<!-- Owner: src/extensions/manifest.ts, src/extensions/runtime.ts, src/extensions/dry-mount.ts, src/extensions/market.ts, src/extensions/describe.ts, src/extensions/describe-export.ts, src/extensions.ts, src/extensions/author-guide.ts, src/extensions/previous-contract.ts -->

# src/extensions

扩展是装在 `extensions/` 下的 npm 包,给框架补一个 World、一个 provider 或一个 bot。
三类使用相同的 manifest 和加载流程,按 `kind` 校验默认导出结构、id 命名空间与 WebUI 页前缀。
`pnpm check:extension` 使用 `dry-mount.ts` 在假部署中验证构造与声明接口:
World 调用 `create()` / `tools()` / `webUi()`,provider 调用 `create()`,bot 调用 `build()`;
不调用 `start()`。报告只有英文;工具重名时写出占用者的 World id。
报告最后两段来自 `author-guide.ts`:按索引仓的标签词表核对 `cortico.tags`,发布前清单与扩展申请格式;只提示,不计入失败。

## manifest

包的 `package.json` 里一块 `cortico`:

```jsonc
{
  "name": "cortico-world-vtuber",
  "type": "module",                       // 必填;CommonJS 有加载重复模块实例的风险
  "keywords": ["cortico-world"],          // npm 搜索按类关键字:cortico-world / cortico-provider / cortico-bot
  "cortico": {
    "kind": "world",                      // world | provider | bot
    "api": 6,                             // 这一类的契约版本,与 EXTENSION_API_VERSIONS[kind] 相等才加载(上一版见下)
    "displayName": "VTuber",              // 可选:WebUI 里的名称;不合格时 warning 并忽略
    "webUiClient": "dist/webui.js",   // 可选:预构建的面板 bundle,包内相对路径
    "webUiStyle": "dist/webui.css",   // 可选:随 bundle 注入的样式
    "describe": "describe.json",      // 可选:pnpm describe:extension 生成的自描述;check:extension 要求有
    "tags": ["streaming"],            // 可选:以下三项由官方索引读取,这里只校验形状
    "locales": { "en": { "displayName": "VTuber" } },
    "screenshots": ["assets/shot-1.png"]
  }
}
```

`describe-export.ts` 在 `dry-mount.ts` 的假部署里从定义的 `describe` 生成 describe.json(`describe.ts` 是它的形状),
`pnpm describe:extension` 写文件,`pnpm check:extension` 核对包里那份一致;规则见
[docs/extensions.md](../../docs/extensions.md)「自描述」。

`parseExtensionManifest(pkg, language)` 只做解析与校验,不碰文件系统;装载器与
`pnpm check:extension <dir>` 共用它。问题与警告按 `language` 成文,扩展页的装载原因按请求语言现取。`api` 与这一类的契约版本不等时不加载,扩展页说明哪一边旧;上一版契约是例外。
上一版契约(`PREVIOUS_CONTRACT_VERSIONS`)例外:给 warning、照常加载,`previous-contract.ts` 把旧接口名接到新名上,
覆盖的范围写在它的模块头;Cortico 下一个大版本删除它。`check:extension` 对上一版契约判失败。

`EXTENSION_API_VERSIONS` 按 kind 各记一个版本:`WorldDefinition` 不兼容变更只加 world,
`ProviderModule` 只加 provider,`BotDefinition`(连同 `BotParts`、`Persona`、`LoadedConfig`)只加 bot;
`WebUiPanelContext` 与其余共用接口变更时三类一起加一。同一次发布里的多处变更合计加一。

## 装载

`loadExtensions(repoRoot)` 读 `extensions/package.json` 的 dependencies,逐个从
`extensions/node_modules/<包>/` import 入口(`exports` → `module` → `main` → `index.js`),
按 `kind` 校验默认导出:

