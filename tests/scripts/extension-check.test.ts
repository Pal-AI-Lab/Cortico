/** check:extension 用 WebUI 页 id 的同一条规则校验扩展 id。 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFixture } from '../fixtures/extensions/install.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'extension-check-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('check:extension', () => {
  it('World id 带大写时判失败,写明 id 只能用小写字母、数字和连字符', () => {
    const pkgDir = installFixture(root, 'world-ok');
    const entry = join(pkgDir, 'index.js');
    writeFileSync(entry, readFileSync(entry, 'utf8').replaceAll("'fixture-world'", "'FixtureWorld'"));
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/extension-check.ts', pkgDir], { cwd: repoRoot, encoding: 'utf8' });
    expect(child.status).toBe(1);
    expect(child.stdout).toContain('✗ World id "FixtureWorld" cannot form a WebUI page id: use only lowercase letters, digits and hyphens');
  });
});
