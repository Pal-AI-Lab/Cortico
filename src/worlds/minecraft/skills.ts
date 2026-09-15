/**
 * mc_do 的契约面:技能注册表。
 *
 * 每个技能在 `SKILLS` 里声明一次字段(名/类型/必填/范围/默认值/一行文档)与文档段落,
 * 出口全部由这一份生成:`SKILL_NAMES`、mc_do / mc_scout 的 schema 与技能表、
 * `parseSteps` / `parseScoutSteps`。mc_scout 是同一张表的只读切片:probe,以及
 * 声明了 dryRun 的技能(入队时一律按试算跑)。结构约束只有一个家,长出新技能时同步。
 *
 * 横向规则(build 的 shape-锚点数、use 的 at/target 互斥、craft 的 item/grid 二选一)
 * 不进表,走技能自己的 parse 钩子;钩子接管该步的全部校验与规范化。
 */
import {
  ANCHOR_COUNT, FACE_NAMES, SHAPE_NAMES,
  type Anchor, type BlockFace, type BoxFill, type ShapeName,
} from './geometry.ts';
import { DIRECTIONS, type Direction } from './terrain.ts';
import { normalizeDimension } from './escape.ts';

/** 步骤依赖与验收的可选覆写；省略时使用执行器推导的因果依赖和验收规则。 */
export interface StepBounds {
  /**
   * 依赖的更早步骤，序号从 1 起；省略时按产出与消费关系推导，空数组表示独立。
   * 显式依赖仅在上游 ok 或 partial 时放行；自动依赖另允许所需入料已在背包时放行。
   * 执行始终按列表顺序，不按依赖重排。
   */
  needs?: number[];
  /**
   * 验收标准的**覆写**。缺省时判据由执行器按 `(skill, 参数)` 推(`deriveExpect`),
   * 推不出来的才信技能自己的裁决。被叫停/抢占的步不评估。
   */
  expect?: Expectation;
}

/**
 * 验收支持背包数量、位置、方块与手持物四种状态。
 * 锚点按评估时刻脚下解析，与技能参数的相对坐标约定一致。
 */
export type Expectation =
  | { has: { item: string; count: number } }
  | { near: Anchor; within?: number }
  | { block: string; at: Anchor }
  | { holding: { item: string } };

/** near 形态缺省的判定半径(格) */
export const NEAR_DEFAULT = 2;

/**
 * 新任务与队列的关系。三态各对应她的一句话:
 * `replace`「后面排的不算数了,改做这个」、`append`「手上和排着的做完再做这个」、
 * `now`「别挖了,先插火把」。mc_do 与 mc_scout 是同一条队列,同一套三态。
 */
export type QueueMode = 'replace' | 'append' | 'now';

export const QUEUE_MODES: readonly QueueMode[] = ['replace', 'append', 'now'];

/** mc_do / mc_scout 顶层的 queue 字段 */
export const QUEUE_SCHEMA: Record<string, unknown> = {
  type: 'string',
  enum: [...QUEUE_MODES],
  description:
    '这一单跟队列的关系。不写 = replace:撤掉排着的那些,接在正在做的那件后面(回执点名撤了谁);' +
    'append:排到队尾,排着的都保留;now:中断正在做的那件、插到队头立刻开做,排着的保留' +
    '(正在逃命时不抢,排队头等它逃完)',
};

/** queue 字段的校验;不写 = replace */
export function parseQueueMode(raw: unknown): { mode: QueueMode } | { error: string } {
  if (raw === undefined || raw === null) return { mode: 'replace' };
  const s = str(raw);
  if (!s || !(QUEUE_MODES as readonly string[]).includes(s)) {
    return { error: `queue 只认 ${QUEUE_MODES.join('/')}(不写 = replace)` };
  }
  return { mode: s as QueueMode };
}

/** 贴面放置以参照格 at 与表面 face 定义落点，参数与 use_item_on 协议对应。 */
interface PlaceOnFace { at: Anchor; face: BlockFace }

export type AttackMode = 'auto' | 'melee' | 'ranged' | 'kite';

/** 一步技能:动作参数,外加边界声明(StepBounds)。 */
export type SkillCall = StepBounds & (
  | { skill: 'goto'; at: Anchor; dimension?: string; groundY?: true; dryRun?: boolean }
  | { skill: 'transit'; at: Anchor }
  | { skill: 'goto_player'; name: string }
  | { skill: 'follow'; name: string }
  | { skill: 'find'; target: string; distance: number; direction?: Direction; until?: string[] }
  | { skill: 'flee'; distance: number }
  | { skill: 'surface' }
  | { skill: 'collect'; block: string; count: number; buried?: boolean; mature?: boolean; tool?: string }
  | { skill: 'fish'; at?: Anchor }
  | { skill: 'build'; on: PlaceOnFace[]; material: string; dryRun?: boolean }
  | { skill: 'build'; anchors: Anchor[]; material: string; shape?: ShapeName; fill?: BoxFill; dryRun?: boolean }
  /**
   * 按已装载的蓝图施工(判别式的第三形态,判据是 `blueprint` 在不在)。
   * 形状与材料都在图里,所以这一形态一个 material 都不收;`at` 是蓝图 [0,0,0]
   * 落在世界的哪一格(首次要给,续建从施工绑定里取),`stopAfter` 是 y 层号。
   */
  | {
      skill: 'build';
      blueprint: string;
      at?: Anchor;
      stopAfter?: number;
      /** retrofit 现场有冲突时，明确同意清掉冲突格后施工。 */
      confirm?: boolean;
      /** 冲突格原样留着，先把能放的放上;回执点名跳过了哪几格。与 confirm 二选一。 */
      skipConflicts?: boolean;
      dryRun?: boolean;
    }
  | { skill: 'excavate'; shape: ShapeName; anchors: Anchor[]; fill?: BoxFill; dryRun?: boolean; tool?: string }
  | { skill: 'tunnel'; at: Anchor; spiral?: boolean; dryRun?: boolean; until?: string[]; tool?: string }
  | { skill: 'probe'; shape: ShapeName; anchors: Anchor[]; fill?: BoxFill; where?: string[] }
  | { skill: 'craft'; item?: string; count: number; grid?: string[][] }
  | { skill: 'smelt'; input: string; count: number; fuel: string; at?: Anchor }
  | { skill: 'brew'; at?: Anchor; input: string; bottle: string; count: number; fuel: string }
  | { skill: 'enchant'; at: Anchor; item: string; index?: number }
  | { skill: 'eat'; item: string }
  | { skill: 'attack'; target: string; mode?: AttackMode }
  | { skill: 'equip'; item?: string; pick?: string }
  | { skill: 'pickup'; item?: string }
  | { skill: 'toss'; item: string; count: number; at?: Anchor; pick?: string }
  | { skill: 'stow'; item: string; count: number; pick?: string }
  | { skill: 'take'; item?: string; count?: number; at?: Anchor; all?: true; pick?: string }
  | { skill: 'chat'; text: string }
  | {
      skill: 'use';
      item?: string;
      at?: Anchor;
      target?: string;
      index?: number;
      times?: number;
      /** 只对告示牌:右键打开编辑框之后把这几行字写上去(\n 分行,最多 4 行) */
      text?: string;
      /** 写在牌子背面(1.20 起两面各有一套字);缺省写正面 */
      back?: true;
      /** 右键落在哪一面;缺省顶面。贴墙的东西(展示框、画)靠它 */
      face?: BlockFace;
    }
  /** 骑上/驾驭/下坐骑。off 单独一态;target 上坐骑;to 驾着走(可与 target 同给) */
  | { skill: 'ride'; target?: string; to?: Anchor; off?: true }
  /**
   * 拴绳:拴住一只活物,牵着走到 to,到了松开(keep 就继续牵着)、或系到 tie 那根栅栏上。
   * off 单独一态 = 松开现在牵着的那只。
   */
  | {
      skill: 'lead';
      target?: string;
      to?: Anchor;
      tolerance?: number;
      tie?: Anchor;
      keep?: true;
      off?: true;
    }
  /** 铁砧:合修/改名。repair 与 combine 同义(两件同种或本体+附魔书放一起) */
  | {
      skill: 'anvil';
      op: 'repair' | 'combine' | 'rename';
      item: string;
      with?: string;
      name?: string;
      at?: Anchor;
      pick?: string;
      withPick?: string;
    }
  /** 砂轮:除魔/合修,附魔按原版比例返经验 */
  | { skill: 'grindstone'; item: string; with?: string; at?: Anchor; pick?: string; withPick?: string }
);

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** 返回 [lo,hi] 内的整数;缺省时用 fallback,越界时返回 null。 */
function intIn(v: unknown, lo: number, hi: number, fallback: number): number | null {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const n = Math.floor(v);
  return n >= lo && n <= hi ? n : null;
}

/**
 * 锚点结构校验:[x,y,z],分量是数字或非空字符串。相对值到执行时才解析。
 *
 * 光给一个字符串 = 路标名,当场查 mc_map 换成坐标。她已经维护着十几处路标并且
 * 自己在用航点分解走长途,写名字是那条习惯与工具面之间最后一块缺口。
 */
function anchorOf(v: unknown, marks?: MarkLookup): Anchor | null {
  if (typeof v === 'string') {
    const hit = v.trim() === '' ? null : marks?.(v.trim()) ?? null;
    return !Array.isArray(hit) ? null : [hit[0], hit[1], hit[2]];
  }
  if (!Array.isArray(v) || v.length !== 3) return null;
  for (const cc of v) {
    if (typeof cc === 'number' && Number.isFinite(cc)) continue;
    if (typeof cc === 'string' && cc.trim() !== '') continue;
    return null;
  }
  return [v[0], v[1], v[2]] as Anchor;
}

/**
 * `at` 写的是名字却没换出坐标时补的那句事实。分两种说法:路标表里查无此名,
 * 与这个部署根本没接路标表 —— 她要改的东西不一样。
 */
function markMissNote(v: unknown, marks?: MarkLookup): string {
  if (typeof v !== 'string' || v.trim() === '') return '';
  if (marks === undefined) return ';这一单没接路标表,at 只认坐标';
  const hit = marks(v.trim());
  return hit && !Array.isArray(hit)
    ? `;${hit.error}`
    : `;mc_map 里没有登记叫「${v.trim()}」的路标`;
}

function anchorsOf(v: unknown, n: number, marks?: MarkLookup): Anchor[] | null {
  if (!Array.isArray(v) || v.length !== n) return null;
  const out: Anchor[] = [];
  for (const a of v) {
    const anchor = anchorOf(a, marks);
    if (!anchor) return null;
    out.push(anchor);
  }
  return out;
}

/** 任意长度的锚点清单(1-max);形状不参与,给几个就是几个格子 */
function anchorListOf(v: unknown, max: number, marks?: MarkLookup): Anchor[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > max) return null;
  return anchorsOf(v, v.length, marks);
}

/**
 * 她自己摆的合成格:按行写的名字二维数组,空位写 null/""。
 * 只校验形状(最多 3×3)与元素类型 —— 这几个名字配不配得出东西由服务端说了算。
 */
function gridOf(raw: unknown): string[][] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 3) return null;
  const out: string[][] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length === 0 || row.length > 3) return null;
    const cells: string[] = [];
    for (const cell of row) {
      if (cell === null || cell === undefined || cell === '') { cells.push(''); continue; }
      if (typeof cell !== 'string') return null;
      cells.push(cell.trim());
    }
    out.push(cells);
  }
  return out.some((r) => r.some((n) => n !== '')) ? out : null;
}

/** 一个物品栏装得下的上限:36 格 × 64 */
const HAS_COUNT_MAX = 2304;

