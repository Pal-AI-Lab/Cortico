import { createResponse } from '../../src/protocol/open-responses/index.ts';
import { functionResult, message, responseRecords } from '../../src/protocol/open-responses/context.ts';

export function responseTimelineFixture() {
  const response = createResponse('resp_ordered', { model: 'webui-fixture' }, Date.parse('2026-09-06T00:00:00Z'));
  response.status = 'completed';
  response.output = [
    { type: 'reasoning', id: 'reason_plain', summary: [], content: [
      { type: 'reasoning_text', text: '先读取当前状态。' },
      { type: 'reasoning_text', text: '再核对待处理事件。' },
    ] },
    { type: 'function_call', id: 'call_inspect', call_id: 'inspect_1', name: 'inspect', arguments: '{"scope":"queue"}', status: 'completed' },
    { type: 'reasoning', id: 'reason_sealed', summary: [], encrypted_content: 'opaque-state-one' },
    { type: 'function_call', id: 'call_send', call_id: 'send_1', name: 'console_send', arguments: '{"text":"状态已确认"}', status: 'completed' },
    { type: 'reasoning', id: 'reason_mixed', content: [{ type: 'reasoning_text', text: '保留当前结果用于下一步。' }],
      summary: [{ type: 'summary_text', text: '已完成状态核对。' }], encrypted_content: 'opaque-state-two' },
    { type: 'message', id: 'progress', role: 'assistant', phase: 'commentary', status: 'completed', content: [{ type: 'output_text', text: '状态核对完成。', annotations: [] }] },
    { type: 'message', id: 'answer', role: 'assistant', phase: 'final_answer', status: 'completed', content: [
      { type: 'output_text', text: '可以继续处理事件。', annotations: [] },
      { type: 'refusal', refusal: '该操作无法执行。' },
      { type: 'output_text', text: '其余结果保持有效。', annotations: [] },
    ] },
  ];
  const entries = responseRecords(response, { instance: 'fixture', module: 'fixture', model: response.model, compatibilityDomain: 'fixture' });
  return { response, entries, session: [message('system', '按事件顺序处理任务。'), ...entries,
    functionResult('send_1', '已发送'), functionResult('inspect_1', '队列中有 2 条事件')] };
}
