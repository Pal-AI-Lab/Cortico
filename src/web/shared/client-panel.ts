/**
 * 控制台页浏览器扩展与控制台内核的契约，仅浏览器端 import，服务端不 import。此文件使用 DOM 类型，根 tsconfig 从初始文件表排除，由 tsconfig.web.json 检查。
 * 扩展通过 ConsolePanelContext 获取调用、根节点、取消、定时器、动画帧、存储、离开拦截及 UI。
 * 卸载依次 abort、dispose、清空 root；离开面板后轮询、RAF、observer、listener、挂起 fetch 与音频播放均停止。
 */

import type { ConsoleBadge } from './console-protocol.ts';
import type { ConfigValue } from '../../core/config-schema.ts';
import type { Language } from '../../core/language.ts';
import type { PathPickerOptions } from './path-picker.ts';

/** 可释放资源。`ResizeObserver` 这类原生对象用 `toDisposable` 包一下即可。 */
export interface Disposable {
  dispose(): void;
}

/** 把任意清理函数包成 `Disposable`。 */
export function toDisposable(cleanup: () => void): Disposable {
  let done = false;
  return {
    dispose() {
      if (done) return;
      done = true;
      cleanup();
    },
  };
}

// ---------------------------------------------------------------------------
// Panel Context
// ---------------------------------------------------------------------------

/**
 * 面板运行时上下文。**这是扩展与外界的唯一接口。**
 *
 * 身份、DOM 根、生命周期与自有数据面是稳定基线；通用框架能力可以增量扩充。
 * 接口不接受任何具体页的专用成员。
 */
export interface ConsolePanelContext {
  /** `world:chat` / `persona:demo` */
  readonly pageId: string;
  /** 本页内的局部 id，如 `gate` */
  readonly panelId: string;
  /**
   * 这个浏览器的界面语言(`zh` / `en`):部署默认,或操作员在设置里改过的那种。扩展自己
   * 决定要不要带第二套文案;没有这一语言的就给中文,宿主不翻译、不告警。
   */
  readonly language: Language;

  /**
   * 扩展的 DOM 根。**扩展只往这里面写**，不碰 `document.body`。
   * unmount 时由 host 清空。
   */
  readonly root: HTMLElement;

  /**
   * unmount 时 abort。传给 `addEventListener` 与 `fetch` 即可自动清理——
   * 这两个 API 原生认识 `AbortSignal`，所以 context 不再重复提供包装。
   */
  readonly signal: AbortSignal;

  /**
   * 调本面板的数据面方法（`ConsolePageContribution.invoke`）。
   * 走 POST，请求随 `signal` 取消；非 2xx 抛 `ConsoleInvokeError`。
   */
  invoke<T = unknown>(method: string, args?: unknown[]): Promise<T>;

  /** 同上，但按二进制取回（音频试听、图片这类）。 */
  invokeBinary(method: string, args?: unknown[]): Promise<Blob>;

  /** 面板卸载时发送小型清理 POST；该请求不随面板的 abort signal 取消。 */
  notifyOnUnmount?(method: string, args?: unknown[]): void;

  /** 打开服务端主机的本机文件/目录选择器。取消返回 null。 */
  pickPath(options: PathPickerOptions): Promise<string | null>;

  /** 按配置组写回已声明字段；校验、热更新与持久化均走框架配置面。 */
  setConfig(groupId: string, values: Record<string, ConfigValue>): Promise<string>;

  /**
   * 本面板的推送通道对应服务端 ConsolePageContribution.stream。连接中断后退避重连，unmount 同时终止连接与重连；已有推送的数据不另行轮询。
   */
  stream(handlers: ConsoleStreamHandlers): ConsoleStreamHandle;

  /** 轮询。返回的 `Disposable` 已登记，unmount 自动停；提前停就手动 `dispose()`。 */
  interval(fn: () => void, ms: number): Disposable;

  /** 一次性延时，触发后移除登记；unmount 自动取消。 */
  timeout(fn: () => void, ms: number): Disposable;

  /** RAF 循环。`fn` 返回 `false` 即自行结束；unmount 自动停。 */
  frame(fn: (dtMs: number) => void | false): Disposable;

  /**
   * 登记一个资源，unmount 时自动 `dispose()`。
   * `AudioContext`、`ObjectURL`、`ResizeObserver`、子进程连接都走这里。
   */
  own<T extends Disposable>(d: T): T;

