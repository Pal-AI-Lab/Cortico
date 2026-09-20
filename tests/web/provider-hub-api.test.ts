import { expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeCfg, makeTmpDir } from '../core/helpers.ts';
import { nullLogger } from '../../src/core/util.ts';
import { ProviderRegistry } from '../../src/providers/registry.ts';
import { ProviderSettings } from '../../src/providers/console/settings.ts';
import { ProviderHub } from '../../src/providers/console/hub.ts';
import { WebApp } from '../../src/web/server.ts';
import { FakeStore } from './fakes.ts';

it('connection APIs reject partial and stale saves, preserve protocol objects and update status', async () => {
  const temp = makeTmpDir();
  const root = join(temp.dir, 'providers'); mkdirSync(root);
  const file = join(temp.dir, 'config.json'); writeFileSync(file, '{}');
  const cfg = makeCfg({ providers: {}, activeProvider: '' });
  const registry = new ProviderRegistry(() => cfg.providers, { stateRoot: root, readBlob: () => null, keepThinking: () => true, log: nullLogger() });
  const settings = new ProviderSettings(cfg, registry, file, root);
  const hub = new ProviderHub(cfg, registry, settings, file, root);
  const app = new WebApp({ store: new FakeStore(), memoryDir: temp.dir, dataDir: temp.dir,
    webDistDir: join(temp.dir, 'no-dist'), log: nullLogger(), providers: hub,
    getStatus: () => ({ modelConnection: hub.current('en') }) });
  try {
    const port = await app.start(0);
    const base = `http://127.0.0.1:${port}`;
    const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const entry = { kind: 'openai-responses-compat', baseUrl: 'https://example.invalid', spec: { model: 'test-model', thinking: false }, options: { extraHeaders: { 'X-Test': 'value' }, extraBody: { store: false } } };
    expect(((await (await fetch(base + '/api/providers')).json()) as ReturnType<ProviderHub['list']>).providers).toEqual([]);
    const invalid = await post('/api/providers', { name: 'Alpha', entry: { ...entry, spec: undefined } });
    expect(invalid.status).toBe(400);
    expect(existsSync(join(root, 'Alpha'))).toBe(false);
    const created = await post('/api/providers', { name: 'Alpha', entry });
    expect(created.status).toBe(200);
    const saved = await created.json() as ReturnType<ProviderHub['detail']>;
    expect(saved.entry.options?.extraHeaders).toEqual(entry.options.extraHeaders);
    expect(saved.entry.options?.extraBody).toEqual(entry.options.extraBody);
    expect((await post('/api/providers/Alpha/activate', {})).status).toBe(200);
    expect(((await (await fetch(base + '/api/status')).json()) as { modelConnection: ReturnType<ProviderHub['current']> }).modelConnection).toMatchObject({ name: 'Alpha', model: 'test-model', ready: true });
    expect((await post('/api/providers/Alpha/save', { name: 'Alpha', entry: { ...entry, multimodal: true }, expectedRevision: saved.revision })).status).toBe(200);
    expect((await post('/api/providers/Alpha/save', { name: 'Alpha', entry, expectedRevision: saved.revision })).status).toBe(409);
    const latest = await (await fetch(base + '/api/providers/Alpha')).json() as ReturnType<ProviderHub['detail']>;
    expect(latest.entry.multimodal).toBe(true);
    expect((await post('/api/providers/Alpha/delete', { expectedRevision: latest.revision })).status).toBe(409);
    expect(existsSync(join(root, 'Alpha', 'config.json'))).toBe(true);
  } finally { await app.stop(); temp.cleanup(); }
});

