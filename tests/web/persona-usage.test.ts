import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebApp, type UsageReport } from '../../src/web/server.ts';
import { JsonlEventStore } from '../../src/core/event-store.ts';
import { USAGE_LOG_FILE, UsageLog, WORLD_USAGE_ROLE_PREFIX } from '../../src/core/usage-log.ts';
import { WORLD_ACTIVITY_LOG_FILE, WorldActivityLog } from '../../src/core/world-activity-log.ts';
import { aggregateUsage, usageRecordFilter } from '../../src/core/cost.ts';
import { nullLogger } from '../../src/core/util.ts';
import type { UsageRecord } from '../../src/core/types.ts';
import type { BotConfig } from '../../bots/corti-soulmate/assemble.ts';
import { composeDefaults } from '../../bots/corti-soulmate/assemble.ts';
import { CORE_CONFIG_GROUP } from '../../src/core/config.ts';
import { PERSONA_CONFIG_GROUP } from '../../bots/corti-soulmate/persona/config.ts';
import { webSearchConfigGroup } from '../../src/worlds/websearch/config.ts';
import { readGroupValues, setByPath, type ConfigGroup } from '../../src/core/config-schema.ts';

let app: WebApp;
let port: number;
let memoryDir: string;
let dataDir: string;
let store: JsonlEventStore;

const timezone = 'Asia/Shanghai';
const world = 'sample';
const worldRole = WORLD_USAGE_ROLE_PREFIX + world;
const model = 'fixture-model';
const pushes = ['events', 'events'] as const;

const base = () => `http://127.0.0.1:${port}`;
const getJ = async (p: string): Promise<any> => (await fetch(`${base()}${p}`)).json();
const postJ = async (p: string, body?: any): Promise<{ status: number; body: any }> => {
  const r = await fetch(`${base()}${p}`, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: (await r.json()) as any };
};

// 拿真声明 + 真 BotConfig,验证 WebUI 按 schema 读写活配置
// 深拷贝:composeDefaults 里若干段是默认值对象的直接引用,测试要就地热改不能污染它们
const cfg: BotConfig = JSON.parse(JSON.stringify(composeDefaults())) as BotConfig;
cfg.dream.maxRounds = 6;
cfg.batching.quietGapMs = 2500;
const configGroups: ConfigGroup[] = [CORE_CONFIG_GROUP, PERSONA_CONFIG_GROUP, webSearchConfigGroup('zh')];

beforeAll(async () => {
  memoryDir = mkdtempSync(join(tmpdir(), 'webpersona-'));
  dataDir = mkdtempSync(join(tmpdir(), 'webpersona-data-'));
  const run = 'fixture-run';
  store = new JsonlEventStore({ dataDir, run, timezone });
  const usage = new UsageLog(join(dataDir, USAGE_LOG_FILE));
  const activity = new WorldActivityLog(join(dataDir, WORLD_ACTIVITY_LOG_FILE), { run, timezone: () => timezone });
  const rec = (ts: string, role: string, miss: number, comp: number): UsageRecord => ({
    ts, sessionId: role, role, label: 'Model usage', model,
    promptTokens: miss, completionTokens: comp, cacheHitTokens: 0, cacheMissTokens: miss, reasoningTokens: 0,
  });
  const reportedAt = '2026-07-19T09:00:00+08:00';
  usage.append(rec(reportedAt, worldRole, 1_000_000, 1_000_000));
  usage.append(rec('2026-07-19T10:00:00+08:00', 'main', 0, 500_000));
  for (const push of pushes) activity.record(world, push, Date.parse(reportedAt));
  activity.record(world, 'rounds', Date.parse(reportedAt));

  app = new WebApp({
    store,
    memoryDir,
    dataDir,
    getStatus: () => ({}),
    usage: { aggregate: async opts => {
      const options = { ...opts, timezone };
      const keep = usageRecordFilter(options);
      return aggregateUsage(await usage.readAll(keep), options, await activity.readAll(keep));
    } },
    config: {
      groups: () => configGroups.map((group) => ({ group, values: readGroupValues(cfg, group) })),
      set: (groupId, values) => {
        const root = cfg as unknown as Record<string, unknown>;
        for (const [path, v] of Object.entries(values)) setByPath(root, path, v);
        return `${groupId} ok`;
      },
    },
    // 框架级表面(不在 extensions 里)
    log: nullLogger(),
  });
  port = await app.start(0);
});

