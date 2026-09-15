/**
 * World 适配为 provider，局部 panel id 原样进入 manifest。
 * 无效或重复的 provider 被隔离，manifest 请求仍返回 200。夹具使用假 World 验证通用装配契约。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebApp, type WebAppDeps } from '../../src/web/server.ts';
import type { ConsolePageSource } from '../../src/web/console-pages.ts';
import { panelRoute } from '../../src/web/shared/console-protocol.ts';
import type { ConsoleManifest } from '../../src/web/shared/console-protocol.ts';
import { deriveConsolePageSources } from '../../src/bot.ts';
import { WorldAssembly } from '../../src/world.ts';

/** 带未激活槽位与缺失声明的槽位表:未激活的走真定义(enabled:false),缺失的走声明。 */
function assemblyWith(spec: {
  inactive?: Array<{ mod: World; label: string }>;
  missing?: Array<{ id: string; label: string; reason: string }>;
}): WorldAssembly {
  const loaded = { config: { worlds: {} } as never, secret: () => '', rootDir: '', memoryDir: '', dataDir: '' };
  const defs = (spec.inactive ?? []).map(({ mod, label }) => ({
    id: mod.id, label, defaults: () => ({ enabled: false }), create: () => mod,
  }));
  return new WorldAssembly(loaded, defs, [...defs.map((d) => d.id), ...(spec.missing ?? [])]);
}
import type { Persona, World, WorldConsoleDecl, ToolDef } from '../../src/core/types.ts';
import { nullLogger } from '../../src/core/util.ts';
import { FakeStore } from './fakes.ts';

let dir: string;
/** 默认的"没构建过"资源目录:不让测试撞上仓库里真实的 dist/web。 */
let emptyDist: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'webtest-providers-'));
  emptyDist = join(dir, 'no-dist');
  mkdirSync(emptyDist, { recursive: true });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 起一个只挂了 consolePageSources 的最小控制台,跑完就关。 */
async function withApp(
  extra: Partial<WebAppDeps>,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const deps: WebAppDeps = {
    store: new FakeStore(),
    memoryDir: dir,
    dataDir: dir,
    webDistDir: emptyDist,
    getStatus: () => ({}),
    log: nullLogger(),
    ...extra,
  };
  const app = new WebApp(deps);
  const port = await app.start(0);
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await app.stop();
  }
}

const manifestOf = async (base: string): Promise<ConsoleManifest> =>
  (await (await fetch(`${base}/api/console/manifest`)).json()) as ConsoleManifest;

const byId = (m: ConsoleManifest, id: string) => m.providers.find((p) => p.id === id);

/** 只声明 console() 的假 World;其余 World 契约给最小桩。 */
class FakeWorld implements World {
  constructor(
    readonly id: string,
    private readonly decl: () => WorldConsoleDecl,
  ) {}

  envPromptVars(): Record<string, string> {
    return {};
  }

  tools(): ToolDef[] {
    return [];
  }

  console(): WorldConsoleDecl {
    return this.decl();
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}
}

/** deriveConsolePageSources 只要 core 的可见性事实,这里直接喂一份。 */
const facts = (visibility: Record<string, boolean> = {}, drifted: string[] = []) => ({
  worldVisibility: () => ({ visibility, driftedWorlds: drifted }),
});

// ---------------------------------------------------------------------------

