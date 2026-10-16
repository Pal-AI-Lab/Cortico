/**
 * 扩展市场的官方索引与讨论区,数据都在索引仓 Pal-AI-Lab/cortico-extensions,文件格式以那里的 DESIGN.md 为准。
 * 索引文件按 `fetchIndexFile` 的顺序读取。投票与评论用 GitHub App「Cortico Extension Market」的用户令牌
 * 调 GraphQL;令牌由设备码登录取得,存在扩展目录的 github-token.json,App 设置里关了令牌过期。
 * 没登录时评论读 Action 写进索引仓的 `comments/` 快照:App 私钥不随 Cortico 分发,匿名读不了 Discussions。
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { baseLanguage, LocalizedError, type Language } from '../core/language.ts';
import type { Logger, ToolTag } from '../core/types.ts';
import { fetchFailure, PACKAGE_NAME } from '../extensions.ts';
import type { ProviderAuth, ProviderDescribe } from '../providers/base.ts';
import type {
  ExtensionComment,
  ExtensionCommentPage,
  ExtensionDescribe,
  ExtensionPackageDetail,
  ExtensionRating,
  ExtensionSearchHit,
  ExtensionSummary,
  GithubAccount,
  GithubDeviceCode,
  MarketIndex,
  MarketIndexBase,
  MarketTag,
} from '../web/server.ts';
import { text } from './strings.ts';

const REPO_OWNER = 'Pal-AI-Lab';
const REPO_NAME = 'cortico-extensions';
/** 索引仓 main 上文件的 raw 地址前缀;没配索引源时读索引先问它,图标与截图也用它。 */
const RAW_BASE = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main`;
const CONTENTS_API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents`;
/** 每个包一帖的讨论区分类;Announcement 格式,只有维护者(Action)能开帖。 */
const DISCUSSION_CATEGORY = 'extensions';
const GITHUB_APP_CLIENT_ID = 'Iv23lidZhJ2BMvVFLsl0';
export const GITHUB_TOKEN_FILE = 'github-token.json';
/** 最近一次读到的 `index.json`;读不到时照它拦拉黑的包、合进搜索结果。 */
const INDEX_CACHE_FILE = 'market-index.json';
/** 最近一次读到的 `catalog.json`;读不到时用它。 */
const CATALOG_CACHE_FILE = 'market-catalog.json';
/** 扩展页配的索引源:`{ "indexBase": "<地址>" }`。 */
const SETTINGS_FILE = 'market.json';
/** 本机认得的索引文件格式版本。 */
const SCHEMA = 1;
/** raw.githubusercontent.com 的 CDN 缓存是 5 分钟,更勤地取拿到的也是同一份。 */
const RAW_CACHE_MS = 5 * 60_000;
/**
 * 搜索列表要等索引回来才出,每一处来源各有超时,连不上的机器不卡到系统的连接超时。第一处与 npm 下载统计同一个值
 * (`src/extensions.ts` 的 DOWNLOADS_TIMEOUT_MS);contents API 是最后一处,多给 2 秒,两处都超时时搜索等 8 秒。
 */
const RAW_TIMEOUT_MS = 3000;
const API_TIMEOUT_MS = 5000;
/** WebUI 评论区一次显示 5 条。 */
const COMMENTS_PAGE_SIZE = 5;
/** GitHub GraphQL 一页最多 100 条:每条评论的回复只取前 100 条,评分的评论数只数前 100 条评论下的回复。 */
const GRAPHQL_PAGE_MAX = 100;

type Bilingual = { zh: string; en: string };

/** `index.json`:官方维护的词表、官方账号、认证、拉黑与覆盖。 */
interface IndexFile {
  schema: number;
  official: { maintainers: string[]; githubOwners: string[] };
  tags: Record<string, { style?: MarketTag['style']; label: Bilingual; hint: Bilingual }>;
  certified?: string[];
  newDays?: number;
  blocked?: { packages?: Record<string, Bilingual>; publishers?: Record<string, Bilingual> };
  overrides?: Record<string, { addTags?: string[]; removeTags?: string[]; note?: Bilingual; supersededBy?: string }>;
}

type Locale = { displayName?: string; description?: string };

