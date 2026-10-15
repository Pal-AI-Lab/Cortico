/**
 * World 装配层:定义 → 槽位 → 挂载表,以及热激活 / 停用 / 重启的实例生命周期。
 *
 * 用真 config.json(临时目录)与真 core 挂载路径;World 是内联的探针,
 * 记录自己被 start / stop 的次数与拿到的上下文。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorldAssembly, withWorlds, worldDefaults, type WorldDefinition, type WorldContext, type WorldSection } from '../src/world.ts';
import { loadDeployment } from '../src/deploy.ts';
import type { BotDefinition } from '../src/bot.ts';
import type { CoreConfig, ToolDef, World, WorldHost, WorldLifecycleEvent } from '../src/core/types.ts';
import type { Language } from '../src/core/language.ts';
import { makeCfg } from './core/helpers.ts';

interface ProbeSection { enabled: boolean; port: number; nested: { name: string; tags: string[] } }

class Probe implements World {
  started = 0;
  stopped = 0;
  host: WorldHost | null = null;
  constructor(readonly id: string, readonly ctx: WorldContext<ProbeSection>) {}
  envPromptVars() { return {}; }
  tools() { return []; }
  async start(host: WorldHost) { this.started++; this.host = host; }
  async stop() { this.stopped++; this.host = null; }
}

/** 缺失清单的中文形态:reason 按语言给,断言时取中文那份。 */
const missingOf = (assembly: WorldAssembly) => assembly.missing.map((m) => ({ ...m, reason: m.reason('zh') }));

function probeDefinition(id: string, patch: Partial<WorldDefinition<ProbeSection>> = {}): WorldDefinition<ProbeSection> {
  return {
    id,
    label: `${id} 探针`,
    defaults: () => ({ enabled: false, port: 1000, nested: { name: 'a', tags: ['x'] } }),
    create: (ctx) => new Probe(id, ctx),
    ...patch,
  };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'worlds-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function assemblyOf(defs: WorldDefinition<ProbeSection>[], declares: Parameters<typeof worldDefaults>[1], worlds: Record<string, unknown> = {}, reserved?: string[]) {
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ worlds }), 'utf8');
  // 真部署读取器:config.json 四层合并、密钥按 进程环境 → bot .env 读
  const loaded = loadDeployment(
    { defaults: () => makeCfg({ worlds: worldDefaults(defs as never, declares) } as never) },
    dir,
    dir,
  );
  const assembly = new WorldAssembly(loaded, defs as never, declares);
  const mounts: string[] = [];
  const lifecycle: WorldLifecycleEvent[] = [];
  const host = {
    mount: async (mod: World) => { mounts.push(`+${mod.id}`); await mod.start({} as WorldHost); assembly.mounted.push(mod); },
    unmount: async (id: string) => {
      mounts.push(`-${id}`);
      const i = assembly.mounted.findIndex((m) => m.id === id);
      await assembly.mounted[i].stop();
      assembly.mounted.splice(i, 1);
    },
    lifecycle: (event: WorldLifecycleEvent) => { lifecycle.push(event); },
    ...(reserved ? { reservedToolNames: () => reserved } : {}),
  };
  assembly.bind(host);
  const json = () => JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as { worlds: Record<string, ProbeSection> };
  return { assembly, loaded, mounts, lifecycle, json };
}

describe('worldDefaults', () => {
  it('声明过的渠道 enabled:true,没声明的 false,覆盖项最后压上', () => {
    const worlds = worldDefaults([probeDefinition('a'), probeDefinition('b')] as never, ['a', { id: 'ghost', label: 'G' }], {
      b: { port: 7 },
    });
    expect(worlds.a).toMatchObject({ enabled: true, port: 1000 });
    expect(worlds.b).toMatchObject({ enabled: false, port: 7 });
    expect(worlds).not.toHaveProperty('ghost');
  });
});

