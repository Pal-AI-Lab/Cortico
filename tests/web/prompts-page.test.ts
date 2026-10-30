// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { mountPrompts } from '../../src/web/client/features/prompts/index.ts';
import { S } from '../../src/web/client/features/prompts/strings.ts';
import { createWebUi } from '../../src/web/client/ui/index.ts';
import { Lifecycle } from '../../src/web/client/core/lifecycle.ts';
import { Router } from '../../src/web/client/core/router.ts';
import { WEBUI_PROTOCOL_VERSION } from '../../src/web/shared/webui-protocol.ts';

type Any = any;
/** 查询结果按 Any 用:测试里节点必在,缺了就让断言或调用直接失败。 */
const $ = (sel: string, from: ParentNode = document): Any => from.querySelector(sel);
const $$ = (sel: string, from: ParentNode = document): Any[] => [...from.querySelectorAll(sel)];

const worldKey = 'worlds.fixture.envPrompt';
let sources: Any, generated: Any, session: Any, writes: Any, sessionWrites: Any, saveGate: Any, sessionGate: Any, configAvailable: Any, failures: Any, mounted: Any;
const deferred = () => { let resolve; const promise = new Promise((done: Any) => { resolve = done; }); return { promise, resolve }; };
const json = (body: Any, status: Any = 200) => new Response(JSON.stringify(body), { status });
function prefix() {
  return [
    ...sources.filter((doc: Any) => doc.content).map((doc: Any) => ({ title: doc.key, sourceKey: doc.key, text: doc.content })),
    { title: 'WORKSPACE', text: generated },
  ];
}
beforeEach(() => {
  mounted = [];
  sources = [
    { key: 'constitution', title: 'Persona', role: 'prefix', content: 'Hello {{fixture.name}}', revision: '1', vars: [{ name: 'fixture.name', description: 'Name', value: 'Friend' }] },
    { key: worldKey, title: 'World template', role: 'envPrompt', content: 'Environment', revision: '1', origin: 'module' },
  ];
  generated = 'files.md'; session = []; writes = []; sessionWrites = [];
  saveGate = sessionGate = null; configAvailable = true; failures = new Set();
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  history.replaceState(null, '', '/#/prompts');
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  Range.prototype.getClientRects = (() => []) as Any;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  vi.stubGlobal('matchMedia', (media: Any) => ({ media, matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('fetch', async (path: Any, options: Any) => {
    if (path === '/api/theme') return json({ theme: null });
    if (path === '/api/status') return json({ displayName: 'Fixture', loop: { paused: true } });
    if (path === '/api/capabilities') return json({ capabilities: { worlds: true, prompts: true, config: true, storage: true, sessionControl: true } });
    if (path === '/api/config') return json({ groups: [{ group: { id: 'worlds.fixture', owner: 'world:fixture', schema: { title: 'Fixture configuration', properties: { 'worlds.fixture.name': { type: 'string', title: 'Fixture name' } } } }, values: { 'worlds.fixture.name': 'Friend' } }] });
    if (path === '/api/webui/lamps') return json({ lamps: {} });
    if (path === '/api/webui/manifest') return json({ protocolVersion: WEBUI_PROTOCOL_VERSION, framework: { capabilities: { config: configAvailable } }, providers: [
      { id: 'world:fixture', kind: 'world', label: 'Fixture World', availability: 'active', configGroups: ['worlds.fixture'], prompts: [{ key: worldKey }] },
    ] });
    if (path === '/api/prompts/prefix') return json({ segments: prefix() });
    if (path === '/api/prompts' && options.method === 'GET') return json({ prompts: sources });
    if (path === '/api/prompts') {
      const body = JSON.parse(options.body);
      writes.push(body);
      if (saveGate) await saveGate.promise;
      if (options.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const doc = sources.find((source: Any) => source.key === body.key);
      if (failures.has(doc.key) || doc.revision !== body.baseRevision) return json({ error: 'Revision conflict' }, 409);
      doc.content = body.content; doc.revision = String(Number(doc.revision) + 1);
      return json({ revision: doc.revision });
    }
    if (path === '/api/session/reload-prefix' || path === '/api/storage/clear?owner=core&key=session') {
      sessionWrites.push(path);
      if (sessionGate) await sessionGate.promise;
      if (options.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      session = prefix();
      return json({ ok: true });
    }
    throw new Error(`Unexpected request: ${path}`);
  });
});
afterEach(() => {
  for (const life of mounted) life.dispose();
  document.body.replaceChildren();
  delete (Range.prototype as Any).getClientRects;
  delete (Range.prototype as Any).getBoundingClientRect;
  vi.unstubAllGlobals();
});

async function mount() {
  const life = new Lifecycle((error: Any) => { throw error; });
  mounted.push(life);
  const root = document.createElement('div');
  document.body.append(root);
  const ui = createWebUi({ doc: document, overlayHost: document.body, signal: life.signal, memo: { get: (_: Any, fallback: Any) => fallback, set() {} } });
  const router = new Router({ win: window, confirmLeave: (body: Any) => ui.confirm({ title: 'Leave', body }) });
  life.own(router.start());
  await mountPrompts({ root, ui, router, route: router.route, signal: life.signal, lifecycle: life, capabilities: { prompts: true, storage: true, sessionControl: true }, onError: (error: Any) => { throw error; } });
  await vi.waitFor(() => expect($(`[data-source="${worldKey}"]`, root).textContent).toContain('Fixture World'));
  const view = EditorView.findFromDOM($('.cm-editor', root))!;
  const button = (label: Any) => $$('.prompt-actions button', root).find((el: Any) => el.textContent === label);
  const edit = (text: Any) => view.dispatch({ changes: { from: 0, insert: text }, userEvent: 'input.type' });
  return { root, life, router, view, button, edit };
}

it('serializes saves and keeps edits made during an apply unsaved, with usable undo afterwards', async () => {
  const { root, view, button, edit } = await mount();
  saveGate = deferred(); sessionGate = deferred();
  edit('First ');
  button(S.reloadSession).click();
  await vi.waitFor(() => expect(writes).toHaveLength(1));
  saveGate.resolve();
  await vi.waitFor(() => expect(sessionWrites).toHaveLength(1));
  edit('Later ');
  expect($$('.prompt-actions button', root).every((el: Any) => el.disabled)).toBe(true);
  view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', keyCode: 83, ctrlKey: true, bubbles: true, cancelable: true }));
  root.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
  await Promise.resolve();
  expect(writes).toHaveLength(1);
  sessionGate.resolve();
  await vi.waitFor(() => expect(button(S.reloadSession).disabled).toBe(false));
  expect(session[0].text).toBe('First Hello {{fixture.name}}');
  expect(view.state.doc.toString()).toContain('Later First Hello');
  expect(button(S.saveToFile).disabled).toBe(false);
  expect(button(S.undo).disabled).toBe(false);
  expect($('[role=status]', root).textContent).toBe(S.dirtyCount(1));
});

it('unsaved edits also hold back unloading the window, until they are saved', async () => {
  const { button, edit } = await mount();
  const unloadHeld = () => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; };
  expect(unloadHeld()).toBe(false);
  edit('Unsaved ');
  expect(unloadHeld()).toBe(true);
  button(S.saveToFile).click();
  await vi.waitFor(() => expect(unloadHeld()).toBe(false));
});

it('does not apply when a newer edit arrives during saving, and saves that edit with the new revision', async () => {
  const { button, edit } = await mount();
  saveGate = deferred();
  edit('First '); button(S.reloadSession).click();
  await vi.waitFor(() => expect(writes).toHaveLength(1));
  edit('Later '); saveGate.resolve();
  await vi.waitFor(() => expect(button(S.reloadSession).disabled).toBe(false));
  expect(sessionWrites).toHaveLength(0);
  expect(button(S.saveToFile).disabled).toBe(false);
  const savedRevision = sources[0].revision;
  button(S.reloadSession).click();
  await vi.waitFor(() => expect(session).toHaveLength(3));
  expect(session[0].text).toBe('Later First Hello {{fixture.name}}');
  expect(writes[1].baseRevision).toBe(savedRevision);
});

it('refreshes variables and generated text after applying, preserving undo and reporting missing values', async () => {
  const { root, view, button, edit } = await mount();
  $('.prompt-preview-toggle', root).click();
  await vi.waitFor(() => expect($('.prompt-reference-label', root).textContent).toBe('Friend'));
  edit('New ');
  sources[0].vars[0].value = 'Partner'; generated = 'notes.md';
  button(S.reloadSession).click();
  await vi.waitFor(() => expect($('.prompt-reference-label', root).textContent).toBe('Partner'));
  expect(view.state.doc.toString()).toContain('notes.md');
  button(S.undo).click();
  expect(view.state.doc.toString()).toContain('Hello {{fixture.name}}');
  expect(view.state.doc.toString()).not.toContain('New ');
  expect(view.state.doc.toString()).toContain('notes.md');
  delete sources[0].vars[0].value;
  $('.prompt-preview-toggle', root).click();
  $('.prompt-preview-toggle', root).click();
  await vi.waitFor(() => expect($('.prompt-varwarn', root).textContent).toContain('fixture.name'));
});

it('reloads templates changed outside the page when applying, so the next save uses their revision', async () => {
  const { root, view, button, edit } = await mount();
  sources[0].content = 'Rewritten {{fixture.name}}'; sources[0].revision = '2';
  button(S.reloadSession).click();
  await vi.waitFor(() => expect(view.state.doc.toString()).toContain('Rewritten'));
  edit('New ');
  button(S.saveToFile).click();
  await vi.waitFor(() => expect($('[role=status]', root).textContent).toBe(S.pendingApply));
  expect(writes).toEqual([expect.objectContaining({ key: 'constitution', content: 'New Rewritten {{fixture.name}}', baseRevision: '2' })]);
});

it('retains empty editable templates omitted from the prefix and applies their restored content', async () => {
  sources[1].content = '';
  const { root, view, button } = await mount();
  const flag = $(`[data-source="${worldKey}"]`, root);
  expect(flag.textContent).toContain(S.outsidePrefix);
  $('button', flag).click();
  view.dispatch({ changes: { from: view.state.doc.length, insert: 'Restored environment' } });
  button(S.reloadSession).click();
  await vi.waitFor(() => expect(session.find((segment: Any) => segment.sourceKey === worldKey)?.text).toBe('Restored environment'));
  await vi.waitFor(() => expect(flag.textContent).not.toContain(S.outsidePrefix));
});

it('keeps the accepted route unchanged when leaving for World configuration is cancelled', async () => {
  const { root, router, edit } = await mount();
  edit('Unsaved ');
  $('.prompt-settings-link', root).click();
  await vi.waitFor(() => expect($('.confirm-card')).not.toBeNull());
  $('.confirm-card .btn').click();
  await vi.waitFor(() => expect(location.hash).toBe('#/prompts'));
  expect(router.route.segments).toEqual(['prompts']);
  $('.prompt-settings-link', root).click();
  await vi.waitFor(() => expect($('.confirm-card')).not.toBeNull());
  $('.confirm-card .btn.primary').click();
  await vi.waitFor(() => expect(router.route.segments).toEqual(['provider', 'world:fixture', '~config']));
  expect(router.route.query).toEqual({});
});

it('keeps unsaved edits when leaving for World configuration is cancelled', async () => {
  const { root, router, view, edit } = await mount();
  edit('Unsaved ');
  $('.prompt-settings-link', root).click();
  await vi.waitFor(() => expect($('.confirm-card')).not.toBeNull());
  $('.confirm-card .btn').click();
  await vi.waitFor(() => expect(location.hash).toBe('#/prompts'));
  expect(router.route.segments).toEqual(['prompts']);
  expect(view.state.doc.toString()).toContain('Unsaved ');
  $('.prompt-settings-link', root).click();
  await vi.waitFor(() => expect($('.confirm-card')).not.toBeNull());
  $('.confirm-card .btn.primary').click();
  await vi.waitFor(() => expect(router.route.segments).toEqual(['provider', 'world:fixture', '~config']));
});

it('opens World configuration at once when nothing is unsaved', async () => {
  const { root, router } = await mount();
  vi.stubGlobal('confirm', () => { throw new Error('asked'); });
  await vi.waitFor(() => expect($('.prompt-settings-link', root)).not.toBeNull());
  $('.prompt-settings-link', root).click();
  await vi.waitFor(() => expect(router.route.segments).toEqual(['provider', 'world:fixture', '~config']));
  expect($('.confirm-card')).toBeNull();
});

it('omits the World configuration shortcut when the manifest disables configuration', async () => {
  configAvailable = false;
  const { root } = await mount();
  await vi.waitFor(() => expect($(`[data-source="${worldKey}"]`, root).textContent).toContain('Fixture World'));
  expect($('.prompt-settings-link', root)).toBeNull();
});

it('restores action availability after cancelling a restart without saving or clearing', async () => {
  const { root, button, edit } = await mount();
  edit('Unsaved ');
  $('.prompt-actions .danger', root).click();
  await vi.waitFor(() => expect($('.confirm-card')).not.toBeNull());
  $('.confirm-card .btn').click();
  await vi.waitFor(() => expect(button(S.saveToFile).disabled).toBe(false));
  expect(button(S.undo).disabled).toBe(false);
  expect(writes).toHaveLength(0);
  expect(sessionWrites).toHaveLength(0);
});

it('keeps a failed source dirty after a partial save and retries only that source', async () => {
  const { root, view, button, edit } = await mount();
  edit('New ');
  $(`[data-source="${worldKey}"] button`, root).click();
  const from = view.state.doc.toString().indexOf('Environment');
  view.dispatch({ changes: { from, insert: 'New ' } });
  failures.add(worldKey); button(S.reloadSession).click();
  await vi.waitFor(() => expect($('[role=status]', root).textContent).toContain('Revision conflict'));
  expect(sessionWrites).toHaveLength(0);
  expect($('[data-source="constitution"] .is-dirty', root)).toBeNull();
  expect($(`[data-source="${worldKey}"] .is-dirty`, root)).not.toBeNull();
  failures.clear(); button(S.reloadSession).click();
  await vi.waitFor(() => expect(session).toHaveLength(3));
  expect(writes.filter((write: Any) => write.key === 'constitution')).toHaveLength(1);
  expect(session.filter((segment: Any) => segment.sourceKey).every((segment: Any) => segment.text.startsWith('New '))).toBe(true);
});

it('abandons a pending save on unmount without applying the session', async () => {
  const { life, button, edit } = await mount();
  saveGate = deferred(); edit('New '); button(S.reloadSession).click();
  await vi.waitFor(() => expect(writes).toHaveLength(1));
  life.dispose(); saveGate.resolve();
  await new Promise((resolve: Any) => setTimeout(resolve, 0));
  expect(sources[0].content).toBe('Hello {{fixture.name}}');
  expect(sessionWrites).toHaveLength(0);
});

it('remembers folds across page mounts and resets them in a new window session', async () => {
  const first = await mount();
  const flag = (root: Any, key: Any) => $(`[data-source="${key}"] button`, root);
  expect(flag(first.root, 'constitution').getAttribute('aria-expanded')).toBe('true');
  expect(flag(first.root, worldKey).getAttribute('aria-expanded')).toBe('false');
  flag(first.root, worldKey).click();
  flag(first.root, 'constitution').click();
  first.life.dispose(); first.root.remove();
  const next = await mount();
  expect(flag(next.root, 'constitution').getAttribute('aria-expanded')).toBe('false');
  expect(flag(next.root, worldKey).getAttribute('aria-expanded')).toBe('true');
  expect($('.prefix-comment[data-block="1"] button', next.view.dom).getAttribute('aria-expanded')).toBe('true');
  next.button(S.expandAll).click();
  next.life.dispose(); next.root.remove();
  const expanded = await mount();
  expect(expanded.button(S.collapseAll)).toBeTruthy();
  expect($$('.prefix-flag', expanded.root).every((el: Any) => el.getAttribute('aria-expanded') === 'true')).toBe(true);
  expanded.life.dispose(); expanded.root.remove();
  sessionStorage.clear();
  const restarted = await mount();
  expect(flag(restarted.root, 'constitution').getAttribute('aria-expanded')).toBe('true');
  expect(flag(restarted.root, worldKey).getAttribute('aria-expanded')).toBe('false');
});

it('labels each section with its key and whether it is editable, and lists its template variables under the label', async () => {
  const { root } = await mount();
  const label = $('[data-source="constitution"]', root);
  expect($('.prefix-flag-meta', label).textContent).toBe(`constitution${S.editable}`);
  expect($('[data-source="WORKSPACE"] .prefix-flag-meta', root).textContent).toBe(`WORKSPACE${S.readOnly}`);
  expect($$('.varchip', label).map((chip: Any) => chip.textContent)).toEqual(['fixture.name']);
  expect($('.prompt-vars-heading .prompt-preview-toggle', label).getAttribute('aria-label')).toBe(S.previewVariables);
});
