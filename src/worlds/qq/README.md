<!-- Owner: src/worlds/qq/definition.ts, src/worlds/qq/driver.ts -->

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

语音以 `base64://` 的 `record` 段发出,转成 QQ 语音格式由协议端负责。
