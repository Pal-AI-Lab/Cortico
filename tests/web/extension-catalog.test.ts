/** The World catalog's categories, grouped from the market index's function tags (`console/advanced/features/extensions/catalog.ts`). */
import { describe, expect, it } from 'vitest';
import { CATALOG_CATEGORIES, inCatalogCategory, isFunctionTag } from '../../src/web/client/features/extensions/catalog.ts';

describe('World catalog categories', () => {
  it('puts a package in every category one of its tags names', () => {
    expect(inCatalogCategory(['qq', 'voice'], 'chat')).toBe(true);
    expect(inCatalogCategory(['qq', 'voice'], 'media')).toBe(true);
    expect(inCatalogCategory(['qq', 'voice'], 'game')).toBe(false);
  });
  it('collects packages without a function tag under other', () => {
    expect(inCatalogCategory(['experimental', 'unsafe'], 'other')).toBe(true);
    expect(inCatalogCategory(undefined, 'other')).toBe(true);
    expect(inCatalogCategory(['game'], 'other')).toBe(false);
    expect(inCatalogCategory(undefined, 'all')).toBe(true);
  });
  it('treats exactly the grouped tags as function tags', () => {
    for (const ids of Object.values(CATALOG_CATEGORIES)) for (const id of ids) expect(isFunctionTag(id)).toBe(true);
    expect(isFunctionTag('requires-key')).toBe(false);
  });
});
