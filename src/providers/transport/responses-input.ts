/** Stateless native Responses input: the whole context is replayed on every request. */
import type { Request } from '../../protocol/open-responses/index.ts';
import { inputItem } from '../../protocol/open-responses/context.ts';
import type { GenerateOptions } from '../../core/generation.ts';
import { requestContext } from './native-input.ts';
import type { CompatMediaOptions } from './history.ts';

type Item = Record<string, unknown>;

export interface ResponsesInputOptions {
  media?: CompatMediaOptions;
  /** Whether past reasoning re-enters the context; the first synthetic turn is exempt. */
  keepThinking?: () => boolean;
}

/**
 * Replay reasoning only when encrypted_content exists and the recorded instance, module,
 * compatibility domain and model match this request. These are local eligibility checks.
 * Plaintext reasoning is omitted. System and developer text is joined into instructions.
 */
export function responsesInput(
  request: Request,
  options: GenerateOptions,
  opts: ResponsesInputOptions = {},
): { input: Item[]; instructions: string | undefined } {
  const input: Item[] = [];
  const systems = request.instructions ? [request.instructions] : [];
  for (const entry of requestContext(request, options)) {
    const item = entry.item;
    if (item.type === 'reasoning') {
      if (!item.encrypted_content) continue;
      if (!entry.context.head && opts.keepThinking?.() === false) continue;
      const owner = entry.context.origin;
      const current = options.origin;
      if (!owner || !current || owner.instance !== current.instance || owner.module !== current.module
        || owner.compatibilityDomain !== current.compatibilityDomain || owner.model !== request.model) continue;
    }
    if (item.type === 'message' && (item.role === 'system' || item.role === 'developer')) {
      systems.push(typeof item.content === 'string' ? item.content : item.content.map(part => 'text' in part ? part.text : '').join(''));
      continue;
    }
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
  }
  return { input, instructions: systems.length ? systems.join('\n') : undefined };
}
