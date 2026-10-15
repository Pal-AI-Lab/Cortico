/**
 * 主题的数据与纯函数：token 词表、内置调色板、部署主题记录的规范化。
 * 浏览器、WebUI 服务端与启动器共用这一份；不依赖 DOM，token 的中文标签由浏览器侧贴。
 */

export type ThemeMode = 'light' | 'dark' | 'system';

/** `system` 解析之后只剩两种。CSS 变量真正落地时看的是这个。 */
export type ThemeAppearance = 'light' | 'dark';

/** token key → `#rrggbb`。缺格由 `normalizePalette` 用回退表补齐。 */
export type ThemePalette = Record<string, string>;

export interface ThemeScheme {
  id: string;
  name: string;
  note: string;
  /** 浅色与黑夜是**两份独立配色**，不是同一份的明暗算法推导。 */
  palettes: Record<ThemeAppearance, ThemePalette>;
  builtin?: boolean;
  custom?: boolean;
}

/** 一份部署的主题记录，存在 `<部署>/theme.json`。内置方案不进记录。 */
export interface StoredTheme {
  /** 选中的方案 id（可能指向一个已被删掉的自定义方案，取用时再兜底）。 */
  selectedId: string;
  mode: ThemeMode;
  custom: ThemeScheme[];
}

export const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system'];

/** 词表分组与顺序。组标题与逐个 token 的标签在浏览器侧按 id 取。 */
export const THEME_TOKEN_GROUPS = [
  { id: 'paper', keys: ['paper', 'paper-2', 'sheet', 'sheet-2', 'sheet-3'] },
  { id: 'ink', keys: ['ink', 'ink-soft', 'ink-dim', 'line', 'line-2', 'line-strong'] },
  { id: 'state', keys: ['accent', 'accent-2', 'on-accent', 'ok', 'warn', 'danger'] },
  {
    id: 'timeline',
    keys: ['ink-blue', 'violet', 'agent-surface', 'world-bg', 'world-ink', 'bubble-bg', 'bubble-ink', 'tool-result'],
  },
  {
    id: 'chart',
    keys: [
      'chart-hit', 'chart-miss', 'chart-output',
      'chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'chart-6', 'chart-7', 'chart-8',
    ],
  },
] as const;

export const THEME_TOKEN_KEYS: readonly string[] = THEME_TOKEN_GROUPS.flatMap((g) => [...g.keys]);

/** 主强调取自明暗版 Logo；正文使用加深或调亮的同色系绿色。 */
const mintLight: ThemePalette = {
  paper: '#f4f5f4', 'paper-2': '#ecedec', sheet: '#fbfbfb', 'sheet-2': '#f2f3f2', 'sheet-3': '#e8e9e8',
  ink: '#1b1a1e', 'ink-soft': '#5c5c60', 'ink-dim': '#8b8b8f', line: '#e3e4e3', 'line-2': '#d0d2d0', 'line-strong': '#aeb0ae',
  accent: '#00a870', 'accent-2': '#54b494', 'on-accent': '#082a1e', ok: '#19815e', warn: '#96743b', danger: '#b45950',
  'ink-blue': '#238268', violet: '#25765e', 'agent-surface': '#f4f5f4', 'world-bg': '#f0f1f0', 'world-ink': '#4a4a4e',
  'bubble-bg': '#e6e9e7', 'bubble-ink': '#1f2221', 'tool-result': '#087452',
  'chart-hit': '#19815e', 'chart-miss': '#96743b', 'chart-output': '#00a870',
  'chart-1': '#00a870', 'chart-2': '#54b494', 'chart-3': '#348f86', 'chart-4': '#72967f',
  'chart-5': '#b59564', 'chart-6': '#9b8071', 'chart-7': '#4a8f9a', 'chart-8': '#889460',
};

