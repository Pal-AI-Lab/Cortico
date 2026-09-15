/** 装配 Core、Persona、World 与控制台；具体 bot 的配置和行为由 BotDefinition 提供。 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import type {
  ConfigGroup,
  CoreConfig,
  World,
  Logger,
  WorldLifecycleEvent,
  WorldPanelDecl,
  Persona,
  PromptDocDecl,
  ShutdownExternalCheck,
  ToolSchema,
} from './core/types.ts';
import type { LoadedConfig } from './core/config.ts';
import { coreConfigGroup } from './core/config.ts';
import { pick, resolveLanguage, type Language } from './core/language.ts';
import { updateJsonObject } from './config-file.ts';
import { isSupervised, requestRestart } from './boot.ts';
import { ExtensionManager, type ExtensionSet } from './extensions.ts';
import { WorldAssembly, type WorldDefinition, type WorldDeclaration, type WorldSection } from './world.ts';
import { Core, type WorldStopFailure } from './core/core.ts';
import { RESERVED_FRAME_NAMES } from './core/loop.ts';
import type { ResponseClient } from './core/generation.ts';
import { acquireInstanceLock, type InstanceLock } from './core/instance-lock.ts';
import { assembleSystemSegments, envPromptOverridePath, envPromptTemplateSource, renderWorldEnvPrompt, type EnvPromptDirs, type EnvPromptOrigin } from './core/prefix.ts';
import { aggregateUsage } from './core/cost.ts';
import { nowIso, withDeadline } from './core/util.ts';
import { closeRun } from './core/run.ts';
import { ProviderSettings } from './providers/console/settings.ts';
import { providerModules } from './providers/registry.ts';
import { readGroupValues, setByPath as setConfigPath } from './core/config-schema.ts';
import type { ConfigValues } from './core/config-schema.ts';
import {
  PromptRevisionConflict,
  WebApp,
  type ConsoleWorldInfo,
  type WorldInfo,
  type PromptDocument,
  type StoragePart,
  type ToolOwner,
  type WebAppPromptDeps,
} from './web/server.ts';
import type { ConsolePageSource } from './web/console-pages.ts';
import {
  pageIdFor,
  type ConsolePageContribution,
} from './web/shared/console-protocol.ts';

/** 启动器使用的 bot 包装配契约。 */
export interface BotDefinition<C extends CoreConfig = CoreConfig> {
  /** 目录名以外的稳定标识,用于日志与控制台标题 */
  id: string;
  /** 一句话说明,启动器列表里显示 */
  description?: string;
  /** 框架默认值与 Persona 默认值；World 默认段由 withWorlds() 补充。 */
  defaults(): C;
  /** 由 withWorlds() 注入的内建及扩展 World 定义；按 worlds.<id>.enabled 挂载。 */
  worlds?: readonly WorldDefinition<WorldSection>[];
  /** 默认启用的 World id；缺失实现时显示不可用。对象声明可附缺失原因，未声明的 World 默认关闭。 */
  declares?: readonly WorldDeclaration[];
  /** 配置已完成合并；worlds 与 Core 共用数组，激活和停用会就地更新，Persona 应在使用时读取。 */
  build(loaded: LoadedConfig<C>, worlds: World[]): BotParts<C>;
}

export interface BotStartContext<C extends CoreConfig> {
  core: Core<C>;
  loaded: LoadedConfig<C>;
  /** 控制台实际监听的端口;不起控制台时为 null */
  port: number | null;
}

export interface BotParts<C extends CoreConfig = CoreConfig> {
  persona: Persona;
  /** 预建实例替换同 id 的定义实例，初始挂载；重启复用该实例，停用后不能通过 activate 重新挂载。 */
  worlds?: World[];
  llm?: ResponseClient;
  console?: ConsoleContribution;
  onStart?(ctx: BotStartContext<C>): void | Promise<void>;
  onStop?(): void | Promise<void>;
}

/** bot 提供的控制台声明，补充 Core 与 World 的通用页面。 */
export interface ConsoleContribution {
  /** false = 完全不起控制台(无头运行) */
  enabled?: boolean;
  /** 追加的可清除存储项。 */
  storage?: StoragePart[];
  /** 追加的可调配置组(Persona那组;core 与各 World 的由框架收拢) */
  configGroups?: ConfigGroup[];
  /** 动态下拉选项；固定选项的文案使用请求语言。 */
  configOptions?(kind: string, language: Language): Array<{ value: string; label: string }>;
  /** 合并进状态快照的实现特有字段(框架给的基础字段在前,这里覆盖) */
  status?(): Record<string, unknown>;
  /** 以 persona 作用域展示的提示词文件，框架负责读写。 */
  promptDocs?: PromptDocDecl[];
  /**
   * 非主循环 session 的额外工具 schema。
   * 每个 session 的声明方负责在此补充其工具。
   */
  extraToolSchemas?(): ToolSchema[];
  /** 需要部署配置或跨模块操作的控制台页；Persona.console() 声明 Persona 自身的操作。 */
  consolePages?(ctx: ConsolePageBuildContext): ConsolePageContribution[];
}

/** 装配层向 bot 控制台声明函数提供的共享数据。 */
export interface ConsolePageBuildContext {
  /** 与 /api/storage 共用同一批对象的存储清单，文案使用请求语言。 */
  storage: readonly StoragePart[];
  /** 发起这次请求的浏览器的界面语言。 */
  language: Language;
}

/** 关机步骤；ok=false 时 detail 说明异常或超时。 */
export interface ShutdownStep {
  key: string;
  label: string;
  ok: boolean;
  elapsedMs: number;
  detail?: string;
}

/** complete 要求本地关机步骤完成且外部状态核验通过。 */
export interface ShutdownReport {
  reason: string;
  localComplete: boolean;
  complete: boolean;
  steps: ShutdownStep[];
  externalChecks: ShutdownExternalCheck[];
}

export interface Bot<C extends CoreConfig = CoreConfig> {
  core: Core<C>;
  parts: BotParts<C>;
  /** World 槽位表:挂载表、未激活槽位与缺失声明。 */
  assembly: WorldAssembly;
  webApp: WebApp | null;
  /** 启动全部;返回控制台端口(未起控制台=null) */
  start(): Promise<{ port: number | null }>;
  stop(): Promise<void>;
  /** 分步关机并返回结果。步骤失败或超时后继续，不调用 process.exit。 */
  shutdown(reason?: string): Promise<ShutdownReport>;
}

