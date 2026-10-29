/**
 * Palette 蓝图格式的解析与校验。layers[y][z][x] 为 Palette 索引满矩阵，y 自下向上、x 自西向东、z 自北向南。
 * Minecraft 状态校验由 blueprint-registry.ts 负责；格式修复由 blueprint-repair.ts 负责。
 */

export type SizeXYZ = [x: number, y: number, z: number];
export type PositionXYZ = [x: number, y: number, z: number];

/** 新建与改造均须确认冲突后清场；改造首次调用只调查现场。 */
type BlueprintSiteMode = 'new' | 'retrofit';

export interface ParsedBlockState {
  id: string;
  properties: Record<string, string>;
}

/** 规范化后的蓝图:每一格都是一条完整 block-state 串,索引已经展开 */
export interface NormalizedBlueprint {
  size_xyz: SizeXYZ;
  site_mode: BlueprintSiteMode;
  /** layers[y][z][x] */
  layers: string[][][];
}

const IDENTIFIER_PATTERN = /^([a-z0-9_.-]+):([a-z0-9/._-]+)$/;
const PROPERTY_NAME_PATTERN = /^[a-z0-9_]+$/;
const PROPERTY_VALUE_PATTERN = /^[a-z0-9_.-]+$/;
const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** 固定轴序;矩阵按 高度 → 南北 → 东西 三层数组读 */
export const AXIS_ORDER = 'YZX' as const;

/** 校验错误包含精确路径和中文说明。 */
export class BlueprintValidationError extends Error {
  constructor(
    message: string,
    readonly path: string,
    readonly reason = message,
  ) {
    super(`${path}: ${message}`);
    this.name = 'BlueprintValidationError';
  }
}

function fail(path: string, message: string): never {
  throw new BlueprintValidationError(message, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 稀疏数组的空洞按缺格处理。 */
function expectDenseArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, '这里应该是一个数组');
  for (let index = 0; index < value.length; index++) {
    if (!(index in value)) fail(`${path}[${index}]`, '数组这一位是空洞,缺一个元素');
  }
  return value;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, '这里应该是一个字符串');
  return value;
}

function validateSize(value: unknown, path = 'size_xyz'): SizeXYZ {
  const tuple = expectDenseArray(value, path);
  if (tuple.length !== 3) fail(path, `应该正好是 [X,Y,Z] 三个数,给了 ${tuple.length} 个`);
  const result = tuple.map((dimension, index) => {
    if (!Number.isSafeInteger(dimension) || (dimension as number) <= 0) {
      fail(`${path}[${index}]`, '应该是一个正整数');
    }
    return dimension as number;
  });
  return result as SizeXYZ;
}

/** 资源名是否合法;命名空间可省,省略时按 `minecraft`(`stone_button`、`minecraft:stone_button`) */
export function isResourceName(id: string): boolean {
  return IDENTIFIER_PATTERN.test(id.includes(':') ? id : `minecraft:${id}`);
}

/** 方块 id:必须带命名空间,全小写(`minecraft:oak_planks`) */
export function parseBlockId(value: unknown, path = 'block id'): string {
  const id = expectString(value, path);
  if (!IDENTIFIER_PATTERN.test(id)) {
    fail(path, `${JSON.stringify(id)} 不是带命名空间的小写方块 id(应形如 minecraft:oak_planks)`);
  }
  return id;
}

