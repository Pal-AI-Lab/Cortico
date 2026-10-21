/** 扩展管理页。扩展信息与运行状态由服务端提供；安装、卸载后需重启进程才能生效。类别取路由第二段。 */

import { get, post, pickPath } from '../../core/api.ts';
import { icon, brandMark } from '../../ui/icons.ts';
import { pageIntro } from '../../ui/page.ts';
import { renderMarkdown } from './markdown.ts';
import type { FeatureContext, FrameworkFeature } from '../feature.ts';
import { S } from './strings.ts';

/** 扩展类别。与 `ExtensionKind` 同形;这一页只用它分组与选关键字。 */
export type ExtensionKindView = 'world' | 'provider' | 'bot';

/** 与 `src/web/server.ts` 的 `ExtensionInfo` 同形。 */
export interface ExtensionView {
  metadata?: Partial<PackageDetailView>;
  builtin?: boolean;
  location?: string;
  name: string;
  spec: string;
  version: string | null;
  installedVersion?: string | null;
  author?: string;
  description?: string;
  kind?: ExtensionKindView;
  api?: number;
  webUiClient: boolean;
  webUi?: 'none' | 'served' | 'missing';
  loaded: boolean;
  reason?: string;
  warnings?: string[];
  worldId?: string;
  label?: string;
  enabled?: boolean;
  hidden?: boolean;
  icon?: boolean;
  /** 官方索引拉黑了这个包或它的发布者时的拉黑原因。 */
  blocked?: string;
  state: 'loaded' | 'failed' | 'pending-restart' | 'removed' | 'idle';
}

/** 官方索引里的一个标签:名称与悬停说明已按界面语言取好;没有 `style` 的是普通标签。 */
export interface MarketTagView {
  label: string;
  hint: string;
  style?: 'official' | 'warning' | 'notice';
}

/** 包在官方讨论区那一帖的喜欢、不喜欢与评论数。 */
export interface RatingView {
  up: number;
  down: number;
  comments: number;
  /** 讨论帖的网页地址 */
  discussion?: string;
  /** 本机登录的 GitHub 账号投的票;没登录或没投时缺席 */
  mine?: 'up' | 'down';
}

/** 讨论帖里的一条评论;`body` 是 Markdown。 */
export interface CommentView {
  id: string;
  author: string;
  avatar?: string;
  body: string;
  createdAt: string;
  /** 对这条评论的回复,只有一层 */
  replies?: CommentView[];
}

/** 一页评论,新的在前;`next` 是下一页的游标,没有就是到底了。 */
export interface CommentPageView {
  comments: CommentView[];
  total: number;
  next?: string;
  /** 讨论帖的网页地址;还没人评论、帖子没建时缺席 */
  discussion?: string;
}

/** 本机登录的 GitHub 账号;没登录时 `login` 缺席。 */
export interface GithubAccountView {
  login?: string;
  avatar?: string;
}

/** 设备码登录:用户在 `verificationUri` 输入 `userCode`。 */
export interface DeviceCodeView {
  userCode: string;
  verificationUri: string;
  /** 秒 */
  expiresIn: number;
  interval: number;
}

/** 写了更新说明的版本;没写的包缺席。正文在包详情的 `changelog` 里。 */
export interface ChangelogView {
  versions: string[];
  /** 完整更新日志的地址 */
  url?: string;
}

/** 与 `ExtensionSummary` 同形。 */
export interface SummaryView {
  tools?: number;
  events?: number;
  toolTokens?: number;
  envPromptTokens?: number;
  protocols?: string[];
  auth?: Array<'api-key' | 'oauth' | 'device-code' | 'web-session'>;
  input?: Array<'text' | 'image' | 'audio' | 'video'>;
  local?: boolean;
  worlds?: number;
  memory?: string;
}

/** 扩展自描述里的一个工具:名字、给模型的描述、分类标签(read / write / speak / act / flow / snapshot)。 */
export interface ToolDescribeView {
  name: string;
  description: string;
  /** 给人看的一句话;缺省时市场取 description 的第一句 */
  summary?: string;
  tags: readonly string[];
}

/** 扩展自描述里的一种事件:类型与给人看的一句话说明。 */
export interface EventDescribeView {
  type: string;
  description: string;
}

/** 与 `ExtensionDescribe` 同形:扩展的自描述,按类别取用。 */
export interface ExtensionDescribeView {
  /** World 的全部工具;Bot 是 Persona 提供的工具 */
  tools?: ToolDescribeView[];
  /** World 会推出的事件 */
  events?: EventDescribeView[];
  provider?: {
    protocols: string[];
    auth: Array<'api-key' | 'oauth' | 'device-code' | 'web-session'>;
    /** 在本机跑模型 */
    local: boolean;
    input: Array<'text' | 'image' | 'audio' | 'video'>;
  };
  bot?: {
    /** 默认启用的 World id */
    worlds: string[];
    memory?: { name: string; form: string };
  };
  /** 包里带的默认提示词模板:World 的环境提示词,Bot 的 Persona 模板 */
  prompts?: PromptDescribeView[];
}

/** 一份默认提示词;`content` 是模板原文。 */
export interface PromptDescribeView {
  key: string;
  title: string;
  role?: 'envPrompt' | 'prefix';
  content: string;
}

/** 搜索回应里的官方索引部分;读不到索引时只有 `error`。 */
export interface MarketIndexView {
  tags: Record<string, MarketTagView>;
  /** 「新品」算首次发布后多少天 */
  newDays?: number;
  error?: string;
  /** 这次没读到、用的是上次读到的索引时,这次读取失败的原因 */
  stale?: string;
}

interface UpdateView {
  name: string;
  installedVersion: string;
  latestVersion: string;
  problems: string[];
}

interface UpdateResultView {
  updates: UpdateView[];
  errors: Array<{ name: string; error: string }>;
}

/** `/api/extensions/registry` 的回应:.npmrc 的 registry 行,与 pnpm 实际用的源或读不出它的原因。 */
interface RegistryView {
  configured: string | null;
  registry?: string;
  registryError?: string;
}

/** `/api/extensions/index-base` 的回应:扩展页配的索引源(没配时 null)与先问的那一处。 */
interface IndexBaseView {
  configured: string | null;
  base: string;
}

/** 与 `ExtensionSearchHit` 同形。 */
export interface SearchHitView {
  name: string;
  version: string;
  description: string;
  date?: string;
  publisher?: string;
  license?: string;
  keywords?: string[];
  downloads: { total?: number; month: number; week?: number };
  dependents: number;
  links: { npm?: string; repository?: string; homepage?: string };
  installed: boolean;
  kind?: ExtensionKindView;
  /** 以下来自官方索引,索引读不到时缺席。 */
  displayName?: string;
  /** 合并后的标签 id:作者声明的、keywords 里命中词表的、官方加的,减去官方删的 */
  tags?: string[];
  /** 官方对这个包的说明,通常解释提示与警示标签 */
  note?: string;
  /** 官方认证 */
  certified?: boolean;
  /** 首次发布在索引给的天数之内 */
  isNew?: boolean;
  /** 官方标明这个包已被另一个包取代,值是新包的包名 */
  supersededBy?: string;
  /** package.json 的 `os`,npm 语义:列出的是支持的平台,带 `!` 的是排除的 */
  os?: string[];
  /** 官方发布:npm 维护者里有索引列出的官方账号 */
  official?: boolean;
  /** package.json 的 author 与 npm 维护者,高级搜索按作者用 */
  author?: string;
  maintainers?: string[];
  rating?: RatingView;
  /** 索引仓库里的图标与截图地址 */
  icon?: string;
  screenshots?: string[];
  summary?: SummaryView;
  changelog?: ChangelogView;
}

/** 与 `ExtensionPackageDetail` 同形。 */
export interface PackageDetailView {
  displayName?: string;
  name: string;
  version: string;
  description?: string;
  license?: string;
  keywords?: string[];
  published?: string;
  created?: string;
  versionCount: number;
  history: Array<{ version: string; date: string; problems?: string[]; warnings?: string[] }>;
  deprecated?: string;
  manifest?: { kind: ExtensionKindView; api: number; webUiClient?: string; webUiStyle?: string };
  problems?: string[];
  warnings: string[];
  frameworkApi: number;
  engines?: string;
  os?: string[];
  unpackedSize?: number;
  fileCount?: number;
  dependencies: string[];
  maintainers: string[];
  author?: string;
  publisher?: string;
  links: { npm?: string; repository?: string; homepage?: string; bugs?: string };
  installed: boolean;
  installedSpec?: string;
  /** 来自官方索引,读不到时缺席 */
  describe?: ExtensionDescribeView;
  /** 版本号 → 这一版的说明(Markdown) */
  changelog?: Record<string, string>;
}

/**
 * 结果的排序口径。
 * `certified` 先排认证,其余按名字;`rating` 按喜欢减不喜欢。
 */
export type HitSort = 'certified' | 'downloads' | 'date' | 'name' | 'rating';
export const HIT_SORTS: readonly HitSort[] = ['certified', 'name', 'date', 'downloads', 'rating'];

export interface ArrangeOptions {
  filter: string;
  hideInstalled: boolean;
  sort: HitSort;
  page: number;
  pageSize: number;
  /** 选中的标签,包要全部带上才算命中 */
  tags?: readonly string[];
  /** 带上其中任一标签的包不显示(用于「隐藏带警示标签的」) */
  excludeTags?: readonly string[];
  /** 只留官方发布的包 */
  officialOnly?: boolean;
  /** 只留官方认证的包 */
  certifiedOnly?: boolean;
  /** 只留新品 */
  newOnly?: boolean;
  /** 高级搜索:作者(author、发布者、维护者任一包含即可)、关键字、许可证、发布时间不早于、近 30 天下载量下限 */
  author?: string;
  keyword?: string;
  license?: string;
  publishedSince?: string;
  minDownloads?: number;
}

/**
 * 在整份结果上筛选、排序、切页。registry 的搜索端点在 `keywords:` 过滤下不按文本
 * 缩小结果,所以文本匹配在这里做:包名、描述、关键字任一命中即算。
 * `page` 超出范围时收回最后一页,返回值里的 `page` 是实际用的那一页。
 */
export function arrangeHits(
  hits: readonly SearchHitView[],
  opts: ArrangeOptions,
): { matched: number; pages: number; page: number; shown: SearchHitView[] } {
  const needle = opts.filter.trim().toLowerCase();
  const matched = hits.filter((h) => {
    if (opts.hideInstalled && h.installed) return false;
    if (opts.officialOnly && !h.official) return false;
    if (opts.certifiedOnly && !h.certified) return false;
    if (opts.newOnly && !h.isNew) return false;
    const author = opts.author?.trim().toLowerCase();
    if (author && ![h.author, h.publisher, ...h.maintainers ?? []].some(v => v?.toLowerCase().includes(author))) return false;
    const keyword = opts.keyword?.trim().toLowerCase();
    if (keyword && !(h.keywords ?? []).some(k => k.toLowerCase().includes(keyword))) return false;
    if (opts.license && (h.license ?? '').toLowerCase() !== opts.license.trim().toLowerCase()) return false;
    if (opts.publishedSince && (h.date ?? '') < opts.publishedSince) return false;
    if (opts.minDownloads && h.downloads.month < opts.minDownloads) return false;
    if (opts.tags?.some((t) => !h.tags?.includes(t))) return false;
    if (opts.excludeTags?.some((t) => h.tags?.includes(t))) return false;
    if (!needle) return true;
    return h.name.toLowerCase().includes(needle)
      || (h.displayName ?? '').toLowerCase().includes(needle)
      || h.description.toLowerCase().includes(needle)
      || (h.keywords ?? []).some((k) => k.toLowerCase().includes(needle));
  });
  const score = (h: SearchHitView) => h.rating ? h.rating.up - h.rating.down : -Infinity;
  matched.sort((a, b) => {
    switch (opts.sort) {
      case 'certified': return Number(!!b.certified) - Number(!!a.certified) || a.name.localeCompare(b.name);
      case 'rating': return score(b) - score(a) || (b.rating?.up ?? 0) - (a.rating?.up ?? 0) || a.name.localeCompare(b.name);
      case 'downloads': return b.downloads.month - a.downloads.month || a.name.localeCompare(b.name);
      // 发布时间是 ISO 串,按串比就是按时间比;没有日期的排在最后
      case 'date': return (b.date ?? '').localeCompare(a.date ?? '') || a.name.localeCompare(b.name);
      default: return a.name.localeCompare(b.name);
    }
  });
  const pages = Math.max(1, Math.ceil(matched.length / opts.pageSize));
  const page = Math.min(Math.max(opts.page, 0), pages - 1);
  return { matched: matched.length, pages, page, shown: matched.slice(page * opts.pageSize, (page + 1) * opts.pageSize) };
}

/** 按 npm 对 `os` 的规则判断这个平台装不装得上:有 `!平台` 就不行;列了正向平台时要在其中;没写都行。 */
export function osAllowed(os: readonly string[] | undefined, platform: string): boolean {
  if (!os?.length) return true;
  if (os.includes('!' + platform)) return false;
  const listed = os.filter(value => !value.startsWith('!'));
  return !listed.length || listed.includes(platform);
}
const PLATFORM_NAMES: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
const platformName = (value: string) => PLATFORM_NAMES[value] ?? value;
/** `os` 的读法:正向列表写「仅 X」,只有排除项写「不支持 X」。 */
export function osText(os: readonly string[]): string {
  const listed = os.filter(value => !value.startsWith('!'));
  return listed.length
    ? S.osOnly(listed.map(platformName).join(S.listSeparator))
    : S.osExcept(os.map(value => platformName(value.slice(1))).join(S.listSeparator));
}

