/**
 * mc_escape 的重生点解析、候选排序、传送指令和回执。
 * World 负责清空队列、发送指令与等待位置变化。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { zhDimension } from './names.ts';

export const SET_SPAWN_TRANSLATE = 'block.minecraft.set_spawn';
const NEAR_SPAWN_BLOCKS = 4;
export const ESCAPE_TP_MS = 3_000;

type SpawnSource = 'bed' | 'anchor' | 'world' | 'mark';

export interface SpawnTarget {
  x: number;
  y: number;
  z: number;
  dimension: string;
  source: SpawnSource;
  /** `mark` 的路标原名;别的来源没有名字 */
  name?: string;
}

export interface Vec3like {
  x: number;
  y: number;
  z: number;
}

export function normalizeDimension(raw: string | undefined | null): string {
  const s = (raw ?? '').trim();
  if (!s) return 'minecraft:overworld';
  return s.includes(':') ? s : `minecraft:${s}`;
}

export function spawnAt(
  pos: Vec3like,
  dimension: string | undefined | null,
  source: SpawnSource,
  name?: string,
): SpawnTarget {
  return {
    x: pos.x, y: pos.y, z: pos.z,
    dimension: normalizeDimension(dimension),
    source,
    ...(name !== undefined ? { name } : {}),
  };
}

function worldSpawnOf(pos: Vec3like | null | undefined): SpawnTarget | null {
  if (!pos) return null;
  return spawnAt(pos, 'minecraft:overworld', 'world');
}

/** 个人重生点优先;没有则世界出生点。同维度没有候选时的兜底口径。 */
export function resolveEscapeTarget(
  personal: SpawnTarget | null,
  world: Vec3like | null | undefined,
): SpawnTarget | null {
  return personal ?? worldSpawnOf(world);
}

/** 一个候选安全锚,连同它此刻的读数 */
interface EscapeCandidate {
  target: SpawnTarget;
  /** 与当前位置的水平直线距离;不同维度算不了,给 null */
  distance: number | null;
  /** 她自己圈的危险区名字(这一格落在里面);不在任何危险区里为空数组 */
  danger: readonly string[];
  /** 世界读数确认锚点或正邻格可站立；缺少判据或读数时为 null。 */
  standable: boolean | null;
  /** 世界读数确认的具体落脚格;没有确认时保留锚坐标。 */
  landing: Vec3like | null;
}

function anchorKey(t: SpawnTarget): string {
  return `${normalizeDimension(t.dimension)}:${Math.floor(t.x)},${Math.floor(t.y)},${Math.floor(t.z)}`;
}

/**
 * 安全锚按个人重生点、世界出生点、路标的顺序收集，同维度同格保留首项。
 * 同维度候选优先，明确不可站立的候选降级，其余按水平距离排序；未知可站性不降级。
 */
export function escapeCandidates(
  personal: SpawnTarget | null,
  world: Vec3like | null | undefined,
  marks: readonly SpawnTarget[],
  here: Vec3like,
  hereDimension: string,
  dangerAt?: (t: SpawnTarget) => readonly string[],
  landingAt?: (t: SpawnTarget) => Vec3like | false | null,
): EscapeCandidate[] {
  const dim = normalizeDimension(hereDimension);
  const seen = new Set<string>();
  const out: EscapeCandidate[] = [];
  for (const t of [personal, worldSpawnOf(world), ...marks]) {
    if (!t) continue;
    const key = anchorKey(t);
    if (seen.has(key)) continue;
    seen.add(key);
    const landing = landingAt?.(t) ?? null;
    out.push({
      target: t,
      distance: normalizeDimension(t.dimension) === dim
        ? Math.hypot(t.x - here.x, t.z - here.z)
        : null,
      danger: dangerAt?.(t) ?? [],
      standable: landing === null ? null : landing !== false,
      landing: landing === false ? null : landing,
    });
  }
  return out.sort((a, b) => {
    if (a.distance === null) return b.distance === null ? 0 : 1;
    if (b.distance === null) return -1;
    const aBad = a.standable === false ? 1 : 0;
    const bBad = b.standable === false ? 1 : 0;
    if (aBad !== bBad) return aBad - bBad;
    return a.distance - b.distance;
  });
}

