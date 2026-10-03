import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JsonlEventStore } from '../../src/core/event-store.ts';
import { nullLogger } from '../../src/core/util.ts';
import { makeTmpDir } from './helpers.ts';

const RUN_A = 'r-20260101-000000-aaaa';
const RUN_B = 'r-20260101-000100-bbbb';
const RUN_C = 'r-20260101-000200-cccc';

/** readFileSync 的旁观钩子:node 内建模块的属性不可重定义,只能整 module 代理一次。 */
const fsHooks = vi.hoisted(() => ({ reads: [] as string[] }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    readFileSync: (file: string, ...rest: unknown[]) => {
      fsHooks.reads.push(String(file));
      return actual.readFileSync(file, ...rest as []);
    },
  };
});

/** 记下每一级日志的调用,用来断言装载期/写盘期的机械告警。 */
function spyLogger() {
  const base = nullLogger();
  const calls: Array<{ level: string; msg: string; data?: unknown }> = [];
  const mk = (level: string) => (msg: string, data?: unknown) => { calls.push({ level, msg, data }); };
  return {
    calls,
    log: { ...base, debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error'), child: () => base },
  };
}

function seed(store: JsonlEventStore, n: number, offset = 0): void {
  for (let i = 1 + offset; i <= n + offset; i++) {
    store.append({
      type: 'qq.message',
      ts: `2026-07-17T10:${String(i).padStart(2, '0')}:00.000+08:00`,
      source: i % 2 === 0 ? 'qq' : 'web',
      origin: 'external',
      text: `第${i}条消息 msg-${i}`,
      senderKey: i % 3 === 0 ? 'alice' : 'bob',
    });
  }
}

describe('JsonlEventStore', () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  const open = (run = RUN_A, log = nullLogger()) => new JsonlEventStore({ dataDir: tmp.dir, run, log });
  const fileOf = (run: string) => join(tmp.dir, 'runs', run, 'events.jsonl');
  beforeEach(() => (tmp = makeTmpDir(), fsHooks.reads.length = 0));
  afterEach(() => tmp.cleanup());

  it('append游标从1递增,get/latestCursor一致,记录带 run', () => {
    const store = open();
    expect(store.latestCursor()).toBe(0);
    seed(store, 5);
    expect(store.latestCursor()).toBe(5);
    expect(store.get(1)?.text).toContain('第1条');
    expect(store.get(5)?.cursor).toBe(5);
    expect(store.get(5)?.run).toBe(RUN_A);
    expect(store.get(0)).toBeUndefined();
    expect(store.get(6)).toBeUndefined();
    expect(existsSync(fileOf(RUN_A))).toBe(true);
  });

  it('archive-only 投递语义跨重启往返', () => {
    const store = open();
    store.append({
      type: 'bilibili.danmaku',
      ts: '2026-07-17T10:00:00.000+08:00',
      source: 'bilibili',
      origin: 'external',
      contextDelivery: 'archive-only',
      text: '只归档',
    });
    store.append({
      type: 'qq.message',
      ts: '2026-07-17T10:01:00.000+08:00',
      source: 'qq',
      origin: 'external',
      text: '旧语义',
    });

    const reloaded = open();
    expect(reloaded.get(1)?.contextDelivery).toBe('archive-only');
    expect(reloaded.get(2)?.contextDelivery).toBeUndefined();
  });

  it('range按游标/时间/人/来源过滤,limit从尾部取但升序返回', () => {
    const store = open();
    seed(store, 10);
    expect(store.range({ fromCursor: 3, toCursor: 6 }).map((e) => e.cursor)).toEqual([3, 4, 5, 6]);
    expect(store.range({ fromTs: '2026-07-17T10:08:00' }).map((e) => e.cursor)).toEqual([8, 9, 10]);
    expect(store.range({ senderKey: 'alice' }).map((e) => e.cursor)).toEqual([3, 6, 9]);
    expect(store.range({ source: 'qq' }).map((e) => e.cursor)).toEqual([2, 4, 6, 8, 10]);
    // limit最近优先,仍升序
    expect(store.range({ limit: 3 }).map((e) => e.cursor)).toEqual([8, 9, 10]);
    expect(store.range({ fromCursor: 2, toCursor: 9, limit: 2 }).map((e) => e.cursor)).toEqual([8, 9]);
  });

  it('无起点的 limit 查询从当前分片倒着凑,不装载更早的历史', () => {
    const a = open(RUN_A); seed(a, 10);
    const b = open(RUN_B); seed(b, 10, 10); // cursor 11..20,RUN_B 为当前 run
    fsHooks.reads.length = 0;
    expect(b.range({ limit: 5 }).map((e) => e.cursor)).toEqual([16, 17, 18, 19, 20]);
    // 尾部在内存里就够了:连当前分片都不必重读,更没碰 RUN_A
    expect(fsHooks.reads).toEqual([]);
    expect(b.range({ senderKey: 'alice', limit: 2 }).map((e) => e.cursor)).toEqual([15, 18]);
    expect(fsHooks.reads).toEqual([]);
    // 起点查询不受影响,仍按需装载旧分片
    expect(b.range({ fromCursor: 2, toCursor: 4 }).map((e) => e.cursor)).toEqual([2, 3, 4]);
    expect(fsHooks.reads.some((f) => f.includes(RUN_A))).toBe(true);
  });

  it('历史分片只缓存最近一次查询读到的:同批分片上的连续查询各分片只读一次磁盘', () => {
    const a = open(RUN_A); seed(a, 6);      // 1..6
    const b = open(RUN_B); seed(b, 6, 6);   // 7..12
    const store = open(RUN_C);
    const readsOf = (run: string) => fsHooks.reads.filter((f) => f.includes(run)).length;
    fsHooks.reads.length = 0;
    expect(store.get(1)?.cursor).toBe(1);
    expect(store.get(2)?.cursor).toBe(2);
    expect(readsOf(RUN_A)).toBe(1);
    // 换到 RUN_B 的查询结束后 RUN_A 被释放,再查 RUN_A 要重读
    expect(store.get(7)?.cursor).toBe(7);
    expect(store.get(3)?.cursor).toBe(3);
    expect(readsOf(RUN_A)).toBe(2);
    // grep 为每条命中取上下文,每个分片仍只读一次
    fsHooks.reads.length = 0;
    expect(store.grep({ keyword: '条消息', context: 1 }).map((h) => h.hitCursor)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(readsOf(RUN_A)).toBe(0);
    expect(readsOf(RUN_B)).toBe(1);
  });

  it('clear 只清当前 run 的分片,游标不回退,重启后仍从续号处起', () => {
    const store = open();
    seed(store, 5);
    expect(store.clear()).toBe(5);
    expect(store.latestCursor()).toBe(5);
    expect(store.currentCount()).toBe(0);
    expect(store.range({})).toEqual([]);
    expect(existsSync(fileOf(RUN_A))).toBe(false);
    seed(store, 1);
    expect(store.get(6)?.cursor).toBe(6);
    expect(store.get(1)).toBeUndefined();
    const reloaded = open();
    expect(reloaded.latestCursor()).toBe(6);
  });

  it('around边界截断', () => {
    const store = open();
    seed(store, 5);
    expect(store.around(3, 1, 1).map((e) => e.cursor)).toEqual([2, 3, 4]);
    expect(store.around(1, 3, 1).map((e) => e.cursor)).toEqual([1, 2]);
    expect(store.around(5, 1, 3).map((e) => e.cursor)).toEqual([4, 5]);
    expect(store.around(3, 0, 0).map((e) => e.cursor)).toEqual([3]);
  });

  it('grep不区分大小写,附上下文,重叠不合并,limit限组数', () => {
    const store = open();
    seed(store, 10);
    const hits = store.grep({ keyword: 'MSG-4', context: 1 });
    expect(hits).toHaveLength(1);
    expect(hits[0].hitCursor).toBe(4);
    expect(hits[0].events.map((e) => e.cursor)).toEqual([3, 4, 5]);

    // "msg-1"命中1和10,两组独立
    const multi = store.grep({ keyword: 'msg-1', context: 2 });
    expect(multi.map((h) => h.hitCursor)).toEqual([1, 10]);
    expect(multi[0].events.map((e) => e.cursor)).toEqual([1, 2, 3]);
    expect(multi[1].events.map((e) => e.cursor)).toEqual([8, 9, 10]);

    // 相邻命中窗口重叠也不合并
    const all = store.grep({ keyword: '条消息', context: 2 });
    expect(all).toHaveLength(10);

    const limited = store.grep({ keyword: '条消息', context: 0, limit: 3 });
    expect(limited.map((h) => h.hitCursor)).toEqual([1, 2, 3]);

    // 过滤条件组合
    const byPerson = store.grep({ keyword: '条消息', context: 0, senderKey: 'alice' });
    expect(byPerson.map((h) => h.hitCursor)).toEqual([3, 6, 9]);
  });

  it('同一 run 重载:读回全部事件,游标续增,损坏行跳过并报一次', () => {
    const store = open();
    seed(store, 3);
    appendFileSync(fileOf(RUN_A), '{broken json\n', 'utf8');
    const spy = spyLogger();
    const store2 = open(RUN_A, spy.log);
    expect(store2.latestCursor()).toBe(3);
    expect(store2.get(2)?.text).toContain('第2条');
    const e = store2.append({ type: 'qq.message', ts: '2026-07-17T11:00:00.000+08:00', source: 'qq', origin: 'external', text: '重启后' });
    expect(e.cursor).toBe(4);
    expect(spy.calls.filter((c) => c.level === 'warn').map((c) => c.data)).toEqual([{ run: RUN_A, skipped: 1 }]);
  });

  it('新 run 从上一分片末行续号;跨分片的 get / range / around / grep 都按 cursor 作答', () => {
    const a = open(RUN_A);
    seed(a, 3);
    const b = open(RUN_B);
    expect(b.latestCursor()).toBe(3);
    expect(b.currentCount()).toBe(0);
    seed(b, 2, 3);
    expect(b.latestCursor()).toBe(5);
    expect(b.get(2)?.run).toBe(RUN_A);
    expect(b.get(5)?.run).toBe(RUN_B);
    expect(b.range({ fromCursor: 2 }).map((e) => e.cursor)).toEqual([2, 3, 4, 5]);
    expect(b.range({ source: 'qq' }).map((e) => e.cursor)).toEqual([2, 4]);
    expect(b.around(4, 2, 1).map((e) => e.cursor)).toEqual([2, 3, 4, 5]);
    expect(b.grep({ keyword: 'msg-1', context: 0 }).map((h) => h.hitCursor)).toEqual([1]);
    // 只按 ts 切时,早于区间的分片不装载也不参与
    expect(b.range({ fromTs: '2026-07-17T10:04:00' }).map((e) => e.cursor)).toEqual([4, 5]);
  });

  it('分片里乱序或重复的 cursor 行按损坏跳过', () => {
    const rows = [
      { type: 'qq.message', ts: '2026-08-27T10:00:00.000+08:00', source: 'qq', origin: 'external', text: '一', cursor: 1 },
      { type: 'qq.message', ts: '2026-08-27T10:01:00.000+08:00', source: 'qq', origin: 'external', text: '二', cursor: 2 },
      { type: 'opening', ts: '2026-08-27T10:02:00.000+08:00', source: 'persona', origin: 'internal', text: '三', cursor: 1 },
      { type: 'qq.message', ts: '2026-08-27T10:03:00.000+08:00', source: 'qq', origin: 'external', text: '四', cursor: 3 },
    ];
    mkdirSync(join(tmp.dir, 'runs', RUN_A), { recursive: true });
    writeFileSync(fileOf(RUN_A), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    const spy = spyLogger();
    const store = open(RUN_A, spy.log);
    expect(store.latestCursor()).toBe(3);
    expect(store.range({}).map((e) => e.text)).toEqual(['一', '二', '四']);
    expect(spy.calls.filter((c) => c.level === 'warn').map((c) => c.data)).toEqual([{ run: RUN_A, skipped: 1 }]);
  });

  it('写盘前发现文件被别人动过,报一次 error', () => {
    const spy = spyLogger();
    const store = open(RUN_A, spy.log);
    seed(store, 2);
    expect(spy.calls.filter((c) => c.level === 'error')).toHaveLength(0);
    appendFileSync(fileOf(RUN_A), JSON.stringify({
      type: 'qq.message', ts: '2026-08-27T10:00:00.000+08:00', source: 'qq', origin: 'external', text: '别人写的', cursor: 1,
    }) + '\n', 'utf8');
    seed(store, 1, 2);
    const errors = spy.calls.filter((c) => c.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].msg).toContain('另一个实例');
    seed(store, 1, 3);
    expect(spy.calls.filter((c) => c.level === 'error')).toHaveLength(1);
  });
});
