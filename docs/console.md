<!-- Owner: src/web/server.ts, src/web/shared/console-protocol.ts, src/web/client/main.ts, src/web/client/core/language.ts, src/web/client/features/live/onboarding.ts, src/web/client/features/settings/general.ts -->

# 控制台

每份部署运行一个本机 Web 控制台:`http://127.0.0.1:<web.port>/`,端口被占时顺延,含配置端口最多尝试五个端口。
服务仅绑定 `127.0.0.1`;Host 头不是回环名或绑定地址的请求回 421,带跨站 Origin 的写请求与 WebSocket
升级被拒。显式绑到 `0.0.0.0` 时不校验 Host。

## 页

框架自己的页:

| 路由 | 页 | 内容 |
|---|---|---|
| `live` | 终端 | 与 bot 对话、时间线、上下文圈、fork;全新部署上多一组开场引导 |
| `core` | 运行诊断 | run、session、事件、运行日志,以及 Core 自己的数据与配置 |
| `usage` | 用量与成本 | 按 session、按天的 token 与费用 |
| `provider` | 语言模型 | 端点表(见 [providers.md](providers.md)) |
| `world` | World 总览 | World 激活、停用、重启和状态 |
| `extensions` | 扩展 | 安装、卸载与 npm 搜索（见 [extensions.md](extensions.md)） |
| `prompts` | 系统提示词 | 前缀各段的模板 |
| `settings` / `appearance` | 设置 | 语言、外观;入口是左栏底部那颗齿轮,不占左栏的行 |

终端页在这份部署什么都还没发生时(session 没有记录、事件库没有分配过游标)多出一组开场引导:
模型端点、World、系统提示词各一条,报当前状态并给出各自的入口。末尾那颗按钮先让运行继续,再经终端
通道投一条 `terminal.invite` 事件,正文只陈述谁按了按钮、按钮上写着什么、这个终端此前有没有人说过话。
第一条记录落进 session 后这一组不再出现。没有可用端点时按钮按不动。

左栏三组:Core(框架自己的页)、Persona & Memory(Persona 页、Memory 页、系统提示词)、World(总览与各实例)。
左栏顶上是框架字标,底部是这一台 bot 的头像与展示名(`displayName`)。
根 URL 不带 hash 时跳转到 `live`；未知路由不显示页面内容，侧栏仍可导航。
存储项按归属分页:Core 的在运行诊断的「数据」子页,一键清空也在那里;World、Persona 与 Memory 页
各有「数据」页签,列本页声明的项。配置组同理:Core 的在运行诊断的「配置」子页,其余在声明方自己的页。
工具表是装配好的整份,只挂在 Persona 页的「工具表」页签上。

World、Persona 与 provider 各自贡献自己的页,页 id `world:<id>` / `persona:<id>` /
`llm:<id>`;Persona 的 `console().memory` 子声明另成一页 `memory:<id>`,与 Persona 页共用一份
浏览器产物,标题取 bot 的 `memoryName`。Persona 页的标题取 Persona 的类名,取不到才用
bot 的展示名。面板、配置组与提示词文档由贡献方声明;
框架按声明渲染，新增 World 或 Persona 无需修改 `src/web/**`。
`tests/web/acceptance-zero-diff.test.ts` 验证此约束。

## 页面与面板契约

`ConsolePageContribution` 包含:`lamps`(模块报告的状态灯,最多显示 7 个)、
`badges`、`panels`、`links`、`config`(按 schema 渲染的配置组)、
`promptDocs`(可编辑的提示词文档,如环境提示词)、`storage`(存储清单)、`invoke`(面板的
数据接口)、`stream`(面板的推送通道)。World 通过 `World.console()` 声明,Persona 通过
`Persona.console()` 声明。面板方法只接受 POST;`getMethods` 点名的方法才接受 GET(轮询读、
`<audio src>` 这类只能带 URL 的场合)。存储项由装配层按来源盖上归属 `owner`(`core` / `persona` /
`memory` / `world:<id>`),`/api/storage` 原样回它。

自定义面板需要客户端 bundle,内建面板由框架提供。`src/worlds/<id>/console/client.ts`(Persona 是
`bots/<名>/console/client.ts`)默认导出 `{ panels: { <id>: { mount(ctx) } } }`,
`pnpm build:web` 自动发现并打包;扩展包自己 build,manifest 里声明产物路径。

面板通过 `ctx`(`src/web/shared/client-panel.ts`)访问宿主:`invoke` /
`invokeBinary` 调用本面板的数据接口,`stream` 订阅推送。通过 `interval` / `timeout` / `frame` / `own`
登记的资源在卸载时释放;`memo` 按页面和面板隔离本地状态,`guardLeave` 检查是否允许离开,
`pickPath` 打开本机路径选择器,`setConfig` 写配置组,`ui` 提供界面组件(`sheet`、`table`、
`log`、`toast`、`confirm`、`drawer`、`promptInput`…)。面板不碰 `document.body`,不直连
`/api/`,不用裸定时器。

## 运行控制

| 端点 | 行为 |
|---|---|
| `POST /api/run/pause` | 暂停:事件照常落库排队,不投递唤醒 |
| `POST /api/run/resume` | 继续:积压一次性投递 |
| `POST /api/run/shutdown` | 分步关机，完成后返回各步骤的结果 |
| `POST /api/run/restart` | 写入 `data/.restart-request` 后关机；由启动器监管时（`CORTICO_SUPERVISED`）自动重新启动 |

## 语言

界面语言由浏览器选择,支持 `zh` / `en`。默认值在进程启动时读取:`config.json` 的 `language` >
`CORTICO_LANGUAGE` > 系统区域(中文区域使用中文,其他区域使用英文;区域不可用时回退到中文),写进 `<html lang>`。设置 → 通用的「简体中文 /
English」把选择存在当前浏览器里,刷新页面生效,不重启 bot。

之后每个请求自带语言(HTTP 头 `x-cortico-language`,WebSocket 握手查询串 `language`),服务端给
控制台的文案都按它现取:`World.console(language)`、`Persona.console(language)`、provider 的配置组、
回执、校验报错、关机结果。面板通过 `ctx.language` 读取相同值。模块自行提供语言版本,
未提供所选语言时回退到中文。

界面语言不改变模型输入。World 的环境提示词模板、工具回执和事件正文使用其实现指定的语言,
Persona 的文本使用作者选择的语言。

中文界面里 Core、Persona、Memory、World 是专名,不翻译。

## 开发

`pnpm dev:console` 用假数据起一个控制台(端口 8848,`CORTICO_DEV_MINIMAL=1` 只挂终端 World),
不连任何真实平台。改了 `src/web/client/`、`src/web/shared/` 或任何 `console/client.ts` 都要
`pnpm build:web`;bot 运行期间禁止覆盖其正在使用的控制台产物。内部结构见
[src/web/README.md](../src/web/README.md)。
