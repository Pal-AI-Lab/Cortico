import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeCfg, makeTmpDir } from '../core/helpers.ts';
import { nullLogger } from '../../src/core/util.ts';
import { ProviderRegistry, providerModule, providerModules, registerProviderModules, removeProviderModule } from '../../src/providers/registry.ts';
import { ProviderSettings } from '../../src/providers/webui/settings.ts';
import { ProviderHub } from '../../src/providers/webui/hub.ts';
import { acquireInstanceLock } from '../../src/core/instance-lock.ts';
import { validateProviderName } from '../../src/providers/name.ts';
import { FixtureStream } from '../core/fixture-protocol.ts';
import { PROBE_MAX_OUTPUT_TOKENS } from '../../src/providers/webui/types.ts';
import { text } from '../../src/providers/webui/strings.ts';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach(fn => fn()));
function fixture() {
  const temp = makeTmpDir(); cleanups.push(temp.cleanup);
  const root = join(temp.dir, 'providers');
  mkdirSync(root);
  const file = join(temp.dir, 'config.json');
  writeFileSync(file, '{}');
  const cfg = makeCfg({ providers: {}, activeProvider: '' });
  const registry = new ProviderRegistry(() => cfg.providers, { stateRoot: root, readBlob: () => null, keepThinking: () => true, log: nullLogger() });
  const settings = new ProviderSettings(cfg, registry, file, root);
  const hub = new ProviderHub(cfg, registry, settings, file, root);
  return { hub, cfg, root, file, temp, registry, settings };
}
const entry = { kind: 'openai-responses-compat', baseUrl: 'https://model.test', spec: { model: 'test-model', thinking: false } };

it('withdraws a provider before package removal, rejects stale editors, and restores registration on failure', async () => {
  const module = { ...providerModule(entry.kind), id: 'fixture-removable', title: 'Fixture' };
  registerProviderModules([module]);
  const { hub, settings, registry, cfg, root } = fixture();
  const input = { ...entry, kind: module.id };
  const source = settings.sources().find(source => source.id === `llm:${module.id}`)!;
  const page = source.contribute('en')!;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const removal = hub.removeModule(module.id, async () => { await gate; throw new Error('fixture remove failure'); });
    const rejected = expect(removal).rejects.toThrow('fixture remove failure');
    expect(hub.moduleList('en').some(module => module.id === input.kind)).toBe(false);
    expect(source.contribute('en')).toBeNull();
    expect(() => hub.save(null, { name: 'Late', entry: input }, 'en')).toThrow();
    expect(() => settings.save('Late', input, 'en')).toThrow();
    expect(() => registry.preview('Late', input)).toThrow();
    await expect(page.invoke!('reasoning', 'state', [{ name: 'Late' }])).rejects.toThrow('Unknown provider module');
    expect(existsSync(join(root, 'Late'))).toBe(false);
    release(); await rejected;
    expect(source.contribute('en')).not.toBeNull();
    const saved = hub.save(null, { name: 'First', entry: input }, 'en');
    await expect(Promise.resolve().then(() => hub.removeModule(module.id, async () => 'removed'))).rejects.toMatchObject({ status: 409 });
    expect(cfg.providers.First.kind).toBe(module.id);
    hub.delete('First', saved.revision);
    await hub.removeModule(module.id, async () => 'removed');
    expect(() => hub.save(null, { name: 'After', entry: input }, 'en')).toThrow();
    expect(providerModules).not.toContain(module);
  } finally {
    release();
    if (providerModules.includes(module)) await removeProviderModule(module.id, async () => 'cleanup');
  }
});

