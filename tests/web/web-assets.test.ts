/** 可用 = 清单、样式表和清单引用到的每个文件都在，且清单记下的源文件没有变化；不可用时报出第一处原因。 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashSources, webAssetsProblem } from '../../bin/web-assets.mjs';

let root: string;
let dir: string;

/** 造一份可用产物:两个源文件、清单、样式表,以及清单引用到的两个文件。 */
function buildComplete(): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'main.ts'), 'export {};\n', 'utf8');
  writeFileSync(join(root, 'src', 'dep.ts'), 'export {};\n', 'utf8');
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
      sources: hashSources(root, ['src/main.ts', 'src/dep.ts']),
    }),
    'utf8',
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cortico-web-assets-'));
  dir = join(root, 'dist', 'web');
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('webAssetsProblem', () => {
  it('产物齐全且源文件未变', () => {
    buildComplete();
    expect(webAssetsProblem(root)).toBeNull();
  });

  it('没构建过', () => {
    expect(webAssetsProblem(root)).toContain('asset-manifest.json');
  });

  it('清单在、样式表不在:Tailwind 那一步没跑完', () => {
    buildComplete();
    rmSync(join(dir, 'styles.css'));
    expect(webAssetsProblem(root)).toContain('styles.css');
  });

  it('清单引用的分包不在', () => {
    buildComplete();
    rmSync(join(dir, 'providers', 'world-fake-def.js'));
    expect(webAssetsProblem(root)).toContain('/assets/providers/world-fake-def.js');
  });

  it('清单不是合法 JSON', () => {
    writeFileSync(join(dir, 'asset-manifest.json'), '{', 'utf8');
    expect(webAssetsProblem(root)).toContain('解析失败');
  });

  it('清单没有源文件摘要', () => {
    buildComplete();
    writeFileSync(
      join(dir, 'asset-manifest.json'),
      JSON.stringify({ protocolVersion: 1, core: '/assets/main-abc.js', providers: {} }),
      'utf8',
    );
    expect(webAssetsProblem(root)).toContain('源文件摘要');
  });

  it('构建后源文件有改动', () => {
    buildComplete();
    appendFileSync(join(root, 'src', 'main.ts'), '// changed\n', 'utf8');
    expect(webAssetsProblem(root)).toBe('构建后 src/main.ts 有改动');
  });

  it('构建后源文件被删除，其余改动计数', () => {
    buildComplete();
    rmSync(join(root, 'src', 'dep.ts'));
    appendFileSync(join(root, 'src', 'main.ts'), '// changed\n', 'utf8');
    expect(webAssetsProblem(root)).toBe('构建后 src/dep.ts 已删除，另有 1 个源文件有变化');
  });
});