describe('manifest 组装', () => {
  it('一个 provider 都没有时也答 200 的空壳,不是 503', async () => {
    await withApp({}, async (base) => {
      const r = await fetch(`${base}/api/console/manifest`);
      expect(r.status).toBe(200);
      const m = (await r.json()) as ConsoleManifest;
      expect(m.protocolVersion).toBe(1);
      expect(m.providers).toEqual([]);
      // 框架能力照常如实上报,前端据此决定不渲染哪块
      expect(m.framework.capabilities.worlds).toBe(false);
      expect(m.framework.capabilities.run).toBe(false);
    });
  });

  it('单个 World 出一个 worlds: provider,panel id 原样进 manifest', async () => {
      const mod = new FakeWorld('demo', () => ({
        panels: [ { id: 'gate', title: '接入门' }, { id: 'roster', title: '名单' }, { id: 'loose', title: 'loose' }],
        promptDocs: [{ key: 'worlds.demo.envPrompt', title: '环境提示词', description: '环境提示词', path: 'C:\\private\\demo.md' }],
      }));
    const sources = deriveConsolePageSources(facts({ demo: true }), { assembly: WorldAssembly.ofInstances([mod]) });
    await withApp({ consolePageSources: sources }, async (base) => {
      const m = await manifestOf(base);
      const p = byId(m, 'world:demo');
      expect(p?.kind).toBe('world');
      expect(p?.availability).toBe('active');
      expect(p?.panels?.map((x) => x.id)).toEqual(['gate', 'roster', 'loose']);
      // 标题是声明方自己给的,框架不改写
        expect(p?.panels?.map((x) => x.title)).toEqual(['接入门', '名单', 'loose']);
        expect(p?.prompts).toEqual([{ key: 'worlds.demo.envPrompt', title: '环境提示词', description: '环境提示词' }]);
        expect(JSON.stringify(p)).not.toContain('private');
    });
  });

  it('label 取 World 目录的名字,目录里没有就退回 id', async () => {
    const sources = deriveConsolePageSources(facts(), {
      assembly: WorldAssembly.ofInstances(
        [new FakeWorld('named', () => ({})), new FakeWorld('bare', () => ({}))],
        { labels: { named: '有名字的 World' } },
      ),
    });
    await withApp({ consolePageSources: sources }, async (base) => {
      const m = await manifestOf(base);
      expect(byId(m, 'world:named')?.label).toBe('有名字的 World');
      expect(byId(m, 'world:named')?.declared).toBe(true);
      expect(byId(m, 'world:bare')?.label).toBe('bare');
    });
  });

  it('多个 IO provider 并存,各自的面板与徽标互不串味', async () => {
    const sources = deriveConsolePageSources(facts(), {
      assembly: WorldAssembly.ofInstances([
        new FakeWorld('alpha', () => ({
          badges: [{ label: '在线', value: 3, tone: 'on' }],
          panels: [ { id: 'gate', title: '接入门' }],
        })),
        new FakeWorld('beta', () => ({
          badges: [{ label: '引擎', value: '未启动', tone: 'off' }],
          panels: [ { id: 'world', title: '世界' }, { id: 'log', title: '日志' }],
          links: [{ label: '打开 overlay', href: 'http://127.0.0.1:9/overlay' }],
        })),
      ]),
    });
    await withApp({ consolePageSources: sources }, async (base) => {
      const m = await manifestOf(base);
      expect(m.providers.map((p) => p.id)).toEqual(['world:alpha', 'world:beta']);
      expect(byId(m, 'world:alpha')?.panels?.map((x) => x.id)).toEqual(['gate']);
      expect(byId(m, 'world:beta')?.panels?.map((x) => x.id)).toEqual(['world', 'log']);
      expect(byId(m, 'world:alpha')?.links).toBeUndefined();
    });
  });

  it('World 声明的配置组:manifest 只带组 id,schema 与属性名一个字都不上线', async () => {
    const sources = deriveConsolePageSources(facts(), {
      assembly: WorldAssembly.ofInstances([new FakeWorld('demo', () => ({
        config: [{
          id: 'world:demo',
          owner: 'world:demo',
          schema: {
            type: 'object' as const,
            title: '样例 World 的旋钮',
            properties: { 'worlds.demo.n': { type: 'integer' as const, title: '条数' } },
          },
        }],
      }))]),
    });
    await withApp({ consolePageSources: sources }, async (base) => {
      const p = byId(await manifestOf(base), 'world:demo');
      expect(p?.configGroups).toEqual(['world:demo']);
      const text = JSON.stringify(p);
      expect(text).not.toContain('样例 World 的旋钮');
      expect(text).not.toContain('worlds.demo.n');
    });
  });

  it('World 声明的存储项:manifest 只带 key,stat 与 clear 不上线', async () => {
    const sources = deriveConsolePageSources(facts(), {
      assembly: WorldAssembly.ofInstances([new FakeWorld('demo', () => ({
        storage: [{ key: 'demo-log', label: '日志', kind: 'disk' as const, stat: () => '1', clear: () => '清了' }],
      }))]),
    });
    await withApp({ consolePageSources: sources }, async (base) => {
      const p = byId(await manifestOf(base), 'world:demo');
      expect(p?.storageKeys).toEqual(['demo-log']);
      expect(JSON.stringify(p)).not.toContain('清了');
    });
  });

  it('bot 级声明的配置组跟着人格 provider 走(Persona自己没实现 console() 也算)', async () => {
    const group = {
      id: 'persona',
      owner: 'persona' as const,
      schema: { type: 'object' as const, title: '认知节奏', properties: {} },
    };
    const sources = deriveConsolePageSources(
      facts(),
      { assembly: WorldAssembly.ofInstances([]) },
      { id: 'demo', label: '示例人格', configGroups: [group] },
    );
    await withApp({ consolePageSources: sources }, async (base) => {
      const p = byId(await manifestOf(base), 'persona:demo');
      expect(p?.kind).toBe('persona');
      expect(p?.configGroups).toEqual(['persona']);
    });
  });

  /** Persona 夹具:Persona 页一块面板,Memory 页一块面板,invoke 共用。 */
  const personaWithMemory = (memory: object | undefined): Persona => ({
    memory,
    console: () => ({
      panels: [{ id: 'notes', title: '笔记' }],
      memory: { panels: [{ id: 'workspace', title: '工作区' }] },
      invoke: async (panel: string, method: string) => ({ panel, method }),
    }),
  }) as unknown as Persona;

  it('Persona 的 memory 子声明成为 memory:<bot> 页:标题取 memoryName,面板归它,invoke 走同一个数据面', async () => {
    const sources = deriveConsolePageSources(
      facts(),
      { assembly: WorldAssembly.ofInstances([]), persona: personaWithMemory(undefined) },
      { id: 'demo', label: '示例人格', memoryName: 'GitMem' },
    );
    await withApp({ consolePageSources: sources }, async (base) => {
      const m = await manifestOf(base);
      expect(byId(m, 'persona:demo')?.panels?.map((x) => x.id)).toEqual(['notes']);
      const mem = byId(m, 'memory:demo');
      expect(mem?.kind).toBe('memory');
      expect(mem?.label).toBe('GitMem');
      expect(mem?.panels?.map((x) => x.id)).toEqual(['workspace']);
      const r = await fetch(`${base}${panelRoute('memory:demo', 'workspace', 'tree')}`, { method: 'POST' });
      expect(await r.json()).toEqual({ panel: 'workspace', method: 'tree' });
    });
  });

  it('没给 memoryName 时标题回落到 Memory 实例的类名;没有 memory 子声明就没有这一页', async () => {
    class GitWorkspaceMemory {}
    const named = deriveConsolePageSources(
      facts(),
      { assembly: WorldAssembly.ofInstances([]), persona: personaWithMemory(new GitWorkspaceMemory()) },
      { id: 'demo', label: '示例人格' },
    );
    await withApp({ consolePageSources: named }, async (base) => {
      expect(byId(await manifestOf(base), 'memory:demo')?.label).toBe('GitWorkspaceMemory');
    });
    const plain = { console: () => ({ panels: [{ id: 'notes', title: '笔记' }] }) } as unknown as Persona;
    const none = deriveConsolePageSources(
      facts(),
      { assembly: WorldAssembly.ofInstances([]), persona: plain },
      { id: 'demo', label: '示例人格' },
    );
    await withApp({ consolePageSources: none }, async (base) => {
      const m = await manifestOf(base);
      expect(byId(m, 'persona:demo')).toBeDefined();
      expect(byId(m, 'memory:demo')).toBeUndefined();
    });
  });

  it('badges 与 links 原样透传,框架不解释语义', async () => {
    const badges = [
      { label: '连接', value: '已连上', tone: 'on' as const },
      { label: '监听', value: '群 2 · 私聊 1' },
    ];
    const links = [{ label: '打开面板', href: 'http://127.0.0.1:8/x?y=1' }];
    const sources = deriveConsolePageSources(facts(), {
      assembly: WorldAssembly.ofInstances([new FakeWorld('demo', () => ({ badges, links }))]),
    });
    await withApp({ consolePageSources: sources }, async (base) => {
      const p = byId(await manifestOf(base), 'world:demo');
      expect(p?.badges).toEqual(badges);
      expect(p?.links).toEqual(links);
    });
  });

  it('那一排灯原样透传(顺序也是),不报灯就没有这个字段', async () => {
    const lamps = [
      { label: '甲链路', state: 'online' as const },
      { label: '乙链路', state: 'error' as const, hint: '连不上' },
    ];
    const sources = deriveConsolePageSources(facts(), {
      assembly: WorldAssembly.ofInstances([
        new FakeWorld('lit', () => ({ lamps })),
        new FakeWorld('mute', () => ({})),
      ]),
    });
    await withApp({ consolePageSources: sources }, async (base) => {
      const m = await manifestOf(base);
      expect(byId(m, 'world:lit')?.lamps).toEqual(lamps);
      expect(byId(m, 'world:mute')?.lamps).toBeUndefined();
    });
  });

  it('/api/console/lamps 只回灯:同一批 source,不带面板与前缀源索引', async () => {
    const sources = deriveConsolePageSources(facts(), {
      assembly: WorldAssembly.ofInstances([
        new FakeWorld('lit', () => ({
          lamps: [{ label: '甲链路', state: 'online' }],
          panels: [{ id: 'log', title: '日志' }],
          badges: [{ label: '连接', value: 1 }],
        })),
        new FakeWorld('mute', () => ({ panels: [{ id: 'log', title: '日志' }] })),
      ]),
    });
    await withApp({ consolePageSources: sources }, async (base) => {
      const r = await fetch(`${base}/api/console/lamps`);
      expect(r.status).toBe(200);
      const body = await r.json() as { lamps: Record<string, unknown> };
      expect(body).toEqual({ lamps: { 'world:lit': [{ label: '甲链路', state: 'online' }] } });
    });
  });

  it('「语言模型」那一行的灯与页的灯同表不同键,挂了才有', async () => {
    const lamp = { label: '可用端点', state: 'offline' as const, hint: '没有可用端点' };
    await withApp({ providersLamp: () => lamp }, async (base) => {
      const body = await (await fetch(`${base}/api/console/lamps`)).json() as { lamps: Record<string, unknown> };
      expect(body.lamps['framework:providers']).toEqual([lamp]);
    });
    await withApp({}, async (base) => {
      const body = await (await fetch(`${base}/api/console/lamps`)).json() as { lamps: Record<string, unknown> };
      expect(body.lamps['framework:providers']).toBeUndefined();
    });
  });

  it('灯是活数据:同一个 World 两次取,读到的是当下那排', async () => {
    let connected = false;
    const sources = deriveConsolePageSources(facts(), {
      assembly: WorldAssembly.ofInstances([new FakeWorld('demo', () => ({
        lamps: [connected
          ? { label: '连接', state: 'online' }
          : { label: '连接', state: 'loading', hint: '连接中' }],
      }))]),
    });
    await withApp({ consolePageSources: sources }, async (base) => {
      const read = async (): Promise<unknown> =>
        ((await (await fetch(`${base}/api/console/lamps`)).json()) as { lamps: Record<string, unknown> })
          .lamps['world:demo'];
      expect(await read()).toEqual([{ label: '连接', state: 'loading', hint: '连接中' }]);
      connected = true;
      expect(await read()).toEqual([{ label: '连接', state: 'online' }]);
    });
  });

  it('可见性与前缀漂移取自三态推导,不在适配器里重算', async () => {
    const sources = deriveConsolePageSources(
      facts({ hidden: false, shown: true }, ['hidden']),
      { assembly: WorldAssembly.ofInstances([new FakeWorld('hidden', () => ({})), new FakeWorld('shown', () => ({}))]) },
    );
    await withApp({ consolePageSources: sources }, async (base) => {
      const m = await manifestOf(base);
      expect(byId(m, 'world:hidden')?.agentVisible).toBe(false);
      expect(byId(m, 'world:hidden')?.prefixDrifted).toBe(true);
      expect(byId(m, 'world:shown')?.agentVisible).toBe(true);
      expect(byId(m, 'world:shown')?.prefixDrifted).toBe(false);
    });
  });

  it('只上控制台的未激活 World 照样出 provider(接入面板要在激活前就能用)', async () => {
    const sources = deriveConsolePageSources(facts(), {
      assembly: assemblyWith({
        inactive: [{ mod: new FakeWorld('later', () => ({ panels: [ { id: 'gate', title: '接入门' }] })), label: '稍后激活' }],
      }),
    });
    await withApp({ consolePageSources: sources }, async (base) => {
      const p = byId(await manifestOf(base), 'world:later');
      expect(p?.availability).toBe('inactive');
      expect(p?.label).toBe('稍后激活');
      expect(p?.panels?.map((x) => x.id)).toEqual(['gate']);
      // 没挂上就谈不上"对 agent 可见",这两个字段整条省掉
      expect(p?.agentVisible).toBeUndefined();
      expect(p?.prefixDrifted).toBeUndefined();
    });
  });

  it('Persona声明了、本地没实现的 World 报 missing 并带上原因', async () => {
    const sources = deriveConsolePageSources(facts(), {
      assembly: assemblyWith({ missing: [{ id: 'ghost', label: '装不上的 World', reason: '缺少依赖 xyz' }] }),
    });
    await withApp({ consolePageSources: sources }, async (base) => {
      const p = byId(await manifestOf(base), 'world:ghost');
      expect(p?.availability).toBe('missing');
      expect(p?.reason).toBe('缺少依赖 xyz');
      expect(p?.panels).toBeUndefined();
    });
  });

  it('一个 World 的 console() 抛错只丢它自己,别的 provider 照常在 manifest 里', async () => {
    const sources = deriveConsolePageSources(facts(), {
      assembly: WorldAssembly.ofInstances([
        new FakeWorld('boom', () => {
          throw new Error('World 声明炸了');
        }),
        new FakeWorld('fine', () => ({ panels: [ { id: 'gate', title: '接入门' }] })),
      ]),
    });
    await withApp({ consolePageSources: sources }, async (base) => {
      const r = await fetch(`${base}/api/console/manifest`);
      expect(r.status).toBe(200);
      const m = (await r.json()) as ConsoleManifest;
      expect(m.providers.map((p) => p.id)).toEqual(['world:fine']);
    });
  });

  it('provider id 重复时两个都丢掉,manifest 仍然 200', async () => {
    const dup = (label: string): ConsolePageSource => ({
      id: 'world:twin',
      contribute: () => ({ id: 'world:twin', kind: 'world' as const, label }),
    });
    const sources = (): ConsolePageSource[] => [
      dup('第一个'),
      dup('第二个'),
      { id: 'world:solo', contribute: () => ({ id: 'world:solo', kind: 'world' as const, label: '独苗' }) },
    ];
    await withApp({ consolePageSources: sources }, async (base) => {
      const r = await fetch(`${base}/api/console/manifest`);
      expect(r.status).toBe(200);
      const m = (await r.json()) as ConsoleManifest;
      expect(m.providers.map((p) => p.id)).toEqual(['world:solo']);
    });
  });
});