/** 采用已排序候选中的首个同维度锚；没有同维度候选时使用个人重生点，其次世界出生点。 */
export function pickEscapeTarget(
  candidates: readonly EscapeCandidate[],
  personal: SpawnTarget | null,
  world: Vec3like | null | undefined,
): SpawnTarget | null {
  const nearest = candidates.find((c) => c.distance !== null);
  return nearest?.target ?? resolveEscapeTarget(personal, world);
}

function anchorText(t: SpawnTarget): string {
  if (t.source === 'world') return '世界出生点';
  if (t.source === 'anchor') return '重生锚';
  if (t.source === 'mark') return `你圈的「${t.name ?? '路标'}」`;
  return '床重生点';
}

/** 多个候选时报告坐标、距离、可站性及登记的危险区。 */
export function formatCandidates(
  candidates: readonly EscapeCandidate[],
  chosen: SpawnTarget | null,
): string {
  if (candidates.length < 2) return '';
  const one = (c: EscapeCandidate): string => {
    const at = `(${Math.round(c.target.x)}, ${Math.round(c.target.y)}, ${Math.round(c.target.z)})`;
    const far = c.distance === null
      ? `在${zhDimension(c.target.dimension)}`
      : `${Math.round(c.distance)} 格`;
    const danger = c.danger.length > 0 ? `,在你圈的危险区「${c.danger.join('」「')}」里` : '';
    const footing = c.standable === false ? ',落点按读数站不住人' : '';
    const mark = chosen && anchorKey(c.target) === anchorKey(chosen) ? '←去的是这个' : '';
    return `${anchorText(c.target)} ${at} ${far}${danger}${footing}${mark}`;
  };
  return `候选安全锚 ${candidates.length} 个,按远近排:${candidates.map(one).join(';')}。`;
}

export function alreadyNear(
  here: Vec3like,
  dimension: string,
  target: SpawnTarget,
  radius = NEAR_SPAWN_BLOCKS,
): boolean {
  if (normalizeDimension(dimension) !== target.dimension) return false;
  return Math.hypot(here.x - target.x, here.y - target.y, here.z - target.z) < radius;
}

export function tpLine(name: string, target: SpawnTarget): string {
  const x = Math.floor(target.x) + 0.5;
  const z = Math.floor(target.z) + 0.5;
  return `execute in ${target.dimension} run tp ${name} ${x} ${target.y} ${z}`;
}

export function playerDatPath(serverDir: string, levelName: string, uuid: string): string {
  return join(serverDir, levelName, 'playerdata', `${uuid}.dat`);
}

export function readPlayerDatFile(path: string): SpawnTarget | null {
  if (!existsSync(path)) return null;
  return parsePlayerDat(readFileSync(path));
}

/** 从 gzip 或未压缩的 player.dat 读取 Spawn*；缺少坐标时返回 null。 */
export function parsePlayerDat(buf: Buffer): SpawnTarget | null {
  const nbt = decodeRootCompound(maybeGunzip(buf));
  if (!nbt) return null;
  const x = asNumber(nbt.SpawnX);
  const y = asNumber(nbt.SpawnY);
  const z = asNumber(nbt.SpawnZ);
  if (x === null || y === null || z === null) return null;
  const dim = typeof nbt.SpawnDimension === 'string' ? nbt.SpawnDimension : 'minecraft:overworld';
  return spawnAt(
    { x, y, z },
    dim,
    normalizeDimension(dim) === 'minecraft:the_nether' ? 'anchor' : 'bed',
  );
}

function formatCleared(cleared: string | null): string {
  return cleared ?? '队列本来就是空的';
}

