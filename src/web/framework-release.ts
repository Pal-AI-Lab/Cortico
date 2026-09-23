/** Cortico 的发布提醒以当前检出的版本 tag 和 GitHub Releases 为准。 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../paths.ts';

const RELEASE_URL = 'https://api.github.com/repos/Pal-AI-Lab/Cortico/releases/latest';

export interface FrameworkReleaseStatus {
  currentVersion: string;
  checkout: 'release' | 'development';
  update?: { version: string; url: string };
}

function versionParts(version: string): bigint[] | null {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  return match ? match.slice(1).map((part) => BigInt(part)) : null;
}

function isNewer(latest: string, current: string): boolean {
  const left = versionParts(latest);
  const right = versionParts(current);
  if (!left || !right) return false;
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i];
  }
  return false;
}

export async function checkFrameworkRelease(
  root = repoRoot(), releaseUrl = RELEASE_URL, signal?: AbortSignal,
): Promise<FrameworkReleaseStatus> {
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
  let tag = '';
  try {
    tag = execFileSync('git', ['describe', '--tags', '--exact-match', 'HEAD'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { /* 非发布检出 */ }
  if (tag !== `v${version}` && tag !== version) return { currentVersion: version, checkout: 'development' };

  const response = await fetch(releaseUrl, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Cortico' },
    signal: signal ?? AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GitHub Releases: HTTP ${response.status}`);
  const release = await response.json() as { tag_name?: unknown; html_url?: unknown };
  if (typeof release.tag_name !== 'string' || typeof release.html_url !== 'string') {
    throw new Error('GitHub Releases: 响应缺少版本或链接');
  }
  const url = new URL(release.html_url);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') throw new Error('GitHub Releases: 链接无效');
  return {
    currentVersion: version,
    checkout: 'release',
    ...(isNewer(release.tag_name, version) ? { update: { version: release.tag_name, url: url.href } } : {}),
  };
}
