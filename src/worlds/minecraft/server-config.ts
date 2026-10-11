/** 读取和写入 server.properties，列出存档及其 level.dat 元数据。生成参数仅用于生成区块，不重新生成已有区块。 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { readLevelDat, type LevelDatInfo } from './level-dat.ts';
import { offlineUuid } from './client-launch.ts';
import type { Language } from '../../core/language.ts';
import { text } from './strings.ts';

export const GAMEMODES = ['survival', 'creative', 'adventure', 'spectator'] as const;
export const DIFFICULTIES = ['peaceful', 'easy', 'normal', 'hard'] as const;
const LEVEL_TYPES = [
  'minecraft:normal',
  'minecraft:flat',
  'minecraft:large_biomes',
  'minecraft:amplified',
  'minecraft:single_biome_surface',
] as const;

type Gamemode = (typeof GAMEMODES)[number];
export type Difficulty = (typeof DIFFICULTIES)[number];
export type LevelType = (typeof LEVEL_TYPES)[number];

/** 世界类型的选项表;措辞随界面语言。 */
export function levelTypeLabels(language: Language): Array<{ value: LevelType; label: string; note: string }> {
  const t = text(language).levelTypes;
  return LEVEL_TYPES.map((value) => ({ value, ...t[value] }));
}

export function levelTypeLabel(type: LevelType, language: Language): string {
  return levelTypeLabels(language).find((t) => t.value === type)?.label ?? type;
}

/** 超平坦预设的方块层和结构参数。 */
const FLAT_PRESET_LAYERS = {
  classic: '{"layers":[{"block":"minecraft:bedrock","height":1},{"block":"minecraft:dirt","height":2},'
    + '{"block":"minecraft:grass_block","height":1}],"biome":"minecraft:plains"}',
  void: '{"layers":[{"block":"minecraft:air","height":1}],"biome":"minecraft:the_void"}',
  tunnelers: '{"layers":[{"block":"minecraft:bedrock","height":1},{"block":"minecraft:stone","height":230}],'
    + '"biome":"minecraft:windswept_hills"}',
  minable: '{"layers":[{"block":"minecraft:bedrock","height":1},{"block":"minecraft:stone","height":59},'
    + '{"block":"minecraft:dirt","height":3},{"block":"minecraft:grass_block","height":1}],'
    + '"biome":"minecraft:plains"}',
} as const;

/** 超平坦预设的选项表;措辞随界面语言,配方各语言一致。 */
export function flatPresets(language: Language): Array<{ id: string; label: string; note: string; json: string }> {
  const t = text(language).flatPresets;
  return (Object.keys(FLAT_PRESET_LAYERS) as Array<keyof typeof FLAT_PRESET_LAYERS>)
    .map((id) => ({ id, ...t[id], json: FLAT_PRESET_LAYERS[id] }));
}

export interface GameSettings {
  gamemode: Gamemode;
  difficulty: Difficulty;
  hardcore: boolean;
  pvp: boolean;
  spawnMonsters: boolean;
  levelSeed: string;
  /** 当前存档目录名 */
  levelName: string;
  levelType: LevelType;
  /** 生成器细则(超平坦层配方 / 单群系名);空 = 该类型的默认 */
  generatorSettings: string;
  /** 村庄、神殿、要塞这些结构 */
  generateStructures: boolean;
  allowNether: boolean;
  /** 出生点保护半径(格);0 = 不保护 */
  spawnProtection: number;
  viewDistance: number;
  simulationDistance: number;
  /** 世界边界半径(格) */
  maxWorldSize: number;
}

export interface WorldInfo {
  name: string;
  generated: boolean;
  modified: string | null;
  sizeBytes: number;
  /** 已生成的附属维度:nether / the_end */
  dimensions: string[];
  info: LevelDatInfo | null;
}

/** 一行 properties:注释与空行原样留着 */
type Line = { kind: 'raw'; text: string } | { kind: 'pair'; key: string; value: string };

export function parseProperties(text: string): Line[] {
  return text.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) return { kind: 'raw', text: line };
    const eq = line.indexOf('=');
    if (eq < 0) return { kind: 'raw', text: line };
    return { kind: 'pair', key: line.slice(0, eq).trim(), value: line.slice(eq + 1) };
  });
}

export function stringifyProperties(lines: Line[]): string {
  return lines.map((l) => (l.kind === 'raw' ? l.text : `${l.key}=${l.value}`)).join('\n');
}

