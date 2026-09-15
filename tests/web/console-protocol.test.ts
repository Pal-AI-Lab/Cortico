/** 验证 world、llm、persona 页命名空间、资源 URL 限制与 manifest 公开字段；面板 id 仅页内唯一。 */
import { describe, it, expect } from 'vitest';
import {
  CONSOLE_ASSET_PREFIX,
  CONSOLE_MANIFEST_ROUTE,
  CONSOLE_PROTOCOL_VERSION,
  assetKeyForPage,
  isBinaryResult,
  isPanelId,
  isSafeAssetUrl,
  isSafeLinkHref,
  panelRoute,
  parsePageId,
  pageIdFor,
  LAMP_MAX,
  toPageManifest,
  validateContributions,
  type ConsolePageContribution,
} from '../../src/web/shared/console-protocol.ts';

/** 变量动态 import 避免根 tsconfig 纳入 DOM 类型；浏览器契约由 tsconfig.web.json 检查。 */
type ClientBundleModule = {
  toDisposable(cleanup: () => void): { dispose(): void };
  isConsoleClientBundle(v: unknown): boolean;
};
const CLIENT_BUNDLE_SPEC = '../../src/web/shared/client-panel.ts';
const loadClientBundle = async (): Promise<ClientBundleModule> =>
  (await import(/* @vite-ignore */ CLIENT_BUNDLE_SPEC)) as ClientBundleModule;

// ---------------------------------------------------------------------------

describe('ID 命名空间', () => {
  it('page id 拆解为 kind 与 name', () => {
    expect(parsePageId('world:qq')).toEqual({ kind: 'world', name: 'qq' });
    expect(parsePageId('persona:corti')).toEqual({ kind: 'persona', name: 'corti' });
    expect(parsePageId('world:a')).toEqual({ kind: 'world', name: 'a' });
    expect(parsePageId('world:x-y-9')).toEqual({ kind: 'world', name: 'x-y-9' });
  });

  it('没有 kind 前缀的裸名字不是 provider id', () => {
    expect(parsePageId('qq')).toBeNull();
  });

  it('大写不合法(id 是路由与文件名的一部分,不允许大小写歧义)', () => {
    expect(parsePageId('IO:qq')).toBeNull();
    expect(parsePageId('world:QQ')).toBeNull();
  });

  it('空 name 不合法', () => {
    expect(parsePageId('world:')).toBeNull();
    expect(parsePageId('persona:')).toBeNull();
  });

  it('连字符不能出现在首尾', () => {
    expect(parsePageId('world:-x')).toBeNull();
    expect(parsePageId('world:x-')).toBeNull();
  });

  it('未知 kind 被拒(协议只认 worlds / persona,framework 不是 provider)', () => {
    expect(parsePageId('extension:x')).toBeNull();
    expect(parsePageId('framework:x')).toBeNull();
  });

  it('多段冒号被拒(id 只有一层 namespace)', () => {
    expect(parsePageId('world:a:b')).toBeNull();
  });

  it('空格、斜杠与 .. 都进不了 id(它会被拼进路由与 asset key)', () => {
    expect(parsePageId('world:a b')).toBeNull();
    expect(parsePageId('world: qq')).toBeNull();
    expect(parsePageId('world:a/b')).toBeNull();
    expect(parsePageId('world:..')).toBeNull();
    expect(parsePageId('world:a..b')).toBeNull();
    expect(parsePageId('world:a\\b')).toBeNull();
    expect(parsePageId('')).toBeNull();
  });

  it('panel id 是局部名,不带任何前缀', () => {
    expect(isPanelId('gate')).toBe(true);
    expect(isPanelId('vision-2')).toBe(true);
    expect(isPanelId('a')).toBe(true);
  });

  it('含连字符的 panel id 按普通局部名处理', () => {
    // qq-gate 是 provider 内的局部面板 id，连字符不触发命名空间特例。
    expect(isPanelId('qq-gate')).toBe(true);
    expect(isPanelId('vtuber-align')).toBe(true);
  });

  it('panel id 拒空串、大写、下划线与斜杠', () => {
    expect(isPanelId('')).toBe(false);
    expect(isPanelId('Gate')).toBe(false);
    expect(isPanelId('a_b')).toBe(false);
    expect(isPanelId('a/b')).toBe(false);
    expect(isPanelId('-a')).toBe(false);
    expect(isPanelId('a-')).toBe(false);
  });

  it('pageIdFor 与 parsePageId 往返一致(构建脚本与注册表共用同一处推导)', () => {
    expect(pageIdFor('world', 'qq')).toBe('world:qq');
    expect(pageIdFor('persona', 'corti')).toBe('persona:corti');
    for (const [kind, name] of [['world', 'qq'], ['persona', 'corti'], ['world', 'x-y-9']] as const) {
      const id = pageIdFor(kind, name);
      expect([id, parsePageId(id)]).toEqual([id, { kind, name }]);
    }
  });

  it('panel 路由把冒号编码掉,provider/panel/method 三段各自转义', () => {
    expect(panelRoute('world:qq', 'gate', 'state'))
      .toBe('/api/console/providers/world%3Aqq/panels/gate/state');
    expect(panelRoute('world:qq', 'g', 'a/b')).toBe('/api/console/providers/world%3Aqq/panels/g/a%2Fb');
  });

  it('协议版本与 manifest 端点是常量,不由 provider 决定', () => {
    expect(CONSOLE_PROTOCOL_VERSION).toBe(1);
    expect(CONSOLE_MANIFEST_ROUTE).toBe('/api/console/manifest');
  });
});

