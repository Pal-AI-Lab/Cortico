/** bot 的服务端控制台入口，提供存档点、统一重置和强制入梦。统一重置先回滚 Persona 工作区，再按清单顺序清除框架存储。 */
import type { StoragePart } from 'cortico/core/types.ts';
import type {
  ConsoleCheckpointEntry, ConsoleMediumStatus,
  WebAppCheckpointDeps,
} from 'cortico/web/server.ts';
import {
  pageIdFor,
  type ConsolePanelDecl,
  type ConsolePageContribution,
} from 'cortico/web/shared/console-protocol.ts';

// ---------------------------------------------------------------------------
// 面板声明
// ---------------------------------------------------------------------------

/**
 * 统一重置与强制入梦的 bot 侧接口；人格领域类型由提供方持有。
 */
export interface CortiResetDeps {
  /** `parts` 是框架提供的权威存储清单;实现决定清除范围与执行顺序。 */
  run(checkpoint: string, parts: StoragePart[]): Promise<{
    ok: boolean;
    persona: string;
    results: Array<{ key: string; ok: boolean; result: string }>;
  }>;
}

/** 手动强制"入梦→截断→唤醒"(人工操作)。 */
export interface CortiDreamDeps {
  /** 已在入梦或截断中则不重复触发,返回 ok:false 说明原因。 */
  trigger(): { ok: boolean; message: string };
}

export const CORTI_OPS_PANELS: ConsolePanelDecl[] = [
  {
    id: 'checkpoints',
    title: '存档点',
    description: 'persona/ 的 git tag。新建会先把当前改动提交进去;checkpoint0 是出厂基线。',
  },
  {
    id: 'reset',
    title: '统一重置',
    description: '回滚 persona 到某个存档点,并按序清空全部 core 存储。不可撤销的运维动作。',
  },
  {
    id: 'dream',
    title: '强制入梦',
    description: '手动触发一次交接,交接完成后梦在后台整理工作区。已在进行中不会重复触发。',
  },
];

// ---------------------------------------------------------------------------
// 返回形状(浏览器那一半 import 不到本文件,两边靠这些注释对齐)
// ---------------------------------------------------------------------------

export interface OpsApplied<S> {
  ok: true;
  result: string;
  state: S;
}

export interface OpsCheckpointsState {
  status: ConsoleMediumStatus;
  checkpoints: ConsoleCheckpointEntry[];
}

/** 重置面板要展示"到底会清掉哪些东西",所以把清单的可显示部分一起回。 */
export interface OpsStoragePart {
  key: string;
  label: string;
  kind: 'disk' | 'memory';
  location?: string;
  danger?: boolean;
  note?: string;
}

export interface OpsResetState {
  status: ConsoleMediumStatus;
  checkpoints: ConsoleCheckpointEntry[];
  parts: OpsStoragePart[];
  /** 清单齐不齐。不齐就不许按下去——半次重置比不重置危险得多。 */
  ready: boolean;
  /** `ready:false` 时的原因,原样显示 */
  reason: string | null;
}

export interface OpsResetResult {
  ok: boolean;
  persona: string;
  results: Array<{ key: string; ok: boolean; result: string }>;
}

export interface OpsDreamState {
  dreaming: boolean;
}

// ---------------------------------------------------------------------------
// 重置的存储清单闸门
// ---------------------------------------------------------------------------

/** 重置要求权威存储清单中包含 session 和 events；核查键名，不依赖条目总数。 */
const REQUIRED_PART_KEYS = ['session', 'events'];

