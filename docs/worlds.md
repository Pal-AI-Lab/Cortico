<!-- Owner: src/core/types.ts (World, WorldHost), src/world.ts -->

# World

World 通过事件报告外部环境变化,通过工具提供外部操作,并向 system 前缀提供环境描述。
World 不直接访问 Memory 或调用 Persona 的工具。

## 契约

`World`:

| 成员 | 含义 |
|---|---|
| `id` | 同时用于配置段 `worlds.<id>` 和控制台页 `world:<id>` |
| `envPromptVars()` | 环境提示词模板的当前占位符值。返回 `null` 时省略整段,`{}` 时使用无变量模板;前缀重建时重新调用 |
| `tools()` | 这个 World 暴露的工具 |
| `start(host)` / `stop()` | 启动与停止;运行中挂载时先调用 `start`,成功后加入挂载表 |
| `console?()` | 控制台页声明(见 [console.md](console.md)) |
| `outputTap?()` | 主 session 输出流的接收器(演出、字幕);这一刻没有接收器时返回 `undefined` |
| `onHandoffEnded?()`、`onTurnEnded?()` | 交接结束与主循环一轮结束的通知;隐藏的 World 不接收 |
| `shutdownVerification?()` | 关机前要核对的外部状态,同步只读快照 |

Core 通过 `WorldHost` 向 World 提供以下能力:

| 成员 | 含义 |
|---|---|
| `pushEvent(e, opts?)` | 落库分配游标,按 `opts.trigger` 投递;不填 `origin` 即 `external` |
| `pushDeferred(e, { trigger })` | 投递时生成正文;`render` 返回 null、抛错或超时时不存储、不投递 |
| `pushCandidate?(spec, { trigger })` | 先归档原始事件,在投递时选择内容并生成正文 |
| `store`、`drainPendingEvents(filter)` | 读事件库;消费待投递事件(一次性) |
| `modelFacts` | 当前模型接受什么(多模态等) |
| `blob(handle)`、`reportUsage()`、`llmStalls?()` | 附件、用量上报、模型停滞查询 |
| `cognition?` | 向 Persona 请求后台认知计算;Persona 未提供时该成员不存在 |
| `log` | 包含 World 区域和调用关联字段的 Logger |

`trigger` 控制投递时机:`preempt` 请求中断当前模型调用并立即投递,已提交不可逆输出时不取消调用;
`flush` 立即投递并包含积压事件;`debounce` 参与合批;`piggyback` 仅排队,随其他触发产生的批次投递。
外部事件默认 `debounce`,内部事件默认 `flush`。`deliver: false` 仅存储事件。

被动变化通过事件报告,主动查询通过工具提供。当前状态快照使用 `pushDeferred` 在投递时读取,
配合 `piggyback` 随其他事件投递。只有需要立即中止当前模型轮的事件使用 `preempt`。
World 应通过事件报告服务器起停、存档切换、连接变化等状态变更。

事件是 `EventEnvelope`:`cursor`、`run`、`type`、`ts`、`source`(World id)、`origin`、`tags`、
`text`(由生产方提供,Core 不添加语义内容)、`senderKey`、`meta`、`blobs`、`ephemeral`。
系统生成的判断只陈述可确认的事实。`origin: 'internal'` 只用于来源可验证的内部通知;
外部消息使用 `origin: 'external'`。

工具回执 `ToolOutcome { text, blobs?, failed? }`;handler 抛错由 Core 转成失败回执。
`endsTurn` 让一个工具结束本轮,`barrierAfter` 让流式提前派发在它之后停下。
工具名在一个 bot 内全局唯一:模型按名字调用,Core 按名字归属与隐藏。用自家短名做前缀
(`mc_`、`qq_`);工具名与已挂载 World、Persona 工具或 Core 保留帧名冲突时,装配层拒绝挂载并报告原因。

## 定义与装配

`WorldDefinition`(`src/world.ts`):`id`、`label`、`defaults()`(配置段默认值,World 声明的
`enabled` 应为 false)、`preflight?`、`configOptions?`、`create(ctx)`。
`WorldContext` 向 `create` 提供:`cfg`(共享配置对象)、`timezone`、`botName`、`botDir` /
`packageDir` / `dataDir` / `repoRoot`、`secret()` / `storeSecret()`、`persist()`(写回
`worlds.<id>`)、`restart()`。界面语言不在其中:它是每个请求的属性,`console(language)` 与
`configOptions(kind, language)` 每次传入(见 [console.md](console.md))。

