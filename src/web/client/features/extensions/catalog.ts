/**
 * World catalog categories. Each groups the market index's function tags it names; a package
 * belongs to every category one of its tags falls in, and to `other` when it has none of them.
 */
export const CATALOG_CATEGORIES = {
  chat: ['im', 'qq'], // arch-allow: 市场索引的功能标签名
  game: ['game'],
  streaming: ['streaming'],
  companion: ['companion', 'memory'],
  media: ['voice', 'video'],
  creative: ['creative'],
  web: ['internet', 'browser'],
  computer: ['computer-use', 'apps', 'real-world'],
  diagnostics: ['diagnostics'],
} as const satisfies Record<string, readonly string[]>;

export type CatalogCategory = 'all' | keyof typeof CATALOG_CATEGORIES | 'other';
export const CATALOG_CATEGORY_IDS: readonly CatalogCategory[] = ['all', ...Object.keys(CATALOG_CATEGORIES) as (keyof typeof CATALOG_CATEGORIES)[], 'other'];

const FUNCTION_TAGS: ReadonlySet<string> = new Set(Object.values(CATALOG_CATEGORIES).flat());

/** Function tags pick the category, so the tag filters beneath it leave them out. */
export const isFunctionTag = (id: string): boolean => FUNCTION_TAGS.has(id);

export function inCatalogCategory(tags: readonly string[] | undefined, category: CatalogCategory): boolean {
  if (category === 'all') return true;
  if (category === 'other') return !(tags ?? []).some(isFunctionTag);
  const members: readonly string[] = CATALOG_CATEGORIES[category];
  return (tags ?? []).some(id => members.includes(id));
}
