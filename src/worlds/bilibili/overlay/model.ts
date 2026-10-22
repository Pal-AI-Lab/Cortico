import {
  OVERLAY_SCHEMA_VERSION,
  type AudienceCompare,
  type AudienceField,
  type AudienceGroup,
  type AudienceRule,
  type BilibiliOverlayConfig,
  type BilibiliOverlayDesign,
  type OverlayAudienceFacts,
  type OverlayComponent,
  type OverlayComponentTitle,
  type OverlayPlacement,
  type OverlayStyle,
  type OverlayTextStyle,
  type OverlayTextStylePatch,
} from './types.ts';

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/;
const URL_RE = /^https?:\/\//i;
const AUDIENCE_FIELDS = new Set<AudienceField>([
  'uid',
  'guardLevel',
  'medalLevel',
  'medalName',
  'medalAnchorName',
  'medalRoomId',
  'medalColor',
  'isAdmin',
  'vip',
  'svip',
  'rank',
  'nameColor',
  'userLevel',
  'eventKind',
]);
const AUDIENCE_COMPARES = new Set<AudienceCompare>(['eq', 'gte', 'lte', 'exists', 'contains']);

const BASE_USERNAME: OverlayTextStyle = {
  fontFamily: 'Microsoft YaHei, sans-serif',
  fontSize: 30,
  fontWeight: 700,
  color: '#ffffffff',
  strokeColor: '#17324dff',
  strokeWidth: 1,
};

const BASE_BODY: OverlayTextStyle = {
  fontFamily: 'Microsoft YaHei, sans-serif',
  fontSize: 32,
  fontWeight: 500,
  color: '#ffffffff',
  strokeColor: '#17324dff',
  strokeWidth: 1,
};

const BASE_TITLE: OverlayTextStyle = {
  fontFamily: 'Microsoft YaHei, sans-serif',
  fontSize: 26,
  fontWeight: 700,
  color: '#ffffffff',
  strokeColor: '#17324dff',
  strokeWidth: 0,
};

/** 首项是默认样式：新组件、缺省设计和找不到样式的组件都用它。 */
export const BUILTIN_OVERLAY_STYLES: readonly OverlayStyle[] = [
  {
    id: 'builtin:translucent',
    name: '半透明黑',
    background: '#0000001f',
    borderColor: '#00000000',
    borderWidth: 0,
    radius: 0,
    padding: 16,
    username: { ...BASE_USERNAME },
    body: { ...BASE_BODY },
  },
  {
    id: 'builtin:sky',
    name: '天蓝色',
    background: '#58b8e8dd',
    borderColor: '#d8f5ffff',
    borderWidth: 2,
    radius: 0,
    padding: 16,
    username: { ...BASE_USERNAME, color: '#ffffffff', strokeColor: '#17628bff' },
    body: { ...BASE_BODY, color: '#ffffffff', strokeColor: '#17628bff' },
  },
  {
    id: 'builtin:navy',
    name: '海军蓝',
    background: '#0c2340e8',
    borderColor: '#4f83b8ff',
    borderWidth: 2,
    radius: 0,
    padding: 16,
    username: { ...BASE_USERNAME, color: '#7dd3fcff', strokeColor: '#020617ff' },
    body: { ...BASE_BODY, color: '#f8fafcff', strokeColor: '#020617ff' },
  },
  {
    id: 'builtin:white',
    name: '白色',
    background: '#fffffff0',
    borderColor: '#d9e2ecff',
    borderWidth: 2,
    radius: 0,
    padding: 16,
    username: { ...BASE_USERNAME, color: '#176b9cff', strokeColor: '#ffffffff', strokeWidth: 0 },
    body: { ...BASE_BODY, color: '#172033ff', strokeColor: '#ffffffff', strokeWidth: 0 },
  },
  {
    id: 'builtin:minimal',
    name: '极简',
    background: '#000000ff',
    borderColor: '#00000000',
    borderWidth: 0,
    radius: 0,
    padding: 0,
    username: { ...BASE_USERNAME, strokeWidth: 0 },
    body: { ...BASE_BODY, strokeWidth: 0 },
  },
] as const;

