import { runForkLoop as run, type ForkLoopOptions } from '../../src/core/fork.ts';
import { adaptClient, records, messages, type FixtureClient } from './fixture-protocol.ts';
import type { ChatMessage } from './fixture-types.ts';
import { fakeBlobIntern } from './helpers.ts';

export async function runForkLoop(options: Omit<ForkLoopOptions, 'llm' | 'messages' | 'observeMessages' | 'blobs'> & {
  llm: FixtureClient | ForkLoopOptions['llm']; messages: ChatMessage[]; observeMessages?: (messages: ChatMessage[]) => void;
  blobs?: ForkLoopOptions['blobs'];
}): Promise<string> {
  return run({ ...options, llm: adaptClient(options.llm), messages: records(options.messages),
    blobs: options.blobs ?? fakeBlobIntern(),
    observeMessages: entries => options.observeMessages?.(messages(entries)) });
}
