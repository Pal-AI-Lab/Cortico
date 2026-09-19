<!-- Owner: src/worlds/bilibili/definition.ts -->

# worlds/bilibili

B 站直播间协议只读接入。观众的弹幕、礼物、醒目留言、上舰、进场与人流读数从这里进事件流；
同一 World 提供本机透明 Overlay。唯一工具 `bilibili_set_announcement` 只写本机 Agent 公告栏，
不会向 B 站账号发送弹幕或执行平台操作。

“重要观众”指符合 UID 资格、在限流时优先分配上下文预算的观众。资格、拥挤状态、事件分组与人物档案召回由 [`audience-admission.ts`](audience-admission.ts) 管理；阈值和预算在 [`config.ts`](config.ts)。资格变化不删除 Memory 中的人物档案。具体条件见「重要观众与实时限流」。

## 分层

| 文件 | 职责 |
|---|---|
| [`wire.ts`](wire.ts) | 16 字节帧头的编解码;`op=5` 且 protover 2/3 时包体是压缩过的另一串完整包,解析是递归的 |
| [`client.ts`](client.ts) | 握手四步 + wss 长连 + 30s 心跳 + 退避重连 |
| [`normalize.ts`](normalize.ts) | 原始 cmd → 归一化产物(事件 / 计数 / 读数 / 不推)。纯函数 |
| [`protobuf.ts`](protobuf.ts) | 按字段号与 wire type 读取 protobuf；无法解析时返回 null |
| [`gift-frame.ts`](gift-frame.ts) | `SEND_GIFT_V2` 的 pb blob → V1 字段形状。两种帧共用下游 |
| [`coalescing-buffer.ts`](coalescing-buffer.ts) | 相同弹幕与常规礼物进入事件总线前的固定窗归并 |
| [`audience-admission.ts`](audience-admission.ts) | 按 UID 记录优先资格，以高能榜和批次预算决定是否筛选，并分配三类事件的上下文额度 |
| [`world.ts`](world.ts) | 投递分档、人流聚合、公告工具、控制台数据面与 Overlay 接线 |
| [`overlay/`](overlay/) | 设计模型、用户组匹配、原始事件显示、素材、公告持久化、loopback HTTP/SSE、运行页与独立编辑器 |
| [`console/`](console/) | 直播间入站诊断 `log`；Overlay 编辑入口由 World 链接提供 |

帧压缩使用 `node:zlib`，WBI 签名使用 `node:crypto` 的 md5，WebSocket 使用 `ws`。protobuf 读取器按已核对的字段编号解析；本项目没有官方 `.proto` schema。

## 接入协议

本 World 使用 B 站 web 直播协议，按返回的 uid 识别观众。该接口非官方开放平台接口，字段可能变化，接入也可能受风控限制。

## 送礼帧:V1 与 V2 并存

`SEND_GIFT` 使用 V1 JSON 字段；`SEND_GIFT_V2` 的 `data.pb` 是 base64 编码的 protobuf，`data` 还可含 `dmscore`。[`gift-frame.ts`](gift-frame.ts) 将 V2 解码为 V1 字段结构，包括 `giftName`、`num`、`coin_type`、`total_coin`、`uname` 与 `sender_uinfo`。帧中已有 V1 字段时沿用 V1 路径。

字段编号没有官方 schema，映射来自 `bilibili-raw-samples.jsonl` 的实际接收帧。回归夹具位于 [`tests/worlds/bilibili/gift-v2-frames.ts`](../../../tests/worlds/bilibili/gift-v2-frames.ts)，保留原始布局并替换身份字段。V1 接收帧和同结构夹具也用于回放与测试。

**读取失败不能降级为计数。** 只有明确读出 `coin_type` 且不是 gold 时才计为免费礼物；读取失败仍生成事件，正文省略金额并告警。

握手四步(全在 `client.ts`):

1. `x/frontend/finger/spi` 取非空 `buvid3`
2. `x/web-interface/nav` 取 WBI 密钥与登录 uid
3. `Room/get_info` 将短房间号转换为认证包使用的真实房间号
4. `getDanmuInfo`(WBI 签名)拿弹幕服务器列表与 token