/** 解析完整方块状态串。 */
export function parseBlockState(value: unknown, path = 'block state'): ParsedBlockState {
  const state = expectString(value, path);
  const bracket = state.indexOf('[');
  const idText = bracket === -1 ? state : state.slice(0, bracket);
  const id = parseBlockId(idText, path);

  if (bracket === -1) return { id, properties: {} };
  if (!state.endsWith(']') || state.indexOf('[', bracket + 1) !== -1) {
    fail(path, '属性方括号没配对');
  }

  const propertyText = state.slice(bracket + 1, -1);
  if (propertyText.length === 0) fail(path, '属性方括号里是空的');

  const properties: Record<string, string> = {};
  for (const assignment of propertyText.split(',')) {
    const separator = assignment.indexOf('=');
    if (
      separator <= 0
      || separator === assignment.length - 1
      || assignment.indexOf('=', separator + 1) !== -1
    ) {
      fail(path, `属性写法不对:${JSON.stringify(assignment)}(应形如 facing=north)`);
    }
    const name = assignment.slice(0, separator);
    const propertyValue = assignment.slice(separator + 1);
    if (!PROPERTY_NAME_PATTERN.test(name)) {
      fail(path, `属性名不合法:${JSON.stringify(name)}`);
    }
    if (!PROPERTY_VALUE_PATTERN.test(propertyValue)) {
      fail(path, `属性 ${JSON.stringify(name)} 的值不合法`);
    }
    if (Object.hasOwn(properties, name)) {
      fail(path, `属性 ${JSON.stringify(name)} 写了两遍`);
    }
    properties[name] = propertyValue;
  }
  return { id, properties };
}

/** 按属性名排序序列化状态串。 */
export function formatBlockState(state: ParsedBlockState): string {
  const id = parseBlockId(state.id);
  const entries = Object.entries(state.properties)
    .sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return id;

  for (const [name, value] of entries) {
    if (!PROPERTY_NAME_PATTERN.test(name)) fail(`properties.${name}`, '属性名不合法');
    if (!PROPERTY_VALUE_PATTERN.test(value)) fail(`properties.${name}`, '属性值不合法');
  }
  return `${id}[${entries.map(([name, value]) => `${name}=${value}`).join(',')}]`;
}

/** 状态串规范化:解析一遍再排序打印,消掉属性顺序差异 */
export function canonicalizeBlockState(value: unknown, path?: string): string {
  return formatBlockState(parseBlockState(value, path));
}

/** palette 一条 → 规范化状态串;字符串与 `{Name, Properties}` 两种写法都收 */
export function paletteEntryToState(value: unknown, path = 'palette entry'): string {
  if (typeof value === 'string') return canonicalizeBlockState(value, path);
  if (!isRecord(value)) fail(path, '这里应该是状态串,或者 {Name, Properties} 对象');

  const id = parseBlockId(value.Name, `${path}.Name`);
  if (value.Properties === undefined) return id;
  if (!isRecord(value.Properties)) fail(`${path}.Properties`, '这里应该是一个对象');

  const properties: Record<string, string> = {};
  for (const [name, propertyValue] of Object.entries(value.Properties)) {
    if (!PROPERTY_NAME_PATTERN.test(name)) {
      fail(`${path}.Properties.${name}`, '属性名不合法');
    }
    if (typeof propertyValue !== 'string' || !PROPERTY_VALUE_PATTERN.test(propertyValue)) {
      fail(`${path}.Properties.${name}`, '属性值不合法');
    }
    properties[name] = propertyValue;
  }
  return formatBlockState({ id, properties });
}

/** 只带 id 的方块名(丢掉属性);type 比对与直方图都用它 */
export function blockIdOf(state: string): string {
  const bracket = state.indexOf('[');
  return bracket === -1 ? state : state.slice(0, bracket);
}

/**
 * 不产生放置步骤的状态。`air` 仍属于工地并要求为空；`structure_void` 表示这格
 * 不属于工地，施工与冲突核对都跳过。
 */
const AIR_IDS = new Set([
  'minecraft:air',
  'minecraft:cave_air',
  'minecraft:void_air',
  'minecraft:structure_void',
]);

export function isAirState(state: string): boolean {
  return AIR_IDS.has(blockIdOf(state));
}

/** structure_void 表示这格不属于工地：不放、不挖、也不参与冲突核对。 */
export function isStructureVoidState(state: string): boolean {
  return blockIdOf(state) === 'minecraft:structure_void';
}

