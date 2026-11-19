/**
 * Fallback for a request whose attachments the model service refuses. A request that carries
 * attachments and is refused with 413, or with a 400 that is not a context overflow, is sent once
 * more without them. When that one is accepted, the attachments were the cause: their handles are
 * remembered, every later request through this client leaves them out, and each record that lost
 * one gets the `attachmentLeftOut` line after its text. The handles live in memory only, so after a
 * restart the first request carrying one of them is refused once more.
 *
 * A 413 is retried without attachments even though `isContextOverflow` counts it: attachment bytes reach a
 * service's body size limit long before they move the token count. A 413 that survives the retry
 * reaches Core as a context overflow.
 */
import { BaseProvider } from '../base.ts';
import { GenerationError, type GenerateOptions, type Generation } from '../../core/generation.ts';
import type { ContextRecord, Item } from '../../protocol/open-responses/context.ts';
import type { Request } from '../../protocol/open-responses/index.ts';
import type { Logger } from '../../core/types.ts';
import type { CompatMediaOptions } from './history.ts';

/** Statuses of a request the service will not take as written. */
const REFUSED: ReadonlySet<number> = new Set([400, 413]);

export interface AttachmentFallbackOptions {
  media: CompatMediaOptions;
  /** The module's `contextOverflow`. A refusal it matches is not retried, except a 413. */
  contextOverflow(error: GenerationError): boolean;
  /** The records whose attachments the client sends with a request; every record when absent. */
  attached?(context: readonly ContextRecord[]): readonly ContextRecord[];
  /** The attachment types the client sends; images when absent. */
  accepts?(mime: string): boolean;
  log: Logger;
}

/** Follows the `[blob …]` line of an attachment a request goes out without. */
export const attachmentLeftOut = (handle: string): string =>
  `[${handle} left out: the model service rejected the request that carried this attachment]`;

export class AttachmentFallback extends BaseProvider {
  /** Attachments whose request was accepted only without them. */
  private readonly refused = new Set<string>();

  constructor(private readonly inner: BaseProvider, private readonly options: AttachmentFallbackOptions) {
    super();
  }

  async respond(request: Request, options: GenerateOptions = {}): Promise<Generation> {
    const context = options.context && withoutAttachments(options.context, this.refused);
    try {
      return await this.inner.respond(request, context ? { ...options, context } : options);
    } catch (error) {
      if (!context || options.diagnostic || options.signal?.aborted || !(error instanceof GenerationError) || !this.retried(error)) throw error;
      const sent = this.sentAttachments(context);
      if (!sent.size) throw error;
      let generation: Generation;
      try {
        generation = await this.inner.respond(request, { ...options, context: withoutAttachments(context, sent) });
      } catch (retry) {
        if (!(retry instanceof GenerationError)) throw retry;
        throw new GenerationError(retry.message, [...error.attempts, ...retry.attempts], retry.partial, retry.origin, retry.status, retry.body, { cause: retry.cause });
      }
      for (const handle of sent) this.refused.add(handle);
      this.options.log.warn('Model service rejected a request with attachments; sent again without them', { status: error.status, attachments: [...sent] });
      return { ...generation, attempts: [...error.attempts, ...generation.attempts] };
    }
  }

  private retried(error: GenerationError): boolean {
    return REFUSED.has(error.status) && (error.status === 413 || !this.options.contextOverflow(error));
  }

  /** The attachments the client sends with a request built from `context`. */
  private sentAttachments(context: readonly ContextRecord[]): Set<string> {
    const { media, attached, accepts = (mime: string) => mime.startsWith('image/') } = this.options;
    if (!media.enabled()) return new Set();
    return new Set((attached?.(context) ?? context).flatMap((entry) => (entry.context.blobs ?? [])
      .filter((ref) => accepts(ref.mime) && media.read(ref.handle))
      .map((ref) => ref.handle)));
  }
}

/** The context without the attachments in `handles`; each record that lost one gets an `attachmentLeftOut` line per attachment. */
export function withoutAttachments(context: readonly ContextRecord[], handles: ReadonlySet<string>): readonly ContextRecord[] {
  if (!handles.size) return context;
  return context.map((entry) => {
    const blobs = entry.context.blobs ?? [];
    const out = blobs.filter((ref) => handles.has(ref.handle));
    if (!out.length) return entry;
    return {
      ...entry,
      item: withLine(entry.item, out.map((ref) => attachmentLeftOut(ref.handle)).join('\n')),
      context: { ...entry.context, blobs: blobs.filter((ref) => !out.includes(ref)) },
    };
  });
}

/**
 * The item with `line` on its own line after its text; content parts other than text stay in place.
 * An appended part starts with a newline because Chat joins text parts without a separator.
 */
function withLine(item: Item, line: string): Item {
  if (item.type === 'message')
    return { ...item, content: typeof item.content === 'string' ? `${item.content}\n${line}` : [...item.content, { type: 'input_text', text: `\n${line}` }] } as Item;
  if (item.type === 'function_call_output')
    return { ...item, output: typeof item.output === 'string' ? `${item.output}\n${line}` : [...item.output, { type: 'input_text', text: `\n${line}` }] } as Item;
  return item;
}
