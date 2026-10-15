/**
 * mc_policy 的契约面:六格常驻规矩一处声明。
 *
 * `POLICY_FIELDS` 声明一次字段(schema 片段 / 工具说明的一行 / 入参校验),出口全部由
 * 这一份生成:`POLICY_SCHEMA`、`POLICY_DOC`、`parsePolicy`。回读渲染另在 `renderPolicy`,
 * 因为它按语义分句(照明名单与照明场合合成一句),不是逐格拼。
 *
 * 规矩是设置不是任务:不进队列、不占任务号、同步回执。五格落盘跨重启活着,所以
 * 「上一场设过 reserve」必须有出口说出来 —— 回执六格全念、非默认项进环境提示词、
 * 连入播报点明是上一场留下的。`fight` 是例外:重启回 `DEFAULT_FIGHT`(回弹本身也要
 * 播报),理由见 `loadPolicyReport`。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { zhName } from './names.ts';

/** 赶路遇坎挖还是垫;接寻路器的挖/垫代价系数 */
export type TravelPrefer = 'auto' | 'dig' | 'place';

/** 什么场合周身黑下来才补一根 */
type LightWhen = 'dig' | 'anywhere';

/** 怪贴到跟前主动动手的条件。只管主动进场,挨打还手不受它管 */
export type FightMode = 'auto' | 'armed' | 'off';

/**
 * `fight` 的默认档:手上有趁手的家伙才主动进场。
 *
 * 空手主动扑怪是必输局而她开局与死后重来都是空背包,`auto` 让这一档成为常态。
 * 不取 `off`:那一档连带把"有剑也不清怪"一起关掉,而挡住的只是空手那一种。
 * 这一格不落盘(见 `loadPolicyReport`),所以默认值就是每次重启后的实际生效值。
 */
export const DEFAULT_FIGHT: FightMode = 'armed';

const TRAVEL_MODES: readonly TravelPrefer[] = ['auto', 'dig', 'place'];
const LIGHT_WHENS: readonly LightWhen[] = ['dig', 'anywhere'];
const FIGHT_MODES: readonly FightMode[] = ['auto', 'armed', 'off'];

/**
 * 生效中的六格。`scaffold`/`light` 的 `null` = 用默认名单(`PolicyDefaults`),
 * `[]` = 这条关掉;`reserve` 没有默认名单这一层,空数组就是「都不收着」。
 */
export interface PolicySettings {
  /** 垫一格用哪些方块,顺序即优先;寻路器搭路用的也是这一份 */
  scaffold: string[] | null;
  /** 周身黑下来插一根用哪些 */
  light: string[] | null;
  lightWhen: LightWhen;
  travel: TravelPrefer;
  /** 收着不主动拿去挖的家伙什;剔完没有别的挖得出掉落时仍然会拿(回执点名) */
  reserve: string[];
  fight: FightMode;
}

/**
 * 她没设过名单时用哪一份。**名单只有一份真相**:寻路器读 `cfg.scaffoldBlocks`,
 * 维持条件层从这里取同一份,同时保住「默认 vs 她设的」这个区别(回执要说得出是哪一种)。
 */
export interface PolicyDefaults {
  scaffold: string[];
  light: string[];
}

export function defaultPolicy(): PolicySettings {
  return { scaffold: null, light: null, lightWhen: 'dig', travel: 'auto', reserve: [], fight: DEFAULT_FIGHT };
}

/** 没接 World 时(测试台架)的兜底名单;真 World 一律从 `cfg.scaffoldBlocks` 来 */
export const FALLBACK_DEFAULTS: PolicyDefaults = { scaffold: ['dirt', 'cobblestone'], light: ['torch'] };

/**
 * 重生点的物理载体:床(16 色)与重生锚。
 *
 * 它是**资产**不是耗材——寻路器挖路、几何形状顺带覆盖、顺手捡走这三条间接破坏
 * 一律不许碰它;要搬要拆走她显式指名那一格的路(见执行器的重生锚闸)。
 */
export function isSpawnAnchorBlock(name: string): boolean {
  return name === 'respawn_anchor' || /(^|_)bed$/.test(name);
}

