<!-- Owner: src/core/types.ts (Persona), src/bot.ts -->

# Persona 与 Bot

Persona 定义一类 Bot 的语义:上下文怎么构造、有哪些 session、认知流程、交接策略、对 Memory 的
解释与操作工具。Bot 是一份装配定义:选一个 Persona、声明一组 World、给出默认配置。两者都在
`bots/<名>/` 下,进版本控制,或者作为 `kind: "bot"` 的扩展包装在 `extensions/` 下(见
[extensions.md](extensions.md));Memory 与配置在部署里。

## Persona 契约

Core 在生命周期节点调用 Persona 钩子。Persona 通过钩子返回值和注入接口提供上下文中的语义内容。

必填:

| 成员 | 含义 |
|---|---|
| `systemSegments(ctx)` | system 前缀的有序命名段,Core 逐字拼接 |
| `memoryDir` | Memory 目录绝对路径 |
| `blobs` | `mem:` 句柄的后端 |
| `attach(core)` | 拿到 `CoreApi`;在 `declareSessions` 之前调用 |
| `declareSessions()` | session 声明,恰好一个 `receivesEvents` 且 `persistent`(见 [sessions.md](sessions.md)) |

可选时机钩子:`onOpening({ reason })`(session 开场)、`onDelivery({ events })`(一批唤醒项投递刻,
钩子内同步调用 `injectInternal` 的项加入本批)、`onBatchEnd()`(一批处理结束,可执行上下文容量策略)、
`onTurnEnded()`、`onIdle()`、`onStallsRecovered()`(回一句措辞或 null)、
`onWorldLifecycle(event)`、`sessionHead()`(合成开头:置于 system 之后、持久历史之前的 item 列表,每次请求现取,不落盘)、
`onHandoff(snapshot, { hardTokens })`(回 `{ tail, trim? }`)、`promptVarValues(ctx)`、
`ownToolNames()`(自有工具名,装配层据此拒绝工具名冲突的 World;未提供时仅告警并保留先注册的工具)、
`cognition`(处理 World 的后台认知请求)、`console()`。
钩子的异常处理方式见 [Core 文档](../src/core/README.md)。

工具不在 Persona 上,在每个 `SessionDecl.tools()` 里;`end_turn`、`save_blob` 这类是 bot 侧的
Persona 工具,Core 只认 `ToolDef.endsTurn`。

`CoreApi` 是 Persona 唯一的 Core 入口:`injectInternal` / `injectDeferred` / `injectExternal`、
`requestContextHandoff`、`spawnFork`、`sessionInfo`、`llm`、`timers`、`deliveryGate`、
`personaState` / `savePersonaState`(不透明状态,Core 只负责原子持久化)、`toolsTagged`、
`blob`、`log`。

## Bot 定义

包代码通过 `cortico/<src 下的路径>` 导入框架,如 `cortico/bot.ts`、`cortico/core/types.ts`。
仓内包和扩展包使用相同的导入路径。

`bots/<名>/index.ts` 默认导出 `BotDefinition`:

| 字段 | 含义 |
|---|---|
| `id`、`description` | 包 id 与一句话 |
| `defaults()` | bot 默认配置,可包含 World 段。启动器用 `withWorlds()` 补充内建与扩展 World 中缺失的默认段,保留此处已有的段 |
| `declares` | 默认启用的 World id;未安装时显示为不可用。已安装但未声明的 World 默认关闭,部署可自行启用 |
| `build(loaded, worlds)` | 创建 Persona,返回 `BotParts { persona, worlds?, llm?, onStart?, onStop?, console? }` |

`createBot()` 的顺序:算提示词覆盖目录 → 定默认语言 → `WorldAssembly` → `build()` → `Core` →
装配层绑定挂载钩子 → 收配置组(含未激活槽位)→ provider 设置页 → `WebApp`。`start()`:单实例锁
→ 控制台 → 启动 active provider → `onStart` → `core.start()`。

## 包里有什么

| 路径 | 内容 |
|---|---|
| `index.ts` | `BotDefinition`,声明包 id、默认配置与装配方法 |
| `persona/` | Persona 代码与它的提示词模板(`PREFIX.md`、`ENV_SECTION.md`、`CORE.md`…) |
| `console/client.ts` | Persona 页的面板 bundle(可选) |
| `worlds/<id>/config.json`、`worlds/<id>/ENV_PROMPT.md` | 对某个 World 的默认配置与环境提示词覆盖 |
| `vtuber-pack/` | 挂 `cortico-world-vtuber` 的包才有:演出词表、曲线、参数集 |

部署里的东西见 [deployment.md](deployment.md)。

## 参考 bot

| 包 | Persona | 一句话 | 端口 | Memory |
|---|---|---|---|---|
| `corti-soulmate` | `CortiSoulmate` | 分层记忆、交接后并行梦、QQ 起草-确认门、宪法归梦修订 | 7777 | `memory/` |
| `cormini` | `Cormini` | 最小完整实现:工作区即记忆、宪法即前缀、一个 session、只有终端 | 7788 | `workspace/` |
| `cortiv` | `CortiV` | AI VTuber 实时系统:演出舞台、B 站直播间、游戏 | 7789 | `workspace/` |

## 添加 Bot

- 继承:像 `cortiv` 那样 `class CortiV extends Cormini`,差异写成独立类的行为(覆写时机钩子、
  前缀段、交接策略),不给基类加构造开关。
- 复制:要改记忆结构或 session 形态时,复制 `bots/cormini/` 整个目录再改 `persona/`。

修改 `index.ts` 中的 `id` 与 `web.port`,再在部署根下创建引用此包的部署。
框架提供通用控制台页,专有面板通过 `console` 声明。
