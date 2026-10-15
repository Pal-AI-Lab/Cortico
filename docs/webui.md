<!-- Owner: src/core/language.ts, src/web/server.ts, src/web/auth.ts, src/web/diagnostics.ts, src/web/shared/webui-protocol.ts, src/web/client/main.ts, src/web/client/core/language.ts, src/web/client/features/live/onboarding.ts, src/web/client/features/settings/general.ts -->

# WebUI

每份部署运行一个 WebUI,监听 `web.host`(缺省 `127.0.0.1`,只有本机连得上)上的 `web.port`;端口被占或不可监听时顺延,
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

WebUI 不终结 TLS。经公网使用时放在终结 HTTPS 的反向代理后面,否则密码与 Cookie 明文传输;登录请求从非回环对端
经明文连接送来时记一条 warn。

## 页

框架自己的页:

| 路由 | 页 | 内容 |
|---|---|---|
| `live` | 控制台 | 与 bot 对话、时间线、主循环运行阶段、上下文圈、fork;全新部署上多一组开场引导 |
| `core` | 运行诊断 | run、session、事件、运行日志,以及 Core 自己的数据与配置 |
| `usage` | 用量与成本 | 按 session、按天的 token 与费用 |
| `providers` | 模型供应商 | 端点表(见 [providers.md](providers.md)) |
| `world` | World 总览 | World 激活、停用、重启和状态 |
| `extensions` | 扩展 | 安装、删除、npm 搜索、更新检查与安装历史版本（见 [extensions.md](extensions.md)） |
| `prompts` | 系统提示词 | 前缀各段的模板;完整前缀按已保存文件渲染 |
| `settings` / `appearance` | 设置 | 语言、外观;入口是左栏底部那颗齿轮,不占左栏的行 |

控制台页在部署目录里还挂着 `.onboarding` 标记时(自建部署写下的一次性开关,见
[deployment.md](deployment.md))多出一组开场引导:
模型端点、World、系统提示词各一条,报当前状态并给出各自的入口。末尾那颗按钮先让运行继续,再经控制台
通道投一条 `console.invite` 事件,正文只陈述谁按了按钮、按钮上写着什么、这个控制台此前有没有人说过话。
操作员开口或按下按钮时 WebUI 销掉标记(`POST /api/onboarding/dismiss`),这一组不再出现。
没有可用端点时按钮按不动。

控制台页时间线把记录上 `image/*` 的附件画成缩略图,点击在浮层里看原图;取不到字节的那张不画,正文里的
`[blob …]` 行照常显示。字节经 `GET /api/blob?handle=<句柄>` 取,按 `Core.resolveBlob` 解析:`log:` 回应可长期缓存,
`mem:` 回应 `no-store`,认不出或已不在回 404。回应带 `X-Content-Type-Options: nosniff` 与
`Content-Security-Policy: sandbox`。

左栏三组:Core(框架自己的页)、Persona & Memory(Persona 页、Memory 页、系统提示词)、World(总览与各实例)。
左栏顶上是框架字标,底部是这一台 bot 的头像与展示名(`displayName`),展示名下面写运行中或已暂停。
根 URL 不带 hash 时跳转到 `live`；未知路由不显示页面内容，侧栏仍可导航。
存储项按归属分页:Core 的在运行诊断的「数据」子页,一键清空也在那里;World、Persona 与 Memory 页
各有「数据」页签,列本页声明的项。配置组同理:Core 的在运行诊断的「配置」子页,其余在声明方自己的页。
工具表是装配好的整份,只挂在 Persona 页的「工具表」页签上。

World、Persona 与 provider 各自贡献自己的页,页 id `world:<id>` / `persona:<id>` /
`llm:<id>`;Persona 的 `webUi().memory` 子声明另成一页 `memory:<id>`,与 Persona 页共用一份
浏览器产物,标题取 bot 的 `memoryName`。Persona 页的标题取 Persona 的类名,取不到才用
bot 的展示名。面板、配置组与提示词文档由贡献方声明;
框架按声明渲染，新增 World 或 Persona 无需修改 `src/web/**`。
`tests/web/acceptance-zero-diff.test.ts` 验证此约束。

## 页面与面板契约

`WebUiPageContribution` 包含:`lamps`(模块报告的状态灯,最多显示 7 个)、
`badges`、`panels`、`links`、`config`(按 schema 渲染的配置组)、
`promptDocs`(可编辑的提示词文档,如环境提示词)、`storage`(存储清单)、`invoke`(面板的
数据接口)、`stream`(面板的推送通道)。World 通过 `World.webUi()` 声明,Persona 通过
`Persona.webUi()` 声明。面板方法只接受 POST;`getMethods` 点名的方法才接受 GET(轮询读、
`<audio src>` 这类只能带 URL 的场合)。存储项由装配层按来源盖上归属 `owner`(`core` / `persona` /
`memory` / `world:<id>`),`/api/storage` 原样回它。

