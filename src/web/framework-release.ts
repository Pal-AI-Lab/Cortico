/** 框架更新提示：`package.json` 的版本低于 GitHub 最新正式 Release 时给出新版本。 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repoRoot } from '../paths.ts';

const RELEASE_URL = 'https://api.github.com/repos/Pal-AI-Lab/Cortico/releases/latest';
/** 与仓库其余出站元数据查询同一时限。 */
const RELEASE_TIMEOUT_MS = 15_000;

export interface FrameworkReleaseStatus {
  currentVersion: string;
  /** 最新正式 Release 的版本高于 currentVersion 时才有。 */
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
  root = repoRoot(), releaseUrl = RELEASE_URL, signal: AbortSignal = AbortSignal.timeout(RELEASE_TIMEOUT_MS),
): Promise<FrameworkReleaseStatus> {
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string };
  const response = await fetch(releaseUrl, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Cortico' },
    signal,
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
    ...(isNewer(release.tag_name, version)
      ? { update: { version: release.tag_name.replace(/^v/, ''), url: url.href } }
      : {}),
  };
}
