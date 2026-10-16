/**
 * `pnpm check:extension` 的最后两段:按索引仓 index.json 的词表核对 `cortico.tags`,以及发布前清单与向官方提
 * 扩展申请的纯文本格式。词表经 raw.githubusercontent.com 读,读不到或 `schema` 不认识时跳过标签核对。
 * 这两段只提示,不计入失败;读者是作者和作者的 coding agent,所以只有英文。
 * 标签规则与申请格式以索引仓的 DESIGN.md、TAGS.md 为准。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extensionPackageFile } from '../extensions.ts';
import type { ExtensionPackageJson } from './manifest.ts';

const INDEX_REPO = 'Pal-AI-Lab/cortico-extensions';
const INDEX_REPO_URL = `https://github.com/${INDEX_REPO}`;
export const TAG_INDEX_URL = `https://raw.githubusercontent.com/${INDEX_REPO}/main/index.json`;
export const TAGS_DOC_URL = `${INDEX_REPO_URL}/blob/main/TAGS.md`;
const INDEX_SCHEMA = 1;
/** 与扩展市场读索引同一个超时;连不上 GitHub 的机器不该让检查卡到系统的连接超时。 */
const INDEX_TIMEOUT_MS = 3000;
/** 不认识的标签最多给几个接近的。 */
const MAX_SUGGESTIONS = 3;

export type TagStyle = 'official' | 'notice' | 'warning';

/** index.json 里这里用到的字段。`style` 缺席是普通标签。 */
export interface TagIndex {
  tags: Record<string, { style?: TagStyle; label?: { zh?: string; en?: string }; when?: string }>;
  overrides?: Record<string, { addTags?: string[]; removeTags?: string[]; note?: { en?: string } }>;
}

export type TagIndexResult = { ok: true; index: TagIndex } | { ok: false; reason: string };

