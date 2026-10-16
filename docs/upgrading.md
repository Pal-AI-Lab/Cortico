<!-- Owner: src/extensions/manifest.ts -->

# 把扩展升到当前契约

当前契约版本是 world **6**、provider **6**、bot **7**(`EXTENSION_API_VERSIONS`)。`cortico.api` 还是
world 5、provider 5、bot 6 的包加载不了,扩展页显示「需要升级」。按下面改完、重新发布即可。
English below.

## 改名

| 旧 | 新 |
|---|---|
| World / Persona / provider 的 `console(language)` | `webUi(language)` |
| `Console*` 类型(`ConsolePanelContext`、`WorldConsoleDecl`、`ConsolePageContribution` 等) | `WebUi*`(`WebUiPanelContext`、`WorldWebUiDecl`、`WebUiPageContribution`) |
| `BotParts.console` | `BotParts.webUi` |
| manifest `cortico.consoleClient` / `cortico.consoleStyle` | `cortico.webUiClient` / `cortico.webUiStyle` |
| 面板源码目录 `console/`,产物 `dist/console.js` / `.css` | `webui/`,`dist/webui.js` / `.css` |
| HTTP `/api/console/*` | `/api/webui/*` |
| 内置 World `terminal`(`terminal_send`、`terminal.*` 事件、`world:terminal`) | `console`(`console_send`、`console.*`、`world:console`) |
| 配置 `logging.console` | `logging.stdout` |

`cortico.api` 改成上面的版本号;devDependency `cortico` 升到同版本。

## 自描述

三类扩展的定义都写 `describe`,写法见 [extensions.md](extensions.md)「自描述」。写好后在 Cortico 仓库根目录:

```bash
pnpm describe:extension <包目录>
pnpm check:extension <包目录>
```

前一条写出 `describe.json` 并把 `"describe": "describe.json"` 加进 cortico 块;package.json 有 `files` 时把
`describe.json` 加进去。`check:extension` 要求 describe 存在、实例的工具名都已声明、文件与代码一致。

## 可选的市场字段

- `cortico.tags`:标签 id,词表与选法见索引仓的 [TAGS.md](https://github.com/Pal-AI-Lab/cortico-extensions/blob/main/TAGS.md)。
- `cortico.locales`:`{ zh?, en? }`,每项可写 `displayName`、`description`。
- `cortico.screenshots`、`cortico.icon`:包内相对路径。
- `os`:npm 标准字段,只能在部分系统上跑时写,如 `["win32"]`。
- 包根目录的 `CHANGELOG.md`:每个版本一个 `## <版本号>` 标题,市场按版本显示更新说明。

## 发布与申请

1. 跑通 `pnpm check:extension <包目录>`,末尾「Before publishing」一段列出标签、CHANGELOG、`os` 与 describe 的情况。
2. `npm publish`。官方索引每 30 分钟扫一次 npm,新包会出现在市场里,并开一个讨论帖收评论与喜欢 / 不喜欢。
3. 要改官方给的标签、申请认证、声明被新包取代、对拉黑申诉、举报或提议新标签,在索引仓
   [Pal-AI-Lab/cortico-extensions](https://github.com/Pal-AI-Lab/cortico-extensions) 开 issue:标题
   `[类型] 包名`,正文一行一个 `键: 值`,格式与示例在 `check:extension` 的输出末尾和索引仓 README。

---

# Upgrading an extension to the current contract

The current contract versions are world **6**, provider **6**, bot **7** (`EXTENSION_API_VERSIONS`). A package whose
`cortico.api` is still world 5, provider 5 or bot 6 does not load, and the extensions page says it needs an upgrade.
Make the changes below and publish again.

## Renames

| Old | New |
|---|---|
| `console(language)` on a World, Persona or provider | `webUi(language)` |
| `Console*` types (`ConsolePanelContext`, `WorldConsoleDecl`, `ConsolePageContribution`, …) | `WebUi*` (`WebUiPanelContext`, `WorldWebUiDecl`, `WebUiPageContribution`) |
| `BotParts.console` | `BotParts.webUi` |
| manifest `cortico.consoleClient` / `cortico.consoleStyle` | `cortico.webUiClient` / `cortico.webUiStyle` |
| panel sources `console/`, bundles `dist/console.js` / `.css` | `webui/`, `dist/webui.js` / `.css` |
| HTTP `/api/console/*` | `/api/webui/*` |
| built-in World `terminal` (`terminal_send`, `terminal.*` events, `world:terminal`) | `console` (`console_send`, `console.*`, `world:console`) |
| config `logging.console` | `logging.stdout` |

Set `cortico.api` to the versions above and move the `cortico` devDependency to the same release.

## Self-description

Every extension definition carries `describe`; see "自描述" in [extensions.md](extensions.md). Then, from the root of a
Cortico checkout:

```bash
pnpm describe:extension <package dir>
pnpm check:extension <package dir>
```

The first writes `describe.json` and adds `"describe": "describe.json"` to the cortico block; if package.json has
`files`, add `describe.json` there. `check:extension` fails when describe is missing, when the instance returns a
tool that is not declared, or when the file differs from the code.

## Optional market fields

- `cortico.tags`: tag ids; the vocabulary and how to choose are in the index repository's
  [TAGS.md](https://github.com/Pal-AI-Lab/cortico-extensions/blob/main/TAGS.md).
- `cortico.locales`: `{ zh?, en? }`, each with `displayName` and `description`.
- `cortico.screenshots`, `cortico.icon`: paths inside the package.
- `os`: the standard npm field, for a package that runs only on some systems, e.g. `["win32"]`.
- `CHANGELOG.md` at the package root: one `## <version>` heading per version; the market shows each version's notes.

## Publishing and requests

1. Get `pnpm check:extension <package dir>` to pass; its "Before publishing" section lists tags, CHANGELOG, `os` and
   describe.
2. `npm publish`. The official index scans npm every 30 minutes; a new package appears in the market and gets a
   discussion thread for comments and likes / dislikes.
3. To change the tags the maintainers set, apply for certification, mark a package superseded, appeal a block, report a
   package or propose a tag, open an issue in [Pal-AI-Lab/cortico-extensions](https://github.com/Pal-AI-Lab/cortico-extensions):
   title `[type] package-name`, body one `key: value` per line. The format and an example are at the end of the
   `check:extension` output and in the index repository's README.
