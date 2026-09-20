/**
 * 日志附件库与句柄语法:字节按内容哈希落 data/media/,句柄带 `log:` scheme;
 * read 认完整句柄与唯一前缀,没有 scheme 或不合形状的一律拒绝(防穿越)。
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LogBlobStore, blobLine, blobScheme, mimeOfHandle, withBlobLines } from '../../src/core/blobs.ts';

let dir: string | null = null;
afterEach(() => {
  if (dir) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* win句柄滞留 */ }
    dir = null;
  }
});

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);

describe('LogBlobStore', () => {
  it('put 落盘并返回 log: 句柄;read 按句柄取回同一份字节与 mime', () => {
    dir = mkdtempSync(join(tmpdir(), 'blob-store-'));
    const store = new LogBlobStore(dir);
    const handle = store.put(JPEG, 'image/jpeg');
    expect(handle).toMatch(/^log:[0-9a-f]{20}\.jpg$/);
    expect(existsSync(join(dir, 'media', handle.slice(4)))).toBe(true);
    const got = store.read(handle)!;
    expect(got.bytes.equals(JPEG)).toBe(true);
    expect(got.mime).toBe('image/jpeg');
  });

  it('内容寻址:同一份字节重复 put 不重复占盘,句柄一致', () => {
    dir = mkdtempSync(join(tmpdir(), 'blob-store-'));
    const store = new LogBlobStore(dir);
    expect(store.put(JPEG, 'image/jpeg')).toBe(store.put(JPEG, 'image/jpeg'));
    expect(readdirSync(join(dir, 'media'))).toHaveLength(1);
  });

  it('read 认唯一前缀(≥8 位);没有 scheme 的裸文件名不认;前缀太短或不存在返回 null', () => {
    dir = mkdtempSync(join(tmpdir(), 'blob-store-'));
    const store = new LogBlobStore(dir);
    const handle = store.put(JPEG, 'image/jpeg');
    const name = handle.slice(4);
    expect(store.read(name)).toBeNull();
    expect(store.read(`log:${name.slice(0, 8)}`)?.bytes.equals(JPEG)).toBe(true);
    expect(store.read(`log:${name.slice(0, 10)}.jpg`)?.bytes.equals(JPEG)).toBe(true);
    expect(store.read(`log:${name.slice(0, 7)}`)).toBeNull(); // 太短,不当前缀
    expect(store.read('log:deadbeefdeadbeefdead.jpg')).toBeNull(); // 合形状但不存在
  });

  it('stat 报现存份数与占用;目录还没建时是 0', () => {
    dir = mkdtempSync(join(tmpdir(), 'blob-store-'));
    const store = new LogBlobStore(dir);
    expect(store.stat()).toEqual({ count: 0, bytes: 0 });
    store.put(JPEG, 'image/jpeg');
    store.put(Buffer.from([1, 2, 3]), 'audio/wav');
    expect(store.stat()).toEqual({ count: 2, bytes: JPEG.length + 3 });
  });

  it('clear 删掉全部附件并报份数;之后按句柄读不到', () => {
    dir = mkdtempSync(join(tmpdir(), 'blob-store-'));
    const store = new LogBlobStore(dir);
    const handle = store.put(JPEG, 'image/jpeg');
    expect(store.clear()).toBe(1);
    expect(store.read(handle)).toBeNull();
    expect(store.stat()).toEqual({ count: 0, bytes: 0 });
    expect(store.clear()).toBe(0);
  });

  it('read 拒绝不合形状的句柄(路径穿越/绝对路径/别的 scheme)', () => {
    dir = mkdtempSync(join(tmpdir(), 'blob-store-'));
    const store = new LogBlobStore(dir);
    expect(store.read('../secrets.txt')).toBeNull();
    expect(store.read('..\\secrets.txt')).toBeNull();
    expect(store.read('log:a/b.jpg')).toBeNull();
    expect(store.read('C:\\x.jpg')).toBeNull();
    expect(store.read('mem:blobs/x.jpg')).toBeNull();
  });
});

describe('句柄语法与文本形态', () => {
  it('blobScheme 只认带 scheme 的句柄', () => {
    expect(blobScheme('log:abc.png')).toBe('log');
    expect(blobScheme('abcdef0123.png')).toBeNull();
    expect(blobScheme('mem:blobs/猫.png')).toBe('mem');
    expect(blobScheme('../x')).toBeNull();
    expect(blobScheme('')).toBeNull();
  });

  it('mimeOfHandle 按扩展名反推,认不出的是 octet-stream', () => {
    expect(mimeOfHandle('mem:blobs/a.PNG')).toBe('image/png');
    expect(mimeOfHandle('log:abc.pdf')).toBe('application/pdf');
    expect(mimeOfHandle('log:abc.bin')).toBe('application/octet-stream');
  });

  it('每份附件一行 [blob 句柄 mime 名字] 文本形态,接在正文后;没附件原样交回', () => {
    const ref = { handle: 'log:abc.png', mime: 'image/png', name: 'shot.png', fallbackText: '阿明 发来的图片 1/1' };
    expect(blobLine(ref)).toBe('[blob log:abc.png image/png shot.png] 阿明 发来的图片 1/1');
    expect(blobLine({ ...ref, name: undefined })).toBe('[blob log:abc.png image/png] 阿明 发来的图片 1/1');
    expect(withBlobLines('看看这个', [ref])).toBe('看看这个\n[blob log:abc.png image/png shot.png] 阿明 发来的图片 1/1');
    expect(withBlobLines('', [ref])).toBe('[blob log:abc.png image/png shot.png] 阿明 发来的图片 1/1');
    expect(withBlobLines('纯文字', undefined)).toBe('纯文字');
    expect(withBlobLines('纯文字', [])).toBe('纯文字');
  });
});
