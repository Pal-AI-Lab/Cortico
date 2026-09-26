<!-- Owner: src/web/server.ts, src/web/auth.ts, src/web/diagnostics.ts, src/web/shared/console-protocol.ts, src/web/client/main.ts, src/web/client/core/language.ts, src/web/client/features/live/onboarding.ts, src/web/client/features/settings/general.ts -->

# 控制台

每份部署运行一个 Web 控制台,监听 `web.host`(缺省 `127.0.0.1`,只有本机连得上)上的 `web.port`;端口被占或不可监听时顺延,
含配置端口最多尝试五个端口。`--host=` 与 `--port=` 覆盖本次运行。启动器打印本机打得开的地址:监听 `0.0.0.0` 或 `::`
时给 `http://127.0.0.1:<端口>/`,IPv6 地址加方括号。Host 头不是回环名、
监听地址或 `web.allowedHosts` 里的名字的请求回 421,带跨站 Origin 的写请求与 WebSocket 升级被拒;
`web.allowedHosts` 里的名字作 Origin 时算本站,反向代理改写 Host 时靠它放行。监听 `0.0.0.0` 或 `::`
时不校验 Host。监听非回环地址而没有设访问密码时,启动记一条 warn。

## 访问密码

`web.password` 或密钥 `CORTICO_WEB_PASSWORD`(进程环境或 `<部署>/.env`,非空时优先)为空时不要求登录。设了之后,
未登录访问 `/` 得到登录页,其余路径回 401 并带 `x-cortico-auth` 头,WebSocket 升级被断开;这道检查排在
各路由的 body 解析之前。`POST /api/auth/login` 校验密码并发 `cortico_session` Cookie(HttpOnly、
SameSite=Strict、Max-Age 取浏览器上限 400 天;请求经 HTTPS 或反向代理报告 `X-Forwarded-Proto: https` 时带 Secure),
`POST /api/auth/logout` 清掉它,`GET /api/auth/status` 报告是否要求登录与当前是否已登录。设置页在设了密码时
多一颗「退出登录」。

令牌是由密码与 `data/web-auth.key` 里的随机盐导出的 HMAC,自身不设到期:进程重启后登录态仍在,有效到改密码
或退出登录为止。密码在启动时读一次,改了之后重启生效,旧登录态随之全部失效。错误的登录串行处理,每次等 1 秒才回应;正确的密码不排队。

控制台不终结 TLS。经公网使用时放在终结 HTTPS 的反向代理后面,否则密码与 Cookie 明文传输;登录请求从非回环对端
经明文连接送来时记一条 warn。

## 页

框架自己的页:

| 路由 | 页 | 内容 |
|---|---|---|
| `live` | 终端 | 与 bot 对话、时间线、上下文圈、fork;全新部署上多一组开场引导 |
| `core` | 运行诊断 | run、session、事件、运行日志,以及 Core 自己的数据与配置 |
| `usage` | 用量与成本 | 按 session、按天的 token 与费用 |
| `providers` | 模型供应商 | 端点表(见 [providers.md](providers.md)) |
| `world` | World 总览 | World 激活、停用、重启和状态 |
| `extensions` | 扩展 | 按 World / 供应商 / Bot 模板分页签:已安装、扩展市场、手动安装与更新检查（见 [extensions.md](extensions.md)） |
| `prompts` | 系统提示词 | 前缀各段的模板 |
| `settings` / `appearance` | 设置 | 语言、外观;入口是左栏底部那颗齿轮,不占左栏的行 |

终端页在部署目录里还挂着 `.onboarding` 标记时(自建部署写下的一次性开关,见
[deployment.md](deployment.md))多出一组开场引导:
模型端点、World、系统提示词各一条,报当前状态并给出各自的入口。末尾那颗按钮先让运行继续,再经终端
通道投一条 `terminal.invite` 事件,正文只陈述谁按了按钮、按钮上写着什么、这个终端此前有没有人说过话。
操作员开口或按下按钮时控制台销掉标记(`POST /api/onboarding/dismiss`),这一组不再出现。
没有可用端点时按钮按不动。

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

面板带 `slot` 就没有自己的页签,由同页某块面板调 `ctx.mountSlot(slot, 容器, 作用域)` 挂进去,
同一插槽的多块按声明顺序排,作用域进子面板的 `ctx.scope`;返回的句柄结束这一批。`llm:*` 页的面板
不走插槽:端点编辑页按声明顺序把它们挂成段落,作用域 `instance` 是端点名(见 [providers.md](providers.md))。

自定义面板需要客户端 bundle,内建面板由框架提供。`src/worlds/<id>/console/client.ts`(Persona 是
`bots/<名>/console/client.ts`)默认导出 `{ panels: { <id>: { mount(ctx) } } }`,
`pnpm build:web` 自动发现并打包;扩展包自己 build,manifest 里声明产物路径。

面板通过 `ctx`(`src/web/shared/client-panel.ts`)访问宿主:`invoke` /
`invokeBinary` 调用本面板的数据接口,`stream` 订阅推送。通过 `interval` / `timeout` / `frame` / `own`
登记的资源在卸载时释放;`memo` 按页面和面板隔离本地状态,`guardLeave` 检查是否允许离开,
`pickPath` 打开本机路径选择器,`setConfig` 写配置组,`mountSlot` 挂本页声明到某插槽的面板,
`ui` 提供界面组件(`sheet`、`table`、
`log`、`toast`、`confirm`、`drawer`、`promptInput`…)。面板不碰 `document.body`,不直连
`/api/`,不用裸定时器。

## 框架更新提示

打开控制台时查询 GitHub 上 Cortico 的最新正式 Release。它的版本高于 `package.json` 的版本时，
左上角字标下出现一行提示，链接到发布说明；版本相同、更低或查询失败时不显示。只提示，不下载也不重启。

## 运行控制

| 端点 | 行为 |
|---|---|
| `POST /api/run/pause` | 暂停:事件照常落库排队,不投递唤醒 |
| `POST /api/run/resume` | 继续:积压一次性投递 |
| `POST /api/run/shutdown` | 分步关机，完成后返回各步骤的结果 |
| `POST /api/run/restart` | 写入 `data/.restart-request` 后关机；由启动器监管时（`CORTICO_SUPERVISED`）自动重新启动 |

## 诊断包

`GET /api/diagnostics`(终端页的「导出诊断」)把排查一场跑要看的记录收进一个
JSON:运行指纹(`runs/index.jsonl` 的这一行与 `run.json`)、状态快照、常驻 session 的上下文与
合成开头、session 列表、工具表、最近事件、运行日志(warn 及以上与不分级别的尾部各一段)、
工具调用、transcript 里的交接记号、用量聚合与本 run 的用量行、`config.json`。每段各有条数
上限(`DIAGNOSTICS_TAIL`),取到上限的段名列在 `truncated` 里;键名含 secret / token / key /
password 的配置值写出前抹成 `***`。未挂载的接缝那一段为空。

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
