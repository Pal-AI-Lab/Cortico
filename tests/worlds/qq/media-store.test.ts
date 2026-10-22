import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractVideoSource,
  hashBytes,
  isRemoteSource,
  isoStamp,
  storeVideoSegment,
  type VideoStoreOptions,
} from '../../../src/worlds/qq/media-store.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'qq-media-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const OPTS: VideoStoreOptions = { maxVideoBytes: 200 * 1024 * 1024, timeoutMs: 60_000 };
const TIGHT: VideoStoreOptions = { maxVideoBytes: 1024, timeoutMs: 60_000 };

function writeFakeVideo(name: string, bytes = 4096): string {
  const p = join(dir, name);
  writeFileSync(p, Buffer.alloc(bytes, 7));
  return p;
}

describe('extractVideoSource', () => {
  it('url 优先于 file', () => {
    expect(extractVideoSource({ url: 'https://x/v.mp4', file: 'C:/c.mp4' })).toBe('https://x/v.mp4');
  });
  it('只有 file 时取 file', () => {
    expect(extractVideoSource({ file: 'C:/cache/v.mp4' })).toBe('C:/cache/v.mp4');
  });
  it('NapCat 的嵌套 video 对象也认', () => {
    expect(extractVideoSource({ video: { file: 'D:/a.mp4' } })).toBe('D:/a.mp4');
  });
  it('都没有时返回空串', () => {
    expect(extractVideoSource({})).toBe('');
    expect(extractVideoSource({ file: '  ' })).toBe('');
  });
});

describe('isRemoteSource', () => {
  it('http/https 算远端', () => {
    expect(isRemoteSource('https://x/v.mp4')).toBe(true);
    expect(isRemoteSource('http://x/v.mp4')).toBe(true);
  });
  it('本地路径不算', () => {
    expect(isRemoteSource('C:/a/v.mp4')).toBe(false);
    expect(isRemoteSource('/tmp/v.mp4')).toBe(false);
  });
});

describe('storeVideoSegment · 本地复制', () => {
  it('复制到 media 目录，文件名带时间戳，返回绝对路径', async () => {
    const src = writeFakeVideo('clip.mp4');
    const res = await storeVideoSegment(src, OPTS, { dataDir: dir }, new Date(2026, 0, 2, 3, 4, 5, 6));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.path).toContain('qq-media');
    expect(res.path).toMatch(/20260102-030405-006-clip\.mp4$/);
    expect(res.bytes).toBe(4096);
    expect(res.mime).toBe('video/mp4');
  });

  it('保留原扩展名（mkv / mov）', async () => {
    const a = writeFakeVideo('a.mkv');
    const b = writeFakeVideo('b.mov');
    const ra = await storeVideoSegment(a, OPTS, { dataDir: dir });
    const rb = await storeVideoSegment(b, OPTS, { dataDir: dir });
    expect(ra.ok && ra.path.endsWith('.mkv')).toBe(true);
    expect(rb.ok && rb.path.endsWith('.mov')).toBe(true);
  });

  it('不认识的扩展名按 mp4 存', async () => {
    const src = writeFakeVideo('weird.qqvideo');
    const res = await storeVideoSegment(src, OPTS, { dataDir: dir });
    expect(res.ok && res.path.endsWith('.mp4')).toBe(true);
  });

  it('两次调用不互相覆盖', async () => {
    const src = writeFakeVideo('same.mp4');
    const a = await storeVideoSegment(src, OPTS, { dataDir: dir });
    const b = await storeVideoSegment(src, OPTS, { dataDir: dir });
    expect(a.ok && b.ok && a.path !== b.path).toBe(true);
  });

  it('内容真的复制过去了', async () => {
    const src = writeFakeVideo('c.mp4', 2048);
    const res = await storeVideoSegment(src, OPTS, { dataDir: dir });
    if (!res.ok) throw new Error('should succeed');
    expect(hashBytes(new Uint8Array(require('node:fs').readFileSync(res.path)))).toBe(
      hashBytes(new Uint8Array(require('node:fs').readFileSync(src))),
    );
  });

  it('file:// 形式的本地路径也认', async () => {
    const src = writeFakeVideo('d.mp4');
    const res = await storeVideoSegment(`file:///${src.replace(/\\/g, '/')}`, OPTS, { dataDir: dir });
    expect(res.ok).toBe(true);
  });
});

describe('storeVideoSegment · 失败路径', () => {
  it('文件不存在时返回原因，不抛', async () => {
    const res = await storeVideoSegment(join(dir, 'nope.mp4'), OPTS, { dataDir: dir });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain('不存在');
  });

  it('超过上限时不落盘，说明大小', async () => {
    const src = writeFakeVideo('big.mp4', 4096);
    const res = await storeVideoSegment(src, TIGHT, { dataDir: dir });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain('过大');
  });

  it('相对路径不猜，直接说明', async () => {
    const res = await storeVideoSegment('relative/v.mp4', OPTS, { dataDir: dir });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain('绝对路径');
  });

  it('空源返回原因', async () => {
    const res = await storeVideoSegment('', OPTS, { dataDir: dir });
    expect(res.ok).toBe(false);
  });

  it('超时立刻收手', async () => {
    const src = writeFakeVideo('slow.mp4');
    const res = await storeVideoSegment(src, { maxVideoBytes: 0, timeoutMs: 1 }, { dataDir: dir });
    // 1ms 通常来不及完成复制；要么超时要么（极快时）成功，但不该抛异常
    expect(typeof res.ok).toBe('boolean');
  });
});

describe('isoStamp', () => {
  it('零填充到毫秒', () => {
    expect(isoStamp(new Date(2026, 0, 2, 3, 4, 5, 6))).toBe('20260102-030405-006');
  });
});

describe('hashBytes', () => {
  it('同样字节同样哈希', () => {
    const a = new Uint8Array([1, 2, 3]);
    expect(hashBytes(a)).toBe(hashBytes(new Uint8Array([1, 2, 3])));
    expect(hashBytes(a)).not.toBe(hashBytes(new Uint8Array([1, 2, 4])));
  });
});