// ---------------------------------------------------------------------------

describe('panel 调用', () => {
  /** 记录 World 这一侧真正收到的 (panel, method, args) */
  const spy = () => {
    const calls: Array<{ panel: string; method: string; args: unknown[] }> = [];
    const mod = new FakeWorld('demo', () => ({
      panels: [ { id: 'gate', title: '接入门', getMethods: ['read'] }, { id: 'loose', title: 'loose' }],
      invoke: async (panel, method, args) => {
        calls.push({ panel, method, args });
        return { ok: true, panel };
      },
    }));
    return { calls, sources: deriveConsolePageSources(facts(), { assembly: WorldAssembly.ofInstances([mod]) }) };
  };

  it('POST 打到 World 的 invoke,World 收到的就是声明里那个 id', async () => {
    const { calls, sources } = spy();
    await withApp({ consolePageSources: sources }, async (base) => {
      const r = await fetch(`${base}${panelRoute('world:demo', 'gate', 'status')}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ args: [1, 'two'] }),
      });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ ok: true, panel: 'gate' });
      expect(calls).toEqual([{ panel: 'gate', method: 'status', args: [1, 'two'] }]);
    });
  });

  it('另一个面板同样原样直达', async () => {
    const { calls, sources } = spy();
    await withApp({ consolePageSources: sources }, async (base) => {
      await fetch(`${base}${panelRoute('world:demo', 'loose', 'ping')}`, { method: 'POST' });
      expect(calls).toEqual([{ panel: 'loose', method: 'ping', args: [] }]);
    });
  });

  it('GET 只对 getMethods 点名的方法开放:没点名的方法与没声明的面板都是 405,面板没被调到', async () => {
    const { calls, sources } = spy();
    await withApp({ consolePageSources: sources }, async (base) => {
      expect((await fetch(`${base}${panelRoute('world:demo', 'gate', 'status')}`)).status).toBe(405);
      expect((await fetch(`${base}${panelRoute('world:demo', 'loose', 'ping')}`)).status).toBe(405);
      expect(calls).toEqual([]);
    });
  });

  it('GET 的 args 走 query 里的 JSON 数组', async () => {
    const { calls, sources } = spy();
    await withApp({ consolePageSources: sources }, async (base) => {
      const url = `${base}${panelRoute('world:demo', 'gate', 'read')}?args=${encodeURIComponent('[1,2]')}`;
      expect((await fetch(url)).status).toBe(200);
      expect(calls[0].args).toEqual([1, 2]);
      // 不带 args 等于空参
      await fetch(`${base}${panelRoute('world:demo', 'gate', 'read')}`);
      expect(calls[1].args).toEqual([]);
    });
  });

  it('args 不是合法 JSON 或不是数组一律 400', async () => {
    const { calls, sources } = spy();
    await withApp({ consolePageSources: sources }, async (base) => {
      const route = panelRoute('world:demo', 'gate', 'read');
      expect((await fetch(`${base}${route}?args=notjson`)).status).toBe(400);
      expect((await fetch(`${base}${route}?args=${encodeURIComponent('{}')}`)).status).toBe(400);
      const post = await fetch(`${base}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ args: 'nope' }),
      });
      expect(post.status).toBe(400);
      expect(calls).toEqual([]);
    });
  });

  it('返回 { $binary } 时按二进制送回,Content-Type 与字节都对', async () => {
    const bytes = Buffer.from([0xff, 0x00, 0x41, 0x42]);
    const mod = new FakeWorld('demo', () => ({
      panels: [ { id: 'tts', title: '声线', getMethods: ['preview'] }],
      invoke: async () => ({ $binary: { mime: 'audio/wav', base64: bytes.toString('base64') } }),
    }));
    const sources = deriveConsolePageSources(facts(), { assembly: WorldAssembly.ofInstances([mod]) });
    await withApp({ consolePageSources: sources }, async (base) => {
      const r = await fetch(`${base}${panelRoute('world:demo', 'tts', 'preview')}`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe('audio/wav');
      expect(Buffer.from(await r.arrayBuffer())).toEqual(bytes);
    });
  });

  it('没这个 provider / 没声明这个面板都是 404,没有数据面是 503', async () => {
    const sources = deriveConsolePageSources(facts(), {
      assembly: WorldAssembly.ofInstances([
        new FakeWorld('demo', () => ({
          panels: [ { id: 'gate', title: '接入门', getMethods: ['status'] }],
          invoke: async () => ({ ok: true }),
        })),
        // 声明了面板但没有 invoke:面板存在、数据面缺席
        new FakeWorld('mute', () => ({ panels: [{ id: 'gate', title: '接入门', getMethods: ['status'] }] })),
      ]),
    });
    await withApp({ consolePageSources: sources }, async (base) => {
      const cases: Array<[string, number]> = [
        [panelRoute('world:nobody', 'gate', 'status'), 404],
        [panelRoute('world:demo', 'nosuch', 'status'), 404],
        [panelRoute('world:mute', 'gate', 'status'), 503],
        [panelRoute('world:demo', 'gate', 'status'), 200],
      ];
      for (const [route, want] of cases) {
        const r = await fetch(`${base}${route}`);
        expect([route, r.status]).toEqual([route, want]);
      }
    });
  });

  it('World 自己抛错是 500,错误信息原样透传给操作者', async () => {
    const mod = new FakeWorld('demo', () => ({
      panels: [ { id: 'gate', title: '接入门', getMethods: ['status'] }],
      invoke: async () => {
        throw new Error('后端没连上');
      },
    }));
    const sources = deriveConsolePageSources(facts(), { assembly: WorldAssembly.ofInstances([mod]) });
    await withApp({ consolePageSources: sources }, async (base) => {
      const r = await fetch(`${base}${panelRoute('world:demo', 'gate', 'status')}`);
      expect(r.status).toBe(500);
      expect(((await r.json()) as { error: string }).error).toContain('后端没连上');
    });
  });
});