export const BILIBILI_OVERLAY_DEFAULTS: BilibiliOverlayConfig = {
  enabled: true,
  port: 7795,
  agentNoticeMaxChars: 200,
  design: {
    schemaVersion: OVERLAY_SCHEMA_VERSION,
    canvas: { width: 1920, height: 1080 },
    styles: [],
    groups: [],
    components: [
      {
        id: 'danmaku-main',
        name: '主弹幕机',
        kind: 'danmaku',
        styleId: 'builtin:translucent',
        axis: 'vertical',
        admission: 'all',
        showAvatar: true,
        speed: 90,
        gap: 12,
        maxItems: 12,
        usernameMaxChars: 24,
        bodyMaxChars: 80,
        edgeFadePx: 32,
      },
      {
        id: 'agent-notice',
        name: 'Agent 公告',
        kind: 'agent-notice',
        styleId: 'builtin:translucent',
        emptyText: '公告栏待更新',
        hideWhenEmpty: false,
        typingMs: 42,
      },
    ],
    placements: [
      {
        id: 'placement-danmaku-main',
        componentId: 'danmaku-main',
        x: 1240,
        y: 120,
        width: 600,
        height: 760,
        z: 10,
        visible: true,
        locked: false,
      },
      {
        id: 'placement-agent-notice',
        componentId: 'agent-notice',
        x: 120,
        y: 60,
        width: 960,
        height: 120,
        z: 20,
        visible: true,
        locked: false,
      },
    ],
  },
};

export function cloneOverlayConfig(value: BilibiliOverlayConfig = BILIBILI_OVERLAY_DEFAULTS): BilibiliOverlayConfig {
  return structuredClone(value);
}

export function normalizeOverlayConfig(value: unknown): BilibiliOverlayConfig {
  const raw = object(value);
  return {
    enabled: bool(raw.enabled, BILIBILI_OVERLAY_DEFAULTS.enabled),
    port: integer(raw.port, 0, 65535, BILIBILI_OVERLAY_DEFAULTS.port),
    agentNoticeMaxChars: integer(
      raw.agentNoticeMaxChars,
      1,
      5000,
      BILIBILI_OVERLAY_DEFAULTS.agentNoticeMaxChars,
    ),
    design: normalizeOverlayDesign(raw.design),
  };
}

export function normalizeOverlayDesign(value: unknown): BilibiliOverlayDesign {
  if (value === undefined || value === null) return structuredClone(BILIBILI_OVERLAY_DEFAULTS.design);
  const raw = object(value);
  if (Object.hasOwn(raw, 'schemaVersion')) {
    const version = raw.schemaVersion;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > OVERLAY_SCHEMA_VERSION) {
      throw new Error(`Overlay 设计 schemaVersion 无效或不受支持: ${String(version)}`);
    }
  }
  const canvas = object(raw.canvas);
  const styles = array(raw.styles).slice(0, 100).map((item, index) => normalizeStyle(item, index));
  uniqueIds(styles, '样式');
  const groups = array(raw.groups).slice(0, 100).map((item, index) => normalizeGroup(item, index));
  uniqueIds(groups, '用户组');
  const components = array(raw.components)
    .slice(0, 200)
    .map((item, index) => normalizeComponent(item, index));
  uniqueIds(components, '组件');
  const placements = array(raw.placements).slice(0, 400).map((item, index) => normalizePlacement(item, index));
  uniqueIds(placements, '布局项');

  const styleIds = new Set([...BUILTIN_OVERLAY_STYLES.map((item) => item.id), ...styles.map((item) => item.id)]);
  for (const component of components) {
    if (!styleIds.has(component.styleId)) throw new Error(`组件「${component.name}」引用了不存在的样式`);
  }
  const componentIds = new Set(components.map((item) => item.id));
  for (const placement of placements) {
    if (!componentIds.has(placement.componentId)) throw new Error(`布局项引用了不存在的组件 ${placement.componentId}`);
  }

  return {
    schemaVersion: OVERLAY_SCHEMA_VERSION,
    canvas: {
      width: integer(canvas.width, 320, 7680, 1920),
      height: integer(canvas.height, 180, 4320, 1080),
    },
    styles,
    groups,
    components,
    placements,
  };
}

