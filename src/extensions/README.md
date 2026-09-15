<!-- Owner: src/extensions/manifest.ts, src/extensions/runtime.ts, src/extensions/dry-mount.ts, src/extensions.ts -->

# src/extensions

扩展是装在 `extensions/` 下的 npm 包,给框架补一个 World、一个 provider 或一个 bot。
三类使用相同的 manifest 和加载流程,按 `kind` 校验默认导出结构、id 命名空间与控制台页前缀。
`pnpm check:extension` 使用 `dry-mount.ts` 在假部署中验证构造与声明接口:
World 调用 `create()` / `tools()` / `console()`,provider 调用 `create()`,bot 调用 `build()`;
不调用 `start()`。

## manifest

包的 `package.json` 里一块 `cortico`:

```jsonc
{
  "name": "cortico-world-vtuber",
  "type": "module",                       // 必填;CommonJS 有加载重复模块实例的风险
  "keywords": ["cortico-world"],          // npm 搜索按类关键字:cortico-world / cortico-provider / cortico-bot
  "cortico": {
    "kind": "world",                      // world | provider | bot
    "api": 3,                             // 扩展契约版本,与 EXTENSION_API_VERSION 相等才加载
    "consoleClient": "dist/console.js",   // 可选:预构建的面板 bundle,包内相对路径
    "consoleStyle": "dist/console.css"    // 可选:随 bundle 注入的样式
  }
}
```

`parseExtensionManifest(pkg)` 只做解析与校验,不碰文件系统;装载器与
`pnpm check:extension <dir>` 共用它。`api` 与框架不等时不加载,扩展页说明哪一边旧。
`WorldDefinition`、`ProviderModule`、`BotDefinition`(连同 `BotParts`、`Persona`、`LoadedConfig`)
或 `ConsolePanelContext` 任一不兼容变更就把 `EXTENSION_API_VERSION` 加一。

已发生、尚未计入版本号的不兼容变更(下次升版一并计入):

- `WorldContext.language` 删除。
- `Persona.firstTurn()` 改为 `sessionHead()`,返回 Open Responses item 列表;`FirstTurnRound` 删除。
- `ConfigGroup.settingsPage` 删除,Persona 的配置组一律进 Persona 页;`ConsoleContribution.storage` 删除。

## 装载

`loadExtensions(repoRoot)` 读 `extensions/package.json` 的 dependencies,逐个从
`extensions/node_modules/<包>/` import 入口(`exports` → `module` → `main` → `index.js`),
按 `kind` 校验默认导出:

| kind | 默认导出 | 命名空间 | 控制台页 |
|---|---|---|---|
| `world` | `WorldDefinition`(`id` / `label` / `defaults()` / `create()`) | 与内建 World 共用 | `world:<id>` |
| `provider` | `ProviderModule`(`id` / `title` / `reasoningTiers` / `serviceTiers` / `create()`) | 与内建 provider 共用 | `llm:<id>` |
| `bot` | `BotDefinition`(`id` / `defaults()` / `build()`) | 不得与仓内 `bots/` 目录同名 | `persona:<id>` |

与内建 id 冲突的扩展不能加载;两个扩展 id 相同时只加载第一个。单个扩展失败不影响其他扩展,
原因写入 `ExtensionRecord.reason`。

bot 包不在这条循环里 import:`deployment.json` 的 `bot` 字段指向哪个包,启动器就先经
`locateBotPackage()`(优先仓内 `bots/<名>/`,其次为 `extensions/` 下同名且 `kind: "bot"` 的包)与
`importBotDefinition()` 导入该包,再作为 `activeBot` 交给 `loadExtensions()` 标记加载状态:
同名记录记 loaded,其余 bot 包记 `idle`。`ExtensionSet.bot` 说明这份部署的 bot 来自扩展包,
`createBot` 据此把已安装扩展包内的提示词模板设为只读,pnpm 安装的文件可能硬链接到 store。结果 `ExtensionSet` 里 `worlds` 由启动器接在仓内目录(`src/worlds/index.ts`)之后,整张表经
`withWorlds()` 交给 bot 定义；它仅补充缺失的 World 配置段，已有段保持原值，新增段的 `enabled` 取决于 bot 是否声明该 World。`providers` 交给 `registerProviderModules()`，`consoleAssets` 交给控制台。

新装或卸掉的包要重启进程:ESM 模块缓存不支持运行中换代码。

## 扩展怎么 import 框架

扩展写 `import { nowIso } from 'cortico/core/util.ts'`:`cortico/<路径>` 就是 `src/<路径>`。
`runtime.ts` 用 `module.registerHooks` 把这个前缀映到框架源码,再交给链上下一个解析器,
所以扩展与框架拿到同一份模块实例。fork 出去的子进程用 `childExecArgv()` 带上同一个钩子。

浏览器侧(面板 bundle)对 `cortico/*` 只允许 `import type`;bundle 里要用的运行时值由包自带。

## 控制台接口

`ExtensionManager` 提供扩展页接口:`list()` 比较启动时的加载结果与当前安装状态
(`loaded` / `failed` / `pending-restart` / `removed`),`search()` 按关键字查 npm registry,
`install()` / `uninstall()` 经 `corepack pnpm add|remove --ignore-workspace` 改 `extensions/`。
装卸串行。面板 bundle 的 URL 由服务端分配:`/assets/extensions/<包>/<版本>/<文件>`,只发
manifest 里声明的那两个文件。
