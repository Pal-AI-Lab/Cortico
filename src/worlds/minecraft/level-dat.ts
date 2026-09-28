/**
 * 读取存档 level.dat 的 NBT 元数据；同时支持 gzip 压缩和未压缩内容。
 * 解析失败返回 null。存档元数据与下次启动的 server.properties 配置分别显示。
 */
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

/** 存档元数据；缺失字段为 null。 */
export interface LevelDatInfo {
  /** 存档自己记的显示名,可能与目录名不同 */
  levelName: string | null;
  /** 上次游玩时刻，Unix 毫秒。 */
  lastPlayed: number | null;
  /** 世界种子;1.16+ 在 WorldGenSettings 下 */
  seed: string | null;
  /** 0=生存 1=创造 2=冒险 3=旁观 */
  gameType: number | null;
  /** 0=和平 1=简单 2=普通 3=困难 */
  difficulty: number | null;
  hardcore: boolean | null;
  /** 存档 Version.Name 字段。 */
  version: string | null;
  /** 主世界生成器:flat / amplified / large_biomes / normal;认不出为 null */
  generator: string | null;
  /** 世界内时间(tick);/ 24000 即天数 */
  dayTime: number | null;
  /**
   * Data/GameRules 的原始字符串值；null 表示读不到，空对象表示读到但没有规则。
   * Paper/Bukkit 各维度单独存储，必须读取对应维度的 level.dat。
   */
  gameRules: Record<string, string> | null;
}

type NbtValue = number | bigint | string | NbtValue[] | { [key: string]: NbtValue };

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

class Cursor {
  private i = 0;
  constructor(private readonly buf: Buffer) {}

  u8(): number {
    if (this.i >= this.buf.length) throw new Error('nbt eof');
    return this.buf[this.i++];
  }
  i16(): number { const v = this.buf.readInt16BE(this.i); this.i += 2; return v; }
  i32(): number { const v = this.buf.readInt32BE(this.i); this.i += 4; return v; }
  i64(): bigint { const v = this.buf.readBigInt64BE(this.i); this.i += 8; return v; }
  f32(): number { const v = this.buf.readFloatBE(this.i); this.i += 4; return v; }
  f64(): number { const v = this.buf.readDoubleBE(this.i); this.i += 8; return v; }
  skip(n: number): void { this.i += n; }
  str(): string {
    const n = this.buf.readUInt16BE(this.i);
    this.i += 2;
    const s = this.buf.subarray(this.i, this.i + n).toString('utf8');
    this.i += n;
    return s;
  }
}

function readPayload(c: Cursor, type: number): NbtValue {
  switch (type) {
    case TAG_BYTE: return c.u8();
    case TAG_SHORT: return c.i16();
    case TAG_INT: return c.i32();
    case TAG_LONG: return c.i64();
    case TAG_FLOAT: return c.f32();
    case TAG_DOUBLE: return c.f64();
    case TAG_BYTE_ARRAY: { const n = c.i32(); c.skip(n); return []; }
    case TAG_STRING: return c.str();
    case TAG_LIST: {
      const inner = c.u8();
      const n = c.i32();
      const out: NbtValue[] = [];
      for (let i = 0; i < n; i++) out.push(inner === TAG_END ? 0 : readPayload(c, inner));
      return out;
    }
    case TAG_COMPOUND: return readCompound(c);
    case TAG_INT_ARRAY: { const n = c.i32(); c.skip(n * 4); return []; }
    case TAG_LONG_ARRAY: { const n = c.i32(); c.skip(n * 8); return []; }
    default: throw new Error(`nbt type ${type}`);
  }
}

function readCompound(c: Cursor): Record<string, NbtValue> {
  const out: Record<string, NbtValue> = {};
  for (;;) {
    const type = c.u8();
    if (type === TAG_END) return out;
    const name = c.str();
    out[name] = readPayload(c, type);
  }
}

function obj(v: NbtValue | undefined): Record<string, NbtValue> | null {
  return v !== undefined && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, NbtValue> : null;
}
function num(v: NbtValue | undefined): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'bigint') return Number(v);
  return null;
}
function str(v: NbtValue | undefined): string | null {
  return typeof v === 'string' ? v : null;
}

/** 生成器 → 界面词表用的短名。1.16+ 是 dimensions 下每个维度各自的 generator。 */
function generatorOf(gen: Record<string, NbtValue> | null): string | null {
  const overworld = obj(obj(gen?.dimensions)?.['minecraft:overworld']);
  const generator = obj(overworld?.generator);
  const type = str(generator?.type);
  if (type === null) return null;
  if (type.endsWith('flat')) return 'flat';
  const settings = str(generator?.settings);
  if (settings === null) return 'normal';
  return settings.replace(/^minecraft:/, '');
}

/** 只保留 GameRules 中的字符串值。 */
function gameRulesOf(rules: Record<string, NbtValue> | null): Record<string, string> | null {
  if (!rules) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(rules)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

export function parseLevelDat(buf: Buffer): LevelDatInfo | null {
  try {
    const raw = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf;
    const c = new Cursor(raw);
    if (c.u8() !== TAG_COMPOUND) return null;
    c.str();
    const data = obj(readCompound(c).Data);
    if (!data) return null;
    const gen = obj(data.WorldGenSettings);
    const seed = gen?.seed;
    const hardcore = num(data.hardcore);
    return {
      levelName: str(data.LevelName),
      lastPlayed: num(data.LastPlayed),
      seed: typeof seed === 'bigint' ? seed.toString() : num(seed) !== null ? String(num(seed)) : null,
      gameType: num(data.GameType),
      difficulty: num(data.Difficulty),
      hardcore: hardcore === null ? null : hardcore !== 0,
      version: str(obj(data.Version)?.Name),
      generator: generatorOf(gen),
      dayTime: num(data.DayTime),
      gameRules: gameRulesOf(obj(data.GameRules)),
    };
  } catch {
    return null;
  }
}

export function readLevelDat(path: string): LevelDatInfo | null {
  if (!existsSync(path)) return null;
  try {
    return parseLevelDat(readFileSync(path));
  } catch {
    return null;
  }
}

/** 存档 data/map_<id>.dat 里地图自己记的中心与维度;网络包里不带这两项 */
export interface MapDatInfo {
  xCenter: number;
  zCenter: number;
  /** 0–4:一像素 = 2^scale 格 */
  scale: number | null;
  /** minecraft:overworld / minecraft:the_nether / minecraft:the_end */
  dimension: string | null;
}

export function readMapDat(path: string): MapDatInfo | null {
  if (!existsSync(path)) return null;
  try {
    const buf = readFileSync(path);
    const raw = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf;
    const c = new Cursor(raw);
    if (c.u8() !== TAG_COMPOUND) return null;
    c.str();
    const data = obj(readCompound(c).data);
    const x = num(data?.xCenter);
    const z = num(data?.zCenter);
    if (x === null || z === null) return null;
    const dim = data?.dimension;
    return {
      xCenter: x, zCenter: z, scale: num(data?.scale),
      dimension: typeof dim === 'string' ? dim : num(dim) !== null ? ['minecraft:the_nether', 'minecraft:overworld', 'minecraft:the_end'][num(dim)! + 1] ?? null : null,
    };
  } catch {
    return null;
  }
}
