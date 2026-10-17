/**
 * 扩展市场:官方索引合进搜索结果、拉黑与缓存、设备码登录、投票与评论。
 * GitHub 由一个按地址与 GraphQL 操作分派的假 fetch 代替:raw、contents API 与镜像给同一份内存里的索引文件,
 * OAuth 端点与讨论区状态也在内存里。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExtensionMarket, GITHUB_TOKEN_FILE } from '../../src/extensions/market.ts';
import { LocalizedError } from '../../src/core/language.ts';
import { nullLogger } from '../../src/core/util.ts';
import type { ExtensionComment, ExtensionPackageDetail, ExtensionSearchHit } from '../../src/web/server.ts';

const RAW = 'https://raw.githubusercontent.com/Pal-AI-Lab/cortico-extensions/main/';
const CONTENTS = 'https://api.github.com/repos/Pal-AI-Lab/cortico-extensions/contents/';
const MIRROR = 'https://mirror.example.invalid/index/';

const bi = (zh: string, en: string) => ({ zh, en });
const INDEX = {
  schema: 1,
  official: { maintainers: ['maintainer'], githubOwners: ['Pal-AI-Lab'], names: [] },
  tags: {
    blue: { style: 'official', label: bi('蓝', 'Blue'), hint: bi('蓝说明', 'Blue hint'), when: '' },
    plain: { label: bi('普通', 'Plain'), hint: bi('普通说明', 'Plain hint'), when: '' },
    other: { label: bi('其他', 'Other'), hint: bi('其他说明', 'Other hint'), when: '' },
    yellow: { style: 'notice', label: bi('黄', 'Yellow'), hint: bi('黄说明', 'Yellow hint'), when: '' },
    red: { style: 'warning', label: bi('红', 'Red'), hint: bi('红说明', 'Red hint'), when: '' },
  },
  certified: ['cortico-world-a'],
  newDays: 14,
  blocked: { packages: { 'cortico-world-bad': bi('恶意代码', 'Malicious code') }, publishers: { villain: bi('冒名', 'Impersonation') } },
  overrides: { 'cortico-world-a': { addTags: ['blue'], removeTags: ['other'], note: bi('官方说明', 'Official note'), supersededBy: 'cortico-world-a2' } },
};

const hit = (name: string, extra: Partial<ExtensionSearchHit> = {}): ExtensionSearchHit => ({
  name, version: '1.0.0', description: '', downloads: { month: 0 }, dependents: 0, links: {}, installed: false, ...extra,
});

interface Discussion { id: string; number: number; title: string; reactions: Record<string, Set<string>>; comments: Array<ExtensionComment & { minimized?: boolean; replies: Array<ExtensionComment & { minimized?: boolean }> }> }

/** 内存里的 GitHub:raw 文件按路径给,GraphQL 按查询里出现的操作名分派;`calls` 记下每次变更的操作。 */
function fakeGithub(viewer = 'me') {
  const raw = new Map<string, unknown>();
  const discussions: Discussion[] = [];
  const calls: string[] = [];
  let rawDown = false;
  let apiDown = false;
  /** contents API 每次请求带的 Authorization 头 */
  const apiAuth: Array<string | null> = [];
  let pollsBeforeGrant = 1;
  const node = (id: string) => discussions.find((d) => d.id === id)!;
  const gqlComment = (c: ExtensionComment & { minimized?: boolean }) => ({ id: c.id, body: c.body, createdAt: c.createdAt, isMinimized: !!c.minimized, author: { login: c.author } });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const file = (path: string) => raw.has(path) ? json(raw.get(path)) : new Response('404: Not Found', { status: 404 });
    if (url.startsWith(RAW)) {
      if (rawDown) throw new TypeError('fetch failed');
      return file(url.slice(RAW.length));
    }
    if (url.startsWith(MIRROR)) return file(url.slice(MIRROR.length));
    if (url.startsWith(CONTENTS)) {
      if (apiDown) return new Response('{"message":"API rate limit exceeded"}', { status: 403, statusText: 'Forbidden', headers: { 'x-ratelimit-remaining': '0' } });
      apiAuth.push(new Headers(init?.headers).get('authorization'));
      return file(url.slice(CONTENTS.length).replace(/\?ref=main$/, ''));
    }
    if (url === 'https://github.com/login/device/code') {
      return json({ device_code: 'dev-1', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 0 });
    }
    if (url === 'https://github.com/login/oauth/access_token') {
      return json(pollsBeforeGrant-- > 0 ? { error: 'authorization_pending' } : { access_token: 'tok', token_type: 'bearer' });
    }
    if (url === 'https://api.github.com/user') return json({ login: viewer, avatar_url: 'https://avatars.example.invalid/me' });
    if (url === 'https://api.github.com/graphql') {
      const { query, variables: v } = JSON.parse(String(init!.body)) as { query: string; variables: Record<string, string | null> };
      if (query.includes('removeReaction')) { calls.push(`remove ${v.content}`); node(v.id!).reactions[v.content!]!.delete(viewer); return json({ data: { removeReaction: {} } }); }
      if (query.includes('addReaction')) { calls.push(`add ${v.content}`); node(v.id!).reactions[v.content!]!.add(viewer); return json({ data: { addReaction: {} } }); }
      if (query.includes('addDiscussionComment')) {
        calls.push(`comment ${v.replyTo ?? '-'}`);
        const comment = { id: `c${Date.now()}`, author: viewer, body: v.body!, createdAt: '2026-10-15T00:00:00Z', replies: [] };
        const d = node(v.id!);
        if (v.replyTo) d.comments.find((c) => c.id === v.replyTo)!.replies.push(comment); else d.comments.push(comment);
        return json({ data: { addDiscussionComment: { comment: gqlComment(comment) } } });
      }
      if (query.includes('discussions(')) {
        return json({ data: { repository: { discussions: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: discussions.map((d) => ({ id: d.id, title: d.title, url: `https://github.com/d/${d.number}`, category: { slug: 'extensions' } })) } } } });
      }
      const d = node(v.id!);
      if (query.includes('reactionGroups')) {
        return json({ data: { node: {
          url: `https://github.com/d/${d.number}`,
          reactionGroups: Object.entries(d.reactions).map(([content, users]) => ({ content, viewerHasReacted: users.has(viewer), reactors: { totalCount: users.size } })),
          comments: { totalCount: d.comments.length, nodes: d.comments.map((c) => ({ replies: { totalCount: c.replies.length } })) },
        } } });
      }
      // comments(last: N, before: cursor):游标是从旧到新的下标
      const size = Number(/last: (\d+)/.exec(query)![1]);
      const end = v.before ? Number(v.before) : d.comments.length;
      const start = Math.max(0, end - size);
      return json({ data: { node: {
        url: `https://github.com/d/${d.number}`,
        comments: {
          totalCount: d.comments.length,
          pageInfo: { hasPreviousPage: start > 0, startCursor: String(start) },
          nodes: d.comments.slice(start, end).map((c) => ({ ...gqlComment(c), replies: { nodes: c.replies.map(gqlComment) } })),
        },
      } } });
    }
    throw new Error(`unexpected ${url}`);
  });
  return {
    fetch: fetch as unknown as typeof globalThis.fetch,
    raw, discussions, calls, apiAuth,
    set rawDown(value: boolean) { rawDown = value; },
    set apiDown(value: boolean) { apiDown = value; },
    set pollsBeforeGrant(value: number) { pollsBeforeGrant = value; },
    addDiscussion(title: string, number: number): Discussion {
      const d: Discussion = { id: `D${number}`, number, title, reactions: { THUMBS_UP: new Set(), THUMBS_DOWN: new Set() }, comments: [] };
      discussions.push(d);
      return d;
    },
  };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'extension-market-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const signIn = () => writeFileSync(join(dir, GITHUB_TOKEN_FILE), JSON.stringify({ token: 'tok', login: 'me' }));
