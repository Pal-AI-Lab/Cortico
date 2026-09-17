/** 诊断包:真的写一套 run 记录到临时目录,再看 buildDiagnostics 收了什么、抹了什么。 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDiagnostics, DIAGNOSTICS_LIMITS, type DiagnosticsSources } from '../../src/web/diagnostics.ts';
import { message } from '../../src/protocol/open-responses/context.ts';
import type { EventEnvelope } from '../../src/core/types.ts';

const RUN = 'r-20260917-104402-c2ab';
let root: string;
let dataDir: string;

const jsonl = (file: string, rows: readonly unknown[]): void => {
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
};

const event = (cursor: number, text: string): EventEnvelope => ({
  cursor, run: RUN, type: 'terminal.message', ts: '2026-09-17T10:45:00+08:00',
  source: 'terminal', origin: 'external', text,
});

function sources(over: Partial<DiagnosticsSources> = {}): DiagnosticsSources {
  return {
    dataDir,
    runId: RUN,
    exportedAt: new Date('2026-09-17T14:25:30Z'),
    status: { paused: false },
    session: { messages: [message('system', '前缀'), message('user', '在吗')], head: [message('assistant', '开头')] },
    sessions: [],
    toolSchemas: [{ name: 'terminal_send', description: '发送文本', parameters: { type: 'object' } }],
    events: [event(1, '第一条'), event(2, '第二条')],
    latestCursor: 2,
    worlds: [{ id: 'terminal', status: 'active' }],
    usage: { currency: 'USD', totals: null },
    ...over,
  };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cortico-diag-'));
  dataDir = join(root, 'data');
  const runDir = join(dataDir, 'runs', RUN);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    language: 'zh',
    providers: { grok: { apiKey: 'xai-真钥匙', baseUrl: 'https://api.example.test' } },
    worlds: { bilibili: { rooms: [{ id: 1, accessToken: '别写出去' }] } },
  }), 'utf8');
  writeFileSync(join(runDir, 'run.json'), JSON.stringify({ run: RUN, worlds: ['terminal'] }), 'utf8');
  jsonl(join(dataDir, 'runs', 'index.jsonl'), [
    { run: 'r-old', startedAt: '2026-09-16T10:00:00+08:00' },
    { run: RUN, startedAt: '2026-09-17T10:44:02+08:00' },
    { run: RUN, endedAt: '2026-09-17T12:00:00+08:00', complete: true },
  ]);
  jsonl(join(runDir, 'log.jsonl'), [
    { ts: '2026-09-17T10:45:00+08:00', run: RUN, seq: 1, level: 'info', area: 'core.loop', msg: '第一轮' },
    { ts: '2026-09-17T10:46:00+08:00', run: RUN, seq: 2, level: 'warn', area: 'worlds.terminal', msg: '重连' },
    { ts: '2026-09-17T10:47:00+08:00', run: RUN, seq: 3, level: 'error', area: 'core.loop', msg: '流式卡死' },
  ]);
  jsonl(join(runDir, 'toolcalls.jsonl'), [
    { seq: 1, ts: '2026-09-17T10:45:10+08:00', run: RUN, role: 'main', tool: 'terminal_send', args: {}, durMs: 12, chars: 3, receipt: '已发送' },
  ]);
  jsonl(join(runDir, 'transcript.jsonl'), [
    { kind: 'item', ts: '2026-09-17T10:45:00+08:00', run: RUN, index: 0, item: { type: 'message', role: 'user' }, context: {} },
    { kind: 'boundary', ts: '2026-09-17T11:00:00+08:00', run: RUN, event: 'handoff', data: { kept: 12 } },
  ]);
  jsonl(join(dataDir, 'usage.jsonl'), [
    { ts: '2026-09-16T10:00:00+08:00', run: 'r-old', costUsd: 1 },
    { ts: '2026-09-17T10:45:00+08:00', run: RUN, costUsd: 2 },
  ]);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('诊断包', () => {
  it('收齐这一 run 的落盘记录:指纹、日志、工具调用、交接记号、用量行', () => {
    const b = buildDiagnostics(sources());
    expect(b.kind).toBe('cortico-diagnostics');
    expect(b.exportedAt).toBe('2026-09-17T14:25:30.000Z');
    expect(b.run.id).toBe(RUN);
    // index 的开机行与关机行合成一行
    expect(b.run.index).toMatchObject({ run: RUN, startedAt: '2026-09-17T10:44:02+08:00', complete: true });
    expect(b.run.manifest).toEqual({ run: RUN, worlds: ['terminal'] });
    expect(b.log.warn.map((r) => r.msg)).toEqual(['重连', '流式卡死']);
    expect(b.log.tail.map((r) => r.msg)).toEqual(['第一轮', '重连', '流式卡死']);
    expect(b.toolcalls).toHaveLength(1);
    expect(b.transcriptBoundaries).toEqual([
      { kind: 'boundary', ts: '2026-09-17T11:00:00+08:00', run: RUN, event: 'handoff', data: { kept: 12 } },
    ]);
    expect(b.usage.rows).toEqual([{ ts: '2026-09-17T10:45:00+08:00', run: RUN, costUsd: 2 }]);
    expect(b.truncated).toEqual([]);
  });

  it('活数据原样带走:状态、上下文与合成开头、事件、工具表、World、用量聚合', () => {
    const s = sources();
    const b = buildDiagnostics(s);
    expect(b.status).toEqual(s.status);
    expect(b.session).toEqual(s.session);
    expect(b.events).toEqual({ latestCursor: 2, items: s.events });
    expect(b.toolSchemas).toEqual(s.toolSchemas);
    expect(b.worlds).toEqual(s.worlds);
    expect(b.usage.aggregate).toEqual(s.usage);
  });

  it('配置里像凭据的键抹成 ***,其余照留', () => {
    const config = buildDiagnostics(sources()).config as Record<string, any>;
    expect(config.language).toBe('zh');
    expect(config.providers.grok.apiKey).toBe('***');
    expect(config.providers.grok.baseUrl).toBe('https://api.example.test');
    expect(config.worlds.bilibili.rooms[0].accessToken).toBe('***');
    expect(config.worlds.bilibili.rooms[0].id).toBe(1);
  });

  it('事件取到上限时段名进 truncated', () => {
    const many = Array.from({ length: DIAGNOSTICS_LIMITS.events + 5 }, (_, i) => event(i + 1, `第 ${i} 条`));
    const b = buildDiagnostics(sources({ events: many }));
    expect(b.events.items).toHaveLength(DIAGNOSTICS_LIMITS.events);
    expect(b.events.items[0].text).toBe('第 5 条');
    expect(b.truncated).toContain('events');
  });

  it('没有 run 也没有调试通道时各段为空,不抛', () => {
    const b = buildDiagnostics(sources({ runId: null, session: null, events: [], latestCursor: null, usage: null }));
    expect(b.run).toEqual({ id: null, index: null, manifest: null });
    expect([b.log.warn, b.log.tail, b.toolcalls, b.transcriptBoundaries, b.usage.rows]).toEqual([[], [], [], [], []]);
    expect(b.session).toBeNull();
    // run 之外的东西照样读得到
    expect((b.config as Record<string, unknown>).language).toBe('zh');
  });
});