/** 逃生回执显示目标坐标；提供同维度出发点时附目标水平距离，传送失败时另附实测当前位置。 */
export function formatEscapeReceipt(
  kind: 'already' | 'arrived' | 'rejected',
  target: SpawnTarget,
  cleared: string | null,
  here?: Vec3like & { dimension?: string },
  from?: Vec3like & { dimension?: string },
  repeat?: string | null,
  candidates?: string | null,
): string {
  const at = `[${zhDimension(target.dimension)}] (${Math.round(target.x)}, ${Math.round(target.y)}, ${Math.round(target.z)})`;
  const place = anchorText(target);
  const queue = `${candidates ? `${candidates}` : ''}${formatCleared(cleared)}`;
  const moved = from && from.dimension
    && normalizeDimension(from.dimension) === normalizeDimension(target.dimension)
    ? `,离你出发那儿 ${Math.round(Math.hypot(target.x - from.x, target.z - from.z))} 格`
    : '';
  const again = repeat ? `${repeat}` : '';
  if (kind === 'already') return `已经在${place}附近 ${at}。${again}${queue}`;
  if (kind === 'arrived') return `已回到${place} ${at}${moved}。${again}${queue}`;
  const now = here
    ? `还在${here.dimension ? `[${zhDimension(here.dimension)}] ` : ' '}`
      + `(${Math.round(here.x)}, ${Math.round(here.y)}, ${Math.round(here.z)})。`
    : '';
  return `没能传送(服务器拒了指令,多半没有 op)。本来会把你送到${place} ${at}${moved}。${now}${again}${queue}`;
}

interface EscapeBot {
  entity: { position: Vec3like };
  game?: { dimension?: string };
  spawnPoint?: Vec3like;
}

interface EscapeDeps {
  getBot: () => EscapeBot | null;
  playerName: string;
  personalSpawn: SpawnTarget | null;
  /** 登记为家或床的安全路标；空数组时仍可使用个人重生点与世界出生点。 */
  safeMarks?: readonly SpawnTarget[];
  dangerAt?: (t: SpawnTarget) => readonly string[];
  /**
   * 返回确认能站的具体落脚格;false 表示全不可站,null 表示读不到。
   * 不可站只作排序降级键,不做硬过滤。
   */
  landingAt?: (t: SpawnTarget) => Vec3like | false | null;
  clearQueue: () => string | null;
  /** 托管服 stdin;成功返回 true,否则调用方改走 bot 聊天 */
  sendConsole: (line: string) => boolean;
  chat: (text: string) => void;
  hold: (ms: number) => void;
  waitMove: (ms: number) => Promise<boolean>;
  timeoutMs?: number;
  /** 在传送核验前记录本次选择的逃生目标并生成重复说明；无说明时可返回空串或 null。 */
  noteRepeat?: (target: SpawnTarget) => string | null;
}

