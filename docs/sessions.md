<!-- Owner: src/core/sessions.ts, src/core/types.ts (SessionDecl, Persona.onHandoff, UsageSources), src/core/loop.ts, src/core/cost.ts (usageShares) -->

# Session

一个 session 是一次独立的模型对话:常驻的那一个接收事件投递,其余是临时 fork。session 由
Persona 声明,Core 只把 `role` 当分类标签。

## 声明

`Persona.declareSessions()` 返回一组 `SessionDecl`,其中恰好一个同时设置 `receivesEvents: true`
和 `persistent: true`:

| 字段 | 含义 |
|---|---|
| `id`、`label` | 不透明 id 与展示名 |
| `rounds()` | 软 / 硬轮数上限与 Persona 提供的 `softHint`、`hardHint`(追加时机见 `src/core/README.md`「主循环」),函数以便热改 |
| `persistent` | 是否落盘;临时 fork 不落 |
| `receivesEvents` | 是否接收事件投递 |
| `eventDelivery` | 事件以 `tool` 回执还是 `user` 消息进入上下文 |
| `outputTap` | 输出流的旁路(演出、字幕) |
| `tools()` | 这个 session 可用的工具 |

主 session 每次模型请求用当前 `activeProvider` 端点的 `spec`;fork 在创建时固定端点与模型配置。Persona 不指定模型。
主 session 与 fork 的模型请求都是流式请求;`outputTap` 决定输出流是否转给接收器、闭合的工具调用是否提前执行。
读不到 `activeProvider` 可用的 `spec` 时,主循环记一条 warn 并结束这一批:本批事件已经进了上下文,只是不发模型调用,配好端点后随下一批一起发出。

模型返回的工具调用只有 `status` 为 `completed` 才执行。其余的回执为未执行,主循环记一条 warn
(工具名、`call_id`、原始 `status`),同一轮排在它后面的调用也不执行。

一批之内,新事件在轮次边界进入上下文:本轮工具全部返回之后,或 `preempt`、`interrupt` 取消模型轮
之后。`preempt` 只取消 `outputTap` 尚未报告外部输出的模型轮,丢弃其输出;`interrupt` 取消模型轮时
保留已外化的输出,执行工具期间则停止 `interruptible` 工具、跳过本轮尚未开始的调用。两者取消后都在
同一批内带着新事件开始下一轮,被取消的轮计入 `rounds()` 的轮数,不调用 `onTurnEnded`;到达时没有
可取消的轮,事件在下一次模型请求前送入。

## 上下文与交接

Core 的输入上限为 `hardTokens = max(0, 生效窗口 − (spec.maxTokens ?? 0))`。生效窗口取服务探测值与配置的
`contextWindow` 中的较小者；两者都缺失时不设置此上限。超过上限或服务拒绝超长输入时(413 请求体过大也算),
Core 调用 `Persona.onHandoff(snapshot, { hardTokens })`。Persona 决定保留的上下文和交接笔记，
Core 重建 system 前缀、按容量截断保留内容并重置 session。
上一批已按计数强制交接、其间没有一次计数检查回到上限内,计数又越过同一上限时(窗口不大于最大输出,或交接后的
前缀仍超限),Core 不交接,记一条 error,在这个上限下不再按计数收束或强制交接;计数检查看到计数回到上限内,
或端点配置改变上限时恢复。服务拒绝超长输入与手动交接照常进行,不计入也不清除这条连续记录。

阶段预算(`context.maxTokens`、`softRatio`、`keepRatio`)是 Persona 自己的配置,不在 Core 里。
Cormini 一系的默认:64000 / 0.85 / 1/3;控制台页上下文圈的分母与黄线读的是这几个数。

## fork

`ForkOptions { id, messages, tools?, stopWhen?, wrapUpHint?, capNote?, nudge? }` 创建临时 session，
运行独立的工具循环。World 发起的认知任务（cognition）及 Persona 的梦、潜意识任务使用此接口。
Core 记录并发数，WebUI「运行诊断 → 会话统计」显示各 session 的用量。

## 持久化

常驻 session 落 `data/session-main.jsonl`,只追加;交接时的重置先写 `.tmp` 再 rename。启动时末行
没有换行结尾视为追加中途中断:解析不出的截掉、完整的补上换行,并记一条 warn;其他损坏行拒绝加载。
读回后,前面没有同 call_id 调用的工具回执被删去,文件同样先写 `.tmp` 再 rename;每条记一次 error,
原记录写进本次 run 的 `transcript.jsonl`(边界记录 `orphan-result-drop`)。缺回执的调用补一条
`[result missing (process restart)]`。
统计(调用次数、prompt / completion / 缓存命中 / 推理 token)只在内存,重启清零;已结束的
临时 session 保留最近 8 个供查看。

## 用量归属

每次模型请求的各次尝试写进 `data/usage.jsonl`(`UsageRecord`)。主循环的记录带 `round` 和 `sources`
(`UsageSources`);`/api/usage` 的 `byWorld` 与 `unattributed` 据此把每次请求的 token 和费用分给各 World。

`sources` 由主循环记下(`src/core/loop.ts` 的 `noteInput`、`outputSources`),数值是估算 token,口径与上下文
计数相同:Provider 模块给了 `estimateTokens` 就用它，否则按字数比例估。

- 输入：上次模型输出写进 session 之后新写进去的记录。投递的事件记给来源 World,一次投递写进的记录按各事件正文
  的估算 token 比例分;工具回执记给工具所属的 World,一轮几条回执各算各的;Persona 加的内容(内部事件、轮数提示)、
  来源不是 World 的事件和 Persona 工具的回执记作未归属。模型输出写进 session 时清零，失败后重试的请求仍带着它。
- 输出：拿到响应后记下推理以外的输出的估算，和其中调用各 World 工具(工具名加参数)的部分。

分摊在 `src/core/cost.ts` 的 `usageShares`:

- 输入份额是各来源占新内容估算的比例，没有新内容时全归未归属。输入、缓存命中、缓存未命中与推理的 token 和费用
  按输入份额分。
- 调用 World 工具的输出按「推理以外的实际输出 token ÷ 它的估算」折成实际 token,记给那个 World;其余输出(文字、
  推理、Persona 工具的调用)按输入份额分。输出 token 和输出费用按这样得到的输出份额分。
- 按输入加输出总量(`total`)计价的费用，按这次请求的输入、输出 token 比例混合两种份额。
- 一次请求分给各 World 与未归属的 token 和各项费用，加起来等于这次请求的实付;`byWorld` 的 token 按份额累计后取整。
- World 自己调模型的记录(`role` 为 `worlds.<id>`)全额归它;没有 `sources` 的记录(fork 等)归未归属。
