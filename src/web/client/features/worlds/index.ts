/**
 * 按 /api/worlds 展示 active、inactive、missing 状态及声明信息。
 * visibility 改变 agent 可见性，World 继续运行；restart 重建实例以应用构造时参数。
 * activation 写入 worlds.<id>.enabled 并挂载或卸载。详情由各 World 的控制台页提供。
 */

import { pageIdFor } from '../../../shared/console-protocol.ts';
import type { ConsoleBadge, ConsoleLamp, ConsoleLink } from '../../../shared/console-protocol.ts';
import { get, post } from '../../core/api.ts';
import { PROVIDER_ROUTE } from '../../console-pages/host.ts';
import { resolveConsoleLinkHref } from '../../theme/handoff.ts';
import { icon, type ConsoleIconName } from '../../ui/icons.ts';
import { lampRow, paintLamps, subscribeLamps } from '../../ui/lamp.ts';
import { pageIntro } from '../../ui/page.ts';
import type { FeatureContext, FrameworkFeature } from '../feature.ts';
import { S } from './strings.ts';

/** World 控制台页 id 使用 world:<id>。 */
const WORLD_PAGE_KIND = 'world';

/** 某个 World 那一页的路由:`#/provider/<kind>:<id>`。 */
function worldPageId(id: string): string {
  return pageIdFor(WORLD_PAGE_KIND, id);
}

/**
 * 清单里的一条。字段与 `src/web/server.ts` 的 `ConsoleWorldInfo` 同形——那是三个
 * 接口的联合,这里摊平成一个可选字段都全的形状:这一页按 `status` 分支渲染。
 */
export interface WorldView {
  id: string;
  status: 'active' | 'inactive' | 'missing';
  /** World 自报的状态灯,一条链路一颗(仅 active 有意义)。 */
  lamps?: ConsoleLamp[];
  /** 人类可读名;没有就退回 id。 */
  label?: string;
  /** Persona定义的渠道;false = 部署侧选配的外挂;undefined = 没说。 */
  declared?: boolean;
  /** 当前对 agent 可见(仅 active 有意义)。 */
  visible?: boolean;
  /** 可见性已改,但当前 system 前缀还是按旧的烘出来的。 */
  prefixDrifted?: boolean;
  /** 装不上的原因(仅 missing)。原样显示,这一页不改写措辞。 */
  reason?: string;
  workspace?: string;
  tools?: string[];
  badges?: ConsoleBadge[];
  links?: ConsoleLink[];
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAbort(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === 'AbortError';
}

/**
 * 渲染顺序:已挂载 → 未激活 → 未安装。同一状态内保持服务端顺序(那就是装配顺序)。
 */
function sortWorlds(worlds: readonly WorldView[]): WorldView[] {
  const rank: Record<WorldView['status'], number> = { active: 0, inactive: 1, missing: 2 };
  return [...worlds].sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9));
}

