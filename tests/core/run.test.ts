import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeRun, openRun } from '../../src/core/run.ts';

describe('runs/index.jsonl', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('关机那行写不进时返回原因，不抛出', () => {
    dir = mkdtempSync(join(tmpdir(), 'cortico-run-'));
    const run = openRun(dir, { timezone: 'Asia/Shanghai', bot: 'test' });
    expect(run.indexError).toBeUndefined();
    // 占住文件名的目录让追加失败；原来这里抛出，关机流程里成了未处理的 promise 拒绝
    rmSync(join(run.runsDir, 'index.jsonl'));
    mkdirSync(join(run.runsDir, 'index.jsonl'));
    const error = closeRun(run, { endedAt: run.startedAt, lastCursor: 0, complete: true, reason: 'test' });
    expect(error).toBeTruthy();
  });
});