/** `catalog.json`:Action 扫 npm 与讨论区生成,字段对应包的当前版本。这里只读下面几个字段。 */
interface CatalogFile {
  schema: number;
  packages: Record<string, {
    version: string;
    displayName?: string;
    locales?: { zh?: Locale; en?: Locale };
    author?: string;
    maintainers?: string[];
    os?: string[];
    /** 首次发布时间 */
    created?: string;
    /** 当前版本 `cortico.tags` 里词表内的标签 */
    declaredTags?: string[];
    /** 索引仓里的相对路径 */
    icon?: string;
    screenshots?: string[];
    summary?: ExtensionSummary;
    changelog?: { versions: string[]; url?: string };
    discussion?: { number: number; url: string; up: number; down: number; comments: number };
  }>;
  /** 粘住名单:任一版本声明过的警示标签 */
  sticky?: Record<string, string[]>;
}

/** `packages/<包>.json`:Action 从包的 `version` 版里解出的自描述文件原文与按版本切好的更新日志。 */
interface PackageFile {
  schema: number;
  version: string;
  describe?: unknown;
  changelog?: Record<string, string>;
}

/** `comments/<包>.json`:一个包讨论帖的评论快照,新的在前,回复旧的在前;`id` 是 GraphQL 节点 id。 */
interface CommentsSnapshot {
  schema: number;
  discussion: number;
  comments: ExtensionComment[];
}

interface TokenFile { token: string; login: string; avatar?: string }

interface GraphqlComment {
  id: string;
  body: string;
  createdAt: string;
  isMinimized: boolean;
  author: { login: string; avatarUrl?: string } | null;
}

const COMMENT_FIELDS = 'id body createdAt isMinimized author { login avatarUrl }';
const RATING_FIELDS = `url reactionGroups { content viewerHasReacted reactors { totalCount } }
  comments(first: ${GRAPHQL_PAGE_MAX}) { totalCount nodes { replies { totalCount } } }`;
const REACTIONS = { up: 'THUMBS_UP', down: 'THUMBS_DOWN' } as const;

interface GraphqlRating {
  url: string;
  reactionGroups: Array<{ content: string; viewerHasReacted: boolean; reactors: { totalCount: number } }>;
  comments: { totalCount: number; nodes: Array<{ replies: { totalCount: number } }> };
}

function marketError(message: (t: ReturnType<typeof text>) => string, status: number): LocalizedError {
  return new LocalizedError((language) => message(text(language)), status);
}

const pickText = (value: Bilingual, language: Language) => baseLanguage(language) === 'zh' ? value.zh : value.en;
/** 作者写的文字(`locales`、自描述)只有 zh 与 en 两份:zh 读 zh,zh-Hant 与其余语言读 en。 */
const authorLanguage = (language: Language): 'zh' | 'en' => language === 'zh' ? 'zh' : 'en';
const discussionUrl = (num: number) => `https://github.com/${REPO_OWNER}/${REPO_NAME}/discussions/${num}`;
/** 包名当文件名,作用域包的 `/` 换成 `__`。 */
const fileName = (name: string) => name.replace('/', '__');
const toComment = (node: GraphqlComment): ExtensionComment => ({
  id: node.id,
  // 删了号的用户在 GitHub 上显示为 ghost
  author: node.author?.login ?? 'ghost',
  ...(node.author?.avatarUrl ? { avatar: node.author.avatarUrl } : {}),
  body: node.body,
  createdAt: node.createdAt,
});

type Item = Record<string, unknown>;
const isItem = (value: unknown): value is Item => !!value && typeof value === 'object' && !Array.isArray(value);
const items = (value: unknown): Item[] => Array.isArray(value) ? value.filter(isItem) : [];
const strings = <T extends string = string>(value: unknown): T[] => Array.isArray(value) ? value.filter((v): v is T => typeof v === 'string') : [];

/**
 * 包里的自描述文件按请求语言取成 `ExtensionDescribe`。文件是作者写的、索引仓原样转存,
 * 缺字段或类型不对的工具、事件、提示词丢掉,整份不是对象时是 undefined。
 */
