// @ts-check
/**
 * 启动前准备依赖与控制台产物，选择部署并监管 src/launcher.ts 子进程。
 * 此入口需要在 node_modules 不存在时运行，不得依赖第三方包。
 */
import { spawnSync, fork } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { emitKeypressEvents } from 'node:readline';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webAssetsProblem } from './web-assets.mjs';

/** 仓库根:本文件在 `<根>/bin/` 下。 */
export const REPO_ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));

/** 与 src/boot.ts 的 RESTART_MESSAGE 保持一致。 */
export const RESTART_MESSAGE = 'cortico:restart';
/** 子进程上报 data 目录；与 src/boot.ts 的 READY_MESSAGE 保持一致。 */
export const READY_MESSAGE = 'cortico:ready';
/** 重启标志文件名;与 src/boot.ts 的 `RESTART_FLAG_FILE` 是同一个字面量。 */
export const RESTART_FLAG_FILE = '.restart-request';

const MIN_NODE_MAJOR = 22;

/**
 * 收到重启 IPC 消息或检测到重启标志文件时重新启动；其他退出不自动重启。
 * 标志文件用于 IPC 通知中断时保留请求。
 *
 * @param {{ askedRestart: boolean, dataDir: string | null, exists?: (path: string) => boolean }} state
 * @returns {boolean}
 */
export function shouldRelaunch(state) {
  if (state.askedRestart) return true;
  if (!state.dataDir) return false;
  const exists = state.exists ?? existsSync;
  return exists(join(state.dataDir, RESTART_FLAG_FILE));
}

/**
 * 从命令行里挑出部署名。第一个不以 `-` 开头的参数就是它;其余原样透传给 launcher。
 *
 * @param {readonly string[]} argv 已去掉 node 与脚本自身的那一段
 * @returns {{ bot: string | null, passthrough: string[] }}
 */
export function parseArgs(argv) {
  const bot = argv.find((a) => !a.startsWith('-')) ?? null;
  return { bot, passthrough: argv.filter((a) => a !== bot) };
}

/**
 * 这一趟要做什么:列出部署,还是启动某一份。不给名字时用 `CORTICO_BOT`。
 *
 * @param {readonly string[]} argv 已去掉 node 与脚本自身的那一段
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ kind: 'list' } | { kind: 'run', bot: string | null, passthrough: string[] }}
 */
export function parseRequest(argv, env) {
  const { bot, passthrough } = parseArgs(argv);
  if (passthrough.includes('--list')) return { kind: 'list' };
  return { kind: 'run', bot: bot ?? env.CORTICO_BOT ?? null, passthrough };
}

/**
 * 未指定部署且有多个可选项时,交互终端返回 ask,非交互终端返回错误与可选项。
 *
 * @param {{ bot: string | null, available: readonly string[], interactive: boolean }} input
 * @returns {{ kind: 'run', bot: string } | { kind: 'ask' } | { kind: 'error', message: string }}
 */
export function chooseBot(input) {
  const { bot, available, interactive } = input;
  if (available.length === 0) {
    return { kind: 'error', message: '部署根下没有含 deployment.json 的部署目录。' };
  }
  if (bot) {
    if (available.includes(bot)) return { kind: 'run', bot };
    return { kind: 'error', message: `没有这个部署: ${bot}。可选:${available.join(' / ')}` };
  }
  if (available.length === 1) return { kind: 'run', bot: available[0] };
  if (interactive) return { kind: 'ask' };
  return {
    kind: 'error',
    message: `有多份部署,非交互终端上要指定启动哪一个:${available.join(' / ')}`,
  };
}

/**
 * @param {(cmd: string) => boolean} has
 * @returns {{ command: string, prefix: string[] } | null}
 */
export function resolvePnpm(has) {
  if (has('corepack')) return { command: 'corepack', prefix: ['pnpm'] };
  if (has('pnpm')) return { command: 'pnpm', prefix: [] };
  return null;
}

