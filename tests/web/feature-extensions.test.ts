// @vitest-environment jsdom
/** 扩展市场的纯函数：安装输入、os 字段、命中排序与重启判定。页面行为在 feature-world-library.test.ts。 */
import { describe, expect, it } from 'vitest';

const EXTENSIONS = '../../src/web/client/features/extensions/index.ts';

type Any = any;

const { parseInstallInput, arrangeHits, restartOutcome, osAllowed } = (await import(EXTENSIONS)) as Any;

describe('npm input', () => {
  it('accepts names, scoped names and exact versions or tags only', () => {
    expect(parseInstallInput('@scope/example@1.2.3')).toEqual({ name: '@scope/example', version: '1.2.3' });
    expect(parseInstallInput('@scope/example@next')).toEqual({ name: '@scope/example', version: 'next' });
    for (const value of ['', './path', 'C:\\path', 'https://example.com', 'name; cmd', 'name@^1.0']) expect(parseInstallInput(value)).toBeNull();
  });
});

describe('npm os field', () => {
  it('follows npm: a negation excludes, a positive list restricts, nothing means everywhere', () => {
    expect(osAllowed(undefined, 'darwin')).toBe(true);
    expect(osAllowed(['win32'], 'win32')).toBe(true);
    expect(osAllowed(['win32'], 'darwin')).toBe(false);
    expect(osAllowed(['!win32'], 'linux')).toBe(true);
    expect(osAllowed(['!win32'], 'win32')).toBe(false);
    expect(osAllowed(['linux', '!linux'], 'linux')).toBe(false);
  });
});

describe('arrangeHits', () => {
  const hit = (over: Any): Any => ({ name: 'x', version: '1.0.0', description: '', downloads: { month: 0 }, dependents: 0, links: {}, installed: false, ...over });
  const opts = (over: Any): Any => ({ filter: '', hideInstalled: false, sort: 'downloads', page: 0, pageSize: 2, ...over });

  it('月下载量未知的排在 0 之后,设了最低下载量时不列出', () => {
    const hits = [
      hit({ name: 'a-unknown', downloads: {} }),
      hit({ name: 'z-zero', downloads: { month: 0 } }),
      hit({ name: 'b-unknown', downloads: {} }),
      hit({ name: 'positive', downloads: { month: 5 } }),
    ];
    expect(arrangeHits(hits, opts({ pageSize: 10 })).shown.map((h: Any) => h.name)).toEqual(['positive', 'z-zero', 'a-unknown', 'b-unknown']);
    expect(arrangeHits(hits, opts({ minDownloads: 1 })).shown.map((h: Any) => h.name)).toEqual(['positive']);
  });

  it('筛选看名字、描述与关键字;隐藏已安装是另一道', () => {
    const hits = [
      hit({ name: 'alpha', description: '甲' }),
      hit({ name: 'beta', description: '乙', keywords: ['chat'] }),
      hit({ name: 'gamma', description: '丙', installed: true }),
    ];
    expect(arrangeHits(hits, opts({ filter: 'chat' })).shown.map((h: Any) => h.name)).toEqual(['beta']);
    expect(arrangeHits(hits, opts({ filter: '丙' })).shown.map((h: Any) => h.name)).toEqual(['gamma']);
    expect(arrangeHits(hits, opts({ filter: 'ALPHA' })).shown.map((h: Any) => h.name)).toEqual(['alpha']);
    expect(arrangeHits(hits, opts({ hideInstalled: true })).matched).toBe(2);
  });

  it('三种排序各自的口径;并列时按名字', () => {
    const hits = [
      hit({ name: 'b', downloads: { month: 5 }, dependents: 1, date: '2026-01-01T00:00:00.000Z' }),
      hit({ name: 'a', downloads: { month: 5 }, dependents: 9, date: '2026-05-05T00:00:00.000Z' }),
      hit({ name: 'c', downloads: { month: 90 }, dependents: 0 }),
    ];
    const names = (sort: string): string[] => arrangeHits(hits, opts({ sort, pageSize: 10 })).shown.map((h: Any) => h.name);
    expect(names('downloads')).toEqual(['c', 'a', 'b']);
    expect(names('name')).toEqual(['a', 'b', 'c']);
    // 没有发布时间的排在最后
    expect(names('date')).toEqual(['a', 'b', 'c']);
  });

  it('页码超出范围收回最后一页;一条都没有时仍是一页', () => {
    const hits = [hit({ name: 'a' }), hit({ name: 'b' }), hit({ name: 'c' })];
    expect(arrangeHits(hits, opts({ page: 9 }))).toMatchObject({ page: 1, pages: 2 });
    expect(arrangeHits(hits, opts({ page: -3 })).page).toBe(0);
    expect(arrangeHits([], opts({}))).toMatchObject({ matched: 0, pages: 1, page: 0, shown: [] });
  });
});

describe('restart', () => {
  it('waits for a new ready process of the same deployment', () => {
    const before = { deployment: 'same', bootId: 'old', ready: true };
    expect(restartOutcome(before, before)).toBe('waiting');
    expect(restartOutcome(before, { ...before, bootId: 'new', ready: false })).toBe('waiting');
    expect(restartOutcome(before, { ...before, bootId: 'new' })).toBe('ready');
    expect(restartOutcome(before, { ...before, deployment: 'other', bootId: 'new' })).toBe('wrong-deployment');
  });
});