/** 分步上限合计 33 秒；每一步超时只推进编排，不会取消外部 promise。 */
const SHUTDOWN_BUDGET_MS = {
  pause: 2_000,
  worlds: 22_000,
  core: 1_000,
  llm: 3_000,
  flush: 2_000,
  web: 3_000,
} as const;

const BOT_TEXT = {
  zh: {
    noFile: '(无文件)',
    storage: {
      events: {
        label: '事件库(本次运行的分片)',
        note: '清除本次运行的事件记录，保留此前运行的记录；游标不回退',
        stat: (count: number, cursor: number, size: string) => `${count}条(游标至 ${cursor}) / ${size}`,
        cleared: (n: number) => `已清除本次运行的${n}条事件`,
      },
      session: {
        label: '主session(当前对话上下文)',
        note: '清除对话上下文并重新开场，保留 Memory 和事件库。建议在空闲时操作',
        stat: (records: number, ktok: number, size: string) => `${records}条 / ~${ktok}k tok / ${size}`,
        cleared: 'session已清空重开(system前缀+开场消息)',
      },
      runlog: {
        label: '运行日志(本次运行)',
        note: '清除本次运行的日志，保留此前运行的日志。运行日志不进入模型上下文',
        cleared: '运行日志已清空',
      },
      usage: {
        label: 'token用量流水(成本页数据源)',
        note: '清除全部模型用量与成本记录，成本页从后续写入的记录重新累计。这些记录不进入模型上下文',
        stat: (n: number, size: string) => `${n}条 / ${size}`,
        cleared: (n: number) => `已清除${n}条用量记录`,
      },
      toolcalls: {
        label: '工具调用流水(工具名/原始参数/回执)',
        note: '清除本次运行的工具调用日志，不改变模型上下文中的工具回执',
        cleared: '工具调用流水已清空',
      },
      state: {
        label: 'Core 状态',
        note: '清除 Persona 状态、交接时间和模型连续失败记录，保留投递游标与 World 可见性',
        stat: (n: number, lastHandoff: string) => `人格状态${n}项 / 上次交接${lastHandoff}`,
        never: '无',
        cleared: 'core状态已重置为默认',
      },
      wakes: {
        label: '持久定时器',
        note: '全部定时器取消(不产生通知)',
        stat: (n: number) => `${n}个待触发`,
        cleared: (n: number) => `已取消${n}个定时器`,
      },
      tracker: {
        label: 'session统计(usage/缓存命中)',
        note: '清零统计，保留正在运行的 session 条目',
        stat: (n: number) => `${n}个session`,
        cleared: 'session统计已清零',
      },
      pending: {
        label: '待投递事件',
        note:
          '丢弃待投递的事件，保留事件库记录。延迟生成正文的队列项保留；已丢弃项不会在重启后补投',
        stat: (n: number) => `${n}条待投递`,
        cleared: (n: number) => `已丢弃${n}条待投递事件`,
      },
    },
    config: {
      unknownGroup: (id: string) => `没有这一组配置: ${id}`,
      updated: (title: string, file: string) => `${title}已更新,已写回 ${file}`,
    },
    prompts: {
      unknown: (key: string) => `未知提示词模板: ${key}`,
      packageReadOnly: (title: string) => `${title} 是只读的扩展包模板`,
      conflict: (title: string) => `${title} 已在别处被修改,请重新载入后再保存`,
      saved: (title: string) => `已保存 ${title}`,
      savedOverride: (title: string) => `已保存 ${title} 的部署覆盖文件`,
      notEnvPrompt: (title: string) => `${title} 没有可恢复的默认模板`,
      alreadyDefault: (title: string) => `${title} 本来就在用 World 默认`,
      reset: (title: string) => `已删除 ${title} 的部署覆盖文件`,
    },
    visibility: {
      shown: (id: string) => `${id} 对 agent 重新可见。事件投递已恢复;前缀段与工具要等前缀重载才回来。`,
      hidden: (id: string) => `${id} 已对 agent 隐藏。新事件不再唤醒 agent(仍照常落库);前缀段与工具要等前缀重载才撤下。`,
      prefixReloaded: (kept: number) => `系统前缀与工具表已重载，保留当前session的${kept}条既有消息`,
    },
    shutdown: {
      pause: '暂停事件投递',
      worlds: '停止 World',
      core: '停止 Persona',
      modulesTimedOut: 'World 停止超时',
      externalState: (worldId: string) => `${worldId} 外部状态`,
      stopIncomplete: (detail: string) => `World 停止未完成，不能采用外部核验缓存:${detail}`,
      cacheReadFailed: (detail: string) => `读取已缓存的关机验证结果失败:${detail}`,
      manualCheck: '请检查对应外部服务是否已停止。',
      llm: '停止 Provider 实例',
      flush: '保存 Core 状态',
      web: '关闭控制台',
      summarySkipped: '本地关机步骤未全部完成',
      summaryComplete: '本地关机步骤全部完成',
      summaryUnverified: (items: string[]) => `本地关机完成,但外部状态未确认结束:${items.join('、')}(需人工确认)`,
    },
  },
  en: {
    noFile: '(no file)',
    storage: {
      events: {
        label: "Event store (this run's shard)",
        note: 'Clears events from this run and keeps earlier runs; the cursor does not rewind',
        stat: (count: number, cursor: number, size: string) => `${count} records (cursor at ${cursor}) / ${size}`,
        cleared: (n: number) => `Cleared ${n} events from this run`,
      },
      session: {
        label: 'Main session (current conversation context)',
        note: 'Clears the conversation and reopens the session, keeping Memory and the event store. Prefer clearing while idle',
        stat: (records: number, ktok: number, size: string) => `${records} records / ~${ktok}k tok / ${size}`,
        cleared: 'Session cleared and reopened (system prefix + opening message)',
      },
      runlog: {
        label: 'Run log (this run)',
        note: 'Clears logs from this run and keeps earlier runs. Run logs are not included in model context',
        cleared: 'Run log cleared',
      },
      usage: {
        label: 'Token usage ledger (source of the cost page)',
        note: 'Clears all model usage and cost records; totals restart with subsequently written records. These records are not included in model context',
        stat: (n: number, size: string) => `${n} records / ${size}`,
        cleared: (n: number) => `Cleared ${n} usage records`,
      },
      toolcalls: {
        label: 'Tool call ledger (tool name / raw arguments / receipt)',
        note: 'Clears tool call logs from this run without changing tool results in model context',
        cleared: 'Tool call ledger cleared',
      },
      state: {
        label: 'Core state',
        note: 'Clears Persona state, handoff time and consecutive model failure records; keeps the delivery cursor and World visibility',
        stat: (n: number, lastHandoff: string) => `${n} persona state entries / last handoff ${lastHandoff}`,
        never: 'none',
        cleared: 'Core state reset to defaults',
      },
      wakes: {
        label: 'Persistent timers',
        note: 'Cancels every timer (no notifications are produced)',
        stat: (n: number) => `${n} pending`,
        cleared: (n: number) => `Cancelled ${n} timers`,
      },
      tracker: {
        label: 'Session statistics (usage / cache hits)',
        note: 'Resets statistics and keeps entries for active sessions',
        stat: (n: number) => `${n} sessions`,
        cleared: 'Session statistics zeroed',
      },
      pending: {
        label: 'Pending events',
        note:
          'Discards pending events and keeps archived records. Deferred rendering items remain queued; discarded items will not be replayed after restart',
        stat: (n: number) => `${n} pending`,
        cleared: (n: number) => `Discarded ${n} pending events`,
      },
    },
    config: {
      unknownGroup: (id: string) => `No such config group: ${id}`,
      updated: (title: string, file: string) => `${title} updated and written back to ${file}`,
    },
    prompts: {
      unknown: (key: string) => `Unknown prompt template: ${key}`,
      packageReadOnly: (title: string) => `${title} is a read-only extension package template`,
      conflict: (title: string) => `${title} was modified elsewhere; reload before saving`,
      saved: (title: string) => `Saved ${title}`,
      savedOverride: (title: string) => `Saved the deployment override for ${title}`,
      notEnvPrompt: (title: string) => `${title} has no default template to restore`,
      alreadyDefault: (title: string) => `${title} is already using the World default`,
      reset: (title: string) => `Removed the deployment override for ${title}`,
    },
    visibility: {
      shown: (id: string) => `${id} is visible to the agent again. Event delivery has resumed; its prefix segment and tools return once the prefix is reloaded.`,
      hidden: (id: string) => `${id} is now hidden from the agent. New events no longer wake the agent (they are still stored); its prefix segment and tools are removed once the prefix is reloaded.`,
      prefixReloaded: (kept: number) => `System prefix and tool table reloaded; ${kept} existing messages of the current session kept`,
    },
    shutdown: {
      pause: 'Pause event delivery',
      worlds: 'Stop Worlds',
      core: 'Stop Persona',
      modulesTimedOut: 'World shutdown timed out',
      externalState: (worldId: string) => `${worldId} external state`,
      stopIncomplete: (detail: string) => `World stop incomplete, so the cached external verification cannot be used: ${detail}`,
      cacheReadFailed: (detail: string) => `Failed to read the cached shutdown verification: ${detail}`,
      manualCheck: 'Check whether the corresponding external service has stopped.',
      llm: 'Stop provider instances',
      flush: 'Persist core state',
      web: 'Close the console',
      summarySkipped: 'Local shutdown steps incomplete',
      summaryComplete: 'Local shutdown finished: every step completed',
      summaryUnverified: (items: string[]) => `Local shutdown finished, but external state is not confirmed ended: ${items.join(', ')} (manual confirmation needed)`,
    },
  },
};
type BotText = (typeof BOT_TEXT)['zh'];
const botText = (language: Language): BotText => pick(language, BOT_TEXT);