## 登录凭证与观众身份

`worlds.bilibili.sessdata` 保存浏览器登录后的 SESSDATA cookie，位于部署的 `config.json`，不进入版本控制。匿名连接仍可接收弹幕；已观测到匿名响应将观众 uid 置为 0，并对昵称脱敏。`uid=0` 时不生成 `senderKey`，昵称不作为稳定身份键。

已有弹幕且最近至多 20 条均缺少有效 uid 时,控制台显示「近期弹幕缺少观众 uid」。

登录态以服务端返回的 `LiveStatus.selfUid` 为准，0 表示匿名。已配置 `sessdata` 但仍为匿名时，每次接入至多记录一次 error。

## 接入日志

- **归并统计**：`info 直播间归并折叠` 按分钟汇总 `folds`、`sourceItems` 和 `windowMs`，停机时记录剩余不足一分钟的统计。
- **筛选统计**：`warn 直播间准入筛除` 逐批记录筛除量、候选量、限流状态与本场累计量。
- **存储失败**：`warn B站观众准入账本落盘失败` 由 `onPersistError` 报告。

## 投递分档

事件按 `trigger` 决定是否唤醒以及是否参与合批。人流读数在投递时生成正文。

| 事件 | 唤醒 | 说明 |
|---|---|---|
| `bilibili.superchat` | flush | 醒目留言 |
| `bilibili.guard` | flush | 上舰 |
| `bilibili.gift` | flush / debounce | 金额 ≥ `worlds.bilibili.giftFlushYuan` 走 flush,低于它先过短窗归并再排常规合批 |
| `bilibili.guard-renew` | debounce | 续费 |
| `bilibili.danmaku` | debounce | 弹幕 |
| `bilibili.enter-guard` | debounce | 舰长进场(普通进场只计数) |
| `bilibili.block` | debounce | 观众被禁言 |
| `bilibili.room` | flush / debounce | 开播、下播、全员禁言走 flush;标题变更 debounce |
| `bilibili.feed` | flush / debounce | 弹幕接入中断超过 60 秒成文一次(flush),恢复时补一条带中断时长(debounce);60 秒内的抖动不推 |
| `bilibili.warning` | flush | 超管警告与切断；World 仅投递事件 |
| `bilibili.superchat-del` | piggyback | |
| `bilibili.audience` | piggyback + **投递成文** | 人流读数 |

进场、点赞和免费礼物累计次数；看过、在线、人气与粉丝数记录接收时的读数。它们在 World 内累积，经 `pushDeferred` 随下一批事件投递，并在渲染正文后清零。待投递期间不重复登记；超过 5 分钟未渲染时允许重新登记。

`normalize.ts` 的 `IGNORED` 列出不投递的 cmd，包括运营挂件、连麦玩法、全站广播及自身语音转写。未识别的 cmd 仍按原名称计数，并显示在控制台。

## 相同消息归并

弹幕与低于插队门槛的付费礼物在写事件库和总线前经过固定窗。窗口默认 300ms，从池内首件
起算且不因后续消息续期；累计到 64 条立即冲刷。任何不能归并的事件与 `flush` 都是顺序屏障：
先按各组首件的到达顺序冲刷旧池，再立即写入该事件。停机同样先冲刷并取消定时器。

弹幕以「稳定 UID + 去掉首尾空白后的正文」逐字匹配，大小写、内部空白和 Unicode 形式均不改写；**不同观众发同一句话不合并**。礼物只合并礼物流中连续出现的同一稳定 UID、同一礼物名和单价，累计笔数、件数与金额；另一位送礼人或另一种礼物结束该连续段，普通弹幕不打断礼物段。无稳定 UID 的礼物逐笔投递，不凭昵称猜身份。匿名接入时弹幕没有稳定身份键，按正文合并。
单件仍使用原正文、昵称和 `senderKey`；两件以上写成 `[弹幕×N|昵称] 正文`；礼物写成 `[礼物×N笔 ¥合计|昵称] 礼物×总件数`，保留送礼人姓名与组级 `senderKey`。昵称必须进入归并正文，因为私有 `meta` 不渲染给 agent。
参与者的稳定 `senderKey`、昵称与原始条数保留在组级私有 `meta`，供人物档案逐人召回。Overlay 与控制台日志在原始消息到达时逐条更新，不等待归并窗。