/** expect 的结构校验:四形态有且只有一个;at 是错误文案里的「第 N 步」 */
function expectOf(v: unknown, at: string): { expect: Expectation } | { error: string } {
  const usage = `${at}的 expect 要 {"has":{"item","count"}} / {"near":[x,y,z],"within"} / ` +
    `{"block","at":[x,y,z]} / {"holding":{"item"}} 四种之一`;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { error: usage };
  const e = v as Record<string, unknown>;
  const forms = ['has', 'near', 'block', 'holding'].filter((k) => e[k] !== undefined);
  if (forms.length !== 1) return { error: usage };
  switch (forms[0]) {
    case 'has': {
      const h = e.has;
      if (typeof h !== 'object' || h === null || Array.isArray(h)) return { error: usage };
      const item = str((h as Record<string, unknown>).item);
      if (!item) return { error: `${at}的 expect.has 要 item(物品英文 id)` };
      const count = intIn((h as Record<string, unknown>).count, 1, HAS_COUNT_MAX, 0);
      if (!count) return { error: `${at}的 expect.has 的 count 要在 1-${HAS_COUNT_MAX} 之间` };
      return { expect: { has: { item, count } } };
    }
    case 'holding': {
      const h = e.holding;
      if (typeof h !== 'object' || h === null || Array.isArray(h)) return { error: usage };
      const item = str((h as Record<string, unknown>).item);
      if (!item) return { error: `${at}的 expect.holding 要 item(物品英文 id)` };
      return { expect: { holding: { item } } };
    }
    case 'near': {
      const near = anchorOf(e.near);
      if (!near) return { error: `${at}的 expect.near 要 [x,y,z](数字或 "~"/"~-3" 相对写法)` };
      const within = intIn(e.within, 1, 128, NEAR_DEFAULT);
      if (within === null) return { error: `${at}的 expect.within 要在 1-128 格之间` };
      return { expect: within === NEAR_DEFAULT ? { near } : { near, within } };
    }
    default: {
      const block = str(e.block);
      if (!block) return { error: `${at}的 expect.block 要方块英文 id` };
      const spot = anchorOf(e.at);
      if (!spot) return { error: `${at}的 expect 形态 block 还要 at:[x,y,z](数字或 "~"/"~-3" 相对写法)` };
      return { expect: { block, at: spot } };
    }
  }
}

/** needs 的结构校验:整数数组,只准引用更早的步(1 ≤ n < 当前序号) */
function needsOf(v: unknown, index: number, at: string): { needs: number[] } | { error: string } {
  if (!Array.isArray(v)) {
    return { error: `${at}的 needs 要是更早步骤的序号数组(1 起),[] = 不依赖任何步` };
  }
  if (index === 0 && v.length > 0) {
    return { error: `${at}前面没有可引用的步,needs 只能是 []` };
  }
  const needs: number[] = [];
  for (const n of v) {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > index) {
      return { error: `${at}的 needs 只能引用更早的步(1 到 ${index}),给了 ${JSON.stringify(n)}` };
    }
    needs.push(n);
  }
  return { needs };
}

/**
 * 注册表字段:结构声明 + 进 schema 分支的一行文档。
 * kind 驱动表校验与默认 schema 片段;`schema` 覆盖默认生成(goto 的 at 收 2-3 分量这类特例)。
 * `opaque` 只进 schema,校验完全在技能的 parse 钩子里(anchors/grid/scaffold 这类复合结构)。
 */
type FieldSpec = {
  key: string;
  /** 进 schema 分支的 description;类型与枚举自明时不写 */
  doc?: string;
  schema?: Record<string, unknown>;
} & (
  | { kind: 'string'; required?: true; hint?: string }
  /** 一串英文 id(可带 `#类别`);空数组等于没写 */
  | { kind: 'names'; hint?: string }
  | { kind: 'int'; lo: number; hi: number; def: number; unit?: string }
  | { kind: 'anchor'; required?: true; error: string }
  | { kind: 'flag' }
  | { kind: 'enum'; values: readonly string[]; required?: true; error: string }
  | { kind: 'opaque'; required?: true; schema: Record<string, unknown> }
);

/**
 * 解析对这一步做过的改动:某个字段被丢掉,或按别的意思收下了。
 * 校验通不过时整批退回,说的是错误本身,没有这个。
 */
type StepNote =
  | { field: string; given: unknown; kind: 'dropped'; why: string }
  | { field: string; given: unknown; kind: 'rewritten'; as: string };

/** 解析提示附带从 1 起的步骤编号，由受理回执报告参数调整。 */
export type ParseNote = StepNote & { step: number };

/** 这些改动只有一份渲染,回执与日志都用它。 */
export function parseNoteText(n: ParseNote): string {
  const wrote = `第 ${n.step} 步写的 ${n.field}:${JSON.stringify(n.given)}`;
  return n.kind === 'dropped' ? `${wrote},${n.why},忽略了` : `${wrote},按${n.as}理解`;
}

type ParseResult = { step: SkillCall; notes?: StepNote[] } | { error: string };

interface SkillSpec {
  name: SkillCall['skill'];
  /** SKILL_DOC 里这一技能的段落:示例行 + 语义,完全手写 */
  doc: string;
  fields: FieldSpec[];
  /** 横向规则钩子:接管整步校验与规范化;没给钩子的技能走表驱动 */
  parse?: (c: Record<string, unknown>, at: string, marks?: MarkLookup) => ParseResult;
}

/**
 * 路标名 → 坐标。 World 持有 mc_map 那张表,解析器只收这一个只读查询;
 * 不接(台架、纯结构测试)时 `at` 只认坐标数组。
 */
export type MarkLookup = (name: string) => [number, number, number] | { error: string } | null;

const RELATIVE_HINT = '数字或 "~"/"~-3" 相对写法';

/** 一步 use 里连着右键的次数上限 */
const USE_TIMES_MAX = 16;

/**
 * lead 的 tolerance:「牵到了」判到 to 多少格内算数。默认 3 —— 牵绳本来就是软的,
 * 原版把活物拉到落脚点上是做不到的事,给一个圈才说得出「到了没有」。
 */
const LEAD_TOL = { lo: 1, hi: 16, def: 3 } as const;

function parseGoto(c: Record<string, unknown>, at: string, marks?: MarkLookup): ParseResult {
  // [x,z] 两分量 = 按地表落脚;y 在执行那一刻按 (x,z) 的最高实心块解
  const flat = Array.isArray(c.at) && c.at.length === 2;
  const to = anchorOf(flat ? [(c.at as unknown[])[0], 0, (c.at as unknown[])[1]] : c.at, marks);
  if (!to) {
    return {
      error: `${at} goto 要 at:[x,y,z] / [x,z](${RELATIVE_HINT}),或一个 mc_map 路标名`
        + markMissNote(c.at, marks),
    };
  }
  return {
    step: {
      skill: 'goto', at: to,
      ...(str(c.dimension) ? { dimension: normalizeDimension(str(c.dimension)) } : {}),
      ...(flat ? { groundY: true as const } : {}),
      ...(c.dryRun === true ? { dryRun: true } : {}),
    },
  };
}

/** 一步 build 里最多放几处(格子清单形态与贴面形态共用) */
const PLACE_SPOTS_MAX = 16;

/** 一处贴面放置的结构校验:{"at":[x,y,z],"face":"up"} */
function placeOnFaceOf(v: unknown): PlaceOnFace | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const spot = anchorOf(o.at);
  const face = str(o.face);
  if (!spot || !face || !(FACE_NAMES as string[]).includes(face)) return null;
  return { at: spot, face: face as BlockFace };
}

/**
 * build 的贴面形态。判别式的第二形态,判据是 `on` 在不在——**不重载 `anchors`**:
 * 同一个字段在有没有 face 时含义不同就是二义性字段。
 */
function parseBuildOnFaces(c: Record<string, unknown>, at: string): ParseResult {
  if (c.anchors !== undefined && c.anchors !== null) {
    return { error: `${at} build 的 on(贴着某一面放)与 anchors(直接点格子)只能给一个` };
  }
  const material = str(c.material);
  if (!material) return { error: `${at} build 要 material(方块英文 id)` };
  if (!Array.isArray(c.on) || c.on.length === 0 || c.on.length > PLACE_SPOTS_MAX) {
    return { error: `${at} build 的 on 要 1-${PLACE_SPOTS_MAX} 处,每处 {"at":[x,y,z],"face":"up"}` };
  }
  const on: PlaceOnFace[] = [];
  for (const [i, raw] of c.on.entries()) {
    const spot = placeOnFaceOf(raw);
    if (!spot) {
      return {
        error: `${at} on 的第 ${i + 1} 处要 {"at":[x,y,z],"face":…}` +
          `(at 是参照方块那一格,${RELATIVE_HINT};face 只认 ${FACE_NAMES.join('/')})`,
      };
    }
    on.push(spot);
  }
  const notes: StepNote[] = [];
  for (const key of ['shape', 'fill'] as const) {
    const given = c[key];
    if (given !== undefined && given !== null) {
      notes.push({ field: key, given, kind: 'dropped', why: '贴面放置是一处一处的,没有形状' });
    }
  }
  const step: SkillCall = { skill: 'build', material, on, ...(c.dryRun === true ? { dryRun: true } : {}) };
  return notes.length > 0 ? { step, notes } : { step };
}

/**
 * build 的蓝图形态。判据是 `blueprint` 在不在 —— 形状、材料、每一格放什么都在
 * 图里,所以这一形态把 material/shape/fill/on/anchors 一概当误写丢掉并点名
 * (静默吃掉参数是这条链上最贵的一类失败)。
 */
function parseBuildBlueprint(c: Record<string, unknown>, at: string): ParseResult {
  const key = str(c.blueprint);
  if (!key) return { error: `${at} build 的 blueprint 要一个蓝图键(字符串)` };
  const notes: StepNote[] = [];
  for (const field of ['material', 'shape', 'fill', 'on', 'anchors'] as const) {
    const given = c[field];
    if (given !== undefined && given !== null) {
      notes.push({ field, given, kind: 'dropped', why: '按蓝图施工时形状与材料都在图里' });
    }
  }
  let anchor: Anchor | undefined;
  if (c.at !== undefined && c.at !== null) {
    const a = anchorOf(c.at);
    if (!a) {
      return {
        error: `${at} build 的 at 要 [x,y,z](蓝图 [0,0,0] 落在世界的哪一格;${RELATIVE_HINT})`,
      };
    }
    anchor = a;
  }
  let stopAfter: number | undefined;
  if (c.stopAfter !== undefined && c.stopAfter !== null) {
    if (typeof c.stopAfter !== 'number' || !Number.isSafeInteger(c.stopAfter) || c.stopAfter < 0) {
      return { error: `${at} build 的 stopAfter 要一个非负整数 y 层号(0 是最低层)` };
    }
    stopAfter = c.stopAfter;
  }
  const step: SkillCall = {
    skill: 'build', blueprint: key,
    ...(anchor ? { at: anchor } : {}),
    ...(stopAfter !== undefined ? { stopAfter } : {}),
    ...(c.confirm === true ? { confirm: true } : {}),
    ...(c.skipConflicts === true ? { skipConflicts: true } : {}),
    ...(c.dryRun === true ? { dryRun: true } : {}),
  };
  return notes.length > 0 ? { step, notes } : { step };
}

/**
 * find 站着扫的最远距离(格)。等于感知半径:再远的方块进不了 findBlocks 的区块索引,
 * 也谈不上"看得见"。要更远只能走过去 —— 那就得给 direction。
 */
export const FIND_STATIC_MAX = 48;

/** `until` 一次最多点几样(名单与类别合计) */
const UNTIL_NAMES_MAX = 12;

/** `probe` 的 `where` 每样最多列几处坐标(按远近);总数照实报 */
export const PROBE_WHERE_SHOWN = 6;

