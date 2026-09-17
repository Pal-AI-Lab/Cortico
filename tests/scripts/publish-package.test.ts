/** 发布清单要覆盖扩展契约的传递依赖，exports 要把模板用的说明符解析到包内文件。 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PACKAGE_NAME,
  buildManifest,
  corticoEntries,
  importClosure,
  missingDependencies,
  type RootPackageJson,
} from '../../scripts/publish-package.ts';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const SRC = join(REPO_ROOT, 'src');
const TEMPLATES = join(REPO_ROOT, 'templates', 'extension');
const root = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as RootPackageJson;

describe('publish-package', () => {
  it('exports 把模板用到的每个说明符解析到包内文件', () => {
    const pattern = buildManifest(root).exports['./*'] as string;
    const entries = corticoEntries(TEMPLATES);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const inPackage = pattern.replace('*', entry);
      expect(existsSync(join(REPO_ROOT, inPackage)), inPackage).toBe(true);
    }
  });

  it('清单声明了契约闭包触及的每个第三方包', () => {
    const { externals } = importClosure(SRC, corticoEntries(TEMPLATES));
    expect(externals.length).toBeGreaterThan(0);
    expect(missingDependencies(buildManifest(root), externals)).toEqual([]);
  });

  it('版本与依赖范围取自仓库根清单', () => {
    const manifest = buildManifest(root);
    expect(manifest.version).toBe(root.version);
    for (const [name, range] of Object.entries(manifest.dependencies)) {
      expect(range).toBe(root.dependencies[name] ?? root.devDependencies[name]);
    }
  });

  it('模板声明的 cortico 范围跟着仓库版本', () => {
    for (const kind of ['bot', 'world', 'provider']) {
      const pkg = JSON.parse(readFileSync(join(TEMPLATES, kind, 'package.json'), 'utf8')) as {
        devDependencies: Record<string, string>;
      };
      expect(pkg.devDependencies[PACKAGE_NAME], kind).toBe(`^${root.version}`);
    }
  });
});
