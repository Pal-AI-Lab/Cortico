/**
 * QQ 视频消息落盘。
 *
 * 收到 type=video 的段时，模型侧原本只看到一个空的 `[video]` 占位，没有任何文件，
 * 于是 video_probe / video_frames 这类「看画面」的工具无从下手。这里把视频落到
 * World 自己的 media 目录，再把绝对路径写进事件文本，模型就能自己去探、去抽帧。
 *
 * 原则：
 * - 只读传入路径对应的本地文件；不联网下载除非段里给了 http(s) 地址。
 * - 不碰 API Key，不碰别的 World 的目录。
 * - 任何一步失败都返回原因，由调用方写进事件文本，绝不让整条消息卡住。
 */
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, extname, isAbsolute, join } from 'node:path';

/** video 段落盘的上限与超时。默认值在 config.ts 里，这里只描述形状。 */
export interface VideoStoreOptions {
  /** 单个视频的字节上限；0 或负数表示不限制。 */
  maxVideoBytes: number;
  /** 下载或复制的总时限（毫秒）。 */
  timeoutMs: number;
}

export interface VideoStoreDirs {
  /** 部署数据目录（ctx.dataDir），media 目录建在它下面。 */
  dataDir: string;
}

/** 一次落盘的结果：成功给绝对路径，失败给原因。二者必居其一。 */
export type VideoStoreResult =
  | { ok: true; path: string; bytes: number; mime: string }
  | { ok: false; reason: string };

/** 视频 MIME → 扩展名；缺省按 mp4 处理。 */
const VIDEO_EXT: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/webm': 'webm',
  'video/x-msvideo': 'avi',
  'video/x-flv': 'flv',
  'video/mpeg': 'mpeg',
  'video/3gpp': '3gp',
};

/** 已知视频扩展名 → MIME；用于协议端只给本地路径、没有 content-type 时。 */
const EXT_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(VIDEO_EXT).map(([mime, ext]) => [ext, mime]),
);

/** 这些后缀我们认识，别的一律按 mp4 存，交给 ffprobe 去判。 */
const KNOWN_EXTS = new Set(Object.values(VIDEO_EXT));

