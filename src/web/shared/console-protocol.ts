/**
 * 控制台贡献与 manifest 协议，供 Node 和浏览器共用，不依赖 DOM 或 node:*。
 * 页面类别为 world、llm、persona；声明可含本地路径与回调，manifest 仅含可公开字段。
 * 协议保持通用，具体页的语义和实现由贡献方提供。
 */

import type { ConfigGroup, StoragePart } from '../../core/types.ts';

/** 前端拒绝渲染不支持的协议版本。 */
export const CONSOLE_PROTOCOL_VERSION = 1;

/**
 * 界面语言随每个请求走:HTTP 请求带这个头,WebSocket 握手带这个查询参数(浏览器的
 * WebSocket 构造器带不了头)。值是 `zh` / `en`;缺席或不认识时服务端用部署默认语言。
 */
export const CONSOLE_LANGUAGE_HEADER = 'x-cortico-language';
export const CONSOLE_LANGUAGE_QUERY = 'language';

/** world：World 控制面；llm：LLM 供应模块；persona：bot/Persona 控制面。framework 为保留类别，不经贡献协议提供页面。 */
export type ConsolePageKind = 'framework' | 'world' | 'persona' | 'llm';

/** 能真正贡献一页的类别（框架除外）。 */
export type ContributingKind = Exclude<ConsolePageKind, 'framework'>;

// ---------------------------------------------------------------------------
// 1. 命名空间规则
// ---------------------------------------------------------------------------

