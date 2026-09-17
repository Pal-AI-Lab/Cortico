/**
 * logq:查询部署的 `data/runs/`,不修改源记录;bundle 将副本写入指定目录。
 * 子命令 runs(run 清单)、log(过滤运行日志)、timeline(跨流归并)、turn(单轮回放)、
 * doctor(诊断)、bundle(打包)。记录布局由写入侧定义:
 * `src/core/run.ts`(run 目录与 index)、`log-context.ts`(日志关联字段)、
 * `tool-log.ts`、`transcript.ts`、`usage-log.ts`。
 *
 * 时刻一律 Date.parse 后按毫秒比较。相对时刻(`10m`)从 run 结束刻(未关机则此刻)往回数;
 * `HH:MM[:SS]` 落在 run 开机那天的 run 时区,同日早于开机而次日仍在 run 内的算次日。
 * 大文件按行流式读,`--limit` 只保留尾部环形缓冲。
 */
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LOG_LEVEL_RANK, type EventEnvelope, type LogLevel, type LogRecord, type UsageRecord } from '../src/core/types.ts';
import { deploymentRoot } from '../src/paths.ts';
import { redactSecrets } from '../src/core/util.ts';
export { redactSecrets };
import type { ToolCallEntry } from '../src/core/tool-log.ts';
import type { TranscriptItemRecord, TranscriptRecord } from '../src/core/transcript.ts';

export const USAGE = `用法: pnpm logq [子命令] [选项]

子命令
  runs                 run 清单(runs/index.jsonl 的开机行与关机行合并)
  log                  过滤运行日志(缺省子命令;按 log.N.jsonl 旧→新再 log.jsonl 读)
  timeline             按 ts 归并 log / toolcalls / transcript / events / usage 为一条时间线
  turn <N>             回放第 N 轮:投递事件、推理、assistant 正文、工具调用及同 call 的 World 记录、用量
  doctor               运行固定诊断项,输出 markdown
  bundle --out <dir>   把 run 目录、本 run 的 usage 行与 index 行、脱敏 config.json、doctor.md
                       拷到 <dir>/<run>/

选择
  --bot <name>         部署根下 <name>/data;缺省取唯一带 data/runs 的部署
  --data <dir>         直接指定 data 目录
  --run latest|<id>|<id 前缀>    缺省 latest

过滤(log / timeline)
  --level <min>        trace|debug|info|warn|error,可写 warn+;只作用于 log 流
  --area <prefix>      区域前缀:worlds.minecraft 命中 worlds.minecraft 与 worlds.minecraft.*
  --event <code>       机器可读小类
  --grep <regex>       不区分大小写;log 流匹配 msg+data+err,其余流匹配整条 JSON
  --since / --until    绝对 ISO(缺时区按 run 时区)、相对 10m / 2h / 1d(从 run 结束刻往回数)、
                       或 HH:MM[:SS](run 开机那天)
  --round N  --call <id>  --resp <id>  --task N
  --limit N            从尾部取 N 条,缺省 200
  --format text|jsonl  缺省 text
  --streams a,b,c      timeline 的流,缺省全部
  --full               turn 不截断推理 / args / 回执
  --help
`;

const COMMANDS = new Set(['runs', 'log', 'timeline', 'turn', 'doctor', 'bundle']);
const FLAGS = new Set(['full', 'help']);
const RUN_ID = /^r-\d{8}-\d{6}-[0-9a-f]{4}$/;
const DEFAULT_LIMIT = 200;

/** 参数错误:主入口印一行并以 1 退出 */
export class UsageError extends Error {}

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

export interface Argv {
  cmd: string;
  positional: string[];
  opts: Record<string, string | true>;
}

export function parseArgs(argv: readonly string[]): Argv {
  const opts: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq > 0) { opts[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!FLAGS.has(key) && next !== undefined && !next.startsWith('--')) { opts[key] = next; i++; }
    else opts[key] = true;
  }
  const cmd = positional.length && COMMANDS.has(positional[0]) ? positional.shift()! : 'log';
  return { cmd, positional, opts };
}

function opt(a: Argv, key: string): string | undefined {
  const v = a.opts[key];
  if (v === true) throw new UsageError(`--${key} 需要一个值`);
  return v;
}

function intOpt(a: Argv, key: string): number | undefined {
  const v = opt(a, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new UsageError(`--${key} 需要整数,给的是 ${v}`);
  return n;
}

// ---------------------------------------------------------------------------
// 数据目录与 run
// ---------------------------------------------------------------------------

/** root 为部署根,缺省由 src/paths.ts 按 CORTICO_HOME 解析。 */
export function resolveDataDir(opts: { bot?: string; data?: string }, root = deploymentRoot()): string {
  if (opts.data) return resolve(opts.data);
  if (opts.bot) {
    const dir = join(root, opts.bot, 'data');
    if (!existsSync(join(dir, 'runs'))) throw new UsageError(`${dir}/runs 不存在`);
    return dir;
  }
  const candidates = existsSync(root)
    ? readdirSync(root).filter((n) => existsSync(join(root, n, 'data', 'runs')))
    : [];
  if (candidates.length === 1) return join(root, candidates[0], 'data');
  throw new UsageError(candidates.length
    ? `多个 bot 有 data/runs,用 --bot 指定:${candidates.join(', ')}`
    : '没有 bot 有 data/runs;用 --bot 或 --data 指定');
}

export interface RunRow {
  run: string;
  startedAt?: string;
  endedAt?: string;
  bot?: string;
  pid?: number;
  gitSha?: string | null;
  previousRun?: string | null;
  lastCursor?: number;
  complete?: boolean | null;
  reason?: string;
}

/** index.jsonl 按 run 合并开机行与关机行,升序 */
export function readRunsIndex(dataDir: string): RunRow[] {
  const file = join(dataDir, 'runs', 'index.jsonl');
  if (!existsSync(file)) return [];
  const byRun = new Map<string, RunRow>();
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: RunRow;
    try { row = JSON.parse(line) as RunRow; } catch { continue; }
    if (typeof row.run !== 'string') continue;
    byRun.set(row.run, { ...byRun.get(row.run), ...row });
  }
  return [...byRun.values()].sort((a, b) => a.run.localeCompare(b.run));
}

