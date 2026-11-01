import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeRun, openRun } from '../../src/core/run.ts';

describe('runs/index.jsonl', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('写不进时开机和关机都返回原因，不抛出', () => {
    dir = mkdtempSync(join(tmpdir(), 'cortico-run-'));
    // 占住文件名的目录让每次追加都失败，和被别的程序独占时一样走失败分支
    mkdirSync(join(dir, 'runs', 'index.jsonl'), { recursive: true });
    const run = openRun(dir, { timezone: 'Asia/Shanghai', bot: 'test' });
    expect(run.indexError).toBeTruthy();
    const error = closeRun(run, { endedAt: run.startedAt, lastCursor: 0, complete: true, reason: 'test' });
    expect(error).toBeTruthy();
  });
});