// ---------------------------------------------------------------------------

describe('Asset 安全模型', () => {
  it('assetKeyForPage 是恒等映射(provider 只有 key,没有路径这个字段)', () => {
    expect(assetKeyForPage('world:qq')).toBe('world:qq');
    expect(assetKeyForPage('persona:corti')).toBe('persona:corti');
    expect(assetKeyForPage('')).toBe('');
  });

  it('资源路径必须使用规定前缀', () => {
    expect(CONSOLE_ASSET_PREFIX).toBe('/assets/');
  });

  it('放行:内核入口', () => {
    expect(isSafeAssetUrl('/assets/main-a1b2.js')).toBe(true);
  });

  it('放行:provider 扩展产物', () => {
    expect(isSafeAssetUrl('/assets/providers/worlds-qq-d4e5.js')).toBe(true);
  });

  it('拦:相对路径(没有 /assets/ 前缀)', () => {
    expect(isSafeAssetUrl('../../foo.js')).toBe(false);
  });

  it('拦:前缀内的 .. 段回溯', () => {
    expect(isSafeAssetUrl('/assets/../../etc/passwd')).toBe(false);
  });

  it('拦:file 协议', () => {
    expect(isSafeAssetUrl('file:///x')).toBe(false);
  });

  it('拦:http 外链', () => {
    expect(isSafeAssetUrl('http://evil/x.js')).toBe(false);
  });

  it('拦:https 外链', () => {
    expect(isSafeAssetUrl('https://evil/x.js')).toBe(false);
  });

  it('拦:协议相对写法', () => {
    expect(isSafeAssetUrl('//evil/x.js')).toBe(false);
  });

  it('拦:前缀后紧跟双斜杠(浏览器会当成 host)', () => {
    expect(isSafeAssetUrl('/assets//evil')).toBe(false);
  });

  it('拦:Windows 盘符路径', () => {
    expect(isSafeAssetUrl('C:\\foo.js')).toBe(false);
  });

  it('拦:前缀内混入反斜杠', () => {
    expect(isSafeAssetUrl('/assets/a\\b.js')).toBe(false);
  });

  it('拦:空串', () => {
    expect(isSafeAssetUrl('')).toBe(false);
  });

  it('拦:undefined', () => {
    expect(isSafeAssetUrl(undefined)).toBe(false);
  });

  it('拦:null', () => {
    expect(isSafeAssetUrl(null)).toBe(false);
  });

  it('拦:数字', () => {
    expect(isSafeAssetUrl(123)).toBe(false);
  });

  it('拦:对象', () => {
    expect(isSafeAssetUrl({ toString: () => '/assets/x.js' })).toBe(false);
  });

  it('拦:数组', () => {
    expect(isSafeAssetUrl(['/assets/x.js'])).toBe(false);
  });

  it('拦:含 NUL 字节', () => {
    expect(isSafeAssetUrl('/assets/x.js\0.png')).toBe(false);
  });

  it('拦:光秃秃的前缀本身(否则它就是个目录列举面)', () => {
    expect(isSafeAssetUrl('/assets/')).toBe(false);
  });

  it('拦:百分号编码的 .. 回溯', () => {
    expect(isSafeAssetUrl('/assets/%2e%2e/%2e%2e/etc/passwd')).toBe(false);
  });

  it('拦:百分号编码的斜杠回溯', () => {
    expect(isSafeAssetUrl('/assets/..%2f..%2fetc/passwd')).toBe(false);
  });

  it('拦:百分号编码的反斜杠回溯', () => {
    expect(isSafeAssetUrl('/assets/..%5c..%5cx')).toBe(false);
  });

  it('拦:任何百分号(白名单字符集里没有 %)', () => {
    expect(isSafeAssetUrl('/assets/x%41.js')).toBe(false);
  });

  it('拦:换行(拼进响应头就是头注入面)', () => {
    expect(isSafeAssetUrl('/assets/x\n.js')).toBe(false);
  });

  it('拦:制表符', () => {
    expect(isSafeAssetUrl('/assets/\t')).toBe(false);
  });

  it('拦:空格', () => {
    expect(isSafeAssetUrl('/assets/a b.js')).toBe(false);
  });

  it('拦:查询串(产物带内容 hash,不需要 cache-buster)', () => {
    expect(isSafeAssetUrl('/assets/x.js?a=../../y')).toBe(false);
  });
});