// ---------------------------------------------------------------------------

describe('浏览器扩展资源', () => {
  const distWith = (name: string, providers: Record<string, unknown>): string => {
    const d = join(dir, `dist-${name}`);
    mkdirSync(d, { recursive: true });
    writeFileSync(
      join(d, 'asset-manifest.json'),
      JSON.stringify({ protocolVersion: 1, core: '/assets/console.js', providers }),
      'utf8',
    );
    return d;
  };

  const soleSource = deriveConsolePageSources(facts(), {
    assembly: WorldAssembly.ofInstances([new FakeWorld('demo', () => ({ panels: [ { id: 'gate', title: '接入门' }] }))]),
  });

  it('构建产物里有这个 provider 的条目时,manifest 带上 client', async () => {
    const webDistDir = distWith('ok', { 'world:demo': { js: '/assets/worlds/demo/client.js' } });
    await withApp({ consolePageSources: soleSource, webDistDir }, async (base) => {
      const p = byId(await manifestOf(base), 'world:demo');
      expect(p?.client).toEqual({ js: '/assets/worlds/demo/client.js' });
    });
  });

  it('没构建过不是错误:provider 照常出现,只是没有 client', async () => {
    await withApp({ consolePageSources: soleSource }, async (base) => {
      const p = byId(await manifestOf(base), 'world:demo');
      expect(p?.id).toBe('world:demo');
      expect(p?.client).toBeUndefined();
    });
  });

  it('跳出 /assets/ 的 URL 被拒,provider 仍在但不带 client', async () => {
    for (const [name, js] of [['evil', 'http://evil/x.js'], ['escape', '/assets/../etc/passwd']]) {
      const webDistDir = distWith(name, { 'world:demo': { js } });
      await withApp({ consolePageSources: soleSource, webDistDir }, async (base) => {
        const p = byId(await manifestOf(base), 'world:demo');
        expect([js, p?.id]).toEqual([js, 'world:demo']);
        expect([js, p?.client]).toEqual([js, undefined]);
      });
    }
  });
});