/**
 * 失去支撑会下落的 FallingBlock 方块族，含三种砧形态。
 * 垫脚名单排除这些方块；build 禁止放在自身碰撞箱正上方。
 */
export function isGravityBlock(name: string): boolean {
  return name === 'sand' || name === 'red_sand' || name === 'gravel'
    || name === 'suspicious_sand' || name === 'suspicious_gravel'
    || name === 'anvil' || name === 'chipped_anvil' || name === 'damaged_anvil'
    || name === 'dragon_egg' || name === 'pointed_dripstone'
    || name.endsWith('_concrete_powder');
}

type PolicyValue = PolicySettings[keyof PolicySettings];

/**
 * 一格的声明。`parse` 认下就给值,不认就给一句 `why` —— 那一格不动,别的照改,
 * 理由进回执的 note(静默吃掉参数是这条链上最贵的一类失败)。
 */
interface PolicyField {
  key: keyof PolicySettings;
  /** 参数 schema 里的那一条(含 description) */
  schema: Record<string, unknown>;
  /** 工具说明里的那一行 */
  doc: string;
  parse(v: unknown): { value: PolicyValue } | { why: string };
}

/**
 * 一份料单:字符串数组,元素 trim;空数组 = 这条关掉。
 * 名字不校验存在性,空串也照收——包里找不找得到由世界说了算,而把 `[""]` 悄悄
 * 收成 `[]` 就是把「一个没用的名字」翻译成了「关掉这一条」。
 */
function listOf(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) return null;
  return (v as string[]).map((s) => s.trim());
}

function listField(
  key: 'scaffold' | 'light' | 'reserve',
  description: string,
  doc: string,
): PolicyField {
  return {
    key,
    schema: { type: 'array', items: { type: 'string' }, description },
    doc,
    parse: (v) => {
      const list = listOf(v);
      return list ? { value: list } : { why: '要一串英文 id(数组),空数组是关掉这一条' };
    },
  };
}

function enumField<T extends string>(
  key: 'lightWhen' | 'travel' | 'fight',
  values: readonly T[],
  description: string,
  doc: string,
): PolicyField {
  return {
    key,
    schema: { type: 'string', enum: [...values], description },
    doc,
    parse: (v) =>
      (typeof v === 'string' && (values as readonly string[]).includes(v.trim())
        ? { value: v.trim() as PolicyValue }
        : { why: `只认 ${values.join('/')}` }),
  };
}

/** 注册表本体。顺序即 schema 与说明的出场顺序 */
const POLICY_FIELDS: readonly PolicyField[] = [
  listField(
    'scaffold',
    '垫一格用哪些方块,顺序即优先;[] = 不垫',
    `scaffold  ["dirt","cobblestone"]   脚下没底时垫一格用哪些方块,顺序即优先。
                                   赶路、逃跑、tunnel 垫桥、塔的每一格、上露天的
                                   每一格都用这份。[] = 不垫`,
  ),
  listField(
    'light',
    '插一根用哪些;[] = 不插',
    'light     ["torch"]                周身黑下来插一根用哪些。[] = 不插',
  ),
  enumField(
    'lightWhen', LIGHT_WHENS,
    '什么场合黑了才插:dig 只在挖通道/挖空间的时候,anywhere 赶路和采集途中也插',
    `lightWhen "dig" | "anywhere"       什么场合黑了才插:dig 只在挖通道/挖空间的时候
                                   (默认),anywhere 赶路和采集途中也插`,
  ),
  enumField(
    'travel', TRAVEL_MODES,
    '赶路遇到坎是挖开还是垫过去',
    `travel    "auto" | "dig" | "place" 赶路遇到坎:auto 按代价自选,dig 能挖就不垫,
                                   place 能垫就不挖`,
  ),
  listField(
    'reserve',
    '收着不主动拿去挖的家伙什;[] = 都不收着',
    `reserve   ["iron_pickaxe"]         这几件家伙什收着,挖东西不主动拿。
                                   收着的那把是唯一挖得出掉落的时候仍然会拿。[] = 都不收着`,
  ),
  enumField(
    'fight', FIGHT_MODES,
    '怪贴到跟前主动动手的条件;挨打一律还手,这一条管不了',
    `fight     "auto" | "armed" | "off" 怪贴到跟前主动动手的条件:armed 手上有趁手的
                                   家伙才动手(默认),auto 空手也一律动手,
                                   off 不主动动手。挨打一律还手,这一条改不了。
                                   这一格重连之后回 armed,别的五格留着`,
  ),
];

