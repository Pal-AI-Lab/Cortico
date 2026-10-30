/**
 * 扩展页用的 Markdown 子集(简介、评论、更新说明):段落、标题、无序 / 有序列表、代码块、行内粗体 / 斜体 / 代码、链接。
 * 只生成文本节点与固定几种元素,不解析 HTML;链接只认 http(s),在新窗口打开。
 */

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\((https?:\/\/[^)\s]+)\)|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;

function inline(doc: Document, text: string, into: Node): void {
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) into.appendChild(doc.createTextNode(text.slice(last, match.index)));
    const token = match[0];
    let el: HTMLElement;
    if (token.startsWith('**')) { el = doc.createElement('strong'); el.textContent = token.slice(2, -2); }
    else if (token.startsWith('`')) { el = doc.createElement('code'); el.textContent = token.slice(1, -1); }
    else if (token.startsWith('[')) {
      const a = doc.createElement('a'); a.textContent = token.slice(1, token.indexOf('](')); a.href = match[2];
      a.target = '_blank'; a.rel = 'noopener noreferrer'; el = a;
    } else { el = doc.createElement('em'); el.textContent = token.slice(1, -1); }
    into.appendChild(el);
    last = match.index + token.length;
  }
  if (last < text.length) into.appendChild(doc.createTextNode(text.slice(last)));
}

export function renderMarkdown(doc: Document, source: string): DocumentFragment {
  const out = doc.createDocumentFragment();
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let paragraph: string[] = [];
  let list: HTMLElement | null = null;
  const flush = () => {
    if (paragraph.length) {
      const p = doc.createElement('p');
      paragraph.forEach((line, i) => { if (i) p.appendChild(doc.createElement('br')); inline(doc, line, p); });
      out.appendChild(p); paragraph = [];
    }
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flush();
      const code: string[] = [];
      // Only a line of the fence alone closes the block, as on GitHub: text right after a fence stays in it.
      while (++i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i]);
      const pre = doc.createElement('pre'); const el = doc.createElement('code'); el.textContent = code.join('\n'); pre.appendChild(el); out.appendChild(pre);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (!line.trim()) { flush(); continue; }
    if (heading) {
      flush();
      const h = doc.createElement(heading[1].length <= 2 ? 'h5' : 'h6'); inline(doc, heading[2], h); out.appendChild(h);
    } else if (item) {
      if (paragraph.length) flush();
      const ordered = !!item[2];
      if (!list || (list.tagName === 'OL') !== ordered) { list = doc.createElement(ordered ? 'ol' : 'ul'); out.appendChild(list); }
      const li = doc.createElement('li'); inline(doc, item[3], li); list.appendChild(li);
    } else {
      if (list) list = null;
      paragraph.push(line);
    }
  }
  flush();
  return out;
}