/** 按 semver 比大小。预发布版排在同号正式版之前,预发布标识之间按字符串比。 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => { const i = v.indexOf('-'); return { core: (i < 0 ? v : v.slice(0, i)).split('.').map(Number), pre: i < 0 ? '' : v.slice(i + 1) }; };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) { const d = (x.core[i] || 0) - (y.core[i] || 0); if (d) return d; }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}
/** 已装版本(不含)到目标版本(含)之间写了说明的版本,新的在前。 */
export function changesBetween(versions: readonly string[] | undefined, from: string, to: string): string[] {
  return (versions ?? [])
    .filter(version => compareVersions(version, from) > 0 && compareVersions(version, to) <= 0)
    .sort((a, b) => compareVersions(b, a));
}

type Target = { name: string; version?: string } | { path: string };
interface Life { deployment: string; bootId: string; ready: boolean }
interface PowerReport { result?: string; error?: string; steps?: Array<{ label: string; ok: boolean; elapsedMs: number; detail?: string }> }
/** 重启后轮询到的进程:同一部署、换了 bootId 且就绪才算回来了。 */
export function restartOutcome(before: Life, next: Life): 'waiting' | 'ready' | 'wrong-deployment' {
  return next.deployment !== before.deployment ? 'wrong-deployment' : next.bootId !== before.bootId && next.ready ? 'ready' : 'waiting';
}
/** 每个类别页签各自记住的筛选、分页与滚动位置。操作结果不跨刷新保存。 */
interface CategoryState {
  installedFilter: string; installedSize: number; marketSize: number;
  filter: string; sort: HitSort; hide: boolean; page: number; installedPage: number; scroll: number;
  tags: string[]; hideWarnings: boolean; officialOnly: boolean; certifiedOnly: boolean; newOnly: boolean;
  advanced: boolean; author: string; keyword: string; license: string; sinceDays: number; minDownloads: number;
  hits: SearchHitView[]; fetched: boolean; generation: number; messages: Record<string, { text: string; bad: boolean }>;
  source: 'npm' | 'local'; input: string;
}
export const HITS_PER_PAGE = 12;
/** 卡片网格的列数,按内容区宽度取。 */
export function extensionColumns(width: number): number { return width >= 1000 ? 3 : width >= 660 ? 2 : 1; }
/** 手动安装的 npm 输入:包名,可带 `@` 精确版本或 dist-tag。 */
export function parseInstallInput(raw: string): Target | null {
  const match = /^((?:@[a-z0-9_.-]+\/)?[a-z0-9][a-z0-9_.-]*)(?:@([a-zA-Z0-9][a-zA-Z0-9._-]*))?$/.exec(raw.trim());
  return match ? { name: match[1], ...(match[2] ? { version: match[2] } : {}) } : null;
}
/** 官方索引仓:标签、讨论区与扩展申请都在这里。 */
const INDEX_REPO = 'https://github.com/Pal-AI-Lab/cortico-extensions';
/** 预填包名的「标签」扩展申请:索引仓的网页表单,`package` 字段按查询参数预填。 */
export const tagIssueUrl = (name: string): string =>
  `${INDEX_REPO}/issues/new?${new URLSearchParams({ template: '1-tags.yml', title: `${S.tagIssuePrefix} ${name}`, package: name })}`;
/** 已装包图标的地址;版本号放进查询串,换版本后浏览器重新取。 */
export const iconUrl = (name: string, version: string | null | undefined): string =>
  '/api/extensions/icon?name=' + encodeURIComponent(name) + (version ? '&v=' + encodeURIComponent(version) : '');