it('new environments remain empty until a validated connection is saved', () => {
  const { hub, root } = fixture();
  expect(hub.list('en').providers).toEqual([]);
  expect(() => hub.save(null, { name: 'Connection', entry: { ...entry, spec: undefined } }, 'en')).toThrow('Model');
  expect(existsSync(join(root, 'Connection'))).toBe(false);
  hub.save(null, { name: 'Connection', entry, secretValue: 'test-key' }, 'en');
  expect(readFileSync(join(root, 'Connection', '.env'), 'utf8')).toContain('CORTICO_KEY_CONNECTION=test-key');
  expect(hub.list('en').providers[0].readiness.state).toBe('ready');
});
it('derives a distinct default secret variable name from each endpoint name', () => {
  const { hub, root } = fixture();
  hub.save(null, { name: 'Alpha', entry, secretValue: 'alpha-key' }, 'en');
  hub.save(null, { name: 'beta-2', entry, secretValue: 'beta-key' }, 'en');
  expect(readFileSync(join(root, 'Alpha', '.env'), 'utf8')).toContain('CORTICO_KEY_ALPHA=alpha-key');
  expect(readFileSync(join(root, 'beta-2', '.env'), 'utf8')).toContain('CORTICO_KEY_BETA_2=beta-key');
});
it('rejects stale revisions, directory collisions and module changes without changing saved files', () => {
  const { hub, root } = fixture();
  const saved = hub.save(null, { name: 'Connection', entry }, 'en');
  hub.save('Connection', { ...saved, expectedRevision: saved.revision, entry: { ...entry, multimodal: true } }, 'en');
  expect(() => hub.save('Connection', { ...saved, expectedRevision: saved.revision }, 'en')).toThrow('changed');
  mkdirSync(join(root, 'Occupied'));
  expect(() => hub.save(null, { name: 'Occupied', entry }, 'en')).toThrow('exists');
  const fresh = hub.detail('Connection', 'en');
  expect(() => hub.save('Connection', { ...fresh, expectedRevision: fresh.revision, entry: { ...entry, kind: 'llamacpp' } }, 'en')).toThrow('cannot be changed');
});
it('renames historical directories and every deployment reference while retaining module-owned files', () => {
  const { hub, cfg, root, file, temp } = fixture();
  const old = '历史.name'; mkdirSync(join(root, old));
  writeFileSync(join(root, old, 'config.json'), JSON.stringify(entry));
  writeFileSync(join(root, old, 'owned.txt'), 'retained');
  writeFileSync(file, JSON.stringify({ activeProvider: old }));
  const other = join(temp.dir, 'other'); mkdirSync(other);
  writeFileSync(join(other, 'deployment.json'), '{}');
  writeFileSync(join(other, 'config.json'), JSON.stringify({ activeProvider: old, unrelated: 7 }));
  const saved = hub.detail(old, 'en');
  hub.save(old, { ...saved, name: 'Renamed', expectedRevision: saved.revision }, 'en');
  expect(existsSync(join(root, old))).toBe(false);
  expect(readFileSync(join(root, 'Renamed', 'owned.txt'), 'utf8')).toBe('retained');
  expect(cfg.activeProvider).toBe('Renamed');
  expect(JSON.parse(readFileSync(join(other, 'config.json'), 'utf8'))).toEqual({ activeProvider: 'Renamed', unrelated: 7 });
  expect(() => hub.delete('Renamed', hub.detail('Renamed', 'en').revision)).toThrow('other');
});
it('missing modules remain visible and cannot be activated', () => {
  const { hub, root } = fixture();
  mkdirSync(join(root, 'Legacy'));
  writeFileSync(join(root, 'Legacy', 'config.json'), JSON.stringify({ ...entry, kind: 'removed-module' }));
  expect(hub.list('en').providers[0].readiness.state).toBe('module-missing');
  expect(() => hub.activate('Legacy', 'en')).toThrow('unavailable');
});
it.each(['../escape', 'CON', 'lpt1', 'Name ', 'name.', '中文', 'two words'])('rejects unsafe new name %s', name => {
  expect(validateProviderName(name)).not.toBeNull();
});

it('copies saved credentials only on final creation, without exposing them in detail responses', () => {
  const { hub, root } = fixture();
  const source = hub.save(null, { name: 'Source', entry, secretValue: 'test-secret' }, 'en');
  expect(JSON.stringify(source)).not.toContain('test-secret');
  expect(existsSync(join(root, 'Copy'))).toBe(false);
  hub.save(null, { name: 'Copy', entry: source.entry, copyFrom: { name: source.name, revision: source.revision } }, 'en');
  expect(readFileSync(join(root, 'Copy', '.env'), 'utf8')).toContain('test-secret');
});