/** mc_policy 的参数 schema。六格全可选:空调用 = 只回读 */
export const POLICY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: Object.fromEntries(POLICY_FIELDS.map((f) => [f.key, f.schema])),
  required: [],
};

/** mc_policy 的对外说明(独立于 mc_do 的技能表) */
export const POLICY_DOC = [
  `干活的常驻规矩,给哪个字段就改哪个,立即生效直到下次改。不排队,不占任务号。
一个字段都不给 = 只念一遍现在生效的规矩。`,
  ...POLICY_FIELDS.map((f) => f.doc),
  `方块/物品一律用英文 id(dirt、cobblestone、torch、iron_pickaxe)。
料不在包里的那一条就不做,不算受阻;做过的进收工回执报数。
回执一律念出六条当下生效的规矩,没改过的念默认值。`,
].join('\n');

/**
 * 解析对这次调用做过的改动:某一格没收下(不认的值),或某个键根本不存在。
 * 收下的那些不进这里 —— 回执念的是 `set` 之后读回来的六格,本来就说得出结果。
 */
interface PolicyNote {
  field: string;
  given: unknown;
  why: string;
}

export function policyNoteText(n: PolicyNote): string {
  return `${n.field} 写的 ${JSON.stringify(n.given)},${n.why},没收下`;
}

/**
 * 入参 → 补丁。**给哪个字段就改哪个,没给的一个字都不动**;`{}` 合法,只回读。
 *
 * 名字不校验存在性:她写 `stone_pickaxe` 还是 `stone_pick` 由包里找不找得到说了算
 * (与 `smelt.input` 同一条规矩)。
 */
export function parsePolicy(
  args: Record<string, unknown>,
): { patch: Partial<PolicySettings>; notes: PolicyNote[] } {
  const patch: Partial<PolicySettings> = {};
  const notes: PolicyNote[] = [];
  for (const f of POLICY_FIELDS) {
    const v = args[f.key];
    // null 不算「她想说什么」:模型照 schema 把用不上的字段填成 null 是常态
    if (v === undefined || v === null) continue;
    const r = f.parse(v);
    if ('why' in r) notes.push({ field: f.key, given: v, why: r.why });
    else (patch as Record<string, unknown>)[f.key] = r.value;
  }
  const known = new Set<string>(POLICY_FIELDS.map((f) => f.key));
  for (const [field, given] of Object.entries(args)) {
    if (!known.has(field) && given !== undefined && given !== null) {
      notes.push({ field, given, why: 'mc_policy 没有这一格' });
    }
  }
  return { patch, notes };
}

/** 一格的值渲染成她写得出的那个 token:名单给数组字面量,枚举给字面量 */
function valueToken(v: PolicyValue): string {
  if (v === null) return '默认';
  if (Array.isArray(v)) return v.length === 0 ? '[](关着)' : `[${v.join(',')}]`;
  return String(v);
}

/** 这一次调用真正改动的那几格,渲染成 `fight:auto→armed`;一格没动返回空数组 */
function policyDiff(before: PolicySettings, after: PolicySettings): string[] {
  const out: string[] = [];
  for (const f of POLICY_FIELDS) {
    const a = before[f.key];
    const b = after[f.key];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    out.push(`${f.key}:${valueToken(a)}→${valueToken(b)}`);
  }
  return out;
}

/** `fight` 那一格不跨重启:改了它就得当场说一句,别让她带着一条已经弹回去的规矩干活 */
const FIGHT_VOLATILE_NOTE =
  `fight 这一格不跨重启,重启会弹回 ${DEFAULT_FIGHT}(其余五格落盘,跨重启还在)。`;

