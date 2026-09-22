// @ts-check
/**
 * 控制台产物是否可用：清单、样式表和清单引用到的每个文件都在，且构建时记下的源文件至今未变。
 * `bin/cortico.mjs` 在依赖装好之前就要用它，因此不得依赖第三方包。
 */
import { createHash } from 'node:crypto';
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
 * 源文件内容的 sha256，键为仓库相对路径（`/` 分隔）。
 *
 * @param {string} root 仓库根目录
 * @param {string[]} files 仓库相对路径
 * @returns {Record<string, string>}
 */
export function hashSources(root, files) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const file of [...files].sort()) {
    out[file] = createHash('sha256').update(readFileSync(join(root, file))).digest('hex');
  }
  return out;
}

/**
 * 构建后改动或删除了的源文件，按清单顺序。
 *
 * @param {string} root 仓库根目录
 * @param {Record<string, string>} sources 构建时的摘要
 * @returns {string[]}
 */
function changedSources(root, sources) {
  return Object.entries(sources)
    .filter(([file, sha]) => {
      const abs = join(root, file);
      return !existsSync(abs) || createHash('sha256').update(readFileSync(abs)).digest('hex') !== sha;
    })
    .map(([file]) => file);
}

/**
 * 控制台产物为什么不能用。可用回 null，否则回一句原因。
 *
 * @param {string} root 仓库根目录；产物在它的 `dist/web`
 * @returns {string | null}
 */
export function webAssetsProblem(root) {
  const dir = join(root, 'dist', 'web');
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
  const sources = /** @type {{ sources?: unknown }} */ (manifest).sources;
  if (typeof sources !== 'object' || sources === null) return `${MANIFEST} 没有源文件摘要`;
  const changed = changedSources(root, /** @type {Record<string, string>} */ (sources));
  if (changed.length === 0) return null;
  const what = existsSync(join(root, changed[0])) ? '有改动' : '已删除';
  const more = changed.length > 1 ? `，另有 ${changed.length - 1} 个源文件有变化` : '';
  return `构建后 ${changed[0]} ${what}${more}`;
}