function readiness(parts: StoragePart[]): { ready: boolean; reason: string | null } {
  const missing = REQUIRED_PART_KEYS.filter((k) => !parts.some((p) => p.key === k));
  if (missing.length === 0) return { ready: true, reason: null };
  return {
    ready: false,
    reason: `存储清单不完整（缺 ${missing.join(' / ')}），无法执行统一重置。`,
  };
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

export interface CortiOpsDeps {
  /** 这一页的名字(冒号后那截),必须等于 bot id:装配层才会把它与 Persona 自报的那半合成一页,asset key 才对得上按目录出的产物。 */
  name: string;
  label: string;
  checkpoints: WebAppCheckpointDeps;
  /** 介质状态(HEAD / 脏 / 存档点),存档点与重置两个面板都要显示 */
  status(): ConsoleMediumStatus;
  reset: CortiResetDeps;
  /**
   * 重置要清的存储清单。**bot 自己闭包持有**——`CortiResetDeps.run` 那个
   * `parts` 参数在改走控制台页之后就不该由框架回传了。
   */
  storage(): StoragePart[];
  dream: CortiDreamDeps;
  dreamState(): OpsDreamState;
}

async function runReset(deps: CortiOpsDeps, args: unknown[]): Promise<OpsResetResult> {
  const checkpoint = typeof args[0] === 'string' ? args[0].trim() : '';
  if (!checkpoint) throw new Error('缺少 checkpoint 名');
  const parts = deps.storage();
  const gate = readiness(parts);
  if (!gate.ready) throw new Error(gate.reason ?? '存储清单不完整');
  return deps.reset.run(checkpoint, parts);
}

/**
 * 一个 `persona:<name>` 贡献。**面板与浏览器扩展同进同退**:这里声明的三个局部 id
 * 就是 `bots/corti-soulmate/console/client.ts` 里 `panels` 的三个键,
 * `tests/web/persona-corti-console.test.ts` 拿两份清单对咬。
 */
export function cortiConsolePages(deps: CortiOpsDeps): ConsolePageContribution[] {
  return [{
    id: pageIdFor('persona', deps.name),
    kind: 'persona',
    label: deps.label,
    panels: CORTI_OPS_PANELS,
    invoke: async (panel: string, method: string, args: unknown[]): Promise<unknown> => {
      if (panel === 'checkpoints') {
        const state = (): OpsCheckpointsState => ({
          status: deps.status(),
          checkpoints: deps.checkpoints.list(),
        });
        switch (method) {
          case 'state':
            return state();
          case 'create': {
            const name = typeof args[0] === 'string' ? args[0].trim() : '';
            if (!name) throw new Error('缺少 checkpoint 名');
            const note = typeof args[1] === 'string' ? args[1] : '';
            return { ok: true, result: deps.checkpoints.create(name, note), state: state() };
          }
          case 'remove': {
            const name = typeof args[0] === 'string' ? args[0].trim() : '';
            if (!name) throw new Error('缺少 checkpoint 名');
            return { ok: true, result: deps.checkpoints.remove(name), state: state() };
          }
          // 存档点列表上的「回滚到此」与「统一重置」面板是同一次事务,
          // 走同一个 `runReset`——两个入口、一份实现。
          case 'rollback':
            return runReset(deps, args);
          default:
            throw new Error(`未知面板方法: ${panel}.${method}`);
        }
      }
      if (panel === 'reset') {
        if (method === 'state') {
          const parts = deps.storage();
          const gate = readiness(parts);
          const out: OpsResetState = {
            status: deps.status(),
            checkpoints: deps.checkpoints.list(),
            parts: parts.map((p) => ({
              key: p.key,
              label: p.label,
              kind: p.kind,
              ...(p.location ? { location: p.location } : {}),
              ...(p.danger ? { danger: true } : {}),
              ...(p.note ? { note: p.note } : {}),
            })),
            ready: gate.ready,
            reason: gate.reason,
          };
          return out;
        }
        if (method === 'run') return runReset(deps, args);
        throw new Error(`未知面板方法: ${panel}.${method}`);
      }
      if (panel === 'dream') {
        if (method === 'state') return deps.dreamState();
        if (method === 'trigger') {
          const out = deps.dream.trigger();
          return { ...out, state: deps.dreamState() };
        }
        throw new Error(`未知面板方法: ${panel}.${method}`);
      }
      throw new Error(`未知面板: ${panel}`);
    },
  }];
}