describe('withWorlds', () => {
  const impl = (id: string, extra: Record<string, unknown> = {}): WorldDefinition<WorldSection> => ({
    id, label: `${id} 实现`, defaults: () => ({ enabled: false, ...extra } as WorldSection), create: () => ({}) as never,
  });
  const definition: BotDefinition<CoreConfig> = {
    id: 'bot',
    defaults: () => ({ displayName: 'b', worlds: { seeded: { enabled: true } } }) as unknown as CoreConfig,
    declares: ['a', 'voice', { id: 'ghost', label: '幽灵', reason: '没装' }],
    build: () => { throw new Error('not built in this test'); },
  };

  it('实现表整份交给定义;worlds 段为每个实现补默认值,声明过的 enabled:true,其余 false;已有段不覆盖', () => {
    const merged = withWorlds(definition, [impl('a'), impl('voice', { port: 9 }), impl('extra', { port: 9 }), impl('seeded')]);
    expect(merged.worlds?.map((m) => m.id)).toEqual(['a', 'voice', 'extra', 'seeded']);
    expect(merged.id).toBe('bot');
    expect(merged.declares).toBe(definition.declares);
    const worlds = (merged.defaults() as unknown as { worlds: Record<string, WorldSection & { port?: number }> }).worlds;
    expect(worlds.a).toEqual({ enabled: true });
    expect(worlds.voice).toEqual({ enabled: true, port: 9 });
    expect(worlds.extra).toEqual({ enabled: false, port: 9 });
    expect(worlds.seeded).toEqual({ enabled: true });
    expect(worlds).not.toHaveProperty('ghost');
  });
});

describe('槽位表', () => {
  it('按 worlds.<id>.enabled 分成挂载与未激活;声明了没定义的进 missing', () => {
    const { assembly } = assemblyOf([probeDefinition('a'), probeDefinition('b')], ['a', 'b', { id: 'ghost', label: '幽灵', reason: '没装' }]);
    expect(assembly.mounted.map((m) => m.id)).toEqual(['a', 'b']);
    expect(assembly.slots.map((s) => [s.id, s.mounted, s.declared])).toEqual([['a', true, true], ['b', true, true]]);
    expect(missingOf(assembly)).toEqual([{ id: 'ghost', label: '幽灵', reason: '没装' }]);
    expect(assembly.labelOf('a')).toBe('a 探针');
    expect(() => assembly.slot('ghost')).toThrow('未知 World');
  });

  it('定义了但没声明的 World 是部署侧选配,默认不挂', () => {
    const { assembly } = assemblyOf([probeDefinition('a'), probeDefinition('extra')], ['a']);
    expect(assembly.mounted.map((m) => m.id)).toEqual(['a']);
    expect(assembly.slot('extra')).toMatchObject({ mounted: false, declared: false });
  });

  it('config.json 缺段时按定义默认值补一段,活对象上就有', () => {
    const { assembly, loaded } = assemblyOf([probeDefinition('a')], []);
    expect((loaded.config as unknown as { worlds: Record<string, ProbeSection> }).worlds.a).toMatchObject({ enabled: false, port: 1000 });
    expect(assembly.slot('a').mounted).toBe(false);
  });
});

describe('装配上下文', () => {
  it('cfg 是 worlds.<id> 的活引用;persist 深合并到活对象与 config.json,数组整体替换', () => {
    const { assembly, loaded, json } = assemblyOf([probeDefinition('a')], ['a'], { a: { enabled: true, port: 1500 } });
    const probe = assembly.slot('a').instance as Probe;
    const live = (loaded.config as unknown as { worlds: { a: ProbeSection } }).worlds.a;
    expect(probe.ctx.cfg).toBe(live);
    expect(live.port).toBe(1500);
    probe.ctx.persist({ port: 2000, nested: { tags: ['y', 'z'] } });
    expect(live).toMatchObject({ port: 2000, nested: { name: 'a', tags: ['y', 'z'] } });
    expect(json().worlds.a).toMatchObject({ port: 2000, nested: { tags: ['y', 'z'] } });
    // config.json 里原有的其它键原样保留;没写过的默认值不会被落盘
    expect(json().worlds.a.enabled).toBe(true);
    expect(json().worlds.a.nested.name).toBeUndefined();
  });

  it('storeSecret 写进 bot 目录的 .env,本进程 secret() 立刻读到', () => {
    const { assembly, loaded } = assemblyOf([probeDefinition('a')], ['a']);
    const probe = assembly.slot('a').instance as Probe;
    const name = `PROBE_SECRET_${process.pid}`;
    try {
      probe.ctx.storeSecret(name, 'tok-1');
      expect(readFileSync(join(dir, '.env'), 'utf8')).toContain(`${name}=tok-1`);
      expect(probe.ctx.secret(name)).toBe('tok-1');
      probe.ctx.storeSecret(name, 'tok-2');
      expect(readFileSync(join(dir, '.env'), 'utf8').match(new RegExp(`^${name}=`, 'gm'))).toHaveLength(1);
      expect(loaded.secret(name)).toBe('tok-2');
    } finally {
      delete process.env[name];
    }
  });

  it('宿主事实:时区、bot 名、目录', () => {
    const { assembly, loaded } = assemblyOf([probeDefinition('a')], ['a']);
    const probe = assembly.slot('a').instance as Probe;
    expect(probe.ctx.timezone).toBe(loaded.config.timezone);
    expect(probe.ctx.botName).toBe(loaded.config.displayName);
    expect(probe.ctx.botDir).toBe(dir);
    expect(probe.ctx.dataDir).toBe(join(dir, 'data'));
  });
});