const statusOf = async (promise: Promise<unknown>) => promise.then(() => 200, (err: unknown) => (err instanceof LocalizedError ? err.status : 0));

describe('merge', () => {
  it('滤掉拉黑的包与发布者,按规则合出标签、官方、认证、新品、说明与评分', async () => {
    const github = fakeGithub();
    github.raw.set('index.json', INDEX);
    github.raw.set('catalog.json', {
      schema: 1,
      packages: {
        'cortico-world-a': {
          version: '1.0.0', created: new Date(Date.now() - 86_400_000).toISOString(), declaredTags: ['yellow', 'blue', 'other', 'unknown'],
          discussion: { number: 7, url: 'https://github.com/Pal-AI-Lab/cortico-extensions/discussions/7', up: 3, down: 1, comments: 2 },
        },
        'cortico-world-old': { version: '1.0.0', created: '2020-01-01T00:00:00Z' },
      },
      sticky: { 'cortico-world-a': ['red', 'plain'] },
    });
    const market = new ExtensionMarket({ dir, log: nullLogger(), fetch: github.fetch });
    const { hits, index } = await market.merge(Promise.resolve([
      hit('cortico-world-a', { keywords: ['cortico-world', 'plain', 'yellow'], maintainers: ['maintainer'], links: { repository: 'https://github.com/pal-ai-lab/a' } }),
      hit('cortico-world-old', { maintainers: ['maintainer'], links: { repository: 'https://github.com/someone/old' } }),
      hit('cortico-world-bad'),
      hit('cortico-world-c', { publisher: 'villain' }),
    ]), 'en');
    expect(hits.map((h) => h.name)).toEqual(['cortico-world-a', 'cortico-world-old']);
    const [a, old] = hits;
    // 作者声明的 blue 不算、unknown 不在词表;keywords 只映射普通标签;粘住名单只收红色;官方加 blue、去 other
    expect(new Set(a.tags)).toEqual(new Set(['yellow', 'plain', 'red', 'blue']));
    expect(a).toMatchObject({ certified: true, official: true, isNew: true, note: 'Official note', supersededBy: 'cortico-world-a2',
      rating: { up: 3, down: 1, comments: 2, discussion: 'https://github.com/Pal-AI-Lab/cortico-extensions/discussions/7' } });
    // 维护者是官方账号但仓库不在官方账号下:不算官方
    expect(old.official).toBeUndefined();
    expect(old.isNew).toBeUndefined();
    expect(Object.keys(index.tags)).toEqual(Object.keys(INDEX.tags));
    expect(index.tags.red).toEqual({ label: 'Red', hint: 'Red hint', style: 'warning' });
    expect(index.newDays).toBe(INDEX.newDays);
    expect(market.blocked('cortico-world-bad', 'zh')).toBe('恶意代码');
  });

  it('索引格式版本不认识时当作读不到:结果原样返回并给出原因', async () => {
    const github = fakeGithub();
    github.raw.set('index.json', { ...INDEX, schema: 2 });
    const market = new ExtensionMarket({ dir, log: nullLogger(), fetch: github.fetch });
    const hits = [hit('cortico-world-bad')];
    const merged = await market.merge(Promise.resolve(hits), 'en');
    expect(merged.hits).toEqual(hits);
    expect(merged.index).toEqual({ tags: {}, error: expect.stringContaining('index.json has format version 2') });
  });

  it('raw 连不上时改问 contents API 并带上登录令牌;配了索引源时先问它,图标也用它', async () => {
    const github = fakeGithub();
    github.raw.set('index.json', INDEX);
    github.raw.set('catalog.json', { schema: 1, packages: { 'cortico-world-d': { version: '1.0.0', icon: 'assets/d/icon.png' } } });
    github.rawDown = true;
    signIn();
    const market = new ExtensionMarket({ dir, log: nullLogger(), fetch: github.fetch });
    const viaApi = await market.merge(Promise.resolve([hit('cortico-world-bad'), hit('cortico-world-d')]), 'en');
    expect(viaApi.hits.map((h) => h.name)).toEqual(['cortico-world-d']);
    expect(viaApi.index.stale).toBeUndefined();
    expect(github.apiAuth).toEqual(['Bearer tok', 'Bearer tok']);

    expect(market.setIndexBase(`${MIRROR}/`)).toEqual({ configured: MIRROR.slice(0, -1), base: MIRROR.slice(0, -1) });
    const viaMirror = await market.merge(Promise.resolve([hit('cortico-world-d')]), 'en');
    expect(viaMirror.hits[0].icon).toBe(`${MIRROR}assets/d/icon.png`);
    expect(github.apiAuth).toHaveLength(2);
    expect(() => market.setIndexBase('ftp://mirror.example.invalid')).toThrow(LocalizedError);
  });

  it('所有来源都读不到时用扩展目录里上次读到的索引与 catalog,index.stale 写出每一处的原因', async () => {
    const github = fakeGithub();
    github.raw.set('index.json', INDEX);
    github.raw.set('catalog.json', { schema: 1, packages: { 'cortico-world-d': { version: '1.0.0', displayName: 'D' } } });
    await new ExtensionMarket({ dir, log: nullLogger(), fetch: github.fetch }).merge(Promise.resolve([]), 'zh');
    github.rawDown = true;
    github.apiDown = true;
    const offline = new ExtensionMarket({ dir, log: nullLogger(), fetch: github.fetch });
    expect(offline.blocked('cortico-world-bad', 'en')).toBe('Malicious code');
    const { hits, index } = await offline.merge(Promise.resolve([hit('cortico-world-bad'), hit('cortico-world-d')]), 'zh');
    expect(hits.map((h) => [h.name, h.displayName])).toEqual([['cortico-world-d', 'D']]);
    expect(Object.keys(index.tags)).toEqual(Object.keys(INDEX.tags));
    expect(index.error).toBeUndefined();
    expect(index.stale).toContain('raw.githubusercontent.com: fetch failed');
    expect(index.stale).toContain('api.github.com: 403 Forbidden (x-ratelimit-remaining: 0)');
  });
});