const fileSize = (dir: string, rel: string, noFile: string): string => {
  const p = join(dir, rel);
  if (!existsSync(p)) return noFile;
  try {
    return `${(statSync(p).size / 1024).toFixed(1)}KB`;
  } catch {
    return '?';
  }
};

function deriveStorage<C extends CoreConfig>(core: Core<C>, dataDir: string, language: Language): StoragePart[] {
  const t = botText(language);
  const size = (dir: string, rel: string): string => fileSize(dir, rel, t.noFile);
  const s = t.storage;
  return [
    {
      key: 'events',
      label: s.events.label,
      kind: 'disk',
      location: `data/runs/${core.run.id}/events.jsonl`,
      danger: true,
      note: s.events.note,
      stat: () => s.events.stat(core.store.currentCount(), core.store.latestCursor(), size(core.run.dir, 'events.jsonl')),
      clear: () => s.events.cleared(core.store.clear()),
    },
    {
      key: 'session',
      label: s.session.label,
      kind: 'disk',
      location: 'data/session-main.jsonl',
      danger: true,
      // 最后重建 session 前缀和开场，使其读取清理后的状态。
      order: 10,
      note: s.session.note,
      stat: () =>
        s.session.stat(core.session.records.length, Math.round(core.session.estTokens() / 1000), size(dataDir, 'session-main.jsonl')),
      clear: async () => {
        await core.loop.clearSession();
        return s.session.cleared;
      },
    },
    {
      key: 'runlog',
      label: s.runlog.label,
      kind: 'disk',
      location: `data/runs/${core.run.id}/log.jsonl`,
      note: s.runlog.note,
      stat: () => size(core.run.dir, 'log.jsonl'),
      clear: () => {
        core.runlog.clear();
        return s.runlog.cleared;
      },
    },
    {
      key: 'usage',
      label: s.usage.label,
      kind: 'disk',
      location: 'data/usage.jsonl',
      note: s.usage.note,
      stat: () => s.usage.stat(core.usageLog.count(), size(dataDir, 'usage.jsonl')),
      clear: () => s.usage.cleared(core.usageLog.clear()),
    },
    {
      key: 'toolcalls',
      label: s.toolcalls.label,
      kind: 'disk',
      location: `data/runs/${core.run.id}/toolcalls.jsonl`,
      note: s.toolcalls.note,
      stat: () => core.toolLog.stat(),
      clear: () => {
        core.toolLog.clear();
        return s.toolcalls.cleared;
      },
    },
    {
      key: 'state',
      label: s.state.label,
      kind: 'disk',
      location: 'data/core-state.json',
      note: s.state.note,
      stat: () =>
        s.state.stat(Object.keys(core.state.data.persona).length, core.state.data.lastTruncateAt ?? s.state.never),
      clear: () => {
        core.state.clear();
        return s.state.cleared;
      },
    },
    {
      key: 'wakes',
      label: s.wakes.label,
      kind: 'disk',
      location: 'data/timers.json',
      note: s.wakes.note,
      stat: () => s.wakes.stat(core.timers.list().length),
      clear: () => s.wakes.cleared(core.timers.clearAll()),
    },
    {
      key: 'tracker',
      label: s.tracker.label,
      kind: 'memory',
      note: s.tracker.note,
      stat: () => s.tracker.stat(core.sessions.list().length),
      clear: () => {
        core.sessions.reset();
        return s.tracker.cleared;
      },
    },
    {
      // 在 session 重建前清除积压事件。

      key: 'pending',
      label: s.pending.label,
      kind: 'memory',
      order: 9,
      note: s.pending.note,
      stat: () => s.pending.stat(core.bus.pending()),
      // 保留延迟渲染项，其回调还负责复位 World 的排队状态。
      clear: () => s.pending.cleared(core.discardPendingEvents()),
    },
  ];
}

