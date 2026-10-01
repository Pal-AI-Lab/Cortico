/**
 * 按维度与坐标持久化已完成成果，跨任务保留。
 * 寻路禁止在登记格头顶垫脚、也不挖登记格；显式挖掘与放置仍执行，并在回执中报告涉及的成果数量。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 登记的三类。`blueprint` 是完工蓝图占的格,`farmland` 是锄成的耕地,`crop` 是种下的作物 */
type WorkKind = 'blueprint' | 'farmland' | 'crop';

const WORK_KIND_ZH: Record<WorkKind, string> = {
  blueprint: '建成的蓝图', farmland: '耕地', crop: '作物',
};

interface WorkCell {
  kind: WorkKind;
  /** 登记那一刻这一格是什么(蓝图记材料名、耕地记 farmland、作物记作物方块名) */
  block: string;
  /** 蓝图记图名,别的为 null */
  site: string | null;
  /** 登记时刻(epoch ms) */
  at: number;
}

/** 落盘形状:维度 → "x,y,z" → 一格 */
type WorksFile = Record<string, Record<string, WorkCell>>;

const WORK_KINDS = new Set<string>(['blueprint', 'farmland', 'crop']);

export function cellKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

function parseFile(raw: string): WorksFile {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof data !== 'object' || data === null) return {};
  const out: WorksFile = {};
  for (const [dim, cells] of Object.entries(data as Record<string, unknown>)) {
    if (typeof cells !== 'object' || cells === null) continue;
    const kept: Record<string, WorkCell> = {};
    for (const [key, v] of Object.entries(cells as Record<string, unknown>)) {
      const c = v as Partial<WorkCell>;
      if (!WORK_KINDS.has(String(c.kind)) || typeof c.block !== 'string') continue;
      kept[key] = {
        kind: c.kind as WorkKind,
        block: c.block,
        site: typeof c.site === 'string' ? c.site : null,
        at: typeof c.at === 'number' ? c.at : 0,
      };
    }
    if (Object.keys(kept).length > 0) out[dim] = kept;
  }
  return out;
}

export function loadWorks(file: string | null): WorksFile {
  if (!file || !existsSync(file)) return {};
  try {
    const raw = readFileSync(file, 'utf8').trim();
    return raw ? parseFile(raw) : {};
  } catch {
    return {};
  }
}

export interface WorkHit extends WorkCell {
  x: number;
  y: number;
  z: number;
}

export class WorksBook {
  private works: WorksFile;

  constructor(private readonly file: string | null) {
    this.works = loadWorks(file);
  }

  /** 登记一格。同一格重登(耕地被踩回去又锄一遍)覆盖旧的,时刻跟着刷新 */
  note(dimension: string, x: number, y: number, z: number, cell: Omit<WorkCell, 'at'>, now = Date.now()): void {
    const dim = (this.works[dimension] ??= {});
    dim[cellKey(x, y, z)] = { ...cell, at: now };
    this.save();
  }

  /** 一批一起登记(蓝图完工):只落一次盘 */
  noteMany(
    dimension: string,
    cells: ReadonlyArray<{ x: number; y: number; z: number } & Omit<WorkCell, 'at'>>,
    now = Date.now(),
  ): void {
    if (cells.length === 0) return;
    const dim = (this.works[dimension] ??= {});
    for (const c of cells) {
      dim[cellKey(c.x, c.y, c.z)] = { kind: c.kind, block: c.block, site: c.site, at: now };
    }
    this.save();
  }

  at(dimension: string, x: number, y: number, z: number): WorkCell | null {
    return this.works[dimension]?.[cellKey(x, y, z)] ?? null;
  }

  has(dimension: string, x: number, y: number, z: number): boolean {
    return this.at(dimension, x, y, z) !== null;
  }

  /** 这一批格子里哪些在登记上;按传入顺序返回 */
  inCells(
    dimension: string,
    cells: ReadonlyArray<{ x: number; y: number; z: number }>,
  ): WorkHit[] {
    const dim = this.works[dimension];
    if (!dim) return [];
    const out: WorkHit[] = [];
    for (const c of cells) {
      const hit = dim[cellKey(c.x, c.y, c.z)];
      if (hit) out.push({ ...hit, x: c.x, y: c.y, z: c.z });
    }
    return out;
  }

  /** 撤销一格的登记:她把它拆了/挖了,登记不该留着骗下一次 */
  forget(dimension: string, x: number, y: number, z: number): void {
    const dim = this.works[dimension];
    if (!dim?.[cellKey(x, y, z)]) return;
    delete dim[cellKey(x, y, z)];
    if (Object.keys(dim).length === 0) delete this.works[dimension];
    this.save();
  }

  count(dimension?: string): number {
    if (dimension !== undefined) return Object.keys(this.works[dimension] ?? {}).length;
    return Object.values(this.works).reduce((n, d) => n + Object.keys(d).length, 0);
  }

  stat(): string {
    const n = this.count();
    if (!this.file || !existsSync(this.file)) return n === 0 ? '(无文件)' : `${n} 格(未落盘)`;
    const kb = (statSync(this.file).size / 1024).toFixed(1);
    return `${n} 格 / ${kb}KB`;
  }

  clear(): string {
    const n = this.count();
    this.works = {};
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, '{}\n', 'utf8');
    }
    return n === 0 ? '成果登记是空的' : `成果登记已清空(${n} 格)`;
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(this.works)}\n`, 'utf8');
  }
}

/**
 * 「这一框里有你 N 格登记的耕地/作物」那句。按类别合并计数,各报最早那一笔的时刻;
 * 一格都没有返回 null(不出这一行)。
 */
export function worksNote(hits: readonly WorkHit[], clock: (ms: number) => string): string | null {
  if (hits.length === 0) return null;
  const byKind = new Map<WorkKind, { n: number; at: number }>();
  for (const h of hits) {
    const cur = byKind.get(h.kind);
    if (cur) { cur.n++; cur.at = Math.min(cur.at, h.at); } else byKind.set(h.kind, { n: 1, at: h.at });
  }
  const bits = [...byKind].map(([kind, v]) => `${v.n} 格${WORK_KIND_ZH[kind]}(记于 ${clock(v.at)})`);
  return `这一框里有你${bits.join('、')}`;
}
