import type {
  WebUiPanelContext,
  WebUiPanel,
} from '../../../web/shared/client-panel.ts';
import {
  autoload,
  errText,
  type QQConvNames,
  type QQRoster,
  type QQRosterEntry,
} from './client.ts';
import { qqPanelText } from './strings.ts';

type Text = ReturnType<typeof qqPanelText>;

type Kind = 'group' | 'private';

interface RosterView {
  roster: QQRoster;
  names: QQConvNames;
}

const NO_NAMES: QQConvNames = { groups: [], privates: [] };

export const rosterPanel: WebUiPanel = {
  mount(ctx: WebUiPanelContext) {
    const T = qqPanelText(ctx.language);
    autoload<RosterView>(ctx, {
      loading: T.rosterLoading,
      failed: T.rosterFailed,
      load: async () => ({
        roster: await ctx.invoke<QQRoster>('get'),
        names: await ctx.invoke<QQConvNames>('names').catch(() => NO_NAMES),
      }),
      render: (view, reload) => [sheet(ctx, view, reload, T)],
    });
  },
};

function sheet(ctx: WebUiPanelContext, view: RosterView, reload: () => void, T: Text): HTMLElement {
  const { ui } = ctx;
  const card = ui.sheet({
    title: T.rosterTitle,
    en: T.rosterEn,
    desc: T.rosterDesc,
  });

  const save = (action: string): void => {
    void ctx
      .invoke('set', [view.roster.groups, view.roster.privates])
      .then(
        () => { ui.toast(T.saved(action)); },
        (err: unknown) => { ui.toast(T.failed(action, errText(err)), 'bad'); },
      )
      .then(() => {
        reload();
        void ctx.refresh();
      });
  };

  for (const kind of ['group', 'private'] as const) {
    card.body.append(ui.section(T.words[kind].label), list(ctx, view, kind, save, T));
  }
  return card.el;
}

function list(
  ctx: WebUiPanelContext,
  view: RosterView,
  kind: Kind,
  save: (action: string) => void,
  T: Text,
): HTMLElement {
  const { ui } = ctx;
  const box = ui.h('div', 'qq-rosterlist');
  const entries = entriesOf(view.roster, kind);
  if (!entries.length) box.appendChild(ui.placeholder(T.words[kind].empty));
  for (const entry of entries) box.appendChild(card(ctx, view, kind, entry, save, T));
  box.appendChild(addRow(ctx, view, kind, save, T));
  return box;
}

function entriesOf(roster: QQRoster, kind: Kind): QQRosterEntry[] {
  return kind === 'group' ? roster.groups : roster.privates;
}

/** 号码在这份名单里已知的显示名;没有就返回 null(渲染成"等连上/等消息补全")。 */
function nameOf(view: RosterView, kind: Kind, id: number, T: Text): string | null {
  if (kind === 'group') {
    const g = view.names.groups.find((x) => x.id === id);
    return g ? `${g.name}${g.card ? T.myGroupCardParen(g.card) : ''}` : null;
  }
  const p = view.names.privates.find((x) => x.id === id);
  return p && p.name ? p.name : null;
}

function card(
  ctx: WebUiPanelContext,
  view: RosterView,
  kind: Kind,
  entry: QQRosterEntry,
  save: (action: string) => void,
  T: Text,
): HTMLElement {
  const { ui } = ctx;
  const row = ui.h('div', entry.enabled ? 'qq-rcard' : 'qq-rcard off');

  const toggle = ui.button(entry.enabled ? T.watching : T.paused, {
    size: 'sm',
    variant: entry.enabled ? 'primary' : 'plain',
    onClick: () => {
      entry.enabled = !entry.enabled;
      save(entry.enabled ? T.actionWatch : T.actionPause);
    },
  });
  toggle.title = entry.enabled ? T.pauseHint : T.watchHint;

  const idInput = ui.input({ value: String(entry.id), cls: 'mono', placeholder: T.words[kind].num });
  idInput.inputMode = 'numeric';
  idInput.addEventListener('change', () => {
    const n = Number(idInput.value.trim());
    const list = entriesOf(view.roster, kind);
    if (!Number.isInteger(n) || n <= 0) { idInput.value = String(entry.id); return; }
    if (n === entry.id) return;
    if (list.some((e) => e !== entry && e.id === n)) {
      ui.toast(T.duplicate, 'bad');
      idInput.value = String(entry.id);
      return;
    }
    entry.id = n;
    save(T.actionEditId);
  }, { signal: ctx.signal });
  idInput.addEventListener('keydown', (ev: KeyboardEvent) => {
    if (ev.key === 'Enter') idInput.blur();
  }, { signal: ctx.signal });

  const known = nameOf(view, kind, entry.id, T);
  const name = ui.h(
    'span',
    'qq-rc-name',
    known ?? (kind === 'group' ? T.groupUnknown : T.privateUnknown),
  );
  name.title = name.textContent ?? '';

  const del = ui.button('✕', {
    size: 'sm',
    variant: 'danger',
    onClick: () => { void remove(ctx, view, kind, entry, save, T); },
  });
  del.title = T.deleteHint;

  row.append(toggle, idInput, name, del);
  return row;
}

async function remove(
  ctx: WebUiPanelContext,
  view: RosterView,
  kind: Kind,
  entry: QQRosterEntry,
  save: (action: string) => void,
  T: Text,
): Promise<void> {
  const ok = await ctx.ui.confirm({
    title: kind === 'group' ? T.deleteGroupTitle(entry.id) : T.deletePrivateTitle(entry.id),
    body: T.deleteBody,
    danger: true,
  });
  if (!ok) return;
  const list = entriesOf(view.roster, kind);
  const i = list.indexOf(entry);
  if (i >= 0) list.splice(i, 1);
  save(T.actionDelete);
}

function addRow(
  ctx: WebUiPanelContext,
  view: RosterView,
  kind: Kind,
  save: (action: string) => void,
  T: Text,
): HTMLElement {
  const { ui } = ctx;
  const row = ui.h('div', 'qq-rcadd');
  const field = ui.input({ cls: 'mono', placeholder: T.words[kind].add });
  const doAdd = (): void => {
    const n = Number(field.value.trim());
    if (!Number.isInteger(n) || n <= 0) {
      ui.toast(T.invalidNumber(T.words[kind].num), 'bad');
      return;
    }
    const list = entriesOf(view.roster, kind);
    if (list.some((e) => e.id === n)) {
      ui.toast(T.duplicate, 'bad');
      return;
    }
    list.push({ id: n, enabled: true });
    field.value = '';
    save(T.actionAdd);
  };
  field.addEventListener('keydown', (ev: KeyboardEvent) => {
    if (ev.key === 'Enter') doAdd();
  }, { signal: ctx.signal });
  row.append(ui.h('span'), field, ui.button(T.addButton, { size: 'sm', variant: 'primary', onClick: doAdd }));
  return row;
}
