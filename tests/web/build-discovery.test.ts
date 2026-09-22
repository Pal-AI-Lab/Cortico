/**
 * 浏览器端入口发现只认目录约定:World 把 client.ts 放进自己的 console/ 就被收进
 * 构建,构建脚本里不存在任何 World 名单。asset key 由目录名推导,World 无法自选。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWeb, discoverEntries } from '../../scripts/build-web.ts';
import { webAssetsProblem } from '../../bin/web-assets.mjs';

let root: string;

/** 造一个入口文件,连同它的目录。 */
const put = (rel: string) => {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, 'export {};\n', 'utf8');
  return abs;
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cortico-web-discovery-'));
  put('src/web/client/main.ts');
  put('src/worlds/fake/console/client.ts');
  put('bots/fake/console/client.ts');
  // 没有 console/client.ts 的 World 不该被收进来。
  mkdirSync(join(root, 'src', 'worlds', 'headless', 'core'), { recursive: true });
  mkdirSync(join(root, 'bots', 'headless', 'core'), { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('discoverEntries', () => {
  it('按目录约定收入口,key 从目录名推导', () => {
    const entries = discoverEntries(root);
    // core 固定在首位,其余按 key 排序:persona: 排在 world: 前
    expect(entries.map((e) => e.key)).toEqual(['core', 'persona:fake', 'world:fake']);
    expect(entries.map((e) => e.entry)).toEqual([
      join(root, 'src/web/client/main.ts'),
      join(root, 'bots/fake/console/client.ts'),
      join(root, 'src/worlds/fake/console/client.ts'),
    ]);
  });

  it('没有 console/client.ts 的 World 目录不产生入口', () => {
    const keys = discoverEntries(root).map((e) => e.key);
    expect(keys).not.toContain('world:headless');
    expect(keys).not.toContain('persona:headless');
  });

  it('空仓(无任何入口)返回空数组而不是抛错', () => {
    const empty = mkdtempSync(join(tmpdir(), 'cortico-web-empty-'));
    try {
      expect(discoverEntries(empty)).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

});

describe('buildWeb', () => {
  it('清单记下入口及其导入的仓库内源文件', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'cortico-web-build-'));
    try {
      mkdirSync(join(repo, 'src', 'web', 'client'), { recursive: true });
      writeFileSync(join(repo, 'src', 'web', 'client', 'main.ts'), "import { x } from './dep.ts';\nconsole.log(x);\n", 'utf8');
      writeFileSync(join(repo, 'src', 'web', 'client', 'dep.ts'), 'export const x = 1;\n', 'utf8');
      const manifest = await buildWeb(repo);
      expect(Object.keys(manifest.sources ?? {})).toEqual(['src/web/client/dep.ts', 'src/web/client/main.ts']);
      // 样式表由 Tailwind 那一步写出。
      writeFileSync(join(repo, 'dist', 'web', 'styles.css'), 'body{}\n', 'utf8');
      expect(webAssetsProblem(repo)).toBeNull();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
