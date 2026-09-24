/**
 * 绝对路径的 CORTICO_HOME 解析部署根时不调 git。没装命令行工具的 macOS 上,/usr/bin/git
 * 一被调用就弹出安装对话框。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolve, sep } from 'node:path';

const calls: string[][] = [];
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    execFileSync: (cmd: string, args: readonly string[] = []) => { calls.push([cmd, ...args]); throw new Error('没有 git'); },
  };
});

const saved = process.env.CORTICO_HOME;
afterEach(() => {
  if (saved === undefined) delete process.env.CORTICO_HOME;
  else process.env.CORTICO_HOME = saved;
});

describe('deploymentRoot:绝对路径的 CORTICO_HOME', () => {
  it('原样采用,不调 git 去找主仓库根', async () => {
    const home = resolve(sep, 'app-data', 'home');
    process.env.CORTICO_HOME = home;
    const { deploymentRoot } = await import('../src/paths.ts');
    expect(deploymentRoot()).toBe(home);
    expect(calls).toEqual([]);
  });
});