/**
 * 环境提示词按 World、bot 包、部署的顺序覆盖，控制台只写部署覆盖文件。
 * Persona 声明 deploymentPath 时写该路径，否则读写 path；扩展包中的模板只读，避免修改 pnpm store 的硬链接。
 */
function derivePrompts<C extends CoreConfig>(
  parts: BotParts<C>,
  assembly: WorldAssembly,
  contribution: ConsoleContribution,
  timezone: string,
  dirs: EnvPromptDirs,
  packageReadOnly: boolean,
): WebAppPromptDeps | undefined {
  // 同 key 采用第一个声明；装配层优先于 Persona。
  // 标题与说明按请求语言读取；key 与路径必须保持一致。
  const docsOf = (language: Language) => {
    const seen = new Set<string>();
    return [
      ...(contribution.promptDocs ?? []).map((d) => ({ ...d, scope: 'persona' as const })),
      ...(parts.persona.console?.(language)?.promptDocs ?? []).map((d) => ({ ...d, scope: 'persona' as const })),

      ...assembly.instances()
        .flatMap((m) => (m.console?.(language)?.promptDocs ?? []).map((d) => ({ ...d, scope: 'world' as const, worldId: m.id }))),
    ].filter((d) => (seen.has(d.key) ? false : (seen.add(d.key), true)));
  };
  type Doc = ReturnType<typeof docsOf>[number];
  if (docsOf('zh').length === 0) return undefined;
  const docOf = (key: string, language: Language): Doc => {
    const doc = docsOf(language).find((d) => d.key === key);
    if (!doc) throw new Error(botText(language).prompts.unknown(key));
    return doc;
  };
  const revisionOf = (content: string): string => createHash('sha256').update(content).digest('hex');

  const sourceOf = (d: Doc): { readPath: string; writePath: string; origin?: EnvPromptOrigin } => {
    if (d.scope === 'world' && d.role === 'envPrompt') {
      const { path, origin } = envPromptTemplateSource(d, d.worldId, dirs);

      const writeDir = dirs.deploymentDir;
      return { readPath: path, writePath: writeDir ? envPromptOverridePath(writeDir, d.worldId) : d.path, origin };
    }
    // path 由声明方解析为当前读取源。
    if (d.deploymentPath) {
      return {
        readPath: d.path,
        writePath: d.deploymentPath,
        origin: d.path === d.deploymentPath ? 'deployment' : 'package',
      };
    }
    return { readPath: d.path, writePath: d.path };
  };

  const varValues = async (): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    try {
      Object.assign(out, await parts.persona.promptVarValues?.({
        now: new Date(),
        timezone,
      }) ?? {});
    } catch { /* 忽略单个来源的变量读取错误。 */ }
    for (const m of assembly.instances()) {
      try {
        Object.assign(out, (await m.envPromptVars()) ?? {});
      } catch { /* 忽略单个来源的变量读取错误。 */ }
    }
    return out;
  };

  const readSource = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8') : '');

  const readDoc = (d: Doc, values: Record<string, string>): PromptDocument => {
    const { readPath, origin } = sourceOf(d);
    const content = readSource(readPath);
    return {
      ...(d.role ? { role: d.role } : {}),
      ...(origin ? { origin } : {}),
      ...(d.vars?.length
        ? {
            vars: d.vars.map((v) => ({
              ...v,
              ...(Object.prototype.hasOwnProperty.call(values, v.name) ? { value: values[v.name] } : {}),
            })),
          }
        : {}),
      key: d.key,
      title: d.title,
      scope: d.scope,
      description: d.description,
      content,
      revision: revisionOf(content),
    };
  };
  return {
    list: async (language) => {
      const values = await varValues();
      return docsOf(language).map((d) => readDoc(d, values));
    },
    prefix: () => assembleSystemSegments({
      persona: parts.persona,
      worlds: assembly.mounted,
      now: new Date(),
      timezone,
      dirs,
    }),
    write: (key, content, baseRevision, language) => {
      const t = botText(language).prompts;
      const doc = docOf(key, language);
      if (packageReadOnly && doc.scope === 'persona' && !doc.deploymentPath) {
        throw new Error(t.packageReadOnly(doc.title));
      }
      const { readPath, writePath, origin } = sourceOf(doc);
      if (baseRevision) {
        const cur = revisionOf(readSource(readPath));
        if (cur !== baseRevision) throw new PromptRevisionConflict(t.conflict(doc.title));
      }
      mkdirSync(dirname(writePath), { recursive: true });
      const tmp = `${writePath}.tmp-${Math.random().toString(36).slice(2, 10)}`;
      try {
        writeFileSync(tmp, content, 'utf8');
        renameSync(tmp, writePath);
      } catch (error) {
        try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* 保留原始写入错误 */ }
        throw error;
      }
      return origin ? t.savedOverride(doc.title) : t.saved(doc.title);
    },
    reset: (key, language) => {
      const t = botText(language).prompts;
      const doc = docOf(key, language);
      const { writePath, origin } = sourceOf(doc);
      if (!origin) throw new Error(t.notEnvPrompt(doc.title));
      if (origin === 'module') return t.alreadyDefault(doc.title);
      unlinkSync(writePath);
      return t.reset(doc.title);
    },
  };
}

type WorldVisibilityFacts = Pick<Core<CoreConfig>, 'worldVisibility'>;

/** 控制台状态清单不渲染环境模板；需要环境正文的调用方使用 deriveWorldInfo。 */
export type WorldFacts =
  | Omit<WorldInfo, 'envPrompt'>
  | Extract<ConsoleWorldInfo, { status: 'inactive' | 'missing' }>;

