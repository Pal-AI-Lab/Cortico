/**
 * WebSearch 的「快速配置」页签：选搜索服务、改各家的地址、填各家的密钥、试搜一次。
 *
 * 服务和地址写进配置组 `worlds.websearch`;密钥经 World 的 `setKey` 写进部署 .env,页面只拿得到打码后的样子。
 */
import type { WebUiClientBundle, WebUiPanel, WebUiPanelContext } from '../../../web/shared/client-panel.ts';
import type { SearchProvider, WebSearchPanelState } from '../config.ts';
import type { SearchOutcome } from '../search.ts';
import { text } from '../strings.ts';

const PROVIDERS: readonly SearchProvider[] = ['brave', 'deepseek'];
const KEY_URLS: Record<SearchProvider, string> = {
  brave: 'https://api-dashboard.search.brave.com/app/keys',
  deepseek: 'https://platform.deepseek.com/api_keys',
};
const CONFIG_GROUP = 'world:websearch';
const PROVIDER_KEY = 'worlds.websearch.provider';
const BASE_URL_KEYS: Record<SearchProvider, string> = {
  brave: 'worlds.websearch.braveBaseUrl',
  deepseek: 'worlds.websearch.deepseekBaseUrl',
};

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const setupPanel: WebUiPanel = {
  mount(ctx: WebUiPanelContext) {
    const { ui, root } = ctx;
    const t = text(ctx.language);
    let state: WebSearchPanelState | null = null;

    // ------------------------------------------------------------ 服务
    const service = ui.sheet({ title: t.providerTitle, desc: t.serviceDesc });
    const seg = ui.segmented(PROVIDERS.map((p) => ({ value: p, label: t.providerName[p] })), {
      onSelect: (v) => void selectProvider(v as SearchProvider),
    });
    service.body.append(seg.el);

    // ------------------------------------------------------------ 地址
    const address = ui.sheet({ title: t.baseUrl, desc: t.baseUrlDesc });
    const urlInput = ui.input({ cls: 'mono grow', onCommit: () => void saveBaseUrl() });
    const urlSave = ui.button(t.save, { size: 'sm', onClick: () => void saveBaseUrl() });
    const urlRow = ui.rowbar();
    urlRow.append(urlInput, urlSave);
    address.body.append(urlRow);

    // ------------------------------------------------------------ 密钥
    const keys = ui.sheet({ title: t.key, desc: t.keyDesc });
    const status = ui.h('div', 'rowbar');
    const input = ui.input({ type: 'password', cls: 'mono grow', onCommit: () => void saveKey() });
    const save = ui.button(t.save, { size: 'sm', variant: 'primary', onClick: () => void saveKey() });
    const link = ui.h('a', '', t.getKey);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    const editRow = ui.rowbar();
    editRow.append(input, save, link);
    const testOut = ui.msgline();
    testOut.hidden = true;
    keys.body.append(status, editRow, testOut);

    root.append(service.el, address.el, keys.el);

    function render(next: WebSearchPanelState): void {
      state = next;
      const p = next.provider;
      seg.setValue(p);
      urlInput.value = next.baseUrls[p];
      const masked = next.keys[p];
      const clear = ui.button(t.clear, { size: 'sm', variant: 'danger', onClick: () => void clearKey() });
      const test = ui.button(t.test, { size: 'sm', onClick: () => void runTest(test) });
      status.replaceChildren(
        ui.pill(masked ? t.keySet : t.keyUnset, masked ? 'on' : 'off'),
        ...(masked ? [ui.h('span', 'mono', masked), ui.h('span', 'grow'), test, clear] : []),
      );
      input.placeholder = t.keyPlaceholder(t.providerName[p]);
      link.href = KEY_URLS[p];
    }

    async function call(method: string, args: unknown[] = []): Promise<boolean> {
      try {
        render(await ctx.invoke<WebSearchPanelState>(method, args));
        void ctx.refresh();
        return true;
      } catch (err) {
        ui.toast(errText(err), 'bad');
        return false;
      }
    }

    async function selectProvider(p: SearchProvider): Promise<void> {
      try {
        await ctx.setConfig(CONFIG_GROUP, { [PROVIDER_KEY]: p });
        testOut.hidden = true;
        if (await call('state')) ui.toast(t.providerSaved(t.providerName[p]));
      } catch (err) {
        ui.toast(errText(err), 'bad');
        if (state) seg.setValue(state.provider);
      }
    }

    async function saveBaseUrl(): Promise<void> {
      if (!state) return;
      const value = urlInput.value.trim();
      if (value && !/^https?:\/\/[^/\s]/i.test(value)) {
        ui.toast(t.baseUrlInvalid, 'bad');
        return;
      }
      const off = ui.disable(urlSave, urlInput);
      try {
        await ctx.setConfig(CONFIG_GROUP, { [BASE_URL_KEYS[state.provider]]: value });
        testOut.hidden = true;
        if (await call('state')) ui.toast(t.baseUrlSaved);
      } catch (err) {
        ui.toast(errText(err), 'bad');
      }
      off.dispose();
    }

    async function saveKey(): Promise<void> {
      if (!state) return;
      const value = input.value.trim();
      if (!value) {
        ui.toast(t.keyEmpty, 'bad');
        return;
      }
      const off = ui.disable(save, input);
      if (await call('setKey', [state.provider, value])) {
        input.value = '';
        testOut.hidden = true;
        ui.toast(t.keySaved);
      }
      off.dispose();
    }

    async function clearKey(): Promise<void> {
      if (!state) return;
      const name = t.providerName[state.provider];
      if (!(await ui.confirm({ title: t.clearConfirm(name), danger: true }))) return;
      if (await call('clearKey', [state.provider])) {
        testOut.hidden = true;
        ui.toast(t.keyCleared);
      }
    }

    async function runTest(btn: HTMLButtonElement): Promise<void> {
      const off = ui.disable(btn);
      try {
        const out = await ctx.invoke<SearchOutcome>('test', []);
        testOut.textContent = t.testOk(out.results.length, out.endpoint);
        testOut.className = 'msgline';
      } catch (err) {
        testOut.textContent = errText(err);
        testOut.className = 'msgline bad';
      }
      testOut.hidden = false;
      off.dispose();
    }

    void call('state');
  },
};

const bundle: WebUiClientBundle = {
  // 键是局部 panel id,与服务端 `webUi().panels[].id` 一一对应。
  panels: { setup: setupPanel },
};

export default bundle;
