// @ts-check
/**
 * 启动前准备依赖与控制台产物，选择部署并监管 src/launcher.ts 子进程。
 * 此入口需要在 node_modules 不存在时运行，不得依赖第三方包。
 */
import { spawnSync, fork } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NEW_DEPLOYMENT, deploymentRows, packageRows, promptChoice, promptLine } from './menu.mjs';
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
 * 这一趟要做什么:列清单、建一份新的,还是启动某一份。不给名字时用 `CORTICO_BOT`。
 *
 * @param {readonly string[]} argv 已去掉 node 与脚本自身的那一段
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ kind: 'list' } | { kind: 'create', passthrough: string[] } | { kind: 'run', bot: string | null, passthrough: string[] }}
 */
export function parseRequest(argv, env) {
  const { bot, passthrough } = parseArgs(argv);
  if (passthrough.includes('--list')) return { kind: 'list' };
  if (passthrough.includes('--new')) {
    return { kind: 'create', passthrough: passthrough.filter((a) => a !== '--new') };
  }
  return { kind: 'run', bot: bot ?? env.CORTICO_BOT ?? null, passthrough };
}

/**
 * 未指定部署时,交互终端返回 ask,非交互终端只有一份就用它、多份返回错误与可选项。
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
  // 交互终端上一份部署也弹菜单:「新建部署」那一项始终够得着。
  if (interactive) return { kind: 'ask' };
  if (available.length === 1) return { kind: 'run', bot: available[0] };
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
 * @typedef {import('./menu.mjs').RowColors} RowColors
 * @typedef {{ name: string, dir: string, bot: string, displayName: string, problem?: string, colors: RowColors }} DeploymentEntry
 * @typedef {{ id: string, source: string, displayName: string, colors: RowColors }} PackageEntry
 * @typedef {{ root: string, deployments: DeploymentEntry[], packages: PackageEntry[] }} Listing
 */

/**
 * 跑一趟 launcher 的开关并返回 stdout。不经 pnpm:参数里有部署名与操作员取的名字,
 * Windows 上 shell 那层会把带空格的参数拆开。依赖此时已经装好。
 *
 * @param {string[]} args
 */
function readLauncher(args) {
  const result = spawnSync(
    process.execPath,
    [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'launcher.ts'), ...args],
    { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true, shell: false },
  );
  if (result.status !== 0) {
    // launcher 给每条错误都冠上「启动失败」,而这里跑的是它的子命令。
    const said = (result.stderr || result.stdout || '').trim().replace(/^启动失败:\s*/, '');
    throw new Error(said || `launcher ${args.join(' ')} 失败`);
  }
  return result.stdout;
}

/**
 * 部署清单与可选的代码包。颜色已在那一侧按各自的配色方案解析好。
 *
 * @returns {Listing}
 */
function readListing() {
  return JSON.parse(readLauncher(['--json']));
}

/**
 * 菜单顶上那两行:部署根的绝对路径与按键说明。
 *
 * @param {string} root
 */
function menuHead(root) {
  return ['', `  部署根  ${root}`, '  ↑↓ 移动   Enter 确认   Esc 取消', ''];
}

/**
 * 在终端里建一份空白部署:选代码包、起目录名、取个名字。返回新部署名;中途取消返回 null。
 *
 * @param {Listing} listing
 * @returns {Promise<string | null>}
 */
async function createDeployment(listing) {
  if (listing.packages.length === 0) {
    console.error('没有可用的 bot 代码包。');
    return null;
  }
  const bot = await promptChoice(packageRows(listing.packages), {
    head: ['', '  选一个 bot 代码包:', ''],
  });
  if (bot === null) return null;
  const pkg = listing.packages.find((p) => p.id === bot);
  const taken = listing.deployments.map((d) => d.name);
  let suggestion = bot;
  for (let n = 2; taken.includes(suggestion); n++) suggestion = `${bot}-${n}`;

  console.log('');
  for (;;) {
    const name = await promptLine('部署目录名', suggestion);
    if (name === null) return null;
    const displayName = await promptLine('给它取个名字', pkg ? pkg.displayName : '');
    if (displayName === null) return null;
    try {
      const created = readLauncher([
        `--create-deployment=${name}`,
        `--bot=${bot}`,
        // 与代码包默认一致时不写 config.json:那一份配置里只该有部署自己改过的东西。
        ...(pkg && displayName !== pkg.displayName ? [`--display-name=${displayName}`] : []),
      ]).trim();
      console.log(`\n  已建好 ${created},在 ${listing.root} 下`);
      return created;
    } catch (err) {
      console.error(`  ${err instanceof Error ? err.message : err}`);
      suggestion = name;
    }
  }
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

  // 控制台产物不纳入版本控制;不完整或落后于源码的产物按没有算。
  const assetsProblem = webAssetsProblem(REPO_ROOT);
  if (assetsProblem) {
    console.log(`正在构建控制台: pnpm build:web ...(${assetsProblem})\n`);
    const code = runPnpm(pnpm, ['build:web']);
    if (code !== 0) return code;
  }

  let listing = readListing();
  let available = listing.deployments.map((d) => d.name);
  if (request.kind === 'list') {
    console.log(available.join('\n'));
    return 0;
  }

  // 一份部署都没有 = 第一次上手。建一份再启动,端点与其余设置在控制台里配。
  if (available.length === 0 && request.kind === 'run') {
    const created = readPnpm(pnpm, ['--silent', 'bots', '--create-default']).trim();
    if (created) {
      console.log(`\n  已创建部署: ${created}`);
      listing = readListing();
      available = listing.deployments.map((d) => d.name);
    }
  }

  const interactive = process.stdin.isTTY === true;
  if (request.kind === 'create') {
    if (!interactive) {
      console.error('--new 要在交互终端上用。');
      return 1;
    }
    const created = await createDeployment(listing);
    if (created === null) {
      console.log('\n已取消。');
      return 1;
    }
    console.log(`\n  启动: ${created}`);
    return supervise(created, request.passthrough, process.env.CORTICO_OPEN_BROWSER !== '0');
  }

  let choice = chooseBot({ bot: request.bot, available, interactive });
  if (choice.kind === 'ask') {
    const picked = await promptChoice(
      (selected) => deploymentRows(listing.deployments, selected),
      { head: menuHead(listing.root) },
    );
    if (picked === null) {
      console.log('\n已取消。');
      return 1;
    }
    if (picked === NEW_DEPLOYMENT) {
      const created = await createDeployment(listing);
      if (created === null) {
        console.log('\n已取消。');
        return 1;
      }
      choice = { kind: 'run', bot: created };
    } else {
      choice = { kind: 'run', bot: picked };
    }
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