it('an endpoint without a key variable keeps its .env out of a copy', () => {
  const { hub, root } = fixture();
  const source = hub.save(null, { name: 'Account', entry }, 'en');
  writeFileSync(join(root, 'Account', '.env'), 'ACCOUNT_REFRESH_TOKEN=signed-in\n');
  hub.save(null, { name: 'Copy', entry: source.entry, copyFrom: { name: source.name, revision: hub.detail('Account', 'en').revision } }, 'en');
  expect(existsSync(join(root, 'Copy', '.env'))).toBe(false);
});

it.skipIf(process.platform === 'win32')('writes a saved key readable by its owner alone', () => {
  const { hub, root } = fixture();
  hub.save(null, { name: 'Alpha', entry, secretValue: 'alpha-key' }, 'en');
  expect(statSync(join(root, 'Alpha', '.env')).mode & 0o777).toBe(0o600);
});

it('switches the current connection without replacing instances already serving requests', () => {
  const { hub, registry } = fixture();
  hub.save(null, { name: 'Alpha', entry }, 'en');
  hub.save(null, { name: 'Beta', entry: { ...entry, spec: { model: 'other-model', thinking: false } } }, 'en');
  hub.activate('Alpha', 'en');
  const instance = registry.resolve('Alpha');
  hub.activate('Beta', 'en');
  expect(registry.resolve('Alpha')).toBe(instance);
  expect(hub.current('en')).toMatchObject({ name: 'Beta', model: 'other-model', ready: true });
});

it('rejects credentials changed in another process without overwriting them', () => {
  const { hub, root } = fixture();
  const saved = hub.save(null, { name: 'Alpha', entry, secretValue: 'first-key' }, 'en');
  writeFileSync(join(root, 'Alpha', '.env'), 'CORTICO_KEY_ALPHA=changed-key\n');
  expect(() => hub.save('Alpha', { ...saved, expectedRevision: saved.revision, secretValue: 'stale-key' }, 'en')).toThrow('changed');
  expect(readFileSync(join(root, 'Alpha', '.env'), 'utf8')).toContain('changed-key');
});

it('reports other deployment selections and live ownership without claiming stopped instances are running', () => {
  const { hub, temp } = fixture();
  hub.save(null, { name: 'Shared', entry }, 'en');
  const other = join(temp.dir, 'other');
  const data = join(other, 'custom-data'); mkdirSync(data, { recursive: true });
  writeFileSync(join(other, 'deployment.json'), '{}');
  writeFileSync(join(other, 'config.json'), JSON.stringify({ activeProvider: 'Shared', paths: { data: 'custom-data' } }));
  expect(hub.list('en').providers[0].usage).toEqual([{ name: 'other', running: false }]);
  const lock = acquireInstanceLock(data);
  try { expect(hub.list('en').providers[0].usage).toEqual([{ name: 'other', running: true }]); }
  finally { lock.release(); }
  expect(hub.list('en').providers[0].usage).toEqual([{ name: 'other', running: false }]);
});

it('probes and lists models on a browser draft with its typed key, writing nothing', async () => {
  const { hub, root, cfg } = fixture();
  const seen: Array<{ url: string; auth: string | null }> = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    seen.push({ url, auth: new Headers(init?.headers).get('authorization') });
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'listed-model' }] }));
    const events: string[] = [];
    const stream = new FixtureStream(JSON.parse(String(init?.body)), event => events.push(`data: ${JSON.stringify(event)}\n\n`));
    stream.feed({ type: 'content', text: 'pong' });
    stream.finish({ promptTokens: 1, completionTokens: 1, cacheHitTokens: 0, cacheMissTokens: 1 });
    return new Response(events.join(''), { headers: { 'content-type': 'text/event-stream' } });
  });
  try {
    expect(await hub.action('draft', 'models', 'en', { entry, secretValue: 'typed-key' })).toEqual({ models: [{ id: 'listed-model' }] });
    expect(await hub.action('draft', 'test', 'en', { entry, secretValue: 'typed-key' })).toMatchObject({ ok: true, status: 200, model: 'test-model' });
    expect(seen.map(call => call.auth)).toEqual(['Bearer typed-key', 'Bearer typed-key']);
    expect(existsSync(join(root, 'draft'))).toBe(false);
    expect(cfg.providers).toEqual({});
    await expect(hub.action('draft', 'test', 'en', { entry: { ...entry, spec: undefined } })).rejects.toThrow('Model');
    expect(await hub.action('draft', 'models', 'en', { entry: { ...entry, spec: { model: '', thinking: false } } })).toEqual({ models: [{ id: 'listed-model' }] });
    await expect(hub.action('draft', 'test', 'en', { entry: { ...entry, kind: 'removed-module' } })).rejects.toThrow('unavailable');
  } finally { vi.unstubAllGlobals(); }
});