function localizeDescribe(raw: unknown, language: Language): ExtensionDescribe | undefined {
  if (!isItem(raw)) return undefined;
  const say = (value: unknown): string | undefined => typeof value === 'string' ? value
    : isItem(value) && typeof value.zh === 'string' && typeof value.en === 'string' ? (value as Bilingual)[authorLanguage(language)] : undefined;
  const out: ExtensionDescribe = {};
  const tools = items(raw.tools).flatMap((t) => {
    const summary = say(t.summary);
    return typeof t.name === 'string' && typeof t.description === 'string'
      ? [{ name: t.name, description: t.description, tags: strings<ToolTag>(t.tags), ...(summary ? { summary } : {}) }] : [];
  });
  if (tools.length) out.tools = tools;
  const events = items(raw.events).flatMap((e) => {
    const description = say(e.description);
    return typeof e.type === 'string' && description !== undefined ? [{ type: e.type, description }] : [];
  });
  if (events.length) out.events = events;
  if (isItem(raw.provider)) {
    const p = raw.provider;
    out.provider = { protocols: strings(p.protocols), auth: strings<ProviderAuth>(p.auth), local: p.local === true, input: strings<ProviderDescribe['input'][number]>(p.input) };
  }
  if (isItem(raw.bot)) {
    const memory = raw.bot.memory, form = isItem(memory) ? say(memory.form) : undefined;
    out.bot = { worlds: strings(raw.bot.worlds), ...(isItem(memory) && typeof memory.name === 'string' ? { memory: { name: memory.name, form: form ?? '' } } : {}) };
  }
  const prompts = items(raw.prompts).flatMap((p) => {
    const role = p.role === 'envPrompt' || p.role === 'prefix' ? p.role as 'envPrompt' | 'prefix' : undefined;
    return typeof p.key === 'string' && typeof p.title === 'string' && typeof p.content === 'string'
      ? [{ key: p.key, title: p.title, content: p.content, ...(role ? { role } : {}) }] : [];
  });
  if (prompts.length) out.prompts = prompts;
  return out;
}

export interface IndexFileOptions {
  /** 换掉 raw.githubusercontent.com 的索引源,目录结构与它相同;缺省用 raw */
  base?: string;
  /** GitHub 令牌;contents API 带上它每小时 5000 次,不带时每个 IP 60 次 */
  token?: string;
  fetch?: typeof fetch;
}

/**
 * 读索引仓 main 上的一个 JSON 文件。先问 `base`(raw 的 CDN 不限次数);连不上、超时、回非 2xx 或正文不是 JSON 时
 * 改问 GitHub contents API。404 是文件不存在,回 null,不再往下问。两处都失败时抛错,依次写出每一处的主机与原因。
 */
export async function fetchIndexFile(path: string, opts: IndexFileOptions = {}): Promise<unknown> {
  const fetchImpl = opts.fetch ?? fetch;
  const sources = [
    { url: `${opts.base ?? RAW_BASE}/${path}`, headers: {}, timeoutMs: RAW_TIMEOUT_MS },
    {
      url: `${CONTENTS_API}/${path}?ref=main`,
      headers: { Accept: 'application/vnd.github.raw', 'User-Agent': 'Cortico', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
      timeoutMs: API_TIMEOUT_MS,
    },
  ];
  const failures: string[] = [];
  for (const { url, headers, timeoutMs } of sources) {
    let res: Response;
    try { res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) }); } catch (err) { failures.push(fetchFailure(url, err)); continue; }
    if (res.status === 404) return null;
    if (!res.ok) {
      // 额度用完时 GitHub 回 403 或 429,剩余次数在这个头里
      const limited = res.headers.get('x-ratelimit-remaining') === '0' ? ' (x-ratelimit-remaining: 0)' : '';
      failures.push(`${new URL(url).host}: ${res.status} ${res.statusText}${limited}`);
      continue;
    }
    try { return await res.json(); } catch (err) { failures.push(fetchFailure(url, err)); }
  }
  throw new Error(failures.join('; '));
}

export interface ExtensionMarketOptions {
  /** 扩展目录:令牌文件与索引缓存放在这里 */
  dir: string;
  log: Logger;
  fetch?: typeof fetch;
}

/** 官方索引、GitHub 登录、投票与评论;WebUI 的扩展页经它读写索引仓。 */
export class ExtensionMarket {
  private readonly dir: string;
  private readonly log: Logger;
  private readonly fetch: typeof fetch;
  private readonly raws = new Map<string, { atMs: number; value: unknown }>();
  /** 最近一次读到的合格 `index.json`,来自网络或缓存文件 */
  private index: IndexFile | null = null;
  /** 最近一次读到的合格 `catalog.json`,来自网络或缓存文件 */
  private catalog: CatalogFile | null = null;
  /** 帖子标题(包名) → 节点 id 与网址 */
  private discussions: Map<string, { id: string; url: string }> | null = null;
  /** 每次登录或退出加一;后台等待授权的循环发现它变了就停下 */
  private loginRun = 0;

  constructor(opts: ExtensionMarketOptions) {
    this.dir = opts.dir;
    this.log = opts.log;
    this.fetch = opts.fetch ?? fetch;
  }