/** 查询与修改使用不同回执开头；修改报告 diff，并注明未变项和不跨重启项。 */
export function renderPolicyChange(
  before: PolicySettings,
  after: PolicySettings,
  patch: Partial<PolicySettings>,
): string {
  const asked = POLICY_FIELDS.map((f) => f.key).filter((k) => patch[k] !== undefined);
  if (asked.length === 0) return '念一遍(这次一格都没给,什么都没改)。';
  const diff = policyDiff(before, after);
  const volatile = asked.includes('fight') ? FIGHT_VOLATILE_NOTE : '';
  if (diff.length === 0) {
    return `一格都没变:${asked.join('、')} 给的值与现在生效的一模一样` +
      `(${asked.map((k) => `${k}:${valueToken(after[k])}`).join(';')})。${volatile}`;
  }
  return `这次改了 ${diff.join(';')};其余 ${POLICY_FIELDS.length - diff.length} 条没动。${volatile}`;
}

function namesText(names: readonly string[]): string {
  return names.map((n) => zhName(n)).join('、');
}

/** 一份料单当下是什么:默认名单 / 关着 / 她指定的那几样 */
function listText(given: string[] | null, fallback: readonly string[]): string {
  if (given === null) return `用默认名单(${namesText(fallback)})`;
  if (given.length === 0) return '关着';
  return `只用${namesText(given)}`;
}

/** 垫脚名单与 renderPolicyEnv 使用相同过滤；被剔除的重力方块须明确报告。 */
function scaffoldText(given: string[] | null, fallback: readonly string[]): string {
  if (given !== null && given.length === 0) return '关着';
  const list = given ?? fallback;
  const usable = list.filter((n) => !isGravityBlock(n));
  const heavy = list.filter((n) => isGravityBlock(n));
  // 名单里的全被剔了:bridge 会回退到寻路器自己的默认名单,不是"不垫"
  if (usable.length === 0) {
    return `料单里${namesText(heavy)}垫下去会自己掉,一样都没收下,仍走寻路器默认名单`;
  }
  const head = given === null ? `用默认名单(${namesText(usable)})` : `只用${namesText(usable)}`;
  return heavy.length > 0 ? `${head}(${namesText(heavy)}垫下去会自己掉,不收)` : head;
}

/**
 * 垫脚名单里被开工蓝图收口的那几样,只述事实。
 *
 * 判定与哪几样收口全在 World 侧算好传进来(渲染保持纯函数)。措辞一律叫「蓝图预留」:
 * 六格里另有一格也叫 `reserve`(收着不主动拿的家伙什),两者不是一回事。
 */
function blueprintHeldText(held: readonly string[]): string {
  return `垫脚名单里${namesText(held)}正在蓝图预留中(开工的蓝图还要用),`
    + '垫一格排到最后,要动它先用 mc_blueprint 的 reserve_override。';
}

const TRAVEL_ZH: Record<TravelPrefer, string> = {
  auto: '按代价自选挖还是垫',
  dig: '能挖就不垫',
  place: '能垫就不挖',
};

const LIGHT_WHEN_ZH: Record<LightWhen, string> = {
  dig: '只在挖通道和挖空间的时候插',
  anywhere: '赶路和采集途中也插',
};

const FIGHT_ZH: Record<FightMode, string> = {
  auto: '怪贴到跟前一律动手',
  armed: '手上有趁手的家伙才主动动手,挨打照旧还手',
  off: '不主动动手,挨打照旧还手',
};

/**
 * 全量回读六项设置，未修改项显示默认值，措辞不使用第二人称。
 * combatOff 时注明 fight 不生效；blueprintHeld 列出被开工蓝图预留收口的物品。
 */
export function renderPolicy(
  s: PolicySettings,
  def: PolicyDefaults,
  combatOff = false,
  blueprintHeld: readonly string[] = [],
): string {
  const parts = [
    `垫一格${scaffoldText(s.scaffold, def.scaffold)}`,
    s.light !== null && s.light.length === 0
      ? '插一根关着(照明场合那一格用不上)'
      : `插一根${listText(s.light, def.light)},${LIGHT_WHEN_ZH[s.lightWhen]}`,
    `赶路遇坎${TRAVEL_ZH[s.travel]}`,
    s.reserve.length === 0 ? '没有收着不用的家伙什' : `${namesText(s.reserve)}收着不主动拿`,
    FIGHT_ZH[s.fight],
  ];
  if (combatOff) parts.push('战斗总开关在 WebUI 关着,主动动手这一格现在不起作用');
  // 蓝图预留是当下的现场状况,不是第七格规矩:另起一句,不混进六格那一串
  const held = blueprintHeld.length > 0 ? blueprintHeldText(blueprintHeld) : '';
  return `现在生效的规矩:${parts.join(';')}。${held}`;
}

