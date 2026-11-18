import { expect, it } from 'vitest';
import { functionCall, functionResult, inputItem } from '../../../src/protocol/open-responses/context.ts';
import { FOLD_ARGS_PLACEHOLDER, FOLD_PLACEHOLDER, NOT_EXECUTED_INCOMPLETE, NOT_EXECUTED_STREAM_ABORTED, TOOL_FAILED_BAD_ARGS } from '../../../src/core/markers.ts';
import { nativeChatInput, requestContext } from '../../../src/providers/transport/native-input.ts';
import { responsesInput } from '../../../src/providers/transport/responses-input.ts';

it.each([NOT_EXECUTED_STREAM_ABORTED, NOT_EXECUTED_INCOMPLETE])('replays a malformed historical call paired with %s', marker => {
  const entries = [functionCall('partial', 'inspect', '{}{}{}'), functionCall('ran', 'inspect', '{"slot":2}'),
    functionResult('ran', 'real receipt'), functionResult('partial', marker)];
  const historical = JSON.stringify(entries);
  const request = { model: 'test', input: entries.map(inputItem) };
  const native = responsesInput(request, {}).input;
  expect(native.filter(item => item.type === 'function_call').map(item => [item.call_id, JSON.parse(String(item.arguments))]))
    .toEqual([['partial', { _cortico_replay: 'invalid_historical_arguments' }], ['ran', { slot: 2 }]]);
  expect(native.filter(item => item.type === 'function_call_output').map(item => [item.call_id, item.output]))
    .toEqual([['ran', 'real receipt'], ['partial', marker]]);
  const chat = nativeChatInput(request, { context: entries });
  expect(JSON.parse(chat[0].tool_calls![0].function.arguments)).toEqual({ _cortico_replay: 'invalid_historical_arguments' });
  expect(chat.filter(row => row.role === 'tool').map(row => row.tool_call_id)).toEqual(['ran', 'partial']);
  expect(JSON.stringify(entries)).toBe(historical);
});

it.each([FOLD_PLACEHOLDER, TOOL_FAILED_BAD_ARGS + '\n[additional context]', 'actual result'])('preserves the projected or actual receipt %s', output => {
  const context = [functionCall('call', 'inspect', '{}{}{}'), functionResult('call', output)];
  const input = responsesInput({ model: 'test' }, { context }).input;
  expect(JSON.parse(String(input[0].arguments))).toEqual({ _cortico_replay: 'invalid_historical_arguments' });
  expect(input[1]).toMatchObject({ type: 'function_call_output', call_id: 'call', output });
  expect(context[0].item).toMatchObject({ arguments: '{}{}{}' });
});

it('exposes folded or unavailable arguments without inventing an execution result', () => {
  const context = [functionCall('folded', 'read', FOLD_ARGS_PLACEHOLDER), functionResult('folded', 'ran'), functionCall('orphan', 'read', '{')];
  const input = responsesInput({ model: 'test', input: context.map(inputItem) }, {}).input;
  expect(JSON.parse(String(input[0].arguments))).toEqual({ _cortico_replay: 'arguments_folded' });
  expect(input[1].output).toBe('ran');
  expect(JSON.parse(String(input[2].arguments))).toEqual({ _cortico_replay: 'invalid_historical_arguments' });
  expect(input).toHaveLength(3);
});

it('keeps the original spelling and entry identity for valid JSON', () => {
  const context = [functionCall('good', 'read', '{  }'), functionResult('good', NOT_EXECUTED_STREAM_ABORTED)];
  expect(requestContext({ model: 'test' }, { context })).toBe(context);
});
