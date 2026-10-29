/**
 * 持久化最近一次记录死亡的世界、死亡计数与近期死因。
 * 每日计数以部署时区 06:00 为日界；记录不同世界的死亡时重置并覆盖原账本。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { nowIso, readTextFile } from '../../core/util.ts';

/** 死亡时刻、服务端死因原文与坐标；未获取死因时为 null。 */
interface DeathFact {
  at: string;
  cause: string | null;
  /** `维度:x,y,z`(floor 口径);读不到死亡点为 null */
  cell: string | null;
}

interface DeathToll {
  /** 账本属于哪个世界;换世界时整本重置 */
  world: string;
  /** `today` 所属的那一"天"(部署时区,YYYY-MM-DD);06:00 换日,见 dayKey */
  day: string;
  today: number;
  total: number;
  /** 近期死亡记录，用于计算同日同格死亡次数。 */
  lastCauses: DeathFact[];
}


const LAST_CAUSES_CAP = 20;

const EMPTY: DeathToll = { world: '', day: '', today: 0, total: 0, lastCauses: [] };

const DAY_START_HOUR = 6;

/**
 * "今天"的键:部署时区 06:00 换日,凌晨那几个小时算前一天。
 * 日期取自把时刻整体往回拨 6 小时之后的那一天。
 */
export function dayKey(timezone: string, at: Date = new Date()): string {
  return nowIso(timezone, new Date(at.getTime() - DAY_START_HOUR * 3_600_000)).slice(0, 10);
}

/** 文件不存在、为空或格式错误时使用空记录。 */
export function loadDeaths(file: string | null): DeathToll {
  if (!file || !existsSync(file)) return { ...EMPTY };
  let data: Partial<DeathToll>;
  try {
    data = JSON.parse(readTextFile(file)) as Partial<DeathToll>;
  } catch {
    return { ...EMPTY };
  }
  return {
    world: typeof data.world === 'string' ? data.world : '',
    day: typeof data.day === 'string' ? data.day : '',
    today: typeof data.today === 'number' && data.today > 0 ? Math.floor(data.today) : 0,
    total: typeof data.total === 'number' && data.total > 0 ? Math.floor(data.total) : 0,
    lastCauses: Array.isArray(data.lastCauses)
      ? data.lastCauses
        .filter((f): f is DeathFact => !!f && typeof (f as DeathFact).at === 'string')
        .map((f) => ({
          at: f.at,
          cause: typeof f.cause === 'string' ? f.cause : null,
          cell: typeof f.cell === 'string' ? f.cell : null,
        }))
        .slice(-LAST_CAUSES_CAP)
      : [],
  };
}

/** 读数视图:跨过换日点的旧账本今天是 0,不必等下一次死亡才滚。 */
export function tollOn(toll: DeathToll, day: string): { today: number; total: number } {
  return { today: toll.day === day ? toll.today : 0, total: toll.total };
}

export class DeathBook {
  private toll: DeathToll;

  constructor(private readonly file: string | null, private readonly timezone: string) {
    this.toll = loadDeaths(file);
  }

  /**
   * 记录死亡后返回计数；世界改变时重置，跨日时 today 归零。
   * hereToday 包含本次死亡；缺少死亡坐标时为 0。
   */
  record(
    world: string,
    at: Date = new Date(),
    fact?: { cause?: string | null; cell?: string | null },
  ): { today: number; total: number; hereToday: number } {
    const day = dayKey(this.timezone, at);
    if (this.toll.world !== world) this.toll = { world, day, today: 0, total: 0, lastCauses: [] };
    if (this.toll.day !== day) this.toll = { ...this.toll, day, today: 0 };
    const cell = fact?.cell ?? null;
    const entry: DeathFact = { at: nowIso(this.timezone, at), cause: fact?.cause ?? null, cell };
    const lastCauses = [...this.toll.lastCauses, entry].slice(-LAST_CAUSES_CAP);
    this.toll = { ...this.toll, today: this.toll.today + 1, total: this.toll.total + 1, lastCauses };
    this.save();
    const hereToday = cell === null
      ? 0
      : lastCauses.filter((f) => f.cell === cell && dayKey(this.timezone, new Date(f.at)) === day).length;
    return { today: this.toll.today, total: this.toll.total, hereToday };
  }

  /** 迟到的服务端死因仅补入 15 秒内尚无死因的最近一次死亡。 */
  noteCause(cause: string, at: Date = new Date()): void {
    const last = this.toll.lastCauses[this.toll.lastCauses.length - 1];
    if (!last || last.cause !== null) return;
    if (Math.abs(at.getTime() - new Date(last.at).getTime()) > 15_000) return;
    last.cause = cause;
    this.save();
  }

  count(at: Date = new Date()): { today: number; total: number } {
    return tollOn(this.toll, dayKey(this.timezone, at));
  }

  stat(): string {
    const { today, total } = this.count();
    return total === 0 ? '(没死过)' : `今天 ${today} 次 / 累计 ${total} 次`;
  }

  clear(): string {
    const { total } = this.count();
    this.toll = { ...EMPTY, world: this.toll.world };
    this.save();
    return total === 0 ? '死亡账本本来就是空的' : `死亡账本已清空(原有 ${total} 次)`;
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(this.toll)}\n`, 'utf8');
  }
}