afterAll(async () => {
  await app.stop();
  rmSync(memoryDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe('/api/usage', () => {
  it('聚合 World 自报 token，未提交报价时显示未报价', async () => {
    const d = await getJ('/api/usage?bucket=hour&from=2026-07-19&to=2026-07-19');
    expect(d.totals.calls).toBe(2);
    expect(d.series.filter((s: { calls: number }) => s.calls > 0).length).toBe(2); // 09 / 10 两个小时桶
    expect(d.totals.cost).toBe(0);
    expect(d.totals.unpricedCalls).toBe(2);
    expect(d.byModel[0].key).toBe(model);
  });

  it('returns World push and round counts with the World model totals', async () => {
    const report: UsageReport = await getJ('/api/usage?bucket=hour&from=2026-07-19&to=2026-07-19');
    const ownUsage = report.byRole.find(group => group.key === worldRole)!;
    expect(report.byWorld).toEqual([{
      ...ownUsage, key: world, events: pushes.length, calls: pushes.length, rounds: 1,
    }]);
  });

  it('returns an empty byWorld when usage is unmounted', async () => {
    const unmounted = new WebApp({ store, memoryDir, dataDir, getStatus: () => ({}), log: nullLogger() });
    try {
      const port = await unmounted.start(0);
      const response = await fetch(`http://127.0.0.1:${port}/api/usage`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ series: [], totals: null, byWorld: [] });
    } finally {
      await unmounted.stop();
    }
  });

  it('带 dailyTokenDays 时同一次回应附上逐日 token;不带时回应里没有 dailyTokens', async () => {
    const range = '/api/usage?bucket=hour&from=2026-07-19&to=2026-07-19';
    const plain = await getJ(range);
    const d = await getJ(`${range}&dailyTokenDays=2`);
    expect('dailyTokens' in plain).toBe(false);
    expect(d.dailyTokens).toEqual([{ day: '2026-07-18', tokens: 0 }, { day: '2026-07-19', tokens: 2_500_000 }]);
    expect({ ...d, dailyTokens: undefined }).toEqual({ ...plain, dailyTokens: undefined });
  });
});

describe('/api/config', () => {
  const groupOf = (g: any, id: string) => g.groups.find((x: any) => x.group.id === id);

  it('GET 按组返回 JSON Schema 声明 + 当前值,标出各组所有者', async () => {
    const g = await getJ('/api/config');
    // id 标识具体实例；owner 标识与实例无关的架构角色。
    expect(g.groups.map((x: any) => x.group.id)).toEqual(['core', PERSONA_CONFIG_GROUP.id, 'world:websearch']);
    expect(g.groups.map((x: any) => x.group.owner)).toEqual(['core', 'persona', 'world:websearch']);
    const pc = groupOf(g, PERSONA_CONFIG_GROUP.id);
    expect(pc.values['dream.maxRounds']).toBe(6);
    expect(pc.group.schema.properties['dream.maxRounds'].type).toBe('integer');
    expect(pc.values['context.maxTokens']).toBeGreaterThan(0);
    expect(pc.values['memo.residentCap']).toBeGreaterThan(0);
    const pair = pc.group.schema.properties['tick.dayIntervalMinutes'];
    expect(pair.type).toBe('array');
    expect([pair.minItems, pair.maxItems]).toEqual([2, 2]);
    const hn = groupOf(g, 'core');
    expect(hn.values['batching.quietGapMs']).toBe(cfg.batching.quietGapMs);
    expect(hn.group.schema.properties['dream.maxRounds']).toBeUndefined();
  });

  it('POST 按组校验并热改(部分更新);越界值 400', async () => {
    const ok = await postJ('/api/config', {
      group: PERSONA_CONFIG_GROUP.id,
      values: { 'dream.maxRounds': 3 },
      persist: false,
    });
    expect(ok.status).toBe(200);
    expect(cfg.dream.maxRounds).toBe(3);
    const after = groupOf(await getJ('/api/config'), PERSONA_CONFIG_GROUP.id);
    expect(after.values['dream.maxRounds']).toBe(3);

    const hot = await postJ('/api/config', {
      group: 'core',
      values: { 'batching.quietGapMs': 5000, 'context.keepPastThinking': false },
    });
    expect(hot.status).toBe(200);
    expect(cfg.batching.quietGapMs).toBe(5000);
    expect(cfg.context.keepPastThinking).toBe(false);

    expect((await postJ('/api/config', { group: PERSONA_CONFIG_GROUP.id, values: { 'dream.maxRounds': 4 } })).status).toBe(200);
    expect((await postJ('/api/config', { group: PERSONA_CONFIG_GROUP.id, values: { 'dream.maxRounds': 0 } })).status).toBe(400);
    expect((await postJ('/api/config', { group: PERSONA_CONFIG_GROUP.id, values: { 'tick.dayIntervalMinutes': [90, 30] } })).status).toBe(400);
    expect((await postJ('/api/config', { group: 'world:websearch', values: { 'worlds.websearch.safesearch': 'nope' } })).status).toBe(400);
    expect((await postJ('/api/config', { group: 'world:nonexistent', values: {} })).status).toBe(400);
    // 配置组只能更新其 schema 声明的键:provider 表与活跃指针都不在 core 组里。
    const sneak = await postJ('/api/config', {
      group: 'core',
      values: { 'providers.deepseek.baseUrl': 'http://evil', activeProvider: 'evil' },
    });
    expect(sneak.status).toBe(400);
    expect(cfg.providers).toEqual({});
    expect(cfg.activeProvider).toBe('');
  });
});
