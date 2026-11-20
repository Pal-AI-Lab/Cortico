import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionLog } from "./fixture-session.ts";
import { makeTmpDir } from './helpers.ts';
import type { ChatMessage } from './fixture-types.ts';
import { SessionLog as StandardSession } from '../../src/core/session.ts';
import { functionCall, functionResult, message } from '../../src/protocol/open-responses/context.ts';


const sys: ChatMessage = { role: 'system', content: '前缀' };
const asst: ChatMessage = { role: 'assistant', content: '你好', reasoning_content: '想了一下' };
const tool: ChatMessage = { role: 'tool', content: '结果', tool_call_id: 'x1' };

describe('SessionLog', () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  beforeEach(() => (tmp = makeTmpDir()));
  afterEach(() => tmp.cleanup());

  it('append落盘,load重启恢复', () => {
    const s = new SessionLog(tmp.dir);
    s.append(sys);
    s.append(asst);
    s.append(tool);
    const s2 = new SessionLog(tmp.dir);
    s2.load();
    expect(s2.messages).toHaveLength(3);
    expect(s2.messages[1].reasoning_content).toBe('想了一下');
    expect(s2.messages[2].tool_call_id).toBe('x1');
  });

  it('给了 stamp 就在入库时盖 ts,已有 ts 的不覆盖;不给 stamp 就没有 ts', () => {
    const s = new SessionLog(tmp.dir, 'session-main.jsonl', () => '2026-09-03T06:24:42+08:00');
    s.append({ ...sys });
    s.append({ ...asst });
    s.append({ ...tool, ts: '2026-09-03T06:00:00+08:00' });
    expect(s.messages.map((m) => m.ts)).toEqual([
      '2026-09-03T06:24:42+08:00',
      '2026-09-03T06:24:42+08:00',
      '2026-09-03T06:00:00+08:00',
    ]);
    const s2 = new SessionLog(tmp.dir);
    s2.load();
    expect(s2.messages[1].ts).toBe('2026-09-03T06:24:42+08:00');
    s2.append({ ...asst });
    expect(s2.messages[3].ts).toBeUndefined();
  });

  it('损坏行阻止加载，原始文件保持可恢复', () => {
    const s = new SessionLog(tmp.dir);
    s.append(sys);
    appendFileSync(join(tmp.dir, 'session-main.jsonl'), 'oops not json\n', 'utf8');
    s.append(asst);
    const s2 = new SessionLog(tmp.dir);
    const original = readFileSync(join(tmp.dir, 'session-main.jsonl'), 'utf8');
    expect(() => s2.load()).toThrow('Invalid session JSON');
    expect(readFileSync(join(tmp.dir, 'session-main.jsonl'), 'utf8')).toBe(original);
  });

  it('追加中途断掉的末行:启动时截掉并报告,完整的行原样恢复', () => {
    const s = new SessionLog(tmp.dir);
    s.append(sys);
    s.append(asst);
    const file = join(tmp.dir, 'session-main.jsonl');
    const intact = readFileSync(file, 'utf8');
    appendFileSync(file, '{"version":2,"item":{"type":"message","role":"user","con', 'utf8');
    const s2 = new SessionLog(tmp.dir);
    expect(s2.load()).toMatchObject({ kind: 'torn-tail' });
    expect(s2.messages).toHaveLength(2);
    expect(readFileSync(file, 'utf8')).toBe(intact);
  });

  it('reset整体替换+原子重写,重启读到的是新内容', () => {
    const s = new SessionLog(tmp.dir);
    s.append(sys);
    s.append(asst);
    s.reset([{ role: 'system', content: '新前缀' }, tool]);
    expect(s.messages).toHaveLength(2);
    const raw = readFileSync(join(tmp.dir, 'session-main.jsonl'), 'utf8').trim().split('\n');
    expect(raw).toHaveLength(2);
    expect(JSON.parse(raw[0]).item.content[0].text).toBe('新前缀');
    s.append(asst);
    const s2 = new SessionLog(tmp.dir);
    s2.load();
    expect(s2.messages).toHaveLength(3);
    expect(s2.messages[0].content).toBe('新前缀');
  });

  it('estTokens>0', () => {
    const s = new SessionLog(tmp.dir);
    s.append(asst);
    expect(s.estTokens()).toBeGreaterThan(0);
  });

  it('replaces only leading system records, preserving the raw tail, identity and concurrent appends', async () => {
    const s = new StandardSession(tmp.dir);
    const file = join(tmp.dir, 'session-main.jsonl');
    const call = functionCall('c1', 'lookup', '{}');
    const originalTail = '  ' + JSON.stringify(call) + '\r\n';
    writeFileSync(file, [' ', JSON.stringify(message('system', '旧'.repeat(360000))), '',
      JSON.stringify(message('system', '二')), originalTail].join('\r\n'));
    s.load();
    const oldCall = s.records[2];
    const replacement = message('system', 'new');
    const fresh = functionResult('c1', 'done');
    const update = s.replaceSystemPrefix(replacement);
    s.append(fresh);
    expect(await update).toBe(2);
    expect(s.records[1]).toBe(oldCall);
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify(replacement) + '\n' + originalTail + JSON.stringify(fresh) + '\n');
    const reopened = new StandardSession(tmp.dir);
    reopened.load();
    expect(reopened.records).toEqual(s.records);
    expect(readdirSync(tmp.dir)).toEqual(['session-main.jsonl']);
  });

  it('updates tools for an unchanged prefix while retaining its file, identity and ingestion time', async () => {
    const s = new StandardSession(tmp.dir, 'session-main.jsonl', () => 'old-stamp');
    const file = join(tmp.dir, 'session-main.jsonl');
    s.append(message('system', 'same'));
    s.append(message('user', 'tail'));
    const records = s.records;
    const inode = statSync(file, { bigint: true }).ino;
    let schema = 'old';
    let observed: unknown;
    s.onReset((rows, prefix) => { observed = { count: rows.length, prefix, schema }; });
    await s.replaceSystemPrefix(message('system', 'same'), () => true, () => { schema = 'new'; });
    expect(s.records).toBe(records);
    expect(statSync(file, { bigint: true }).ino).toBe(inode);
    expect(observed).toEqual({ count: 2, prefix: { entry: records[0], removed: 1, previousLength: 2 }, schema: 'new' });
  });

  it('retains an append arriving after a copy has already written part of its snapshot', async () => {
    const s = new StandardSession(tmp.dir);
    s.append(message('system', 'before'));
    s.append(message('user', 'x'.repeat(2 * 1024 * 1024)));
    const receipt = functionResult('c1', 'arrived while copying');
    let appended = false;
    const kept = await s.replaceSystemPrefix(message('system', 'after'), () => {
      const temp = readdirSync(tmp.dir).find(name => name.endsWith('.tmp'));
      if (!appended && temp && statSync(join(tmp.dir, temp)).size > 1024 * 1024) {
        appended = true;
        s.append(receipt);
      }
      return true;
    });
    expect(appended).toBe(true);
    expect(kept).toBe(2);
    const reopened = new StandardSession(tmp.dir);
    reopened.load();
    expect(reopened.records).toEqual(s.records);
    expect(reopened.records.at(-1)).toEqual(receipt);
  });

  it('abandons stale copies after a full reset or lifecycle cancellation', async () => {
    const s = new StandardSession(tmp.dir);
    s.append(message('user', 'before'));
    const newer = message('user', 'after');
    const stale = s.replaceSystemPrefix(message('system', 'stale'));
    s.reset([newer]);
    expect(await stale).toBeNull();
    let active = true;
    const cancelled = s.replaceSystemPrefix(message('system', 'cancelled'), () => active);
    active = false;
    expect(await cancelled).toBeNull();
    const reopened = new StandardSession(tmp.dir);
    reopened.load();
    expect(reopened.records).toEqual([newer]);
    expect(readdirSync(tmp.dir)).toEqual(['session-main.jsonl']);
  });

  it('keeps the previous generation and listeners intact on I/O failure and accepts a subsequent retry', async () => {
    const s = new StandardSession(tmp.dir);
    s.append(message('system', 'old'));
    s.append(message('user', 'tail'));
    const file = join(tmp.dir, 'session-main.jsonl');
    const bytes = readFileSync(file);
    const original = s.records;
    const prefix = message('system', 'new');
    let installed = 0;
    let notifications = 0;
    s.onReset(() => notifications++);
    writeFileSync(file, '');
    await expect(s.replaceSystemPrefix(prefix, () => true, () => installed++)).rejects.toThrow('size changed');
    expect(s.records).toBe(original);
    expect([installed, notifications]).toEqual([0, 0]);
    writeFileSync(file, bytes);
    expect(await s.replaceSystemPrefix(prefix, () => true, () => installed++)).toBe(1);
    expect([installed, notifications]).toEqual([1, 1]);
    expect(s.records[0]).toEqual(prefix);
  });

  it('追加结果保留原始调用与回执，生命周期重置只保留新上下文', () => {
    const s = new SessionLog(tmp.dir);
    const intent: ChatMessage = {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'vtuber_act', arguments: '{"script":"完整台词"}' } }],
    };
    const receipt: ChatMessage = { role: 'tool', content: '已排入', tool_call_id: 'c1' };
    s.append(intent);
    s.append(receipt);
    s.append({ role: 'tool', tool_call_id: 'event1', content: 'call_id=c1 本地只播放了：完整' });
    const restored = new SessionLog(tmp.dir);
    restored.load();
    expect(restored.messages.slice(0, 2)).toEqual([intent, receipt]);
    restored.reset([sys]);
    expect(restored.messages).toEqual([sys]);
  });

});
