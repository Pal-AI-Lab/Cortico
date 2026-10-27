// Reuse Cortico artwork through the shared icon library.
import { icon as originalIcon, wordmark as originalWordmark, brandMark as originalBrandMark, type WebUiIconName } from '../ui/icons.ts';
const aliases: Record<string, WebUiIconName> = { chat: 'message', book: 'folder-open', triangle: 'play', arrow: 'play', plus: 'bot', check: 'shield-check' };
export function icon(name: string): string { return originalIcon(document, aliases[name] || name as WebUiIconName).outerHTML; }
export function wordmark(): string { return originalWordmark(document).outerHTML; }

export function managementMark(): string { return originalBrandMark(document).outerHTML; }