  /** 面板局部存储，按 page:panel 隔离键。浏览器存储不可用时退回内存，不抛错。 */
  readonly memo: ConsoleMemo;

  /**
   * 离开拦截。`fn` 返回一句话 = 拦下并让用户确认；返回 null = 放行。
   * 编辑器类面板（有未保存改动）用它。unmount 时自动解除。
   */
  guardLeave(fn: () => string | null): Disposable;

  /**
   * 宿主面板挂载本面板时给的作用域（如选中的端点名）。自己占一个页签时为空对象。
   */
  readonly scope: Readonly<Record<string, string>>;

  /**
   * 把本页声明到该插槽的面板按声明顺序挂进 `host`，`scope` 传给它们的 `ctx.scope`。
   * 返回句柄的 `dispose()` 结束这些面板；`host` 的内容由调用方清理。
   * 插槽里没有面板时挂载为空。
   */
  mountSlot(
    slot: string,
    host: HTMLElement,
    scope?: Readonly<Record<string, string>>,
  ): Promise<Disposable>;

  /** UI 原语。 */
  readonly ui: ConsoleUi;

  /**
   * 重新读取 manifest 并更新 host 渲染的 badges、availability 与 prefixDrifted。保持面板挂载和表单状态；面板自身的数据由面板另行刷新。
   */
  refresh(): Promise<void>;
}

/** invoke 失败，携带 HTTP 状态与服务端按界面语言提供的消息。 */
export class ConsoleInvokeError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ConsoleInvokeError';
    this.status = status;
  }
}

export interface ConsoleStreamHandlers {
  /** 收到一帧。 */
  message(text: string): void;
  /** 连上了（含每次重连成功）。用来重置面板里的"连接中"状态。 */
  open?(): void;
  /** 断开了。`willRetry` 为 false 表示不再重连（面板已卸载）。 */
  close?(willRetry: boolean): void;
}

export interface ConsoleStreamHandle extends Disposable {
  /** 往回推一帧。连接未就绪时排队，连上后按序发出。 */
  send(text: string): void;
  readonly open: boolean;
}

export interface ConsoleMemo {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
}

// ---------------------------------------------------------------------------
// UI 原语
// ---------------------------------------------------------------------------

/**
 * 控制台 UI 原语仅包含跨页通用的能力，领域波形、预览和播放器由各扩展实现。原语返回真实 DOM 元素，复用统一样式，不接受 HTML 字符串或 JSON UI 描述。
 * ctx.ui 绑定面板 signal：abort 时关闭 toast、confirm 与 drawer，待决 confirm resolve 为 false 以允许调用方清理；abort 后 confirm 立即返回 false，toast/drawer 不显示。
 */
