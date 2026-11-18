import { expect, it } from 'vitest';
import { functionCall, functionResult, inputItem } from '../../../src/protocol/open-responses/context.ts';
import { NOT_EXECUTED_INCOMPLETE, NOT_EXECUTED_STREAM_ABORTED } from '../../../src/core/markers.ts';
import { nativeChatInput, requestContext } from '../../../src/providers/transport/native-input.ts';
import { responsesInput } from '../../../src/providers/transport/responses-input.ts';

it.each([NOT_EXECUTED_STREAM_ABORTED, NOT_EXECUTED_INCOMPLETE])('replays a malformed historical call paired with %s', marker => {
  const entries = [functionCall('partial', 'inspect', '{}{}{}'), functionCall('ran', 'inspect', '{"slot":2}'),
    functionResult('ran', 'real receipt'), functionResult('partial', marker)];
  const historical = JSON.stringify(entries);
  const request = { model: 'test', input: entries.map(inputItem) };
  const native = responsesInput(request, {}).input;
  expect(native.filter(item => item.type === 'function_call').map(item => [item.call_id, JSON.parse(String(item.arguments))]))
    .toEqual([['partial', { _cortico_replay: 'unexecuted_invalid_json' }], ['ran', { slot: 2 }]]);
  expect(native.filter(item => item.type === 'function_call_output').map(item => [item.call_id, item.output]))
    .toEqual([['ran', 'real receipt'], ['partial', marker]]);
  const chat = nativeChatInput(request, { context: entries });
  expect(JSON.parse(chat[0].tool_calls![0].function.arguments)).toEqual({ _cortico_replay: 'unexecuted_invalid_json' });
  expect(chat.filter(row => row.role === 'tool').map(row => row.tool_call_id)).toEqual(['ran', 'partial']);
  expect(JSON.stringify(entries)).toBe(historical);
});

it('keeps valid arguments, unmatched calls and actual execution receipts intact', () => {
  const context = [functionCall('good', 'read', '{  }'), functionResult('good', NOT_EXECUTED_STREAM_ABORTED),
    functionCall('actual', 'read', '{'), functionResult('actual', 'real tool result'), functionCall('orphan', 'read', '{}{}')];
  expect(requestContext({ model: 'test' }, { context })).toBe(context);
});