/** index.jsonl 与目录清单的并集;id 自带时间戳,字典序即时间序 */
export function listRunIds(dataDir: string): string[] {
  const ids = new Set(readRunsIndex(dataDir).map((r) => r.run));
  const runsDir = join(dataDir, 'runs');
  if (existsSync(runsDir)) for (const n of readdirSync(runsDir)) if (RUN_ID.test(n)) ids.add(n);
  return [...ids].sort();
}

export function resolveRunId(dataDir: string, spec = 'latest'): string {
  const ids = listRunIds(dataDir);
  if (!ids.length) throw new UsageError(`${dataDir} 下没有 run`);
  if (spec === 'latest') return ids[ids.length - 1];
  if (ids.includes(spec)) return spec;
  const hits = ids.filter((id) => id.startsWith(spec));
  if (hits.length === 1) return hits[0];
  throw new UsageError(hits.length ? `run 前缀 ${spec} 命中多个:${hits.join(', ')}` : `没有 run 匹配 ${spec}`);
}

export interface RunContext {
  dataDir: string;
  run: string;
  runDir: string;
  row: RunRow | undefined;
  startedAt: string;
  /** 关机行缺席(崩溃或仍在跑)时为空 */
  endedAt: string | undefined;
  /** run 时区的固定偏移,如 +08:00 */
  offset: string;
}

