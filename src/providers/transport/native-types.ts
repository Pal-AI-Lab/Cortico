import type { BlobRef } from '../../core/types.ts';

/** Chat Completions request envelope, used only inside native provider adapters. */
export interface NativeChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  parts?: Array<Record<string, unknown>>;
  reasoning_content?: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  blobs?: BlobRef[];
  head?: true;
}
