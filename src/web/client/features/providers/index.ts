/**
 * 「语言模型」页 —— 模型供应模块的入口。
 *
 * 左侧次级菜单列出 manifest 里 kind 为 `llm` 的页(每个供应模块一条),右侧由
 * 嵌入的控制台页宿主渲染选中模块的面板:实例与模型、授权、托管、参数。这一页不认识
 * 任何具体模块——名字、灯、徽标与面板全部来自 manifest。
 *
 * 路由 `#/providers/<pageId>/<panelId>`:第二段选模块,第三段选面板;缺省取第一个
 * 模块及其第一个面板。面板页签由宿主渲染并指向同一前缀,所以切换留在本页内。
 */

import { PROVIDERS_LAMP_ID } from '../../../shared/console-protocol.ts';
import { lampRow, paintLamps, subscribeLamps } from '../../ui/lamp.ts';
import { pageIntro } from '../../ui/page.ts';
import type { Route } from '../../core/router.ts';
import type { FeatureContext, FrameworkFeature } from '../feature.ts';
import { S } from './strings.ts';

const PROVIDERS_ROUTE = 'providers';
/** 这一页只列供应模块;人格与 IO 各有自己的入口。 */
const PROVIDER_KIND = 'llm';

export async function mountProviders(ctx: FeatureContext): Promise<void> {
  const { ui, root } = ctx;
  const doc = root.ownerDocument;
  const intro = pageIntro(ui, S.pageTitle);
  const layout = ui.h('div', 'settings-layout providerhub');
  const index = ui.h('nav', 'settings-index');
  index.setAttribute('aria-label', S.modulesAria);
  index.setAttribute('role', 'tablist');
  const content = ui.h('div', 'settings-content');
  layout.append(index, content);
  root.append(intro, layout);

  if (!ctx.consolePageHost) {
    content.appendChild(ui.placeholder(S.needHost));
    return;
  }
  const host = ctx.consolePageHost({
    root: content,
    route: (pageId, panelId) => [PROVIDERS_ROUTE, pageId, panelId],
  });
  ctx.lifecycle.own({ dispose: () => host.unmount() });
  content.appendChild(ui.placeholder(S.loading));
  await host.load();
  if (ctx.signal.aborted) return;

  const providers = host.pages.filter((p) => p.kind === PROVIDER_KIND);
  if (!providers.length) {
    content.replaceChildren(ui.placeholder(S.none));
    return;
  }

  const jumps = new Map<string, HTMLButtonElement>();
  const lampNodes = new Map<string, HTMLSpanElement>();
  for (const p of providers) {
    const jump = ui.h('button', 'settings-jump providerhub-jump');
    jump.type = 'button';
    jump.setAttribute('role', 'tab');
    jump.append(ui.h('span', 'lbl', p.label || p.id));
    const lamps = lampRow(doc, p.lamps ?? []);
    jump.appendChild(lamps);
    lampNodes.set(p.id, lamps);
    jump.addEventListener('click', () => {
      try { ctx.router.navigate([PROVIDERS_ROUTE, p.id]); } catch (err) { ctx.onError(err); }
    }, { signal: ctx.signal });
    index.appendChild(jump);
    jumps.set(p.id, jump);
  }
  // 灯的活数据只改那几个点,不重排菜单(与左栏同一节拍)。
  ctx.lifecycle.own(subscribeLamps(doc, (lamps) => {
    for (const [id, el] of lampNodes) paintLamps(el, lamps[id] ?? []);
  }));

  const show = (route: Route): void => {
    const wanted = route.segments[1];
    const provider = providers.find((p) => p.id === wanted) ?? providers[0]!;
    for (const [id, jump] of jumps) {
      const on = id === provider.id;
      jump.classList.toggle('active', on);
      jump.setAttribute('aria-selected', String(on));
    }
    const panel = route.segments[2];
    void host.show(provider.id, typeof panel === 'string' && panel !== '' ? panel : undefined);
  };
  show(ctx.route);
  ctx.lifecycle.own(ctx.router.onChange((route) => {
    if (route.segments[0] !== PROVIDERS_ROUTE) return;
    show(route);
  }));
}

export const providersFeature: FrameworkFeature = {
  route: PROVIDERS_ROUTE,
  label: S.navLabel,
  icon: 'cpu',
  lampId: PROVIDERS_LAMP_ID,
  navGroup: S.navGroup,
  mount: mountProviders,
};