/** 缺少开机行时取最早日志的 ts,再缺失则从 run id 按 UTC 解析。 */
function startedAtOf(run: string, runDir: string, row: RunRow | undefined): string {
  if (row?.startedAt) return row.startedAt;
  const first = logFiles(runDir)[0];
  if (first) {
    for (const line of readFileSync(first, 'utf8').split('\n', 5)) {
      const m = /"ts":"([^"]+)"/.exec(line);
      if (m) return m[1];
    }
  }
  const s = run.slice(2, 17);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}.000Z`;
}

export function locateRun(dataDir: string, spec = 'latest'): RunContext {
  const run = resolveRunId(dataDir, spec);
  const runDir = join(dataDir, 'runs', run);
  const row = readRunsIndex(dataDir).find((r) => r.run === run);
  const startedAt = startedAtOf(run, runDir, row);
  return { dataDir, run, runDir, row, startedAt, endedAt: row?.endedAt, offset: tsOffset(startedAt) };
}

// ---------------------------------------------------------------------------
// 时刻
// ---------------------------------------------------------------------------

export function tsOffset(ts: string): string {
  const m = /([+-]\d{2}:\d{2}|Z)$/.exec(ts);
  return m ? m[1] : 'Z';
}

/** epoch ms → 该偏移下的 HH:MM:SS.mmm */
export function clockAt(ms: number, offset: string): string {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  const shift = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000 : 0;
  return new Date(ms + shift).toISOString().slice(11, 23);
}

const REL = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const CLOCK = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

export function parseWhen(
  spec: string,
  ctx: Pick<RunContext, 'startedAt' | 'endedAt' | 'offset'>,
  now = Date.now(),
): number {
  const start = Date.parse(ctx.startedAt);
  const end = ctx.endedAt ? Date.parse(ctx.endedAt) : now;
  const rel = REL.exec(spec);
  if (rel) return end - Number(rel[1]) * UNIT_MS[rel[2]];
  const clock = CLOCK.exec(spec);
  if (clock) {
    const hms = `${clock[1].padStart(2, '0')}:${clock[2]}:${clock[3] ?? '00'}`;
    let ms = Date.parse(`${ctx.startedAt.slice(0, 10)}T${hms}${ctx.offset}`);
    if (ms < start && ms + UNIT_MS.d <= end) ms += UNIT_MS.d;
    return ms;
  }
  let iso = /^\d{4}-\d{2}-\d{2}$/.test(spec) ? `${spec}T00:00:00` : spec;
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(iso)) iso += ctx.offset;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new UsageError(`无效时间:${spec}`);
  return ms;
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

export async function* readJsonl<T>(file: string): AsyncGenerator<T> {
  if (!existsSync(file)) return;
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    // 正在写的末行可能只有半截
    try { yield JSON.parse(line) as T; } catch { continue; }
  }
}

/** log.N.jsonl 的 N 越大越旧;旧→新排,log.jsonl 最后 */
export function logFiles(runDir: string): string[] {
  if (!existsSync(runDir)) return [];
  const gens = readdirSync(runDir)
    .map((n) => /^log\.(\d+)\.jsonl$/.exec(n))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => b - a)
    .map((n) => join(runDir, `log.${n}.jsonl`));
  const head = join(runDir, 'log.jsonl');
  return existsSync(head) ? [...gens, head] : gens;
}

export async function* readLog(runDir: string): AsyncGenerator<LogRecord> {
  for (const file of logFiles(runDir)) yield* readJsonl<LogRecord>(file);
}

/** 尾部 cap 条 */
class Ring<T> {
  private buf: T[] = [];
  private start = 0;
  constructor(private readonly cap: number) {}
  push(v: T): void {
    if (this.buf.length < this.cap) this.buf.push(v);
    else { this.buf[this.start] = v; this.start = (this.start + 1) % this.cap; }
  }
  toArray(): T[] {
    return [...this.buf.slice(this.start), ...this.buf.slice(0, this.start)];
  }
}

// ---------------------------------------------------------------------------
// 过滤
// ---------------------------------------------------------------------------

export interface LogFilter {
  level?: string;
  area?: string;
  event?: string;
  grep?: string;
  /** epoch ms,含 */
  since?: number;
  until?: number;
  round?: number;
  call?: string;
  resp?: string;
  task?: number;
}

function minLevel(spec: string | undefined): number {
  if (!spec) return 0;
  const name = spec.replace(/\+$/, '');
  if (!(name in LOG_LEVEL_RANK)) throw new UsageError(`未知级别:${spec}`);
  return LOG_LEVEL_RANK[name as LogLevel];
}

function compileGrep(spec: string | undefined): RegExp | null {
  if (!spec) return null;
  try { return new RegExp(spec, 'i'); } catch (e) { throw new UsageError(`--grep 不是合法正则:${(e as Error).message}`); }
}

function inWindow(ms: number, f: Pick<LogFilter, 'since' | 'until'>): boolean {
  return !(f.since !== undefined && ms < f.since) && !(f.until !== undefined && ms > f.until);
}

function grepText(r: LogRecord): string {
  return [
    r.msg,
    r.data === undefined ? '' : JSON.stringify(r.data),
    r.err ? `${r.err.name} ${r.err.message} ${r.err.stack ?? ''}` : '',
  ].join('\n');
}

export function logPredicate(f: LogFilter): (r: LogRecord) => boolean {
  const min = minLevel(f.level);
  const re = compileGrep(f.grep);
  const area = f.area?.replace(/\.?\*$/, '');
  const timed = f.since !== undefined || f.until !== undefined;
  return (r) => {
    if ((LOG_LEVEL_RANK[r.level] ?? 0) < min) return false;
    if (area && r.area !== area && !r.area.startsWith(`${area}.`)) return false;
    if (f.event && r.event !== f.event) return false;
    if (f.round !== undefined && r.round !== f.round) return false;
    if (f.call && r.call !== f.call) return false;
    if (f.resp && r.resp !== f.resp) return false;
    if (f.task !== undefined && r.task !== f.task) return false;
    if (timed && !inWindow(Date.parse(r.ts), f)) return false;
    if (re && !re.test(grepText(r))) return false;
    return true;
  };
}

export async function queryLog(ctx: RunContext, filter: LogFilter, limit = DEFAULT_LIMIT): Promise<LogRecord[]> {
  const pred = logPredicate(filter);
  const ring = new Ring<LogRecord>(limit);
  for await (const r of readLog(ctx.runDir)) if (pred(r)) ring.push(r);
  return ring.toArray();
}

// ---------------------------------------------------------------------------
// 格式
// ---------------------------------------------------------------------------

export const clock = (ts: string): string => ts.slice(11, 23);

/** 一行,超过 max 截断 */
export function compact(value: unknown, max: number): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  const one = s.replace(/\s*\n\s*/g, ' ');
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

interface Anchors {
  round?: number;
  call?: string;
  resp?: string;
  ev?: number;
  task?: number;
  sess?: string;
}

function anchors(r: Anchors): string {
  const parts: string[] = [];
  if (r.round !== undefined) parts.push(`r=${r.round}`);
  if (r.call) parts.push(`c=${r.call}`);
  if (r.resp) parts.push(`resp=${r.resp}`);
  if (r.ev !== undefined) parts.push(`ev=${r.ev}`);
  if (r.task !== undefined) parts.push(`t=${r.task}`);
  if (r.sess) parts.push(`s=${r.sess}`);
  return parts.length ? ` [${parts.join(' ')}]` : '';
}

/** 折叠汇总行代表 repeat 次重复,连同窗口首条印成 ×(repeat+1),与 Runlog 的 stdout 回显一致 */
function logBody(r: LogRecord): string {
  const tag = r.event ? `${r.area}/${r.event}` : r.area;
  let line = `${r.level.toUpperCase().padEnd(5)} ${tag}  ${r.msg}`;
  if (r.repeat) line += ` ×${r.repeat + 1}`;
  if (r.durMs !== undefined) line += ` ${r.durMs}ms`;
  if (r.data !== undefined) line += `  ${compact(r.data, 200)}`;
  if (r.err) line += `  err: ${r.err.message}`;
  return line + anchors(r);
}

export function formatLogLine(r: LogRecord): string {
  return `${clock(r.ts)} ${logBody(r)}`;
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

function textTable(rows: string[][]): string[] {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd());
}

export function runsTable(dataDir: string): string[] {
  const rows = readRunsIndex(dataDir);
  const known = new Set(rows.map((r) => r.run));
  for (const id of listRunIds(dataDir)) if (!known.has(id)) rows.push({ run: id });
  rows.sort((a, b) => a.run.localeCompare(b.run));
  const cells = rows.map((r) => [
    r.run,
    r.startedAt ?? '',
    r.endedAt ?? '',
    r.startedAt && r.endedAt ? fmtDuration(Date.parse(r.endedAt) - Date.parse(r.startedAt)) : '',
    r.complete === undefined ? '' : r.complete === null ? '—' : String(r.complete),
    r.reason ?? '',
    r.lastCursor === undefined ? '' : String(r.lastCursor),
  ]);
  return textTable([['run', 'startedAt', 'endedAt', 'duration', 'complete', 'reason', 'lastCursor'], ...cells]);
}

// ---------------------------------------------------------------------------
// transcript item 文本
// ---------------------------------------------------------------------------

interface LooseItem {
  type: string;
  role?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  content?: unknown;
  summary?: unknown;
  output?: unknown;
}

function partsText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (!Array.isArray(v)) return '';
  return v.map((p) => {
    const q = p as { text?: unknown; refusal?: unknown };
    return typeof q.text === 'string' ? q.text : typeof q.refusal === 'string' ? q.refusal : '';
  }).join('');
}

export function itemText(item: LooseItem): string {
  switch (item.type) {
    case 'function_call': return item.arguments ?? '';
    case 'function_call_output': return partsText(item.output);
    case 'reasoning': return partsText(item.content) || partsText(item.summary);
    default: return partsText(item.content);
  }
}

// ---------------------------------------------------------------------------
// timeline
// ---------------------------------------------------------------------------

export type StreamName = 'log' | 'toolcalls' | 'transcript' | 'events' | 'usage';
export const STREAMS: readonly StreamName[] = ['log', 'toolcalls', 'transcript', 'events', 'usage'];
const STREAM_TAG: Record<StreamName, string> = { log: 'log', toolcalls: 'tool', transcript: 'trans', events: 'event', usage: 'usage' };

export interface TimelineRow {
  stream: StreamName;
  ts: string;
  ms: number;
  text: string;
  record: unknown;
  keys: Anchors;
}

function row(stream: StreamName, ts: string, text: string, record: unknown, keys: Anchors = {}): TimelineRow {
  return { stream, ts, ms: Date.parse(ts), text, record, keys };
}

function toolRow(t: ToolCallEntry): TimelineRow {
  const keys = { round: t.round, call: t.call, resp: t.resp };
  const text = `${t.tool}${t.mod ? ` (${t.mod})` : ''}  ${t.durMs}ms ${t.chars}ch${t.failed ? ' FAILED' : ''}${t.blobs ? ` blobs=${t.blobs}` : ''}${anchors(keys)}`;
  return row('toolcalls', t.ts, text, t, keys);
}

function transcriptRow(t: TranscriptRecord): TimelineRow {
  if (t.kind === 'boundary') {
    const keys = { round: t.round, sess: t.sess };
    return row('transcript', t.ts, `boundary/${t.event}  ${compact(t.data, 120)}${anchors(keys)}`, t, keys);
  }
  const item = t.item as LooseItem;
  const keys = { round: t.round, call: item.call_id, resp: t.context.responseId, sess: t.sess };
  const head = `${item.role ? `${item.type}/${item.role}` : item.type}${item.name ? ` ${item.name}` : ''}`;
  return row('transcript', t.ts, `${head}  ${compact(itemText(item), 120)}${anchors(keys)}`, t, keys);
}

function eventRow(e: EventEnvelope): TimelineRow {
  return row('events', e.ts, `#${e.cursor} ${e.source}/${e.type}  ${compact(e.text, 120)}`, e, { ev: e.cursor });
}