const mintDark: ThemePalette = {
  paper: '#121312', 'paper-2': '#181a19', sheet: '#1d1f1e', 'sheet-2': '#242726', 'sheet-3': '#2c302e',
  ink: '#e9eae9', 'ink-soft': '#b0b2b1', 'ink-dim': '#828584', line: '#292c2b', 'line-2': '#383c3a', 'line-strong': '#535856',
  accent: '#2fd59b', 'accent-2': '#78cbae', 'on-accent': '#082a1e', ok: '#76ca9f', warn: '#c4a372', danger: '#d18c83',
  'ink-blue': '#53bda0', violet: '#91d8bb', 'agent-surface': '#181a19', 'world-bg': '#1e211f', 'world-ink': '#adb2b0',
  'bubble-bg': '#2c3230', 'bubble-ink': '#e6eae8', 'tool-result': '#75cfa8',
  'chart-hit': '#76ca9f', 'chart-miss': '#c4a372', 'chart-output': '#2fd59b',
  'chart-1': '#2fd59b', 'chart-2': '#78cbae', 'chart-3': '#64b8ad', 'chart-4': '#91b99d',
  'chart-5': '#c4a372', 'chart-6': '#b69b8c', 'chart-7': '#76afb9', 'chart-8': '#a8b17e',
};

const navigatorLight: ThemePalette = {
  paper: '#f5f7fa', 'paper-2': '#e9eef4', sheet: '#ffffff', 'sheet-2': '#f1f4f8', 'sheet-3': '#e3eaf2',
  ink: '#383d43', 'ink-soft': '#536174', 'ink-dim': '#7d8a9c', line: '#dce3eb', 'line-2': '#c6d1df', 'line-strong': '#9dacc0',
  accent: '#6591c3', 'accent-2': '#383d43', 'on-accent': '#111820', ok: '#357389', warn: '#865963', danger: '#a34f63',
  'ink-blue': '#426c99', violet: '#383d43', 'agent-surface': '#f5f7fa', 'world-bg': '#edf3f8', 'world-ink': '#485665',
  'bubble-bg': '#e4eef8', 'bubble-ink': '#383d43', 'tool-result': '#355c84',
  'chart-hit': '#529bbd', 'chart-miss': '#383d43', 'chart-output': '#6591c3',
  'chart-1': '#6591c3', 'chart-2': '#383d43', 'chart-3': '#81c9ef', 'chart-4': '#a9bed6',
  'chart-5': '#bc8f9a', 'chart-6': '#637489', 'chart-7': '#4f91ad', 'chart-8': '#c6d3e2',
};

/** 深色背景上的海军蓝边线与文字使用提亮的同色系蓝色。 */
const navigatorDark: ThemePalette = {
  paper: '#12171d', 'paper-2': '#171d24', sheet: '#202730', 'sheet-2': '#28313c', 'sheet-3': '#323d4a',
  ink: '#f2f5fa', 'ink-soft': '#b8c5d6', 'ink-dim': '#8594a7', line: '#2d3743', 'line-2': '#3c4959', 'line-strong': '#596b80',
  accent: '#81c9ef', 'accent-2': '#6591c3', 'on-accent': '#162331', ok: '#85c8dc', warn: '#d6aeb8', danger: '#e99bae',
  'ink-blue': '#81c9ef', violet: '#a9bed6', 'agent-surface': '#171d24', 'world-bg': '#202b38', 'world-ink': '#b8c5d6',
  'bubble-bg': '#2e3d50', 'bubble-ink': '#f2f5fa', 'tool-result': '#9dbfe2',
  'chart-hit': '#81c9ef', 'chart-miss': '#6591c3', 'chart-output': '#adc7e4',
  'chart-1': '#81c9ef', 'chart-2': '#6591c3', 'chart-3': '#9dbfe2', 'chart-4': '#b8c5d6',
  'chart-5': '#fae6e8', 'chart-6': '#8e9fb5', 'chart-7': '#73aec9', 'chart-8': '#cbd6e4',
};