  /**
   * 把官方索引合进搜索结果:滤掉拉黑的包与发布者,补上标签、徽标、官方说明、取代、评分与 `catalog.json` 的列表字段。
   * 显示名与简介按 `authorLanguage` 取 `locales`,没有时用顶层的。
   * 索引在等搜索的同时读取;这次读不到时用上次读到的,`index.stale` 是这次的原因;从没读到过时结果原样返回,
   * `index` 只有空词表与原因。
   */
  async merge(search: Promise<ExtensionSearchHit[]>, language: Language): Promise<{ hits: ExtensionSearchHit[]; index: MarketIndex }> {
    const describe = (err: unknown) => err instanceof LocalizedError ? err.describe(language) : err instanceof Error ? err.message : String(err);
    const loaded = Promise.all([this.loadIndex().catch((err: unknown) => describe(err)), this.loadCatalog()]);
    const hits = await search;
    const [indexRead, catalogRead] = await loaded;
    if (typeof indexRead === 'string') return { hits, index: { tags: {}, error: indexRead } };
    const { index } = indexRead, { catalog } = catalogRead;
    const stale = [indexRead.stale, catalogRead.stale].filter((err) => err !== undefined).map(describe).join('; ');
    const base = this.indexBase().base;
    const vocab = index.tags;
    const now = Date.now();
    const merged = hits.filter((hit) => !this.blockedEntry(index, hit.name, hit.publisher)).map((hit): ExtensionSearchHit => {
      const override = index.overrides?.[hit.name];
      const listed = catalog?.packages[hit.name];
      // 作者能声明官方标注以外的标签;keywords 只映射普通标签;粘住名单只收警示标签;官方的去优先
      const tags = [...new Set([
        ...(listed?.declaredTags ?? []).filter((id) => vocab[id] && vocab[id].style !== 'official'),
        ...(hit.keywords ?? []).filter((id) => vocab[id] && !vocab[id].style),
        ...(catalog?.sticky?.[hit.name] ?? []).filter((id) => vocab[id]?.style === 'warning'),
        ...(override?.addTags ?? []).filter((id) => vocab[id]),
      ])].filter((id) => !override?.removeTags?.includes(id));
      const maintainers = hit.maintainers ?? listed?.maintainers;
      const repository = hit.links.repository?.toLowerCase() ?? '';
      const official = !!maintainers?.some((m) => index.official.maintainers.includes(m))
        && index.official.githubOwners.some((owner) => repository.startsWith(`https://github.com/${owner.toLowerCase()}/`));
      const isNew = !!listed?.created && now - Date.parse(listed.created) < (index.newDays ?? 0) * 86_400_000;
      const locale = listed?.locales?.[authorLanguage(language)];
      const displayName = locale?.displayName ?? listed?.displayName;
      const discussion = listed?.discussion;
      return {
        ...hit,
        ...(locale?.description ? { description: locale.description } : {}),
        ...(displayName ? { displayName } : {}),
        ...(listed?.author ? { author: listed.author } : {}),
        ...(maintainers ? { maintainers } : {}),
        ...(listed?.os ? { os: listed.os } : {}),
        ...(listed?.icon ? { icon: `${base}/${listed.icon}` } : {}),
        ...(listed?.screenshots ? { screenshots: listed.screenshots.map((path) => `${base}/${path}`) } : {}),
        ...(listed?.summary ? { summary: listed.summary } : {}),
        ...(listed?.changelog ? { changelog: listed.changelog } : {}),
        ...(tags.length ? { tags } : {}),
        ...(override?.note ? { note: pickText(override.note, language) } : {}),
        ...(index.certified?.includes(hit.name) ? { certified: true } : {}),
        ...(official ? { official: true } : {}),
        ...(isNew ? { isNew: true } : {}),
        ...(override?.supersededBy ? { supersededBy: override.supersededBy } : {}),
        ...(discussion ? { rating: { up: discussion.up, down: discussion.down, comments: discussion.comments, discussion: discussionUrl(discussion.number) } } : {}),
      };
    });
    const tags = Object.fromEntries(Object.entries(vocab).map(([id, tag]) => [id, {
      label: pickText(tag.label, language), hint: pickText(tag.hint, language), ...(tag.style ? { style: tag.style } : {}),
    }]));
    return { hits: merged, index: { tags, ...(index.newDays !== undefined ? { newDays: index.newDays } : {}), ...(stale ? { stale } : {}) } };
  }

