# cortico-world-example

Owner: `src/definition.ts`

挂载时投递 `example.started` 事件，提供 `example_echo` 工具和环境提示词。
配置项 `worlds.example.greeting` 可在 WebUI 修改并立即生效。测试覆盖事件投递、工具调用和配置修改后的回执。

| 文件 | 内容 |
|---|---|
| `src/definition.ts` | `WorldDefinition`:id、label、默认配置段、`create()` |
| `src/config.ts` | 配置段类型、默认值、WebUI 配置组 |
| `src/world.ts` | `World` 实现:事件、工具、`webUi()` 声明 |
| `src/ENV_PROMPT.md` | 环境提示词模板;`{{example.greeting}}` 由 `envPromptVars()` 报值 |
| `tests/` | 干装载、事件、工具回执;`helpers/fake-host.ts` 是记录推送的假宿主 |

改名清单:包名、`id: 'example'`、`EXAMPLE` / `Example` / `example_` 前缀、事件 `type` 的 `example.`
段、配置键 `worlds.example.*`、promptDoc key。规矩见 [docs/worlds.md](../../../docs/worlds.md)。