const CATALOG_ENTRY = {
  version: '1.0.0',
  displayName: '甲',
  locales: { en: { displayName: 'A', description: 'Reads A.' } },
  author: 'Author', maintainers: ['someone'], os: ['win32'],
  icon: 'assets/@scope__cortico-world-x/icon.png',
  screenshots: ['assets/@scope__cortico-world-x/screenshot-1.png'],
  summary: { tools: 2, events: 1 },
  changelog: { versions: ['1.0.0', '0.9.0'], url: 'https://github.com/someone/x/blob/HEAD/CHANGELOG.md' },
};

describe('catalog.json 的列表字段', () => {
  it('合进搜索结果:图标与截图换成 raw 地址;显示名与简介 zh 读顶层,zh-Hant、en 与其余语言读 locales.en', async () => {
    const github = fakeGithub();
    github.raw.set('index.json', INDEX);
    github.raw.set('catalog.json', { schema: 1, packages: { '@scope/cortico-world-x': CATALOG_ENTRY } });
    const market = new ExtensionMarket({ dir, log: nullLogger(), fetch: github.fetch });
    const search = () => Promise.resolve([hit('@scope/cortico-world-x', { description: '读甲。' })]);
    const [en] = (await market.merge(search(), 'en')).hits;
    expect(en).toMatchObject({
      displayName: 'A', description: 'Reads A.', author: 'Author', maintainers: ['someone'], os: ['win32'],
      icon: `${RAW}assets/@scope__cortico-world-x/icon.png`, screenshots: [`${RAW}assets/@scope__cortico-world-x/screenshot-1.png`],
      summary: CATALOG_ENTRY.summary, changelog: CATALOG_ENTRY.changelog,
    });
    expect((await market.merge(search(), 'zh')).hits[0]).toMatchObject({ displayName: '甲', description: '读甲。' });
    expect((await market.merge(search(), 'ja')).hits[0]).toMatchObject({ displayName: 'A', description: 'Reads A.' });
    expect((await market.merge(search(), 'zh-Hant')).hits[0]).toMatchObject({ displayName: 'A', description: 'Reads A.' });
  });
});

