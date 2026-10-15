// @ts-check
/**
 * 启动器的方向键菜单与行内提问。颜色由 `src/deploy-listing.ts` 解析好随清单送来，
 * 这里只负责画。此文件与 bin/cortico.mjs 一样需要在装依赖之前跑得起来。
 */
import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';

/** 菜单里「新建部署」那一项的值。部署名不能以 `-` 开头，不会与它相撞。 */
export const NEW_DEPLOYMENT = '--new';

/** 新建部署那一项的颜色：框架默认方案的主强调色，新部署正是从它开始。 */
export const MINT_ACCENT = '#2fd59b';

const ESC = '\u001b';

/**
 * @typedef {{ text: string, color?: string }} Span 一段文字与它的颜色
 * @typedef {{ lines: Span[][], value: string }} MenuRow 菜单的一项，占一到两行
 * @typedef {{ accent: string, accent2: string, ink: string, inkDim: string, danger: string }} RowColors 菜单一行用得到的几个颜色
 */

/**
 * 着色开关：非 TTY、`NO_COLOR`、`FORCE_COLOR=0` 都关掉。
 *
 * @param {{ isTTY?: boolean }} out
 * @param {NodeJS.ProcessEnv} env
 */
export function colorEnabled(out, env) {
  if (!out.isTTY) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  return env.FORCE_COLOR !== '0';
}

/**
 * `#rrggbb` → 24 位真彩转义。16 色表由命令行窗口的调色板决定，画不出方案本身的颜色。
 *
 * @param {string} text
 * @param {string | undefined} color
 * @param {boolean} enabled
 */
export function paint(text, color, enabled) {
  if (!enabled || !color || !/^#[0-9a-fA-F]{6}$/.test(color)) return text;
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  return `${ESC}[38;2;${r};${g};${b}m${text}${ESC}[0m`;
}

/**
 * 命令行列宽：CJK 与全角标点占两列。
 *
 * @param {string} text
 */
export function displayWidth(text) {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f64f);
    width += wide ? 2 : 1;
  }
  return width;
}

/**
 * 按列宽截断并补省略号。一行折到下一行会让重绘时上移的行数算错。
 *
 * @param {Span[]} spans
 * @param {number} columns
 * @returns {Span[]}
 */
export function fitSpans(spans, columns) {
  if (displayWidth(spans.map((s) => s.text).join('')) <= columns) return spans;
  const limit = Math.max(1, columns - 1);
  /** @type {Span[]} */
  const out = [];
  let used = 0;
  for (const span of spans) {
    let text = '';
    for (const ch of span.text) {
      const w = displayWidth(ch);
      if (used + w > limit) break;
      text += ch;
      used += w;
    }
    if (text) out.push({ ...span, text });
    if (used >= limit) break;
  }
  out.push({ text: '…' });
  return out;
}

/**
 * 一行的最终文本。
 *
 * @param {Span[]} spans
 * @param {{ columns: number, color: boolean }} opts
 */
export function renderLine(spans, opts) {
  return fitSpans(spans, opts.columns)
    .map((s) => paint(s.text, s.color, opts.color))
    .join('');
}

/**
 * 一份部署占两行：相对部署根的路径，以及 `bot id - 名字`。路径按选中与否换亮度，
 * 其余颜色跟着这份部署自己的配色走。代码包读不出来时第二行写原因。
 *
 * @param {{ dir: string, bot: string, displayName: string, problem?: string, colors: RowColors }} row
 * @param {boolean} selected
 * @returns {Span[][]}
 */
export function deploymentLines(row, selected) {
  const c = row.colors;
  return [
    [{ text: row.dir, color: selected ? c.ink : c.inkDim }],
    row.problem
      ? [{ text: row.bot, color: c.accent }, { text: ' - ', color: c.inkDim }, { text: row.problem, color: c.danger }]
      : [
        { text: row.bot, color: c.accent },
        { text: ' - ', color: c.inkDim },
        { text: row.displayName, color: c.accent2 },
      ],
  ];
}

