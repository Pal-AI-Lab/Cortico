import { type ContextRecord } from '../protocol/open-responses/context.ts';
/**
 * 共享小工具:token估算、时间格式化、Logger实现。
 */
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LOG_LEVEL_RANK, type EventEnvelope, type LogEmitOptions, type LogError, type LogInput, type Logger, type LogLevel, type LogRecord } from './types.ts';
import { currentAnchors } from './log-context.ts';


export { estimateTokens, estimateMessagesTokens } from '../protocol/open-responses/tokens.ts';

/**
 * 前 count 条消息按请求形状序列化后计算 SHA256，取前 12 位用于日志比较。
 * 该指纹不参与运行控制，也不证明上游缓存是否命中。
 */
export function prefixFingerprint(messages: readonly ContextRecord[], count = PREFIX_FINGERPRINT_MESSAGES): string {
  const parts = messages.slice(0, count).map(({ item }) => {
    const { id: _id, ...wire } = item;
    return JSON.stringify(wire);
  });
  return createHash('sha256').update(parts.join('\0'), 'utf8').digest('hex').slice(0, 12);
}

/** 指纹覆盖的消息条数，包含 system 前缀、合成首轮对话及其后的部分上下文。 */
export const PREFIX_FINGERPRINT_MESSAGES = 8;