/** 挂载为 active，有实例但未挂载为 inactive，无法建立可用实例为 missing。 */
export function deriveWorldFacts(
  core: WorldVisibilityFacts,
  assembly: WorldAssembly,
  language: Language,
): WorldFacts[] {
  const { visibility, driftedWorlds } = core.worldVisibility();
  const slots: WorldFacts[] = assembly.slots.map((slot) => {
    const m = slot.instance;

    let decl;
    try {
      decl = m.console?.(language);
    } catch {
      decl = undefined;
    }
    const label = decl?.label ?? slot.label;
    if (!slot.mounted) {
      return { id: slot.id, status: 'inactive' as const, label, declared: slot.declared };
    }
    return {
      id: m.id,
      status: 'active' as const,
      label,
      declared: slot.declared,
      workspace: `worlds/${m.id}`,
      tools: m.tools().map((t) => t.name),
      visible: visibility[m.id] !== false,
      prefixDrifted: driftedWorlds.includes(m.id),
      ...(decl?.lamps?.length ? { lamps: decl.lamps } : {}),
      ...(decl?.badges ? { badges: decl.badges } : {}),
      ...(decl?.links ? { links: decl.links } : {}),
    };
  });
  const missing: WorldFacts[] = assembly.missing.map((m) => ({
    id: m.id,
    status: 'missing' as const,
    label: m.label,
    declared: m.declared ?? true,
    reason: m.reason(language),
  }));
  return [...slots, ...missing];
}

async function deriveWorldInfo(
  core: WorldVisibilityFacts,
  assembly: WorldAssembly,
  dirs: EnvPromptDirs,
  language: Language,
): Promise<ConsoleWorldInfo[]> {
  return Promise.all(deriveWorldFacts(core, assembly, language).map(async (facts) => {
    if (facts.status !== 'active') return facts;
    return { ...facts, envPrompt: (await renderWorldEnvPrompt(assembly.slot(facts.id).instance, dirs)).text };
  }));
}

/**
 * 存储清单在装配期固定；stat/clear 按 key 访问当前实例，以支持定义实例重建。
 */
function deriveSlotStorage(assembly: WorldAssembly, language: Language): StoragePart[] {
  return assembly.slots.flatMap((slot) =>
    (slot.instance.console?.(language)?.storage ?? []).map((part): StoragePart => {
      const current = (): StoragePart => {
        const found = slot.instance.console?.(language)?.storage?.find((p) => p.key === part.key);
        if (!found) throw new Error(`${slot.id} 的存储项 ${part.key} 在当前实例上不存在`);
        return found;
      };
      return { ...part, stat: () => current().stat(), clear: () => current().clear() };
    }),
  );
}

// 面板 id 在各页内唯一，转发时保持声明方提供的局部 id。
// 控制台声明异常由 ConsolePageRegistry 按来源隔离。
function normalizePanelDecls(
  panels: readonly WorldPanelDecl[],
): Array<{ id: string; title: string; description?: string; getMethods?: readonly string[] }> {
  return panels.map((p) => ({
    id: p.id,
    title: p.title,
    ...(p.description ? { description: p.description } : {}),
    ...(p.getMethods ? { getMethods: [...p.getMethods] } : {}),
  }));
}

export function ioPageContribution(
  worldId: string,
  label: string,
  info: WorldFacts | undefined,
  mod: World | undefined,
  language: Language = 'zh',
): ConsolePageContribution {
  const decl = mod?.console?.(language);
  const declaredPanels = decl?.panels ?? [];
  const out: ConsolePageContribution = {
    id: pageIdFor('world', worldId),
    kind: 'world',
    label: decl?.label ?? label,
    availability: info?.status ?? 'inactive',
  };
  if (decl?.lamps?.length) out.lamps = decl.lamps;
  if (decl?.badges?.length) out.badges = decl.badges;
  if (declaredPanels.length) out.panels = normalizePanelDecls(declaredPanels);
  if (decl?.links?.length) out.links = decl.links;
  if (decl?.config?.length) out.config = decl.config;
  if (decl?.promptDocs?.length) out.promptDocs = decl.promptDocs;
  if (decl?.storage?.length) out.storage = decl.storage;
  if (info?.declared !== undefined) out.declared = info.declared;
  if (info?.status === 'missing') out.reason = info.reason;
  if (info?.status === 'active') {
    if (info.visible !== undefined) out.agentVisible = info.visible;
    if (info.prefixDrifted !== undefined) out.prefixDrifted = info.prefixDrifted;
  }
  const invoke = decl?.invoke;
  if (invoke) {
    out.invoke = (panel, method, args) =>
      invoke(panel, method, args);
  }

  const stream = decl?.stream;
  if (stream) {
    out.stream = (panel, socket) =>
      stream(panel, socket);
  }
  return out;
}

export function personaPageContribution(
  botId: string,
  label: string,
  core: Persona,
  language: Language = 'zh',
): ConsolePageContribution | null {
  const decl = core.console?.(language);
  if (!decl) return null;
  const declaredPanels = decl.panels ?? [];
  const out: ConsolePageContribution = {
    id: pageIdFor('persona', botId),
    kind: 'persona',
    label,
    availability: 'active',
  };
  if (decl.badges?.length) out.badges = decl.badges;
  if (declaredPanels.length) out.panels = normalizePanelDecls(declaredPanels);
  if (decl.config?.length) out.config = decl.config;
  if (decl.promptDocs?.length) out.promptDocs = decl.promptDocs;
  if (decl.storage?.length) out.storage = decl.storage;
  const invoke = decl.invoke;
  if (invoke) {
    out.invoke = (panel, method, args) =>
      invoke(panel, method, args);
  }
  return out;
}

/** 合并同 id 的 Persona 页面，按面板归属分派 invoke 和 stream；重复面板由 validateContributions 拒绝。 */
export function mergePersonaContributions(
  id: string,
  label: string,
  core: ConsolePageContribution | null,
  extras: readonly ConsolePageContribution[],
): ConsolePageContribution | null {
  const parts = [core, ...extras].filter((c): c is ConsolePageContribution => !!c);
  if (parts.length === 0) return null;
  if (parts.length === 1 && parts[0]) return parts[0];

  const out: ConsolePageContribution = {
    id,
    kind: 'persona',
    label: parts.find((p) => p.label)?.label ?? label,
    availability: 'active',
  };
  const badges = parts.flatMap((p) => p.badges ?? []);
  if (badges.length) out.badges = badges;
  const links = parts.flatMap((p) => p.links ?? []);
  if (links.length) out.links = links;
  const config = parts.flatMap((p) => p.config ?? []);
  if (config.length) out.config = config;
  const promptDocs = parts.flatMap((p) => p.promptDocs ?? []);
  if (promptDocs.length) out.promptDocs = promptDocs;
  const storage = parts.flatMap((p) => p.storage ?? []);
  if (storage.length) out.storage = storage;

  const panels = parts.flatMap((p) => p.panels ?? []);
  if (panels.length) out.panels = panels;

  const owner = new Map<string, ConsolePageContribution>();
  for (const p of parts) {
    for (const panel of p.panels ?? []) {
      if (!owner.has(panel.id)) owner.set(panel.id, p);
    }
  }
  if (parts.some((p) => p.invoke)) {
    out.invoke = async (panel, method, args) => {
      const target = owner.get(panel);
      if (!target?.invoke) throw new Error(`没有面板数据面: ${panel}`);
      return target.invoke(panel, method, args);
    };
  }
  if (parts.some((p) => p.stream)) {
    out.stream = (panel, socket) => {
      const target = owner.get(panel);
      if (!target?.stream) throw new Error(`没有流式面: ${panel}`);
      target.stream(panel, socket);
    };
  }
  return out;
}