function usageRow(u: UsageRecord): TimelineRow {
  const keys = { round: u.round, resp: u.attempt?.responseId ?? undefined };
  const text = `${u.model} in=${u.promptTokens} cached=${u.cacheHitTokens} out=${u.completionTokens} reasoning=${u.reasoningTokens} ${u.attempt?.elapsedMs ?? '?'}ms ${u.outcome ?? 'ok'}${anchors(keys)}`;
  return row('usage', u.ts, text, u, keys);
}

/** log 之外的流:level/area/event 不作用,task 只在 log 上有 */
function rowPredicate(f: LogFilter): (r: TimelineRow) => boolean {
  const re = compileGrep(f.grep);
  return (r) => {
    if (!inWindow(r.ms, f)) return false;
    if (f.round !== undefined && r.keys.round !== f.round) return false;
    if (f.call && r.keys.call !== f.call) return false;
    if (f.resp && r.keys.resp !== f.resp) return false;
    if (f.task !== undefined) return false;
    if (re && !re.test(JSON.stringify(r.record))) return false;
    return true;
  };
}

async function* streamRows(ctx: RunContext, name: StreamName, filter: LogFilter): AsyncGenerator<TimelineRow> {
  if (name === 'log') {
    const pred = logPredicate(filter);
    for await (const r of readLog(ctx.runDir)) {
      if (pred(r)) yield row('log', r.ts, logBody(r), r, { round: r.round, call: r.call, resp: r.resp, task: r.task, ev: r.ev, sess: r.sess });
    }
    return;
  }
  const pass = rowPredicate(filter);
  const emit = function* (r: TimelineRow) { if (pass(r)) yield r; };
  switch (name) {
    case 'toolcalls':
      for await (const t of readJsonl<ToolCallEntry>(join(ctx.runDir, 'toolcalls.jsonl'))) yield* emit(toolRow(t));
      return;
    case 'transcript':
      for await (const t of readJsonl<TranscriptRecord>(join(ctx.runDir, 'transcript.jsonl'))) yield* emit(transcriptRow(t));
      return;
    case 'events':
      for await (const e of readJsonl<EventEnvelope>(join(ctx.runDir, 'events.jsonl'))) yield* emit(eventRow(e));
      return;
    case 'usage':
      for await (const u of readJsonl<UsageRecord>(join(ctx.dataDir, 'usage.jsonl'))) if (u.run === ctx.run) yield* emit(usageRow(u));
      return;
  }
}