/** 世界侧读回来的名字规范化:`stone` / `minecraft:stone` 都收,统一成带前缀 */
export function normalizeBlockName(name: string): string {
  const trimmed = name.trim();
  return trimmed.includes(':') ? trimmed : `minecraft:${trimmed}`;
}

function validateGrid(
  value: unknown,
  size: SizeXYZ,
  parseCell: (cell: unknown, path: string) => string,
): string[][][] {
  const [sizeX, sizeY, sizeZ] = size;
  const layers = expectDenseArray(value, 'layers');
  if (layers.length !== sizeY) {
    fail('layers', `声明高 ${sizeY} 层,矩阵给了 ${layers.length} 层`);
  }

  return layers.map((layer, y) => {
    const rows = expectDenseArray(layer, `layers[${y}]`);
    if (rows.length !== sizeZ) {
      fail(`layers[${y}]`, `第 ${y} 层应有 ${sizeZ} 行(Z),给了 ${rows.length} 行`);
    }
    return rows.map((row, z) => {
      const cells = expectDenseArray(row, `layers[${y}][${z}]`);
      if (cells.length !== sizeX) {
        fail(`layers[${y}][${z}]`, `这一行应有 ${sizeX} 格(X),给了 ${cells.length} 格`);
      }
      return cells.map((cell, x) => parseCell(cell, `layers[${y}][${z}][${x}]`));
    });
  });
}

export interface NormalizeOptions {
  /** 给了就核对声明尺寸;不给就以提交的尺寸为准 */
  expectedSize?: SizeXYZ;
}

/** 有 palette 时解析索引矩阵；无 palette 时解析逐格状态串。 */
export function normalizeBlueprint(
  value: unknown,
  options: NormalizeOptions = {},
): NormalizedBlueprint {
  if (!isRecord(value)) fail('submission', '提交应该是一个对象');

  const size = validateSize(value.size_xyz);
  const siteMode = value.site_mode === undefined
    ? fail('site_mode', '必须选:new(空地新建)或 retrofit(改造前探测)')
    : expectString(value.site_mode, 'site_mode');
  if (siteMode !== 'new' && siteMode !== 'retrofit') {
    fail('site_mode', '只认 new(空地新建)或 retrofit(改造前探测)');
  }
  const { expectedSize } = options;
  if (expectedSize !== undefined) {
    const expected = validateSize(expectedSize, 'expected_size');
    if (!expected.every((dimension, index) => dimension === size[index])) {
      fail('size_xyz', `这一份要求 [${expected.join(',')}],提交写的是 [${size.join(',')}]`);
    }
  }

  if (value.axis_order !== undefined) {
    const axis = expectString(value.axis_order, 'axis_order');
    if (axis !== AXIS_ORDER) {
      fail('axis_order', `轴序固定写 ${AXIS_ORDER},给的是 ${JSON.stringify(axis)}`);
    }
  }

  if (value.palette === undefined) {
    return {
      size_xyz: size,
      site_mode: siteMode,
      layers: validateGrid(value.layers, size, canonicalizeBlockState),
    };
  }

  const rawPalette = expectDenseArray(value.palette, 'palette');
  if (rawPalette.length === 0) fail('palette', '对照表至少要有一条');
  const palette = rawPalette.map((entry, index) =>
    paletteEntryToState(entry, `palette[${index}]`));

  const layers = validateGrid(value.layers, size, (cell, path) => {
    if (!Number.isSafeInteger(cell)) fail(path, '这一格应该是 palette 的整数索引');
    const index = cell as number;
    if (index < 0 || index >= palette.length) {
      fail(path, `palette 索引 ${index} 越界,对照表只有 0..${palette.length - 1}`);
    }
    return palette[index];
  });

  return { size_xyz: size, site_mode: siteMode, layers };
}

