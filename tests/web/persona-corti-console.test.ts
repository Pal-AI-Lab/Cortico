/**
 * Persona和部署贡献共用 同一个 persona:<bot id>，须在 provider 校验前合并，避免重复 id 导致两份都被丢弃。
 * 浏览器扩展键与合并后的面板声明一致；checkpoints、reset、dream 按各自面板分派。
 * 重置必须取得完整存储清单，避免人格状态与 session 只重置一部分。
 */
import { describe, it, expect } from 'vitest';

import { mergePersonaContributions, personaPageContribution } from '../../src/bot.ts';
import { pageIdFor, validateContributions } from '../../src/web/shared/console-protocol.ts';
import type { StoragePart } from '../../src/core/types.ts';
import {
  CORTI_OPS_PANELS, cortiConsolePages,
} from '../../bots/corti-soulmate/console-page.ts';
import definition from '../../bots/corti-soulmate/index.ts';
import { PERSONA_PANELS, personaConsoleDecl } from '../../bots/corti-soulmate/persona/consoleSurface.ts';
import type {
  OpsCheckpointsState, OpsDreamState, OpsResetState,
} from '../../bots/corti-soulmate/console-page.ts';
import type {
  ConsoleMediumStatus,
} from '../../src/web/server.ts';
import type { PersonaConsoleDecl, Persona } from '../../src/core/types.ts';

/**
 * 扩展是浏览器端代码(DOM 类型,由 tsconfig.web.json 单独 check)。
 * specifier 存进变量,免得根 tsconfig 把它拉进 Node 那份检查——
 * 与 worlds-qq-console.test.ts 同一个理由。
 */
const CORTI_BUNDLE_ENTRY = '../../bots/corti-soulmate/console/client.ts';

// ---------------------------------------------------------------------------
// 假件:只实现两条接缝要用到的部分
// ---------------------------------------------------------------------------

function fakeCore(decl: PersonaConsoleDecl): Persona {
  return { console: () => decl } as unknown as Persona;
}

const STATUS: ConsoleMediumStatus = {
  available: true, repo: true, dirty: false, head: 'abc1234', lastCommit: null, tags: ['checkpoint0'],
};

const part = (key: string): StoragePart => ({
  key, label: key, kind: 'disk', stat: () => '0', clear: () => `已清 ${key}`,
});

interface OpsFixture {
  contribution: ReturnType<typeof cortiConsolePages>[number];
  cleared: string[];
  triggered: number;
}

function ops(storage: StoragePart[] = [part('session'), part('events')]): OpsFixture {
  const cleared: string[] = [];
  const fixture: OpsFixture = { cleared, triggered: 0, contribution: null as never };
  let tags = ['checkpoint0'];
  fixture.contribution = cortiConsolePages({
    name: definition.id,
    label: 'Yukima · 部署',
    checkpoints: {
      list: () => tags.map((t) => ({ name: t, message: '', hash: 'abc1234', date: '' })),
      create: (name) => { tags = [...tags, name]; return `checkpoint「${name}」已创建`; },
      remove: (name) => { tags = tags.filter((t) => t !== name); return `checkpoint「${name}」已删除`; },
    },
    status: () => STATUS,
    reset: {
      run: async (checkpoint, parts) => ({
        ok: true,
        persona: `persona 已回滚到 checkpoint「${checkpoint}」`,
        results: parts.map((p) => {
          cleared.push(p.key);
          return { key: p.key, ok: true, result: String(p.clear()) };
        }),
      }),
    },
    storage: () => storage,
    dream: {
      trigger: () => { fixture.triggered++; return { ok: true, message: '已触发' }; },
    },
    dreamState: () => ({ dreaming: false }),
  })[0];
  return fixture;
}

const call = <T>(f: OpsFixture, panel: string, method: string, args: unknown[] = []): Promise<T> =>
  f.contribution.invoke!(panel, method, args) as Promise<T>;

// ---------------------------------------------------------------------------