/**
 * k 路归并,尾部 limit 条。各流自身按追加序,子进程转来的记录可能晚几毫秒落盘,
 * 所以最后再按 ms 稳定排一次。
 */
export async function timeline(
  ctx: RunContext,
  opts: { streams?: readonly StreamName[]; filter?: LogFilter; limit?: number } = {},
): Promise<TimelineRow[]> {
  const streams = opts.streams ?? STREAMS;
  const filter = opts.filter ?? {};
  const sources = streams.map((name) => streamRows(ctx, name, filter));
  const heads = await Promise.all(sources.map((s) => s.next()));
  const ring = new Ring<TimelineRow>(opts.limit ?? DEFAULT_LIMIT);
  for (;;) {
    let pick = -1;
    for (let i = 0; i < heads.length; i++) {
      const h = heads[i];
      if (h.done) continue;
      if (pick < 0 || h.value.ms < (heads[pick] as IteratorYieldResult<TimelineRow>).value.ms) pick = i;
    }
    if (pick < 0) break;
    ring.push((heads[pick] as IteratorYieldResult<TimelineRow>).value);
    heads[pick] = await sources[pick].next();
  }
  return ring.toArray().sort((a, b) => a.ms - b.ms);
}

export function formatTimelineRow(r: TimelineRow): string {
  return `${clock(r.ts)} ${STREAM_TAG[r.stream].padEnd(5)}  ${r.text}`;
}

export function parseStreams(spec: string | undefined): StreamName[] {
  if (!spec) return [...STREAMS];
  const names = spec.split(',').map((s) => s.trim()).filter(Boolean);
  for (const n of names) if (!STREAMS.includes(n as StreamName)) throw new UsageError(`未知的流:${n}(可选 ${STREAMS.join(',')})`);
  return names as StreamName[];
}

// ---------------------------------------------------------------------------
// turn
// ---------------------------------------------------------------------------

const indent = (s: string, pad = '  '): string => s.split('\n').map((l) => pad + l).join('\n');

