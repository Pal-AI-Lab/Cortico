<!-- Owner: src/web/server.ts, src/web/shared/console-protocol.ts, src/web/shared/client-panel.ts -->

# src/web

控制台服务端、共享协议和浏览器代码。框架页面由控制台实现；World、Persona 与 Provider 通过声明贡献页面。
服务端聚合、校验并分发声明。

## 目录

| 路径 | 职责 |
|---|---|
| `server.ts` | `WebApp`：Express、WebSocket、API 路由、静态资源和首页入口注入。 |
| `console-pages.ts` | `ConsolePageRegistry`、`ConsoleAssets`：聚合页面与资源，读取 `dist/web/asset-manifest.json`。 |
| `path-picker.ts` | 按平台调用本机路径选择器。 |
| `shared/console-protocol.ts` | 页面 id、manifest、路由常量与校验规则，供服务端和浏览器共用。 |
| `shared/client-panel.ts` | 浏览器面板接口：`ConsolePanelContext`、`ConsoleUi`、`ConsolePanel`。 |
| `client/core/` | API、路由、生命周期、流连接、WebSocket 与语言设置。 |
| `client/console-pages/` | 页面宿主、面板加载器、上下文与内置面板，如 `llm-settings`。 |
| `client/features/` | 框架页面，每页实现 `FrameworkFeature`。 |
| `client/ui/` | `ConsoleUi` 组件与图标。 |
| `client/shell/`、`client/theme/` | 页面框架与主题。 |
| `public/` | `index.html` 与 Tailwind 入口。 |

## 协议

`ConsolePageKind` 包含 `framework`、`world`、`persona`、`memory`、`llm`。贡献页 id 使用 `world:<id>`、
`persona:<id>`、`memory:<id>` 或 `llm:<id>`；构建脚本与服务端共用 `pageIdFor()`,`memory:<id>` 的浏览器产物
取 `persona:<id>` 那份。面板 id 在所属页内唯一。
manifest 的 `CONSOLE_PROTOCOL_VERSION` 不匹配时，浏览器拒绝加载。

`toPageManifest()` 将服务端的 `ConsolePageContribution` 转换为 `ConsolePageManifest`。
`invoke`、`promptDocs.path`、`config.schema` 和 `storage` 不发送给浏览器；`links`、`builtin` 与资源 URL 按协议规则校验。
链接拒绝 `javascript:`、`data:`，一页最多七盏状态灯。

| 路由 | 用途 |
|---|---|
| `/api/console/manifest` | 页面声明。 |
| `/api/console/lamps` | 状态灯。 |
| `/api/console/providers/<page>/panels/<panel>/<method>` | 面板调用；GET 只对面板 `getMethods` 点名的方法开放，参数使用 query 中的 JSON 数组；POST JSON 上限为 64 MiB。 |
| `/ws/providers/<page>/panels/<panel>` | 面板流。 |

## 服务端

`WebApp` 默认监听 `127.0.0.1`，支持由依赖配置指定监听地址。从首选端口起最多尝试五个端口；
端口为 0 时仅申请一次系统分配。WebSocket 使用 `noServer` 分派 `/ws/debug`、`/ws/sessions` 和面板流。
所有请求与 upgrade 先校验 Host 头：只接受回环名或显式绑定的地址，绑到通配地址时不校验。
写请求与 upgrade 再按 Host 校验 Origin，拒绝不匹配或无效的 Origin；缺少 Origin 时放行。

`/assets` 提供 `dist/web` 资源。首页在最后一个 `</body>` 前注入带 hash 的入口。
扩展面板通过 `/assets/extensions/<包>/<版本>/<文件>` 提供，仅允许 manifest 声明的脚本与样式文件。

`createBot()` 通过 `WebAppDeps` 注入事件库、session、运行控制、配置、存储、`consolePageSources` 和扩展信息。

## 浏览器

`main.ts` 的 `FEATURES` 包含 `live`、`core`、`usage`、`provider`、`world`、`extensions`、`prompts`、
`appearance`、`settings`。贡献页由 manifest 加载，保留路由段 `provider` 交由 `ConsolePageHost` 处理。
`features/config/view.ts` 与 `features/storage/view.ts` 是配置组与存储清单的通用视图,运行诊断页与
`ConsolePageHost` 共用。

`ConsolePageHost` 渲染页面声明中的徽标、状态灯、配置组、提示词文档、存储项与面板。
`ConsolePageLoader` 按页 id 查找 bundle，缓存成功的导入，校验默认导出的 `{ panels }`；缺少 `mount` 的面板显示错误。
卸载依次执行 abort、dispose、清空 root，并释放上下文登记的轮询、RAF、observer、监听器、请求和音频资源。

`ConsoleUi` 返回 DOM 节点，文本参数不作为 HTML 解析。面板通过 `signal` 管理资源。abort 会关闭关联的 toast、confirm 和 drawer，
待决 confirm 返回 `false`。

## 构建

`scripts/build-web.ts` 使用以下入口：

| 入口 | 资源键 |
|---|---|
| `src/web/client/main.ts` | 控制台主入口。 |
| `src/worlds/*/console/client.ts` | `world:<name>` |
| `src/providers/*/console/client.ts` | `llm:<name>` |
| `bots/*/console/client.ts` | `persona:<name>` |

esbuild 输出分包 ESM 和带 hash 的文件名，写入 `asset-manifest.json`；Tailwind 输出 `styles.css`。
浏览器代码使用 `tsconfig.web.json` 检查：`pnpm typecheck:web`。
