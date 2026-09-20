/**
 * /api/run/pause 与 /api/run/resume 测试:fake run deps + 真WakeBus接线语义。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WakeBus } from '../../src/core/bus.ts';
import { WebApp } from '../../src/web/server.ts';
import { nullLogger } from '../../src/core/util.ts';
import { FakeStore } from './fakes.ts';

let app: WebApp;
let port: number;
let dir: string;
/** 关机被调过几次 + 它回的那份账(装配层给什么,接口就原样发什么) */
let shutdownCalls = 0;
const SHUTDOWN_REPORT = {
  localComplete: false,
  complete: false,
  steps: [
    { label: '按住事件投递', ok: true, elapsedMs: 2 },
    { label: 'World 收尾(托管的外部进程与存档都在这一步)', ok: true, elapsedMs: 4200 },
    { label: '托管 LLM server 停机', ok: false, elapsedMs: 3000, detail: '托管 LLM server 停机超时(3秒)' },
    { label: 'core 状态落盘', ok: true, elapsedMs: 4 },
  ],
  externalChecks: [],
};
const bus = new WakeBus({ quietGapMs: 20, minBatchAgeMs: 0, maxBatchAgeMs: 5000, maxBatchSize: 100 });

const base = () => `http://127.0.0.1:${port}`;
const post = async (path: string): Promise<{ status: number; body: any }> => {
  const r = await fetch(`${base()}${path}`, { method: 'POST' });
  return { status: r.status, body: (await r.json()) as any };
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'webtest-run-'));
  app = new WebApp({
    store: new FakeStore(),
    memoryDir: dir,
    dataDir: dir,
    getStatus: () => ({ loop: { paused: bus.isPaused() } }),
    run: {
      pause: () => bus.setPaused(true),
      resume: () => bus.setPaused(false),
      isPaused: () => bus.isPaused(),
      shutdown: async () => {
        shutdownCalls += 1;
        return SHUTDOWN_REPORT;
      },
    },
    log: nullLogger(),
  });
  port = await app.start(0);
});

afterAll(async () => {
  await app.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('/api/run', () => {
  it('pause→bus.paused=true且status可见;resume→false', async () => {
    const p = await post('/api/run/pause');
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ ok: true, paused: true });
    expect(bus.isPaused()).toBe(true);

    const st = (await (await fetch(`${base()}/api/status`)).json()) as any;
    expect(st.loop.paused).toBe(true);

    const r = await post('/api/run/resume');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, paused: false });
    expect(bus.isPaused()).toBe(false);
  });

  it('幂等:重复pause/resume不出错', async () => {
    expect((await post('/api/run/pause')).status).toBe(200);
    expect((await post('/api/run/pause')).status).toBe(200);
    expect((await post('/api/run/resume')).status).toBe(200);
    expect((await post('/api/run/resume')).status).toBe(200);
    expect(bus.isPaused()).toBe(false);
  });

  it('未挂载run依赖→503', async () => {
    const bare = new WebApp({
      store: new FakeStore(),
      memoryDir: dir,
      dataDir: dir,
      getStatus: () => ({}),
      log: nullLogger(),
    });
    const p2 = await bare.start(0);
    expect((await fetch(`http://127.0.0.1:${p2}/api/run/pause`, { method: 'POST' })).status).toBe(503);
    expect((await fetch(`http://127.0.0.1:${p2}/api/run/resume`, { method: 'POST' })).status).toBe(503);
    expect((await fetch(`http://127.0.0.1:${p2}/api/run/shutdown`, { method: 'POST' })).status).toBe(503);
    await bare.stop();
  });
});