export interface ConsoleUi {
  /** `h('div', 'sheet', '文本')` */
  h<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    cls?: string | null,
    text?: string | null,
  ): HTMLElementTagNameMap[K];

  /** HTML 转义。拼 innerHTML 的场合用。 */
  esc(s: unknown): string;

  /** 档案卡。 */
  sheet(opts: ConsoleSheetOptions): ConsoleSheet;

  /**
   * 可折叠档案卡（`details.sheet.tabbed.fold`）。展开状态按 `id` 记在 `ctx.memo` 里，
   * 跨导航重建 DOM 后恢复。`note` 是折叠状态下唯一可见的字段。
   */
  foldSheet(id: string, opts: ConsoleSheetOptions & { defaultOpen?: boolean }): ConsoleSheet;

  /** 按钮与状态行。 */
  rowbar(): HTMLDivElement;

  /** 卡片分区标题。 */
  section(title: string, description?: string): HTMLDivElement;

  /** 卡片动作行。 */
  actions(): HTMLDivElement;

  /** 按钮（`.btn` / `.btn.sm` / `.btn.primary` / `.btn.danger`）。 */
  button(label: string, opts?: {
    variant?: 'plain' | 'primary' | 'danger';
    size?: 'sm' | 'md';
    onClick?: (ev: MouseEvent) => void;
  }): HTMLButtonElement;

  /** 点击时读取函数形式的文本。Clipboard API 失败后尝试 execCommand；均失败则显示错误和含原文的抽屉。 */
  copyButton(text: string | (() => string), opts?: ConsoleCopyOptions): HTMLButtonElement;

  /** 状态标签；on、off 分别使用启用和关闭色，plain 使用中性色。 */
  pill(text: string, tone?: ConsoleBadge['tone']): HTMLSpanElement;

  /** 读数标签，支持中性、警示与强调色；可追加节点突出数值。 */
  chip(text: string, tone?: ConsoleChipTone): HTMLSpanElement;

  /** 一行消息（保存结果、错误）。`bad` 走警示配色（`.msgline` / `.msgline.bad`）。 */
  msgline(text?: string, bad?: boolean): HTMLDivElement;

  /** 空态说明节点，可作为表格单元格内容。 */
  placeholder(text: string): HTMLDivElement;

  /**
   * 单行输入（`input.field`）。`cls` 追加到 `field` 后面（常用 `mono`）。
   * 监听随面板 `signal` 自动摘，扩展不必自己收尾。
   */
  input(opts?: ConsoleInputOptions): HTMLInputElement;

  /** 下拉选择（`select.field`）。选项给字符串就是 value=label。 */
  select(opts?: ConsoleSelectOptions): HTMLSelectElement;

  /** 多行输入（`textarea.field`，可竖向拉伸）。 */
  textarea(opts?: ConsoleTextareaOptions): HTMLTextAreaElement;

  /**
   * 对话输入器。textarea、提交动作与快捷键共享一个交互边界；面板卸载时 React 根随
   * `signal` 销毁。适用于消息式输入，不替代普通表单的 `input` / `textarea`。
   */
  promptInput(opts: ConsolePromptInputOptions): ConsolePromptInput;

  /**
   * 可编辑勾选框，使用 label.check 包裹 input[type=checkbox]；只读状态使用 pill。
   * 返回句柄供读取 checked 和程序更新；setChecked 不触发代表用户操作的 onChange。
   */
  checkbox(label: string, opts?: ConsoleCheckboxOptions): ConsoleCheckbox;

  /** 将标签与任意控件包在 label 中；返回包装节点，控件句柄由调用方保留。 */
  field(label: string, control: HTMLElement): HTMLLabelElement;

  /** 分段选择器；点击已选项和 setValue 均不触发用户回调，重复 value 的选项一同更新。 */
  segmented(
    items: readonly (string | { value: string; label?: string })[],
    opts?: ConsoleSegmentedOptions,
  ): ConsoleSegmented;

  /** 数据表返回节点及 clear/addRow 句柄；可选表头保持置顶。 */
  table(opts?: ConsoleTableOptions): ConsoleTable;

  /** 无表头的键值表，节点值直接挂入。值格使用等宽字体；需要保留换行时使用 table 的 txt 单元格。 */
  kv(rows: readonly ConsoleKvRow[]): HTMLTableElement;

  /** 追加式日志，有行数上限。贴底时随新增行滚动，上翻后暂停，返回底部后恢复。 */
  log(opts?: ConsoleLogOptions): ConsoleLog;

  /** 概览读数（`.stat`，内含 `.k` 小标题与 `.v` 大数字；`accent` 上强调色）。 */
  stat(item: ConsoleStat): HTMLDivElement;

  /** 读数网格（`.statgrid`，自适应列宽）。把一组 `stat` 排进去。 */
  statgrid(items?: readonly ConsoleStat[]): HTMLDivElement;

  /** 占比条；默认显示百分比，可用 format 定义读数文本。 */
  progress(opts?: ConsoleProgressOptions): ConsoleProgress;

  /**
   * 瞬时提示（`.toast` / `.toast.bad`，屏幕下沿居中）。
   * 同一面板同时只留一条，后来的顶掉前面的。返回的 `Disposable` 可提前撤下；
   * 面板 unmount 时自动消失，不必登记。
   */
  toast(text: string, tone?: 'ok' | 'bad'): Disposable;

  /** 模态确认；danger 使用危险配色与继续文案。取消或面板 unmount 时返回 false。 */
  confirm(opts: { title: string; body?: string; danger?: boolean }): Promise<boolean>;

  /** 抽屉响应 Esc、遮罩和关闭按钮。字符串放入 pre.mono，节点放入 modalbody；面板卸载时关闭。 */
  drawer(title: string, body: string | HTMLElement): Disposable;

  /** busy 只能由 Disposable 或面板 abort 关闭，不响应用户关闭操作。abort 后不显示，并返回可释放的空句柄。 */
  busy(title: string, text?: string): Disposable;

  /**
   * 局部禁用一组控件，dispose() 恢复各自原本的 disabled 状态；整页阻塞使用 busy。
   * 同一控件只记录首次原值；dispose() 幂等。
   */
  disable(...els: readonly ConsoleDisablable[]): Disposable;

  readonly fmt: ConsoleFormat;
}

