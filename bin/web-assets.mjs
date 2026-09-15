// @ts-check
/**
 * 控制台产物的完整性判断:清单、样式表,以及清单引用到的每个文件都在才算完整。
 * `bin/cortico.mjs` 在依赖装好之前就要用它，因此不得依赖第三方包。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** esbuild 那一步的产物清单。 */
const MANIFEST = 'asset-manifest.json';

/** Tailwind 那一步的产物；`index.html` 直接引用，不进清单。 */
const STYLESHEET = 'styles.css';

/** 清单里的 URL 前缀，与服务端把 `dist/web` 挂出去的路径一致。 */
const ASSET_PREFIX = '/assets/';

/**
 * 清单里引用到的全部产物 URL。
 *
 * @param {unknown} manifest
 * @returns {string[]}
 */
function referencedUrls(manifest) {
  const out = [];
  const m = /** @type {{ core?: unknown, providers?: Record<string, { js?: unknown, css?: unknown }> }} */ (manifest);
  if (typeof m.core === 'string') out.push(m.core);
  for (const entry of Object.values(m.providers ?? {})) {
    if (typeof entry?.js === 'string') out.push(entry.js);
    if (typeof entry?.css === 'string') out.push(entry.css);
  }
  return out;
}

/**
 * 控制台产物缺什么。齐全回 null，否则回一句缺失原因。
 *
 * @param {string} dir 产物目录，即仓库的 `dist/web`
 * @returns {string | null}
 */
export function webAssetsProblem(dir) {
  const manifestFile = join(dir, MANIFEST);
  if (!existsSync(manifestFile)) return `缺少 ${MANIFEST}`;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  } catch (err) {
    return `${MANIFEST} 解析失败: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (!existsSync(join(dir, STYLESHEET))) return `缺少 ${STYLESHEET}`;
  for (const url of referencedUrls(manifest)) {
    if (!url.startsWith(ASSET_PREFIX)) return `${MANIFEST} 里的 ${url} 不是 ${ASSET_PREFIX} 路径`;
    const file = join(dir, ...url.slice(ASSET_PREFIX.length).split('/'));
    if (!existsSync(file)) return `${MANIFEST} 引用的 ${url} 不在`;
  }
  return null;
}
