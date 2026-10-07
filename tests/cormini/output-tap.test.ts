/**
 * 主 session 输出旁路的扇入:World 可以在某一刻不给接收器,扇入按真值过滤。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cormini } from '../../bots/cormini/persona/persona.ts';
import type { OutputTap, World } from '../../src/core/types.ts';
import type { StreamEvent } from '../../src/protocol/open-responses/index.ts';

const dir = mkdtempSync(join(tmpdir(), 'cormini-output-tap-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const delta = (text: string): StreamEvent => ({
  type: 'response.output_text.delta', sequence_number: 0, output_index: 0, item_id: 'item', content_index: 0, delta: text,
});

function world(id: string, tap: () => OutputTap | undefined): World {
  return {
    id,
    envPromptVars: () => null,
    tools: () => [],
    outputTap: tap,
    start: async () => {},
    stop: async () => {},
  };
}

describe('outputTap 扇入', () => {
  it('一个 World 这一刻不给接收器,另一个 World 的接收器照常收到增量', () => {
    const seen: string[] = [];
    const persona = new Cormini({
      memoryDir: dir,
      worlds: [
        world('a', () => undefined),
        world('b', () => ({ onEvent: (e) => { if (e.type === 'response.output_text.delta') seen.push(e.delta); } })),
      ],
    });

    persona.declareSessions()[0].outputTap?.onEvent(delta('甲'));

    expect(seen).toEqual(['甲']);
  });

  it('扇入多个接收器时，没声明 externalizes 的接收器按单接收器时的默认规则判定', () => {
    const persona = new Cormini({
      memoryDir: dir,
      worlds: [world('a', () => ({ onEvent: () => {} })), world('b', () => ({ onEvent: () => {} }))],
    });

    expect(persona.declareSessions()[0].outputTap?.externalizes?.(delta('甲'))).toBe(true);
  });

  it('没有任何 World 给接收器时不声明 tap', () => {
    const persona = new Cormini({
      memoryDir: dir,
      worlds: [world('a', () => undefined)],
    });

    expect(persona.declareSessions()[0].outputTap).toBeUndefined();
  });
});
