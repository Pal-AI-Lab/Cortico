import { afterEach, describe, expect, it } from 'vitest';
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

function checkout(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cortico-release-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }));
  return dir;
}

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试端口缺失');
  return `http://127.0.0.1:${address.port}/latest`;
}

function releaseEndpoint(status: number, body: unknown): Promise<string> {
  return listen(createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }));
}

const release = (tag: string) => ({ tag_name: tag, html_url: `https://github.com/Pal-AI-Lab/Cortico/releases/tag/${tag}` });

describe('框架更新提示', () => {
  it('最新正式 Release 高于 package.json 版本时给出新版本和发布说明链接', async () => {
    const endpoint = await releaseEndpoint(200, release('v1.3.0'));
    expect(await checkFrameworkRelease(checkout('1.2.3'), endpoint)).toEqual({
      currentVersion: '1.2.3',
      update: { version: '1.3.0', url: 'https://github.com/Pal-AI-Lab/Cortico/releases/tag/v1.3.0' },
    });
  });

  it('版本相同或更高时没有更新', async () => {
    const endpoint = await releaseEndpoint(200, release('v1.2.0'));
    expect(await checkFrameworkRelease(checkout('1.2.0'), endpoint)).toEqual({ currentVersion: '1.2.0' });
    expect(await checkFrameworkRelease(checkout('1.3.0'), endpoint)).toEqual({ currentVersion: '1.3.0' });
  });

  it('发布源失败时抛错', async () => {
    const endpoint = await releaseEndpoint(503, { message: 'Unavailable' });
    await expect(checkFrameworkRelease(checkout('1.0.0'), endpoint)).rejects.toThrow('GitHub Releases: HTTP 503');
  });

  it('发布源不回应时按截止信号放弃', async () => {
    const endpoint = await listen(createServer(() => {}));
    await expect(checkFrameworkRelease(checkout('1.0.0'), endpoint, AbortSignal.timeout(30)))
      .rejects.toMatchObject({ name: 'TimeoutError' });
  });
});
