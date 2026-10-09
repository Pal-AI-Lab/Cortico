/**
 * 关机先暂停投递，再停止 World 和其他服务并保存状态。
 * 步骤失败或超时后继续后续步骤；整个关机过程只执行一次。
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Core } from "./fixture-core.ts";
import { CORE_DEFAULTS, type LoadedConfig } from '../../src/core/config.ts';
import { withDeadline } from '../../src/core/util.ts';
import { createBot, type BotDefinition } from '../../src/bot.ts';
import type {
  CoreConfig,
  World,
  WorldHost,
  ShutdownExternalCheck,
} from '../../src/core/types.ts';
import { FakeLLM, makeFakePersona } from './helpers.ts';

type TestConfig = CoreConfig & { loop: { softCap: number; hardCap: number } };

/** 停机行为可编排的探针 World:立刻停 / 永远不停 / 停的时候抛。 */
class ProbeWorld implements World {
  stopped = false;
  constructor(
    readonly id: string,
    private readonly mode: 'fast' | 'hang' | 'throw' = 'fast',
  ) {}
  envPromptVars(): Record<string, string> { return {}; }
  tools(): [] { return []; }
  async start(_host: WorldHost): Promise<void> { /* 探针不需要 host */ }
  stop(): Promise<void> {
    if (this.mode === 'hang') return new Promise<void>(() => { /* 永不 resolve */ });
    this.stopped = true;
    if (this.mode === 'throw') return Promise.reject(new Error('探针拒绝停机'));
    return Promise.resolve();
  }
}

class CheckedProbeWorld extends ProbeWorld {
  constructor(
    id: string,
    private readonly check: ShutdownExternalCheck,
    mode: 'fast' | 'hang' | 'throw' = 'fast',
  ) {
    super(id, mode);
  }
  shutdownVerification(): readonly ShutdownExternalCheck[] {
    return [{ ...this.check }];
  }
}

class HostLeaseProbeWorld extends ProbeWorld {
  host: WorldHost | null = null;
  override async start(host: WorldHost): Promise<void> {
    this.host = host;
  }
}

const checked = (status: ShutdownExternalCheck['status']): ShutdownExternalCheck => ({
  key: 'platform.broadcast',
  label: '外部直播平台',
  status,
  detail: status === 'verified-ended' ? '平台已确认结束' : '平台没有确认结束',
  manualAction: '打开平台后台人工确认并下播。',
});

