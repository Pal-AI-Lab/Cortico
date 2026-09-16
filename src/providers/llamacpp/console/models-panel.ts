/**
 * Model section of one endpoint: what llama-server knows, and pulling more.
 * The endpoint comes from `ctx.scope.instance`.
 */
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
    const name = ctx.scope.instance;
    const card = ui.sheet({ title: S.modelsTitle });
    const message = ui.msgline();
    root.append(card.el, message);
    /** The pull input survives a re-render: the operator types while the poll redraws the card. */
    let draft = '';
    let lastSnapshot = '';

    async function act(method: string, extra: Record<string, unknown> = {}): Promise<void> {
      message.textContent = '';
      try {
        await ctx.invoke(method, [{ name, ...extra }]);
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
        value: draft,
        onInput: (value) => { draft = value; },
        onCommit: (value) => void submit(value),
      });
      const submit = async (value: string): Promise<void> => {
        const model = value.trim();
        if (!model) return;
        draft = '';
        await act('pull', { model });
      };
      bar.append(
        pull,
        ui.button(S.pull, { variant: 'primary', onClick: () => void submit(pull.value) }),
        ui.button(S.reload, { onClick: () => void act('reload') }),
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
          actions.append(ui.button(S.cancel, { size: 'sm', onClick: () => void act('cancel', { model: model.id }) }));
        else if (model.status === 'loaded' || model.status === 'sleeping')
          actions.append(ui.button(S.unload, { size: 'sm', onClick: () => void act('unload', { model: model.id }) }));
        else if (model.status === 'unloaded' || model.status === 'failed')
          actions.append(ui.button(S.load, { size: 'sm', onClick: () => void act('load', { model: model.id }) }));
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
      let state: ModelsState;
      try {
        state = await ctx.invoke<ModelsState>('state', [{ name }]);
      } catch (error) {
        message.textContent = String(error);
        return;
      }
      if (ctx.signal.aborted) return;
      const snapshot = JSON.stringify(state);
      const focused = card.el.ownerDocument.activeElement;
      if (!force && (snapshot === lastSnapshot || (focused !== null && card.el.contains(focused)))) return;
      lastSnapshot = snapshot;
      card.body.replaceChildren();
      render(state, card.body);
    }

    await load(true);
    ctx.interval(() => void load(), POLL_MS);
  },
};
