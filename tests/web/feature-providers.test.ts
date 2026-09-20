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
async function fixture(names = ['Alpha', 'Beta'], active = names[0] ?? '') {
  const calls: Array<{ path: string; body: any }> = [];
  const detail = (name: string) => ({ name, entry: structuredClone(entry), revision: 'r1', secretConfigured: 'none', readiness: { state: 'ready' }, config: [], references: [] });
  vi.stubGlobal('fetch', async (path: string, init: any) => {
    calls.push({ path, body: init.body ? JSON.parse(init.body) : null });
    let result: unknown = {};
    if (path === '/api/providers') result = { active, providers: names.map(name => ({ id: name, name, module: 'sample', moduleTitle: 'Sample driver', model: 'test-model', baseUrl: entry.baseUrl, active: name === active, readiness: { state: 'ready' }, revision: 'r1' })) };
    else if (path === '/api/provider-modules') result = [{ id: 'sample', title: 'Sample driver', description: 'A sample connection', defaultBaseUrl: entry.baseUrl, reasoningTiers: [], serviceTiers: [] }];
    else if (path === '/api/provider-modules/config') result = [];
    else if (/\/activate$/.test(path)) active = decodeURIComponent(path.split('/')[3]);
    else if (/^\/api\/providers\/[^/]+$/.test(path)) result = detail(decodeURIComponent(path.split('/')[3]));
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const root = document.createElement('div'); document.body.append(root);
  const lifecycle = new Lifecycle(() => {}); lifecycles.push(lifecycle);
  const ui = createConsoleUi({ memo: { get: (_: string, fallback: unknown) => fallback, set: () => {} }, overlayHost: document.body, signal: lifecycle.signal, doc: document });
  const ctx = { root, ui, lifecycle, signal: lifecycle.signal, route: { segments: ['providers'] }, router: { addLeaveGuard: () => ({ dispose() {} }), onChange: () => ({ dispose() {} }) }, onError: (error: unknown) => { throw error; }, capabilities: {} };
  await mountProviders(ctx); await flush(); return { root, calls, ctx };
}
afterEach(() => { lifecycles.splice(0).forEach(life => life.dispose()); vi.unstubAllGlobals(); document.body.replaceChildren(); localStorage.clear(); });
it('uses one connection navigation entry without provider lamps', () => { expect(providersFeature.route).toBe('providers'); expect(providersFeature.lampId).toBeUndefined(); });
it('selection preserves active connection and card DOM', async () => {
  const { root, calls } = await fixture();
  const cards = [...root.querySelectorAll('.connection-card')];
  (cards[1].querySelector('button') as HTMLButtonElement).click(); await flush();
  expect(root.querySelectorAll('.connection-card')[0]).toBe(cards[0]);
  expect(cards[0].classList.contains('is-active')).toBe(true);
  expect(cards[1].classList.contains('is-selected')).toBe(true);
  expect(calls.some(call => call.path.endsWith('/activate'))).toBe(false);
});
it('activation leaves selected detail and unsaved input in place', async () => {
  const { root } = await fixture();
  const input = root.querySelector('[aria-label="供应商名称"]') as HTMLInputElement;
  input.value = 'Edited'; input.dispatchEvent(new Event('input'));
  (root.querySelectorAll('.connection-card')[1].querySelectorAll('button')[1] as HTMLButtonElement).click(); await flush();
  expect(root.querySelector('[aria-label="供应商名称"]')).toBe(input);
  expect(input.value).toBe('Edited');
  expect(root.querySelectorAll('.connection-card')[1].classList.contains('is-active')).toBe(true);
});
it('new drafts make no server mutation and cancel removes the card', async () => {
  const { root, calls } = await fixture([]);
  expect(root.textContent).toContain('还没有模型供应商');
  (root.querySelector('.connection-index>button') as HTMLButtonElement).click(); await flush();
  expect(root.querySelectorAll('.connection-card')).toHaveLength(1);
  expect(root.querySelector('.connection-status')?.textContent).toBe('草稿');
  expect(calls.filter(call => call.body && call.path !== '/api/provider-modules/config')).toHaveLength(0);
  ([...root.querySelectorAll('button')].find(button => button.textContent === '取消') as HTMLButtonElement).click(); await flush();
  expect(root.querySelectorAll('.connection-card')).toHaveLength(0);
});
it('field editing is local and saved modules stay readonly', async () => {
  const { root, calls } = await fixture();
  const input = root.querySelector('[aria-label="API 地址"]') as HTMLInputElement;
  input.value = 'https://edited.test'; input.dispatchEvent(new Event('input')); await flush();
  expect(calls.some(call => call.path.endsWith('/save'))).toBe(false);
  expect(root.querySelector('select[aria-label="供应商类型"]')).toBeNull();
  expect(root.querySelectorAll('details')[2]?.open).toBe(false);
});
it('missing active references are displayed without selecting a replacement as active', async () => {
  const { root } = await fixture(['Alpha'], 'Gone');
  expect(root.textContent).toContain('当前模型供应商不存在，配置中引用：Gone');
  expect(root.querySelector('.is-active')).toBeNull();
});

it('saved drafts restore after remount without changing the server configuration', async () => {
  const { root, ctx, calls } = await fixture();
  const input = root.querySelector('[aria-label="API 地址"]') as HTMLInputElement;
  input.value = 'https://draft.test'; input.dispatchEvent(new Event('input'));
  ([...root.querySelectorAll('button')].find(button => button.textContent === '保存草稿') as HTMLButtonElement).click(); await flush();
  expect(calls.some(call => call.path.endsWith('/save'))).toBe(false);
  ctx.lifecycle.dispose(); root.remove();
  const remounted = await fixture();
  expect((remounted.root.querySelector('[aria-label="API 地址"]') as HTMLInputElement).value).toBe('https://draft.test');
});
it('switching away from edits offers stay, discard and save', async () => {
  const { root } = await fixture();
  const input = root.querySelector('[aria-label="API 地址"]') as HTMLInputElement;
  input.value = 'https://draft.test'; input.dispatchEvent(new Event('input'));
  (root.querySelectorAll('.connection-card')[1].querySelector('button') as HTMLButtonElement).click(); await flush();
  const dialog = document.querySelector('dialog')!;
  expect(dialog.textContent).toContain('放弃更改并切换');
  expect(dialog.textContent).toContain('保存');
  (dialog.querySelector('button') as HTMLButtonElement).click(); await flush();
  expect(root.querySelectorAll('.connection-card')[0].classList.contains('is-selected')).toBe(true);
});