export function matchAudienceGroup(
  groups: readonly AudienceGroup[],
  facts: OverlayAudienceFacts,
): AudienceGroup | undefined {
  return [...groups]
    .filter((group) => group.enabled && testAudienceRule(group.rule, facts))
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))[0];
}

export function testAudienceRule(rule: AudienceRule, facts: OverlayAudienceFacts): boolean {
  if (rule.op === 'all') return rule.rules.every((child) => testAudienceRule(child, facts));
  if (rule.op === 'any') return rule.rules.some((child) => testAudienceRule(child, facts));
  const actual = facts[rule.field];
  if (rule.compare === 'exists') return actual !== undefined && actual !== null && actual !== '';
  if (actual === undefined || actual === null) return false;
  if (rule.compare === 'contains') return String(actual).includes(String(rule.value ?? ''));
  if (rule.compare === 'gte') return Number(actual) >= Number(rule.value);
  if (rule.compare === 'lte') return Number(actual) <= Number(rule.value);
  return actual === rule.value || String(actual) === String(rule.value);
}

function normalizeStyle(value: unknown, index: number): OverlayStyle {
  const raw = object(value);
  const nine = object(raw.nineSlice);
  const sourceSlice = object(nine.slice);
  const destinationWidth = object(nine.width);
  const assetId = text(nine.assetId, '', 128);
  return {
    id: id(raw.id, `style-${index + 1}`),
    name: text(raw.name, `样式 ${index + 1}`, 80),
    background: color(raw.background, BUILTIN_OVERLAY_STYLES[0].background),
    borderColor: color(raw.borderColor, BUILTIN_OVERLAY_STYLES[0].borderColor),
    borderWidth: number(raw.borderWidth, 0, 64, BUILTIN_OVERLAY_STYLES[0].borderWidth),
    radius: number(raw.radius, 0, 200, 0),
    padding: number(raw.padding, 0, 200, 16),
    username: normalizeTextStyle(raw.username, BASE_USERNAME),
    body: normalizeTextStyle(raw.body, BASE_BODY),
    ...(assetId
      ? {
          nineSlice: {
            assetId,
            slice: {
              top: integer(sourceSlice.top ?? nine.top, 0, 65535, 20),
              right: integer(sourceSlice.right ?? nine.right, 0, 65535, 20),
              bottom: integer(sourceSlice.bottom ?? nine.bottom, 0, 65535, 20),
              left: integer(sourceSlice.left ?? nine.left, 0, 65535, 20),
            },
            width: {
              top: number(destinationWidth.top ?? nine.top, 0, 512, 20),
              right: number(destinationWidth.right ?? nine.right, 0, 512, 20),
              bottom: number(destinationWidth.bottom ?? nine.bottom, 0, 512, 20),
              left: number(destinationWidth.left ?? nine.left, 0, 512, 20),
            },
            fill: bool(nine.fill, true),
            repeat: nine.repeat === 'repeat' || nine.repeat === 'round' ? nine.repeat : 'stretch',
          },
        }
      : {}),
  };
}

