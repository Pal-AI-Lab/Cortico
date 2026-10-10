/**
 * 一次进程运行对应一个 run，运行日志保存在 data/runs/<run>/。
 * index.jsonl 在启动与正常关机时各追加一行；暂停沿用 run，重启创建新 run。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { nowIso } from './util.ts';

export interface RunInfo {
  id: string;
  dir: string;
  runsDir: string;
  startedAt: string;
  previousRun: string | null;
}

export interface RunOpenMeta {
  timezone: string;
  bot: string;
  repoRoot?: string;
}

export interface RunCloseSummary {
  endedAt: string;
  lastCursor: number;
  /** 关机步骤是否全部完成。 */
  complete: boolean | null;
  reason: string;
}

const RUN_ID = /^r-\d{8}-\d{6}-[0-9a-f]{4}$/;

export function runsDirOf(dataDir: string): string {
  return join(dataDir, 'runs');
}

/**
 * 已存在的 run id,按字典序。id 里是写入时区的墙钟时间,换过时区或跨夏令时后
 * 字典序不等于时间序;要时间序看 index.jsonl 的行序或事件游标。
 */
export function listRuns(dataDir: string): string[] {
  const dir = runsDirOf(dataDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => RUN_ID.test(name)).sort();
}

function gitSha(repoRoot: string | undefined): string | null {
  if (!repoRoot) return null;
  try {
    const head = readFileSync(join(repoRoot, '.git', 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) return head.slice(0, 12);
    const ref = head.slice(4).trim();
    const refFile = resolve(repoRoot, '.git', ref);
    if (existsSync(refFile)) return readFileSync(refFile, 'utf8').trim().slice(0, 12);
    const packed = join(repoRoot, '.git', 'packed-refs');
    if (!existsSync(packed)) return null;
    for (const line of readFileSync(packed, 'utf8').split('\n')) {
      const [sha, name] = line.trim().split(' ');
      if (name === ref) return sha.slice(0, 12);
    }
  } catch {
    // 不在 git 仓库里就不记
  }
  return null;
}

/** index.jsonl 按开机、关机的先后追加,最后一行属于最近一次 run。 */
function lastIndexedRun(runsDir: string): string | null {
  const file = join(runsDir, 'index.jsonl');
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    try {
      const row = JSON.parse(lines[i]) as { run?: unknown };
      if (typeof row.run === 'string') return row.run;
    } catch {
      // 进程在追加中途结束会留下半行
    }
  }
  return null;
}

/** 生成 run id、建目录、在 index.jsonl 记一行开机。 */
export function openRun(dataDir: string, meta: RunOpenMeta): RunInfo {
  const runsDir = runsDirOf(dataDir);
  mkdirSync(runsDir, { recursive: true });
  const previousRun = lastIndexedRun(runsDir) ?? listRuns(dataDir).at(-1) ?? null;
  const startedAt = nowIso(meta.timezone);
  const stamp = startedAt.slice(0, 19).replace(/[-:T]/g, '');
  const id = `r-${stamp.slice(0, 8)}-${stamp.slice(8, 14)}-${randomBytes(2).toString('hex')}`;
  const dir = join(runsDir, id);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(runsDir, 'index.jsonl'), JSON.stringify({
    run: id,
    startedAt,
    bot: meta.bot,
    pid: process.pid,
    gitSha: gitSha(meta.repoRoot),
    previousRun,
  }) + '\n', 'utf8');
  return { id, dir, runsDir, startedAt, previousRun };
}

/** 追加关机记录；进程异常结束时可能没有该行，查询方需从已有记录推算结束时间。 */
export function closeRun(run: RunInfo, summary: RunCloseSummary): void {
  appendFileSync(join(run.runsDir, 'index.jsonl'), JSON.stringify({ run: run.id, ...summary }) + '\n', 'utf8');
}

/** run.json 保存本次运行的 World 清单与配置指纹。 */
export function writeRunJson(run: RunInfo, data: Record<string, unknown>): void {
  writeFileSync(join(run.dir, 'run.json'), JSON.stringify({ run: run.id, startedAt: run.startedAt, previousRun: run.previousRun, ...data }, null, 2), 'utf8');
}
