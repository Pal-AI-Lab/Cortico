import type { OutputTap } from '../../src/core/types.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { quietLine } from '../../bots/cormini/persona/heartbeat.ts';
import { Cormini, CORMINI_ORIENTATION_FILE } from '../../bots/cormini/persona/persona.ts';
import type { World } from '../../src/core/types.ts';
import { makeFakeHarnessApi } from '../core/helpers.ts';

describe('CortiV 实时参数化', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cormini-rt-'))));
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  function fakeWorld(patch: Partial<World>): World {
    return {
      id: 'probe',
      envPromptVars: () => ({}),
      tools: () => [],
      start: async () => {},
      stop: async () => {},
      ...patch,
    };
  }

  it('outputTap 取自挂载 World 的接收器;投递刻抬头经注入原语、只数外部项', () => {
    const tap: OutputTap = { onEvent: () => {} };
    const worlds: World[] = [fakeWorld({ outputTap: () => tap })];
    const p = new Cormini({
      memoryDir: dir,
      worlds: worlds,
      orientation: 'REALTIME ORIENTATION TEXT',
    });
    const decl = p.declareSessions()[0];
    expect(decl.outputTap).toBe(tap);
    // 挂载表是活引用:World 卸下后 tap 随之消失,session 不再流式
    worlds.length = 0;
    expect(decl.outputTap).toBeUndefined();
    const injected: string[] = [];
    p.attach(makeFakeHarnessApi({ injectInternal: (text) => injected.push(text) }));
    p.onDelivery({
      events: [
        { cursor: 1, type: 't', ts: '', source: 's', origin: 'external', text: 'a' },
        { cursor: 2, type: 't', ts: '', source: 's', origin: 'external', text: 'b' },
        { cursor: 3, type: 'tick', ts: '', source: 'persona', origin: 'internal', text: 'c' },
      ],
    });
    expect(injected).toEqual(['[system] 2 条新事件。']);
  });

  it('不给 orientation 就读默认源文件(与 WebUI 改的是同一份)', async () => {
    const p = new Cormini({ memoryDir: dir });
    const segs = await p.systemSegments({ now: new Date(), timezone: 'Asia/Shanghai', worlds: [] });
    expect(segs.find((s) => s.title === 'ORIENTATION')?.text)
      .toBe(readFileSync(CORMINI_ORIENTATION_FILE, 'utf8').trim());
  });

  it('orientation 传函数则每次拼前缀时重取(WebUI 改源文件后重载即生效)', async () => {
    let text = '第一版定向';
    const p = new Cormini({ memoryDir: dir, orientation: () => text });
    const first = await p.systemSegments({ now: new Date(), timezone: 'Asia/Shanghai', worlds: [] });
    expect(first.find((s) => s.title === 'ORIENTATION')?.text).toBe('第一版定向');
    text = '改过的定向';
    const second = await p.systemSegments({ now: new Date(), timezone: 'Asia/Shanghai', worlds: [] });
    expect(second.find((s) => s.title === 'ORIENTATION')?.text).toBe('改过的定向');
  });

  it('外部正文一律落在工具回执区:声明不带 eventDelivery 与 tap', () => {
    const p = new Cormini({ memoryDir: dir });
    const decl = p.declareSessions()[0];
    expect(decl.eventDelivery).toBeUndefined();
    expect(decl.outputTap).toBeUndefined();
    // 外部正文由 core 以保留帧投递;session 不声明同名(含旧名)工具。
    const names = decl.tools().map((t) => t.name);
    expect(names).not.toContain('external_event_frame');
    expect(names).not.toContain('observe');
  });

  it('tick 是投递成文项(发车刻渲染)', async () => {
    vi.useFakeTimers();
    const rendered: string[] = [];
    const p = new Cormini({
      memoryDir: dir,
      tickDelayMs: () => 40,
    });
    p.attach(makeFakeHarnessApi({
      injectDeferred: (_kind, render) => {
        void Promise.resolve(render()).then((t) => { if (t !== null) rendered.push(t); });
      },
    }));
    p.startRhythm();
    await vi.advanceTimersByTimeAsync(40);
    p.stopRhythm();
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toContain('已安静');
  });

  /**
   * 不足一分钟的静默按秒显示，避免快心跳被四舍五入成零分钟。
   */
  it('安静不到一分钟按秒说,不再印 0 分钟', () => {
    expect(quietLine(0)).toBe('[system] 已安静 0 秒。');
    expect(quietLine(1)).toBe('[system] 已安静 1 秒。');
    expect(quietLine(15)).toBe('[system] 已安静 15 秒。');
    expect(quietLine(59)).toBe('[system] 已安静 59 秒。');
    // 满一分钟才换单位;向下取整,「1 分钟」是真的过了一分钟
    expect(quietLine(60)).toBe('[system] 已安静 1 分钟。');
    expect(quietLine(119)).toBe('[system] 已安静 1 分钟。');
    expect(quietLine(2700)).toBe('[system] 已安静 45 分钟。');
  });

  /**
   * 连续空拍使间隔逐次翻倍； World 投递 flush 事件也算活动，会复位计数。
   */
  it('连着空拍:基线逐次翻倍', async () => {
    vi.useFakeTimers();
    let fires = 0;
    const p = new Cormini({ memoryDir: dir, tickDelayMs: () => 30 });
    p.attach(makeFakeHarnessApi({ injectDeferred: () => { fires++; } }));
    p.startRhythm();
    // 首拍后仍按基线等待；后续无人活动的间隔逐次翻倍。
    for (const [index, delay] of [30, 30, 60, 120].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(fires).toBe(index);
      await vi.advanceTimersByTimeAsync(1);
      expect(fires).toBe(index + 1);
    }
    p.stopRhythm();
  });

  it('外部事件到达即复位回退', async () => {
    vi.useFakeTimers();
    let fires = 0;
    const p = new Cormini({ memoryDir: dir, tickDelayMs: () => 30 });
    p.attach(makeFakeHarnessApi({ injectDeferred: () => { fires++; } }));
    p.startRhythm();
    await vi.advanceTimersByTimeAsync(80);
    expect(fires).toBe(2);
    p.onDelivery({
      events: [{ cursor: 1, type: 't', ts: '', source: 's', origin: 'external', text: 'a' }],
    });
    await vi.advanceTimersByTimeAsync(40);
    expect(fires).toBe(3);
    await vi.advanceTimersByTimeAsync(29);
    expect(fires).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(fires).toBe(4);
    p.stopRhythm();
  });

  it('没有提示时用基线;基线 null 则不心跳', async () => {
    vi.useFakeTimers();
    const injected: string[] = [];
    const p = new Cormini({ memoryDir: dir });
    p.attach(makeFakeHarnessApi({ injectDeferred: (kind) => injected.push(kind) }));
    p.startRhythm();
    await vi.advanceTimersByTimeAsync(150);
    p.stopRhythm();
    expect(injected).toHaveLength(0);
  });
});
