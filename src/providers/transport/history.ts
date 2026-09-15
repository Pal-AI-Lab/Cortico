import type { NativeChatMessage } from './native-types.ts';
import type { ToolSchema } from '../../core/types.ts';
export function dropPastThinking(messages: NativeChatMessage[]): NativeChatMessage[] {
  return messages.map((m) =>
    m.role === 'assistant' && m.reasoning_content && !m.head
      ? { ...m, reasoning_content: '' }
      : m,
  );
}

/** 线上不带 blobs 字段:句柄是 core 内部形态,分片渲染(若有)另行处理。 */
export function dropBlobsField(m: NativeChatMessage): NativeChatMessage {
  if (m.blobs === undefined) return m;
  const { blobs: _drop, ...rest } = m;
  return rest as NativeChatMessage;
}

export function dropHeadMark(m: NativeChatMessage): NativeChatMessage {
  return { role: m.role, content: m.content,
    ...(m.reasoning_content !== undefined ? { reasoning_content: m.reasoning_content } : {}),
    ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
    ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}), ...(m.parts ? { parts: m.parts } : {}) };
}

export interface CompatMediaOptions {
  enabled: () => boolean;
  read: (ref: string) => Buffer | null;
}

/** OpenAI function 格式的 tools 段(各 chat 方言共用)。 */
export function mapTools(tools?: ToolSchema[]): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/**
 * 渲染 Chat 请求消息，移除内部 blobs 字段。仅在 keepReasoning 时保留非空 reasoning_content。
 * 启用媒体时将可读取附件转换为 data URL 内容块；无法读取的附件跳过，原文本引用仍保留。
 */
export function renderMessagesWithMedia(
  messages: NativeChatMessage[],
  media?: CompatMediaOptions,
  opts?: { keepReasoning?: boolean },
): Array<Record<string, unknown>> {
  const renderMedia = media?.enabled() === true ? media : undefined;
  return messages.map((m) => {
    const refs = m.blobs;
    const { reasoning_content: _r, parts: _parts, ...rest } = dropHeadMark(m);
    const base = { ...rest, content: m.parts ?? m.content } as Record<string, unknown>;
    if (opts?.keepReasoning && m.reasoning_content) base.reasoning_content = m.reasoning_content;
    if (!renderMedia || !refs?.length) return base;
    const parts: Array<Record<string, unknown>> = m.parts ? [...m.parts] : [{ type: 'text', text: m.content }];
    let attached = false;
    for (const r of refs) {
      const bytes = renderMedia.read(r.handle);
      if (!bytes) continue;
      attached = true;
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${r.mime};base64,${bytes.toString('base64')}` },
      });
    }
    return attached ? { ...base, content: parts } : base;
  });
}
