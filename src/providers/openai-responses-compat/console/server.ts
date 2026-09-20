/**
 * Reasoning section of the endpoint page: the replay form and its probe. The probe sends the
 * shape production sends after an event delivery, a function call the model never made followed by
 * its output, once without reasoning and once with plaintext reasoning, and stores the form the
 * endpoint accepts.
 */
import type { ConsolePageContribution } from '../../../web/shared/console-protocol.ts';
import { PROBE_MAX_OUTPUT_TOKENS, type ProviderConsoleHost } from '../../console/types.ts';
import { getByPath, type ConfigGroup, type ConfigValues } from '../../../core/config-schema.ts';
import type { LLMProviderEntry, ModelSpec } from '../../../core/types.ts';
import { GenerationError, type Generation, type ResponseClient } from '../../../core/generation.ts';
import { functionCall, functionResult, message } from '../../../protocol/open-responses/context.ts';
import { responseRequest } from '../../../protocol/open-responses/context-helpers.ts';
import type { ReasoningReplay } from '../../transport/responses-input.ts';
import { protocolConfig } from '../config.ts';
import type { CompatControl } from '../index.ts';
import { text } from '../strings.ts';

/** The function the probe's synthetic call names; the endpoint sees a call the model never made. */
const PROBE_TOOL = 'probe_event_frame';

export type ProbeOutcome =
  | { ok: true; status: number | null; reasoning: 'encrypted' | 'plaintext' | 'none' }
  | { ok: false; status: number | null; error: string };

export interface DetectResult {
  /** The form written to the entry; null leaves the entry unchanged. */
  verdict: ReasoningReplay | null;
  bare: ProbeOutcome;
  /** Absent when the bare probe failed for a reason other than a rejected request. */
  withReasoning?: ProbeOutcome;
}

export interface ReasoningPanelState {
  name: string;
  config: Array<{ group: ConfigGroup; values: ConfigValues }>;
}

/**
 * Both accepted: the form the endpoint returned, with a reasoning-free response counted as
 * encrypted since nothing is replayed either way. One rejected with 400: the other form.
 * Anything else is undetermined.
 */
export function replayVerdict(bare: ProbeOutcome, withReasoning: ProbeOutcome): ReasoningReplay | null {
  if (bare.ok && withReasoning.ok) return bare.reasoning === 'plaintext' ? 'plaintext' : 'encrypted';
  if (withReasoning.ok && bare.status === 400) return 'plaintext';
  if (bare.ok && withReasoning.status === 400) return 'encrypted';
  return null;
}

function probeRequest(spec: ModelSpec) {
  const context = [
    message('user', 'Reply with one word.'),
    functionCall('probe_1', PROBE_TOOL, '{}'),
    functionResult('probe_1', 'delivered'),
  ];
  const tools = [{ name: PROBE_TOOL, description: 'Delivers external events.', parameters: { type: 'object', properties: {} } }];
  return {
    ...responseRequest(spec, context, tools),
    max_output_tokens: Math.min(spec.maxTokens ?? PROBE_MAX_OUTPUT_TOKENS, PROBE_MAX_OUTPUT_TOKENS),
  };
}

function reasoningForm(generation: Generation): 'encrypted' | 'plaintext' | 'none' {
  const items = generation.response.output.filter((item) => item.type === 'reasoning');
  if (!items.length) return 'none';
  return items.some((item) => item.encrypted_content) ? 'encrypted' : 'plaintext';
}

async function probe(client: ResponseClient, spec: ModelSpec): Promise<ProbeOutcome> {
  try {
    const generation = await client.respond(probeRequest(spec), { diagnostic: true, nativeSpec: spec, role: 'probe' });
    return { ok: true, status: generation.attempts.at(-1)?.status ?? null, reasoning: reasoningForm(generation) };
  } catch (error) {
    if (error instanceof GenerationError) return { ok: false, status: error.status, error: error.body || error.message };
    return { ok: false, status: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export function compatConsole(host: ProviderConsoleHost): Partial<ConsolePageContribution> {
  const S = text(host.language);
  const body = (args: unknown[]): string => {
    const [raw] = args;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(S.bodyRequired);
    const name = (raw as Record<string, unknown>).name;
    if (typeof name !== 'string') throw new Error(S.instanceNameRequired);
    return name;
  };
  const entryOf = (name: string): LLMProviderEntry => {
    const found = host.entries().find((entry) => entry.name === name);
    if (!found) throw new Error(S.instanceNameRequired);
    return found.entry;
  };
  const detect = async (name: string): Promise<DetectResult> => {
    const entry = entryOf(name);
    if (!entry.spec) throw new Error(S.modelRequired);
    if (!entry.spec.thinking) throw new Error(S.thinkingOff);
    const control = host.instance(name).control as CompatControl;
    const bare = await probe(control.probeClient('encrypted'), entry.spec);
    if (!bare.ok && bare.status !== 400) return { verdict: null, bare };
    const withReasoning = await probe(control.probeClient('plaintext'), entry.spec);
    const verdict = replayVerdict(bare, withReasoning);
    if (verdict) host.save(name, { ...entry, options: { ...entry.options, reasoningReplay: verdict } });
    return { verdict, bare, withReasoning };
  };
  return {
    config: [],
    panels: [{ id: 'reasoning', title: S.reasoningPanel, description: S.reasoningPanelDescription, slot: 'instance' }],
    invoke: async (panel, method, args) => {
      if (panel !== 'reasoning') throw new Error(S.unknownPanel);
      const name = body(args);
      if (method === 'state') {
        const entry = entryOf(name);
        const prefix = `providers.${name}.`;
        const config = protocolConfig(name, entry, host.language).map((group) => ({
          group,
          values: Object.fromEntries(Object.keys(group.schema.properties).map((path) => [
            path, getByPath(entry as unknown as Record<string, unknown>, path.slice(prefix.length)) ?? '',
          ])) as ConfigValues,
        }));
        return { name, config } satisfies ReasoningPanelState;
      }
      if (method === 'detect') return detect(name);
      throw new Error(S.unknownMethod);
    },
  };
}
