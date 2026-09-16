import { LANGUAGE, saveLanguage, type Language } from '../../core/language.ts';
import type { FeatureContext } from '../feature.ts';
import { S } from './strings.ts';

export function mountGeneral(ctx: FeatureContext): void {
  const { ui, root, signal } = ctx;
  const win = root.ownerDocument.defaultView!;
  // 同页别处都是档案卡:标题与说明的字体从卡片来,这里自己写 h3/p 会与它们对不齐。
  const sheet = ui.sheet({ title: S.language, en: 'language', desc: S.languageDesc });
  const group = ui.h('div', 'rowbar');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', S.language);
  sheet.body.appendChild(group);
  root.append(sheet.el);
  for (const [language, label] of [['zh', '简体中文'], ['en', 'English']] as const) {
    const button = ui.h('button', 'btn', label);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(language === LANGUAGE));
    button.disabled = language === LANGUAGE;
    button.addEventListener('click', () => { void changeLanguage(language).catch(ctx.onError); }, { signal });
    group.append(button);
  }

  async function changeLanguage(language: Language): Promise<void> {
    if (!await ui.confirm({ title: S.reloadTitle, body: S.reloadBody }) || signal.aborted) return;
    saveLanguage(language, win.localStorage);
    win.location.reload();
  }
}