export interface ConsoleSheetOptions {
  title: string;
  /** 标题后的英文小注（`h3 > .en`） */
  en?: string;
  /** 卡片说明行（`.sh-desc`，标题下方一行灰字）。解释这张卡是干嘛的，不放读数。 */
  desc?: string;
}

export interface ConsoleSheet {
  /** 整张卡，扩展把它 append 到 `ctx.root` */
  el: HTMLElement;
  /** 内容区 */
  body: HTMLElement;
  /** 折叠态下显示的一行摘要（`sheet()` 也有，只是不折叠时不显示） */
  note: HTMLElement;
  /** 说明行（`.sh-desc`）。只有传了 `opts.desc` 才存在；给出来是为了之后改写它。 */
  desc: HTMLElement | null;
}

/** chip 的中性、警示与强调配色。 */
export type ConsoleChipTone = 'plain' | 'warn' | 'accent';

/** 输入控件的回调分别对应输入、change 与提交键；监听随面板 signal 释放。 */
export interface ConsoleFieldOptions {
  value?: string;
  placeholder?: string;
  /** 追加到 `field` 之后的 class，如 `mono` */
  cls?: string;
  disabled?: boolean;
  /** 值变了。input/textarea 听 `input`，select 听 `change`。 */
  onInput?: (value: string) => void;
  /** change 事件：input/textarea 值变化后失焦，select 选项变化。select 的 onInput 也监听 change，若两者均提供则都会触发。 */
  onChange?: (value: string) => void;
  /** Enter 提交；textarea 使用 Ctrl/⌘+Enter，IME 组词期间不提交。浏览器可能继续派发 change，同时使用两种提交回调时由调用方去重。 */
  onCommit?: (value: string) => void;
}

/** `checkbox` 的选项。 */
export interface ConsoleCheckboxOptions {
  checked?: boolean;
  disabled?: boolean;
  /** 悬停气泡（`title` 属性）。写"点一下会发生什么"，别重复标签本身。 */
  title?: string;
  /** 用户拨动时。**`setChecked` 不触发它。** */
  onChange?: (checked: boolean) => void;
}

export interface ConsoleCheckbox {
  /** `label.check`（含方框与标签文字），扩展把它 append 到卡里 */
  el: HTMLLabelElement;
  /** 里面那个 `input[type=checkbox]`。要设 `disabled`、要聚焦时用。 */
  input: HTMLInputElement;
  /** 当前是否勾选 */
  readonly checked: boolean;
  /** 程序化设值，不触发 `onChange` */
  setChecked(checked: boolean): void;
}

export interface ConsoleSegmentedOptions {
  /** 初始选中的 value。不给（或给了一个不在 items 里的值）就一颗都不亮。 */
  value?: string;
  /** `.segwrap.sm`：塞进 `rowbar` 与 `.btn.sm` 并排时用 */
  size?: 'sm' | 'md';
  /** 用户切换时。**点已经选中的那颗不触发**，`setValue` 也不触发。 */
  onSelect?: (value: string) => void;
}

export interface ConsoleSegmented {
  /** `.segwrap`，扩展把它 append 到卡里 */
  el: HTMLDivElement;
  /** 当前选中的 value */
  readonly value: string;
  /** 程序化切换选中态，不触发 `onSelect` */
  setValue(value: string): void;
}

/** `kv` 的一行。`k` 是字段名（左列窄灰），`v` 给节点就直接放。 */
export interface ConsoleKvRow {
  k: string;
  v: string | number | HTMLElement | null | undefined;
}

export interface ConsoleInputOptions extends ConsoleFieldOptions {
  /** 缺省 `text`。`search` 会带上浏览器的清除按钮。 */
  type?: 'text' | 'number' | 'password' | 'search' | 'date';
}

export interface ConsoleSelectOptions extends ConsoleFieldOptions {
  /** 给字符串等价于 `{ value: s, label: s }` */
  options?: readonly (string | { value: string; label?: string })[];
}

export interface ConsoleTextareaOptions extends ConsoleFieldOptions {
  rows?: number;
}