/**
 * `until` 支持的类别写法(`"#ores"` 这种)。
 *
 * 本该用 minecraft-data 的方块 tag 展开,但本仓库钉住的 registry(prismarine-registry
 * 1.12 / minecraft-data 3.112)**没有 tag 数据面** —— 逐版本核过,`blockTags` 不存在。
 * 于是退化成这几个内置类别;它们写成**名字谓词**而不是写死的 id 名单,换版本不会
 * 漏掉新方块。执行器先探一次 registry 的 tag 面(将来有了就走那条),取不到才落到这里。
 */
export const UNTIL_CATEGORIES: Readonly<Record<string, (name: string) => boolean>> = {
  ores: (n) => n.endsWith('_ore') || n === 'ancient_debris',
  logs: (n) => n.endsWith('_log') || n.endsWith('_stem'),
  leaves: (n) => n.endsWith('_leaves'),
  chests: (n) => n === 'chest' || n === 'trapped_chest' || n === 'barrel',
  liquids: (n) => n === 'water' || n === 'lava',
  beds: (n) => n.endsWith('_bed'),
};

/** 文档与错误文案里那一串类别名(带 `#`) */
export const UNTIL_CATEGORY_DOC = Object.keys(UNTIL_CATEGORIES).map((k) => `#${k}`).join('/');

function parseShaped(skill: 'build' | 'excavate' | 'probe') {
  return (c: Record<string, unknown>, at: string, marks?: MarkLookup): ParseResult => {
    // 判别式三形态,判据各是一个独占字段:blueprint(按图盖)→ on(贴面)→ anchors(点格子)
    if (skill === 'build' && c.blueprint !== undefined && c.blueprint !== null) {
      return parseBuildBlueprint(c, at);
    }
    if (skill === 'build' && c.on !== undefined && c.on !== null) return parseBuildOnFaces(c, at);
    // build 不写 shape = 就这些格,一步放 N 处、各报各的;写了 shape 才按形状连片铺
    const listed = skill === 'build' && (c.shape === undefined || c.shape === null);
    const shape = listed ? null : str(c.shape);
    if (!listed && (!shape || !(SHAPE_NAMES as string[]).includes(shape))) {
      return { error: `${at} ${skill} 的 shape 要是 ${SHAPE_NAMES.join('/')} 之一` };
    }
    const anchors = listed
      ? anchorListOf(c.anchors, PLACE_SPOTS_MAX, marks)
      : anchorsOf(c.anchors, ANCHOR_COUNT[shape as ShapeName], marks);
    if (!anchors) {
      return {
        error: listed
          ? `${at} build 不写 shape 时 anchors 是 1-${PLACE_SPOTS_MAX} 个格子,` +
            `每个是 [x,y,z](${RELATIVE_HINT})`
          : `${at} ${shape} 要 ${ANCHOR_COUNT[shape as ShapeName]} 个锚点,` +
            `每个是 [x,y,z](${RELATIVE_HINT})`,
      };
    }
    let fill: BoxFill | undefined;
    if (c.fill !== undefined) {
      const f = str(c.fill);
      if (f !== 'solid' && f !== 'outline' && f !== 'edges') {
        // `hollow` 是原版 /fill 的模式名,含义是"外壳 + 内部清成空气",与这里的
        // outline(只动外壳)差一整个内部。收下它当别名等于把假朋友留着,所以退回
        // 并当场说清两者的分别 —— 这也是改名唯一的通知口。
        return {
          error: f === 'hollow'
            ? `${at} 只动外壳写 fill:"outline";原版 /fill 的 hollow 还会把内部清成空气,这里没有那个模式`
            : `${at} fill 只认 solid/outline/edges`,
        };
      }
      fill = f;
    }
    const dryRun = c.dryRun === true;
    if (skill === 'build') {
      const material = str(c.material);
      if (!material) return { error: `${at} build 要 material(方块英文 id)` };
      return {
        step: {
          skill, anchors, material,
          ...(shape ? { shape: shape as ShapeName } : {}),
          ...(fill ? { fill } : {}), ...(dryRun ? { dryRun } : {}),
        },
      };
    }
    if (skill === 'excavate') {
      const tool = str(c.tool);
      if (c.tool !== undefined && c.tool !== null && !tool) {
        return { error: `${at} excavate 的 tool 要物品英文 id 或 "fastest"` };
      }
      return {
        step: {
          skill, shape: shape as ShapeName, anchors,
          ...(fill ? { fill } : {}), ...(dryRun ? { dryRun } : {}), ...(tool ? { tool } : {}),
        },
      };
    }
    const where = nameListOf(c.where, at, 'probe 的 where');
    if (where !== null && 'error' in where) return { error: where.error };
    return {
      step: {
        skill, shape: shape as ShapeName, anchors,
        ...(fill ? { fill } : {}), ...(where ? { where: where.names } : {}),
      },
    };
  };
}

/** 一串英文 id:没写(或写了个空数组)给 null,写错给 error */
function nameListOf(
  v: unknown, at: string, what: string,
): { names: string[] } | { error: string } | null {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) {
    return { error: `${at} ${what} 要是一串英文 id(数组)` };
  }
  if (v.length > UNTIL_NAMES_MAX) return { error: `${at} ${what} 最多 ${UNTIL_NAMES_MAX} 项` };
  const names = (v as string[]).map((s) => s.trim()).filter(Boolean);
  return names.length > 0 ? { names } : null;
}

