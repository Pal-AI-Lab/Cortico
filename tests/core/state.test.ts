import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** renameSync 的旁观钩子:node 内建模块的属性不可重定义,只能整module代理一次。 */
const fsHooks = vi.hoisted(() => ({ onRename: null as null | ((from: string, to: string) => void) }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    renameSync: (from: string, to: string) => {
      fsHooks.onRename?.(from, to);
      return actual.renameSync(from, to);
    },
  };
});
import { CoreState } from '../../src/core/state.ts';
import { makeTmpDir } from './helpers.ts';

describe('CoreState', () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  beforeEach(() => (tmp = makeTmpDir()));
  afterEach(() => tmp.cleanup());

  it('无文件时全默认值', () => {
    const s = new CoreState(tmp.dir);
    s.load();
    expect(s.data).toEqual({
      lastTruncateAt: null,
      lastDeliveredCursor: 0,
      llmStall: { since: 0, at: [] },
      persona: {},
      worldVisibility: {},
    });
  });

  // 连败记录须跨重启保留，供重启后第一次成功时结清并报告。
  it('LLM 连续失败记录跨重启保留，无效结构恢复为空记录', () => {
    const s = new CoreState(tmp.dir);
    s.load();
    s.data.llmStall = { since: 1000, at: [1000, 2000] };
    s.save();

    const back = new CoreState(tmp.dir);
    back.load();
    expect(back.data.llmStall).toEqual({ since: 1000, at: [1000, 2000] });

    writeFileSync(join(tmp.dir, 'core-state.json'), JSON.stringify({ llmStall: '坏了' }), 'utf8');
    const broken = new CoreState(tmp.dir);
    broken.load();
    expect(broken.data.llmStall).toEqual({ since: 0, at: [] });
  });

  it('save/load往返:人格状态袋原样存取(core不解释内容)', () => {
    const s = new CoreState(tmp.dir);
    s.load();
    s.data.lastTruncateAt = '2026-07-23T12:00:00+08:00';
    s.data.persona.emergences = ['想起A'];
    s.data.persona.随便什么键 = { n: 1 };
    s.save();
    const s2 = new CoreState(tmp.dir);
    s2.load();
    expect(s2.data.lastTruncateAt).toBe('2026-07-23T12:00:00+08:00');
    expect(s2.data.persona).toEqual({ emergences: ['想起A'], 随便什么键: { n: 1 } });
  });

  it('clear:重置为默认并落盘', () => {
    const s = new CoreState(tmp.dir);
    s.load();
    s.data.lastTruncateAt = '2026-07-23T12:00:00+08:00';
    s.data.persona.emergences = ['想起B'];
    s.save();
    s.clear();
    expect(s.data.lastTruncateAt).toBeNull();
    expect(s.data.persona).toEqual({});
    const s2 = new CoreState(tmp.dir);
    s2.load();
    expect(s2.data.lastTruncateAt).toBeNull();
  });

  it('部分字段缺失/文件损坏都回默认', () => {
    // 未声明的旧字段不加载，也不写回。
    writeFileSync(join(tmp.dir, 'core-state.json'), '{"lastDreamCursor":7,"softNoticeSent":true}', 'utf8');
    const s = new CoreState(tmp.dir);
    s.load();
    expect(s.data.lastTruncateAt).toBeNull();
    expect(s.data.persona).toEqual({});

    writeFileSync(join(tmp.dir, 'core-state.json'), '不是json', 'utf8');
    const s2 = new CoreState(tmp.dir);
    s2.load();
    expect(s2.data.lastTruncateAt).toBeNull();
  });

  // 状态文件替换期间必须保留原文件，避免重启将投递水位复位。
  it('落盘期间任何一刻状态文件都在盘上(rename 直接覆盖,不先删)', () => {
    const file = join(tmp.dir, 'core-state.json');
    const s = new CoreState(tmp.dir);
    s.load();
    s.data.lastDeliveredCursor = 172230;
    s.save();

    const seen: boolean[] = [];
    fsHooks.onRename = () => { seen.push(existsSync(file)); }; // 覆盖前旧文件必须还在
    try {
      s.data.lastDeliveredCursor = 198633;
      s.save();
    } finally {
      fsHooks.onRename = null;
    }
    expect(seen).toEqual([true]);

    const s2 = new CoreState(tmp.dir);
    s2.load();
    expect(s2.data.lastDeliveredCursor).toBe(198633);
  });

  it('rename 失败时旧状态文件原样留在盘上', () => {
    const file = join(tmp.dir, 'core-state.json');
    const s = new CoreState(tmp.dir);
    s.load();
    s.data.lastDeliveredCursor = 172230;
    s.save();

    fsHooks.onRename = () => { throw new Error('盘满'); };
    try {
      s.data.lastDeliveredCursor = 198633;
      expect(() => s.save()).toThrow('盘满');
    } finally {
      fsHooks.onRename = null;
    }
    expect(existsSync(file)).toBe(true);
    const s2 = new CoreState(tmp.dir);
    s2.load();
    expect(s2.data.lastDeliveredCursor).toBe(172230);
  });
});

describe('CoreState 在 Windows 上遇到文件被短暂占用', () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  beforeEach(() => {
    tmp = makeTmpDir();
    Object.defineProperty(process, 'platform', { value: 'win32' });
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    fsHooks.onRename = null;
    tmp.cleanup();
  });

  const busy = () => Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });

  it('占用几十毫秒后放开时 save 照常落盘', () => {
    const s = new CoreState(tmp.dir);
    s.load();
    let left = 2;
    fsHooks.onRename = () => { if (left-- > 0) throw busy(); };
    s.data.lastDeliveredCursor = 42;
    s.save();
    const s2 = new CoreState(tmp.dir);
    s2.load();
    expect(s2.data.lastDeliveredCursor).toBe(42);
  });

  it('一直被占用时 save 照原样抛出', () => {
    const s = new CoreState(tmp.dir);
    s.load();
    fsHooks.onRename = () => { throw busy(); };
    expect(() => s.save()).toThrow('EBUSY');
  });
});