面板带 `slot` 就没有自己的页签,由同页某块面板调 `ctx.mountSlot(slot, 容器, 作用域)` 挂进去,
同一插槽的多块按声明顺序排,作用域进子面板的 `ctx.scope`;返回的句柄结束这一批。`llm:*` 页的面板
不走插槽:端点编辑页按声明顺序把它们挂成段落,作用域 `instance` 是端点名(见 [providers.md](providers.md))。

自定义面板需要客户端 bundle,内建面板由框架提供。`src/worlds/<id>/webui/client.ts`(Persona 是
`bots/<名>/webui/client.ts`)默认导出 `{ panels: { <id>: { mount(ctx) } } }`,
`pnpm build:web` 自动发现并打包;扩展包自己 build,manifest 里声明产物路径。

面板通过 `ctx`(`src/web/shared/client-panel.ts`)访问宿主:`invoke` /
`invokeBinary` 调用本面板的数据接口,`stream` 订阅推送。通过 `interval` / `timeout` / `frame` / `own`
登记的资源在卸载时释放;`memo` 按页面和面板隔离本地状态,`guardLeave` 检查是否允许离开,
`pickPath` 打开本机路径选择器,`setConfig` 写配置组,`mountSlot` 挂本页声明到某插槽的面板,
`ui` 提供界面组件(`sheet`、`table`、
`log`、`toast`、`confirm`、`drawer`、`lightbox`、`promptInput`…)。面板不碰 `document.body`,不直连
`/api/`,不用裸定时器。

## HTTP API 的公开范围

下游产品的前端由下游自己维护，只经下表的公开路由读写 Core 的状态。公开路由的破坏性变更(删除路由、改方法或路径、
删除或改名请求参数与体字段、新增必填参数、删除回应字段或改变已有字段的含义)按提交规则带 `!` 与 `BREAKING CHANGE:` 脚注，写明迁移办法。

| 路由 | 内容 |
|---|---|
| `GET /api/capabilities` | 框架级表面的挂载情况 |
| `GET /api/status` | 运行状态快照与 `uptimeSec` |
| `GET /api/config`、`POST /api/config` | 配置组;POST 体 `{ group, values }`,按 schema 校验 |
| `GET /api/config/options/:kind` | schema 里 `x-options` 为 `kind` 的配置项的当前候选值 |
| `GET /api/blob?handle=` | 附件字节 |
| `GET /api/worlds`、`POST /api/worlds/activation` | World 清单;激活或停用,体 `{ id, enabled }` |
| `POST /api/storage/clear?key=` | 清除一个存储部分;`key` 取自各页 manifest 的 `storageKeys`,Core 自己的对话历史是 `session` |
| `GET /api/theme`、`POST /api/theme` | 部署的配色;GET 回 `{ defaultScheme, theme }`,POST 体是 `StoredTheme`(`src/web/shared/theme.ts`),回 `{ ok, theme }` |
| `GET /api/avatar`、`POST /api/avatar` | bot 头像 PNG,没有时 404;POST 体是 `image/png` 原始字节，不是 PNG 时回 400 |
| `GET /api/usage` | 用量聚合;查询参数 `bucket`(`auto`/`minute`/`hour`/`day`/`week`/`month`)、`currency`、`basis`(`marginal`/`equivalent`)、`from`、`to`、`days`(不小于 1 的整数) |
| `POST /api/run/pause`、`POST /api/run/resume`、`POST /api/run/shutdown` | 暂停、继续与关机，见「运行控制」 |
| `GET /api/prompts`、`POST /api/prompts` | 固定提示词的列表与编辑;POST 体 `{ key, content, baseRevision? }`,带上的 `baseRevision` 过期时回 409 并带 `conflict: true`,成功回新的 `revision` |
| `GET /api/prompts/prefix`、`POST /api/prompts/reset`、`POST /api/session/reload-prefix` | 整条系统前缀的分段预览，回 `{ segments: [{ title, text, sourceKey? }] }`;移除一条固定提示词的部署覆盖，体 `{ key }`,回 `{ ok, result }`;用当前提示词重载当前 session 的系统前缀，对话保留，回 `{ ok, result }`。服务没挂时回 503 |
| `GET /api/auth/status`、`POST /api/auth/login`、`POST /api/auth/logout` | 部署设了访问密码时的登录与登出;登录态在 Cookie 里，未登录的请求回 401 并带 `x-cortico-auth: required` 头，WebSocket 握手直接断开 |
| `GET /api/providers`、`GET /api/providers/:name`、`POST /api/providers`、`POST /api/providers/:name/save`、`POST /api/providers/:name/activate`、`POST /api/providers/:name/test` | 模型端点：列出、详情、新建、保存(体带 `expectedRevision`)、设为当前端点、测试连通;没挂 provider 时 503 |
| `GET /api/webui/manifest` | 每页一条 `WebUiPageManifest`,以及框架级能力;形状见 `webui-protocol.ts` |
| `GET`/`POST /api/webui/providers/<page>/panels/<panel>/<method>`、WebSocket `/ws/providers/<page>/panels/<panel>` | 面板契约：路径两段都 `encodeURIComponent`(page id 的冒号写作 `%3A`);POST 体 `{ args: [...] }`,GET 只对 `getMethods` 点名的方法开放，参数放在查询串 `args`(JSON 数组);WebSocket 是该面板的推送通道 |