控制台 `log.state.coalescing` 报告输入量、输出量、已合并量、冲刷次数、容量冲刷次数与当前池内条数。`worlds.bilibili.coalesceWindowMs` 和 `worlds.bilibili.coalesceMaxItems` 支持热改；窗口设为 0 时关闭等待，逐条输出。

## 重要观众与实时限流

优先资格只使用稳定 UID，满足任一条件即可获得：舰队身份的正向记录保留 35 天；单条 SC 不低于 ¥30，或 30 天内累计不低于 ¥50；30 天内至少一场直播有 25 个去重活跃分钟。互动所需分钟数与场次数可配置。SC 与互动资格自命中起保留 30 天。

账本位于 `data/bilibili-audience/ledger.json`，记录 UID、时间、金额、活跃分钟和用于跨批分配的等待计数（`fairDebt`）；不存昵称或消息正文。记录在归并和筛选前更新。脏账本每 30 秒至多保存一次，停机强制保存；运行期保存失败时报警，保留未保存状态并在后续更新时重试。

高能榜用于判断拥挤状态，不等同于在线人数。默认达到 200 时进入拥挤态，连续 120 秒不高于 170 时退出；信号超过 300 秒未更新后不再维持拥挤态，下播或切换直播代次时清零。只有拥挤态且同批候选超过 114 行或 1,061 个估算 token 时才筛选，否则全部进入上下文。

筛选时分为三组：

- `critical`：平台警告、开关播、SC、上舰/续费与达到即时投递金额门槛的礼物全部保留，可超过批次预算。
- `important`：任一参与者具有优先资格的合并组整体归入此组。按跨批等待计数分配，最多使用所配置行数和 token 预算的 50%，同时受全批剩余额度限制。
- `ordinary`：其余事件按持久保存的私有盐确定性抽样，使用剩余额度。

原始事件均以 `archive-only` 保存，供历史查询；筛选结果进入 Agent 上下文。控制台报告高能榜、拥挤与限流状态、重要观众数和累计筛除量。

## Overlay

World 在 `127.0.0.1` 启动独立页面：`GET /overlay` 是 OBS browser source，`GET /editor`
是编辑器，`GET /stream` 是同源 SSE 数据面，`GET /assets/<id>` 提供上传素材。端口默认 7795，
被占用或不可监听(`listen` 回 `EADDRINUSE` 或 `EACCES`)时顺延,含配置端口最多尝试 5 个端口,并记录 warn。
编辑接口只接受浏览器携带的同源 `Origin` 与 JSON 请求，并限制请求体大小；
服务不发送 wildcard CORS。设计和公告分别使用修订号做冲突检测，素材、设计与公告写入共用串行队列，
避免保存过程中删除素材或后完成的旧请求覆盖新状态。

组件类型：

- 横向或纵向弹幕机，准入可选弹幕、礼物、弹幕+礼物；用户名与内容可分别限制显示字数，礼物包含免费礼物、付费礼物、SC 与舰队事件。
- 横向或纵向滚动公告、固定公告、Agent 公告；多行滚动公告可设置每行停留时间和行间切换时长，滚动内容在运动方向的两端渐隐。
- HTTPS/HTTP 外部图片或上传图片，支持 contain/cover/fill。

组件可带独立标题。标题占据上、右、下或左侧边带，支持起点、居中、终点对齐，并拥有独立的
字体、字号、字重、RGBA 颜色与描边。Agent 公告更新时按 Unicode 字符逐字显示并保留输入光标；
弹幕机 Mock 会持续混合注入弹幕和礼物，组件工作区的 Mock 测试只写入预览运行器，不改设计、
真实公告或直播事件流。