function parseUse(c: Record<string, unknown>, at: string, marks?: MarkLookup): ParseResult {
  const item = str(c.item);
  const useAt = c.at === undefined ? null : anchorOf(c.at, marks);
  if (c.at !== undefined && !useAt) {
    return { error: `${at} use 的 at 要 [x,y,z](${RELATIVE_HINT})${markMissNote(c.at, marks)}` };
  }
  const target = str(c.target);
  if (useAt && target) {
    return { error: `${at} use 的 at 与 target 只能给一个` };
  }
  // 空手又不说对哪儿使,右键不出任何东西
  if (!item && !useAt && !target) {
    return { error: `${at} use 至少要给 item,或 at/target` };
  }

  const times = intIn(c.times, 1, USE_TIMES_MAX, 1);
  if (times === null) return { error: `${at} use 的 times 要在 1-${USE_TIMES_MAX} 之间` };
  let index: number | undefined;
  if (c.index !== undefined) {
    if (!target) return { error: `${at} use 的 index 是报价菜单序号,要和 target 一起给` };
    const i = intIn(c.index, 1, 99, 1);
    if (i === null) return { error: `${at} use 的 index 要是报价菜单里的序号(1 起)` };
    index = i;
  }
  // 牌子上的字:原版一块牌子四行、每行 45 个字符。超了当场说清楚超在哪一行,
  // 不交给下游 —— mineflayer 的 updateSign 越界时只 emit 一个 error 就静默返回。
  let text: string | undefined;
  let textNote: StepNote | undefined;
  if (c.text !== undefined && c.text !== null) {
    if (typeof c.text !== 'string') return { error: `${at} use 的 text 要是字符串(告示牌上的字,\\n 分行)` };
    if (!useAt) return { error: `${at} use 的 text 是写在某一块告示牌上的,要和 at 一起给` };
    // 仅含字面 \n 且没有真实换行时，尝试将其规范化为换行。
    // 规范化后不超过四行才采用，并以该文本继续校验。
    let given = c.text;
    if (!given.includes('\n') && given.includes('\\n')) {
      const unescaped = given.split('\\n').join('\n');
      if (unescaped.split('\n').length <= SIGN_LINES) {
        given = unescaped;
        textNote = { field: 'text', given: c.text, kind: 'rewritten', as: `字面「\\n」按分行符收下,归一成 ${given.split('\n').length} 行` };
      }
    }
    const lines = given.split('\n');
    if (lines.length > SIGN_LINES) {
      return { error: `${at} 告示牌一共 ${SIGN_LINES} 行,给了 ${lines.length} 行` };
    }
    const over = lines.findIndex((line) => line.length > SIGN_LINE_CHARS);
    if (over >= 0) {
      return { error: `${at} 告示牌每行最多 ${SIGN_LINE_CHARS} 个字符,第 ${over + 1} 行有 ${lines[over].length} 个` };
    }
    text = given;
  }
  if (c.back !== undefined && c.back !== null && text === undefined) {
    return { error: `${at} use 的 back 是"写在牌子背面",要和 text 一起给` };
  }
  const back = c.back === true;
  let face: BlockFace | undefined;
  if (c.face !== undefined && c.face !== null) {
    const f = str(c.face);
    if (!f || !(FACE_NAMES as string[]).includes(f)) {
      return { error: `${at} use 的 face 要是 ${FACE_NAMES.join('/')} 之一` };
    }
    if (!useAt) return { error: `${at} use 的 face 是"右键那一格的哪一面",要和 at 一起给` };
    face = f as BlockFace;
  }
  return {
    step: {
      skill: 'use',
      ...(item ? { item } : {}),
      ...(useAt ? { at: useAt } : {}),
      ...(target ? { target } : {}),
      ...(index !== undefined ? { index } : {}),
      ...(times > 1 ? { times } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(back ? { back: true as const } : {}),
      ...(face ? { face } : {}),
    },
    ...(textNote ? { notes: [textNote] } : {}),
  };
}

/** 原版一块告示牌的行数与每行字符数上限(1.20.6 同 1.14 起未变)。 */
const SIGN_LINES = 4;
const SIGN_LINE_CHARS = 45;

/** 空着的那只手在游戏里就是 `air`:她照着游戏这么写,收下并回念成「空手」。 */
const EMPTY_HAND_NAMES = ['air', 'minecraft:air'];

function parseEquip(c: Record<string, unknown>, at: string): ParseResult {
  const item = str(c.item);
  const pick = str(c.pick);
  if (!item) {
    if (pick) return { error: `${at} equip 的 pick 是从同 id 的几件里挑一件,要和 item 一起给` };
    return { step: { skill: 'equip' } };
  }
  if (EMPTY_HAND_NAMES.includes(item)) {
    return {
      step: { skill: 'equip' },
      notes: [{ field: 'item', given: c.item, kind: 'rewritten', as: '空手' }],
    };
  }
  return { step: { skill: 'equip', item, ...(pick ? { pick } : {}) } };
}

/** 原版铁砧改名框的字符上限(ServerboundRenameItem 超长直接丢) */
const ANVIL_NAME_MAX = 50;

/**
 * 挑选词:同 id 的几件里点名哪一件。六个技能共用一句说法,匹配规则见 item-pick.ts。
 */
const PICK_DOC = '同 id 的几件里挑哪一件:写清单括号里的字(「无限」「效率IV」,英文附魔 id 也认);'
  + '不写 = 撞上哪件算哪件。按内容匹配,不是序号,存掉一件不影响其余几件怎么写';

/** 骑乘:off / target / to 三个入参的横向规则都在这儿说清,不静默吃字段。 */
function parseRide(c: Record<string, unknown>, at: string, marks?: MarkLookup): ParseResult {
  const off = c.off === true;
  const target = str(c.target);
  const to = c.to === undefined || c.to === null ? null : anchorOf(c.to, marks);
  if (c.to !== undefined && c.to !== null && !to) {
    return { error: `${at} ride 的 to 要 [x,y,z](${RELATIVE_HINT})${markMissNote(c.to, marks)}` };
  }
  if (c.off !== undefined && c.off !== true) {
    return { error: `${at} ride 的 off 只认 true(下坐骑写 {"skill":"ride","off":true})` };
  }
  if (off && (target || to)) {
    return { error: `${at} ride 的 off 是下来,不能和 target/to 一起给` };
  }
  if (!off && !target && !to) {
    return { error: `${at} ride 要 target(骑上哪种)或 to(骑着现在的坐骑去哪),下来写 off:true` };
  }
  return {
    step: {
      skill: 'ride',
      ...(target ? { target } : {}),
      ...(to ? { to } : {}),
      ...(off ? { off: true as const } : {}),
    },
  };
}

/**
 * 拴绳:三种形态各自成立(只拴上／牵着走／松开),照 ride 的写法当场点名缺什么。
 * `tie` 是「牵到了就系在这根栅栏上」,单独给它而不给 to 也成立(人已经牵着的时候)。
 */
function parseLead(c: Record<string, unknown>, at: string, marks?: MarkLookup): ParseResult {
  const target = str(c.target);
  const to = c.to === undefined || c.to === null ? null : anchorOf(c.to, marks);
  const tie = c.tie === undefined || c.tie === null ? null : anchorOf(c.tie, marks);
  const off = c.off === true;
  if (c.to !== undefined && c.to !== null && !to) {
    return { error: `${at} lead 的 to 要 [x,y,z](${RELATIVE_HINT})${markMissNote(c.to, marks)}` };
  }
  if (c.tie !== undefined && c.tie !== null && !tie) {
    return { error: `${at} lead 的 tie 要 [x,y,z](栅栏那一格;${RELATIVE_HINT})${markMissNote(c.tie, marks)}` };
  }
  if (c.off !== undefined && c.off !== true) {
    return { error: `${at} lead 的 off 只认 true(松开写 {"skill":"lead","off":true})` };
  }
  if (c.keep !== undefined && c.keep !== true) {
    return { error: `${at} lead 的 keep 只认 true` };
  }
  if (off && (target || to || tie || c.keep === true)) {
    return { error: `${at} lead 的 off 是松开,不能和 target/to/tie/keep 一起给` };
  }
  if (!off && !target && !to && !tie) {
    return { error: `${at} lead 要 target(拴哪只)或 to(把现在牵着的牵去哪),松开写 off:true` };
  }
  const tol = intIn(c.tolerance, LEAD_TOL.lo, LEAD_TOL.hi, LEAD_TOL.def);
  if (tol === null) {
    return { error: `${at} lead 的 tolerance 要在 ${LEAD_TOL.lo}-${LEAD_TOL.hi} 格之间` };
  }
  return {
    step: {
      skill: 'lead',
      ...(target ? { target } : {}),
      ...(to ? { to, tolerance: tol } : {}),
      ...(tie ? { tie } : {}),
      ...(c.keep === true ? { keep: true as const } : {}),
      ...(off ? { off: true as const } : {}),
    },
  };
}

/** 铁砧:op 决定哪些字段成立;缺什么当场点名,不留到执行期。 */
function parseAnvil(c: Record<string, unknown>, at: string, marks?: MarkLookup): ParseResult {
  const op = str(c.op);
  if (!op || !['repair', 'combine', 'rename'].includes(op)) {
    return { error: `${at} anvil 的 op 只认 repair/combine/rename` };
  }
  const item = str(c.item);
  if (!item) return { error: `${at} anvil 要 item(左格那件东西的物品英文 id)` };
  const withItem = str(c.with);
  const name = str(c.name);
  if ((op === 'repair' || op === 'combine') && !withItem) {
    return { error: `${at} anvil 的 op:"${op}" 要 with(右格放什么:同种的另一件、附魔书或修补材料)` };
  }
  if (op === 'rename') {
    if (!name) return { error: `${at} anvil 的 op:"rename" 要 name(新名字)` };
    if (name.length > ANVIL_NAME_MAX) {
      return { error: `${at} anvil 的 name 最多 ${ANVIL_NAME_MAX} 个字符,给了 ${name.length} 个` };
    }
  }
  if (op !== 'rename' && name !== null) {
    return { error: `${at} anvil 的 name 只跟 op:"rename" 一起用;合修顺便改名分两步做` };
  }
  const anvilAt = c.at === undefined || c.at === null ? null : anchorOf(c.at, marks);
  if (c.at !== undefined && c.at !== null && !anvilAt) {
    return { error: `${at} anvil 的 at 要 [x,y,z](${RELATIVE_HINT})${markMissNote(c.at, marks)}` };
  }
  const pick = str(c.pick);
  const withPick = str(c.withPick);
  if (withPick && !withItem) {
    return { error: `${at} anvil 的 withPick 是给 with 挑哪一件,要和 with 一起给` };
  }
  return {
    step: {
      skill: 'anvil', op: op as 'repair' | 'combine' | 'rename', item,
      ...(withItem ? { with: withItem } : {}),
      ...(name ? { name } : {}),
      ...(anvilAt ? { at: anvilAt } : {}),
      ...(pick ? { pick } : {}),
      ...(withPick ? { withPick } : {}),
    },
  };
}

function parseGrindstone(c: Record<string, unknown>, at: string, marks?: MarkLookup): ParseResult {
  const item = str(c.item);
  if (!item) return { error: `${at} grindstone 要 item(要磨的那件东西的物品英文 id)` };
  const withItem = str(c.with);
  const gsAt = c.at === undefined || c.at === null ? null : anchorOf(c.at, marks);
  if (c.at !== undefined && c.at !== null && !gsAt) {
    return { error: `${at} grindstone 的 at 要 [x,y,z](${RELATIVE_HINT})${markMissNote(c.at, marks)}` };
  }
  const pick = str(c.pick);
  const withPick = str(c.withPick);
  if (withPick && !withItem) {
    return { error: `${at} grindstone 的 withPick 是给 with 挑哪一件,要和 with 一起给` };
  }
  return {
    step: {
      skill: 'grindstone', item,
      ...(withItem ? { with: withItem } : {}),
      ...(gsAt ? { at: gsAt } : {}),
      ...(pick ? { pick } : {}),
      ...(withPick ? { withPick } : {}),
    },
  };
}

/** `take` 的两种操作必须显式区分：定量取物，或清空指定容器。 */
function parseTake(c: Record<string, unknown>, at: string, marks?: MarkLookup): ParseResult {
  const item = str(c.item);
  const takeAt = c.at === undefined || c.at === null ? null : anchorOf(c.at, marks);
  if (c.at !== undefined && c.at !== null && !takeAt) {
    return { error: `${at} take 的 at 要 [x,y,z](${RELATIVE_HINT})${markMissNote(c.at, marks)}` };
  }
  const all = c.all === true;
  if (c.all !== undefined && c.all !== true) {
    return { error: `${at} take 的 all 只认 true;清空指定容器写 all:true` };
  }
  if (all) {
    if (!takeAt) return { error: `${at} take 的 all:true 必须同时给 at:[x,y,z]` };
    if (item || c.count !== undefined || c.pick !== undefined) {
      return { error: `${at} take 的 all:true 是清空指定容器,不能再给 item、count 或 pick` };
    }
    return { step: { skill: 'take', at: takeAt, all: true } };
  }
  if (!item) {
    return { error: takeAt
      ? `${at} take 点名容器后还要说明操作:定量取物写 item+count;清空写 all:true`
      : `${at} take 要 item+count(定量取物),或 at+all:true(清空指定容器)` };
  }
  if (c.count === undefined || c.count === null) {
    return { error: `${at} take 定量取物必须写 count(1-64),不再默认成 1` };
  }
  const count = intIn(c.count, 1, 64, 1);
  if (count === null) return { error: `${at} take 的 count 要在 1-64 之间` };
  const pick = str(c.pick);
  return {
    step: {
      skill: 'take',
      item,
      count,
      ...(takeAt ? { at: takeAt } : {}),
      ...(pick ? { pick } : {}),
    },
  };
}

/**
 * enchant 的 `index` 有三态:不写 = 只看报价;1/2/3 = 按那一档下手。
 * 表驱动的 int 字段必带默认值,而这里「没写」本身是一种语义,只能走钩子。
 */
function parseEnchant(c: Record<string, unknown>, at: string, marks?: MarkLookup): ParseResult {
  const table = anchorOf(c.at, marks);
  if (!table) {
    return { error: `${at} enchant 要 at:[x,y,z](${RELATIVE_HINT}),指着附魔台那一格${markMissNote(c.at, marks)}` };
  }
  const item = str(c.item);
  if (!item) return { error: `${at} enchant 要 item(要给哪样东西附魔,英文 id)` };
  if (c.index === undefined || c.index === null) return { step: { skill: 'enchant', at: table, item } };
  const index = intIn(c.index, 1, 3, 1);
  if (index === null) return { error: `${at} enchant 的 index 要 1/2/3(上中下三格),不写就是只看报价` };
  return { step: { skill: 'enchant', at: table, item, index } };
}

function parseCraft(c: Record<string, unknown>, at: string): ParseResult {
  const count = intIn(c.count, 1, 64, 1);
  if (count === null) return { error: `${at} craft 的 count 要在 1-64 之间` };
  if (c.grid !== undefined) {
    const grid = gridOf(c.grid);
    if (!grid) {
      return {
        error: `${at} craft 的 grid 要是按行写的名字二维数组(空位写 null),最多 3 行 3 列`,
      };
    }
    // 格子摆好了就按格子做,产出槽出什么算什么;同时写的 item 没有用武之地
    const spare = str(c.item);
    return {
      step: { skill: 'craft', grid, count },
      ...(spare
        ? { notes: [{ field: 'item', given: c.item, kind: 'dropped' as const, why: 'grid 在场,按格子做' }] }
        : {}),
    };
  }
  const item = str(c.item);
  if (!item) return { error: `${at} craft 要 item(物品英文 id)或 grid(自己摆的格子)` };
  return { step: { skill: 'craft', item, count } };
}

/** 锚点的 schema 片段([x,y,z],分量数字或 "~" 相对写法;整个给一个字符串 = mc_map 路标名) */
const ANCHOR_SCHEMA = {
  type: ['array', 'string'], items: { type: ['number', 'string'] }, minItems: 3, maxItems: 3,
} as const;

/** 注册表本体。顺序即 SKILL_NAMES 与 SKILL_DOC 的出场顺序 */
const SKILLS: readonly SkillSpec[] = [
  {
    name: 'goto',
    doc: `{"skill":"goto","at":[100,-20],"dimension":"overworld"} 去坐标。dimension 是当前维度前置条件,不符就不动。
                                                 **只写 [x,z] = 按那儿的地表落脚**(区块没加载会照实受阻)。
                                                 at 也收 mc_map 的路标名:{"skill":"goto","at":"家"}。
                                                 赶路会自己挖方块/搭方块开路`,
    parse: parseGoto,
    fields: [
      {
        key: 'at', kind: 'anchor', required: true,
        error: `goto 要 at:[x,y,z] / [x,z](${RELATIVE_HINT}),或一个 mc_map 路标名`,
        schema: { type: ['array', 'string'], items: { type: ['number', 'string'] }, minItems: 2, maxItems: 3 },
        doc: '只写 [x,z] = 按那儿的地表落脚;给字符串 = mc_map 路标名',
      },
      { key: 'dimension', kind: 'string', doc: '可选的当前维度前置条件(overworld/the_nether/the_end)' },
      { key: 'dryRun', kind: 'flag' },
    ],
  },
  {
    name: 'transit',
    doc: `{"skill":"transit","at":[-228,73,58]}          穿过这一格的下界传送门。只认当前维度里已加载的 nether_portal;
                                                 会先走到门边,再明确踏进门里,等维度和落点都切换后才算完成`,
    fields: [
      {
        key: 'at', kind: 'anchor', required: true,
        error: `transit 要 at:[x,y,z](下界传送门方块;${RELATIVE_HINT}),或一个当前维度的 mc_map 路标名`,
        doc: '当前维度里的一格 nether_portal;给字符串 = 当前维度的 mc_map 路标名',
      },
    ],
  },
  {
    name: 'goto_player',
    doc: '{"skill":"goto_player","name":"Alice"}           去某玩家身边',
    fields: [{ key: 'name', kind: 'string', required: true, hint: '在线玩家名' }],
  },
  {
    name: 'follow',
    doc: '{"skill":"follow","name":"Alice"}                持续跟随,直到被新任务顶替',
    fields: [{ key: 'name', kind: 'string', required: true, hint: '在线玩家名' }],
  },
  {
    name: 'find',
    doc: `{"skill":"find","target":"chest","distance":32}  找东西,方块和活物都认,只报看得见的(隔玻璃算看得见)。
                                                 不给 direction = 站着扫一圈,最远 ${FIND_STATIC_MAX} 格,不挪地方。
                                                 回执里的 blockAt 是目标方块占用格,不是可站落点;seenAt 是活物被看见那一刻的位置。
                                                 当前没看见只说明当前观察面没命中,不表示目标不存在。旧位置只在真实看见过时出现,并带年龄。
                                                 给了 direction = 朝那个方向边走边找,看见就停下报坐标;走满没看见也算做完。
                                                 若出发点全向扫描先命中,回执会明确请求方向尚未搜索,不能把命中叫作该方向的结果
{"skill":"find","target":"cow","distance":64,"direction":"east","until":["#ores","water"]}
                                                 边走边找时加 "until" = 路上看见这里头任何一样就停下来报坐标(算做完)。
                                                 名单写方块英文 id,也认类别 ${UNTIL_CATEGORY_DOC};站着扫用不上它`,
    fields: [
      { key: 'target', kind: 'string', required: true, hint: '要找的方块或活物英文 id', doc: '方块或实体英文 id' },
      {
        key: 'direction', kind: 'enum', values: Object.keys(DIRECTIONS),
        error: `find 的 direction 要是 ${Object.keys(DIRECTIONS).join('/')} 之一`,
        doc: '给了就边走边找;不给就站着扫',
      },
      { key: 'distance', kind: 'int', lo: 1, hi: 1024, def: FIND_STATIC_MAX, unit: '格' },
      {
        key: 'until', kind: 'names', hint: `方块英文 id 或类别 ${UNTIL_CATEGORY_DOC}`,
        doc: '边走边找时:路上碰到这里头任何一样就停',
      },
    ],
  },
  {
    name: 'flee',
    doc: '{"skill":"flee","distance":24}                   远离最近的敌对生物',
    fields: [{ key: 'distance', kind: 'int', lo: 1, hi: 128, def: 24, unit: '格' }],
  },
  {
    name: 'surface',
    doc: `{"skill":"surface"}                              脱离水体或向上到露天:在水里=浮上水面并站到干燥落脚格,回执另报 sky_visible;
                                                 只换到气、没找到岸或游不到岸都算没完成;在陆上=挖+垫一路上行到露天`,
    fields: [],
  },
  {
    name: 'collect',
    doc: `{"skill":"collect","block":"oak_log","count":3}  采集方块,只挖看得见的——埋在石头里的看不见,得先挖开或者找暴露的。
                                                 加 "buried":true = 看得见但走不过去时,允许挖条路过去(最多 4 次)。
                                                 加 "mature":true = 作物只收 age 到顶的,没长成的留着。
                                                 tool 不写=节约耐久;"fastest"=本步最快;物品 id=本步精确指定,都不改长期设置`,
    fields: [
      { key: 'block', kind: 'string', required: true, hint: '方块英文 id' },
      { key: 'count', kind: 'int', lo: 1, hi: 64, def: 1 },
      { key: 'buried', kind: 'flag' },
      { key: 'mature', kind: 'flag' },
      { key: 'tool', kind: 'string', hint: '物品英文 id 或 fastest', doc: '只覆盖本步;不写时节约耐久' },
    ],
  },
  {
    name: 'fish',
    doc: `{"skill":"fish"}                                 钓一竿:12 格内的水面里优先选开阔水域(周围 5×5 至少 2 格深、离岸 ≥3 格,宝藏只在这种水里出),没有才钓岸边并说明;
                                                 站在原地抛得到就不挪窝。45 秒没上钩就收竿(浮标头顶看不到天时 60 秒);
                                                 加 "at":[x,y,z] = 指定钓哪格水面。抛竿角度按弹道自己算,浮标没落进水里会换角度重抛`,
    fields: [
      { key: 'at', kind: 'anchor', error: `fish 的 at 要 [x,y,z](水面那一格;${RELATIVE_HINT})` },
    ],
  },
  {
    name: 'tunnel',
    doc: `{"skill":"tunnel","at":["~","~-10","~30"]}       从脚下朝那一格挖一条 1 宽 2 高的通道,斜着自动成楼梯;
                                                 坡度超 45° 不接。走到终点才算挖通,没走到就报断在哪一格。
{"skill":"tunnel","at":["~","~-30","~"]}         终点在正下方 = 竖井,一格一格往下挖(下面塌空就停,不往下掉;竖井是单程的,回不来)
{"skill":"tunnel","at":["~","~12","~"]}          终点在正上方 = 塔,一格一格垫上去(垫脚料见 mc_policy)
{"skill":"tunnel","at":["~","~-30","~"],"spiral":true}
                                                 正上/正下 + "spiral" = 螺旋楼梯:绕脚下 2×2 井筒边挖边转,每格升降 1,
                                                 挖完上下都能走——下矿要能自己走回来就用这个,别用竖井
{"skill":"tunnel","at":["~","~-30","~"],"until":["#ores"]}
                                                 加 "until" = 挖的路上周围碰到这里头任何一样就停下来报坐标(算做完,
                                                 不再往终点挖)。名单写方块英文 id,也认类别 ${UNTIL_CATEGORY_DOC}。
                                                 tool 不写=节约耐久;"fastest"=本步最快;物品 id=本步精确指定`,
    fields: [
      { key: 'at', kind: 'anchor', required: true, error: `tunnel 要 at:[x,y,z](通道终点;${RELATIVE_HINT})`, doc: '通道终点' },
      { key: 'spiral', kind: 'flag', doc: '正上/正下时改挖 2×2 螺旋楼梯(上下都能走)' },
      { key: 'dryRun', kind: 'flag' },
      { key: 'tool', kind: 'string', hint: '物品英文 id 或 fastest', doc: '只覆盖本步;不写时节约耐久' },
      {
        key: 'until', kind: 'names', hint: `方块英文 id 或类别 ${UNTIL_CATEGORY_DOC}`,
        doc: '挖的路上碰到这里头任何一样就停',
      },
    ],
  },
  {
    name: 'build',
    doc: `{"skill":"build","material":"torch","on":[{"at":[103,63,-31],"face":"up"}]}
                                                 贴着 at 那一格的 face 面放,新方块落在那一面的外侧;
                                                 face 认 ${FACE_NAMES.join('/')},一步最多 ${PLACE_SPOTS_MAX} 处
{"skill":"build","material":"torch","anchors":[[103,64,-31]]}
                                                 直接点格子:**不写 shape = 就这些格**(1-${PLACE_SPOTS_MAX} 个),贴哪一面由我挑;
                                                 那一格已经是这个方块就直接算做好。
                                                 给 shape + 多锚点就按形状连片搭:line 2 个、rect 2 个(轴对齐的面,
                                                 两锚点须有一轴相等)、triangle 3 个、arc 3 个(过三点的弧)、
                                                 box 2 个(对角,fill: solid 实心/outline 只有外壳/edges 只有 12 条棱;
                                                 outline 不清内部,原版 /fill 的 hollow 那个模式这里没有)。
                                                 一单最多 256 块;材料用完或贴不住就停在那。
                                                 dryRun 试算:要动几块、材料够不够
{"skill":"build","blueprint":"home-v2","at":[100,64,-30]}
                                                 按 mc_blueprint 装载着的那张图施工。**at 是蓝图 [0,0,0] 落在世界的哪一格**,
                                                 第一次要给,续建省略(接着上次那个锚点往下施工)。
                                                 开工前先跟世界对一遍账:已经对上的格子跳过,只做差的那些;
                                                 料用完就停在那儿。完成(或阶段停)会逐格回读验收。
                                                 加 "stopAfter":2 = 施工到第 2 层(y 层号,0 是最低层)就收工;
                                                 retrofit 初探报出冲突后,审阅无误可加 "confirm":true 清掉那些冲突格再施工;
                                                 或加 "skipConflicts":true 把冲突格原样留着、先放能放的(回执点名跳过了哪几格);
                                                 dryRun 试算:冲突格、在箱/随身/还缺三分账单、手上的料能连着施工到第几步`,
    parse: parseShaped('build'),
    fields: [
      {
        key: 'blueprint', kind: 'string',
        hint: 'mc_blueprint 装载着的键', doc: '按蓝图施工;形状与材料都在图里',
      },
      {
        key: 'stopAfter', kind: 'int', lo: 0, hi: Number.MAX_SAFE_INTEGER, def: 0,
        doc: '按蓝图施工时:做到这个 y 层就收工(0 是最低层)',
      },
      { key: 'confirm', kind: 'flag', doc: 'retrofit 有冲突时:确认清掉冲突格后施工' },
      { key: 'skipConflicts', kind: 'flag', doc: 'retrofit 有冲突时:留着冲突格,先放能放的' },
      {
        key: 'shape', kind: 'enum', values: SHAPE_NAMES,
        error: `build 的 shape 要是 ${SHAPE_NAMES.join('/')} 之一`, doc: '不写 = 就 anchors 那些格',
      },
      {
        key: 'on', kind: 'opaque',
        schema: {
          type: 'array',
          items: {
            type: 'object',
            properties: { at: { ...ANCHOR_SCHEMA }, face: { type: 'string', enum: [...FACE_NAMES] } },
            required: ['at', 'face'],
          },
          minItems: 1, maxItems: PLACE_SPOTS_MAX,
        },
        doc: '贴着 at 那一格的 face 面放;与 anchors 二选一',
      },
      {
        key: 'anchors', kind: 'opaque',
        schema: { type: 'array', items: { ...ANCHOR_SCHEMA }, minItems: 1, maxItems: PLACE_SPOTS_MAX },
        doc: '不写 shape = 就这些格;与 on 二选一',
      },
      // 三形态里两形态必填;蓝图形态一个都不收,由 parse 钩子裁决(required 只进文档)
      { key: 'material', kind: 'string', required: true, hint: '方块英文 id' },
      {
        key: 'at', kind: 'anchor',
        error: `build 的 at 要 [x,y,z](蓝图 [0,0,0] 落在世界的哪一格;${RELATIVE_HINT})`,
        doc: '按蓝图施工时:蓝图 [0,0,0] 落在世界的哪一格',
      },
      { key: 'fill', kind: 'enum', values: ['solid', 'outline', 'edges'], error: 'fill 只认 solid/outline/edges', doc: '只对 box 有意义' },
      { key: 'dryRun', kind: 'flag' },
    ],
  },
  {
    name: 'excavate',
    doc: `{"skill":"excavate","shape":"box","anchors":[[160,-58,95],[168,-52,102]]}
                                                 按形状挖空间,shape/锚点同 build。一单最多 512 块;
                                                 紧贴液体的格子不挖。tool 不写=节约耐久;"fastest"=本步最快;
                                                 物品 id=本步精确指定,都不改长期设置`,
    parse: parseShaped('excavate'),
    fields: [
      {
        key: 'shape', kind: 'enum', values: SHAPE_NAMES, required: true,
        error: `excavate 的 shape 要是 ${SHAPE_NAMES.join('/')} 之一`,
      },
      {
        key: 'anchors', kind: 'opaque', required: true,
        schema: { type: 'array', items: { ...ANCHOR_SCHEMA }, minItems: 2, maxItems: 3 },
        doc: '数量由 shape 定',
      },
      { key: 'fill', kind: 'enum', values: ['solid', 'outline', 'edges'], error: 'fill 只认 solid/outline/edges' },
      { key: 'dryRun', kind: 'flag' },
      { key: 'tool', kind: 'string', hint: '物品英文 id 或 fastest', doc: '只覆盖本步;不写时节约耐久' },
    ],
  },
  {
    name: 'probe',
    doc: `{"skill":"probe","shape":"line","anchors":[["~","~2","~"],["~","~80","~"]]}
                                                 只看不动:读出你圈的这片形状里的材质构成与液体;27 格以内
                                                 逐格报「(x,y,z):方块」,作物带 age。圈哪片由你定
{"skill":"probe","shape":"box","anchors":[[-40,40,-120],[-8,60,-88]],"where":["spawner","#chests"]}
                                                 加 "where" = 只报这几样在这片里的坐标(按远近,每样最多 ${PROBE_WHERE_SHOWN} 处)。
                                                 这一档直接读区块,不看视线也不管挡没挡着 —— 封在结构里的刷怪笼、
                                                 埋着的箱子、矿脉走这条;find 只看得见明面上的东西。名单认 ${UNTIL_CATEGORY_DOC}`,
    parse: parseShaped('probe'),
    fields: [
      {
        key: 'shape', kind: 'enum', values: SHAPE_NAMES, required: true,
        error: `probe 的 shape 要是 ${SHAPE_NAMES.join('/')} 之一`,
      },
      {
        key: 'anchors', kind: 'opaque', required: true,
        schema: { type: 'array', items: { ...ANCHOR_SCHEMA }, minItems: 2, maxItems: 3 },
        doc: '数量由 shape 定',
      },
      { key: 'fill', kind: 'enum', values: ['solid', 'outline', 'edges'], error: 'fill 只认 solid/outline/edges', doc: '只对 box 有意义' },
      {
        key: 'where', kind: 'names', hint: `方块英文 id 或类别 ${UNTIL_CATEGORY_DOC}`,
        doc: '只报这几样在这片里的坐标(不看视线)',
      },
    ],
  },
  {
    name: 'use',
    doc: `{"skill":"use","item":"flint_and_steel","at":[103,64,-31]}
                                                 右键那一格:开门/拉杆/按钮、空桶装水、锄头翻地、骨粉催熟、
                                                 开箱子看一眼、点床睡觉。不写 item = 用手上现在拿着的。
                                                 加 "times":5 = 连着右键 5 次(最多 16)。
                                                 想让空着的那一格出现东西(放方块/床/船)用 build
{"skill":"use","item":"water_bucket","at":[-185,70,61]}
                                                 满桶倒出去:水/岩浆浇在那一格,倒完包里多一个空桶。
                                                 倒水走这条,build 的 material 不认水桶
{"skill":"use","item":"shears","target":"sheep"} 右键活物:剪毛、挤奶、喂食、上鞍。
                                                 target 写 villager/wandering_trader = 看报价菜单(只看不买);
                                                 再带 "index":1,"times":2 = 按菜单 1 号成交 2 次
{"skill":"use","item":"potion"}                  只给 item:对自己/面前用,喝药水、拉弓蓄力。
                                                 投掷类(喷溅药水、末影珍珠、雪球、鸡蛋)再给 at = 朝那一格扔
{"skill":"use","at":[-147,72,101],"text":"欢迎来我家\\n可缇"}
                                                 **往告示牌上写字**:先 build 把牌子放上,再用这条写。
                                                 \\n 分行,最多 4 行、每行 45 字符;写完读回牌子上的字进回执。
                                                 手上拿着染料/墨囊/蜂巢时右键做的是改色/发光/上蜡,先空手
{"skill":"use","item":"item_frame","at":[-147,72,101],"face":"north"}
                                                 face = 右键那一格的哪一面(缺省顶面)。画只能贴侧面`,
    parse: parseUse,
    fields: [
      { key: 'item', kind: 'string', doc: '不写 = 用手上现在拿着的' },
      { key: 'at', kind: 'anchor', error: `use 的 at 要 [x,y,z](${RELATIVE_HINT})`, doc: '右键那一格;与 target 二选一' },
      { key: 'target', kind: 'string', doc: '右键活物;与 at 二选一' },
      { key: 'index', kind: 'int', lo: 1, hi: 99, def: 1 },
      { key: 'times', kind: 'int', lo: 1, hi: USE_TIMES_MAX, def: 1, doc: '连着右键几次;带 index 时是成交几次' },
      { key: 'text', kind: 'string', doc: `写在告示牌上的字,\\n 分行;最多 ${SIGN_LINES} 行、每行 ${SIGN_LINE_CHARS} 字符` },
      { key: 'back', kind: 'flag', doc: '写在牌子背面;缺省正面' },
      { key: 'face', kind: 'enum', values: FACE_NAMES, error: `use 的 face 要是 ${FACE_NAMES.join('/')} 之一`, doc: '右键那一格的哪一面;缺省顶面' },
    ],
  },
  {
    name: 'ride',
    doc: `{"skill":"ride","target":"pig","to":[120,64,-30]}
                                                 骑上坐骑并驾着走。**能驾的只有猪(要先上鞍、包里有胡萝卜钓竿)
                                                 和船**;马/驴骑得上但驾不了(这版不支持),骑上不动。
                                                 to 只认水平目的地,到目标 2.5 格内算到;20 秒零推进会自己下来并报走到哪。
{"skill":"ride","target":"boat"}                 只骑上不走;之后驾驭再来一步 {"skill":"ride","to":[x,y,z]}
{"skill":"ride","off":true}                      从坐骑上下来。骑着的时候寻路器不管坐骑,goto 走不了`,
    parse: parseRide,
    fields: [
      { key: 'target', kind: 'string', doc: '骑上哪种(实体英文 id:pig/boat/horse…);已骑着时可省' },
      { key: 'to', kind: 'anchor', error: `ride 的 to 要 [x,y,z](${RELATIVE_HINT})`, doc: '驾着去哪;只有猪和船能驾' },
      { key: 'off', kind: 'flag', doc: '下坐骑;与 target/to 互斥' },
    ],
  },
  {
    name: 'lead',
    doc: `{"skill":"lead","target":"cow","to":[-146,71,103],"tolerance":3}
                                                 **拴绳牵动物**:包里要有拴绳(lead)。走到最近的那只跟前拴上,
                                                 分段牵着走到 to,到了就松开,它留在那儿。
                                                 tolerance = 牵到 to 多少格内算到(缺省 3;绳是软的,拉不到落脚点上)。
                                                 路上它掉队会停下等;绳绷断(超 10 格)当场停下报断在哪儿。
                                                 拴不上的:村民、幼崽以外的敌对生物、别人已经牵着的
{"skill":"lead","target":"cow","to":[...],"tie":[-145,67,103]}
                                                 牵到了再**系到 tie 那一格的栅栏上**——这样它才真的圈住了,
                                                 松开只是它暂时站那儿
{"skill":"lead","target":"cow"}                  只拴上不牵走(之后再来一步给 to)
{"skill":"lead","to":[...],"keep":true}          把现在牵着的牵过去,到了继续牵着不松
{"skill":"lead","off":true}                      松开现在牵着的那只(绳掉在地上,记得 pickup)`,
    parse: parseLead,
    fields: [
      { key: 'target', kind: 'string', doc: '拴哪种(实体英文 id);已经牵着时可省' },
      { key: 'to', kind: 'anchor', error: `lead 的 to 要 [x,y,z](${RELATIVE_HINT})`, doc: '牵去哪' },
      {
        key: 'tolerance', kind: 'int', lo: LEAD_TOL.lo, hi: LEAD_TOL.hi, def: LEAD_TOL.def, unit: '格',
        doc: '牵到 to 多少格内算到',
      },
      { key: 'tie', kind: 'anchor', error: `lead 的 tie 要 [x,y,z](${RELATIVE_HINT})`, doc: '到了系在这一格的栅栏上' },
      { key: 'keep', kind: 'flag', doc: '到了继续牵着,不松开' },
      { key: 'off', kind: 'flag', doc: '松开;与 target/to/tie/keep 互斥' },
    ],
  },
  {
    name: 'craft',
    doc: `{"skill":"craft","grid":[["charcoal"],["stick"]],"count":4}
                                                 **自己摆合成格**:grid 是按行写的名字二维数组,空位写 null。
                                                 2 行 2 列以内徒手就能做,更大要工作台。产出槽出什么算什么。
{"skill":"craft","item":"wooden_pickaxe","count":1}
                                                 也可以只写 item,按游戏自带的配方表摆。**中间材料不会自动补**。
                                                 够得着的工作台直接用;够不着就放一个自己带的,包里没有才走去现成的`,
    parse: parseCraft,
    fields: [
      { key: 'item', kind: 'string', doc: '按游戏配方表摆;与 grid 二选一' },
      {
        key: 'grid', kind: 'opaque',
        schema: { type: 'array', items: { type: 'array', items: { type: ['string', 'null'] } } },
        doc: '与 item 二选一',
      },
      { key: 'count', kind: 'int', lo: 1, hi: 64, def: 1 },
    ],
  },
  {
    name: 'smelt',
    doc: `{"skill":"smelt","input":"raw_iron","count":8,"fuel":"charcoal"}
                                                 走到炉边下料点火就走,input 与 fuel 都必写。炉子自己烧
                                                 (熔炉一件约 10 秒),烧好会有事件提醒;取货用 take 的 at 指着炉子。
                                                 够得着的炉子直接用;够不着就放一个自己带的,包里没有才走去现成的。
                                                 还烧着别的东西的炉子不挑,几座炉子可以同时各烧各的;
                                                 加 "at":[x,y,z] = 指定用那一座炉子`,
    fields: [
      { key: 'input', kind: 'string', required: true, hint: '原料英文 id' },
      { key: 'count', kind: 'int', lo: 1, hi: 64, def: 1 },
      { key: 'fuel', kind: 'string', required: true, hint: '燃料英文 id' },
      { key: 'at', kind: 'anchor', error: `smelt 的 at 要 [x,y,z](${RELATIVE_HINT})`, doc: '指定用哪一座炉子' },
    ],
  },
  {
    name: 'brew',
    doc: `{"skill":"brew","at":[x,y,z],"input":"nether_wart","bottle":"potion","count":3,"fuel":"blaze_powder"}
                                                 下料点火就走,酿一轮约 20 秒,好了有事件提醒;取货用 take 的 at 指着酿造台。
                                                 **水瓶与所有药水的物品 id 都是 potion**,名字上分不出来;回执带的「内容 #N」
                                                 是原版药水注册表序号,同一种药水这个数不变,拿它对账。
                                                 燃料只吃烈焰粉(一份烧 20 轮),煤不行。
                                                 材料链三段跳不过:水瓶 →(地狱疣)→ 粗制药水 →(效果材料)→ 基础药水
                                                 →(红石延时 / 萤石粉加强 / 火药变喷溅 / 龙息变滞留)。
                                                 红石与萤石粉互斥,同一瓶不能既加强又延时。
                                                 玻璃瓶装水:{"skill":"use","item":"glass_bottle","at":水源那一格}`,
    fields: [
      { key: 'input', kind: 'string', required: true, hint: '这一轮加的材料英文 id' },
      { key: 'bottle', kind: 'string', required: true, hint: '瓶子英文 id(potion / glass_bottle)' },
      { key: 'count', kind: 'int', lo: 1, hi: 3, def: 3, doc: '放几瓶(三个瓶位)' },
      { key: 'fuel', kind: 'string', required: true, hint: '燃料英文 id(原版只吃 blaze_powder)' },
      { key: 'at', kind: 'anchor', error: `brew 的 at 要 [x,y,z](${RELATIVE_HINT})`, doc: '指定用哪一座酿造台' },
    ],
  },
  {
    name: 'enchant',
    doc: `{"skill":"enchant","at":[x,y,z],"item":"diamond_pickaxe"}
                                                 走到附魔台边,把东西放上去**只看三档报价,不下手**。
                                                 回执报三档各要多少级、多少青金石、显示出来的那条附魔,以及周围有效书架。
{"skill":"enchant","at":[x,y,z],"item":"diamond_pickaxe","index":3}
                                                 按第 N 档下手(1/2/3 = 上中下三格)。
                                                 「需 N 级」是**门槛**;真扣掉的是档位号那么多级与同样多的青金石(1/2/3)。
                                                 原版下手前每档只显示一条附魔,别的要下手才知道。
                                                 已经附过魔的东西附魔台不接;书架要隔一格、同高或高一格,中间那格必须空着`,
    parse: parseEnchant,
    fields: [
      {
        key: 'at', kind: 'anchor', required: true,
        error: `enchant 要 at:[x,y,z](${RELATIVE_HINT}),指着附魔台那一格`,
      },
      { key: 'item', kind: 'string', required: true, hint: '要附魔的物品英文 id' },
      { key: 'index', kind: 'int', lo: 1, hi: 3, def: 1, doc: '不写 = 只看报价;写了 = 按那一档下手' },
    ],
  },
  {
    name: 'anvil',
    doc: `{"skill":"anvil","op":"combine","item":"iron_pickaxe","with":"iron_pickaxe"}
                                                 铁砧:两件同种合修(耐久相加+12%),或本体+附魔书。
                                                 op:"repair" 与 combine 同义。**花的是经验等级**,回执报实扣几级;
                                                 等级不够时产出拿不走,回执会说门槛。铁砧每用一次有 12% 概率磨损一级
{"skill":"anvil","op":"rename","item":"iron_sword","name":"新名字"}
                                                 改名(最多 ${ANVIL_NAME_MAX} 字符)。at 不写就用附近 16 格内的铁砧
{"skill":"anvil","op":"combine","item":"bow","with":"enchanted_book","withPick":"无限"}
                                                 包里有好几本附魔书(同一个 id)时,靠 pick/withPick 点名要哪一本:
                                                 写清单括号里的字。不点名 = 撞上哪件算哪件`,
    parse: parseAnvil,
    fields: [
      { key: 'op', kind: 'enum', values: ['repair', 'combine', 'rename'], required: true, error: 'anvil 的 op 只认 repair/combine/rename' },
      { key: 'item', kind: 'string', required: true, hint: '左格物品英文 id' },
      { key: 'with', kind: 'string', doc: 'repair/combine 必写:右格放什么' },
      { key: 'name', kind: 'string', doc: 'rename 必写:新名字' },
      // 挑选词的说明只挂第一处:字段池按 (技能, doc) 逐条印,六个技能各写一遍就是印六遍
      { key: 'pick', kind: 'string', doc: PICK_DOC },
      { key: 'withPick', kind: 'string', doc: '同 pick,筛的是 with 那一格' },
      { key: 'at', kind: 'anchor', error: `anvil 的 at 要 [x,y,z](${RELATIVE_HINT})`, doc: '指定用哪一座铁砧;不写用最近的' },
    ],
  },
  {
    name: 'grindstone',
    doc: `{"skill":"grindstone","item":"iron_sword"}       砂轮:磨掉普通附魔并按原版比例**返还经验**(诅咒磨不掉);
                                                 再给 with(同种工具)= 两件合修成一件。回执报磨前磨后的耐久与附魔、
                                                 返了多少点经验。at 不写就用附近 16 格内的砂轮`,
    parse: parseGrindstone,
    fields: [
      { key: 'item', kind: 'string', required: true, hint: '要磨的物品英文 id' },
      { key: 'with', kind: 'string', doc: '合修:同种的另一件' },
      { key: 'pick', kind: 'string' },
      { key: 'withPick', kind: 'string' },
      { key: 'at', kind: 'anchor', error: `grindstone 的 at 要 [x,y,z](${RELATIVE_HINT})`, doc: '指定用哪一座砂轮;不写用最近的' },
    ],
  },
  {
    name: 'eat',
    doc: `{"skill":"eat","item":"bread"}                 吃点名的食物;item 必须写完整英文 id。
                                                 河豚/蜘蛛眼/毒马铃薯会中毒:第一次只回后果不吃,3 分钟内再下一模一样的单才吃。
                                                 milk_bucket 也走这条:喝掉清光身上的状态效果,不管饱,剩个空桶`,
    fields: [{ key: 'item', kind: 'string', required: true, hint: '食物英文 id(牛奶桶写 milk_bucket)' }],
  },
  {
    name: 'attack',
    doc: `{"skill":"attack","target":"zombie"}             攻击最近的该目标。mode 不写/auto = 距离判断近战或弓(8 格切弓、5.5 格切回近战);
                                                 melee = 只近战;ranged = 只用弓;kite = 用弓并尽量保持 8–14 格。
                                                 ranged/kite 没有可用弓箭或看不见目标时会受阻,不会暗换近战`,
    fields: [
      { key: 'target', kind: 'string', required: true, hint: '实体英文 id 或玩家名' },
      {
        key: 'mode', kind: 'enum', values: ['auto', 'melee', 'ranged', 'kite'],
        error: 'attack 的 mode 只认 auto/melee/ranged/kite',
        doc: '不写 = auto',
      },
    ],
  },
  {
    name: 'equip',
    doc: `{"skill":"equip","item":"stone_sword"}           手持物品;盔甲、鞘翅、盾牌会自动穿进对应装备槽。
                                                 不写 item = 把主手腾空(骑马、上鞍这类要空手的动作用它)`,
    parse: parseEquip,
    fields: [
      { key: 'item', kind: 'string', hint: '物品英文 id', doc: '不写 = 把主手腾空' },
      { key: 'pick', kind: 'string' },
    ],
  },
  {
    name: 'pickup',
    doc: '{"skill":"pickup","item":"cobblestone"}          拾取附近掉落物;item 可选,不写就近扫',
    fields: [{ key: 'item', kind: 'string', doc: '不写就近扫' }],
  },
  {
    name: 'toss',
    doc: `{"skill":"toss","item":"cobblestone","count":64} 扔掉。不写 at = 自己挑一个开阔方向抛出去,
                                                 免得东西落回脚边又被自己捡回来
{"skill":"toss","item":"gold_ingot","at":[12,32,10]}
                                                 **朝那一格扔**:以物易物把金锭扔到猪灵脚边、
                                                 把东西放到指定的地方。最远约 8 格,远了先走近。
                                                 抛物线的落点由服务端算,回执只说朝哪儿扔的`,
    fields: [
      { key: 'item', kind: 'string', required: true, hint: '物品英文 id' },
      { key: 'count', kind: 'int', lo: 1, hi: 64, def: 1 },
      {
        key: 'at', kind: 'anchor', error: `toss 的 at 要 [x,y,z](${RELATIVE_HINT})`,
        doc: '朝那一格扔;不写 = 自己挑一个开阔方向',
      },
      { key: 'pick', kind: 'string' },
    ],
  },
  {
    name: 'stow',
    doc: `{"skill":"stow","item":"cobblestone","count":64} 存进附近箱子(32 格内)。先找上次看见还有空位的,没有就开最近没开过的
{"skill":"stow","item":"enchanted_book","pick":"精准采集","count":1}
                                                 同 id 的几件里只存点名的那件(留下别的)`,
    fields: [
      { key: 'item', kind: 'string', required: true, hint: '物品英文 id' },
      { key: 'count', kind: 'int', lo: 1, hi: 64, def: 1 },
      { key: 'pick', kind: 'string' },
    ],
  },
  {
    name: 'take',
    doc: `{"skill":"take","item":"coal","count":16}        从附近箱子取出。先找账本里有的,对不上再开,最多 3 个
{"skill":"take","at":[103,63,-31],"all":true}    明确清空那一格容器:炉子=输出+没烧完的料+剩的燃料;箱子=整箱。
                                                 定量取物必须同时写 item 和 count,不默认数量`,
    parse: parseTake,
    fields: [
      { key: 'item', kind: 'string', hint: '物品英文 id', doc: '定量取物时与 count 一起写' },
      { key: 'count', kind: 'int', lo: 1, hi: 64, def: 1, doc: '定量取物必须显式写;不再默认成 1' },
      { key: 'at', kind: 'anchor', error: `take 的 at 要 [x,y,z](${RELATIVE_HINT})`, doc: '点名哪一格容器' },
      { key: 'all', kind: 'flag', doc: '只在 at+all:true 时清空指定容器' },
      { key: 'pick', kind: 'string' },
    ],
  },
  {
    name: 'chat',
    doc: '{"skill":"chat","text":"..."}                    游戏内说话',
    fields: [{ key: 'text', kind: 'string', required: true }],
  },
];

const SKILL_INDEX = new Map(SKILLS.map((s) => [s.name as string, s]));

function specIsScout(s: SkillSpec): boolean {
  return s.name === 'probe' || s.fields.some((f) => f.key === 'dryRun');
}

const SCOUT_SKILLS = SKILLS.filter(specIsScout);

/** 技能名清单:mc_do 参数 schema 的 enum;顺序即注册表出场顺序 */
export const SKILL_NAMES: ReadonlyArray<SkillCall['skill']> = SKILLS.map((s) => s.name);

/** mc_scout 收的技能名;与 schema enum、parseScoutSteps 同源 */
export const SCOUT_SKILL_NAMES: ReadonlyArray<SkillCall['skill']> = SCOUT_SKILLS.map((s) => s.name);

const SKILL_DOC_TAIL = `坐标写成 [x,y,z];at 是一个坐标,anchors 是一串坐标。
每个分量是绝对数字,或 "~"/"~-3" 相对写法——原点是**这一步开始执行那一刻**我脚下那一格,
所以 goto 之后接 "~" 指的是那个 goto 的落点。没有前后左右的写法。
回执一律报解析后的绝对坐标。
方块/物品/实体一律用英文 id(oak_log、cobblestone、skeleton);target 也收玩家名。
类别名有两套:target/block/material 认 log、planks、ore、wool 这样的裸名(它们本身不是物品 id),把所有同类算进去;
until 名单认带井号的 ${UNTIL_CATEGORY_DOC}。
**写一个真实物品 id 就只认它自己**:obsidian 不会拿哭泣的黑曜石顶,torch 不是灵魂火把,
chest 不是末影箱,dirt 不是土径 —— 要"随便哪种木板"就写裸类别名 planks。
count 一律 1-64;distance:flee 1-128,find 1-1024(不给 direction 时站着扫,最远 ${FIND_STATIC_MAX})。
"needs" 声明这一步依赖哪些更早的步(序号 1 起);"needs":[] = 独立步。缺省见字段说明。
每一步都会核验:判据由执行器按 (skill, 参数) 推,达成与落空都写进回执
(「该步按『背包内原木 ≥5』核验:达成(实测 7)」)。`;

function skillDocOf(skills: readonly SkillSpec[], lead: string): string {
  return [lead, ...skills.map((s) => s.doc), SKILL_DOC_TAIL].join('\n');
}

/** 技能表的对外说明:直接作 mc_do 的 steps 参数说明。骨架来自注册表,首尾两段手写 */
export const SKILL_DOC = skillDocOf(SKILLS, '一步一个对象,按顺序执行:');

/**
 * mc_scout 的 steps 说明:**指向 mc_do 那一份,不再重列技能条目**。
 *
 * 重列的那一版 53 行里 52 行逐字同于 `SKILL_DOC`(3,891 字符),而两处措辞一旦漂移
 * 就成了两套口径。结构化那份(`SCOUT_STEP_SCHEMA`)照旧是完整字段池 —— 解参数读的是它。
 */
export const SCOUT_SKILL_DOC = [
  '一步一个对象,按顺序试算,不动世界。',
  `收 ${SCOUT_SKILLS.map((s) => s.name).join(' / ')} 这几个技能,写法与参数跟 mc_do 的 steps 完全一样`,
  '(见 mc_do 的说明),一律按试算跑,不用自己写 dryRun。',
].join('');

function defaultFieldSchema(f: FieldSpec): Record<string, unknown> {
  switch (f.kind) {
    case 'string': return { type: 'string' };
    case 'names': return { type: 'array', items: { type: 'string' }, maxItems: UNTIL_NAMES_MAX };
    case 'int': return { type: 'integer', minimum: f.lo, maximum: f.hi };
    case 'anchor': return { ...ANCHOR_SCHEMA };
    case 'flag': return { type: 'boolean' };
    case 'enum': return { type: 'string', enum: [...f.values] };
    case 'opaque': return { ...f.schema };
  }
}

/** 字段的结构片段;description 不在这儿,合并后按用处列表另生成。 */
function fieldSchema(f: FieldSpec): Record<string, unknown> {
  const base = f.schema ? { ...f.schema } : defaultFieldSchema(f);
  delete base.description;
  return base;
}

/**
 * 同名字段跨技能的合并:区间取并集,枚举取并集,其余(type/items)本就一致,
 * 留先出场的那份。放宽到并集不丢约束——真校验在 parseSteps,schema 只管别把
 * 合法值挡在门外。
 */
function widenField(
  into: Record<string, unknown>,
  add: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...into };
  for (const [k, v] of Object.entries(add)) {
    const prev = out[k];
    if (prev === undefined) out[k] = v;
    else if (k === 'minimum' || k === 'minItems') out[k] = Math.min(prev as number, v as number);
    else if (k === 'maximum' || k === 'maxItems') out[k] = Math.max(prev as number, v as number);
    else if (k === 'enum') out[k] = [...new Set([...(prev as string[]), ...(v as string[])])];
  }
  return out;
}