/**
 * 环境提示词那一行:只念与默认不同的几条,全默认返回空串(一个字都不加)。
 *
 * 不需要 `PolicyDefaults`:默认名单那一档正是"与默认相同",本来就不进这一行。
 * 代理侧现读落盘文件走的也是这个函数,那边拿不到 `cfg.scaffoldBlocks`。
 */
export function renderPolicyEnv(
  s: PolicySettings,
  restored = false,
  blueprintHeld: readonly string[] = [],
): string {
  const parts: string[] = [];
  if (s.scaffold !== null) {
    // 与 bridge 一致地剔除重力方块，并报告剔除项。
    // 空名单表示禁垫；非空名单被全部剔除时，bridge 回退到寻路器默认名单。
    const usable = s.scaffold.filter((n) => !isGravityBlock(n));
    const heavy = s.scaffold.filter((n) => isGravityBlock(n));
    if (s.scaffold.length === 0) parts.push('不垫脚');
    else if (usable.length === 0) {
      parts.push(`垫脚名单里${namesText(heavy)}垫下去会自己掉,一样都没收下,垫一格仍走默认名单`);
    } else {
      parts.push(`垫一格只用${namesText(usable)}`);
      if (heavy.length > 0) parts.push(`${namesText(heavy)}垫下去会自己掉,不收`);
    }
  }
  if (s.light !== null) {
    parts.push(s.light.length === 0 ? '不插火把' : `插一根只用${namesText(s.light)}`);
  }
  if (s.lightWhen !== 'dig') parts.push(LIGHT_WHEN_ZH[s.lightWhen]);
  if (s.travel !== 'auto') parts.push(`赶路遇坎${TRAVEL_ZH[s.travel]}`);
  if (s.reserve.length > 0) parts.push(`${namesText(s.reserve)}收着不主动拿`);
  if (s.fight !== DEFAULT_FIGHT) parts.push(FIGHT_ZH[s.fight]);
  // 蓝图预留是当下现场状况,不是「与默认不同的规矩」:单独一句,六格全默认时也照说
  // (`PolicyBook` 拿这个函数判「有没有非默认项」,所以它不许把这一句算进去 —— 那一路
  // 一律不传 blueprintHeld)
  const held = blueprintHeld.length > 0 ? blueprintHeldText(blueprintHeld) : '';
  if (parts.length === 0) return held;
  // restored 表示上次运行落盘且本次尚未修改的设置；连接回执注明来源。
  return `${restored ? '上一场设下的常驻规矩还在' : '常驻规矩'}(与默认不同的几条):${parts.join(';')}。${held}`;
}

/** 读盘的结果:六格,外加这一次读盘**丢掉**的 `fight` 档(没丢就是 null) */
interface PolicyLoad {
  settings: PolicySettings;
  /** 盘上存着、而本进程按规矩不认的那一档;它是「回弹」这件事的唯一凭据 */
  droppedFight: FightMode | null;
}

/**
 * 从落盘文件加载六项设置，缺失或无效字段回默认；fight 始终回 DEFAULT_FIGHT。
 * 被丢弃的 fight 值经 droppedFight 传出，由连接回执报告回滚。
 */
export function loadPolicyReport(file: string | null): PolicyLoad {
  const out = defaultPolicy();
  if (!file || !existsSync(file)) return { settings: out, droppedFight: null };
  let data: Record<string, unknown>;
  try {
    const raw = readFileSync(file, 'utf8').trim();
    if (!raw) return { settings: out, droppedFight: null };
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { settings: out, droppedFight: null };
  }
  let droppedFight: FightMode | null = null;
  for (const f of POLICY_FIELDS) {
    // fight 重启后回配置默认值；其余五项工作方式跨重启保留。
    if (f.key === 'fight') {
      const disk = data[f.key];
      if (disk !== undefined && disk !== null) {
        const r = f.parse(disk);
        // 盘上是默认档 = 什么都没丢,不必惊动她
        if (!('why' in r) && r.value !== out.fight) droppedFight = r.value as FightMode;
      }
      continue;
    }
    const v = data[f.key];
    if (v === undefined || v === null) continue;
    const r = f.parse(v);
    if (!('why' in r)) (out as unknown as Record<string, unknown>)[f.key] = r.value;
  }
  return { settings: out, droppedFight };
}

