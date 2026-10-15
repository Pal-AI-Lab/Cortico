/** 独立页面只收到一份受主题词表约束的颜色快照。 */

import { describe, expect, it } from 'vitest';

const HANDOFF = '../../src/web/client/theme/handoff.ts';
const REGISTRY = '../../src/web/client/theme/registry.ts';

type Any = any;

const handoff = (await import(HANDOFF)) as Any;
const registry = (await import(REGISTRY)) as Any;

function fakeDocument(appearance: string | null, values: Record<string, string>): Any {
  const documentElement = {
    getAttribute(name: string): string | null {
      return name === 'data-color-mode' ? appearance : null;
    },
  };
  return {
    documentElement,
    defaultView: {
      getComputedStyle(root: unknown) {
        expect(root).toBe(documentElement);
        return {
          getPropertyValue(name: string): string {
            return values[name] ?? '';
          },
        };
      },
    },
  };
}

function decodePayload(href: string): Any {
  const fragment = href.slice(href.indexOf('#') + 1);
  const encoded = new URLSearchParams(fragment).get(handoff.THEME_HANDOFF_FRAGMENT_KEY);
  if (!encoded) throw new Error('链接没有主题快照');
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
}

describe('独立页面主题交接', () => {
  it('普通链接逐字保持原样，不读取页面主题', () => {
    const doc = {
      get documentElement(): never {
        throw new Error('普通链接不应读取主题');
      },
    };
    const href = '/editor?room=7#section';
    expect(handoff.resolveWebUiLinkHref(doc, { label: '打开', href })).toBe(href);
  });

  it('已有 fragment 的主题链接保持其既有页面协议', () => {
    const doc = {
      get documentElement(): never {
        throw new Error('已有 fragment 时不应读取主题');
      },
    };
    const href = '/editor?room=7#section';
    expect(handoff.resolveWebUiLinkHref(doc, { label: '打开', href, inheritTheme: true })).toBe(href);
  });

  it('深色自定义主题保留原 query，并编码为 URL-safe 的完整词表快照', () => {
    const values: Record<string, string> = {};
    for (const [index, token] of registry.THEME_TOKENS.entries()) {
      values[`--${token.key}`] = index === 0 ? '  #A1B2C3  ' : '#123456';
    }
    const href = 'http://127.0.0.1:9000/editor?room=7&mode=custom';
    const out = handoff.resolveWebUiLinkHref(
      fakeDocument('dark', values),
      { label: '打开', href, inheritTheme: true },
    );

    expect(out.slice(0, out.indexOf('#'))).toBe(href);
    const encoded = new URLSearchParams(out.split('#')[1]).get(handoff.THEME_HANDOFF_FRAGMENT_KEY);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(decodePayload(out)).toEqual({
      v: 1,
      appearance: 'dark',
      palette: Object.fromEntries(registry.THEME_TOKENS.map((token: Any, index: number) => [
        token.key,
        index === 0 ? '#a1b2c3' : '#123456',
      ])),
    });
  });

  it('缺色、CSS 函数和野键不会进入快照；未解析的明暗模式不交接', () => {
    const values = {
      '--paper': 'rgb(1, 2, 3)',
      '--sheet': '#12345g',
      '--accent': '#ABCDEF',
      '--rogue': '#010101',
    };
    const link = { label: '打开', href: '/editor?keep=1', inheritTheme: true };
    const out = handoff.resolveWebUiLinkHref(fakeDocument('light', values), link);

    expect(decodePayload(out)).toEqual({
      v: 1,
      appearance: 'light',
      palette: { accent: '#abcdef' },
    });
    expect(out).not.toContain('rgb');
    expect(out).not.toContain('rogue');
    expect(handoff.resolveWebUiLinkHref(fakeDocument('system', values), link)).toBe(link.href);
  });
});

/** 独立页面与 WebUI 需使用相同的主题 fragment 常量。 */
describe('收方与发方用同一个 fragment 键', () => {
  it('B 站 Overlay 编辑器读的键 = handoff 写的键', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(
      new URL('../../src/worlds/bilibili/overlay/web/editor.js', import.meta.url),
      'utf8',
    );
    expect(source).toContain(`const THEME_FRAGMENT_KEY = '${handoff.THEME_HANDOFF_FRAGMENT_KEY}';`);
  });
});