  /**
   * 把索引仓 `packages/<包>.json` 的更新日志正文与自描述合进包详情,与包文档同时读取;显示名与简介按 `merge` 的规则取 `locales`。
   * 自描述与 `locales` 对应索引扫到的那个版本,详情是别的版本时不合。读不到时详情原样返回。
   */
  async mergePackage(name: string, detail: Promise<ExtensionPackageDetail>, language: Language): Promise<ExtensionPackageDetail> {
    const files = PACKAGE_NAME.test(name) ? Promise.all([this.loadCatalog().then((read) => read.catalog), this.loadPackage(name)]) : Promise.resolve([null, null] as const);
    const info = await detail;
    const [catalog, file] = await files;
    const listed = catalog?.packages[info.name];
    const locale = listed?.version === info.version ? listed.locales?.[authorLanguage(language)] : undefined;
    const describe = file?.version === info.version ? localizeDescribe(file.describe, language) : undefined;
    return {
      ...info,
      ...(locale?.displayName ? { displayName: locale.displayName } : {}),
      ...(locale?.description ? { description: locale.description } : {}),
      ...(describe ? { describe } : {}),
      ...(file?.changelog && Object.keys(file.changelog).length ? { changelog: file.changelog } : {}),
    };
  }

  /** 已装包被官方拉黑时的原因;按最近一次读到的索引,本进程还没读过时读缓存文件。 */
  blocked(name: string, language: Language): string | undefined {
    const index = this.index ??= this.readJsonFile<IndexFile>(INDEX_CACHE_FILE);
    const reason = index && this.blockedEntry(index, name);
    return reason ? pickText(reason, language) : undefined;
  }

  /** 读索引用的源:`configured` 是扩展页配的,没配时 null;`base` 是先问的那一处。 */
  indexBase(): MarketIndexBase {
    const configured = this.readJsonFile<{ indexBase?: string }>(SETTINGS_FILE)?.indexBase ?? null;
    return { configured, base: configured ?? RAW_BASE };
  }

  /**
   * 把索引源改成 `url`(去掉末尾的 `/`),空串恢复 raw.githubusercontent.com;不是 http(s) 地址时抛 400。
   * 内存里已读的索引文件作废,下次读改问新的源;缓存文件留着,新的源也读不到时照样用。
   */
  setIndexBase(url: string): MarketIndexBase {
    const value = url.trim().replace(/\/+$/, '');
    if (value && !(/^https?:\/\/\S+$/i.test(value) && URL.canParse(value))) throw marketError((t) => t.badIndexBase(value), 400);
    const file = join(this.dir, SETTINGS_FILE);
    if (value) this.writeJsonFile(SETTINGS_FILE, { indexBase: value });
    else if (existsSync(file)) unlinkSync(file);
    this.raws.clear();
    return this.indexBase();
  }

  account(): GithubAccount {
    const token = this.token();
    return token ? { login: token.login, ...(token.avatar ? { avatar: token.avatar } : {}) } : {};
  }

  /**
   * 向 GitHub 要设备码并在后台等用户授权,授权后取账号写进令牌文件;WebUI 按 `interval` 查 `account()`。
   * 再次登录或退出时之前的等待作废。用户拒绝或码过期时记一条日志,WebUI 在过期时提示重新登录。
   */
  async login(): Promise<GithubDeviceCode> {
    const run = ++this.loginRun;
    const code = await this.form<{ device_code?: string; user_code: string; verification_uri: string; expires_in: number; interval: number; error_description?: string; error?: string }>(
      'https://github.com/login/device/code', { client_id: GITHUB_APP_CLIENT_ID });
    if (!code.device_code) throw marketError((t) => t.githubFailed(code.error_description ?? code.error ?? ''), 502);
    const deviceCode = code.device_code;
    void this.awaitAuthorization(run, deviceCode, code.interval, Date.now() + code.expires_in * 1000)
      .catch((err: unknown) => this.log.warn('GitHub 登录没有完成', { error: err instanceof Error ? err.message : String(err) }));
    return { userCode: code.user_code, verificationUri: code.verification_uri, expiresIn: code.expires_in, interval: code.interval };
  }

  /** 删掉本机令牌,停下进行中的登录。GitHub 那边的授权不撤销,用户在 GitHub 设置里自己撤。 */
  logout(): void {
    this.loginRun++;
    const file = join(this.dir, GITHUB_TOKEN_FILE);
    if (existsSync(file)) unlinkSync(file);
  }

  /** 改成 `vote` 或撤回(`null`):先撤掉本账号的另一种 reaction,再加上要的那种。回应是投完后的实时数。 */
  async vote(name: string, vote: 'up' | 'down' | null): Promise<ExtensionRating> {
    const { id } = await this.discussion(name);
    const before = await this.rating(id);
    for (const value of ['up', 'down'] as const) {
      if (before.mine === value && vote !== value) {
        await this.graphql('mutation($id: ID!, $content: ReactionContent!) { removeReaction(input: { subjectId: $id, content: $content }) { clientMutationId } }', { id, content: REACTIONS[value] });
      }
    }
    if (vote && before.mine !== vote) {
      await this.graphql('mutation($id: ID!, $content: ReactionContent!) { addReaction(input: { subjectId: $id, content: $content }) { clientMutationId } }', { id, content: REACTIONS[vote] });
    }
    return this.rating(id);
  }

