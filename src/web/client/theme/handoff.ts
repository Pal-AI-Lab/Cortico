/**
 * 独立页面主题交接。链接只携带点击瞬间的已解析颜色快照，接收方无需依赖 WebUI。
 */

import type { WebUiLink } from '../../shared/webui-protocol.ts';
import {
  isHexColor,
  THEME_TOKENS,
  type ThemeAppearance,
} from './registry.ts';

export const THEME_HANDOFF_FRAGMENT_KEY = 'cortico-theme';

export interface ThemeHandoffSnapshot {
  v: 1;
  appearance: ThemeAppearance;
  palette: Record<string, string>;
}

/** 无既有 fragment 的继承链接附加主题快照；其余链接逐字保持原值。 */
export function resolveWebUiLinkHref(doc: Document, link: WebUiLink): string {
  if (link.inheritTheme !== true) return link.href;
  if (link.href.includes('#')) return link.href;

  const appearance = doc.documentElement.getAttribute('data-color-mode');
  if (appearance !== 'light' && appearance !== 'dark') return link.href;
  const view = doc.defaultView;
  if (!view) return link.href;

  const computed = view.getComputedStyle(doc.documentElement);
  const palette: Record<string, string> = {};
  for (const token of THEME_TOKENS) {
    const value = computed.getPropertyValue(`--${token.key}`).trim();
    if (isHexColor(value)) palette[token.key] = value.toLowerCase();
  }

  const snapshot: ThemeHandoffSnapshot = { v: 1, appearance, palette };
  const payload = btoa(JSON.stringify(snapshot))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
  return `${link.href}#${THEME_HANDOFF_FRAGMENT_KEY}=${payload}`;
}
