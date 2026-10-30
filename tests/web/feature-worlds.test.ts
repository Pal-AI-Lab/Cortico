/** World 页源码的架构约束；页面行为由 feature-world-library.test.ts 在 jsdom 里验证。 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

describe('feature 契约', () => {
  it('源码里没有裸 setInterval / setTimeout，不碰 document.body 与 window.__，也不自己 fetch', () => {
    const dir = 'src/web/client/features/worlds';
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts')) continue;
      // 架构约束只检查可执行源码，忽略注释。
      const src = readFileSync(`${dir}/${name}`, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect(src, name).not.toMatch(/(^|[^.\w])setInterval\s*\(/);
      expect(src, name).not.toMatch(/(^|[^.\w])setTimeout\s*\(/);
      expect(src, name).not.toMatch(/document\s*\.\s*body/);
      expect(src, name).not.toMatch(/window\s*\.\s*__/);
      expect(src, name).not.toMatch(/(^|[^.\w])fetch\s*\(/);
    }
  });
});