  /**
   * 一页评论,新的在前;`cursor` 是上一页回的 `next`。登录了用令牌实时读(被管理员隐藏的不列出),
   * 没登录读快照;包还没有讨论帖时是空页。
   */
  async comments(name: string, cursor: string | undefined): Promise<ExtensionCommentPage> {
    this.checkName(name);
    if (!this.token()) return this.snapshotPage(name, cursor);
    const found = await this.findDiscussion(name);
    if (!found) return { comments: [], total: 0 };
    const data = await this.graphql<{ node: { url: string; comments: {
      totalCount: number;
      pageInfo: { hasPreviousPage: boolean; startCursor: string | null };
      nodes: Array<GraphqlComment & { replies: { nodes: GraphqlComment[] } }>;
    } } }>(`query($id: ID!, $before: String) { node(id: $id) { ... on Discussion { url
      comments(last: ${COMMENTS_PAGE_SIZE}, before: $before) { totalCount pageInfo { hasPreviousPage startCursor }
        nodes { ${COMMENT_FIELDS} replies(first: ${GRAPHQL_PAGE_MAX}) { nodes { ${COMMENT_FIELDS} } } } } } } }`,
    { id: found.id, before: cursor ?? null });
    const page = data.node.comments;
    const comments = page.nodes.filter((node) => !node.isMinimized).reverse().map((node) => {
      const replies = node.replies.nodes.filter((reply) => !reply.isMinimized).map(toComment);
      return { ...toComment(node), ...(replies.length ? { replies } : {}) };
    });
    return {
      comments,
      total: page.totalCount,
      ...(page.pageInfo.hasPreviousPage && page.pageInfo.startCursor ? { next: page.pageInfo.startCursor } : {}),
      discussion: data.node.url,
    };
  }

  /** 发一条评论;`replyTo` 是顶层评论的 id,给了就是回复那条。回应是新发的这条。 */
  async comment(name: string, body: string, replyTo: string | undefined): Promise<ExtensionComment> {
    const { id } = await this.discussion(name);
    const data = await this.graphql<{ addDiscussionComment: { comment: GraphqlComment } }>(
      `mutation($id: ID!, $body: String!, $replyTo: ID) { addDiscussionComment(input: { discussionId: $id, body: $body, replyToId: $replyTo }) { comment { ${COMMENT_FIELDS} } } }`,
      { id, body, replyTo: replyTo ?? null });
    return toComment(data.addDiscussionComment.comment);
  }

