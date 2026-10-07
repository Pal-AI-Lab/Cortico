<!-- Owner: src/core/sessions.ts, src/core/types.ts (SessionDecl, Persona.onHandoff), src/core/loop.ts -->

# Session

一个 session 是一次独立的模型对话:常驻的那一个接收事件投递,其余是临时 fork。session 由
Persona 声明,Core 只把 `role` 当分类标签。

## 声明

`Persona.declareSessions()` 返回一组 `SessionDecl`,其中恰好一个同时设置 `receivesEvents: true`
和 `persistent: true`:

| 字段 | 含义 |
|---|---|
| `id`、`label` | 不透明 id 与展示名 |
| `rounds()` | 软 / 硬轮数上限,函数以便热改 |
| `persistent` | 是否落盘;临时 fork 不落 |
| `receivesEvents` | 是否接收事件投递 |
| `eventDelivery` | 事件以 `tool` 回执还是 `user` 消息进入上下文 |
| `outputTap` | 输出流的旁路(演出、字幕) |
| `tools()` | 这个 session 可用的工具 |

主 session 每次模型请求用 `activeProvider` 端点的 `spec`;`Persona.mainEndpoint()` 返回端点名时这次请求
改用该端点,上下文上限仍按 `activeProvider` 计算。fork 在创建时固定端点与模型配置。Persona 不指定模型。
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
`contextWindow` 中的较小者；两者都缺失时不设置此上限。超过上限或服务拒绝超长输入时，
Core 调用 `Persona.onHandoff(snapshot, { hardTokens })`。Persona 决定保留的上下文和交接笔记，
Core 重建 system 前缀、按容量截断保留内容并重置 session。

阶段预算(`context.maxTokens`、`softRatio`、`keepRatio`)是 Persona 自己的配置,不在 Core 里。
Cormini 一系的默认:64000 / 0.85 / 1/3;终端页上下文圈的分母与黄线读的是这几个数。

## fork

`ForkOptions { id, messages, tools?, stopWhen?, wrapUpHint?, capNote?, nudge? }` 创建临时 session，
运行独立的工具循环。World 发起的认知任务（cognition）及 Persona 的梦、潜意识任务使用此接口。
Core 记录并发数，控制台「运行诊断 → 会话统计」显示各 session 的用量。

## 持久化

常驻 session 落 `data/session-main.jsonl`,只追加;交接时的重置先写 `.tmp` 再 rename。启动时末行
没有换行结尾视为追加中途中断:解析不出的截掉、完整的补上换行,并记一条 warn;其他损坏行拒绝加载。
统计(调用次数、prompt / completion / 缓存命中 / 推理 token)只在内存,重启清零;已结束的
临时 session 保留最近 8 个供查看。
