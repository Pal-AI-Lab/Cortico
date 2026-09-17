import { expect, it } from 'vitest';
import { LAUNCH_DEFAULTS } from '../../src/providers/llamacpp/options.ts';
import { change, doc, flush, mountSettings } from './provider-settings-fixture.ts';

const UI = '../../src/web/client/ui/index.ts';
const PANEL = '../../src/providers/llamacpp/console/runtime-panel.ts';
type Any = any;

/** 挂一次运行时面板;`state` 覆盖 state 回执里那几位。回执的配置组取真的声明与真的值。 */
async function mountRuntimePanel(
  entry: Any, state: Record<string, unknown> = {},
): Promise<{
  root: Any;
  settings: Any;
  read: () => Any;
  field: (label: string) => Any;
  cleanup: () => void;
}> {
  const endpoint = await mountSettings('llamacpp', entry);
  const controller = new doc.defaultView.AbortController();
  const root = doc.createElement('div');
  doc.body.append(root);
  const { createConsoleUi } = await import(UI) as Any;
  const { runtimePanel } = await import(PANEL) as Any;
  const ui = createConsoleUi({
    memo: { get: (_key: string, fallback: unknown) => fallback, set: () => {} },
    overlayHost: doc.body, signal: controller.signal, doc,
  });
  await runtimePanel.mount({
    root, ui, language: 'zh', signal: controller.signal, scope: { instance: 'primary' },
    invoke: async () => ({
      name: 'primary', managed: true, own: false, supported: true, backendChoices: ['cpu', 'cuda-12.4'],
      install: { phase: 'absent' }, server: null, smartAppControl: null,
      config: endpoint.settings.groups().filter((group: Any) => !group.id.endsWith('.connection'))
        .map((group: Any) => ({ group, values: endpoint.settings.values(group.id) })),
      ...state,
    }),
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
  const panel = await mountRuntimePanel({ options: { runtime: { backend: 'cpu' } } });
  try {
    change(panel.field('GPU 层数(-ngl)'), '0');
    await flush();
    expect(panel.read().providers.primary.options.launch.nGpuLayers).toBe(0);
    change(panel.field('并发槽位(--parallel)'), '');
    await flush();
    expect(panel.read().providers.primary.options.launch.parallel).toBe(LAUNCH_DEFAULTS.parallel);
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
