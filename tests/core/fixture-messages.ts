import { createHash } from 'node:crypto';
import type { BlobRef, FrameEventRef } from '../../src/core/types.ts';
import { record, type ContextMeta, type ContextRecord } from '../../src/protocol/open-responses/context.ts';

/** Compact scripted messages expanded into standard Items for behavior tests. */
export interface FixtureMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  reasoning_content?: string;
  reasoningRef?: { signature: string; model: string };
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  blobs?: BlobRef[];
  ephemeral?: true;
  head?: true;
  ts?: string;
  frame?: { events: FrameEventRef[] };
}

export function fixtureRecords(messages: readonly FixtureMessage[], namespace: string): ContextRecord[] {
  return messages.flatMap((message, messageIndex) => {
    const id = (part: string) => 'fixture_' + createHash('sha256').update(`${namespace}/${messageIndex}/${part}`).digest('hex').slice(0, 24);
    const context: ContextMeta = {
      responseId: `${namespace}:${messageIndex}`,
      ...(message.reasoningRef ? { origin: { instance: 'fixture', module: 'fixture', model: message.reasoningRef.model, compatibilityDomain: 'fixture' } } : {}),
      ...(message.ts ? { ts: message.ts } : {}),
      ...(message.ephemeral ? { ephemeral: true } : {}),
      ...(message.head ? { head: true } : {}),
      ...(message.blobs ? { blobs: message.blobs } : {}),
      ...(message.frame ? { frame: message.frame } : {}),
    };
    if (message.role === 'tool') {
      if (!message.tool_call_id) throw new Error(`Scripted tool result has no call ID at message ${messageIndex}`);
      return [record({ type: 'function_call_output', id: id('result'), call_id: message.tool_call_id, status: 'completed', output: message.content }, context)];
    }
    const out: ContextRecord[] = [];
    if (message.role === 'assistant' && (message.reasoning_content !== undefined || message.reasoningRef)) {
      out.push(record({
        type: 'reasoning', id: id('reasoning'),
        summary: message.reasoningRef && message.reasoning_content ? [{ type: 'summary_text', text: message.reasoning_content }] : [],
        ...(!message.reasoningRef && message.reasoning_content !== undefined ? { content: [{ type: 'reasoning_text' as const, text: message.reasoning_content }] } : {}),
        ...(message.reasoningRef ? { encrypted_content: message.reasoningRef.signature } : {}),
      }, context));
    }
    if (message.role !== 'assistant' || message.content || !message.tool_calls?.length) {
      out.push(record({
        type: 'message', id: id('message'), role: message.role, status: 'completed',
        content: message.role === 'assistant'
          ? [{ type: 'output_text', text: message.content, annotations: [] }]
          : [{ type: 'input_text', text: message.content }],
      }, context));
    }
    for (const [index, call] of (message.tool_calls ?? []).entries()) {
      out.push(record({ type: 'function_call', id: id(`call/${index}`), call_id: call.id, name: call.function.name, arguments: call.function.arguments, status: 'completed' }, context));
    }
    return out;
  });
}