export function pnpmMissingMessage(nodeMajor = Number(process.versions.node.split('.')[0])) {
  if (nodeMajor < MIN_NODE_MAJOR) {
    return `Node ${process.versions.node} 太旧,需要 ${MIN_NODE_MAJOR}+。下载 https://nodejs.org`;
  }
  return '找不到 pnpm。请安装：npm i -g pnpm';
}

/** @param {string} cmd */
function onPath(cmd) {
  const probe = process.platform === 'win32'
    ? spawnSync('where', [cmd], { stdio: 'ignore', windowsHide: true, shell: false })
    : spawnSync('command', ['-v', cmd], { stdio: 'ignore', shell: '/bin/sh' });
  return probe.status === 0;
}

/**
 * 同步执行 pnpm 命令并继承终端输入输出。
 * @param {{ command: string, prefix: string[] }} pnpm
 * @param {string[]} args
 */
function runPnpm(pnpm, args) {
  const result = spawnSync(pnpm.command, [...pnpm.prefix, ...args], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    // Windows 上的 .cmd 启动文件需要经 shell 执行。
    shell: process.platform === 'win32',
    env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
  });
  return result.status ?? 1;
}

/**
 * 执行 pnpm 命令并返回 stdout。
 * @param {{ command: string, prefix: string[] }} pnpm
 * @param {string[]} args
 */
function readPnpm(pnpm, args) {
  const result = spawnSync(pnpm.command, [...pnpm.prefix, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    windowsHide: true,
    shell: process.platform === 'win32',
    env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
  });
  if (result.status !== 0) {
    throw new Error(`pnpm ${args.join(' ')} 失败:\n${(result.stderr || result.stdout || '').trim()}`);
  }
  return result.stdout;
}

/**
 * @param {readonly string[]} items
 * @returns {Promise<string | null>} null = 操作员按了 Esc
 */
export function promptChoice(items, out = process.stdout, input = process.stdin) {
  return new Promise((done) => {
    let idx = 0;
    // 非 TTY 输入也需要 keypress 事件，不能依赖 readline 的 TTY 初始化。
    emitKeypressEvents(input);
    if (input.isTTY) input.setRawMode(true);
    const draw = (first = false) => {
      if (!first) out.write(`\u001b[${items.length}A`);
      for (const [i, name] of items.entries()) {
        const mark = i === idx ? '\u001b[36m>' : ' ';
        out.write(`  ${mark} ${name}\u001b[0m\u001b[K\n`);
      }
    };
    // 每条退出路径都要退出 raw 模式,包括不经 finish 的那些。
    const restore = () => { if (input.isTTY) input.setRawMode(false); };
    process.once('exit', restore);
    const finish = (/** @type {string | null} */ value) => {
      restore();
      process.off('exit', restore);
      input.removeListener('keypress', onKey);
      input.pause();
      done(value);
    };
    /** @type {(chunk: unknown, key: { name?: string, ctrl?: boolean }) => void} */
    const onKey = (chunk, key) => {
      if (!key) return;
      if (key.name === 'up' && idx > 0) { idx--; draw(); }
      else if (key.name === 'down' && idx < items.length - 1) { idx++; draw(); }
      else if (key.name === 'return') finish(items[idx]);
      else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) finish(null);
    };
    input.on('keypress', onKey);
    input.resume();
    out.write('\n  可启动的部署:  ↑↓ 移动  Enter 确认  Esc 取消\n\n');
    draw(true);
  });
}

/**
 * @param {string} bot
 * @param {string[]} passthrough
 * @param {boolean} firstRunOpensBrowser
 * @param {{ entry?: string, execArgv?: string[], log?: (s: string) => void, warn?: (s: string) => void }} [opts]
 * @returns {Promise<number>}
 */
