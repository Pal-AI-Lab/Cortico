/** Stateless native Responses input: the whole context is replayed on every request. */
import type { Request } from '../../protocol/open-responses/index.ts';
import { inputItem, itemText, type ContextRecord } from '../../protocol/open-responses/context.ts';
import type { GenerateOptions } from '../../core/generation.ts';
import { requestContext } from './native-input.ts';
import type { CompatMediaOptions } from './history.ts';

type Item = Record<string, unknown>;

/**
 * How past reasoning re-enters the context. `encrypted`: the signed `encrypted_content` block, only
 * when the recorded origin matches this request. `plaintext`: the reasoning text itself, for
 * endpoints whose thinking mode requires the text of every tool-call turn back.
 */
export const REASONING_REPLAYS = ['encrypted', 'plaintext'] as const;
export type ReasoningReplay = (typeof REASONING_REPLAYS)[number];

/**
 * Default `reasoning_text` sent before a function call without a recorded origin in plaintext
 * replay. A missing field, an empty `content`, an empty string and a summary without
 * `reasoning_text` are each rejected, so the padding is one character; it is non-whitespace in case
 * an endpoint trims. It carries no prose by default: what these calls are is the Persona's to say.
 * The operator replaces it per endpoint.
 */
export const SYNTHETIC_REASONING_TEXT = '-';

export interface ResponsesInputOptions {
  media?: CompatMediaOptions;
  /** Whether past reasoning re-enters the context; the first synthetic turn is exempt. */
  keepThinking?: () => boolean;
  /** Default `encrypted`. */
  reasoningReplay?: ReasoningReplay;
  /** Plaintext replay only; defaults to `SYNTHETIC_REASONING_TEXT`. Endpoints reject an empty one. */
  syntheticReasoningText?: string;
}

/**
 * Encrypted replay: a reasoning item re-enters only with `encrypted_content` and when the recorded
 * instance, module, compatibility domain and model match this request. Plaintext replay: a reasoning
 * item re-enters as `reasoning_text`; the turn after the last user message is always replayed, earlier
 * turns follow `keepThinking`; a function call without an origin gets a synthetic reasoning item
 * unless one already precedes it. System and developer text is joined into instructions.
 */
export function responsesInput(
  request: Request,
  options: GenerateOptions,
  opts: ResponsesInputOptions = {},
): { input: Item[]; instructions: string | undefined } {
  const input: Item[] = [];
  const systems = request.instructions ? [request.instructions] : [];
  const plaintext = opts.reasoningReplay === 'plaintext';
  const entries = requestContext(request, options);
  const roundStart = plaintext ? lastUserMessage(entries) : -1;
  entries.forEach((entry, index) => {
    const item = entry.item;
    if (item.type === 'reasoning') {
      if (plaintext) {
        const text = itemText(item);
        if (!text && !item.encrypted_content) return;
        if (!entry.context.head && index < roundStart && opts.keepThinking?.() === false) return;
        const wire = inputItem(entry) as Item;
        if (text) wire.content = [{ type: 'reasoning_text', text }];
        input.push(wire);
        return;
      }
      if (!item.encrypted_content) return;
      if (!entry.context.head && opts.keepThinking?.() === false) return;
      const owner = entry.context.origin;
      const current = options.origin;
      if (!owner || !current || owner.instance !== current.instance || owner.module !== current.module
        || owner.compatibilityDomain !== current.compatibilityDomain || owner.model !== request.model) return;
    }
    if (item.type === 'message' && (item.role === 'system' || item.role === 'developer')) {
      systems.push(typeof item.content === 'string' ? item.content : item.content.map(part => 'text' in part ? part.text : '').join(''));
      return;
    }
    if (plaintext && item.type === 'function_call' && !entry.context.origin && input.at(-1)?.type !== 'reasoning')
      input.push({
        type: 'reasoning', id: `rs_${item.call_id}`, summary: [],
        content: [{ type: 'reasoning_text', text: opts.syntheticReasoningText ?? SYNTHETIC_REASONING_TEXT }],
      });
    const wire = inputItem(entry) as Item;
    if (opts.media?.enabled() && entry.context.blobs?.length && (item.type === 'message' || item.type === 'function_call_output')) {
      const field = item.type === 'message' ? 'content' : 'output';
      const content = wire[field];
      const parts = typeof content === 'string' ? [{ type: 'input_text', text: content }] : [...(content as Item[])];
      for (const ref of entry.context.blobs) {
        const bytes = opts.media.read(ref.handle);
        if (bytes) parts.push({ type: 'input_image', image_url: `data:${ref.mime};base64,${bytes.toString('base64')}` });
      }
      wire[field] = parts;
    }
    input.push(wire);
  });
  return { input, instructions: systems.length ? systems.join('\n') : undefined };
}

/** Index of the last user message, -1 when there is none. */
function lastUserMessage(entries: readonly ContextRecord[]): number {
  for (let index = entries.length - 1; index >= 0; index--) {
    const item = entries[index].item;
    if (item.type === 'message' && item.role === 'user') return index;
  }
  return -1;
}
