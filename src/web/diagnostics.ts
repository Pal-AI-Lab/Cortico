/**
 * 诊断包:一次导出把排查一场跑要看的记录收进一个 JSON —— 运行指纹、状态快照、常驻 session
 * 的上下文、事件、运行日志、工具调用、交接边界、用量与脱敏配置。
 *
 * 每段各有条数上限,取到上限的段名列在 `truncated` 里;配置里键名含 secret / token / key /
 * password 的值在写出前抹掉。缺席的接缝(未挂载调试通道、未挂载用量)那一段为空。
 */

import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { ContextRecord } from '../protocol/open-responses/context.ts';
import type { EventEnvelope, LogRecord } from '../core/types.ts';
import type { SessionStats } from '../core/sessions.ts';
import { redactSecrets } from '../core/util.ts';
import { logPredicate, readRunsIndex, readTailRecordsWhere, type RunIndexRow } from './files.ts';

/**
 * 每段取最近多少条,与 `/api/log` 的缺省条数一致。事件段非它不可:`store.range` 不给 limit
 * 会把事件库整份读出来。取到这个数的段名进 `truncated`,拿到包的人据此知道还有更早的记录。
 */
export const DIAGNOSTICS_TAIL = 200;

export interface DiagnosticsToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** 活数据由 WebApp 现取交进来;落盘记录由本模块按 `dataDir` 与 `runId` 自己读。 */
export interface DiagnosticsSources {
  dataDir: string;
  runId: string | null;
  exportedAt: Date;
  status: Record<string, unknown>;
  /** 常驻 session 的上下文与合成开头;没挂调试通道时为 null。 */
  session: { messages: readonly ContextRecord[]; head: readonly ContextRecord[] } | null;
  sessions: readonly SessionStats[];
  toolSchemas: readonly DiagnosticsToolSchema[];
  events: readonly EventEnvelope[];
  latestCursor: number | null;
  worlds: readonly unknown[];
  /** `/api/usage` 那份聚合;没挂用量时为 null。 */
  usage: unknown;
}

export interface DiagnosticsBundle {
  kind: 'cortico-diagnostics';
  version: 1;
  exportedAt: string;
  run: { id: string | null; index: RunIndexRow | null; manifest: unknown };
  status: Record<string, unknown>;
  worlds: readonly unknown[];
  session: { messages: readonly ContextRecord[]; head: readonly ContextRecord[] } | null;
  sessions: readonly SessionStats[];
  toolSchemas: readonly DiagnosticsToolSchema[];
  events: { latestCursor: number | null; items: readonly EventEnvelope[] };
  /** `warn` 是 warn 及以上,`tail` 不论级别取最近几条。 */
  log: { warn: LogRecord[]; tail: LogRecord[] };
  toolcalls: unknown[];
  /** transcript 里的 handoff / clear / prefix-reload 记号。 */
  transcriptBoundaries: unknown[];
  usage: { aggregate: unknown; rows: unknown[] };
  config: unknown;
  truncated: string[];
}

function readJson(file: string): unknown {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as unknown) : null;
}

export function buildDiagnostics(sources: DiagnosticsSources): DiagnosticsBundle {
  const { dataDir, runId } = sources;
  const runDir = runId ? join(dataDir, 'runs', runId) : null;
  const warn = runDir
    ? readTailRecordsWhere<LogRecord>(join(runDir, 'log.jsonl'), DIAGNOSTICS_TAIL, logPredicate({ level: 'warn' }))
    : [];
  const tail = runDir
    ? readTailRecordsWhere<LogRecord>(join(runDir, 'log.jsonl'), DIAGNOSTICS_TAIL, () => true)
    : [];
  const toolcalls = runDir
    ? readTailRecordsWhere<unknown>(join(runDir, 'toolcalls.jsonl'), DIAGNOSTICS_TAIL, () => true)
    : [];
  const boundaries = runDir
    ? readTailRecordsWhere<{ kind?: string }>(
      join(runDir, 'transcript.jsonl'),
      DIAGNOSTICS_TAIL,
      (r) => r?.kind === 'boundary',
    )
    : [];
  const usageRows = runId
    ? readTailRecordsWhere<{ run?: string }>(
      join(dataDir, 'usage.jsonl'),
      DIAGNOSTICS_TAIL,
      (r) => r?.run === runId,
    )
    : [];
  const events = sources.events.slice(-DIAGNOSTICS_TAIL);

  const truncated: string[] = [];
  for (const [name, rows] of [
    ['events', events],
    ['log.warn', warn],
    ['log.tail', tail],
    ['toolcalls', toolcalls],
    ['transcriptBoundaries', boundaries],
    ['usage.rows', usageRows],
  ] as const) {
    if (rows.length >= DIAGNOSTICS_TAIL) truncated.push(name);
  }

  const index = runId
    ? readRunsIndex(join(dataDir, 'runs', 'index.jsonl')).find((row) => row.run === runId) ?? null
    : null;

  return {
    kind: 'cortico-diagnostics',
    version: 1,
    exportedAt: sources.exportedAt.toISOString(),
    run: { id: runId, index, manifest: runDir ? readJson(join(runDir, 'run.json')) : null },
    status: sources.status,
    worlds: sources.worlds,
    session: sources.session,
    sessions: sources.sessions,
    toolSchemas: sources.toolSchemas,
    events: { latestCursor: sources.latestCursor, items: events },
    log: { warn, tail },
    toolcalls,
    transcriptBoundaries: boundaries,
    usage: { aggregate: sources.usage, rows: usageRows },
    config: redactSecrets(readJson(join(dirname(dataDir), 'config.json'))),
    truncated,
  };
}
