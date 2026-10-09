/** 服务端注入进首页的两样：`<html lang>` 与部署主题（默认方案 + 已保存的记录）。 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebApp } from '../../src/web/server.ts';
import { THEME_FILE } from '../../src/web/theme-store.ts';
import { THEME_SCRIPT_ID, type InjectedTheme } from '../../src/web/shared/theme.ts';
import { nullLogger } from '../../src/core/util.ts';
import { FakeStore } from './fakes.ts';
import type { Language } from '../../src/core/language.ts';

const dirs: string[] = [];
const apps: WebApp[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function serve(
  opts: { language?: Language; defaultScheme?: string; themeFile?: string },
): Promise<{ openTag: string; injected: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'webtest-index-'));
  dirs.push(dir);
  if (opts.themeFile !== undefined) writeFileSync(join(dir, THEME_FILE), opts.themeFile, 'utf8');
  const app = new WebApp({
    store: new FakeStore(),
    memoryDir: dir,
    dataDir: dir,
    log: nullLogger(),
    getStatus: () => ({}),
    botDir: dir,
    ...(opts.language ? { language: opts.language } : {}),
    ...(opts.defaultScheme ? { defaultScheme: opts.defaultScheme } : {}),
  });
  apps.push(app);
  const port = await app.start(0);
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  const script = new RegExp(`<script type="application/json" id="${THEME_SCRIPT_ID}">(.*?)</script>`, 's')
    .exec(html);
  return { openTag: /<html[^>]*>/.exec(html)?.[0] ?? '', injected: script?.[1] ?? '' };
}

describe('首页注入', () => {
  it('开标签只带语言', async () => {
    expect((await serve({ language: 'en' })).openTag).toBe('<html lang="en">');
    expect((await serve({ language: 'zh' })).openTag).toBe('<html lang="zh-CN">');
    expect((await serve({ language: 'ja' })).openTag).toBe('<html lang="ja">');
  });

  it('部署还没保存过配色：默认方案照发,记录是 null', async () => {
    const { injected } = await serve({ defaultScheme: 'crab-daisy' });
    expect(JSON.parse(injected) as InjectedTheme).toEqual({ defaultScheme: 'crab-daisy', theme: null });
  });

  it('部署保存过：记录随首页发出,颜色已规范化', async () => {
    const { injected } = await serve({
      defaultScheme: 'mint',
      themeFile: JSON.stringify({ selectedId: 'navigator', mode: 'dark', custom: [] }),
    });
    const value = JSON.parse(injected) as InjectedTheme;
    expect(value.theme).toEqual({ selectedId: 'navigator', mode: 'dark', custom: [] });
  });

  it('theme.json 坏了：按没有记录发,首页仍然出得来', async () => {
    const { injected } = await serve({ defaultScheme: 'mint', themeFile: '{ 这不是 JSON' });
    expect((JSON.parse(injected) as InjectedTheme).theme).toBe(null);
  });

  it('自定义方案名里的 `</script>` 不会提前闭合那个标签', async () => {
    const name = '</script><script>alert(1)</script>';
    const { injected } = await serve({
      themeFile: JSON.stringify({ selectedId: 'x', mode: 'light', custom: [{ id: 'x', name }] }),
    });
    expect(injected).not.toContain('</script>');
    expect((JSON.parse(injected) as InjectedTheme).theme?.custom[0].name).toBe(name);
  });
});
