<!-- Owner: bots/cortiv/index.ts, bots/cortiv/persona/persona.ts -->

# bots/cortiv

直播 bot,默认展示名可缇Corti。Persona `CortiV` 继承 `Cormini`，增加观众档案和交接后的后台整理。

## 启动

```bash
pnpm start cortiv
```

默认控制台地址：`http://127.0.0.1:7789/`。

## World

| World | 功能与配置 |
|---|---|
| `terminal` | 控制台聊天。 |
| `minecraft` | Minecraft 操作、任务队列和客户端托管。 |
| `pvz` | 植物大战僵尸操作、任务队列和游戏托管，由扩展 `cortico-world-pvz` 提供，默认关闭。 |
| `vtuber` | L1–L4 演出、TTS 声卡输出、演出流 SSE `http://127.0.0.1:7792/stream` 与弹幕输入 WS，由扩展 `cortico-world-vtuber` 提供。 |
| `bilibili` | 直播间只读接入：弹幕、礼物、SC、上舰和观众统计。默认关闭，启用前填写 `worlds.bilibili.roomId`；`sessdata` 可提供登录凭证。 |
| `asr` | 麦克风语音识别，由扩展 `cortico-world-asr` 提供，默认关闭。 |

未安装的扩展 World 显示为不可用。VTS 首次连接授权后可将 `VTS_AUTH_TOKEN` 写入部署 `.env`。

## 事件投递

默认将外部事件正文放入合成的 `external_event_frame` 工具回执，user 消息用于内部系统文本。

## Memory

Memory 使用工作区文件，由 [Persona](persona/persona.ts) 管理。

| 功能 | 行为 |
|---|---|
| 观众档案 | `viewers/<来源>/<数字ID>.md`，首行为摘要。同一 `senderKey` 在当前上下文窗口首次出现时，档案首行与外部事件同批注入。交接清除已唤起记录，热重启保留；没有稳定身份键的事件不触发档案召回。后台整理追加档案时同时更新首行摘要。 |
| 工作区工具 | 基类提供 `read_file`（支持行区间）、`write_file`、`edit_file`、`delete_file`、`list_files`、`glob_files`、`grep_files`；另外提供 `append_file`、`git_log`、`git_show`、`recall_viewer`。文件修改成功后尝试提交工作区 Git，使用 Persona 署名；提交失败保留已写文件并报告错误。 |
| 主动召回 | `recall_viewer` 按 id 读取完整档案；按名字查询当前已知观众与档案首行，唯一匹配时返回全文，无档案时返回已知 id。自动召回只提供首行；事件正文不附加身份 id。 |
| 目录列表 | 前缀将 `viewers/` 与 `handoffs/` 显示为文件计数。`list_files` 指定目录时列出全部条目；默认列表的各子目录最多展示十项并统计其余条目。前缀提示使用 `recall_viewer` 读取档案。 |
| 上下文阈值 | 批末估算 token 超过 `context.maxTokens * context.softRatio` 时，首次注入记录提醒；提醒后再次在批末超过阈值才请求交接。交接后复位提醒状态。Core 另按模型 token 上限执行强制交接。 |
| 后台整理 | 交接把快照排入串行 `dream` 队列，继续执行基类交接，不等待整理结束。基类写交接笔记并返回空 tail。后台使用相同档位模型，更新观众档案、整理场次和过时内容。 |

后台整理按原顺序从快照头部选取消息，正文总预算为 120,000 字符。user/assistant 单条上限
1,500 字符、工具参数 300 字符、工具回执 800 字符；忽略 system 与无文本项，超过总预算后停止选取。
整理结束后，非空且已变化的 `recent` 文件摘要最多注入 900 字符；非空且不为 `(nothing)` 的最终文本另注入最多 600 字符。

观众身份按来源与数字 uid 区分，昵称用于显示和查询。首次出现的弹幕、礼物或上舰事件均可触发召回，
不依赖普通进场事件；普通进场只参与聚合统计。
