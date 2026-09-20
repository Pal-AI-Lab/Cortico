/**
 * 附件以句柄存入事件库与 session。
 * `log:<内容哈希>.<ext>` 引用 data/media/ 中按内容寻址、只增的日志附件。
 * `mem:<后端标识>` 由 Persona 的 BlobStore 解析，后端决定标识格式。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BlobRef } from './types.ts';

export const LOG_SCHEME = 'log:';
export const MEM_SCHEME = 'mem:';

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'audio/wav': '.wav',
  'audio/mpeg': '.mp3',
  'text/plain': '.txt',
  'application/json': '.json',
  'application/zip': '.zip',
};

/** 日志附件的文件名形状(不含 scheme);路径分隔符一律拒绝(防穿越)。 */
const LOG_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** 短句柄:至少 8 位十六进制,可带扩展名 */
const LOG_PREFIX_RE = /^([0-9a-f]{8,40})(\.[A-Za-z0-9]+)?$/;
const LOG_HASH_CHARS = 20;

export function blobScheme(handle: string): 'log' | 'mem' | null {
  if (handle.startsWith(MEM_SCHEME)) return 'mem';
  if (handle.startsWith(LOG_SCHEME)) return 'log';
  return null;
}

/** 按扩展名反推 mime;认不出的扩展名 → octet-stream。 */
export function mimeOfHandle(handle: string): string {
  const dot = handle.lastIndexOf('.');
  const ext = dot >= 0 ? handle.slice(dot).toLowerCase() : '';
  for (const [mime, e] of Object.entries(EXT_BY_MIME)) if (e === ext) return mime;
  return 'application/octet-stream';
}

/** 一份附件进入 session 的那一行:句柄、mime、名字,后接它的文本形态。 */
export function blobLine(ref: BlobRef): string {
  return `[blob ${ref.handle} ${ref.mime}${ref.name ? ` ${ref.name}` : ''}] ${ref.fallbackText}`;
}

/** 正文后接每份附件一行;没有附件时原样交回。 */
export function withBlobLines(text: string, refs: readonly BlobRef[] | undefined): string {
  if (!refs || refs.length === 0) return text;
  const lines = refs.map(blobLine).join('\n');
  return text ? `${text}\n${lines}` : lines;
}

/**
 * 字节按内容哈希存入 data/media/，重复写入不增加副本。
 * 读取接受完整句柄或唯一的十六进制前缀（至少 8 位）。
 */
export class LogBlobStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'media');
  }

  /** 落盘并返回 `log:` 句柄。 */
  put(bytes: Uint8Array, mime: string): string {
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, LOG_HASH_CHARS);
    const ext = EXT_BY_MIME[mime] ?? '.bin';
    const name = `${hash}${ext}`;
    const path = join(this.dir, name);
    if (!existsSync(path)) {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      writeFileSync(path, bytes);
    }
    return `${LOG_SCHEME}${name}`;
  }

  /** 现存份数与占用字节;目录还没建时都是 0。 */
  stat(): { count: number; bytes: number } {
    if (!existsSync(this.dir)) return { count: 0, bytes: 0 };
    const names = readdirSync(this.dir);
    return { count: names.length, bytes: names.reduce((sum, name) => sum + statSync(join(this.dir, name)).size, 0) };
  }

  /**
   * 删掉目录里的全部附件,返回删掉的份数。附件那一行正文在落库时已写定
   * (句柄、mime 与 fallbackText),此后 read() 返回 null,投递时不再附字节。
   */
  clear(): number {
    if (!existsSync(this.dir)) return 0;
    let removed = 0;
    for (const name of readdirSync(this.dir)) {
      rmSync(join(this.dir, name), { force: true });
      removed += 1;
    }
    return removed;
  }

  /** 按句柄取回;句柄不合形状、前缀不唯一或文件不在了返回 null。 */
  read(handle: string): { bytes: Buffer; mime: string } | null {
    const name = this.resolveName(handle);
    if (!name) return null;
    try {
      return { bytes: readFileSync(join(this.dir, name)), mime: mimeOfHandle(name) };
    } catch {
      return null;
    }
  }

  private resolveName(handle: string): string | null {
    if (!handle.startsWith(LOG_SCHEME)) return null;
    const raw = handle.slice(LOG_SCHEME.length);
    if (!LOG_NAME_RE.test(raw)) return null;
    if (existsSync(join(this.dir, raw))) return raw;
    const m = LOG_PREFIX_RE.exec(raw);
    if (!m || !existsSync(this.dir)) return null;
    const [, prefix, ext] = m;
    const hits = readdirSync(this.dir).filter((f) => f.startsWith(prefix) && (!ext || f.endsWith(ext)));
    return hits.length === 1 ? hits[0] : null;
  }
}
