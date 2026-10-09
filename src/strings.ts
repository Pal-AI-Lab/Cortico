import { pick, type Language } from './core/language.ts';
import { botText as botZhHant, assemblyText as assemblyZhHant } from './strings.zh-Hant.ts';
import { botText as botJa, assemblyText as assemblyJa } from './strings.ja.ts';
import { botText as botKo, assemblyText as assemblyKo } from './strings.ko.ts';
import { botText as botFr, assemblyText as assemblyFr } from './strings.fr.ts';
import { botText as botDe, assemblyText as assemblyDe } from './strings.de.ts';
import { botText as botEs419, assemblyText as assemblyEs419 } from './strings.es-419.ts';
import { botText as botPtBR, assemblyText as assemblyPtBR } from './strings.pt-BR.ts';
import { botText as botIt, assemblyText as assemblyIt } from './strings.it.ts';
import { botText as botRu, assemblyText as assemblyRu } from './strings.ru.ts';

/** bot.ts 给控制台的回执与说明,按发起请求的界面语言取。 */
const botZh = {
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
      note: '清除对话上下文并重新开场，保留 Memory 和事件库。正在处理批次时等该批结束后执行',
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
    media: {
      label: '附件库(事件与工具回执里的图片、音频)',
      note: '删除全部附件文件，保留引用它们的事件与 session 记录；删掉的附件在上下文里只剩文字说明',
      stat: (n: number, size: string) => `${n}份 / ${size}`,
      cleared: (n: number) => `已删除${n}份附件`,
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
};
export const botEn: typeof botZh = {
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
      note: 'Clears the conversation and reopens the session, keeping Memory and the event store. While a batch is in progress, runs after it finishes',
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
    media: {
      label: 'Attachment store (images and audio from events and tool results)',
      note: 'Deletes every attachment file and keeps the events and session records that reference them; a deleted attachment leaves only its text description in context',
      stat: (n: number, size: string) => `${n} files / ${size}`,
      cleared: (n: number) => `Deleted ${n} attachments`,
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
};
export const botText = (language: Language) => pick(language, {
  zh: botZh, en: botEn, 'zh-Hant': botZhHant, ja: botJa, ko: botKo, fr: botFr, de: botDe,
  'es-419': botEs419, 'pt-BR': botPtBR, it: botIt, ru: botRu,
});

/** 装配层给控制台的回执与拒绝理由,按发起请求的界面语言取。 */
const assemblyZh = {
  constructFailed: (detail: string) => `构造失败: ${detail}`,
  notImplemented: '本地没有找到这个 World 的实现。',
  unknownWorld: (id: string) => `未知 World: ${id}`,
  alreadyRunning: (label: string) => `${label} 已启用`,
  prebuilt: (label: string) => `${label} 是预建实例,不经装配层激活`,
  activated: (label: string, id: string) => `${label}（${id}）已启用`,
  deactivated: (label: string, id: string) => `${label}（${id}）已停用`,
  notActive: (label: string) => `${label} 未激活,没有可重启的实例`,
  restarted: (label: string) => `${label} 已重启`,
  toolClash: (other: string, names: string[]) => `工具名与 ${other} 撞名,拒绝挂载: ${names.join(', ')}`,
  toolReserved: (names: string[]) => `工具名已被 Core 或 Persona 占用,拒绝挂载: ${names.join(', ')}`,
  unbound: '装配层尚未绑定 core',
};
export const assemblyEn: typeof assemblyZh = {
  constructFailed: (detail: string) => `Construction failed: ${detail}`,
  notImplemented: 'No implementation of this World was found locally.',
  unknownWorld: (id: string) => `Unknown World: ${id}`,
  alreadyRunning: (label: string) => `${label} is already enabled`,
  prebuilt: (label: string) => `${label} is a prebuilt instance and is not activated through assembly`,
  activated: (label: string, id: string) => `${label} (${id}) enabled`,
  deactivated: (label: string, id: string) => `${label} (${id}) disabled`,
  notActive: (label: string) => `${label} is not active, so there is no instance to restart`,
  restarted: (label: string) => `${label} restarted`,
  toolClash: (other: string, names: string[]) => `Tool names clash with ${other}, refusing to mount: ${names.join(', ')}`,
  toolReserved: (names: string[]) => `Tool names are taken by Core or the Persona, refusing to mount: ${names.join(', ')}`,
  unbound: 'The assembly layer is not bound to a core yet',
};
export const assemblyText = (language: Language) => pick(language, {
  zh: assemblyZh, en: assemblyEn, 'zh-Hant': assemblyZhHant, ja: assemblyJa, ko: assemblyKo,
  fr: assemblyFr, de: assemblyDe, 'es-419': assemblyEs419, 'pt-BR': assemblyPtBR, it: assemblyIt,
  ru: assemblyRu,
});