describe('包详情', () => {
  const detail = (version: string): ExtensionPackageDetail => ({
    name: '@scope/cortico-world-x', version, description: '读甲。', versionCount: 2, history: [], warnings: [], dependencies: [], maintainers: [], links: {}, installed: false,
  });
  const PACKAGE_FILE = {
    schema: 1, name: '@scope/cortico-world-x', version: '1.0.0',
    describe: {
      tools: [
        { name: 'x_read', description: 'Read x.', parameters: { type: 'object' }, tags: ['read'], summary: bi('读 x', 'Reads x') },
        { name: 'x_broken', tags: [] },
      ],
      events: [{ type: 'x.message', description: bi('来消息', 'A message arrived'), trigger: 'wake' }],
      prompts: [{ key: 'worlds.x.envPrompt', title: 'X', role: 'envPrompt', content: '你在 X 上。' }],
    },
    changelog: { '1.0.0': '- 第一版', '0.9.0': '- 预览' },
  };

  it('合进按请求语言取好的自描述与更新日志正文,缺字段的工具丢掉', async () => {
    const github = fakeGithub();
    github.raw.set('catalog.json', { schema: 1, packages: { '@scope/cortico-world-x': CATALOG_ENTRY } });
    github.raw.set('packages/@scope__cortico-world-x.json', PACKAGE_FILE);
    const market = new ExtensionMarket({ dir, log: nullLogger(), fetch: github.fetch });
    const merged = await market.mergePackage('@scope/cortico-world-x', Promise.resolve(detail('1.0.0')), 'en');
    expect(merged).toMatchObject({ displayName: 'A', description: 'Reads A.', changelog: PACKAGE_FILE.changelog });
    expect(merged.describe).toEqual({
      tools: [{ name: 'x_read', description: 'Read x.', summary: 'Reads x', tags: ['read'] }],
      events: [{ type: 'x.message', description: 'A message arrived' }],
      prompts: [{ key: 'worlds.x.envPrompt', title: 'X', role: 'envPrompt', content: '你在 X 上。' }],
    });
    expect((await market.mergePackage('@scope/cortico-world-x', Promise.resolve(detail('1.0.0')), 'zh')).describe?.events).toEqual([{ type: 'x.message', description: '来消息' }]);
    expect((await market.mergePackage('@scope/cortico-world-x', Promise.resolve(detail('1.0.0')), 'zh-Hant')).describe?.events).toEqual([{ type: 'x.message', description: 'A message arrived' }]);
  });

  it('详情是索引没扫到的版本时只合更新日志;索引里没有这个包时详情原样返回', async () => {
    const github = fakeGithub();
    github.raw.set('catalog.json', { schema: 1, packages: { '@scope/cortico-world-x': CATALOG_ENTRY } });
    github.raw.set('packages/@scope__cortico-world-x.json', PACKAGE_FILE);
    const market = new ExtensionMarket({ dir, log: nullLogger(), fetch: github.fetch });
    const older = await market.mergePackage('@scope/cortico-world-x', Promise.resolve(detail('0.9.0')), 'en');
    expect(older).toEqual({ ...detail('0.9.0'), changelog: PACKAGE_FILE.changelog });
    const unlisted = { ...detail('1.0.0'), name: 'cortico-world-y' };
    expect(await market.mergePackage('cortico-world-y', Promise.resolve(unlisted), 'en')).toEqual(unlisted);
  });
});