function normalizeTextStyle(value: unknown, fallback: OverlayTextStyle): OverlayTextStyle {
  const raw = object(value);
  return {
    fontFamily: text(raw.fontFamily, fallback.fontFamily, 200),
    fontSize: number(raw.fontSize, 8, 240, fallback.fontSize),
    fontWeight: integer(raw.fontWeight, 100, 900, fallback.fontWeight),
    color: color(raw.color, fallback.color),
    strokeColor: color(raw.strokeColor, fallback.strokeColor),
    strokeWidth: number(raw.strokeWidth, 0, 12, fallback.strokeWidth),
  };
}

function normalizeTextPatch(value: unknown): OverlayTextStylePatch {
  const raw = object(value);
  return {
    ...(typeof raw.fontFamily === 'string' ? { fontFamily: text(raw.fontFamily, '', 200) } : {}),
    ...(raw.fontSize !== undefined ? { fontSize: number(raw.fontSize, 8, 240, 32) } : {}),
    ...(raw.fontWeight !== undefined ? { fontWeight: integer(raw.fontWeight, 100, 900, 500) } : {}),
    ...(typeof raw.color === 'string' ? { color: color(raw.color, '#ffffffff') } : {}),
    ...(typeof raw.strokeColor === 'string' ? { strokeColor: color(raw.strokeColor, '#000000ff') } : {}),
    ...(raw.strokeWidth !== undefined ? { strokeWidth: number(raw.strokeWidth, 0, 12, 0) } : {}),
  };
}

function normalizeGroup(value: unknown, index: number): AudienceGroup {
  const raw = object(value);
  return {
    id: id(raw.id, `group-${index + 1}`),
    name: text(raw.name, `用户组 ${index + 1}`, 80),
    enabled: bool(raw.enabled, true),
    priority: integer(raw.priority, -10000, 10000, 0),
    rule: normalizeRule(raw.rule, 0),
    username: normalizeTextPatch(raw.username),
    body: normalizeTextPatch(raw.body),
  };
}

function normalizeRule(value: unknown, depth: number): AudienceRule {
  if (depth > 6) throw new Error('用户组规则嵌套不能超过 6 层');
  const raw = object(value);
  if (raw.op === 'all' || raw.op === 'any') {
    const rules = array(raw.rules).slice(0, 32).map((child) => normalizeRule(child, depth + 1));
    if (!rules.length) throw new Error('组合规则至少需要一条子规则');
    return { op: raw.op, rules };
  }
  const field = String(raw.field ?? '') as AudienceField;
  const compare = String(raw.compare ?? '') as AudienceCompare;
  if (!AUDIENCE_FIELDS.has(field) || !AUDIENCE_COMPARES.has(compare)) throw new Error('用户组规则字段或比较方式无效');
  const compareValue = raw.value;
  if (compare !== 'exists' && !['string', 'number', 'boolean'].includes(typeof compareValue)) {
    throw new Error('用户组规则缺少比较值');
  }
  return {
    op: 'leaf',
    field,
    compare,
    ...(compare === 'exists' ? {} : { value: compareValue as string | number | boolean }),
  };
}

