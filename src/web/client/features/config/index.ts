/**
 * 运行参数页显示尚未被任何控制台页认领的配置组。认领关系由 manifest.configGroups 显式提供，不从 owner 推断；已认领组在所属页展示。渲染和保存复用 view.ts。
 */

import { fetchManifest } from '../../core/api.ts';
import { pageIntro } from '../../ui/page.ts';
import type { FeatureContext, FrameworkFeature } from '../feature.ts';
import { S } from './strings.ts';
import { createConfigView } from './view.ts';

export {
  configField,
  createConfigView,
  type ConfigField,
  type ConfigGroup,
  type ConfigGroupEntry,
  type ConfigProperty,
  type ConfigValue,
} from './view.ts';

/** manifest 不可用时返回空认领集合，使运行参数页展示全部配置组。 */
async function claimedGroupIds(signal: AbortSignal): Promise<Set<string>> {
  try {
    const manifest = await fetchManifest({ signal });
    const out = new Set<string>();
    for (const p of manifest?.providers ?? []) {
      for (const id of p.configGroups ?? []) out.add(id);
    }
    return out;
  } catch {
    return new Set<string>();
  }
}

export async function mountConfig(ctx: FeatureContext, opts: { embedded?: boolean } = {}): Promise<void> {
  const { ui, root } = ctx;
  const intro = pageIntro(ui, S.pageTitle);

  const sheet = ui.sheet({
    title: S.sheetTitle,
    en: 'core',
    desc: S.sheetDesc,
  });
  sheet.body.appendChild(ui.placeholder(S.loading));
  if (!opts.embedded) root.appendChild(intro);
  root.appendChild(sheet.el);

  const claimed = await claimedGroupIds(ctx.signal);
  if (ctx.signal.aborted) return;

  const view = createConfigView({
    ui,
    lifecycle: ctx.lifecycle,
    signal: ctx.signal,
    filter: (group) => !claimed.has(group.id),
    emptyText: S.allClaimed,
  });
  sheet.body.replaceChildren(view.el);
  await view.load();
}

export const configFeature: FrameworkFeature = {
  route: 'config',
  label: S.navLabel,
  navMode: 'hidden',
  needsAny: ['config'],
  mount: mountConfig,
};
