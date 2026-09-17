/**
 * Runtime section of one endpoint: the binary, its launch parameters and the llama-server process.
 * The endpoint comes from `ctx.scope.instance`; edits are written on change.
 */
import type { ConsolePanel, ConsolePanelContext } from '../../../web/shared/client-panel.ts';
import type { ConfigValues } from '../../../core/config-schema.ts';
import { configField } from '../../../web/client/features/config/view.ts';
import type { RuntimePanelState } from './server.ts';
import { panel } from '../strings.ts';

type Row = RuntimePanelState;

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
    const name = ctx.scope.instance;
    const card = ui.sheet({ title: S.runtimeTitle });
    const message = ui.msgline();
    root.append(card.el, message);
    let busy = false;
    let lastSnapshot = '';

    async function act(method: string, extra: Record<string, unknown> = {}): Promise<void> {
      if (busy) return;
      busy = true;
      message.textContent = '';
      try {
        await ctx.invoke(method, [{ name, ...extra }]);
      } catch (error) {
        message.textContent = String(error);
      } finally {
        busy = false;
      }
      await load(true);
    }

    async function saveConfig(groupId: string, values: ConfigValues): Promise<void> {
      if (busy) return;
      busy = true;
      message.textContent = '';
      try {
        await ctx.setConfig(groupId, values);
      } catch (error) {
        message.textContent = String(error);
      } finally {
        busy = false;
      }
      await load(true);
    }

    function renderConfig(row: Row, index: number, body: HTMLElement): void {
      const { group, values } = row.config[index];
      body.append(ui.section(group.schema.title, group.schema.description));
      for (const [path, property] of Object.entries(group.schema.properties)) {
        const field = configField(ui, property, values[path], () => {
          if (field.read) void saveConfig(group.id, { [path]: field.read() });
        }, ctx.signal);
        field.node.setAttribute('aria-label', property.title);
        // 自备目录里的二进制自己决定后端,这一格此时不参与:与手写面板时的禁用一致。
        if (path.endsWith('.runtime.backend') && row.own) {
          (field.node as HTMLSelectElement).disabled = true;
        }
        body.append(ui.field(property.title, field.node));
        if (property.description) body.append(ui.msgline(property.description));
      }
    }

    function renderUnmanaged(row: Row, body: HTMLElement): void {
      body.append(ui.msgline(S.managedOff));
      const bar = ui.rowbar();
      const backend = ui.select({ options: row.backendChoices });
      bar.append(ui.field(S.backend, backend), ui.button(S.enable, {
        variant: 'primary',
        onClick: () => void act('enable', { backend: backend.value }),
      }));
      body.append(bar);
    }

    function renderManaged(row: Row, body: HTMLElement): void {
      const install = row.install;
      const installPill = install.phase === 'installed' ? ui.pill(S.installed, 'on')
        : install.phase === 'downloading' ? ui.pill(S.downloading, 'plain')
        : install.phase === 'extracting' ? ui.pill(S.extracting, 'plain')
        : ui.pill(S.absent, 'off');

      renderConfig(row, 0, body);
      body.append(ui.kv([{ k: S.installStatus, v: installPill }]));
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
          onClick: () => void act('install'),
        });
        button.disabled = !row.supported || install.phase === 'downloading' || install.phase === 'extracting';
        installBar.append(button);
      }
      installBar.append(ui.h('span', 'grow'), ui.button(S.disable, { onClick: () => void act('disable') }));
      body.append(installBar);

      renderConfig(row, 1, body);

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
      const start = ui.button(S.start, { variant: 'primary', onClick: () => void act('start') });
      start.disabled = install.phase !== 'installed' || server?.phase === 'running' || server?.phase === 'starting';
      const stop = ui.button(S.stop, { onClick: () => void act('stop') });
      stop.disabled = !server || server.phase === 'stopped';
      serverBar.append(start, stop);
      body.append(serverBar);
      if (install.phase !== 'installed') {
        body.append(ui.msgline(S.installRequired));
      }
    }

    /** The poll redraws the card, so it stands down while the operator is in one of its fields. */
    function editing(): boolean {
      const focused = card.el.ownerDocument.activeElement;
      return focused !== null && card.el.contains(focused);
    }

    async function load(force = false): Promise<void> {
      let row: Row;
      try {
        row = await ctx.invoke<Row>('state', [{ name }]);
      } catch (error) {
        message.textContent = String(error);
        return;
      }
      if (ctx.signal.aborted) return;
      const snapshot = JSON.stringify(row);
      if (!force && (snapshot === lastSnapshot || editing())) return;
      lastSnapshot = snapshot;
      card.body.replaceChildren();
      if (row.managed) renderManaged(row, card.body);
      else renderUnmanaged(row, card.body);
    }

    await load(true);
    ctx.interval(() => void load(), POLL_MS);
  },
};