export function mountWorlds(ctx: FeatureContext): void {
  const { ui, root } = ctx;
  const doc = root.ownerDocument;
  /** page id → 这张卡上那排灯的容器。轮询只碰这些节点。 */
  const lampNodes = new Map<string, HTMLSpanElement>();
  /** 灯的轮询只更新灯节点，不重新获取清单或重建卡片。 */
  ctx.lifecycle.own(subscribeLamps(doc, (lamps) => {
    for (const [id, el] of lampNodes) paintLamps(el, lamps[id] ?? []);
  }));

  const intro = pageIntro(ui, S.introTitle);
  const canToggleVisibility = ctx.capabilities.worldVisibility === true;
  const canActivate = ctx.capabilities.worldActivation === true;

  const sheet = ui.sheet({
    title: S.sheetTitle,
    en: 'active / inactive / missing',

  });
  const sumBar = ui.rowbar();
  const msg = ui.msgline();
  const reloadBtn = ui.button(S.reloadPrefixBtn, {
    size: 'sm',
    onClick: () => void reloadPrefix(reloadBtn),
  });
  sheet.body.append(sumBar, msg);
  const grid = ui.h('div', 'iogrid');
  root.append(intro, sheet.el, grid);

  function setMsg(text: string, bad?: boolean): void {
    msg.textContent = text;
    msg.className = 'msgline' + (bad ? ' bad' : '');
  }

  // -------------------------------------------------------------------------
  // 动作
  // -------------------------------------------------------------------------

  async function reloadPrefix(btn?: HTMLButtonElement): Promise<void> {
    const lock = btn ? ui.disable(btn) : null;
    try {
      const out = await post<{ result?: string }>(
        '/api/session/reload-prefix',
        undefined,
        { signal: ctx.signal },
      );
      if (ctx.signal.aborted) return;
      setMsg(out?.result || S.prefixReloaded);
      await load();
    } catch (err) {
      if (isAbort(err) || ctx.signal.aborted) return;
      setMsg(S.prefixReloadFailed(errText(err)), true);
    } finally {
      lock?.dispose();
    }
  }

  /**
   * 可见性只改「对 agent 是否可见」。事件投递立即生效;环境提示词与工具同属缓存前缀,
   * 要等一次前缀重载才跟上——所以服务端报了漂移时问一句,操作者说了算。
   */
  async function toggleVisibility(
    m: WorldView,
    wantVisible: boolean,
    btn: HTMLButtonElement,
  ): Promise<void> {
    const lock = ui.disable(btn);
    let drifted = 0;
    try {
      const out = await post<{ result?: string; driftedWorlds?: string[] }>(
        '/api/worlds/visibility',
        { id: m.id, visible: wantVisible },
        { signal: ctx.signal },
      );
      if (ctx.signal.aborted) return;
      setMsg(out?.result || S.updated);
      drifted = (out?.driftedWorlds ?? []).length;
      await load();
    } catch (err) {
      if (isAbort(err) || ctx.signal.aborted) return;
      setMsg(S.toggleFailed(errText(err)), true);
      return;
    } finally {
      lock.dispose();
    }
    if (drifted === 0) return;
    const name = m.label || m.id;
    const ok = await ui.confirm({
      title: S.reloadNowTitle,
      body: S.reloadNowBody(name, wantVisible),
    });
    if (!ok || ctx.signal.aborted) return;
    await reloadPrefix();
  }

  /** 激活、停用与重启请求执行期间禁用相关按钮，完成后刷新清单。 */
  async function activation(m: WorldView, wantEnabled: boolean, btn: HTMLButtonElement): Promise<void> {
    const name = m.label || m.id;
    if (!wantEnabled) {
      const ok = await ui.confirm({
        title: S.deactivateTitle(name),
        body: S.deactivateBody(m.id),
        danger: true,
      });
      if (!ok || ctx.signal.aborted) return;
    }
    const lock = ui.disable(btn);
    try {
      const out = await post<{ result?: string }>(
        '/api/worlds/activation',
        { id: m.id, enabled: wantEnabled },
        { signal: ctx.signal },
      );
      if (ctx.signal.aborted) return;
      setMsg(out?.result || (wantEnabled ? S.activated : S.deactivated));
      // 左栏重排失败只是导航旧了一拍,激活本身已经成功,不进上面那行的失败文案。
      void ctx.refreshNav?.().catch(ctx.onError);
      await load();
    } catch (err) {
      if (isAbort(err) || ctx.signal.aborted) return;
      setMsg(wantEnabled ? S.activateFailed(errText(err)) : S.deactivateFailed(errText(err)), true);
    } finally {
      lock.dispose();
    }
  }

  async function restart(m: WorldView, btn: HTMLButtonElement): Promise<void> {
    const name = m.label || m.id;
    const ok = await ui.confirm({
      title: S.restartTitle(name),
      body: S.restartBody,
    });
    if (!ok || ctx.signal.aborted) return;
    const lock = ui.disable(btn);
    try {
      const out = await post<{ result?: string }>(
        '/api/worlds/restart',
        { id: m.id },
        { signal: ctx.signal },
      );
      if (ctx.signal.aborted) return;
      setMsg(out?.result || S.restarted);
      await load();
    } catch (err) {
      if (isAbort(err) || ctx.signal.aborted) return;
      setMsg(S.restartFailed(errText(err)), true);
    } finally {
      lock.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  /** 卡角上的一颗图标键:只有图形,名字在 title / aria-label 上。 */
  function iconButton(
    name: ConsoleIconName,
    label: string,
    cls: string,
    onClick: (btn: HTMLButtonElement) => void,
  ): HTMLButtonElement {
    const btn = ui.h('button', `iobtn ${cls}`);
    btn.type = 'button';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.appendChild(icon(doc, name));
    btn.addEventListener('click', () => onClick(btn), { signal: ctx.signal });
    return btn;
  }

  /** World 自己声明的徽标,原样摆上去,控制台不解释语义。 */
  function badgePills(m: WorldView): HTMLSpanElement[] {
    return (m.badges ?? []).map((b) => ui.pill(`${b.label} ${b.value}`, b.tone));
  }

  /** active 状态使用 World 自报读数；其余状态显示框架提供的灰灯。 */
  function cardLamps(m: WorldView): HTMLSpanElement {
    const el = lampRow(doc, m.status === 'active'
      ? m.lamps ?? []
      : [{ label: S.lampAssembly, state: 'offline', hint: m.status === 'missing' ? S.notInstalled : S.notActive }]);
    if (m.status === 'active') lampNodes.set(worldPageId(m.id), el);
    return el;
  }

  /** 显示 Persona 声明或部署选配来源；缺失时不显示。 */
  function declaredPills(m: WorldView): HTMLSpanElement[] {
    if (m.declared === undefined) return [];
    return [ui.pill(m.declared ? S.declaredByPersona : S.optionalAddon)];
  }

  /** 打开 World 自己声明的外部页面。链接是 World 给的,这一页不解析它的语义。 */
  function linkButtons(m: WorldView): HTMLButtonElement[] {
    const view = ctx.root.ownerDocument?.defaultView ?? null;
    const out: HTMLButtonElement[] = [];
    for (const link of m.links ?? []) {
      if (!link || !link.href) continue;
      out.push(ui.button(link.label || S.open, {
        size: 'sm',
        variant: 'primary',
        onClick: () => {
          view?.open(resolveConsoleLinkHref(ctx.root.ownerDocument, link), '_blank', 'noopener');
        },
      }));
    }
    return out;
  }

  /** 进这个 World 的详情。详情页归 World 自己那一页,这一页只是入口。 */
  function detailButton(m: WorldView): HTMLButtonElement {
    return ui.button(S.details, {
      size: 'sm',
      onClick: () => ctx.router.navigate([PROVIDER_ROUTE, worldPageId(m.id)]),
    });
  }

  function cardShell(m: WorldView, tools: readonly string[], corner: HTMLButtonElement[]): { el: HTMLElement; body: HTMLElement } {
    const card = ui.sheet({ title: m.label || m.id, en: S.toolsCount(m.id, tools.length) });
    card.el.classList.add('iocard');
    if (corner.length > 0) {
      const box = ui.h('div', 'iocorner');
      box.append(...corner);
      card.el.appendChild(box);
    }
    return card;
  }

  /** 不可用的 World 显示实际原因。 */
  function missingCard(m: WorldView): HTMLElement {
    const card = cardShell(m, [], []);
    card.el.classList.add('iocard-missing');
    const bar = ui.rowbar();
    bar.append(cardLamps(m), ui.pill(S.notInstalled, 'off'), ...declaredPills(m));
    card.body.appendChild(bar);
    card.body.appendChild(ui.msgline(m.reason || S.missingReasonDefault, true));
    return card.el;
  }

  /** 未激活:角上一颗「激活」;没接激活开关时改成一句怎么手改 config 的说明。 */
  function inactiveCard(m: WorldView): HTMLElement {
    const corner = canActivate
      ? [iconButton('power', S.activateWorld, 'iobtn-start', (btn) => { void activation(m, true, btn); })]
      : [];
    const card = cardShell(m, [], corner);
    card.el.classList.add('iocard-inactive');
    const bar = ui.rowbar();
    bar.append(cardLamps(m), ui.pill(S.notActive, 'off'), ...declaredPills(m));
    card.body.appendChild(bar);
    card.body.appendChild(ui.msgline(
      canActivate
        ? S.inactiveNoteActivatable
        : S.inactiveNoteManual(m.id),
    ));
    const actions = ui.actions();
    actions.append(detailButton(m));
    card.body.appendChild(actions);
    return card.el;
  }

  /** 已挂载:右上角依次是可见性(热)、重启、停用。 */
  function activeCard(m: WorldView): HTMLElement {
    const tools = m.tools ?? [];
    const visible = m.visible !== false;
    const corner: HTMLButtonElement[] = [];
    if (canToggleVisibility) {
      corner.push(iconButton(
        visible ? 'eye' : 'eye-off',
        visible ? S.hideFromAgent : S.showToAgent,
        visible ? 'iobtn-visible' : 'iobtn-hidden',
        (btn) => { void toggleVisibility(m, !visible, btn); },
      ));
    }
    if (canActivate) {
      corner.push(
        iconButton('refresh', S.restartWorld, 'iobtn-restart', (btn) => { void restart(m, btn); }),
        iconButton('power', S.deactivateWorld, 'iobtn-stop', (btn) => { void activation(m, false, btn); }),
      );
    }
    const card = cardShell(m, tools, corner);
    if (!visible) card.el.classList.add('iocard-hidden');

    const bar = ui.rowbar();
    bar.append(cardLamps(m), ...badgePills(m));
    bar.append(
      ui.pill(visible ? S.visibleToAgent : S.hidden, visible ? 'on' : 'off'),
      ...declaredPills(m),
    );
    if (m.prefixDrifted) bar.appendChild(ui.pill(S.prefixPending));
    card.body.appendChild(bar);

    card.body.appendChild(ui.kv([
      { k: S.kvTools, v: tools.join(S.listSep) || S.kvNone },
      { k: S.kvWorkspace, v: m.workspace || '—' },
    ]));

    if (m.prefixDrifted) {
      card.body.appendChild(ui.msgline(S.driftNote));
    }
    const actions = ui.actions();
    actions.append(...linkButtons(m), detailButton(m));
    card.body.appendChild(actions);
    return card.el;
  }

  function worldCard(m: WorldView): HTMLElement {
    if (m.status === 'missing') return missingCard(m);
    if (m.status === 'inactive') return inactiveCard(m);
    return activeCard(m);
  }

  function render(worlds: readonly WorldView[]): void {
    sumBar.replaceChildren();
    grid.replaceChildren();
    lampNodes.clear();

    const active = worlds.filter((m) => m.status === 'active');
    const inactive = worlds.filter((m) => m.status === 'inactive');
    const missing = worlds.filter((m) => m.status === 'missing');
    const hidden = active.filter((m) => m.visible === false).length;

    sumBar.appendChild(ui.pill(S.sumVisible(active.length - hidden), 'on'));
    if (hidden > 0) sumBar.appendChild(ui.pill(S.sumHidden(hidden), 'off'));
    if (inactive.length > 0) sumBar.appendChild(ui.pill(S.sumInactive(inactive.length), 'off'));
    if (missing.length > 0) sumBar.appendChild(ui.pill(S.sumMissing(missing.length), 'off'));
    sumBar.append(ui.h('span', 'grow'), reloadBtn);

    if (worlds.length === 0) {
      grid.appendChild(ui.placeholder(S.noWorlds));
      return;
    }
    for (const m of sortWorlds(worlds)) grid.appendChild(worldCard(m));
  }

  async function load(): Promise<void> {
    try {
      const data = await get<{ worlds?: WorldView[] }>('/api/worlds', { signal: ctx.signal });
      if (ctx.signal.aborted) return;
      render(Array.isArray(data?.worlds) ? data.worlds : []);
    } catch (err) {
      if (isAbort(err) || ctx.signal.aborted) return;
      grid.replaceChildren(ui.placeholder(S.listLoadFailed(errText(err))));
    }
  }

  grid.appendChild(ui.placeholder(S.loading));
  void load();
}

/**
 * `route` 沿用旧的 `worlds`:用户的书签与外部链接都指着它。
 */
export const worldsFeature: FrameworkFeature = {
  route: 'world',
  label: S.navLabel,
  icon: 'boxes',
  navMode: 'world-root',
  needs: ['worlds'],
  mount: mountWorlds,
};
