/**
 * 在临时目录写入真实 asset-manifest.json，验证文件读取到 provider manifest 的拒绝路径。
 * 无效 asset 使 forPage() 返回 undefined 并记录日志；provider 仍出现在 manifest 中，但没有 client 字段。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebUiAssets, WebUiPageRegistry, type WebUiPageSource } from '../../src/web/webui-pages.ts';
import { WEBUI_PROTOCOL_VERSION, type WebUiPageContribution } from '../../src/web/shared/webui-protocol.ts';
import type { Logger } from '../../src/core/types.ts';

let dir: string;
let seq = 0;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'webtest-hardening-assets-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface RecLogger extends Logger {
  errors: { msg: string; data?: unknown }[];
}

function recLogger(): RecLogger {
  const errors: { msg: string; data?: unknown }[] = [];
  const l = {
    errors,
    trace: () => {},
    emit: (level: string, msg: string, o?: { data?: unknown }) => { if (level === 'error') errors.push({ msg, data: o?.data }); },
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (msg: string, data?: unknown) => { errors.push({ msg, data }); },
    child: () => l,
  } as RecLogger;
  return l;
}

/** 写一个真的 asset-manifest.json 到临时目录，返回那个目录。 */
function distWith(raw: unknown): string {
  const d = join(dir, `dist-${seq++}`);
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, 'asset-manifest.json'),
    typeof raw === 'string' ? raw : JSON.stringify(raw),
    'utf8',
  );
  return d;
}

function assetsWith(raw: unknown): { assets: WebUiAssets; log: RecLogger } {
  const log = recLogger();
  return { assets: new WebUiAssets(distWith(raw), log), log };
}

const GOOD = '/assets/worlds/demo/client.a1b2c3.js';

/**
 * 被人手改坏的 `js` 值。每一条都是一种**跳出 `/assets/` 的写法**，
 * 分组是为了在失败时一眼看出漏的是哪一类。
 */
const EVIL_JS: readonly (readonly [string, unknown])[] = [
  ['相对回溯', '../../evil.js'],
  ['前缀内回溯', '/assets/../../etc/passwd'],
  ['单段回溯', '/assets/../secret.js'],
  ['尾部回溯', '/assets/x/..'],
  ['百分号编码回溯', '/assets/%2e%2e/%2e%2e/etc/passwd'],
  ['百分号编码斜杠', '/assets/..%2f..%2fx.js'],
  ['file 协议', 'file:///C:/Windows/evil.js'],
  ['Windows 盘符', 'C:\\Windows\\evil.js'],
  ['反斜杠回溯', '/assets/..\\..\\evil.js'],
  ['外站 http', 'http://evil.example/x.js'],
  ['外站 https', 'https://cdn.evil.example/x.js'],
  ['协议相对', '//evil.example/x.js'],
  ['同名前缀但不同目录', '/assetsevil/x.js'],
  ['别的目录', '/other/x.js'],
  ['执行类协议', 'javascript:alert(1)'],
  ['data 协议', 'data:text/javascript,alert(1)'],
  ['带查询串', '/assets/x.js?v=1'],
  ['带片段', '/assets/x.js#frag'],
  ['换行(响应头注入面)', '/assets/x\n.js'],
  ['空字节', '/assets/x\u0000.js'],
  ['空串', ''],
  ['只有前缀', '/assets/'],
  ['数字', 123],
  ['null', null],
  ['对象', { js: '/assets/x.js' }],
];

