import type { NativeChatMessage } from './native-types.ts';
import type { ModelSpec, ToolSchema } from '../../core/types.ts';
import type { Request } from '../../protocol/open-responses/index.ts';
import { ResponseProtocolError } from '../../protocol/open-responses/stream.ts';
import { itemText, record, type ContextRecord } from '../../protocol/open-responses/context.ts';
import type { GenerateOptions } from '../../core/generation.ts';

export function requestSpec(request: Request, options: GenerateOptions): ModelSpec {
  return { ...options.nativeSpec, model: request.model ?? options.nativeSpec?.model ?? '',
    thinking: options.nativeSpec?.thinking ?? request.reasoning?.effort !== 'none',
    ...(request.reasoning?.effort && request.reasoning.effort !== 'none' ? { reasoningEffort: request.reasoning.effort } : {}),
    ...(options.nativeSpec?.reasoningEffort === 'max' ? { reasoningEffort: 'max' } : {}),
    ...(request.temperature != null ? { temperature: request.temperature } : {}),
    ...(request.max_output_tokens != null ? { maxTokens: request.max_output_tokens } : {}),
  };
}

export function requestTools(request: Request): ToolSchema[] | undefined {
  return request.tools?.map(tool => ({ name: tool.name, description: tool.description ?? '', parameters: tool.parameters ?? {} }));
}

export function requestContext(request: Request, options: GenerateOptions): readonly ContextRecord[] {
  if (options.context) return options.context;
  if (typeof request.input === 'string') return [record({ type: 'message', role: 'user', content: request.input })];
  return (request.input ?? []).map(item => record(item));
}

function nativeParts(entry: ContextRecord): Array<Record<string, unknown>> | undefined {
  const item = entry.item;
  const content = item.type === 'message' ? item.content : item.type === 'function_call_output' ? item.output : undefined;
  if (!Array.isArray(content) || content.every(part => 'text' in part || part.type === 'refusal')) return undefined;
  return content.map(part => {
    if ('text' in part) return { type: 'text', text: part.text };
    if (part.type === 'input_image') {
      if (!part.image_url) throw new ResponseProtocolError('Native Chat images require image_url');
      return { type: 'image_url', image_url: { url: part.image_url, ...(part.detail ? { detail: part.detail } : {}) } };
    }
    if (part.type === 'input_file') {
      if (!('file_data' in part) || !part.file_data) throw new ResponseProtocolError('Native Chat files require inline file_data');
      return { type: 'file', file: { ...(part.filename ? { filename: part.filename } : {}), file_data: part.file_data } };
    }
    throw new ResponseProtocolError('Unsupported native Chat content part: ' + part.type);
  });
}

/** Chat Completions has one assistant envelope for adjacent reasoning, text and function calls. */
export function nativeChatInput(request: Request, options: GenerateOptions): NativeChatMessage[] {
  const messages: NativeChatMessage[] = [];
  if (request.instructions) messages.push({ role: 'system', content: request.instructions });
  let assistant: NativeChatMessage | null = null;
  const ensureAssistant = (entry: ContextRecord): NativeChatMessage => {
    if (!assistant) {
      assistant = { role: 'assistant', content: '', ...(entry.context.head ? { head: true } : {}) };
      messages.push(assistant);
    }
    return assistant;
  };
  let group: string | number | undefined;
  for (const entry of requestContext(request, options)) {
    const nextGroup = entry.context.responseId;
    if (nextGroup !== undefined && nextGroup !== group) assistant = null;
    group = nextGroup;
    const item = entry.item;
    if (item.type === 'reasoning') {
      const target = ensureAssistant(entry);
      target.reasoning_content = (target.reasoning_content ?? '') + itemText(item);
    } else if (item.type === 'function_call') {
      const target = ensureAssistant(entry);
      (target.tool_calls ??= []).push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } });
    } else if (item.type === 'function_call_output') {
      assistant = null;
      messages.push({ role: 'tool', content: itemText(item), parts: nativeParts(entry), tool_call_id: item.call_id, blobs: entry.context.blobs });
    } else if (item.type === 'message') {
      if (item.role === 'assistant') {
        ensureAssistant(entry).content += itemText({ ...item, type: 'message' });
      } else {
        assistant = null;
        messages.push({ role: item.role === 'developer' ? 'system' : item.role, content: itemText({ ...item, type: 'message' }), parts: nativeParts(entry), blobs: entry.context.blobs });
      }
    } else throw new Error(`Native Chat provider cannot replay ${item.type}`);
  }
  return messages;
}
