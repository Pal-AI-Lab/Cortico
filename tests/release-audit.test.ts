import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  auditRepository,
  formatAuditReport,
  MAX_TRACKED_FILE_BYTES,
} from '../scripts/release-audit.ts';

const repos: string[] = [];

function repository(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), 'cortico-release-audit-'));
  repos.push(root);
  execFileSync('git', ['init', '--quiet', root]);
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  execFileSync('git', ['-C', root, 'add', '--all']);
  return root;
}

function commit(root: string, message = 'fixture'): void {
  execFileSync('git', [
    '-C', root,
    '-c', 'user.name=Release Audit',
    '-c', 'user.email=audit@example.invalid',
    'commit', '--quiet', '-m', message,
  ]);
}

afterEach(() => {
  for (const root of repos.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('公开发布审计', () => {
  it('允许源码、Live2D 适配指南和小型测试资源', () => {
    const root = repository({
      'src/worlds/minecraft/world.ts': 'export const id = "minecraft";\n',
      'docs/LIVE2D-ADAPTATION.md': '# 适配\n',
      'tests/fixtures/tone.wav': Buffer.from('RIFF-test-fixture'),
    });

    const result = auditRepository(root);

    expect(result.trackedFiles).toBe(3);
    expect(result.findings).toEqual([]);
    expect(formatAuditReport(result)).toContain('公开发布审计通过');
  });

  it('报告模型、私有部署目录、Minecraft 文件和异常大文件', () => {
    const root = repository({
      'models/chat.gguf': 'weight',
      'bots/demo/voices/reference.wav': 'voice',
      'bots/demo/live2d/Alice/Alice.model3.json': '{}',
      'scratch/minecraft/server/world/level.dat': 'world',
      'src/large.data': Buffer.alloc(MAX_TRACKED_FILE_BYTES + 1),
    });

    const result = auditRepository(root);

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'model-weight', path: 'models/chat.gguf' }),
      expect.objectContaining({ kind: 'external-resource', path: 'bots/demo/voices/reference.wav' }),
      expect.objectContaining({ kind: 'external-resource', path: 'bots/demo/live2d/Alice/Alice.model3.json' }),
      expect.objectContaining({ kind: 'external-resource', path: 'scratch/minecraft/server/world/level.dat' }),
      expect.objectContaining({ kind: 'large-file', path: 'src/large.data' }),
    ]));
    expect(formatAuditReport(result)).toContain('移到仓库同级 Cortico-Resources');
  });

  it('部署目录中的全部已跟踪文件均被报告', () => {
    const root = repository({

      'deployments/cortiv/config.json': '{"world":{"bilibili":{"sessdata":"real"}}}',
      'deployments/cortiv/workspace/CONSTITUTION.md': '# 私人内容',
      'deployments/cortiv/data/runs/index.jsonl': '{}',
      'deployments/providers/cloud/config.json': '{}',
    });

    const result = auditRepository(root);
    const flagged = result.findings.filter((f) => f.path.startsWith('deployments/')).map((f) => f.path);
    expect(flagged).toEqual(expect.arrayContaining([
      'deployments/cortiv/config.json',
      'deployments/cortiv/workspace/CONSTITUTION.md',
      'deployments/cortiv/data/runs/index.jsonl',
      'deployments/providers/cloud/config.json',
    ]));
  });

  it('OAuth token 文件按文件名认出来,与是哪家的端点无关', () => {
    const root = repository({
      'src/index.ts': 'export const x = 1;\n',
      'runtime/alpha-oauth-7f3.json': '{"access_token":"redacted"}\n',
      'runtime/oauth.json': '{"access_token":"redacted"}\n',
      'docs/oauth.md': '# 设备码流\n',
    });

    const result = auditRepository(root);

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'credential', path: 'runtime/alpha-oauth-7f3.json' }),
      expect.objectContaining({ kind: 'credential', path: 'runtime/oauth.json' }),
    ]));
    expect(result.findings.map((f) => f.path)).not.toContain('docs/oauth.md');
  });

  it('从索引内容识别凭证且不在报告中回显正文', () => {
    const token = `hf_${'a'.repeat(24)}`;
    const root = repository({
      'src/config.ts': `export const token = "${token}";\n`,
      'bots/demo/config.json': '{}',
      'src/placeholders.ts': 'export const key = process.env.API_KEY ?? "sk-test";\n',
    });

    const result = auditRepository(root);
    const report = formatAuditReport(result);

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'credential', path: 'src/config.ts' }),
      expect.objectContaining({ kind: 'credential', path: 'bots/demo/config.json' }),
    ]));
    expect(result.findings.some((finding) => finding.path === 'src/placeholders.ts')).toBe(false);
    expect(report).not.toContain(token);
    expect(report).toContain('先撤销或轮换');
  });

  it('识别已跟踪文件中尚未暂存的凭证', () => {
    const root = repository({ 'src/config.ts': 'export const token = process.env.HF_TOKEN;\n' });
    const token = `hf_${'b'.repeat(24)}`;
    writeFileSync(join(root, 'src', 'config.ts'), `export const token = "${token}";\n`);

    const result = auditRepository(root);

    expect(result.findings).toContainEqual(expect.objectContaining({
      kind: 'credential',
      path: 'src/config.ts',
    }));
    expect(formatAuditReport(result)).not.toContain(token);
  });

  it('暂存删除不能掩盖 HEAD 发布树中的资源和凭证', () => {
    const token = `hf_${'c'.repeat(24)}`;
    const root = repository({
      'bots/demo/voices/reference.wav': 'voice',
      'src/config.ts': `export const token = "${token}";\n`,
    });
    commit(root);
    execFileSync('git', ['-C', root, 'rm', '--quiet', 'bots/demo/voices/reference.wav', 'src/config.ts']);

    const result = auditRepository(root);
    const report = formatAuditReport(result);

    expect(result.trackedFiles).toBe(2);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'external-resource',
        path: 'bots/demo/voices/reference.wav',
        origins: ['HEAD'],
      }),
      expect.objectContaining({ kind: 'credential', path: 'src/config.ts', origins: ['HEAD'] }),
    ]));
    expect(report).toContain('HEAD 发布树');
    expect(report).toContain('暂存删除不会改变 git archive HEAD');
    expect(report).not.toContain(token);
  });
});
