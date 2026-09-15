/** 完整 = 清单、样式表,以及清单引用到的每个文件都在;缺哪个就报哪个。 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webAssetsProblem } from '../../bin/web-assets.mjs';

let dir: string;

/** 造一份完整产物:清单、样式表,以及清单引用到的两个文件。 */
function buildComplete(): void {
  writeFileSync(join(dir, 'styles.css'), 'body{}\n', 'utf8');
  mkdirSync(join(dir, 'providers'), { recursive: true });
  writeFileSync(join(dir, 'main-abc.js'), 'export {};\n', 'utf8');
  writeFileSync(join(dir, 'providers', 'world-fake-def.js'), 'export {};\n', 'utf8');
  writeFileSync(
    join(dir, 'asset-manifest.json'),
    JSON.stringify({
      protocolVersion: 1,
      core: '/assets/main-abc.js',
      providers: { 'world:fake': { js: '/assets/providers/world-fake-def.js' } },
    }),
    'utf8',
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cortico-web-assets-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('webAssetsProblem', () => {
  it('产物齐全', () => {
    buildComplete();
    expect(webAssetsProblem(dir)).toBeNull();
  });

  it('没构建过', () => {
    expect(webAssetsProblem(dir)).toContain('asset-manifest.json');
  });

  it('清单在、样式表不在:Tailwind 那一步没跑完', () => {
    buildComplete();
    rmSync(join(dir, 'styles.css'));
    expect(webAssetsProblem(dir)).toContain('styles.css');
  });

  it('清单引用的分包不在', () => {
    buildComplete();
    rmSync(join(dir, 'providers', 'world-fake-def.js'));
    expect(webAssetsProblem(dir)).toContain('/assets/providers/world-fake-def.js');
  });

  it('清单不是合法 JSON', () => {
    writeFileSync(join(dir, 'asset-manifest.json'), '{', 'utf8');
    expect(webAssetsProblem(dir)).toContain('解析失败');
  });
});