export function deriveConsolePageSources(
  core: WorldVisibilityFacts,

  parts: { assembly: WorldAssembly; persona?: Persona },
  /** bot 标识与配置组；未指定 settingsPage 的组归入 Persona 页面。 */
  bot?: { id: string; label: string; configGroups?: readonly ConfigGroup[] },

  extra?: (language: Language) => ConsolePageContribution[],
): () => ConsolePageSource[] {
  const { assembly } = parts;
  const labelOf = (id: string): string => assembly.labelOf(id) ?? id;
  return () => {
    // 每次枚举按语言缓存状态，供同一批 contribute() 调用共享。
    const once = new Map<Language, Map<string, WorldFacts>>();
    const infos = (language: Language): Map<string, WorldFacts> => {
      let facts = once.get(language);
      if (!facts) {
        facts = new Map(deriveWorldFacts(core, assembly, language).map((i) => [i.id, i]));
        once.set(language, facts);
      }
      return facts;
    };
    const instances = new Map<string, World>(assembly.slots.map((s) => [s.id, s.instance]));
    const ids = [...assembly.slots.map((s) => s.id), ...assembly.missing.map((m) => m.id)];
    const sources: ConsolePageSource[] = ids.map((id) => ({
      id: pageIdFor('world', id),
      contribute: (language) =>
        ioPageContribution(id, labelOf(id), infos(language).get(id), instances.get(id), language),
    }));

    const persona = parts.persona;
    const selfId = bot ? pageIdFor('persona', bot.id) : null;

    const extrasByLanguage = new Map<Language, ConsolePageContribution[]>();
    const extrasOf = (language: Language): ConsolePageContribution[] => {
      let list = extrasByLanguage.get(language);
      if (!list) {
        list = extra?.(language) ?? [];
        extrasByLanguage.set(language, list);
      }
      return list;
    };
    const extras = extrasOf('zh');

    // 同 id 的贡献共用页面与构建产物。
    if (bot && selfId) {

      // 指定 settingsPage 的配置组保留在设置页。

      const claimedGroups = (bot.configGroups ?? []).filter((g) => g.settingsPage !== true);
      const botConfig: ConsolePageContribution[] = claimedGroups.length
        ? [{ id: selfId, kind: 'persona', label: bot.label, config: claimedGroups }]
        : [];
      sources.push({
        id: selfId,
        contribute: (language) => mergePersonaContributions(
          selfId,
          bot.label,
          persona ? personaPageContribution(bot.id, bot.label, persona, language) : null,
          [...extrasOf(language).filter((c) => c.id === selfId), ...botConfig],
        ),
      });
    }
    // 页面 id 不随语言变化；各来源异常由 registry 分别处理。

    for (const c of extras) {
      if (selfId && c.id === selfId) continue;
      sources.push({ id: c.id, contribute: (language) => extrasOf(language).find((x) => x.id === c.id) ?? c });
    }
    return sources;
  };
}