/**
 * 输入器交出的一张图:已按 `ConsolePromptImagesOptions` 归一化(长边缩到上限、超限的
 * 重编码),base64 不带 `data:` 前缀,直接可进 JSON 帧。
 */
export interface ConsoleImageAttachment {
  name: string;
  /** image/jpeg | image/png | image/webp | image/gif */
  mime: string;
  base64: string;
  /** 编码后的字节数 */
  bytes: number;
  width: number;
  height: number;
}

/**
 * 输入器的图片通道。给了就出现附图按钮、接收粘贴与拖放,输入框上方长出缩略图托盘;
 * 不给就是纯文本输入器。
 */
export interface ConsolePromptImagesOptions {
  /** 一条消息最多带几张,缺省 8。超出的拒收并就地提示。 */
  max?: number;
  /** 长边上限(像素),缺省 2048。超过的按比例缩小。 */
  maxEdge?: number;
  /** 单张编码后字节上限,缺省 6MB。超限的按 JPEG 重编码;仍超就拒收。 */
  maxBytes?: number;
}

export interface ConsolePromptInputOptions {
  label?: string;
  placeholder?: string;
  hint?: string;
  disabled?: boolean;
  /** 发送键左侧的紧凑工具入口。节点所有权随 prompt input 一起结束。 */
  tools?: HTMLElement;
  /** 图片通道。不给 = 不收图,`onSubmit` 的第二参恒为空数组。 */
  images?: ConsolePromptImagesOptions;
  /**
   * 文本与图片至少一样非空才触发。
   * 返回 `false` 保留当前内容(文本与托盘都留)；其余返回值表示已接收并清空。
   */
  onSubmit(text: string, images: readonly ConsoleImageAttachment[]): boolean | void;
}

export interface ConsolePromptInput {
  el: HTMLDivElement;
  focus(): void;
  setDisabled(disabled: boolean): void;
  /** 盖住输入框里的灰字。`null` 回到构造时给的那一句。 */
  setPlaceholder(text: string | null): void;
}

export interface ConsoleTableOptions {
  /** 表头文字。不给就不渲染 `<thead>`。 */
  head?: readonly string[];
  /** 外框最高多少（如 `calc(100vh - 300px)`）。给了才滚，表头的 sticky 也才有意义。 */
  maxHeight?: string;
}

/**
 * 一格。给字符串/数字就是纯文本；给节点就直接放进去（塞 `pill`、按钮用）；
 * 给对象可以额外指定单元格 class（既有的 `mono` = 等宽不换行，`txt` = 保留换行）。
 */
export type ConsoleCell =
  | string
  | number
  | null
  | undefined
  | HTMLElement
  | { text?: string | number | null; el?: HTMLElement; cls?: string };

export interface ConsoleTable {
  /** 外框 `.tablewrap`，扩展把它 append 到卡里 */
  el: HTMLDivElement;
  /** `<tbody>`，想自己操作行时用 */
  body: HTMLTableSectionElement;
  /** 追加一行 */
  addRow(cells: readonly ConsoleCell[]): HTMLTableRowElement;
  /** 清空。带一句话就铺一行跨列的 `.placeholder` 空态。 */
  clear(empty?: string): void;
}

export interface ConsoleStat {
  /** 小标题（`.k`） */
  k: string;
  /** 大数字（`.v`）。给节点就直接放。 */
  v: string | number | HTMLElement;
  /** 数字后面的小字单位（`.v small`），如 `次` / `tok` */
  unit?: string;
  /** 上强调色（`.stat.accent`）。一屏里只该有一两个。 */
  accent?: boolean;
}

/**
 * 一行日志的配色，对应 `.logline` / `.logline.dim` / `.logline.warn` / `.logline.bad`。
 * 与 `ConsoleChipTone` 一样按**角色**命名：`dim` 是次要噪声（心跳、回执），
 * `warn` 是需要留意但没坏，`bad` 是真出事了。
 */
export type ConsoleLogTone = 'plain' | 'dim' | 'warn' | 'bad';

