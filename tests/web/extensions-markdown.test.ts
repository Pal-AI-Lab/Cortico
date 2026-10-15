/**
 * @vitest-environment jsdom
 * 扩展页的 Markdown(简介、评论、更新说明)来自第三方:原始 HTML 只能当文字,链接只认 http(s)。
 */
import { describe, expect, it } from 'vitest';

const MARKDOWN = '../../src/web/client/features/extensions/markdown.ts';
const { renderMarkdown } = (await import(MARKDOWN)) as { renderMarkdown(doc: Document, source: string): DocumentFragment };

const render = (source: string) => { const box = document.createElement('div'); box.append(renderMarkdown(document, source)); return box; };

describe('renderMarkdown', () => {
  it('keeps raw HTML in the package description as text', () => {
    const box = render('<img src=x onerror="alert(1)"> **粗体**');
    expect(box.querySelector('img')).toBeNull();
    expect(box.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(box.querySelector('strong')?.textContent).toBe('粗体');
  });

  it('links only http(s) and opens them in a new window', () => {
    const box = render('[好](https://example.com) [坏](javascript:alert(1))');
    const links = [...box.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.com']);
    expect(links[0].target).toBe('_blank');
    expect(box.textContent).toContain('[坏](javascript:alert(1))');
  });
});
