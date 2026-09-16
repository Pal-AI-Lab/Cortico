/** Persona console declarations remain owned by their cognitive implementation. */
import { afterAll, describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDeployment } from '../../src/deploy.ts';
import corminiDefinition from '../../bots/cormini/index.ts';
import realtimeDefinition from '../../bots/cortiv/index.ts';

const repoRoot = join(import.meta.dirname, '../..');

// 目录活到断言之后(宪法在Persona构造时才落盘),统一在末尾清。
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* win句柄滞留 */ }
  }
});

/** 从一个空目录装配:没有 config.json,四层里只剩框架默认 + Persona建议。 */
function buildOf(definition: typeof corminiDefinition | typeof realtimeDefinition) {
  const dir = mkdtempSync(join(tmpdir(), 'cormini-provider-'));
  dirs.push(dir);
  const loaded = loadDeployment(definition as never, dir, repoRoot);
  const parts = (definition as never as typeof corminiDefinition).build(loaded as never, []);
  return { parts, loaded };
}

describe('Persona卡:只有 ORIENTATION 与宪法', () => {
  it('Cormini.console() 自报 ORIENTATION/宪法(路径真实存在)+ 首轮对话三份(指向部署的 prompts/,首次保存前不存在)', () => {
    const { parts, loaded } = buildOf(corminiDefinition);
    const decl = parts.persona.console?.();
    expect(decl).toBeDefined();
    expect(decl!.promptDocs?.map((d) => d.key)).toEqual([
      'orientation', 'constitution', 'firstTurn.user', 'firstTurn.thinking', 'firstTurn.reply',
    ]);
    for (const doc of decl!.promptDocs ?? []) {
      if (doc.key.startsWith('firstTurn.')) {
        expect(doc.path.startsWith(join(loaded.rootDir, 'prompts'))).toBe(true);
        expect(existsSync(doc.path)).toBe(false);
      } else {
        expect(existsSync(doc.path)).toBe(true);
      }
    }
  });

  it('分叉用自己的 ORIENTATION 文件(bots/cortiv/persona/ORIENTATION.md)', () => {
    const { parts } = buildOf(realtimeDefinition);
    const docs = parts.persona.console?.().promptDocs ?? [];
    const orient = docs.find((d) => d.key === 'orientation');
    expect(orient?.path.replaceAll('\\', '/')).toContain('bots/cortiv/persona/ORIENTATION.md');
  });

  const FORBIDDEN = ['workspace', 'tree', 'file', 'memory', 'memo', 'checkpoint', 'checkpoints', 'dream', 'reset', 'history', 'diff'];

  it('Cormini 的 Memory 页是工作区与版本历史两块,工作区同时列入存储清单', () => {
    const { parts } = buildOf(corminiDefinition);
    const decl = parts.persona.console?.();
    expect(decl?.panels).toBeUndefined();
    expect(decl?.config).toBeUndefined();
    expect(decl?.memory?.panels?.map((p) => p.id)).toEqual(['workspace', 'history']);
    expect(decl?.invoke).toEqual(expect.any(Function));
    // 工作区须进入可清存储清单，避免清空后再次读回原工作文件。
    expect(decl?.storage).toBeUndefined();
    expect(decl?.memory?.storage?.map((s) => s.key)).toEqual(['workspace']);
    for (const key of decl?.promptDocs?.map((d) => d.key) ?? []) {
      expect(FORBIDDEN).not.toContain(key);
    }
  });

  it('CortiV 的 Memory 页是工作区/记忆/历史三块,工作区不进清除清单,promptDocs 比 Cormini 多一份 MEMORY', () => {
    const { parts } = buildOf(realtimeDefinition);
    const decl = parts.persona.console?.();
    expect(decl?.panels).toBeUndefined();
    expect(decl?.memory?.panels?.map((p) => p.id)).toEqual(['workspace', 'memory', 'history']);
    expect(decl?.invoke).toEqual(expect.any(Function));
    expect(decl?.storage).toBeUndefined();
    expect(decl?.memory?.storage).toBeUndefined();
    expect(decl?.promptDocs?.map((d) => d.key)).toEqual([
      'orientation', 'constitution', 'memoryNote',
      'firstTurn.user', 'firstTurn.thinking', 'firstTurn.reply',
    ]);
  });

  it('两台 bot 各有自己的浏览器入口', () => {
    expect(existsSync(join(repoRoot, 'bots/cormini/console/client.ts'))).toBe(true);
    expect(existsSync(join(repoRoot, 'bots/cortiv/console/client.ts'))).toBe(true);
  });
});
