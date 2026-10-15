/** 启动器菜单的数据：展示名的来路、每份部署的配色，以及代码包读不出来时那一行。 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildListing, colorsOf, type BotDefaults } from '../src/deploy-listing.ts';
import { BUILTIN_PALETTES } from '../src/web/shared/theme.ts';
import { THEME_FILE } from '../src/web/theme-store.ts';

const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 一个部署根，按 `{ 部署名: 目录里的文件 }` 铺好。 */
function root(layout: Record<string, Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'listing-'));
  roots.push(dir);
  for (const [name, files] of Object.entries(layout)) {
    mkdirSync(join(dir, name), { recursive: true });
    for (const [file, value] of Object.entries(files)) {
      writeFileSync(join(dir, name, file), JSON.stringify(value), 'utf8');
    }
  }
  return dir;
}

const DEFAULTS: Record<string, BotDefaults> = {
  cortiv: { displayName: '可缇Corti', scheme: 'navigator' },
  cormini: { displayName: '可缇mini', scheme: 'mint' },
};

async function defaultsOf(bot: string): Promise<BotDefaults> {
  const hit = DEFAULTS[bot];
  if (!hit) throw new Error(`找不到 bot 代码包「${bot}」`);
  return hit;
}

describe('取色', () => {
  it('部署存过配色就用存的那份,认不出的方案 id 落到框架默认方案', () => {
    const dir = root({ a: { [THEME_FILE]: { selectedId: 'crab-daisy', mode: 'system', custom: [] } } });
    expect(colorsOf(join(dir, 'a'), 'navigator').accent).toBe(BUILTIN_PALETTES['crab-daisy'].dark.accent);
    expect(colorsOf(join(dir, 'a'), '没这个方案').accent).toBe(BUILTIN_PALETTES['crab-daisy'].dark.accent);
    expect(colorsOf(null, '也没这个').accent).toBe(BUILTIN_PALETTES.mint.dark.accent);
  });

  it('命令行按深色底算;钉在浅色的部署才取浅色那份', () => {
    const dark = root({ a: { [THEME_FILE]: { selectedId: 'mint', mode: 'dark', custom: [] } } });
    const light = root({ a: { [THEME_FILE]: { selectedId: 'mint', mode: 'light', custom: [] } } });
    expect(colorsOf(join(dark, 'a'), 'mint').accent).toBe(BUILTIN_PALETTES.mint.dark.accent);
    expect(colorsOf(join(light, 'a'), 'mint').accent).toBe(BUILTIN_PALETTES.mint.light.accent);
  });

  it('自定义方案照样跟得到', () => {
    const custom = { id: 'mine', name: '我的', note: '', palettes: { dark: { accent: '#ff00aa' } } };
    const dir = root({ a: { [THEME_FILE]: { selectedId: 'mine', mode: 'dark', custom: [custom] } } });
    expect(colorsOf(join(dir, 'a'), 'mint').accent).toBe('#ff00aa');
  });
});

describe('部署清单', () => {
  it('展示名取部署配置,没写就用代码包默认;路径相对部署根', async () => {
    const dir = root({
      named: { 'deployment.json': { bot: 'cortiv' }, 'config.json': { displayName: '值班的那位' } },
      plain: { 'deployment.json': { bot: 'cormini' } },
    });
    const listing = await buildListing({ root: dir, deployments: ['named', 'plain'], packages: [], defaultsOf });
    expect(listing.deployments.map((d) => d.displayName)).toEqual(['值班的那位', '可缇mini']);
    expect(listing.deployments[0].dir.endsWith('/named')).toBe(true);
    expect(listing.root).toBe(dir);
  });

  it('配色:部署 config.json 的 web.theme 压过代码包选的方案', async () => {
    const dir = root({
      a: { 'deployment.json': { bot: 'cortiv' } },
      b: { 'deployment.json': { bot: 'cortiv' }, 'config.json': { web: { theme: 'crab-daisy' } } },
    });
    const listing = await buildListing({ root: dir, deployments: ['a', 'b'], packages: [], defaultsOf });
    expect(listing.deployments[0].colors.accent).toBe(BUILTIN_PALETTES.navigator.dark.accent);
    expect(listing.deployments[1].colors.accent).toBe(BUILTIN_PALETTES['crab-daisy'].dark.accent);
  });

  it('代码包读不出来:这一行仍然列出,带上原因', async () => {
    const dir = root({ ghosted: { 'deployment.json': { bot: 'ghost' } } });
    const listing = await buildListing({ root: dir, deployments: ['ghosted'], packages: [], defaultsOf });
    expect(listing.deployments[0].problem).toContain('ghost');
    expect(listing.deployments[0].displayName).toBe('');
    expect(listing.deployments[0].colors.accent).toBe(BUILTIN_PALETTES.mint.dark.accent);
  });

  it('装不上的代码包不进新建部署的候选', async () => {
    const dir = root({});
    const listing = await buildListing({
      root: dir,
      deployments: [],
      packages: [{ id: 'cortiv', source: 'tree' }, { id: 'ghost', source: 'extension' }],
      defaultsOf,
    });
    expect(listing.packages.map((p) => p.id)).toEqual(['cortiv']);
    expect(listing.packages[0].colors.accent).toBe(BUILTIN_PALETTES.navigator.dark.accent);
  });

  it('同一个代码包只读一次', async () => {
    const dir = root({
      a: { 'deployment.json': { bot: 'cortiv' } },
      b: { 'deployment.json': { bot: 'cortiv' } },
    });
    let reads = 0;
    await buildListing({
      root: dir,
      deployments: ['a', 'b'],
      packages: [{ id: 'cortiv', source: 'tree' }],
      defaultsOf: async (bot) => { reads += 1; return defaultsOf(bot); },
    });
    expect(reads).toBe(1);
  });
});
