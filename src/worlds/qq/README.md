<!-- Owner: src/worlds/qq/definition.ts, src/worlds/qq/driver.ts, src/worlds/qq/normalize.ts, src/worlds/qq/world.ts -->

# worlds/qq

QQ 群聊与私聊接入。World 作为客户端连接一个 OneBot v11 协议端的正向 WebSocket,只处理
`worlds.qq.groups` / `worlds.qq.privates` 里启用的会话;发言经过起草-确认门。

## 协议端

任何 OneBot v11 实现都可以接,推荐 [SnowLuma](https://github.com/SnowLuma/SnowLuma),
[NapCat](https://github.com/NapNeko/NapCatQQ) 同样可用。换协议端只改控制台「接入门」里的
WS 地址与 token,保存后进程重启。

SnowLuma:

- 注入本机已安装并在运行的 QQNT 客户端,在 QQ 窗口里扫码登录;账号登录后它才开始监听
  OneBot 端口,这之前 World 按退避重连。
- 正向 WS 默认 `ws://127.0.0.1:3001`,与 `worlds.qq.wsUrl` 的默认值相同。token 在首次运行时
  按账号随机生成,写在 SnowLuma 目录的 `config/onebot_<QQ号>.json`。
- 它的状态命令默认开启:群里有人发 `#sl`,账号会自动回一条状态消息,这条消息不经过起草-确认门。
  接入前在 SnowLuma 配置里关掉 `statusCommand`。

## 依赖的动作与事件

OneBot v11 标准动作:`get_login_info`、`get_group_info`、`get_group_member_info`、`get_msg`、
`get_forward_msg`、`send_group_msg`、`send_private_msg`。

标准之外的字段,协议端不给时按下列方式降级:

| 字段 | 缺失时 |
|---|---|
| 通知 `group_msg_emoji_like` | 不产生表情回应事件 |
| `notify/poke` 的 `raw_info` | 动作文案退回「戳了戳」 |

## 分享卡片

JSON 分享卡片的来源名、内容标题和目标链接写入消息正文。直接消息、引用取回与合并转发使用相同解析规则。

| 卡片字段 | 小程序 `meta.detail_1` | 普通分享 `meta.news` |
|---|---|---|
| 来源名 | `title` | `tag` |
| 内容标题 | `desc` | `title` |
| 目标链接 | `qqdocurl` | `jumpUrl` |

缺失字段不补全；内容标题缺失时保留 `prompt`。只有 `prompt` 的卡片沿用 `[分享:<prompt>]`，
分享字段与 `prompt` 均缺失时显示 `[json]`。目标链接只收单个 http(s) 网址，其余当作缺失。
来源名与内容标题照卡片 JSON 原文写入，World 不核实。封面按图片配置与辅助视觉配置处理。

## 语音转写

监听会话里收到的语音,正文占位为 `[语音,正在转写中...]`,World 随后用原 `message_id` 调协议端的
转写扩展动作,不阻塞后续消息。占位这条不单独唤醒;结果另发一条 `qq.transcript` 事件,行首是原消息号,
带原会话、发言人和 `[QQ语音转写]` 标记,照常合批唤醒。没转写成的说明同样唤醒。占位随下一次唤醒投递:
转写完成前有别的消息唤醒时随那一批,否则与转写结果同批。

| 协议端 | 动作 |
|---|---|
| SnowLuma、NapCat | `fetch_ptt_text({ message_id })` → `{ text }` |
| LLOneBot | `voice_msg_to_text({ message_id })` → `{ text }` |

先试 `fetch_ptt_text`,协议端回 retcode 1404(动作不存在)才换 `voice_msg_to_text`;探明可用的
动作在本次连接内沿用,重连后重新探明。两个都回 1404 时发一条不可用说明,此后本次连接里的语音
占位为 `[语音,协议端不提供转写]`,不再请求。

超时、撤回、识别失败或转写为空不换动作名,各发一条 `[系统] #<message_id> 的语音没能转写:<原因>`。
调用时限 40s:协议端等转写结果最长 30s,再加一次普通动作调用的时限 10s。

语音以 `base64://` 的 `record` 段发出,转成 QQ 语音格式由协议端负责。
