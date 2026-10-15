/**
 * 内核页面表(`main.ts` 的 `FEATURES`)必须收录 `features/<dir>/index.ts` 导出的每一个
 * framework feature。路由分派只认这张表:漏掉一项,那一页就从 WebUI 上消失——
 * `hidden` 的页面(设置页里嵌着的那几节)也不例外,它们的直达路由同样靠这张表。
 */
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const FEATURES_DIR = resolve(process.cwd(), 'src/web/client/features');
const MAIN = '../../src/web/client/main.ts';

type Any = any;

describe('内核页面表', () => {
  it('收录每个 feature 目录导出的 feature,且路由互不重复', async () => {
    const { FEATURES } = (await import(MAIN)) as Any;
    const dirs = readdirSync(FEATURES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    expect(dirs.length).toBeGreaterThan(0);
    const declared: Array<{ dir: string; route: string }> = [];
    for (const dir of dirs) {
      const mod = (await import(pathToFileURL(resolve(FEATURES_DIR, dir, 'index.ts')).href)) as Record<string, unknown>;
      for (const [name, value] of Object.entries(mod)) {
        if (!name.endsWith('Feature')) continue;
        const feature = value as { route?: unknown; mount?: unknown };
        if (typeof feature?.route !== 'string' || typeof feature.mount !== 'function') continue;
        declared.push({ dir, route: feature.route });
        expect(FEATURES, `${dir}/index.ts 的 ${name} 不在 main.ts 的 FEATURES 里`).toContain(value);
      }
    }
    expect(declared.length).toBe(FEATURES.length);
    const routes = FEATURES.map((f: { route: string }) => f.route);
    expect(new Set(routes).size).toBe(routes.length);
    expect(routes).not.toContain('provider');
  });
});
