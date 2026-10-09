/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createConsoleUi } from '../../src/web/client/ui/index.ts';
import { Lifecycle } from '../../src/web/client/core/lifecycle.ts';
import { Router } from '../../src/web/client/core/router.ts';
import type { FeatureContext } from '../../src/web/client/features/feature.ts';
import { LANGUAGES, LANGUAGE_NAMES } from '../../src/core/language.ts';

let lifecycle: Lifecycle;
beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  document.documentElement.lang = 'zh-CN';
  document.body.replaceChildren();
  lifecycle = new Lifecycle(() => {});
});
afterEach(() => { lifecycle.dispose(); vi.restoreAllMocks(); });

it('lists every language by its own name, marks the current one, and keeps it on cancellation', async () => {
  const { mountGeneral } = await import('../../src/web/client/features/settings/general.ts');
  const root = document.createElement('div');
  document.body.append(root);
  const ui = createConsoleUi({
    memo: { get: (_key, fallback) => fallback, set: () => {} },
    overlayHost: document.body, signal: lifecycle.signal, doc: document,
  });
  const ctx: FeatureContext = {
    root, ui, lifecycle, signal: lifecycle.signal, capabilities: {},
    route: { segments: ['settings'], query: {}, raw: '/settings' },
    router: new Router({ win: window, confirmLeave: async () => true }),
    onError: (err) => { throw err; },
  };
  mountGeneral(ctx);
  const buttons = [...root.querySelectorAll('button')];
  expect(buttons.map((button) => button.textContent)).toEqual(LANGUAGES.map((language) => LANGUAGE_NAMES[language]));
  const current = buttons[LANGUAGES.indexOf('zh')];
  expect(current.getAttribute('aria-pressed')).toBe('true');
  expect(current.disabled).toBe(true);
  buttons[LANGUAGES.indexOf('en')].click();
  await Promise.resolve();
  expect(document.body.textContent).toContain('未保存的编辑会丢失');
  const cancel = [...document.querySelectorAll('button')].find((button) => button.textContent === '取消');
  expect(cancel).toBeDefined();
  cancel!.click();
  await Promise.resolve();
  expect(localStorage.length).toBe(0);
  expect(document.documentElement.lang).toBe('zh-CN');
});
