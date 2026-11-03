/**
 * Workspace Memory 的二进制工件:`mem:` 句柄 = 工作区相对路径;save_blob 把看见过的日志附件
 * 存进 blobs/;read_file 读到 blobs/ 下的文件时回执附句柄而不是正文;前缀清单把 blobs/ 折叠为计数。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cormini } from '../../bots/cormini/persona/persona.ts';
import { saveBlobTool } from '../../bots/cormini/persona/blobs.ts';
import { WorkspaceBlobStore } from '../../bots/cormini/persona/memory.ts';
import { nullLogger } from '../../src/core/util.ts';
import type { ToolOutcome } from '../../src/core/types.ts';
import { makeFakeHarnessApi } from '../core/helpers.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const ctx = { role: 'main', log: nullLogger() };

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cormini-blobs-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('WorkspaceBlobStore', () => {
  it('put 落进 blobs/(名字提示不带目录时),句柄即工作区相对路径;get 按句柄取回字节与 mime', () => {
    const store = new WorkspaceBlobStore(dir);
    const handle = store.put('cat.png', PNG, 'image/png');
    expect(handle).toBe('mem:blobs/cat.png');
    expect(existsSync(join(dir, 'blobs', 'cat.png'))).toBe(true);
    const got = store.get(handle)!;
    expect(Buffer.from(got.bytes).equals(PNG)).toBe(true);
    expect(got.mime).toBe('image/png');
  });

  it('带目录的名字提示按给的路径落;get 认工作区里任何文件,拒绝逃逸与目录', () => {
    const store = new WorkspaceBlobStore(dir);
    expect(store.put('blobs/stickers/dog.jpg', PNG, 'image/jpeg')).toBe('mem:blobs/stickers/dog.jpg');
    mkdirSync(join(dir, 'external', 'qq', 'images'), { recursive: true });
    writeFileSync(join(dir, 'external', 'qq', 'images', 'old.png'), PNG);
    expect(store.get('mem:external/qq/images/old.png')?.mime).toBe('image/png');
    expect(store.get('mem:../secret.png')).toBeNull();
    expect(store.get('mem:blobs')).toBeNull();
    expect(store.get('mem:blobs/missing.png')).toBeNull();
  });

  it('list 默认列 blobs/ 下全部,带大小与 mime;目录不存在给空表', () => {
    const store = new WorkspaceBlobStore(dir);
    expect(store.list()).toEqual([]);
    store.put('a.png', PNG, 'image/png');
    store.put('blobs/deep/b.pdf', PNG, 'application/pdf');
    expect(store.list()).toEqual([
      { handle: 'mem:blobs/a.png', mime: 'image/png', size: PNG.length },
      { handle: 'mem:blobs/deep/b.pdf', mime: 'application/pdf', size: PNG.length },
    ]);
  });
});

describe('save_blob 与 read_file 的二进制回执', () => {
  it('save_blob 从 core 取日志附件,存进工作区,回 mem: 句柄', async () => {
    const store = new WorkspaceBlobStore(dir);
    const core = makeFakeHarnessApi({
      blob: (handle) => (handle.startsWith('log:abc') ? { bytes: PNG, mime: 'image/png' } : null),
    });
    const tool = saveBlobTool({ blobs: store, core: () => core });
    const out = await tool.handler({ handle: 'log:abcdef01', path: 'blobs/stickers/cat.png' }, ctx);
    expect(out).toBe(`[saved] mem:blobs/stickers/cat.png image/png ${PNG.length} 字节`);
    expect(readFileSync(join(dir, 'blobs', 'stickers', 'cat.png')).equals(PNG)).toBe(true);
    expect(await tool.handler({ handle: 'abcdef01', path: 'blobs/bare.png' }, ctx)).toBe(`[saved] mem:blobs/bare.png image/png ${PNG.length} 字节`);
    expect(await tool.handler({ handle: 'log:nope', path: 'blobs/x.png' }, ctx)).toContain('[save failed] 没有 log:nope');
    expect(await tool.handler({ handle: 'log:abcdef01', path: '../x.png' }, ctx)).toContain('[save failed]');
  });

  it('resolvePath 给出 put 实际写入的路径;含 .. 或点开头的段直接拒绝', () => {
    const store = new WorkspaceBlobStore(dir);
    expect(store.resolvePath('cat.png')).toBe('blobs/cat.png');
    expect(store.resolvePath('./notes/a.png')).toBe('notes/a.png');
    expect(store.resolvePath('notes\\b.png')).toBe('notes/b.png');
    for (const bad of ['x/../people/alice.md', 'x\\..\\people\\alice.md', '../x.png', '.git/config', 'x/../.gitattributes']) {
      expect(() => store.resolvePath(bad)).toThrow();
    }
  });

  it('guard 拿到的是规范化后的落点,和 put 写的是同一条路径', async () => {
    const store = new WorkspaceBlobStore(dir);
    const core = makeFakeHarnessApi({ blob: () => ({ bytes: PNG, mime: 'image/png' }) });
    const seen: string[] = [];
    const tool = saveBlobTool({ blobs: store, core: () => core, guard: (p) => { seen.push(p); return p.startsWith('people/') ? '只能追加' : null; } });
    expect(await tool.handler({ handle: 'log:abcdef01', path: 'cat.png' }, ctx)).toBe(`[saved] mem:blobs/cat.png image/png ${PNG.length} 字节`);
    expect(await tool.handler({ handle: 'log:abcdef01', path: './stickers/dog.png' }, ctx)).toBe(`[saved] mem:stickers/dog.png image/png ${PNG.length} 字节`);
    expect(seen).toEqual(['blobs/cat.png', 'stickers/dog.png']);
    expect(await tool.handler({ handle: 'log:abcdef01', path: 'people/alice.md' }, ctx)).toBe('[save failed] 只能追加');
    expect(await tool.handler({ handle: 'log:abcdef01', path: 'x/../people/alice.md' }, ctx)).toMatch(/^\[save failed\] /);
    expect(existsSync(join(dir, 'people', 'alice.md'))).toBe(false);
  });

  it.skipIf(process.platform !== 'win32')('Windows 上大小写或 8.3 短名不同的写法被拒,guard 按文件名判断也不会漏', async () => {
    const store = new WorkspaceBlobStore(dir);
    const core = makeFakeHarnessApi({ blob: () => ({ bytes: PNG, mime: 'image/png' }) });
    const kept = ['notes/keep.md', 'notes/keep-longname.md'];
    const tool = saveBlobTool({ blobs: store, core: () => core, guard: (p) => (kept.includes(p) ? '这份不能覆盖' : null) });
    mkdirSync(join(dir, 'notes'), { recursive: true });
    for (const rel of kept) writeFileSync(join(dir, rel), '原样\n', 'utf8');
    expect(await tool.handler({ handle: 'log:abcdef01', path: 'Notes/KEEP.md' }, ctx)).toMatch(/^\[save failed\] /);
    let short = false;
    try {
      short = realpathSync.native(join(dir, 'notes', 'KEEP-L~1.MD')) === realpathSync.native(join(dir, 'notes', 'keep-longname.md'));
    } catch { /* 卷上没有短名 */ }
    if (short) expect(await tool.handler({ handle: 'log:abcdef01', path: 'notes/KEEP-L~1.MD' }, ctx)).toMatch(/^\[save failed\] /);
    for (const rel of kept) expect(readFileSync(join(dir, rel), 'utf8')).toBe('原样\n');
  });

  it('Cormini 主 session 带 save_blob;read_file 读 blobs/ 下的文件回执附句柄,不回正文', async () => {
    const p = new Cormini({ memoryDir: dir });
    p.attach(makeFakeHarnessApi({ blob: () => ({ bytes: PNG, mime: 'image/png' }) }));
    const tools = p.declareSessions()[0].tools();
    const save = tools.find((t) => t.name === 'save_blob')!;
    expect(save.tags).toEqual(['write']);
    await save.handler({ handle: 'log:abcdef01', path: 'blobs/cat.png' }, ctx);
    const read = tools.find((t) => t.name === 'read_file')!;
    const out = (await read.handler({ path: 'blobs/cat.png' }, ctx)) as ToolOutcome;
    expect(out.text).toBe('');
    expect(out.blobs).toEqual([{ handle: 'mem:blobs/cat.png', fallbackText: `image/png ${PNG.length} 字节` }]);
    expect(await read.handler({ path: 'blobs/missing.png' }, ctx)).toBe('[not found] blobs/missing.png');
    // 工作区清单里 blobs/ 折叠为计数
    const seg = (await p.systemSegments({ now: new Date(), timezone: 'UTC', worlds: [] })).find((s) => s.title === 'WORKSPACE')!;
    expect(seg.text).toContain('blobs/ (1 份二进制');
    expect(seg.text).not.toContain('blobs/cat.png');
  });
});
