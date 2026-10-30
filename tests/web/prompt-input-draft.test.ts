// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { promptInput } from '../../src/web/client/ui/prompt-input.tsx';

type Any = any;
/** 查询结果按 Any 用:测试里节点必在,缺了就让断言或调用直接失败。 */
const $ = (sel: string, from: ParentNode = document): Any => from.querySelector(sel);
const $$ = (sel: string, from: ParentNode = document): Any[] => [...from.querySelectorAll(sel)];

(globalThis as Any).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = 'test.draft';
const image = { name: 'a.png', mime: 'image/png', base64: 'iVBORw0KGgo=', bytes: 8, width: 1, height: 1 };
const pages: Any[] = [];

function open(sent: Any = []) {
  const page = new AbortController();
  pages.push(page);
  let input: Any;
  act(() => { input = promptInput(document, page.signal, { draftKey: KEY, images: { max: 8 }, onSubmit: (text: Any) => { sent.push(text); } }); });
  document.body.append(input.el);
  return { input, page, textarea: $('textarea', input.el) };
}

async function type(textarea: Any, text: Any) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

afterEach(() => {
  act(() => { for (const page of pages.splice(0)) page.abort(); });
  document.body.replaceChildren();
  localStorage.clear();
});

describe('composer draft', () => {
  it('outlives leaving the page and is gone once sent', async () => {
    const first = open();
    await type(first.textarea, 'half a sentence');
    await act(async () => first.input.restore('', [image]));
    act(() => first.page.abort());

    const sent: Any[] = [];
    const again = open(sent);
    expect(again.textarea.value).toBe('half a sentence');
    expect($$('img', again.input.el)).toHaveLength(1);

    await act(async () => $('form', again.input.el).requestSubmit());
    expect(sent).toEqual(['half a sentence']);
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(localStorage.getItem(`${KEY}.images`)).toBeNull();
  });
});
