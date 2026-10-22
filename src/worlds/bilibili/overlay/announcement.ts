import { existsSync, readFileSync } from 'node:fs';
import { writeStateFile } from './state-file.ts';
import type { AgentAnnouncementState } from './types.ts';

const EMPTY_STATE: AgentAnnouncementState = {
  schemaVersion: 1,
  text: '',
  revision: 0,
  updatedAt: null,
};

export class AgentAnnouncementStore {
  private state: AgentAnnouncementState = { ...EMPTY_STATE };

  constructor(private readonly file?: string) {
    this.load();
  }

  get current(): AgentAnnouncementState {
    return { ...this.state };
  }

  set(text: string, maxChars: number): AgentAnnouncementState {
    const normalized = text.replace(/\r\n?/g, '\n');
    const count = Array.from(normalized).length;
    if (count > maxChars) throw new Error(`公告最多 ${maxChars} 字，当前 ${count} 字`);
    const next: AgentAnnouncementState = {
      schemaVersion: 1,
      text: normalized,
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
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<AgentAnnouncementState>;
      if (raw.schemaVersion !== 1 || typeof raw.text !== 'string') return;
      this.state = {
        schemaVersion: 1,
        text: raw.text.replace(/\r\n?/g, '\n'),
        revision: Number.isInteger(raw.revision) && Number(raw.revision) >= 0 ? Number(raw.revision) : 0,
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
      };
    } catch {
      this.state = { ...EMPTY_STATE };
    }
  }
}
