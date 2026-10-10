/**
 * 代理 ↔ 引擎子进程链路的集成测试:真的 fork 一个引擎子进程(engine-child.ts),
 * 走完 init/工具/面板/状态推送/停机的完整来回。游戏语义本身归 module.test.ts
 * (进程内);这里只验证跨进程语义。不连接 Minecraft 服务器，工具与面板按未连接
 * 状态的既定契约响应。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventEnvelope, WorldHost, PushOptions } from '../../../src/core/types.ts';
import { renderWorldEnvPrompt } from '../../../src/core/prefix.ts';
import { MinecraftWorldProxy } from '../../../src/worlds/minecraft/proxy.ts';
import { MINECRAFT_DEFAULTS, type MinecraftConfigSection } from '../../../src/worlds/minecraft/config.ts';
import { MINECRAFT_TOOL_DECLS } from '../../../src/worlds/minecraft/world.ts';

class FakeHost implements WorldHost {
  events: Array<{ e: EventEnvelope; opts?: PushOptions }> = [];
  deferred: Array<{
    type: string;
    render: () => string | null | Promise<string | null>;
    trigger?: string;
  }> = [];
  pushDeferred(
    e: { type: string; senderKey?: string; meta?: Record<string, unknown>; render: () => string | null | Promise<string | null> },
    opts?: { trigger?: string },
  ): void {
    this.deferred.push({ type: e.type, render: e.render, trigger: opts?.trigger });
  }
  notes: string[] = [];
  logs: Array<{ level: string; msg: string }> = [];
  store = {
    get: () => undefined,
    latestCursor: () => 0,
    range: () => [],
    around: () => [],
    grep: () => [],
  } as unknown as WorldHost['store'];
  blob = (_handle: string): { bytes: Uint8Array; mime: string } | null => null;
  modelFacts: { model: () => string; accepts: (mime: string) => boolean; contextWindow: () => number | undefined } =
    { model: () => 'test', accepts: () => false, contextWindow: () => 128000 };
  log: WorldHost['log'];

  constructor() {
    const make = (): WorldHost['log'] => {
      const push = (level: string) => (msg: string) => this.logs.push({ level, msg });
      return {
        child: () => make(),
        trace: push('trace'),
        emit: (level: string, msg: string) => push(level)(msg),
        debug: push('debug'),
        info: push('info'),
        warn: push('warn'),
        error: push('error'),
      } as WorldHost['log'];
    };
    this.log = make();
  }

  async pushEvent(e: Omit<EventEnvelope, 'cursor'>, opts?: PushOptions): Promise<EventEnvelope> {
    const full = { ...e, cursor: this.events.length + 1 } as EventEnvelope;
    this.events.push({ e: full, opts });
    return full;
  }
  async drainPendingEvents(): Promise<EventEnvelope[]> {
    return [];
  }
  reportUsage(): void {}
}

function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (cond()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        reject(new Error('waitFor 超时'));
      }
    }, 25);
  });
}

describe('MinecraftWorldProxy(引擎子进程)', () => {
  let host: FakeHost;
  let proxy: MinecraftWorldProxy;
  let dir: string;
  let cfg: MinecraftConfigSection;

  beforeAll(async () => {
    host = new FakeHost();
    dir = mkdtempSync(join(tmpdir(), 'mc-proxy-'));
    cfg = structuredClone(MINECRAFT_DEFAULTS) as unknown as MinecraftConfigSection;
    cfg.enabled = true;
    cfg.host = '127.0.0.1';
    cfg.port = 1; // 没人监听:重连循环是正常态
    cfg.viewerPort = 0;
    cfg.client.enabled = false;
    proxy = new MinecraftWorldProxy({
      cfg,
      timezone: 'Asia/Shanghai',
      botName: 'ProxyTest',
      dataDir: dir,
    });
    await proxy.start(host);
  }, 60_000);

  afterAll(async () => {
    await proxy.stop();
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it('工具面与真 World 逐字节一致(共用同一份声明)', () => {
    const names = proxy.tools().map((t) => t.name);
    expect(names).toEqual(MINECRAFT_TOOL_DECLS.map((d) => d.name));
  });

  it('工具调用过界:mc_stop 回队列文本', async () => {
    const stop = proxy.tools().find((t) => t.name === 'mc_stop');
    const out = await stop!.handler({}, { role: 'main', log: host.log });
    expect(typeof out).toBe('string');
    expect(out).not.toContain('引擎进程不可用');
  });

  it('显式 round 穿过代理和子进程:同轮去重,下一轮重新读取', async () => {
    const blocked = proxy.tools().find((t) => t.name === 'mc_blocked')!;
    expect(await blocked.handler({}, { role: 'main', log: host.log, round: 41 }))
      .toContain('[上次没成]');
    expect(await blocked.handler({}, { role: 'main', log: host.log, round: 41 }))
      .toBe('这轮已经答过了,答案不会变,先看上一条。');
    expect(await blocked.handler({}, { role: 'main', log: host.log, round: 42 }))
      .toContain('[上次没成]');
  });

  it('面板调用过界:server.state 报未配置目录', async () => {
    const invoke = proxy.console().invoke!;
    const st = (await invoke('server', 'state', [])) as { phase: string; configured: boolean };
    expect(st.configured).toBe(false);
  });

  it('面板调用前同步刚写入的路径配置', async () => {
    cfg.local.serverDir = dir;
    const st = await proxy.console().invoke!('server', 'state', []) as { serverDir: string };
    expect(st.serverDir).toBe(dir);
    cfg.local.serverDir = '';
  });

  it('状态推送填充徽标与存储统计;账本可跨界清除', async () => {
    // 灯与徽标同批跨界。等的是**灯变了**:徽标与存储在子进程报上来之前就有占位值,
    // 拿它们当"报上来了"的判据等于没等。
    await waitFor(() => proxy.console().lamps?.[0]?.label !== '引擎');
    expect((proxy.console().badges?.length ?? 0) > 0 && (proxy.console().storage?.length ?? 0) > 0).toBe(true);
    const storage = proxy.console().storage!;
    const chests = storage.find((s) => s.key === 'minecraft-chests');
    expect(chests).toBeTruthy();
    expect(typeof chests!.stat()).toBe('string');
    const cleared = await chests!.clear();
    expect(typeof cleared).toBe('string');
  });

  it('子进程日志转发回主进程宿主', async () => {
    await waitFor(() => host.logs.length > 0);
  });

  /**
   * cognition 可用性通过 caps 传给子进程，请求通过 hreq 往返。
   * 主进程没有句柄时，子进程也不提供 cognition 属性，以便构思流程选择可用档位。
   */
  it('主进程没有 cognition 句柄:子进程那边这个档就是不可用,受理刻如实回执', async () => {
    expect((host as unknown as { cognition?: unknown }).cognition).toBeUndefined();
    const bp = proxy.tools().find((t) => t.name === 'mc_blueprint')!;
    const receipt = await bp.handler(
      { design: { key: 'nobody', brief: '随便盖点什么' } },
      { role: 'main', log: host.log },
    ) as string;
    expect(receipt).toContain('走不通');
    expect(receipt).toContain('这一单没受理');
  }, 30_000);

  it('认知外包跨进程:能力位随 caps 到位,请求经 hreq 回主进程,交稿走同一个 save', async () => {
    const briefs: string[] = [];
    const bp = proxy.tools().find((t) => t.name === 'mc_blueprint')!;
    const ctx = { role: 'main', log: host.log };
    (host as unknown as { cognition?: unknown }).cognition = {
      request: async (req: { brief: string; tools?: string[] }) => {
        briefs.push(req.brief);
        expect(req.tools).toEqual(['mc_blueprint']);
        const jobId = req.brief.match(/job_id 是「([^」]+)」/)?.[1];
        expect(jobId).toMatch(/^bpj_/);
        const revision = briefs.length > 1;
        if (revision) {
          expect(req.brief).toContain('这是同键修订轮');
          expect(req.brief).toContain('上一版:new');
          expect(req.brief).toContain('刷怪塔和红石时钟');
        }
        // 她那一侧交稿的唯一方式就是点这把工具 —— 再经 RPC 回子进程装载
        await bp.handler({
          save: {
            key: 'proxy-bp', name: revision ? '刷怪塔时钟' : '台子', site_mode: 'new',
            job_id: jobId,
            size_xyz: revision ? [2, 1, 1] : [1, 1, 1], axis_order: 'YZX',
            palette: revision
              ? [
                  'minecraft:cobblestone',
                  'minecraft:repeater[delay=4,facing=north,locked=false,powered=false]',
                ]
              : ['minecraft:cobblestone'],
            layers: revision ? [[[0, 1]]] : [[[0]]],
          },
        }, ctx);
        return { text: revision
          ? '我把同一个键升级成了带四档中继器的刷怪塔时钟，并重新交稿了。'
          : '我搭了个一格的台子。' };
      },
    };
    // caps 搭配置那条 1s 采样线过界:等到子进程那边认得出这个档
    let receipt = '';
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      receipt = await bp.handler({ design: { key: 'proxy-bp', brief: '一个一格的台子' } }, ctx) as string;
      if (!receipt.includes('走不通')) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(receipt).toContain('构思在后台开工了');
    await waitFor(() => host.events.some((e) => e.e.text.includes('构思出来了')), 20_000);
    expect(briefs[0]).toContain('proxy-bp');
    expect(briefs[0]).toContain('layers[y][z][x]');
    const said = host.events.find((e) => e.e.text.includes('构思出来了'))!.e.text;
    expect(said).toContain('我搭了个一格的台子');
    expect(said).toContain('接下来三件事');
    expect(await bp.handler({}, ctx)).toContain('proxy-bp');

    const completed = host.events.filter((e) => e.e.text.includes('构思出来了')).length;
    const revised = await bp.handler({
      design: { key: 'proxy-bp', brief: '把它升级成刷怪塔和红石时钟，保留同一个键' },
    }, ctx) as string;
    expect(revised).toContain('构思在后台开工了');
    await waitFor(
      () => host.events.filter((e) => e.e.text.includes('构思出来了')).length > completed,
      20_000,
    );
    expect(briefs).toHaveLength(2);
    expect(host.events.filter((e) => e.e.text.includes('构思出来了')).at(-1)?.e.text)
      .toContain('我把同一个键升级成了带四档中继器的刷怪塔时钟');
    const query = await bp.handler({}, ctx) as string;
    expect(query).toContain('2×1×1 [空地新建]');
    expect(query).toMatch(/\[version:bpv_[^;\]]+;hash:[0-9a-f]{64}\]/);
  }, 40_000);
});

