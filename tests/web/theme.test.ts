/**
 * 变量形式的动态 import 避免根 tsconfig 纳入 DOM 代码；浏览器类型由 tsconfig.web.json 检查，行为测试使用迷你 DOM。
 * 主题记录归部署:验证首页注入的读取、本机旧记录的一次性迁移与回写失败的呈现。
 * 没有记录时使用部署默认方案且不广播；另验证调色板到 CSS 变量的映射以及 onChange 订阅和退订。
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

const REGISTRY = '../../src/web/client/theme/registry.ts';
const STORAGE = '../../src/web/client/theme/storage.ts';
const PALETTE = '../../src/web/client/theme/palette.ts';
const STUDIO = '../../src/web/client/theme/studio.ts';

type Any = any;

const registry = (await import(REGISTRY)) as Any;
const storageMod = (await import(STORAGE)) as Any;
const palette = (await import(PALETTE)) as Any;
const studioMod = (await import(STUDIO)) as Any;

const DEFAULT_ID: string = registry.DEFAULT_SCHEME_ID;
const SECOND: string = registry.BUILTIN_SCHEMES[1].id;
const THIRD: string = registry.BUILTIN_SCHEMES[2].id;

// ---------------------------------------------------------------------------
// 迷你 DOM 桩：只实现主题真正用到的那几样
// ---------------------------------------------------------------------------

class FakeStyle {
  readonly props = new Map<string, string>();
  colorScheme = '';
  setProperty(name: string, value: string): void {
    this.props.set(name, value);
  }
  getPropertyValue(name: string): string {
    return this.props.get(name) ?? '';
  }
}

class FakeEl {
  readonly tagName: string;
  textContent = '';
  readonly children: FakeEl[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style = new FakeStyle();
  /** `<meta>` 的两个属性，主题按 property 而不是 attribute 写它们 */
  name = '';
  content = '';
  constructor(tag: string) {
    this.tagName = tag;
  }
  appendChild(child: FakeEl): FakeEl {
    this.children.push(child);
    return child;
  }
}

class FakeDoc {
  readonly documentElement = new FakeEl('html');
  readonly head = new FakeEl('head');
  defaultView: Any;
  /** 服务端注入的那段 JSON；未设置 = 页面里没有这个节点。 */
  private injected: FakeEl | null = null;
  constructor(view?: Any) {
    this.defaultView = view;
  }
  setInjected(value: unknown): void {
    this.setInjectedRaw(JSON.stringify(value));
  }
  setInjectedRaw(raw: string): void {
    const el = new FakeEl('script');
    el.textContent = raw;
    this.injected = el;
  }
  getElementById(id: string): FakeEl | null {
    return id === THEME_SCRIPT_ID ? this.injected : null;
  }
  createElement(tag: string): FakeEl {
    return new FakeEl(tag);
  }
  /** 只认主题用的那一条选择器；别的一律 null。 */
  querySelector(selector: string): FakeEl | null {
    if (selector !== 'meta[name="theme-color"]') return null;
    return this.head.children.find((c) => c.tagName === 'meta' && c.name === 'theme-color') ?? null;
  }
}

/** Map 存储；fail 模拟读取和写入被拒绝。 */
class FakeStorage {
  readonly map = new Map<string, string>();
  fail = false;
  /** 仅写入失败，读取仍可用。 */
  failWrite = false;
  getItem(key: string): string | null {
    if (this.fail) throw new Error('无痕');
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.fail || this.failWrite) throw new Error('配额满');
    this.map.set(key, value);
  }
}

/** `matchMedia` 桩。`set()` 改偏好并派发一次 change。 */
class FakeMedia {
  matches: boolean;
  private readonly listeners = new Set<() => void>();
  constructor(matches = false) {
    this.matches = matches;
  }
  addEventListener(_type: string, fn: () => void): void {
    this.listeners.add(fn);
  }
  removeEventListener(_type: string, fn: () => void): void {
    this.listeners.delete(fn);
  }
  set(matches: boolean): void {
    this.matches = matches;
    for (const fn of [...this.listeners]) fn();
  }
  get count(): number {
    return this.listeners.size;
  }
}

const THEME_SCRIPT_ID: string = storageMod.THEME_SCRIPT_ID;