describe('GitHub 账号', () => {
  it('设备码登录:后台等到授权后写下令牌,账号可读;退出删掉令牌', async () => {
    const github = fakeGithub();
    github.pollsBeforeGrant = 2;
    const market = new ExtensionMarket({ dir, log: nullLogger(), fetch: github.fetch });
    expect(market.account()).toEqual({});
    expect(await market.login()).toEqual({ userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 0 });
    await vi.waitFor(() => expect(market.account()).toEqual({ login: 'me', avatar: 'https://avatars.example.invalid/me' }));
    expect(JSON.parse(readFileSync(join(dir, GITHUB_TOKEN_FILE), 'utf8')).token).toBe('tok');
    market.logout();
    expect(existsSync(join(dir, GITHUB_TOKEN_FILE))).toBe(false);
    expect(market.account()).toEqual({});
  });
});

describe('投票', () => {
  it('没登录 428;包没有讨论帖 409', async () => {
    const github = fakeGithub();
    const market = new ExtensionMarket({ dir, log: nullLogger(), fetch: github.fetch });
    expect(await statusOf(market.vote('cortico-world-a', 'up'))).toBe(428);
    signIn();
    expect(await statusOf(market.vote('cortico-world-a', 'up'))).toBe(409);
  });

  it('改票先撤掉另一种再加上要的那种;撤回只撤自己的', async () => {
    const github = fakeGithub();
    const d = github.addDiscussion('cortico-world-a', 7);
    d.reactions.THUMBS_DOWN!.add('me');
    d.reactions.THUMBS_UP!.add('someone');
    signIn();
    const market = new ExtensionMarket({ dir, log: nullLogger(), fetch: github.fetch });
    expect(await market.vote('cortico-world-a', 'up')).toEqual({ up: 2, down: 0, comments: 0, discussion: 'https://github.com/d/7', mine: 'up' });
    expect(github.calls).toEqual(['remove THUMBS_DOWN', 'add THUMBS_UP']);
    expect(await market.vote('cortico-world-a', null)).toEqual({ up: 1, down: 0, comments: 0, discussion: 'https://github.com/d/7' });
  });
});