/** Claude 灰阶配赤陶与灰玫瑰强调色；浅色文字使用同色系的深色。 */
const crabDaisyLight: ThemePalette = {
  paper: '#fcfcfb', 'paper-2': '#f9f9f7', sheet: '#ffffff', 'sheet-2': '#f3f3f0', 'sheet-3': '#f0efec',
  ink: '#0b0b0b', 'ink-soft': '#52514e', 'ink-dim': '#7b7974', line: '#e1e0d9', 'line-2': '#d2d1c7', 'line-strong': '#b4b3a8',
  accent: '#c87c5d', 'accent-2': '#cb7c78', 'on-accent': '#131313', ok: '#006300', warn: '#835100', danger: '#8e2626',
  'ink-blue': '#cb7c78', violet: '#a15d59', 'agent-surface': '#fcfcfb', 'world-bg': '#f3f3f0', 'world-ink': '#52514e',
  'bubble-bg': '#f0efec', 'bubble-ink': '#131313', 'tool-result': '#995b43',
  'chart-hit': '#009300', 'chart-miss': '#a66a00', 'chart-output': '#c87c5d',
  'chart-1': '#c87c5d', 'chart-2': '#cb7c78', 'chart-3': '#7161e0', 'chart-4': '#009300',
  'chart-5': '#c6613f', 'chart-6': '#a66a00', 'chart-7': '#7b7974', 'chart-8': '#c04873',
};

const crabDaisyDark: ThemePalette = {
  paper: '#151515', 'paper-2': '#111111', sheet: '#20201f', 'sheet-2': '#1e1e1d', 'sheet-3': '#2c2c2a',
  ink: '#f0efec', 'ink-soft': '#c3c2b7', 'ink-dim': '#97958d', line: '#383835', 'line-2': '#454442', 'line-strong': '#5f5e5a',
  accent: '#c87c5d', 'accent-2': '#cb7c78', 'on-accent': '#131313', ok: '#91d68b', warn: '#db9300', danger: '#ec7e7e',
  'ink-blue': '#cb7c78', violet: '#cb7c78', 'agent-surface': '#151515', 'world-bg': '#20201f', 'world-ink': '#c3c2b7',
  'bubble-bg': '#2c2c2a', 'bubble-ink': '#f0efec', 'tool-result': '#c87c5d',
  'chart-hit': '#91d68b', 'chart-miss': '#db9300', 'chart-output': '#c87c5d',
  'chart-1': '#c87c5d', 'chart-2': '#cb7c78', 'chart-3': '#a096eb', 'chart-4': '#91d68b',
  'chart-5': '#ec835a', 'chart-6': '#db9300', 'chart-7': '#97958d', 'chart-8': '#e87ba4',
};

/** 内置方案的调色板，按 id。名称与说明是界面文案，由浏览器侧按 id 贴。 */
export const BUILTIN_PALETTES: Readonly<Record<string, Record<ThemeAppearance, ThemePalette>>> = {
  mint: { light: mintLight, dark: mintDark },
  navigator: { light: navigatorLight, dark: navigatorDark },
  'crab-daisy': { light: crabDaisyLight, dark: crabDaisyDark },
};

/** 内置方案 id，第一个是框架默认方案。 */
export const BUILTIN_SCHEME_IDS: readonly string[] = Object.keys(BUILTIN_PALETTES);

/** 记录里没有可用选择时落到哪一个。 */
export const DEFAULT_SCHEME_ID = BUILTIN_SCHEME_IDS[0];

/** `#rrggbb`（大小写不限）。三位简写**不算**——记录里只留规范形式。 */
export function isHexColor(value: unknown): boolean {
  return /^#[0-9a-f]{6}$/i.test(String(value ?? ''));
}

/**
 * 用户输入 → 规范 `#rrggbb`（小写）；认不出给 `null`。
 *
 * 收 `#abc` 简写是因为手打十六进制的人真会那么写，而 `<input type="color">`
 * 永远吐六位——两边喂进同一个函数，编辑器里就不必分两条路。
 */
export function normalizeHex(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  const short = /^#([0-9a-f]{3})$/i.exec(raw);
  const full = short ? '#' + short[1].split('').map((c) => c + c).join('') : raw;
  return isHexColor(full) ? full.toLowerCase() : null;
}

/** 该明暗变体的兜底调色板（默认方案）。 */
export function fallbackPalette(appearance: ThemeAppearance): ThemePalette {
  return BUILTIN_PALETTES[DEFAULT_SCHEME_ID][appearance];
}

/**
 * 逐 token 校验 + 补齐。**只留词表里的键**：记录里混进来的野键不该被原样写回
 * `documentElement`，那等于让一份主题记录往全站注入任意 CSS 变量。
 */
