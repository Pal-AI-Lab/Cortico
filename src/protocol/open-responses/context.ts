import type { BlobRef, FrameEventRef } from '../../core/types.ts';
import type { InputItem, OutputItem, Response, Schemas } from './index.ts';

/** Context preserves the standard input and output item shapes without flattening responses. */
export type Item = InputItem | OutputItem;
export interface ItemOrigin {
  instance: string;
  module: string;
  model: string;
  compatibilityDomain: string;
}
export interface ContextMeta {
  ts?: string;
  ephemeral?: true;
  /** 合成开头的项:不写入 session,交接时不进保留内容。 */
  head?: true;
  frame?: { events: FrameEventRef[] };
  blobs?: BlobRef[];
  responseId?: string;
  responseStatus?: string;
  origin?: ItemOrigin;
}
export interface ContextRecord {
  version: 2;
  item: Item;
  context: ContextMeta;
}

export function record(item: Item, context: ContextMeta = {}): ContextRecord {
  return { version: 2, item, context };
}

export function message(role: 'system' | 'developer' | 'user' | 'assistant', text: string, context: ContextMeta = {}): ContextRecord {
  return record({
    type: 'message', id: `msg_${crypto.randomUUID()}`, status: 'completed', role,
    content: role === 'assistant' ? [{ type: 'output_text', text, annotations: [] }] : [{ type: 'input_text', text }],
  }, context);
}

export function functionCall(callId: string, name: string, args: string, context: ContextMeta = {}): ContextRecord {
  return record({ type: 'function_call', id: `fc_${crypto.randomUUID()}`, call_id: callId, name, arguments: args, status: 'completed' }, context);
}

export function functionResult(callId: string, text: string, context: ContextMeta = {}): ContextRecord {
  return record({ type: 'function_call_output', id: `fco_${crypto.randomUUID()}`, call_id: callId, status: 'completed', output: text }, context);
}

function partsText(content: string | readonly unknown[] | null | undefined): string {
  if (typeof content === 'string') return content;
  return (content ?? []).map(part => {
    const p = part as { text?: string; refusal?: string };
    return p.text ?? p.refusal ?? '';
  }).join('');
}

/** Extract readable text from the Item without changing its stored shape. */
export function itemText(item: Item): string {
  if (item.type === 'message') return partsText(item.content);
  if (item.type === 'function_call_output') return partsText(item.output);
  if (item.type === 'reasoning') return partsText(item.content) || partsText(item.summary);
  return '';
}

export function withText(entry: ContextRecord, text: string): ContextRecord {
  const item = entry.item;
  if (item.type === 'function_call_output') return { ...entry, item: { ...item, output: text } };
  if (item.type !== 'message') throw new Error(`Cannot replace text on ${item.type}`);
  return { ...entry, item: { ...item, content: text } as InputItem };
}

export function responseRecords(response: Response, origin: ItemOrigin, context: ContextMeta = {}): ContextRecord[] {
  return response.output.map(item => record(structuredClone(item), {
    ...context, responseId: response.id, responseStatus: response.status, origin,
  }));
}

/** Build a standard request Item; provider context records retain output reasoning content. */
export function inputItem(entry: ContextRecord): InputItem {
  const item = entry.item;
  if (item.type === 'reasoning') {
    const reasoning: Schemas['ReasoningItemParam'] = {
      type: 'reasoning', summary: item.summary.filter(part => part.type === 'summary_text') as Schemas['ReasoningSummaryContentParam'][],
    };
    if (item.id) reasoning.id = item.id;
    if (item.encrypted_content) reasoning.encrypted_content = item.encrypted_content;
    return reasoning;
  }
  return structuredClone(item) as InputItem;
}