/** 一份带自定义方案的主题记录，旧 localStorage 记录与首页注入共用这个形状。 */
function legacyRecord(): string {
  return JSON.stringify({
    selectedId: 'custom-legacy',
    mode: 'dark',
    custom: [
      {
        id: 'custom-legacy',
        name: '我的旧配色',
        note: '本机自定义配色',
        palettes: {
          light: { ...registry.fallbackPalette('light'), paper: '#ABCDEF' },
          dark: { ...registry.fallbackPalette('dark'), paper: '#123456' },
        },
        custom: true,
      },
    ],
  });
}

afterEach(() => {
  studioMod.disposeThemeStudio();
});

// ---------------------------------------------------------------------------
// registry —— 纯数据与纯函数
// ---------------------------------------------------------------------------

describe('主题词表', () => {
  it('每个内置方案的两个变体都给齐了全部 token，且都是合法 #rrggbb', () => {
    for (const scheme of registry.BUILTIN_SCHEMES) {
      for (const appearance of ['light', 'dark']) {
        for (const token of registry.THEME_TOKENS) {
          const value = scheme.palettes[appearance][token.key];
          expect(registry.isHexColor(value), `${scheme.id}/${appearance}/${token.key}`).toBe(true);
        }
      }
    }
  });

  it('token key 不重复；默认方案在第一位', () => {
    const keys = registry.THEME_TOKENS.map((t: Any) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(registry.BUILTIN_SCHEMES[0].id).toBe(registry.DEFAULT_SCHEME_ID);
  });

  it('isHexColor：只认六位，三位简写与空值不算', () => {
    expect(registry.isHexColor('#a1b2c3')).toBe(true);
    expect(registry.isHexColor('#A1B2C3')).toBe(true);
    expect(registry.isHexColor('#abc')).toBe(false);
    expect(registry.isHexColor('abc123')).toBe(false);
    expect(registry.isHexColor(null)).toBe(false);
    expect(registry.isHexColor(undefined)).toBe(false);
    expect(registry.isHexColor('#a1b2c3 ')).toBe(false);
  });

  it('normalizeHex：去空白、补三位简写、统一小写；认不出给 null', () => {
    expect(registry.normalizeHex('  #A1B2C3 ')).toBe('#a1b2c3');
    expect(registry.normalizeHex('#ABC')).toBe('#aabbcc');
    expect(registry.normalizeHex('#abcd')).toBe(null);
    expect(registry.normalizeHex('')).toBe(null);
    expect(registry.normalizeHex('rgb(1,2,3)')).toBe(null);
    expect(registry.normalizeHex(null)).toBe(null);
  });

  it('normalizePalette：坏值回退、大小写归一、词表外的野键一律丢掉', () => {
    const fallback = registry.fallbackPalette('light');
    const out = registry.normalizePalette(
      { paper: '#AABBCC', ink: 'not-a-color', 'evil-key': '#000000' },
      fallback,
    );
    expect(out.paper).toBe('#aabbcc');
    expect(out.ink).toBe(fallback.ink);
    expect(out['evil-key']).toBeUndefined();
    expect(Object.keys(out).length).toBe(registry.THEME_TOKENS.length);
  });

  it('normalizePalette：给 null / 非对象也照样补出一份完整调色板', () => {
    const fallback = registry.fallbackPalette('dark');
    for (const bad of [null, undefined, 42, 'x']) {
      expect(registry.normalizePalette(bad, fallback)).toEqual(fallback);
    }
  });

  it('groupedThemeTokens：按 group 归并且保持词表出现顺序', () => {
    const groups = registry.groupedThemeTokens();
    expect(groups.map((g: Any) => g.group)).toEqual([
      '背景层级', '文字与边界', '交互与状态', '终端时间线', '图表系列',
    ]);
    expect(groups.reduce((n: number, g: Any) => n + g.tokens.length, 0)).toBe(registry.THEME_TOKENS.length);
    expect(groups[0].tokens[0].key).toBe('paper');
    // 同一个 group 分散出现时也只开一个桶
    const merged = registry.groupedThemeTokens([
      { group: 'a', key: 'k1', label: '' },
      { group: 'b', key: 'k2', label: '' },
      { group: 'a', key: 'k3', label: '' },
    ]);
    expect(merged.map((g: Any) => g.group)).toEqual(['a', 'b']);
    expect(merged[0].tokens.map((t: Any) => t.key)).toEqual(['k1', 'k3']);
  });

  it('schemeSwatches：底纸 / 主卡纸 / 主强调 / 一个系列色，按变体取', () => {
    const scheme = registry.BUILTIN_SCHEMES[0];
    const light = registry.schemeSwatches(scheme, 'light');
    expect(light).toEqual([
      scheme.palettes.light.paper,
      scheme.palettes.light.sheet,
      scheme.palettes.light.accent,
      scheme.palettes.light['chart-2'],
    ]);
    expect(registry.schemeSwatches(scheme, 'dark')[0]).toBe(scheme.palettes.dark.paper);
  });

  it('cloneScheme：两个变体都是深拷贝，改副本不动内置表', () => {
    const copy = registry.cloneScheme(registry.BUILTIN_SCHEMES[0]);
    copy.palettes.light.paper = '#000000';
    expect(registry.BUILTIN_SCHEMES[0].palettes.light.paper).not.toBe('#000000');
  });
});

// ---------------------------------------------------------------------------
// palette —— 调色板 → CSS 变量
// ---------------------------------------------------------------------------

describe('调色板落到 CSS 变量', () => {
  it('paletteVars：按词表顺序、名字带 `--`、词表外的键不出现', () => {
    const p = { ...registry.fallbackPalette('light'), 'evil-key': '#000000' };
    const vars = palette.paletteVars(p);
    expect(vars.length).toBe(registry.THEME_TOKENS.length);
    expect(vars[0]).toEqual(['--paper', p.paper]);
    expect(vars.map((v: Any) => v[0])).toEqual(registry.THEME_TOKENS.map((t: Any) => '--' + t.key));
    expect(vars.some((v: Any) => v[0] === '--evil-key')).toBe(false);
  });

  it('paletteVars：缺格与空串跳过，不写一条 `--x: ` 出去', () => {
    const vars = palette.paletteVars({ paper: '#ffffff', ink: '' });
    expect(vars).toEqual([['--paper', '#ffffff']]);
  });

  it('applyPalette：变量刷到 documentElement，并带上两个 data 标记与 color-scheme', () => {
    const doc = new FakeDoc();
    const p = registry.fallbackPalette('dark');
    palette.applyPalette(doc as Any, p, { appearance: 'dark', schemeId: SECOND });
    const root = doc.documentElement;
    expect(root.style.getPropertyValue('--paper')).toBe(p.paper);
    expect(root.style.getPropertyValue('--chart-8')).toBe(p['chart-8']);
    expect(root.style.props.size).toBe(registry.THEME_TOKENS.length);
    expect(root.dataset.colorMode).toBe('dark');
    expect(root.dataset.themeScheme).toBe(SECOND);
    expect(root.style.colorScheme).toBe('dark');
  });

  it('applyPalette：theme-color meta 建一次之后复用，不会每次换肤多一个', () => {
    const doc = new FakeDoc();
    palette.applyPalette(doc as Any, registry.fallbackPalette('light'), { appearance: 'light' });
    expect(doc.head.children.length).toBe(1);
    expect(doc.head.children[0].content).toBe(registry.fallbackPalette('light').paper);
    palette.applyPalette(doc as Any, registry.fallbackPalette('dark'), { appearance: 'dark' });
    expect(doc.head.children.length).toBe(1);
    expect(doc.head.children[0].content).toBe(registry.fallbackPalette('dark').paper);
  });

  it('applyPalette：不给 schemeId 就不动 data-theme-scheme（预览不该改方案标记）', () => {
    const doc = new FakeDoc();
    palette.applyPalette(doc as Any, registry.fallbackPalette('light'), { appearance: 'light', schemeId: THIRD });
    palette.applyPalette(doc as Any, registry.fallbackPalette('light'), { appearance: 'light' });
    expect(doc.documentElement.dataset.themeScheme).toBe(THIRD);
  });

  it('readThemeColor：读不出合法颜色时退回 --ink-dim', () => {
    const doc = new FakeDoc();
    doc.defaultView = {
      getComputedStyle: () => doc.documentElement.style,
    };
    doc.documentElement.style.setProperty('--accent', '#112233');
    doc.documentElement.style.setProperty('--ink-dim', '#888888');
    expect(palette.readThemeColor(doc as Any, 'accent')).toBe('#112233');
    expect(palette.readThemeColor(doc as Any, 'nope')).toBe('#888888');
    // 没有 defaultView（离屏文档）不该抛
    expect(palette.readThemeColor(new FakeDoc() as Any, 'accent')).toBe('');
  });
});

describe('颜色换算', () => {
  const round = (hsl: Any) => ({ h: Math.round(hsl.h), s: Math.round(hsl.s), l: Math.round(hsl.l) });

  it('hexToHsl：黑白灰无色相，三原色落在 0 / 120 / 240', () => {
    expect(round(palette.hexToHsl('#000000'))).toEqual({ h: 0, s: 0, l: 0 });
    expect(round(palette.hexToHsl('#ffffff'))).toEqual({ h: 0, s: 0, l: 100 });
    expect(round(palette.hexToHsl('#808080'))).toEqual({ h: 0, s: 0, l: 50 });
    expect(round(palette.hexToHsl('#ff0000'))).toEqual({ h: 0, s: 100, l: 50 });
    expect(round(palette.hexToHsl('#00ff00'))).toEqual({ h: 120, s: 100, l: 50 });
    expect(round(palette.hexToHsl('#0000ff'))).toEqual({ h: 240, s: 100, l: 50 });
  });

  it('hexToHsl：三位简写与不带 # 都收，结果与展开形一致', () => {
    expect(palette.hexToHsl('#abc')).toEqual(palette.hexToHsl('#aabbcc'));
    expect(palette.hexToHsl('aabbcc')).toEqual(palette.hexToHsl('#aabbcc'));
  });

  it('hslCss：三个分量都取整', () => {
    expect(palette.hslCss({ h: 210.4, s: 12.5, l: 39.6 })).toBe('hsl(210,13%,40%)');
    expect(palette.hslCss(palette.hexToHsl('#ff0000'))).toBe('hsl(0,100%,50%)');
  });

  it('clampNumber：两头都夹', () => {
    expect(palette.clampNumber(5, 10, 20)).toBe(10);
    expect(palette.clampNumber(25, 10, 20)).toBe(20);
    expect(palette.clampNumber(15, 10, 20)).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// storage —— 旧格式与旧键兼容
// ---------------------------------------------------------------------------

describe('注入与迁移', () => {
  it('首页注入的记录原样读回来（含自定义方案），十六进制统一小写', () => {
    const doc = new FakeDoc();
    doc.setInjected({ defaultScheme: THIRD, theme: JSON.parse(legacyRecord()) });
    const injected = storageMod.readInjectedTheme(doc as Any);
    expect(injected.defaultScheme).toBe(THIRD);
    expect(injected.theme.selectedId).toBe('custom-legacy');
    expect(injected.theme.mode).toBe('dark');
    expect(injected.theme.custom[0].name).toBe('我的旧配色');
    expect(injected.theme.custom[0].palettes.light.paper).toBe('#abcdef');
    expect(injected.theme.custom[0].custom).toBe(true);
  });

  it('部署还没有记录：theme 给 null,默认方案仍按注入的来', () => {
    const doc = new FakeDoc();
    doc.setInjected({ defaultScheme: SECOND, theme: null });
    expect(storageMod.readInjectedTheme(doc as Any)).toEqual({ defaultScheme: SECOND, theme: null });
  });

  it('没有那段 script / 坏 JSON / 形状不对 → 框架默认方案 + 没有记录，绝不抛', () => {
    const none: Any = { defaultScheme: DEFAULT_ID, theme: null };
    expect(storageMod.readInjectedTheme(new FakeDoc() as Any)).toEqual(none);
    for (const raw of ['', '   ', '{ 坏 JSON', 'null', '[1,2]', '{"defaultScheme":7}']) {
      const doc = new FakeDoc();
      doc.setInjectedRaw(raw);
      expect(storageMod.readInjectedTheme(doc as Any)).toEqual(none);
    }
  });

  it('注入的自定义方案：没 id 的丢掉，超长的名与说明截断，颜色缺格用内置补齐', () => {
    const doc = new FakeDoc();
    doc.setInjected({
      defaultScheme: DEFAULT_ID,
      theme: {
        selectedId: 'x',
        mode: 'light',
        custom: [
          { name: '没有 id' },
          null,
          { id: 'ok', name: '名'.repeat(60), note: '说'.repeat(200), palettes: { light: { paper: '#010203' } } },
        ],
      },
    });
    const state = storageMod.readInjectedTheme(doc as Any).theme;
    expect(state.custom.length).toBe(1);
    expect(state.custom[0].name.length).toBe(40);
    expect(state.custom[0].note.length).toBe(80);
    expect(state.custom[0].palettes.light.paper).toBe('#010203');
    expect(state.custom[0].palettes.light.ink).toBe(registry.fallbackPalette('light').ink);
    expect(state.custom[0].palettes.dark).toEqual(registry.fallbackPalette('dark'));
  });

  it('本机旧记录：两个键都认,新键在前;读完不删', () => {
    expect(storageMod.LEGACY_THEME_STORAGE_KEYS).toEqual(['cortico.theme.v1', 'xuewu.theme-studio.v1']);
    const [KEY, LEGACY_KEY] = storageMod.LEGACY_THEME_STORAGE_KEYS;
    const store = new FakeStorage();
    store.map.set(LEGACY_KEY, legacyRecord());
    const doc = new FakeDoc({ localStorage: store });
    expect(storageMod.readLegacyLocalTheme(doc as Any).selectedId).toBe('custom-legacy');
    store.map.set(KEY, JSON.stringify({ selectedId: SECOND, mode: 'light', custom: [] }));
    expect(storageMod.readLegacyLocalTheme(doc as Any).selectedId).toBe(SECOND);
    expect(store.map.has(LEGACY_KEY)).toBe(true);
  });

  it('本机旧记录：没有、读不出、拿不到 localStorage（沙箱 iframe）一律 null', () => {
    expect(storageMod.readLegacyLocalTheme(new FakeDoc() as Any)).toBe(null);
    expect(storageMod.readLegacyLocalTheme(new FakeDoc({ localStorage: new FakeStorage() }) as Any)).toBe(null);
    const denied = new FakeStorage();
    denied.fail = true;
    expect(storageMod.readLegacyLocalTheme(new FakeDoc({ localStorage: denied }) as Any)).toBe(null);
    const hostile = new FakeDoc();
    Object.defineProperty(hostile, 'defaultView', {
      get(): never {
        throw new Error('被沙箱挡了');
      },
    });
    expect(storageMod.readLegacyLocalTheme(hostile as Any)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// studio —— 首屏应用、订阅、编辑
// ---------------------------------------------------------------------------

describe('主题工作室', () => {
  let doc: FakeDoc;
  let media: FakeMedia;
  /** 回写到部署的每一份记录，按先后顺序。 */
  let saved: Any[];
  /** 非空则回写失败，内容是失败原因。 */
  let saveFails: string | null;

  beforeEach(() => {
    doc = new FakeDoc();
    media = new FakeMedia(false);
    saved = [];
    saveFails = null;
  });

  const save = async (state: Any): Promise<void> => {
    if (saveFails !== null) throw new Error(saveFails);
    saved.push(JSON.parse(JSON.stringify(state)));
  };
  const deps = (extra: Any = {}): Any => ({
    media,
    save,
    legacy: null,
    injected: { defaultScheme: DEFAULT_ID, theme: null },
    ...extra,
  });
  const apply = (extra: Any = {}): Any => studioMod.applyStoredTheme(doc as Any, deps(extra));
  const studio = (extra: Any = {}): Any => studioMod.getThemeStudio({ doc: doc as Any, ...deps(extra) });
  const lastSaved = (): Any => saved[saved.length - 1];
  /** 回写是异步的；等一轮微任务让结果落到快照上。 */
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it('applyStoredTheme：没存过主题时落到内置首个方案 + 跟随系统 + 浅色', () => {
    const snap = apply();
    expect(snap.selectedId).toBe(DEFAULT_ID);
    expect(snap.mode).toBe('system');
    expect(snap.appearance).toBe('light');
    expect(snap.scheme.builtin).toBe(true);
    expect(doc.documentElement.style.getPropertyValue('--paper'))
      .toBe(registry.BUILTIN_SCHEMES[0].palettes.light.paper);
    expect(doc.documentElement.dataset.themeScheme).toBe(DEFAULT_ID);
    // 只读不写：部署还没有记录，也没有本机旧记录可交，就不该凭空写一份
    expect(saved).toEqual([]);
  });

  it('部署默认方案：还没有记录时用它,认不出的 id 落到框架默认', () => {
    expect(apply({ injected: { defaultScheme: THIRD, theme: null } }).selectedId).toBe(THIRD);
    studioMod.disposeThemeStudio();
    expect(apply({ injected: { defaultScheme: '没这个方案', theme: null } }).selectedId).toBe(DEFAULT_ID);
  });

  it('部署默认方案：已保存的选择赢过它,删掉自定义方案后回到它', () => {
    const s = studio({
      injected: { defaultScheme: THIRD, theme: { selectedId: SECOND, mode: 'light', custom: [] } },
    });
    s.apply(false);
    expect(s.snapshot().selectedId).toBe(SECOND);
    s.saveAs('待删', s.snapshot().palette);
    expect(s.removeCurrent()).toBe(true);
    expect(s.snapshot().selectedId).toBe(THIRD);
  });

  it('部署还没有记录而本机存过：采用本机那份并回写一次', () => {
    const legacy = JSON.parse(legacyRecord());
    const snap = apply({ legacy, injected: { defaultScheme: SECOND, theme: null } });
    expect(snap.selectedId).toBe('custom-legacy');
    expect(saved.length).toBe(1);
    expect(lastSaved().selectedId).toBe('custom-legacy');
  });

  it('部署已有记录：本机旧记录不再参与', () => {
    const snap = apply({
      legacy: JSON.parse(legacyRecord()),
      injected: { defaultScheme: DEFAULT_ID, theme: { selectedId: SECOND, mode: 'light', custom: [] } },
    });
    expect(snap.selectedId).toBe(SECOND);
    expect(saved).toEqual([]);
  });

  it('回写失败：当前选择照样生效，失败原因进快照；下一次成功后清掉', async () => {
    apply();
    const s = studio();
    saveFails = '磁盘满了';
    s.select(THIRD);
    await settle();
    expect(s.snapshot().selectedId).toBe(THIRD);
    expect(s.snapshot().saveError).toBe('磁盘满了');
    saveFails = null;
    s.select(SECOND);
    await settle();
    expect(s.snapshot().saveError).toBe(null);
  });

  it('applyStoredTheme：系统偏好为深色时，system 挡位解析成 dark', () => {
    media.matches = true;
    const snap = apply();
    expect(snap.appearance).toBe('dark');
    expect(doc.documentElement.style.colorScheme).toBe('dark');
    expect(doc.documentElement.style.getPropertyValue('--paper'))
      .toBe(registry.BUILTIN_SCHEMES[0].palettes.dark.paper);
  });

  it('applyStoredTheme：读得到部署记录就照它来（含自定义方案）', () => {
    const snap = apply({ injected: { defaultScheme: DEFAULT_ID, theme: JSON.parse(legacyRecord()) } });
    expect(snap.selectedId).toBe('custom-legacy');
    expect(snap.mode).toBe('dark');
    expect(snap.appearance).toBe('dark');
    expect(doc.documentElement.style.getPropertyValue('--paper')).toBe('#123456');
    expect(snap.scheme.custom).toBe(true);
  });

  it('applyStoredTheme：首屏这一次不广播（那时候还没有订阅者）', () => {
    const seen: Any[] = [];
    apply();
    studio().onChange((c: Any) => seen.push(c));
    expect(seen.length).toBe(0);
    // 再调一次仍然不广播：它是"应用存档"，不是"用户换了主题"
    studioMod.applyStoredTheme(doc as Any);
    expect(seen.length).toBe(0);
  });

  it('applyStoredTheme：同一个进程里反复调只有一个实例，deps 以第一次为准', () => {
    apply();
    const other: Any[] = [];
    studioMod.applyStoredTheme(doc as Any, deps({ save: async (s: Any) => { other.push(s); } }));
    studio().setMode('dark');
    expect(other).toEqual([]);
    expect(lastSaved().mode).toBe('dark');
  });

  it('记录里的方案没了（在别处删的）→ 退回默认方案并把纠正回写部署', () => {
    const snap = apply({
      injected: { defaultScheme: DEFAULT_ID, theme: { selectedId: 'ghost', mode: 'light', custom: [] } },
    });
    expect(snap.selectedId).toBe(DEFAULT_ID);
    expect(lastSaved().selectedId).toBe(DEFAULT_ID);
  });

  it('select / setMode：认不出的值原样拒绝，认得的回写部署并刷 CSS 变量', () => {
    apply();
    const s = studio();
    expect(s.select('不存在')).toBe(false);
    expect(s.setMode('neon')).toBe(false);
    expect(s.select(THIRD)).toBe(true);
    expect(doc.documentElement.style.getPropertyValue('--paper'))
      .toBe(registry.BUILTIN_SCHEMES[2].palettes.light.paper);
    expect(s.setMode('dark')).toBe(true);
    expect(doc.documentElement.style.getPropertyValue('--paper'))
      .toBe(registry.BUILTIN_SCHEMES[2].palettes.dark.paper);
    expect(lastSaved()).toEqual({ selectedId: THIRD, mode: 'dark', custom: [] });
  });

  it('onChange：订阅收到快照，dispose 之后一条都不再收', () => {
    apply();
    const seen: Any[] = [];
    const sub = studio().onChange((c: Any) => seen.push(c));
    studio().select(SECOND);
    expect(seen.length).toBe(1);
    expect(seen[0].preview).toBe(false);
    expect(seen[0].snapshot.selectedId).toBe(SECOND);
    sub.dispose();
    studio().select(THIRD);
    expect(seen.length).toBe(1);
    // 重复 dispose 幂等
    expect(() => sub.dispose()).not.toThrow();
  });

  it('onChange：同一个函数登记两次只算一次；一个订阅方抛错不挡住其余的', () => {
    const errs: unknown[] = [];
    studioMod.applyStoredTheme(doc as Any, deps({ onError: (e: unknown) => errs.push(e) }));
    const s = studio();
    let hits = 0;
    const once = (): void => {
      hits += 1;
    };
    s.onChange(once);
    s.onChange(once);
    const after: string[] = [];
    s.onChange(() => {
      throw new Error('这张图重画失败了');
    });
    s.onChange(() => after.push('还是跑到了'));
    s.select(THIRD);
    expect(hits).toBe(1);
    expect(after).toEqual(['还是跑到了']);
    expect((errs[0] as Error).message).toBe('这张图重画失败了');
  });

  it('preview：刷到文档、广播 preview:true，但**不回写部署**；resetPreview 复原', () => {
    apply();
    const s = studio();
    const seen: Any[] = [];
    s.onChange((c: Any) => seen.push(c));
    const draft = { ...s.snapshot().palette, paper: '#010101' };
    s.preview(draft);
    expect(doc.documentElement.style.getPropertyValue('--paper')).toBe('#010101');
    expect(seen[0].preview).toBe(true);
    expect(seen[0].snapshot.palette.paper).toBe('#010101');
    expect(saved).toEqual([]);
    s.resetPreview();
    expect(doc.documentElement.style.getPropertyValue('--paper'))
      .toBe(registry.BUILTIN_SCHEMES[0].palettes.light.paper);
    expect(seen[1].preview).toBe(false);
  });

  it('preview：草稿里的坏颜色按当前方案补齐，野键不会被刷进 documentElement', () => {
    apply();
    const s = studio();
    s.preview({ paper: '#020202', ink: '瞎写的', 'evil-key': '#ff0000' });
    expect(doc.documentElement.style.getPropertyValue('--paper')).toBe('#020202');
    expect(doc.documentElement.style.getPropertyValue('--ink'))
      .toBe(registry.BUILTIN_SCHEMES[0].palettes.light.ink);
    expect(doc.documentElement.style.getPropertyValue('--evil-key')).toBe('');
  });

  it('saveAs：只覆盖当前明暗变体，另一半原样拷贝；记录里多一条并切过去', () => {
    apply();
    const s = studio();
    const id = s.saveAs('我的配色', { ...s.snapshot().palette, paper: '#030303' });
    const snap = s.snapshot();
    expect(snap.selectedId).toBe(id);
    expect(snap.scheme.custom).toBe(true);
    expect(snap.scheme.name).toBe('我的配色');
    expect(snap.palette.paper).toBe('#030303');
    const raw = lastSaved();
    expect(raw.custom.length).toBe(1);
    expect(raw.custom[0].palettes.light.paper).toBe('#030303');
    // 黑夜变体没被浅色草稿污染
    expect(raw.custom[0].palettes.dark.paper).toBe(registry.BUILTIN_SCHEMES[0].palettes.dark.paper);
    // 方案列表里内置在前、自定义在后
    expect(snap.schemes.length).toBe(registry.BUILTIN_SCHEMES.length + 1);
    expect(snap.schemes[snap.schemes.length - 1].custom).toBe(true);
  });

  it('saveAs：名字空着走「源方案 副本」，并且截到 40 字', () => {
    apply();
    const s = studio();
    s.saveAs('   ', s.snapshot().palette);
    expect(s.snapshot().scheme.name).toBe(`${registry.BUILTIN_SCHEMES[0].name} 副本`);
    s.saveAs('长'.repeat(80), s.snapshot().palette);
    expect(s.snapshot().scheme.name.length).toBe(40);
  });

  it('saveCurrent：内置方案上返回 false；自定义方案上改名改色并回写部署', () => {
    apply();
    const s = studio();
    expect(s.saveCurrent('随便', s.snapshot().palette)).toBe(false);
    s.saveAs('底稿', s.snapshot().palette);
    expect(s.saveCurrent('改过名', { ...s.snapshot().palette, ink: '#040404' })).toBe(true);
    expect(s.snapshot().scheme.name).toBe('改过名');
    expect(s.snapshot().palette.ink).toBe('#040404');
    // 名字给空串就保留原名
    expect(s.saveCurrent('', s.snapshot().palette)).toBe(true);
    expect(s.snapshot().scheme.name).toBe('改过名');
  });

  it('removeCurrent：内置方案上返回 false；删掉自定义后切回默认方案', () => {
    apply();
    const s = studio();
    expect(s.removeCurrent()).toBe(false);
    s.saveAs('待删', s.snapshot().palette);
    expect(s.removeCurrent()).toBe(true);
    expect(s.snapshot().selectedId).toBe(DEFAULT_ID);
    expect(lastSaved().custom).toEqual([]);
  });

  it('系统偏好变了：system 挡位跟着换，钉死的挡位不为所动', () => {
    apply();
    const s = studio();
    const seen: Any[] = [];
    s.onChange((c: Any) => seen.push(c));
    media.set(true);
    expect(s.snapshot().appearance).toBe('dark');
    expect(seen.length).toBe(1);
    s.setMode('light');
    media.set(false);
    media.set(true);
    expect(s.snapshot().appearance).toBe('light');
    expect(doc.documentElement.style.colorScheme).toBe('light');
  });

  it('dispose：摘掉系统偏好监听与全部订阅，之后系统再变也不动文档', () => {
    apply();
    const s = studio();
    expect(media.count).toBe(1);
    let hits = 0;
    s.onChange(() => {
      hits += 1;
    });
    studioMod.disposeThemeStudio();
    expect(media.count).toBe(0);
    media.set(true);
    expect(hits).toBe(0);
    expect(doc.documentElement.style.colorScheme).toBe('light');
  });

  it('snapshot 是副本：改它不会反过来改工作室的状态', () => {
    apply();
    const s = studio();
    const snap = s.snapshot();
    snap.palette.paper = '#050505';
    expect(s.snapshot().palette.paper).toBe(registry.BUILTIN_SCHEMES[0].palettes.light.paper);
  });

  it('没有 Document 又没建过实例时，getThemeStudio 给一条能看懂的错', () => {
    expect(() => studioMod.getThemeStudio()).toThrow(/Document/);
  });
});

describe('部署默认方案', () => {
  it('框架默认与仓内三个 bot 填的 id 都是内置方案,不会静默落回', async () => {
    const { CORE_DEFAULTS } = await import('../../src/core/config.ts');
    const bots = await Promise.all([
      import('../../bots/cormini/index.ts'),
      import('../../bots/cortiv/index.ts'),
      import('../../bots/corti-soulmate/index.ts'),
    ]);
    const ids = [CORE_DEFAULTS.web.theme, ...bots.map((m) => m.default.defaults().web.theme)];
    for (const id of ids) expect(registry.resolveDefaultSchemeId(id)).toBe(id);
    expect(ids.slice(1)).toEqual(['mint', 'navigator', 'crab-daisy']);
  });

  it('终端页当前端点那块徽标只用主题变量取色,换方案跟着走', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync(new URL('../../src/web/public/styles.css', import.meta.url), 'utf8');
    const rule = /^\.live-connection-value \{([^}]*)\}/m.exec(css);
    expect(rule).not.toBeNull();
    expect(rule![1]).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