/** 一个字段在某技能下的用处标注:「smelt」「goto(只写 [x,z] …)」「flee(1-128)」 */
function fieldUse(skill: string, f: FieldSpec, merged: Record<string, unknown>): string {
  const bits: string[] = [];
  // 区间被别的技能撑宽了才写出来,否则 schema 自身就说清楚了
  if (f.kind === 'int' && (merged.minimum !== f.lo || merged.maximum !== f.hi)) {
    bits.push(`${f.lo}-${f.hi}`);
  }
  if (f.doc) bits.push(f.doc);
  return bits.length ? `${skill}(${bits.join(';')})` : skill;
}

/**
 * steps.items schema:一份扁平字段池,description 写明每个字段用于哪些技能。
 * 每技能自己的必填与横向规则不进 schema:判别式 oneOf 不能用,有的 provider 解工具参数
 * 约束只认顶层 properties,分支里的字段会被整个吃掉,她填了也传不出来。硬约束改由
 * SKILL_DOC 陈述、parseSteps 裁决,报错回执带整张技能表。
 */
function stepSchemaOf(skills: readonly SkillSpec[]): Record<string, unknown> {
  const pool = new Map<string, { schema: Record<string, unknown>; uses: Array<[string, FieldSpec]> }>();
  for (const s of skills) {
    for (const f of s.fields) {
      const prev = pool.get(f.key);
      pool.set(f.key, {
        schema: widenField(prev?.schema ?? {}, fieldSchema(f)),
        uses: [...(prev?.uses ?? []), [s.name, f]],
      });
    }
  }
  const fields = [...pool].map(([key, { schema, uses }]) => {
    const notes = uses.map(([skill, f]) => fieldUse(skill, f, schema));
    return [key, { ...schema, description: `用于 ${notes.join(' / ')}` }] as const;
  });
  return {
    type: 'object',
    properties: {
      skill: { type: 'string', enum: skills.map((s) => s.name) },
      ...Object.fromEntries(fields),
      needs: {
        type: 'array', items: { type: 'integer' },
        description: '任何技能都可带:依赖哪些更早的步(序号 1 起)。' +
          '不写=只拦因果:要用更早某步的产出、那一步又没做成时才跳过,其余照跑;[]=独立步',
      },
      // `expect` 不进 schema、也不进技能表:两轮实验(0821 给回显、0822 回显 791 次
      // 而声明 0/5440)之后放弃「让她自己声明验收标准」这条路,只留自动推导 + 回执回显。
      // 解析仍然收(见 `parseSteps`),写了照样覆写判据 —— 撤的是广告,不是能力。
    },
    required: ['skill'],
  };
}