export function createBot<C extends CoreConfig>(
  loaded: LoadedConfig<C>,
  definition: BotDefinition<C>,
  /** 启动时加载的扩展集；未提供时不显示扩展页。扩展 bot 的包内模板只读。 */
  opts: { extensions?: ExtensionSet } = {},
): Bot<C> {
  const cfg = loaded.config;
  // 环境模板允许包和部署覆盖，控制台仅写部署层。
  const promptDirs: EnvPromptDirs = {
    packageDir: loaded.packageDir ?? loaded.rootDir,
    deploymentDir: loaded.rootDir,
  };
  // 默认语言用于 HTML 和未指定语言的请求。

  const language = resolveLanguage(cfg.language);
  const assembly = new WorldAssembly(loaded, definition.worlds ?? [], definition.declares ?? []);
  const parts = definition.build(loaded, assembly.mounted);
  if (parts.worlds?.length) assembly.addPrebuilt(parts.worlds);
  const contribution = parts.console ?? {};

  const core = new Core<C>(loaded, {
    persona: parts.persona,
    worlds: assembly.mounted,
    llm: parts.llm,
  });

  const notifyLifecycle = (event: WorldLifecycleEvent): void => {
    parts.persona.onWorldLifecycle?.(event);
  };
  assembly.bind({
    mount: (mod) => core.mountWorld(mod),
    unmount: async (id) => { await core.unmountWorld(id); },
    lifecycle: notifyLifecycle,

    reservedToolNames: () => [...RESERVED_FRAME_NAMES, ...(parts.persona.ownToolNames?.() ?? [])],
  });

  // 未激活实例也提供配置；组 id、owner 和配置键不随语言变化。

  const configGroups = (language: Language): ConfigGroup[] => [
    coreConfigGroup(language),
    ...(contribution.configGroups ?? []),
    ...assembly.instances().flatMap((m) => m.console?.(language)?.config ?? []),
  ];

  // 共享端点配置位于部署根的 providers/；activeProvider 属于当前部署。
  const providerSettings = new ProviderSettings(cfg,core.providers,join(loaded.rootDir,'config.json'),loaded.providersDir ?? join(loaded.rootDir,'providers'));
  const allConfigGroups = (language: Language) => [...configGroups(language),...providerSettings.groups(language)];
  const llmManagers = new Map<string,{stop():Promise<unknown>}>([['providers',{stop:()=>core.providers.stopAll()}]]);

  let webApp: WebApp | null = null;

  /** 控制台与启动器共用一次关机操作，重复调用返回同一 Promise。 */
  let shutdownOnce: Promise<ShutdownReport> | null = null;
  let coreStopOnce: Promise<void> | null = null;
  const stopCore = (): Promise<void> => {
    coreStopOnce ??= (async () => { await parts.onStop?.(); })();
    return coreStopOnce;
  };
  // start() 在启动控制台、Provider 和 World 之前获取单实例锁。
  let instanceLock: InstanceLock | null = null;

  const beginShutdown = (
    reason: string,
    opts: { closeWeb: boolean; exit: boolean; language?: Language },
  ): Promise<ShutdownReport> => {
    shutdownOnce ??= runShutdown({
      reason,
      core,
      worlds: [...assembly.mounted],
      stopCore,
      llmManagers,

      webApp: opts.closeWeb ? webApp : null,
      log: core.runlog.logger('shutdown'),
      language: opts.language ?? language,
    }).then((report) => {
      instanceLock?.release();
      instanceLock = null;
      if (opts.exit) {
      // 先发送关机结果，再关闭控制台并退出进程。

        setTimeout(() => {
          void Promise.resolve(webApp?.stop()).finally(() => {

            process.exit(report.complete ? 0 : 1);
          });
        }, 300);
      }
      return report;
    });
    return shutdownOnce;
  };

  if (contribution.enabled !== false) {
    const startedAt = new Date().toISOString();
    /**
     * 可清除存储清单在装配期生成一次，/api/storage 与 bot 的 consolePages 共用这些对象。
     * 贡献方须在 console().storage 中声明全部项目；stat 和 clear 可延迟执行，子进程代理也须在装配期提供完整声明。
     */
    const consoleStorage = (language: Language): StoragePart[] => [
      ...deriveStorage(core, loaded.dataDir, language),
      ...(parts.persona.console?.(language)?.storage ?? []),
      ...deriveSlotStorage(assembly, language),
      ...(contribution.storage ?? []),
    ];
    webApp = new WebApp({
      store: core.store,
      memoryDir: loaded.memoryDir,
      dataDir: loaded.dataDir,
      botDir: loaded.rootDir,
      language,
      sessions: core.sessions,
      storage: consoleStorage,
      usage: { aggregate: (opts) => aggregateUsage(core.usageLog.readAll(), opts), status: () => core.usageLog.status() },
      config: {
        groups: (language) => allConfigGroups(language).map((group) => ({ group, values: group.owner.startsWith('provider:') ? providerSettings.values(group.id, language) : readGroupValues(cfg, group) })),
        set: (groupId: string, values: ConfigValues, language) => {
          const group = allConfigGroups(language).find((g) => g.id === groupId);
          if (group?.owner.startsWith('provider:')) return providerSettings.setConfig(groupId,values,language);
          if (!group) return botText(language).config.unknownGroup(groupId);
          const root = cfg as unknown as Record<string, unknown>;
          for (const [path, v] of Object.entries(values)) setConfigPath(root, path, v);
          return botText(language).config.updated(group.schema.title, persistConfig(loaded, values));
        },

        options: (kind, language) => {
          const own = contribution.configOptions?.(kind, language);
          if (own?.length) return own;
          for (const def of definition.worlds ?? []) {
            const opts = def.configOptions?.(kind, language);
            if (opts?.length) return opts;
          }
          return [];
        },
      },
      worlds: async (language) => deriveWorldInfo(core, assembly, promptDirs, language),

      consolePageSources: () => [...deriveConsolePageSources(
        core,
        { assembly, persona: parts.persona },
        {
          id: definition.id,
          label: cfg.displayName || definition.id,

          ...(contribution.configGroups?.length ? { configGroups: contribution.configGroups } : {}),
        },
        contribution.consolePages
          ? (language) => contribution.consolePages!({ storage: consoleStorage(language), language })
          : undefined,
      )(),...providerSettings.sources()],
      providersLamp: (language) => providerSettings.providersLamp(language),
      worldVisibility: {
        state: () => core.worldVisibility(),
        set: (id, visible, language) => {
          core.setWorldVisible(id, visible);
          notifyLifecycle({ kind: 'visibility', id, label: assembly.labelOf(id) ?? id, visible });
          const t = botText(language).visibility;
          return visible ? t.shown(id) : t.hidden(id);
        },
      },
      sessionControl: {
        reloadPrefix: async (language) => {
          await core.loop.reloadSystemPrefix();
          return botText(language).visibility.prefixReloaded(Math.max(0, core.session.records.length - 1));
        },
      },
      run: {
        pause: () => core.bus.setPaused(true),
        resume: () => core.bus.setPaused(false),
        isPaused: () => core.bus.isPaused(),

        shutdown: (language) => beginShutdown('控制台关机键', { closeWeb: false, exit: true, language }),
    // 重启请求先于关机写入，供监督进程在子进程退出后读取。
        restart: (language) => {
          requestRestart(loaded.dataDir);
          return beginShutdown('控制台重启键', { closeWeb: false, exit: true, language });
        },
        supervised: isSupervised(),
      },
      ...(opts.extensions ? { extensions: new ExtensionManager(loaded.repoRoot ?? loaded.rootDir, opts.extensions) } : {}),
      debug: {
        sessionMessages: () => core.session.records,
        firstTurnMessages: () => core.loop.activeFirstTurn(),
        onSessionAppend: (cb) => core.session.onAppend(cb),
        onSessionReset: (cb) => core.session.onReset(cb),
        onEvent: (cb) => core.store.onAppend(cb),
        onRunlog: (cb) => core.runlog.onWrite(cb),
        recentLog: (limit) => core.runlog.recent(limit),
        runId: () => core.run.id,
        toolSchemas: () => core.loop.getToolSchemas(),
      },
      toolSchemas: {
        list: () => {

          const byWorld = new Map<string, ToolOwner>();
          for (const m of assembly.mounted) {
            const label = assembly.labelOf(m.id);
            const owner: ToolOwner = { kind: 'world', id: m.id, ...(label ? { label } : {}) };
            for (const t of m.tools()) byWorld.set(t.name, owner);
          }
          const extras = (contribution.extraToolSchemas?.() ?? []).map((s) => ({ ...s, tags: [] }));
          const byName = new Map<string, ToolSchema & { owner: ToolOwner }>();
          for (const s of [...core.loop.getToolSchemas(), ...extras]) {
            if (byName.has(s.name)) continue;
            const owner = byWorld.get(s.name) ?? { kind: 'persona' as const };
            byName.set(s.name, {
              name: s.name, description: s.description, parameters: s.parameters, owner,
            });
          }
          return [...byName.values()];
        },
      },
      getStatus: () => ({
        displayName: cfg.displayName,
        startedAt,
        loop: core.loop.getStatus(),
        eventCount: core.store.latestCursor(),
        ...(contribution.status?.() ?? {}),
      }),
      log: core.runlog.logger('console'),
      prompts: derivePrompts(parts, assembly, contribution, cfg.timezone, promptDirs, opts.extensions?.bot !== undefined),

      worldActivation: {
        set: (id, enabled, language) => (enabled ? assembly.activate(id, language) : assembly.deactivate(id, language)),
        restart: (id, language) => assembly.restart(id, language),
      },
    });
  }

  const app = webApp;
  return {
    core,
    parts,
    assembly,
    webApp,
    async start() {
      instanceLock ??= acquireInstanceLock(loaded.dataDir, {
        force: process.argv.includes('--force-second-instance'),
        log: core.runlog.logger('boot'),
      });

      const port = app ? await app.start(cfg.web.port) : null;
      // 启动 Provider 不等待健康检查完成；健康轮询由托管器执行。

      const orphans = Object.entries(cfg.providers).filter(([, entry]) => !providerModules.some((m) => m.id === entry.kind)).map(([name, entry]) => `${name}(kind=${entry.kind})`);
      if (orphans.length) core.runlog.logger('provider').warn('端点条目没有对应的 Provider 模块,不可用', { orphans });
      void core.providers.start(cfg.activeProvider).catch(error=>core.runlog.logger('provider').error('Provider 启动失败',{error:String(error)}));
      await parts.onStart?.({ core, loaded, port });
      await core.start();
      return { port };
    },
    async stop() {
      await core.stop();
      await stopCore();
      await Promise.all([...llmManagers.values()].map((m) => m.stop()));
      if (app) await app.stop();
      instanceLock?.release();
      instanceLock = null;
    },
    shutdown: (reason?: string) =>
      beginShutdown(reason ?? '外部请求', { closeWeb: true, exit: false }),
  };
}

