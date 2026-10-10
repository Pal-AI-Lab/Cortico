/**
 * 模型工具调用写入 data/runs/<run>/toolcalls.jsonl，每次调用一行。
 * args 保留模型原始参数；receipt 保存摘要，chars 记录全文长度。
 * 完整回执可通过 call 在 transcript.jsonl 中查找。
 */
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { currentAnchors } from './log-context.ts';
import { nowIso, SYSTEM_TIMEZONE } from './util.ts';

/** 回执正文进流水的上限;全长另记在 chars,全文在 transcript 里 */
const RECEIPT_CHARS = 600;

export interface ToolCallInput {
  /** 发起调用的 session 声明 id */
  role: string;
  tool: string;
  /** 工具所属 World id；Persona 工具不填。 */
  mod?: string;
  /** 模型原始参数，未经 World 归一化。 */
  args: Record<string, unknown> | null;
  durMs: number;
  /** 回执全长(字符);receipt 只留前 RECEIPT_CHARS 个 */
  chars: number;
  receipt: string;
  /** handler 抛错或 ToolOutcome.failed 标记的失败。 */
  failed?: true;
  /** 回执带的媒体件数 */
  blobs?: number;
}

export interface ToolCallEntry extends ToolCallInput {
  seq: number;
  ts: string;
  run: string;
  round?: number;
  resp?: string;
  /** session 里的 tool_call id,与 transcript 的 function_call / function_call_output 对上 */
  call?: string;
}

export interface ToolCallLogOptions {
  timezone?: string;
  run?: string;
}

/** JSONL 追加;不给文件名就只计数(测试与未配目录的部署) */
export class ToolCallLog {
  private seq = 0;
  private dirReady = false;
  private readonly timezone: string;
  private readonly run: string;

  constructor(private readonly file: string | null, opts: ToolCallLogOptions = {}) {
    this.timezone = opts.timezone ?? SYSTEM_TIMEZONE;
    this.run = opts.run ?? 'r-none';
  }

  write(input: ToolCallInput): ToolCallEntry {
    const anchors = currentAnchors();
    const entry: ToolCallEntry = {
      seq: ++this.seq,
      ts: nowIso(this.timezone),
      run: this.run,
      ...(anchors.round !== undefined ? { round: anchors.round } : {}),
      ...(anchors.resp !== undefined ? { resp: anchors.resp } : {}),
      ...(anchors.call !== undefined ? { call: anchors.call } : {}),
      ...input,
      receipt: input.receipt.slice(0, RECEIPT_CHARS),
    };
    this.append(entry);
    return entry;
  }

  /** 控制台存储清单的规模描述 */
  stat(): string {
    const size = this.bytes();
    return `${this.seq}条 / ${size === null ? '(无文件)' : `${(size / 1024).toFixed(1)}KB`}`;
  }

  clear(): void {
    if (!this.file || !existsSync(this.file)) return;
    try {
      writeFileSync(this.file, '', 'utf8');
    } catch {
      // 清空失败不致命
    }
  }

  private bytes(): number | null {
    if (!this.file || !existsSync(this.file)) return null;
    try {
      return statSync(this.file).size;
    } catch {
      return null;
    }
  }

  private append(entry: ToolCallEntry): void {
    if (!this.file) return;
    try {
      if (!this.dirReady) {
        mkdirSync(dirname(this.file), { recursive: true });
        this.dirReady = true;
      }
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      // 日志写不进去不影响运行
    }
  }
}

/** 一次调用的落盘记录(执行方在 handler 前后各取一次时刻) */
export function recordToolCall(
  log: ToolCallLog | undefined,
  role: string,
  tool: string,
  args: Record<string, unknown> | null,
  startedAt: number,
  out: { text: string; blobs?: unknown[]; failed?: true },
  mod?: string,
): void {
  if (!log) return;
  log.write({
    role,
    tool,
    ...(mod ? { mod } : {}),
    args,
    durMs: Date.now() - startedAt,
    chars: out.text.length,
    receipt: out.text,
    ...(out.failed ? { failed: true as const } : {}),
    ...(out.blobs?.length ? { blobs: out.blobs.length } : {}),
  });
}