function makeEnv(worlds: World[]): {
  dir: string;
  config: TestConfig;
  loaded: LoadedConfig<TestConfig>;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'shutdown-'));
  const config: TestConfig = {
    ...CORE_DEFAULTS,
    web: { ...CORE_DEFAULTS.web, port: 0 },
    paths: { memory: 'workspace', data: 'data' },
    context: { ...CORE_DEFAULTS.context },
    loop: { softCap: 8, hardCap: 16 },
  };
  const loaded: LoadedConfig<TestConfig> = {
    config,
    secret: () => 'k',
    rootDir: dir,
    memoryDir: join(dir, 'workspace'),
    dataDir: join(dir, 'data'),
  };
  void worlds;
  return { dir, config, loaded, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('withDeadline', () => {
  it('按时回来就原样放行', async () => {
    await expect(withDeadline(Promise.resolve('ok'), 1000)).resolves.toBe('ok');
  });

  it('不肯回来就抛,而且错误里说得出是哪一步', async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<void>(() => { /* 永不 resolve */ });
      const p = withDeadline(never, 5_000, 'World 收尾');
      const caught = p.catch((e: Error) => e.message);
      await vi.advanceTimersByTimeAsync(5_100);
      expect(await caught).toContain('World 收尾');
      expect(await caught).toContain('5s');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("core.stop():单个 World 未完成时仍停止其他 World", () => {
  it('挂住的那个到点被放弃,其余照常停完', async () => {
    const fast = new ProbeWorld('fast');
    const hang = new ProbeWorld('hang', 'hang');
    // 未完成的 stop 排在前面，验证其他 World 的 stop 仍可执行。
    const env = makeEnv([hang, fast]);
    vi.useFakeTimers();
    try {
      const core = new Core<TestConfig>(env.loaded, {
        persona: makeFakePersona([], { cfg: env.config as never, worlds: [hang, fast] }),
        worlds: [hang, fast],
        llm: new FakeLLM(),
      });
      // 此测试仅检查停止流程，不启动主循环。
      const done = core.stop();
      await vi.advanceTimersByTimeAsync(21_000);
      const failures = await done; // 单个 stop 未完成不能阻止整体超时返回。
      expect(fast.stopped).toBe(true);
      expect(hang.stopped).toBe(false);
      expect(failures).toEqual([expect.objectContaining({
        worldId: 'hang',
        detail: expect.stringContaining('timed out'),
      })]);
    } finally {
      vi.useRealTimers();
      env.cleanup();
    }
  });

  it('World stop 完成后捕获的旧 host 不能再写事件、用量或 session', async () => {
    const probe = new HostLeaseProbeWorld('lease');
    const env = makeEnv([probe]);
    try {
      const cognitionRequest = vi.fn(async () => ({ text: '不该启动' }));
      const persona = makeFakePersona([], { cfg: env.config as never, worlds: [probe] });
      persona.cognition = { request: cognitionRequest };
      const core = new Core<TestConfig>(env.loaded, {
        persona: persona,
        worlds: [probe],
        llm: new FakeLLM(),
      });
      const usage = vi.spyOn(
        core as unknown as { reportWorldUsage(...args: unknown[]): void },
        'reportWorldUsage',
      );
      await core.start();
      const host = probe.host!;
      const cachedCognition = host.cognition!;
      await core.stop();
      const cursor = core.store.latestCursor();

      await expect(host.pushEvent({
        type: 'late.event', ts: new Date().toISOString(), source: 'lease', text: '迟到事件',
      })).rejects.toThrow();
      host.pushDeferred({ type: 'late.deferred', render: () => '迟到延迟事件' });
      host.reportUsage({ promptTokens: 1, completionTokens: 1, cacheHitTokens: 0, cacheMissTokens: 1 });

      expect(core.store.latestCursor()).toBe(cursor);
      expect(usage).not.toHaveBeenCalled();
      expect(host.cognition).toBeUndefined();
      expect(await cachedCognition.request({ brief: '迟到请求' })).toEqual({ error: expect.any(String) });
      expect(cognitionRequest).not.toHaveBeenCalled();
    } finally {
      env.cleanup();
    }
  });

  it('World stop 超时的期限一到也立即封住旧 host', async () => {
    const probe = new HostLeaseProbeWorld('lease-timeout', 'hang');
    const env = makeEnv([probe]);
    vi.useFakeTimers();
    try {
      const core = new Core<TestConfig>(env.loaded, {
        persona: makeFakePersona([], { cfg: env.config as never, worlds: [probe] }),
        worlds: [probe],
        llm: new FakeLLM(),
      });
      await core.start();
      const stopping = core.stop();
      await vi.advanceTimersByTimeAsync(21_000);
      expect(await stopping).toEqual([expect.objectContaining({ worldId: 'lease-timeout' })]);
      await expect(probe.host!.pushEvent({
        type: 'late.timeout', ts: new Date().toISOString(), source: 'lease-timeout', text: '超时后事件',
      })).rejects.toThrow();
    } finally {
      vi.useRealTimers();
      env.cleanup();
    }
  });
});

/** 不启动控制台的 bot，用于测试关机顺序。 */
function makeHeadlessBot(worlds: World[], onStop?: () => void | Promise<void>) {
  const env = makeEnv(worlds);
  const definition: BotDefinition<TestConfig> = {
    id: 'probe-bot',
    defaults: () => env.config,
    build: (loaded) => ({
      persona: makeFakePersona([], { cfg: loaded.config as never, worlds: worlds }),
      worlds: worlds,
      llm: new FakeLLM(),
      ...(onStop ? { onStop } : {}),
      console: { enabled: false },
    }),
  };
  return { bot: createBot(env.loaded, definition), cleanup: env.cleanup };
}

describe("bot.shutdown():执行顺序与步骤结果", () => {
  it('顺利时各步全过,Persona有独立且受控的收尾阶段', async () => {
    const probe = new ProbeWorld('probe');
    const { bot, cleanup } = makeHeadlessBot([probe]);
    try {
      await bot.start();
      const report = await bot.shutdown('测试');
      expect(report.complete).toBe(true);
      expect(report.localComplete).toBe(true);
      expect(report.externalChecks).toEqual([]);
      expect(report.reason).toBe('测试');
      // 控制台没起,所以没有 web 那一步。
      expect(report.steps.map((s) => s.key)).toEqual(['pause', 'worlds', 'core', 'llm', 'flush']);
      expect(report.steps.every((s) => s.ok)).toBe(true);
      // 关机前先暂停事件投递，避免启动新的模型轮。
      expect(bot.core.bus.isPaused()).toBe(true);
      expect(probe.stopped).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("步骤失败后继续执行，并记录失败步骤", async () => {
    const probe = new ProbeWorld('probe');
    const { bot, cleanup } = makeHeadlessBot([probe], () => {
      throw new Error('Persona收尾炸了');
    });
    try {
      await bot.start();
      const report = await bot.shutdown('测试');
      expect(report.complete).toBe(false);
      expect(report.localComplete).toBe(false);
      const core = report.steps.find((s) => s.key === 'core');
      expect(core?.ok).toBe(false);
      expect(core?.detail).toContain('Persona收尾炸了');
      // 前一步失败后，保存步骤仍须执行。
      expect(report.steps.find((s) => s.key === 'flush')?.ok).toBe(true);
      expect(report.steps.map((s) => s.key)).toContain('llm');
    } finally {
      cleanup();
    }
  });

  it('单个 World 停机超时会让 worlds 步和 localComplete 失败，后续落盘仍继续', async () => {
    const hang = new ProbeWorld('hang', 'hang');
    const { bot, cleanup } = makeHeadlessBot([hang]);
    vi.useFakeTimers();
    try {
      await bot.start();
      const stopping = bot.shutdown('测试 World 超时');
      await vi.advanceTimersByTimeAsync(21_000);
      const report = await stopping;

      expect(report.localComplete).toBe(false);
      expect(report.complete).toBe(false);
      expect(report.steps.find((step) => step.key === 'worlds')).toMatchObject({
        ok: false,
        detail: expect.stringContaining('hang'),
      });
      expect(report.steps.find((step) => step.key === 'flush')?.ok).toBe(true);
    } finally {
      vi.useRealTimers();
      cleanup();
    }
  });

  it('World 停止失败时不采用它缓存的 verified-ended 外部状态', async () => {
    const hang = new CheckedProbeWorld('checked-hang', checked('verified-ended'), 'hang');
    const { bot, cleanup } = makeHeadlessBot([hang]);
    vi.useFakeTimers();
    try {
      await bot.start();
      const stopping = bot.shutdown('测试核验保守降级');
      await vi.advanceTimersByTimeAsync(21_000);
      const report = await stopping;

      expect(report.externalChecks).toEqual([expect.objectContaining({
        key: 'checked-hang.shutdown-verification',
        status: 'unknown',
        detail: expect.stringContaining('World 停止未完成'),
      })]);
    } finally {
      vi.useRealTimers();
      cleanup();
    }
  });

  it('主循环 drain 超时后Persona只收尾一次，迟到 resolve 不会重新启动收尾', async () => {
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => { release = resolve; });
    let coreStops = 0;
    const probe = new ProbeWorld('probe');
    const { bot, cleanup } = makeHeadlessBot([probe], () => { coreStops += 1; });
    vi.useFakeTimers();
    try {
      await bot.start();
      (bot.core as unknown as { runPromise: Promise<void> }).runPromise = stalled;
      const stopping = bot.shutdown('测试主循环迟到');
      await vi.advanceTimersByTimeAsync(1_100);
      const report = await stopping;

      expect(report.steps.find((step) => step.key === 'worlds')).toMatchObject({
        ok: false,
        detail: expect.stringContaining('core.loop'),
      });
      expect(coreStops).toBe(1);
      release();
      await Promise.resolve();
      expect(coreStops).toBe(1);
    } finally {
      vi.useRealTimers();
      cleanup();
    }
  });

  it('本地步骤全过但平台仍 live 时 complete=false，并记录 P0 人工动作', async () => {
    const probe = new CheckedProbeWorld('checked-live', checked('still-live'));
    const { bot, cleanup } = makeHeadlessBot([probe]);
    try {
      await bot.start();
      const report = await bot.shutdown('测试外部状态');
      expect(report.localComplete).toBe(true);
      expect(report.complete).toBe(false);
      expect(report.externalChecks).toEqual([expect.objectContaining({
        status: 'still-live',
        manualAction: '打开平台后台人工确认并下播。',
      })]);
      const log = readFileSync(join(bot.core.run.dir, 'log.jsonl'), 'utf8');
      expect(log).toContain('[P0] 外部状态未确认结束');
      expect(log).toContain('打开平台后台人工确认并下播');
      // 关机总结须纳入外部步骤的未确认状态。
      expect(log).not.toContain('本地关机完成:各步全部走完');
      expect(log).toContain('本地关机完成,但外部状态未确认结束');
    } finally {
      cleanup();
    }
  });

  it('本地步骤全过且声明的外部状态 verified-ended 时 complete=true', async () => {
    const probe = new CheckedProbeWorld('checked-ended', checked('verified-ended'));
    const { bot, cleanup } = makeHeadlessBot([probe]);
    try {
      await bot.start();
      const report = await bot.shutdown('测试外部状态');
      expect(report.localComplete).toBe(true);
      expect(report.complete).toBe(true);
      expect(report.externalChecks[0].status).toBe('verified-ended');
    } finally {
      cleanup();
    }
  });

  it("重复关机返回同一结果，不再次停止 World", async () => {
    let stops = 0;
    const probe = new ProbeWorld('probe');
    const counting: World = {
      ...probe,
      id: 'counting',
      envPromptVars: () => ({}),
      tools: () => [],
      start: async () => {},
      stop: async () => { stops += 1; },
    };
    const { bot, cleanup } = makeHeadlessBot([counting]);
    try {
      await bot.start();
      const [a, b] = await Promise.all([bot.shutdown('第一次'), bot.shutdown('第二次')]);
      expect(a).toBe(b);
      expect(a.reason).toBe('第一次');
      expect(stops).toBe(1);
    } finally {
      cleanup();
    }
  });
});