export async function turn(ctx: RunContext, round: number, opts: { full?: boolean } = {}): Promise<string[]> {
  const cut = (s: string, n: number): string => (opts.full || s.length <= n ? s : `${s.slice(0, n)}…`);

  const items: TranscriptItemRecord[] = [];
  for await (const t of readJsonl<TranscriptRecord>(join(ctx.runDir, 'transcript.jsonl'))) {
    if (t.kind === 'item' && t.round === round) items.push(t);
  }
  const callRows: ToolCallEntry[] = [];
  const byCallId = new Map<string, ToolCallEntry>();
  for await (const t of readJsonl<ToolCallEntry>(join(ctx.runDir, 'toolcalls.jsonl'))) {
    if (t.round !== round) continue;
    callRows.push(t);
    if (t.call) byCallId.set(t.call, t);
  }
  const wanted = new Set<number>();
  for (const it of items) for (const ref of it.context.frame?.events ?? []) wanted.add(ref.cursor);
  const events = new Map<number, EventEnvelope>();
  if (wanted.size) {
    for await (const e of readJsonl<EventEnvelope>(join(ctx.runDir, 'events.jsonl'))) if (wanted.has(e.cursor)) events.set(e.cursor, e);
  }
  const moduleRecords = new Map<string, LogRecord[]>();
  if (byCallId.size) {
    for await (const r of readLog(ctx.runDir)) {
      if (!r.call || !byCallId.has(r.call)) continue;
      const list = moduleRecords.get(r.call) ?? [];
      list.push(r);
      moduleRecords.set(r.call, list);
    }
  }
  const usage: UsageRecord[] = [];
  for await (const u of readJsonl<UsageRecord>(join(ctx.dataDir, 'usage.jsonl'))) if (u.run === ctx.run && u.round === round) usage.push(u);

  const out: string[] = [`# turn ${round} · ${ctx.run} · transcript ${items.length} 条 · 工具 ${callRows.length} 次`];
  const printed = new Set<string>();
  const printCall = (t: ToolCallEntry): void => {
    out.push(`## 工具 ${t.tool}${t.mod ? ` (${t.mod})` : ''}  ${clock(t.ts)}  ${t.durMs}ms  ${t.failed ? 'FAILED' : 'ok'}${t.call ? `  c=${t.call}` : ''}`);
    out.push(`  args: ${cut(compact(t.args, Infinity), 300)}`);
    out.push(`  receipt(${t.chars}ch): ${cut(compact(t.receipt, Infinity), 300)}`);
    if (t.call) {
      for (const r of moduleRecords.get(t.call) ?? []) out.push(`    ${formatLogLine(r)}`);
      printed.add(t.call);
    }
  };

  for (const it of items) {
    const item = it.item as LooseItem;
    if (item.type === 'message' && item.role === 'user') {
      const refs = it.context.frame?.events ?? [];
      if (!refs.length) {
        out.push(`## user ${clock(it.ts)}`, indent(cut(itemText(item), 400)));
        continue;
      }
      out.push(`## 投递 ${clock(it.ts)} · ${refs.length} 条事件`);
      for (const ref of refs) {
        const e = events.get(ref.cursor);
        out.push(e
          ? `  #${e.cursor} ${clock(e.ts)} ${e.source}/${e.type}  ${cut(compact(e.text, Infinity), 400)}`
          : `  #${ref.cursor} ${clock(ref.ts)} ${ref.source}/${ref.type}  (不在本 run 的 events.jsonl)`);
      }
    } else if (item.type === 'reasoning') {
      out.push(`## 推理 ${clock(it.ts)}`, indent(cut(itemText(item), 400)));
    } else if (item.type === 'message' && item.role === 'assistant') {
      out.push(`## assistant ${clock(it.ts)}`, indent(itemText(item)));
    } else if (item.type === 'function_call') {
      const t = item.call_id ? byCallId.get(item.call_id) : undefined;
      if (t) printCall(t);
      else out.push(`## 工具 ${item.name ?? '?'}  ${clock(it.ts)}  (toolcalls.jsonl 无此行)`, `  args: ${cut(item.arguments ?? '', 300)}`);
    } else if (item.type === 'function_call_output') {
      if (!item.call_id || !printed.has(item.call_id)) out.push(`  output: ${cut(compact(itemText(item), Infinity), 300)}`);
    } else {
      out.push(`## ${item.type} ${clock(it.ts)}`, indent(cut(itemText(item), 400)));
    }
  }
  for (const t of callRows) if (!t.call || !printed.has(t.call)) printCall(t);
  out.push(`## 用量 ${usage.length} 次`);
  for (const u of usage) {
    out.push(`  ${clock(u.ts)} ${u.model} prompt=${u.promptTokens} completion=${u.completionTokens} cached=${u.cacheHitTokens} ${u.attempt?.elapsedMs ?? '?'}ms ${u.outcome ?? 'ok'}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

/** 最近秩分位;values 非空 */
export function quantile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

const LLM_EVENTS = new Set(['llm-failed', 'stall', 'watermark-stall']);
const LLM_MSG = ['连续失败', '水位停滞'];
const TTS_EVENTS = new Set(['stream-received', 'synth']);
/** 相邻重连超过此间隔时分组统计。 */
const VTS_WINDOW_GAP_MS = 60_000;
const WARN_TOP = 15;
const MIN_DELAY_SAMPLES = 5;

interface ErrorGroup { count: number; first: string; last: string; msg: string }

const pct = (n: number, d: number): string => (d ? `${Math.round((n / d) * 100)}%` : '—');

export async function doctor(ctx: RunContext): Promise<string> {
  // toolcalls
  const perTool = new Map<string, { count: number; failed: number; dur: number[] }>();
  const roundTools = new Map<number, Set<string>>();
  let acts = 0;
  let emptyActs = 0;
  /** vtuber_act 调用开始刻(行的 ts 是回执刻,减 durMs) */
  const actStart = new Map<string, number>();
  for await (const t of readJsonl<ToolCallEntry>(join(ctx.runDir, 'toolcalls.jsonl'))) {
    const s = perTool.get(t.tool) ?? { count: 0, failed: 0, dur: [] };
    s.count++;
    if (t.failed) s.failed++;
    s.dur.push(t.durMs);
    perTool.set(t.tool, s);
    if (t.round !== undefined) {
      const set = roundTools.get(t.round) ?? new Set<string>();
      set.add(t.tool);
      roundTools.set(t.round, set);
    }
    if (t.tool === 'vtuber_act') {
      acts++;
      const script = t.args?.script;
      if (typeof script !== 'string' || !script.trim()) emptyActs++;
      if (t.call) actStart.set(t.call, Date.parse(t.ts) - t.durMs);
    }
  }

  // log
  const errors = new Map<string, ErrorGroup>();
  const warns = new Map<string, number>();
  const llmLogs: LogRecord[] = [];
  const ttsFirst = new Map<string, { ms: number; preferred: boolean }>();
  const reconnects: Array<{ ms: number; n: number }> = [];
  const deaths: LogRecord[] = [];
  for await (const r of readLog(ctx.runDir)) {
    const key = r.event ? `${r.area}/${r.event}` : r.area;
    // 折叠汇总行代表 repeat 次重复,普通行计 1
    const n = r.repeat ?? 1;
    if (r.level === 'error') {
      const g = errors.get(key);
      if (g) { g.count += n; g.last = r.ts; } else errors.set(key, { count: n, first: r.ts, last: r.ts, msg: r.msg });
    } else if (r.level === 'warn') {
      warns.set(key, (warns.get(key) ?? 0) + n);
    }
    if ((r.event && LLM_EVENTS.has(r.event)) || LLM_MSG.some((m) => r.msg.includes(m))) llmLogs.push(r);
    if (r.call && actStart.has(r.call) && r.area.startsWith('worlds.vtuber.tts')) {
      const preferred = r.event !== undefined && TTS_EVENTS.has(r.event);
      const cur = ttsFirst.get(r.call);
      if (!cur || (preferred && !cur.preferred)) ttsFirst.set(r.call, { ms: Date.parse(r.ts), preferred });
    }
    if ((r.area === 'worlds.vtuber.inject' && r.event === 'reconnect') || r.msg.includes('VTS 排定重连')) reconnects.push({ ms: Date.parse(r.ts), n });
    if (r.area.startsWith('worlds.minecraft.world') && (r.event === 'death' || r.event === 'death-cause')) deaths.push(r);
  }

  // usage
  const usage: UsageRecord[] = [];
  for await (const u of readJsonl<UsageRecord>(join(ctx.dataDir, 'usage.jsonl'))) if (u.run === ctx.run) usage.push(u);

  const out: string[] = [];
  const span = ctx.endedAt ? `${ctx.startedAt} → ${ctx.endedAt},${fmtDuration(Date.parse(ctx.endedAt) - Date.parse(ctx.startedAt))}` : `${ctx.startedAt} → (无关机行)`;
  out.push(`# doctor · ${ctx.run}`, '', `${span}`, '');

  out.push('## 1. error 记录', '');
  if (errors.size) {
    out.push('| area/event | 次数 | 首见 | 末见 | 例 |', '|---|---|---|---|---|');
    for (const [key, g] of [...errors].sort((a, b) => b[1].count - a[1].count)) out.push(`| ${key} | ${g.count} | ${clock(g.first)} | ${clock(g.last)} | ${compact(g.msg, 80)} |`);
  } else out.push('无');
  out.push('');

  out.push(`## 2. warn 折叠 Top ${WARN_TOP}`, '');
  if (warns.size) {
    out.push('| area/event | 次数 |', '|---|---|');
    for (const [key, n] of [...warns].sort((a, b) => b[1] - a[1]).slice(0, WARN_TOP)) out.push(`| ${key} | ${n} |`);
  } else out.push('无');
  out.push('');

  out.push('## 3. LLM', '');
  if (usage.length) {
    const failed = usage.filter((u) => u.outcome === 'failed').length;
    const discarded = usage.filter((u) => u.outcome === 'discarded').length;
    const elapsed = usage.map((u) => u.attempt?.elapsedMs).filter((v): v is number => typeof v === 'number');
    out.push(`- 尝试 ${usage.length} 次,失败 ${failed},丢弃 ${discarded}`);
    if (elapsed.length) out.push(`- elapsedMs p50 ${quantile(elapsed, 0.5)} / p90 ${quantile(elapsed, 0.9)}(${elapsed.length} 样本)`);
    const times = usage.map((u) => ({ ms: Date.parse(u.ts), ts: u.ts })).sort((a, b) => a.ms - b.ms);
    let gap = { ms: -1, from: '', to: '' };
    for (let i = 1; i < times.length; i++) {
      const d = times[i].ms - times[i - 1].ms;
      if (d > gap.ms) gap = { ms: d, from: times[i - 1].ts, to: times[i].ts };
    }
    if (gap.ms >= 0) out.push(`- 相邻尝试最长间隔 ${fmtDuration(gap.ms)}(${clock(gap.from)} → ${clock(gap.to)})`);
  } else out.push('- usage.jsonl 里没有本 run 的行');
  if (llmLogs.length) {
    out.push(`- 相关日志 ${llmLogs.length} 条:`);
    for (const r of llmLogs) out.push(`  - ${formatLogLine(r)}`);
  } else out.push('- 相关日志:无');
  out.push('');

  out.push('## 4. 工具调用', '');
  if (perTool.size) {
    out.push('| tool | 次数 | 失败 | p50 ms | p90 ms |', '|---|---|---|---|---|');
    for (const [tool, s] of [...perTool].sort((a, b) => b[1].count - a[1].count)) out.push(`| ${tool} | ${s.count} | ${s.failed} | ${quantile(s.dur, 0.5)} | ${quantile(s.dur, 0.9)} |`);
    const rounds = roundTools.size;
    const endOnly = [...roundTools.values()].filter((set) => set.size === 1 && set.has('end_turn')).length;
    out.push('', `- 只有 end_turn 的轮次:${endOnly} / ${rounds}(${pct(endOnly, rounds)})`);
  } else out.push('无');
  out.push('');

  out.push('## 5. 台词', '');
  if (acts) {
    out.push(`- vtuber_act ${acts} 次,空台本 ${emptyActs}(${pct(emptyActs, acts)})`);
    const delays: number[] = [];
    for (const [call, start] of actStart) {
      const first = ttsFirst.get(call);
      if (first) delays.push(first.ms - start);
    }
    out.push(delays.length >= MIN_DELAY_SAMPLES
      ? `- act→tts 延迟(调用开始 → 首条 worlds.vtuber.tts 记录)p50 ${quantile(delays, 0.5)} ms / p90 ${quantile(delays, 0.9)} ms(${delays.length} 样本)`
      : `- act→tts 延迟:样本不足(${delays.length} < ${MIN_DELAY_SAMPLES})`);
  } else out.push('无');
  out.push('');

  out.push('## 6. VTS 重连', '');
  if (reconnects.length) {
    reconnects.sort((a, b) => a.ms - b.ms);
    const total = reconnects.reduce((s, r) => s + r.n, 0);
    let win = { start: reconnects[0].ms, last: reconnects[0].ms, n: reconnects[0].n };
    let best = win;
    for (const r of reconnects.slice(1)) {
      if (r.ms - win.last > VTS_WINDOW_GAP_MS) win = { start: r.ms, last: r.ms, n: r.n };
      else { win.last = r.ms; win.n += r.n; }
      if (win.last - win.start > best.last - best.start || (win.last - win.start === best.last - best.start && win.n > best.n)) best = win;
    }
    out.push(`- 共 ${total} 次;最长连续窗口 ${fmtDuration(best.last - best.start)}(${best.n} 次,${clockAt(best.start, ctx.offset)} → ${clockAt(best.last, ctx.offset)})`);
  } else out.push('无');
  out.push('');

  out.push('## 7. minecraft 死亡', '');
  if (deaths.length) for (const r of deaths) out.push(`- ${clock(r.ts)} ${r.event}  ${r.msg}${r.data !== undefined ? `  ${compact(r.data, 200)}` : ''}`);
  else out.push('无');
  out.push('');

  out.push('## 8. 事故包', '');
  const incidents = join(ctx.runDir, 'incidents');
  const files = existsSync(incidents) ? readdirSync(incidents).sort() : [];
  if (files.length) for (const f of files) out.push(`- ${f}(${statSync(join(incidents, f)).size} B)`);
  else out.push('无');
  out.push('');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// bundle
// ---------------------------------------------------------------------------

function copyTree(src: string, dest: string, files: string[]): void {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    const to = join(dest, name);
    if (statSync(from).isDirectory()) copyTree(from, to, files);
    else { copyFileSync(from, to); files.push(to); }
  }
}

/** 返回写出的文件路径 */
export async function bundle(ctx: RunContext, outDir: string): Promise<string[]> {
  const dest = join(resolve(outDir), ctx.run);
  const files: string[] = [];
  copyTree(ctx.runDir, dest, files);

  const usage: string[] = [];
  for await (const u of readJsonl<UsageRecord>(join(ctx.dataDir, 'usage.jsonl'))) if (u.run === ctx.run) usage.push(JSON.stringify(u));
  const usageFile = join(dest, 'usage.jsonl');
  writeFileSync(usageFile, usage.length ? `${usage.join('\n')}\n` : '', 'utf8');
  files.push(usageFile);

  const indexSrc = join(ctx.dataDir, 'runs', 'index.jsonl');
  const indexLines = existsSync(indexSrc)
    ? readFileSync(indexSrc, 'utf8').split(/\r?\n/).filter((line) => line.includes(`"run":"${ctx.run}"`))
    : [];
  const indexFile = join(dest, 'index.jsonl');
  writeFileSync(indexFile, indexLines.length ? `${indexLines.join('\n')}\n` : '', 'utf8');
  files.push(indexFile);

  const config = join(dirname(ctx.dataDir), 'config.json');
  if (existsSync(config)) {
    const configFile = join(dest, 'config.json');
    writeFileSync(configFile, `${JSON.stringify(redactSecrets(JSON.parse(readFileSync(config, 'utf8'))), null, 2)}\n`, 'utf8');
    files.push(configFile);
  }

  const doctorFile = join(dest, 'doctor.md');
  writeFileSync(doctorFile, await doctor(ctx), 'utf8');
  files.push(doctorFile);
  return files;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function filterFrom(a: Argv, ctx: RunContext): LogFilter {
  const since = opt(a, 'since');
  const until = opt(a, 'until');
  return {
    level: opt(a, 'level'),
    area: opt(a, 'area'),
    event: opt(a, 'event'),
    grep: opt(a, 'grep'),
    since: since ? parseWhen(since, ctx) : undefined,
    until: until ? parseWhen(until, ctx) : undefined,
    round: intOpt(a, 'round'),
    call: opt(a, 'call'),
    resp: opt(a, 'resp'),
    task: intOpt(a, 'task'),
  };
}

const lines = (rows: readonly string[]): string => (rows.length ? `${rows.join('\n')}\n` : '');

export async function main(
  argv: readonly string[],
  out: (text: string) => void = (text) => { process.stdout.write(text); },
  err: (text: string) => void = (text) => { process.stderr.write(text); },
): Promise<number> {
  try {
    const a = parseArgs(argv);
    if (a.opts.help) { out(USAGE); return 0; }
    const dataDir = resolveDataDir({ bot: opt(a, 'bot'), data: opt(a, 'data') });
    if (a.cmd === 'runs') { out(lines(runsTable(dataDir))); return 0; }
    const ctx = locateRun(dataDir, opt(a, 'run') ?? 'latest');
    const format = opt(a, 'format') ?? 'text';
    if (format !== 'text' && format !== 'jsonl') throw new UsageError(`--format 只认 text|jsonl,给的是 ${format}`);
    switch (a.cmd) {
      case 'log': {
        const rows = await queryLog(ctx, filterFrom(a, ctx), intOpt(a, 'limit') ?? DEFAULT_LIMIT);
        out(lines(rows.map((r) => (format === 'jsonl' ? JSON.stringify(r) : formatLogLine(r)))));
        return 0;
      }
      case 'timeline': {
        const rows = await timeline(ctx, { streams: parseStreams(opt(a, 'streams')), filter: filterFrom(a, ctx), limit: intOpt(a, 'limit') ?? DEFAULT_LIMIT });
        out(lines(rows.map((r) => (format === 'jsonl' ? JSON.stringify({ stream: r.stream, ...(r.record as object) }) : formatTimelineRow(r)))));
        return 0;
      }
      case 'turn': {
        const n = Number(a.positional[0] ?? opt(a, 'round'));
        if (!Number.isInteger(n)) throw new UsageError('turn 需要轮次号:pnpm logq turn 12');
        out(lines(await turn(ctx, n, { full: a.opts.full === true })));
        return 0;
      }
      case 'doctor':
        out(await doctor(ctx));
        return 0;
      case 'bundle': {
        const dir = opt(a, 'out');
        if (!dir) throw new UsageError('bundle 需要 --out <dir>');
        out(lines(await bundle(ctx, dir)));
        return 0;
      }
      default:
        throw new UsageError(`未知子命令 ${a.cmd}`);
    }
  } catch (e) {
    if (e instanceof UsageError) { err(`logq: ${e.message}\n`); return 1; }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
