Owner: `src/core/core.ts`, `src/core/types.ts`, `src/core/loop.ts`, `src/core/bus.ts`

# src/core

Core 管理 session、事件流与模型调用的生命周期，包括事件投递、调度、上下文交接、工具执行、
容量限制、错误隔离和 Provider。Persona 定义上下文语义；Core 使用的事件封装、错误和截断记号
在 `markers.ts` 中定义。

## 文件

| 文件 | 职责 |
|---|---|
| `types.ts` | 全部契约:`Persona`、`World`、`WorldHost`、`CoreApi`、事件、工具、日志、配置类型 |
| `core.ts` | Core 装配，`Persona` / `CoreApi` 的边界 |
| `loop.ts` | 主 session 的模型调用循环、事件投递、上下文交接执行 |
| `bus.ts` | `WakeBus`：合批事件总线、四种触发模式、FIFO 顺序、暂停与投递闸门 |
| `fork.ts` | 临时 session 的工具循环 |
| `session.ts`、`sessions.ts` | 常驻 session 的追加式上下文；各 session 的状态与用量记录 |
| `event-store.ts` | 按 run 分片的 JSONL 事件库,cursor 跨 run 全局单调 |
| `state.ts`、`run.ts`、`timers.ts` | `core-state.json`;run 目录;通用持久定时器 |
| `transcript.ts`、`tool-log.ts`、`usage-log.ts` | 主 session 副本、工具调用记录、用量记录 |
| `cost.ts`、`billing.ts`、`generation.ts` | 消耗汇总、计费余额、`ResponseClient` 与计量口径 |
| `prefix.ts`、`template.ts` | system 前缀装配、环境提示词三层覆盖、模板渲染 |
| `truncate.ts`、`markers.ts`、`blobs.ts` | 上下文压缩、结构记号、附件句柄(`log:` / `mem:`) |
| `config.ts`、`config-schema.ts` | `CORE_DEFAULTS`、深合并、配置项声明 |
| `instance-lock.ts`、`language.ts`、`secrets.ts` | 单实例锁、控制台语言、按名取密钥 |
| `log-context.ts`、`ipc-logger.ts`、`util.ts` | 日志关联字段、子进程日志回传、Logger 与 token 估算 |

## Core 类

构造时创建事件库、session、状态、定时器和日志，先调用 `persona.attach(core)`，再调用
`persona.declareSessions()`。声明中必须恰有一个同时设置 `receivesEvents` 和 `persistent`，否则抛错。
公开成员：`store`、`bus`、`session`、`state`、`timers`、`loop`、`llm`、`sessions`、`providers`、
`sessionDecls`;`spawnFork`、`resolveBlob` / `internBlobs`、`setWorldVisible`、`activeSpec` /
`activeProviderEntry`、`mountWorld` / `unmountWorld`、`start` / `stop`。

Persona 通过 `CoreApi` 访问：`injectInternal` / `injectDeferred` / `injectExternal`、
`requestContextHandoff`、`spawnFork`、`sessionInfo`、`llm`、`timers`、`deliveryGate`、
`personaState` / `savePersonaState`、`toolsTagged`、`blob`、`log`。

## 总线与唤醒

`WakeBus` 提供 `preempt`、`flush`、`debounce`、`piggyback` 四种触发模式。
debounce 的计划投递时刻为 `min(首件时刻 + maxBatchAgeMs, max(首件时刻 + minBatchAgeMs,
末件时刻 + quietGapMs))`；计数达到 `maxBatchSize` 时立即投递。
计数包含外部即时事件与候选，不包含内部事件、延迟渲染项或 piggyback 项。
piggyback 只入队，随后续唤醒一起投递。

操作者的 `paused` 和 Persona 的 `DeliveryGate` 控制投递；操作者暂停的优先级更高。
`nextBatch()` 仅支持一个消费者，每次按 FIFO 顺序取走整批。`batching` 使用共享配置引用，
更新后的值在下一次入队时参与计算。

投递水位 `lastDeliveredCursor` 持久化，队列不持久化。重启时补投水位之后的外部事件；
已被候选处理结果引用的原始归档不重复投递。内部事件仅在当次运行投递。

## 主循环

每次唤醒处理一批事件，可进行多轮模型调用。`SessionDecl.rounds()` 提供
`{ soft, hard, softHint? }`：到 soft 轮时将 `softHint` 追加到最后一条工具回执；到 hard 轮时
记录 warn 并结束本批。`endsTurn` 工具和自然结束共用结束处理；本批结束时尚未处理的事件
退回总线，进入下一批。

状态 0、429 或 5xx 的模型调用失败，可保留已记录的输出和工具回执，按 `ResubmitPolicy` 重试。
默认允许连续重试 2 次、每批最多 4 次，退避为 2 秒、10 秒；上下文超限、抢占、关机或轮数
达到硬上限时不重试。

参数不是合法 JSON 时返回 `TOOL_FAILED_BAD_ARGS`，不执行工具；未知工具返回 `UNKNOWN_TOOL`；
handler 异常转为失败回执。流式生成时 `EagerDispatch` 可提前执行完整的工具调用，遵守
`barrierAfter` 顺序，并按 call id 配对结果。回执超过 8000 字符时记录 warn。

## 上下文

`hardTokens = max(0, contextWindowOf(spec) − (spec.maxTokens ?? 0))`。
`contextWindowOf` 取 provider 探测值与手动 `contextWindow` 的较小者；两者均未知时不按窗口裁剪。
超过上限时，主循环在轮次边界结束本批，并在批末强制交接；上游报告输入超限时也请求交接。

`Persona.onHandoff(snapshot, { hardTokens })` 返回 `{ tail, trim? }`。Core 重建 system 前缀，
按 `hardTokens − estimate(prefix)` 限制保留上下文，其中 prefix 包括 system 前缀和 Persona 的合成
开头(`sessionHead()`)。Core 校验工具调用配对，并重置 session。
阶段预算与保留比例由 Persona 决定，模型配置来自当前 provider。

## 错误隔离

装配层将 World 构造失败限制在该 World。`start()` 抛错时不挂载；`stop()` 失败或超时会记录
结果并继续卸载。`onOpening`、`onDelivery`、`onBatchEnd`、`onTurnEnded`、`onIdle` 异常记录
warn；`onHandoff` 异常记录 error 并使用默认交接策略。其他钩子的异常由调用方处理。
读取 `console()` 失败时省略该 World 的环境段，继续构建前缀。主循环异常退出时记录 error
并停止定时器。启动器处理未捕获的进程异常并执行关机流程。
