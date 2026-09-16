import type { ConsolePanel, ConsolePanelContext } from '../../../web/shared/client-panel.ts';
import type { ModelsState } from './server.ts';
import { panel } from '../strings.ts';

const POLL_MS = 2_000;

function bytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

export const modelsPanel: ConsolePanel = {
  mount: async (ctx: ConsolePanelContext) => {
    const { ui, root } = ctx;
    const S = ctx.language === 'en' ? panel.en : panel.zh;
    const list = ui.h('div');
    const message = ui.msgline();
    root.append(list, message);
    /** Pull inputs survive a re-render: the operator types while the poll redraws the cards. */
    const drafts = new Map<string, string>();
    let lastSnapshot = '';

    async function act(method: string, body: Record<string, unknown>): Promise<void> {
      message.textContent = '';
      try {
        await ctx.invoke(method, [body]);
      } catch (error) {
        message.textContent = String(error);
      }
      await load(true);
    }

    function render(state: ModelsState, body: HTMLElement): void {
      body.append(ui.kv([
        { k: S.cacheDir, v: state.cacheDir },
        { k: S.localDir, v: state.localModelsDir },
      ]));
      if (!state.reachable) {
        body.append(ui.placeholder(S.serverDown));
        return;
      }
      const bar = ui.rowbar();
      const pull = ui.input({
        placeholder: S.pullPlaceholder,
        cls: 'mono',
        value: drafts.get(state.name) ?? '',
        onInput: (value) => drafts.set(state.name, value),
        onCommit: (value) => void submit(value),
      });
      const submit = async (value: string): Promise<void> => {
        const model = value.trim();
        if (!model) return;
        drafts.set(state.name, '');
        await act('pull', { name: state.name, model });
      };
      bar.append(
        pull,
        ui.button(S.pull, { variant: 'primary', onClick: () => void submit(pull.value) }),
        ui.button(S.reload, { onClick: () => void act('reload', { name: state.name }) }),
      );
      body.append(ui.field(S.pull, bar));
      const table = ui.table({ head: [S.modelId, S.modelStatus, S.modality, S.path, S.actions] });
      if (state.models.length === 0) table.clear(S.noModels);
      for (const model of state.models) {
        const status = ui.h('div');
        status.append(ui.pill(S.modelStatusLabel[model.status] ?? model.status,
          model.status === 'loaded' ? 'on' : model.status === 'failed' ? 'off' : 'plain'));
        if (model.status === 'downloading' && model.progress) {
          const progress = ui.progress({
            value: model.progress.done,
            max: model.progress.total || 1,
            format: (value, max) => (model.progress?.total ? `${bytes(value)} / ${bytes(max)}` : bytes(value)),
          });
          status.append(progress.el);
        }
        const actions = ui.h('div');
        if (model.status === 'downloading')
          actions.append(ui.button(S.cancel, { size: 'sm', onClick: () => void act('cancel', { name: state.name, model: model.id }) }));
        else if (model.status === 'loaded' || model.status === 'sleeping')
          actions.append(ui.button(S.unload, { size: 'sm', onClick: () => void act('unload', { name: state.name, model: model.id }) }));
        else if (model.status === 'unloaded' || model.status === 'failed')
          actions.append(ui.button(S.load, { size: 'sm', onClick: () => void act('load', { name: state.name, model: model.id }) }));
        table.addRow([
          { text: model.id, cls: 'mono' },
          status,
          model.inputModalities ? model.inputModalities.join(' + ') : '',
          { text: model.path ?? '', cls: 'mono' },
          actions,
        ]);
      }
      body.append(table.el);
    }

    async function load(force = false): Promise<void> {
      let states: ModelsState[];
      try {
        states = await ctx.invoke<ModelsState[]>('state');
      } catch (error) {
        message.textContent = String(error);
        return;
      }
      if (ctx.signal.aborted) return;
      const snapshot = JSON.stringify(states);
      if (!force && snapshot === lastSnapshot) return;
      const focused = document.activeElement;
      if (focused instanceof HTMLInputElement && list.contains(focused)) return;
      lastSnapshot = snapshot;
      list.replaceChildren();
      for (const state of states) {
        const card = ui.sheet({ title: state.name });
        render(state, card.body);
        list.append(card.el);
      }
    }

    await load(true);
    ctx.interval(() => void load(), POLL_MS);
  },
};
