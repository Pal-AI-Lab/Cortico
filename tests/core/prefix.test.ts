import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assembleSystem, collectWorldContexts, envPromptOverridePath, envPromptTemplateSource, renderWorldEnvPrompt } from '../../src/core/prefix.ts';
import { makeFakeIO, makeFakePersona, makeTool } from './helpers.ts';

describe('assembleSystem', () => {
  it('分节顺序:定向→宪法→World(id序)→记忆', async () => {
    const webTool = makeTool('web_send', 'x');
    const qqTool = makeTool('send', 'x');
    const text = await assembleSystem({
      persona: makeFakePersona(),
      // 故意乱序传入,拼装时应按id排序
      worlds: [makeFakeIO('web', [webTool], 'web环境文本'), makeFakeIO('qq', [qqTool], 'QQ群环境文本')],
      now: new Date('2026-07-17T10:00:00+08:00'),
      timezone: 'Asia/Shanghai',
    });
    const order = [
      'ORIENTATION',
      'CONSTITUTION',
      'QQ群环境文本',
      'web环境文本',
      '完成行动后自然结束回合',
      'MEMORY测试段',
    ];
    let last = -1;
    for (const s of order) {
      const idx = text.indexOf(s);
      expect(idx, `缺少或乱序: ${s}`).toBeGreaterThan(last);
      last = idx;
    }
    // core 按 Persona 返回的顺序拼接段文本。
    expect(text).toContain('环境:qqWorld');
  });

  it('core 只做拼接:逐字连起来,连换行都不替Persona加', async () => {
    const persona = makeFakePersona();
    persona.systemSegments = async () => [
      { title: '第二段', text: 'B\n' },
      { title: '第一段', text: 'A\n' },
    ];
    const text = await assembleSystem({
      persona: persona,
      worlds: [],
      now: new Date(),
      timezone: 'Asia/Shanghai',
    });
    // 按 Persona 返回的顺序直接拼接，段间分隔符由段文本提供。
    expect(text).toBe('B\nA\n');
  });

  it('World 环境提示词按 Worldid序交给Persona', async () => {
    const tool = makeTool('send', 'x');
    const seen: string[] = [];
    const persona = makeFakePersona();
    persona.systemSegments = async (ctx) => {
      seen.push(...ctx.worlds.map((m) => `${m.id}:${m.envPrompt}`));
      return [];
    };
    await assembleSystem({
      persona: persona,
      worlds: [makeFakeIO('web', [], 'web环境'), makeFakeIO('qq', [tool], 'qq环境')],
      now: new Date(),
      timezone: 'Asia/Shanghai',
    });
    expect(seen).toEqual(['qq:qq环境', 'web:web环境']);
  });


  it("不为工具 description 单独生成前缀段，无 World 时也可组装", async () => {
    const text = await assembleSystem({
      persona: makeFakePersona(),
      worlds: [makeFakeIO('qq', [makeTool('send', 'x')])],
      now: new Date(),
      timezone: 'Asia/Shanghai',
    });
    // 工具的说明只在 schema 与 World 自己的环境提示词里,前缀不为它单开一段
    expect(text).not.toContain('send:');
    const text2 = await assembleSystem({
      persona: makeFakePersona(),
      worlds: [],
      now: new Date(),
      timezone: 'Asia/Shanghai',
    });
    expect(text2).toContain('ORIENTATION');
    expect(text2).toContain('MEMORY测试段');
  });
});

describe('环境提示词的三层覆盖', () => {
  /** 写一份某层的覆盖文件。 */
  function putOverride(dir: string, worldId: string, text: string): void {
    const file = envPromptOverridePath(dir, worldId);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text, 'utf8');
  }

  it('部署 > 包 > World:逐层查找,后一层整份替换前一层', async () => {
    const packageDir = mkdtempSync(join(tmpdir(), 'prefix-pkg-'));
    const deploymentDir = mkdtempSync(join(tmpdir(), 'prefix-deploy-'));
    const mod = makeFakeIO('qq', [], 'World 默认文本');
    const dirs = { packageDir, deploymentDir };

    // 两层都没有覆盖 → World 自带的那份
    expect((await renderWorldEnvPrompt(mod, dirs)).text).toBe('World 默认文本');

    putOverride(packageDir, 'qq', '包覆盖文本');
    expect((await renderWorldEnvPrompt(mod, dirs)).text).toBe('包覆盖文本');

    putOverride(deploymentDir, 'qq', '部署覆盖文本');
    expect((await renderWorldEnvPrompt(mod, dirs)).text).toBe('部署覆盖文本');

    // 一个目录都不给(预建实例、测试)= 只认 World 自带的那份
    expect((await renderWorldEnvPrompt(mod)).text).toBe('World 默认文本');

    const text = await assembleSystem({
      persona: makeFakePersona(),
      worlds: [mod],
      now: new Date(),
      timezone: 'Asia/Shanghai',
      dirs,
    });
    expect(text).toContain('部署覆盖文本');
    expect(text).not.toContain('包覆盖文本');
    expect(text).not.toContain('World 默认文本');
  });

  it('origin 说清这份模板此刻来自哪一层', () => {
    const packageDir = mkdtempSync(join(tmpdir(), 'prefix-pkg-'));
    const deploymentDir = mkdtempSync(join(tmpdir(), 'prefix-deploy-'));
    const doc = { key: 'worlds.qq.envPrompt', title: 'QQ', description: '', path: join(packageDir, 'World 默认.md'), role: 'envPrompt' as const };
    writeFileSync(doc.path, 'World 默认文本', 'utf8');

    expect(envPromptTemplateSource(doc, 'qq', { packageDir, deploymentDir }).origin).toBe('module');
    putOverride(packageDir, 'qq', '包覆盖文本');
    expect(envPromptTemplateSource(doc, 'qq', { packageDir, deploymentDir }).origin).toBe('package');
    putOverride(deploymentDir, 'qq', '部署覆盖文本');
    expect(envPromptTemplateSource(doc, 'qq', { packageDir, deploymentDir }).origin).toBe('deployment');
  });

  it('覆盖文件里的占位符照样用 World 报的值插值', async () => {
    const deploymentDir = mkdtempSync(join(tmpdir(), 'prefix-deploy-'));
    const mod = makeFakeIO('qq', [], 'World 默认文本');
    mod.envPromptVars = () => ({ 'qq.name': '测试群' });
    putOverride(deploymentDir, 'qq', '现在在{{qq.name}}里');
    expect(await renderWorldEnvPrompt(mod, { deploymentDir })).toEqual({ text: '现在在测试群里', sourceKey: 'worlds.qq.envPrompt' });
  });
});

describe('collectWorldContexts', () => {
  it('envPromptVars() 抛错或模板读不出的 World 列入 failed,其余照常进 contexts', async () => {
    const thrown = makeFakeIO('thrown');
    thrown.envPromptVars = () => { throw new Error('状态未就绪'); };
    const gone = makeFakeIO('gone');
    rmSync(gone.webUi!()!.promptDocs![0].path);
    const { contexts, failed } = await collectWorldContexts([thrown, makeFakeIO('ok', [], 'ok 环境'), gone]);
    expect(contexts).toEqual([{ id: 'ok', envPrompt: 'ok 环境', sourceKey: 'worlds.ok.envPrompt' }]);
    expect(failed.map(({ world, detail }) => [world.id, detail])).toEqual([
      ['gone', expect.stringContaining('ENOENT')],
      ['thrown', 'envPromptVars(): 状态未就绪'],
    ]);
  });
});
