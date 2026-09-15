import type { ContextRecord } from '../protocol/open-responses/context.ts';
import type { EnvPromptOrigin } from '../core/prefix.ts';
/**
 * WebApp 是独立于 agent 的控制台服务。Express、HTTP 与
 * WebSocket 共用端口；聊天协议由终端对话 World 实现。
 *
 * 依赖通过本文件的窄接口注入，WebApp 不导入 core。
 */
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createReadStream, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { open as openFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import type {
  EventEnvelope, EventRangeQuery, EventStoreReader, Logger,
  ConfigGroup, ConfigValues, WorldConsoleDecl,
  LogRecord, StoragePart, ToolSchema,
} from '../core/types.ts';
import type { SessionStats } from '../core/sessions.ts';
import type { UsageAggregate, UsageBucketOption } from '../core/cost.ts';
import { estimateMessagesTokens } from '../core/util.ts';
import { coerceGroupValues } from '../core/config-schema.ts';
import { isLanguage, pick, systemLanguage, type Language } from '../core/language.ts';

/** 服务端直接回给操作者的几句话:运行控制回执与关机账的总结行,按请求的界面语言。API 协议错误不在此列。 */
const SERVER_TEXT = {
  zh: {
    paused: '已暂停:事件照常落库排队,不投递唤醒',
    resumed: '已继续:积压事件一次性投递',
    exitSupervised: '进程即将退出,启动器随即重新拉起',
    exitUnsupervised: '进程即将退出;没有检测到启动器循环,需要手动重新启动',
    shutdownSkipped: (n: number, labels: string[]) => `本地关机完成,但有 ${n} 步没走完:${labels.join('、')}`,
    shutdownComplete: (n: number) => `本地关机完成(${n} 步全部走完)`,
    externalUnverified: (items: string[]) => `；[P0] ${items.join('；')}`,
    externalItem: (label: string, status: string, detail: string, manualAction: string) =>
      `${label}=${status}（${detail}）。人工动作:${manualAction}`,
    externalVerified: '；外部状态检查均已验证结束',
  },
  en: {
    paused: 'Paused: events are still stored and queued, no wake is delivered',
    resumed: 'Resumed: the backlog is delivered in one batch',
    exitSupervised: 'The process is about to exit; the launcher will start it again',
    exitUnsupervised: 'The process is about to exit; no launcher loop was detected, so it must be started again by hand',
    shutdownSkipped: (n: number, labels: string[]) => `Local shutdown finished, but ${n} step(s) did not complete: ${labels.join(', ')}`,
    shutdownComplete: (n: number) => `Local shutdown finished (all ${n} steps completed)`,
    externalUnverified: (items: string[]) => `; [P0] ${items.join('; ')}`,
    externalItem: (label: string, status: string, detail: string, manualAction: string) =>
      `${label}=${status} (${detail}). Manual action: ${manualAction}`,
    externalVerified: '; every external state check verified ended',
  },
};
import { logPredicate, readRunsIndex, readTailRecordsWhere } from './files.ts';
import { ConsoleAssets, ConsolePageRegistry, type ConsolePageSource } from './console-pages.ts';
import { EXTENSION_ASSET_PREFIX, extensionAssetSegment, type ExtensionConsoleAsset } from '../extensions/manifest.ts';
import {
  CONSOLE_LAMPS_ROUTE, CONSOLE_LANGUAGE_HEADER, CONSOLE_LANGUAGE_QUERY, CONSOLE_PROTOCOL_VERSION,
  PROVIDERS_LAMP_ID,
  isBinaryResult, isFileResult,
  type ConsoleFileResult, type ConsoleLamp, type ConsoleStream,
} from './shared/console-protocol.ts';
import {
  PATH_PICKER_ROUTE,
  type PathPicker,
} from './shared/path-picker.ts';
import {
  nativePathPicker,
  parsePathPickerOptions,
  PathPickerRequestError,
  PathPickerUnavailableError,
  validatePickedPath,
} from './path-picker.ts';





/**
 * 调试通道依赖(窄接口,不import core):session/事件/运行日志的实时观察接缝。
 * on*系列在WebApp构造时各注册一次;WebApp内部维护调试客户端集合做广播。
 */
export interface WebAppDebugDeps {
  /** WebApp 不修改返回的 session 消息数组。 */
  sessionMessages(): readonly ContextRecord[];
  /** 当前的合成开头；为空时返回空数组，不写入 session 记录。省略时时间线不标注开头。 */
  sessionHead?(): ContextRecord[];
  onSessionAppend(cb: (msg: ContextRecord, index: number) => void): void;
  onSessionReset(cb: (messages: ContextRecord[]) => void): void;
  onEvent(cb: (e: EventEnvelope) => void): void;
  onRunlog(cb: (entry: LogRecord) => void): void;
  /** 当前 run 最近落盘的运行日志(hello 快照用) */
  recentLog?(limit: number): LogRecord[];
  /** 当前 run id;/api/log 缺省读它的 log.jsonl */
  runId?(): string;
  /** 主循环当前工具表schema(run()前为空数组) */
  toolSchemas(): Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
}

/** session观察注册表的窄接口(core/sessions.ts的SessionTracker天然满足) */
export interface WebAppSessionsDeps {
  list(): SessionStats[];
  messages(id: string): readonly ContextRecord[] | null;
  onChange(cb: () => void): void;
}

export type { StoragePart };

export interface WorldInfo {
  /** Worldid(装配层给的那个,如 terminal) */
  id: string;
  /** 已挂载到 core 并在当前进程运行。 */
  status: 'active';
  /** 人类可读名(来自装配层的 World 目录;目录没列的 World 缺省用 id) */
  label?: string;
  /** Persona定义的渠道;false/缺省 = 部署侧选配的外挂 */
  declared?: boolean;
  /**
   * 当前对 agent 可见。false = 三要素已撤下(事件不再唤醒 agent),但 World**照常运行**:
   * 连接不断、它持有的页面照常工作。
   */
  visible?: boolean;
  /** 当前系统前缀和工具声明尚未按新的可见性重载。 */
  prefixDrifted?: boolean;
  /** 人工撰写的环境提示词描述 */
  envPrompt: string;
  /** 相对persona/的工作区目录(如 worlds/<Worldid>) */
  workspace: string;
  /** World 工具名清单 */
  tools: string[];
  /**
   * World 声明的控制台表面：状态灯、徽标、专用面板、链接和可调配置组。
   * 控制台路由不依赖 World id。
   */
  lamps?: WorldConsoleDecl['lamps'];
  badges?: WorldConsoleDecl['badges'];
  links?: WorldConsoleDecl['links'];
}

/**
 * 本地已有实现但当前未激活的 World。激活写回 config.json 的 `worlds.<id>.enabled`
 * 并立即挂载,不重启进程。
 */
export interface InactiveWorldInfo {
  id: string;
  status: 'inactive';
  label: string;
  /** 是否由Persona声明；false 表示部署侧选配 World。 */
  declared: boolean;
}

/** Persona已声明、但当前部署未提供实现的 World。仅出现在控制台目录中。 */
export interface UnavailableWorldInfo {
  id: string;
  status: 'missing';
  label: string;
  declared: boolean;
  /** 为什么装不上,原样显示 */
  reason: string;
}

export type ConsoleWorldInfo = WorldInfo | InactiveWorldInfo | UnavailableWorldInfo;

/**
 * 一个装在 `extensions/` 下的包。`state` 是启动时的加载结果对照此刻磁盘:
 * `pending-restart` = 启动后装的或换了版本,`removed` = 启动后卸了但本进程里还在跑,
 * `idle` = bot 包装了但这份部署没引用它。
 */
export interface ExtensionInfo {
  name: string;
  /** extensions/package.json 里的版本范围或 `link:` 路径 */
  spec: string;
  version: string | null;
  description?: string;
  /** manifest 里的类别(`world` / `provider` / `bot`);解析不出 manifest 时缺席 */
  kind?: 'world' | 'provider' | 'bot';
  /** 扩展声明的契约版本 */
  api?: number;
  /** 包声明了浏览器端产物 */
  consoleClient: boolean;
  /** 浏览器端产物:没声明 / 在发 / 声明了但文件不在 */
  console?: 'none' | 'served' | 'missing';
  loaded: boolean;
  reason?: string;
  worldId?: string;
  label?: string;
  state: 'loaded' | 'failed' | 'pending-restart' | 'removed' | 'idle';
}

export interface ExtensionSearchHit {
  name: string;
  version: string;
  description: string;
  date?: string;
  publisher?: string;
  /** 月下载量 */
  downloads: number;
  links: { npm?: string; repository?: string; homepage?: string };
  installed: boolean;
  /** 按哪一类关键字搜到的(`cortico-world` → world,`cortico-provider` → provider,`cortico-bot` → bot) */
  kind?: 'world' | 'provider' | 'bot';
}

/** 装 npm 上的包(可带版本或 dist-tag),或本机一个含 package.json 的目录。 */
export type ExtensionInstallTarget = { name: string; version?: string } | { path: string };

/** 扩展面:清单、搜索、装卸。装卸只改磁盘,加载要重启进程。 */
export interface WebAppExtensionDeps {
  list(): { dir: string; extensions: ExtensionInfo[] };
  /** 不给 kind = world(`cortico-world`)。 */
  search(query: string, kind?: 'world' | 'provider' | 'bot'): Promise<ExtensionSearchHit[]>;
  /**
   * 已加载扩展的浏览器端产物。服务端据此把页 id 映到 `/assets/extensions/<包>/<版本>/<文件>`
   * 并只发这几个文件;缺席 = 没有扩展带面板。
   */
  consoleAssets?(): readonly ExtensionConsoleAsset[];
  /** 返回一句结果描述(含 pnpm 输出尾部) */
  install(target: ExtensionInstallTarget): Promise<string>;
  uninstall(name: string): Promise<string>;
}

/** 规范关机 / 重启的账:本地步骤与外部状态分开记。 */
export interface WebAppShutdownReport {
  localComplete?: boolean;
  complete: boolean;
  steps: Array<{ label: string; ok: boolean; elapsedMs: number; detail?: string }>;
  externalChecks?: Array<{
    key: string;
    label: string;
    status: 'verified-ended' | 'still-live' | 'unknown';
    detail: string;
    manualAction: string;
  }>;
}

/** World 对 agent 的可见性(热开关;不影响 World 自身运行) */
export interface WebAppWorldVisibilityDeps {
  state(): { visibility: Record<string, boolean>; driftedWorlds: string[] };
  /** 返回一句结果描述,按 `language` */
  set(id: string, visible: boolean, language: Language): string;
}

/**
 * World 激活 / 停用 / 重启,全部热生效:装配层写回 `worlds.<id>.enabled`、按定义
 * 重建实例并挂进/撤出 core。未知 id 或前置检查失败抛错,信息原样给操作者。
 */
export interface WebAppWorldActivationDeps {
  /** 激活或停用;返回一句结果描述,按 `language`。 */
  set(id: string, enabled: boolean, language: Language): Promise<string>;
  /** 停下当前实例、按定义重建并重新启动;返回一句结果描述,按 `language`。 */
  restart(id: string, language: Language): Promise<string>;
}

/**
 * 面板中可直接修改、并参与 system 前缀组装的固定文本源。
 * scope 只有两档:人格侧(装配层/Persona声明的)与 World 侧——core 核心
 * 语义无关,不存在 core 归属的提示词模板。
 */
/** 编辑器旁注里的一个占位符:声明 + **此刻的实际展开值**(后者比描述直观得多)。 */
export interface PromptVarView {
  name: string;
  description: string;
  multiline?: boolean;
  /** 此刻会填进去的东西;没人报值时缺席(编辑器标红:模板里用了但没人填) */
  value?: string;
}

export interface PromptDocument {
  key: string;
  title: string;
  scope: 'persona' | 'world';
  description: string;
  content: string;
  revision: string;
  /** `envPrompt`=某 World 进前缀那份;`prefix`=顶层装配表 */
  role?: 'envPrompt' | 'prefix';
  /** 当前模板来源：部署覆盖、bot 包覆盖或 World 默认。保存写入部署覆盖。 */
  origin?: EnvPromptOrigin;
  vars?: PromptVarView[];
}

/** 前缀的一段。`sourceKey` 指向可编辑模板;没有 = 现拼的,编辑器标只读。 */
export interface PrefixSegmentView {
  title: string;
  text: string;
  sourceKey?: string;
}

export interface WebAppPromptDeps {
  /** 标题与说明按 `language`;key、内容与 revision 不随语言变。 */
  list(language: Language): PromptDocument[] | Promise<PromptDocument[]>;
  /** 回执按 `language`。`baseRevision` 过期时抛 `PromptRevisionConflict`,控制台据此回 409。 */
  write(key: string, content: string, baseRevision: string | undefined, language: Language): string;
  /** 删除部署覆盖，回落到 bot 包覆盖或 World 默认。 */
  reset?(key: string, language: Language): string;
  /**
   * 整条前缀的分段视图,**现拼**——不需要活 session。
   *
   * 这一点是有意的:编辑器要改的是**下一条 session 的前缀**,不是当前这条的历史
   * 快照。所以这里现场组装一份"如果现在开一条 session,前缀会长这样"。
   */
  prefix?(): Promise<PrefixSegmentView[]>;
}

/** 工具归属：core 为流程原语，persona 为 Persona 工具，world 的 id/label 指向对应 World。 */
export type ToolOwner =
  | { kind: 'core' }
  | { kind: 'persona' }
  | { kind: 'world'; id: string; label?: string };

export interface WebAppToolSchemasDeps {
  list(): Array<ToolSchema & { owner: ToolOwner }>;
}

export interface WebAppSessionControlDeps {
  /** 重读所有前缀源，只替换当前 session 的 system 消息。回执按 `language`。 */
  reloadPrefix(language: Language): Promise<string>;
}

/** `WebAppPromptDeps.write` 在 `baseRevision` 过期时抛的错;控制台回 409 并标 conflict。 */
export class PromptRevisionConflict extends Error {
  override readonly name = 'PromptRevisionConflict';
}

/**
 * 控制台展示带版本历史的记忆介质时需要的三个形状。
 *
 * 控制台只约束历史记录的展示形状;git、快照或无历史由人格实现选择。
 * TypeScript 结构化类型允许实现侧的既有类型直接满足这些接口。
 */
export interface ConsoleHistoryEntry {
  hash: string;
  fullHash: string;
  author: string;
  email: string;
  date: string;
  message: string;
}

export interface ConsoleCheckpointEntry {
  name: string;
  message: string;
  hash: string;
  date: string;
}

export interface ConsoleMediumStatus {
  available: boolean;
  repo: boolean;
  /** 工作区有未提交改动 */
  dirty: boolean;
  head: string | null;
  lastCommit: ConsoleHistoryEntry | null;
  tags: string[];
}

/** 存档点管理 */
export interface WebAppCheckpointDeps {
  list(): ConsoleCheckpointEntry[];
  /** 新建:提交当前 + 打标记,返回结果描述 */
  create(name: string, note: string): string;
  /** 删除标记 */
  remove(name: string): string;
}

/** 分时段/范围的用量聚合(用量·成本页数据源) */
export interface WebAppUsageDeps {
  status?(): { pending: number; error: string | null };
  aggregate(opts: { from?: string; to?: string; bucket: UsageBucketOption; currency?: string; basis?: 'marginal' | 'equivalent' }): UsageAggregate;
}


/**
 * 一组可调配置项的读写(所有者声明 schema,控制台通用渲染)。
 * 声明来自 core / Persona / 各 World,装配层收集后交进来。
 */
export interface WebAppConfigDeps {
  /** 全部配置组(带 JSON Schema 与当前值),标题与说明按 `language`;id、键与值不随语言变 */
  groups(language: Language): Array<{ group: ConfigGroup; values: ConfigValues }>;
  /** 按组提交:只接受该组 schema 里声明过的键。改了就写回 config.json。回执按 `language`。 */
  set(groupId: string, values: ConfigValues, language: Language): string;
  /** `x-options` 下拉的活选项;缺席或 kind 不认识给空表 */
  options?(kind: string, language: Language): Array<{ value: string; label: string }>;
}

/**
 * 框架级控制台契约。bot 专用的控制面由控制台页(Console Page)提供。
 */
export interface ConsoleSurface {
  /** 事件流(只读) */
  store: EventStoreReader;
  /** persona/工作区绝对路径(工作区浏览) */
  memoryDir: string;
  /** data/目录绝对路径(runlog.jsonl / session-main.jsonl所在) */
  dataDir: string;
  /** bot 根目录。头像固定写入此目录的 avatar.png；未提供时不挂载头像写入面。 */
  botDir?: string;
  /**
   * 控制台的默认语言:印在 `<html lang>` 上,也是没带语言的请求用的那种。缺省按进程读一次
   * 系统语言。每个请求可以经 `CONSOLE_LANGUAGE_HEADER`(WebSocket 握手经
   * `CONSOLE_LANGUAGE_QUERY`)带自己的语言,服务端给控制台的文案按它取。
   */
  language?: Language;
  /**
   * 监听地址。缺省 `127.0.0.1`:控制台没有身份认证,默认不对局域网露面。
   * 要放到反向代理后面或有意让别的机器访问,才显式换成 `0.0.0.0`。
   */
  host?: string;
  /** 主循环状态快照(token/截断/梦状态…有什么给什么) */
  getStatus(): Record<string, unknown>;
  /** 调试通道(可选;不挂载时 /ws/debug 拒绝连接) */
  debug?: WebAppDebugDeps;
  /** session观察(可选;不挂载时 /api/sessions 空、/ws/sessions 拒绝) */
  sessions?: WebAppSessionsDeps;
  /** 可清除的存储部分清单(可选;不挂载时 /api/storage 空)。标签与回执按 `language`;key 不随语言变。 */
  storage?: (language: Language) => StoragePart[];
  /** 用量聚合(可选;不挂载时 /api/usage 空) */
  usage?: WebAppUsageDeps;
  /** 按 schema 声明的可调配置项(可选;不挂载时 /api/config 503) */
  config?: WebAppConfigDeps;
  /** 本机路径选择器。测试与嵌入环境可替换；缺省使用当前平台的原生对话框。 */
  pathPicker?: PathPicker;
  /** 已挂载 World 清单(可选;不挂载时 /api/worlds 空)。async:envPrompt可能异步。显示名与理由按 `language` */
  worlds?: (language: Language) => Promise<ConsoleWorldInfo[]> | ConsoleWorldInfo[];
  /** World 对 agent 的可见性开关(可选;不挂载时 /api/worlds/visibility 503) */
  worldVisibility?: WebAppWorldVisibilityDeps;
  /** World 激活开关(可选;不挂载时 /api/worlds/activation 503) */
  worldActivation?: WebAppWorldActivationDeps;
  /** 固定提示词源文件编辑。 */
  prompts?: WebAppPromptDeps;
  /** 工具 schema 的只读完整结构。 */
  toolSchemas?: WebAppToolSchemasDeps;
  /** 当前 session 的非破坏性前缀重载。 */
  sessionControl?: WebAppSessionControlDeps;
  /**
   * 可选的运行控制，未挂载时 /api/run/* 返回 503；暂停期间事件仍落库排队。
   * shutdown 按装配层顺序停止投递、IO、托管 LLM server 并落盘，各步有时间预算并返回结果；未提供时不显示关机键，进程退出由装配层决定。
   */
  run?: {
    pause(): void;
    resume(): void;
    isPaused(): boolean;
    /** 账里的步骤名与总结行按 `language`。 */
    shutdown?(language: Language): Promise<WebAppShutdownReport>;
    /**
     * 规范关机,退出前落下重启标志;启动器循环读到标志后重新拉起。没有启动器循环
     * (`supervised` 为 false)时它就是一次关机,页面上要说清楚。
     */
    restart?(language: Language): Promise<WebAppShutdownReport>;
    supervised?: boolean;
  };
  /** 扩展装卸(可选;不挂载时 /api/extensions* 503)。 */
  extensions?: WebAppExtensionDeps;
  /**
   * 控制台页的贡献来源(World 与 bot 各自的控制面)。装配层决定收什么;
   * WebApp 只负责聚合、校验与转交,不认识任何具体的一页。
   * 不挂载时 /api/console/manifest 返回一份只有 framework 能力的空 manifest。
   */
  consolePageSources?: () => ConsolePageSource[];
  /**
   * 有没有一个可用的端点。缺省不挂:「语言模型」那一行不点灯。
   */
  providersLamp?: (language: Language) => ConsoleLamp;
  /**
   * 浏览器端构建产物目录(含 asset-manifest.json)。缺省取仓库的 `dist/web`。
   * 没构建过不是错误——控制台照常起,只是没有任何页扩展。
   */
  webDistDir?: string;
  /**
   * 控制台页流的心跳间隔(毫秒),缺省 30 秒。
   * 反向代理的空闲超时比这短时要调小;测试里调到很小以便验证半开连接被清掉。
   */
  streamHeartbeatMs?: number;
  log: Logger;
}

/**
 * 服务端注入面。bot 专属的控制面**全部**走控制台页(`consolePageSources`),
 * 框架不再有任何具名扩展槽位。
 */
export type WebAppDeps = ConsoleSurface;


const FILE_MAX_BYTES = 1024 * 1024; // 1MB
const AVATAR_FILE = 'avatar.png';
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function revisionOf(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

function intParam(v: unknown): number | undefined {
  if (typeof v !== 'string' || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : undefined;
}

function strParam(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** 展示时过滤 contextDelivery 为 archive-only 的记录，不修改存储。 */
function dropArchiveOnly(events: readonly EventEnvelope[]): EventEnvelope[] {
  return events.filter((event) => event.contextDelivery !== 'archive-only');
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** GET 形式的面板调用把 args 编码成 query 里的 JSON 数组。 */
function parseQueryArgs(raw: unknown): { args: unknown[] } | { error: string } {
  if (typeof raw !== 'string' || raw.trim() === '') return { args: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: 'args 不是合法 JSON' };
  }
  return Array.isArray(parsed) ? { args: parsed } : { error: 'args 必须是 JSON 数组' };
}

const hasPort = (h: string): boolean => /:\d+$/.test(h);
const barePort = (h: string): string => h.replace(/:\d+$/, '');

/** 按 Host 校验 Origin；缺失 Origin 时放行，null、非法或主机不匹配时拒绝。 */
function isForeignOrigin(origin: unknown, hostHeader: unknown): boolean {
  if (typeof origin !== 'string' || origin === '') return false;
  if (origin === 'null') return true; // 沙箱 iframe / file:// 一类,不是本控制台
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return true;
  }
  const host = typeof hostHeader === 'string' ? hostHeader : '';
  if (!originHost || !host) return true;
  if (originHost === host) return false;
  // 任一侧省了端口(走默认端口时浏览器会省)→ 只比主机名
  if ((!hasPort(originHost) || !hasPort(host)) && barePort(originHost) === barePort(host)) return false;
  return true;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]']);

/**
 * Host 头必须是回环名或显式绑定的地址。DNS rebinding 让外站页面的 Origin 与 Host 同名,
 * 同源闸门因此失效;这一关把请求钉在浏览器真正访问的名字上。绑到通配地址即操作员
 * 已选择对外露面,不校验。
 */
function isAllowedHost(hostHeader: unknown, listenHost: string): boolean {
  if (WILDCARD_HOSTS.has(listenHost)) return true;
  if (typeof hostHeader !== 'string' || hostHeader === '') return false;
  const name = barePort(hostHeader).toLowerCase();
  return LOOPBACK_HOSTS.has(name) || name === listenHost.toLowerCase() || name === `[${listenHost.toLowerCase()}]`;
}

/**
 * 控制台页流式通道的 WS 路径:`/ws/providers/<page>/panels/<panel>`
 * (与 `panelStreamRoute` 同一形状;路径里的 `providers` 段是线协议形状,未随类型改名)。
 * 两段都是 `encodeURIComponent` 过的——
 * page id 必含冒号,在 URL 里是 `%3A`,所以这里必须解码回来再去注册表查。
 */
const STREAM_PATH_RE = /^\/ws\/providers\/([^/]+)\/panels\/([^/]+)$/;

function parseStreamPath(pathname: string): { pageId: string; panelId: string } | null {
  const m = STREAM_PATH_RE.exec(pathname);
  if (!m) return null;
  try {
    return { pageId: decodeURIComponent(m[1]), panelId: decodeURIComponent(m[2]) };
  } catch {
    return null; // 坏的百分号编码:当成不认识的路径
  }
}

/** WS 关闭时 reason 最多 123 字节(协议硬限),超了 ws 会直接抛。 */
function clipCloseReason(reason: string): string {
  let out = reason;
  while (Buffer.byteLength(out, 'utf8') > 123) out = out.slice(0, -1);
  return out;
}

function frameText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return String(data);
}

/** 那一页还没注册 onMessage 时最多攒几帧(解析要 await,期间对端可能已经发帧)。 */
const STREAM_PREBUFFER = 64;

/** 心跳间隔。一拍没等到 pong 就判失联——最坏 2 拍发现半开连接。 */
const STREAM_HEARTBEAT_MS = 30_000;

/**
 * 把一条真 ws 连接包成协议里的 `ConsoleStream` 交给那一页。
 *
 * 这层适配是**故意**的:协议里那个接口不认识 ws(它同时被浏览器端 import,
 * 而跑在子进程里的贡献方也要能实现它),所以宿主细节全压在这个函数里。
 * 三条约定在这里落实:
 *  - 连接已关时 `send` 静默丢弃,不抛(否则每次推送都要自己判活)
 *  - `onClose` 只触发一次,且对端关/出错/服务器 stop 三条路都到得了
 *    (那一页可能挂着定时器等这个回调来清理)
 *  - socket 出错时 `terminate()` 兜底,不留半死连接
 */
function toConsoleStream(ws: WebSocket, log: Logger, heartbeatMs: number): ConsoleStream {
  const messageCbs: Array<(text: string) => void> = [];
  const closeCbs: Array<() => void> = [];
  const pending: string[] = [];
  let closed = false;
  let dropped = 0;

  const fireClose = (): void => {
    if (closed) return;
    closed = true;
    for (const cb of [...closeCbs]) {
      try { cb(); } catch (err) { log.error('provider 流 onClose 回调抛错', { error: String(err) }); }
    }
    closeCbs.length = 0;
  };

  ws.on('message', (data) => {
    const text = frameText(data);
    if (messageCbs.length === 0) {
      if (pending.length >= STREAM_PREBUFFER) {
        dropped += 1;
        if (dropped === 1) log.warn('provider 流未注册 onMessage,超额帧已丢弃');
        return;
      }
      pending.push(text);
      return;
    }
    for (const cb of [...messageCbs]) {
      try { cb(text); } catch (err) { log.error('provider 流 onMessage 回调抛错', { error: String(err) }); }
    }
  });
  ws.on('close', fireClose);
  ws.on('error', (err) => {
    log.warn('provider 流连接出错', { error: String(err) });
    try { ws.terminate(); } catch { /* ignore */ }
    fireClose();
  });

  /** 上一轮 ping 未收到 pong 时终止连接，触发关闭清理。 */
  let alive = true;
  ws.on('pong', () => { alive = true; });
  const beat = setInterval(() => {
    if (!alive) {
      log.warn('provider 流心跳失联,断开');
      try { ws.terminate(); } catch { /* ignore */ }
      return;
    }
    alive = false;
    try { ws.ping(); } catch { /* 连接正在关,下一拍自会收场 */ }
  }, heartbeatMs);
  closeCbs.push(() => clearInterval(beat));

  return {
    get open(): boolean {
      return !closed && ws.readyState === 1 /* OPEN */;
    },
    send(data: string): void {
      if (closed || ws.readyState !== 1) return; // 已关:静默丢弃
      try { ws.send(data); } catch (err) { log.warn('provider 流推送失败', { error: String(err) }); }
    },
    close(reason?: string): void {
      try {
        ws.close(1000, reason === undefined ? undefined : clipCloseReason(reason));
      } catch {
        try { ws.terminate(); } catch { /* ignore */ }
        fireClose();
      }
    },
    onMessage(cb: (text: string) => void): void {
      messageCbs.push(cb);
      if (messageCbs.length === 1 && pending.length) {
        const buffered = pending.splice(0, pending.length);
        for (const text of buffered) {
          try { cb(text); } catch (err) { log.error('provider 流 onMessage 回调抛错', { error: String(err) }); }
        }
      }
    },
    onClose(cb: () => void): void {
      // 注册晚于关闭时立刻补一次:那一页的清理不该因为竞态而丢
      if (closed) { try { cb(); } catch { /* ignore */ } return; }
      closeCbs.push(cb);
    },
  };
}


export class WebApp {
  private readonly deps: WebAppDeps;
  private readonly app: express.Express;
  private readonly listenHost: string;
  /** 控制台页聚合。没挂 consolePageSources 时它也在,只是永远收到空清单。 */
  private readonly consolePages: ConsolePageRegistry;
  private readonly assets: ConsoleAssets;
  /** 已加载扩展的浏览器端产物。进程生命期内不变(加载新扩展要重启),构造时算一次。 */
  private readonly extensionAssets: readonly ExtensionConsoleAsset[];
  private readonly webDistDir: string;
  /** 默认语言:印在 `<html lang>` 上,没带语言的请求也用它。构造时定死。 */
  private readonly language: Language;
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  /** /ws/debug 已连接客户端(广播目标) */
  private readonly debugClients = new Set<WebSocket>();
  /** /ws/sessions 已连接客户端(session统计广播;chat页轻量订阅用) */
  private readonly sessionClients = new Set<WebSocket>();

  constructor(deps: WebAppDeps) {
    this.deps = deps;
    this.listenHost = deps.host ?? '127.0.0.1';
    this.language = deps.language ?? systemLanguage();
    this.webDistDir = deps.webDistDir ?? fileURLToPath(new URL('../../dist/web', import.meta.url));
    this.extensionAssets = deps.extensions?.consoleAssets?.() ?? [];
    this.assets = new ConsoleAssets(this.webDistDir, deps.log, this.extensionAssets);
    this.consolePages = new ConsolePageRegistry({
      sources: () => deps.consolePageSources?.() ?? [],
      capabilities: () => this.frameworkCapabilities(),
      assets: this.assets,
      log: deps.log,
    });
    this.app = this.buildApp();
    // 调试观察接缝:监听器只在构造时注册一次;之后所有帧广播给当前客户端集合
    const dbg = deps.debug;
    if (dbg) {
      dbg.onSessionAppend((message, index) => {
        this.debugBroadcast({ t: 'session.append', index, message });
        // status顺带推一份(不定时轮询,append即代表状态变化)
        this.debugBroadcast({ t: 'status', status: this.safeStatus() });
      });
      // reset 顺带带上合成开头现值:前缀重载/交接都走 reset,标注块跟着刷新
      dbg.onSessionReset((messages) => this.debugBroadcast({
        t: 'session.reset',
        messages,
        head: dbg.sessionHead?.() ?? [],
      }));
      dbg.onEvent((envelope) => this.debugBroadcast({ t: 'event', envelope }));
      dbg.onRunlog((entry) => this.debugBroadcast({ t: 'runlog', entry }));
    }
    // session统计变化→全量列表推送(列表小,每次LLM调用一帧,频率低)。
    // 同帧也走debug通道(chat调试台已连/ws/debug,免开第二条连接)。
    deps.sessions?.onChange(() => {
      this.sessionsBroadcast();
      this.debugBroadcast({ t: 'sessions', sessions: this.safeSessionList() });
    });
  }

  /**
   * 框架级表面挂没挂。同时供 `/api/capabilities` 与 `/api/console/manifest` 使用,
   * 两处必须是同一份事实。
   *
   * 这里**只有框架级表面**。各页自己的能力("有没有模型档位面板"这种)由
   * manifest 里有没有对应的页回答,不在中央留一份知识。
   */
  /**
   * 这个请求的界面语言:HTTP 看 `CONSOLE_LANGUAGE_HEADER`,WebSocket 握手看 URL 里的
   * `CONSOLE_LANGUAGE_QUERY`;缺席或不认识 = 默认语言。
   */
  private languageOf(req: { headers: Record<string, unknown>; url?: string }): Language {
    const header = req.headers[CONSOLE_LANGUAGE_HEADER];
    if (isLanguage(header)) return header;
    let fromQuery: string | null = null;
    try {
      fromQuery = new URL(req.url ?? '', 'http://localhost').searchParams.get(CONSOLE_LANGUAGE_QUERY);
    } catch { /* 坏 URL:当没带 */ }
    return isLanguage(fromQuery) ? fromQuery : this.language;
  }

  private frameworkCapabilities(): Record<string, boolean> {
    return {
      debug: !!this.deps.debug,
      sessions: !!this.deps.sessions,
      storage: (this.deps.storage?.(this.language) ?? []).length > 0,
      usage: !!this.deps.usage,
      config: !!this.deps.config,
      worlds: !!this.deps.worlds,
      worldVisibility: !!this.deps.worldVisibility,
      worldActivation: !!this.deps.worldActivation,
      prompts: !!this.deps.prompts,
      toolSchemas: !!this.deps.toolSchemas,
      sessionControl: !!this.deps.sessionControl,
      run: !!this.deps.run,
      shutdown: !!this.deps.run?.shutdown,
      restart: !!this.deps.run?.restart,
      supervised: this.deps.run?.supervised === true,
      extensions: !!this.deps.extensions,
      avatar: !!this.deps.botDir,
    };
  }

  /** 关机和重启请求等待编排完成，并返回各步骤结果。 */
  private async respondPowerAction(
    res: Response,
    language: Language,
    action: ((language: Language) => Promise<WebAppShutdownReport>) | undefined,
    unavailable: string,
    logLine: string,
    trailer: string,
  ): Promise<void> {
    if (!action) { res.status(503).json({ error: unavailable }); return; }
    this.deps.log.warn(logLine);
    try {
      const report = await action(language);
      const skipped = report.steps.filter((s) => !s.ok);
      const localComplete = report.localComplete ?? skipped.length === 0;
      const externalChecks = report.externalChecks ?? [];
      const unverified = externalChecks.filter((check) => check.status !== 'verified-ended');
      const t = pick(language, SERVER_TEXT);
      const localResult = !localComplete
        ? t.shutdownSkipped(skipped.length, skipped.map((s) => s.label))
        : t.shutdownComplete(report.steps.length);
      const externalResult = unverified.length > 0
        ? t.externalUnverified(unverified.map((check) =>
          t.externalItem(check.label, check.status, check.detail ?? '', check.manualAction ?? '')))
        : externalChecks.length > 0
          ? t.externalVerified
          : '';
      res.json({
        ok: report.complete,
        localComplete,
        complete: report.complete,
        steps: report.steps,
        externalChecks,
        result: `${localResult}${externalResult}，${trailer}`,
      });
    } catch (err) {
      this.deps.log.error('关机编排失败', { error: String(err) });
      if (!res.headersSent) res.status(500).json({ error: String(err) });
    }
  }

  /**
   * 把那一页的返回值按约定送回：内存字节走 `$binary`，大文件走 `$file`
   * 流式发送，其余按 JSON。语义不解释，形状归那一页。
   */
  private async sendInvokeResult(req: Request, res: Response, value: unknown): Promise<void> {
    if (isBinaryResult(value)) {
      const { mime, base64 } = value.$binary;
      res.setHeader('Content-Type', typeof mime === 'string' ? mime : 'application/octet-stream');
      res.send(Buffer.from(base64, 'base64'));
      return;
    }
    if (isFileResult(value)) {
      if (!isAbsolute(value.$file.path)) {
        res.status(500).json({ error: 'provider 返回了非绝对文件路径' });
        return;
      }
      await this.sendVerifiedFile(req, res, value.$file);
      return;
    }
    if (
      typeof value === 'object'
      && value !== null
      && Object.prototype.hasOwnProperty.call(value, '$file')
    ) {
      res.status(500).json({ error: 'provider 返回了无效文件描述' });
      return;
    }
    res.json(value ?? null);
  }

  private async sendVerifiedFile(
    req: Request,
    res: Response,
    file: ConsoleFileResult['$file'],
  ): Promise<void> {
    const handle = await openFile(file.path, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== file.bytes) {
        throw new Error('provider 文件大小与声明不匹配');
      }

      const hash = createHash('sha256');
      const chunk = Buffer.allocUnsafe(Math.min(Math.max(file.bytes, 1), 64 * 1024));
      let offset = 0;
      while (offset < file.bytes) {
        const { bytesRead } = await handle.read(
          chunk,
          0,
          Math.min(chunk.byteLength, file.bytes - offset),
          offset,
        );
        if (bytesRead === 0) throw new Error('provider 文件在校验期间被截断');
        hash.update(chunk.subarray(0, bytesRead));
        offset += bytesRead;
      }
      if (hash.digest('hex') !== file.sha256) {
        throw new Error('provider 文件 hash 与声明不匹配');
      }

      res.type(file.mime);
      res.setHeader('Content-Length', String(file.bytes));
      if (req.method === 'HEAD' || file.bytes === 0) {
        res.end();
        return;
      }

      // 显式 fd 让响应读取复用上面完成校验的同一次 open；路径不会被重新打开。
      await pipeline(createReadStream(file.path, {
        fd: handle.fd,
        autoClose: false,
        start: 0,
        end: file.bytes - 1,
      }), res);
    } finally {
      await handle.close();
    }
  }

  private safeSessionList(): SessionStats[] {
    try {
      return this.deps.sessions?.list() ?? [];
    } catch {
      return [];
    }
  }

  private sessionsBroadcast(): void {
    const src = this.deps.sessions;
    if (!src || this.sessionClients.size === 0) return;
    let raw: string;
    try {
      raw = JSON.stringify({ t: 'sessions', sessions: src.list() });
    } catch {
      return;
    }
    for (const ws of [...this.sessionClients]) {
      if (ws.readyState === 1 /* OPEN */) {
        try { ws.send(raw); } catch { this.sessionClients.delete(ws); }
      } else if (ws.readyState > 1) {
        this.sessionClients.delete(ws);
      }
    }
  }

  /** /ws/sessions 新连接:发全量列表,之后变化实时推 */
  private handleSessionsConnection(ws: WebSocket): void {
    const src = this.deps.sessions;
    if (!src) {
      try { ws.send(JSON.stringify({ t: 'sys', text: 'session观察不可用' })); } catch { /* ignore */ }
      ws.close(1013, 'sessions deps not mounted');
      return;
    }
    this.sessionClients.add(ws);
    ws.on('close', () => this.sessionClients.delete(ws));
    ws.on('error', () => {
      this.sessionClients.delete(ws);
      try { ws.terminate(); } catch { /* ignore */ }
    });
    try {
      ws.send(JSON.stringify({ t: 'sessions', sessions: src.list() }));
    } catch (err) {
      this.deps.log.warn('sessions hello发送失败', { error: String(err) });
    }
  }

  /** 通道不可用时先发送错误帧，再关闭连接：no-surface 使用 1013，其余使用 1008。 */
  private handleConsolePageStream(ws: WebSocket, pageId: string, panelId: string, language: Language): void {
    // 先包再解析:解析要 await,期间对端可能已经发帧,适配器会替那一页攒着
    const socket = toConsoleStream(ws, this.deps.log, this.deps.streamHeartbeatMs ?? STREAM_HEARTBEAT_MS);
    void this.consolePages.resolveStream(pageId, panelId, language).then(
      (out) => {
        if (!out.ok) {
          this.closeStreamWith(
            ws,
            out.failure.message,
            out.failure.kind === 'no-surface' ? 1013 : 1008,
            out.failure.kind,
          );
          return;
        }
        try {
          out.open(socket);
        } catch (err) {
          // 那一页的 stream() 抛错只关这一条连接:一个面板炸了不该带走控制台
          this.deps.log.error(`provider 流式面抛错 ${pageId}/${panelId}`, { error: String(err) });
          this.closeStreamWith(ws, `流式面出错: ${String(err)}`, 1011, 'stream error');
        }
      },
      (err) => {
        this.deps.log.error(`provider 流解析失败 ${pageId}/${panelId}`, { error: String(err) });
        this.closeStreamWith(ws, `流解析失败: ${String(err)}`, 1011, 'resolve error');
      },
    );
  }

  /** 发一帧说明再关。reason 走 ASCII 短句(帧里才是给人看的中文,reason 有 123 字节上限)。 */
  private closeStreamWith(ws: WebSocket, text: string, code: number, reason: string): void {
    try { ws.send(JSON.stringify({ t: 'sys', text })); } catch { /* ignore */ }
    try { ws.close(code, reason); } catch { try { ws.terminate(); } catch { /* ignore */ } }
  }

  private safeStatus(): Record<string, unknown> {
    try {
      return this.deps.getStatus() ?? {};
    } catch (err) {
      return { statusError: String(err) };
    }
  }

  private debugBroadcast(payload: unknown): void {
    if (this.debugClients.size === 0) return;
    const raw = JSON.stringify(payload);
    for (const ws of [...this.debugClients]) {
      if (ws.readyState === 1 /* OPEN */) {
        try { ws.send(raw); } catch { this.debugClients.delete(ws); }
      } else if (ws.readyState > 1) {
        this.debugClients.delete(ws);
      }
    }
  }

  /** /ws/debug 新连接:发hello全量快照,之后实时帧由构造时注册的监听器广播 */
  private handleDebugConnection(ws: WebSocket): void {
    const dbg = this.deps.debug;
    if (!dbg) {
      try { ws.send(JSON.stringify({ t: 'sys', text: '调试通道不可用' })); } catch { /* ignore */ }
      ws.close(1013, 'debug deps not mounted');
      return;
    }
    this.debugClients.add(ws);
    ws.on('close', () => this.debugClients.delete(ws));
    ws.on('error', () => {
      this.debugClients.delete(ws);
      try { ws.terminate(); } catch { /* ignore */ }
    });
    try {
      ws.send(JSON.stringify({
        t: 'hello',
        session: dbg.sessionMessages(),
        head: dbg.sessionHead?.() ?? [],
        toolSchemas: dbg.toolSchemas(),
        events: dropArchiveOnly(this.deps.store.range({ limit: 400 })).slice(-200),
        runlog: dbg.recentLog?.(200) ?? [],
        status: this.safeStatus(),
        sessions: this.safeSessionList(),
      }));
    } catch (err) {
      this.deps.log.warn('调试hello发送失败', { error: String(err) });
    }
  }

  /**
   * 启动,返回实际监听端口。
   * 传 0 由 OS 分配;传固定端口时若已被占用则顺延到下一个空闲端口。
   */
  async start(port: number): Promise<number> {
    if (this.server) throw new Error('WebApp已在运行');
    const wss = new WebSocketServer({ noServer: true });

    const attachUpgrade = (server: Server): void => {
      server.on('upgrade', (req, socket, head) => {
        let pathname = '';
        try {
          pathname = new URL(req.url ?? '', 'http://localhost').pathname;
        } catch { /* 保持空串 */ }
        // 框架自己的两条固定路径 + 通用控制台页流式通道(路径带 page/panel 两段)
        const stream = parseStreamPath(pathname);
        const framework = pathname === '/ws/debug' || pathname === '/ws/sessions';
        if (!framework && !stream) {
          socket.destroy();
          return;
        }
        if (!isAllowedHost(req.headers.host, this.listenHost)) {
          this.deps.log.warn('拒绝 Host 不在白名单的 WebSocket 连接', {
            path: pathname, host: String(req.headers.host),
          });
          socket.destroy();
          return;
        }
        // 跨站页面开的 WS 不受同源策略限制,只能在 upgrade 这一关自己拦(见 isForeignOrigin)
        if (isForeignOrigin(req.headers.origin, req.headers.host)) {
          this.deps.log.warn('拒绝跨站WebSocket连接', {
            path: pathname, origin: String(req.headers.origin),
          });
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          if (stream) {
            this.handleConsolePageStream(ws, stream.pageId, stream.panelId, this.languageOf(req));
            return;
          }
          if (pathname === '/ws/debug') {
            this.handleDebugConnection(ws);
            return;
          }
          this.handleSessionsConnection(ws);
        });
      });
    };

    const listenOnce = async (candidate: number): Promise<Server> => {
      const server = createServer(this.app);
      attachUpgrade(server);
      try {
        await new Promise<void>((res, rej) => {
          server.once('error', rej);
          server.listen(candidate, this.listenHost, () => {
            server.removeListener('error', rej);
            res();
          });
        });
      } catch (err) {
        server.close();
        throw err;
      }
      return server;
    };

    // 固定端口被占时顺延;0 交给 OS 分配且只尝试一次。
    //
    // 固定端口最多尝试 5 个候选端口。
    const maxAttempts = port === 0 ? 1 : 5;
    let server: Server | null = null;
    let lastErr: unknown;
    for (let i = 0; i < maxAttempts; i++) {
      const candidate = port === 0 ? 0 : port + i;
      try {
        server = await listenOnce(candidate);
        if (i > 0) {
          // 端口顺延记录 warn，便于发现预期端口被其他实例占用。
          this.deps.log.warn(
            `端口 ${port} 被占用，改用 ${candidate}。`,
          );
        }
        break;
      } catch (err) {
        lastErr = err;
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== 'EADDRINUSE' || port === 0) throw err;
      }
    }
    if (!server) {
      throw lastErr instanceof Error
        ? lastErr
        : new Error(`端口 ${port}–${port + maxAttempts - 1} 均不可用`);
    }

    this.server = server;
    this.wss = wss;
    const actual = (server.address() as AddressInfo).port;
    this.deps.log.info(`web面板已启动 http://${this.listenHost}:${actual}/`);
    return actual;
  }

  /** 实际绑定的地址(未启动=null)。缺省 `127.0.0.1`,即局域网上没有这个端口。 */
  get boundAddress(): string | null {
    const addr = this.server?.address();
    return addr && typeof addr === 'object' ? addr.address : null;
  }

  async stop(): Promise<void> {
    const wss = this.wss;
    const server = this.server;
    this.wss = null;
    this.server = null;
    if (wss) {
      for (const client of wss.clients) {
        try { client.terminate(); } catch { /* ignore */ }
      }
      await new Promise<void>((res) => wss.close(() => res()));
    }
    this.debugClients.clear();
    this.sessionClients.clear();
    if (server) {
      await new Promise<void>((res) => {
        server.close(() => res());
        server.closeAllConnections();
      });
    }
  }


  private buildApp(): express.Express {
    const app = express();
    app.disable('x-powered-by');

    app.use((req, res, next) => {
      if (isAllowedHost(req.headers.host, this.listenHost)) {
        next();
        return;
      }
      this.deps.log.warn('拒绝 Host 不在白名单的请求', { path: req.path, host: String(req.headers.host) });
      res.status(421).json({ error: 'Host 不被接受' });
    });

    // 写操作的同源闸门:控制台的每个 POST 都是真副作用(改配置、删存储、回滚人格),
    // 别的站点的页面能凭浏览器自动发这些请求,拦这一下就断了。读接口不设闸——
    // 跨站读本来就拿不到响应体(没有一个 CORS 头放开过)。
    app.use((req, res, next) => {
      if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
        next();
        return;
      }
      if (!isForeignOrigin(req.headers.origin, req.headers.host)) {
        next();
        return;
      }
      this.deps.log.warn('拒绝跨站写请求', { path: req.path, origin: String(req.headers.origin) });
      res.status(403).json({ error: '跨站请求被拒绝' });
    });

    const wrap = (h: (req: Request, res: Response) => void) => (req: Request, res: Response) => {
      try {
        h(req, res);
      } catch (err) {
        this.deps.log.error(`API错误 ${req.path}`, { error: String(err) });
        if (!res.headersSent) res.status(500).json({ error: String(err) });
      }
    };
    app.get('/api/status', wrap((_req, res) => {
      res.json({ ...this.safeStatus(), uptimeSec: Math.round(process.uptime()) });
    }));

    app.get('/api/avatar', wrap((_req, res) => {
      const dir = this.deps.botDir;
      if (!dir) { res.status(404).end(); return; }
      const file = join(dir, AVATAR_FILE);
      if (!existsSync(file)) { res.status(404).end(); return; }
      res.setHeader('Cache-Control', 'no-store');
      res.type('png').send(readFileSync(file));
    }));

    app.post('/api/avatar', express.raw({ type: 'image/png', limit: AVATAR_MAX_BYTES }), wrap((req, res) => {
      const dir = this.deps.botDir;
      if (!dir) { res.status(503).json({ error: '头像存储不可用' }); return; }
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length <= PNG_SIGNATURE.length || !body.subarray(0, 8).equals(PNG_SIGNATURE)) {
        res.status(400).json({ error: '头像必须是有效的 PNG 图片' });
        return;
      }
      const file = join(dir, AVATAR_FILE);
      const temporary = join(dir, `.${AVATAR_FILE}.${process.pid}.tmp`);
      writeFileSync(temporary, body);
      rmSync(file, { force: true });
      renameSync(temporary, file);
      this.deps.log.warn('bot 头像已更新', { file: AVATAR_FILE });
      res.json({ ok: true, file: AVATAR_FILE });
    }));

    // 能力清单只声明挂载情况，前端据此省略未挂载面板。
    app.get('/api/capabilities', wrap((_req, res) => {
      res.json({ capabilities: this.frameworkCapabilities() });
    }));

    // 事件流按 store.range 的 from/to 游标区间查询，默认最近 100 条，to 用于向前翻页。
    // 默认隐藏 archive-only，避免原始归档与投影重复展示；不修改原始归档，archive=1 可查看全部记录。
    app.get('/api/events', wrap((req, res) => {
      const q: EventRangeQuery = {};
      const from = intParam(req.query.from);
      if (from !== undefined) q.fromCursor = from;
      const to = intParam(req.query.to);
      if (to !== undefined) q.toCursor = to;
      const limit = clamp(intParam(req.query.limit) ?? 100, 1, 1000);
      const source = strParam(req.query.source);
      if (source) q.source = source;
      const withArchive = strParam(req.query.archive) === '1';
      if (withArchive) {
        q.limit = limit;
        res.json({ latest: this.deps.store.latestCursor(), events: this.deps.store.range(q) });
        return;
      }
      // 过滤会吃掉配额,所以多取一截再截尾——否则"最近 100 条"实际只剩一半。
      q.limit = clamp(limit * 2, 1, 2000);
      const events = dropArchiveOnly(this.deps.store.range(q)).slice(-limit);
      res.json({ latest: this.deps.store.latestCursor(), events });
    }));

    // 运行日志:服务端按级别/区域/小类/轮次/关键词过滤,从文件尾部向前扫到够数为止。
    // run 缺省为当前 run;文件不存在→[]。
    app.get('/api/log', wrap((req, res) => {
      const limit = clamp(intParam(req.query.limit) ?? 200, 1, 2000);
      const runId = strParam(req.query.run) ?? this.deps.debug?.runId?.();
      if (!runId) { res.json([]); return; }
      const pred = logPredicate({
        level: strParam(req.query.level), area: strParam(req.query.area), event: strParam(req.query.event),
        grep: strParam(req.query.grep), since: strParam(req.query.since), round: intParam(req.query.round), call: strParam(req.query.call),
      });
      res.json(readTailRecordsWhere(join(this.deps.dataDir, 'runs', runId, 'log.jsonl'), limit, pred));
    }));

    app.get('/api/runs', wrap((_req, res) => {
      res.json({ current: this.deps.debug?.runId?.() ?? null, runs: readRunsIndex(join(this.deps.dataDir, 'runs', 'index.jsonl')) });
    }));

    app.get('/api/sessions', wrap((_req, res) => {
      const src = this.deps.sessions;
      res.json({ sessions: src ? src.list() : [] });
    }));

    // 某个session的当前消息流(fork含继承的主session前缀,可能较大)
    app.get('/api/sessions/messages', wrap((req, res) => {
      const src = this.deps.sessions;
      if (!src) { res.status(503).json({ error: 'session观察不可用' }); return; }
      const id = strParam(req.query.id);
      if (!id) { res.status(400).json({ error: '缺少id参数' }); return; }
      const messages = src.messages(id);
      if (messages === null) { res.status(404).json({ error: `没有这个session: ${id}` }); return; }
      res.json({ id, messages, estTokens: estimateMessagesTokens(messages) });
    }));

    app.get('/api/storage', wrap((req, res) => {
      const parts = (this.deps.storage?.(this.languageOf(req)) ?? []).map((p) => {
        let stat = '';
        try { stat = p.stat(); } catch (err) { stat = `统计失败: ${String(err)}`; }
        return {
          key: p.key, label: p.label, kind: p.kind, group: p.group,
          location: p.location, danger: !!p.danger, note: p.note, stat,
        };
      });
      res.json({ parts });
    }));

    // 清除某个存储部分(运维动作;POST,key走query免body解析)
    app.post('/api/storage/clear', (req: Request, res: Response) => {
      void (async () => {
        const key = strParam(req.query.key);
        if (!key) { res.status(400).json({ error: '缺少key参数' }); return; }
        const part = (this.deps.storage?.(this.languageOf(req)) ?? []).find((p) => p.key === key);
        if (!part) { res.status(404).json({ error: `没有这个存储部分: ${key}` }); return; }
        try {
          const result = await part.clear();
          this.deps.log.warn(`存储部分已清除: ${key}`, { result });
          res.json({ ok: true, result });
        } catch (err) {
          this.deps.log.error(`存储清除失败: ${key}`, { error: String(err) });
          res.status(500).json({ error: String(err) });
        }
      })();
    });

    // 一键清空:按order升序清除全部存储部分(session最后);逐项结果返回
    app.post('/api/storage/clear-all', (req: Request, res: Response) => {
      void (async () => {
        const parts = [...(this.deps.storage?.(this.languageOf(req)) ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        if (!parts.length) { res.status(404).json({ error: '服务端未挂载存储清单' }); return; }
        const results: Array<{ key: string; ok: boolean; result: string }> = [];
        for (const part of parts) {
          try {
            results.push({ key: part.key, ok: true, result: String(await part.clear()) });
          } catch (err) {
            results.push({ key: part.key, ok: false, result: String(err) });
          }
        }
        this.deps.log.warn('存储已一键清空', { results });
        res.json({ ok: results.every((r) => r.ok), results });
      })();
    });

    // 暂停/继续:暂停=事件照常落库排队但不投递唤醒;继续=积压一次性投递
    app.post('/api/run/pause', wrap((req, res) => {
      const run = this.deps.run;
      if (!run) { res.status(503).json({ error: '运行控制不可用' }); return; }
      run.pause();
      this.deps.log.warn('运行已暂停(人工操作)');
      res.json({ ok: true, paused: true, result: pick(this.languageOf(req), SERVER_TEXT).paused });
    }));

    app.post('/api/run/resume', wrap((req, res) => {
      const run = this.deps.run;
      if (!run) { res.status(503).json({ error: '运行控制不可用' }); return; }
      run.resume();
      this.deps.log.warn('运行已继续(人工操作)');
      res.json({ ok: true, paused: false, result: pick(this.languageOf(req), SERVER_TEXT).resumed });
    }));

    /** 将关机请求转交装配层，等待完成后返回各步骤结果。 */
    app.post('/api/run/shutdown', (req: Request, res: Response) => {
      void this.respondPowerAction(
        res, this.languageOf(req), this.deps.run?.shutdown, '关机控制不可用', '收到关机请求(人工操作)', '进程即将退出',
      );
    });

    // 重启 = 落下重启标志 + 规范关机。有没有启动器循环把它拉起来,回执里说明。
    app.post('/api/run/restart', (req: Request, res: Response) => {
      const supervised = this.deps.run?.supervised === true;
      const language = this.languageOf(req);
      void this.respondPowerAction(
        res, language, this.deps.run?.restart, '重启控制不可用', '收到重启请求(人工操作)',
        supervised ? pick(language, SERVER_TEXT).exitSupervised : pick(language, SERVER_TEXT).exitUnsupervised,
      );
    });

    // 已挂载 World 清单(前端"World"层的卡片数据源)
    app.get('/api/worlds', (req: Request, res: Response) => {
      void (async () => {
        try {
          const src = this.deps.worlds;
          const worlds = src ? await src(this.languageOf(req)) : [];
          res.json({ worlds });
        } catch (err) {
          this.deps.log.error('API错误 /api/worlds', { error: String(err) });
          if (!res.headersSent) res.status(500).json({ error: String(err) });
        }
      })();
    });

    // 可见性开关仅撤下 agent 表面； World 继续运行，前缀段与工具在重载后更新。
    app.post('/api/worlds/visibility', express.json(), wrap((req, res) => {
      const src = this.deps.worldVisibility;
      if (!src) { res.status(503).json({ error: 'World 可见性开关不可用' }); return; }
      const body = (req.body ?? {}) as { id?: unknown; visible?: unknown };
      const id = typeof body.id === 'string' ? body.id : '';
      if (!id) { res.status(400).json({ error: '缺少 World id' }); return; }
      if (typeof body.visible !== 'boolean') { res.status(400).json({ error: 'visible 必须是布尔' }); return; }
      try {
        const result = src.set(id, body.visible, this.languageOf(req));
        res.json({ ok: true, result, ...src.state() });
      } catch (err) {
        res.status(400).json({ error: String(err) });
      }
    }));

    // World 激活 / 停用:写回 config.json 的 worlds.<id>.enabled 并立即挂载或撤出,不重启进程。
    // 激活独立于可见性;未激活 World 不在当前 core 里。
    app.post('/api/worlds/activation', express.json(), wrap(async (req, res) => {
      const src = this.deps.worldActivation;
      if (!src) { res.status(503).json({ error: 'World 激活开关不可用' }); return; }
      const body = (req.body ?? {}) as { id?: unknown; enabled?: unknown };
      const id = typeof body.id === 'string' ? body.id : '';
      if (!id) { res.status(400).json({ error: '缺少 Worldid' }); return; }
      if (typeof body.enabled !== 'boolean') { res.status(400).json({ error: 'enabled 必须是布尔' }); return; }
      try {
        const result = await src.set(id, body.enabled, this.languageOf(req));
        this.deps.log.warn('World 激活状态已改', { id, enabled: body.enabled });
        res.json({ ok: true, result });
      } catch (err) {
        res.status(400).json({ error: String(err) });
      }
    }));

    // World 重启:停下当前实例、按定义重建、重新启动。构造时读走的参数(端口、地址、路径)由此生效。
    app.post('/api/worlds/restart', express.json(), wrap(async (req, res) => {
      const src = this.deps.worldActivation;
      if (!src) { res.status(503).json({ error: 'World 重启不可用' }); return; }
      const body = (req.body ?? {}) as { id?: unknown };
      const id = typeof body.id === 'string' ? body.id : '';
      if (!id) { res.status(400).json({ error: '缺少 Worldid' }); return; }
      try {
        const result = await src.restart(id, this.languageOf(req));
        this.deps.log.warn('World 已重启', { id });
        res.json({ ok: true, result });
      } catch (err) {
        res.status(400).json({ error: String(err) });
      }
    }));

    // 扩展:磁盘上的包对照启动时的加载结果。装卸只改磁盘,加载要重启进程。
    app.get('/api/extensions', wrap((_req, res) => {
      const src = this.deps.extensions;
      if (!src) { res.status(503).json({ error: '扩展管理不可用' }); return; }
      res.json(src.list());
    }));

    app.get('/api/extensions/search', wrap(async (req, res) => {
      const src = this.deps.extensions;
      if (!src) { res.status(503).json({ error: '扩展管理不可用' }); return; }
      const kind = strParam(req.query.kind);
      if (kind !== undefined && kind !== 'world' && kind !== 'provider' && kind !== 'bot') {
        res.status(400).json({ error: `kind 只能是 world、provider 或 bot,现在是 ${kind}` });
        return;
      }
      try {
        res.json({ hits: await src.search(strParam(req.query.q) ?? '', kind) });
      } catch (err) {
        res.status(502).json({ error: `npm 搜索失败: ${String(err)}` });
      }
    }));

    app.post('/api/extensions/install', express.json(), wrap(async (req, res) => {
      const src = this.deps.extensions;
      if (!src) { res.status(503).json({ error: '扩展管理不可用' }); return; }
      const body = (req.body ?? {}) as { name?: unknown; version?: unknown; path?: unknown };
      const target: ExtensionInstallTarget | null = typeof body.path === 'string' && body.path.trim()
        ? { path: body.path }
        : typeof body.name === 'string' && body.name.trim()
          ? { name: body.name, ...(typeof body.version === 'string' && body.version.trim() ? { version: body.version } : {}) }
          : null;
      if (!target) { res.status(400).json({ error: '缺少包名或路径' }); return; }
      try {
        const result = await src.install(target);
        this.deps.log.warn('扩展已安装(重启后加载)', { target });
        res.json({ ok: true, result, restartRequired: true });
      } catch (err) {
        res.status(400).json({ error: String(err instanceof Error ? err.message : err) });
      }
    }));

    app.post('/api/extensions/uninstall', express.json(), wrap(async (req, res) => {
      const src = this.deps.extensions;
      if (!src) { res.status(503).json({ error: '扩展管理不可用' }); return; }
      const body = (req.body ?? {}) as { name?: unknown };
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) { res.status(400).json({ error: '缺少包名' }); return; }
      try {
        const result = await src.uninstall(name);
        this.deps.log.warn('扩展已卸载(重启后消失)', { name });
        res.json({ ok: true, result, restartRequired: true });
      } catch (err) {
        res.status(400).json({ error: String(err instanceof Error ? err.message : err) });
      }
    }));

    app.get('/api/prompts', wrap(async (req, res) => {
      const src = this.deps.prompts;
      if (!src) { res.status(503).json({ error: '提示词模板编辑不可用' }); return; }
      res.json({ prompts: await src.list(this.languageOf(req)) });
    }));

    /** 整条前缀的分段视图。现拼,不依赖活 session(见 WebAppPromptDeps.prefix)。 */
    app.get('/api/prompts/prefix', wrap(async (_req, res) => {
      const src = this.deps.prompts;
      if (!src?.prefix) { res.status(503).json({ error: '前缀预览不可用' }); return; }
      res.json({ segments: await src.prefix() });
    }));

    app.post('/api/prompts', express.json({ limit: '2mb' }), (req: Request, res: Response) => {
      const src = this.deps.prompts;
      if (!src) { res.status(503).json({ error: '提示词模板编辑不可用' }); return; }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const key = typeof body.key === 'string' ? body.key.trim() : '';
      if (!key) { res.status(400).json({ error: '缺少 key' }); return; }
      if (typeof body.content !== 'string') { res.status(400).json({ error: 'content 必须是字符串' }); return; }
      if (Buffer.byteLength(body.content, 'utf8') > FILE_MAX_BYTES) {
        res.status(413).json({ error: '提示词超过1MB，拒绝保存' });
        return;
      }
      try {
        const result = src.write(
          key,
          body.content,
          typeof body.baseRevision === 'string' ? body.baseRevision : undefined,
          this.languageOf(req),
        );
        this.deps.log.warn('固定提示词已编辑(人工)', { key });
        res.json({ ok: true, result, revision: revisionOf(body.content) });
      } catch (err) {
        const conflict = err instanceof PromptRevisionConflict;
        res.status(conflict ? 409 : 400).json({
          error: String(err),
          ...(conflict ? { conflict: true } : {}),
        });
      }
    });

    app.post('/api/prompts/reset', express.json(), (req: Request, res: Response) => {
      const src = this.deps.prompts;
      if (!src?.reset) { res.status(503).json({ error: '提示词模板编辑不可用' }); return; }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const key = typeof body.key === 'string' ? body.key.trim() : '';
      if (!key) { res.status(400).json({ error: '缺少 key' }); return; }
      try {
        const result = src.reset(key, this.languageOf(req));
        this.deps.log.warn('固定提示词部署覆盖已移除', { key });
        res.json({ ok: true, result });
      } catch (err) {
        res.status(400).json({ error: String(err) });
      }
    });

    app.get('/api/tool-schemas', wrap((_req, res) => {
      const src = this.deps.toolSchemas;
      if (!src) { res.status(503).json({ error: '工具 schema 不可用' }); return; }
      res.json({ tools: src.list() });
    }));

    app.post('/api/session/reload-prefix', (req: Request, res: Response) => {
      void (async () => {
        const src = this.deps.sessionControl;
        if (!src) { res.status(503).json({ error: 'session前缀重载不可用' }); return; }
        try {
          const result = await src.reloadPrefix(this.languageOf(req));
          this.deps.log.warn('当前session系统前缀已重载(人工)');
          res.json({ ok: true, result });
        } catch (err) {
          this.deps.log.error('重载当前session系统前缀失败', { error: String(err) });
          if (!res.headersSent) res.status(500).json({ error: String(err) });
        }
      })();
    });

    // ---- Console Page API:World 与 bot 的控制面唯一通道。----

    app.get('/api/console/manifest', (req: Request, res: Response) => {
      void this.consolePages.manifest(this.languageOf(req)).then(
        (manifest) => { if (!res.headersSent) res.json(manifest); },
        (err) => {
          this.deps.log.error('API错误 /api/console/manifest', { error: String(err) });
          if (!res.headersSent) {
            // manifest 是开页第一个请求;彻底失败也要给一份结构完整的空壳,
            // 否则前端只能把错误当界面显示。
            res.status(500).json({
              protocolVersion: CONSOLE_PROTOCOL_VERSION,
              providers: [],
              framework: { capabilities: {} },
              error: String(err),
            });
          }
        },
      );
    });

    /**
     * 状态灯。manifest 的一个薄切片,给秒级轮询用——导航上的灯要跟得上
     * "引擎起来了没",而 manifest 那份带着全部面板与前缀源索引。
     *
     * 失败给 200 + 空表:一次取灯失败不该让导航变成一排问号,下一拍自然会补上。
     */
    app.get(CONSOLE_LAMPS_ROUTE, (req: Request, res: Response) => {
      const language = this.languageOf(req);
      const framework = this.deps.providersLamp
        ? { [PROVIDERS_LAMP_ID]: [this.deps.providersLamp(language)] }
        : {};
      void this.consolePages.lamps(language).then(
        (lamps) => { if (!res.headersSent) res.json({ lamps: { ...framework, ...lamps } }); },
        (err) => {
          this.deps.log.error(`API错误 ${CONSOLE_LAMPS_ROUTE}`, { error: String(err) });
          if (!res.headersSent) res.json({ lamps: {} });
        },
      );
    });

    /**
     * Panel RPC。解析失败(没这一页 / 没声明这个面板 / 没有数据面)与
     * 那一页自己抛错是两回事:前者 404/503,后者 500。
     */
    const invokeConsolePagePanel = (req: Request, res: Response, args: unknown[]): void => {
      const page = String(req.params.provider ?? '');
      const panel = String(req.params.panel ?? '');
      const method = String(req.params.method ?? '');
      const transport = req.method === 'GET' || req.method === 'HEAD' ? 'get' : 'post';
      void this.consolePages.invoke(page, panel, method, args, transport, this.languageOf(req)).then(
        async (out) => {
          if (res.headersSent) return;
          if (!out.ok) {
            const status = out.failure.kind === 'no-surface'
              ? 503
              : out.failure.kind === 'method-not-allowed'
                ? 405
                : 404;
            res.status(status).json({ error: out.failure.message });
            return;
          }
          await this.sendInvokeResult(req, res, out.value);
        },
      ).catch((err) => {
        this.deps.log.error(`面板调用失败 ${page}/${panel}.${method}`, { error: String(err) });
        if (!res.headersSent) {
          res.status(500).json({ error: String(err) });
        } else if (!res.destroyed) {
          res.destroy(err instanceof Error ? err : new Error(String(err)));
        }
      });
    };

    // GET:轮询读 + <audio src> 这类只能带 URL 的场合。args 经 query 传 JSON 数组。
    app.get('/api/console/providers/:provider/panels/:panel/:method', wrap((req, res) => {
      const args = parseQueryArgs(req.query.args);
      if ('error' in args) { res.status(400).json({ error: args.error }); return; }
      invokeConsolePagePanel(req, res, args.args);
    }));

    // POST:带参调用。base64 音频/图片会经这里,limit 放宽。
    app.post(
      '/api/console/providers/:provider/panels/:panel/:method',
      express.json({ limit: '64mb' }),
      wrap((req, res) => {
        const body = (req.body ?? {}) as { args?: unknown };
        if (body.args !== undefined && !Array.isArray(body.args)) {
          res.status(400).json({ error: 'args 必须是数组' });
          return;
        }
        invokeConsolePagePanel(req, res, (body.args as unknown[] | undefined) ?? []);
      }),
    );

    app.get('/api/usage', wrap((req, res) => {
      const src = this.deps.usage;
      if (!src) { res.json({ currency: 'USD', bucket: 'day', from: null, to: null, series: [], totals: null, byRole: [], byModel: [] }); return; }
      const BUCKETS = ['auto', 'minute', 'hour', 'day', 'week', 'month'] as const;
      const raw = strParam(req.query.bucket);
      const bucket: UsageBucketOption = (BUCKETS as readonly string[]).includes(raw ?? '') ? (raw as UsageBucketOption) : 'auto';
      const opts: Parameters<WebAppUsageDeps['aggregate']>[0] = { bucket };
      const currency = strParam(req.query.currency);
      if (currency) opts.currency = currency;
      const basis = strParam(req.query.basis);
      if (basis === 'marginal' || basis === 'equivalent') opts.basis = basis;
      const from = strParam(req.query.from);
      if (from) opts.from = from;
      const to = strParam(req.query.to);
      if (to) opts.to = to;
      res.json({ ...src.aggregate(opts), ledger: src.status?.() });
    }));

    app.get('/api/config', wrap((req, res) => {
      const src = this.deps.config;
      if (!src) { res.status(503).json({ error: '配置项声明不可用' }); return; }
      res.json({ groups: src.groups(this.languageOf(req)) });
    }));

    app.get('/api/config/options/:kind', wrap((req, res) => {
      const src = this.deps.config;
      if (!src) { res.status(503).json({ error: '配置项声明不可用' }); return; }
      const kind = typeof req.params.kind === 'string' ? req.params.kind : '';
      res.json({ options: src.options?.(kind, this.languageOf(req)) ?? [] });
    }));

    app.post(PATH_PICKER_ROUTE, express.json({ limit: '16kb' }), (req: Request, res: Response) => {
      let options;
      try {
        options = parsePathPickerOptions(req.body);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        return;
      }
      const picker = this.deps.pathPicker ?? nativePathPicker;
      void picker.pick(options)
        .then((selected) => validatePickedPath(selected, options))
        .then((path) => res.json({ path }))
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          if (err instanceof PathPickerRequestError) {
            res.status(400).json({ error: message });
            return;
          }
          if (err instanceof PathPickerUnavailableError) {
            res.status(503).json({ error: message });
            return;
          }
          this.deps.log.error('本机路径选择器失败', { error: message });
          res.status(500).json({ error: message });
        });
    });

    app.post('/api/config', express.json(), (req: Request, res: Response) => {
      const src = this.deps.config;
      if (!src) { res.status(503).json({ error: '配置项声明不可用' }); return; }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const groupId = typeof body.group === 'string' ? body.group : '';
      const language = this.languageOf(req);
      const entry = src.groups(language).find((g) => g.group.id === groupId);
      if (!entry) { res.status(400).json({ error: `未知配置组: ${groupId}` }); return; }
      const values = (body.values ?? {}) as Record<string, unknown>;
      // 校验完全按声明走:schema 里没声明的键一律忽略,控制台不能靠猜往配置里塞东西
      const parsed = coerceGroupValues(entry.group, values, language);
      if ('error' in parsed) { res.status(400).json({ error: parsed.error }); return; }
      try {
        const result = src.set(groupId, parsed.values, language);
        this.deps.log.warn('配置项已修改', { group: groupId });
        res.json({ ok: true, result, groups: src.groups(language) });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    /**
     * 扩展的浏览器端产物。**逐个文件发,不挂目录**:URL 里的三段只用来在产物表里
     * 定位一条已加载的记录,文件名必须与那条记录里的 basename 相等——路径不由 URL
     * 拼出来,所以 `..` 与别的文件名都只是查不到。要排在 `/assets` 静态之前。
     *
     * 版本在 URL 里,换版本即换 URL,于是可以按 immutable 缓存。
     */
    app.get(`${EXTENSION_ASSET_PREFIX}:pkg/:version/:file`, wrap((req, res) => {
      const { pkg, version, file } = req.params;
      const hit = this.extensionAssets.find(
        (a) => extensionAssetSegment(a.packageName) === pkg && extensionAssetSegment(a.version) === version,
      );
      const path = hit
        ? [hit.jsFile, hit.cssFile].find((f): f is string => !!f && extensionAssetSegment(basename(f)) === file)
        : undefined;
      if (!path) { res.status(404).end(); return; }
      res.type(extname(path) === '.css' ? 'css' : 'js');
      // 卸载扩展只改磁盘,本进程的产物表还留着那一条:文件没了就是 404,不是 500。
      res.sendFile(path, { maxAge: '1y', immutable: true }, (err) => {
        if (err && !res.headersSent) res.status(404).end();
      });
    }));

    // 构建产物。只有这一条把 dist/web 露出去,且 URL 前缀与 asset-manifest 里
    // 写的 `/assets/` 一致;manifest 之外的 key 根本不会被任何响应引用。
    app.use('/assets', express.static(this.webDistDir, { fallthrough: true, index: false }));

    const publicDir = fileURLToPath(new URL('./public', import.meta.url));

    /**
     * 首页要注入内核入口。入口文件名带内容 hash(缓存需要),所以 index.html 里
     * 写不死它——由服务端查构建产物注入。
     */
    const serveIndex = (_req: Request, res: Response): void => {
      const file = join(publicDir, 'index.html');
      let html: string;
      try {
        html = readFileSync(file, 'utf8');
      } catch (err) {
        res.status(500).send(String(err));
        return;
      }
      // 语言盖在 <html lang> 上:内核在 import 期就读它,框架页面能在模块顶层选串表。
      if (this.language === 'en') html = html.replace('<html lang="zh-CN">', '<html lang="en">');
      const core = this.assets.core();
      if (core) {
        /**
         * 认**最后一个** `</body>`。
         *
         * 用 `replace()` 会命中第一处,而页面注释里完全可能出现这个字面量
         * (这份 index.html 的注释就解释过入口是怎么注进来的)——那样 script
         * 标签会被注进注释里,页面一片空白而且看不出原因。踩过一次,记在这里。
         */
        const at = html.lastIndexOf('</body>');
        const tag = `<script type="module" src="${core}"></script>\n`;
        html = at >= 0 ? html.slice(0, at) + tag + html.slice(at) : html + tag;
      }
      res.type('html').send(html);
    };
    app.get('/', wrap(serveIndex));
    app.get('/index.html', wrap(serveIndex));

    app.use(express.static(publicDir));

    return app;
  }
}