describe('两条接缝各出一个 provider', () => {
  it('Persona自报四份模板:宪法在工作区,装配/World 段/记忆跟着代码走;首轮对话由基类按部署目录给,不给就没有', () => {
    const memory = { resolveSafe: (path: string) => `C:\\persona\\${path}`, git: {} };
    const decl = personaConsoleDecl({ memory, memo: {}, emergences: () => [] } as never);
    expect(decl.promptDocs?.map((d) => d.key)).toEqual([
      'constitution', 'persona.prefix', 'persona.envSection', 'persona.memory',
    ]);
    const withFirstTurn = personaConsoleDecl({
      memory, memo: {}, emergences: () => [],
      firstTurnDocs: [{ key: 'firstTurn.user', title: 'u', description: '', path: 'C:\\deploy\\prompts\\FIRST_TURN_USER.md' }],
    } as never);
    expect(withFirstTurn.promptDocs?.map((d) => d.key)).toEqual([
      'constitution', 'persona.prefix', 'persona.envSection', 'persona.memory', 'firstTurn.user',
    ]);
    expect(decl.promptDocs?.[0]).toEqual({
      key: 'constitution',
      title: '宪法',
      description: 'Persona的长期原则；重载系统前缀后对当前 session 生效。',
      path: 'C:\\persona\\CONSTITUTION.md',
    });
    // 顶层装配那份带 role=prefix,控制台据此认得出"这是段序表"
    expect(decl.promptDocs?.find((d) => d.key === 'persona.prefix')?.role).toBe('prefix');
    // 每份模板都要自报占位符,否则编辑器旁注是空的
    for (const key of ['persona.prefix', 'persona.envSection', 'persona.memory']) {
      expect(decl.promptDocs?.find((d) => d.key === key)?.vars?.length, key).toBeGreaterThan(0);
    }
  });

  it('Persona那条按 bot id 铸名,面板是认知绑定的三块', () => {
    const c = personaPageContribution(definition.id, 'Yukima', fakeCore({ panels: PERSONA_PANELS }));
    expect(c?.id).toBe(pageIdFor('persona', definition.id));
    expect(c?.kind).toBe('persona');
    expect(c?.availability).toBe('active');
    expect(c?.panels?.map((p) => p.id)).toEqual(['workspace', 'memory', 'history']);
    expect(c?.panels?.[0].description).toBeTruthy();
  });

  it('装配层声明部署面板，模型配置由 LLM Provider 提供', () => {
    const c = ops().contribution;
    expect(c.kind).toBe('persona');
    expect(c.panels?.map((p) => p.id)).toEqual(['checkpoints', 'reset', 'dream']);
    expect(c.panels?.map((p) => p.title)).toEqual(['存档点', '统一重置', '强制入梦']);
    for (const p of CORTI_OPS_PANELS) expect(p.description).toBeTruthy();
  });

  it('两条接缝共用同一个 id,由装配层合成一份', () => {
    // 合并前它们是同 id 的两份,直接一起上线会被判重复——两个都丢掉。
    // 所以 src/bot.ts 的 mergePersonaContributions 必须在校验之前把它们并了。
    const core = personaPageContribution(definition.id, 'Yukima', fakeCore({ panels: PERSONA_PANELS }))!;
    const deploy = ops().contribution;
    expect(deploy.id).toBe(core.id);
    expect(validateContributions([core, deploy]).map((p) => p.message).join()).toContain('重复');
  });

  it('合成之后:七个面板同在一个 provider 里,校验干净', () => {
    const core = personaPageContribution(definition.id, 'Yukima', fakeCore({ panels: PERSONA_PANELS }))!;
    const merged = mergePersonaContributions(pageIdFor('persona', definition.id), 'Yukima', core, [ops().contribution]);
    expect(merged?.id).toBe(pageIdFor('persona', definition.id));
    expect(merged?.panels?.map((p) => p.id)).toEqual(
      ['workspace', 'memory', 'history', 'checkpoints', 'reset', 'dream'],
    );
    expect(validateContributions([merged!])).toEqual([]);
  });

  it('Persona没实现 console() 就没有那个 provider(不是错误)', () => {
    expect(personaPageContribution(definition.id, 'Yukima', {} as Persona)).toBeNull();
  });
});

