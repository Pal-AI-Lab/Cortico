<!-- Owner: src/paths.ts, src/deploy.ts, src/bot.ts -->

# bots/

每个子目录是一个 bot 代码包，包含 Persona、配置默认值、装配代码、提示词和演出配置。
部署保存配置、密钥、Memory 与运行数据，默认位于 `deployments/`，可用 `CORTICO_HOME` 更改位置。
`deployment.json` 的 `bot` 字段指定代码包；多份部署可以使用同一个包。启动器按部署列出入口。

```bash
pnpm start <部署名>
pnpm start --list
```

Windows 也可通过 `start.bat` 选择部署。

## 代码包

| 路径 | 内容 |
|---|---|
| `index.ts` | `BotDefinition`：创建 Persona、声明 World、提供配置默认值和控制台贡献。启动器合并内建与扩展 World，按 `worlds.<id>.enabled` 挂载；控制台支持激活、停用和重启。 |
| `persona/` | Persona 代码与默认模板。 |
| `vtuber-pack/` | `cortico-world-vtuber` 使用的演出词表、曲线与参数。可通过 `worlds.vtuber.packDir` 指定目录；未提供演出包时使用 World 的示例包。 |
| `worlds/<id>/ENV_PROMPT.md` | bot 对 World 环境模板的覆盖，整份替换并保留占位符插值；缺失时使用 World 自带模板。 |

## 部署

下列路径相对于 `<CORTICO_HOME>/<部署名>/`，部署内容不纳入仓库版本控制。

| 路径 | 内容 |
|---|---|
| `deployment.json` | 引用的代码包，例如 `{ "bot": "cortiv" }`。 |
| `config.json` | 部署配置，覆盖代码包默认值。 |
| `.env` | World 密钥。Provider 密钥由端点管理，保存在部署根共享的 `providers/<端点名>/` 中。 |
| `memory/` 或 `workspace/` | Memory 内容；路径由 Persona 的 `paths.memory` 决定，Git 历史由 Persona 实现提供。 |
| `worlds/<id>/ENV_PROMPT.md` | 部署对 World 模板的覆盖。控制台保存写此文件；恢复默认会删除此覆盖，重新使用 bot 或 World 模板。 |
| `prompts/` | Persona 模板覆盖，例如 `ORIENTATION.md`。合成首轮从部署的 `FIRST_TURN_{USER,THINKING,REPLY}.md` 读取，作为 session 的合成开头送进请求；开关 `context.firstTurn` 在 Persona 配置组，默认关闭。 |
| `vtuber-pack/` | 可选的部署演出包。 |
| `avatar.png`、`voices/` | 头像与参考声线素材。 |
| `data/` | 事件库、session、用量记录和 Core 状态。 |

配置优先级为组件默认值、bot 默认值、部署配置，按层深合并。
提示词与演出文件按 World、bot、部署的顺序覆盖，同名文件整份替换。

## 内建 bot

| 代码包 id | Persona 类 | 显示名 | 能力 | 默认控制台端口 |
|---|---|---|---|---|
| `corti-soulmate` | `CortiSoulmate` | 雪午Yukima | 分层 Memory、潜意识三路、QQ 起草与确认、提案和宪法。 | 7777 |
| `cormini` | `Cormini` | 可缇mini | 工作区 Memory、宪法前缀、主 session 和终端。 | 7788 |
| `cortiv` | `CortiV` | 可缇Corti | 继承 Cormini，增加观众档案、交接后台整理，以及直播相关 World。 | 7789 |

## 新建 bot

行为变体可继承现有 Persona，覆写钩子、前缀或交接策略。不同 Memory 结构或 session 组织可从
`cormini` 复制后修改。变体通过独立类实现，基类不增加用于选择变体的构造开关。

设置 `index.ts` 的 `id` 与 `web.port`，创建部署目录并用 `deployment.json` 引用该包。
`createBot()` 提供框架控制台页；bot 的 `console` 声明补充其专有功能。
