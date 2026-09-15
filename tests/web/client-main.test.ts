/**
 * @vitest-environment jsdom
 * main.ts 的两处壳逻辑:面板 memo 的读写优先级,以及 boot 在能力清单到达前被 dispose。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const MAIN = '../../src/web/client/main.ts';

type Any = any;

const flush = async (n = 30): Promise<void> => { for (let i = 0; i < n; i++) await Promise.resolve(); };

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  localStorage.clear();
  window.location.hash = '';
});

describe('createMemo', () => {
  it('localStorage 写不进去时读回本会话写的值,不是落盘的旧值', async () => {
    const { createMemo } = (await import(MAIN)) as Any;
    localStorage.setItem('cortico.test.k', JSON.stringify('old'));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    const memo = createMemo('cortico.test.');
    memo.set('k', 'new');
    expect(memo.get('k', 'dflt')).toBe('new');
  });

  it('没写过就读 localStorage;没有记录或记录坏了都退回缺省', async () => {
    const { createMemo } = (await import(MAIN)) as Any;
    localStorage.setItem('cortico.test.k', JSON.stringify({ n: 1 }));
    localStorage.setItem('cortico.test.bad', '{not json');
    const memo = createMemo('cortico.test.');
    expect(memo.get('k', null)).toEqual({ n: 1 });
    expect(memo.get('bad', 'dflt')).toBe('dflt');
    expect(memo.get('missing', 'dflt')).toBe('dflt');
  });
});

describe('boot', () => {
  it('能力清单到达前 dispose:到达后不再导航,不再渲染', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal('fetch', (url: unknown) => {
      const u = String(url);
      if (u.includes('/api/capabilities')) {
        return gate.then(() => json({ capabilities: { debug: true, sessions: true } }));
      }
      if (u.includes('/api/console/manifest')) {
        return gate.then(() => json({ protocolVersion: 1, providers: [], framework: { capabilities: {} } }));
      }
      return Promise.resolve(json({}));
    });
    const { boot } = (await import(MAIN)) as Any;
    const app = boot(document);
    await flush();
    app.dispose();
    release();
    await flush();
    // 没 dispose 的话空路由会被换成终端页,hash 变成 #/live,并在已清空的根里挂页。
    expect(window.location.hash).toBe('');
    expect(document.getElementById('kernel-root')!.textContent).toBe('');
  });
});