export async function supervise(bot, passthrough, firstRunOpensBrowser, opts = {}) {
  const entry = opts.entry ?? join(REPO_ROOT, 'src', 'launcher.ts');
  const execArgv = opts.execArgv ?? ['--import', 'tsx'];
  const log = opts.log ?? console.log;
  const warn = opts.warn ?? console.error;
  let openBrowser = firstRunOpensBrowser;
  for (;;) {
    let askedRestart = false;
    /** @type {string | null} */
    let dataDir = null;

    const child = fork(entry, [bot, ...passthrough], {
      cwd: REPO_ROOT,
      execArgv,
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: {
        ...process.env,
        CORTICO_SUPERVISED: '1',
        CORTICO_START_PAUSED: process.env.CORTICO_START_PAUSED ?? '1',
        CORTICO_OPEN_BROWSER: openBrowser ? '1' : '0',
      },
    });

    child.on('message', (/** @type {unknown} */ msg) => {
      if (typeof msg !== 'object' || msg === null) return;
      const m = /** @type {{ type?: string, dataDir?: string }} */ (msg);
      if (m.type === READY_MESSAGE && typeof m.dataDir === 'string') dataDir = m.dataDir;
      if (m.type === RESTART_MESSAGE) askedRestart = true;
    });

    // Windows 将 Ctrl+C 发给父子进程；父进程等待子进程完成关机后再退出。
    const hold = () => {};
    process.on('SIGINT', hold);
    process.on('SIGTERM', hold);

    const code = await new Promise((r) => child.once('exit', (c, signal) => r(signal ? `信号 ${signal}` : c)));
    process.off('SIGINT', hold);
    process.off('SIGTERM', hold);

    if (!shouldRelaunch({ askedRestart, dataDir })) {
      if (code !== 0) {
        warn(`\n进程异常退出（${code}）。未自动重启。`);
        return typeof code === 'number' ? code : 1;
      }
      log('\n进程已退出。');
      return 0;
    }

    if (dataDir) rmSync(join(dataDir, RESTART_FLAG_FILE), { force: true });
    openBrowser = false;
    log(`\n[重启] ${bot}\n`);
  }
}

async function main() {
  const request = parseRequest(process.argv.slice(2), process.env);

  const pnpm = resolvePnpm(onPath);
  if (!pnpm) {
    console.error(pnpmMissingMessage());
    return 1;
  }

  if (!existsSync(join(REPO_ROOT, 'node_modules'))) {
    console.log('正在安装依赖: pnpm install ...\n');
    const code = runPnpm(pnpm, ['install']);
    if (code !== 0) return code;
  }

  // 控制台产物不纳入版本控制;不完整的产物按没有算。
  const assetsProblem = webAssetsProblem(join(REPO_ROOT, 'dist', 'web'));
  if (assetsProblem) {
    console.log(`正在构建控制台: pnpm build:web ...(${assetsProblem})\n`);
    const code = runPnpm(pnpm, ['build:web']);
    if (code !== 0) return code;
  }

  let available = readPnpm(pnpm, ['--silent', 'bots']).split('\n').map((s) => s.trim()).filter(Boolean);
  if (request.kind === 'list') {
    console.log(available.join('\n'));
    return 0;
  }

  // 一份部署都没有 = 第一次上手。建一份再启动,端点与其余设置在控制台里配。
  if (available.length === 0) {
    const created = readPnpm(pnpm, ['--silent', 'bots', '--create-default']).trim();
    if (created) {
      console.log(`\n  已创建部署: ${created}`);
      available = [created];
    }
  }

  let choice = chooseBot({ bot: request.bot, available, interactive: process.stdin.isTTY === true });
  if (choice.kind === 'ask') {
    const picked = await promptChoice(available);
    if (picked === null) {
      console.log('\n已取消。');
      return 1;
    }
    choice = { kind: 'run', bot: picked };
  }
  if (choice.kind === 'error') {
    console.error(choice.message);
    return 1;
  }

  console.log(`\n  启动: ${choice.bot}`);
  return supervise(choice.bot, request.passthrough, process.env.CORTICO_OPEN_BROWSER !== '0');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (err) => {
    console.error('启动失败:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