/**
 * 引擎运行在子进程，环境前缀由主进程代理提供；代理须补全模板变量。
 */
describe('MinecraftWorldProxy(前缀变量)', () => {
  it('世界名现读 server.properties;渲染出的环境提示词一个花括号都不剩', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-proxy-env-'));
    try {
      const cfg = structuredClone(MINECRAFT_DEFAULTS) as unknown as MinecraftConfigSection;
      cfg.host = '127.0.0.1';
      cfg.port = 25565;
      cfg.client.enabled = false;
      cfg.local.serverDir = dir;
      writeFileSync(join(dir, 'server.properties'), 'level-name=世界33\n', 'utf8');
      const cold = new MinecraftWorldProxy({ cfg, dataDir: dir });
      expect(cold.envPromptVars()['minecraft.world']).toBe('当前存档:「世界33」');
      const { text } = await renderWorldEnvPrompt(cold);
      expect(text).toContain('当前存档:「世界33」');
      expect(text).not.toContain('{{');

      // 没配本地目录(或读不出存档名)时退到地址,同样是插值过的
      cfg.local.serverDir = '';
      expect(cold.envPromptVars()['minecraft.world']).toBe('当前服务器:127.0.0.1:25565');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('外部服务器不读本地存档名;子进程报了状态后用它按当前连接算的那一行', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-proxy-ext-'));
    try {
      const cfg = structuredClone(MINECRAFT_DEFAULTS) as unknown as MinecraftConfigSection;
      cfg.serverMode = 'external';
      cfg.host = 'mc.example.org';
      cfg.port = 25570;
      cfg.local.serverDir = dir;
      writeFileSync(join(dir, 'server.properties'), 'level-name=世界33\n', 'utf8');
      const proxy = new MinecraftWorldProxy({ cfg, dataDir: dir });
      expect(proxy.envPromptVars()['minecraft.world']).toBe('当前服务器:mc.example.org:25570');

      // 配置已改到新端口,连接仍在旧端口上:以子进程报的为准
      cfg.port = 25571;
      // 状态推送只在挂上宿主后处理
      Object.assign(proxy, { host: {} });
      (proxy as unknown as { onNote(note: unknown): void }).onNote({
        kind: 'status', decl: {}, worldLine: '当前服务器:mc.example.org:25570', storage: [],
      });
      expect(proxy.envPromptVars()['minecraft.world']).toBe('当前服务器:mc.example.org:25570');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('MinecraftWorldProxy(子进程未起时的存储面)', () => {
  it('存储清单装配期就报全;引擎没起时 stat 读文件、清除直清文件', async () => {
    // 可清存储清单在装配期汇总一次，代理须在子进程启动前完整声明存储项。
    const dir = mkdtempSync(join(tmpdir(), 'mc-proxy-cold-'));
    try {
      const cfg = structuredClone(MINECRAFT_DEFAULTS) as unknown as MinecraftConfigSection;
      const chestsFile = join(dir, 'minecraft-chests.json');
      writeFileSync(chestsFile, JSON.stringify({ chests: [{ pos: [1, 2, 3] }] }), 'utf8');
      const cold = new MinecraftWorldProxy({ cfg, dataDir: dir });
      const storage = cold.console().storage ?? [];
      expect(storage.map((s) => s.key))
        .toEqual([
          'minecraft-chests', 'minecraft-deaths', 'minecraft-explored', 'minecraft-works',
          'minecraft-policy', 'minecraft-blueprints',
          // PWSR 暂态是内存的:代理侧没有对应文件,stat/clear 走「引擎没起就没有」那一支,
          // 引擎起着时由子进程推来的缓存报真实规模(storage-clear 走 RPC,子进程按 key 找)
          'minecraft-pwsr',
        ]);
      const pwsr = storage.find((s) => s.key === 'minecraft-pwsr')!;
      expect(pwsr.kind).toBe('memory');
      expect(await pwsr.clear()).toContain('无需清除');
      const chests = storage.find((s) => s.key === 'minecraft-chests')!;
      expect(chests.stat()).toContain('KB');
      const cleared = await chests.clear();
      expect(cleared).toContain('直清文件');
      expect(readFileSync(chestsFile, 'utf8')).toBe('{}\n');

      // 探索账本:旧平面记录没有 realm/dimension,代理不得猜进当前世界；
      // 已归属的 v2 记录逐维度展示,直清后整段消失。
      const exploredFile = join(dir, 'minecraft-explored.json');
      writeFileSync(exploredFile, JSON.stringify({ east: { distance: 80, biome: 'forest', at: 1 } }), 'utf8');
      expect(cold.envPromptVars()['minecraft.explored']).toBe('');
      writeFileSync(exploredFile, JSON.stringify({
        version: 2,
        currentRealm: 'realm-a',
        realms: {
          'realm-a': {
            'minecraft:overworld': { east: { distance: 80, biome: 'forest', at: 1 } },
          },
        },
      }), 'utf8');
      expect(cold.envPromptVars()['minecraft.explored']).toContain('[主世界] 探过:东80(森林)');
      const explored = storage.find((s) => s.key === 'minecraft-explored')!;
      await explored.clear();
      expect(readFileSync(exploredFile, 'utf8').trim()).toBe('{}');
      expect(cold.envPromptVars()['minecraft.explored']).toBe('');

      // 常驻规矩同形:代理侧现读落盘文件,全默认时那一格是空串
      const policyFile = join(dir, 'minecraft-policy.json');
      expect(cold.envPromptVars()['minecraft.policy']).toBe('');
      writeFileSync(policyFile, JSON.stringify({ reserve: ['iron_pickaxe'], fight: 'off' }), 'utf8');
      // 代理侧读的是同一个 loadPolicy:五格照读,fight 不跨重启所以读不出来
      expect(cold.envPromptVars()['minecraft.policy']).toContain('铁镐收着不主动拿');
      expect(cold.envPromptVars()['minecraft.policy']).not.toContain('不主动动手');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
