/**
 * 端点页的思维链段落:探测判定表,以及探测按结果写回条目。上游用假客户端按回放形态给定结果。
 */
import { describe, expect, it } from 'vitest';
import { compatConsole, replayVerdict, type DetectResult, type ProbeOutcome, type ReasoningPanelState } from '../../../../src/providers/openai-responses-compat/console/server.ts';
import type { CompatControl } from '../../../../src/providers/openai-responses-compat/index.ts';
import type { ProviderConsoleHost } from '../../../../src/providers/console/types.ts';
import { PROBE_MAX_OUTPUT_TOKENS } from '../../../../src/providers/console/types.ts';
import { GenerationError, type GenerateOptions, type Generation, type ResponseClient } from '../../../../src/core/generation.ts';
import type { Request } from '../../../../src/protocol/open-responses/index.ts';
import type { LLMProviderEntry } from '../../../../src/core/types.ts';
import type { ReasoningReplay } from '../../../../src/providers/transport/responses-input.ts';

type Upstream = 'encrypted' | 'plaintext' | 'none' | 400 | 401;

const origin = { instance: 'cloud', module: 'openai-responses-compat', model: 'm', compatibilityDomain: 'd' };

/** 假上游:按回放形态返回给定结果,并记下请求。 */
function upstream(byReplay: Record<ReasoningReplay, Upstream>) {
  const seen: Array<{ replay: ReasoningReplay; request: Request; options: GenerateOptions }> = [];
  const client = (replay: ReasoningReplay): ResponseClient => ({
    respond: async (request, options = {}) => {
      seen.push({ replay, request, options });
      const outcome = byReplay[replay];
      if (typeof outcome === 'number') throw new GenerationError(`LLM API ${outcome}`, [], null, origin, outcome, `{"error":"${outcome}"}`);
      const output = outcome === 'none' ? [] : [{ type: 'reasoning', id: 'rs_1', summary: [], content: [], ...(outcome === 'encrypted' ? { encrypted_content: 'sig' } : {}) }];
      return { response: { output }, attempts: [{ status: 200 }] } as unknown as Generation;
    },
  });
  return { seen, control: { probeClient: client } satisfies CompatControl };
}

function host(entry: LLMProviderEntry, control: CompatControl) {
  const entries: Record<string, LLMProviderEntry> = { cloud: entry };
  const value: ProviderConsoleHost = {
    language: 'zh',
    entries: () => Object.entries(entries).map(([name, entry]) => ({ name, entry })),
    instance: () => ({ client: null as never, control }),
    save: (name, next) => { entries[name] = next; },
  };
  return { host: value, entries };
}

const thinking: LLMProviderEntry = {
  kind: 'openai-responses-compat', baseUrl: 'https://api.test', options: { endpointPath: '/v1/responses' },
  spec: { model: 'm', thinking: true },
};

const detect = async (entry: LLMProviderEntry, byReplay: Record<ReasoningReplay, Upstream>) => {
  const up = upstream(byReplay);
  const h = host(entry, up.control);
  const contribution = compatConsole(h.host);
  const result = await contribution.invoke!('reasoning', 'detect', [{ name: 'cloud' }]) as DetectResult;
  return { result, seen: up.seen, saved: h.entries.cloud };
};

describe('replayVerdict', () => {
  const ok = (reasoning: 'encrypted' | 'plaintext' | 'none'): ProbeOutcome => ({ ok: true, status: 200, reasoning });
  const rejected = (status: number): ProbeOutcome => ({ ok: false, status, error: 'x' });
  it('两条都过看返回形态;一条被 400 拒看另一条;其余判不出', () => {
    expect(replayVerdict(ok('encrypted'), ok('encrypted'))).toBe('encrypted');
    expect(replayVerdict(ok('none'), ok('none'))).toBe('encrypted');
    expect(replayVerdict(ok('plaintext'), ok('plaintext'))).toBe('plaintext');
    expect(replayVerdict(rejected(400), ok('plaintext'))).toBe('plaintext');
    expect(replayVerdict(ok('encrypted'), rejected(400))).toBe('encrypted');
    expect(replayVerdict(rejected(400), rejected(400))).toBeNull();
    expect(replayVerdict(rejected(500), ok('plaintext'))).toBeNull();
    expect(replayVerdict(ok('plaintext'), rejected(401))).toBeNull();
  });
});

describe('探测', () => {
  it('裸合成调用被拒、带明文过:写回 plaintext,其余选项保留;两条请求都是诊断请求,尾部是合成调用的回执', async () => {
    const { result, seen, saved } = await detect(thinking, { encrypted: 400, plaintext: 'plaintext' });
    expect(result.verdict).toBe('plaintext');
    expect(result.bare).toEqual({ ok: false, status: 400, error: '{"error":"400"}' });
    expect(result.withReasoning).toEqual({ ok: true, status: 200, reasoning: 'plaintext' });
    expect(saved.options).toEqual({ endpointPath: '/v1/responses', reasoningReplay: 'plaintext' });
    expect(seen.map((call) => call.replay)).toEqual(['encrypted', 'plaintext']);
    for (const { request, options } of seen) {
      expect(options.diagnostic).toBe(true);
      expect(request.max_output_tokens).toBe(PROBE_MAX_OUTPUT_TOKENS);
      expect(request.tools?.map((tool) => tool.name)).toEqual(['probe_event_frame']);
      const input = request.input as Array<{ type: string; name?: string }>;
      expect(input.map((item) => item.type)).toEqual(['message', 'function_call', 'function_call_output']);
      expect(input[1].name).toBe('probe_event_frame');
    }
  });
  it('两条都过、上游返回签名块:写回 encrypted', async () => {
    const { result, saved } = await detect(thinking, { encrypted: 'encrypted', plaintext: 'encrypted' });
    expect(result.verdict).toBe('encrypted');
    expect(saved.options?.reasoningReplay).toBe('encrypted');
  });
  it('裸调用因鉴权失败:不发第二条,条目不动', async () => {
    const { result, seen, saved } = await detect(thinking, { encrypted: 401, plaintext: 'plaintext' });
    expect(result).toEqual({ verdict: null, bare: { ok: false, status: 401, error: '{"error":"401"}' } });
    expect(seen).toHaveLength(1);
    expect(saved.options).toEqual({ endpointPath: '/v1/responses' });
  });
  it('没选模型或关着思维链:不发请求', async () => {
    await expect(detect({ ...thinking, spec: undefined }, { encrypted: 'none', plaintext: 'none' })).rejects.toThrow('先选模型');
    const off = await detect({ ...thinking, spec: { model: 'm', thinking: false } }, { encrypted: 'none', plaintext: 'none' }).catch((error: Error) => error);
    expect(String(off)).toContain('关着思维链');
  });
  it('state 给出协议配置组与当前值', async () => {
    const h = host({ ...thinking, options: { reasoningReplay: 'plaintext' } }, upstream({ encrypted: 'none', plaintext: 'none' }).control);
    const state = await compatConsole(h.host).invoke!('reasoning', 'state', [{ name: 'cloud' }]) as ReasoningPanelState;
    expect(state.name).toBe('cloud');
    const [{ group, values }] = state.config;
    expect(group.schema.properties['providers.cloud.options.reasoningReplay'].enum).toEqual(['encrypted', 'plaintext']);
    expect(values['providers.cloud.options.reasoningReplay']).toBe('plaintext');
    expect(values['providers.cloud.options.endpointPath']).toBe('');
  });
});
