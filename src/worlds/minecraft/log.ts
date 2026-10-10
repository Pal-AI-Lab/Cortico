/**
 * Minecraft 日志保存到 data/runs/<run>/log.jsonl，area 为 worlds.minecraft。
 * 引擎子进程的日志上下文补充轮次和工具调用 ID；环形缓冲供控制台按 seq 增量读取。
 */
import type { Logger, LogLevel } from '../../core/types.ts';
import { nowIso, nullLogger, SYSTEM_TIMEZONE } from '../../core/util.ts';

type MinecraftLane =
  | 'tool'
  | 'event'
  | 'task'
  | 'skill'
  | 'craft'
  | 'inventory'
  | 'path'
  | 'body'
  | 'reflex'
  | 'combat'
  | 'link'
  | 'world';

export const LANE_ZH: Record<MinecraftLane, string> = {
  tool: '工具',
  event: '投递',
  task: '任务',
  skill: '技能',
  craft: '合成',
  inventory: '物品',
  path: '寻路',
  body: '身体',
  reflex: '反射',
  combat: '战斗',
  link: '连接',
  world: '世界',
};

const LANE_LEVEL: Record<MinecraftLane, LogLevel> = {
  tool: 'info',
  event: 'info',
  task: 'info',
  skill: 'debug',
  craft: 'debug',
  inventory: 'debug',
  path: 'debug',
  body: 'trace',
  reflex: 'info',
  combat: 'info',
  link: 'info',
  world: 'info',
};

const EVENT_LEVEL: Record<string, LogLevel> = {
  'craft/slot-in': 'trace',
  'craft/click-out': 'trace',
  'craft/items-in': 'trace',
  'craft/place-out': 'trace',
  'craft/grid-clear': 'trace',
  'craft/result-slot': 'trace',
  'craft/stateid-rewrite': 'trace',
  'path/update': 'trace',
  'reflex/drown-submerged': 'trace',
  'reflex/drown-breath': 'trace',
  'skill/dig-ground-wait': 'trace',
  'link/spectate': 'debug',
};

export function laneLevel(lane: MinecraftLane, event: string): LogLevel {
  return EVENT_LEVEL[`${lane}/${event}`] ?? LANE_LEVEL[lane];
}

interface MinecraftLogInput {
  lane: MinecraftLane;
  event: string;
  msg: string;
  /** 关联的任务号;没有归属的不填 */
  taskId?: number;
  durMs?: number;
  data?: Record<string, unknown>;
  /** 未指定时按日志类别和事件类型选择级别。 */
  level?: LogLevel;
}

export interface MinecraftLogEntry extends MinecraftLogInput {
  seq: number;
  ts: string;
}

interface MinecraftLogOptions {
  /** World 的 logger(区域 worlds.minecraft);不给就只进环形缓冲 */
  log?: Logger;
  timezone?: string;
  /** 环形缓冲容量(控制台面板读它) */
  ring?: number;
}

export class MinecraftLog {
  private readonly log: Logger;
  private readonly timezone: string;
  private readonly capacity: number;
  private ring: MinecraftLogEntry[] = [];
  private seq = 0;

  constructor(opts: MinecraftLogOptions = {}) {
    this.log = opts.log ?? nullLogger();
    this.timezone = opts.timezone ?? SYSTEM_TIMEZONE;
    this.capacity = opts.ring ?? 2_000;
  }

  write(input: MinecraftLogInput): void {
    const entry: MinecraftLogEntry = { seq: ++this.seq, ts: nowIso(this.timezone), ...input };
    this.ring.push(entry);
    if (this.ring.length > this.capacity) this.ring.splice(0, this.ring.length - this.capacity);
    this.log.child(input.lane).emit(input.level ?? laneLevel(input.lane, input.event), input.msg, {
      event: input.event,
      ...(input.taskId !== undefined ? { task: input.taskId } : {}),
      ...(input.durMs !== undefined ? { durMs: input.durMs } : {}),
      ...(input.data !== undefined ? { data: input.data } : {}),
    });
  }

  /** 面板增量轮询:seq 大于 after 的那些 */
  after(seq: number): MinecraftLogEntry[] {
    return this.ring.filter((e) => e.seq > seq);
  }

  /** 清空缓冲;序号继续往下走,面板的 after 游标不会因清空而回头 */
  clear(): string {
    const had = this.ring.length;
    this.ring = [];
    return `面板缓冲已清空(${had} 条);落盘的运行日志不受影响`;
  }
}
