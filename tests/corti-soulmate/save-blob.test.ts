/**
 * save_blob 的权限检查和落盘用同一条规范化后的路径:x/../people/alice.md 不能借 x/ 的权限覆盖 people/ 下的文件。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CortiSoulmate } from '../../bots/corti-soulmate/persona/index.ts';
import { makeCfg, makeFakeHarnessApi } from '../core/helpers.ts';
import { tmpPersona, cleanup, ctxFor, pick } from './helpers.ts';
import type { ToolDef } from '../../src/core/types.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

describe('save_blob 按落盘的那条路径过权限', () => {
  let dir: string;
  let tools: Record<'main' | 'dream', ToolDef[]>;

  beforeEach(() => {
    dir = tmpPersona();
    const core = new CortiSoulmate({ memoryDir: dir, cfg: makeCfg() });
    core.attach(makeFakeHarnessApi({ blob: (h) => (h.startsWith('log:abcdef01') ? { bytes: PNG, mime: 'image/png' } : null) }));
    const decls = core.declareSessions();
    tools = {
      main: decls.find((d) => d.id === 'main')!.tools(),
      dream: decls.find((d) => d.id === 'dream')!.tools(),
    };
    mkdirSync(join(dir, 'people'), { recursive: true });
    writeFileSync(join(dir, 'people', 'alice.md'), 'Alice:老朋友\n', 'utf8');
  });
  afterEach(() => cleanup(dir));

  it('main 用 x/../people/alice.md 被拒,people/alice.md 原样', async () => {
    const save = pick(tools.main, 'save_blob');
    for (const path of ['x/../people/alice.md', 'x\\..\\people\\alice.md', 'external/../people/alice.md']) {
      expect(await save.handler({ handle: 'log:abcdef01', path }, ctxFor('main'))).toMatch(/^\[save failed\] /);
    }
    expect(readFileSync(join(dir, 'people', 'alice.md'), 'utf8')).toBe('Alice:老朋友\n');
  });

  it('经 .. 指向点开头的路径同样拒绝', async () => {
    for (const role of ['main', 'dream'] as const) {
      const out = await pick(tools[role], 'save_blob').handler({ handle: 'log:abcdef01', path: 'x/../.git/config' }, ctxFor(role));
      expect(out).toMatch(/^\[save failed\] /);
    }
    expect(existsSync(join(dir, '.git', 'config'))).toBe(false);
  });

  it('正常路径照样成功;不带目录的名字落进 external/qq/images/', async () => {
    const out = await pick(tools.main, 'save_blob').handler({ handle: 'log:abcdef01', path: 'external/qq/images/cat.png' }, ctxFor('main'));
    expect(out).toBe(`[saved] mem:external/qq/images/cat.png image/png ${PNG.length} 字节`);
    expect(readFileSync(join(dir, 'external', 'qq', 'images', 'cat.png')).equals(PNG)).toBe(true);
    const bare = await pick(tools.dream, 'save_blob').handler({ handle: 'log:abcdef01', path: 'dog.png' }, ctxFor('dream'));
    expect(bare).toBe(`[saved] mem:external/qq/images/dog.png image/png ${PNG.length} 字节`);
    expect(readFileSync(join(dir, 'external', 'qq', 'images', 'dog.png')).equals(PNG)).toBe(true);
  });
});
