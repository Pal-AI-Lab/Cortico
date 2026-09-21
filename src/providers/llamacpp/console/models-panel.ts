/**
 * Model section of one endpoint: what llama-server knows, a HuggingFace search that feeds the
 * pull field, and `use` to put a served model into the model section. The endpoint comes from
 * `ctx.scope.instance`.
 */
import type { ConsolePanel, ConsolePanelContext } from '../../../web/shared/client-panel.ts';
import type { HfFile, HfRepo } from '../huggingface.ts';
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
    /** Typed text and search results survive a re-render: the poll redraws the card around them. */
    let draft = '';
    let query = '';
    let repos: HfRepo[] | null = null;
    let searchNote = '';
    let chosen: { repo: string; files: HfFile[] } | null = null;
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

    async function search(text: string): Promise<void> {
      const wanted = text.trim();
      if (!wanted) return;
      query = wanted;
      chosen = null;
      try {
        const result = await ctx.invoke<{ repos: HfRepo[] }>('search', [{ name, query: wanted }]);
        repos = result.repos;
        searchNote = repos.length ? '' : S.noRepos;
      } catch (error) {
        repos = [];
        searchNote = S.searchFailed(String(error));
      }
      await load(true);
    }

    async function showFiles(repo: string): Promise<void> {
      try {
        chosen = { repo, files: (await ctx.invoke<{ files: HfFile[] }>('files', [{ name, repo }])).files };
      } catch (error) {
        message.textContent = String(error);
        return;
      }
      await load(true);
    }

    function renderSearch(body: HTMLElement): void {
      const bar = ui.rowbar();
      const input = ui.input({
        placeholder: S.searchPlaceholder,
        value: query,
        onCommit: (value) => void search(value),
      });
      input.setAttribute('aria-label', S.search);
      bar.append(input, ui.button(S.search, { onClick: () => void search(input.value) }));
      body.append(ui.field(S.search, bar));
      if (repos === null) return;
      if (searchNote) body.append(ui.msgline(searchNote, repos.length === 0 && searchNote !== S.noRepos));
      if (repos.length) {
        const table = ui.table({ head: [S.repo, S.downloads, S.likes, S.updated, ''] });
        for (const repo of repos) {
          const open = ui.button(S.showFiles, { size: 'sm', onClick: () => void showFiles(repo.id) });
          table.addRow([
            { text: repo.id, cls: 'mono' },
            ui.fmt.count(repo.downloads),
            ui.fmt.count(repo.likes),
            repo.updatedAt ? repo.updatedAt.slice(0, 10) : '',
            open,
          ]);
        }
        body.append(table.el);
      }
      if (!chosen) return;
      body.append(ui.section(S.filesOf(chosen.repo)));
      const files = ui.table({ head: [S.file, S.size, S.tag, ''] });
      if (chosen.files.length === 0) files.clear(S.noFiles);
      for (const file of chosen.files) {
        const pull = ui.button(S.pull, { size: 'sm', variant: 'primary', onClick: () => void act('pull', { model: file.pull }) });
        pull.title = file.pull;
        files.addRow([
          { text: file.name, cls: 'mono' },
          file.bytes === null ? '' : bytes(file.bytes),
          { text: file.tag ?? '', cls: 'mono' },
          pull,
        ]);
      }
      body.append(files.el);
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
        const actions = ui.rowbar();
        if (model.status === 'downloading')
          actions.append(ui.button(S.cancel, { size: 'sm', onClick: () => void act('cancel', { model: model.id }) }));
        else if (model.status === 'loaded' || model.status === 'sleeping')
          actions.append(ui.button(S.unload, { size: 'sm', onClick: () => void act('unload', { model: model.id }) }));
        else if (model.status === 'unloaded' || model.status === 'failed')
          actions.append(ui.button(S.load, { size: 'sm', onClick: () => void act('load', { model: model.id }) }));
        if (model.status !== 'downloading') {
          const use = ui.button(S.use, { size: 'sm', onClick: () => void act('use', { model: model.id }) });
          use.title = S.useTitle;
          actions.append(use);
        }
        table.addRow([
          { text: model.id, cls: 'mono' },
          status,
          model.inputModalities ? model.inputModalities.join(' + ') : '',
          { text: model.path ?? '', cls: 'mono' },
          actions,
        ]);
      }
      body.append(table.el);
      renderSearch(body);
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