const categories: ExtensionKindView[] = ['world', 'provider', 'bot'];
const TAB_ICONS = { world: 'boxes', provider: 'cpu', bot: 'bot' } as const;
const LINK_ICONS = { npm: 'package', repository: 'code', homepage: 'home', bugs: 'alert' } as const;
/** World 卡片能力摘要的黄 / 红两档:超过前一个数标黄,超过后一个数标红。token 数按 catalog 里的估算。 */
const SPEC_LEVELS = {
  toolCount: [10, 20],
  toolTokens: [2500, 6000],
  envPromptTokens: [1000, 2500],
} as const satisfies Record<string, readonly [number, number]>;
const stateLabels = { loaded: S.disabled, failed: S.stateFailed, 'pending-restart': S.statePendingRestart, removed: S.stateRemoved, idle: S.template };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function mountExtensions(ctx: FeatureContext): void {
  const { root, ui, lifecycle, signal, router } = ctx;
  const win = root.ownerDocument.defaultView!;
  const canRestart = ctx.capabilities.restart === true;
  const supervised = ctx.capabilities.supervised === true;
  const storageKey = 'cortico.extensions.v3:' + win.location.origin;
  const states = Object.fromEntries(categories.map(kind => [kind, {
    installedFilter: '', installedSize: 0, marketSize: 0,
    filter: '', sort: 'certified', hide: false, page: 0, installedPage: 0, scroll: 0, tags: [], hideWarnings: false, officialOnly: false, certifiedOnly: false, newOnly: false, advanced: false, author: '', keyword: '', license: '', sinceDays: 0, minDownloads: 0, hits: [], fetched: false, generation: 0,
    messages: {}, source: 'npm', input: '',
  } satisfies CategoryState])) as unknown as Record<ExtensionKindView, CategoryState>;
  try {
    const saved = JSON.parse(win.sessionStorage.getItem(storageKey) ?? '{}');
    for (const kind of categories) if (saved[kind]) Object.assign(states[kind], saved[kind], { hits: [], fetched: false, generation: 0, messages: {} });
    for (const kind of categories) if (!HIT_SORTS.includes(states[kind].sort)) states[kind].sort = 'certified';
  } catch { /* Storage can be disabled by the browser. */ }
  let kind: ExtensionKindView = categories.includes(router.route.segments[1] as ExtensionKindView) ? router.route.segments[1] as ExtensionKindView : 'world';
  let columns = extensionColumns(root.clientWidth);
  let installed: ExtensionView[] = [];
  let updates = new Map<string, UpdateView>();
  let directory = '';
  /** 服务端的 `process.platform`;列表回来之前是空串,这时不按平台拦安装。 */
  let platform = '';
  /** 当前打开的包详情抽屉;从详情里点开另一个包时先关掉它。 */
  let detailDrawer: { dispose(): void } | null = null;
  /** 最近一次搜索用的 registry;市场为空时提示里写出它。 */
  let registry = '';
  /** 最近一次搜索带回的官方索引;读不到时是空词表,标签、徽标与评论区都不显示。 */
  let marketIndex: MarketIndexView = { tags: {} };
  let registrySetting: RegistryView | null = null;
  /** npm 源输入框里没保存的值;切换类别页签时保留。 */
  let registryDraft: string | null = null;
  let registryInput: HTMLInputElement | null = null;
  /** npm 源下拉是否展开;读不出源时自动展开。 */
  let registryOpen = false;
  let indexBaseSetting: IndexBaseView | null = null;
  /** 索引源输入框里没保存的值;切换类别页签时保留。 */
  let indexBaseDraft: string | null = null;
  let indexBaseInput: HTMLInputElement | null = null;
  let indexBaseOpen = false;
  let loadGeneration = 0;
  let installedFetched = false;
  let restoringScroll = true;
  const restoreScroll = () => {
    if (!restoringScroll || !installedFetched || !states[kind].fetched) return;
    root.scrollTop = states[kind].scroll;
    restoringScroll = false;
  };
  /** 正在安装或删除的包;同一个包的第二次操作等前一次回来。 */
  const busy = new Set<string>();
  let armed: (() => void) | null = null;
  const disarm = () => { armed?.(); armed = null; };
  const doc = root.ownerDocument;
  doc.addEventListener('click', event => { if (!(event.target as Element).closest('.extension-erase')) disarm(); }, { signal });
  doc.addEventListener('keydown', event => { if (event.key === 'Escape') disarm(); }, { signal });
  // 历史版本下拉:在同一个抽屉里点别处就收起;确认框等别的浮层里的点击不算
  doc.addEventListener('click', event => { for (const open of doc.querySelectorAll<HTMLDetailsElement>('.extension-releases[open]')) if (!open.contains(event.target as Node) && open.closest('.modalcard')?.contains(event.target as Node)) open.open = false; }, { signal });
  const intro = pageIntro(ui, S.introTitle, S.scope);
  const tabs = ui.h('div', 'extension-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', S.introTitle);
  const indicator = ui.h('span', 'extension-tab-indicator'); indicator.setAttribute('aria-hidden', 'true'); tabs.append(indicator);
  const panel = ui.h('div', 'extension-category'); panel.setAttribute('role', 'tabpanel'); panel.id = 'extension-category';
  const tabButtons = categories.map((value, index) => {
    const button = ui.button('', { onClick: () => router.navigate(['extensions', value]) });
    const text = ui.h('span', 'extension-tab-text'); text.append(ui.h('span', 'extension-tab-label', S.tabs[value]), ui.h('span', 'extension-tab-note', S.tabNotes[value]));
    button.append(icon(doc, TAB_ICONS[value]), text);
    button.id = 'extension-tab-' + value; button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', panel.id);
    button.addEventListener('keydown', event => {
      const target = event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3 : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : -1;
      if (target >= 0) { event.preventDefault(); tabButtons.forEach((b, i) => b.tabIndex = i === target ? 0 : -1); tabButtons[target].focus(); }
    }, { signal }); tabs.append(button); return button;
  });
  root.append(intro, tabs, panel);
  let installedGrid: HTMLElement, marketGrid: HTMLElement, installedPager: HTMLElement, marketPager: HTMLElement;
  let tagBar: HTMLElement | undefined, clearButton: HTMLButtonElement | undefined, licenseList: HTMLElement | undefined;
  let messageNodes: Record<string, HTMLElement> = {};
  const save = () => {
    if (!restoringScroll) states[kind].scroll = root.scrollTop;
    try {
      win.sessionStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(categories.map(k => {
        const { hits: _hits, fetched: _fetched, generation: _gen, messages: _messages, ...s } = states[k];
        return [k, s];
      }))));
    } catch { /* Optional browser state. */ }
  };
  root.addEventListener('scroll', save, { signal, passive: true }); lifecycle.add(save);
  for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) root.addEventListener(event, () => { restoringScroll = false; }, { signal, passive: true });
  function message(owner: ExtensionKindView, area: string, text: string, bad = false) {
    states[owner].messages[area] = { text, bad };
    if (owner === kind && messageNodes[area]) { messageNodes[area].textContent = text; messageNodes[area].className = 'msgline' + (bad ? ' bad' : ''); }
  }
  const pageSize = (area: 'installed' | 'market', owner = kind) => area === 'installed' ? states[owner].installedSize || columns * 2 : states[owner].marketSize || columns * 4;
  function sizePicker(area: 'installed' | 'market') {
    const state = states[kind], key = area === 'installed' ? 'installedSize' : 'marketSize';
    const label = ui.h('label', 'extension-size'); label.dataset.area = area; label.append(ui.h('span', '', S.perPage));
    label.append(ui.select({ value: String(state[key]), options: [0, 3, 6, 12, 24, 48].map(value => ({ value: String(value), label: value ? String(value) : S.automaticCount(columns * (area === 'installed' ? 2 : 4)) })), onChange: value => {
      state[key] = Number(value); (area === 'installed' ? installedGrid : marketGrid).style.minHeight = ''; if (area === 'installed') { state.installedPage = 0; renderInstalled(); } else { state.page = 0; renderMarket(); } save();
    } })); return label;
  }
  function stabilizeGrid(grid: HTMLElement, total: number, size: number, rowHeight: number) {
    const rows = Math.ceil(Math.min(total, size) / columns);
    grid.style.gridTemplateRows = rows ? `repeat(${rows}, minmax(${rowHeight}px, auto))` : '';
  }
  function pager(node: HTMLElement, total: number, page: number, size: number, change: (page: number) => void) {
    node.classList.add('extension-pager');
    node.replaceChildren(ui.h('span', 'muted', S.shown(total ? page * size + 1 : 0, Math.min(total, (page + 1) * size), total)), ui.h('span', 'grow'));
    const pages = Math.max(1, Math.ceil(total / size)); if (pages === 1) return;
    const prev = ui.button(S.prevPage, { onClick: () => change(page - 1) }); prev.disabled = page === 0;
    const next = ui.button(S.nextPage, { onClick: () => change(page + 1) }); next.disabled = page === pages - 1;
    node.append(prev, ui.h('span', '', S.pageOf(page + 1, pages)), next);
  }
  /** 包文档按 name@version 缓存,失败的也留着:registry 连不上时翻页、筛选不会反复重发。 */
  const detailsCache = new Map<string, Promise<PackageDetailView>>();
  function fetchDetail(name: string, version?: string) {
    const key = name + '@' + (version ?? 'latest');
    let request = detailsCache.get(key);
    if (!request) {
      request = get<PackageDetailView>('/api/extensions/package?name=' + encodeURIComponent(name) + (version ? '&version=' + encodeURIComponent(version) : ''), { signal });
      detailsCache.set(key, request);
      void request.catch(() => { /* The rejection is kept for this page's lifetime. */ });
    }
    return request;
  }
  function showLocal(item: ExtensionView) {
    const box = ui.h('div', 'extension-detail');
    detailDrawer?.dispose(); detailDrawer = ui.drawer(item.metadata?.displayName ?? item.label ?? item.name, box);
    // 内建 World 也以 cortico-world-<id> 发布在 npm 上,讨论帖与标签跟那个包
    const hit = states[kind].hits.find(hit => hit.name === item.name || (item.builtin && !!item.worldId && hit.name === 'cortico-world-' + item.worldId));
    const local: PackageDetailView = { name: item.name, version: item.installedVersion ?? item.version ?? '—', versionCount: 0, history: [], warnings: [], frameworkApi: item.api ?? 0, dependencies: [], maintainers: [], links: {}, installed: true, ...item.metadata, description: item.description ?? item.metadata?.description, author: item.author };
    renderDetail(box, local, kind, hit, item);
    if (!item.builtin && !/^(link:|file:)/.test(item.spec) && item.state !== 'removed') {
      void fetchDetail(item.name).then(data => {
        if (!signal.aborted && box.isConnected) renderDetail(box, data, kind, hit, item);
      }).catch(error => {
        if (!signal.aborted && box.isConnected) {
          const feedback = box.querySelector<HTMLElement>('.extension-operation-feedback')!;
          feedback.textContent = errorText(error); feedback.classList.add('bad');
        }
      });
    }
  }
  /** 累计、近 30 天、近 7 天;npm 下载统计没答上来的项显示「—」。 */
  function downloadsText(hit: SearchHitView) {
    return S.downloads(ui.fmt.count(hit.downloads.total), ui.fmt.count(hit.downloads.month), ui.fmt.count(hit.downloads.week));
  }
  /** 包声明了图标就显示图标;没有或取不到时显示 Cortico 标志。 */
  function packageAvatar(src?: string) {
    const avatar = ui.h('span', 'extension-avatar');
    const fallback = ui.h('span', 'extension-avatar-default');
    fallback.append(brandMark(root.ownerDocument));
    avatar.append(fallback);
    if (src) {
      const image = ui.h('img', 'extension-avatar-image'); image.alt = ''; image.src = src; fallback.hidden = true;
      image.addEventListener('error', () => { image.remove(); fallback.hidden = false; }, { signal });
      avatar.prepend(image);
    }
    return avatar;
  }
  const warningTags = () => Object.keys(marketIndex.tags).filter(id => marketIndex.tags[id].style === 'warning');
  /** 标签的颜色分组:红、蓝、普通、黄。 */
  const tagGroup = (id: string) => { const style = marketIndex.tags[id].style; return style === 'warning' ? -2 : style === 'official' ? -1 : style === 'notice' ? 1 : 0; };
  /** 按颜色分组,组内按词表顺序;词表里没有的 id 不显示。 */
  function orderedTags(ids: readonly string[] = []) {
    const order = Object.keys(marketIndex.tags);
    const rank = (id: string) => tagGroup(id) * order.length + order.indexOf(id);
    return ids.filter(id => marketIndex.tags[id]).sort((a, b) => rank(a) - rank(b));
  }
  /** 悬停浮层:指针在目标或浮层上时保持,两者都离开、失焦或滚动时收起。 */
  const hintBox = ui.h('div', 'u-tip extension-hint hidden'); hintBox.setAttribute('role', 'tooltip');
  doc.body.append(hintBox); lifecycle.add(() => hintBox.remove());
  let hideTimer: { dispose(): void } | null = null;
  const keepHint = () => { hideTimer?.dispose(); hideTimer = null; };
  const hideHint = () => { keepHint(); hintBox.classList.add('hidden'); };
  const hideSoon = () => { keepHint(); hideTimer = lifecycle.timeout(hideHint, 150); };
  hintBox.addEventListener('pointerenter', keepHint, { signal });
  hintBox.addEventListener('pointerleave', hideSoon, { signal });
  doc.addEventListener('scroll', hideHint, { capture: true, passive: true, signal });
  const HINT_LINK = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  const plainHint = (text: string) => text.replace(HINT_LINK, '$1');
  function hintBody(text: string) {
    const span = ui.h('span', ''); let last = 0;
    for (const match of text.matchAll(HINT_LINK)) {
      span.append(text.slice(last, match.index));
      const link = ui.h('a', '', match[1]); link.href = match[2]; link.target = '_blank'; link.rel = 'noopener noreferrer';
      span.append(link); last = match.index! + match[0].length;
    }
    span.append(text.slice(last));
    return span;
  }
  function attachHint(el: HTMLElement, title: string | (() => string), text?: string) {
    if (text) el.setAttribute('aria-description', plainHint(text));
    const show = () => {
      keepHint();
      const heading = typeof title === 'string' ? title : title(); if (!heading) return;
      hintBox.replaceChildren(ui.h('b', '', heading), ...(text ? [hintBody(text)] : [])); hintBox.classList.toggle('is-title-only', !text); hintBox.classList.remove('hidden');
      const target = el.getBoundingClientRect(), tip = hintBox.getBoundingClientRect(), view = doc.documentElement;
      const below = target.bottom + 8, above = target.top - tip.height - 8;
      hintBox.style.top = `${below + tip.height > view.clientHeight - 8 && above > 8 ? above : below}px`;
      hintBox.style.left = `${Math.max(8, Math.min(target.left, view.clientWidth - tip.width - 8))}px`;
    };
    el.addEventListener('pointerenter', show, { signal }); el.addEventListener('focus', show, { signal });
    el.addEventListener('pointerleave', hideSoon, { signal }); el.addEventListener('blur', hideHint, { signal });
  }
  /** 标签:悬停显示说明。给了 `onToggle` 就是筛选按钮,点它不打开卡片。 */
  function tagChip(id: string, opts?: { active?: boolean; count?: number; onToggle?: () => void }) {
    const tag = marketIndex.tags[id];
    const el = ui.h(opts?.onToggle ? 'button' : 'span', 'extension-tag' + (tag.style ? ' is-' + tag.style : '') + (opts?.active ? ' is-active' : ''));
    el.append(ui.h('span', '', tag.label)); if (opts?.count !== undefined) el.append(ui.h('span', 'extension-tag-count', String(opts.count)));
    attachHint(el, tag.label, tag.hint);
    const toggle = opts?.onToggle;
    if (toggle) {
      (el as HTMLButtonElement).type = 'button'; el.setAttribute('aria-pressed', String(!!opts?.active));
      el.addEventListener('click', event => { event.stopPropagation(); toggle(); }, { signal });
      el.addEventListener('keydown', event => event.stopPropagation(), { signal });
    }
    return el;
  }
  function badge(cls: string, mark: Parameters<typeof icon>[1], label: string, hint: string) { const el = ui.h('span', cls); el.append(icon(doc, mark), ui.h('span', '', label)); attachHint(el, label, hint); return el; }
  /** `active`:正按这个徽标筛选。 */
  const officialBadge = (active = false) => badge('extension-official-badge' + (active ? ' is-active' : ''), 'cortico', S.officialRelease, S.officialHint);
  const certifiedBadge = (active = false) => badge('extension-certified-badge' + (active ? ' is-active' : ''), 'shield-check', S.certified, S.certifiedHint);
  const newBadge = (active = false) => badge('extension-new-badge' + (active ? ' is-active' : ''), 'sparkles', S.newLabel, S.newHint(marketIndex.newDays ?? 14));
  /** 一个包的全部徽标。 */
  function badgesOf(hit: SearchHitView, state: CategoryState) {
    return [
      ...(hit.certified ? [certifiedBadge(state.certifiedOnly)] : []),
      ...(hit.official ? [officialBadge(state.officialOnly)] : []),
      ...(hit.isNew ? [newBadge(state.newOnly)] : []),
    ];
  }
  /** 列表回来之前不知道本机平台,先当装得上。 */
  const osSupported = (os?: readonly string[]) => !platform || osAllowed(os, platform);
  /** 平台标记;本机装不上时带 `is-unsupported`。 */
  function osBadge(os: readonly string[]) {
    const el = ui.h('span', 'extension-os' + (osSupported(os) ? '' : ' is-unsupported'));
    el.append(icon(doc, 'monitor'), ui.h('span', '', osText(os)));
    return el;
  }
  /** 高级搜索里填了的条件;发布时间换算成最早日期。 */
  function advancedFilters(state: CategoryState): Partial<ArrangeOptions> {
    return {
      author: state.author, keyword: state.keyword, license: state.license, minDownloads: state.minDownloads,
      ...(state.sinceDays ? { publishedSince: new Date(Date.now() - state.sinceDays * 86_400_000).toISOString() } : {}),
    };
  }
  /** 「清除筛选」清搜索词、标签、徽标筛选与高级搜索,不动两个隐藏开关。 */
  const filtersActive = (state: CategoryState) => !!(state.filter.trim() || state.tags.length || state.officialOnly || state.certifiedOnly || state.newOnly || state.author.trim() || state.keyword.trim() || state.license.trim() || state.sinceDays || state.minDownloads);
  function clearFilters() {
    Object.assign(states[kind], { filter: '', tags: [], officialOnly: false, certifiedOnly: false, newOnly: false, author: '', keyword: '', license: '', sinceDays: 0, minDownloads: 0, page: 0 });
    save(); render();
  }
  function toggleTag(id: string) {
    const state = states[kind];
    state.tags = state.tags.includes(id) ? state.tags.filter(t => t !== id) : [...state.tags, id];
    state.page = 0; renderMarket(); save();
  }
  /** 「+N」自己也要落在第二行,放不下就再多收一个。 */
  function foldTags(row: HTMLElement) {
    row.querySelector('.extension-tag-more')?.remove();
    const top = (el: Element) => el.getBoundingClientRect().top - row.getBoundingClientRect().top;
    const opened = row.classList.contains('is-open');
    row.classList.remove('is-open');
    const from = row.getBoundingClientRect().height;
    row.style.maxHeight = '';
    const chips = [...row.children] as HTMLElement[];
    const lines = [...new Set(chips.map(top))].sort((a, b) => a - b);
    if (lines.length <= 2) { row.classList.remove('is-folded'); return; }
    const more = ui.h('button', 'extension-tag extension-tag-more') as HTMLButtonElement; more.type = 'button';
    let cut = chips.findIndex(chip => top(chip) > lines[1]);
    for (; cut > 0; cut--) {
      more.textContent = '+' + (chips.length - cut);
      row.insertBefore(more, chips[cut]);
      if (top(more) <= lines[1]) break;
    }
    const folded = top(more) + more.getBoundingClientRect().height;
    row.classList.add('is-folded');
    if (opened) { row.style.maxHeight = from + 'px'; void row.offsetHeight; }
    row.style.maxHeight = folded + 'px';
    more.setAttribute('aria-label', S.moreTags(chips.length - cut));
    more.addEventListener('click', event => {
      event.stopPropagation();
      more.remove(); row.classList.add('is-open');
      row.style.maxHeight = row.scrollHeight + 'px';
    }, { signal });
    more.addEventListener('keydown', event => event.stopPropagation(), { signal });
  }
  /**
   * 能力摘要:World 是工具数、事件数与环境提示词 token 数,供应商是协议、登录与输入,Bot 是 World 数与 Memory。
   * 工具数按 SPEC_LEVELS 取个数与工具定义 token 两档里较严的一档着色。
   */
  function summaryLine(owner: ExtensionKindView, summary?: SummaryView) {
    const line = ui.h('div', 'extension-card-spec');
    if (!summary) return line;
    const part = (name: Parameters<typeof icon>[1] | null, text: string) => { const el = ui.h('span', ''); if (name) el.append(icon(doc, name)); el.append(ui.h('span', '', text)); line.append(el); return el; };
    const level = (value: number | undefined, [caution, alert]: readonly [number, number]) => value === undefined ? 0 : value > alert ? 2 : value > caution ? 1 : 0;
    const tint = (el: HTMLElement, rank: number) => { if (rank) el.classList.add(rank === 2 ? 'is-alert' : 'is-caution'); };
    if (owner === 'provider') {
      const text = [summary.protocols?.join(S.listSeparator), summary.auth?.map(a => S.authNames[a]).join(S.listSeparator), summary.input?.map(i => S.inputNames[i]).join(S.listSeparator), summary.local ? S.runsLocal : ''].filter(Boolean).join(S.metaSeparator);
      if (text) part('cpu', text);
    } else if (owner === 'bot') {
      if (summary.worlds !== undefined) part('boxes', S.worldCount(summary.worlds));
      if (summary.memory) part(null, S.labelled(S.memory, summary.memory));
    } else {
      if (summary.tools) {
        const el = part('wrench', S.toolCount(summary.tools));
        tint(el, Math.max(level(summary.tools, SPEC_LEVELS.toolCount), level(summary.toolTokens, SPEC_LEVELS.toolTokens)));
        if (summary.toolTokens !== undefined) attachHint(el, S.toolsHint(summary.tools, summary.toolTokens));
      }
      if (summary.events) part('zap', S.eventCount(summary.events));
      if (summary.envPromptTokens) {
        const el = part('text', S.prefixSize(ui.fmt.count(summary.envPromptTokens)));
        tint(el, level(summary.envPromptTokens, SPEC_LEVELS.envPromptTokens));
        attachHint(el, S.prefixHint(summary.envPromptTokens));
      }
    }
    return line;
  }
  function describeSection(describe?: ExtensionDescribeView): { title: string; el: HTMLElement } | null {
    if (!describe) return null;
    const section = ui.h('section', 'extension-describe');
    const firstSentence = (text: string) => (text.match(/^[^。！？.!?\n]+[。！？.!?]?/)?.[0] ?? text).trim();
    const toolList = (tools: readonly ToolDescribeView[]) => {
      const list = ui.h('div', 'extension-tool-list');
      for (const tool of tools) {
        const row = ui.h('details', 'extension-tool');
        const summary = ui.h('summary');
        const head = ui.h('span', 'extension-tool-head'); head.append(ui.h('code', '', tool.name));
        for (const tag of tool.tags) head.append(ui.h('span', 'extension-tool-tag', S.toolTagNames[tag as keyof typeof S.toolTagNames] ?? tag));
        summary.append(head, ui.h('span', 'extension-tool-brief', tool.summary ?? firstSentence(tool.description)));
        const full = ui.h('div', 'extension-tool-full');
        if (tool.summary) full.append(ui.h('p', 'extension-tool-summary', tool.summary));
        full.append(ui.h('span', 'extension-tool-label', S.modelDescription), ui.h('p', '', tool.description));
        row.append(summary, full); list.append(row);
      }
      return list;
    };
    const heading = (text: string, count?: number) => { const h = ui.h('h5', '', text); if (count !== undefined) h.append(ui.h('span', 'extension-describe-count', String(count))); return h; };
    if (describe.provider) {
      const p = describe.provider;
      section.append(ui.kv([
        { k: S.protocol, v: p.protocols.join(S.listSeparator) || '—' },
        { k: S.authLabel, v: p.auth.map(a => S.authNames[a]).join(S.listSeparator) || '—' },
        { k: S.runsOn, v: p.local ? S.runsLocal : S.runsCloud },
        { k: S.inputLabel, v: p.input.map(i => S.inputNames[i]).join(S.listSeparator) || '—' },
      ]));
      return { title: S.sectionProvider, el: section };
    } else if (describe.bot) {
      const b = describe.bot;
      const worlds = ui.h('div', 'extension-tag-row'); for (const id of b.worlds) worlds.append(ui.h('span', 'extension-tag', id));
      section.append(heading(S.botWorlds, b.worlds.length), worlds);
      if (b.memory) section.append(heading(S.memory), ui.h('p', 'extension-describe-text', `${b.memory.name}${S.metaSeparator}${b.memory.form}`));
      if (describe.tools?.length) section.append(heading(S.personaTools, describe.tools.length), toolList(describe.tools));
      return { title: S.sectionBot, el: section };
    } else {
      if (!describe.tools?.length && !describe.events?.length) return null;
      if (describe.tools?.length) section.append(heading(S.toolsHeading, describe.tools.length), toolList(describe.tools));
      if (describe.events?.length) {
        const shown = 8, events = describe.events;
        const list = ui.h('div', 'extension-event-list');
        const row = (event: EventDescribeView) => { const el = ui.h('div', 'extension-event'); el.append(ui.h('code', '', event.type), ui.h('span', '', event.description)); return el; };
        list.append(...events.slice(0, shown).map(row));
        section.append(heading(S.eventsHeading, events.length), list);
        if (events.length > shown) {
          const more = ui.button(S.showAll(events.length), { size: 'sm', onClick: () => { list.replaceChildren(...events.map(row)); more.remove(); } });
          more.classList.add('extension-describe-more'); section.append(more);
        }
      }
    }
    return { title: S.sectionWorld, el: section };
  }
  function promptsSection(describe?: ExtensionDescribeView): { title: string; el: HTMLElement } | null {
    if (!describe?.prompts?.length) return null;
    const section = ui.h('section', 'extension-describe extension-prompts');
    for (const prompt of describe.prompts) {
      const head = ui.h('div', 'extension-prompt-head');
      head.append(ui.h('h5', '', prompt.title), ui.h('code', '', prompt.key), copyIcon(prompt.content));
      section.append(head, ui.h('pre', 'extension-prompt-body', prompt.content));
    }
    return { title: describe.bot ? S.promptsTabBot : S.promptsTabWorld, el: section };
  }
  /** 统计项。给了 `title` 才有悬停,`detail` 是悬停里的完整读数。 */
  function stat(kind: string, parts: Array<SVGSVGElement | string>, title?: string, detail?: string) {
    const el = ui.h('span', 'extension-stat extension-stat-' + kind);
    for (const part of parts) el.append(typeof part === 'string' ? ui.h('span', '', part) : part);
    if (title) { el.tabIndex = 0; attachHint(el, title, detail); }
    return el;
  }
  /** 喜欢 / 不喜欢:再点同一个是撤回,点另一个是改票;按回应刷新所有显示这个包评分的地方。 */
  function votes(name: string, rating: RatingView) {
    const el = ui.h('span', 'extension-votes'); el.dataset.voteFor = name;
    for (const value of ['up', 'down'] as const) {
      const count = value === 'up' ? rating.up : rating.down, mine = rating.mine === value;
      const button = ui.h('button', 'extension-stat extension-vote' + (mine ? ' is-mine' : '')) as HTMLButtonElement; button.type = 'button';
      button.append(icon(doc, value === 'up' ? 'vote-up' : 'vote-down'), ui.h('span', '', ui.fmt.count(count)));
      button.setAttribute('aria-pressed', String(mine)); button.setAttribute('aria-label', value === 'up' ? S.like : S.dislike);
      button.addEventListener('click', event => { event.stopPropagation(); hideHint(); void vote(name, rating, mine ? null : value); }, { signal });
      button.addEventListener('keydown', event => event.stopPropagation(), { signal });
      el.append(button);
    }
    return el;
  }
  async function vote(name: string, rating: RatingView, next: 'up' | 'down' | null) {
    const before = { ...rating };
    const apply = (value: RatingView) => { Object.assign(rating, value); if (!value.mine) delete rating.mine; for (const node of doc.querySelectorAll<HTMLElement>('[data-vote-for]')) if (node.dataset.voteFor === name) node.replaceWith(votes(name, rating)); };
    const optimistic: RatingView = { ...rating, up: rating.up - (rating.mine === 'up' ? 1 : 0) + (next === 'up' ? 1 : 0), down: rating.down - (rating.mine === 'down' ? 1 : 0) + (next === 'down' ? 1 : 0) };
    if (next) optimistic.mine = next; else delete optimistic.mine;
    apply(optimistic);
    try { apply(await withGithub(() => post<RatingView>('/api/extensions/vote', { name, vote: next }, { signal }))); }
    catch (error) { if (signal.aborted) return; apply(before); if (!needsLogin(error)) message(kind, 'market', S.voteFailed(errorText(error)), true); }
  }
  /** 服务端回 428:这个操作要先登录 GitHub。 */
  const needsLogin = (error: unknown) => (error as { status?: number }).status === 428;
  /** 投票、评论这类要 GitHub 账号的请求:没登录时先走登录,登上后重发一次;取消登录时原样抛出 428。 */
  async function withGithub<T>(request: () => Promise<T>): Promise<T> {
    try { return await request(); }
    catch (error) { if (!needsLogin(error) || !await signIn()) throw error; return request(); }
  }
  /** 本机登录的 GitHub 账号,第一次用到时取;登录、退出后换成新值。 */
  let github: Promise<GithubAccountView> | null = null;
  const githubAccount = () => github ??= get<GithubAccountView>('/api/extensions/github', { signal });
  /** 正在进行的设备码登录,同一时间只开一个。 */
  let signingIn: Promise<boolean> | null = null;
  const wait = (ms: number) => new Promise<void>(resolve => { lifecycle.timeout(resolve, ms); });
  /** GitHub 设备码登录:显示码与验证页,按 `interval` 查账号直到登上。登上返回 true;关掉抽屉、过期或出错返回 false。 */
  function signIn(): Promise<boolean> {
    return signingIn ??= (async () => {
      const box = ui.h('div', 'extension-login');
      const status = ui.msgline(S.githubRequesting); status.setAttribute('role', 'status');
      box.append(status);
      const handle = ui.drawer(S.githubLoginTitle, box);
      const card = box.closest('.modalcard'); card?.classList.add('extension-login-card');
      const close = card?.querySelector<HTMLButtonElement>('.modalhead .btn');
      if (close) { const label = (close.textContent ?? '').replace(/^✕\s*/, ''); close.replaceChildren(icon(doc, 'close')); close.classList.add('extension-icon-button'); close.setAttribute('aria-label', label); attachHint(close, label); }
      try {
        const code = await post<DeviceCodeView>('/api/extensions/github/login', undefined, { signal });
        const open = ui.h('a', 'btn primary extension-login-open', S.githubOpen); open.href = code.verificationUri; open.target = '_blank'; open.rel = 'noopener noreferrer';
        const row = ui.h('div', 'extension-login-code');
        row.append(ui.h('code', '', code.userCode), copyIcon(code.userCode));
        status.textContent = S.githubWaiting;
        box.prepend(ui.h('p', 'extension-login-step', S.githubStep), row, open);
        const deadline = Date.now() + code.expiresIn * 1000;
        while (box.isConnected && !signal.aborted && Date.now() < deadline) {
          await wait(Math.max(1, code.interval) * 1000);
          if (!box.isConnected || signal.aborted) break;
          const account = await get<GithubAccountView>('/api/extensions/github', { signal });
          if (account.login) { github = Promise.resolve(account); refreshAccounts(); handle.dispose(); return true; }
        }
        if (box.isConnected) { status.textContent = S.githubExpired; status.classList.add('bad'); open.remove(); row.remove(); }
        return false;
      } catch (error) {
        if (box.isConnected) { status.textContent = errorText(error); status.classList.add('bad'); }
        return false;
      } finally { signingIn = null; }
    })();
  }
  async function signOut() {
    try { await post('/api/extensions/github/logout', undefined, { signal }); github = Promise.resolve({}); refreshAccounts(); }
    catch (error) { if (!signal.aborted) ui.toast(errorText(error), 'bad'); }
  }
  function accountSlot() {
    const slot = ui.h('span', 'extension-github-account'); slot.dataset.githubAccount = '';
    void githubAccount().then(account => {
      if (signal.aborted) return;
      if (account.login) {
        const out = ui.button(S.githubLogout, { size: 'sm', onClick: () => void signOut() });
        slot.replaceChildren(githubAvatar(account.login, account.avatar), ui.h('span', 'extension-github-login', '@' + account.login), out);
      } else {
        const login = ui.button(S.githubLogin, { size: 'sm', onClick: () => void signIn() });
        login.classList.add('extension-github-signin'); login.prepend(icon(doc, 'github'));
        slot.replaceChildren(login);
      }
    }, error => {
      if (signal.aborted) return;
      github = null;
      slot.replaceChildren(ui.h('span', 'extension-github-error', errorText(error)));
    });
    return slot;
  }
  const refreshAccounts = () => { for (const node of doc.querySelectorAll<HTMLElement>('[data-github-account]')) node.replaceWith(accountSlot()); };
  /** GitHub 头像;地址不是 https 或取不到时显示账号首字母。 */
  function githubAvatar(login: string, src?: string) {
    const el = ui.h('span', 'extension-github-avatar', login.slice(0, 1).toUpperCase());
    if (src && /^https:\/\//.test(src)) {
      const image = ui.h('img'); image.alt = ''; image.src = src; image.loading = 'lazy';
      image.addEventListener('error', () => image.remove(), { signal });
      el.append(image);
    }
    return el;
  }
  /** 评论数;给了 `open` 时可点。 */
  function commentCount(name: string, rating: RatingView, open?: () => void) {
    const parts = [icon(doc, 'message'), ui.fmt.count(rating.comments)];
    if (!open) { const el = stat('comments', parts); el.dataset.commentsFor = name; return el; }
    const button = ui.h('button', 'extension-stat extension-stat-comments') as HTMLButtonElement; button.type = 'button'; button.dataset.commentsFor = name;
    for (const part of parts) button.append(typeof part === 'string' ? ui.h('span', '', part) : part);
    button.setAttribute('aria-label', S.comments);
    button.addEventListener('click', event => { event.stopPropagation(); hideHint(); open(); }, { signal });
    button.addEventListener('keydown', event => event.stopPropagation(), { signal });
    return button;
  }
  /** 近 30 天下载量;悬停看累计、30 天、7 天。 */
  const downloadsStat = (hit: SearchHitView) => stat('downloads', [icon(doc, 'download'), ui.fmt.count(hit.downloads.month)], S.fieldDownloads, downloadsText(hit));
  /** 最近更新:最新版本的发布时间,今年的只写月-日,悬停给完整日期。 */
  const dateStat = (date: string) => stat('date', [icon(doc, 'calendar'), date.slice(0, 4) === String(new Date().getFullYear()) ? date.slice(5, 10) : date.slice(0, 10)], S.updated, date.slice(0, 10));
  function copyIcon(text: string) {
    const button = ui.copyButton(text, { size: 'sm' });
    button.replaceChildren(icon(doc, 'copy')); button.classList.add('extension-icon-button');
    button.setAttribute('aria-label', S.copyText); attachHint(button, S.copyText);
    return button;
  }
  function commentBody(text: string) {
    const body = ui.h('div', 'extension-comment-body'); body.append(renderMarkdown(doc, text));
    for (const pre of body.querySelectorAll('pre')) {
      const block = ui.h('div', 'extension-codeblock'); pre.replaceWith(block);
      block.append(pre, copyIcon(pre.textContent ?? ''));
    }
    return body;
  }
  function insertTextBlock(input: HTMLTextAreaElement) {
    const { selectionStart: start, selectionEnd: end, value } = input;
    const before = value.slice(0, start), picked = value.slice(start, end);
    const lead = before && !before.endsWith('\n') ? '\n' : '';
    const open = lead + '```markdown\n';
    input.value = before + open + picked + '\n```\n' + value.slice(end);
    input.focus(); input.selectionStart = input.selectionEnd = start + open.length + picked.length;
  }
  function textBlockButton(input: HTMLTextAreaElement) {
    const button = ui.h('button', 'btn sm extension-insert-code') as HTMLButtonElement; button.type = 'button';
    button.append(icon(doc, 'square-code')); button.setAttribute('aria-label', S.insertTextBlock); attachHint(button, S.insertTextBlock);
    button.addEventListener('click', () => insertTextBlock(input), { signal });
    return button;
  }
  function commentItem(comment: CommentView, reply?: (to: CommentView) => void) {
    const el = ui.h('article', 'extension-comment');
    const head = ui.h('div', 'extension-comment-head');
    head.append(githubAvatar(comment.author, comment.avatar), ui.h('b', '', comment.author), ui.h('time', 'muted', comment.createdAt.slice(0, 10)));
    if (reply) { const button = ui.h('button', 'extension-comment-reply') as HTMLButtonElement; button.type = 'button'; button.append(icon(doc, 'reply')); button.setAttribute('aria-label', S.reply); attachHint(button, S.reply); button.addEventListener('click', () => reply(comment), { signal }); head.append(button); }
    el.append(head, commentBody(comment.body));
    return el;
  }
  /** 详情里的评论区:新的在前,一次一页;发表要登录 GitHub。 */
  function commentsSection(name: string, rating?: RatingView) {
    const section = ui.h('section', 'extension-comments');
    const heading = ui.h('h4', '', S.comments); if (rating) { const counts = ui.h('span', 'extension-rating'); counts.append(votes(name, rating), commentCount(name, rating)); heading.append(counts); }
    const input = ui.textarea({ placeholder: S.commentPlaceholder, rows: 3 }); input.setAttribute('aria-label', S.commentPlaceholder);
    const feedback = ui.msgline(); feedback.setAttribute('role', 'status');
    const list = ui.h('div', 'extension-comment-list');
    const submit = ui.button(S.commentSubmit, { variant: 'primary', size: 'sm', onClick: async () => {
      const body = input.value.trim(); if (!body) return;
      const lock = ui.disable(submit, input); feedback.textContent = ''; feedback.classList.remove('bad');
      try {
        const posted = await withGithub(() => post<CommentView>('/api/extensions/comments', { name, body }, { signal }));
        if (signal.aborted) return;
        input.value = ''; list.querySelector('.extension-comment-empty')?.remove(); list.prepend(thread(posted));
        countOne();
      } catch (error) { if (!signal.aborted && !needsLogin(error)) { feedback.textContent = S.commentFailed(errorText(error)); feedback.classList.add('bad'); } }
      finally { lock.dispose(); }
    } });
    const actions = ui.h('div', 'extension-comment-actions'); actions.append(accountSlot(), textBlockButton(input), submit);
    const composer = ui.h('div', 'extension-comment-composer'); composer.append(input, actions);
    const more = ui.button(S.loadMore, { size: 'sm', onClick: () => void page() }); more.classList.add('extension-comment-more'); more.hidden = true;
    const link = ui.h('a', 'extension-discussion-link', S.openDiscussion); link.target = '_blank'; link.rel = 'noopener noreferrer'; link.hidden = true;
    section.append(heading, composer, feedback, list, more, link);
    const countOne = () => { if (rating) { rating.comments++; for (const node of doc.querySelectorAll<HTMLElement>('[data-comments-for]')) if (node.dataset.commentsFor === name) node.lastElementChild!.textContent = ui.fmt.count(rating.comments); } };
    /** 顶层评论与它的回复;回复只有一层,都以顶层评论为 `replyTo`。 */
    function thread(top: CommentView) {
      const replies = ui.h('div', 'extension-comment-replies');
      let box: HTMLElement | null = null;
      const open = (to: CommentView) => {
        box?.remove();
        const field = ui.textarea({ placeholder: S.replyPlaceholder(to.author), rows: 2 }); field.setAttribute('aria-label', S.replyPlaceholder(to.author));
        if (to !== top) field.value = '@' + to.author + ' ';
        const note = ui.msgline(); note.setAttribute('role', 'status');
        const cancel = ui.button(S.cancelReply, { size: 'sm', onClick: () => { box?.remove(); box = null; } });
        const send = ui.button(S.commentSubmit, { variant: 'primary', size: 'sm', onClick: async () => {
          const body = field.value.trim(); if (!body) return;
          const lock = ui.disable(send, field);
          try {
            const posted = await withGithub(() => post<CommentView>('/api/extensions/comments', { name, body, replyTo: top.id }, { signal }));
            if (signal.aborted) return;
            replies.append(commentItem(posted, open)); box?.remove(); box = null; countOne();
          } catch (error) { if (!signal.aborted && !needsLogin(error)) { note.textContent = S.commentFailed(errorText(error)); note.classList.add('bad'); } }
          finally { lock.dispose(); }
        } });
        const row = ui.h('div', 'extension-comment-actions'); row.append(textBlockButton(field), cancel, send);
        box = ui.h('div', 'extension-comment-composer extension-reply-composer'); box.append(field, row, note);
        replies.after(box); field.focus();
      };
      const el = commentItem(top, open);
      replies.append(...(top.replies ?? []).map(child => commentItem(child, open)));
      el.append(replies);
      return el;
    }
    let cursor: string | undefined;
    async function page() {
      const lock = ui.disable(more);
      try {
        const data = await get<CommentPageView>('/api/extensions/comments?name=' + encodeURIComponent(name) + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), { signal });
        if (signal.aborted) return;
        list.append(...data.comments.map(thread)); cursor = data.next; more.hidden = !cursor;
        if (!list.hasChildNodes()) list.append(ui.h('p', 'muted extension-comment-empty', S.noComments));
        if (data.discussion && /^https:\/\//.test(data.discussion)) { link.href = data.discussion; link.hidden = false; }
      } catch (error) { if (!signal.aborted) { feedback.textContent = S.commentsLoadFailed(errorText(error)); feedback.classList.add('bad'); } }
      finally { lock.dispose(); }
    }
    void page();
    return section;
  }
  /** 几个版本的更新说明,新的在前。 */
  function showChanges(title: string, changes: ReadonlyArray<[string, string]>, url?: string) {
    const box = ui.h('div', 'extension-changes');
    for (const [version, text] of changes) {
      const section = ui.h('section'); const body = ui.h('div', 'extension-changes-body');
      body.append(renderMarkdown(doc, text)); section.append(ui.h('h4', '', version), body); box.append(section);
    }
    if (url && /^https?:\/\//i.test(url)) { const link = ui.h('a', 'extension-discussion-link', S.changelogLink); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; box.append(link); }
    ui.drawer(S.changesTitle(title), box);
    box.closest('.modalcard')?.classList.add('extension-changes-card');
  }
  function installedCard(item: ExtensionView) {
    const card = ui.h('article', 'extension-card extension-installed-card' + (item.enabled ? ' is-enabled' : ''));
    card.tabIndex = 0; card.setAttribute('aria-label', item.metadata?.displayName ?? item.label ?? item.name);
    card.addEventListener('click', event => { if (!(event.target as Element).closest('button, a')) showLocal(item); }, { signal });
    card.addEventListener('keydown', event => { if (event.target === card && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); showLocal(item); } }, { signal });
    const heading = ui.h('div', 'extension-card-heading');
    heading.append(packageAvatar(item.icon ? iconUrl(item.name, item.installedVersion ?? item.version) : undefined));
    const title = ui.h('span', 'extension-card-title', item.metadata?.displayName ?? item.label ?? item.name); title.title = item.label ?? item.name;
    heading.append(title); if (item.enabled) heading.append(ui.pill(item.kind === 'provider' ? S.alreadyInstalled : item.kind === 'bot' ? S.adopted : S.stateLoaded, 'on'));
    card.append(heading);
    const text = item.state === 'removed' || item.state === 'pending-restart' || item.state === 'failed' ? stateLabels[item.state] : item.kind === 'provider' ? S.alreadyInstalled : item.enabled ? (item.kind === 'bot' ? S.adopted : S.enabled) : stateLabels[item.state];
    const failed = item.state === 'failed';
    const symbol = failed ? '!' : item.state === 'pending-restart' ? '◷' : item.enabled ? '●' : '○';
    const author = item.author ?? S.unknownAuthor;
    card.append(ui.h('div', 'extension-meta', [item.builtin ? S.builtin : '', S.version(item.installedVersion ?? item.version ?? '—'), S.author(author)].filter(Boolean).join(' · ')));
    const status = ui.h('div', 'extension-status' + (failed ? ' bad' : item.enabled ? ' on' : ' off'), `${symbol} ${text}`);
    if (item.description) card.append(ui.h('p', 'extension-description', item.description));
    if (item.blocked) card.append(ui.msgline(S.blocked(item.blocked), true));
    const version = ui.h('div', 'extension-secondary');
    const update = updates.get(item.name);
    if (update) {
      version.classList.add('extension-update');
      const alert = ui.h('span', 'extension-update-icon', '!'); alert.setAttribute('aria-hidden', 'true');
      version.append(alert, ui.h('span', '', S.updateVersions(update.installedVersion, update.latestVersion)));
      const button = ui.button(S.updateAction, { size: 'sm', onClick: () => void operate('install', { name: item.name, version: update.latestVersion }, 'management', kind) });
      button.disabled = !!update.problems.length || busy.has(item.name); button.title = update.problems.join('\n');
      const changelog = states[kind].hits.find(hit => hit.name === item.name)?.changelog;
      const versions = changesBetween(changelog?.versions, update.installedVersion, update.latestVersion);
      if (versions.length) {
        const notes = ui.h('button', 'extension-update-notes', S.updateNotes) as HTMLButtonElement; notes.type = 'button';
        const owner = kind;
        notes.addEventListener('click', event => {
          event.stopPropagation();
          void fetchDetail(item.name).then(data => {
            if (signal.aborted) return;
            const changes = versions.flatMap(v => data.changelog?.[v] ? [[v, data.changelog[v]] as [string, string]] : []);
            showChanges(item.metadata?.displayName ?? item.label ?? item.name, changes, changelog?.url);
          }).catch(error => { if (!signal.aborted) message(owner, 'management', errorText(error), true); });
        }, { signal });
        version.append(notes);
      }
      version.append(button);
    } else version.textContent = item.hidden ? S.hidden : item.installedVersion && item.version !== item.installedVersion ? S.runtimeVersion(item.version ?? '—') : '';
    if (version.hasChildNodes()) card.append(version);
    for (const problem of update?.problems ?? []) card.append(ui.msgline(problem, true));
    const footer = ui.h('div', 'extension-status-row'); footer.append(status);
    if (item.state !== 'removed') {
      const remove = ui.h('button', 'connection-erase extension-erase') as HTMLButtonElement; remove.type = 'button';
      const text = ui.h('span', 'connection-erase-text'); text.append(ui.h('span', '', S.eraseConfirm));
      remove.append(icon(doc, 'trash'), text); remove.setAttribute('aria-label', S.remove); remove.title = S.removeBody;
      if (item.builtin) { remove.disabled = true; remove.title = S.builtinNote; }
      else if (item.enabled && item.kind !== 'provider') { remove.disabled = true; remove.title = S.removeInUse; }
      else remove.disabled = busy.has(item.name);
      const owner = kind;
      remove.addEventListener('click', event => {
        event.stopPropagation(); const wasArmed = remove.classList.contains('is-armed'); disarm();
        if (wasArmed) { void operate('delete', { name: item.name }, 'management', owner); return; }
        remove.classList.add('is-armed'); remove.setAttribute('aria-label', S.eraseConfirm);
        const warning = ui.msgline(S.removeBody, true); card.insertBefore(warning, footer);
        armed = () => { remove.classList.remove('is-armed'); remove.setAttribute('aria-label', S.remove); warning.remove(); };
      }, { signal });
      footer.append(remove);
    }
    card.append(footer); return card;
  }
  function renderInstalled() {
    if (!installedGrid) return;
    const needle = states[kind].installedFilter.trim().toLowerCase();
    const mine = installed.filter(p => (p.kind === kind || !p.kind && kind === 'world') && (!needle || [p.label, p.name, p.description, p.worldId].some(value => value?.toLowerCase().includes(needle)))).sort((a, b) => a.name.localeCompare(b.name));
    const state = states[kind], size = pageSize('installed'); if (installedFetched) state.installedPage = Math.min(state.installedPage, Math.max(0, Math.ceil(mine.length / size) - 1));
    installedGrid.replaceChildren(...mine.slice(state.installedPage * size, (state.installedPage + 1) * size).map(installedCard));
    stabilizeGrid(installedGrid, mine.length, size, 150);
    if (!mine.length) installedGrid.append(ui.placeholder(S.noExtensions));
    pager(installedPager, mine.length, state.installedPage, size, page => { installedGrid.style.minHeight = `${installedGrid.getBoundingClientRect().height}px`; state.installedPage = page; renderInstalled(); save(); });
  }
  function renderMarket() {
    const state = states[kind];
    const hits = state.hits.map(h => ({ ...h, installed: installed.some(p => p.name === h.name && p.state !== 'removed') }));
    state.tags = state.tags.filter(id => marketIndex.tags[id]);
    const result = arrangeHits(hits, { filter: state.filter, sort: state.sort, hideInstalled: state.hide, page: state.page, pageSize: pageSize('market'), tags: state.tags, excludeTags: state.hideWarnings ? warningTags() : [], officialOnly: state.officialOnly, certifiedOnly: state.certifiedOnly, newOnly: state.newOnly, ...advancedFilters(state) }); if (state.fetched) state.page = result.page;
    if (clearButton) clearButton.disabled = !filtersActive(state);
    if (licenseList) licenseList.replaceChildren(...[...new Set(hits.map(h => h.license).filter(Boolean))].sort().map(value => { const option = ui.h('option') as HTMLOptionElement; option.value = value!; return option; }));
    renderTagBar(hits);
    marketGrid.replaceChildren(...result.shown.map(hit => {
      const card = ui.h('article', 'extension-card extension-market-card' + (hit.installed ? ' is-installed' : ''));
      const owner = kind; card.tabIndex = 0; card.setAttribute('role', 'button'); card.setAttribute('aria-label', hit.displayName ?? hit.name);
      card.addEventListener('click', () => openDetail(hit, owner), { signal });
      card.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openDetail(hit, owner); } }, { signal });
      const heading = ui.h('div', 'extension-card-heading'); const local = installed.find(item => item.name === hit.name);
      const titleBlock = ui.h('div', 'extension-card-titleblock'), titleLine = ui.h('div', 'extension-card-titleline');
      const title = ui.h('span', 'extension-card-title', hit.displayName ?? local?.metadata?.displayName ?? local?.label ?? hit.name);
      titleLine.append(title); if (hit.installed) titleLine.append(ui.pill(S.alreadyInstalled));
      const metaRow = ui.h('div', 'extension-card-metarow');
      // 署名用 author,悬停 npm 账号;没有 author 时写 `npm@账号`。
      // author 在包文档里,回来之前只写版本。发布者是 GitHub Actions 时改用维护者。
      const byline = ui.h('span', 'extension-card-byline'); let bylineHint = '';
      attachHint(byline, () => bylineHint);
      const sign = (maintainers: readonly string[] | undefined, author: string | undefined, known: boolean) => {
        const publisher = hit.publisher && hit.publisher !== 'GitHub Actions' ? hit.publisher : undefined;
        const account = hit.maintainers?.[0] ?? publisher ?? maintainers?.[0];
        const name = author ?? (account ? `npm@${account}` : S.authorMissing);
        byline.textContent = known ? `${name}${S.metaSeparator}v${hit.version}` : `v${hit.version}`;
        bylineHint = author && account ? `npm: @${account}` : '';
        if (bylineHint) byline.setAttribute('aria-description', bylineHint); else byline.removeAttribute('aria-description');
      };
      sign(undefined, hit.author, !!hit.author);
      metaRow.append(byline, ...badgesOf(hit, state));
      // 搜索结果没带 os 时等包文档
      const placeOs = (os?: readonly string[]) => { metaRow.querySelector('.extension-os')?.remove(); if (os?.length) metaRow.append(osBadge(os)); };
      placeOs(hit.os);
      titleBlock.append(titleLine, metaRow);
      heading.append(packageAvatar(hit.icon ?? (local?.icon ? iconUrl(local.name, local.installedVersion ?? local.version) : undefined)), titleBlock);
      void fetchDetail(hit.name, hit.version).then(data => {
        if (signal.aborted) return;
        if (data.displayName && !hit.displayName) title.textContent = data.displayName;
        sign(data.maintainers, data.author, true);
        if (!hit.os) placeOs(data.os);
      }).catch(() => { /* Search results remain usable when package metadata is unavailable. */ });
      card.append(heading, ui.h('p', 'extension-description', hit.description));
      card.append(summaryLine(owner, hit.summary));
      const tags = orderedTags(hit.tags);
      if (tags.length) {
        const row = ui.h('div', 'extension-tag-row'); row.append(...tags.map(id => tagChip(id, { active: state.tags.includes(id), onToggle: () => toggleTag(id) }))); card.append(row);
        card.addEventListener('pointerleave', () => { if (row.classList.contains('is-open')) foldTags(row); }, { signal });
      }
      const foot = ui.h('div', 'extension-card-foot');
      if (hit.rating) foot.append(votes(hit.name, hit.rating), commentCount(hit.name, hit.rating, () => openDetail(hit, owner, true)));
      foot.append(downloadsStat(hit));
      if (hit.date) foot.append(dateStat(hit.date));
      card.append(foot);
      return card;
    }));
    stabilizeGrid(marketGrid, result.matched, pageSize('market'), 232);
    for (const row of marketGrid.querySelectorAll<HTMLElement>('.extension-card .extension-tag-row')) foldTags(row);
    if (!result.matched) marketGrid.append(ui.placeholder(state.fetched ? state.hits.length ? S.noHits : registry ? S.noPackagesAt(registry) : S.noPackages : S.searching));
    pager(marketPager, result.matched, result.page, pageSize('market'), page => { marketGrid.style.minHeight = `${marketGrid.getBoundingClientRect().height}px`; state.page = page; renderMarket(); save(); });
  }
  /** 标签筛选条:本页签结果里出现过的标签;选中的在前,其余按颜色分组(红色最后)、组内按出现次数;选中的要求全部带上。 */
  function renderTagBar(hits: readonly SearchHitView[]) {
    if (!tagBar) return;
    const state = states[kind];
    const counts = new Map<string, number>();
    for (const hit of hits) for (const id of hit.tags ?? []) if (marketIndex.tags[id]) counts.set(id, (counts.get(id) ?? 0) + 1);
    const officialCount = hits.filter(h => h.official).length, certifiedCount = hits.filter(h => h.certified).length, newCount = hits.filter(h => h.isNew).length;
    tagBar.hidden = !counts.size && !officialCount && !certifiedCount && !newCount;
    const selected = (id: string) => Number(!state.tags.includes(id));
    const barGroup = (id: string) => { const group = tagGroup(id); return group === -2 ? 2 : group; };
    const ids = orderedTags([...counts.keys()]).sort((a, b) => selected(a) - selected(b) || barGroup(a) - barGroup(b) || counts.get(b)! - counts.get(a)!);
    const chips = ui.h('div', 'extension-tag-row');
    const badgeToggle = (key: 'newOnly' | 'certifiedOnly' | 'officialOnly', mark: Parameters<typeof icon>[1], label: string, hint: string, count: number) => {
      if (!count) return;
      const toggle = ui.h('button', 'extension-tag is-badge extension-badge-toggle' + (key === 'newOnly' ? ' is-new' : '') + (state[key] ? ' is-active' : '')) as HTMLButtonElement; toggle.type = 'button';
      toggle.append(icon(doc, mark), ui.h('span', '', label), ui.h('span', 'extension-tag-count', String(count)));
      attachHint(toggle, label, hint); toggle.setAttribute('aria-pressed', String(state[key]));
      toggle.addEventListener('click', () => { state[key] = !state[key]; state.page = 0; renderMarket(); save(); }, { signal });
      chips.append(toggle);
    };
    badgeToggle('certifiedOnly', 'shield-check', S.certified, S.certifiedHint, certifiedCount);
    badgeToggle('officialOnly', 'cortico', S.officialRelease, S.officialHint, officialCount);
    badgeToggle('newOnly', 'sparkles', S.newLabel, S.newHint(marketIndex.newDays ?? 14), newCount);
    chips.append(...ids.map(id => tagChip(id, { active: state.tags.includes(id), count: counts.get(id), onToggle: () => toggleTag(id) })));
    tagBar.replaceChildren(ui.h('span', 'extension-tagbar-label', S.tagFilter), chips);
  }
  async function load(): Promise<boolean> {
    if (signal.aborted) return false;
    const generation = ++loadGeneration;
    try {
      const data = await get<{ dir: string; platform?: string; extensions: ExtensionView[] }>('/api/extensions', { signal });
      if (signal.aborted || generation !== loadGeneration) return !signal.aborted;
      installed = data.extensions; installedFetched = true; directory = data.dir; platform = data.platform ?? ''; const dirNode = root.querySelector('.extension-directory'); if (dirNode) dirNode.textContent = S.labelled(S.directory, directory); renderInstalled(); renderMarket(); restoreScroll(); return true;
    } catch (error) { if (!signal.aborted) { installedFetched = true; message(kind, 'management', S.listLoadFailed(errorText(error)), true); restoreScroll(); } return false; }
  }
  async function checkUpdates() {
    if (signal.aborted) return;
    try { const data = await get<UpdateResultView>('/api/extensions/updates', { signal }); if (signal.aborted) return; updates = new Map(data.updates.map(u => [u.name, u])); renderInstalled(); if (data.errors.length) message(kind, 'management', S.updateCheckFailed(data.errors.map(e => `${e.name}: ${e.error}`).join('; ')), true); }
    catch (error) { if (!signal.aborted) message(kind, 'management', S.updateCheckFailed(errorText(error)), true); }
  }
  async function search(owner: ExtensionKindView) {
    const state = states[owner], generation = ++state.generation;
    message(owner, 'market', S.searching);
    try {
      const data = await get<{ hits: SearchHitView[]; partial?: boolean; registry?: string; index?: MarketIndexView }>(`/api/extensions/search?kind=${owner}`, { signal });
      if (signal.aborted || state.generation !== generation) return;
      registry = data.registry ?? ''; marketIndex = data.index ?? { tags: {} }; state.hits = data.hits; state.fetched = true;
      message(owner, 'market', [data.partial ? S.partial : '', data.index?.error ? S.indexFailed(data.index.error) : '', data.index?.stale ? S.indexStale(data.index.stale) : ''].filter(Boolean).join('\n')); if (owner === kind) { renderInstalled(); renderMarket(); restoreScroll(); }
    } catch (error) { if (!signal.aborted && state.generation === generation) { state.fetched = true; message(owner, 'market', S.searchFailed(errorText(error)), true); if (owner === kind) { renderMarket(); restoreScroll(); } } }
  }
  async function loadRegistry() {
    try { registrySetting = await get<RegistryView>('/api/extensions/registry', { signal }); }
    catch (error) { if (!signal.aborted) message(kind, 'registry', errorText(error), true); return; }
    if (signal.aborted) return;
    if (registrySetting.registryError) { message(kind, 'registry', registrySetting.registryError, true); registryOpen = true; root.querySelector<HTMLElement>('#extension-registry')?.removeAttribute('hidden'); root.querySelector('.extension-registry-toggle')?.classList.add('is-open'); }
    if (registryInput) { registryInput.placeholder = registrySetting.registry ?? ''; if (registryDraft === null) registryInput.value = registrySetting.configured ?? ''; }
  }
  /** 换源后已取到的搜索结果、包详情与更新检查都作废,按新源重取。 */
  async function saveRegistry(value: string) {
    const owner = kind;
    try { registrySetting = await post<RegistryView>('/api/extensions/registry', { registry: value }, { signal }); }
    catch (error) { if (!signal.aborted) message(owner, 'registry', errorText(error), true); return; }
    if (signal.aborted) return;
    registryDraft = null; detailsCache.clear(); updates = new Map();
    for (const state of Object.values(states)) {
      state.hits = []; state.fetched = false; state.generation++; delete state.messages.market;
      if (state.messages.management?.bad) delete state.messages.management;
    }
    render();
    message(owner, 'registry', registrySetting.registry ? S.registrySaved(registrySetting.registry) : registrySetting.registryError ?? '', !registrySetting.registry);
    void checkUpdates(); void search(owner);
  }
  async function loadIndexBase() {
    try { indexBaseSetting = await get<IndexBaseView>('/api/extensions/index-base', { signal }); }
    catch (error) { if (!signal.aborted) message(kind, 'indexBase', errorText(error), true); return; }
    if (signal.aborted) return;
    if (indexBaseInput) { indexBaseInput.placeholder = indexBaseSetting.base; if (indexBaseDraft === null) indexBaseInput.value = indexBaseSetting.configured ?? ''; }
  }
  /** 换索引源后已取到的搜索结果与包详情都作废,按新源重取。 */
  async function saveIndexBase(value: string) {
    const owner = kind;
    try { indexBaseSetting = await post<IndexBaseView>('/api/extensions/index-base', { indexBase: value }, { signal }); }
    catch (error) { if (!signal.aborted) message(owner, 'indexBase', errorText(error), true); return; }
    if (signal.aborted) return;
    indexBaseDraft = null; detailsCache.clear();
    for (const state of Object.values(states)) { state.hits = []; state.fetched = false; state.generation++; delete state.messages.market; }
    render();
    message(owner, 'indexBase', S.indexBaseSaved(indexBaseSetting.base));
    void search(owner);
  }
  /** 安装先按当前类别检查声明再装;删除直接卸。两者都改磁盘,重启进程后生效。 */
  async function operate(action: 'install' | 'delete', target: Target, area: string, owner: ExtensionKindView) {
    const identity = 'name' in target ? target.name : target.path; if (busy.has(identity)) return;
    const actionLabel = action === 'delete' ? S.deletedAction : installed.some(item => item.name === identity) ? S.updatedAction : S.installedAction;
    busy.add(identity); renderInstalled(); message(owner, area, S.progress(actionLabel, identity));
    try {
      let name = identity, version: string | undefined, resultKind: string | undefined;
      if (action === 'install') {
        const checked = await post<{ name: string; version: string; kind: string }>('/api/extensions/check', { target, kind: owner }, { signal });
        ({ name, version, kind: resultKind } = checked);
        await post('/api/extensions/install', 'path' in target ? target : { name: checked.name, version: checked.version }, { signal });
      } else {
        await post('/api/extensions/uninstall', { name: identity }, { signal });
      }
      if (signal.aborted) return;
      const restartHint = action === 'delete' || resultKind !== 'bot' ? ' ' + S.restartNeeded : '';
      const activateHint = actionLabel === S.installedAction && resultKind === 'world' ? ' ' + S.worldActivateHint : '';
      message(owner, area, `${S.completed(actionLabel, name)}${version ? ' ' + S.version(version) : ''}${restartHint}${activateHint}`);
      updates.delete(name);
      if (!await load()) message(owner, area, S.completed(actionLabel, name) + ' ' + S.syncedFailed, true);
    } catch (error) { if (!signal.aborted) message(owner, area, errorText(error), true); }
    finally { busy.delete(identity); if (!signal.aborted) renderInstalled(); }
  }
  function renderDetail(box: HTMLElement, data: PackageDetailView, owner: ExtensionKindView, hit?: SearchHitView, item?: ExtensionView) {
      const title = box.closest('.modalcard')?.querySelector('.modaltitle');
      if (title) title.textContent = data.displayName ?? item?.metadata?.displayName ?? item?.label ?? data.name;
      const historyOpen = box.querySelector('details')?.open ?? false;
      const listed = hit ?? states[owner].hits.find(entry => entry.name === data.name);
      const tags = orderedTags(listed?.tags);
      const local = item ?? installed.find(entry => entry.name === data.name && entry.state !== 'removed');
      const header = ui.h('div', 'extension-detail-header');
      header.append(packageAvatar(listed?.icon ?? (local?.icon ? iconUrl(local.name, local.installedVersion ?? local.version) : undefined)));
      const heading = ui.h('div', 'extension-detail-heading');
      heading.append(ui.h('div', 'extension-detail-name', data.displayName ?? local?.metadata?.displayName ?? local?.label ?? data.name));
      heading.append(ui.h('div', 'extension-detail-sub', item?.builtin ? S.builtin : `${data.name}@${local?.installedVersion ?? data.version}`));
      const badgeList = listed ? badgesOf(listed, states[owner]) : [];
      if (badgeList.length) { const badges = ui.h('div', 'extension-detail-badges'); badges.append(...badgeList); heading.append(badges); }
      header.append(heading);
      const cta = ui.h('div', 'extension-detail-cta');
      if (!item) {
        const isInstalled = installed.some(item => item.name === data.name && item.state !== 'removed');
        const warnings = tags.filter(id => marketIndex.tags[id].style === 'warning');
        const button = ui.button(isInstalled ? S.alreadyInstalled : S.install, { variant: 'primary', onClick: async () => {
          button.disabled = true;
          if (warnings.length && !await ui.confirm({ title: S.installWarningTitle, body: S.installWarningBody(data.name, warnings.map(id => `${marketIndex.tags[id].label}${S.labelSeparator}${plainHint(marketIndex.tags[id].hint)}`), listed?.note), danger: true })) { button.disabled = false; return; }
          void operate('install', { name: data.name, version: data.version }, 'market', owner).finally(() => { if (box.isConnected) button.disabled = installed.some(item => item.name === data.name && item.state !== 'removed'); });
        } });
        button.classList.add('extension-detail-install'); if (!isInstalled) button.prepend(icon(doc, 'download'));
        const os = listed?.os ?? data.os, osBlocked = !isInstalled && !osSupported(os);
        button.disabled = isInstalled || !data.manifest || !!data.problems?.length || data.manifest.kind !== owner || osBlocked; cta.append(button);
        for (const text of data.problems ?? []) cta.append(ui.h('p', 'extension-cta-problem', text));
        if (osBlocked) cta.append(ui.h('p', 'extension-cta-problem', S.osUnsupported(platformName(platform))));
      }
      if (listed?.supersededBy) {
        const next = listed.supersededBy, target = states[owner].hits.find(entry => entry.name === next);
        const [before, after] = S.supersededBy.split('{}');
        const link = ui.h('a', 'extension-superseded-link', target?.displayName ?? next); link.href = '#';
        link.addEventListener('click', event => { event.preventDefault(); openDetail(target ?? { name: next, version: '', description: '', downloads: { month: 0 }, dependents: 0, links: {}, installed: false }, owner); }, { signal });
        const line = ui.h('p', 'extension-cta-superseded'); line.append(before, link, after); cta.append(line);
      }
      header.append(cta);
      const links = ui.rowbar(); links.classList.add('extension-detail-actions');
      for (const [name, href] of Object.entries(data.links)) if (href && /^https?:\/\//i.test(href)) {
        const label = S.linkNames[name as keyof typeof S.linkNames];
        const a = ui.h('a', 'btn secondary sm extension-detail-link'); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.append(icon(doc, LINK_ICONS[name as keyof typeof LINK_ICONS] ?? 'download'), ui.h('span', '', label)); attachHint(a, label, href); links.append(a);
      }
      const changelogUrl = listed?.changelog?.url;
      if (changelogUrl && /^https?:\/\//i.test(changelogUrl)) {
        const a = ui.h('a', 'btn secondary sm extension-detail-link'); a.href = changelogUrl; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.append(icon(doc, 'text'), ui.h('span', '', S.changelogLink)); attachHint(a, S.changelogLink, changelogUrl); links.append(a);
      }
      const feedback = ui.msgline(); feedback.classList.add('extension-operation-feedback'); feedback.setAttribute('role', 'status');
      const columns = ui.h('div', 'extension-detail-columns');
      const main = ui.h('div', 'extension-detail-main'); columns.append(main);
      box.replaceChildren(header, ...(links.hasChildNodes() ? [links] : []), feedback, columns);
      const info = ui.h('div', 'extension-detail-panel');
      const pages: Array<{ value: string; label: string; el: HTMLElement }> = [{ value: 'info', label: S.detailInfoTab, el: info }];
      const described = describeSection(data.describe);
      if (described) { const panel = ui.h('div', 'extension-detail-panel'); panel.append(described.el); pages.push({ value: 'describe', label: described.title, el: panel }); }
      const prompts = promptsSection(data.describe);
      if (prompts) { const panel = ui.h('div', 'extension-detail-panel'); panel.append(prompts.el); pages.push({ value: 'prompts', label: prompts.title, el: panel }); }
      if (pages.length > 1) {
        const tab = pages.some(page => page.value === box.dataset.tab) ? box.dataset.tab! : 'info';
        const show = (value: string) => { box.dataset.tab = value; for (const page of pages) page.el.hidden = page.value !== value; };
        const tabs = ui.segmented(pages.map(({ value, label }) => ({ value, label })), { value: tab, onSelect: show });
        tabs.el.classList.add('extension-detail-tabs');
        main.append(tabs.el, ...pages.map(page => page.el)); show(tab);
      } else main.append(info);
      const intro = ui.h('div', 'extension-intro');
      intro.append(renderMarkdown(doc, item?.builtin ? [item.description, S.builtinNote].filter(Boolean).join(' ') : data.description ?? '—'));
      info.append(ui.h('h4', '', S.introduction), intro);
      // 内建条目要有对应的 npm 包才在索引里
      const indexed = (!item?.builtin || !!listed) && Object.keys(marketIndex.tags).length > 0;
      if (tags.length) { const row = ui.h('div', 'extension-tag-row'); row.append(...tags.map(id => tagChip(id))); info.append(row); }
      if (indexed) {
        const report = ui.h('a', 'extension-tag-feedback', S.feedbackTags); report.href = tagIssueUrl(listed?.name ?? data.name); report.target = '_blank'; report.rel = 'noopener noreferrer';
        info.append(report);
      }
      if (listed?.screenshots?.length) {
        const shots = ui.h('div', 'extension-screenshots');
        for (const src of listed.screenshots) { const image = ui.h('img'); image.src = src; image.alt = ''; image.loading = 'lazy'; shots.append(image); }
        info.append(shots);
      }
      info.append(ui.h('h4', '', S.information));
      if (item?.reason) info.append(ui.msgline(item.reason, true));
      if (item?.webUi === 'missing') info.append(ui.msgline(S.noteWebUiMissing, true));
      for (const text of new Set([...item?.warnings ?? [], ...item ? data.problems ?? [] : [], ...data.warnings])) info.append(ui.msgline(text, true));
      if (data.deprecated) info.append(ui.msgline(S.deprecated(data.deprecated), true));
      const rows = [
        { k: S.authorLabel, v: item?.author ?? data.author ?? S.unknownAuthor },
        ...(item ? [{ k: S.fieldInstalledVersion, v: item.installedVersion ?? item.version ?? '—' }, { k: S.directory, v: item.location ?? directory }] : []),
        { k: item?.builtin ? S.runtime : S.fieldVersion, v: data.published ? `${data.version}${S.metaSeparator}${data.published.slice(0, 10)}` : data.version }, { k: S.fieldLicense, v: data.license ?? '—' },
        { k: S.fieldReleases, v: data.versionCount ? S.releaseCount(data.versionCount, data.created?.slice(0, 10) ?? '') : '—' },
        { k: S.fieldSize, v: data.unpackedSize === undefined ? '—' : S.sizeAndFiles(ui.fmt.bytes(data.unpackedSize), data.fileCount ?? 0) },
        { k: S.fieldMaintainers, v: data.maintainers.join(S.listSeparator) || '—' },
        { k: S.fieldNode, v: data.engines ?? '—' }, { k: S.fieldPlatform, v: (listed?.os ?? data.os)?.length ? osText((listed?.os ?? data.os)!) : S.osAny }, { k: S.fieldDeps, v: data.dependencies.join(S.listSeparator) || S.none },
        { k: S.fieldKeywords, v: data.keywords?.join(S.listSeparator) || '—' },
        { k: S.fieldDownloads, v: hit ? downloadsText(hit) : '—' }, { k: S.fieldDependents, v: hit ? String(hit.dependents) : '—' },
      ];
      info.append(ui.kv(rows));
      {
        const releases = ui.h('details', 'extension-releases'); releases.open = historyOpen;
        releases.append(ui.h('summary', '', S.fieldHistory));
        const history = ui.h('div', 'extension-history');
        const current = local;
        const linked = /^(link:|file:)/.test(current?.spec ?? '');
        for (const release of data.history) {
          const row = ui.h('div');
          const same = (current?.installedVersion ?? current?.version) === release.version;
          const incompatible = !same && !!release.problems?.length;
          const button = ui.button(same ? S.currentVersion : incompatible ? S.incompatible : S.installVersion, { variant: 'danger', size: 'sm', onClick: () => void installRelease(box, data, release.version, owner, hit, item) });
          button.classList.add('extension-version-action');
          button.disabled = same || incompatible || linked || busy.has(data.name);
          if (linked) button.title = S.localVersionNote;
          else if (!same && !incompatible && release.warnings?.length) button.title = release.warnings.join('\n');
          const notes = data.changelog?.[release.version];
          let label: HTMLElement = ui.h('code', '', release.version), body: HTMLElement | null = null;
          if (notes) {
            body = ui.h('div', 'extension-history-notes'); body.hidden = true; body.append(renderMarkdown(doc, notes));
            const toggle = ui.h('button', 'extension-history-version') as HTMLButtonElement; toggle.type = 'button'; toggle.setAttribute('aria-expanded', 'false');
            toggle.append(ui.h('code', '', release.version));
            toggle.addEventListener('click', () => { body!.hidden = !body!.hidden; toggle.setAttribute('aria-expanded', String(!body!.hidden)); }, { signal });
            label = toggle;
          }
          row.append(label, ui.h('time', 'muted', release.date.slice(0, 10) || '—'), button);
          if (incompatible) row.append(ui.h('p', 'extension-history-problem', release.problems!.join(' ')));
          if (body) row.append(body);
          history.append(row);
        }
        releases.append(data.history.length ? history : ui.h('p', 'muted extension-history-empty', S.noHistory)); cta.append(releases);
      }
      if (item?.kind === 'bot') info.append(ui.h('p', 'extension-create-help', S.createBody), ui.h('pre', '', 'pnpm start --new'));
      columns.classList.toggle('is-split', indexed); box.closest('.modalcard')?.classList.toggle('extension-detail-card', indexed);
      if (indexed) { const side = ui.h('aside', 'extension-detail-side'); side.append(commentsSection(listed?.name ?? data.name, listed?.rating)); columns.append(side); }
  }
  /** 历史版本走与市场安装相同的 check → install;结果同时写进抽屉。 */
  async function installRelease(box: HTMLElement, data: PackageDetailView, version: string, owner: ExtensionKindView, hit?: SearchHitView, item?: ExtensionView) {
    const current = installed.find(entry => entry.name === data.name && entry.state !== 'removed');
    const warnings = data.history.find(release => release.version === version)?.warnings ?? [];
    if (busy.has(data.name) || !await ui.confirm({ title: S.versionConfirmTitle, body: [S.versionConfirmBody(data.name, current?.installedVersion ?? current?.version ?? null, version), ...warnings].join('\n'), danger: true })) return;
    if (signal.aborted || busy.has(data.name)) return;
    const show = (note: { text: string; bad: boolean } | undefined) => {
      const feedback = box.querySelector<HTMLElement>('.extension-operation-feedback');
      if (feedback && note) { feedback.textContent = note.text; feedback.classList.toggle('bad', note.bad); }
    };
    const done = operate('install', { name: data.name, version }, 'management', owner);
    box.querySelectorAll<HTMLButtonElement>('.extension-version-action').forEach(button => { button.disabled = true; });
    show(states[owner].messages.management);
    await done;
    const result = states[owner].messages.management;
    await checkUpdates();
    if (signal.aborted || !box.isConnected) return;
    renderDetail(box, data, owner, hit, item && installed.find(entry => entry.name === data.name && entry.state !== 'removed'));
    show(result);
  }
  /** `toComments`:打开后滚到评论区(从卡片上的评论数点进来)。 */
  function openDetail(hit: SearchHitView, owner: ExtensionKindView, toComments = false) {
    const box = ui.h('div', 'extension-detail'); box.append(ui.placeholder(S.loadingDetail));
    const item = installed.find(item => item.name === hit.name && item.state !== 'removed');
    detailDrawer?.dispose(); detailDrawer = ui.drawer(item?.metadata?.displayName ?? item?.label ?? hit.name, box);
    void fetchDetail(hit.name, hit.version || undefined).then(data => {
      if (!signal.aborted && box.isConnected) { renderDetail(box, data, owner, hit); if (toComments) box.querySelector('.extension-comments')?.scrollIntoView({ block: 'start' }); }
    }).catch(error => { if (!signal.aborted && box.isConnected) box.replaceChildren(ui.msgline(errorText(error), true)); });
  }

  /**
   * 重启 = 落标志 + 规范关机,之后轮询 lifecycle 等同一部署的新进程就绪再刷新页面。
   * 关机步骤有没完成的,回执摊在对话框里。
   */
  async function restart() {
    if (!canRestart) return;
    if (!await ui.confirm({ title: supervised ? S.restartConfirmTitle : S.restartNoLoopTitle, body: supervised ? S.restartConfirmBody : S.restartNoLoopBody, danger: !supervised })) return;
    try {
      const before = await get<Life>('/api/run/lifecycle', { signal });
      save(); win.sessionStorage.setItem(storageKey + ':restart', JSON.stringify(before));
      message(kind, 'management', supervised ? S.reloadWait : S.restartManual);
      let report: PowerReport | undefined;
      try { report = await post<PowerReport>('/api/run/restart', undefined, { signal }); } catch (error) {
        if ((error as { status?: number }).status) { win.sessionStorage.removeItem(storageKey + ':restart'); throw error; }
      }
      if (report?.error) { win.sessionStorage.removeItem(storageKey + ':restart'); throw new Error(report.error); }
      const incomplete = (report?.steps ?? []).filter(step => !step.ok);
      if (report && incomplete.length) {
        void ui.confirm({
          title: supervised ? S.doneRestartSupervised : S.doneRestart,
          body: [report.result ?? S.resultDefault, '', ...incomplete.map(step => `✗ ${step.label} · ${step.detail ?? S.stepIncomplete}`)].join('\n'),
        });
      }
      watchRestart(before);
    } catch (error) { if (!signal.aborted) message(kind, 'management', errorText(error), true); }
  }
  function watchRestart(before: Life) {
    const check = async () => {
      if (signal.aborted) return;
      try {
        const next = await get<Life>('/api/run/lifecycle', { signal });
        if (restartOutcome(before, next) === 'wrong-deployment') { win.sessionStorage.removeItem(storageKey + ':restart'); message(kind, 'management', S.otherBot, true); return; }
        if (restartOutcome(before, next) === 'ready') { win.sessionStorage.removeItem(storageKey + ':restart'); save(); win.location.reload(); return; }
      } catch { /* Wait while the listener is unavailable. */ }
      lifecycle.timeout(() => void check(), 1000);
    }; void check();
  }
  function render() {
    const state = states[kind]; tabs.style.setProperty('--tab-index', String(categories.indexOf(kind)));
    tabButtons.forEach((button, i) => { const active = categories[i] === kind; button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; }); panel.setAttribute('aria-labelledby', 'extension-tab-' + kind);
    panel.replaceChildren(); messageNodes = {};
    const managed = ui.sheet({ title: S.installedTitle });
    const bar = ui.rowbar(); bar.classList.add('extension-toolbar');
    managed.el.querySelector('h3')!.append(ui.h('span', 'extension-directory', S.labelled(S.directory, directory)));
    const installedFilters = ui.input({ type: 'search', value: state.installedFilter, placeholder: S.installedFilter, onInput: value => { state.installedFilter = value; state.installedPage = 0; renderInstalled(); save(); } });
    installedFilters.setAttribute('aria-label', S.installedFilter); bar.append(installedFilters, sizePicker('installed'));
    if (canRestart) { const button = ui.button(S.restartProcess, { onClick: () => void restart() }); button.classList.add('extension-restart'); bar.append(button); }
    bar.append(ui.button(S.refresh, { onClick: () => { void load(); void checkUpdates(); } }));
    messageNodes.management = ui.msgline(kind === 'bot' ? S.createBody : kind === 'provider' ? S.providerManagement : S.idleManagement); messageNodes.management.setAttribute('role', 'status'); installedGrid = ui.h('div', 'extension-grid extension-installed-grid'); installedPager = ui.rowbar();
    managed.body.append(bar, messageNodes.management, installedGrid, installedPager);
    const marketSheet = ui.sheet({ title: S.market }); messageNodes.market = ui.msgline(); messageNodes.market.setAttribute('role', 'status');
    const filters = ui.rowbar(); filters.classList.add('extension-toolbar');
    const clear = clearButton = ui.button('', { onClick: clearFilters }); clear.classList.add('extension-clear'); clear.append(icon(doc, 'close'), ui.h('span', '', S.clearFilters));
    filters.append(ui.input({ type: 'search', value: state.filter, placeholder: S.filterPlaceholder, onInput: value => { state.filter = value; state.page = 0; renderMarket(); save(); } }), ui.select({ value: state.sort, options: HIT_SORTS.map(value => ({ value, label: S.sortLabel[value] })), onChange: value => { state.sort = value as HitSort; state.page = 0; renderMarket(); save(); } }), sizePicker('market'), clear, ui.button(S.refresh, { onClick: () => void search(kind) }));
    const options = ui.h('div', 'extension-search-options');
    const advancedToggle = ui.h('button', 'extension-advanced-toggle' + (state.advanced ? ' is-open' : ''), S.advancedSearch) as HTMLButtonElement; advancedToggle.type = 'button';
    advancedToggle.setAttribute('aria-expanded', String(state.advanced)); advancedToggle.setAttribute('aria-controls', 'extension-advanced');
    advancedToggle.addEventListener('click', () => { state.advanced = !state.advanced; save(); render(); }, { signal });
    const switches = ui.h('div', 'extension-switches');
    switches.append(
      ui.checkbox(S.hideInstalled, { checked: state.hide, onChange: value => { state.hide = value; state.page = 0; renderMarket(); save(); } }).el,
      ui.checkbox(S.hideWarnings, { checked: state.hideWarnings, onChange: value => { state.hideWarnings = value; state.page = 0; renderMarket(); save(); } }).el,
    );
    const registryToggle = ui.h('button', 'extension-advanced-toggle extension-registry-toggle' + (registryOpen ? ' is-open' : ''), S.registryLabel) as HTMLButtonElement; registryToggle.type = 'button';
    registryToggle.setAttribute('aria-expanded', String(registryOpen)); registryToggle.setAttribute('aria-controls', 'extension-registry');
    registryToggle.addEventListener('click', () => { registryOpen = !registryOpen; registryPanel.hidden = !registryOpen; registryToggle.classList.toggle('is-open', registryOpen); registryToggle.setAttribute('aria-expanded', String(registryOpen)); }, { signal });
    const indexBaseToggle = ui.h('button', 'extension-advanced-toggle' + (indexBaseOpen ? ' is-open' : ''), S.indexBaseLabel) as HTMLButtonElement; indexBaseToggle.type = 'button';
    indexBaseToggle.setAttribute('aria-expanded', String(indexBaseOpen)); indexBaseToggle.setAttribute('aria-controls', 'extension-index-base');
    indexBaseToggle.addEventListener('click', () => { indexBaseOpen = !indexBaseOpen; indexBasePanel.hidden = !indexBaseOpen; indexBaseToggle.classList.toggle('is-open', indexBaseOpen); indexBaseToggle.setAttribute('aria-expanded', String(indexBaseOpen)); }, { signal });
    const toggles = ui.h('div', 'extension-search-toggles'); toggles.append(advancedToggle, registryToggle, indexBaseToggle);
    options.append(toggles, switches);
    const advanced = ui.h('div', 'extension-advanced'); advanced.id = 'extension-advanced'; advanced.hidden = !state.advanced;
    const field = (label: string, control: HTMLElement) => { const el = ui.h('label', 'extension-advanced-field'); el.append(ui.h('span', '', label), control); return el; };
    const text = (key: 'author' | 'keyword' | 'license', placeholder: string) => ui.input({ value: state[key], placeholder, onInput: value => { state[key] = value; state.page = 0; renderMarket(); save(); } });
    const license = text('license', 'MIT'); license.setAttribute('list', 'extension-licenses');
    licenseList = ui.h('datalist'); licenseList.id = 'extension-licenses';
    const since = ui.select({ value: String(state.sinceDays), options: [0, 7, 30, 90, 365].map(days => ({ value: String(days), label: S.sinceLabel(days) })), onChange: value => { state.sinceDays = Number(value); state.page = 0; renderMarket(); save(); } });
    const minimum = ui.input({ type: 'number', value: state.minDownloads ? String(state.minDownloads) : '', placeholder: '0', onInput: value => { state.minDownloads = Math.max(0, Number(value) || 0); state.page = 0; renderMarket(); save(); } }); minimum.min = '0';
    advanced.append(field(S.advancedAuthor, text('author', S.advancedAuthorHint)), field(S.advancedKeyword, text('keyword', 'tts')), field(S.advancedLicense, license), field(S.advancedSince, since), field(S.advancedDownloads, minimum), licenseList);
    const registryBar = ui.rowbar(); registryBar.classList.add('extension-toolbar');
    const registryField = registryInput = ui.input({ value: registryDraft ?? registrySetting?.configured ?? '', placeholder: registrySetting?.registry ?? '', onInput: value => { registryDraft = value; } });
    registryField.setAttribute('aria-label', S.registryLabel);
    const saveRegistryButton = ui.button(S.registrySave, { onClick: async () => { const lock = ui.disable(saveRegistryButton); try { await saveRegistry(registryField.value); } finally { lock.dispose(); } } });
    registryBar.append(registryField, saveRegistryButton);
    messageNodes.registry = ui.msgline(S.registryHelp); messageNodes.registry.setAttribute('role', 'status');
    const registryPanel = ui.h('div', 'extension-registry'); registryPanel.id = 'extension-registry'; registryPanel.hidden = !registryOpen;
    registryPanel.append(registryBar, messageNodes.registry);
    const indexBaseBar = ui.rowbar(); indexBaseBar.classList.add('extension-toolbar');
    const indexBaseField = indexBaseInput = ui.input({ value: indexBaseDraft ?? indexBaseSetting?.configured ?? '', placeholder: indexBaseSetting?.base ?? '', onInput: value => { indexBaseDraft = value; } });
    indexBaseField.setAttribute('aria-label', S.indexBaseLabel);
    const saveIndexBaseButton = ui.button(S.registrySave, { onClick: async () => { const lock = ui.disable(saveIndexBaseButton); try { await saveIndexBase(indexBaseField.value); } finally { lock.dispose(); } } });
    indexBaseBar.append(indexBaseField, saveIndexBaseButton);
    messageNodes.indexBase = ui.msgline(S.indexBaseHelp); messageNodes.indexBase.setAttribute('role', 'status');
    const indexBasePanel = ui.h('div', 'extension-index-base'); indexBasePanel.id = 'extension-index-base'; indexBasePanel.hidden = !indexBaseOpen;
    indexBasePanel.append(indexBaseBar, messageNodes.indexBase);
    tagBar = ui.h('div', 'extension-tagbar'); tagBar.hidden = true;
    marketGrid = ui.h('div', 'extension-grid'); marketPager = ui.rowbar(); marketSheet.body.append(filters, advanced, options, registryPanel, indexBasePanel, tagBar, messageNodes.market, marketGrid, marketPager);
    const manual = ui.sheet({ title: S.manual }); messageNodes.manual = ui.msgline(); messageNodes.manual.setAttribute('role', 'status');
    const source = ui.segmented([{ value: 'npm', label: S.npm }, { value: 'local', label: S.local }], { value: state.source, onSelect: value => { state.source = value as 'npm' | 'local'; state.input = ''; render(); save(); } });
    const manualBar = ui.rowbar(); const input = ui.input({ value: state.input, placeholder: state.source === 'npm' ? `@scope/cortico-${kind}-demo@1.2.3` : '', onInput: value => { state.input = value; } });
    input.setAttribute('aria-label', state.source === 'npm' ? S.packageLabel : S.pathLabel); manualBar.append(input);
    if (state.source === 'local') manualBar.append(ui.button(S.folder, { onClick: async () => { try { const path = await pickPath({ kind: 'directory', currentPath: input.value }, { signal }); if (path) { state.input = input.value = path; } } catch (error) { message(kind, 'manual', errorText(error), true); } } }));
    const target = (): Target => { if (state.source === 'local' && state.input.trim()) return { path: state.input.trim() }; const value = parseInstallInput(state.input); if (!value) throw new Error(S.invalidInput); return value; };
    const owner = kind;
    const check = ui.button(S.check, { onClick: async () => { const lock = ui.disable(check); try { const data = await post<{ name: string; version: string; kind: string }>('/api/extensions/check', { target: target(), kind: owner }, { signal }); message(owner, 'manual', `${S.checkOk} · ${data.name}@${data.version} · ${data.kind}`); } catch (error) { message(owner, 'manual', errorText(error), true); } finally { lock.dispose(); } } });
    const install = ui.button(S.install, { variant: 'primary', onClick: () => { try { void operate('install', target(), 'manual', owner); } catch (error) { message(owner, 'manual', errorText(error), true); } } });
    const manualActions = ui.rowbar(); manualActions.classList.add('extension-manual-actions'); manualActions.append(check, install, messageNodes.manual);
    manual.body.append(ui.h('p', 'sh-desc extension-install-help', state.source === 'npm' ? S.npmHelp : S.localHelp), source.el, manualBar, manualActions);
    panel.append(managed.el, marketSheet.el, manual.el); root.style.setProperty('--extension-columns', String(columns));
    for (const [area, value] of Object.entries(state.messages)) if (messageNodes[area]) { messageNodes[area].textContent = value.text; messageNodes[area].className = 'msgline' + (value.bad ? ' bad' : ''); }
    renderInstalled(); renderMarket();
  }
  lifecycle.own(router.onChange(route => {
    const next = route.segments[1] as ExtensionKindView; if (!categories.includes(next) || next === kind || route.segments[0] !== 'extensions') return;
    save(); kind = next; restoringScroll = true; render(); restoreScroll(); if (!states[kind].fetched) void search(kind);
  }));
  // 只看宽度变化
  let panelWidth = panel.clientWidth;
  if (typeof win.ResizeObserver === 'function') { const observer = new win.ResizeObserver(() => {
    if (panel.clientWidth === panelWidth) return;
    panelWidth = panel.clientWidth;
    const next = extensionColumns(panelWidth);
    if (next === columns) { for (const row of marketGrid.querySelectorAll<HTMLElement>('.extension-card .extension-tag-row')) if (!row.classList.contains('is-open')) foldTags(row); return; }
    for (const state of Object.values(states)) { if (!state.installedSize) state.installedPage = Math.floor(state.installedPage * columns / next); if (!state.marketSize) state.page = Math.floor(state.page * columns / next); }
    columns = next; installedGrid.style.minHeight = ''; marketGrid.style.minHeight = '';
    for (const label of panel.querySelectorAll<HTMLElement>('.extension-size')) { const option = label.querySelector('option[value="0"]'); if (option) option.textContent = S.automaticCount(columns * (label.dataset.area === 'installed' ? 2 : 4)); }
    root.style.setProperty('--extension-columns', String(columns)); renderInstalled(); renderMarket();
  }); observer.observe(panel); lifecycle.add(() => observer.disconnect()); }
  render();
  if (!categories.includes(router.route.segments[1] as ExtensionKindView)) router.replace(['extensions', kind]);
  void load(); void checkUpdates(); void search(kind); void loadRegistry(); void loadIndexBase();
  try { const marker = win.sessionStorage.getItem(storageKey + ':restart'); if (marker) { message(kind, 'management', S.reloadWait); watchRestart(JSON.parse(marker)); } } catch { /* Invalid recovery marker. */ }
}
export const extensionsFeature: FrameworkFeature = { route: 'extensions', label: S.navLabel, icon: 'download', navGroup: S.navGroup, needsAny: ['extensions'], mount: mountExtensions };
