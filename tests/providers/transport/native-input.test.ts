/**
 * 原生出线的历史调用参数:不是合法 JSON 的 arguments 在 Responses 与 Chat Completions 出线时换成
 * 合法 JSON 的记号，回执和 session 记录不变，合法的参数逐字不变。
 */
import { expect, it } from 'vitest';
import { functionCall, functionResult, inputItem } from '../../../src/protocol/open-responses/context.ts';
import {
  FOLD_ARGS_PLACEHOLDER, NOT_EXECUTED_INCOMPLETE, NOT_EXECUTED_STREAM_ABORTED, REPLAY_ARGS_FOLDED, REPLAY_ARGS_INVALID,
} from '../../../src/core/markers.ts';
import { nativeChatInput, requestContext } from '../../../src/providers/transport/native-input.ts';
import { responsesInput } from '../../../src/providers/transport/responses-input.ts';

it.each([NOT_EXECUTED_STREAM_ABORTED, NOT_EXECUTED_INCOMPLETE])('replays a malformed historical call paired with %s', marker => {
  const entries = [functionCall('partial', 'inspect', '{}{}{}'), functionCall('ran', 'inspect', '{"slot":2}'),
    functionResult('ran', 'real receipt'), functionResult('partial', marker)];
  const historical = JSON.stringify(entries);
  const request = { model: 'test', input: entries.map(inputItem) };
  const native = responsesInput(request, {}).input;
  expect(native.filter(item => item.type === 'function_call').map(item => [item.call_id, item.arguments]))
    .toEqual([['partial', REPLAY_ARGS_INVALID], ['ran', '{"slot":2}']]);
  expect(native.filter(item => item.type === 'function_call_output').map(item => [item.call_id, item.output]))
    .toEqual([['ran', 'real receipt'], ['partial', marker]]);
  const chat = nativeChatInput(request, { context: entries });
  expect(chat[0].tool_calls![0].function.arguments).toBe(REPLAY_ARGS_INVALID);
  expect(chat.filter(row => row.role === 'tool').map(row => row.tool_call_id)).toEqual(['ran', 'partial']);
  expect(JSON.stringify(entries)).toBe(historical);
});

it('tells folded arguments apart from other invalid ones and adds no output', () => {
  const context = [functionCall('folded', 'read', FOLD_ARGS_PLACEHOLDER), functionResult('folded', 'ran'), functionCall('orphan', 'read', '{')];
  const input = responsesInput({ model: 'test', input: context.map(inputItem) }, {}).input;
  expect(input.map(item => item.arguments ?? item.output)).toEqual([REPLAY_ARGS_FOLDED, 'ran', REPLAY_ARGS_INVALID]);
});

it('returns the same context when every argument is valid JSON', () => {
  const context = [functionCall('good', 'read', '{  }'), functionResult('good', NOT_EXECUTED_STREAM_ABORTED)];
  expect(requestContext({ model: 'test' }, { context })).toBe(context);
});
