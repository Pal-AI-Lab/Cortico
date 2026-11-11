import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitWorkspaceMemory } from '../../bots/cormini/persona/memory.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function lockedFile(holdMs: number) {
  const root = mkdtempSync(join(tmpdir(), 'memory-atomic-busy-')); roots.push(root);
  const file = join(root, 'checkpoint.json'), ready = join(root, 'ready');
  writeFileSync(file, '{"revision":1}');
  // A separate process holds a real Windows handle without FILE_SHARE_DELETE.
  // It can release the handle while the synchronous writer waits.
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$stream=[IO.File]::Open($env:ATOMIC_TEST_FILE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite); try { [IO.File]::WriteAllText($env:ATOMIC_TEST_READY,"ready"); Start-Sleep -Milliseconds ([int]$env:ATOMIC_TEST_HOLD) } finally { $stream.Dispose() }'],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ATOMIC_TEST_FILE: file, ATOMIC_TEST_READY: ready, ATOMIC_TEST_HOLD: String(holdMs) } });
  let error = ''; child.stderr.on('data', chunk => { error += chunk; });
  const exited = new Promise<number | null>((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
  const deadline = Date.now() + 5000;
  while (!existsSync(ready) && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  if (!existsSync(ready)) { child.kill(); await exited; throw Error('Lock helper not ready: ' + error); }
  return { root, file, exited, memory: new GitWorkspaceMemory({ memoryDir: root }) };
}

describe.skipIf(process.platform !== 'win32')('atomic workspace publication under Windows file locks', () => {
  it('publishes the completed checkpoint after a temporary reader releases it', async () => {
    const fixture = await lockedFile(220);
    try {
      fixture.memory.writeFileAtomic('checkpoint.json', '{"revision":2,"receipt":"native-result"}');
      expect(JSON.parse(readFileSync(fixture.file, 'utf8'))).toEqual({ revision: 2, receipt: 'native-result' });
      expect(readdirSync(fixture.root).filter(name => name.includes('.tmp-'))).toEqual([]);
    } finally { await fixture.exited; }
  }, 10000);

  it('keeps the previous checkpoint and reports failure when the lock outlasts the bounded retry', async () => {
    const fixture = await lockedFile(3800);
    try {
      expect(() => fixture.memory.writeFileAtomic('checkpoint.json', '{"revision":2}')).toThrow();
      expect(JSON.parse(readFileSync(fixture.file, 'utf8'))).toEqual({ revision: 1 });
      expect(readdirSync(fixture.root).filter(name => name.includes('.tmp-'))).toEqual([]);
    } finally { await fixture.exited; }
  }, 10000);
});
