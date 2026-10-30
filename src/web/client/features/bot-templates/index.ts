/** 「Bot 模板」：扩展市场里 Bot 模板这一类，布局与 World、供应商的市场相同。 */
import { mountExtensionContent } from '../extensions/index.ts';
import { S } from '../extensions/strings.ts';
import { pageIntro } from '../../ui/page.ts';
import type { FrameworkFeature } from '../feature.ts';

export const botsFeature: FrameworkFeature = {
  route: 'bots',
  label: S.botNavLabel,
  icon: 'bot',
  navGroup: S.navGroup,
  needsAny: ['extensions'],
  mount(ctx) {
    const market = ctx.ui.h('div', 'bot-market');
    ctx.root.append(pageIntro(ctx.ui, S.botNavLabel, S.botPageNote), market);
    mountExtensionContent({ ...ctx, root: market }, 'bot');
  },
};