请求带 `x-cortico-language` 头(WebSocket 握手用查询串 `language`)时，回应里的文案按该语言给出。其余路由都是内部路由，包括框架更新提示用的
`GET /api/framework/release` 和左栏状态灯的轮询 `GET /api/webui/lamps`。

WebUI 网页本身(页面、DOM、类名与 `src/web/client/` 下的模块)是随 Cortico 发布、给开发者用的入口，
对下游不作承诺。下游可以复制其中的组件起步，复制后由下游维护。

## 框架更新提示

打开 WebUI 时查询 GitHub 上 Cortico 的最新正式 Release。它的版本高于 `package.json` 的版本时，
左上角字标下出现一行提示，链接到发布说明；版本相同、更低或查询失败时不显示。只提示，不下载也不重启。
`pnpm start` 启动 bot 时也查一次，有新版本就在命令行的启动摘要里打一行 `⚠ Cortico <版本> 已发布`,带同一个链接。

## 运行控制

| 端点 | 行为 |
|---|---|
| `POST /api/run/pause` | 暂停:事件照常落库排队,不投递唤醒 |
| `POST /api/run/resume` | 继续:积压一次性投递 |
| `POST /api/run/shutdown` | 分步关机，完成后返回各步骤的结果 |
| `POST /api/run/restart` | 写入 `data/.restart-request` 后关机；由启动器监管时（`CORTICO_SUPERVISED`）自动重新启动 |

## 诊断包

`GET /api/diagnostics`(控制台页的「导出诊断」)把排查一场跑要看的记录收进一个
JSON:运行指纹(`runs/index.jsonl` 的这一行与 `run.json`)、状态快照、常驻 session 的上下文与
合成开头、session 列表、工具表、最近事件、运行日志(warn 及以上与不分级别的尾部各一段)、
工具调用、transcript 里的交接记号、用量聚合与本 run 的用量行、当前端点(`endpoint`:端点名、Provider 模块与
`spec` 里填了的 `model`、`thinking`、`reasoningEffort`、`temperature`、`maxTokens`、`contextWindow`)、`config.json`。每段各有条数
上限(`DIAGNOSTICS_TAIL`),取到上限的段名列在 `truncated` 里;键名含 secret / token / key /
password 的配置值写出前抹成 `***`;`endpoint` 段不经这一步,否则 `maxTokens` 会被抹掉。未挂载的接缝那一段为空。

## 语言

界面语言由浏览器选择,可选值是 `src/core/language.ts` 的 `LANGUAGES`:`zh`(简体中文)、`zh-Hant`、
`en`、`ja`、`ko`、`fr`、`de`、`es-419`、`pt-BR`、`it`、`ru`。默认值在进程启动时读取:
`config.json` 的 `language` > `CORTICO_LANGUAGE` > 系统区域(`zh-Hant` 及 TW、HK、MO 地区归 `zh-Hant`,
其他中文归 `zh`,西班牙语归 `es-419`,葡萄牙语归 `pt-BR`,列表外的语言归 `en`;区域不可用时回退到 `zh`),
写进 `<html lang>`(`zh` 写作 `zh-CN`)。设置 → 通用里的选择存在当前浏览器里,刷新页面生效,不重启 bot。

之后每个请求自带语言(HTTP 头 `x-cortico-language`,WebSocket 握手查询串 `language`),服务端给
WebUI 的文案都按它现取:`World.webUi(language)`、`Persona.webUi(language)`、provider 的配置组、
回执、校验报错、关机结果。面板通过 `ctx.language` 读取相同值。

文案用 `pick(language, table)` 选取。表必须有 `zh` 和 `en`,其余语言可缺;缺的语言 `zh-Hant` 读 `zh`,
其余读 `en`。值为普通对象时,某语言的译文可以只给部分顶层键,缺的键取回退语言的值。译文放在 `strings.ts`
旁的 `strings.<语言代码>.ts`,`strings.ts` 导出的每张表(`S`、`text`、`panel` 等)在译文文件里各有一个
同名导出,类型是该表英文版的 `Partial`(`strings.ts` 导出 `en`、`panelEn` 等,译文文件用 `import type`
取类型),由 `strings.ts` 导入并放进传给 `pick` 的表。

界面语言不改变模型输入。World 的环境提示词模板、工具回执和事件正文使用其实现指定的语言,
Persona 的文本使用作者选择的语言。

中文界面里 Core、Persona、Memory、World 是专名,不翻译。

## 开发

`pnpm dev:webui` 用假数据起一个 webUi(端口 8848,`CORTICO_DEV_MINIMAL=1` 只挂控制台 World),
不连任何真实平台。改了 `src/web/client/`、`src/web/shared/` 或任何 `webui/client.ts` 都要
`pnpm build:web`;bot 运行期间禁止覆盖其正在使用的 WebUI 产物。内部结构见
[src/web/README.md](../src/web/README.md)。