/** 按序执行关机步骤并记录结果；失败或超时后继续下一步。 */
async function runShutdown<C extends CoreConfig>(ctx: {
  reason: string;
  core: Core<C>;
  /** 开始关机那一刻的挂载表快照 */
  worlds: readonly World[];
  stopCore: () => Promise<void>;
  llmManagers: Map<string, {stop():Promise<unknown>}>;
  webApp: WebApp | null;
  log: Logger;
  /** 步骤名和总结使用控制台请求语言。 */
  language: Language;
}): Promise<ShutdownReport> {
  const t = pick(ctx.language, BOT_TEXT).shutdown;
  const steps: ShutdownStep[] = [];
  let externalChecks: ShutdownExternalCheck[] = [];
  let modulesSettled = false;
  let moduleFailures: WorldStopFailure[] = [];
  const run = async (
    key: string,
    label: string,
    budgetMs: number,
    work: () => Promise<unknown> | unknown,
  ): Promise<void> => {
    const t0 = Date.now();
    try {
      await withDeadline(Promise.resolve().then(work), budgetMs, label);
      steps.push({ key, label, ok: true, elapsedMs: Date.now() - t0 });
      ctx.log.info(`关机 ✓ ${label}`, { elapsedMs: Date.now() - t0 });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      steps.push({ key, label, ok: false, elapsedMs: Date.now() - t0, detail });
      ctx.log.warn(`关机步骤失败: ${label}`, { detail });
    }
  };

  ctx.log.warn(`开始关机(${ctx.reason})`);
  await run('pause', t.pause, SHUTDOWN_BUDGET_MS.pause, () => {
    ctx.core.bus.setPaused(true);
  });
  await run('worlds', t.worlds, SHUTDOWN_BUDGET_MS.worlds, async () => {
    moduleFailures = await ctx.core.stop();
    modulesSettled = true;
    if (moduleFailures.length > 0) {
      throw new Error(moduleFailures.map((failure) => `${failure.worldId}:${failure.detail}`).join('；'));
    }
  });
  await run('core', t.core, SHUTDOWN_BUDGET_MS.core, ctx.stopCore);
  externalChecks = ctx.worlds.flatMap((module) => {
    if (!module.shutdownVerification) return [];
    const stopFailure = !modulesSettled
      ? t.modulesTimedOut
      : moduleFailures.find((failure) => failure.worldId === module.id)?.detail;
    if (stopFailure) {
      return [{
        key: `${module.id}.shutdown-verification`,
        label: t.externalState(module.id),
        status: 'unknown' as const,
        detail: t.stopIncomplete(stopFailure),
        manualAction: t.manualCheck,
      }];
    }
    try {
      return module.shutdownVerification().map((check) => ({ ...check }));
    } catch (error) {
      return [{
        key: `${module.id}.shutdown-verification`,
        label: t.externalState(module.id),
        status: 'unknown' as const,
        detail: t.cacheReadFailed(error instanceof Error ? error.message : String(error)),
        manualAction: t.manualCheck,
      }];
    }
  });
  await run('llm', t.llm, SHUTDOWN_BUDGET_MS.llm, () =>
    Promise.all([...ctx.llmManagers.values()].map((m) => m.stop())));
  await run('flush', t.flush, SHUTDOWN_BUDGET_MS.flush, () => {
    ctx.core.state.save();
  });
  const app = ctx.webApp;
  if (app) await run('web', t.web, SHUTDOWN_BUDGET_MS.web, () => app.stop());

  const localComplete = steps.every((s) => s.ok);
  const externalComplete = externalChecks.every((check) => check.status === 'verified-ended');
  const complete = localComplete && externalComplete;
  for (const check of externalChecks) {
    if (check.status === 'verified-ended') continue;
    ctx.log.error(`[P0] 外部状态未确认结束:${check.label}`, {
      status: check.status,
      detail: check.detail,
      manualAction: check.manualAction,
    });
  }

  const unverified = externalChecks.filter((check) => check.status !== 'verified-ended');
  const summary = !localComplete
    ? t.summarySkipped
    : complete
      ? t.summaryComplete
      : t.summaryUnverified(unverified.map((check) => `${check.label}=${check.status}`));
  ctx.log.emit('warn', summary, {
    event: 'shutdown-summary',
    data: {
      steps: steps.map((s) => `${s.label}=${s.ok ? 'ok' : s.detail}`),
      externalChecks: externalChecks.map((check) => `${check.label}=${check.status}`),
    },
  });
  closeRun(ctx.core.run, {
    endedAt: nowIso(ctx.core.config.timezone),
    lastCursor: ctx.core.store.latestCursor(),
    complete,
    reason: ctx.reason,
  });
  return { reason: ctx.reason, localComplete, complete, steps, externalChecks };
}

function persistConfig<C extends CoreConfig>(loaded: LoadedConfig<C>, values: ConfigValues): string {
  const cfgPath = join(loaded.rootDir, 'config.json');
  updateJsonObject(cfgPath, (raw) => {
    for (const [path, v] of Object.entries(values)) setConfigPath(raw, path, v);
  });
  return 'config.json';
}
