/** 扩展管理页。扩展信息与运行状态由服务端提供；安装、卸载后需重启进程才能生效。 */

import { get, post } from '../../core/api.ts';
import { pageIntro } from '../../ui/page.ts';
import type { FeatureContext, FrameworkFeature } from '../feature.ts';
import { S } from './strings.ts';

/** 扩展类别。与 `ExtensionKind` 同形;这一页只用它分组与选关键字。 */
export type ExtensionKindView = 'world' | 'provider' | 'bot';

/** 与 `src/web/server.ts` 的 `ExtensionInfo` 同形。 */
export interface ExtensionView {
  name: string;
  spec: string;
  version: string | null;
  description?: string;
  kind?: ExtensionKindView;
  api?: number;
  consoleClient: boolean;
  console?: 'none' | 'served' | 'missing';
  loaded: boolean;
  reason?: string;
  worldId?: string;
  label?: string;
  state: 'loaded' | 'failed' | 'pending-restart' | 'removed' | 'idle';
}

/** 与 `ExtensionSearchHit` 同形。 */
export interface SearchHitView {
  name: string;
  version: string;
  description: string;
  date?: string;
  publisher?: string;
  downloads: number;
  links: { npm?: string; repository?: string; homepage?: string };
  installed: boolean;
  kind?: ExtensionKindView;
}

