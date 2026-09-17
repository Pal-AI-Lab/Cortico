import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionLog } from "./fixture-session.ts";
import { makeTmpDir } from './helpers.ts';
import type { ChatMessage } from './fixture-types.ts';


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