it('lists models and probes a saved endpoint without a draft; a 404 probe points at the URL and path', async () => {
  const { hub } = fixture();
  hub.save(null, { name: 'cloud', entry: {
    ...entry, spec: { model: 'test-model', thinking: true, reasoningEffort: 'low', maxTokens: 4096 },
    pricing: [{ models: ['*'], currency: 'USD', basis: 'marginal', source: 'webui', rules: [{ meter: 'input', perMillion: 1 }, { meter: 'output', perMillion: 2 }] }],
  } }, 'en');
  let status = 200;
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'test-model' }] }));
    bodies.push(JSON.parse(String(init?.body)));
    if (status !== 200) return new Response('no route', { status });
    const response = {
      id: 'r', model: 'test-model', status: 'completed', service_tier: null,
      output: [{ type: 'reasoning', id: 'rs', summary: [], content: [], encrypted_content: 'sig' }, { type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'pong', annotations: [] }] }],
      usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 4 } },
    };
    const events = [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [], usage: null } },
      ...response.output.flatMap((item, output_index) => [
        { type: 'response.output_item.added', output_index, item },
        { type: 'response.output_item.done', output_index, item },
      ]),
      { type: 'response.completed', response },
    ];
    return new Response(events.map((event, sequence_number) => `data: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(''),
      { headers: { 'content-type': 'text/event-stream' } });
  });
  try {
    expect(await hub.action('cloud', 'models', 'en')).toEqual({ models: [{ id: 'test-model' }] });
    const ok = await hub.action('cloud', 'test', 'en') as Record<string, unknown>;
    expect(ok).toMatchObject({ ok: true, status: 200, model: 'test-model', encryptedReasoning: true, usage: { input: 10, cachedInput: 4, output: 5, reasoning: null } });
    expect(ok.charges).toEqual([{ currency: 'USD', amount: 20 / 1e6 }]);
    expect(bodies[0]).toMatchObject({ max_output_tokens: PROBE_MAX_OUTPUT_TOKENS, reasoning: { effort: 'low' }, store: false });
    status = 404;
    expect(await hub.action('cloud', 'test', 'en')).toMatchObject({ ok: false, status: 404, hint: text('en').probeNoResponses });
    expect(bodies).toHaveLength(2);
  } finally { vi.unstubAllGlobals(); }
});

it('module list carries the editor sections of each module in its declared order', () => {
  const { hub, settings } = fixture();
  const sections = Object.fromEntries(hub.moduleList('en').map(module => [module.id, module.sections.map(section => section.id)]));
  expect(sections.llamacpp).toEqual(['endpoint', 'runtime', 'models', 'model', 'pricing', 'protocol']);
  expect(sections['openai-responses-compat']).toEqual(['endpoint', 'model', 'reasoning', 'pricing', 'protocol']);
  expect(hub.moduleList('en').find(module => module.id === 'llamacpp')!.sections[0]).toMatchObject({ builtin: 'connection-endpoint', title: 'Server address' });
  for (const module of hub.moduleList('en')) {
    const declared = settings.sources().find(source => source.id === `llm:${module.id}`)!.contribute('en')!.panels!;
    expect(module.sections.map(section => section.defaultOpen)).toEqual(declared.map(panel => panel.defaultOpen));
  }
});