export async function fetchTagIndex(fetchImpl: typeof fetch = fetch): Promise<TagIndexResult> {
  let body: unknown;
  try {
    const res = await fetchImpl(TAG_INDEX_URL, { signal: AbortSignal.timeout(INDEX_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status} from ${TAG_INDEX_URL}` };
    body = await res.json();
  } catch (error) {
    return { ok: false, reason: `${TAG_INDEX_URL}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const file = body as { schema?: unknown; tags?: unknown };
  if (file?.schema !== INDEX_SCHEMA) {
    return { ok: false, reason: `index.json has schema ${JSON.stringify(file?.schema)}; this Cortico reads schema ${INDEX_SCHEMA}` };
  }
  if (!file.tags || typeof file.tags !== 'object') return { ok: false, reason: 'index.json has no tags' };
  return { ok: true, index: body as TagIndex };
}

/** `cortico.tags` 里的字符串;不是数组时为 null。 */
export function declaredTags(pkg: ExtensionPackageJson): string[] | null {
  const tags = (pkg.cortico as { tags?: unknown } | undefined)?.tags;
  if (tags === undefined) return [];
  if (!Array.isArray(tags)) return null;
  return tags.filter((t): t is string => typeof t === 'string');
}

export interface TagCheck {
  /** 词表里没有的标签,各带至多三个名字接近的作者标签。 */
  unknown: { tag: string; near: string[] }[];
  /** 声明了的官方标注,作者声明不算数。 */
  official: string[];
  /** 官方在 index.json 里对这个包加的与去的标签。 */
  override?: { addTags: string[]; removeTags: string[]; note?: string };
}

export function checkTags(pkgName: string | undefined, declared: string[], index: TagIndex): TagCheck {
  const unknown = declared.filter((t) => !index.tags[t]).map((tag) => ({ tag, near: nearTags(tag, index) }));
  const official = declared.filter((t) => index.tags[t]?.style === 'official');
  const o = pkgName ? index.overrides?.[pkgName] : undefined;
  const addTags = o?.addTags ?? [];
  const removeTags = o?.removeTags ?? [];
  const override = addTags.length || removeTags.length ? { addTags, removeTags, note: o?.note?.en } : undefined;
  return { unknown, official, override };
}

/** 按 id 与中英 label 比编辑距离,一方包含另一方算最近;官方标注作者不能声明,不参与。 */
function nearTags(tag: string, index: TagIndex): string[] {
  const needle = tag.toLowerCase();
  const scored = Object.entries(index.tags)
    .filter(([, t]) => t.style !== 'official')
    .map(([id, t]) => {
      const names = [id, t.label?.en, t.label?.zh].filter((n): n is string => !!n).map((n) => n.toLowerCase());
      const score = Math.min(...names.map((n) => (n.length >= 2 && needle.length >= 2 && (n.includes(needle) || needle.includes(n)) ? 0 : editDistance(needle, n))));
      return { id, score };
    });
  const limit = Math.max(2, Math.floor(needle.length / 3));
  return scored.filter((s) => s.score <= limit).sort((a, b) => a.score - b.score).slice(0, MAX_SUGGESTIONS).map((s) => s.id);
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * CHANGELOG.md 里有没有这个版本的一段:二级标题里第一个版本号等于 `version`,与索引仓 Action 切段的规则相同,
 * 如 `## 0.2.0` 或 `## [0.2.0] - 2026-10-15`。
 */
export function changelogHasVersion(text: string, version: string): boolean {
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const head = /^##\s+(.*)$/.exec(line);
    if (head && /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(head[1])?.[0] === version) return true;
  }
  return false;
}

const LEVEL_NAMES: Record<TagStyle | 'normal', string> = {
  normal: 'normal',
  notice: 'notice',
  warning: 'warning',
  official: 'maintainers only',
};

function tagLine(id: string, index: TagIndex): string {
  const t = index.tags[id];
  const label = t.label?.en && t.label.en.toLowerCase() !== id ? ` (${t.label.en})` : '';
  return `    ${id}${label} [${LEVEL_NAMES[t.style ?? 'normal']}]: ${t.when ?? ''}`;
}

function tagSection(pkg: ExtensionPackageJson, declared: string[] | null, result: TagIndexResult): string[] {
  const lines = ['', `Tags (vocabulary: ${TAGS_DOC_URL}):`];
  if (!result.ok) {
    lines.push(`  ⚠ Tag check skipped: could not read the tag vocabulary (${result.reason}).`);
    return lines;
  }
  const { index } = result;
  if (declared === null) {
    lines.push('  ⚠ cortico.tags is not an array; the market ignores it. Write it as ["tag-id", ...].');
    declared = [];
  }
  const ids = Object.keys(index.tags);
  const check = checkTags(pkg.name, declared, index);
  if (declared.length === 0) {
    lines.push('  ⚠ cortico.tags is empty. Declare every tag below whose "when" fits the package; [maintainers only] tags cannot be declared:');
    for (const id of ids) lines.push(tagLine(id, index));
  } else {
    for (const u of check.unknown) {
      lines.push(`  ⚠ "${u.tag}" is not in the vocabulary and is ignored.${u.near.length ? ` Close matches: ${u.near.join(', ')}.` : ''}`);
    }
    for (const id of check.official) lines.push(`  ⚠ "${id}" is set by the maintainers only; declaring it has no effect.`);
    const known = declared.filter((t) => index.tags[t] && index.tags[t].style !== 'official');
    if (known.length) lines.push(`  ✓ Declared: ${known.join(', ')}`);
    lines.push('  Notice and warning tags: declare each one whose "when" fits. A declared warning tag stays on the package in later versions until the maintainers remove it.');
    for (const id of ids.filter((i) => index.tags[i].style === 'notice' || index.tags[i].style === 'warning')) {
      lines.push(`${tagLine(id, index)}${declared.includes(id) ? ' (declared)' : ''}`);
    }
  }
  if (check.override) {
    const { addTags, removeTags, note } = check.override;
    const changes = [addTags.length ? `added ${addTags.join(', ')}` : '', removeTags.length ? `removed ${removeTags.join(', ')}` : ''].filter(Boolean).join('; ');
    lines.push(`  ⚠ The maintainers changed this package's tags in index.json: ${changes}.${note ? ` Note: ${note}.` : ''}`);
    lines.push('    Maintainer changes win over cortico.tags. To dispute one, open a [tags] request (see Before publishing):');
    lines.push(`    title: [tags] ${pkg.name}`);
    lines.push(`    body:  package: ${pkg.name}`);
    if (addTags.length) lines.push('           remove: <tags the maintainers added that do not apply>');
    if (removeTags.length) lines.push('           add: <tags the maintainers removed that do apply>');
    lines.push('           reason: <one or two sentences>');
    lines.push('           evidence: <links to source lines, the npm page or screenshots>');
  }
  return lines;
}

function publishSection(pkgDir: string, pkg: ExtensionPackageJson, declared: string[] | null): string[] {
  const lines = ['', 'Before publishing:'];
  lines.push(declared?.length ? `  Tags: ${declared.join(', ')}` : '  ⚠ Tags: none declared in cortico.tags.');

  const changelog = join(pkgDir, 'CHANGELOG.md');
  if (!existsSync(changelog)) {
    lines.push('  ⚠ No CHANGELOG.md. The market shows release notes from a "## <version>" section per version in CHANGELOG.md at the package root.');
  } else if (pkg.version) {
    lines.push(changelogHasVersion(readFileSync(changelog, 'utf8'), pkg.version)
      ? `  ✓ CHANGELOG.md has a "## ${pkg.version}" section.`
      : `  ⚠ CHANGELOG.md has no "## ${pkg.version}" heading; this version shows without release notes.`);
  }

  const os = (pkg as { os?: unknown }).os;
  if (Array.isArray(os) && os.length) lines.push(`  ✓ os: ${JSON.stringify(os)}`);
  else lines.push('  No "os" field: the market lists the package for every platform. If it runs only on some, set it, e.g. "os": ["win32"] or "os": ["!darwin"].');

  const describe = (pkg.cortico as { describe?: unknown } | undefined)?.describe;
  if (typeof describe !== 'string') {
    lines.push('  ⚠ No cortico.describe. Run `pnpm describe:extension <dir>` in the Cortico repository and set cortico.describe to the written file.');
  } else if (!extensionPackageFile(pkgDir, describe)) {
    lines.push(`  ⚠ cortico.describe points to ${describe}, which is not in the package. Run \`pnpm describe:extension <dir>\`.`);
  } else {
    lines.push(`  ✓ cortico.describe: ${describe}`);
  }

  lines.push(
    `  Requests to the maintainers are issues in ${INDEX_REPO_URL}:`,
    '    tags (change tags the maintainers set, withdraw a declared warning tag), certify, supersede,',
    '    appeal (blocked), report, new-tag, other.',
    '    Title: [<type>] <package name>  (new-tag: [new-tag] <tag id>)',
    '    Body: one "key: value" per line; leave out keys that do not apply.',
    `      package: ${pkg.name ?? '<package name>'}`,
    '      add: <tag>, <tag>',
    '      remove: <tag>',
    '      by: <new package name>  (supersede; deprecate the old package on npm first)',
    '      reason: <one or two sentences>',
    '      evidence: <links>',
    `    Example, with the body saved in request.txt: gh issue create --repo ${INDEX_REPO} --title "[tags] ${pkg.name ?? '<package name>'}" --body-file request.txt`,
    `  Market index and request rules: ${INDEX_REPO_URL}`,
  );
  return lines;
}

/** check:extension 末尾两段的全部输出行。 */
export async function authorGuide(pkgDir: string, pkg: ExtensionPackageJson, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const declared = declaredTags(pkg);
  return [...tagSection(pkg, declared, await fetchTagIndex(fetchImpl)), ...publishSection(pkgDir, pkg, declared)];
}