describe('asset-manifest 被改坏时的拒绝面', () => {
  it('合法条目照常放行（对照组：闸门不是"一律拒"）', () => {
    const { assets, log } = assetsWith({
      protocolVersion: 1,
      core: '/assets/webui.f00d.js',
      providers: { 'world:demo': { js: GOOD, css: '/assets/worlds/demo/client.a1b2c3.css' } },
    });
    expect(assets.forPage('world:demo')).toEqual({
      js: GOOD,
      css: '/assets/worlds/demo/client.a1b2c3.css',
    });
    expect(assets.core()).toBe('/assets/webui.f00d.js');
    expect(log.errors).toEqual([]);
  });

  it.each([undefined, WEBUI_PROTOCOL_VERSION + 1])('协议版本 %s 拒绝整张资产表', (protocolVersion) => {
    const { assets, log } = assetsWith({ protocolVersion, core: '/assets/webui.js', providers: { 'world:demo': { js: GOOD } } });
    expect(assets.core()).toBeNull();
    expect(assets.forPage('world:demo')).toBeUndefined();
    expect(log.errors).toHaveLength(1);
    expect(log.errors[0].msg).toContain('协议版本');
  });

  for (const [name, js] of EVIL_JS) {
    it(`js 被拒：${name}`, () => {
      const { assets, log } = assetsWith({
        protocolVersion: 1,
        core: null,
        providers: { 'world:demo': { js } },
      });
      // 拒得干净：不是"退回一个安全的默认路径"，而是当作这个 provider 没有扩展
      expect([name, assets.forPage('world:demo')]).toEqual([name, undefined]);
      // 但要留下痕迹
      expect([name, log.errors.length]).toEqual([name, 1]);
      expect(String(log.errors[0]?.msg)).toContain('world:demo');
    });
  }

  it('一个坏条目不牵连同一份 manifest 里的好条目', () => {
    const { assets, log } = assetsWith({
      protocolVersion: 1,
      core: null,
      providers: {
        'world:bad': { js: '/assets/../../etc/passwd' },
        'world:good': { js: GOOD },
        'persona:demo': { js: '/assets/persona-demo/client.js' },
      },
    });
    expect(assets.forPage('world:bad')).toBeUndefined();
    expect(assets.forPage('world:good')).toEqual({ js: GOOD });
    expect(assets.forPage('persona:demo')).toEqual({ js: '/assets/persona-demo/client.js' });
    expect(log.errors).toHaveLength(1);
  });

  it('css 不合法只丢 css，js 照常可用（样式坏掉不该让面板整个打不开）', () => {
    const { assets, log } = assetsWith({
      protocolVersion: 1,
      core: null,
      providers: { 'world:demo': { js: GOOD, css: 'https://cdn.evil.example/x.css' } },
    });
    expect(assets.forPage('world:demo')).toEqual({ js: GOOD });
    expect(log.errors).toHaveLength(1);
    expect(String(log.errors[0]?.msg)).toContain('css');
  });

  it('core 不合法 → core() 给 null 并记一条日志', () => {
    const { assets, log } = assetsWith({
      protocolVersion: 1,
      core: 'http://evil.example/webui.js',
      providers: {},
    });
    expect(assets.core()).toBeNull();
    expect(log.errors).toHaveLength(1);
    expect(String(log.errors[0]?.msg)).toContain('core');
  });

  it('core 本来就是 null（没构建过）不算错误，不记日志', () => {
    const { assets, log } = assetsWith({ protocolVersion: 1, core: null, providers: {} });
    expect(assets.core()).toBeNull();
    expect(log.errors).toEqual([]);
  });

  it('未知 key：只按 key 查表，查不到就是没有——不拼路径、不模糊匹配', () => {
    const { assets } = assetsWith({
      protocolVersion: 1,
      core: null,
      providers: { 'world:other': { js: GOOD } },
    });
    expect(assets.forPage('world:demo')).toBeUndefined();
    // 不同 kind 的同名 provider 也不该串味
    expect(assets.forPage('persona:other')).toBeUndefined();
    // 大小写、前后缀都不做归一
    expect(assets.forPage('IO:OTHER')).toBeUndefined();
    expect(assets.forPage('other')).toBeUndefined();
  });

  /** 资源表仅返回自有条目，原型键返回 undefined。 */
  it('资源查询仅返回自有条目，原型键返回 undefined', () => {
    const { assets } = assetsWith({
      protocolVersion: 1,
      core: null,
      providers: { 'world:other': { js: GOOD } },
    });
    // 不变式：任何合法 id 都只能命中表里真有的那一个
    for (const id of ['world:demo', 'world:constructor', 'persona:tostring', 'world:proto']) {
      expect([id, assets.forPage(id)]).toEqual([id, undefined]);
    }
    for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect([key, assets.forPage(key)]).toEqual([key, undefined]);
    }
  });

  it('entry 不是对象（整段被写成字符串/数组）也拒得掉', () => {
    for (const entry of ['/assets/x.js', ['/assets/x.js'], 42, null, true]) {
      const { assets } = assetsWith({ protocolVersion: 1, core: null, providers: { 'world:demo': entry } });
      expect([entry, assets.forPage('world:demo')]).toEqual([entry, undefined]);
    }
  });

  it('providers 整个缺失 / 不是对象 → 空表，不抛', () => {
    for (const raw of [
      { protocolVersion: 1, core: null },
      { protocolVersion: 1, core: null, providers: null },
      {},
    ]) {
      const { assets } = assetsWith(raw);
      expect(assets.forPage('world:demo')).toBeUndefined();
    }
  });

  it('文件是坏 JSON → 全表作废并记日志，WebUI 照常起（不抛）', () => {
    const { assets, log } = assetsWith('{ 这不是 JSON');
    expect(assets.core()).toBeNull();
    expect(assets.forPage('world:demo')).toBeUndefined();
    expect(log.errors).toHaveLength(1);
    expect(String(log.errors[0]?.msg)).toContain('解析失败');
  });

  it('文件根本不存在（还没 build）不是错误：空表且不记日志', () => {
    const empty = join(dir, `no-dist-${seq++}`);
    mkdirSync(empty, { recursive: true });
    const log = recLogger();
    const assets = new WebUiAssets(empty, log);
    expect(assets.core()).toBeNull();
    expect(assets.forPage('world:demo')).toBeUndefined();
    expect(log.errors).toEqual([]);
  });

  it('reload() 重读文件：坏的换成好的之后当场生效', () => {
    const d = distWith({ protocolVersion: 1, core: null, providers: { 'world:demo': { js: 'http://evil/x.js' } } });
    const log = recLogger();
    const assets = new WebUiAssets(d, log);
    expect(assets.forPage('world:demo')).toBeUndefined();

    writeFileSync(
      join(d, 'asset-manifest.json'),
      JSON.stringify({ protocolVersion: 1, core: null, providers: { 'world:demo': { js: GOOD } } }),
      'utf8',
    );
    assets.reload();
    expect(assets.forPage('world:demo')).toEqual({ js: GOOD });
  });
});

