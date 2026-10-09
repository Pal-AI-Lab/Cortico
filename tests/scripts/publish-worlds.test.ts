/** 内建 World 生成的扩展包:源码引用都改写得成框架 import,第三方依赖都在仓库根的 dependencies 里。 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WORLD_PACKAGES, planWorldPackage } from '../../scripts/publish-worlds.ts';
import type { RootPackageJson } from '../../scripts/publish-package.ts';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const root = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as RootPackageJson;

describe('publish-worlds', () => {
  for (const { id } of WORLD_PACKAGES) {
    it(`${id}: 跳出 World 目录的引用都指向 src 下存在的文件,第三方包都是运行时依赖`, () => {
      const plan = planWorldPackage(id);
      expect(plan.problems).toEqual([]);
      expect(plan.externals.filter((name) => root.dependencies[name] === undefined)).toEqual([]);
    });
  }
});