export function readProperty(lines: Line[], key: string): string | null {
  for (const l of lines) if (l.kind === 'pair' && l.key === key) return l.value;
  return null;
}

/** 就地改;没有这个键就追加在末尾 */
export function writeProperty(lines: Line[], key: string, value: string): Line[] {
  const escaped = value.replace(/\\/g, '\\\\').replace(/[\r\n]/g, ' ');
  let hit = false;
  const out = lines.map((l) => {
    if (l.kind === 'pair' && l.key === key) { hit = true; return { kind: 'pair' as const, key, value: escaped }; }
    return l;
  });
  if (!hit) out.push({ kind: 'pair', key, value: escaped });
  return out;
}

function pickEnum<T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T {
  const v = (raw ?? '').trim().toLowerCase();
  return (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function pickBool(raw: string | null, fallback: boolean): boolean {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return fallback;
}

function pickInt(raw: string | null, fallback: number, lo: number, hi: number): number {
  const n = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/** 1.19 之前 level-type 是不带命名空间的短名(flat / largeBiomes);两种写法都收 */
function pickLevelType(raw: string | null): LevelType {
  const v = (raw ?? '').trim();
  const short = v.includes(':') ? v.slice(v.indexOf(':') + 1) : v;
  const id = `minecraft:${short.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}`;
  const legacy: Record<string, LevelType> = { 'minecraft:default': 'minecraft:normal' };
  const resolved = legacy[id] ?? id;
  return (LEVEL_TYPES as readonly string[]).includes(resolved) ? (resolved as LevelType) : 'minecraft:normal';
}

export function settingsFrom(lines: Line[]): GameSettings {
  return {
    gamemode: pickEnum(readProperty(lines, 'gamemode'), GAMEMODES, 'survival'),
    difficulty: pickEnum(readProperty(lines, 'difficulty'), DIFFICULTIES, 'easy'),
    hardcore: pickBool(readProperty(lines, 'hardcore'), false),
    pvp: pickBool(readProperty(lines, 'pvp'), true),
    spawnMonsters: pickBool(readProperty(lines, 'spawn-monsters'), true),
    levelSeed: (readProperty(lines, 'level-seed') ?? '').trim(),
    levelName: (readProperty(lines, 'level-name') ?? 'world').trim() || 'world',
    levelType: pickLevelType(readProperty(lines, 'level-type')),
    generatorSettings: (readProperty(lines, 'generator-settings') ?? '').trim(),
    generateStructures: pickBool(readProperty(lines, 'generate-structures'), true),
    allowNether: pickBool(readProperty(lines, 'allow-nether'), true),
    spawnProtection: pickInt(readProperty(lines, 'spawn-protection'), 16, 0, 512),
    viewDistance: pickInt(readProperty(lines, 'view-distance'), 10, 2, 32),
    simulationDistance: pickInt(readProperty(lines, 'simulation-distance'), 10, 2, 32),
    maxWorldSize: pickInt(readProperty(lines, 'max-world-size'), 29_999_984, 1, 29_999_984),
  };
}

export function applySettings(lines: Line[], patch: Partial<GameSettings>): Line[] {
  let out = lines;
  const set = (key: string, value: string | number | boolean | undefined): void => {
    if (value !== undefined) out = writeProperty(out, key, String(value));
  };
  set('gamemode', patch.gamemode);
  set('difficulty', patch.difficulty);
  set('hardcore', patch.hardcore);
  set('pvp', patch.pvp);
  set('spawn-monsters', patch.spawnMonsters);
  set('level-seed', patch.levelSeed);
  set('level-name', patch.levelName);
  set('level-type', patch.levelType);
  set('generator-settings', patch.generatorSettings);
  set('generate-structures', patch.generateStructures);
  set('allow-nether', patch.allowNether);
  set('spawn-protection', patch.spawnProtection);
  set('view-distance', patch.viewDistance);
  set('simulation-distance', patch.simulationDistance);
  set('max-world-size', patch.maxWorldSize);
  return out;
}

/** 存档名用作目录名;拒绝路径分隔符、相对路径和 Windows 保留名称。 */
export function validWorldName(name: string, language: Language = 'zh'): string | null {
  const t = text(language);
  const n = name.trim();
  if (!n) return t.nameEmpty;
  if (n.length > 64) return t.nameTooLong;
  if (/[\\/:*?"<>|]/.test(n)) return t.nameBadChars;
  if (n === '.' || n === '..') return t.nameReserved;
  return null;
}

export function validGeneratorSettings(settings: string, language: Language = 'zh'): string | null {
  const t = settings.trim();
  if (!t) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch (err) {
    return text(language).genNotJson((err as Error).message);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return text(language).genNotObject;
  }
  return null;
}

/** Paper/Bukkit 把下界与末地拆成独立目录,它们不是可选的存档 */
const DIMENSION_SUFFIX = /_(nether|the_end)$/;

const sizeCache = new Map<string, { stamp: number; size: number }>();

function dirSize(dir: string, budget: { left: number }): number {
  let total = 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (budget.left-- <= 0) return total;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(abs, budget);
    else {
      try { total += statSync(abs).size; } catch {  }
    }
  }
  return total;
}

function worldSize(serverDir: string, name: string, stamp: number): number {
  const key = join(serverDir, name);
  const hit = sizeCache.get(key);
  if (hit && hit.stamp === stamp) return hit.size;
  const budget = { left: 200_000 };
  let size = dirSize(key, budget);
  for (const suffix of ['_nether', '_the_end']) {
    const dim = join(serverDir, `${name}${suffix}`);
    if (existsSync(dim)) size += dirSize(dim, budget);
  }
  sizeCache.set(key, { stamp, size });
  return size;
}

/** serverDir 下的存档目录:有 level.dat 的算已生成,最近活跃的排在前面 */
export function listWorlds(serverDir: string, current: string): WorldInfo[] {
  const found = new Map<string, WorldInfo>();
  if (serverDir && existsSync(serverDir)) {
    const names = new Set<string>();
    for (const entry of readdirSync(serverDir, { withFileTypes: true })) {
      if (entry.isDirectory()) names.add(entry.name);
    }
    for (const name of names) {
      if (DIMENSION_SUFFIX.test(name)) continue;
      const dat = join(serverDir, name, 'level.dat');
      if (!existsSync(dat)) continue;
      const mtime = statSync(dat).mtimeMs;
      const info = readLevelDat(dat);
      found.set(name, {
        name,
        generated: true,
        /** 优先使用 LastPlayed；缺失时使用 level.dat 的修改时间。 */
        modified: new Date(info?.lastPlayed || mtime).toISOString(),
        sizeBytes: worldSize(serverDir, name, mtime),
        dimensions: ['nether', 'the_end'].filter((d) => names.has(`${name}_${d}`)),
        info,
      });
    }
  }
  if (current && !found.has(current)) {
    found.set(current, {
      name: current, generated: false, modified: null, sizeBytes: 0, dimensions: [], info: null,
    });
  }
  return [...found.values()].sort((a, b) => {
    const at = a.modified ? Date.parse(a.modified) : -1;
    const bt = b.modified ? Date.parse(b.modified) : -1;
    return bt - at || a.name.localeCompare(b.name);
  });
}

function propertiesPath(serverDir: string): string {
  return join(serverDir, 'server.properties');
}

export function loadProperties(serverDir: string): Line[] {
  const file = propertiesPath(serverDir);
  return existsSync(file) ? parseProperties(readFileSync(file, 'utf8')) : [];
}

export function saveProperties(serverDir: string, lines: Line[]): void {
  writeFileSync(propertiesPath(serverDir), stringifyProperties(lines), 'utf8');
}

/** 存档身份决定目标、路标和施工绑定所属的 realm。 */
export interface WorldIdentity {
  key: string;
  local: boolean;
}

export function worldIdentityOf(serverDir: string, address: string): WorldIdentity {
  if (serverDir && existsSync(serverDir)) {
    try {
      const name = settingsFrom(loadProperties(serverDir)).levelName;
      if (name) return { key: name, local: true };
    } catch { /* 配置缺损:退回地址 */ }
  }
  return { key: address, local: false };
}

/** 环境提示词中的存档或服务器身份。 */
export function worldEnvLine(world: WorldIdentity): string {
  return world.local ? `当前存档:「${world.key}」` : `当前服务器:${world.key}`;
}

// ---------------------------------------------------------------------------
// 权限与作弊:ops.json 与那几项决定"谁能下命令"的 properties
// ---------------------------------------------------------------------------

/** 写入 ops.json 中的操作员权限；运行中另发送 op/deop 指令。 */
export interface AccessSettings {
  opPermissionLevel: number;
  /** 命令方块能不能用 */
  enableCommandBlock: boolean;
  /** 创造/旁观之外的飞行不被踢 */
  allowFlight: boolean;
  /** online-mode=true 时服务器会验证账户，离线账户无法通过验证。 */
  onlineMode: boolean;
  /** 开启白名单时，账户还需列入白名单。 */
  whiteList: boolean;
}

export function accessFrom(lines: Line[]): AccessSettings {
  return {
    opPermissionLevel: pickInt(readProperty(lines, 'op-permission-level'), 4, 1, 4),
    enableCommandBlock: pickBool(readProperty(lines, 'enable-command-block'), false),
    allowFlight: pickBool(readProperty(lines, 'allow-flight'), false),
    onlineMode: pickBool(readProperty(lines, 'online-mode'), true),
    whiteList: pickBool(readProperty(lines, 'white-list'), false),
  };
}

export function applyAccess(lines: Line[], patch: Partial<AccessSettings>): Line[] {
  let out = lines;
  const set = (key: string, value: string | number | boolean | undefined): void => {
    if (value !== undefined) out = writeProperty(out, key, String(value));
  };
  set('op-permission-level', patch.opPermissionLevel);
  set('enable-command-block', patch.enableCommandBlock);
  set('allow-flight', patch.allowFlight);
  set('online-mode', patch.onlineMode);
  set('white-list', patch.whiteList);
  return out;
}

interface OpEntry {
  uuid: string;
  name: string;
  level: number;
  bypassesPlayerLimit: boolean;
}

function opsPath(serverDir: string): string {
  return join(serverDir, 'ops.json');
}

export function readOps(serverDir: string): OpEntry[] {
  const file = opsPath(serverDir);
  if (!serverDir || !existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is OpEntry => typeof e === 'object' && e !== null && 'name' in e);
  } catch {
    return [];
  }
}

export function writeOps(serverDir: string, ops: OpEntry[]): void {
  writeFileSync(opsPath(serverDir), `${JSON.stringify(ops, null, 2)}\n`, 'utf8');
}

/** 优先采用 usercache.json 中的 UUID；缺失时按区分大小写的账户名计算离线 UUID。 */
export function resolveUuid(serverDir: string, name: string): string {
  const file = join(serverDir, 'usercache.json');
  if (serverDir && existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) {
        const hit = parsed.find(
          (e) => typeof e === 'object' && e !== null && (e as { name?: unknown }).name === name,
        ) as { uuid?: unknown } | undefined;
        if (typeof hit?.uuid === 'string') return hit.uuid;
      }
    } catch {
      /* 缓存读坏了就算离线 UUID */
    }
  }
  return offlineUuid(name);
}

/** 名单里已有这个名字的那条(按 uuid 或原样的名字认) */
function findOp(ops: OpEntry[], name: string, uuid: string): OpEntry | undefined {
  return ops.find((e) => e.uuid === uuid || e.name === name);
}

export function isOp(ops: OpEntry[], serverDir: string, name: string): OpEntry | undefined {
  return findOp(ops, name, resolveUuid(serverDir, name));
}

export function grantOp(
  ops: OpEntry[], serverDir: string, name: string, level = 4,
): { ops: OpEntry[]; changed: boolean } {
  const uuid = resolveUuid(serverDir, name);
  const hit = findOp(ops, name, uuid);
  if (hit) {
    if (hit.level >= level) return { ops, changed: false };
    return { ops: ops.map((e) => (e === hit ? { ...e, level } : e)), changed: true };
  }
  return { ops: [...ops, { uuid, name, level, bypassesPlayerLimit: false }], changed: true };
}

export function revokeOp(ops: OpEntry[], serverDir: string, name: string): { ops: OpEntry[]; changed: boolean } {
  const uuid = resolveUuid(serverDir, name);
  const rest = ops.filter((e) => e.uuid !== uuid && e.name !== name);
  return { ops: rest, changed: rest.length !== ops.length };
}

/** 仅在服务器停止时直接修改这些文件。 */
export function ensureOps(serverDir: string, names: readonly string[], level = 4): string[] {
  if (!serverDir || !existsSync(serverDir)) return [];
  let ops = readOps(serverDir);
  const added: string[] = [];
  for (const name of names) {
    if (!name.trim()) continue;
    const next = grantOp(ops, serverDir, name, level);
    if (next.changed) added.push(name);
    ops = next.ops;
  }
  if (added.length) writeOps(serverDir, ops);
  return added;
}