// ---------------------------------------------------------------------------
// 端到端：坏 asset 之后 provider 在 manifest 里还剩什么
// ---------------------------------------------------------------------------

function sourceOf(c: WebUiPageContribution): WebUiPageSource {
  return { id: c.id, contribute: () => c };
}

const DEMO: WebUiPageContribution = {
  id: 'world:demo',
  kind: 'world',
  label: '验收 Demo',
  badges: [{ label: '握手', value: 3, tone: 'on' }],
  panels: [{ id: 'gate', title: '接入' }, { id: 'echo', title: '回声' }],
};

function registryWith(raw: unknown): { registry: WebUiPageRegistry; log: RecLogger } {
  const log = recLogger();
  const assets = new WebUiAssets(distWith(raw), log);
  const registry = new WebUiPageRegistry({
    sources: () => [sourceOf(DEMO), sourceOf({ id: 'world:other', kind: 'world', label: '另一个' })],
    capabilities: () => ({}),
    assets,
    log,
  });
  return { registry, log };
}

describe('坏 asset 之后 provider 仍在 manifest 里', () => {
  it('js 被拒时：provider、label、badges、panels 全在，只是没有 client', async () => {
    const { registry } = registryWith({
      protocolVersion: 1,
      core: null,
      providers: { 'world:demo': { js: '/assets/%2e%2e/%2e%2e/etc/passwd' } },
    });
    const m = await registry.manifest();
    const demo = m.providers.find((p) => p.id === 'world:demo');
    expect(demo).toBeTruthy();
    expect(demo?.label).toBe('验收 Demo');
    expect(demo?.badges).toEqual([{ label: '握手', value: 3, tone: 'on' }]);
    expect(demo?.panels?.map((p) => p.id)).toEqual(['gate', 'echo']);
    // 关键：面板声明还在，扩展地址没有——前端据此渲染"扩展未构建"的错误卡
    expect(demo?.client).toBeUndefined();
  });

  it('坏条目不影响同一份 manifest 里另一个 provider 拿到自己的 client', async () => {
    const { registry } = registryWith({
      protocolVersion: 1,
      core: null,
      providers: {
        'world:demo': { js: 'file:///C:/x.js' },
        'world:other': { js: '/assets/worlds/other/client.js' },
      },
    });
    const m = await registry.manifest();
    expect(m.providers.find((p) => p.id === 'world:demo')?.client).toBeUndefined();
    expect(m.providers.find((p) => p.id === 'world:other')?.client).toEqual({
      js: '/assets/worlds/other/client.js',
    });
  });

  it('整份 asset-manifest 坏掉时所有 provider 照常上线，只是全都没有扩展', async () => {
    const { registry } = registryWith('}{ 坏文件');
    const m = await registry.manifest();
    expect(m.providers.map((p) => p.id)).toEqual(['world:demo', 'world:other']);
    expect(m.providers.every((p) => p.client === undefined)).toBe(true);
  });
});
