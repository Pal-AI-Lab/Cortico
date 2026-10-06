<!-- Owner: src/core/types.ts (World, WorldHost, ToolDef, ToolCallContext, OutputTap, CognitionHost) -->

# Cortico World 兼容等级

本页给其他架构的 bot 对照自身循环,判断能挂载哪些 Cortico World。等级按宿主提供的能力划分,
每一级包含前一级。各条对应的接口成员见 [worlds.md](worlds.md) 与 `src/core/types.ts`。

只做到 L1 的宿主,World 对它而言是一组工具与一段环境描述;L2 起,环境变化以事件流进入 bot 的上下文。

## L1 工具

- 挂载 World 声明的工具(`tools()`),按名字调用 handler;工具名在一个 bot 内全局唯一,冲突时拒绝挂载。
- 把 World 的环境描述(`envPromptVars()` 填入 `ENV_PROMPT.md` 模板)放进 system 前缀;返回 `null` 时省略整段,
  前缀重建时重新取值。
- 工具回执可带附件:模型接受该 MIME 时附加内容,否则只发送 `fallbackText`。handler 抛错转成失败回执。
- 调用 `start(host)` / `stop()`。

## L2 事件流

- `pushEvent` 保存事件并投递进上下文;没有用户发言时,外部事件也能唤醒一轮模型调用。
- 正文 `text` 原样进入上下文,宿主不改写、不补写语义内容。
- 区分 `origin`:`internal` 只给来源可验证的内部通知,其余一律按 `external` 处理。
- `barrierAfter`:同一条 assistant 输出中排在该工具后面的调用不执行,得到未执行回执。
  `endsTurn`:该工具完成后结束本次唤醒,期间到达的事件留待下一次投递。
- 一轮结束(assistant 自然结束、模型调用失败或轮数达到硬上限)时调用 `onTurnEnded()`。
- 宿主放弃一次工具调用时触发 `ToolCallContext.signal`。
- 提供 `modelFacts`(当前模型名、接受的 MIME、上下文窗口)、`blob(handle)` 与 `reportUsage()`。

## L3 投递语义

- 按 `trigger` 安排投递:`preempt` 取消尚未产生外部输出的模型调用并立即投递,`interrupt` 停止当前轮
  (模型调用与 `interruptible` 工具)并立即投递,`flush` 立即投递并带上积压,
  `debounce` 参与合批,`piggyback` 只排队、随其他批次投递;`deliver: false` 只存储。
- `pushDeferred`:投递时才调用 `render` 生成正文;返回 null、抛错或超时时不存储、不投递。
- `pushCandidate`:先归档原始事件,投递时整批交给 World 选取并生成正文。
- `ephemeral` 事件在下一批投递时从 session 移除,事件库保留。
- 提供事件库读取(`store`)、`drainPendingEvents(filter)` 与工具执行期间的 `queueExternalEvents`。
- `withdrawPending` 撤回、`promotePending` 提级未投递的事件;事件写入 session 或被丢弃时调用
  `onEventsSettled`。
- 上下文交接后、恢复投递前调用 `onHandoffEnded()`。

## L4 实时

- `outputTap()`:把主 session 的模型输出流逐段交给 World;`externalizes` 返回 true 后,该轮不再被 `preempt` 取消。
- `cognition`:World 向 Persona 请求后台认知计算。
- `llmStalls(withinMs)`:最近一段时间内模型调用失败或流中断的次数。
- `onRunPhase(phase)`:主循环进入投递、模型调用、工具执行、重试等待、交接或空闲时,以及工具开始或结束时同步通知。

控制台面板与配置组不属于等级;没有控制台的宿主由 World 的配置文件提供配置。

## World 对照表

最低等级以下无法挂载;介于最低与完整之间时,World 可以运行,缺失的能力按右列降级。

| World | 最低 | 完整 | 低于完整等级时 |
|---|---|---|---|
| `websearch` | L1 | L1 | |
| `terminal` | L3 | L3 | |
| `qq` | L3 | L3 | |
| `bilibili` | L3 | L3 | |
| `minecraft` | L3 | L4 | 没有 `cognition` 时,交给后台构思的工具回执说明该能力未接入,其余工具照常 |
| `asr`(扩展) | L2 | L2 | |
| `canvas`(扩展) | L2 | L2 | |
| `pvz`(扩展) | L3 | L3 | |
| `vtuber`(扩展) | L4 | L4 | |

其他扩展包按它在源码中用到的 `WorldHost` 成员与工具标记,对照上面四级自行判断。
