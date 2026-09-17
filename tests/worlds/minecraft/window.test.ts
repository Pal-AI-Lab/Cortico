import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../../src/worlds/minecraft/client-window.ps1', import.meta.url));

/**
 * 脚本自己的预算。一个 powershell 进程加脚本里 `Add-Type` 的一次 C# 现编,在 windows CI
 * 上与两个 vitest worker 抢四核,跑完要 4.5–12.5s;预算取最慢那次的五倍,用例的上限再翻
 * 一倍,给收进程与断言留出时间。
 */
const SCRIPT_BUDGET_MS = 60_000;

interface ScriptRun {
  out: string;
  ms: number;
}

function runScript(args: string[]): Promise<ScriptRun> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args],
      { windowsHide: true },
    );
    let out = '';
    proc.stdout.on('data', (c: Buffer) => { out += c.toString(); });
    proc.on('error', reject);
    const budget = setTimeout(() => proc.kill(), SCRIPT_BUDGET_MS);
    proc.on('close', () => {
      clearTimeout(budget);
      resolve({ out, ms: Date.now() - started });
    });
  });
}

describe.skipIf(process.platform !== 'win32')('client-window.ps1', () => {
  it('Find-OwnerWindow 不占用 PowerShell 自动变量 $PID', async () => {
    const { out, ms } = await runScript(['-OwnerPid', '1', '-SetTitle', 'cortico-title-probe']);
    const line = out.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
    expect(line, `脚本跑了 ${ms}ms 也没给出一行 JSON`).not.toBe('');
    const parsed = JSON.parse(line) as { ok?: boolean; error?: string };
    expect(parsed.error ?? '').not.toMatch(/overwrite variable pid/i);
    expect(parsed.ok === true || parsed.error === 'no-window').toBe(true);
  }, SCRIPT_BUDGET_MS * 2);
});
