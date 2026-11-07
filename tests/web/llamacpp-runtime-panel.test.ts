import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultBackend, LAUNCH_DEFAULTS } from '../../src/providers/llamacpp/options.ts';
import { ProviderRegistry } from '../../src/providers/registry.ts';
import { ProviderSettings } from '../../src/providers/webui/settings.ts';
import { nullLogger } from '../../src/core/util.ts';
import { makeCfg, makeTmpDir } from '../core/helpers.ts';

const UI = '../../src/web/client/ui/index.ts';
const PANEL = '../../src/providers/llamacpp/webui/runtime-panel.ts';
const JSDOM_MODULE = 'jsdom';
type Any = any;
const { JSDOM } = (await import(JSDOM_MODULE)) as Any;
const doc = new JSDOM('<!doctype html><body></body>').window.document as Any;

function change(element: Any, value: string) {
  element.value = value;
  element.dispatchEvent(new doc.defaultView.Event('change'));
}
async function flush() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

/** 一条 llamacpp 端点 `primary` 与它的配置事务;`read` 读回共享目录里的端点配置。 */
function llamacppEndpoint(entry: Any) {
  const temp = makeTmpDir();
  const cfg = makeCfg();
  cfg.providers = { primary: { kind: 'llamacpp', baseUrl: 'https://provider.test', spec: { model: 'fixture-pro', thinking: false }, ...entry } };
  cfg.activeProvider = 'primary';
  const providersDir = join(temp.dir, 'providers');
  const registry = new ProviderRegistry(() => cfg.providers, {
    stateRoot: providersDir, readBlob: () => null, keepThinking: () => true, log: nullLogger(),
  });
  const settings = new ProviderSettings(cfg, registry, join(temp.dir, 'config.json'), providersDir);
  return {
    settings,
    read: () => JSON.parse(readFileSync(join(providersDir, 'primary', 'config.json'), 'utf8')),
    cleanup: temp.cleanup,
  };
}

/** 挂一次运行时面板;`state` 覆盖 state 回执里那几位。回执的配置组取真的声明与真的值。 */
async function mountRuntimePanel(
  entry: Any, state: Record<string, unknown> = {}, failMethod = '',
): Promise<{
  root: Any;
  settings: Any;
  read: () => Any;
  field: (label: string) => Any;
  cleanup: () => void;
}> {
  const endpoint = llamacppEndpoint(entry);
  const controller = new doc.defaultView.AbortController();
  const root = doc.createElement('div');
  doc.body.append(root);
  const { createWebUi } = await import(UI) as Any;
  const { runtimePanel } = await import(PANEL) as Any;
  const ui = createWebUi({
    memo: { get: (_key: string, fallback: unknown) => fallback, set: () => {} },
    overlayHost: doc.body, signal: controller.signal, doc,
  });
  await runtimePanel.mount({
    root, ui, language: 'zh', signal: controller.signal, scope: { instance: 'primary' },
    invoke: async (method: string) => {
      if (method === failMethod) throw new Error('runtime action failed');
      return {
        name: 'primary', managed: true, own: false, supported: true, backendChoices: ['cpu', 'cuda-12.4'],
        install: { phase: 'absent' }, server: null, smartAppControl: null,
        config: endpoint.settings.groups().filter((group: Any) => !group.id.endsWith('.connection'))
          .map((group: Any) => ({ group, values: endpoint.settings.values(group.id) })),
        ...state,
      };
    },
    setConfig: async (groupId: string, values: Any) => endpoint.settings.setConfig(groupId, values),
    interval: () => ({ dispose() {} }),
  });
  return {
    root,
    settings: endpoint.settings,
    read: endpoint.read,
    field: (label: string) => root.querySelector(`[aria-label="${label}"]`),
    cleanup: () => { controller.abort(); root.remove(); endpoint.cleanup(); },
  };
}

it('runtime schema fields save through the configuration transaction and retain rejected values', async () => {
  const panel = await mountRuntimePanel({ options: { runtime: { backend: defaultBackend() } } });
  try {
    change(panel.field('GPU 层数(-ngl)'), '0');
    await flush();
    expect(panel.read().options.launch.nGpuLayers).toBe(0);
    change(panel.field('并发槽位(--parallel)'), '');
    await flush();
    expect(panel.read().options.launch.parallel).toBe(LAUNCH_DEFAULTS.parallel);
    expect(panel.field('并发槽位(--parallel)').value).toBe(String(LAUNCH_DEFAULTS.parallel));
    expect(panel.root.textContent).toContain('不能小于');
  } finally {
    panel.cleanup();
  }
});

it('自备运行时目录时后端那一格禁用:目录里的二进制自己决定后端', async () => {
  const own = await mountRuntimePanel(
    { options: { runtime: { backend: 'cpu', runtimeDir: 'D:\\llama' } } },
    { own: true },
  );
  try {
    expect(own.field('后端').disabled).toBe(true);
  } finally {
    own.cleanup();
  }

  const managed = await mountRuntimePanel({ options: { runtime: { backend: 'cpu' } } });
  try {
    expect(managed.field('后端').disabled).toBe(false);
  } finally {
    managed.cleanup();
  }
});

it('shows a failed runtime action beside its button', async () => {
  const panel = await mountRuntimePanel({}, { managed: false }, 'enable');
  try {
    (panel.root.querySelector('.runtime-enable-row button') as Any).click();
    await flush();
    expect(panel.root.querySelector('.runtime-enable-row .msgline.bad')?.textContent).toContain('runtime action failed');
  } finally {
    panel.cleanup();
  }
});
