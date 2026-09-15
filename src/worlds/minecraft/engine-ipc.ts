/**
 * Minecraft 引擎子进程运行 Mineflayer、寻路、执行器和 World 心跳。
 * 主进程转发工具、面板及宿主调用；子进程上报日志、事件和状态缓存。
 */
import type { LogNote } from '../../core/ipc-logger.ts';
import type {
  CognitionRequest, CognitionResult, EventEnvelope, EventTag, LLMUsage, WorldConsoleDecl,
  PushOptions, TriggerMode,
} from '../../core/types.ts';
import type { MinecraftConfigSection } from './config.ts';

/** 构造引擎子进程 World 的一次性参数。 */
export interface EngineInit {
  timezone: string;
  botName: string;
  /** 账本目录 data/;null = 只在内存 */
  dataDir: string | null;
  cfg: MinecraftConfigSection;
}

/** 主 → 子:要回执的请求 */
export type EngineRequest =
  | { kind: 'init'; init: EngineInit }
  /** 主进程传入的轮序号；未知时为 null。 */
  | {
      kind: 'tool'; name: string; args: Record<string, unknown>; role: string;
      callId: string | null; round: number | null;
    }
  | { kind: 'panel'; panel: string; method: string; args: unknown[] }
  | { kind: 'storage-clear'; key: string }
  /** 投递时调用子进程登记的渲染回调；null 表示不生成事件正文。 */
  | { kind: 'render-deferred'; type: string }
  | { kind: 'shutdown' };

/** 主 → 子:单向投递 */
export type EngineCast =
  /** x-hot 配置快照(整段替换值,不换对象身份) */
  | { kind: 'config'; cfg: MinecraftConfigSection }
  /** 主进程可选宿主能力的当前状态；子进程据此提供或移除对应句柄。 */
  | { kind: 'caps'; cognition: boolean };

/** StoragePart 的可序列化描述(stat 现值随状态推送,clear 走请求) */
export interface StorageStat {
  key: string;
  label: string;
  kind: 'disk' | 'memory';
  location?: string;
  danger?: boolean;
  note?: string;
  order?: number;
  stat: string;
}

/** 子 → 主:单向通知 */
export type EngineNote =
  | LogNote
  | { kind: 'usage'; usage: LLMUsage; opts?: Parameters<import('../../core/types.ts').WorldHost['reportUsage']>[1] }
  /** 渲染回调保存在子进程；主进程登记待投递项，投递时发送 render-deferred 请求。 */
  | {
      kind: 'arm-deferred';
      type: string;
      senderKey?: string;
      meta?: Record<string, unknown>;
      tags?: readonly EventTag[];
      trigger?: TriggerMode;
    }
  | {
      kind: 'status';
      decl: Pick<WorldConsoleDecl, 'lamps' | 'badges' | 'links'>;
      storage: StorageStat[];
    };

/** 子进程调用宿主并等待结果。跨进程 drain 仅支持读取本 World 来源的事件。 */
export type HostRequest =
  | {
      kind: 'push';
      evt: Omit<EventEnvelope, 'cursor' | 'origin'> & { origin?: EventEnvelope['origin'] };
      opts?: PushOptions;
    }
  | { kind: 'drain' }
  /**
   * 主进程按 World 声明的工具名校验 req.tools。
   * 宿主能力不可用时，error 以 COGNITION_ABSENT 开头。
   */
  | { kind: 'cognition'; req: CognitionRequest };

/** host.cognition.request 的跨进程返回值。 */
export type CognitionReply = CognitionResult;

export type MainToChild =
  | { t: 'req'; id: number; req: EngineRequest }
  | { t: 'hrep'; id: number; ok: boolean; value?: unknown; error?: string }
  | { t: 'cast'; cast: EngineCast };

export type ChildToMain =
  | { t: 'rep'; id: number; ok: boolean; value?: unknown; error?: string }
  | { t: 'hreq'; id: number; req: HostRequest }
  | { t: 'note'; note: EngineNote };
