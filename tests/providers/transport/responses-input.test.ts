/**
 * Responses 无状态重放的思维链形态。加密形态的规则由 tests/core/session-head.test.ts 覆盖;
 * 这里是明文形态:推理项以 reasoning_text 出线,当前轮不受 keepThinking 约束,本地合成的调用前补一项。
 */
import { describe, expect, it } from 'vitest';
import { REASONING_REPLAYS, SYNTHETIC_REASONING_TEXT, responsesInput } from '../../../src/providers/transport/responses-input.ts';
import { functionCall, functionResult, message, record } from '../../../src/protocol/open-responses/context.ts';
import type { ContextRecord } from '../../../src/protocol/open-responses/context.ts';

type Item = Record<string, unknown>;

const origin = { instance: 'i', module: 'openai-responses-compat', model: 'm', compatibilityDomain: 'd' };
const request = { model: 'm', input: [] as never[] };

const reasoning = (id: string, text: string, meta: Record<string, unknown> = {}, encrypted?: string): ContextRecord =>
  record({
    type: 'reasoning', id, summary: [], status: 'completed',
    content: text ? [{ type: 'reasoning_text', text }] : [],
    ...(encrypted ? { encrypted_content: encrypted } : {}),
  } as never, meta as never);

const replay = (context: ContextRecord[], keep = true, form: (typeof REASONING_REPLAYS)[number] = 'plaintext') =>
  responsesInput(request, { context, origin }, { keepThinking: () => keep, reasoningReplay: form }).input;

const reasoningItems = (input: Item[]) => input.filter((item) => item.type === 'reasoning');

describe('responsesInput 明文形态', () => {
  it('推理项以 reasoning_text 出线,不看 origin;签名块照带;没有文字也没有签名的不出线', () => {
    const context = [
      message('user', 'hi'),
      reasoning('own', '想了想', { origin }),
      reasoning('foreign', '别家的', { origin: { ...origin, model: 'other' } }),
      reasoning('signed', '带签名', { origin }, 'sig'),
      reasoning('empty', ''),
    ];
    const items = reasoningItems(replay(context));
    expect(items.map((item) => item.id)).toEqual(['own', 'foreign', 'signed']);
    expect(items[0].content).toEqual([{ type: 'reasoning_text', text: '想了想' }]);
    expect(items[2]).toMatchObject({ encrypted_content: 'sig', content: [{ type: 'reasoning_text', text: '带签名' }] });
  });

  it('keepThinking 关:最后一条 user 消息之后的推理照回,之前的不回,开头豁免', () => {
    const context = [
      reasoning('head', '开场', { head: true }),
      message('user', '第一问'),
      reasoning('past', '上一轮'),
      message('assistant', '上一答'),
      message('user', '第二问'),
      reasoning('current', '这一轮'),
      functionCall('c1', 'tool', '{}', { origin }),
      functionResult('c1', 'done'),
    ];
    expect(reasoningItems(replay(context, false)).map((item) => item.id)).toEqual(['head', 'current']);
    expect(reasoningItems(replay(context, true)).map((item) => item.id)).toEqual(['head', 'past', 'current']);
  });

  it('没有 origin 的调用前补一项合成推理;模型自己的调用和已有推理在前的调用不补', () => {
    const context = [
      message('user', 'hi'),
      reasoning('r1', '想', { origin }),
      functionCall('own', 'tool', '{}', { origin }),
      functionResult('own', 'ok'),
      functionCall('evf_7', 'external_event_frame', '{}'),
      functionResult('evf_7', '[1 new event] x'),
      reasoning('pinned', '钉住的'),
      functionCall('head_call', 'tool', '{}'),
      functionResult('head_call', 'ok'),
    ];
    const input = replay(context);
    const types = input.map((item) => `${item.type}:${item.id ?? item.call_id}`);
    expect(types).toEqual([
      'message:' + input[0].id,
      'reasoning:r1',
      'function_call:' + input[2].id,
      'function_call_output:' + input[3].id,
      'reasoning:rs_evf_7',
      'function_call:' + input[5].id,
      'function_call_output:' + input[6].id,
      'reasoning:pinned',
      'function_call:' + input[8].id,
      'function_call_output:' + input[9].id,
    ]);
    expect(input[4]).toEqual({ type: 'reasoning', id: 'rs_evf_7', summary: [], content: [{ type: 'reasoning_text', text: SYNTHETIC_REASONING_TEXT }] });
  });

  it('加密形态(默认)不补合成推理,明文推理项不出线', () => {
    const context = [message('user', 'hi'), reasoning('r1', '想', { origin }), functionCall('evf_1', 'external_event_frame', '{}'), functionResult('evf_1', 'x')];
    for (const form of [undefined, 'encrypted'] as const) {
      const input = responsesInput(request, { context, origin }, { keepThinking: () => true, ...(form ? { reasoningReplay: form } : {}) }).input;
      expect(input.map((item) => item.type)).toEqual(['message', 'function_call', 'function_call_output']);
    }
  });
});
