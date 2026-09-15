/** 验证部署选择、pnpm 发现与子进程重启条件;监管测试使用本地假子进程。 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';

import {
  RESTART_FLAG_FILE,
  chooseBot,
  parseArgs,
  parseRequest,
  pnpmMissingMessage,
  promptChoice,
  resolvePnpm,
  shouldRelaunch,
  supervise,
} from '../bin/cortico.mjs';

/** 假终端要在 Readable 上补 isTTY / setRawMode,类型上没有这两项。 */
type Any = any;

/** 回车键送进输入流的字节。 */
const ENTER = String.fromCharCode(13);

describe('shouldRelaunch', () => {
  const never = () => false;

  it('子进程明说要重启就重起', () => {
    expect(shouldRelaunch({ askedRestart: true, dataDir: null, exists: never })).toBe(true);
  });

  it('缺少 IPC 消息但存在重启标志时重新启动', () => {
    const dataDir = '/deploy/data';
    const exists = (p: string) => p === join(dataDir, RESTART_FLAG_FILE);
    expect(shouldRelaunch({ askedRestart: false, dataDir, exists })).toBe(true);
  });

  it('崩溃不重起:没人说过要重启,标志文件也不在', () => {
    expect(shouldRelaunch({ askedRestart: false, dataDir: '/deploy/data', exists: never })).toBe(false);
  });

  it('未收到 data 目录时不检查重启标志', () => {
    expect(shouldRelaunch({ askedRestart: false, dataDir: null, exists: never })).toBe(false);
  });
});

describe('parseArgs', () => {
  it('第一个不带 - 的参数是部署名,其余透传', () => {
    expect(parseArgs(['cortiv', '--paused'])).toEqual({ bot: 'cortiv', passthrough: ['--paused'] });
  });

  it('只有开关时没有部署名', () => {
    expect(parseArgs(['--log-level=debug'])).toEqual({ bot: null, passthrough: ['--log-level=debug'] });
  });

  it('空参数表', () => {
    expect(parseArgs([])).toEqual({ bot: null, passthrough: [] });
  });
});

describe('parseRequest', () => {
  it('--list 就是列清单,不启动任何部署', () => {
    expect(parseRequest(['--list'], {})).toEqual({ kind: 'list' });
    expect(parseRequest(['cortiv', '--list'], {})).toEqual({ kind: 'list' });
  });

  it('不给名字时取 CORTICO_BOT', () => {
    expect(parseRequest([], { CORTICO_BOT: 'cortiv' })).toEqual({
      kind: 'run', bot: 'cortiv', passthrough: [],
    });
  });

  it('命令行上的名字压过 CORTICO_BOT,其余参数原样透传', () => {
    expect(parseRequest(['cormini', '--paused'], { CORTICO_BOT: 'cortiv' })).toEqual({
      kind: 'run', bot: 'cormini', passthrough: ['--paused'],
    });
  });

  it('两处都没有名字:留给部署菜单', () => {
    expect(parseRequest([], {})).toEqual({ kind: 'run', bot: null, passthrough: [] });
  });
});

describe('chooseBot', () => {
  it('给了名字就用它', () => {
    expect(chooseBot({ bot: 'b', available: ['a', 'b'], interactive: true })).toEqual({ kind: 'run', bot: 'b' });
  });

  it('名字不在清单里:把可选项摆出来', () => {
    const out = chooseBot({ bot: 'zz', available: ['a', 'b'], interactive: true });
    expect(out.kind).toBe('error');
    expect(out.kind === 'error' && out.message).toContain('a / b');
  });

  it('只有一份部署就不问', () => {
    expect(chooseBot({ bot: null, available: ['only'], interactive: true })).toEqual({ kind: 'run', bot: 'only' });
  });

  it('多份 + 交互终端 → 弹菜单', () => {
    expect(chooseBot({ bot: null, available: ['a', 'b'], interactive: true })).toEqual({ kind: 'ask' });
  });

  it('多份部署且非交互时要求指定名称并列出可选项', () => {
    const out = chooseBot({ bot: null, available: ['a', 'b'], interactive: false });
    expect(out.kind).toBe('error');
    expect(out.kind === 'error' && out.message).toContain('a / b');
  });

  it('一份都没有', () => {
    const out = chooseBot({ bot: null, available: [], interactive: true });
    expect(out.kind).toBe('error');
    expect(out.kind === 'error' && out.message).toContain('deployment.json');
  });
});