describe('激活 / 停用 / 重启', () => {
  it('激活:前置检查 → 写回 enabled → 挂载;失败时回滚 enabled 并换新实例', async () => {
    let allow = false;
    const def = probeDefinition('a', { preflight: () => { if (!allow) throw new Error('还没配好'); } });
    const { assembly, json, mounts } = assemblyOf([def], []);
    const first = assembly.slot('a').instance;
    await expect(assembly.activate('a')).rejects.toThrow('还没配好');
    expect(json().worlds.a?.enabled ?? false).toBe(false);
    expect(mounts).toEqual([]);
    allow = true;
    expect(await assembly.activate('a')).toContain('已启用');
    expect(json().worlds.a.enabled).toBe(true);
    expect(assembly.slot('a').mounted).toBe(true);
    expect(assembly.slot('a').instance).toBe(first);
    expect((first as Probe).started).toBe(1);
    expect(await assembly.activate('a')).toContain('已启用');
  });

  it('start 抛错:enabled 回滚成 false,槽位换上全新实例', async () => {
    let boom = true;
    const def = probeDefinition('a', {
      create: (ctx) => {
        const p = new Probe('a', ctx);
        p.start = async () => { if (boom) throw new Error('端口被占'); p.started++; };
        return p;
      },
    });
    const { assembly, json } = assemblyOf([def], []);
    const first = assembly.slot('a').instance;
    await expect(assembly.activate('a')).rejects.toThrow('端口被占');
    expect(json().worlds.a.enabled).toBe(false);
    expect(assembly.slot('a').mounted).toBe(false);
    expect(assembly.slot('a').instance).not.toBe(first);
    boom = false;
    await assembly.activate('a');
    expect(assembly.slot('a').mounted).toBe(true);
  });

  it('停用:stop 旧实例、出表、写回 false,槽位换上从未 start 的新实例', async () => {
    const { assembly, json, mounts } = assemblyOf([probeDefinition('a')], ['a']);
    const first = assembly.slot('a').instance as Probe;
    expect(await assembly.deactivate('a')).toContain('已停用');
    expect(mounts).toEqual(['-a']);
    expect(first.stopped).toBe(1);
    expect(assembly.mounted).toEqual([]);
    expect(json().worlds.a.enabled).toBe(false);
    const fresh = assembly.slot('a').instance as Probe;
    expect(fresh).not.toBe(first);
    expect(fresh.started).toBe(0);
    // 已停用的再停一次:只写回,不动实例
    await assembly.deactivate('a');
    expect(assembly.slot('a').instance).toBe(fresh);
  });

  it('重启:stop 旧实例、按定义重建、start 新实例;未激活的拒绝', async () => {
    const { assembly, mounts } = assemblyOf([probeDefinition('a'), probeDefinition('b')], ['a']);
    const first = assembly.slot('a').instance as Probe;
    expect(await assembly.restart('a')).toContain('已重启');
    expect(mounts).toEqual(['-a', '+a']);
    expect(first.stopped).toBe(1);
    const next = assembly.slot('a').instance as Probe;
    expect(next).not.toBe(first);
    expect(next.started).toBe(1);
    expect(assembly.mounted).toEqual([next]);
    await expect(assembly.restart('b')).rejects.toThrow('未激活');
  });

  it('ctx.restart() 按当前 enabled 对账:开着就重启,关着就停', async () => {
    const { assembly, loaded } = assemblyOf([probeDefinition('a')], ['a']);
    const worlds = (loaded.config as unknown as { worlds: { a: ProbeSection } }).worlds;
    const first = assembly.slot('a').instance as Probe;
    await first.ctx.restart();
    expect(assembly.slot('a').instance).not.toBe(first);
    expect(assembly.slot('a').mounted).toBe(true);
    worlds.a.enabled = false;
    await (assembly.slot('a').instance as Probe).ctx.restart();
    expect(assembly.slot('a').mounted).toBe(false);
    expect(assembly.mounted).toEqual([]);
    // 关着时 restart 只是停,不改 enabled;再改回 true 对账就重新激活
    worlds.a.enabled = true;
    await (assembly.slot('a').instance as Probe).ctx.restart();
    expect(assembly.slot('a').mounted).toBe(true);
  });

  it('预建实例初始挂载并替换同 id 的定义实例', async () => {
    const { assembly } = assemblyOf([probeDefinition('a')], []);
    const prebuilt: World = { id: 'a', envPromptVars: () => ({}), tools: () => [], start: async () => {}, stop: async () => {} };
    assembly.addPrebuilt([prebuilt], { labels: { a: '预建' }, declared: false });
    expect(assembly.slots).toHaveLength(1);
    expect(assembly.slot('a')).toMatchObject({ mounted: true, declared: false, label: '预建', definition: null });
    expect(assembly.mounted).toEqual([prebuilt]);
    await expect(assembly.activate('a')).resolves.toContain('已启用');
    expect(existsSync(join(dir, '.env'))).toBe(false);
  });
});