interface PowerReport {
  ok?: boolean;
  localComplete?: boolean;
  result?: string;
  error?: string;
  steps?: Array<{ label: string; ok: boolean; elapsedMs: number; detail?: string }>;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAbort(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === 'AbortError';
}

/**
 * 手动安装框里的一行:含路径分隔符或以 `.` 开头的当本机目录,其余按 `name[@version]`
 * 拆(作用域包的第一个 `@` 是名字的一部分)。
 */
export function parseInstallInput(raw: string): { name: string; version?: string } | { path: string } | null {
  const text = raw.trim();
  if (!text) return null;
  if (text.startsWith('.') || text.includes('/') && !text.startsWith('@') || text.includes('\\') || /^[A-Za-z]:/.test(text)) {
    return { path: text };
  }
  const at = text.indexOf('@', 1);
  if (at < 0) return { name: text };
  return { name: text.slice(0, at), version: text.slice(at + 1) };
}

const STATE_LABEL: Record<ExtensionView['state'], string> = {
  loaded: S.stateLoaded,
  failed: S.stateFailed,
  'pending-restart': S.statePendingRestart,
  removed: S.stateRemoved,
  idle: S.stateIdle,
};

const KIND_LABEL: Record<ExtensionKindView, string> = {
  world: 'World',
  provider: 'LLM Provider',
  bot: 'Bot',
};

/** 卡片副标题里 id 前面的那个词。 */
const KIND_NOUN: Record<ExtensionKindView, string> = {
  world: 'World',
  provider: 'provider',
  bot: 'bot',
};

/** npm 上按类发现用的关键字。与 `src/extensions/manifest.ts` 的 `EXTENSION_KEYWORDS` 对齐。 */
const KIND_KEYWORD: Record<ExtensionKindView, string> = {
  world: 'cortico-world',
  provider: 'cortico-provider',
  bot: 'cortico-bot',
};

/** 已安装清单的分组。`kind` 为 null 的一组收所有读不出 manifest 的包。 */
const GROUPS: ReadonlyArray<{ kind: ExtensionKindView | null; title: string; desc: string }> = [
  { kind: 'world', title: KIND_LABEL.world, desc: S.groupWorldDesc },
  { kind: 'provider', title: KIND_LABEL.provider, desc: S.groupProviderDesc },
  { kind: 'bot', title: KIND_LABEL.bot, desc: S.groupBotDesc },
  { kind: null, title: S.groupUnknownTitle, desc: S.groupUnknownDesc },
];

export function mountExtensions(ctx: FeatureContext): void {
  const { ui, root } = ctx;
  const view = root.ownerDocument?.defaultView ?? null;
  const canRestart = ctx.capabilities.restart === true;
  const supervised = ctx.capabilities.supervised === true;

  const intro = pageIntro(ui, S.introTitle, S.introDesc);

  // -------------------------------------------------------------------------
  // 已安装
  // -------------------------------------------------------------------------

  const installedSheet = ui.sheet({
    title: S.installedTitle,
    en: 'extensions/',
  });
  const sumBar = ui.rowbar();
  const msg = ui.msgline();
  const refreshBtn = ui.button(S.refresh, { size: 'sm', onClick: () => void load() });
  const restartBtn = ui.button(S.restartProcess, {
    size: 'sm',
    variant: 'primary',
    onClick: (ev) => void restartProcess(ev.currentTarget as HTMLButtonElement),
  });
  installedSheet.body.append(sumBar, msg);
  /** 分组容器:每组一条 section 标题 + 一张 `.iogrid`。 */
  const installedGroups = ui.h('div');

  function setMsg(text: string, bad?: boolean): void {
    msg.textContent = text;
    msg.className = 'msgline' + (bad ? ' bad' : '');
  }

  /**
   * 重启 = 落标志 + 规范关机。没有启动器循环时它就是一次关机,确认框上说清楚。
   * `confirmed` = 调用方已经问过一遍(装完那一问),不再重复。
   */
  async function restartProcess(btn?: HTMLButtonElement, confirmed = false): Promise<void> {
    if (!canRestart) return;
    if (!confirmed) {
      const ok = await ui.confirm({
        title: supervised ? S.restartConfirmTitle : S.restartNoLoopTitle,
        body: supervised ? S.restartConfirmBody : S.restartNoLoopBody,
        danger: !supervised,
      });
      if (!ok || ctx.signal.aborted) return;
    }
    const lock = btn ? ui.disable(btn) : null;
    const hold = ui.toast(S.finishingToast);
    try {
      const out = await post<PowerReport>('/api/run/restart', undefined, { signal: ctx.signal });
      if (ctx.signal.aborted) return;
      if (out?.error) throw new Error(out.error);
      const lines = (out?.steps ?? []).map((s) =>
        `${s.ok ? '✓' : '✗'} ${s.label} · ${(s.elapsedMs / 1000).toFixed(1)}s${s.ok ? '' : ` — ${s.detail ?? S.stepIncomplete}`}`);
      void ui.confirm({
        title: supervised ? S.doneRestartSupervised : S.doneRestart,
        body: [out?.result ?? S.resultDefault, '', ...lines].join('\n'),
      });
    } catch (err) {
      if (isAbort(err) || ctx.signal.aborted) return;
      // 连接在收尾途中断掉是预期之一:进程退出得比回执快。
      ui.toast(S.noReceipt(errText(err)), 'bad');
    } finally {
      hold.dispose();
      lock?.dispose();
    }
  }

  async function uninstall(p: ExtensionView, btn: HTMLButtonElement): Promise<void> {
    const ok = await ui.confirm({
      title: S.uninstallTitle(p.label || p.name),
      body: S.uninstallBody(p.name),
      danger: true,
    });
    if (!ok || ctx.signal.aborted) return;
    const lock = ui.disable(btn);
    const hold = ui.toast(S.uninstalling);
    try {
      const out = await post<{ result?: string }>('/api/extensions/uninstall', { name: p.name }, { signal: ctx.signal });
      if (ctx.signal.aborted) return;
      setMsg(out?.result?.split('\n')[0] || S.uninstalled);
      await load();
    } catch (err) {
      if (isAbort(err) || ctx.signal.aborted) return;
      setMsg(S.uninstallFailed(errText(err)), true);
    } finally {
      hold.dispose();
      lock.dispose();
    }
  }

  /** 装完问一句要不要顺手重启;答"否"也留在清单里标「待重启」。 */
  async function install(target: { name: string; version?: string } | { path: string }, btn?: HTMLButtonElement): Promise<void> {
    const lock = btn ? ui.disable(btn) : null;
    const hold = ui.toast(S.installing);
    let result = '';
    try {
      const out = await post<{ result?: string }>('/api/extensions/install', target, { signal: ctx.signal });
      if (ctx.signal.aborted) return;
      result = out?.result ?? S.installed;
      setMsg(result.split('\n')[0]);
      await load();
    } catch (err) {
      if (isAbort(err) || ctx.signal.aborted) return;
      setMsg(S.installFailed(errText(err)), true);
      return;
    } finally {
      hold.dispose();
      lock?.dispose();
    }
    if (!canRestart) return;
    const go = await ui.confirm({
      title: S.installedRestartTitle,
      body: result + '\n\n' + (supervised ? S.installedRestartNote : S.installedNoLoopNote),
      danger: !supervised,
    });
    if (!go || ctx.signal.aborted) return;
    await restartProcess(undefined, true);
  }

  function extensionCard(p: ExtensionView): HTMLElement {
    const en = `${p.name}@${p.version ?? '?'}${p.worldId && p.kind ? ` · ${KIND_NOUN[p.kind]} ${p.worldId}` : ''}`;
    const card = ui.sheet({ title: p.label || p.name, en });
    card.el.classList.add('iocard');
    if (p.state !== 'loaded') card.el.classList.add('iocard-inactive');
    const bar = ui.rowbar();
    bar.append(ui.pill(STATE_LABEL[p.state], p.state === 'loaded' ? 'on' : 'off'));
    if (p.kind) bar.appendChild(ui.pill(KIND_LABEL[p.kind]));
    if (p.api !== undefined) bar.appendChild(ui.chip(`v${p.api}`));
    if (p.console === 'served') bar.appendChild(ui.pill(S.panelLoaded, 'on'));
    card.body.appendChild(bar);
    if (p.description) card.body.appendChild(ui.msgline(p.description));
    if (p.reason) card.body.appendChild(ui.msgline(p.reason, true));
    if (p.state === 'idle') card.body.appendChild(ui.msgline(S.noteIdle));
    if (p.console === 'missing') card.body.appendChild(ui.msgline(S.noteConsoleMissing, true));
    if (p.state !== 'removed') {
      const actions = ui.actions();
      actions.appendChild(ui.button(S.uninstall, {
        size: 'sm',
        variant: 'danger',
        onClick: (ev) => void uninstall(p, ev.currentTarget as HTMLButtonElement),
      }));
      card.body.appendChild(actions);
    }
    return card.el;
  }

  function renderInstalled(extensions: readonly ExtensionView[], dir: string): void {
    sumBar.replaceChildren();
    installedGroups.replaceChildren();
    const loaded = extensions.filter((p) => p.state === 'loaded').length;
    const pending = extensions.filter((p) => p.state === 'pending-restart' || p.state === 'removed').length;
    const failed = extensions.filter((p) => p.state === 'failed').length;
    sumBar.appendChild(ui.pill(S.sumLoaded(loaded), 'on'));
    if (pending > 0) sumBar.appendChild(ui.pill(S.sumPending(pending), 'off'));
    if (failed > 0) sumBar.appendChild(ui.pill(S.sumFailed(failed), 'off'));
    sumBar.appendChild(ui.chip(dir));
    sumBar.append(ui.h('span', 'grow'), refreshBtn);
    if (canRestart) sumBar.appendChild(restartBtn);
    if (extensions.length === 0) {
      installedGroups.appendChild(ui.placeholder(S.noExtensions));
      return;
    }
    for (const g of GROUPS) {
      const mine = extensions.filter((p) => (p.kind ?? null) === g.kind);
      if (mine.length === 0) continue;
      const grid = ui.h('div', 'iogrid');
      for (const p of mine) grid.appendChild(extensionCard(p));
      installedGroups.append(ui.section(g.title, g.desc), grid);
    }
  }

  async function load(): Promise<void> {
    try {
      const data = await get<{ dir?: string; extensions?: ExtensionView[] }>('/api/extensions', { signal: ctx.signal });
      if (ctx.signal.aborted) return;
      renderInstalled(Array.isArray(data?.extensions) ? data.extensions : [], data?.dir ?? '');
    } catch (err) {
      if (isAbort(err) || ctx.signal.aborted) return;
      installedGroups.replaceChildren(ui.placeholder(S.listLoadFailed(errText(err))));
    }
  }

  // -------------------------------------------------------------------------
  // 搜索 npm
  // -------------------------------------------------------------------------

  const searchSheet = ui.sheet({
    title: S.searchTitle,
    en: 'npm registry',
    desc: S.searchDesc,
  });
  let searchKind: ExtensionKindView = 'world';
  const searchBar = ui.rowbar();
  const kindSeg = ui.segmented(
    [
      { value: 'world', label: KIND_LABEL.world },
      { value: 'provider', label: KIND_LABEL.provider },
      { value: 'bot', label: KIND_LABEL.bot },
    ],
    {
      size: 'sm',
      value: searchKind,
      onSelect: (v) => {
        searchKind = v as ExtensionKindView;
        paintKeyword();
        // 换了类就换了关键字,上一类的命中留在屏幕上会被当成这一类的结果
        resultGrid.replaceChildren();
        searchMsg.textContent = '';
      },
    },
  );
  const searchInput = ui.input({ type: 'search', placeholder: S.searchPlaceholder });
  const searchBtn = ui.button(S.search, { size: 'sm', variant: 'primary', onClick: () => void search() });
  searchInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') void search(); }, { signal: ctx.signal });
  searchBar.append(kindSeg.el, searchInput, searchBtn);
  const keywordLine = ui.msgline();
  function paintKeyword(): void {
    keywordLine.textContent = S.searchKeywordNote(KIND_KEYWORD[searchKind]);
  }
  paintKeyword();
  const searchMsg = ui.msgline();
  const resultGrid = ui.h('div', 'iogrid');
  searchSheet.body.append(searchBar, keywordLine, searchMsg, resultGrid);

  function openLink(href: string): void {
    view?.open(href, '_blank', 'noopener');
  }

  function hitCard(h: SearchHitView): HTMLElement {
    const card = ui.sheet({ title: h.name, en: S.hitMeta(h.version, h.downloads, h.publisher) });
    card.el.classList.add('iocard');
    if (h.kind) {
      const bar = ui.rowbar();
      bar.appendChild(ui.pill(KIND_LABEL[h.kind]));
      card.body.appendChild(bar);
    }
    if (h.description) card.body.appendChild(ui.msgline(h.description));
    const actions = ui.actions();
    const links: Array<[string, string | undefined]> = [['npm', h.links.npm], [S.linkRepo, h.links.repository], [S.linkHome, h.links.homepage]];
    for (const [label, href] of links) {
      if (href) actions.appendChild(ui.button(label, { size: 'sm', onClick: () => openLink(href) }));
    }
    const installBtn = ui.button(h.installed ? S.alreadyInstalled : S.install, {
      size: 'sm',
      variant: 'primary',
      onClick: (ev) => void install({ name: h.name, version: h.version }, ev.currentTarget as HTMLButtonElement),
    });
    installBtn.disabled = h.installed;
    actions.appendChild(installBtn);
    card.body.appendChild(actions);
    return card.el;
  }

  async function search(): Promise<void> {
    const lock = ui.disable(searchBtn);
    searchMsg.textContent = S.searching;
    searchMsg.className = 'msgline';
    try {
      const q = encodeURIComponent(searchInput.value.trim());
      const data = await get<{ hits?: SearchHitView[] }>(
        `/api/extensions/search?q=${q}&kind=${searchKind}`,
        { signal: ctx.signal },
      );
      if (ctx.signal.aborted) return;
      const hits = Array.isArray(data?.hits) ? data.hits : [];
      resultGrid.replaceChildren();
      searchMsg.textContent = hits.length === 0 ? S.noHits : S.hitCount(hits.length);
      for (const h of hits) resultGrid.appendChild(hitCard(h));
    } catch (err) {
      if (isAbort(err) || ctx.signal.aborted) return;
      searchMsg.textContent = S.searchFailed(errText(err));
      searchMsg.className = 'msgline bad';
    } finally {
      lock.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // 手动安装
  // -------------------------------------------------------------------------

  const manualSheet = ui.sheet({
    title: S.manualTitle,
    en: 'name@version · ./path',
    desc: S.manualDesc,
  });
  const manualBar = ui.rowbar();
  const manualInput = ui.input({ cls: 'mono', placeholder: S.manualPlaceholder });
  const manualBtn = ui.button(S.install, {
    size: 'sm',
    variant: 'primary',
    onClick: (ev) => {
      const target = parseInstallInput(manualInput.value);
      if (!target) { setMsg(S.manualEmpty, true); return; }
      void install(target, ev.currentTarget as HTMLButtonElement);
    },
  });
  manualBar.append(manualInput, manualBtn);
  manualSheet.body.append(manualBar);

  root.append(intro, installedSheet.el, installedGroups, searchSheet.el, manualSheet.el);
  installedGroups.appendChild(ui.placeholder(S.loading));
  void load();
}

export const extensionsFeature: FrameworkFeature = {
  route: 'extensions',
  label: S.navLabel,
  icon: 'download',
  navGroup: S.navGroup,
  needsAny: ['extensions'],
  mount: mountExtensions,
};