describe('promptChoice', () => {
  /** 一个可写可读的假终端:记下每次 raw 模式切换。 */
  function fakeTty(): { stream: Any; modes: boolean[] } {
    const stream = new PassThrough() as Any;
    const modes: boolean[] = [];
    stream.isTTY = true;
    stream.setRawMode = (on: boolean) => { modes.push(on); };
    return { stream, modes };
  }

  it('选完就退出 raw 模式,并摘掉自己挂的 exit 监听', async () => {
    const { stream: input, modes } = fakeTty();
    const exitListeners = process.listenerCount('exit');
    const picked = promptChoice(['alpha', 'beta'], new PassThrough() as Any, input);
    input.write(ENTER);
    expect(await picked).toBe('alpha');
    expect(modes).toEqual([true, false]);
    expect(process.listenerCount('exit')).toBe(exitListeners);
  });

  it('菜单开着时进程退出:exit 监听把终端从 raw 模式带回来', async () => {
    const { stream: input, modes } = fakeTty();
    const picked = promptChoice(['alpha', 'beta'], new PassThrough() as Any, input);
    const restore = process.listeners('exit').at(-1) as () => void;
    restore();
    expect(modes).toEqual([true, false]);
    input.write(ENTER);
    await picked;
  });
});

describe('resolvePnpm', () => {
  it('优先使用 corepack 提供项目指定版本的 pnpm', () => {
    expect(resolvePnpm(() => true)).toEqual({ command: 'corepack', prefix: ['pnpm'] });
  });

  it('没有 corepack 就用 PATH 上的 pnpm', () => {
    expect(resolvePnpm((c: string) => c === 'pnpm')).toEqual({ command: 'pnpm', prefix: [] });
  });

  it('两个都没有', () => {
    expect(resolvePnpm(() => false)).toBeNull();
  });
});

describe('pnpmMissingMessage', () => {
  it('Node 太旧:指路 nodejs.org', () => {
    expect(pnpmMissingMessage(20)).toContain('nodejs.org');
  });

  it('Node 版本满足要求但缺少 pnpm 时提示安装 pnpm', () => {
    const text = pnpmMissingMessage(25);
    expect(text).toContain('npm i -g pnpm');
    expect(text).not.toContain('nodejs.org');
  });
});

describe('子进程监管', () => {
  const entry = fileURLToPath(new URL('./fixtures/launcher/fake-child.mjs', import.meta.url));
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });


  async function run(mode: string): Promise<{ code: number; runs: number }> {
    const dir = mkdtempSync(join(tmpdir(), 'cortico-supervise-'));
    dirs.push(dir);
    const logFile = join(dir, 'runs.log');
    writeFileSync(logFile, '');
    const previous = { ...process.env };
    Object.assign(process.env, {
      CORTICO_FAKE_MODE: mode,
      CORTICO_FAKE_DATA_DIR: dir,
      CORTICO_FAKE_LOG: logFile,
    });
    try {
      const code = await supervise('fake', [], false, { entry, execArgv: [], log: () => {}, warn: () => {} });
      const runs = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).length;
      return { code, runs };
    } finally {
      for (const k of ['CORTICO_FAKE_MODE', 'CORTICO_FAKE_DATA_DIR', 'CORTICO_FAKE_LOG']) delete process.env[k];
      Object.assign(process.env, previous);
    }
  }

  it('正常退出后不再启动', async () => {
    expect(await run('clean')).toEqual({ code: 0, runs: 1 });
  });

  it('子进程请求重启:再起一次', async () => {
    expect(await run('ready-restart')).toEqual({ code: 0, runs: 2 });
  });

  it('IPC 没发出去但标志文件在:照样再起一次', async () => {
    expect(await run('flag-only')).toEqual({ code: 0, runs: 2 });
  });

  it('崩溃不自动重启:只起一次,退出码原样透出去', async () => {
    expect(await run('crash')).toEqual({ code: 3, runs: 1 });
  });
});
