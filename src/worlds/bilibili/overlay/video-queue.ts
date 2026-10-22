import { existsSync, readFileSync } from 'node:fs';
import { writeStateFile } from './state-file.ts';
import type { VideoQueueItem, VideoQueueState } from './types.ts';

/** BV 号是 `BV1` 加 9 位 base58 字符。 */
const BVID_RE = /(?<![0-9A-Za-z])[Bb][Vv]1[1-9A-HJ-NP-Za-km-z]{9}(?![0-9A-Za-z])/;
const STORED_BVID_RE = /^BV1[1-9A-HJ-NP-Za-km-z]{9}$/;
export const VIDEO_QUEUE_NOTE_MAX_CHARS = 60;

const EMPTY_STATE: VideoQueueState = {
  schemaVersion: 1,
  items: [],
  revision: 0,
  updatedAt: null,
};

/** 字符串里的第一个 BV 号，前缀写成大写 `BV`;视频链接也能取出。没有时返回 null。 */
export function parseBvid(value: string): string | null {
  const match = BVID_RE.exec(value);
  return match ? `BV${match[0].slice(2)}` : null;
}

/** 位置一律从 1 数起。修改失败抛出的错误信息直接回给 Bot,队列保持原样。 */
export class VideoQueueStore {
  private state: VideoQueueState = structuredClone(EMPTY_STATE);

  constructor(private readonly file?: string) {
    this.load();
  }

  get current(): VideoQueueState {
    return structuredClone(this.state);
  }

  /** `position` 超出末尾时排到最后。 */
  add(bvid: string, note: string, position: number | undefined, maxItems: number): VideoQueueState {
    const count = Array.from(note).length;
    if (count > VIDEO_QUEUE_NOTE_MAX_CHARS) {
      throw new Error(`note 最多 ${VIDEO_QUEUE_NOTE_MAX_CHARS} 字，当前 ${count} 字`);
    }
    if (this.state.items.length >= maxItems) {
      throw new Error(`队列已满(${this.state.items.length}/${maxItems})`);
    }
    const items = [...this.state.items];
    const index = position === undefined ? items.length : Math.min(items.length, position - 1);
    items.splice(index, 0, { bvid, note, addedAt: new Date().toISOString() });
    return this.commit(items);
  }

  /** 同一 BV 号排了多次时移除第一个。 */
  remove(bvid: string): VideoQueueState {
    const items = [...this.state.items];
    items.splice(this.indexOf(bvid), 1);
    return this.commit(items);
  }

  /** `position` 超出末尾时移到最后。 */
  move(bvid: string, position: number): VideoQueueState {
    const items = [...this.state.items];
    const [item] = items.splice(this.indexOf(bvid), 1);
    items.splice(Math.min(items.length, position - 1), 0, item);
    return this.commit(items);
  }

  clear(): VideoQueueState {
    return this.commit([]);
  }

  private indexOf(bvid: string): number {
    const index = this.state.items.findIndex((item) => item.bvid === bvid);
    if (index < 0) throw new Error(`队列里没有 ${bvid}`);
    return index;
  }

  private commit(items: VideoQueueItem[]): VideoQueueState {
    const next: VideoQueueState = {
      schemaVersion: 1,
      items,
      revision: this.state.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    if (this.file) writeStateFile(this.file, next);
    this.state = next;
    return this.current;
  }

  private load(): void {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<VideoQueueState>;
      if (raw.schemaVersion !== 1 || !Array.isArray(raw.items)) return;
      this.state = {
        schemaVersion: 1,
        items: raw.items
          .filter((item): item is VideoQueueItem => typeof item?.bvid === 'string' && STORED_BVID_RE.test(item.bvid))
          .map((item) => ({
            bvid: item.bvid,
            note: typeof item.note === 'string' ? item.note : '',
            addedAt: typeof item.addedAt === 'string' ? item.addedAt : '',
          })),
        revision: Number.isInteger(raw.revision) && Number(raw.revision) >= 0 ? Number(raw.revision) : 0,
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
      };
    } catch {
      this.state = structuredClone(EMPTY_STATE);
    }
  }
}
