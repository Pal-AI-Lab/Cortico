/** 扩展管理页。扩展信息与运行状态由服务端提供；安装、卸载后需重启进程才能生效。World 与供应商页面共用内容。 */

import { get, post, pickPath } from '../../core/api.ts';
import { icon, brandMark } from '../../ui/icons.ts';
import { renderMarkdown } from './markdown.ts';
import type { FeatureContext } from '../feature.ts';
import { S } from './strings.ts';
import { CATALOG_CATEGORY_IDS, inCatalogCategory, isFunctionTag, type CatalogCategory } from './catalog.ts';
import { problemPopover, scrollerOf, wheelDelta } from '../../ui/problem.ts';
import { fold, measureReflow, prefersStill } from '../../core/motion.ts';
import { matchRanges, matchRank, prepareFields, searchTerms, type MatchRank, type PreparedFields } from './search.ts';

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

/** 与 `ExtensionSearchHit` 同形。 */
export interface SearchHitView {
  name: string;
  version: string;
  description: string;
  date?: string;
  publisher?: string;
  license?: string;
  keywords?: string[];
  downloads: { total?: number; month?: number; week?: number };
  dependents: number;
  links: { npm?: string; repository?: string; homepage?: string };
  installed: boolean;
  kind?: ExtensionKindView;
  /** 页面自己补的名字:包文档或本地安装给的显示名,只用于搜索 */
  aliases?: string[];
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
  history: Array<{ version: string; date: string; problems?: string[] }>;
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
  /** 标签 id 换成显示名,搜索词也比标签名 */
  tagLabel?: (id: string) => string | undefined;
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

/** 把文本写进 `el`,命中的部分包进 `<mark>`。 */
function writeMarked(el: HTMLElement, text: string, terms: readonly string[]): void {
  const doc = el.ownerDocument, nodes: Node[] = [];
  let at = 0;
  for (const [start, end] of matchRanges(text, terms)) {
    if (start > at) nodes.push(doc.createTextNode(text.slice(at, start)));
    const mark = doc.createElement('mark'); mark.className = 'extension-hit'; mark.textContent = text.slice(start, end); nodes.push(mark);
    at = end;
  }
  if (at < text.length || !nodes.length) nodes.push(doc.createTextNode(text.slice(at)));
  el.replaceChildren(...nodes);
}

/** 规整过的搜索字段按包缓存,内容没变就不重算;每敲一个字都要过一遍整份结果。 */
const preparedHits = new Map<string, { key: string; fields: PreparedFields }>();
function searchFields(h: SearchHitView, tagLabel?: (id: string) => string | undefined): PreparedFields {
  const labels = [...(h.tags ?? []).map(id => tagLabel?.(id) ?? id), ...h.keywords ?? [], h.author, h.publisher, ...h.maintainers ?? []];
  const parts = { names: [h.name, h.displayName, ...h.aliases ?? []], labels, text: [h.description, h.note] };
  const key = JSON.stringify(parts), cached = preparedHits.get(h.name);
  if (cached?.key === key) return cached.fields;
  const fields = prepareFields(parts); preparedHits.set(h.name, { key, fields });
  return fields;
}

/**
 * 在整份结果上筛选、排序、切页。registry 的搜索端点在 `keywords:` 过滤下不按文本
 * 缩小结果,所以文本匹配在这里做,规则见 search.ts。有搜索词时先按命中档次,同档再按 `sort`。
 * `page` 超出范围时收回最后一页,返回值里的 `page` 是实际用的那一页。
 */
export function arrangeHits(
  hits: readonly SearchHitView[],
  opts: ArrangeOptions,
): { matched: number; pages: number; page: number; shown: SearchHitView[] } {
  const terms = searchTerms(opts.filter);
  const ranks = new Map<SearchHitView, MatchRank>();
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
    if (opts.minDownloads && (h.downloads.month ?? 0) < opts.minDownloads) return false;
    if (opts.tags?.some((t) => !h.tags?.includes(t))) return false;
    if (opts.excludeTags?.some((t) => h.tags?.includes(t))) return false;
    if (!terms.length) return true;
    const rank = matchRank(terms, searchFields(h, opts.tagLabel));
    if (rank === undefined) return false;
    ranks.set(h, rank); return true;
  });
  const score = (h: SearchHitView) => h.rating ? h.rating.up - h.rating.down : -Infinity;
  matched.sort((a, b) => {
    const ahead = (ranks.get(b) ?? 0) - (ranks.get(a) ?? 0);
    if (ahead) return ahead;
    switch (opts.sort) {
      case 'certified': return Number(!!b.certified) - Number(!!a.certified) || a.name.localeCompare(b.name);
      case 'rating': return score(b) - score(a) || (b.rating?.up ?? 0) - (a.rating?.up ?? 0) || a.name.localeCompare(b.name);
      case 'downloads': return (b.downloads.month ?? -1) - (a.downloads.month ?? -1) || a.name.localeCompare(b.name);
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

type Target = { name: string; version?: string } | { path: string };
interface Life { deployment: string; bootId: string; ready: boolean }
interface PowerReport { result?: string; error?: string; steps?: Array<{ label: string; ok: boolean; elapsedMs: number; detail?: string }> }
/** 重启后轮询到的进程:同一部署、换了 bootId 且就绪才算回来了。 */
export function restartOutcome(before: Life, next: Life): 'waiting' | 'ready' | 'wrong-deployment' {
  return next.deployment !== before.deployment ? 'wrong-deployment' : next.bootId !== before.bootId && next.ready ? 'ready' : 'waiting';
}
/** 每个类别页签各自记住的筛选、分页与滚动位置。操作结果不跨刷新保存。 */
interface CategoryState {
  marketSize: number;
  filter: string; sort: HitSort; page: number; scroll: number;
  /** `tags` must all be on a package. 推荐 is one of certified and official. */
  tags: string[]; officialOnly: boolean; certifiedOnly: boolean; newOnly: boolean;
  advanced: boolean; author: string; keyword: string; license: string; sinceDays: number; minDownloads: number;
  hits: SearchHitView[]; fetched: boolean; generation: number; messages: Record<string, { text: string; bad: boolean }>;
  source: 'npm' | 'local'; input: string;
  catalogCategory: CatalogCategory; filtersFolded: boolean;
  /** Extension catalog: list every package, only installed ones, or only those not installed. */
  installation: 'all' | 'installed' | 'available';
}
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
/** World、供应商与 Bot 模板三类扩展。 */
type Category = ExtensionKindView;
const categories: Category[] = ['world', 'provider', 'bot'];
const LINK_ICONS = { npm: 'package', repository: 'code', homepage: 'home', bugs: 'alert' } as const;
const stateLabels = { loaded: S.disabled, failed: S.stateFailed, 'pending-restart': S.statePendingRestart, removed: S.stateRemoved, idle: S.template };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export interface ExtensionWorkspace {
  statusRoot: HTMLElement;
  restartRoot: HTMLElement;
  beforeReload(): void;
  onLoadError(): void;
  onChange(items: readonly ExtensionView[]): void;
  /** `from` is where the package's icon was on screen when the install started. */
  onAdded(name: string, from?: DOMRect): void;
  /** Shows the installed package's row in the World library. */
  reveal(name: string): void;
  /** The installed packages that have an update, by name, each time that set changes. */
  onUpdates(updates: ReadonlyMap<string, { installedVersion: string; latestVersion: string }>): void;
}
/** Resolves the control an operation's error popover points at; the control may be re-rendered meanwhile. */
export type Anchor = () => Element | null | undefined;
export interface ExtensionController {
  /**
   * Shows the market again: restores its scroll and renders the cards in view at once, until `until`
   * settles. A reveal passes its end: under its clip the browser does not count those cards as in
   * view, so they would stay blank until it ended.
   */
  activate(until?: Promise<unknown>): void;
  /** Opens the package's install information: installed version, location and releases. */
  details(name: string): void;
  remove(name: string, anchor: Anchor): Promise<void>;
}

export function mountExtensionContent(ctx: FeatureContext, kind: Category, workspace?: ExtensionWorkspace): ExtensionController {
  const { root, ui, lifecycle, signal } = ctx;
  const win = root.ownerDocument.defaultView!;
  const restartRoot = workspace?.restartRoot ?? ui.h('div', 'extension-catalog-restart');
  const canRestart = ctx.capabilities.restart === true;
  const supervised = ctx.capabilities.supervised === true;
  const storageKey = 'cortico.extensions.v3:' + win.location.origin;
  const states = Object.fromEntries(categories.map(kind => [kind, {
    marketSize: 0,
    filter: '', sort: 'certified', page: 0, scroll: 0, tags: [], officialOnly: false, certifiedOnly: false, newOnly: false, advanced: false, author: '', keyword: '', license: '', sinceDays: 0, minDownloads: 0, hits: [], fetched: false, generation: 0,
    messages: {}, source: 'npm', input: '', catalogCategory: 'all', filtersFolded: false, installation: 'all',
  } satisfies CategoryState])) as unknown as Record<Category, CategoryState>;
  try {
    const saved = JSON.parse(win.sessionStorage.getItem(storageKey) ?? '{}');
    for (const kind of categories) if (saved[kind]) Object.assign(states[kind], saved[kind], { hits: [], fetched: false, generation: 0, messages: {} });
    for (const kind of categories) if (!HIT_SORTS.includes(states[kind].sort)) states[kind].sort = 'certified';
    for (const kind of categories) if (!CATALOG_CATEGORY_IDS.includes(states[kind].catalogCategory)) states[kind].catalogCategory = 'all';
  } catch { /* Storage can be disabled by the browser. */ }
  /** 注意事项 the viewer excludes. They outlast the session and apply to both markets. */
  const exclusionsKey = 'cortico.extensions.exclusions.v1:' + win.location.origin;
  let exclusions: string[] = [];
  try { const saved: unknown = JSON.parse(win.localStorage.getItem(exclusionsKey) ?? '[]'); if (Array.isArray(saved)) exclusions = saved.filter((id): id is string => typeof id === 'string'); } catch { /* Storage can be disabled by the browser. */ }
  const saveExclusions = () => { try { win.localStorage.setItem(exclusionsKey, JSON.stringify(exclusions)); } catch { /* Optional browser state. */ } };
  let installed: ExtensionView[] = [];
  let updates = new Map<string, UpdateView>();
  const announceUpdates = () => workspace?.onUpdates(new Map(updates));
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
  let loadGeneration = 0, updateGeneration = 0;
  /**
   * The extension catalog's hits before any sidebar choice. Excluded tags take their packages out first, so no
   * sidebar choice brings them back; `unexcluded` keeps them, to count what the exclusions hide.
   */
  const catalogHits = (state: CategoryState, unexcluded = false): SearchHitView[] => {
    const hits = [...state.hits];
    // Providers and Bot templates have no separate library, so local packages remain accessible without npm results.
    if (kind !== 'world') for (const item of installed) {
      if (item.kind !== kind || item.state === 'removed' || hits.some(hit => hit.name === item.name)) continue;
      hits.push({ name: item.name, version: item.installedVersion ?? item.version ?? '', description: item.description ?? item.metadata?.description ?? '', displayName: item.metadata?.displayName ?? item.label,
        author: item.author ?? item.metadata?.author, kind, installed: true, downloads: { month: 0 }, dependents: 0, links: item.metadata?.links ?? {} });
    }
    const excluded = unexcluded ? [] : exclusions;
    return excluded.length ? hits.filter(hit => !(hit.tags ?? []).some(id => excluded.includes(id))) : hits;
  };
  /** Repaints the extension catalog's category list: counts and the selected category. */
  let paintCategories: (() => void) | undefined;
  /** A second click on the selected category goes back to all. Picking a category starts its tags afresh: 推荐, selected tags and exclusions are cleared. */
  function selectCategory(value: CatalogCategory) {
    const state = states[kind]; state.catalogCategory = state.catalogCategory === value ? 'all' : value;
    state.tags = []; state.certifiedOnly = state.officialOnly = state.newOnly = false;
    if (exclusions.length) { exclusions = []; saveExclusions(); }
    state.page = 0; renderMarket(); save();
  }
  /** Loads and searches in flight; the catalog toolbar's refresh icon spins while any runs. */
  let refreshing = 0;
  let refreshControl: HTMLElement | undefined;
  /** The spinning icon finishes its current turn before it stops. */
  const settleSpin = () => {
    const turning = refreshControl?.querySelector('.icon')?.getAnimations?.()[0];
    if (!turning) { refreshControl?.classList.remove('is-spinning'); return; }
    refreshControl!.addEventListener('animationiteration', () => { if (!refreshing) refreshControl?.classList.remove('is-spinning'); }, { once: true, signal });
  };
  const refreshed = <T,>(work: Promise<T>) => {
    refreshing++; refreshControl?.classList.add('is-spinning');
    return work.finally(() => { if (--refreshing === 0) settleSpin(); });
  };
  /** The refresh button hides the cards while the list reloads, then deals them back in, so a refresh shows even when nothing changed. */
  let replays = 0;
  async function replayCards(work: Promise<unknown>) {
    const run = ++replays, grid = marketGrid;
    if (prefersStill(win)) { await work; return; }
    grid.classList.add('is-reloading');
    await Promise.all([work.catch(() => {}), new Promise(resolve => win.setTimeout(resolve, 110))]);
    if (signal.aborted || run !== replays) return;
    grid.classList.remove('is-reloading');
    grid.querySelectorAll<HTMLElement>(':scope > .extension-market-card').forEach((card, index) => card.animate?.([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 180, delay: Math.min(index, 10) * 20, easing: 'cubic-bezier(.32,.72,0,1)', fill: 'backwards' }));
  }
  let installedFetched = false;
  let restoringScroll = true;
  const restoreScroll = () => {
    if (root.hidden || !restoringScroll || !installedFetched || !states[kind].fetched) return;
    scrollRoot.scrollTop = states[kind].scroll;
    restoringScroll = false;
  };
  /** 正在安装或删除的包;同一个包的第二次操作等前一次回来。 */
  const busy = new Set<string>();
  const doc = root.ownerDocument;
  const scrollRoot = ui.h('div', 'world-catalog-scroll');
  root.addEventListener('wheel', event => {
    const target = event.target as Element;
    if (target.closest('.world-catalog-scroll, .world-catalog-filters, select, textarea')) return;
    const own = scrollerOf(target); if (own && root.contains(own) && own !== root) return;
    event.preventDefault(); scrollRoot.scrollBy({ top: wheelDelta(event) });
  }, { passive: false, signal });
  const narrowFilters = win.matchMedia?.('(max-width: 760px)');
  let narrowFiltersOpen = false;
  let syncFilterLayout: (() => void) | undefined;
  narrowFilters?.addEventListener('change', () => syncFilterLayout?.(), { signal });
  // 历史版本下拉:在同一个抽屉里点别处就收起;确认框等别的浮层里的点击不算
  doc.addEventListener('click', event => { for (const open of doc.querySelectorAll<HTMLDetailsElement>('.extension-releases[open]')) if (!open.contains(event.target as Node) && open.closest('.modalcard')?.contains(event.target as Node)) open.open = false; }, { signal });
  const panel = ui.h('div', 'extension-category world-catalog');
  root.append(panel);
  let marketGrid: HTMLElement, marketPager: HTMLElement;
  let tagBar: HTMLElement | undefined, activeBar: HTMLElement | undefined, warningControl: HTMLElement | undefined, clearButton: HTMLButtonElement | undefined, licenseList: HTMLElement | undefined;
  let messageNodes: Record<string, HTMLElement> = {};
  const save = () => {
    if (!root.hidden && !restoringScroll) states[kind].scroll = scrollRoot.scrollTop;
    try {
      const { hits: _hits, fetched: _fetched, generation: _gen, messages: _messages, ...saved } = states[kind];
      win.sessionStorage.setItem(storageKey, JSON.stringify({ ...JSON.parse(win.sessionStorage.getItem(storageKey) ?? '{}'), [kind]: saved }));
    } catch { /* Optional browser state. */ }
  };
  scrollRoot.addEventListener('scroll', save, { signal, passive: true }); lifecycle.add(save);
  for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) root.addEventListener(event, () => { restoringScroll = false; }, { signal, passive: true });
  function message(owner: Category, area: string, text: string, bad = false) {
    states[owner].messages[area] = { text, bad };
    if (owner === kind && messageNodes[area]) { messageNodes[area].textContent = text; messageNodes[area].className = 'msgline' + (bad ? ' bad' : ''); }
  }
  /** The extension catalog lists one card per row, so it pages in fixed sizes instead of filling columns. */
  const CATALOG_PAGE_SIZES = [10, 20, 30, 50], CATALOG_PAGE_SIZE = 30;
  const pageSize = () => CATALOG_PAGE_SIZES.includes(states[kind].marketSize) ? states[kind].marketSize : CATALOG_PAGE_SIZE;
  function sizePicker() {
    const state = states[kind];
    const label = ui.h('label', 'extension-size'); label.append(ui.h('span', '', S.perPage));
    label.append(ui.select({ value: String(pageSize()), options: CATALOG_PAGE_SIZES.map(value => ({ value: String(value), label: String(value) })), onChange: value => {
      state.marketSize = Number(value); state.page = 0; renderMarket(); save();
    } })); return label;
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
  /** 包文档里的显示名:索引没给显示名的包,卡片标题等文档回来才有,搜索也要认它。 */
  const documentNames = new Map<string, string>();
  /** 卡片标题可能用到的其他名字(包文档的、本地安装的显示名与名称),搜索都认。 */
  const named = (hit: SearchHitView): SearchHitView => {
    const local = installed.find(item => item.name === hit.name);
    const aliases = [documentNames.get(hit.name), local?.metadata?.displayName, local?.label].filter((name): name is string => !!name && name !== hit.displayName);
    return aliases.length ? { ...hit, aliases } : hit;
  };
  function fetchDetail(name: string, version?: string) {
    const key = name + '@' + (version ?? 'latest');
    let request = detailsCache.get(key);
    if (!request) {
      request = get<PackageDetailView>('/api/extensions/package?name=' + encodeURIComponent(name) + (version ? '&version=' + encodeURIComponent(version) : ''), { signal });
      detailsCache.set(key, request);
      void request.then(data => { if (data.displayName) documentNames.set(name, data.displayName); }, () => { /* The rejection is kept for this page's lifetime. */ });
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
  let hintAnchor: Element | null = null;
  // Floating tips sit over the page; the wheel still scrolls what is under them.
  hintBox.addEventListener('wheel', event => { const target = scrollerOf(hintAnchor); hideHint(); if (target) { event.preventDefault(); target.scrollBy({ top: wheelDelta(event) }); } }, { passive: false, signal });
  const problems = problemPopover(doc, signal);
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
      keepHint(); hintAnchor = el;
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
  /**
   * A sidebar row keeps its explanation behind a question mark beside the name, shown while the row is hovered;
   * hovering the mark opens it, and a click on the mark does not press the row.
   */
  function helpMark(row: HTMLElement, title: string, text: string) {
    row.setAttribute('aria-description', plainHint(text));
    const mark = ui.h('span', 'extension-tag-help'); mark.append(icon(doc, 'help'));
    attachHint(mark, title, text);
    mark.addEventListener('click', event => event.stopPropagation(), { signal });
    return mark;
  }
  /** 标签:悬停显示说明,侧栏里(`helpMark`)改由名字旁的问号显示。给了 `onToggle` 就是筛选按钮,点它不打开卡片。 */
  function tagChip(id: string, opts?: { active?: boolean; count?: number; onToggle?: () => void; helpMark?: boolean }) {
    const tag = marketIndex.tags[id];
    const el = ui.h(opts?.onToggle ? 'button' : 'span', 'extension-tag' + (tag.style ? ' is-' + tag.style : '') + (opts?.active ? ' is-active' : ''));
    el.append(ui.h('span', '', tag.label));
    if (!opts?.helpMark) attachHint(el, tag.label, tag.hint); else if (tag.hint) el.append(helpMark(el, tag.label, tag.hint));
    if (opts?.count !== undefined) el.append(ui.h('span', 'extension-tag-count', String(opts.count)));
    const toggle = opts?.onToggle;
    if (toggle) {
      (el as HTMLButtonElement).type = 'button'; el.setAttribute('aria-pressed', String(!!opts?.active));
      el.addEventListener('click', event => { event.stopPropagation(); toggle(); }, { signal });
      el.addEventListener('keydown', event => event.stopPropagation(), { signal });
    }
    return el;
  }
  function badge(cls: string, mark: Parameters<typeof icon>[1], label: string, hint: string) { const el = ui.h('span', cls); el.append(icon(doc, mark), ui.h('span', '', label)); attachHint(el, label, hint); return el; }
  const officialBadge = () => badge('extension-official-badge', 'cortico', S.officialRelease, S.officialHint);
  const certifiedBadge = () => badge('extension-certified-badge', 'shield-check', S.certified, S.certifiedHint);
  const newBadge = () => badge('extension-new-badge', 'sparkles', S.newLabel, S.newHint(marketIndex.newDays ?? 14));
  /** 一个包的全部徽标。 */
  function badgesOf(hit: SearchHitView) {
    return [
      ...(hit.certified ? [certifiedBadge()] : []),
      ...(hit.official ? [officialBadge()] : []),
      ...(hit.isNew ? [newBadge()] : []),
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
  /** 「清除筛选」清搜索词、标签、徽标筛选与高级搜索,保留注意事项的排除。 */
  const filtersActive = (state: CategoryState) => !!((state.catalogCategory !== 'all' || state.installation !== 'all') || state.filter.trim() || state.tags.length || state.officialOnly || state.certifiedOnly || state.newOnly || state.author.trim() || state.keyword.trim() || state.license.trim() || state.sinceDays || state.minDownloads);
  /** 「清除其他筛选」只留下搜索词。 */
  function clearFilters(keepQuery = false) {
    Object.assign(states[kind], { catalogCategory: 'all', installation: 'all', filter: keepQuery ? states[kind].filter : '', tags: [], officialOnly: false, certifiedOnly: false, newOnly: false, author: '', keyword: '', license: '', sinceDays: 0, minDownloads: 0, page: 0 });
    save(); render();
  }
  const tagLabel = (id: string) => marketIndex.tags[id]?.label;
  /** 没有结果时的说明;搜索词在去掉其他筛选后有结果,就说有几个并给出一键清除。 */
  function emptyMarket(state: CategoryState): HTMLElement {
    if (!state.fetched) return ui.placeholder(S.searching);
    const all = catalogHits(state).map(named);
    if (!all.length) return ui.placeholder(registry ? S.noPackagesAt(registry) : S.noPackages);
    const elsewhere = state.filter.trim() ? arrangeHits(all, { filter: state.filter, tagLabel, sort: state.sort, hideInstalled: false, page: 0, pageSize: 1 }).matched : 0;
    if (!elsewhere) return noResult();
    const box = noResult(ui.h('p', 'extension-empty-note', S.hitsElsewhere(elsewhere)), ui.button(S.clearOtherFilters, { onClick: () => clearFilters(true) }));
    box.classList.add('extension-hits-elsewhere');
    return box;
  }
  /** Nothing matches: the Cortico mark, the line beneath, and whatever else the case adds below. */
  function noResult(...more: HTMLElement[]) {
    const box = ui.h('div', 'extension-empty'); box.append(brandMark(doc, 'extension-empty-mark'), ui.h('p', '', S.noHits), ...more);
    return box;
  }
  /** 注意事项 only exclude: the notice and warning tags, and after them the plain tags that pick no category. */
  const isExclusion = (id: string) => { const tag = marketIndex.tags[id]; return !!tag && (tag.style === 'notice' || tag.style === 'warning' || (!tag.style && !isFunctionTag(id))); };
  function toggleTag(id: string) {
    const state = states[kind];
    state.tags = state.tags.includes(id) ? state.tags.filter(t => t !== id) : [...state.tags, id];
    state.page = 0; renderMarket(); save();
  }
  /** Excluding a tag drops it from the selection and is kept across sessions. */
  function toggleExclude(id: string) {
    const state = states[kind];
    exclusions = exclusions.includes(id) ? exclusions.filter(t => t !== id) : [...exclusions, id]; saveExclusions();
    state.tags = state.tags.filter(t => t !== id);
    state.page = 0; renderMarket(); save();
  }
  /** A tag on a card: a 注意事项 strikes through and shows a grey eye on hover, and a click excludes it; any other tag adds to the selection within the current category. */
  function cardTag(id: string) {
    if (isExclusion(id)) {
      const chip = tagChip(id, { onToggle: () => toggleExclude(id) });
      chip.classList.add('is-exclusion'); chip.setAttribute('aria-label', S.excludeTag(tagLabel(id) ?? id)); chip.append(icon(doc, 'eye', 'icon extension-tag-eye'));
      return chip;
    }
    const state = states[kind];
    return tagChip(id, { active: state.tags.includes(id), onToggle: () => toggleTag(id) });
  }
  const warningsHidden = () => { const warnings = warningTags(); return !!warnings.length && warnings.every(id => exclusions.includes(id)); };
  /** The toolbar's warning switch: excludes every warning tag at once, or lets them all back. */
  function toggleWarnings() {
    const warnings = warningTags(), all = warnings.every(id => exclusions.includes(id));
    exclusions = all ? exclusions.filter(id => !warnings.includes(id)) : [...new Set([...exclusions, ...warnings])]; saveExclusions();
    const state = states[kind]; state.tags = state.tags.filter(id => !exclusions.includes(id)); state.page = 0; renderMarket(); save();
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
    for (const chip of chips) chip.inert = false;
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
    chips.forEach((chip, index) => { chip.inert = index >= cut; });
    if (opened) { row.style.maxHeight = from + 'px'; void row.offsetHeight; }
    row.style.maxHeight = folded + 'px';
    more.setAttribute('aria-label', S.moreTags(chips.length - cut));
    more.addEventListener('click', event => {
      event.stopPropagation();
      more.remove(); row.classList.add('is-open');
      for (const chip of chips) chip.inert = false;
      chips[cut]?.focus({ preventScroll: true });
      row.style.maxHeight = row.scrollHeight + 'px';
    }, { signal });
    more.addEventListener('keydown', event => event.stopPropagation(), { signal });
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
    // Headed like the information tab's 简介; a count follows the title.
    const heading = (text: string, count?: number) => { const h = ui.h('h4', 'extension-detail-heading-note', text); if (count !== undefined) h.append(ui.h('span', 'extension-describe-count', String(count))); return h; };
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
      // Headed like the information tab's 简介; the prompt's key follows the title.
      const head = ui.h('h4', 'extension-detail-heading-note', prompt.title); head.append(ui.h('code', '', prompt.key));
      section.append(head, ui.h('pre', 'extension-prompt-body', prompt.content));
    }
    return { title: S.promptsTabWorld, el: section };
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
  function details(name: string) {
    const item = installed.find(item => item.name === name);
    if (item) { showLocal(item); return; }
    const hit = states[kind].hits.find(hit => hit.name === name);
    if (hit) openDetail(hit, kind);
  }
  function renderRestart() {
    const pending = installed.some(item => (item.kind === kind || !item.kind) && (item.state === 'pending-restart' || item.state === 'removed'));
    const button = restartRoot.querySelector<HTMLButtonElement>('.extension-restart');
    if (button) { button.hidden = !pending; button.disabled = busy.size > 0 || restartRoot.classList.contains('is-restarting'); }
  }
  /** The market card's control; an installed package's leads to its row. */
  function getButton(hit: SearchHitView & { installed: boolean }, owner: Category): HTMLButtonElement {
    return installControl(hit, owner, {
      anchor: () => marketGrid.querySelector(`.extension-market-card[data-name="${CSS.escape(hit.name)}"] .extension-get`),
      onInstalled: () => { if (workspace) workspace.reveal(hit.name); else details(hit.name); },
    });
  }
  /**
   * The install control the market cards and the detail page share: install, its progress, an
   * available update, or the installed mark (a link when `onInstalled` is given). Errors open beside
   * the control `anchor` finds; `blocked` keeps an install from starting.
   */
  function installControl(hit: SearchHitView & { installed: boolean }, owner: Category, opts: { anchor: Anchor; onInstalled?: () => void; blocked?: boolean }): HTMLButtonElement {
    const update = updates.get(hit.name), working = busy.has(hit.name), { anchor } = opts;
    if (hit.installed && !update && !working) {
      const done = ui.h('button', 'extension-get is-installed') as HTMLButtonElement; done.type = 'button';
      done.setAttribute('aria-label', S.alreadyInstalled); attachHint(done, S.alreadyInstalled); done.append(icon(doc, 'check'));
      const open = opts.onInstalled;
      if (open) done.addEventListener('click', event => { event.stopPropagation(); open(); }, { signal });
      else done.classList.add('is-mark');
      return done;
    }
    const label = working ? S.progress(hit.installed ? S.updatedAction : S.installedAction, hit.name) : update ? `${S.updateAction} ${S.updateVersions(update.installedVersion, update.latestVersion)}` : owner === 'world' ? S.addToLibrary : S.install;
    const button = ui.h('button', 'extension-get' + (working ? ' is-working' : update ? ' is-update' : '')) as HTMLButtonElement; button.type = 'button';
    button.setAttribute('aria-label', label);
    if (working) {
      const svg = 'http://www.w3.org/2000/svg';
      const ring = doc.createElementNS(svg, 'svg'); ring.setAttribute('viewBox', '0 0 32 32'); ring.setAttribute('class', 'extension-get-ring'); ring.setAttribute('aria-hidden', 'true');
      for (const cls of ['track', 'arc']) { const circle = doc.createElementNS(svg, 'circle'); for (const [key, value] of Object.entries({ cx: '16', cy: '16', r: '13', class: cls })) circle.setAttribute(key, value); ring.append(circle); }
      button.append(ring); button.disabled = true; return button;
    }
    button.append(icon(doc, update ? 'update' : 'download'));
    if (update) {
      button.disabled = !!update.problems.length; attachHint(button, label, update.problems.join('\n') || undefined);
      button.addEventListener('click', event => { event.stopPropagation(); void operate('install', { name: hit.name, version: update.latestVersion }, 'market', owner, anchor); }, { signal });
      return button;
    }
    attachHint(button, label);
    button.disabled = !!opts.blocked || !osSupported(hit.os ?? []);
    button.addEventListener('click', async event => {
      event.stopPropagation(); button.disabled = true;
      const warnings = (hit.tags ?? []).filter(id => marketIndex.tags[id]?.style === 'warning');
      if (warnings.length && !await ui.confirm({ title: S.installWarningTitle, body: S.installWarningBody(hit.name, warnings.map(id => `${marketIndex.tags[id].label}${S.labelSeparator}${plainHint(marketIndex.tags[id].hint)}`), hit.note), danger: true })) { button.disabled = false; return; }
      if (!signal.aborted) await operate('install', { name: hit.name, version: hit.version }, 'market', owner, anchor);
    }, { signal });
    return button;
  }
  /** A card's content height, which its placeholder stands in for while it skips rendering. */
  const contentHeight = (card: HTMLElement) => {
    const style = win.getComputedStyle(card), edge = (name: string) => parseFloat(style.getPropertyValue(name)) || 0;
    return Math.max(0, card.offsetHeight - edge('padding-top') - edge('padding-bottom') - edge('border-top-width') - edge('border-bottom-width'));
  };
  /** The end of the market's reveal while it runs (see ExtensionController.activate); renders meanwhile hold their cards until then. */
  let revealEnd: Promise<unknown> | undefined;
  /**
   * Renders the cards in the window now rather than a frame later, so this frame's layout, which a
   * reflow measures, is the one that will show. A rendered card's own height can bring the next one
   * into view. They go back to skipping by themselves once drawn, or once `until` settles.
   */
  function renderInView(until = revealEnd) {
    const bottom = scrollerOf(marketGrid)?.getBoundingClientRect().bottom ?? win.innerHeight, shown: HTMLElement[] = [];
    for (const card of marketGrid.querySelectorAll<HTMLElement>(':scope > .extension-market-card')) {
      const box = card.getBoundingClientRect();
      if (box.top >= bottom) break;
      if (box.bottom > 0) { card.classList.add('is-in-view'); shown.push(card); }
    }
    const release = () => { for (const card of shown) card.classList.remove('is-in-view'); };
    if (until) void until.then(release, release); else win.requestAnimationFrame(() => win.requestAnimationFrame(release));
  }
  /** The market's cards by package, for animating a re-render (see measureReflow): cards that go leave
   * sideways first, then the rest close up. */
  const measureCards = () => marketGrid?.isConnected ? measureReflow(marketGrid, ':scope > .extension-market-card', card => card.dataset.name) : undefined;
  function renderMarket(keepHeight = false) {
    const reflow = measureCards();
    if (!keepHeight) marketGrid.style.minHeight = '';
    const state = states[kind];
    paintCategories?.();
    const listed = (pool: SearchHitView[]) => pool.filter(hit => inCatalogCategory(hit.tags, state.catalogCategory)).map(h => ({ ...named(h), installed: installed.some(p => p.name === h.name && p.state !== 'removed') })).filter(h => state.installation !== 'installed' || h.installed);
    const hits = listed(catalogHits(state)), unexcluded = listed(catalogHits(state, true));
    // 注意事项 only exclude, so a selection carried over from before holds none of them.
    state.tags = state.tags.filter(id => marketIndex.tags[id] && !isExclusion(id) && !exclusions.includes(id));
    const terms = searchTerms(state.filter);
    const arrange: ArrangeOptions = { filter: state.filter, tagLabel, sort: state.sort, hideInstalled: state.installation === 'available', page: state.page, pageSize: pageSize(), tags: state.tags, officialOnly: state.officialOnly, certifiedOnly: state.certifiedOnly, newOnly: state.newOnly, ...advancedFilters(state) };
    const result = arrangeHits(hits, arrange); if (state.fetched) state.page = result.page;
    if (clearButton) clearButton.disabled = !filtersActive(state);
    if (licenseList) licenseList.replaceChildren(...[...new Set(hits.map(h => h.license).filter(Boolean))].sort().map(value => { const option = ui.h('option') as HTMLOptionElement; option.value = value!; return option; }));
    renderTagBar(hits, unexcluded);
    renderActive(state, exclusions.length ? arrangeHits(unexcluded, { ...arrange, page: 0, pageSize: 1 }).matched - result.matched : 0);
    const focused = doc.activeElement instanceof win.HTMLElement && marketGrid.contains(doc.activeElement) ? doc.activeElement : null;
    const focusName = focused?.closest<HTMLElement>('.extension-market-card')?.dataset.name;
    const focusAction = focused?.classList.contains('extension-get');
    // Cards skip rendering until scrolled to, sized by a placeholder meanwhile. A re-render builds new
    // cards, so each takes over the height its predecessor had: the list keeps its layout, above the
    // window too, instead of every card falling back to the placeholder's height.
    const heights = new Map([...marketGrid.querySelectorAll<HTMLElement>(':scope > .extension-market-card[data-name]')].map(card => [card.dataset.name!, contentHeight(card)]));
    marketGrid.replaceChildren(...result.shown.map(hit => {
      const card = ui.h('article', 'extension-card extension-market-card' + (hit.installed ? ' is-installed' : ''));
      const owner = kind; card.tabIndex = 0; card.setAttribute('role', 'button'); card.setAttribute('aria-label', hit.displayName ?? hit.name);
      card.addEventListener('click', event => { if (!(event.target as Element).closest('button, a')) openDetail(hit, owner); }, { signal });
      card.addEventListener('keydown', event => { if (event.target === card && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openDetail(hit, owner); } }, { signal });
      const heading = ui.h('div', 'extension-card-heading'); const local = installed.find(item => item.name === hit.name);
      const listed = state.hits.some(item => item.name === hit.name);
      const titleBlock = ui.h('div', 'extension-card-titleblock'), titleLine = ui.h('div', 'extension-card-titleline');
      const title = ui.h('span', 'extension-card-title');
      writeMarked(title, hit.displayName ?? local?.metadata?.displayName ?? local?.label ?? hit.name, terms);
      titleLine.append(title);
      const metaRow = ui.h('div', 'extension-card-metarow');
      // 署名用 author,悬停 npm 账号;没有 author 时写 `npm@账号`。
      // author 在包文档里,回来之前只写版本。发布者是 GitHub Actions 时改用维护者。
      const byline = ui.h('span', 'extension-card-byline'); let bylineHint = '';
      attachHint(byline, () => bylineHint);
      const sign = (maintainers: readonly string[] | undefined, author: string | undefined, known: boolean) => {
        const publisher = hit.publisher && hit.publisher !== 'GitHub Actions' ? hit.publisher : undefined;
        const account = hit.maintainers?.[0] ?? publisher ?? maintainers?.[0];
        const name = author ?? (account ? `npm@${account}` : S.authorMissing);
        const version = local?.builtin ? S.builtin : hit.version ? `v${hit.version}` : '';
        byline.textContent = [known ? name : '', version].filter(Boolean).join(S.metaSeparator);
        bylineHint = author && account ? `npm: @${account}` : '';
        if (bylineHint) byline.setAttribute('aria-description', bylineHint); else byline.removeAttribute('aria-description');
      };
      sign(undefined, hit.author, !!hit.author);
      metaRow.append(byline, ...badgesOf(hit));
      // 搜索结果没带 os 时等包文档
      const placeOs = (os?: readonly string[]) => { metaRow.querySelector('.extension-os')?.remove(); if (os?.length) metaRow.append(osBadge(os)); };
      placeOs(hit.os);
      titleLine.append(metaRow); titleBlock.append(titleLine);
      heading.append(packageAvatar(hit.icon ?? (local?.icon ? iconUrl(local.name, local.installedVersion ?? local.version) : undefined)), titleBlock);
      if (listed) void fetchDetail(hit.name, hit.version).then(data => {
        if (signal.aborted) return;
        if (data.displayName && !hit.displayName) writeMarked(title, data.displayName, terms);
        sign(data.maintainers, data.author, true);
        if (!hit.os) placeOs(data.os);
      }).catch(() => { /* Search results remain usable when package metadata is unavailable. */ });
      const description = ui.h('p', 'extension-description'); writeMarked(description, hit.description, terms);
      card.append(heading, description);
      const tags = orderedTags(hit.tags).sort((a, b) => Number(state.tags.includes(b)) - Number(state.tags.includes(a)));
      if (tags.length) {
        const row = ui.h('div', 'extension-tag-row'); row.append(...tags.map(cardTag)); card.append(row);
        card.addEventListener('pointerleave', () => { if (row.classList.contains('is-open')) foldTags(row); }, { signal });
      }
      const foot = ui.h('div', 'extension-card-foot');
      if (hit.rating) foot.append(votes(hit.name, hit.rating), commentCount(hit.name, hit.rating, () => openDetail(hit, owner, true)));
      if (kind !== 'world' && local && (local.state === 'pending-restart' || local.state === 'failed')) foot.append(ui.h('span', '', stateLabels[local.state]));
      if (listed) foot.append(downloadsStat(hit));
      if (hit.date) foot.append(dateStat(hit.date));
      card.append(foot);
      card.dataset.name = hit.name; card.append(getButton(hit, owner));
      const known = heights.get(hit.name); if (known) card.style.containIntrinsicHeight = `auto ${known}px`;
      return card;
    }));
    if (focusName) {
      const card = [...marketGrid.querySelectorAll<HTMLElement>('.extension-market-card')].find(card => card.dataset.name === focusName);
      const action = focusAction ? card?.querySelector<HTMLButtonElement>('.extension-get:not(:disabled)') : undefined;
      (action ?? card)?.focus({ preventScroll: true });
    }
    for (const row of marketGrid.querySelectorAll<HTMLElement>('.extension-card .extension-tag-row')) foldTags(row);
    renderInView();
    for (const [control, paint] of detailControls) if (control.isConnected) paint(); else detailControls.delete(control);
    if (!result.matched) marketGrid.append(emptyMarket(state));
    pager(marketPager, result.matched, result.page, pageSize(), page => { marketGrid.style.minHeight = `${marketGrid.getBoundingClientRect().height}px`; state.page = page; renderMarket(true); save(); });
    reflow?.play();
  }
  /**
   * The sidebar below the categories. 推荐 picks one of certified and official, with 新品 beside them on its own; 系列
   * select and must all be on a package; 注意事项 only exclude, the plain ones (本地模型 and the like) last. Counts
   * are what the category and installation leave; an excluded row counts what it hides.
   */
  function renderTagBar(hits: readonly SearchHitView[], unexcluded: readonly SearchHitView[]) {
    if (!tagBar) return;
    const state = states[kind], excluded = exclusions;
    const tally = (list: readonly SearchHitView[]) => { const counts = new Map<string, number>(); for (const hit of list) for (const id of hit.tags ?? []) if (marketIndex.tags[id]) counts.set(id, (counts.get(id) ?? 0) + 1); return counts; };
    const counts = tally(hits), present = tally(unexcluded);
    const ids = orderedTags([...present.keys()]);
    const style = (id: string) => marketIndex.tags[id].style;
    const badgeRow = (on: boolean, mark: Parameters<typeof icon>[1], label: string, hint: string, count: number, onClick: () => void, cls = '') => {
      const toggle = ui.h('button', 'extension-tag is-badge extension-badge-toggle' + cls + (on ? ' is-active' : '')) as HTMLButtonElement; toggle.type = 'button';
      toggle.append(icon(doc, mark), ui.h('span', '', label), helpMark(toggle, label, hint), ui.h('span', 'extension-tag-count', String(count)));
      toggle.setAttribute('aria-pressed', String(on));
      toggle.addEventListener('click', () => { onClick(); state.page = 0; renderMarket(); save(); }, { signal });
      return toggle;
    };
    const pick = (key: 'certifiedOnly' | 'officialOnly') => () => { const on = !state[key]; state.certifiedOnly = state.officialOnly = false; state[key] = on; };
    const certifiedCount = hits.filter(h => h.certified).length, officialCount = hits.filter(h => h.official).length, newCount = hits.filter(h => h.isNew).length;
    const recommended = [
      ...certifiedCount || state.certifiedOnly ? [badgeRow(state.certifiedOnly, 'shield-check', S.certified, S.certifiedHint, certifiedCount, pick('certifiedOnly'))] : [],
      ...officialCount || state.officialOnly ? [badgeRow(state.officialOnly, 'cortico', S.officialRelease, S.officialHint, officialCount, pick('officialOnly'))] : [],
      ...newCount || state.newOnly ? [badgeRow(state.newOnly, 'sparkles', S.newLabel, S.newHint(marketIndex.newDays ?? 14), newCount, () => { state.newOnly = !state.newOnly; }, ' is-new')] : [],
    ];
    const select = (id: string) => tagChip(id, { active: state.tags.includes(id), count: counts.get(id) ?? 0, onToggle: () => toggleTag(id), helpMark: true });
    // 注意事项: the row itself excludes; the eye at its end shows it.
    const exclude = (id: string) => {
      const off = excluded.includes(id), row = tagChip(id, { count: present.get(id) ?? 0, onToggle: () => toggleExclude(id), helpMark: true });
      row.classList.add('is-exclusion'); row.classList.toggle('is-excluded', off); row.setAttribute('aria-pressed', String(off));
      row.setAttribute('aria-label', (off ? S.stopExcluding : S.excludeTag)(tagLabel(id) ?? id));
      row.append(icon(doc, off ? 'eye-off' : 'eye', 'icon extension-tag-eye'));
      return row;
    };
    const cautions = orderedTags([...new Set([...present.keys(), ...exclusions])]).filter(isExclusion);
    const groups: Array<[string, HTMLElement[]]> = [
      [S.tagGroups.badges, recommended],
      [S.tagGroups.series, ids.filter(id => style(id) === 'official' && (counts.has(id) || state.tags.includes(id))).map(select)],
      [S.tagGroups.cautions, [...cautions.filter(id => style(id)), ...cautions.filter(id => !style(id))].map(exclude)],
    ];
    tagBar.replaceChildren(...groups.filter(([, items]) => items.length).flatMap(([label, items]) => {
      const row = ui.h('div', 'extension-tag-row'); row.append(...items);
      return [ui.h('span', 'extension-tagbar-label', label), row];
    }));
    warningControl?.classList.toggle('is-open', warningsHidden()); warningControl?.setAttribute('aria-pressed', String(warningsHidden()));
    tagBar.hidden = !tagBar.childElementCount;
  }
  /**
   * Above the cards: the first line names what is selected, the second what is excluded and how many packages
   * that hides here. Each item removes itself.
   */
  function renderActive(state: CategoryState, hidden: number) {
    if (!activeBar) return;
    const item = (label: string, onRemove: () => void, cls = '') => {
      const button = ui.h('button', 'extension-active-item' + cls) as HTMLButtonElement; button.type = 'button';
      button.append(ui.h('span', '', label), icon(doc, 'close')); button.setAttribute('aria-label', S.removeFilter(label));
      button.addEventListener('click', onRemove, { signal });
      return button;
    };
    // The installation switch and the advanced fields are drawn with the panel, so removing them redraws it.
    const drop = (change: () => void) => () => { change(); state.page = 0; save(); render(); };
    const chosen = [
      ...state.catalogCategory !== 'all' ? [item(S.catalogCategories[state.catalogCategory], drop(() => { state.catalogCategory = 'all'; }))] : [],
      ...state.installation !== 'all' ? [item(state.installation === 'installed' ? S.alreadyInstalled : S.notInstalled, drop(() => { state.installation = 'all'; }))] : [],
      ...state.certifiedOnly ? [item(S.certified, drop(() => { state.certifiedOnly = false; }))] : [],
      ...state.officialOnly ? [item(S.officialRelease, drop(() => { state.officialOnly = false; }))] : [],
      ...state.newOnly ? [item(S.newLabel, drop(() => { state.newOnly = false; }))] : [],
      ...state.tags.map(id => item(tagLabel(id) ?? id, drop(() => { state.tags = state.tags.filter(t => t !== id); }))),
      ...state.author.trim() ? [item(`${S.advancedAuthor}: ${state.author.trim()}`, drop(() => { state.author = ''; }))] : [],
      ...state.keyword.trim() ? [item(`${S.advancedKeyword}: ${state.keyword.trim()}`, drop(() => { state.keyword = ''; }))] : [],
      ...state.license.trim() ? [item(`${S.advancedLicense}: ${state.license.trim()}`, drop(() => { state.license = ''; }))] : [],
      ...state.sinceDays ? [item(S.sinceLabel(state.sinceDays), drop(() => { state.sinceDays = 0; }))] : [],
      ...state.minDownloads ? [item(`${S.advancedDownloads} ${ui.fmt.count(state.minDownloads)}`, drop(() => { state.minDownloads = 0; }))] : [],
    ];
    const excluded = exclusions.filter(id => marketIndex.tags[id]).map(id => {
      const el = item(tagLabel(id)!, () => toggleExclude(id), ' is-excluded'); const tone = marketIndex.tags[id].style; if (tone) el.classList.add('is-' + tone);
      return el;
    });
    const line = (label: string, items: HTMLElement[], note?: string) => {
      // Items that wrap line up under the first item, not under the label.
      const row = ui.h('div', 'extension-active-row'), list = ui.h('div', 'extension-active-items'); list.append(...items);
      if (note) list.append(ui.h('span', 'extension-active-note', note));
      row.append(ui.h('span', 'extension-active-label', label), list);
      return row;
    };
    activeBar.replaceChildren(
      ...chosen.length ? [line(S.activeChosen, chosen)] : [],
      ...excluded.length ? [line(S.activeExcluded, excluded, hidden ? S.hiddenByExclusions(hidden) : undefined)] : [],
    );
    activeBar.hidden = !activeBar.childElementCount;
  }
  function load(): Promise<boolean> { return refreshed(loadList()); }
  async function loadList(): Promise<boolean> {
    if (signal.aborted) return false;
    const generation = ++loadGeneration;
    try {
      const data = await get<{ dir: string; platform?: string; extensions: ExtensionView[] }>('/api/extensions', { signal });
      if (signal.aborted || generation !== loadGeneration) return !signal.aborted;
      installed = data.extensions; installedFetched = true; directory = data.dir; platform = data.platform ?? ''; renderRestart(); renderMarket(); restoreScroll(); workspace?.onChange(installed.filter(item => item.kind === kind || !item.kind)); return true;
    } catch (error) { if (!signal.aborted && generation === loadGeneration) { installedFetched = true; message(kind, 'management', S.listLoadFailed(errorText(error)), true); restoreScroll(); workspace?.onLoadError(); } return false; }
  }
  async function checkUpdates() {
    if (signal.aborted) return;
    const generation = ++updateGeneration;
    try { const data = await get<UpdateResultView>('/api/extensions/updates', { signal }); if (signal.aborted || generation !== updateGeneration) return; updates = new Map(data.updates.map(u => [u.name, u])); announceUpdates(); renderRestart(); renderMarket(); if (data.errors.length) message(kind, 'management', S.updateCheckFailed(data.errors.map(e => `${e.name}: ${e.error}`).join('; ')), true); }
    catch (error) { if (!signal.aborted && generation === updateGeneration) message(kind, 'management', S.updateCheckFailed(errorText(error)), true); }
  }
  function search(owner: Category) { return refreshed(searchMarket(owner)); }
  async function searchMarket(owner: Category) {
    const state = states[owner], generation = ++state.generation;
    message(owner, 'market', '');
    try {
      const data = await get<{ hits: SearchHitView[]; partial?: boolean; registry?: string; index?: MarketIndexView }>(`/api/extensions/search?kind=${owner}`, { signal });
      if (signal.aborted || state.generation !== generation) return;
      registry = data.registry ?? ''; marketIndex = data.index ?? { tags: {} }; state.hits = data.hits; state.fetched = true;
      message(owner, 'market', [data.partial ? S.partial : '', data.index?.error ? S.indexFailed(data.index.error) : ''].filter(Boolean).join('\n')); if (owner === kind) { renderRestart(); renderMarket(); restoreScroll(); }
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
    registryDraft = null; detailsCache.clear(); updates = new Map(); announceUpdates();
    for (const state of Object.values(states)) {
      state.hits = []; state.fetched = false; state.generation++; delete state.messages.market;
      if (state.messages.management?.bad) delete state.messages.management;
    }
    render();
    message(owner, 'registry', registrySetting.registry ? S.registrySaved(registrySetting.registry) : registrySetting.registryError ?? '', !registrySetting.registry);
    void checkUpdates(); void search(owner);
  }
  /**
   * Installation checks the package kind before writing; install and delete take effect after restart.
   * Catalog operations show progress on the action button and errors beside `anchor`.
   */
  async function operate(action: 'install' | 'delete', target: Target, area: string, owner: Category, anchor?: Anchor, onFeedback?: (note: { text: string; bad: boolean }) => void) {
    const identity = 'name' in target ? target.name : target.path; if (busy.has(identity)) return;
    const actionLabel = action === 'delete' ? S.deletedAction : installed.some(item => item.name === identity && item.state !== 'removed') ? S.updatedAction : S.installedAction;
    const quiet = !!anchor;
    const report = (text: string, bad = false) => { if (onFeedback) onFeedback({ text, bad }); else message(owner, area, text, bad); };
    let problem: string | undefined;
    busy.add(identity); renderRestart(); renderMarket(); if (!quiet) report(S.progress(actionLabel, identity));
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
      const activateHint = actionLabel === S.installedAction && resultKind === 'world' ? ' ' + S.worldActivateHint : '';
      if (!quiet) report(`${S.completed(actionLabel, name)}${version ? ' ' + S.version(version) : ''} ${S.restartNeeded}${activateHint}`);
      updateGeneration++; if (updates.delete(name)) announceUpdates();
      if (action === 'install' && actionLabel === S.installedAction) workspace?.onAdded(name, anchor?.()?.closest('.extension-market-card')?.querySelector('.extension-avatar')?.getBoundingClientRect());
      if (!await load()) report(S.completed(actionLabel, name) + ' ' + S.syncedFailed, true);
    } catch (error) { if (!signal.aborted) problem = errorText(error); }
    finally { busy.delete(identity); if (!signal.aborted) { renderRestart(); renderMarket(); } }
    if (problem === undefined || signal.aborted) return;
    const control = quiet ? anchor?.() : null;
    if (control?.isConnected) problems.show(control, problem); else report(problem, true);
  }
  async function remove(name: string, anchor: Anchor) {
    if (busy.has(name) || !await ui.confirm({ title: S.remove, body: S.removeBody, danger: true }) || signal.aborted) return;
    await operate('delete', { name }, 'management', kind, anchor);
  }
  /** The detail page's install control, repainted whenever the market's cards are. */
  const detailControls = new Map<HTMLElement, () => void>();
  function renderDetail(box: HTMLElement, data: PackageDetailView, owner: Category, hit?: SearchHitView, item?: ExtensionView) {
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
      const badgeList = listed ? badgesOf(listed) : [];
      if (badgeList.length) { const badges = ui.h('div', 'extension-detail-badges'); badges.append(...badgeList); heading.append(badges); }
      header.append(heading);
      // The control centres on the header; what goes under it (problems, removal, the version history)
      // hangs below it, outside the centring.
      const cta = ui.h('div', 'extension-detail-cta'), below = ui.h('div', 'extension-detail-cta-below');
      // The market card's control, repainted with the cards: install, its progress, an update, installed.
      if (!item?.builtin) {
        const isInstalled = () => installed.some(entry => entry.name === data.name && entry.state !== 'removed');
        const os = listed?.os ?? data.os, base = listed ?? { description: data.description ?? '', downloads: { month: 0 }, dependents: 0, links: {} };
        const blocked = !data.manifest || !!data.problems?.length || data.manifest.kind !== owner;
        const control = ui.h('div', 'extension-detail-control'), anchor: Anchor = () => control.querySelector('.extension-get');
        const paint = () => control.replaceChildren(installControl({ ...base, name: data.name, version: data.version, os, installed: isInstalled() }, owner, { anchor, blocked }));
        paint(); detailControls.set(control, paint); cta.append(control);
        if (!isInstalled()) {
          for (const text of data.problems ?? []) below.append(ui.h('p', 'extension-cta-problem', text));
          if (!osSupported(os)) below.append(ui.h('p', 'extension-cta-problem', S.osUnsupported(platformName(platform))));
        }
      }
      if (owner === 'bot' && local && local.state !== 'removed') below.append(ui.h('p', 'extension-create-help', S.createBody), ui.h('pre', '', 'pnpm start --new'));
      if (owner !== 'world' && local && local.state !== 'removed') {
        const erase = ui.button(S.remove, { variant: 'danger', onClick: async () => {
          erase.disabled = true;
          try {
            await remove(local.name, () => erase);
            if (!installed.some(item => item.name === local.name && item.state !== 'removed')) detailDrawer?.dispose();
          } finally { erase.disabled = !!local.builtin || busy.has(local.name); }
        } });
        erase.disabled = !!local.builtin || busy.has(local.name);
        if (local.builtin) erase.title = S.builtinNote;
        below.append(erase);
      }
      if (listed?.supersededBy) {
        const next = listed.supersededBy, target = states[owner].hits.find(entry => entry.name === next);
        const [before, after] = S.supersededBy.split('{}');
        const link = ui.h('a', 'extension-superseded-link', target?.displayName ?? next); link.href = '#';
        link.addEventListener('click', event => { event.preventDefault(); openDetail(target ?? { name: next, version: '', description: '', downloads: {}, dependents: 0, links: {}, installed: false }, owner); }, { signal });
        const line = ui.h('p', 'extension-cta-superseded'); line.append(before, link, after); below.append(line);
      }
      cta.append(below); header.append(cta);
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
      // The tag feedback link follows the last tag on its line.
      if (tags.length || indexed) {
        const row = ui.h('div', 'extension-tag-row'); row.append(...tags.map(id => tagChip(id)));
        if (indexed) { const report = ui.h('a', 'extension-tag-feedback', S.feedbackTags); report.href = tagIssueUrl(listed?.name ?? data.name); report.target = '_blank'; report.rel = 'noopener noreferrer'; row.append(report); }
        info.append(row);
      }
      if (listed?.screenshots?.length) {
        const shots = ui.h('div', 'extension-screenshots');
        for (const src of listed.screenshots) { const image = ui.h('img'); image.src = src; image.alt = ''; image.loading = 'lazy'; shots.append(image); }
        info.append(shots);
      }
      info.append(ui.h('h4', '', S.information));
      if (item?.reason) info.append(ui.msgline(item.reason, true));
      if (item?.webUi === 'missing') info.append(ui.msgline(S.noteWebUiMissing, true));
      for (const text of [...item ? data.problems ?? [] : [], ...data.warnings]) info.append(ui.msgline(text, true));
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
        releases.append(data.history.length ? history : ui.h('p', 'muted extension-history-empty', S.noHistory)); below.append(releases);
      }
      columns.classList.toggle('is-split', indexed); box.closest('.modalcard')?.classList.toggle('extension-detail-card', indexed);
      if (indexed) { const side = ui.h('aside', 'extension-detail-side'); side.append(commentsSection(listed?.name ?? data.name, listed?.rating)); columns.append(side); }
  }
  function detailFeedback(box: HTMLElement, note: { text: string; bad: boolean }) {
    const feedback = box.querySelector<HTMLElement>('.extension-operation-feedback');
    if (feedback) { feedback.textContent = note.text; feedback.classList.toggle('bad', note.bad); }
  }
  /** 历史版本走与市场安装相同的 check → install;结果同时写进抽屉。 */
  async function installRelease(box: HTMLElement, data: PackageDetailView, version: string, owner: Category, hit?: SearchHitView, item?: ExtensionView) {
    const current = installed.find(entry => entry.name === data.name && entry.state !== 'removed');
    if (busy.has(data.name) || !await ui.confirm({ title: S.versionConfirmTitle, body: S.versionConfirmBody(data.name, current?.installedVersion ?? current?.version ?? null, version), danger: true })) return;
    if (signal.aborted || busy.has(data.name)) return;
    let result: { text: string; bad: boolean } | undefined;
    const done = operate('install', { name: data.name, version }, 'management', owner, undefined, note => { result = note; detailFeedback(box, note); });
    box.querySelectorAll<HTMLButtonElement>('.extension-version-action').forEach(button => { button.disabled = true; });
    await done;
    await checkUpdates();
    if (signal.aborted || !box.isConnected) return;
    renderDetail(box, data, owner, hit, item && installed.find(entry => entry.name === data.name && entry.state !== 'removed'));
    if (result) detailFeedback(box, result);
  }
  /** `toComments`:打开后滚到评论区(从卡片上的评论数点进来)。 */
  function openDetail(hit: SearchHitView, owner: Category, toComments = false) {
    const item = installed.find(item => item.name === hit.name && item.state !== 'removed');
    if (kind !== 'world' && item && !toComments) { showLocal(item); return; }
    const box = ui.h('div', 'extension-detail'); box.append(ui.placeholder(S.loadingDetail));
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
      showRestarting(true);
      if (!supervised) message(kind, 'management', S.restartManual);
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
    } catch (error) { if (!signal.aborted) { win.sessionStorage.removeItem(storageKey + ':restart'); showRestarting(false); message(kind, 'management', errorText(error), true); } }
  }
  /** Disables the restart control while the process is restarting. */
  function showRestarting(on: boolean) {
    restartRoot.classList.toggle('is-restarting', on);
    renderRestart();
  }
  function watchRestart(before: Life) {
    const check = async () => {
      if (signal.aborted) return;
      try {
        const next = await get<Life>('/api/run/lifecycle', { signal });
        if (restartOutcome(before, next) === 'wrong-deployment') { win.sessionStorage.removeItem(storageKey + ':restart'); showRestarting(false); message(kind, 'management', S.otherBot, true); return; }
        if (restartOutcome(before, next) === 'ready') { win.sessionStorage.removeItem(storageKey + ':restart'); save(); workspace?.beforeReload(); win.location.reload(); return; }
      } catch { /* Wait while the listener is unavailable. */ }
      lifecycle.timeout(() => void check(), 1000);
    }; void check();
  }
  /** The extension catalog's manual install fold, kept open across re-renders. */
  let manualOpen = false;
  function render() {
    const state = states[kind];
    const keptScroll = scrollRoot.scrollTop;
    // The panel is rebuilt with a new grid; its cards still move from where the old ones were.
    const reflow = measureCards();
    manualOpen = panel.querySelector<HTMLDetailsElement>('.world-manual')?.open ?? manualOpen;
    panel.replaceChildren(); messageNodes = {};
    const restartButton = canRestart ? ui.button(S.restartProcess, { onClick: () => void restart() }) : undefined;
    restartButton?.classList.add('extension-restart');
    messageNodes.management = ui.msgline(); messageNodes.management.setAttribute('role', 'status');
    messageNodes.market = ui.msgline(); messageNodes.market.setAttribute('role', 'status');
    const filters = ui.rowbar(); filters.classList.add('extension-toolbar');
    const clear = clearButton = ui.button('', { onClick: () => clearFilters() }); clear.classList.add('extension-clear'); clear.append(icon(doc, 'close'), ui.h('span', '', S.clearFilters));
    filters.append(ui.input({ type: 'search', value: state.filter, placeholder: S.filterPlaceholder, onInput: value => { state.filter = value; state.page = 0; renderMarket(); save(); } }), ui.select({ value: state.sort, options: HIT_SORTS.map(value => ({ value, label: S.sortLabel[value] })), onChange: value => { state.sort = value as HitSort; state.page = 0; renderMarket(); save(); } }), sizePicker(), clear, ui.button(S.refresh, { onClick: () => { void replayCards(Promise.all([load(), search(kind)])); void checkUpdates(); } }));
    const advancedToggle = ui.h('button', 'extension-advanced-toggle' + (state.advanced ? ' is-open' : ''), S.advancedSearch) as HTMLButtonElement; advancedToggle.type = 'button';
    advancedToggle.setAttribute('aria-expanded', String(state.advanced)); advancedToggle.setAttribute('aria-controls', 'extension-advanced');
    advancedToggle.addEventListener('click', () => {
      state.advanced = !state.advanced; save();
      advancedToggle.classList.toggle('is-open', state.advanced); advancedToggle.setAttribute('aria-expanded', String(state.advanced)); fold(advanced, state.advanced);
    }, { signal });
    const registryToggle = ui.h('button', 'extension-advanced-toggle extension-registry-toggle' + (registryOpen ? ' is-open' : ''), S.registryLabel) as HTMLButtonElement; registryToggle.type = 'button';
    registryToggle.setAttribute('aria-expanded', String(registryOpen)); registryToggle.setAttribute('aria-controls', 'extension-registry');
    registryToggle.addEventListener('click', () => { registryOpen = !registryOpen; fold(registryPanel, registryOpen); registryToggle.classList.toggle('is-open', registryOpen); registryToggle.setAttribute('aria-expanded', String(registryOpen)); }, { signal });
    const advanced = ui.h('div', 'extension-advanced'); advanced.id = 'extension-advanced'; advanced.hidden = !state.advanced;
    const field = (label: string, control: HTMLElement) => { const el = ui.h('label', 'extension-advanced-field'); el.append(ui.h('span', '', label), control); return el; };
    const text = (key: 'author' | 'keyword' | 'license', placeholder: string) => ui.input({ value: state[key], placeholder, onInput: value => { state[key] = value; state.page = 0; renderMarket(); save(); } });
    const license = text('license', 'MIT'); license.setAttribute('list', 'extension-licenses');
    licenseList = ui.h('datalist'); licenseList.id = 'extension-licenses';
    const since = ui.select({ value: String(state.sinceDays), options: [0, 7, 30, 90, 365].map(days => ({ value: String(days), label: S.sinceLabel(days) })), onChange: value => { state.sinceDays = Number(value); state.page = 0; renderMarket(); save(); } });
    const minimum = ui.input({ type: 'number', value: state.minDownloads ? String(state.minDownloads) : '', placeholder: '0', onInput: value => { state.minDownloads = Math.max(0, Number(value) || 0); state.page = 0; renderMarket(); save(); } }); minimum.min = '0';
    advanced.append(field(S.advancedAuthor, text('author', 'Pal AI Lab')), field(S.advancedKeyword, text('keyword', 'tts')), field(S.advancedLicense, license), field(S.advancedSince, since), field(S.advancedDownloads, minimum), licenseList);
    const registryBar = ui.rowbar(); registryBar.classList.add('extension-toolbar');
    const registryField = registryInput = ui.input({ value: registryDraft ?? registrySetting?.configured ?? '', placeholder: registrySetting?.registry ?? '', onInput: value => { registryDraft = value; } });
    registryField.setAttribute('aria-label', S.registryLabel);
    const saveRegistryButton = ui.button(S.registrySave, { onClick: async () => { const lock = ui.disable(saveRegistryButton); try { await saveRegistry(registryField.value); } finally { lock.dispose(); } } });
    registryBar.append(registryField, saveRegistryButton);
    messageNodes.registry = ui.msgline(S.registryHelp); messageNodes.registry.setAttribute('role', 'status');
    const registryPanel = ui.h('div', 'extension-registry'); registryPanel.id = 'extension-registry'; registryPanel.hidden = !registryOpen;
    registryPanel.append(registryBar, messageNodes.registry);
    tagBar = ui.h('div', 'extension-tagbar'); tagBar.hidden = true;
    activeBar = ui.h('div', 'extension-active-filters'); activeBar.hidden = true;
    marketGrid = ui.h('div', 'extension-grid'); marketPager = ui.rowbar();
    const manual = ui.sheet({ title: S.manual }); messageNodes.manual = ui.msgline(); messageNodes.manual.setAttribute('role', 'status');
    let inputRevision = 0;
    const source = ui.segmented([{ value: 'npm', label: S.npm }, { value: 'local', label: S.local }], { value: state.source, onSelect: value => { inputRevision++; state.source = value as 'npm' | 'local'; state.input = input.value = ''; syncSource(); save(); } });
    const manualBar = ui.rowbar(); const input = ui.input({ value: state.input, onInput: value => { inputRevision++; state.input = value; } });
    const folder = ui.button(S.folder, { onClick: async () => { try { const path = await pickPath({ kind: 'directory', currentPath: input.value }, { signal }); if (path) { inputRevision++; state.input = input.value = path; } } catch (error) { message(kind, 'manual', errorText(error), true); } } });
    folder.classList.add('extension-manual-folder');
    manualBar.append(input, folder);
    const target = (): Target => { if (state.source === 'local' && state.input.trim()) return { path: state.input.trim() }; const value = parseInstallInput(state.input); if (!value) throw new Error(S.invalidInput); return value; };
    const owner = kind;
    const check = ui.button(S.check, { onClick: async () => { const revision = inputRevision, lock = ui.disable(check); try { const data = await post<{ name: string; version: string; kind: string }>('/api/extensions/check', { target: target(), kind: owner }, { signal }); if (revision === inputRevision && !signal.aborted) message(owner, 'manual', `${S.checkOk} · ${data.name}@${data.version} · ${data.kind}`); } catch (error) { if (revision === inputRevision && !signal.aborted) message(owner, 'manual', errorText(error), true); } finally { lock.dispose(); } } });
    const install = ui.button(S.install, { variant: 'primary', onClick: () => { try { void operate('install', target(), 'manual', owner); } catch (error) { message(owner, 'manual', errorText(error), true); } } });
    const manualActions = ui.rowbar(); manualActions.classList.add('extension-manual-actions'); manualActions.append(check, install, messageNodes.manual);
    const installHelp = ui.h('div', 'sh-desc extension-install-help');
    const help = { npm: ui.h('span', '', S.npmHelp), local: ui.h('span', '', S.localHelp) };
    installHelp.append(help.npm, help.local);
    // Both explanations keep their layout space, including when translated text wraps.
    function syncSource() {
      const local = state.source === 'local';
      input.placeholder = local ? '' : `@scope/cortico-${kind}-demo@1.2.3`;
      input.setAttribute('aria-label', local ? S.pathLabel : S.packageLabel);
      folder.setAttribute('aria-hidden', String(!local)); folder.disabled = !local;
      for (const [key, text] of Object.entries(help)) text.setAttribute('aria-hidden', String(key !== state.source));
    }
    syncSource();
    const row = ui.h('div', 'world-manual-source'); row.append(source.el, installHelp); manual.body.append(row, manualBar, manualActions);
    {
      messageNodes.management.textContent = '';
      restartRoot.replaceChildren(...(restartButton ? [restartButton] : []));
      if (workspace) workspace.statusRoot.replaceChildren(messageNodes.management);
      else panel.append(messageNodes.management, restartRoot);
      const body = ui.h('div', 'world-catalog-body');
      const side = ui.h('aside', 'world-catalog-filters'); side.id = `${kind}-catalog-filters`;
      const toggle = ui.button(S.filterSidebar, { size: 'sm', onClick: () => {
        const open = side.hidden;
        if (narrowFilters?.matches) narrowFiltersOpen = open; else state.filtersFolded = !open;
        fold(side, open, { axis: narrowFilters?.matches ? 'y' : 'x' }); toggle.setAttribute('aria-expanded', String(open)); save();
      } });
      syncFilterLayout = () => {
        side.hidden = narrowFilters?.matches ? !narrowFiltersOpen : state.filtersFolded;
        toggle.setAttribute('aria-expanded', String(!side.hidden));
      };
      syncFilterLayout(); toggle.setAttribute('aria-controls', side.id);
      filters.insertBefore(toggle, clear);
      const categoryList = ui.h('div', 'world-catalog-categories');
      const categoryButtons = CATALOG_CATEGORY_IDS.map(value => {
        const button = ui.button(S.catalogCategories[value], { onClick: () => selectCategory(value) });
        button.dataset.category = value; button.append(ui.h('span', 'extension-tag-count')); categoryList.append(button);
        return button;
      });
      paintCategories = () => {
        for (const button of categoryButtons) {
          const value = button.dataset.category as CatalogCategory, count = catalogHits(state).filter(hit => inCatalogCategory(hit.tags, value)).length;
          button.setAttribute('aria-pressed', String(state.catalogCategory === value));
          button.querySelector('.extension-tag-count')!.textContent = state.fetched ? String(count) : '';
          button.hidden = state.fetched && !count && value !== 'all' && state.catalogCategory !== value;
        }
      };
      for (const [button, mark, label] of [[advancedToggle, 'sliders', S.advancedSearch], [registryToggle, 'globe', S.registryLabel]] as const) {
        button.classList.add('world-catalog-toggle'); button.replaceChildren(icon(doc, mark));
        button.setAttribute('aria-label', label); attachHint(button, label);
        filters.insertBefore(button, clear);
      }
      // The toolbar's secondary actions are icons with name tags, so the row fits beside the search field.
      const refresh = filters.lastElementChild as HTMLButtonElement;
      for (const [button, mark, label] of [[toggle, 'sidebar', S.filterSidebar], [clear, 'close', S.clearFilters], [refresh, 'refresh', S.refresh.replace(/^↻\s*/, '')]] as const) {
        button.className = 'world-catalog-toggle'; button.replaceChildren(icon(doc, mark));
        button.setAttribute('aria-label', label); attachHint(button, label);
      }
      clear.classList.add('extension-clear');
      refreshControl = refresh; refresh.classList.toggle('is-spinning', refreshing > 0);
      const warnings = warningControl = ui.h('button', 'world-catalog-toggle') as HTMLButtonElement; warnings.type = 'button';
      warnings.append(icon(doc, 'warning')); warnings.setAttribute('aria-label', S.hideWarnings); attachHint(warnings, S.hideWarnings);
      warnings.addEventListener('click', toggleWarnings, { signal });
      filters.insertBefore(warnings, refresh);
      const installation = ui.segmented([{ value: 'all', label: S.catalogCategories.all }, { value: 'installed', label: S.alreadyInstalled }, { value: 'available', label: S.notInstalled }], {
        value: state.installation, onSelect: value => { state.installation = value as CategoryState['installation']; state.page = 0; renderMarket(); save(); },
      });
      installation.el.classList.add('world-catalog-installation');
      side.append(installation.el, ui.h('h3', '', S.catalogCategory), categoryList, tagBar);
      const manualFold = ui.h('details', 'world-manual') as HTMLDetailsElement; manualFold.append(ui.h('summary', '', S.manual), manual.body);
      manualFold.open = manualOpen;
      scrollRoot.replaceChildren(activeBar, marketGrid, marketPager, manualFold);
      body.append(side, scrollRoot);
      panel.append(filters, advanced, registryPanel, messageNodes.market, body);
    }
    for (const [area, value] of Object.entries(state.messages)) if (messageNodes[area]) { messageNodes[area].textContent = value.text; messageNodes[area].className = 'msgline' + (value.bad ? ' bad' : ''); }
    renderRestart(); renderMarket();
    scrollRoot.scrollTop = keptScroll;
    reflow?.play(marketGrid);
  }
  // 只看宽度变化
  let panelWidth = panel.clientWidth;
  if (typeof win.ResizeObserver === 'function') { const observer = new win.ResizeObserver(() => {
    if (!panel.clientWidth || panel.clientWidth === panelWidth) return;
    panelWidth = panel.clientWidth;
    for (const row of marketGrid.querySelectorAll<HTMLElement>('.extension-card .extension-tag-row')) if (!row.classList.contains('is-open')) foldTags(row);
  }); observer.observe(panel); lifecycle.add(() => observer.disconnect()); }
  render();
  void load(); void checkUpdates(); void search(kind); void loadRegistry();
  try { const marker = win.sessionStorage.getItem(storageKey + ':restart'); if (marker) { showRestarting(true); if (!workspace) message(kind, 'management', S.reloadWait); watchRestart(JSON.parse(marker)); } } catch { /* Invalid recovery marker. */ }
  const activate = (until?: Promise<unknown>) => {
    const own = revealEnd = until;
    const over = () => { if (revealEnd === own) revealEnd = undefined; };
    if (own) void own.then(over, over);
    restoreScroll(); renderInView(until);
  };
  return { details, remove, activate };
}
