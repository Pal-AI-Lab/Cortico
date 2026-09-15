/** 用两个 run 与关联字段验证日志筛选、时间线、诊断和导出。 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  UsageError, bundle, doctor, formatLogLine, listRunIds, locateRun, main, parseArgs, parseWhen, quantile, queryLog,
  redactSecrets, resolveDataDir, resolveRunId, runsTable, timeline, turn,
} from '../../scripts/logq.ts';

const R1 = 'r-20260908-100000-aaaa';
const R2 = 'r-20260909-100000-bbbb';
const OFFSET = '+08:00';
const T0 = Date.parse(`2026-09-09T10:00:00.000${OFFSET}`);
/** T0 之后 ms 毫秒,run 时区的 ISO */
const at = (ms: number): string => new Date(T0 + ms + 8 * 3_600_000).toISOString().replace('Z', OFFSET);
const jsonl = (rows: readonly unknown[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

/** 五次 vtuber_act:call id、调用开始刻、到首条 tts 记录的延迟 */
const ACTS = [
  { call: 'c1', round: 3, start: 25_000, delay: 100, script: '你好' },
  { call: 'c2', round: 4, start: 40_000, delay: 200, script: '   ' },
  { call: 'c3', round: 4, start: 50_000, delay: 300, script: '今天' },
  { call: 'c4', round: 6, start: 60_000, delay: 400, script: '好' },
  { call: 'c5', round: 6, start: 80_000, delay: 500, script: '再见' },
];
const ACT_DUR = 10;

let root: string;
let dataDir: string;

function buildFixture(): void {

  root = mkdtempSync(join(tmpdir(), 'logq-test-'));
  const botDir = join(root, 'tb');
  dataDir = join(botDir, 'data');
  const runsDir = join(dataDir, 'runs');
  mkdirSync(join(runsDir, R1), { recursive: true });
  mkdirSync(join(runsDir, R2, 'incidents'), { recursive: true });

  writeFileSync(join(botDir, 'config.json'), JSON.stringify({
    displayName: 'tb',
    providers: { cloud: { apiKey: 'sk-live-123', options: { token: 'tok-1' }, model: 'cloud-1' } },
    web: { password: 'pw' },
  }));

  writeFileSync(join(runsDir, 'index.jsonl'), jsonl([
    { run: R1, startedAt: `2026-09-08T10:00:00.000${OFFSET}`, bot: 'tb', pid: 1, gitSha: 'abc', previousRun: null },
    { run: R1, endedAt: `2026-09-08T11:00:00.000${OFFSET}`, lastCursor: 9, complete: true, reason: 'shutdown' },
    { run: R2, startedAt: at(0), bot: 'tb', pid: 2, gitSha: 'abc', previousRun: R1 },
    { run: R2, endedAt: at(600_000), lastCursor: 11, complete: false, reason: 'crash' },
  ]));

  writeFileSync(join(runsDir, R1, 'log.jsonl'), jsonl([
    { ts: `2026-09-08T10:00:01.000${OFFSET}`, run: R1, seq: 1, level: 'info', area: 'core.boot', msg: '旧场开机' },
  ]));


  writeFileSync(join(runsDir, R2, 'log.1.jsonl'), jsonl([
    { ts: at(1000), run: R2, seq: 1, level: 'info', area: 'core.boot', msg: '开机' },
    { ts: at(2000), run: R2, seq: 2, level: 'warn', area: 'worlds.vtuber.inject', event: 'reconnect', msg: 'VTS 排定重连', data: { delayMs: 500 } },
  ]));
  const log: unknown[] = [
    { ts: at(3000), run: R2, seq: 3, level: 'warn', area: 'worlds.vtuber.inject', event: 'reconnect', msg: 'VTS 排定重连', repeat: 4 },
    { ts: at(20_000), run: R2, seq: 4, level: 'error', area: 'core.loop', event: 'llm-failed', msg: 'LLM 已连续失败 3 次', err: { name: 'Error', message: 'upstream 502' }, round: 2 },
    { ts: at(21_000), run: R2, seq: 5, level: 'error', area: 'core.loop', event: 'llm-failed', msg: 'LLM 已连续失败 4 次', err: { name: 'Error', message: 'upstream 502' }, round: 2 },
    { ts: at(22_000), run: R2, seq: 6, level: 'error', area: 'worlds.minecraft.bridge', msg: '桥断了', data: { code: 'ECONNRESET' } },
  ];
  let seq = 7;
  for (const a of ACTS) {
    log.push({ ts: at(a.start + 2), run: R2, seq: seq++, level: 'debug', area: 'worlds.vtuber.perf', event: 'act-accepted', msg: '受理台词', round: a.round, call: a.call, data: { chars: a.script.length } });
    log.push({ ts: at(a.start + a.delay), run: R2, seq: seq++, level: 'debug', area: 'worlds.vtuber.tts', event: 'stream-received', msg: '收到首块音频', round: a.round, call: a.call, durMs: a.delay });
  }
  log.push({ ts: at(200_000), run: R2, seq: seq++, level: 'info', area: 'worlds.minecraft.world', event: 'death', msg: '她死了:摔死', round: 8, data: { cause: 'fall' } });
  log.push({ ts: at(201_000), run: R2, seq: seq++, level: 'warn', area: 'worlds.minecraft.skill', event: 'place-rejected', msg: '(1, 2, 3) 放不下', task: 5 });
  writeFileSync(join(runsDir, R2, 'log.jsonl'), jsonl(log));

  writeFileSync(join(runsDir, R2, 'events.jsonl'), jsonl([
    { cursor: 10, run: R2, ts: at(24_000), type: 'danmaku', source: 'bilibili', origin: 'external', text: '张三: 你好呀' },
    { cursor: 11, run: R2, ts: at(24_500), type: 'danmaku', source: 'bilibili', origin: 'external', text: '李四: 唱歌' },
  ]));

  const frame = { events: [
    { cursor: 10, ts: at(24_000), type: 'danmaku', source: 'bilibili', start: 0, chars: 6 },
    { cursor: 11, ts: at(24_500), type: 'danmaku', source: 'bilibili', start: 7, chars: 5 },
  ] };
  writeFileSync(join(runsDir, R2, 'transcript.jsonl'), jsonl([
    { kind: 'item', ts: at(24_800), run: R2, sess: 'main', round: 3, index: 10, item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[10:00] 张三: 你好呀\n[10:00] 李四: 唱歌' }] }, context: { ts: at(24_800), frame } },
    { kind: 'item', ts: at(24_900), run: R2, sess: 'main', round: 3, index: 11, item: { type: 'reasoning', summary: [{ type: 'summary_text', text: '有人打招呼,先回一句。' }] }, context: { ts: at(24_900), responseId: 'resp_a' } },
    { kind: 'item', ts: at(24_950), run: R2, sess: 'main', round: 3, index: 12, item: { type: 'function_call', call_id: 'c1', name: 'vtuber_act', arguments: '{"script":"你好"}' }, context: { ts: at(24_950), responseId: 'resp_a' } },
    { kind: 'item', ts: at(25_010), run: R2, sess: 'main', round: 3, index: 13, item: { type: 'function_call_output', call_id: 'c1', output: '已受理' }, context: { ts: at(25_010) } },
    { kind: 'item', ts: at(26_000), run: R2, sess: 'main', round: 3, index: 14, item: { type: 'function_call', call_id: 'e1', name: 'end_turn', arguments: '{}' }, context: { ts: at(26_000), responseId: 'resp_b' } },
    { kind: 'boundary', ts: at(300_000), run: R2, sess: 'main', round: 9, event: 'handoff', data: { dropped: 40 } },
  ]));

  const calls: unknown[] = [];
  let cseq = 1;
  for (const a of ACTS) {
    calls.push({ seq: cseq++, ts: at(a.start + ACT_DUR), run: R2, round: a.round, call: a.call, role: 'main', tool: 'vtuber_act', mod: 'vtuber', args: { script: a.script }, durMs: ACT_DUR, chars: 3, receipt: '已受理' });
  }
  for (const round of [3, 5, 6, 7]) {
    calls.push({ seq: cseq++, ts: at(round * 30_000), run: R2, round, call: `e${round}`, role: 'main', tool: 'end_turn', args: {}, durMs: 1, chars: 0, receipt: '' });
  }
  calls.push({ seq: cseq++, ts: at(150_000), run: R2, round: 5, call: 'x1', role: 'main', tool: 'mc_queue', mod: 'minecraft', args: { op: 'push' }, durMs: 20, chars: 13, receipt: '[tool failed] 桥断了', failed: true });
  calls.sort((a, b) => Date.parse((a as { ts: string }).ts) - Date.parse((b as { ts: string }).ts));
  writeFileSync(join(runsDir, R2, 'toolcalls.jsonl'), jsonl(calls));

  writeFileSync(join(runsDir, R2, 'incidents', '2026-09-09T10-00-20-000-llm-failed.json'), '{}');

  writeFileSync(join(dataDir, 'usage.jsonl'), jsonl([
    { run: R1, round: 1, ts: `2026-09-08T10:05:00.000${OFFSET}`, sessionId: 'main', role: 'main', label: 'main', model: 'cloud-1', promptTokens: 10, completionTokens: 1, cacheHitTokens: 0, cacheMissTokens: 10, reasoningTokens: 0, attempt: { elapsedMs: 900, responseId: 'old' } },
    { run: R2, round: 3, ts: at(5000), sessionId: 'main', role: 'main', label: 'main', model: 'cloud-1', promptTokens: 1000, completionTokens: 50, cacheHitTokens: 900, cacheMissTokens: 100, reasoningTokens: 5, attempt: { elapsedMs: 1000, responseId: 'resp_a' } },
    { run: R2, round: 3, ts: at(10_000), sessionId: 'main', role: 'main', label: 'main', model: 'cloud-1', promptTokens: 1000, completionTokens: 0, cacheHitTokens: 900, cacheMissTokens: 100, reasoningTokens: 0, outcome: 'failed', attempt: { elapsedMs: 3000, responseId: null } },
    { run: R2, round: 4, ts: at(70_000), sessionId: 'main', role: 'main', label: 'main', model: 'cloud-2', promptTokens: 1200, completionTokens: 40, cacheHitTokens: 1100, cacheMissTokens: 100, reasoningTokens: 8, attempt: { elapsedMs: 2000, responseId: 'resp_c' } },
  ]));
}

beforeAll(buildFixture);
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe('run 选择', () => {
  it('latest 是字典序最后的 run,前缀唯一命中即选中,歧义报错', () => {
    expect(listRunIds(dataDir)).toEqual([R1, R2]);
    expect(resolveRunId(dataDir)).toBe(R2);
    expect(resolveRunId(dataDir, 'r-20260908')).toBe(R1);
    expect(() => resolveRunId(dataDir, 'r-2026')).toThrow(UsageError);
    expect(() => resolveRunId(dataDir, 'zzz')).toThrow(UsageError);
  });

  it('--bot 缺省取唯一带 data/runs 的部署', () => {
    expect(resolveDataDir({}, root)).toBe(dataDir);
    expect(resolveDataDir({ bot: 'tb' }, root)).toBe(dataDir);
    expect(() => resolveDataDir({ bot: 'nope' }, root)).toThrow(UsageError);
  });

  it('locateRun 带上开机刻、关机刻与偏移', () => {
    const ctx = locateRun(dataDir, R2);
    expect(ctx.startedAt).toBe(at(0));
    expect(ctx.endedAt).toBe(at(600_000));
    expect(ctx.offset).toBe(OFFSET);
  });

  it('runs 表合并开机行与关机行', () => {
    const rows = runsTable(dataDir);
    expect(rows[0]).toMatch(/^run\s+startedAt\s+endedAt\s+duration\s+complete\s+reason\s+lastCursor$/);
    expect(rows[1]).toContain(R1);
    expect(rows[1]).toContain('1h00m');
    expect(rows[1]).toContain('shutdown');
    expect(rows[2]).toContain('10m00s');
    expect(rows[2]).toContain('false');
    expect(rows[2]).toContain('crash');
  });
});

describe('时刻', () => {
  const ctx = { startedAt: `2026-09-09T22:00:00.000${OFFSET}`, endedAt: `2026-09-10T02:00:00.000${OFFSET}`, offset: OFFSET };
  it('相对时刻从 run 结束刻往回数', () => {
    expect(parseWhen('10m', ctx)).toBe(Date.parse(ctx.endedAt) - 600_000);
    expect(parseWhen('2h', ctx)).toBe(Date.parse(ctx.endedAt) - 7_200_000);
  });
  it('HH:MM 落在开机那天;早于开机且次日仍在 run 内的算次日', () => {
    expect(parseWhen('23:30', ctx)).toBe(Date.parse(`2026-09-09T23:30:00${OFFSET}`));
    expect(parseWhen('01:15:30', ctx)).toBe(Date.parse(`2026-09-10T01:15:30${OFFSET}`));
    expect(parseWhen('21:00', ctx)).toBe(Date.parse(`2026-09-09T21:00:00${OFFSET}`));
  });
  it('缺时区的 ISO 按 run 时区解析,无效时间报错', () => {
    expect(parseWhen('2026-09-09T23:00', ctx)).toBe(Date.parse(`2026-09-09T23:00${OFFSET}`));
    expect(parseWhen('2026-09-09T15:00:00Z', ctx)).toBe(Date.parse('2026-09-09T15:00:00Z'));
    expect(() => parseWhen('昨天', ctx)).toThrow(UsageError);
  });
});

describe('log', () => {
  it('滚动代数旧→新读,seq 单调', async () => {
    const rows = await queryLog(locateRun(dataDir, R2), {});
    expect(rows.map((r) => r.seq)).toEqual(rows.map((_, i) => i + 1));
    expect(rows[0].msg).toBe('开机');
  });

  it('级别 warn+ 与区域前缀', async () => {
    const rows = await queryLog(locateRun(dataDir, R2), { level: 'warn+', area: 'worlds.vtuber' });
    expect(rows.map((r) => r.seq)).toEqual([2, 3]);
    expect(rows.every((r) => r.area === 'worlds.vtuber.inject')).toBe(true);
  });

  it('grep 不区分大小写,匹配 msg 与 err', async () => {
    const ctx = locateRun(dataDir, R2);
    expect((await queryLog(ctx, { grep: 'llm 已连续' })).length).toBe(2);
    expect((await queryLog(ctx, { grep: 'UPSTREAM 502' })).length).toBe(2);
    expect((await queryLog(ctx, { grep: 'econnreset' })).map((r) => r.seq)).toEqual([6]);
  });

  it('since/until、round、call、task、limit', async () => {
    const ctx = locateRun(dataDir, R2);
    expect((await queryLog(ctx, { since: T0 + 20_000, until: T0 + 22_000 })).map((r) => r.seq)).toEqual([4, 5, 6]);
    expect((await queryLog(ctx, { round: 2 })).length).toBe(2);
    expect((await queryLog(ctx, { call: 'c3' })).map((r) => r.event)).toEqual(['act-accepted', 'stream-received']);
    expect((await queryLog(ctx, { task: 5 })).map((r) => r.event)).toEqual(['place-rejected']);
    const tail = await queryLog(ctx, {}, 2);
    expect(tail.map((r) => r.event)).toEqual(['death', 'place-rejected']);
  });

  it('文本行包含时间、级别、区域、事件、重复数与关联字段', () => {
    const line = formatLogLine({ ts: at(3000), run: R2, seq: 3, level: 'warn', area: 'worlds.vtuber.inject', event: 'reconnect', msg: 'VTS 排定重连', repeat: 4, data: { delayMs: 500 }, err: { name: 'E', message: '拒连' }, round: 7, call: 'c9' });
    expect(line).toBe('10:00:03.000 WARN  worlds.vtuber.inject/reconnect  VTS 排定重连 ×5  {"delayMs":500}  err: 拒连 [r=7 c=c9]');
  });
});

describe('timeline', () => {
  it('五条流按 ts 归并,同一窗口内事件、transcript、工具、日志、用量交错', async () => {
    const rows = await timeline(locateRun(dataDir, R2), { filter: { since: T0 + 24_000, until: T0 + 25_200 } });
    // 25.010s 上工具行与 function_call_output 同刻,按流序 toolcalls 在前
    expect(rows.map((r) => r.stream)).toEqual(['events', 'events', 'transcript', 'transcript', 'transcript', 'log', 'toolcalls', 'transcript', 'log']);
    for (let i = 1; i < rows.length; i++) expect(rows[i].ms).toBeGreaterThanOrEqual(rows[i - 1].ms);
    expect(rows[0].text).toContain('#10 bilibili/danmaku');
    expect(rows[6].text).toContain('vtuber_act (vtuber)  10ms 3ch');
  });

  it('--streams 与 --round 只留选中的流与轮次;usage 只算本 run', async () => {
    const ctx = locateRun(dataDir, R2);
    const rows = await timeline(ctx, { streams: ['usage', 'toolcalls'], filter: { round: 3 } });
    expect(rows.map((r) => r.stream)).toEqual(['usage', 'usage', 'toolcalls', 'toolcalls']);
    expect(rows[1].text).toContain('failed');
    expect((await timeline(ctx, { streams: ['usage'] })).length).toBe(3);
  });
});

describe('turn', () => {
  it('投递事件、推理、工具调用及同 call 的 World 记录、用量按序出现', async () => {
    const text = (await turn(locateRun(dataDir, R2), 3)).join('\n');
    const order = ['## 投递', '#10 10:00:24.000 bilibili/danmaku  张三: 你好呀', '#11', '## 推理', '有人打招呼', '## 工具 vtuber_act (vtuber)', 'c=c1', 'args: {"script":"你好"}', 'receipt(3ch): 已受理', 'worlds.vtuber.perf/act-accepted', 'worlds.vtuber.tts/stream-received', '## 工具 end_turn', '## 用量 2 次', 'cloud-1 prompt=1000'];
    let pos = -1;
    for (const needle of order) {
      const next = text.indexOf(needle, pos + 1);
      expect(next, needle).toBeGreaterThan(pos);
      pos = next;
    }
    expect(text).not.toContain('output: 已受理');
  });

  it('没有 transcript 的轮次仍列出 toolcalls 行', async () => {
    const text = (await turn(locateRun(dataDir, R2), 5)).join('\n');
    expect(text).toContain('## 工具 mc_queue (minecraft)');
    expect(text).toContain('FAILED');
    expect(text).toContain('## 工具 end_turn');
  });
});

describe('doctor', () => {
  it('八节都有,数字从假数据算出', async () => {
    const md = await doctor(locateRun(dataDir, R2));
    expect(md).toContain('| core.loop/llm-failed | 2 |');
    expect(md).toContain('| worlds.minecraft.bridge | 1 |');

    expect(md).toContain('| worlds.vtuber.inject/reconnect | 5 |');
    expect(md).toContain('尝试 3 次,失败 1,丢弃 0');
    expect(md).toContain('elapsedMs p50 2000 / p90 3000');
    expect(md).toContain('相邻尝试最长间隔 1m00s(10:00:10.000 → 10:01:10.000)');
    expect(md).toContain('相关日志 2 条');
    expect(md).toContain('| vtuber_act | 5 | 0 | 10 | 10 |');
    expect(md).toContain('| mc_queue | 1 | 1 | 20 | 20 |');

    expect(md).toContain('只有 end_turn 的轮次:1 / 5(20%)');
    expect(md).toContain('vtuber_act 5 次,空台本 1(20%)');
    expect(md).toContain('p50 300 ms / p90 500 ms(5 样本)');
    expect(md).toContain('共 5 次;最长连续窗口 1s(5 次,10:00:02.000 → 10:00:03.000)');
    expect(md).toContain('- 10:03:20.000 death  她死了:摔死  {"cause":"fall"}');
    expect(md).toContain('- 2026-09-09T10-00-20-000-llm-failed.json(2 B)');
  });

  it('空 run 每节都印「无」(LLM 节另有措辞)', async () => {
    const md = await doctor(locateRun(dataDir, R1));
    expect(md.match(/^无$/gm)?.length).toBe(7);
    expect(md).toContain('尝试 1 次,失败 0,丢弃 0');
    expect(md).not.toContain('相邻尝试最长间隔');
    expect(md).toContain('相关日志:无');
  });

  it('quantile 取最近秩', () => {
    expect(quantile([5, 1, 3], 0.5)).toBe(3);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(quantile([7], 0.9)).toBe(7);
  });
});

describe('bundle', () => {
  it('拷 run 目录、本 run 的 usage 与 index 行、脱敏 config、doctor.md', async () => {
    const out = join(root, 'out');
    const files = await bundle(locateRun(dataDir, R2), out);
    const dest = join(out, R2);
    for (const name of ['log.jsonl', 'log.1.jsonl', 'events.jsonl', 'transcript.jsonl', 'toolcalls.jsonl', 'usage.jsonl', 'index.jsonl', 'config.json', 'doctor.md']) {
      expect(existsSync(join(dest, name)), name).toBe(true);
    }
    expect(existsSync(join(dest, 'incidents', '2026-09-09T10-00-20-000-llm-failed.json'))).toBe(true);
    expect(files).toContain(join(dest, 'doctor.md'));
    const usage = readFileSync(join(dest, 'usage.jsonl'), 'utf8').trim().split('\n');
    expect(usage.length).toBe(3);
    expect(usage.every((l) => l.includes(`"run":"${R2}"`))).toBe(true);
    expect(readFileSync(join(dest, 'index.jsonl'), 'utf8').trim().split('\n').length).toBe(2);
    const cfg = JSON.parse(readFileSync(join(dest, 'config.json'), 'utf8'));
    expect(cfg.displayName).toBe('tb');
    expect(cfg.providers.cloud.apiKey).toBe('***');
    expect(cfg.providers.cloud.options.token).toBe('***');
    expect(cfg.providers.cloud.model).toBe('cloud-1');
    expect(cfg.web.password).toBe('***');
    expect(readFileSync(join(dest, 'doctor.md'), 'utf8')).toContain(`# doctor · ${R2}`);
  });

  it('redactSecrets 走数组与嵌套', () => {
    expect(redactSecrets({ list: [{ secretKey: 'a', name: 'b' }], clientSecret: 'c' })).toEqual({ list: [{ secretKey: '***', name: 'b' }], clientSecret: '***' });
  });
});

describe('cli', () => {
  it('parseArgs:子命令、位置参数、--k v、--k=v、布尔旗标不吞下一个参数', () => {
    expect(parseArgs(['turn', '--full', '12', '--bot=cortiv', '--limit', '5'])).toEqual({ cmd: 'turn', positional: ['12'], opts: { full: true, bot: 'cortiv', limit: '5' } });
    expect(parseArgs(['--level', 'warn+']).cmd).toBe('log');
  });

  it('main:坏参数一行报错退出 1,--help 退出 0,log 走到底', async () => {
    let stdout = '';
    let stderr = '';
    const out = (s: string): void => { stdout += s; };
    const err = (s: string): void => { stderr += s; };
    expect(await main(['--help'], out, err)).toBe(0);
    expect(stdout).toContain('用法: pnpm logq');
    stdout = '';
    expect(await main(['--data', dataDir, '--level', 'bogus'], out, err)).toBe(1);
    expect(stderr).toBe('logq: 未知级别:bogus\n');
    expect(await main(['--data', dataDir, '--run', 'r-20260909', '--area', 'worlds.minecraft.world', '--format', 'jsonl'], out, err)).toBe(0);
    expect(JSON.parse(stdout.trim()).event).toBe('death');
    stdout = '';
    expect(await main(['turn', '3', '--data', dataDir], out, err)).toBe(0);
    expect(stdout).toContain('# turn 3');
    stdout = '';
    expect(await main(['timeline', '--data', dataDir, '--streams', 'nope'], out, err)).toBe(1);
  });
});
