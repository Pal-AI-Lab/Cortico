/**
 * 按维度与坐标保存容器上次读取的内容，供容器选择、快照和蓝图材料统计使用。
 * 炉子另外记录槽位与预计完成时间；工作站记录放置时刻。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ItemStack } from './terrain.ts';

/** 炉子族方块名(原版三种炉子;槽位名照原版 input/fuel/output) */
export const FURNACE_BLOCKS = ['furnace', 'smoker', 'blast_furnace'] as const;

/** 箱子族方块名(能当仓库用的那些);工作台、炉子族、酿造台都不在内 */
export const CHEST_BLOCKS = ['chest', 'trapped_chest', 'barrel', 'ender_chest'] as const;

const CHEST_KINDS = new Set<string>(CHEST_BLOCKS);

/** 炉子槽位与预计完成时间的上次读数；未开窗时不持续同步。 */
interface FurnaceState {
  input: ItemStack | null;
  fuel: ItemStack | null;
  output: ItemStack | null;
  /** 下料(或最近一次读到槽位)的时刻 */
  loadedAt: number;
  /** 预计完成时间；null 表示未记录预计时间。 */
  expectedDoneAt: number | null;
  /** 到期事件已经发过,不重复发 */
  notified?: boolean;
}

export interface ChestRecord {
  x: number;
  y: number;
  z: number;
  dimension: string;
  items: ItemStack[];
  usedSlots: number;
  slots: number;
  /** 方块名;旧档案没有这个字段,读档按 chest 兜底 */
  name?: string;
  /** 我们自己放下的时刻;捡现成的没有 */
  placedAt?: number;
  /** 炉子族的三槽位;箱子族没有 */
  furnace?: FurnaceState;
}

/** 缺少 name 的记录按 chest 处理。 */
export function chestBlockName(rec: ChestRecord): string {
  return rec.name ?? 'chest';
}

/** 类别名按整词或 `_query` 后缀匹配，与 collect 共用此规则。 */
export function matchItemName(query: string, name: string): boolean {
  return name === query || name.endsWith(`_${query}`);
}

/** 物品和方块名字的注册表接口；缺失时回退到后缀匹配。 */
export interface NameRegistry {
  itemsByName?: Record<string, unknown>;
  blocksByName?: Record<string, unknown>;
}

/** 名字是否存在于当前注册表。 */
export function isRealId(reg: NameRegistry | null | undefined, name: string): boolean {
  return reg != null
    && (reg.itemsByName?.[name] !== undefined || reg.blocksByName?.[name] !== undefined);
}

/**
 * 注册表中存在的物品 id 只作精确匹配；其余查询按 `_query` 后缀匹配类别。
 * 材料选择与放置核对共用此规则。
 */
export function matchMaterialName(
  reg: NameRegistry | null | undefined,
  query: string,
  name: string,
): boolean {
  if (name === query) return true;
  if (isRealId(reg, query)) return false;
  return name.endsWith(`_${query}`);
}

function chestKey(dimension: string, p: { x: number; y: number; z: number }): string {
  return `${dimension}:${p.x},${p.y},${p.z}`;
}

/** 容量包括空槽和同种物品的未满栈；stackMax 必须取自物品注册表。 */
export function hasRoom(rec: ChestRecord, item: string, stackMax: number): boolean {
  if (rec.usedSlots < rec.slots) return true;
  return rec.items.some((i) => matchItemName(item, i.name) && i.count % stackMax !== 0);
}

export function hasItem(rec: ChestRecord, item: string): boolean {
  return rec.items.some((i) => matchItemName(item, i.name) && i.count > 0);
}

export class ChestBook {
  private readonly map = new Map<string, ChestRecord>();

  constructor(private readonly file: string | null) {
    this.load();
  }

  get(dimension: string, p: { x: number; y: number; z: number }): ChestRecord | undefined {
    return this.map.get(chestKey(dimension, p));
  }

  remember(
    dimension: string,
    p: { x: number; y: number; z: number },
    items: ItemStack[],
    usedSlots: number,
    slots: number,
  ): void {
    /** 刷新内容时保留原 placedAt。 */
    const prev = this.map.get(chestKey(dimension, p));
    const rec: ChestRecord = {
      x: p.x, y: p.y, z: p.z, dimension, items, usedSlots, slots,
      ...(prev?.name !== undefined ? { name: prev.name } : {}),
      ...(prev?.placedAt !== undefined ? { placedAt: prev.placedAt } : {}),
    };
    this.map.set(chestKey(dimension, p), rec);
    this.save();
  }

  /** 更新方块名及可选的放置时间，保留原内容记录。 */
  rememberStation(
    dimension: string,
    p: { x: number; y: number; z: number },
    name: string,
    placedAt?: number,
  ): void {
    const k = chestKey(dimension, p);
    const prev = this.map.get(k);
    this.map.set(k, {
      x: p.x, y: p.y, z: p.z, dimension,
      items: prev?.items ?? [],
      usedSlots: prev?.usedSlots ?? 0,
      slots: prev?.slots ?? 0,
      name,
      ...(placedAt !== undefined ? { placedAt } : prev?.placedAt !== undefined ? { placedAt: prev.placedAt } : {}),
      ...(prev?.furnace !== undefined ? { furnace: prev.furnace } : {}),
    });
    this.save();
  }

