import type { BlobInput, BlobRef, Logger, ModelSpec, ToolCallContext, ToolDef } from './types.ts';
import type { SessionHandle } from './sessions.ts';
import { withBlobLines } from './blobs.ts';
import { message, functionResult, responseRecords, type ContextRecord } from '../protocol/open-responses/context.ts';
import { responseRequest, textOf } from '../protocol/open-responses/context-helpers.ts';
import { ResponseAccumulator } from '../protocol/open-responses/stream.ts';
import { GenerationError, type ResponseClient } from './generation.ts';
import {
  NOT_EXECUTED_BARRIER,
  NOT_EXECUTED_INCOMPLETE,
  NOT_EXECUTED_THREAD_ENDED,
  forkUnknownTool,
  toolFailed,
} from './markers.ts';

export interface ForkLoopOptions {
  id: string;
  llm: ResponseClient;
  spec: ModelSpec;
  messages: ContextRecord[];
  tools: ToolDef[];
  maxRounds: number;
  softRounds?: number;
  log: Logger;
  /** 工具回执的附件内部化(新字节进日志附件库、已有句柄补 mime),与主循环同一个实现。 */
  blobs: { intern(inputs: readonly (BlobInput | BlobRef)[] | undefined): BlobRef[] | undefined };
  stopWhen?: () => boolean;
  wrapUpHint?: string;
  capNote?: string;
  nudge?: { when: (lastContent: string) => boolean; message: string };
  track?: SessionHandle;
  observeMessages?: (messages: ContextRecord[]) => void;
}

/** The caller hands the fork a client already bound to one provider instance; the Item sequence is retained across tool rounds. */
export async function runForkLoop(opts: ForkLoopOptions): Promise<string> {
  const { id, llm, spec, tools, maxRounds, log } = opts;
  const messages = [...opts.messages];
  const observed = [...messages];
  opts.observeMessages?.(observed);
  const ctx: ToolCallContext = { role: id, log };
  const schemas = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  const wrapUpAt = Math.min(Math.max(1, opts.softRounds ?? maxRounds - 1), Math.max(1, maxRounds - 1));
  const wrapUpHint = opts.wrapUpHint ?? 'Wrap up: give your conclusion next round, no more tool calls.';
  let lastContent = '';
  const runRound = async (round: number): Promise<'done' | 'continue'> => {
    let draft = new ResponseAccumulator();
    const settledLength = observed.length;
    let generated;
    try {
      generated = await llm.respond(responseRequest(spec, messages, schemas), {
        role: id, sessionId: opts.track?.id, context: messages, nativeSpec: spec,
        onEvent: event => {
          if (event.type === 'response.created') draft = new ResponseAccumulator();
          draft.accept(event);
          const snapshot = draft.snapshot();
          if (snapshot) {
            observed.splice(settledLength, observed.length - settledLength, ...snapshot.output.map(item => ({ version: 2 as const, item, context: { responseId: snapshot.id } })));
          }
        },
      });
    } catch (error) {
      if (error instanceof GenerationError) opts.track?.recordAttempts(error.attempts, observed);
      throw error;
    }
    const output = responseRecords(generated.response, generated.origin);
    messages.push(...output);
    observed.splice(settledLength, observed.length - settledLength, ...output);
    opts.track?.recordAttempts(generated.attempts, observed);
    const text = output.filter(entry => entry.item.type === 'message').map(textOf).join('');
    if (text) lastContent = text;
    const calls = generated.response.output.filter(item => item.type === 'function_call');
    if (!calls.length) return 'done';
    let barrier = false;
    for (const [index, call] of calls.entries()) {
      const def = tools.find(tool => tool.name === call.name);
      let out: string;
      let blobs: BlobRef[] | undefined;
      let ended = false;
      if (barrier) out = NOT_EXECUTED_BARRIER;
      else if (call.status !== 'completed') { out = NOT_EXECUTED_INCOMPLETE; barrier = true; }
      else if (!def) out = forkUnknownTool(call.name);
      else {
        try {
          const args = JSON.parse(call.arguments || '{}') as Record<string, unknown>;
          const result = await def.handler(args, { ...ctx, callId: call.call_id });
          if (typeof result === 'string') out = result;
          else {
            blobs = opts.blobs.intern(result.blobs);
            out = withBlobLines(result.text, blobs);
          }
          ended = def.endsTurn === true;
        } catch (error) { out = toolFailed(error instanceof Error ? error.message : String(error)); }
        if (def.barrierAfter) barrier = true;
      }
      if (round === wrapUpAt) out += `\n[system] ${wrapUpHint}`;
      const receipt = functionResult(call.call_id, out, blobs ? { blobs } : {});
      messages.push(receipt); observed.push(receipt);
      if (ended || opts.stopWhen?.()) {
        for (const skipped of calls.slice(index + 1)) {
          const receipt = functionResult(skipped.call_id, NOT_EXECUTED_THREAD_ENDED);
          messages.push(receipt); observed.push(receipt);
        }
        return 'done';
      }
    }
    return 'continue';
  };
  let finished = false;
  for (let round = 1; round <= maxRounds; round++) {
    if (await runRound(round) === 'done') { finished = true; break; }
  }
  if (!finished) log.warn('工具循环达到硬上限,取最后内容为结果', { maxRounds });
  if (opts.nudge && !opts.stopWhen?.() && opts.nudge.when(lastContent)) {
    const reminder = message('user', opts.nudge.message);
    messages.push(reminder); observed.push(reminder);
    await runRound(maxRounds);
  }
  if (!finished && opts.capNote) lastContent = lastContent ? `${lastContent}\n\n${opts.capNote}` : opts.capNote;
  return lastContent;
}