describe('部署面的 invoke 分派', () => {
  it('checkpoints:列表 / 新建 / 删除都回最新状态,省一次往返', async () => {
    const f = ops();
    const st = await call<OpsCheckpointsState>(f, 'checkpoints', 'state');
    expect(st.status.head).toBe('abc1234');
    expect(st.checkpoints.map((c) => c.name)).toEqual(['checkpoint0']);

    const made = await call<{ result: string; state: OpsCheckpointsState }>(
      f, 'checkpoints', 'create', ['v1', '第一版'],
    );
    expect(made.result).toContain('v1');
    expect(made.state.checkpoints.map((c) => c.name)).toEqual(['checkpoint0', 'v1']);

    const gone = await call<{ state: OpsCheckpointsState }>(f, 'checkpoints', 'remove', ['v1']);
    expect(gone.state.checkpoints.map((c) => c.name)).toEqual(['checkpoint0']);
    await expect(call(f, 'checkpoints', 'create', ['  '])).rejects.toThrow('缺少 checkpoint 名');
  });

  it('dream:状态与触发;触发回执带最新状态', async () => {
    const f = ops();
    const st = await call<OpsDreamState>(f, 'dream', 'state');
    expect(st.dreaming).toBe(false);
    const out = await call<{ ok: boolean; message: string; state: OpsDreamState }>(f, 'dream', 'trigger');
    expect(out.ok).toBe(true);
    expect(f.triggered).toBe(1);
    expect(out.state).toBeTruthy();
  });

  it('不认识的面板与方法各报各的', async () => {
    const f = ops();
    await expect(call(f, 'nope', 'state')).rejects.toThrow('未知面板');
    await expect(call(f, 'dream', 'nope')).rejects.toThrow('未知面板方法');
  });
});

describe('统一重置', () => {
  it('清单齐:回滚 + 逐项清除,顺序与结果原样回', async () => {
    const f = ops();
    const st = await call<OpsResetState>(f, 'reset', 'state');
    expect(st.ready).toBe(true);
    expect(st.reason).toBeNull();
    expect(st.parts.map((p) => p.key)).toEqual(['session', 'events']);

    const out = await call<{ ok: boolean; persona: string }>(f, 'reset', 'run', ['checkpoint0']);
    expect(out.ok).toBe(true);
    expect(out.persona).toContain('checkpoint0');
    expect(f.cleared).toEqual(['session', 'events']);
  });

  it('清单不齐:面板报原因,run 直接拒绝——不做半次重置', async () => {
    const f = ops([part('vision')]);
    const st = await call<OpsResetState>(f, 'reset', 'state');
    expect(st.ready).toBe(false);
    expect(st.reason).toContain('session');
    await expect(call(f, 'reset', 'run', ['checkpoint0'])).rejects.toThrow('存储清单');
    expect(f.cleared).toEqual([]);
  });

  it('存档点上的「回滚到此」与重置面板是同一次事务', async () => {
    const f = ops();
    const out = await call<{ ok: boolean }>(f, 'checkpoints', 'rollback', ['checkpoint0']);
    expect(out.ok).toBe(true);
    expect(f.cleared).toEqual(['session', 'events']);
    await expect(call(f, 'reset', 'run', ['  '])).rejects.toThrow('缺少 checkpoint 名');
  });
});

describe('浏览器扩展', () => {
  it('default export 的面板键 = 两个 provider 声明的七个局部 id,且都能 mount', async () => {
    const bundle = ((await import(CORTI_BUNDLE_ENTRY)) as any).default;
    const declared = [...PERSONA_PANELS, ...CORTI_OPS_PANELS].map((p) => p.id);
    expect(Object.keys(bundle.panels).sort()).toEqual([...declared].sort());
    for (const id of declared) expect(typeof bundle.panels[id].mount).toBe('function');
  });
});
