/** 验证部署选择、菜单渲染、pnpm 发现与子进程重启条件;监管测试使用本地假子进程。 */
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
  resolvePnpm,
  shouldRelaunch,
  supervise,
} from '../bin/cortico.mjs';
import {
  MINT_ACCENT,
  NEW_DEPLOYMENT,
  colorEnabled,
  deploymentRows,
  displayWidth,
  paint,
  promptChoice,
  renderLine,
} from '../bin/menu.mjs';

/** 假命令行要在 Readable 上补 isTTY / setRawMode,类型上没有这两项。 */
type Any = any;

/** 送进输入流的按键。 */
const ENTER = String.fromCharCode(13);
const ESCAPE = String.fromCharCode(27);
const DOWN = ESCAPE + '[B';
/** 转义序列的前缀,断言里拼出上移与清行。 */
const CSI = ESCAPE + '[';

/** 两份部署,配色各不相同。 */
const DEPLOYMENTS = [
  {
    name: 'a',
    dir: 'deployments/a',
    bot: 'cortiv',
    displayName: '可缇Corti',
    colors: { accent: '#81c9ef', accent2: '#6591c3', ink: '#f2f5fa', inkDim: '#8594a7', danger: '#e99bae' },
  },
  {
    name: 'b',
    dir: 'deployments/b',
    bot: 'cormini',
    displayName: '可缇mini',
    colors: { accent: '#2fd59b', accent2: '#78cbae', ink: '#e9eae9', inkDim: '#828584', danger: '#d18c83' },
  },
];

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

  it('交互式命令行一份也弹菜单:新建那一项要够得着', () => {
    expect(chooseBot({ bot: null, available: ['only'], interactive: true })).toEqual({ kind: 'ask' });
    expect(chooseBot({ bot: null, available: ['a', 'b'], interactive: true })).toEqual({ kind: 'ask' });
  });

  it('非交互环境只有一份就用它', () => {
    expect(chooseBot({ bot: null, available: ['only'], interactive: false })).toEqual({ kind: 'run', bot: 'only' });
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
  /** 一个可写可读的假命令行:记下每次 raw 模式切换。 */
  function fakeTty(): { stream: Any; modes: boolean[] } {
    const stream = new PassThrough() as Any;
    const modes: boolean[] = [];
    stream.isTTY = true;
    stream.setRawMode = (on: boolean) => { modes.push(on); };
    return { stream, modes };
  }

  /** 两项的假菜单,一项一行。 */
  function rows(): Any[] {
    return [
      { lines: [[{ text: 'alpha' }]], value: 'alpha' },
      { lines: [[{ text: 'beta' }]], value: 'beta' },
    ];
  }

  it('选完就退出 raw 模式,并摘掉自己挂的 exit 监听', async () => {
    const { stream: input, modes } = fakeTty();
    const exitListeners = process.listenerCount('exit');
    const picked = promptChoice(rows(), { out: new PassThrough() as Any, input });
    input.write(ENTER);
    expect(await picked).toBe('alpha');
    expect(modes).toEqual([true, false]);
    expect(process.listenerCount('exit')).toBe(exitListeners);
  });

  it('菜单开着时进程退出:exit 监听把命令行从 raw 模式带回来', async () => {
    const { stream: input, modes } = fakeTty();
    const picked = promptChoice(rows(), { out: new PassThrough() as Any, input });
    const restore = process.listeners('exit').at(-1) as () => void;
    restore();
    expect(modes).toEqual([true, false]);
    input.write(ENTER);
    await picked;
  });

  it('两行一项:重绘上移的行数等于画出去的行数', async () => {
    const { stream: input } = fakeTty();
    const out = new PassThrough() as Any;
    let written = '';
    out.write = (chunk: string): boolean => { written += chunk; return true; };
    const picked = promptChoice(deploymentRows(DEPLOYMENTS, 0) as Any, { out, input, color: false });
    input.write(DOWN);
    input.write(ENTER);
    expect(await picked).toBe('b');
    // 两份部署各两行 + 新建一行
    expect(written).toContain(`${CSI}5A`);
    expect(written.split('\n').filter((l) => l.includes('deployments/')).length).toBe(4);
  });

  it('Esc 取消', async () => {
    const { stream: input } = fakeTty();
    const picked = promptChoice(rows(), { out: new PassThrough() as Any, input });
    input.write(ESCAPE);
    expect(await picked).toBe(null);
  });
});

describe('菜单渲染', () => {
  it('部署一项两行:路径在上,`bot id - 名字`在下;末项是新建部署', () => {
    const menu = deploymentRows(DEPLOYMENTS, 0);
    expect(menu.length).toBe(3);
    expect(menu[0].lines.length).toBe(2);
    expect(menu[0].lines[0][0].text).toBe('deployments/a');
    expect(menu[0].lines[1].map((s: Any) => s.text).join('')).toBe('cortiv - 可缇Corti');
    expect(menu[2].value).toBe(NEW_DEPLOYMENT);
    expect(menu[2].lines[0][0].color).toBe(MINT_ACCENT);
  });

  it('颜色按这份部署自己的配色:bot id 主强调、名字次强调、路径按选中换亮度', () => {
    const menu = deploymentRows(DEPLOYMENTS, 1);
    expect(menu[0].lines[0][0].color).toBe(DEPLOYMENTS[0].colors.inkDim);
    expect(menu[1].lines[0][0].color).toBe(DEPLOYMENTS[1].colors.ink);
    expect(menu[1].lines[1][0].color).toBe(DEPLOYMENTS[1].colors.accent);
    expect(menu[1].lines[1][2].color).toBe(DEPLOYMENTS[1].colors.accent2);
  });

  it('代码包读不出来时第二行写原因,这一项仍然可选', () => {
    const broken = { ...DEPLOYMENTS[0], problem: '找不到 bot 代码包「ghost」' };
    const [row] = deploymentRows([broken], 0);
    expect(row.value).toBe('a');
    expect(row.lines[1][2]).toEqual({ text: '找不到 bot 代码包「ghost」', color: broken.colors.danger });
  });

  it('着色:非 TTY、NO_COLOR、FORCE_COLOR=0 都不上色', () => {
    expect(colorEnabled({ isTTY: true }, {})).toBe(true);
    expect(colorEnabled({ isTTY: false }, {})).toBe(false);
    expect(colorEnabled({ isTTY: true }, { NO_COLOR: '1' })).toBe(false);
    expect(colorEnabled({ isTTY: true }, { NO_COLOR: '' })).toBe(true);
    expect(colorEnabled({ isTTY: true }, { FORCE_COLOR: '0' })).toBe(false);
  });

  it('上色走 24 位真彩;关掉时原样输出', () => {
    expect(paint('x', '#00a870', true)).toBe(`${CSI}38;2;0;168;112mx${CSI}0m`);
    expect(paint('x', '#00a870', false)).toBe('x');
    expect(paint('x', 'red', true)).toBe('x');
  });

  it('列宽:CJK 算两列', () => {
    expect(displayWidth('cortiv')).toBe(6);
    expect(displayWidth('可缇Corti')).toBe(9);
  });

  it('超出列宽就截断补省略号,免得折行把重绘行数算错', () => {
    const spans = [{ text: 'cortiv', color: '#00a870' }, { text: ' - ' }, { text: '可缇Corti' }];
    expect(renderLine(spans, { columns: 40, color: false })).toBe('cortiv - 可缇Corti');
    expect(renderLine(spans, { columns: 10, color: false })).toBe('cortiv - …');
    expect(displayWidth(renderLine(spans, { columns: 10, color: false }))).toBeLessThanOrEqual(10);
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