  /** expectedDoneAt 由调用方计算；槽位读数同步到 items。 */
  rememberFurnace(
    dimension: string,
    p: { x: number; y: number; z: number },
    name: string,
    state: { input: ItemStack | null; fuel: ItemStack | null; output: ItemStack | null },
    loadedAt: number,
    expectedDoneAt: number | null,
  ): void {
    const k = chestKey(dimension, p);
    const prev = this.map.get(k);
    const items = [state.input, state.fuel, state.output].filter((s): s is ItemStack => s !== null);
    this.map.set(k, {
      x: p.x, y: p.y, z: p.z, dimension,
      items, usedSlots: items.length, slots: 3,
      name,
      ...(prev?.placedAt !== undefined ? { placedAt: prev.placedAt } : {}),
      furnace: { ...state, loadedAt, expectedDoneAt },
    });
    this.save();
  }

  due(now: number): ChestRecord[] {
    const out: ChestRecord[] = [];
    for (const rec of this.map.values()) {
      const f = rec.furnace;
      if (f && f.expectedDoneAt !== null && f.expectedDoneAt <= now && !f.notified) out.push(rec);
    }
    return out;
  }

  markNotified(dimension: string, p: { x: number; y: number; z: number }): void {
    const rec = this.map.get(chestKey(dimension, p));
    if (!rec?.furnace || rec.furnace.notified) return;
    rec.furnace.notified = true;
    this.save();
  }

  loadedFurnaces(dimension: string): ChestRecord[] {
    const out: ChestRecord[] = [];
    for (const rec of this.map.values()) {
      const f = rec.furnace;
      if (rec.dimension !== dimension || !f) continue;
      if (f.input || f.output) out.push(rec);
    }
    return out;
  }

  /**
   * 当前维度账上的箱子族，不含炉子族与工作台。
   * 记录表示上次看见的状态，调用方须按历史读数措辞。
   */
  chestsIn(dimension: string): ChestRecord[] {
    const out: ChestRecord[] = [];
    for (const rec of this.map.values()) {
      if (rec.dimension !== dimension || rec.furnace) continue;
      if (CHEST_KINDS.has(chestBlockName(rec))) out.push(rec);
    }
    return out;
  }

  forget(dimension: string, p: { x: number; y: number; z: number }): boolean {
    const removed = this.map.delete(chestKey(dimension, p));
    if (removed) this.save();
    return removed;
  }

  inCells(dimension: string, cells: ReadonlyArray<{ x: number; y: number; z: number }>): ChestRecord[] {
    if (this.map.size === 0) return [];
    const keys = new Set(cells.map((c) => chestKey(dimension, c)));
    const out: ChestRecord[] = [];
    for (const [k, rec] of this.map) {
      if (keys.has(k)) out.push(rec);
    }
    return out;
  }

  /** 汇总当前维度容器的上次观测数量，供蓝图材料统计使用。 */
  tally(dimension: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const rec of this.map.values()) {
      if (rec.dimension !== dimension) continue;
      for (const it of rec.items) out[it.name] = (out[it.name] ?? 0) + it.count;
    }
    return out;
  }

  stat(): string {
    const n = this.map.size;
    if (!this.file || !existsSync(this.file)) return n === 0 ? '(无文件)' : `${n} 个(未落盘)`;
    const kb = (this.fileSize() / 1024).toFixed(1);
    return `${n} 个 / ${kb}KB`;
  }

  clear(): string {
    const n = this.map.size;
    this.map.clear();
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, '{}\n', 'utf8');
    }
    return n === 0 ? '容器账本是空的' : `容器账本已清空(${n} 个)`;
  }

  private fileSize(): number {
    return statSync(this.file!).size;
  }

  private load(): void {
    if (!this.file || !existsSync(this.file)) return;
    const raw = readFileSync(this.file, 'utf8').trim();
    if (!raw) return;
    const data = JSON.parse(raw) as Record<string, ChestRecord>;
    for (const [k, v] of Object.entries(data)) {
      if (typeof v?.x === 'number' && typeof v.y === 'number' && typeof v.z === 'number') {
        const f = v.furnace;
        this.map.set(k, {
          x: v.x, y: v.y, z: v.z,
          dimension: typeof v.dimension === 'string' ? v.dimension : 'overworld',
          items: Array.isArray(v.items) ? v.items : [],
          usedSlots: typeof v.usedSlots === 'number' ? v.usedSlots : 0,
          slots: typeof v.slots === 'number' ? v.slots : 27,
          ...(typeof v.name === 'string' ? { name: v.name } : {}),
          ...(typeof v.placedAt === 'number' ? { placedAt: v.placedAt } : {}),
          ...(f && typeof f === 'object' ? {
            furnace: {
              input: f.input ?? null,
              fuel: f.fuel ?? null,
              output: f.output ?? null,
              loadedAt: typeof f.loadedAt === 'number' ? f.loadedAt : 0,
              expectedDoneAt: typeof f.expectedDoneAt === 'number' ? f.expectedDoneAt : null,
              ...(f.notified === true ? { notified: true } : {}),
            },
          } : {}),
        });
      }
    }
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const obj: Record<string, ChestRecord> = {};
    for (const [k, v] of this.map) obj[k] = v;
    writeFileSync(this.file, `${JSON.stringify(obj)}\n`, 'utf8');
  }
}
/** 箱子族在世界里的扫描名单;与账本认箱子的口径同一份(见 chests.ts CHEST_BLOCKS) */
export const CONTAINER_FIND: readonly string[] = CHEST_BLOCKS;

export const FURNACE_KINDS = new Set<string>(FURNACE_BLOCKS);