  private async awaitAuthorization(run: number, deviceCode: string, interval: number, deadlineMs: number): Promise<void> {
    while (run === this.loginRun && Date.now() < deadlineMs) {
      await new Promise((resolve) => setTimeout(resolve, interval * 1000).unref());
      if (run !== this.loginRun) return;
      const reply = await this.form<{ access_token?: string; error?: string; error_description?: string; interval?: number }>(
        'https://github.com/login/oauth/access_token',
        { client_id: GITHUB_APP_CLIENT_ID, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
      if (reply.access_token) {
        const user = await this.api<{ login: string; avatar_url?: string }>('https://api.github.com/user', reply.access_token);
        if (run !== this.loginRun) return;
        const token: TokenFile = { token: reply.access_token, login: user.login, ...(user.avatar_url ? { avatar: user.avatar_url } : {}) };
        mkdirSync(this.dir, { recursive: true });
        writeFileSync(join(this.dir, GITHUB_TOKEN_FILE), JSON.stringify(token, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
        return;
      }
      if (reply.error === 'authorization_pending') continue;
      // GitHub 要求收到 slow_down 后把间隔加长,回应里带新的间隔
      if (reply.error === 'slow_down') { interval = reply.interval ?? interval + 5; continue; }
      throw new Error(reply.error_description ?? reply.error ?? 'no access_token');
    }
  }

  private token(): TokenFile | null {
    const file = join(this.dir, GITHUB_TOKEN_FILE);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as TokenFile : null;
  }

  private checkName(name: string): void {
    if (!PACKAGE_NAME.test(name)) throw marketError((t) => t.badPackageName(name), 400);
  }

  private blockedEntry(index: IndexFile, name: string, publisher?: string): Bilingual | undefined {
    return index.blocked?.packages?.[name] ?? (publisher ? index.blocked?.publishers?.[publisher] : undefined);
  }

  private readJsonFile<T>(name: string): T | null {
    const file = join(this.dir, name);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as T : null;
  }

  private writeJsonFile(name: string, value: unknown): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, name), JSON.stringify(value) + '\n', 'utf8');
  }

  /**
   * 读 `index.json`,读到新的一份就写进缓存文件。读不到时用本进程上次读到的或缓存文件,`stale` 是这次的错误;
   * 都没有才抛。
   */
  private async loadIndex(): Promise<{ index: IndexFile; stale?: unknown }> {
    try {
      const { value, stale } = await this.raw('index.json');
      if (!value) throw marketError((t) => t.indexMissing('index.json'), 502);
      const index = this.checkSchema(value as IndexFile, 'index.json');
      if (index !== this.index) this.writeJsonFile(INDEX_CACHE_FILE, index);
      this.index = index;
      return stale === undefined ? { index } : { index, stale };
    } catch (err) {
      const fallback = this.index ??= this.readJsonFile<IndexFile>(INDEX_CACHE_FILE);
      if (!fallback) throw err;
      this.log.warn('官方索引读取失败,用上次读到的', { error: err instanceof Error ? err.message : String(err) });
      return { index: fallback, stale: err };
    }
  }

  /**
   * `catalog.json` 没有时不补 Action 汇总的字段。格式不认识或读不到时记日志,用本进程上次读到的或缓存文件,
   * `stale` 是这次的错误;都没有时同样不补。
   */
  private async loadCatalog(): Promise<{ catalog: CatalogFile | null; stale?: unknown }> {
    try {
      const { value, stale } = await this.raw('catalog.json');
      if (!value) return { catalog: null };
      const catalog = this.checkSchema(value as CatalogFile, 'catalog.json');
      if (catalog !== this.catalog) this.writeJsonFile(CATALOG_CACHE_FILE, catalog);
      this.catalog = catalog;
      return stale === undefined ? { catalog } : { catalog, stale };
    } catch (err) {
      this.log.warn('官方索引的 catalog.json 读取失败', { error: err instanceof Error ? err.message : String(err) });
      const fallback = this.catalog ??= this.readJsonFile<CatalogFile>(CATALOG_CACHE_FILE);
      return fallback ? { catalog: fallback, stale: err } : { catalog: null };
    }
  }

  /** 包没有 `packages/` 文件时是 null;格式不认识或读不到时同样是 null 并记日志。 */
  private async loadPackage(name: string): Promise<PackageFile | null> {
    const path = `packages/${fileName(name)}.json`;
    try {
      const { value } = await this.raw(path);
      return value ? this.checkSchema(value as PackageFile, path) : null;
    } catch (err) {
      this.log.warn('官方索引的包文件读取失败', { path, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  private checkSchema<T extends { schema: number }>(value: T, file: string): T {
    if (value.schema !== SCHEMA) throw marketError((t) => t.indexSchema(file, String(value.schema), SCHEMA), 502);
    return value;
  }

  /**
   * 索引仓里的一个 JSON 文件,404 是 null;结果(含 404)按 CDN 缓存时长留在内存里。
   * 过了时长再读失败时回内存里那份,`stale` 是这次的错误;内存里没有才抛。
   */
  private async raw(path: string): Promise<{ value: unknown; stale?: unknown }> {
    const kept = this.raws.get(path);
    if (kept && Date.now() - kept.atMs < RAW_CACHE_MS) return { value: kept.value };
    let value: unknown;
    try {
      value = await fetchIndexFile(path, { base: this.indexBase().configured ?? undefined, token: this.token()?.token, fetch: this.fetch });
    } catch (err) {
      if (!kept) throw err;
      return { value: kept.value, stale: err };
    }
    this.raws.set(path, { atMs: Date.now(), value });
    return { value };
  }

  private async snapshotPage(name: string, cursor: string | undefined): Promise<ExtensionCommentPage> {
    if (cursor !== undefined && !/^\d+$/.test(cursor)) throw marketError((t) => t.badCursor(cursor), 400);
    const { value } = await this.raw(`comments/${fileName(name)}.json`);
    if (!value) return { comments: [], total: 0 };
    const snapshot = this.checkSchema(value as CommentsSnapshot, `comments/${fileName(name)}.json`);
    const from = Number(cursor ?? 0);
    const end = from + COMMENTS_PAGE_SIZE;
    return {
      comments: snapshot.comments.slice(from, end),
      total: snapshot.comments.length,
      ...(end < snapshot.comments.length ? { next: String(end) } : {}),
      discussion: discussionUrl(snapshot.discussion),
    };
  }

  /** 包的讨论帖;没登录抛 428,帖子还没开抛 409。 */
  private async discussion(name: string): Promise<{ id: string; url: string }> {
    this.checkName(name);
    if (!this.token()) throw marketError((t) => t.githubLoginRequired, 428);
    const found = await this.findDiscussion(name);
    if (!found) throw marketError((t) => t.noDiscussion(name), 409);
    return found;
  }

  /** 列出讨论区分类里的帖子按标题找。找到的帖子在进程内一直沿用;没找到时重新列一次,Action 可能刚开了帖。 */
  private async findDiscussion(name: string): Promise<{ id: string; url: string } | undefined> {
    const listed = this.discussions?.get(name);
    if (listed) return listed;
    const byTitle = new Map<string, { id: string; url: string }>();
    for (let after: string | null = null; ;) {
      const data: { repository: { discussions: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{ id: string; title: string; url: string; category: { slug: string } }>;
      } } } = await this.graphql(`query($owner: String!, $name: String!, $after: String) { repository(owner: $owner, name: $name) {
        discussions(first: ${GRAPHQL_PAGE_MAX}, after: $after) { pageInfo { hasNextPage endCursor } nodes { id title url category { slug } } } } }`,
      { owner: REPO_OWNER, name: REPO_NAME, after });
      const page = data.repository.discussions;
      for (const node of page.nodes) if (node.category.slug === DISCUSSION_CATEGORY) byTitle.set(node.title, { id: node.id, url: node.url });
      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor;
    }
    this.discussions = byTitle;
    return byTitle.get(name);
  }

  /** 讨论帖首楼的喜欢、不喜欢与本账号的票;评论数含回复。 */
  private async rating(id: string): Promise<ExtensionRating> {
    const data = await this.graphql<{ node: GraphqlRating }>(`query($id: ID!) { node(id: $id) { ... on Discussion { ${RATING_FIELDS} } } }`, { id });
    const group = (value: 'up' | 'down') => data.node.reactionGroups.find((g) => g.content === REACTIONS[value]);
    const mine = (['up', 'down'] as const).find((value) => group(value)?.viewerHasReacted);
    const comments = data.node.comments;
    return {
      up: group('up')?.reactors.totalCount ?? 0,
      down: group('down')?.reactors.totalCount ?? 0,
      comments: comments.totalCount + comments.nodes.reduce((sum, node) => sum + node.replies.totalCount, 0),
      discussion: data.node.url,
      ...(mine ? { mine } : {}),
    };
  }

  /** 用本机令牌调 GraphQL。没登录抛 428;令牌被撤销或失效时删掉令牌文件,同样抛 428。 */
  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const token = this.token();
    if (!token) throw marketError((t) => t.githubLoginRequired, 428);
    const url = 'https://api.github.com/graphql';
    let res: Response;
    try {
      res = await this.fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json', 'User-Agent': 'Cortico' }, body: JSON.stringify({ query, variables }) });
    } catch (err) { throw new Error(fetchFailure(url, err)); }
    if (res.status === 401) { this.logout(); throw marketError((t) => t.githubLoginRequired, 428); }
    const reply = await res.json() as { data?: T; errors?: Array<{ message: string }>; message?: string };
    if (!res.ok || reply.errors?.length || !reply.data) {
      const detail = reply.errors?.map((e) => e.message).join('; ') ?? reply.message ?? `${res.status} ${res.statusText}`;
      throw marketError((t) => t.githubFailed(detail), 502);
    }
    return reply.data;
  }

  private async api<T>(url: string, token: string): Promise<T> {
    let res: Response;
    try { res = await this.fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Cortico' } }); } catch (err) { throw new Error(fetchFailure(url, err)); }
    if (!res.ok) throw new Error(`${new URL(url).host}: ${res.status} ${res.statusText}`);
    return await res.json() as T;
  }

  /** github.com 的 OAuth 端点:表单进、要 JSON 回;出错时也是 200,原因在 `error` 里。 */
  private async form<T>(url: string, body: Record<string, string>): Promise<T> {
    let res: Response;
    try {
      res = await this.fetch(url, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Cortico' }, body: new URLSearchParams(body).toString() });
    } catch (err) { throw new Error(fetchFailure(url, err)); }
    if (!res.ok) throw marketError((t) => t.githubFailed(`${res.status} ${res.statusText}`), 502);
    return await res.json() as T;
  }
}