/** 不抛异常的解析口:错误按精确路径结构化返回,给需要拼回执的调用方 */
type BlueprintParseResult =
  | { ok: true; blueprint: NormalizedBlueprint }
  | { ok: false; path: string; reason: string };

export function tryNormalizeBlueprint(
  value: unknown,
  options: NormalizeOptions = {},
): BlueprintParseResult {
  try {
    return { ok: true, blueprint: normalizeBlueprint(value, options) };
  } catch (error) {
    if (error instanceof BlueprintValidationError) {
      return { ok: false, path: error.path, reason: error.reason };
    }
    throw error;
  }
}

/** 运行时使用的蓝图键和显示名。 */
export interface BlueprintLabel {
  key: string;
  name: string | null;
}

export function validateBlueprintLabel(value: unknown): BlueprintLabel {
  if (!isRecord(value)) fail('submission', '提交应该是一个对象');
  const key = expectString(value.key, 'key').trim();
  if (!KEY_PATTERN.test(key)) {
    fail('key', '键用小写字母数字加连字符,开头是字母或数字,最长 32 个字符');
  }
  const name = value.name === undefined || value.name === null
    ? null
    : expectString(value.name, 'name').trim() || null;
  return { key, name };
}

// ── 多部件方块 ────────────────────────────────────────────────────────────────

export type Cardinal = 'north' | 'south' | 'west' | 'east';

/** 四个水平朝向的单位向量(X 西→东,Z 北→南,与蓝图轴向一致) */
export const CARDINAL_VECTORS: Record<Cardinal, readonly [number, number, number]> = {
  north: [0, 0, -1],
  south: [0, 0, 1],
  west: [-1, 0, 0],
  east: [1, 0, 0],
};

function isCardinal(value: string): value is Cardinal {
  return value === 'north' || value === 'south' || value === 'west' || value === 'east';
}

/**
 * 按注册表属性识别多部件方块：half=upper/lower 或 part=head/foot。
 * 从部件不单独生成步骤，mainOffset 指向对应主部件。
 */
type MultiPartRole =
  | { role: 'single' }
  | { role: 'main'; secondaryOffset: readonly [number, number, number] }
  | { role: 'secondary'; mainOffset: readonly [number, number, number] };

export function multiPartRole(state: string): MultiPartRole {
  const parsed = parseBlockState(state);
  const half = parsed.properties.half;
  if (half === 'upper') return { role: 'secondary', mainOffset: [0, -1, 0] };
  if (half === 'lower') return { role: 'main', secondaryOffset: [0, 1, 0] };

  const part = parsed.properties.part;
  if (part === 'head' || part === 'foot') {
    const facing = parsed.properties.facing;
    if (facing === undefined || !isCardinal(facing)) return { role: 'single' };
    const [dx, dy, dz] = CARDINAL_VECTORS[facing];
    // 取负别落出 -0(它和 0 相等但深比较不认),0 原样返回
    const neg = (value: number): number => (value === 0 ? 0 : -value);
    // 床的 facing 从床脚指向床头
    return part === 'foot'
      ? { role: 'main', secondaryOffset: [dx, dy, dz] }
      : { role: 'secondary', mainOffset: [neg(dx), neg(dy), neg(dz)] };
  }
  return { role: 'single' };
}

// ── 体素指标与逐层图 ──────────────────────────────────────────────────────────

interface Bounds3D {
  min: PositionXYZ;
  max: PositionXYZ;
  size: SizeXYZ;
}

export interface VoxelMetrics {
  size_xyz: SizeXYZ;
  totalCells: number;
  airCells: number;
  nonAirCells: number;
  /** 非空气占比,0..1,两位小数 */
  fillRate: number;
  uniqueBlockStates: number;
  uniqueBlockIds: number;
  /** 状态 → 格数,按格数降序 */
  blockStateHistogram: Record<string, number>;
  /** 方块 id → 格数,按格数降序 */
  blockIdHistogram: Record<string, number>;
  /** 非空气格的包围盒;整份都是空气时是 null */
  nonAirBounds: Bounds3D | null;
}

