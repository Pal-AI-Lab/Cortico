/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';
const UI = '../../src/web/client/ui/index.ts';
const LIFE = '../../src/web/client/core/lifecycle.ts';
const FEATURE = '../../src/web/client/features/providers/index.ts';
const { createConsoleUi } = await import(UI);
const { Lifecycle } = await import(LIFE);
const { mountProviders, providersFeature } = await import(FEATURE);
const lifecycles: any[] = [];
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const entry = { kind: 'sample', baseUrl: 'https://model.test', spec: { model: 'test-model', thinking: false } };
const BLOCKS = { endpoint: { id: 'endpoint', title: '连接', builtin: 'connection-endpoint', defaultOpen: true }, model: { id: 'model', title: '模型与生成', builtin: 'connection-model', defaultOpen: true }, pricing: { id: 'pricing', title: '成本与计价', builtin: 'connection-pricing', defaultOpen: false }, protocol: { id: 'protocol', title: '高级协议', builtin: 'connection-protocol', defaultOpen: false } };
const DEFAULT_SECTIONS = [BLOCKS.endpoint, BLOCKS.model, BLOCKS.pricing, BLOCKS.protocol];
interface FixtureOptions { sections?: typeof DEFAULT_SECTIONS; usage?: Array<{ name: string; running: boolean }>; readiness?: string; secretConfigured?: string }
async function fixture(names = ['Alpha', 'Beta'], active = names[0] ?? '', { sections = DEFAULT_SECTIONS, usage = [], readiness = 'ready', secretConfigured = 'none' }: FixtureOptions = {}) {
  const calls: Array<{ path: string; body: any }> = [];
  const detail = (name: string) => ({ name, entry: structuredClone(entry), revision: 'r1', secretConfigured, readiness: { state: 'ready' }, config: [], references: [] });
  vi.stubGlobal('fetch', async (path: string, init: any) => {
    calls.push({ path, body: init.body ? JSON.parse(init.body) : null });
    let result: unknown = {};
    if (path === '/api/providers') result = { active, providers: names.map(name => ({ id: name, name, module: 'sample', moduleTitle: 'Sample driver', model: 'test-model', baseUrl: entry.baseUrl, active: name === active, usage, readiness: { state: readiness }, revision: 'r1' })) };
    else if (path === '/api/provider-modules') result = [{ id: 'sample', title: 'Sample driver', description: 'A sample connection', defaultBaseUrl: entry.baseUrl, reasoningTiers: [], serviceTiers: [], sections }];
    else if (path === '/api/provider-modules/config') result = [];
    else if (/\/activate$/.test(path)) active = decodeURIComponent(path.split('/')[3]);
    else if (/\/delete$/.test(path)) names = names.filter(name => name !== decodeURIComponent(path.split('/')[3]));
    else if (/\/test$/.test(path)) result = { ok: true, status: 200, elapsedMs: 1234, model: 'probe-model', usage: { input: 10, cachedInput: 0, output: 5, reasoning: 0 }, encryptedReasoning: false, charges: [] };
    else if (/^\/api\/providers\/[^/]+$/.test(path)) result = detail(decodeURIComponent(path.split('/')[3]));
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const root = document.createElement('div'); document.body.append(root);
  const lifecycle = new Lifecycle(() => {}); lifecycles.push(lifecycle);
  const ui = createConsoleUi({ memo: { get: (_: string, fallback: unknown) => fallback, set: () => {} }, overlayHost: document.body, signal: lifecycle.signal, doc: document });
  const ctx = { root, ui, lifecycle, signal: lifecycle.signal, route: { segments: ['providers'] }, router: { addLeaveDecision: () => ({ dispose() {} }), onChange: () => ({ dispose() {} }) }, onError: (error: unknown) => { throw error; }, capabilities: {} };
  await mountProviders(ctx); await flush(); return { root, calls, ctx };
}
afterEach(() => { lifecycles.splice(0).forEach(life => life.dispose()); vi.unstubAllGlobals(); document.body.replaceChildren(); localStorage.clear(); });
it('uses one connection navigation entry without provider lamps', () => { expect(providersFeature.route).toBe('providers'); expect(providersFeature.lampId).toBeUndefined(); });
it('selection preserves active connection and card DOM', async () => {
  const { root, calls } = await fixture();
  const cards = [...root.querySelectorAll('.connection-card')];
  (cards[1] as HTMLElement).click(); await flush();
  expect(root.querySelectorAll('.connection-card')[0]).toBe(cards[0]);
  expect(cards[0].classList.contains('is-active')).toBe(true);
  expect(cards[1].classList.contains('is-selected')).toBe(true);
  expect(calls.some(call => call.path.endsWith('/activate'))).toBe(false);
});
it('activation leaves selected detail and unsaved input in place', async () => {
  const { root } = await fixture();
  const input = root.querySelector('[aria-label="供应商名称"]') as HTMLInputElement;
  input.value = 'Edited'; input.dispatchEvent(new Event('input'));
  (root.querySelectorAll('.connection-card')[1].querySelector('.connection-activate') as HTMLButtonElement).click(); await flush();
  expect(root.querySelector('[aria-label="供应商名称"]')).toBe(input);
  expect(input.value).toBe('Edited');
  expect(root.querySelectorAll('.connection-card')[1].classList.contains('is-active')).toBe(true);
});
it('new drafts make no server mutation and cancel removes the card', async () => {
  const { root, calls } = await fixture([]);
  expect(root.textContent).toContain('还没有模型供应商');
  (root.querySelector('.connection-create > button') as HTMLButtonElement).click(); await flush();
  expect(root.querySelectorAll('.connection-card')).toHaveLength(1);
  expect(root.querySelector('.connection-status')?.textContent).toBe('✎ 草稿');
  expect(calls.filter(call => call.body && call.path !== '/api/provider-modules/config')).toHaveLength(0);
  ([...root.querySelectorAll('button')].find(button => button.textContent === '放弃更改') as HTMLButtonElement).click(); await flush();
  expect(root.querySelectorAll('.connection-card')).toHaveLength(0);
});
it('field editing is local and saved modules stay readonly', async () => {
  const { root, calls } = await fixture();
  const input = root.querySelector('[aria-label="API 地址"]') as HTMLInputElement;
  input.value = 'https://edited.test'; input.dispatchEvent(new Event('input')); await flush();
  expect(calls.some(call => call.path.endsWith('/save'))).toBe(false);
  expect(root.querySelector('select[aria-label="供应商类型"]')).toBeNull();
  expect((root.querySelector('input[aria-label="供应商类型"]') as HTMLInputElement).readOnly).toBe(true);
  expect(([...root.querySelectorAll('details')].find(card => card.textContent?.includes('成本与计价')) as HTMLDetailsElement).open).toBe(false);
});
it('the editor lays its sections out in the order the module declared', async () => {
  const { root } = await fixture(['Alpha'], 'Alpha', { sections: [BLOCKS.model, BLOCKS.protocol, BLOCKS.endpoint] });
  expect([...root.querySelectorAll('.connection-flow .connection-step h3')].map(node => node.textContent)).toEqual(['模型与生成', '高级协议', '连接']);
  expect(root.querySelector('.connection-identity [aria-label="供应商名称"]')).not.toBeNull();
});
it('missing active references are displayed without selecting a replacement as active', async () => {
  const { root } = await fixture(['Alpha'], 'Gone');
  expect(root.textContent).toContain('当前模型供应商不存在，配置中引用：Gone');
  expect(root.querySelector('.is-active')).toBeNull();
});

it('edits persist as a browser draft on their own and restore after remount without touching the server', async () => {
  const { root, ctx, calls } = await fixture();
  const input = root.querySelector('[aria-label="API 地址"]') as HTMLInputElement;
  input.value = 'https://draft.test'; input.dispatchEvent(new Event('input')); await flush();
  expect(calls.some(call => call.path.endsWith('/save'))).toBe(false);
  expect(root.querySelector('[data-provider="Alpha"] .connection-secondary')?.textContent).toBe('✎ 草稿');
  ctx.lifecycle.dispose(); root.remove();
  const remounted = await fixture();
  expect((remounted.root.querySelector('[aria-label="API 地址"]') as HTMLInputElement).value).toBe('https://draft.test');
});
it('a form edited back to its saved state drops the draft', async () => {
  const { root } = await fixture();
  const input = root.querySelector('[aria-label="API 地址"]') as HTMLInputElement;
  input.value = 'https://draft.test'; input.dispatchEvent(new Event('input')); await flush();
  input.value = entry.baseUrl; input.dispatchEvent(new Event('input')); await flush();
  expect(root.querySelector('[data-provider="Alpha"] .connection-secondary')?.textContent).toBe('');
  expect(localStorage.length === 0 || !Object.values(localStorage).join('').includes('draft.test')).toBe(true);
});
it('switching away keeps the edits and shows them again on return', async () => {
  const { root } = await fixture();
  const input = root.querySelector('[aria-label="API 地址"]') as HTMLInputElement;
  input.value = 'https://draft.test'; input.dispatchEvent(new Event('input')); await flush();
  (root.querySelectorAll('.connection-card')[1] as HTMLElement).click(); await flush();
  expect(document.querySelector('dialog')).toBeNull();
  expect(root.querySelectorAll('.connection-card')[1].classList.contains('is-selected')).toBe(true);
  (root.querySelectorAll('.connection-card')[0] as HTMLElement).click(); await flush();
  expect((root.querySelector('[aria-label="API 地址"]') as HTMLInputElement).value).toBe('https://draft.test');
});

it('uses the shared page heading and never persists API Keys in browser drafts', async () => {
  const { root } = await fixture();
  expect(root.querySelector('header.featureintro > h1.pagetitle')?.textContent).toBe('模型供应商');
  const key = root.querySelector('[aria-label="API Key"]') as HTMLInputElement;
  key.value = 'private-test-key'; key.dispatchEvent(new Event('input')); await flush();
  expect(root.querySelector('[data-provider="Alpha"] .connection-secondary')?.textContent).toBe('✎ 草稿');
  expect(Object.values(localStorage).join('')).not.toContain('private-test-key');
});
it('a new draft keeps its card when the operator switches away', async () => {
  const { root } = await fixture();
  (root.querySelector('.connection-create > button') as HTMLButtonElement).click(); await flush();
  expect(root.querySelector('.connection-card .connection-name')?.textContent).toBe('未命名实例');
  const input = root.querySelector('[aria-label="供应商名称"]') as HTMLInputElement;
  input.value = 'Unsaved'; input.dispatchEvent(new Event('input')); await flush();
  (root.querySelector('[data-provider="Alpha"]') as HTMLElement).click(); await flush();
  expect(root.querySelectorAll('.connection-card')).toHaveLength(3);
  expect(root.querySelector('.connection-card .connection-name')?.textContent).toBe('Unsaved');
  expect(root.querySelector('.is-selected')?.getAttribute('data-provider')).toBe('Alpha');
});

it('ordinary connection names do not inherit phantom browser drafts', async () => {
  const { root } = await fixture(['constructor']);
  expect(root.querySelector('.connection-secondary')?.textContent).toBe('');
  expect(root.querySelector('[aria-label="供应商名称"]')?.getAttribute('aria-invalid')).not.toBe('true');
});

it('deleting from a card asks once on the button and carries the revision it listed', async () => {
  const { root, calls } = await fixture();
  const erase = root.querySelector('[data-provider="Beta"] .connection-erase') as HTMLButtonElement;
  erase.click(); await flush();
  expect(erase.classList.contains('is-armed')).toBe(true);
  expect(calls.some(call => call.path.endsWith('/delete'))).toBe(false);
  root.click(); await flush();
  expect(erase.classList.contains('is-armed')).toBe(false);
  erase.click(); erase.click(); await flush();
  const deletion = calls.find(call => call.path.endsWith('/delete'))!;
  expect(deletion.path).toBe('/api/providers/Beta/delete');
  expect(deletion.body).toEqual({ expectedRevision: 'r1' });
  expect(root.querySelector('[data-provider="Beta"]')).toBeNull();
});

it('cards carry no probe; the saved connection is tested from its detail form', async () => {
  const { root, calls } = await fixture();
  expect(root.querySelector('.connection-card button:not(.connection-erase):not(.connection-activate)')).toBeNull();
  ([...root.querySelectorAll('button')].find(button => button.textContent === '测试连接') as HTMLButtonElement).click(); await flush();
  expect(calls.some(call => call.path === '/api/providers/Alpha/test')).toBe(true);
  expect(root.textContent).toContain('HTTP 200');
  expect(root.textContent).toContain('probe-model');
  expect(root.querySelector('.connection-test button + .msgline')?.textContent).toContain('HTTP 200');
});

it('the editor probes and lists models on the unsaved form, key included, without saving', async () => {
  const { root, calls } = await fixture();
  const url = root.querySelector('[aria-label="API 地址"]') as HTMLInputElement;
  url.value = 'https://edited.test'; url.dispatchEvent(new Event('input'));
  const key = root.querySelector('[aria-label="API Key"]') as HTMLInputElement;
  key.value = 'typed-key'; key.dispatchEvent(new Event('input'));
  ([...root.querySelectorAll('button')].find(button => button.textContent === '测试连接') as HTMLButtonElement).click(); await flush();
  const probe = calls.find(call => call.path === '/api/providers/Alpha/test')!;
  expect(probe.body).toMatchObject({ entry: { baseUrl: 'https://edited.test' }, secretValue: 'typed-key' });
  ([...root.querySelectorAll('button')].find(button => button.textContent === '获取模型列表') as HTMLButtonElement).click(); await flush();
  expect(calls.find(call => call.path === '/api/providers/Alpha/models')!.body).toMatchObject({ entry: { baseUrl: 'https://edited.test' } });
  expect(calls.some(call => call.path.endsWith('/save'))).toBe(false);
});

it('a saved connection offers discard only while the form differs from what is saved', async () => {
  const { root } = await fixture();
  const cancel = () => [...root.querySelectorAll('button')].find(button => button.textContent === '放弃更改') as HTMLButtonElement;
  expect(cancel().hidden).toBe(true);
  const input = root.querySelector('[aria-label="API 地址"]') as HTMLInputElement;
  input.value = 'https://draft.test'; input.dispatchEvent(new Event('input')); await flush();
  expect(cancel().hidden).toBe(false);
  cancel().click(); await flush();
  expect((root.querySelector('[aria-label="API 地址"]') as HTMLInputElement).value).toBe(entry.baseUrl);
  expect(cancel().hidden).toBe(true);
});

it('a new connection uses the declared initial section states and marks required fields', async () => {
  const { root } = await fixture();
  (root.querySelector('.connection-create > button') as HTMLButtonElement).click(); await flush();
  expect(root.querySelector('.connection-flow')).toBeNull();
  expect(root.querySelector('.connection-module-hint')?.textContent).toBe('请选择供应商类型。');
  const select = root.querySelector('select[aria-label="供应商类型"]') as HTMLSelectElement;
  select.value = 'sample'; select.dispatchEvent(new Event('change')); await flush();
  expect(root.querySelector('.connection-flow')).not.toBeNull();
  expect(root.querySelector('.connection-module-hint')?.textContent).toBe('');
  const folds = [...root.querySelectorAll<HTMLDetailsElement>('.connection-flow > .connection-step > details')];
  expect(folds.map(section => section.open)).toEqual([true, true, false, false]);
  expect(root.querySelector('.fieldlabel .required-mark')?.textContent).toContain('*');
  expect(root.querySelector('[role="switch"][aria-label="接受图片"]')).not.toBeNull();
});

it('hides the connect control for endpoints that are not ready or are used by a running deployment', async () => {
  const unavailable = await fixture(['Alpha'], '', { readiness: 'needs-setup' });
  expect((unavailable.root.querySelector('.connection-connect') as HTMLElement).hidden).toBe(true);
  expect((unavailable.root.querySelector('.connection-status') as HTMLElement).dataset.tone).toBe('error');
  unavailable.ctx.lifecycle.dispose(); unavailable.root.remove();
  const occupied = await fixture(['Alpha'], '', { usage: [{ name: 'Other', running: true }] });
  expect((occupied.root.querySelector('.connection-connect') as HTMLElement).hidden).toBe(true);
  expect(occupied.root.querySelector('.connection-status')?.textContent).toContain('其他实例使用中：Other');
  expect((occupied.root.querySelector('.connection-status') as HTMLElement).dataset.tone).toBe('active');
  occupied.ctx.lifecycle.dispose(); occupied.root.remove();
  const idle = await fixture(['Alpha'], '', { usage: [{ name: 'Other', running: false }] });
  expect((idle.root.querySelector('.connection-connect') as HTMLElement).hidden).toBe(false);
  expect(idle.root.querySelector('.connection-secondary')?.textContent).toBe('已被 Other 选用（未运行）');
});

it('saved keys show a masked placeholder without staging a replacement secret', async () => {
  const { root, calls } = await fixture(['Alpha'], 'Alpha', { secretConfigured: 'file' });
  const key = root.querySelector('[aria-label="API Key"]') as HTMLInputElement;
  expect(key.type).toBe('password');
  expect(key.placeholder).toBe('••••••••');
  expect(key.value).toBe('');
  ([...root.querySelectorAll('button')].find(button => button.textContent === '保存') as HTMLButtonElement).click(); await flush();
  expect(calls.find(call => call.path.endsWith('/save'))?.body).not.toHaveProperty('secretValue');
});