仓内定义列在 `src/worlds/index.ts`;启动器合并内建与扩展定义,通过 `withWorlds()` 交给 bot 定义。
bot 的 `index.ts` 在 `declares` 中列出默认启用的 World id。声明但未安装的 World 显示为不可用;
补充 World 默认段时,声明过的 `enabled` 置 true,其余置 false;bot 已提供的配置段保留原值,
部署配置可继续覆盖。
`WorldAssembly` 分别管理各 World:`create()` 抛错不影响其他 World 的构造;
`activate` / `deactivate` 热生效并写回 `worlds.<id>.enabled`。定义实例在停用或重启时重新构造;
预建实例重启时复用现有对象,停用后不能通过 `activate` 重新挂载。
生命周期事件转给 `Persona.onWorldLifecycle`。

## 环境提示词

每个 World 一份 `ENV_PROMPT.md` 模板,三层覆盖:`src/worlds/<id>/ENV_PROMPT.md` ←
`bots/<名>/worlds/<id>/ENV_PROMPT.md` ← `<部署>/worlds/<id>/ENV_PROMPT.md`,后一层整份替换。
Persona 的段模板用 `{{world.id}}` 与 `{{world.envPrompt}}` 嵌入,前缀总装模板用
`{{worlds.envPrompts}}`。模板语法只有三条(`src/core/template.ts`)。

环境提示词说明使用时机、跨工具协作和操作约束。工具 `description` 说明该工具的参数、行为与回执。
两处不重复。

## Persona–World 状态对账(PWSR)

此设计仍在试验中。实现位于 `src/worlds/minecraft/world.ts`,由 World 自行管理,Core 不提供专用接口。

设计原则是将路标、目标的持久语义记录交给 Persona 管理的 Memory,World 保存用于机械计算的运行时副本。
bot 从 Memory 读取记录,再调用 World 工具登记;World 不直接读取 Memory。
当前目标与路标遵循此方式,蓝图另有文件持久化,具体范围见下文。

生命周期(realm 指 World 内的隔离域,如一个存档):

1. 目标与路标按 realm 保存在内存中。首次访问 realm 时创建空表,切换时保留旧表,切回后继续使用。
   重新创建 World 实例或清除相应存储项后表为空。World 通过事件或工具回执报告状态,提供批量登记工具。
2. bot 自己从 Memory 找出对应的语义信息,调装载工具写入暂态;装载回执做世界核验,凡能对世界查证
   的逐条核验,如登记位置的方块是否仍为容器。
3. 工具回执或描述提示 bot 在语义变更后同步更新 Memory 中的记录。
4. 对齐提醒只跟随 bot 主动的语义写操作(增、删、改名、改语义)。位置、建造进度这类高频机械变化
   绝不催写 Memory。
5. World 对暂态做机械计算,以事实形式进回执(距离、包含、账单、图算法)。空间事实携带维度;方位、
   距离、包含与世界核验只在同一 realm 的同一维度内计算。

Persona 自行决定恢复时机与内容。表为空时回执缺少相应信息,操作仍可执行。

准入判据,三条都满足才立一张暂态表:

- **需要语义输入和机械计算。** 记录由 bot 命名或定义,并供 World 计算。纯语义记录保留在 Memory;
  可直接观察的容器内容等状态从环境读取。
- **低频。** 语义变更预期每场数次至数十次;同步提醒只随语义写操作产生,不周期投递。
- **可选。** 空表不阻塞操作。

计算结果须区分 bot 的标记与环境事实。「路径进入了你标记的危险区」可以,
「系统判断这里危险」不可以。

Minecraft 的 `PwsrTables` 管理目标、路标及蓝图的 realm 视图,空间记录按维度隔离。
蓝图数据由 `BlueprintBook` 管理:设计可跨 realm 使用,施工绑定按 realm 和维度保存。
配置 `dataDir` 时,设计与绑定写入 `minecraft-blueprints.json`,在下次创建实例时加载。

## 内建 World

| id | 是什么 |
|---|---|
| `terminal` | 控制台里的对话通道,与 QQ 同层级的外部平台 |
| `qq` | OneBot 协议端,只监听名单里的群与私聊;起草-确认门 |
| `bilibili` | B 站直播间只读接入与本机 Overlay |
| `minecraft` | mineflayer 客户端,观察 = 结构化文本、动作 = 异步执行器;子进程 |
| `websearch` | 只有请求 / 响应工具,不产事件 |
| `console-fixture` | 开发控制台与验收测试使用的 World |

`vtuber`、`asr`、`pvz`、`canvas` 是扩展包(见 [extensions.md](extensions.md))。`bilibili` 与
`minecraft` 各有自己的 README;`src/worlds/websearch/` 最短,`src/worlds/minecraft/` 最全。

## 添加 World

从 `WorldDefinition` 起:`defaults()` 定配置段,`create()` 返回实现 `World` 的实例;有自定义面板就加
`console/client.ts`;有环境描述就加 `ENV_PROMPT.md`。测试用 `tests/helpers/fake-host.ts` 的
`FakeHost` 记录推送。放进仓库的在 `src/worlds/index.ts` 登记一行;放进仓库还是做成扩展,判据在
[CONTRIBUTING.md](../CONTRIBUTING.md)。