export async function runEscape(deps: EscapeDeps): Promise<string> {
  const bot = deps.getBot();
  if (!bot?.entity) return '[mc_escape 失败] 未连接服务器';
  const dim = normalizeDimension(bot.game?.dimension);
  const from = {
    x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z,
    dimension: dim,
  };
  const candidates = escapeCandidates(
    deps.personalSpawn, bot.spawnPoint, deps.safeMarks ?? [], from, dim, deps.dangerAt, deps.landingAt,
  );
  const anchor = pickEscapeTarget(candidates, deps.personalSpawn, bot.spawnPoint);
  if (!anchor) return '[mc_escape 失败] 还不知道出生点,也没有圈过可以去的地方';
  const chosen = candidates.find((c) => c.target === anchor);
  const target = chosen?.landing ? { ...anchor, ...chosen.landing } : anchor;
  const chosenBad = chosen?.standable === false;
  const footing = chosenBad
    ? '所有候选落点按世界读数都站不住人(落点和它周围一格要么实心要么悬空),去的是其中最近的。'
    : '';
  const list = `${footing}${formatCandidates(candidates, anchor)}`;

  const timeoutMs = deps.timeoutMs ?? ESCAPE_TP_MS;
  deps.hold(timeoutMs + 500);
  const repeat = deps.noteRepeat?.(target) ?? null;
  const cleared = deps.clearQueue();
  const inLanding = (p: Vec3like): boolean => Math.floor(p.x) === Math.floor(target.x)
    && Math.floor(p.y) === Math.floor(target.y) && Math.floor(p.z) === Math.floor(target.z);
  if (alreadyNear(from, dim, target) && (!chosen?.landing || inLanding(from))) {
    return formatEscapeReceipt('already', target, cleared, undefined, undefined, repeat, list);
  }

  const line = tpLine(deps.playerName, target);
  const readHere = (): Vec3like & { dimension: string } => {
    const p = deps.getBot()?.entity.position ?? bot.entity.position;
    return { x: p.x, y: p.y, z: p.z, dimension: normalizeDimension(deps.getBot()?.game?.dimension ?? dim) };
  };
  const arrived = (h: Vec3like & { dimension: string }): boolean => alreadyNear(h, h.dimension, target)
    && (!chosen?.landing || inLanding(h));
  if (!deps.sendConsole(line)) deps.chat(`/${line}`);
  // 传送前刚好到的别的强制位置包(撤寻路、水里纠偏)也会触发一次;没落到目标就接着等到时限
  const deadline = Date.now() + timeoutMs;
  let here = readHere();
  while (!arrived(here)) {
    const left = deadline - Date.now();
    if (left <= 0 || !(await deps.waitMove(left))) break;
    here = readHere();
  }
  if (arrived(here)) {
    return formatEscapeReceipt('arrived', target, cleared, undefined, from, repeat, list);
  }
  return formatEscapeReceipt('rejected', target, cleared, here, from, repeat, list);
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function maybeGunzip(buf: Buffer): Buffer {
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return gunzipSync(buf);
  return buf;
}

const TAG_END = 0;
const TAG_BYTE = 1;
const TAG_SHORT = 2;
const TAG_INT = 3;
const TAG_LONG = 4;
const TAG_FLOAT = 5;
const TAG_DOUBLE = 6;
const TAG_BYTE_ARRAY = 7;
const TAG_STRING = 8;
const TAG_LIST = 9;
const TAG_COMPOUND = 10;
const TAG_INT_ARRAY = 11;
const TAG_LONG_ARRAY = 12;

class NbtCursor {
  constructor(private readonly buf: Buffer, private i = 0) {}

  u8(): number {
    if (this.i >= this.buf.length) throw new Error('nbt eof');
    return this.buf[this.i++];
  }
  i16(): number {
    const v = this.buf.readInt16BE(this.i);
    this.i += 2;
    return v;
  }
  i32(): number {
    const v = this.buf.readInt32BE(this.i);
    this.i += 4;
    return v;
  }
  f32(): number {
    const v = this.buf.readFloatBE(this.i);
    this.i += 4;
    return v;
  }
  f64(): number {
    const v = this.buf.readDoubleBE(this.i);
    this.i += 8;
    return v;
  }
  skip(n: number): void { this.i += n; }
  str(): string {
    const n = this.buf.readUInt16BE(this.i);
    this.i += 2;
    const s = this.buf.subarray(this.i, this.i + n).toString('utf8');
    this.i += n;
    return s;
  }
}

function decodeRootCompound(buf: Buffer): Record<string, number | string> | null {
  try {
    const c = new NbtCursor(buf);
    if (c.u8() !== TAG_COMPOUND) return null;
    c.str();
    return readCompound(c);
  } catch {
    return null;
  }
}

function readCompound(c: NbtCursor): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (;;) {
    const type = c.u8();
    if (type === TAG_END) return out;
    const name = c.str();
    const v = readPayload(c, type);
    if (v !== undefined) out[name] = v;
  }
}

function readPayload(c: NbtCursor, type: number): number | string | undefined {
  switch (type) {
    case TAG_BYTE: return c.u8();
    case TAG_SHORT: return c.i16();
    case TAG_INT: return c.i32();
    case TAG_LONG: c.skip(8); return undefined;
    case TAG_FLOAT: return c.f32();
    case TAG_DOUBLE: return c.f64();
    case TAG_BYTE_ARRAY: c.skip(c.i32()); return undefined;
    case TAG_STRING: return c.str();
    case TAG_LIST: {
      const inner = c.u8();
      const n = c.i32();
      for (let i = 0; i < n; i++) readPayload(c, inner);
      return undefined;
    }
    case TAG_COMPOUND: readCompound(c); return undefined;
    case TAG_INT_ARRAY: c.skip(c.i32() * 4); return undefined;
    case TAG_LONG_ARRAY: c.skip(c.i32() * 8); return undefined;
    default: throw new Error(`nbt type ${type}`);
  }
}
