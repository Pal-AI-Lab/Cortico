<!-- Owner: src/web/server.ts, src/web/framework-release.ts, src/web/auth.ts, src/web/shared/console-protocol.ts, src/web/shared/client-panel.ts, src/web/client/console-pages/host.ts, src/web/client/console-pages/builtins/llm-settings/panel.ts, src/web/client/console-pages/builtins/llm-settings/pricing-panel.ts, src/web/client/features/providers/index.ts, src/web/client/features/live/index.ts -->

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
| `/api/extensions/updates` | 已安装 npm 扩展的可用新版本及逐包检查错误。 |
| `/api/console/providers/<page>/panels/<panel>/<method>` | 面板调用；GET 只对面板 `getMethods` 点名的方法开放，参数使用 query 中的 JSON 数组；POST JSON 上限为 64 MiB。 |
| `/ws/providers/<page>/panels/<panel>` | 面板流。 |

## 服务端

`GET /api/framework/release` 返回 `package.json` 的版本；GitHub 最新正式 Release 更高时带上它的版本与链接，
查询失败返回错误。

`WebApp` 默认监听 `127.0.0.1`，支持由依赖配置指定监听地址。从首选端口起最多尝试五个端口；
端口为 0 时仅申请一次系统分配。WebSocket 使用 `noServer` 分派 `/ws/debug`、`/ws/sessions` 和面板流。
所有请求与 upgrade 先校验 Host 头：只接受回环名、显式绑定的地址和 `allowedHosts` 里的名字，绑到通配地址时不校验。
写请求与 upgrade 再按 Host 校验 Origin，拒绝不匹配或无效的 Origin；缺少 Origin 时放行，Origin 是
`allowedHosts` 里的名字时放行。监听非回环地址而没有设访问密码时启动记一条 warn。
`auth.ts` 的 `ConsoleAuth` 在设了密码时把未登录的请求挡在各路由与 body 解析之前:`/` 给登录页,其余 401,
upgrade 断开;登录态是 HttpOnly Cookie 里的无状态签名令牌(见 [console.md](../../docs/console.md))。

`/assets` 提供 `dist/web` 资源。首页在最后一个 `</body>` 前注入带 hash 的入口。
扩展面板通过 `/assets/extensions/<包>/<版本>/<文件>` 提供，仅允许 manifest 声明的脚本与样式文件。

`createBot()` 通过 `WebAppDeps` 注入事件库、session、运行控制、配置、存储、`consolePageSources` 和扩展信息。

## 浏览器

`features/providers` 一次编辑一条端点,改动只进浏览器暂存,保存时整条提交。模块面板挂在所选端点
的作用域里,面板的 `setConfig` 同样进暂存;`llm-settings` 的服务接口保留,旧的 `llm:<kind>` 路由
转到这一页。`features/providers/drafts.ts` 的暂存按部署分 scope 存进 localStorage,不含 API Key;
这一页自己拦切换端点,并向路由登记离开保护。端点保存、删除或设为当前之后推送状态帧,终端页顶部
的统计行显示当前端点的名称与模型,点开进该端点。

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
清单的 `sources` 记下 esbuild 读到的每个仓库内源文件的 sha256，`bin/web-assets.mjs` 据此判断产物是否落后于源码；依赖包与 Tailwind 的输入不在其中。
浏览器代码使用 `tsconfig.web.json` 检查：`pnpm typecheck:web`。

供应商卡片区分当前连接、可连接、配置问题与草稿。其他部署的运行实例选用同一连接时显示实例名并隐藏连接操作；未运行部署的选用记录单独标注。页面每五秒刷新列表，保留详情草稿。

扩展操作提供可查询的 operation ID；重启恢复使用 `/api/run/lifecycle` 的部署身份、bootId 和 ready 状态。
异步接口异常由统一请求包装返回错误，已提交的安装结果不因后续列表刷新失败而改变。
