/**
 * 子进程通过 IPC 发送 LogNote，父进程写入日志。
 * 日志关联字段在子进程的异步作用域读取；时间使用子进程的 epoch 毫秒值，
 * 由父进程按配置时区格式化。
 */
import type { LogAnchorFields, LogEmitOptions, LogError, Logger, LogLevel } from './types.ts';
import { currentAnchors } from './log-context.ts';
import { LOG_ANCHOR_KEYS, normalizeError, nowIso, splitLogError } from './util.ts';

export interface LogNote extends LogAnchorFields {
  kind: 'log';
  level: LogLevel;
  area: string;
  msg: string;
  event?: string;
  durMs?: number;
  data?: unknown;
  err?: LogError;
  /** 子进程侧的 epoch 毫秒 */
  atMs: number;
}

export function createIpcLogger(send: (note: LogNote) => void, area = ''): Logger {
  const emit = (level: LogLevel, msg: string, opts?: LogEmitOptions): void => {
    const anchors = currentAnchors();
    const note: LogNote = { kind: 'log', level, area, msg, atMs: Date.now() };
    if (opts?.event !== undefined) note.event = opts.event;
    if (opts?.durMs !== undefined) note.durMs = opts.durMs;
    for (const key of LOG_ANCHOR_KEYS) {
      const value = opts?.[key] ?? anchors[key];
      if (value !== undefined) (note as unknown as Record<string, unknown>)[key] = value;
    }
    const split = splitLogError(opts?.data, opts?.err);
    let data = split.data;
    const err = split.err;
    if (data !== undefined) {
      try { JSON.stringify(data); } catch { data = String(data); }
      note.data = data;
    }
    if (err !== undefined) note.err = normalizeError(err);
    send(note);
  };
  return {
    trace: (m, d) => emit('trace', m, { data: d }),
    debug: (m, d) => emit('debug', m, { data: d }),
    info: (m, d) => emit('info', m, { data: d }),
    warn: (m, d) => emit('warn', m, { data: d }),
    error: (m, d) => emit('error', m, { data: d }),
    emit,
    child: (sub) => createIpcLogger(send, area ? `${area}.${sub}` : sub),
  };
}

/** 主进程侧:把子进程的 note 按原字段落到 World 的 logger 下。 */
export function emitLogNote(root: Logger, note: LogNote, timezone: string): void {
  const target = note.area ? root.child(note.area) : root;
  const { kind: _kind, level, area: _area, msg, atMs, ...rest } = note;
  target.emit(level, msg, { ...rest, ts: nowIso(timezone, new Date(atMs)) });
}

/** 把一个输出流按行落日志;跨 chunk 的半行拼起来,空行不记。 */
export function logLines(
  stream: NodeJS.ReadableStream | null | undefined,
  log: Logger,
  level: LogLevel,
  event: string,
): void {
  if (!stream) return;
  let carry = '';
  stream.on('data', (chunk: Buffer | string) => {
    const text = carry + chunk.toString();
    const lines = text.split(/\r?\n/);
    carry = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) log.emit(level, trimmed, { event });
    }
  });
  stream.on('end', () => {
    const trimmed = carry.trim();
    carry = '';
    if (trimmed) log.emit(level, trimmed, { event });
  });
}

/** sidecar 的 stdout / stderr 进运行日志:区域 `<World>.stdio`,stdout 记 debug、stderr 记 warn。 */
export function logChildStdio(
  child: { stdout?: NodeJS.ReadableStream | null; stderr?: NodeJS.ReadableStream | null },
  log: Logger,
): void {
  const stdio = log.child('stdio');
  logLines(child.stdout, stdio, 'debug', 'stdout');
  logLines(child.stderr, stdio, 'warn', 'stderr');
}
