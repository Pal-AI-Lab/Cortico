/**
 * HuggingFace lookups behind the pull field: repositories tagged `gguf`, and the GGUF files of
 * one repository as `repo:tag` pull targets. The host is the one llama-server itself pulls from
 * (`MODEL_ENDPOINT`, else `HF_ENDPOINT`, else huggingface.co), so a repository found here is
 * reachable for the pull.
 */

export interface HfRepo {
  id: string;
  downloads: number;
  likes: number;
  /** ISO timestamp of the last commit; null when the listing omits it. */
  updatedAt: string | null;
}

export interface HfFile {
  name: string;
  /** Sum over shards; null when the listing carries no sizes. */
  bytes: number | null;
  /** Quantization tag read from the file name; null when the name carries none. */
  tag: string | null;
  /** What `POST /models` takes to pull this file: `repo:tag`, or the repository alone. */
  pull: string;
}

export interface HfOptions {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_ENDPOINT = 'https://huggingface.co';
const SEARCH_LIMIT = 20;
const TIMEOUT_MS = 15_000;
const SHARD_RE = /-(\d{5})-of-\d{5}\.gguf$/i;
const QUANT_RE = /^(?:i?q\d[a-z0-9_]*|tq\d[a-z0-9_]*|bf16|f16|f32|f64|mxfp4[a-z0-9_]*)$/i;

export function hfEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  return (env.MODEL_ENDPOINT || env.HF_ENDPOINT || DEFAULT_ENDPOINT).replace(/\/+$/, '');
}

async function getJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET ${url} ${res.status}`);
  return res.json();
}

export async function searchGguf(query: string, options: HfOptions = {}): Promise<HfRepo[]> {
  const params = new URLSearchParams({ search: query, filter: 'gguf', sort: 'downloads', direction: '-1', limit: String(SEARCH_LIMIT) });
  // The plain listing omits lastModified; `expand` names every field wanted back.
  for (const field of ['downloads', 'likes', 'lastModified']) params.append('expand[]', field);
  const rows = await getJson(`${hfEndpoint(options.env)}/api/models?${params}`, options.fetchImpl ?? fetch);
  if (!Array.isArray(rows)) throw new Error('HuggingFace search returned no list');
  const repos: HfRepo[] = [];
  for (const row of rows as Array<Record<string, unknown>>) {
    const id = typeof row.id === 'string' ? row.id : typeof row.modelId === 'string' ? row.modelId : null;
    if (!id) continue;
    repos.push({
      id,
      downloads: typeof row.downloads === 'number' ? row.downloads : 0,
      likes: typeof row.likes === 'number' ? row.likes : 0,
      updatedAt: typeof row.lastModified === 'string' ? row.lastModified : null,
    });
  }
  return repos;
}

/** The quantization tag in a GGUF file name: the last `-` or `.` separated token that names one, with an `UD-` prefix kept. */
export function quantTag(filename: string): string | null {
  const stem = filename.replace(SHARD_RE, '.gguf').replace(/\.gguf$/i, '');
  const tokens = stem.split(/[-.]/);
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (!QUANT_RE.test(tokens[i])) continue;
    return (tokens[i - 1]?.toUpperCase() === 'UD' ? 'UD-' : '') + tokens[i];
  }
  return null;
}

/** GGUF files of a repository, shards folded into one entry, projector files (`mmproj-*`) left out. */
export async function listGguf(repo: string, options: HfOptions = {}): Promise<HfFile[]> {
  const info = await getJson(`${hfEndpoint(options.env)}/api/models/${repo.split('/').map(encodeURIComponent).join('/')}?blobs=true`, options.fetchImpl ?? fetch) as { siblings?: unknown };
  if (!Array.isArray(info.siblings)) throw new Error('HuggingFace repository listing carries no files');
  const files = new Map<string, HfFile>();
  for (const sibling of info.siblings as Array<Record<string, unknown>>) {
    const path = typeof sibling.rfilename === 'string' ? sibling.rfilename : '';
    if (!/\.gguf$/i.test(path) || /(^|\/)mmproj/i.test(path)) continue;
    const name = path.replace(SHARD_RE, '.gguf');
    const lfs = sibling.lfs as { size?: unknown } | undefined;
    const size = typeof sibling.size === 'number' ? sibling.size : typeof lfs?.size === 'number' ? lfs.size : null;
    const entry = files.get(name);
    if (entry) { if (size !== null && entry.bytes !== null) entry.bytes += size; continue; }
    const tag = quantTag(name);
    files.set(name, { name, bytes: size, tag, pull: tag ? `${repo}:${tag}` : repo });
  }
  return [...files.values()];
}
