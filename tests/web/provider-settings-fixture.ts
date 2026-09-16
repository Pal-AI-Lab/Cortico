import { join } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { makeCfg, makeTmpDir } from '../core/helpers.ts';
import { nullLogger } from '../../src/core/util.ts';
import { ProviderRegistry, providerModules } from '../../src/providers/registry.ts';
import { ProviderSettings } from '../../src/providers/console/settings.ts';
import type { ProviderModule } from '../../src/providers/base.ts';
import type { LLMProviderEntry, ModelSpec } from '../../src/core/types.ts';

/** 供应模块夹具包含推理强度、服务档与温度提示，用于验证声明驱动的设置项。 */
export const FIXTURE_KIND = 'fixture-llm';
export const fixtureWorld: ProviderModule = {
  id: FIXTURE_KIND,
  title: 'Fixture LLM',
  reasoningTiers: [
    { id: 'off', label: '关闭', thinking: false },
    { id: 'high', label: '高', thinking: true, effort: 'high' },
  ],
  serviceTiers: [
    { id: 'default', label: '默认' },
    { id: 'priority', label: '快车道 priority' },
  ],
  temperatureNote: '这个端点实测 ≤1.2 稳定;更高会在中途把台词转成乱码。',
  create: () => ({ client: null as never }),
};

/**
 * 开放推理强度的方言:`reasoningTiers` 为空,effort 是自由字串。面板对这两种模块走两套控件
 * (下拉 vs 带 datalist 的文本框),所以两份夹具都要有。
 */
export const FIXTURE_OPEN_KIND = 'fixture-open-llm';
export const openBaseUrls: readonly string[] = ['https://alpha.test/v1', 'https://beta.test/api'];
export const openEfforts: readonly string[] = ['none', 'low', 'high'];
export const openFixtureWorld: ProviderModule = {
  id: FIXTURE_OPEN_KIND,
  title: 'Fixture Open LLM',
  baseUrlSuggestions: openBaseUrls,
  reasoningTiers: [],
  effortSuggestions: openEfforts,
  serviceTiers: [],
  create: () => ({ client: null as never }),
};

const UI = '../../src/web/client/ui/index.ts';
const CLIENT = '../../src/web/client/console-pages/builtins/llm-settings/panel.ts';
// Browser code is independently checked by tsconfig.web.json.
type Any = any;
const JSDOM_MODULE = 'jsdom';
const { JSDOM } = (await import(JSDOM_MODULE)) as Any;
export const doc = new JSDOM('<!doctype html><body></body>').window.document as Any;
export async function mountSettings(
  kind = FIXTURE_KIND,
  patch: Partial<LLMProviderEntry> = {},
  baseline: ModelSpec = { model: 'fixture-pro', thinking: false },
) {
  const temp = makeTmpDir();
  const cfg = makeCfg();
  cfg.providers = {
    primary: {
      kind,
      baseUrl: 'https://provider.test',
      spec: { ...baseline },
      ...patch,
    },
  };
  cfg.activeProvider = 'primary';
  const file = join(temp.dir, 'config.json');
  const providersDir = join(temp.dir, 'providers');
  const worlds = [...providerModules, fixtureWorld, openFixtureWorld];
  const settings = new ProviderSettings(
    cfg,
    new ProviderRegistry(() => cfg.providers, {
      stateRoot: providersDir,
      readBlob: () => null,
      keepThinking: () => true,
      log: nullLogger(),
    }, worlds),
    file,
    providersDir,
    worlds,
  );
  const contribution = settings
    .sources()
    .find((source) => source.id === `llm:${kind}`)!
    .contribute('zh');
  const mounted = await mountPanel((method, args) => contribution.invoke!('settings', method, args));
  return {
    root: mounted.root,
    cfg,
    settings,
    slots: mounted.slots,
    /** 合并全局端点配置与部署选择，提供断言使用的配置视图。 */
    read: () => ({
      ...JSON.parse(readFileSync(file, 'utf8')),
      providers: Object.fromEntries(
        (existsSync(providersDir) ? readdirSync(providersDir) : []).map((name) => [
          name,
          JSON.parse(readFileSync(join(providersDir, name, 'config.json'), 'utf8')),
        ]),
      ),
    }),
    cleanup: () => {
      mounted.cleanup();
      temp.cleanup();
    },
  };
}

/** 挂载真实面板到测试 context，数据接口由调用方提供。 */
export async function mountPanel(
  invoke: (method: string, args: unknown[]) => Promise<unknown> | unknown,
  language: 'zh' | 'en' = 'zh',
) {
  /** 宿主挂插槽的记录:挂了哪个插槽、给的作用域,以及有没有被结束。 */
  const slots: Array<{ slot: string; scope: Record<string, string>; host: Any; disposed: boolean }> = [];
  const { createConsoleUi } = (await import(UI)) as Any;
  const { llmSettingsPanel } = (await import(CLIENT)) as Any;
  const root = doc.createElement('div');
  doc.body.append(root);
  const controller = new doc.defaultView.AbortController();
  // 浮层(confirm)用全局 AbortController 造自己的 signal 再挂到 jsdom 的 EventTarget 上;
  // jsdom 只认自己那一份,所以挂载期间把全局换成 jsdom 的,cleanup 时换回。
  const nativeAbortController = globalThis.AbortController;
  globalThis.AbortController = doc.defaultView.AbortController;
  const memo = { get: (_key: string, fallback: unknown) => fallback, set: () => {} };
  const ui = createConsoleUi({ memo, overlayHost: doc.body, signal: controller.signal, doc });
  await llmSettingsPanel.mount({
    root,
    ui,
    language,
    signal: controller.signal,
    scope: {},
    invoke: async (method: string, args: unknown[] = []) => invoke(method, args),
    refresh: async () => {},
    mountSlot: async (slot: string, host: Any, scope: Record<string, string>) => {
      const record = { slot, scope, host, disposed: false };
      slots.push(record);
      return { dispose: () => { record.disposed = true; } };
    },
  });
  return {
    root,
    slots,
    cleanup: () => {
      controller.abort();
      root.remove();
      globalThis.AbortController = nativeAbortController;
    },
  };
}
export function change(element: Any, value: string) {
  element.value = value;
  element.dispatchEvent(new doc.defaultView.Event('change'));
}
export function button(root: Any, label: string): Any {
  return [...root.querySelectorAll('button')].find((node: Any) => node.textContent === label);
}
export async function flush() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}