/** Page ID 使用 kind:name 命名空间，如 world:chat、persona:demo、llm:sample；Panel ID 仅在页内唯一。 */
const PAGE_ID_RE = /^(world|persona|llm):[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Panel ID 只需在自己这一页内唯一，所以不带任何前缀。 */
const PANEL_ID_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export interface ParsedPageId {
  kind: ContributingKind;
  /** 冒号后的部分：`world:chat` → `chat` */
  name: string;
}

/** 合法则返回拆解结果，否则 null。调用方负责报错措辞。 */
export function parsePageId(id: string): ParsedPageId | null {
  if (!PAGE_ID_RE.test(id)) return null;
  const idx = id.indexOf(':');
  return { kind: id.slice(0, idx) as ContributingKind, name: id.slice(idx + 1) };
}

export function isPanelId(id: string): boolean {
  return PANEL_ID_RE.test(id);
}

/** 内置面板名以小写字母开头，后续允许小写字母、数字和连字符。 */
const BUILTIN_PANEL_RE = /^[a-z][a-z0-9-]*$/;

export function isBuiltinPanel(name: unknown): name is string {
  return typeof name === 'string' && BUILTIN_PANEL_RE.test(name);
}

/** 构建脚本与服务端注册表共用的目录到 page id 映射。 */
export function pageIdFor(kind: ContributingKind, name: string): string {
  return `${kind}:${name}`;
}

// ---------------------------------------------------------------------------
// 2. Asset 安全模型
// ---------------------------------------------------------------------------

/** 资源 key 等于 page id；资源 URL 由构建清单和服务端资源表提供，贡献声明不提供路径。 */
export function assetKeyForPage(pageId: string): string {
  return pageId;
}

/** 构建产物里一页的浏览器资源。值是 URL 路径，不是文件系统路径。 */
export interface ConsoleAssetEntry {
  js: string;
  css?: string;
}

export interface ConsoleAssetManifest {
  protocolVersion: typeof CONSOLE_PROTOCOL_VERSION;
  /** 内核入口；尚未构建时为 null */
  core: string | null;
  /** key 为 page id。 */
  providers: Record<string, ConsoleAssetEntry>;
}

/** 静态资源 URL 的唯一合法前缀。服务端把它映射到 `dist/web/`。 */
export const CONSOLE_ASSET_PREFIX = '/assets/';

/** 资源 URL 仅允许 /assets/ 下的字母、数字、点、下划线、横线和斜杠；拒绝路径回溯、编码、控制字符、反斜杠和查询串。 */
const ASSET_URL_RE = /^\/assets\/[A-Za-z0-9._/-]+$/;

export function isSafeAssetUrl(url: unknown): url is string {
  if (typeof url !== 'string' || !ASSET_URL_RE.test(url)) return false;
  if (url.includes('//')) return false;
  return !url.split('/').includes('..');
}

/** 链接允许 HTTP(S)、单斜杠开头的同源路径及非执行类应用协议；拒绝执行类协议、协议相对 URL 与控制字符。 */
const EXECUTING_SCHEMES = new Set([
  'javascript:', 'data:', 'vbscript:', 'blob:', 'filesystem:',
]);

/** 控制字符(含换行/回车/制表)。用码点构造,免得源码里真嵌进控制字符。 */
const CONTROL_CHARS_RE = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`);

export function isSafeLinkHref(href: unknown): href is string {
  if (typeof href !== 'string' || href === '') return false;
  if (CONTROL_CHARS_RE.test(href)) return false;
  if (href.startsWith('//')) return false;
  if (href.startsWith('/')) return true;
  try {
    return !EXECUTING_SCHEMES.has(new URL(href).protocol);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 3. 声明侧：贡献方交给框架的东西
// ---------------------------------------------------------------------------

/** 状态徽标。控制台原样显示，不解释语义。 */
export interface ConsoleBadge {
  label: string;
  value: string | number;
  tone?: 'on' | 'off' | 'plain';
}

/** 贡献方自报的四态链路灯，与 core 的 WorldLamp 同形；浏览器协议独立声明该结构。 */
export interface ConsoleLamp {
  /** 这是哪条链路。导航上没有它的位置，只进悬停说明。 */
  label: string;
  state: 'online' | 'loading' | 'error' | 'offline';
  /** 悬停时的一句细节。不占版面，只进 title。 */
  hint?: string;
}

const LAMP_STATES: readonly ConsoleLamp['state'][] = ['online', 'loading', 'error', 'offline'];

/**
 * 一页最多点几颗灯。与 `src/core/types.ts` 的 `MODULE_LAMP_MAX` 同值——
 * 数是版面给的（左栏一行放得下这么多颗 6px 的点），所以由渲染这一侧定。
 */
export const LAMP_MAX = 7;

/** 丢弃缺少 label 或 state 非法的灯，并截断到 LAMP_MAX。 */
export function sanitizeLamps(value: unknown): ConsoleLamp[] {
  if (!Array.isArray(value)) return [];
  const out: ConsoleLamp[] = [];
  for (const raw of value) {
    if (out.length >= LAMP_MAX) break;
    const lamp = raw as ConsoleLamp | null;
    if (!lamp || !LAMP_STATES.includes(lamp.state)) continue;
    if (typeof lamp.label !== 'string' || lamp.label === '') continue;
    const one: ConsoleLamp = { label: lamp.label, state: lamp.state };
    if (typeof lamp.hint === 'string' && lamp.hint !== '') one.hint = lamp.hint;
    out.push(one);
  }
  return out;
}

/** 贡献方自带的独立页面入口。控制台不解析路径语义；主题交接只在显式请求时发生。 */
export interface ConsoleLink {
  label: string;
  href: string;
  /** 打开时把控制台当前的已解析主题作为一次性快照放进 URL fragment。 */
  inheritTheme?: boolean;
}

/**
 * 一个专用面板的声明。
 *
 * **声明了 panel 就意味着有一份浏览器实现**——默认是这一页自己的扩展。声明式的
 * 东西（badge / config / prompt / storage / link）不是 panel，它们由控制台通用
 * 渲染，贡献方不必写一行浏览器代码。
 *
 * 判据：简单配置走 JSON Schema；复杂 UI 直接写 TS 扩展，
 * **不为它发明 JSON DSL**。
 */
export interface ConsolePanelDecl {
  /** 一页内唯一，`[a-z0-9-]`。 */
  id: string;
  title: string;
  /** 一句话说明，控制台可显示在标题旁 */
  description?: string;
  /** 允许经 HTTP GET 调用的方法；该声明只留在服务端，不进入 manifest。 */
  getMethods?: readonly string[];
  /**
   * 这块面板的实现由控制台核心提供，值是它在内核那张内置表里的名字。
   *
   * 一页的面板全是内置时，这一页不需要浏览器产物。装在仓库外的贡献方（外部
   * npm 包）拿不到框架的浏览器代码，通用面板只能走这条路。
   */
  builtin?: string;
}

/**
 * 一页自有的固定提示词源文件。`path` 是**本地绝对路径**，因此这个类型
 * 只存在于声明侧——读文件、算 revision、原子写回都由框架代办，路径不上线。
 */
export interface ConsolePromptDocDecl {
  /** 全局唯一，惯例 `worlds.<World>.<名>` / `core.<名>` */
  key: string;
  title: string;
  description: string;
  path: string;
}

/**
 * 一页交给框架的完整贡献。
 *
 * 每次组装 manifest 时重新取一遍（`badges` 是活数据），所以字段是值不是 thunk——
 * 与既有的 `World.console()` 同一个用法。
 */
export interface ConsolePageContribution {
  /** `world:chat` / `persona:demo`；`parsePageId` 校验 */
  id: string;
  kind: ContributingKind;
  /** 人类可读名，导航与卡片上显示 */
  label: string;

  /** 状态灯，一条链路一颗。不报 = 控制台不画灯（框架不替贡献方猜自己的状态）。 */
  lamps?: ConsoleLamp[];
  badges?: ConsoleBadge[];
  panels?: ConsolePanelDecl[];
  links?: ConsoleLink[];

  /** 按 JSON Schema 声明的可调项，控制台通用渲染 */
  config?: ConfigGroup[];
  /** 可编辑的固定提示词源文件 */
  promptDocs?: ConsolePromptDocDecl[];
  /** 这一页自己攒下的、可清除的存储 */
  storage?: StoragePart[];

  /**
   * 面板数据面。控制台只把 HTTP 请求翻译成一次 `(panel, method, args)` 调用——
   * 语义、参数校验、结果形状全归这一页。返回 `{ $binary: { mime, base64 } }`
   * 时按二进制响应（音频试听这类）。不声明 = 这一页的面板没有数据面。
   */
  invoke?(panel: string, method: string, args: unknown[]): Promise<unknown>;

  /**
   * 按 panel 分派的推送通道，消息语义归这一页；未声明此通道时拒绝对应 WS 握手。
   * 每条 socket 连接调用一次 stream()，同一面板的 N 条连接产生 N 次独立调用；框架不广播、不去重、不保证单实例。
   * 重连发起全新调用，不携带续播游标或重放断连期间的帧。当前协议无背压信号和二进制帧，onClose 不提供关闭原因。
   */
  stream?(panel: string, socket: ConsoleStream): void;

  /**
   * 装配态。框架对所有页一视同仁地报这三态；不适用的（persona 页）
   * 恒为 `active`。
   */
  availability?: ConsolePageAvailability;
  /** Persona定义的渠道（true），还是部署侧选配的外挂（false/缺省） */
  declared?: boolean;
  /** `missing` 时的原因，原样显示 */
  reason?: string;
  /** 当前对 agent 可见。不适用的页省略。 */
  agentVisible?: boolean;
  /** 可见性已改但 system 前缀还是旧的。不适用的页省略。 */
  prefixDrifted?: boolean;
}

/**
 * - `active`   已装配并运行
 * - `inactive` 本地有实现但这次没载入（面板仍可露出，比如激活前的接入配置）
 * - `missing`  不可用：缺少实现、构造失败或工具冲突；原因见 reason
 */
export type ConsolePageAvailability = 'active' | 'inactive' | 'missing';

/** 运行期校验用的取值表。 */
const AVAILABILITY: readonly ConsolePageAvailability[] = ['active', 'inactive', 'missing'];

/**
 * 一条已建立的流式连接，交给贡献方用。
 *
 * **故意不是 `ws.WebSocket`**：这份协议既被服务端也被浏览器 import，不能引宿主依赖；
 * 而且把贡献方与某个具体 WS 实现解耦之后，跑在子进程里的贡献方也能实现它
 * （高频与长阻塞的 World 本来就隔离成子进程）。服务端负责把真
 * socket 包成这个形状。
 */
export interface ConsoleStream {
  /** 推一帧。连接已关时静默丢弃，不抛。 */
  send(data: string): void;
  /** 主动关闭。`reason` 原样带给对端。 */
  close(reason?: string): void;
  /** 对端来的帧。 */
  onMessage(cb: (text: string) => void): void;
  /** 连接结束（对端关、网络断、面板 unmount 都会到这里）。 */
  onClose(cb: () => void): void;
  /** 连接是否还活着。 */
  readonly open: boolean;
}

/** 二进制返回的约定形状。 */
export interface ConsoleBinaryResult {
  $binary: { mime: string; base64: string };
}

/** 服务端内部的流式文件返回；路径不会写入 JSON 响应。 */
export interface ConsoleFileResult {
  $file: { mime: string; path: string; bytes: number; sha256: string };
}

export function isBinaryResult(v: unknown): v is ConsoleBinaryResult {
  const bin = (v as ConsoleBinaryResult | null)?.$binary;
  return !!bin && typeof bin.base64 === 'string';
}

export function isFileResult(v: unknown): v is ConsoleFileResult {
  const file = (v as ConsoleFileResult | null)?.$file;
  return !!file
    && typeof file.mime === 'string'
    && typeof file.path === 'string'
    && Number.isSafeInteger(file.bytes)
    && file.bytes >= 0
    && typeof file.sha256 === 'string'
    && /^[0-9a-f]{64}$/.test(file.sha256);
}

// ---------------------------------------------------------------------------
// 4. 线上侧：Manifest DTO
// ---------------------------------------------------------------------------

export interface ConsolePanelManifest {
  id: string;
  title: string;
  description?: string;
  /** 由内核那张内置表提供实现；缺省则去取这一页自己的扩展。 */
  builtin?: string;
}

/** 可安全上线的前缀源索引；本地路径与正文仍只走 `/api/prompts`。 */
export interface ConsolePromptManifest {
  key: string;
  title: string;
  description: string;
}

export interface ConsolePageManifest {
  id: string;
  kind: ContributingKind;
  label: string;
  availability: ConsolePageAvailability;

  lamps?: ConsoleLamp[];
  badges?: ConsoleBadge[];
  panels?: ConsolePanelManifest[];
  prompts?: ConsolePromptManifest[];
  /**
   * 这一页通过 ConsolePageContribution.config 显式认领的配置组 id；schema 和值经 /api/config 提供。
   * 归属不从 owner 推断；未认领的组显示在框架设置页。
   */
  configGroups?: string[];
  links?: ConsoleLink[];

  declared?: boolean;
  reason?: string;
  agentVisible?: boolean;
  prefixDrifted?: boolean;

  /** 浏览器扩展资源由服务端解析构建产物得到；缺省时非内置面板显示缺少产物错误，内置面板不依赖该字段。 */
  client?: ConsoleAssetEntry;
}

export interface ConsoleManifest {
  protocolVersion: typeof CONSOLE_PROTOCOL_VERSION;
  /** 每一页一条。字段名是线协议形状,与自带前端的构建产物同步,故未改名。 */
  providers: ConsolePageManifest[];
  framework: {
    /** 框架级表面挂没挂。前端据此决定不渲染哪一块，不必拿 503 当信号。 */
    capabilities: Record<string, boolean>;
  };
}

// ---------------------------------------------------------------------------
// 5. 路由
// ---------------------------------------------------------------------------

/** Manifest 端点。 */
export const CONSOLE_MANIFEST_ROUTE = '/api/console/manifest';

/** 状态灯接口：{ lamps: { [pageId]: ConsoleLamp[] } }，用于独立轮询灯状态。 */
export const CONSOLE_LAMPS_ROUTE = '/api/console/lamps';

/** `CONSOLE_LAMPS_ROUTE` 的响应体：page id → 它那排灯。 */
export interface ConsoleLampsResponse {
  lamps: Record<string, ConsoleLamp[]>;
}

/**
 * 「语言模型」那一行的灯在灯表里的键。贡献方的 page id 是 `<kind>:<id>`,
 * kind 取 world / llm / persona,因此这个键与谁都不撞。
 */
export const PROVIDERS_LAMP_ID = 'framework:providers';

/**
 * Panel RPC 路径。page id 含冒号，调用方**必须** `encodeURIComponent`。
 * GET 用于轮询读与 `<audio src>` 这类只能带 URL 的场合（args 经 query 传 JSON 数组）；
 * POST 用于带参调用。
 *
 * 路径里的 `providers` 段是**线协议形状**,与自带前端的构建产物同步,故未随类型改名。
 */
export function panelRoute(pageId: string, panelId: string, method: string): string {
  return `/api/console/providers/${encodeURIComponent(pageId)}`
    + `/panels/${encodeURIComponent(panelId)}`
    + `/${encodeURIComponent(method)}`;
}

/**
 * 流式通道的 WS 路径。与 `panelRoute` 同构:page + panel 定位,
 * 之后的语义全归那一页。
 */
export function panelStreamRoute(pageId: string, panelId: string): string {
  return `/ws/providers/${encodeURIComponent(pageId)}/panels/${encodeURIComponent(panelId)}`;
}

// ---------------------------------------------------------------------------
// 6. 校验
// ---------------------------------------------------------------------------

export interface ContributionProblem {
  pageId: string;
  message: string;
}

/**
 * 校验一批贡献，返回**所有**问题（不是遇到第一个就停）——注册表要能一次告诉
 * 部署者他装的东西哪儿不对。校验只看协议规则，不看语义。
 */
export function validateContributions(
  contributions: readonly ConsolePageContribution[],
): ContributionProblem[] {
  const problems: ContributionProblem[] = [];
  const seenPage = new Set<string>();

  for (const c of contributions) {
    const parsed = parsePageId(c.id);
    if (!parsed) {
      problems.push({
        pageId: c.id,
        message: `provider id 不合法「${c.id}」：应形如 world:chat / persona:demo（小写字母数字与连字符）`,
      });
      continue;
    }
    if (parsed.kind !== c.kind) {
      problems.push({
        pageId: c.id,
        message: `provider id 的前缀是 ${parsed.kind}，但 kind 声明为 ${c.kind}`,
      });
    }
    if (seenPage.has(c.id)) {
      problems.push({ pageId: c.id, message: `provider id 重复：${c.id}` });
      continue;
    }
    seenPage.add(c.id);

    if (!c.label) {
      problems.push({ pageId: c.id, message: 'label 不能为空' });
    }

    // 类型只在 TS 侧管用。JS 侧的贡献方、或来自 JSON 配置的值,能塞任意字符串
    // 给前端,所以运行期也要查一次。
    if (c.availability !== undefined && !AVAILABILITY.includes(c.availability)) {
      problems.push({
        pageId: c.id,
        message: `availability 不合法「${String(c.availability)}」：只能是 ${AVAILABILITY.join(' / ')}`,
      });
    }

    const seenPanel = new Set<string>();
    for (const p of c.panels ?? []) {
      if (!isPanelId(p.id)) {
        problems.push({
          pageId: c.id,
          message: `panel id 不合法「${p.id}」：只允许小写字母数字与连字符，且不带 provider 前缀`,
        });
        continue;
      }
      if (seenPanel.has(p.id)) {
        problems.push({ pageId: c.id, message: `panel id 在本 provider 内重复：${p.id}` });
        continue;
      }
      seenPanel.add(p.id);
      if (!p.title) {
        problems.push({ pageId: c.id, message: `panel「${p.id}」缺 title` });
      }
    }
  }
  return problems;
}

/** 序列化可公开的 manifest 字段，省略回调、本地路径、schema 与存储动作。独立过滤不安全链接和非法 builtin 面板；数组浅拷贝，调用方记录被过滤项。 */
export function toPageManifest(
  c: ConsolePageContribution,
  client?: ConsoleAssetEntry,
): ConsolePageManifest {
  const out: ConsolePageManifest = {
    id: c.id,
    kind: c.kind,
    label: c.label,
    availability: c.availability ?? 'active',
  };
  const lamps = sanitizeLamps(c.lamps);
  if (lamps.length) out.lamps = lamps;
  if (c.badges?.length) out.badges = c.badges.map((b) => ({ ...b }));
  if (c.panels?.length) {
    const panels = c.panels
      .filter((p) => p.builtin === undefined || isBuiltinPanel(p.builtin))
      .map((p) => {
        const panel: ConsolePanelManifest = { id: p.id, title: p.title };
        if (p.description) panel.description = p.description;
        if (p.builtin !== undefined) panel.builtin = p.builtin;
        return panel;
      });
    if (panels.length) out.panels = panels;
  }
  // 只上 id:归属够用了,schema 与当前值仍只走 /api/config。
  if (c.config?.length) out.configGroups = c.config.map((g) => g.id);
  if (c.promptDocs?.length) {
    out.prompts = c.promptDocs.map((doc) => ({
      key: doc.key,
      title: doc.title,
      description: doc.description,
    }));
  }
  const links = (c.links ?? [])
    .filter((l) => isSafeLinkHref(l?.href))
    .map((l) => ({
      label: l.label,
      href: l.href,
      ...(l.inheritTheme === true ? { inheritTheme: true } : {}),
    }));
  if (links.length) out.links = links;
  if (c.declared !== undefined) out.declared = c.declared;
  if (c.reason) out.reason = c.reason;
  if (c.agentVisible !== undefined) out.agentVisible = c.agentVisible;
  if (c.prefixDrifted !== undefined) out.prefixDrifted = c.prefixDrifted;
  if (client) out.client = client;
  return out;
}