export function normalizePalette(palette: unknown, fallback: ThemePalette): ThemePalette {
  const src = (palette ?? {}) as Record<string, unknown>;
  const out: ThemePalette = {};
  for (const key of THEME_TOKEN_KEYS) {
    const value = src[key];
    out[key] = isHexColor(value) ? String(value).toLowerCase() : fallback[key];
  }
  return out;
}

export function clonePalette(palette: ThemePalette): ThemePalette {
  return { ...palette };
}

export function cloneScheme(scheme: ThemeScheme): ThemeScheme {
  return {
    ...scheme,
    palettes: {
      light: clonePalette(scheme.palettes.light),
      dark: clonePalette(scheme.palettes.dark),
    },
  };
}

/** 方案卡上那条四格色带：底纸 / 主卡纸 / 主强调 / 一个图表系列色。 */
export function schemeSwatches(scheme: ThemeScheme, appearance: ThemeAppearance): string[] {
  const p = scheme.palettes[appearance];
  return [p.paper, p.sheet, p.accent, p['chart-2']];
}

export function defaultStoredTheme(): StoredTheme {
  return { selectedId: DEFAULT_SCHEME_ID, mode: 'system', custom: [] };
}

/** 自定义方案的名称上限 40 字、说明上限 80 字；缺 id 的记录返回 null。 */
function normalizeCustomScheme(raw: unknown): ThemeScheme | null {
  if (!raw || typeof raw !== 'object') return null;
  const scheme = raw as Partial<ThemeScheme>;
  if (typeof scheme.id !== 'string' || scheme.id === '') return null;
  const palettes = (scheme.palettes ?? {}) as Partial<ThemeScheme['palettes']>;
  return {
    id: scheme.id,
    name: String(scheme.name ?? '').slice(0, 40),
    note: String(scheme.note ?? '').slice(0, 80),
    palettes: {
      light: normalizePalette(palettes.light, fallbackPalette('light')),
      dark: normalizePalette(palettes.dark, fallbackPalette('dark')),
    },
    custom: true,
  };
}

/** 任意值 → 一份可用的主题记录。字段类型不对的按缺省算，绝不抛。 */
export function normalizeStoredTheme(value: unknown): StoredTheme {
  if (!value || typeof value !== 'object') return defaultStoredTheme();
  const raw = value as Partial<StoredTheme>;
  return {
    selectedId: typeof raw.selectedId === 'string' ? raw.selectedId : DEFAULT_SCHEME_ID,
    mode: THEME_MODES.includes(raw.mode as ThemeMode) ? (raw.mode as ThemeMode) : 'system',
    custom: Array.isArray(raw.custom)
      ? raw.custom.map(normalizeCustomScheme).filter((s): s is ThemeScheme => s !== null)
      : [],
  };
}

/** JSON 文本 → 主题记录。解析不了或是空串给默认值。 */
export function parseStoredTheme(raw: string | null | undefined): StoredTheme {
  if (raw == null || raw === '') return defaultStoredTheme();
  try {
    return normalizeStoredTheme(JSON.parse(raw));
  } catch {
    return defaultStoredTheme();
  }
}

/**
 * 记录里选中的那份调色板。选中的自定义方案被删掉、或 id 认不出时落到默认方案。
 * `mode` 为 `system` 时由调用方决定明暗：浏览器问系统，命令行按深色。
 */
export function resolvePalette(state: StoredTheme, appearance: ThemeAppearance): ThemePalette {
  const custom = state.custom.find((s) => s.id === state.selectedId);
  if (custom) return custom.palettes[appearance];
  const builtin = BUILTIN_PALETTES[state.selectedId] ?? BUILTIN_PALETTES[DEFAULT_SCHEME_ID];
  return builtin[appearance];
}

/** 服务端把部署的主题记录注入到这个 id 的 `<script type="application/json">`。 */
export const THEME_SCRIPT_ID = 'cortico-theme';

/** 随首页发出的主题：部署默认方案 id，以及这份部署已保存的记录（没保存过为 null）。 */
export interface InjectedTheme {
  defaultScheme: string;
  theme: StoredTheme | null;
}
