/**
 * 主 session 的追加记录，保存在 data/runs/<run>/transcript.jsonl。
 * session-main.jsonl 会在上下文替换时重写；本文件保留每次追加的正文，
 * 并在交接、清空和前缀重载时写入边界记录。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ContextRecord } from '../protocol/open-responses/context.ts';
import { currentAnchors } from './log-context.ts';
import { nowIso, SYSTEM_TIMEZONE } from './util.ts';

export type TranscriptBoundary = 'handoff' | 'clear' | 'prefix-reload' | 'ephemeral-drop';

export interface TranscriptItemRecord {
  kind: 'item';
  ts: string;
  run: string;
  sess?: string;
  round?: number;
  /** session 里的下标(append 时刻) */
  index: number;
  item: ContextRecord['item'];
  context: ContextRecord['context'];
}

export interface TranscriptBoundaryRecord {
  kind: 'boundary';
  ts: string;
  run: string;
  sess?: string;
  round?: number;
  event: TranscriptBoundary;
  data: Record<string, unknown>;
}

export type TranscriptRecord = TranscriptItemRecord | TranscriptBoundaryRecord;

export interface TranscriptOptions {
  run?: string;
  timezone?: string;
}

export class Transcript {
  private readonly run: string;
  private readonly timezone: string;
  private dirReady = false;

  constructor(private readonly file: string | null, opts: TranscriptOptions = {}) {
    this.run = opts.run ?? 'r-none';
    this.timezone = opts.timezone ?? SYSTEM_TIMEZONE;
  }

  item(record: ContextRecord, index: number): void {
    const anchors = currentAnchors();
    this.append({
      kind: 'item',
      ts: record.context.ts ?? nowIso(this.timezone),
      run: this.run,
      ...(anchors.sess !== undefined ? { sess: anchors.sess } : {}),
      ...(anchors.round !== undefined ? { round: anchors.round } : {}),
      index,
      item: record.item,
      context: record.context,
    });
  }

  boundary(event: TranscriptBoundary, data: Record<string, unknown>): void {
    const anchors = currentAnchors();
    this.append({
      kind: 'boundary',
      ts: nowIso(this.timezone),
      run: this.run,
      ...(anchors.sess !== undefined ? { sess: anchors.sess } : {}),
      ...(anchors.round !== undefined ? { round: anchors.round } : {}),
      event,
      data,
    });
  }

  private append(record: TranscriptRecord): void {
    if (!this.file) return;
    try {
      if (!this.dirReady) {
        mkdirSync(dirname(this.file), { recursive: true });
        this.dirReady = true;
      }
      appendFileSync(this.file, `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      // 写不进去不影响运行
    }
  }
}