describe('链接 href 闸门', () => {
  it('放行:http / https 外链', () => {
    expect(isSafeLinkHref('http://127.0.0.1:8080/panel')).toBe(true);
    expect(isSafeLinkHref('https://example.org/x')).toBe(true);
  });

  it('放行:同源相对路径', () => {
    expect(isSafeLinkHref('/overlay')).toBe(true);
  });

  it('拦:javascript: 伪协议(控制台里的 XSS)', () => {
    expect(isSafeLinkHref('javascript:alert(1)')).toBe(false);
  });

  it('拦:大小写混写与前导空白的 javascript:', () => {
    expect(isSafeLinkHref('JaVaScRiPt:alert(1)')).toBe(false);
    expect(isSafeLinkHref(' javascript:alert(1)')).toBe(false);
  });

  it('拦:data: 与 vbscript:', () => {
    expect(isSafeLinkHref('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isSafeLinkHref('vbscript:msgbox(1)')).toBe(false);
  });

  it('拦:协议相对写法(会跑到外站)', () => {
    expect(isSafeLinkHref('//evil/x')).toBe(false);
  });

  it('放行:自定义应用协议(交给操作系统,不在控制台里执行)', () => {
    expect(isSafeLinkHref('vscode://file/c:/x')).toBe(true);
    expect(isSafeLinkHref('obs://x')).toBe(true);
    expect(isSafeLinkHref('file:///C:/x')).toBe(true);
  });

  it('拦:含控制字符的 href', () => {
    expect(isSafeLinkHref('https://a/\nSet-Cookie:x')).toBe(false);
  });

  it('拦:空串与非字符串', () => {
    expect(isSafeLinkHref('')).toBe(false);
    expect(isSafeLinkHref(undefined)).toBe(false);
    expect(isSafeLinkHref(null)).toBe(false);
    expect(isSafeLinkHref(123)).toBe(false);
  });

  it('不安全的链接在 toPageManifest 处被丢掉,但 provider 本身照常上线', () => {
    const manifest = toPageManifest({
      id: 'world:chat',
      kind: 'world',
      label: '对话',
      links: [
        { label: '正常', href: 'http://127.0.0.1:9000/', inheritTheme: true },
        { label: '普通', href: '/plain', inheritTheme: false },
        { label: '恶意', href: 'javascript:alert(1)' },
      ],
    });
    expect(manifest.links).toEqual([
      { label: '正常', href: 'http://127.0.0.1:9000/', inheritTheme: true },
      { label: '普通', href: '/plain' },
    ]);
    expect(JSON.stringify(manifest)).not.toContain('javascript:');
  });

  it('链接全不安全时不留空数组键', () => {
    const manifest = toPageManifest({
      id: 'world:chat',
      kind: 'world',
      label: '对话',
      links: [{ label: '恶意', href: 'javascript:alert(1)' }],
    });
    expect(manifest.links).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

const provider = (over: Partial<ConsolePageContribution> = {}): ConsolePageContribution => ({
  id: 'world:alpha',
  kind: 'world',
  label: '阿尔法',
  ...over,
});

describe('validateContributions', () => {
  it('空数组没有问题', () => {
    expect(validateContributions([])).toEqual([]);
  });

  it('只有通用声明式表面(徽标/配置/链接)的 provider 合法——不声明 panel 就不必写浏览器代码', () => {
    const problems = validateContributions([
      provider({
        badges: [{ label: '状态', value: 'on', tone: 'on' }],
        links: [{ label: '打开', href: '/x' }],
        config: [{
          id: 'alpha',
          owner: 'world:alpha',
          schema: { type: 'object', title: '阿尔法', properties: {} },
        }],
      }),
    ]);
    expect(problems).toEqual([]);
  });

  it('provider id 重复报一条', () => {
    const problems = validateContributions([provider(), provider()]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toEqual({ pageId: 'world:alpha', message: 'provider id 重复：world:alpha' });
  });

  it('同一 provider 内 panel id 重复报一条', () => {
    const problems = validateContributions([
      provider({ panels: [{ id: 'log', title: '日志' }, { id: 'log', title: '日志二' }] }),
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain('panel id 在本 provider 内重复：log');
  });

  it('不同 provider 用同名 panel id 合法(这正是 namespace 规则要买到的东西)', () => {
    const problems = validateContributions([
      provider({ id: 'world:alpha', kind: 'world', panels: [{ id: 'log', title: '日志' }] }),
      provider({ id: 'persona:beta', kind: 'persona', panels: [{ id: 'log', title: '日志' }] }),
    ]);
    expect(problems).toEqual([]);
  });

  it('id 前缀与 kind 不一致要报出来(两处都写了,不许悄悄以其中一处为准)', () => {
    const problems = validateContributions([provider({ id: 'world:alpha', kind: 'persona' })]);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain('前缀是 world');
    expect(problems[0]?.message).toContain('kind 声明为 persona');
  });

  it('label 为空报一条', () => {
    const problems = validateContributions([provider({ label: '' })]);
    expect(problems).toEqual([{ pageId: 'world:alpha', message: 'label 不能为空' }]);
  });

  it('panel 缺 title 报一条', () => {
    const problems = validateContributions([provider({ panels: [{ id: 'log', title: '' }] })]);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain('panel「log」缺 title');
  });

  it('panel id 不合法报一条,并指出不该带 provider 前缀', () => {
    const problems = validateContributions([provider({ panels: [{ id: 'Log', title: '日志' }] })]);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain('panel id 不合法');
  });

  it('非法 provider id 不中断后续 provider 的校验——注册表要一次报全', () => {
    const problems = validateContributions([
      provider({ id: 'nope', kind: 'world' }),
      provider({ id: 'world:beta', label: '' }),
      provider({ id: 'world:gamma', panels: [{ id: 'x', title: '' }] }),
    ]);
    // 一次跑出三个 provider 各自的问题,而不是遇到第一个就停
    expect(problems.length).toBeGreaterThan(1);
    expect(problems.map((p) => p.pageId)).toEqual(['nope', 'world:beta', 'world:gamma']);
    expect(problems[0]?.message).toContain('provider id 不合法');
  });
});

// ---------------------------------------------------------------------------

describe('toPageManifest 序列化公开字段', () => {
  const full = (): ConsolePageContribution => ({
    id: 'world:alpha',
    kind: 'world',
    label: '阿尔法',
    badges: [{ label: '连接', value: 3, tone: 'on' }],
    panels: [{ id: 'log', title: '日志', description: '一句话' }],
    links: [{ label: '打开', href: '/alpha/page' }],
    config: [{
      id: 'alpha',
      owner: 'world:alpha',
      schema: {
        type: 'object',
        title: '阿尔法旋钮',
        properties: { 'alpha.speed': { type: 'integer', title: '速度' } },
      },
    }],
    promptDocs: [{
      key: 'worlds.alpha.main',
      title: '主提示词',
      description: '说明',
      path: 'C:\\secret\\x.md',
    }],
    storage: [{
      key: 'alpha.cache',
      label: '缓存',
      kind: 'disk',
      location: 'data/alpha',
      stat: () => '0 条',
      clear: () => '已清',
    }],
    invoke: async () => ({ ok: true }),
    availability: 'inactive',
    declared: true,
    reason: '没装',
    agentVisible: false,
    prefixDrifted: true,
  });

  it('本地绝对路径不上线', () => {
    expect(JSON.stringify(toPageManifest(full()))).not.toContain('secret');
  });

  it('promptDocs 只上线安全索引,本地路径与正文不上线', () => {
    const text = JSON.stringify(toPageManifest(full()));
    expect(text).not.toContain('promptDocs');
    expect(text).not.toContain('C:\\secret');
    expect(text).toContain('worlds.alpha.main');
  });

  it('config 只上线组 id(归属),schema 与属性名不上线——正文仍走 /api/config', () => {
    const m = toPageManifest(full());
    expect(m.configGroups).toEqual(['alpha']);
    const text = JSON.stringify(m);
    expect(text).not.toContain('阿尔法旋钮');
    expect(text).not.toContain('alpha.speed');
    expect(text).not.toContain('properties');
    expect(text).not.toContain('owner');
  });

  it('没声明 config 就没有 configGroups 键', () => {
    expect('configGroups' in toPageManifest(provider())).toBe(false);
  });

  it('storage 整块不上线', () => {
    expect(JSON.stringify(toPageManifest(full()))).not.toContain('storage');
  });

  it('invoke 是可执行的,连键名都不该出现', () => {
    expect(JSON.stringify(toPageManifest(full()))).not.toContain('invoke');
  });

  it('该上线的照常上线(不是靠删光字段过关的)', () => {
    expect(toPageManifest(full())).toEqual({
      id: 'world:alpha',
      kind: 'world',
      label: '阿尔法',
      availability: 'inactive',
      badges: [{ label: '连接', value: 3, tone: 'on' }],
      panels: [{ id: 'log', title: '日志', description: '一句话' }],
      configGroups: ['alpha'],
      prompts: [{ key: 'worlds.alpha.main', title: '主提示词', description: '说明' }],
      links: [{ label: '打开', href: '/alpha/page' }],
      declared: true,
      reason: '没装',
      agentVisible: false,
      prefixDrifted: true,
    });
  });

  it('availability 缺省为 active', () => {
    expect(toPageManifest(provider()).availability).toBe('active');
  });

  it('空数组字段不产生键(manifest 保持精简)', () => {
    const m = toPageManifest(provider({ badges: [], panels: [], links: [] }));
    expect(Object.keys(m).sort()).toEqual(['availability', 'id', 'kind', 'label']);
    expect('badges' in m).toBe(false);
    expect('panels' in m).toBe(false);
    expect('links' in m).toBe(false);
  });

  it('传 client 时原样带上', () => {
    const client = { js: '/assets/providers/worlds-alpha-1.js', css: '/assets/providers/worlds-alpha-1.css' };
    expect(toPageManifest(provider(), client).client).toEqual(client);
  });

  it('不传 client 时没有 client 键(前端据此把 panel 渲染成"扩展未构建")', () => {
    expect('client' in toPageManifest(provider())).toBe(false);
  });

  it('panel 的 description 有则带', () => {
    const m = toPageManifest(provider({ panels: [{ id: 'log', title: '日志', description: '说明' }] }));
    expect(m.panels).toEqual([{ id: 'log', title: '日志', description: '说明' }]);
  });

  it('panel 的 description 无则不带键', () => {
    const m = toPageManifest(provider({ panels: [{ id: 'log', title: '日志' }] }));
    expect(m.panels?.[0] && 'description' in m.panels[0]).toBe(false);
  });
});

// ---------------------------------------------------------------------------

/** 非法 builtin 名仅过滤对应面板，其余声明保留。 */
describe('内置面板声明', () => {
  const withBuiltin = (builtin: unknown) =>
    toPageManifest(provider({
      panels: [{ id: 'settings', title: '设置', builtin: builtin as string }],
    }));

  it('合法名字原样投影,与 id / title 并列', () => {
    expect(withBuiltin('llm-settings').panels).toEqual([
      { id: 'settings', title: '设置', builtin: 'llm-settings' },
    ]);
  });

  it('不声明 builtin 的面板不带这个键(前端据此去取这一页自己的扩展)', () => {
    const m = toPageManifest(provider({ panels: [{ id: 'log', title: '日志' }] }));
    expect(m.panels?.[0] && 'builtin' in m.panels[0]).toBe(false);
  });

  it('名字不合法的那块面板整块丢掉,同页其余面板照常上线', () => {
    for (const bad of ['', '9lives', 'LLM-Settings', 'llm settings', 'llm/settings', '-x', 42, null, {}]) {
      const m = toPageManifest(provider({
        panels: [
          { id: 'settings', title: '设置', builtin: bad as string },
          { id: 'log', title: '日志' },
        ],
      }));
      expect([bad, m.panels]).toEqual([bad, [{ id: 'log', title: '日志' }]]);
    }
  });

  it('全部面板都因内置名写歪被丢掉时不留空数组键', () => {
    expect('panels' in withBuiltin('Nope')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('运行期形状判定', () => {
  it('isBinaryResult 认 { $binary: { mime, base64 } }', () => {
    expect(isBinaryResult({ $binary: { mime: 'audio/wav', base64: 'x' } })).toBe(true);
  });

  it('isBinaryResult 拒 null / 空对象 / 空 $binary / base64 非字符串', () => {
    expect(isBinaryResult(null)).toBe(false);
    expect(isBinaryResult(undefined)).toBe(false);
    expect(isBinaryResult({})).toBe(false);
    expect(isBinaryResult({ $binary: {} })).toBe(false);
    expect(isBinaryResult({ $binary: { base64: 123 } })).toBe(false);
    expect(isBinaryResult('x')).toBe(false);
  });

  it('isFileResult 要求文件大小与小写 sha256 都随路径传入', async () => {
    const { isFileResult } = await import('../../src/web/shared/console-protocol.ts');
    const sha256 = 'a'.repeat(64);
    expect(isFileResult({
      $file: { mime: 'audio/wav', path: 'C:\\clip.wav', bytes: 42, sha256 },
    })).toBe(true);
    expect(isFileResult({ $file: { mime: 'audio/wav', path: '/clip.wav' } })).toBe(false);
    expect(isFileResult({
      $file: { mime: 'audio/wav', path: '/clip.wav', bytes: -1, sha256 },
    })).toBe(false);
    expect(isFileResult({
      $file: { mime: 'audio/wav', path: '/clip.wav', bytes: 42, sha256: 'A'.repeat(64) },
    })).toBe(false);
  });

  it('isConsoleClientBundle 认 { panels: {} }', async () => {
    const { isConsoleClientBundle } = await loadClientBundle();
    expect(isConsoleClientBundle({ panels: {} })).toBe(true);
    expect(isConsoleClientBundle({ panels: { log: { mount() {} } } })).toBe(true);
  });

  it('isConsoleClientBundle 拒 null / 空对象 / panels 为 null / 字符串', async () => {
    const { isConsoleClientBundle } = await loadClientBundle();
    expect(isConsoleClientBundle(null)).toBe(false);
    expect(isConsoleClientBundle(undefined)).toBe(false);
    expect(isConsoleClientBundle({})).toBe(false);
    expect(isConsoleClientBundle({ panels: null })).toBe(false);
    expect(isConsoleClientBundle('extension')).toBe(false);
  });

  it('toDisposable 的 dispose 幂等(unmount 路径上重复调不会跑两遍清理)', async () => {
    const { toDisposable } = await loadClientBundle();
    let n = 0;
    const d = toDisposable(() => { n += 1; });
    d.dispose();
    d.dispose();
    d.dispose();
    expect(n).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('状态灯', () => {
  const withLamps = (lamps: unknown): ConsolePageContribution => ({
    id: 'world:alpha',
    kind: 'world',
    label: '阿尔法',
    lamps: lamps as ConsolePageContribution['lamps'],
  });

  it.each(['online', 'loading', 'error', 'offline'] as const)('四态原样上线:%s', (state) => {
    expect(toPageManifest(withLamps([{ label: '链路', state }])).lamps)
      .toEqual([{ label: '链路', state }]);
  });

  it('一条链路一颗,顺序原样(那是 World 自己排的)', () => {
    const lamps = [
      { label: '甲', state: 'online' as const },
      { label: '乙', state: 'error' as const, hint: '连不上' },
      { label: '丙', state: 'offline' as const },
    ];
    expect(toPageManifest(withLamps(lamps)).lamps).toEqual(lamps);
  });

  it('hint 跟着灯走;空 hint 不占字段', () => {
    expect(toPageManifest(withLamps([{ label: '甲', state: 'error', hint: '' }])).lamps)
      .toEqual([{ label: '甲', state: 'error' }]);
  });

  it.each([
    ['写歪的 state', { label: '甲', state: 'green' }],
    ['缺 state', { label: '甲' }],
    ['缺 label(说不出自己是哪条链路)', { state: 'online' }],
    ['label 是空串', { label: '', state: 'online' }],
    ['不是对象', 'online'],
    ['null', null],
  ])('%s → 这一颗丢掉,同排其余的照上', (_why, bad) => {
    const good = { label: '好的', state: 'online' as const };
    expect(toPageManifest(withLamps([bad, good])).lamps).toEqual([good]);
  });

  it('超过上限的截掉:一行放不下那么多点', () => {
    const many = Array.from({ length: LAMP_MAX + 3 }, (_v, i) => ({
      label: `第${i}条`, state: 'online' as const,
    }));
    const out = toPageManifest(withLamps(many)).lamps ?? [];
    expect(out).toHaveLength(LAMP_MAX);
    expect(out[0].label).toBe('第0条');
  });

  it('不是数组 / 空数组 / 不报 → manifest 里没有这个字段(框架据此决定不画)', () => {
    expect(toPageManifest(withLamps('online')).lamps).toBeUndefined();
    expect(toPageManifest(withLamps([])).lamps).toBeUndefined();
    expect(toPageManifest({ id: 'world:alpha', kind: 'world', label: '阿尔法' }).lamps).toBeUndefined();
  });
});

describe('Memory 页', () => {
  it('memory:<name> 是合法 page id,浏览器产物与同名 persona 页共用一份', async () => {
    const { parsePageId, assetKeyForPage } = await import('../../src/web/shared/console-protocol.ts');
    expect(parsePageId('memory:demo')).toEqual({ kind: 'memory', name: 'demo' });
    expect(assetKeyForPage('memory:demo')).toBe('persona:demo');
    expect(assetKeyForPage('persona:demo')).toBe('persona:demo');
    expect(assetKeyForPage('world:qq')).toBe('world:qq');
  });
});