export interface ConsoleLogOptions {
  /** `conversation` 使用阅读型正文排版；缺省保留等宽日志排版。 */
  variant?: 'plain' | 'conversation';
  /**
   * 日志保留行数上限，超出时从头裁剪，避免长期运行时节点无界增长；缺省 400。
   */
  max?: number;
  /** 外框最高多少（缺省 `240px`）。给了才滚，粘滞也才有意义。 */
  maxHeight?: string;
  /** 一行都没有时铺的空态（`.placeholder`）。不给就留一个空框。 */
  empty?: string;
  /** 贴底容差，单位像素，默认 24；scrollTop 可能包含小数。 */
  stickThreshold?: number;
}

export interface ConsoleLog {
  /** `.logview`，扩展把它 append 到卡里 */
  el: HTMLDivElement;
  /** 追加一行，返回那一行的节点（想再往里塞 `chip` / 链接时用） */
  append(line: string, tone?: ConsoleLogTone): HTMLDivElement;
  /** 清空（回到空态） */
  clear(): void;
  /** 当前有几行 */
  readonly count: number;
  /** 此刻是否粘在底部。用来画一颗"回到底部"的按钮。 */
  readonly stuck: boolean;
  /** 滚到底并重新粘住（"回到底部"那颗按钮点下去做的事） */
  scrollToEnd(): void;
}

export interface ConsoleProgressOptions {
  /** 满值，缺省 1。给 0 或非有限数一律当 1（否则读数是 `NaN%`）。 */
  max?: number;
  /** 初值，缺省 0 */
  value?: number;
  /** 左侧小标题。不给就只有右侧读数。 */
  label?: string;
  /** 右侧读数怎么印。不给就是百分比；给了可以印成 `3 / 12`。 */
  format?: (value: number, max: number) => string;
  /** 条的配色，与 `ConsoleChipTone` 同一套词。 */
  tone?: ConsoleChipTone;
}

export interface ConsoleProgress {
  /** `.progress`，扩展把它 append 到卡里 */
  el: HTMLDivElement;
  readonly value: number;
  readonly max: number;
  /** 设值；顺带改满值（总量是边跑边知道的时候用） */
  setValue(value: number, max?: number): void;
  /** 改左侧小标题 */
  setLabel(text: string): void;
}

export interface ConsoleCopyOptions {
  /** 按钮上的字，缺省「复制」 */
  label?: string;
  /** 缺省 `sm`：这颗几乎总是跟在别的东西后面，不该抢主按钮的份量 */
  size?: 'sm' | 'md';
  variant?: 'plain' | 'primary';
  /** 成功那条 toast 的措辞，缺省「已复制」 */
  okText?: string;
}

/** 接受任意带 disabled 字段的控件，忽略 null 与 undefined。 */
export type ConsoleDisablable = { disabled: boolean } | null | undefined;

export interface ConsoleFormat {
  /** 12345 → `12.3k` */
  count(n: number | null | undefined): string;
  /** 1536 → `1.5K` */
  bytes(n: number | null | undefined): string;
  /** 0.42 → `42%` */
  percent(r: number | null | undefined): string;
  /** ISO 时间戳 → `18:56:48` */
  clock(ts: unknown): string;
  /** 金额，带货币符号 */
  money(n: number | null | undefined, currency?: string): string;
  /** 毫秒 → `1.2s` / `3m 04s` */
  duration(ms: number | null | undefined): string;
}

// ---------------------------------------------------------------------------
// Bundle
// ---------------------------------------------------------------------------

export interface ConsolePanel {
  /**
   * 渲染面板，返回的 Disposable 在 unmount 时释放；ctx.own、interval、frame 已登记的资源无需再次返回。抛错由 host 转成当前面板错误卡，不影响其他面板或其他页。
   */
  mount(ctx: ConsolePanelContext): void | Disposable | Promise<void | Disposable>;
}

/** console/client.ts 的 default 导出。panels 以局部 panel id 为键；服务端已声明但扩展未提供的面板显示错误。 */
export interface ConsoleClientBundle {
  panels: Record<string, ConsolePanel>;
}

/**
 * host 侧用来校验 `import()` 回来的东西确实是个扩展。
 *
 * 数组要排掉：`{panels: []}` 也满足 `typeof === 'object'`，放过去之后 host 会
 * 按 `panels[panelId]` 全部取空，报成"扩展缺这个面板"——那是条误导的诊断，
 * 真相是"这压根不是个扩展"。
 */
export function isConsoleClientBundle(v: unknown): v is ConsoleClientBundle {
  const panels = (v as ConsoleClientBundle | null)?.panels;
  return !!panels && typeof panels === 'object' && !Array.isArray(panels);
}