function sortedHistogram(values: string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries(
    [...counts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])),
  );
}

/** 遍历所有格:回调拿到局部坐标与该格状态,顺序是 y→z→x */
export function forEachCell(
  blueprint: NormalizedBlueprint,
  visit: (x: number, y: number, z: number, state: string) => void,
): void {
  const [sizeX, sizeY, sizeZ] = blueprint.size_xyz;
  for (let y = 0; y < sizeY; y++) {
    for (let z = 0; z < sizeZ; z++) {
      for (let x = 0; x < sizeX; x++) visit(x, y, z, blueprint.layers[y][z][x]);
    }
  }
}

export function voxelMetrics(blueprint: NormalizedBlueprint): VoxelMetrics {
  const states: string[] = [];
  const ids: string[] = [];
  let nonAirCells = 0;
  const min: PositionXYZ = [Infinity, Infinity, Infinity];
  const max: PositionXYZ = [-Infinity, -Infinity, -Infinity];

  forEachCell(blueprint, (x, y, z, state) => {
    states.push(state);
    ids.push(blockIdOf(state));
    if (isAirState(state)) return;
    nonAirCells++;
    min[0] = Math.min(min[0], x); max[0] = Math.max(max[0], x);
    min[1] = Math.min(min[1], y); max[1] = Math.max(max[1], y);
    min[2] = Math.min(min[2], z); max[2] = Math.max(max[2], z);
  });

  const totalCells = states.length;
  return {
    size_xyz: [...blueprint.size_xyz],
    totalCells,
    airCells: totalCells - nonAirCells,
    nonAirCells,
    fillRate: totalCells === 0 ? 0 : Math.round((nonAirCells / totalCells) * 100) / 100,
    uniqueBlockStates: new Set(states).size,
    uniqueBlockIds: new Set(ids).size,
    blockStateHistogram: sortedHistogram(states),
    blockIdHistogram: sortedHistogram(ids),
    nonAirBounds: nonAirCells === 0 ? null : {
      min,
      max,
      size: [max[0] - min[0] + 1, max[1] - min[1] + 1, max[2] - min[2] + 1],
    },
  };
}

interface BlueprintLayerMap {
  /** 图例:字符 → 状态与格数;空气固定是 `.` 不进图例 */
  legend: Array<{ char: string; state: string; cells: number }>;
  /** 每层一张图,`rows[z]` 是从北到南第 z 行,行内从西到东 */
  layers: Array<{ y: number; nonAirCells: number; rows: string[] }>;
}

const LEGEND_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** 供 dryRun 与核验回执使用的逐层字符图；超过 62 种的状态显示为 ?，不进入图例。 */
export function renderLayerMap(blueprint: NormalizedBlueprint): BlueprintLayerMap {
  const counts = new Map<string, number>();
  forEachCell(blueprint, (_x, _y, _z, state) => {
    if (isAirState(state)) return;
    counts.set(state, (counts.get(state) ?? 0) + 1);
  });
  const ordered = [...counts]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));

  const charOf = new Map<string, string>();
  const legend: BlueprintLayerMap['legend'] = [];
  for (const [state, cells] of ordered) {
    if (legend.length >= LEGEND_CHARS.length) break;
    const char = LEGEND_CHARS[legend.length];
    charOf.set(state, char);
    legend.push({ char, state, cells });
  }

  const [, sizeY] = blueprint.size_xyz;
  const layers: BlueprintLayerMap['layers'] = [];
  for (let y = 0; y < sizeY; y++) {
    let nonAirCells = 0;
    const rows = blueprint.layers[y].map((row) => row.map((state) => {
      if (isAirState(state)) return '.';
      nonAirCells++;
      return charOf.get(state) ?? '?';
    }).join(''));
    layers.push({ y, nonAirCells, rows });
  }
  return { legend, layers };
}