| kind | 默认导出 | 命名空间 | WebUI 页 |
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
`withWorlds()` 交给 bot 定义；它仅补充缺失的 World 配置段，已有段保持原值，新增段的 `enabled` 取决于 bot 是否声明该 World。`providers` 交给 `registerProviderModules()`，`webUiAssets` 交给 WebUI。

新装或卸掉的包要重启进程:ESM 模块缓存不支持运行中换代码。

## 扩展怎么 import 框架

扩展写 `import { nowIso } from 'cortico/core/util.ts'`:`cortico/<路径>` 就是 `src/<路径>`。
`runtime.ts` 用 `module.registerHooks` 把这个前缀映到框架源码,再交给链上下一个解析器,
所以扩展与框架拿到同一份模块实例。fork 出去的子进程用 `childExecArgv()` 带上同一个钩子。

浏览器侧(面板 bundle)对 `cortico/*` 只允许 `import type`;bundle 里要用的运行时值由包自带。

## WebUI 接口

`ExtensionManager` 提供扩展页接口:`list(language)` 比较启动时的加载结果与当前安装状态
(`loaded` / `failed` / `pending-restart` / `removed` / `idle`),给出本机 `platform`,带上本机 package.json 的 `metadata` 与 `author`,
末尾接 `builtins` 给的随框架条目,每条再经 `decorate` 补上本进程的 `enabled` / `hidden`。
`search()` 按 `keywords:<类关键字>` 查 npm registry,一个包都没回时再按类关键字做文本搜索，结果只留带这个关键字的包,每条带 npm 维护者 `maintainers`;翻到上限时 `searchPartial()` 为真;`npmRegistry()` 给出所用的 registry;`packageInfo(name, version?)` 取一个版本的包文档,带 package.json 的 `os`,`history[].problems` 是按各版本自己的 manifest 判出的不兼容原因;
`updates()` 比较磁盘版本与 `latest`。这三处用安装时的 registry:首次查询时在 `extensions/` 里跑
`pnpm config get registry`,成功的结果缓存到 `setRegistry()` 改写 `extensions/.npmrc` 的
`registry=` 行为止(`configuredRegistry()` 读这一行),pnpm 失败时抛出它的输出;连接失败和读正文时断线的错误都带主机和
undici 的 `cause` 错误码。
`search()` 命中的 `downloads` 另问 `api.npmjs.org/downloads/point`,不走这个 registry:`week`、`month` 为近 7 天、近 30 天,
`total` 按 365 天一段往前累加、某段为 0 即停。不带 scope 的包合批问,带 scope 的逐个问;单次请求 3 秒没回或失败就缺那一项,
`month` 缺时留搜索端点的月数。
`packageInfo()` 的 `author` 取 package.json 的 `author`(字符串只取名字,或 `{ name }`);`publisher` 取 `_npmUser.name`。
`check(target, kind?)` 装前只读 manifest;`install()` / `uninstall()` 经 `corepack pnpm add|remove` 改 `extensions/`,
先补上空的 `pnpm-workspace.yaml` 让它成为独立的工作区根,并带 `--config.strict-dep-builds=false`:跳过构建不算失败。
`install()` 随后把 `allowBuilds` 里待定、又是已装扩展直接依赖的包改成 true 并 `pnpm rebuild`,其余待定的列进回执。
规则见 [docs/extensions.md](../../docs/extensions.md)「安装」。装卸串行。面板 bundle 的 URL 由服务端分配:`/assets/extensions/<包>/<版本>/<文件>`,只发
manifest 里声明的那两个文件。

`market.ts` 的 `ExtensionMarket` 是扩展页的官方索引与讨论区:`merge()` 把索引仓的 `index.json` / `catalog.json` 合进
`search()` 的结果,`mergePackage()` 把 `packages/<包名>.json` 的自描述与更新日志正文合进 `packageInfo()` 的详情,
`blocked()` 给已装包的拉黑原因,其余方法是 GitHub 设备码登录、投票与评论。令牌文件与索引缓存都在扩展目录;
规则与接口见 [docs/extensions.md](../../docs/extensions.md)「市场的官方索引」。
