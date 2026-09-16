import type { ConsolePanel, ConsolePanelContext } from '../../../web/shared/client-panel.ts';
import type { RuntimeState } from '../runtime.ts';
import { panel } from '../strings.ts';

type Row = RuntimeState & { name: string };

const POLL_MS = 2_000;

function bytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

export const runtimePanel: ConsolePanel = {
  mount: async (ctx: ConsolePanelContext) => {
    const { ui, root } = ctx;
    const S = ctx.language === 'en' ? panel.en : panel.zh;
    const list = ui.h('div');
    const message = ui.msgline();
    const toolbar = ui.rowbar();
    toolbar.append(ui.h('span', 'grow'), ui.button(S.refresh, { size: 'sm', onClick: () => void load() }));
    root.append(toolbar, list, message);
    let busy = false;
    let lastSnapshot = '';

    async function act(method: string, body: Record<string, unknown>, refresh = false): Promise<void> {
      if (busy) return;
      busy = true;
      message.textContent = '';
      try {
        await ctx.invoke(method, [body]);
        if (refresh) await ctx.refresh();
      } catch (error) {
        message.textContent = String(error);
      } finally {
        busy = false;
      }
      await load(true);
    }

    function renderUnmanaged(row: Row, body: HTMLElement): void {
      body.append(ui.msgline(S.managedOff));
      const bar = ui.rowbar();
      const backend = ui.select({ options: row.backendChoices });
      bar.append(ui.field(S.backend, backend), ui.button(S.enable, {
        variant: 'primary',
        onClick: () => void act('enable', { name: row.name, backend: backend.value }, true),
      }));
      body.append(bar);
    }

    function renderManaged(row: Row, body: HTMLElement): void {
      const install = row.install;
      const installPill = install.phase === 'installed' ? ui.pill(S.installed, 'on')
        : install.phase === 'downloading' ? ui.pill(S.downloading, 'plain')
        : install.phase === 'extracting' ? ui.pill(S.extracting, 'plain')
        : ui.pill(S.absent, 'off');

      body.append(ui.section(S.runtimeSection, S.runtimeSectionDesc));
      body.append(ui.kv([
        { k: S.release, v: row.release },
        { k: S.backend, v: row.own ? S.ownRuntime : row.backend },
        { k: S.runtimeDir, v: row.runtimeDir },
        { k: S.installStatus, v: installPill },
      ]));
      if (row.smartAppControl === 1) body.append(ui.msgline(S.sacWarning, true));
      if (install.phase === 'downloading' || install.phase === 'extracting') {
        const progress = ui.progress({
          label: `${install.phase === 'downloading' ? S.downloading : S.extracting} ${install.file ?? ''}`,
          value: install.done,
          max: install.total ?? 1,
          format: (value, max) => (install.total ? `${bytes(value)} / ${bytes(max)}` : bytes(value)),
        });
        body.append(progress.el);
      }
      if (install.detail) body.append(ui.msgline(install.detail, true));
      const installBar = ui.rowbar();
      if (!row.own) {
        const button = ui.button(install.phase === 'installed' ? S.reinstall : S.install, {
          variant: install.phase === 'installed' ? 'plain' : 'primary',
          onClick: () => void act('install', { name: row.name }),
        });
        button.disabled = !row.supported || install.phase === 'downloading' || install.phase === 'extracting';
        installBar.append(button);
      }
      installBar.append(ui.h('span', 'grow'), ui.button(S.disable, { onClick: () => void act('disable', { name: row.name }, true) }));
      body.append(installBar);

      body.append(ui.section(S.serverSection, S.serverSectionDesc));
      const server = row.server;
      if (server) {
        const endpointRow = ui.rowbar();
        const epText = ui.h('span', 'mono', server.baseUrl);
        const epPill = ui.pill(server.reachable ? S.reachable : S.unreachable, server.reachable ? 'on' : 'off');
        const copyBtn = ui.copyButton(server.baseUrl, { size: 'sm' });
        endpointRow.append(epText, epPill, copyBtn);

        body.append(ui.kv([
          { k: S.status, v: ui.pill(S.phase[server.phase] ?? server.phase, server.phase === 'running' ? 'on' : server.phase === 'error' ? 'off' : 'plain') },
          { k: S.endpoint, v: endpointRow },
          { k: S.pid, v: server.pid === null ? '' : String(server.pid) },
        ]));
        if (server.configurationPending) body.append(ui.msgline(S.pendingNote));
        if (server.detail) body.append(ui.msgline(server.detail, server.phase === 'error'));
      }
      const serverBar = ui.rowbar();
      const start = ui.button(S.start, { variant: 'primary', onClick: () => void act('start', { name: row.name }) });
      start.disabled = install.phase !== 'installed' || server?.phase === 'running' || server?.phase === 'starting';
      const stop = ui.button(S.stop, { onClick: () => void act('stop', { name: row.name }) });
      stop.disabled = !server || server.phase === 'stopped';
      serverBar.append(start, stop);
      body.append(serverBar);
      if (install.phase !== 'installed') {
        body.append(ui.msgline(S.installRequired));
      }
      if (S.paramsNote) {
        body.append(ui.msgline(S.paramsNote));
      }
    }

    async function load(force = false): Promise<void> {
      let rows: Row[];
      try {
        rows = await ctx.invoke<Row[]>('state');
      } catch (error) {
        message.textContent = String(error);
        return;
      }
      if (ctx.signal.aborted) return;
      const snapshot = JSON.stringify(rows);
      if (!force && snapshot === lastSnapshot) return;
      lastSnapshot = snapshot;
      list.replaceChildren();
      for (const row of rows) {
        const card = ui.sheet({ title: row.name });
        if (row.managed) renderManaged(row, card.body);
        else renderUnmanaged(row, card.body);
        list.append(card.el);
      }
    }

    await load(true);
    ctx.interval(() => void load(), POLL_MS);
  },
};
