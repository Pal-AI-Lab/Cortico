import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import type { LLMProviderEntry } from '../../../src/core/types.ts';
import { nullLogger } from '../../../src/core/util.ts';
import { ProviderRegistry } from '../../../src/providers/registry.ts';
import { ProviderHub } from '../../../src/providers/webui/hub.ts';
import { ProviderSettings } from '../../../src/providers/webui/settings.ts';
import { PROBE_MAX_OUTPUT_TOKENS } from '../../../src/providers/webui/types.ts';
import type { Request } from '../../../src/protocol/open-responses/index.ts';
import { FixtureStream } from '../../core/fixture-protocol.ts';
import { makeCfg, makeTmpDir } from '../../core/helpers.ts';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function fixture() {
  const temp = makeTmpDir(); cleanups.push(temp.cleanup);
  const root = join(temp.dir, 'providers'); mkdirSync(root);
  const file = join(temp.dir, 'config.json'); writeFileSync(file, '{}');
  const cfg = makeCfg({ providers: {}, activeProvider: '' });
  const registry = new ProviderRegistry(() => cfg.providers, { stateRoot: root, readBlob: () => null, keepThinking: () => true, log: nullLogger() });
  const settings = new ProviderSettings(cfg, registry, file, root);
  return { hub: new ProviderHub(cfg, registry, settings, file, root), cfg, root };
}

async function endpoint(kind: string, result: 'complete' | 'error' | 'truncated' = 'complete') {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    requests.push(request);
    if (request.stream !== true) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Only streaming requests are accepted' } }));
      return;
    }
    if (req.headers.authorization !== 'Bearer probe-key') {
      res.writeHead(401).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (kind === 'llamacpp') {
      emit({ id: 'probe', model: request.model, choices: [{ index: 0, delta: { content: 'pong' }, finish_reason: 'stop' }] });
      emit({ id: 'probe', model: request.model, choices: [], usage: {
        prompt_tokens: 21, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 3 },
      } });
      res.end('data: [DONE]\n\n');
    } else {
      const stream = new FixtureStream(request as Request, emit);
      stream.feed({ type: 'content', text: 'pong' });
      if (result === 'complete') stream.finish({ promptTokens: 21, completionTokens: 8, cacheHitTokens: 5, cacheMissTokens: 16, reasoningTokens: 3 });
      else if (result === 'error') emit({ type: 'error', error: { message: 'Generation interrupted', type: 'server_error', code: null, param: null } });
      res.end();
    }
  });
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  return { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, requests };
}

it.each(['openai-responses-compat', 'llamacpp'].flatMap(kind => ['saved', 'draft'].map(state => ({ kind, state }))))(
  'probes a $state $kind endpoint that requires streaming and returns its final usage and charges', async ({ kind, state }) => {
    const { hub, cfg, root } = fixture();
    const { baseUrl, requests } = await endpoint(kind);
    const entry: LLMProviderEntry = { kind, baseUrl, spec: { model: 'test-model', thinking: false }, pricing: [{
      models: ['*'], currency: 'USD', basis: 'marginal', source: 'test',
      rules: [{ meter: 'input', perMillion: 2 }, { meter: 'output', perMillion: 4 }],
    }] };
    if (state === 'saved') hub.save(null, { name: 'Connection', entry, secretValue: 'probe-key' }, 'en');
    const receipt = await hub.action('Connection', 'test', 'en', state === 'draft' ? { entry, secretValue: 'probe-key' } : undefined);
    expect(receipt).toMatchObject({ ok: true, status: 200, model: entry.spec!.model,
      usage: { input: 21, cachedInput: 5, output: 8, reasoning: 3 },
      charges: [{ currency: 'USD', amount: (21 * 2 + 8 * 4) / 1_000_000 }],
    });
    expect(requests[0][kind === 'llamacpp' ? 'max_tokens' : 'max_output_tokens']).toBe(PROBE_MAX_OUTPUT_TOKENS);
    expect(cfg.activeProvider).toBe('');
    if (state === 'draft') {
      expect(existsSync(join(root, 'Connection'))).toBe(false);
      expect(cfg.providers).toEqual({});
    }
  },
);

it.each(['error', 'truncated'] as const)('fails a probe with a stream result of %s without retrying', async result => {
  const { hub } = fixture();
  const { baseUrl, requests } = await endpoint('openai-responses-compat', result);
  const receipt = await hub.action('Connection', 'test', 'en', {
    entry: { kind: 'openai-responses-compat', baseUrl, spec: { model: 'test-model', thinking: false } }, secretValue: 'probe-key',
  });
  expect(receipt).toMatchObject({ ok: false, status: 0 });
  expect(receipt).toHaveProperty('error', expect.stringContaining(result === 'error' ? 'Generation interrupted' : 'terminal'));
  expect(requests).toHaveLength(1);
});