/** 只要六格的读法;丢档信息见 `loadPolicyReport` */
export function loadPolicy(file: string | null): PolicySettings {
  return loadPolicyReport(file).settings;
}

/**
 * 回弹播报:上一进程设下的 `fight` 档没跨过重启,这一刻据实说出来。
 *
 * 措辞只陈述两件事实(原来那档是什么、现在按什么规矩转)加一句怎么改回去。
 * 不解释重启的原因 —— 那一层归闭包原则管,而且我们也未必知道是崩了还是人为关的。
 */
export function renderFightRollback(prev: FightMode): string {
  return `战斗那一格不跨重启:上次设的「${FIGHT_ZH[prev]}」已经回到默认「${FIGHT_ZH[DEFAULT_FIGHT]}」`
    + `;还要按原样打就再设一次 fight。`;
}

/**
 * 常驻规矩的持有者:进程内一份 + 落盘一份。
 *
 * 落盘的理由与容器账本同一条:进程内状态被一次崩溃重启静默清回默认,正是「隐形」
 * 那类最贵的失败。风险(重启后带着一条她不记得的规矩)由环境提示词与连入播报兜住,
 * 而代价最大的那一格(`fight`)干脆不跨重启,回弹那一刻由连入播报点名 —— 见
 * `loadPolicyReport` 与 `takeFightRollback`。
 */
export class PolicyBook {
  private s: PolicySettings;
  /** 载入时磁盘带来的非默认项至今没被动过 —— 连入播报据此点明来路 */
  private restoredFromDisk: boolean;
  /** 载入时被丢掉的 `fight` 档,等着连入播报取走(取过就清) */
  private droppedFight: FightMode | null;

  constructor(private readonly file: string | null) {
    const load = loadPolicyReport(file);
    this.s = load.settings;
    this.restoredFromDisk = renderPolicyEnv(this.s) !== '';
    this.droppedFight = load.droppedFight;
  }

  /** 现在这份非默认规矩是不是上一场留下、本场一次没改过的 */
  restored(): boolean {
    return this.restoredFromDisk;
  }

  /**
   * 一次性取走 fight 回滚通知；重连复用本对象，不重播。
   * 取走通知时才将磁盘值写回当前值，避免连入前退出导致通知丢失。
   */
  takeFightRollback(): FightMode | null {
    const prev = this.droppedFight;
    if (prev === null) return null;
    this.droppedFight = null;
    this.save();
    return prev;
  }

  get(): PolicySettings {
    return {
      ...this.s,
      scaffold: this.s.scaffold ? [...this.s.scaffold] : null,
      light: this.s.light ? [...this.s.light] : null,
      reserve: [...this.s.reserve],
    };
  }

  /** 给哪一格就改哪一格;没给的一个字都不动 */
  set(patch: Partial<PolicySettings>): void {
    this.s = { ...this.s, ...patch };
    this.restoredFromDisk = false;
    // 她自己重新拧了这一格,回弹就没什么可报的了 —— 再报只会把人绕晕
    if (patch.fight !== undefined) this.droppedFight = null;
    this.save();
  }

  stat(): string {
    const env = renderPolicyEnv(this.s);
    if (!this.file || !existsSync(this.file)) return env === '' ? '(全默认)' : '非默认(未落盘)';
    const kb = (statSync(this.file).size / 1024).toFixed(1);
    return `${env === '' ? '全默认' : '有非默认项'} / ${kb}KB`;
  }

  clear(): string {
    const wasDefault = renderPolicyEnv(this.s) === '';
    this.s = defaultPolicy();
    this.restoredFromDisk = false;
    this.droppedFight = null;
    this.save();
    return wasDefault ? '常驻规矩本来就都是默认的' : '常驻规矩已清回默认';
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(this.s)}\n`, 'utf8');
  }
}