export const SKILL_STEP_SCHEMA: Record<string, unknown> = stepSchemaOf(SKILLS);
export const SCOUT_STEP_SCHEMA: Record<string, unknown> = stepSchemaOf(SCOUT_SKILLS);

/** 表驱动的结构校验:按字段声明逐个过,规范对象只收声明过的键 */
function parseByFields(
  spec: SkillSpec,
  c: Record<string, unknown>,
  at: string,
  marks?: MarkLookup,
): ParseResult {
  const out: Record<string, unknown> = { skill: spec.name };
  const notes: StepNote[] = [];
  for (const f of spec.fields) {
    const v = c[f.key];
    switch (f.kind) {
      case 'string': {
        const s = str(v);
        if (!s) {
          if (f.required) return { error: `${at} ${spec.name} 要 ${f.key}${f.hint ? `(${f.hint})` : ''}` };
          if (v !== undefined && v !== null) {
            notes.push({ field: f.key, given: v, kind: 'dropped', why: '不是一个名字' });
          }
          break;
        }
        out[f.key] = s;
        break;
      }
      case 'names': {
        if (v === undefined || v === null) break;
        if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) {
          return { error: `${at} ${spec.name} 的 ${f.key} 要是一串英文 id(数组)${f.hint ? `,${f.hint}` : ''}` };
        }
        if (v.length > UNTIL_NAMES_MAX) {
          return { error: `${at} ${spec.name} 的 ${f.key} 最多 ${UNTIL_NAMES_MAX} 项` };
        }
        const names = (v as string[]).map((s) => s.trim()).filter(Boolean);
        // 空数组不是「关掉」也不是错写:这一格本来就可以不给,收成没写
        if (names.length > 0) out[f.key] = names;
        else if (v.length > 0) notes.push({ field: f.key, given: v, kind: 'dropped', why: '全是空名字' });
        break;
      }
      case 'int': {
        const n = intIn(v, f.lo, f.hi, f.def);
        if (n === null) return { error: `${at} ${spec.name} 的 ${f.key} 要在 ${f.lo}-${f.hi} ${f.unit ?? ''}之间` };
        out[f.key] = n;
        break;
      }
      case 'anchor': {
        if (v === undefined) {
          if (f.required) return { error: `${at} ${f.error}` };
          break;
        }
        const a = anchorOf(v, marks);
        if (!a) return { error: `${at} ${f.error}${markMissNote(v, marks)}` };
        out[f.key] = a;
        break;
      }
      case 'flag': {
        if (v === true) out[f.key] = true;
        else if (v !== undefined && v !== null && v !== false) {
          notes.push({ field: f.key, given: v, kind: 'dropped', why: '只认 true' });
        }
        break;
      }
      case 'enum': {
        if (v === undefined && !f.required) break;
        const s = str(v);
        if (!s || !f.values.includes(s)) return { error: `${at} ${f.error}` };
        out[f.key] = s;
        break;
      }
      case 'opaque':
        // 复合结构只出现在带 parse 钩子的技能里,不会走到表驱动这条路
        break;
    }
  }
  return { step: out as unknown as SkillCall, ...(notes.length > 0 ? { notes } : {}) };
}

