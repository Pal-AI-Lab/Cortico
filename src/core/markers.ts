/**
 * 模型上下文中的结构标记，用于缺失、截断、不可用或中断的内容。
 * 标记使用英文，不受控制台语言设置影响；语义说明由 Persona 提供。
 */

/** 工具回执被折叠(见 truncate.ts 的 FOLD_THRESHOLD) */
export const FOLD_PLACEHOLDER = '[result folded]';
/** 调用入参被折叠 */
export const FOLD_ARGS_PLACEHOLDER = '[arguments folded]';
/** 单条越过整份预算,整条换成记号 */
export const OVERSIZE_PLACEHOLDER = '[turn too long, omitted]';

/** 配对修复:重建后调用还开着,补一条回执 */
export const MISSING_RESULT = '[result missing]';
/** 进程重启后，为未完成的调用补充缺失回执。 */
export const MISSING_RESULT_RESTART = '[result missing (process restart)]';
/** 主线程调用仍在执行时，fork 快照中的临时回执。 */
export const PENDING_IN_MAIN_THREAD = '[result pending in the main thread]';

/** 工具名不在本 session 的工具表里 */
export const UNKNOWN_TOOL = '[unknown tool]';
/** fork 调用了当前工具表中不存在的名称。 */
export const forkUnknownTool = (name: string): string =>
  `[unknown tool ${name}] This thread wires a subset of the tools. Use the ones listed above.`;

/** 上游把这次调用标成未完成(流被截断),参数不可信,不执行 */
export const NOT_EXECUTED_INCOMPLETE = '[not executed: function call incomplete]';
/** 屏障工具(barrierAfter)之后同一条消息里的调用 */
export const NOT_EXECUTED_BARRIER = '[not executed: review the preceding tool result first]';
/** fork 已结束，同一条消息中后续的调用不执行。 */
export const NOT_EXECUTED_THREAD_ENDED = '[not executed: this thread already ended]';
/** 流在响应中途断了,提前派发的调用没跑完 */
export const NOT_EXECUTED_STREAM_ABORTED = '[not executed: stream aborted mid-response]';
/** interrupt 事件到达时本轮尚未开始的调用 */
export const NOT_EXECUTED_INTERRUPTED = '[not executed: interrupted by a new event]';
/** interruptible 工具执行期间发出过 interrupt 信号,接在它的回执之后;做到哪一步由回执正文说明 */
export const INTERRUPTED_WHILE_RUNNING = '[an interrupt signal was sent while this tool ran]';
/** 主循环已停 */
export const NOT_EXECUTED_LOOP_STOPPED = '[not executed: main loop stopped]';
/** 关机打断了这一轮,回执取不回来了 */
export const SHUTDOWN_INTERRUPTED = '[tool result unavailable: shutdown interrupted the round]';

/** 工具失败的模型可见标记；结构化失败状态使用 ToolOutcome.failed。 */
export const toolFailed = (detail: string): string => `[tool failed] ${detail}`;
/** 参数不是合法 JSON:不进 handler,就地失败 */
export const TOOL_FAILED_BAD_ARGS = toolFailed('arguments are not valid JSON');

/** 合成投递帧的表头(见 loop.ts 的 EXTERNAL_EVENT_FRAME) */
export const eventFrameHeader = (count: number): string =>
  `[${count} new event${count === 1 ? '' : 's'}]`;
/** 读取投递帧正文时使用，需与写入的表头一致。 */
export const EVENT_FRAME_HEADER_RE = /^\[\d+ new events?\]\n?/;