内置样式为天蓝色、海军蓝、白色与极简，全部默认尖角。自定义样式可分别配置用户名和正文的
字体、字号、字重、RGBA 颜色与描边。Nine-slice 将源图四条切线与输出边框宽度分开保存；
编辑器可在源图上拖动切线，并用可缩放的实际组件预览验证拉伸、平铺和中心填充。

用户组规则是递归 `all`/`any` 组合。可匹配 uid、舰队等级、粉丝牌、房管、VIP/SVIP、
用户等级以及实测弹幕结构中的排名和颜色字段；最高优先级的匹配组覆写用户名与正文样式。
头像优先使用消息携带的 `sender_uinfo`/富用户信息，经典弹幕没有头像时显示昵称首字占位。

设计保存在部署配置 `worlds.bilibili.overlay.design`，由装配层的 `onOverlayConfig` 原子写回。
上传素材位于 `data/bilibili-overlay/assets/`，文件名是内容哈希；只接受经魔数确认的 PNG、JPEG、
WebP 与 GIF，单文件上限 8 MiB。Agent 公告单独原子保存到
`data/bilibili-overlay/agent-notice.json`，工具写入后以独立 SSE 事件更新公告节点，不会清空
正在滚动的弹幕。公告内容在下一次主会话前缀重建时通过 `ENV_PROMPT.md` 占位符同步； World 不会
为了每次公告写入强制重建前缀。

## 控制台

控制台提供直播间事件诊断和独立 Overlay 编辑器入口。样式、组件与布局编辑共享草稿、撤销历史和保存操作。草稿预览复用 OBS 渲染器，支持拖动、八向缩放、网格、画布与组件吸附、层级、可见性和锁定；编辑控件与选择框不进入 `/overlay` 输出。

从主 Web 页面打开编辑器时，语义调色板通过 URL fragment 传递。编辑器内置浅色和深色默认调色板，主 Web 停止后仍可通过独立 URL 打开。画布背景的浅深设置只保存在本机，不写入设计数据。

配置项包括直播间号、登录凭证、礼物即时投递门槛、相同消息归并窗与容量上限，以及 Overlay
启用、端口和 Agent 公告字数上限。

日志面板每 2 秒轮询 `log.state`。`total` 是累计记录数，包括已超出 `RECENT_CAP` 而从缓冲移除的记录；客户端按差值追加新行，保留滚动位置。

目录名 `worlds/bilibili` 的末段必须与 World id `bilibili` 对得上:浏览器产物的 asset key 由目录名推导
(`src/worlds/<x>/console/client.ts` → `world:<x>`),而控制台按 provider id `world:bilibili` 去取它。
两边对不上时页面上出现的是"声明了面板,但没有构建出浏览器扩展"。

## 字段待校

以下 cmd 尚未用实际接收帧验证，字段形状来自社区文档：
`ROOM_BLOCK_MSG`(禁言)、`ROOM_SILENT_ON/OFF`、`WARNING`、`CUT_OFF`。

已用接收帧核对的 cmd 包括 `DANMU_MSG`、`USER_TOAST_MSG_V2`、`INTERACT_WORD_V2`、`LIKE_INFO_V3_*`、`WATCHED_CHANGE`、
`ONLINE_RANK_COUNT`、`ROOM_REAL_TIME_MESSAGE_UPDATE`、`STOP_LIVE_ROOM_LIST`。

`INTERACT_WORD_V2` 使用 protobuf；当前解析未区分进场、关注和分享，均计为进场。

## 接入限制

- 握手失败后按指数退避重连，等待从 2 秒起加倍，最多 60 秒。状态轮询遇到 HTTP 412 时将下一次轮询延后 10 分钟。412 / -352 作为风控错误报告。
- 连接看门狗在平台开播时检查 `connecting`，以及没有重试定时器的 `retrying` 状态；持续 60 秒无结果后重新连接。它不检查 `connected` 状态下长期收不到业务消息的情况。
- Web 协议字段可能变化；`IGNORED` 之外的新 cmd 会显示在控制台计数中。
