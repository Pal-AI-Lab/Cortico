import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeCfg, makeTmpDir } from '../core/helpers.ts';
import { nullLogger } from '../../src/core/util.ts';
import { ProviderRegistry } from '../../src/providers/registry.ts';
import { ProviderSettings } from '../../src/providers/console/settings.ts';
import { ProviderHub } from '../../src/providers/console/hub.ts';
import { validateProviderName } from '../../src/providers/name.ts';

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
  return { hub, cfg, root, file, temp, registry };
}
const entry = { kind: 'openai-responses-compat', baseUrl: 'https://model.test', spec: { model: 'test-model', thinking: false } };

it('new environments remain empty until a validated connection is saved', () => {
  const { hub, root } = fixture();
  expect(hub.list('en').providers).toEqual([]);
  expect(() => hub.save(null, { name: 'Connection', entry: { ...entry, spec: undefined } }, 'en')).toThrow('Model');
  expect(existsSync(join(root, 'Connection'))).toBe(false);
  hub.save(null, { name: 'Connection', entry, secretValue: 'test-key' }, 'en');
  expect(readFileSync(join(root, 'Connection', '.env'), 'utf8')).toContain('CORTICO_PROVIDER_API_KEY=test-key');
  expect(hub.list('en').providers[0].readiness.state).toBe('ready');
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
  writeFileSync(join(root, 'Alpha', '.env'), 'CORTICO_PROVIDER_API_KEY=changed-key\n');
  expect(() => hub.save('Alpha', { ...saved, expectedRevision: saved.revision, secretValue: 'stale-key' }, 'en')).toThrow('changed');
  expect(readFileSync(join(root, 'Alpha', '.env'), 'utf8')).toContain('changed-key');
});
