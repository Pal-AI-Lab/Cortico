/** 验证状态灯的颜色、标签与共享轮询：多个订阅者共用定时器，请求不重叠，最后退订后停止。DOM 与动态 import 方式见 client-ui.test.ts。 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const LAMP_ENTRY = '../../src/web/client/ui/lamp.ts';

type Any = any;

class FakeEl {
  className = '';
  title = '';
  hidden = false;
  children: FakeEl[] = [];
  attrs = new Map<string, string>();
  ownerDocument: Any;
  constructor(doc: Any) { this.ownerDocument = doc; }
  setAttribute(k: string, v: string): void { this.attrs.set(k, v); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  replaceChildren(...nodes: FakeEl[]): void { this.children = nodes; }
}

const fakeDoc = (hidden = false): Any => {
  const doc: Any = { hidden };
  doc.createElement = (): FakeEl => new FakeEl(doc);
  return doc;
};

/** 每个用例一份新模块:轮询状态是模块级的(一个 WebUI 只该有一个节拍)。 */
async function loadLamp(): Promise<Any> {
  vi.resetModules();
  return import(LAMP_ENTRY);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** 依次答同一份灯；记下被问了几次。 */
function stubLamps(lamps: Record<string, unknown>): { calls: () => number } {
  let calls = 0;
  vi.stubGlobal('fetch', () => {
    calls++;
    return Promise.resolve({
      ok: true, status: 200,
      text: () => Promise.resolve(JSON.stringify({ lamps })),
    });
  });
  return { calls: (): number => calls };
}

describe('灯的画法', () => {
  it.each([
    ['online', 'navdot on', '正常'],
    ['loading', 'navdot warn', '启动中'],
    ['error', 'navdot bad', '故障'],
    ['offline', 'navdot', '未启用'],
  ])('%s → class %s，措辞「%s」', async (state, cls, word) => {
    const { lampRow } = await loadLamp();
    const row = lampRow(fakeDoc(), [{ label: '甲链路', state }]);
    expect(row.children).toHaveLength(1);
    expect(row.children[0].className).toBe(cls);
    expect(row.children[0].title).toBe(`甲链路 ${word}`);
  });

  it('一条链路一颗，顺序照 World 给的来', async () => {
    const { lampRow } = await loadLamp();
    const row = lampRow(fakeDoc(), [
      { label: '甲', state: 'online' },
      { label: '乙', state: 'error', hint: '连不上' },
      { label: '丙', state: 'offline' },
    ]);
    expect(row.children.map((d: FakeEl) => d.className))
      .toEqual(['navdot on', 'navdot bad', 'navdot']);
    expect(row.children[1].title).toBe('乙 故障 · 连不上');
    expect(row.children[1].getAttribute('aria-label')).toBe('乙 故障 · 连不上');
  });

  it('没报灯 → 空容器藏起来，不画占位灰点（灰是"关着"，不是"没报"）', async () => {
    const { lampRow, paintLamps } = await loadLamp();
    const row = lampRow(fakeDoc(), []);
    expect(row.hidden).toBe(true);
    expect(row.children).toEqual([]);
    // 之后报上来就点亮同一个容器
    paintLamps(row, [{ label: '甲', state: 'online' }]);
    expect(row.hidden).toBe(false);
    expect(row.children).toHaveLength(1);
  });

  it('数目没变就地改色（每半秒重建一次 DOM 是没必要的抖动）', async () => {
    const { lampRow, paintLamps } = await loadLamp();
    const row = lampRow(fakeDoc(), [
      { label: '甲', state: 'online' },
      { label: '乙', state: 'online' },
    ]);
    const before = [...row.children];
    paintLamps(row, [
      { label: '甲', state: 'error', hint: '断了' },
      { label: '乙', state: 'online' },
    ]);
    expect(row.children).toEqual(before); // 同一批节点
    expect(row.children[0].className).toBe('navdot bad');
    expect(row.children[0].title).toBe('甲 故障 · 断了');
  });

  it('数目变了就重排（World 多接了一条链路）', async () => {
    const { lampRow, paintLamps } = await loadLamp();
    const row = lampRow(fakeDoc(), [{ label: '甲', state: 'online' }]);
    paintLamps(row, [
      { label: '甲', state: 'online' },
      { label: '乙', state: 'loading' },
    ]);
    expect(row.children).toHaveLength(2);
    expect(row.children[1].title).toBe('乙 启动中');
  });
});

describe('灯的取数', () => {
  it('多个订阅者共用一个定时器与一次请求：一拍只问一次，两边都收到', async () => {
    vi.useFakeTimers();
    const { subscribeLamps } = await loadLamp();
    const payload = { 'world:a': [{ label: '甲', state: 'online' }] };
    const seen = stubLamps(payload);
    const a: unknown[] = [];
    const b: unknown[] = [];
    subscribeLamps(fakeDoc(), (l: unknown) => a.push(l));
    subscribeLamps(fakeDoc(), (l: unknown) => b.push(l));

    await vi.advanceTimersByTimeAsync(500);
    expect(seen.calls()).toBe(1);
    expect(a).toEqual([payload]);
    expect(b).toEqual(a);
  });

  it('最后一个订阅者走掉就停：没人看的时候不该还有定时器在敲后端', async () => {
    vi.useFakeTimers();
    const { subscribeLamps } = await loadLamp();
    const seen = stubLamps({});
    const one = subscribeLamps(fakeDoc(), () => {});
    const two = subscribeLamps(fakeDoc(), () => {});

    await vi.advanceTimersByTimeAsync(500);
    expect(seen.calls()).toBe(1);
    one.dispose();
    await vi.advanceTimersByTimeAsync(500);
    expect(seen.calls()).toBe(2); // 还有人看着，照问
    two.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(seen.calls()).toBe(2); // 没人看了，一拍都不问
  });

  it('上一拍没回来就跳过这一拍（后端一慢会攒出一串在途请求）', async () => {
    vi.useFakeTimers();
    const { subscribeLamps } = await loadLamp();
    let calls = 0;
    let release: (() => void) | null = null;
    vi.stubGlobal('fetch', () => {
      calls++;
      return new Promise((resolve) => {
        release = (): void => resolve({
          ok: true, status: 200, text: () => Promise.resolve('{"lamps":{}}'),
        } as never);
      });
    });
    subscribeLamps(fakeDoc(), () => {});

    await vi.advanceTimersByTimeAsync(2500); // 五拍
    expect(calls).toBe(1);
    release!();
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toBe(2);
  });

  it('页面不可见时一拍都不发', async () => {
    vi.useFakeTimers();
    const { subscribeLamps } = await loadLamp();
    const seen = stubLamps({});
    subscribeLamps(fakeDoc(true), () => {});
    await vi.advanceTimersByTimeAsync(5000);
    expect(seen.calls()).toBe(0);
  });

  it('取灯失败不通知订阅者：留上一拍的读数，而不是把整排灯清空', async () => {
    vi.useFakeTimers();
    const { subscribeLamps } = await loadLamp();
    let fail = false;
    vi.stubGlobal('fetch', () => (fail
      ? Promise.reject(new Error('断了'))
      : Promise.resolve({
        ok: true, status: 200,
        text: () => Promise.resolve('{"lamps":{"world:a":[{"label":"甲","state":"online"}]}}'),
      })));
    const got: unknown[] = [];
    subscribeLamps(fakeDoc(), (l: unknown) => got.push(l));

    await vi.advanceTimersByTimeAsync(500);
    expect(got).toHaveLength(1);
    fail = true;
    await vi.advanceTimersByTimeAsync(1500);
    expect(got).toHaveLength(1); // 失败的那几拍一次都没回调
  });
});