describe('显示名', () => {
  const labelled = (id: string, labels: Partial<Record<Language, string>>) => probeDefinition(id, {
    create: (ctx) => Object.assign(new Probe(id, ctx), { webUi: (language: Language) => ({ label: labels[language] }) }),
  });

  it('按请求语言现取:实例 webUi().label,其次定义的 label', () => {
    let current = '启动时的名字';
    const live = Object.defineProperty(probeDefinition('live'), 'label', { get: () => current });
    const { assembly } = assemblyOf([labelled('decl', { en: 'Declared' }), live], []);
    current = '现在的名字';
    expect(assembly.labelIn('decl', 'en')).toBe('Declared');
    expect(assembly.labelIn('decl', 'zh')).toBe('decl 探针');
    expect(assembly.labelIn('live', 'en')).toBe('现在的名字');
  });

  it('激活与停用的回执用请求语言的名字', async () => {
    const { assembly } = assemblyOf([labelled('a', { en: 'Alpha' })], []);
    expect(await assembly.activate('a', 'en')).toContain('Alpha');
    expect(await assembly.deactivate('a', 'en')).toContain('Alpha');
  });
});

describe('构造隔离与生命周期', () => {
  it('create() 抛错的定义进 missing(带 declared 与原因),其余槽位照常', () => {
    const boom = probeDefinition('boom', { create: () => { throw new Error('端口被占'); } });
    const { assembly } = assemblyOf([probeDefinition('a'), boom, probeDefinition('extra')], ['a', 'boom']);
    expect(assembly.mounted.map((m) => m.id)).toEqual(['a']);
    expect(assembly.slots.map((s) => s.id)).toEqual(['a', 'extra']);
    expect(missingOf(assembly)).toEqual([{ id: 'boom', label: 'boom 探针', declared: true, reason: '构造失败: 端口被占' }]);
    expect(assembly.missing[0].reason('en')).toBe('Construction failed: 端口被占');
    expect(() => assembly.slot('boom')).toThrow('未知 World');
  });

  it('没声明的定义构造失败 → missing 上 declared:false', () => {
    const boom = probeDefinition('boom', { create: () => { throw new Error('x'); } });
    const { assembly } = assemblyOf([boom], []);
    expect(assembly.missing[0]).toMatchObject({ id: 'boom', declared: false });
  });

  it('激活 / 停用 / 重启 / 对账各报一次生命周期事件;启动期初始挂载与失败的激活不报', async () => {
    const { assembly, lifecycle, loaded } = assemblyOf([probeDefinition('a'), probeDefinition('b')], ['a'], {
      b: { enabled: false },
    });
    expect(lifecycle).toEqual([]);
    await assembly.activate('b');
    await assembly.restart('b');
    await assembly.deactivate('b');
    await assembly.deactivate('b');
    expect(lifecycle).toEqual([
      { kind: 'mounted', id: 'b', label: 'b 探针' },
      { kind: 'restarted', id: 'b', label: 'b 探针' },
      { kind: 'unmounted', id: 'b', label: 'b 探针' },
    ]);
    lifecycle.length = 0;
    // 对账:关着 → 开着报 mounted;开着 → 关着报 unmounted
    (loaded.config as unknown as { worlds: Record<string, ProbeSection> }).worlds.a.enabled = false;
    await assembly.sync('a');
    (loaded.config as unknown as { worlds: Record<string, ProbeSection> }).worlds.a.enabled = true;
    await assembly.sync('a');
    expect(lifecycle.map((e) => e.kind)).toEqual(['unmounted', 'mounted']);
    // start 抛错的激活不算挂载
    lifecycle.length = 0;
    const bad = assembly.slot('b').instance as Probe;
    bad.start = async () => { throw new Error('连不上'); };
    await expect(assembly.activate('b')).rejects.toThrow('连不上');
    expect(lifecycle).toEqual([]);
  });
});