/** 超时后拒绝返回的 Promise；不会取消仍在运行的底层 Promise。 */
export function withDeadline<T>(work: Promise<T>, ms: number, what = '这一步'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what}超时(${Math.round(ms / 1000)}秒)`)), ms);
    work.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e as Error); },
    );
  });
}

/** 当前时刻ISO 8601(带时区偏移,毫秒),按配置时区渲染 */
export function nowIso(timezone: string, d: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = `${fmt.format(d).replace(' ', 'T')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  const offMin = -getTimezoneOffsetMinutes(timezone, d);
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${parts}${sign}${hh}:${mm}`;
}

/** 目标时区相对UTC的偏移(分钟, UTC-本地=负东区),内部用 */
function getTimezoneOffsetMinutes(timezone: string, d: Date): number {
  const utc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
  const loc = new Date(d.toLocaleString('en-US', { timeZone: timezone }));
  return (utc.getTime() - loc.getTime()) / 60000;
}

/** 渲染"[HH:MM]"短时间(消息行用) */
export function shortTime(timezone: string, d: Date = new Date()): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
}

export function hourIn(timezone: string, d: Date = new Date()): number {
  return parseInt(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour: 'numeric', hour12: false,
  }).format(d), 10) % 24;
}

/** 返回 World 提供的事件正文，不添加存储游标或语义文本。 */
export function renderEventLines(events: EventEnvelope[]): string {
  return events.map((e) => e.text).join('\n');
}

/** 折叠窗口:同一 (area, event|msg 模板) 的 warn/error 在窗口内只落第一条,窗口末补一条计数。 */
const FOLD_MS = 30_000;
/** 同一 key 的错误上下文快照写入间隔 */
const INCIDENT_GAP_MS = 60_000;
/** 错误上下文快照附带的最近记录条数 */
const RING_SIZE = 300;
/** 单文件大小上限；轮转文件数在当前 run 内不设上限。 */
const ROTATE_BYTES = 64 * 1024 * 1024;

export interface RunlogLevels {
  file: LogLevel;
  console: LogLevel;
  areas: string;
}

export interface RunlogOptions {
  run?: string;
  timezone?: string;
  /** 现读:配置热改立即生效 */
  levels?: () => RunlogLevels;
  /** error 记录的上下文快照目录；未提供时不写快照。 */
  incidentsDir?: string | null;
  /** 是否同时打到 stdout(测试关掉) */
  console?: boolean;
}

const DEFAULT_LEVELS: RunlogLevels = { file: 'debug', console: 'info', areas: '' };

export function normalizeError(value: unknown): LogError {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, ...(value.stack ? { stack: value.stack } : {}) };
  }
  if (typeof value === 'string') return { name: 'Error', message: value };
  if (value && typeof value === 'object') {
    const v = value as { name?: unknown; message?: unknown; stack?: unknown };
    if (typeof v.message === 'string') {
      return {
        name: typeof v.name === 'string' ? v.name : 'Error',
        message: v.message,
        ...(typeof v.stack === 'string' ? { stack: v.stack } : {}),
      };
    }
  }
  return { name: 'Error', message: String(value) };
}

/** 解析 `a.b=level,c.*=level`;条目按前缀长度降序,最长前缀命中优先 */
function parseAreaLevels(spec: string): Array<{ prefix: string; level: LogLevel }> {
  const out: Array<{ prefix: string; level: LogLevel }> = [];
  for (const part of spec.split(',')) {
    const [rawArea, rawLevel] = part.split('=').map((s) => s.trim());
    if (!rawArea || !rawLevel) continue;
    if (!(rawLevel in LOG_LEVEL_RANK)) continue;
    const prefix = rawArea.endsWith('.*') ? rawArea.slice(0, -2) : rawArea.endsWith('*') ? rawArea.slice(0, -1) : rawArea;
    out.push({ prefix: prefix.replace(/\.$/, ''), level: rawLevel as LogLevel });
  }
  return out.sort((a, b) => b.prefix.length - a.prefix.length);
}

function foldKey(input: { area: string; event?: string; msg: string }): string {
  return `${input.area}|${input.event ?? input.msg.replace(/\d+(\.\d+)?/g, '#').slice(0, 80)}`;
}

function slug(text: string): string {
  return text.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40) || 'error';
}

const ANCHOR_KEYS = ['sess', 'round', 'resp', 'call', 'ev', 'task'] as const;

/**
 * 日志写入 data/runs/<run>/log.jsonl，并按独立门槛输出到 stdout。
 * 写入时读取异步作用域的关联字段；重复 warn/error 合并计数，error 可另存诊断记录。
 */
export class Runlog {
  private readonly file: string | null;
  private readonly run: string;
  private readonly timezone: string;
  private readonly levels: () => RunlogLevels;
  private readonly incidentsDir: string | null;
  private readonly echo: boolean;
  private seq = 0;
  private bytes = 0;
  private dirReady = false;
  private areaSpec = '';
  private areaLevels: Array<{ prefix: string; level: LogLevel }> = [];
  private readonly ring: LogRecord[] = [];
  private readonly folds = new Map<string, { count: number; record: LogRecord; timer: NodeJS.Timeout }>();
  private readonly incidentAt = new Map<string, number>();
  private writeListeners: Array<(entry: LogRecord) => void> = [];

  constructor(file: string | null, opts: RunlogOptions = {}) {
    this.file = file;
    this.run = opts.run ?? 'r-none';
    this.timezone = opts.timezone ?? 'Asia/Shanghai';
    this.levels = opts.levels ?? (() => DEFAULT_LEVELS);
    this.incidentsDir = opts.incidentsDir ?? null;
    this.echo = opts.console ?? true;
    if (file) {
      const dir = dirname(file);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      this.dirReady = true;
      try { this.bytes = existsSync(file) ? statSync(file).size : 0; } catch { this.bytes = 0; }
    }
  }

  get path(): string | null { return this.file; }
  get runId(): string { return this.run; }

  /** 日志追加订阅，供控制台实时观察。 */
  onWrite(cb: (entry: LogRecord) => void): void {
    this.writeListeners.push(cb);
  }

  /** 内存中最近的日志记录，包含未写入文件的记录。 */
  recent(limit = RING_SIZE): LogRecord[] {
    return this.ring.slice(-limit);
  }

  private fileThreshold(area: string): LogLevel {
    const levels = this.levels();
    if (levels.areas !== this.areaSpec) {
      this.areaSpec = levels.areas;
      this.areaLevels = parseAreaLevels(levels.areas);
    }
    for (const entry of this.areaLevels) {
      if (area === entry.prefix || area.startsWith(`${entry.prefix}.`)) return entry.level;
    }
    return levels.file;
  }

  write(input: LogInput): LogRecord | null {
    const rank = LOG_LEVEL_RANK[input.level];
    const toFile = rank >= LOG_LEVEL_RANK[this.fileThreshold(input.area)];
    const toConsole = this.echo && rank >= LOG_LEVEL_RANK[this.levels().console];
    if (!toFile && !toConsole) return null;
    const record = this.build(input);
    if (rank >= LOG_LEVEL_RANK.warn && this.fold(record)) return null;
    this.commit(record, toFile, toConsole);
    if (record.level === 'error') this.incident(record);
    return record;
  }

  private build(input: LogInput): LogRecord {
    const anchors = currentAnchors();
    const record: LogRecord = {
      ts: input.ts ?? nowIso(this.timezone),
      run: this.run,
      seq: ++this.seq,
      level: input.level,
      area: input.area,
      msg: input.msg,
    };
    if (input.event !== undefined) record.event = input.event;
    for (const key of ANCHOR_KEYS) {
      const value = input[key] ?? anchors[key];
      if (value !== undefined) (record as unknown as Record<string, unknown>)[key] = value;
    }
    if (input.durMs !== undefined) record.durMs = input.durMs;
    let data = input.data;
    let err = input.err;
    if (data instanceof Error) { err ??= data; data = undefined; }
    else if (data && typeof data === 'object' && !Array.isArray(data)) {
      const bag = data as Record<string, unknown>;
      const carried = bag.err instanceof Error ? bag.err : bag.error instanceof Error ? bag.error : undefined;
      if (carried) {
        err ??= carried;
        const { err: _e, error: _error, ...rest } = bag;
        data = Object.keys(rest).length ? rest : undefined;
      }
    }
    if (data !== undefined) record.data = data;
    if (err !== undefined) record.err = normalizeError(err);
    return record;
  }

  /** 窗口内重复的 warn/error 只累计计数；返回 true 表示本条无需另行写入。 */
  private fold(record: LogRecord): boolean {
    const key = foldKey(record);
    const open = this.folds.get(key);
    if (open) { open.count++; return true; }
    const timer = setTimeout(() => {
      const entry = this.folds.get(key);
      this.folds.delete(key);
      if (!entry || entry.count === 0) return;
      const summary: LogRecord = { ...entry.record, ts: nowIso(this.timezone), seq: ++this.seq, repeat: entry.count };
      this.commit(summary, true, this.echo);
    }, FOLD_MS);
    timer.unref?.();
    this.folds.set(key, { count: 0, record, timer });
    return false;
  }

  private commit(record: LogRecord, toFile: boolean, toConsole: boolean): void {
    this.ring.push(record);
    if (this.ring.length > RING_SIZE) this.ring.shift();
    if (toFile && this.file) {
      try {
        if (!this.dirReady) { mkdirSync(dirname(this.file), { recursive: true }); this.dirReady = true; }
        if (this.bytes > ROTATE_BYTES) this.rotate();
        const line = `${JSON.stringify(record)}\n`;
        appendFileSync(this.file, line, 'utf8');
        this.bytes += Buffer.byteLength(line, 'utf8');
      } catch {
        // 日志写不进去不影响运行
      }
    }
    for (const cb of this.writeListeners) {
      try { cb(record); } catch { /* 观察者异常不影响日志 */ }
    }
    if (!toConsole) return;
    const clock = record.ts.slice(11, 23);
    const tag = record.event ? `${record.area}/${record.event}` : record.area;
    const line = `[${clock}] ${record.level.toUpperCase().padEnd(5)} ${tag}: ${record.msg}${record.repeat ? ` (×${record.repeat + 1})` : ''}`;
    if (record.level === 'error') console.error(line, record.err?.stack ?? record.err?.message ?? '', record.data ?? '');
    else if (record.level === 'warn') console.warn(line, record.data ?? '');
    else console.log(line);
  }

  /** log.jsonl → log.1.jsonl,已有的代数各退一位 */
  private rotate(): void {
    if (!this.file) return;
    const base = this.file.replace(/\.jsonl$/, '');
    let n = 1;
    while (existsSync(`${base}.${n}.jsonl`)) n++;
    for (let i = n - 1; i >= 1; i--) renameSync(`${base}.${i}.jsonl`, `${base}.${i + 1}.jsonl`);
    renameSync(this.file, `${base}.1.jsonl`);
    this.bytes = 0;
  }

  private incident(record: LogRecord): void {
    if (!this.incidentsDir) return;
    const key = foldKey(record);
    const now = Date.now();
    const last = this.incidentAt.get(key) ?? 0;
    if (now - last < INCIDENT_GAP_MS) return;
    this.incidentAt.set(key, now);
    try {
      mkdirSync(this.incidentsDir, { recursive: true });
      const name = `${record.ts.slice(0, 23).replace(/[:.]/g, '-')}-${slug(record.event ?? record.msg)}.json`;
      writeFileSync(join(this.incidentsDir, name), JSON.stringify({ record, anchors: currentAnchors(), recent: this.ring.slice(0, -1) }, null, 1), 'utf8');
    } catch {
      // 快照写入失败不影响运行
    }
  }

  logger(area: string): Logger {
    return makeLogger(this, area);
  }

  /** 清空当前 run 的日志文件(web运维动作);之后照常append */
  clear(): void {
    if (!this.file) return;
    try {
      writeFileSync(this.file, '', 'utf8');
      this.bytes = 0;
    } catch {
      // 清空失败不致命
    }
  }
}

function makeLogger(runlog: Runlog, area: string): Logger {
  const emit = (level: LogLevel, msg: string, opts?: LogEmitOptions): void => {
    runlog.write({ level, area, msg, ...opts });
  };
  return {
    trace: (m, d) => emit('trace', m, { data: d }),
    debug: (m, d) => emit('debug', m, { data: d }),
    info: (m, d) => emit('info', m, { data: d }),
    warn: (m, d) => emit('warn', m, { data: d }),
    error: (m, d) => emit('error', m, { data: d }),
    emit,
    child: (sub) => makeLogger(runlog, `${area}.${sub}`),
  };
}

/** 测试用:静默logger */
export function nullLogger(): Logger {
  const l: Logger = {
    trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
    emit: () => {},
    child: () => l,
  };
  return l;
}

/** 生成短随机id(tool_call补记、fork id等) */
export function shortId(prefix = ''): string {
  return prefix + Math.random().toString(36).slice(2, 10);
}

/**
 * 读一个手写的文本文件:按 BOM 选编码,UTF-8 与 UTF-16 LE 都读得出来,BOM 不进返回值。
 * 没有 BOM 就是 UTF-8。Windows 的 shell 重定向写出的是带 BOM 的 UTF-8 或 UTF-16 LE。
 */
export function readTextFile(file: string): string {
  const bytes = readFileSync(file);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString('utf16le');
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3).toString('utf8');
  }
  return bytes.toString('utf8');
}
