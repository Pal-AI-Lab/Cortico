import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkFrameworkRelease } from '../../src/web/framework-release.ts';

const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function checkout(version: string, tag?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cortico-release-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('add', 'package.json');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'release');
  if (tag) git('tag', tag);
  return dir;
}

async function releaseEndpoint(status: number, body: unknown): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试端口缺失');
  return `http://127.0.0.1:${address.port}/latest`;
}

describe('framework release notice', () => {
  it('发布 tag 的检出显示较新的 GitHub Release 和说明链接', async () => {
    const root = checkout('1.2.3', 'v1.2.3');
    const endpoint = await releaseEndpoint(200, {
      tag_name: 'v1.3.0', html_url: 'https://github.com/Pal-AI-Lab/Cortico/releases/tag/v1.3.0',
    });
    expect(await checkFrameworkRelease(root, endpoint)).toEqual({
      currentVersion: '1.2.3', checkout: 'release',
      update: { version: 'v1.3.0', url: 'https://github.com/Pal-AI-Lab/Cortico/releases/tag/v1.3.0' },
    });
  });

  it('开发检出与高于 latest 的版本均不误报', async () => {
    const endpoint = await releaseEndpoint(200, {
      tag_name: 'v1.2.0', html_url: 'https://github.com/Pal-AI-Lab/Cortico/releases/tag/v1.2.0',
    });
    expect(await checkFrameworkRelease(checkout('1.1.0'), endpoint))
      .toEqual({ currentVersion: '1.1.0', checkout: 'development' });
    expect(await checkFrameworkRelease(checkout('1.3.0', 'v1.3.0'), endpoint))
      .toEqual({ currentVersion: '1.3.0', checkout: 'release' });
  });

  it('发布源失败时返回错误，供控制台重试', async () => {
    const endpoint = await releaseEndpoint(503, { message: 'Unavailable' });
    await expect(checkFrameworkRelease(checkout('1.0.0', 'v1.0.0'), endpoint))
      .rejects.toThrow('GitHub Releases: HTTP 503');
  });

  it('发布源接收请求后不回应时截止等待，控制台可以显示重试', async () => {
    const server = createServer(() => {});
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('测试端口缺失');
    const endpoint = `http://127.0.0.1:${address.port}/latest`;
    await expect(checkFrameworkRelease(checkout('1.0.0', 'v1.0.0'), endpoint, AbortSignal.timeout(30)))
      .rejects.toMatchObject({ name: 'TimeoutError' });
  });
});