/**
 * 这个技能不收、被整个丢掉的键。值是 null/undefined 的不算:schema 是一份扁平
 * 字段池,模型把用不上的字段填成 null 是照 schema 写的,不是她想说什么。
 */
function strayKeys(spec: SkillSpec, c: Record<string, unknown>): StepNote[] {
  const known = new Set(['skill', 'needs', 'expect', ...spec.fields.map((f) => f.key)]);
  return Object.entries(c)
    .filter(([k, v]) => !known.has(k) && v !== undefined && v !== null)
    .map(([field, given]) => ({
      field, given, kind: 'dropped' as const, why: `${spec.name} 不收这个字段`,
    }));
}

/**
 * mc_do 的边界校验采用整批原子语义;任一步非法时返回步骤索引和原因。
 * 有效步骤重建为规范对象,额外字段不进入技能实现。
 *
 * 规范化不是无声的:被丢掉的字段与被改读的写法进 `notes`(没有就不带这个键),
 * 由受理回执回念 —— 「解析后的调用与她写的不一致时明说」这条规矩的出口。
 */
export function parseSteps(
  raw: unknown,
  marks?: MarkLookup,
): { steps: SkillCall[]; notes?: ParseNote[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'steps 要是一个非空的技能数组' };
  const steps: SkillCall[] = [];
  const notes: ParseNote[] = [];
  for (const [i, item] of raw.entries()) {
    const at = `第 ${i + 1} 步`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return { error: `${at}不是一个对象` };
    }
    const c = item as Record<string, unknown>;
    const name = str(c.skill);
    const spec = name ? SKILL_INDEX.get(name) : undefined;
    if (!spec) {
      return { error: `${at}的 skill「${String(c.skill)}」不是技能表里的动作` };
    }
    const parsed = spec.parse ? spec.parse(c, at, marks) : parseByFields(spec, c, at, marks);
    if ('error' in parsed) return parsed;
    const step = parsed.step;
    for (const n of [...(parsed.notes ?? []), ...strayKeys(spec, c)]) notes.push({ ...n, step: i + 1 });
    // 边界声明骑在规范步骤上;结构非法同样整批退回
    if (c.needs !== undefined) {
      const needs = needsOf(c.needs, i, at);
      if ('error' in needs) return needs;
      step.needs = needs.needs;
    }
    if (c.expect !== undefined) {
      const expect = expectOf(c.expect, at);
      if ('error' in expect) return expect;
      step.expect = expect.expect;
    }
    steps.push(step);
  }
  return notes.length > 0 ? { steps, notes } : { steps };
}

function asScoutStep(step: SkillCall): SkillCall {
  switch (step.skill) {
    case 'goto':
    case 'build':
    case 'excavate':
    case 'tunnel':
      return { ...step, dryRun: true };
    default:
      return step;
  }
}

/**
 * mc_scout 的入参:先走 parseSteps,再留下试算能做的步,并把 dryRun 补上。
 * 会动世界的技能整批退回——这是入口过滤,不是「没试算就不许动手」。
 */
export function parseScoutSteps(
  raw: unknown,
  marks?: MarkLookup,
): { steps: SkillCall[]; notes?: ParseNote[] } | { error: string } {
  const parsed = parseSteps(raw, marks);
  if ('error' in parsed) return parsed;
  const scout = new Set<string>(SCOUT_SKILL_NAMES);
  const steps: SkillCall[] = [];
  for (const [i, step] of parsed.steps.entries()) {
    if (!scout.has(step.skill)) {
      return { error: `第 ${i + 1} 步「${step.skill}」会动世界,试算只收 probe 和带 dryRun 的技能` };
    }
    steps.push(asScoutStep(step));
  }
  return parsed.notes ? { steps, notes: parsed.notes } : { steps };
}
