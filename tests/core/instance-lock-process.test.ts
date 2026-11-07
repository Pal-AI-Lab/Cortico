import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { acquireInstanceLock, INSTANCE_LOCK_FILE, InstanceLockedError, instanceIsRunning } from '../../src/core/instance-lock.ts';
import { makeTmpDir } from './helpers.ts';

it('a renamed child remains the lock owner until it exits', async () => {
  const tmp = makeTmpDir();
  const child = spawn(process.execPath, ['-e', `
    process.title = 'renamed lock owner';
    process.send({ pid: process.pid, execPath: process.execPath });
    process.on('disconnect', () => process.exit());
  `], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(child, 'exit');
  try {
    const [owner] = await once(child, 'message');
    const file = join(tmp.dir, INSTANCE_LOCK_FILE);
    const content = JSON.stringify({ ...owner, startedAt: new Date().toISOString(), argv: [] });
    writeFileSync(file, content);
    expect(instanceIsRunning(tmp.dir)).toBe(true);
    expect(() => acquireInstanceLock(tmp.dir)).toThrow(InstanceLockedError);
    const forced = acquireInstanceLock(tmp.dir, { force: true });
    expect(forced.owns).toBe(false);
    forced.release();
    expect(readFileSync(file, 'utf8')).toBe(content);
    child.kill();
    await exited;
    expect(instanceIsRunning(tmp.dir)).toBe(false);
    const replacement = acquireInstanceLock(tmp.dir);
    expect(replacement.owns).toBe(true);
    replacement.release();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    tmp.cleanup();
  }
});

it.skipIf(process.platform !== 'darwin')('macOS recognizes an executable name longer than its accounting name', async () => {
  const tmp = makeTmpDir();
  const executable = join(tmp.dir, 'long-executable-name');
  copyFileSync('/bin/sleep', executable);
  const child = spawn(executable, ['60'], { stdio: 'ignore' });
  const exited = once(child, 'exit');
  try {
    await once(child, 'spawn');
    writeFileSync(join(tmp.dir, INSTANCE_LOCK_FILE), JSON.stringify({
      pid: child.pid, execPath: executable, startedAt: new Date().toISOString(), argv: [],
    }));
    expect(instanceIsRunning(tmp.dir)).toBe(true);
    expect(() => acquireInstanceLock(tmp.dir)).toThrow(InstanceLockedError);
  } finally {
    child.kill();
    await exited;
    tmp.cleanup();
  }
});
