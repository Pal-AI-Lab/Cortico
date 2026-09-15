import { pageIntro } from '../../ui/page.ts';
import { mountAppearance } from '../appearance/index.ts';
import { mountConfig } from '../config/index.ts';
import type { FeatureContext, FrameworkFeature } from '../feature.ts';
import { mountStorage } from '../storage/index.ts';
import { mountGeneral } from './general.ts';
import { S } from './strings.ts';

interface SettingSection {
  id: string;
  label: string;
  description: string;
  need?: string;
  mount(ctx: FeatureContext): void | Promise<void>;
}

const SECTIONS: readonly SettingSection[] = [
  {
    id: 'general',
    label: S.general,
    description: S.generalDesc,
    mount: mountGeneral,
  },
  {
    id: 'appearance',
    label: S.appearance,
    description: S.appearanceDesc,
    mount: (ctx) => mountAppearance(ctx, { embedded: true }),
  },
  {
    id: 'runtime',
    label: S.runtime,
    description: S.runtimeDesc,
    need: 'config',
    mount: (ctx) => mountConfig(ctx, { embedded: true }),
  },
  {
    id: 'storage',
    label: S.storage,
    description: S.storageDesc,
    need: 'storage',
    mount: (ctx) => mountStorage(ctx, { embedded: true }),
  },
];

export function mountSettings(ctx: FeatureContext): void {
  const { ui } = ctx;
  const intro = pageIntro(ui, S.pageTitle);
  const layout = ui.h('div', 'settings-layout');
  const index = ui.h('nav', 'settings-index');
  index.setAttribute('aria-label', S.sectionsAria);
  index.setAttribute('role', 'tablist');
  const content = ui.h('div', 'settings-content');
  const visible = SECTIONS.filter((section) => !section.need || ctx.capabilities[section.need] === true);
  const mounted: Array<{ button: HTMLButtonElement; section: HTMLElement }> = [];

  const select = (id: string): void => {
    for (const item of mounted) {
      const active = item.section.id === `settings-${id}`;
      item.section.classList.toggle('active', active);
      item.button.classList.toggle('active', active);
      item.button.setAttribute('aria-selected', String(active));
    }
  };

  for (const spec of visible) {
    const section = ui.h('section', 'settings-section');
    section.id = `settings-${spec.id}`;
    const heading = ui.h('div', 'settings-section-head');
    heading.append(ui.h('h2', null, spec.label), ui.h('p', null, spec.description));
    const body = ui.h('div', 'settings-section-body');
    section.append(heading, body);
    content.appendChild(section);

    const jump = ui.h('button', 'settings-jump', spec.label);
    jump.type = 'button';
    jump.setAttribute('role', 'tab');
    jump.setAttribute('aria-controls', section.id);
    jump.addEventListener('click', () => select(spec.id), { signal: ctx.signal });
    index.appendChild(jump);
    mounted.push({ button: jump, section });

    const child = { ...ctx, root: body };
    void Promise.resolve(spec.mount(child)).catch(ctx.onError);
  }

  layout.append(index, content);
  ctx.root.append(intro, layout);
  if (visible[0]) select(visible[0].id);
}

export const settingsFeature: FrameworkFeature = {
  route: 'settings',
  label: S.navLabel,
  icon: 'settings',
  navGroup: S.navGroup,
  mount: mountSettings,
};
