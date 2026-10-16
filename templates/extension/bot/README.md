# cortico-bot-example

Owner: `index.ts`

最小完整的 bot:一个 Persona、一个常驻 session、只有控制台。Memory 是部署目录下的 `memory/`:
`MEMORY.md` 整份进 system 前缀,`memory_write` 往里追加一行,`blobs/` 收二进制。Core 只通知时机,
前缀的每个字来自 `persona/PREFIX.md`。扩展 bot 不能 import 仓内的 `bots/cormini`,要更完整的
参考实现就复制那个目录再改。

| 文件 | 内容 |
|---|---|
| `index.ts` | `BotDefinition`:id、`declares`、默认配置、`build()`、`describe`(Persona 的工具与 Memory 的形式) |
| `persona/persona.ts` | `Persona` 实现:前缀、session 声明、`memory_write`、`end_turn`、开场注入 |
| `persona/blobs.ts` | `mem:` 句柄的后端,字节住在 `memory/blobs/` |
| `persona/PREFIX.md` | 前缀装配模板;`{{persona.memory}}` 与 `{{worlds.envPrompts}}` |
| `persona/MEMORY.seed.md` | 部署第一次起来时 `MEMORY.md` 的初始内容 |
| `tests/` | 干装载、前缀渲染、写记忆、blobs |

改名清单:包名、`id: 'example'`、`Example` 前缀、`displayName`、`web.port`。bot id 不得与仓内
`bots/` 目录同名。装好后一份部署这样用它:`deployment.json` 写 `{ "bot": "cortico-bot-example" }`。
规矩见 [docs/personas.md](../../../docs/personas.md)。