/** 下载/复制的总时限用一个 AbortController 统一兜住。 */
class Deadline {
  private readonly ac = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  constructor(timeoutMs: number) {
    if (timeoutMs > 0) {
      this.timer = setTimeout(() => this.ac.abort(), timeoutMs);
    }
  }
  get signal(): AbortSignal {
    return this.ac.signal;
  }
  /** 正常收尾；超时已触发时 abort 会让在等的操作抛错，由调用方转成「超时」。 */
  done(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}

function humanBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${n}B`;
}

/**
 * 从 video 段的 data 里取「视频在哪」。
 * 优先级：url（协议端/CDN 地址）→ file（协议端给的本地缓存路径）。
 * 两者都没有时返回空串，调用方据此跳过。
 */
export function extractVideoSource(data: Record<string, unknown>): string {
  const url = typeof data.url === 'string' ? data.url.trim() : '';
  if (url) return url;
  const file = typeof data.file === 'string' ? data.file.trim() : '';
  if (file) return file;
  // 有的协议端（NapCat）把它放在 data.video 里
  const nested = data.video;
  if (nested && typeof nested === 'object') {
    const obj = nested as Record<string, unknown>;
    const nUrl = typeof obj.url === 'string' ? obj.url.trim() : '';
    if (nUrl) return nUrl;
    const nFile = typeof obj.file === 'string' ? obj.file.trim() : '';
    if (nFile) return nFile;
  }
  return '';
}

/** 段里给的是不是 http(s) 地址（要走下载而不是复制）。 */
export function isRemoteSource(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

/** 段里给的是不是 file:// 形式的本地路径。 */
/**
 * file:// URI → 本机路径。
 * 要同时处理 `file:///C:/a/b.mp4`（标准三斜杠，带盘符）和 `file://C:/a/b.mp4`
 * （有的协议端少写一斜杠）两种写法；UNIX 下的 `file:///tmp/a.mp4` 也走这里。
 */
function fileUrlToPath(source: string): string {
  const m = /^file:\/\/(.*)$/i.exec(source);
  if (!m) return source;
  let rest = decodeURIComponent(m[1]);
  // Windows 盘符：三斜杠形式会把盘符吃成一个前导斜杠，补回来。
  const drive = /^\/([a-zA-Z]:)(\/|$)/.exec(rest);
  if (drive) rest = rest.slice(1);
  return rest;
}

/** 目标文件名：时间戳 + 原名（清洗过），保证可排序、不撞名、可读。 */
function buildName(source: string, stamp: string): string {
  const raw = basename(fileUrlToPath(source).split('?')[0]) || 'video';
  const clean = raw.replace(/[^\w.\-]+/g, '_').slice(-80);
  const ext = extname(clean).toLowerCase();
  const stem = (ext ? clean.slice(0, -ext.length) : clean) || 'video';
  const finalExt = KNOWN_EXTS.has(ext.replace('.', '')) ? ext : '.mp4';
  return `${stamp}-${stem}${finalExt}`;
}

/**
 * 把一段视频落到 `<dataDir>/qq-media/` 下。
 * 成功返回绝对路径；失败返回原因（调用方写进事件文本，不抛给消息处理链）。
 */
export async function storeVideoSegment(
  source: string,
  opts: VideoStoreOptions,
  dirs: VideoStoreDirs,
  now: Date = new Date(),
): Promise<VideoStoreResult> {
  if (!source) return { ok: false, reason: '段里没有 url / file，拿不到视频' };

  const mediaDir = join(dirs.dataDir, 'qq-media');
  const stamp = isoStamp(now);
  const name = buildName(source, stamp);
  const target = join(mediaDir, name);
  const local = fileUrlToPath(source);

  const deadline = new Deadline(opts.timeoutMs);
  try {
    await mkdir(mediaDir, { recursive: true });

    if (isRemoteSource(source)) {
      return await downloadTo(source, target, opts, deadline);
    }

    // 本地路径：直接复制。协议端给的 file 段多半就是它自己的缓存文件。
    if (!isAbsolute(local)) {
      return { ok: false, reason: `协议端给的路径不是绝对路径：${local}` };
    }
    let size: number;
    try {
      size = (await stat(local)).size;
    } catch {
      return { ok: false, reason: `本地视频文件不存在或读不到：${local}` };
    }
    if (opts.maxVideoBytes > 0 && size > opts.maxVideoBytes) {
      return {
        ok: false,
        reason: `视频过大（${humanBytes(size)} > 上限 ${humanBytes(opts.maxVideoBytes)}）：${local}`,
      };
    }
    await copyFile(local, target);
    const bytes = (await stat(target)).size;
    return { ok: true, path: target, bytes, mime: mimeFor(target) };
  } catch (e) {
    if (deadline.signal.aborted) return { ok: false, reason: `落盘超时（>${opts.timeoutMs}ms）` };
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    deadline.done();
  }
}

/** 下载分支：流式写盘，边下边校验上限，超限立刻停，不把整个文件读进内存。 */
async function downloadTo(
  url: string,
  target: string,
  opts: VideoStoreOptions,
  deadline: Deadline,
): Promise<VideoStoreResult> {
  let res: Response;
  try {
    res = await fetch(url, { signal: deadline.signal });
  } catch (e) {
    if (deadline.signal.aborted) return { ok: false, reason: `下载超时（>${opts.timeoutMs}ms）` };
    return { ok: false, reason: `下载失败：${e instanceof Error ? e.message : String(e)}` };
  }
  if (!res.ok) return { ok: false, reason: `下载返回 HTTP ${res.status}` };
  if (!res.body) return { ok: false, reason: '下载响应没有正文' };

  // content-length 先拦一道，省得下到一半才发现超限。
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (opts.maxVideoBytes > 0 && declared > opts.maxVideoBytes) {
    return {
      ok: false,
      reason: `视频过大（声明 ${humanBytes(declared)} > 上限 ${humanBytes(opts.maxVideoBytes)}）`,
    };
  }

  const { createWriteStream } = await import('node:fs');
  const sink = createWriteStream(target);
  let written = 0;
  let overflow: string | null = null;

  try {
    for await (const chunk of res.body) {
      if (deadline.signal.aborted) {
        await closeSink(sink);
        return { ok: false, reason: `下载超时（>${opts.timeoutMs}ms）` };
      }
      const buf = chunk as Uint8Array;
      written += buf.byteLength;
      if (opts.maxVideoBytes > 0 && written > opts.maxVideoBytes) {
        overflow = `视频过大（已下 ${humanBytes(written)} > 上限 ${humanBytes(opts.maxVideoBytes)}）`;
        break;
      }
      if (!sink.write(buf)) {
        await new Promise<void>((r) => sink.once('drain', r));
      }
    }
  } catch (e) {
    await closeSink(sink);
    if (deadline.signal.aborted) return { ok: false, reason: `下载超时（>${opts.timeoutMs}ms）` };
    return { ok: false, reason: `下载中断：${e instanceof Error ? e.message : String(e)}` };
  }

  await new Promise<void>((resolve, reject) => {
    sink.end(() => resolve());
    sink.once('error', reject);
  });
  if (overflow) {
    await removeQuietly(target);
    return { ok: false, reason: overflow };
  }
  const bytes = (await stat(target)).size;
  if (bytes === 0) {
    await removeQuietly(target);
    return { ok: false, reason: '下载到空文件' };
  }
  return { ok: true, path: target, bytes, mime: mimeFor(target) };
}

/** 关掉写流的兜底：失败也不该盖掉主结果。 */
async function closeSink(sink: { close: (cb?: () => void) => unknown; destroy: () => void }): Promise<void> {
  await new Promise<void>((resolve) => {
    try {
      const ret = sink.close(() => resolve());
      if (ret && typeof (ret as { then?: unknown }).then === 'function') (ret as Promise<void>).then(() => resolve(), () => resolve());
      else resolve();
    } catch {
      try { sink.destroy(); } catch { /* 已关 */ }
      resolve();
    }
  });
}

function mimeFor(path: string): string {
  const ext = extname(path).toLowerCase().replace('.', '');
  return EXT_MIME[ext] ?? 'video/mp4';
}

async function removeQuietly(path: string): Promise<void> {
  try {
    const { rm } = await import('node:fs/promises');
    await rm(path, { force: true });
  } catch {
    // 清理失败不改变主结果
  }
}

/** 20261022-235955-123 形式：可排序、可读、不会和同一秒内的另一次撞名。 */
export function isoStamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`
  );
}

/** 文件内容哈希，测试与去重都会用到。 */
export function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}