describe('工具名全局唯一', () => {
  const tool = (name: string): ToolDef => ({ name, description: '', parameters: {}, tags: [], handler: async () => '' });
  /** 工具名可热改:定义读一个活表,重启后的新实例报的就是改过的名字。 */
  const withTools = (id: string, names: () => string[]) =>
    probeDefinition(id, { create: (ctx) => Object.assign(new Probe(id, ctx), { tools: () => names().map(tool) }) });

  it('启动期:与已挂载 World 撞名的进 missing 并写明双方 World id 与工具名,其余槽位照常', () => {
    const { assembly } = assemblyOf(
      [withTools('a', () => ['a_go', 'shared']), withTools('b', () => ['shared', 'b_go']), withTools('c', () => ['c_go'])],
      ['a', 'b', 'c'],
    );
    expect(assembly.mounted.map((m) => m.id)).toEqual(['a', 'c']);
    expect(assembly.slots.map((s) => s.id)).toEqual(['a', 'c']);
    expect(missingOf(assembly)).toEqual([{ id: 'b', label: 'b 探针', declared: true, reason: 'World b 与 World a 的工具撞名,拒绝挂载 b: shared' }]);
  });

  it('未激活的槽位不参与:同名只在两者都要挂载时才算撞', async () => {
    const { assembly, mounts, json } = assemblyOf(
      [withTools('a', () => ['shared']), withTools('b', () => ['shared'])],
      ['a'],
    );
    expect(assembly.slots.map((s) => s.id)).toEqual(['a', 'b']);
    await expect(assembly.activate('b')).rejects.toThrow('World b 与 World a 的工具撞名,拒绝挂载 b: shared');
    expect(mounts).toEqual([]);
    expect(json().worlds.b?.enabled ?? false).toBe(false);
    await assembly.deactivate('a');
    await expect(assembly.activate('b')).resolves.toContain('已启用');
  });

  it('重启查的是重建后的实例:工具名改成撞名的,停下来不再挂', async () => {
    const bNames = ['b_go'];
    const { assembly, mounts } = assemblyOf(
      [withTools('a', () => ['a_go']), withTools('b', () => bNames)],
      ['a', 'b'],
    );
    bNames[0] = 'a_go';
    await expect(assembly.restart('b')).rejects.toThrow('World b 与 World a 的工具撞名,拒绝挂载 b: a_go');
    expect(mounts).toEqual(['-b']);
    expect(assembly.slot('b').mounted).toBe(false);
    expect(assembly.mounted.map((m) => m.id)).toEqual(['a']);
  });

  it('预建实例撞名直接抛', () => {
    const { assembly } = assemblyOf([withTools('a', () => ['shared'])], ['a']);
    const prebuilt: World = { id: 'p', envPromptVars: () => ({}), tools: () => [tool('shared')], start: async () => {}, stop: async () => {} };
    expect(() => assembly.addPrebuilt([prebuilt])).toThrow('撞名');
    expect(assembly.mounted.map((m) => m.id)).toEqual(['a']);
  });

  it('保留名(Core 帧名、Persona 自有工具):绑定时把启动期已挂载的扫一遍,占用的出表进 missing', () => {
    const { assembly } = assemblyOf(
      [withTools('a', () => ['a_go']), withTools('b', () => ['read_file', 'b_go']), withTools('c', () => ['c_go'])],
      ['a', 'b', 'c'],
      {},
      ['read_file', 'external_event_frame'],
    );
    expect(assembly.mounted.map((m) => m.id)).toEqual(['a', 'c']);
    expect(assembly.slots.map((s) => s.id)).toEqual(['a', 'c']);
    expect(missingOf(assembly)).toEqual([{ id: 'b', label: 'b 探针', declared: true, reason: '工具名已被 Core 或 Persona 占用,拒绝挂载: read_file' }]);
  });

  it('保留名:激活、重启、预建都拒', async () => {
    const bNames = ['b_go'];
    const { assembly, mounts } = assemblyOf(
      [withTools('a', () => ['read_file']), withTools('b', () => bNames)],
      ['b'],
      {},
      ['read_file'],
    );
    await expect(assembly.activate('a')).rejects.toThrow('已被 Core 或 Persona 占用,拒绝挂载: read_file');
    expect(mounts).toEqual([]);
    bNames[0] = 'read_file';
    await expect(assembly.restart('b')).rejects.toThrow('占用');
    expect(assembly.slot('b').mounted).toBe(false);
    const prebuilt: World = { id: 'p', envPromptVars: () => ({}), tools: () => [tool('read_file')], start: async () => {}, stop: async () => {} };
    expect(() => assembly.addPrebuilt([prebuilt])).toThrow('占用');
    expect(assembly.mounted).toEqual([]);
  });
});
