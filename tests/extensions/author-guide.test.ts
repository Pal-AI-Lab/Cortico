/** check:extension 末尾的标签核对与发布前清单:词表从注入的 fetch 来,不联网。 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorGuide, changelogHasVersion, checkTags, fetchTagIndex, type TagIndex } from '../../src/extensions/author-guide.ts';
import type { ExtensionPackageJson } from '../../src/extensions/manifest.ts';

const INDEX: TagIndex = {
  tags: {
    'example-product': { style: 'official', label: { en: 'Example Product' }, when: 'Maintainers only.' },
    im: { label: { zh: '即时通讯', en: 'Messaging' }, when: 'Connects to an instant-messaging platform.' },
    streaming: { label: { en: 'Streaming' }, when: 'Built for live streaming.' },
    game: { label: { en: 'Game' }, when: 'Plays or hosts a game.' },
    experimental: { style: 'notice', label: { en: 'Experimental' }, when: 'The author marks it as still in testing.' },
    unsafe: { style: 'warning', label: { en: 'Unsafe' }, when: 'Runs arbitrary code.' },
  },
};

const served = (body: unknown): typeof fetch => async () => new Response(JSON.stringify(body));
const pkgWith = (tags: unknown): ExtensionPackageJson => ({ name: 'cortico-world-sample', version: '0.2.0', cortico: { kind: 'world', api: 6, tags } });

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'author-guide-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('标签核对', () => {
  it('不认识的标签给出名字接近的作者标签,按 id 与中英 label 比', () => {
    const check = checkTags('cortico-world-sample', ['streming', 'Messaging', '即时通讯', 'zzzzzzzz'], INDEX);
    expect(check.unknown.find((u) => u.tag === 'streming')?.near).toContain('streaming');
    expect(check.unknown.find((u) => u.tag === 'Messaging')?.near).toContain('im');
    expect(check.unknown.find((u) => u.tag === '即时通讯')?.near).toContain('im');
    expect(check.unknown.find((u) => u.tag === 'zzzzzzzz')?.near).toEqual([]);
  });

  it('官方标注不作为接近的标签给出,作者声明了单列', () => {
    const check = checkTags('cortico-world-sample', ['example-produc', 'example-product'], INDEX);
    expect(check.unknown[0].near).not.toContain('example-product');
    expect(check.official).toEqual(['example-product']);
  });

  it('cortico.tags 为空时列出整张词表与每个标签的 when', async () => {
    const out = (await authorGuide(dir, pkgWith([]), served({ schema: 1, ...INDEX }))).join('\n');
    for (const [id, tag] of Object.entries(INDEX.tags)) {
      expect(out).toMatch(new RegExp(`${id}\\b.*${tag.when!.replace(/\./g, '\\.')}`));
    }
  });

  it.each([
    ['连不上', (async () => { throw new Error('getaddrinfo ENOTFOUND'); }) as typeof fetch],
    ['HTTP 错误', (async () => new Response('', { status: 404 })) as typeof fetch],
    ['schema 不认识', served({ schema: 2, ...INDEX })],
  ])('读不到索引(%s)时跳过标签核对,发布前清单照出', async (_case, fetchImpl) => {
    expect((await fetchTagIndex(fetchImpl)).ok).toBe(false);
    const out = await authorGuide(dir, pkgWith(['nonexistent-tag']), fetchImpl);
    expect(out.some((l) => l.includes('Tag check skipped'))).toBe(true);
    expect(out.some((l) => l.includes('nonexistent-tag') && l.includes('not in the vocabulary'))).toBe(false);
    expect(out).toContain('Before publishing:');
  });
});

describe('CHANGELOG.md 的版本标题', () => {
  it('二级标题里第一个版本号等于当前版本才算有', () => {
    expect(changelogHasVersion('# Changelog\n\n## 0.2.0\n\n- x\n', '0.2.0')).toBe(true);
    expect(changelogHasVersion('## [0.2.0] - 2026-10-15\r\n- x\r\n', '0.2.0')).toBe(true);
    expect(changelogHasVersion('## 0.2.0-beta.1\n', '0.2.0-beta.1')).toBe(true);
    expect(changelogHasVersion('## 0.2.0-beta.1\n', '0.2.0')).toBe(false);
    expect(changelogHasVersion('## 10.2.0\n', '0.2.0')).toBe(false);
    expect(changelogHasVersion('### 0.2.0\n# 0.2.0\n', '0.2.0')).toBe(false);
    expect(changelogHasVersion('## 0.1.0 (after 0.2.0)\n', '0.2.0')).toBe(false);
  });

  it('发布前清单按包目录里的 CHANGELOG.md 提示,缺这一版的标题时写出版本号', async () => {
    const offline = (async () => { throw new Error('offline'); }) as typeof fetch;
    const missing = await authorGuide(dir, pkgWith([]), offline);
    expect(missing.some((l) => l.includes('No CHANGELOG.md'))).toBe(true);

    writeFileSync(join(dir, 'CHANGELOG.md'), '## 0.1.0\n');
    const stale = await authorGuide(dir, pkgWith([]), offline);
    expect(stale.some((l) => l.includes('no "## 0.2.0" heading'))).toBe(true);

    writeFileSync(join(dir, 'CHANGELOG.md'), '## 0.2.0\n\n## 0.1.0\n');
    const current = await authorGuide(dir, pkgWith([]), offline);
    expect(current.some((l) => l.includes('## 0.2.0') && l.includes('✓'))).toBe(true);
  });
});
