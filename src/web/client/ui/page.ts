import type { WebUi } from '../../shared/client-panel.ts';

export function pageIntro(ui: Pick<WebUi, 'h'>, title: string, description?: string): HTMLElement {
  const intro = ui.h('header', 'featureintro');
  intro.appendChild(ui.h('h1', 'pagetitle', title));
  if (description) intro.appendChild(ui.h('p', 'pagedesc', description));
  return intro;
}