function normalizeComponent(value: unknown, index: number): OverlayComponent {
  const raw = object(value);
  const title = normalizeComponentTitle(raw.title);
  const base = {
    id: id(raw.id, `component-${index + 1}`),
    name: text(raw.name, `组件 ${index + 1}`, 80),
    styleId: id(raw.styleId, BUILTIN_OVERLAY_STYLES[0].id),
    ...(title ? { title } : {}),
  };
  switch (raw.kind) {
    case 'scroll-notice':
      return {
        ...base,
        kind: 'scroll-notice',
        axis: raw.axis === 'vertical' ? 'vertical' : 'horizontal',
        text: text(raw.text, '滚动公告', 5000),
        speed: number(raw.speed, 10, 500, 70),
        gap: number(raw.gap, 0, 500, 60),
        lineHoldMs: integer(raw.lineHoldMs, 0, 60000, 1600),
        lineTransitionMs: integer(raw.lineTransitionMs, 0, 10000, 420),
        edgeFadePx: number(raw.edgeFadePx, 0, 512, 32),
      };
    case 'fixed-notice':
      return { ...base, kind: 'fixed-notice', text: text(raw.text, '固定公告', 5000) };
    case 'agent-notice':
      return {
        ...base,
        kind: 'agent-notice',
        emptyText: text(raw.emptyText, '公告栏待更新', 500),
        hideWhenEmpty: bool(raw.hideWhenEmpty, false),
        typingMs: integer(raw.typingMs, 0, 2000, 42),
      };
    case 'image':
      return {
        ...base,
        kind: 'image',
        source: raw.source === 'upload' ? 'upload' : 'external',
        url: URL_RE.test(String(raw.url ?? '')) ? text(raw.url, '', 2048) : '',
        assetId: text(raw.assetId, '', 128),
        fit: raw.fit === 'cover' || raw.fit === 'fill' ? raw.fit : 'contain',
        opacity: number(raw.opacity, 0, 1, 1),
      };
    case 'danmaku':
      return {
        ...base,
        kind: 'danmaku',
        axis: raw.axis === 'horizontal' ? 'horizontal' : 'vertical',
        admission: raw.admission === 'danmaku' || raw.admission === 'gift' ? raw.admission : 'all',
        showAvatar: bool(raw.showAvatar, true),
        speed: number(raw.speed, 10, 500, 90),
        gap: number(raw.gap, 0, 500, 12),
        maxItems: integer(raw.maxItems, 1, 100, 12),
        usernameMaxChars: integer(raw.usernameMaxChars, 0, 5000, 24),
        bodyMaxChars: integer(raw.bodyMaxChars, 0, 5000, 80),
        edgeFadePx: number(raw.edgeFadePx, 0, 512, 32),
      };
    default:
      throw new Error(`组件「${base.name}」类型无效: ${String(raw.kind)}`);
  }
}

function normalizeComponentTitle(value: unknown): OverlayComponentTitle | undefined {
  const raw = object(value);
  const titleText = text(raw.text, '', 500);
  if (!titleText) return undefined;
  return {
    text: titleText,
    position: raw.position === 'right' || raw.position === 'bottom' || raw.position === 'left'
      ? raw.position
      : 'top',
    align: raw.align === 'center' || raw.align === 'right' ? raw.align : 'left',
    style: normalizeTextStyle(raw.style, BASE_TITLE),
  };
}

function normalizePlacement(value: unknown, index: number): OverlayPlacement {
  const raw = object(value);
  return {
    id: id(raw.id, `placement-${index + 1}`),
    componentId: id(raw.componentId, ''),
    x: number(raw.x, -7680, 7680, 0),
    y: number(raw.y, -4320, 4320, 0),
    width: number(raw.width, 20, 7680, 600),
    height: number(raw.height, 20, 4320, 200),
    z: integer(raw.z, -10000, 10000, index),
    visible: bool(raw.visible, true),
    locked: bool(raw.locked, false),
  };
}

function uniqueIds(items: ReadonlyArray<{ id: string }>, label: string): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) throw new Error(`${label} id 重复: ${item.id}`);
    ids.add(item.id);
  }
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function id(value: unknown, fallback: string): string {
  const out = typeof value === 'string' ? value.trim() : '';
  if (out && ID_RE.test(out)) return out;
  if (fallback && ID_RE.test(fallback)) return fallback;
  throw new Error('id 只能包含字母、数字、点、冒号、下划线和连字符');
}

function text(value: unknown, fallback: string, max: number): string {
  return (typeof value === 'string' ? value : fallback).slice(0, max);
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function number(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

function integer(value: unknown, min: number, max: number, fallback: number): number {
  return Math.round(number(value, min, max, fallback));
}

function color(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !COLOR_RE.test(value)) return fallback;
  const normalized = value.toLowerCase();
  return normalized.length === 7 ? `${normalized}ff` : normalized;
}
