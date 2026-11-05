/** 重启等待:轮询 /api/run/lifecycle,同一部署换了 bootId 且就绪才算回来。 */

import { afterEach, describe, expect, it, vi } from 'vitest';

type Any = any;

const RESTART = '../../src/web/client/core/restart.ts';
const { restartOutcome, waitForRestart } = (await import(RESTART)) as Any;

const boot = (over: Record<string, unknown> = {}): Any => ({ deployment: 'dep', bootId: 'b1', ready: true, ...over });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('restartOutcome', () => {
  it('同一部署换了 bootId 且就绪才算回来了', () => {
    const before = boot();
    expect(restartOutcome(before, before)).toBe('waiting');
    expect(restartOutcome(before, boot({ bootId: 'b2', ready: false }))).toBe('waiting');
    expect(restartOutcome(before, boot({ bootId: 'b2' }))).toBe('ready');
    expect(restartOutcome(before, boot({ deployment: 'other', bootId: 'b2' }))).toBe('wrong-deployment');
  });
});

describe('waitForRestart', () => {
  it('旧进程还在应答时继续等,换了 bootId 且就绪就停', async () => {
    vi.useFakeTimers();
    const replies = [boot(), boot(), boot({ bootId: 'b2' })];
    let calls = 0;
    vi.stubGlobal('fetch', () => {
      const payload = replies[Math.min(calls++, replies.length - 1)];
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(payload)) });
    });

    const ready = vi.fn();
    waitForRestart({
      before: boot(), signal: new AbortController().signal, onReady: ready, intervalMs: 10,
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(calls).toBe(3);
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it('连不上就继续等', async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal('fetch', () => {
      calls++;
      if (calls === 1) return Promise.reject(new Error('connect ECONNREFUSED'));
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(boot({ bootId: 'b2' }))) });
    });

    const ready = vi.fn();
    waitForRestart({
      before: boot(), signal: new AbortController().signal, onReady: ready, intervalMs: 10,
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(ready).toHaveBeenCalledTimes(1);
  });

  it('换成了另一个部署就停下并报告', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', () => Promise.resolve({
      ok: true, status: 200,
      text: () => Promise.resolve(JSON.stringify(boot({ deployment: 'other', bootId: 'b2' }))),
    }));

    const ready = vi.fn();
    const wrong = vi.fn();
    waitForRestart({
      before: boot(), signal: new AbortController().signal, onReady: ready, onWrongDeployment: wrong, intervalMs: 10,
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(wrong).toHaveBeenCalledTimes(1);
    expect(ready).not.toHaveBeenCalled();
  });
});
