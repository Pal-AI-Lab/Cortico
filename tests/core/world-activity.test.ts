/**
 * Core 对 World 推送事件与触发轮次的记账：
 * pushEvent / pushDeferred / pushCandidate、隐藏 World、失活租约、同轮多 World、重试去重与 core/persona 过滤。
 */
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Core } from './fixture-core.ts';
import type { LoadedConfig } from '../../src/core/config.ts';
import type { BotConfig } from '../../bots/corti-soulmate/assemble.ts';
import type { World, WorldHost } from '../../src/core/types.ts';
import { WORLD_ACTIVITY_VERSION, WorldActivityLog } from '../../src/core/world-activity-log.ts';
import {
  FakeLLM,
  makeCfg,
  makeFakePersona,
  makeLoaded,
  makeTmpDir,
  sleep,
  textReply,
} from './helpers.ts';

function loadedFor(dir: string): LoadedConfig<BotConfig> {
  const config = makeCfg();
  config.worlds.qq.enabled = false;
  config.batching.quietGapMs = 30;
  config.batching.maxBatchAgeMs = 60;
  return makeLoaded({
    config,
    rootDir: dir,
    memoryDir: `${dir}/persona`,
    dataDir: `${dir}/data`,
  });
}

function makeTestWorld(id: string): { world: World; host: () => WorldHost } {
  let bound: WorldHost | null = null;
  const world: World = {
    id,
    async start(host) {
      bound = host;
    },
    async stop() {},
    tools() {
      return [];
    },
    envPromptVars() {
      return {};
    },
  };
  return {
    world,
    host: () => {
      if (!bound) throw new Error(`World ${id} has not started`);
      return bound;
    },
  };
}

async function until(pred: () => boolean, timeoutMs = 6_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(20);
  }
  throw new Error('timed out waiting for condition');
}