describe('评论', () => {
  const comment = (i: number): ExtensionComment => ({ id: `s${i}`, author: 'u', body: `#${i}`, createdAt: '2026-10-01T00:00:00Z' });

  it('没登录读快照,一页 5 条,next 指向下一页', async () => {
    const github = fakeGithub();
    github.raw.set('comments/@scope__cortico-world-x.json', { schema: 1, discussion: 'https://github.com/Pal-AI-Lab/cortico-extensions/discussions/9', comments: Array.from({ length: 7 }, (_, i) => comment(i)) });
    const market = new ExtensionMarket({ dir, log: nullLogger(), fetch: github.fetch });
    const first = await market.comments('@scope/cortico-world-x', undefined);
    expect(first).toMatchObject({ total: 7, next: '5', discussion: 'https://github.com/Pal-AI-Lab/cortico-extensions/discussions/9' });
    expect(first.comments.map((c) => c.id)).toEqual(['s0', 's1', 's2', 's3', 's4']);
    const second = await market.comments('@scope/cortico-world-x', first.next);
    expect(second.comments.map((c) => c.id)).toEqual(['s5', 's6']);
    expect(second.next).toBeUndefined();
    expect(await market.comments('cortico-world-none', undefined)).toEqual({ comments: [], total: 0 });
  });

  it('登录后实时读:新的在前、隐藏的不列;回复挂在顶层评论下', async () => {
    const github = fakeGithub();
    const d = github.addDiscussion('cortico-world-a', 7);
    for (let i = 0; i < 6; i++) d.comments.push({ ...comment(i), id: `t${i}`, replies: [] });
    d.comments[4]!.minimized = true;
    signIn();
    const market = new ExtensionMarket({ dir, log: nullLogger(), fetch: github.fetch });
    const posted = await market.comment('cortico-world-a', 'reply', 't5');
    expect(github.calls).toEqual(['comment t5']);
    const first = await market.comments('cortico-world-a', undefined);
    expect(first.comments.map((c) => c.id)).toEqual(['t5', 't3', 't2', 't1']);
    expect(first.comments[0]!.replies).toEqual([posted]);
    const second = await market.comments('cortico-world-a', first.next);
    expect(second.comments.map((c) => c.id)).toEqual(['t0']);
    expect(second.next).toBeUndefined();
  });
});