describe('/api/run/shutdown', () => {
  it('回执等到仪式跑完才发,逐步结果原样带回来', async () => {
    const before = shutdownCalls;
    const r = await post('/api/run/shutdown');
    expect(r.status).toBe(200);
    expect(shutdownCalls).toBe(before + 1);
    // 有步骤被跳过 → ok=false,而且措辞点得出是哪一步(操作员唯一的回执)
    expect(r.body.ok).toBe(false);
    expect(r.body.localComplete).toBe(false);
    expect(r.body.complete).toBe(false);
    expect(r.body.steps).toHaveLength(4);
    expect(r.body.steps[1]).toMatchObject({ label: 'World 收尾(托管的外部进程与存档都在这一步)', ok: true });
    expect(String(r.body.result)).toContain('托管 LLM server 停机');
    expect(String(r.body.result)).toContain('本地关机完成');
  });

  it('本地完成但平台仍 live 时分层返回 P0 与人工动作', async () => {
    const external = new WebApp({
      store: new FakeStore(),
      memoryDir: dir,
      dataDir: dir,
      getStatus: () => ({}),
      run: {
        pause: () => {},
        resume: () => {},
        isPaused: () => false,
        shutdown: async () => ({
          localComplete: true,
          complete: false,
          steps: [{ label: 'World 收尾', ok: true, elapsedMs: 10 }],
          externalChecks: [{
            key: 'bilibili.live-room',
            label: 'B 站直播间 7734200',
            status: 'still-live' as const,
            detail: '平台仍显示直播中',
            manualAction: '打开主播后台手动下播。',
          }],
        }),
      },
      log: nullLogger(),
    });
    const externalPort = await external.start(0);
    try {
      const response = await fetch(`http://127.0.0.1:${externalPort}/api/run/shutdown`, { method: 'POST' });
      const body = await response.json() as Record<string, unknown>;
      expect(body).toMatchObject({ ok: false, localComplete: true, complete: false });
      expect(body.externalChecks).toEqual([expect.objectContaining({ status: 'still-live' })]);
      expect(String(body.result)).toContain('本地关机完成');
      expect(String(body.result)).toContain('[P0]');
      expect(String(body.result)).toContain('打开主播后台手动下播');
    } finally {
      await external.stop();
    }
  });

  it('能力清单里 shutdown 跟着 run.shutdown 走,不是跟着 run 走', async () => {
    const caps = (await (await fetch(`${base()}/api/capabilities`)).json()) as any;
    expect(caps.capabilities.run).toBe(true);
    expect(caps.capabilities.shutdown).toBe(true);

    // 只有暂停/继续、没有关机的部署:按钮不该长出来
    const noShutdown = new WebApp({
      store: new FakeStore(),
      memoryDir: dir,
      dataDir: dir,
      getStatus: () => ({}),
      run: { pause: () => {}, resume: () => {}, isPaused: () => false },
      log: nullLogger(),
    });
    const p3 = await noShutdown.start(0);
    const c3 = (await (await fetch(`http://127.0.0.1:${p3}/api/capabilities`)).json()) as any;
    expect(c3.capabilities.run).toBe(true);
    expect(c3.capabilities.shutdown).toBe(false);
    expect((await fetch(`http://127.0.0.1:${p3}/api/run/shutdown`, { method: 'POST' })).status).toBe(503);
    await noShutdown.stop();
  });
});

describe('/api/run/restart', () => {
  it('挂了 restart 才有能力位与端点;回执尾句按 supervised 说清会不会被拉起', async () => {
    const calls: boolean[] = [];
    const make = async (supervised: boolean, startsPaused = false) => {
      const a = new WebApp({
        store: new FakeStore(),
        memoryDir: dir,
        dataDir: dir,
        getStatus: () => ({}),
        run: {
          pause: () => {}, resume: () => {}, isPaused: () => false,
          restart: async () => { calls.push(supervised); return { complete: true, steps: [{ label: '按住事件投递', ok: true, elapsedMs: 1 }] }; },
          supervised,
          startsPaused,
        },
        log: nullLogger(),
      });
      const p = await a.start(0);
      return { a, p };
    };
    const sup = await make(true);
    const un = await make(false);
    try {
      const caps = await (await fetch(`http://127.0.0.1:${sup.p}/api/capabilities`)).json() as any;
      expect(caps.capabilities).toMatchObject({ restart: true, supervised: true, shutdown: false });
      const r1 = await (await fetch(`http://127.0.0.1:${sup.p}/api/run/restart`, { method: 'POST' })).json() as any;
      expect(r1.ok).toBe(true);
      expect(r1.steps).toHaveLength(1);
      expect(r1.result).toContain('启动器随即重新拉起');
      const caps2 = await (await fetch(`http://127.0.0.1:${un.p}/api/capabilities`)).json() as any;
      expect(caps2.capabilities).toMatchObject({ restart: true, supervised: false });
      const r2 = await (await fetch(`http://127.0.0.1:${un.p}/api/run/restart`, { method: 'POST' })).json() as any;
      expect(r2.result).toContain('需要手动重新启动');
      expect(calls).toEqual([true, false]);
    } finally {
      await sup.a.stop();
      await un.a.stop();
    }
  });

  it('重启后以暂停态回来时,回执说明要按继续', async () => {
    const app2 = new WebApp({
      store: new FakeStore(),
      memoryDir: dir,
      dataDir: dir,
      getStatus: () => ({}),
      run: {
        pause: () => {}, resume: () => {}, isPaused: () => false,
        restart: async () => ({ complete: true, steps: [] }),
        supervised: true,
        startsPaused: true,
      },
      log: nullLogger(),
    });
    const p = await app2.start(0);
    try {
      const r = await (await fetch(`http://127.0.0.1:${p}/api/run/restart`, { method: 'POST' })).json() as any;
      expect(r.result).toContain('事件投递是暂停的');
    } finally {
      await app2.stop();
    }
  });

  it('没挂 restart → 503,能力位 false(关机照旧)', async () => {
    const caps = await (await fetch(`${base()}/api/capabilities`)).json() as any;
    expect(caps.capabilities.restart).toBe(false);
    expect(caps.capabilities.shutdown).toBe(true);
    expect((await post('/api/run/restart')).status).toBe(503);
  });
});