describe('Core · World 活动记账 (world-activity.jsonl)', () => {
  let tmp: ReturnType<typeof makeTmpDir> | null = null;
  let core: Core<BotConfig> | null = null;

  afterEach(async () => {
    if (core) {
      await core.stop();
      core = null;
    }
    tmp?.cleanup();
    tmp = null;
  });

  it('pushEvent / pushDeferred / pushCandidate 原始事件、隐藏 World 均计数；失活租约不计', async () => {
    tmp = makeTmpDir();
    const loaded = loadedFor(tmp.dir);
    const alpha = makeTestWorld('alpha');
    const hidden = makeTestWorld('hidden_w');
    const persona = makeFakePersona([], { cfg: loaded.config });
    const llm = new FakeLLM();
    core = new Core(loaded, { persona, worlds: [alpha.world, hidden.world], llm });
    core.setWorldVisible('hidden_w', false);
    await core.start();

    const alphaHost = alpha.host();
    const hiddenHost = hidden.host();

    await alphaHost.pushEvent({ type: 'alpha.msg', ts: '2026-07-19T10:00:00+08:00', source: 'alpha', text: 'one' }, { trigger: 'piggyback' });
    await alphaHost.pushEvent({ type: 'alpha.arch', ts: '2026-07-19T10:00:01+08:00', source: 'alpha', text: 'arch' }, { deliver: false });
    alphaHost.pushDeferred({ type: 'alpha.def', render: () => 'deferred' }, { trigger: 'piggyback' });
    await alphaHost.pushCandidate!({
      sourceEvents: [
        { type: 'alpha.raw', ts: '2026-07-19T10:00:02+08:00', text: 'r1' },
        { type: 'alpha.raw', ts: '2026-07-19T10:00:03+08:00', text: 'r2' },
        { type: 'alpha.raw', ts: '2026-07-19T10:00:04+08:00', text: 'r3' },
      ],
      gateText: 'raw',
      value: null,
      project: () => [],
    }, { trigger: 'piggyback' });

    await hiddenHost.pushEvent({ type: 'hidden_w.msg', ts: '2026-07-19T10:00:05+08:00', source: 'hidden_w', text: 'secret' });
    hiddenHost.pushDeferred({ type: 'hidden_w.def', render: () => 'x' });

    // 卸载 alpha 后，失活租约上的推送被拒绝且不计数。
    await core.unmountWorld('alpha');
    await expect(alphaHost.pushEvent({ type: 'alpha.late', ts: '2026-07-19T10:00:06+08:00', source: 'alpha', text: 'late' })).rejects.toThrow();
    alphaHost.pushDeferred({ type: 'alpha.late_def', render: () => 'late' });

    await core.stop();
    core = null;

    const rows = await new WorldActivityLog(join(tmp.dir, 'data', 'world-activity.jsonl'), {
      timezone: loaded.config.timezone,
      run: 'check',
    }).readAll();

    const byWorld = new Map(rows.map((r) => [r.world, r]));
    expect(byWorld.get('alpha')).toMatchObject({ version: WORLD_ACTIVITY_VERSION, events: 6, rounds: 0 });
    expect(byWorld.get('hidden_w')).toMatchObject({ version: WORLD_ACTIVITY_VERSION, events: 2, rounds: 0 });
  });

  it('同轮送入两个 World 的事件各记一轮；core 和 persona 的事件不计', async () => {
    tmp = makeTmpDir();
    const loaded = loadedFor(tmp.dir);
    const w1 = makeTestWorld('w1');
    const w2 = makeTestWorld('w2');
    const persona = makeFakePersona([], { cfg: loaded.config });
    const llm = new FakeLLM();
    llm.script(textReply('opening'), textReply('handled'));
    core = new Core(loaded, { persona, worlds: [w1.world, w2.world], llm });
    await core.start();

    // 等开机第一轮（core/persona 内部唤醒）完成。
    await until(() => llm.calls.length >= 1);
    const before = llm.calls.length;

    // 同一批同时推入 w1 与 w2，以及 persona 注入事件。
    await w1.host().pushEvent({ type: 'w1.ping', ts: '2026-07-19T10:00:00+08:00', source: 'w1', text: 'from w1' });
    await w2.host().pushEvent({ type: 'w2.ping', ts: '2026-07-19T10:00:00+08:00', source: 'w2', text: 'from w2' });
    core.loop.injectInternal('persona note', 'persona.note');

    await until(() => llm.calls.length >= before + 1);
    await sleep(80);
    await core.stop();
    core = null;

    const rows = await new WorldActivityLog(join(tmp.dir, 'data', 'world-activity.jsonl'), {
      timezone: loaded.config.timezone,
      run: 'check',
    }).readAll();

    expect(rows.map((r) => r.world).sort()).toEqual(['w1', 'w2']);
    for (const id of ['w1', 'w2']) {
      const row = rows.find((r) => r.world === id);
      expect(row).toMatchObject({ events: 1, rounds: 1 });
    }
    expect(rows.some((r) => r.world === 'core' || r.world === 'persona')).toBe(false);
  });

  it('同一轮模型调用失败重试后仍只记一轮', async () => {
    tmp = makeTmpDir();
    const loaded = loadedFor(tmp.dir);
    const w1 = makeTestWorld('w1');
    const persona = makeFakePersona([], { cfg: loaded.config });
    const llm = new FakeLLM();
    llm.script(textReply('opening'));
    core = new Core(loaded, { persona, worlds: [w1.world], llm });
    await core.start();

    await until(() => llm.calls.length >= 1);
    const before = llm.calls.length;

    // 首次请求抛可重试错误，退避后第二次请求成功。
    llm.throwNext = new Error('transient upstream failure');
    llm.script(textReply('recovered'));
    await w1.host().pushEvent({ type: 'w1.msg', ts: '2026-07-19T10:00:00+08:00', source: 'w1', text: 'hello' });

    await until(() => llm.calls.length >= before + 2, 8_000);
    await sleep(80);
    await core.stop();
    core = null;

    const rows = await new WorldActivityLog(join(tmp.dir, 'data', 'world-activity.jsonl'), {
      timezone: loaded.config.timezone,
      run: 'check',
    }).readAll();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ world: 'w1', events: 1, rounds: 1 });
  });
});