/**
 * 部署菜单的全部项：每份部署一项，末尾是新建部署。
 *
 * @param {Array<{ name: string, dir: string, bot: string, displayName: string, problem?: string, colors: RowColors }>} deployments
 * @param {number} selected 当前选中项的下标，决定路径那行的亮度
 * @returns {MenuRow[]}
 */
export function deploymentRows(deployments, selected) {
  return [
    ...deployments.map((row, i) => ({ lines: deploymentLines(row, i === selected), value: row.name })),
    { lines: [[{ text: '＋ 新建部署', color: MINT_ACCENT }]], value: NEW_DEPLOYMENT },
  ];
}

/**
 * 代码包菜单的全部项：`包 id - 名字`，扩展来的在后面标一下。
 *
 * @param {Array<{ id: string, source: string, displayName: string, colors: RowColors }>} packages
 * @returns {MenuRow[]}
 */
export function packageRows(packages) {
  return packages.map((pkg) => ({
    lines: [[
      { text: pkg.id, color: pkg.colors.accent },
      { text: ' - ', color: pkg.colors.inkDim },
      { text: pkg.displayName, color: pkg.colors.accent2 },
      ...(pkg.source === 'extension' ? [{ text: '  扩展', color: pkg.colors.inkDim }] : []),
    ]],
    value: pkg.id,
  }));
}

/**
 * 方向键菜单。返回选中项的 value；Esc 与 Ctrl+C 返回 null。
 *
 * `rows` 是一个函数时，每次重绘按当前下标重新取行，选中项才换得了亮度。
 *
 * @param {MenuRow[] | ((selected: number) => MenuRow[])} rows
 * @param {{ head?: string[], out?: NodeJS.WriteStream, input?: NodeJS.ReadStream, color?: boolean }} [opts]
 * @returns {Promise<string | null>}
 */
export function promptChoice(rows, opts = {}) {
  const out = opts.out ?? process.stdout;
  const input = opts.input ?? process.stdin;
  const color = opts.color ?? colorEnabled(out, process.env);
  const columns = (out.columns ?? 80) - 4;
  const at = (/** @type {number} */ i) => (typeof rows === 'function' ? rows(i) : rows);
  return new Promise((done) => {
    let idx = 0;
    const items = at(0);
    // 非 TTY 输入也需要 keypress 事件，不能依赖 readline 的 TTY 初始化。
    emitKeypressEvents(input);
    if (input.isTTY) input.setRawMode(true);
    const height = items.reduce((n, row) => n + row.lines.length, 0);
    const draw = (/** @type {boolean} */ first = false) => {
      if (!first) out.write(`${ESC}[${height}A`);
      for (const [i, row] of at(idx).entries()) {
        for (const [j, spans] of row.lines.entries()) {
          const head = j === 0 ? `  ${i === idx ? '>' : ' '} ` : '      ';
          out.write(head + renderLine(spans, { columns, color }) + `${ESC}[K\n`);
        }
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
      else if (key.name === 'return') finish(items[idx].value);
      else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) finish(null);
    };
    input.on('keypress', onKey);
    input.resume();
    for (const line of opts.head ?? []) out.write(line + '\n');
    draw(true);
  });
}

/**
 * 问一行。直接回车用括号里的默认值；读不到输入（Ctrl+D）返回 null。
 *
 * @param {string} question
 * @param {string} fallback
 * @param {{ out?: NodeJS.WritableStream, input?: NodeJS.ReadableStream }} [opts]
 * @returns {Promise<string | null>}
 */
export async function promptLine(question, fallback, opts = {}) {
  const input = opts.input ?? process.stdin;
  const output = opts.out ?? process.stdout;
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`  ${question}${fallback ? ` (${fallback})` : ''}: `);
    return answer.trim() || fallback;
  } catch {
    return null;
  } finally {
    rl.close();
    input.pause();
  }
}
