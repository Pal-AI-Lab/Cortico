<!-- Owner: src/extensions.ts, src/extensions/manifest.ts, src/extensions/market.ts -->

# 扩展

扩展是一个 npm 包,给一份部署补一个 World、一个 provider 或一个 bot。仓库内建的 World 与
provider 仅包含参考 bot 所需的实现;其他平台或模型通信协议通过扩展提供。

## 安装

扩展目录默认是检出根下的 `extensions/`;设了环境变量 `CORTICO_EXTENSIONS_DIR` 就是它指的目录,本页说的
`extensions/` 都换成那里,程序装在只读位置时(比如 macOS 的 `.app`)由应用这样设。

安装会向 `extensions/package.json` 添加依赖,重启进程后加载。支持以下方式:

- WebUI「扩展」页(路由 `extensions/<kind>`):从 npm 上带 `cortico-world` / `cortico-provider` /
  `cortico-bot` 关键字的包里装,或手动填 npm 包名(可带 `@` 精确版本或 dist-tag)、选本机目录。
  本机目录以 link 方式装入,改源码后重启生效。
- WebUI 安装前先调 `POST /api/extensions/check`:只读 manifest(本机目录读 package.json,npm 包读包文档),
  类别与所选类别不符、声明不合格时拒绝,不导入包代码。
- 命令行,在仓库根下:

```bash
cd extensions && corepack pnpm add --ignore-workspace <包名或目录>
```

`--ignore-workspace` 不能省:少了它 pnpm 会把 `extensions/` 当成仓库工作区的一员写进根
lockfile。

`/api/extensions` 也列出随框架提供的 World 与供应商(`builtin`),它们不能删除。`enabled` 表示在本进程生效:
World 已挂载,供应商已注册,bot 包是这份部署在用的那个。本进程正在使用的 World 与 bot 包不能删除,
World 先在 World 页停用。
清单还回 `platform`(服务端的 `process.platform`),包详情回 package.json 的 `os`:市场按 `os` 标出平台,本机不在其中时禁用安装并写明原因。
`extensions/` 整个目录不进版本控制,是部署状态。

## 更新

扩展更新检查在页面打开及清单刷新时执行。发现新版时显示磁盘版本与 `latest` 版本；
更新会向 `extensions/` 执行 `pnpm add`，重启进程后加载新版，不需要先卸载。
详情的历史版本可安装 registry 中仍存在的任一版本，经 check 后 `pnpm add name@version`，重启后生效；配置与 Memory 不随包回退。
包文档里每个历史版本按自己的 manifest 判断契约兼容(`history[].problems`),不兼容的版本不能装,原因写在那一行。
契约不兼容的新版不能更新。
`link:` 本机扩展不查 npm；registry 查询失败的包显示错误，不算已是最新。连接失败和读正文时断线的错误里都带出错的主机和底层错误码
(例如证书不符时的 `ERR_TLS_CERT_ALTNAME_INVALID`)。
搜索、详情和检查更新用安装时的 registry:在 `extensions/` 里跑 `pnpm config get registry --ignore-workspace`,
读 `extensions/` 与用户的 .npmrc、`pnpm_config_registry`,不读外层工作区的配置。结果在进程内缓存,在扩展页以外改了配置要重启进程;
pnpm 读不出地址时这三处都报 pnpm 的错误。
扩展页的「npm 源」读写 `extensions/.npmrc` 的 `registry=` 行,其余行原样保留,填空保存删掉这一行;写入后缓存作废,
检查更新、搜索、详情和 `pnpm add` 立即改用新源。接口是内部路由 `GET /api/extensions/registry`
(回 `configured`,即 .npmrc 里的值或 null,以及 pnpm 实际用的 `registry`,读不出时换成 `registryError`)与
`POST /api/extensions/registry`(体 `{ registry }`,只收 http(s) 地址,回应同 GET)。
搜索按 `keywords:<类关键字>` 查;这条查询一个包都没回时，再按类关键字本身做文本搜索(有的 registry 不认 `keywords:`,对它回空列表),
结果都只留带这个关键字的包。市场为空时提示写出所用的 registry。
搜索结果的下载量另问 npm 下载统计 `api.npmjs.org`,不随 registry 配置变:近 30 天、近 7 天,
以及按 365 天一段往前累加的累计,某段为 0 即停,所以中间有整年无下载的包少计更早的下载。
单次请求 3 秒没回就缺那一项,卡片显示「—」;近 30 天缺时用搜索端点给的月数。
磁盘版本与本进程加载版本不同，即使依赖范围没变，扩展仍标为「待重启」。

## 市场的官方索引

扩展页的标签、徽标(认证、官方、新品)、喜欢 / 不喜欢与评论来自官方索引仓
[Pal-AI-Lab/cortico-extensions](https://github.com/Pal-AI-Lab/cortico-extensions),文件格式以那里的 DESIGN.md 为准。
`src/extensions/market.ts` 经 raw.githubusercontent.com 读 `index.json` 与 `catalog.json`,读到的内容在内存里留 5 分钟
(raw 的 CDN 缓存也是 5 分钟),单次 3 秒没回算读不到。`GET /api/extensions/search` 的回应多一个 `index`
(按界面语言取好的标签词表与 `newDays`),每条结果按索引补字段:

- 拉黑的包与拉黑的发布者发的包不出现在结果里;已装的照常列出,`/api/extensions` 里那一条带 `blocked`(原因)。
- `tags`:`catalog.json` 里作者当前版本声明的(官方标注除外)、`keywords` 里的普通标签、粘住名单里的警示标签与官方
  `addTags`,去掉官方 `removeTags`。
- `official`:npm 维护者里有 `official.maintainers` 的账号,且 repository 在 `official.githubOwners` 名下。`certified` 来自
  `certified`;`isNew` 按 `catalog.json` 的首次发布时间与 `newDays`;`note`、`supersededBy` 来自官方覆盖;`rating` 来自
  `catalog.json`。
- `schema` 不是 1 的文件当作读不到。`index.json` 每次读到都写进扩展目录的 `market-index.json`,读不到时用它,拉黑照常生效;
  它也没有时 `index` 只有 `error`,结果原样返回。`catalog.json` 读不到时结果不带它补的字段。

包的简介按 Markdown 子集渲染:段落、标题、列表、代码、粗体、斜体与 http(s) 链接,原始 HTML 当文字。

### GitHub 登录、投票与评论

投票与评论由服务端用 GitHub App「Cortico Extension Market」的用户令牌代用户调 GraphQL;这个 App 只有 Discussions 读写权限,
只装在索引仓。以下都是内部路由:

| 路由 | 请求 | 回应 |
|---|---|---|
| `GET /api/extensions/github` | | `{ login?, avatar? }` |
| `POST /api/extensions/github/login` | | `{ userCode, verificationUri, expiresIn, interval }`;服务端在后台等授权,登上后上一行有账号 |
| `POST /api/extensions/github/logout` | | `{ ok: true }` |
| `POST /api/extensions/vote` | `{ name, vote: "up" \| "down" \| null }` | `{ up, down, comments, discussion?, mine? }`,投完后的实时数 |
| `GET /api/extensions/comments?name=&cursor=` | | `{ comments: [{ id, author, avatar?, body, createdAt, replies? }], total, next?, discussion? }` |
| `POST /api/extensions/comments` | `{ name, body, replyTo? }` | 新发的那条评论 |

- 令牌存在扩展目录的 `github-token.json`(`.gitignore` 单列了这个文件名),不过期。退出只删这个文件,GitHub 上的授权由用户在
  GitHub 设置里撤销。
- 要账号的接口没登录时回 428;令牌被撤销时删掉令牌文件,同样回 428。WebUI 先弹设备码登录,登上后重发一次。
- 每个包一帖,帖子只由索引仓的 Action 在 extensions 分类(Announcement 格式)里开,标题是包名;还没开帖的包投票与发评论回 409。
- 改票先撤掉本账号的另一种 reaction 再加上新的。评论数含前 100 条顶层评论下的回复(GraphQL 一页的上限)。
- 评论一页 5 条,新的在前,`replyTo` 是顶层评论的 id。登录了实时读,管理员隐藏的不列;没登录读 Action 写的
  `comments/<包名>.json` 快照(作用域包名的 `/` 换成 `__`),比实时晚一个扫描周期;包还没有帖子时是空页。

## 起步

`templates/extension/` 为三种 kind 各提供一个可安装的模板,测试会验证构造和声明接口。
复制一份出来,改包名与 id,`corepack pnpm install`,`pnpm test`。每个模板的 README 说它验证什么、
装进实例后该看见什么。
扩展开发相关项目:[Cortina](https://github.com/Pal-AI-Lab/Cortina)。

## 写一个 World 扩展

`package.json`:

```jsonc
{
  "name": "cortico-world-discord",
  "type": "module",
  "main": "./src/index.ts",
  "keywords": ["cortico-world"],
  "cortico": { "kind": "world", "api": 6, "displayName": "Discord", "icon": "assets/icon.png", "webUiClient": "dist/webui.js", "webUiStyle": "dist/webui.css" }
}
```

`displayName` 可选,是 WebUI 里的扩展名称,读它不需要导入包代码;空串或非字符串时给出 warning 并忽略,
包照常加载。

`icon` 可选,是包内相对路径,指向 png、webp 或 svg。WebUI 卡片的头像取它,经
`GET /api/extensions/icon?name=<包名>` 提供;没声明或文件不在时显示淡色 Cortico 标志。
npm 市场里还没装的包都是默认头像。bot 包的 png 图标
在 `pnpm start --new` 新建部署时复制成部署的 `avatar.png`,之后头像以部署里的那份为准。路径不合格时给出
warning 并忽略。

入口默认导出一个 `WorldDefinition`(契约见 [worlds.md](worlds.md)):

```ts
import type { WorldDefinition } from 'cortico/world.ts';
export default { id: 'discord', label: 'Discord', defaults: () => ({ ... }), create: (ctx) => new DiscordWorld(ctx) } satisfies WorldDefinition<DiscordSection>;
```

框架以 `cortico/<src 下的路径>` import:`cortico/world.ts`、`cortico/core/types.ts`、
`cortico/core/util.ts`。运行时由 `src/extensions/runtime.ts` 的模块钩子解析到框架源码本身,
早于 `node_modules`;开发期装 `cortico` 这个开发依赖,编辑器、`tsc` 与 vitest 按包的 `exports`
解析同一批文件。`"type": "module"` 是硬要求。

```bash
corepack pnpm add -D cortico
```

npm 上的 `cortico` 装下来就是框架的 `src/`,没有入口,启动不了 bot。它的版本跟着框架走;
按你写扩展时的版本钉住范围。仓库根的 `pnpm publish:package` 生成它。

WebUI 面板可选。自定义面板的 `src/webui/client.ts` 默认导出 `{ panels: { <id>: { mount(ctx) } } }`,
用 esbuild 打成 `dist/webui.js`(+ `.css`),路径写进 manifest;浏览器侧对 `cortico/*` 只能
`import type`。面板契约在 `src/web/shared/client-panel.ts`。

配置段归 World 包:`worlds.<id>` 的形状由 `defaults()` 定。bot 通过 `declares` 声明默认启用的 World,
也可提供 World 配置覆盖;部署 `config.json` 的同名段优先于包默认值。

## 写一个 provider 扩展

`"kind": "provider"`,关键字 `cortico-provider`,默认导出 `ProviderModule`(见
[providers.md](providers.md))。WebUI 页 id 是 `llm:<id>`,面板与 World 扩展同一套契约。

模块自己的旋钮走 `config(name, entry, language)`:owner 是 `provider:<id>`,路径一律在
`providers.<端点名>.options.` 下。端点条目里 `options` 之外的字段——`baseUrl`、`secret`、
`multimodal` 与 `spec`——由框架自己编辑,模块不声明它们。

面板在 `webUi(host)` 里声明。`llm:<id>` 这一页在 WebUI 里没有自己的入口(左栏不列 `kind: 'llm'`
的页,`#/provider/llm:*` 会被换成 `#/providers`),模块面板只在端点编辑页露面,排法见
[providers.md](providers.md) 的「WebUI」一节;`ctx.scope.instance` 是端点名。

端点编辑是事务化的:改动随手暂存在浏览器,保存时整条写入,面板经 `ctx.setConfig` 改的配置也只进暂存。
`ctx.invoke` 把浏览器手上这份条目一起交给服务端,与磁盘上的一致就用真实例、`host.editing` 为假,
不一致就按这份草稿临时构造一个预览实例、`host.editing` 为真,`host.save` 写回的是草稿而不是磁盘。
托管进程的启停、下载安装这类运行时动作要求端点已保存,模块在 `editing` 为真时拒绝它们。

## 写一个 bot 扩展

`"kind": "bot"`,关键字 `cortico-bot`,默认导出 `BotDefinition`(见 [personas.md](personas.md)):
接口与仓内 `bots/<名>/` 相同,安装在 `extensions/` 下。入口可以直接使用 TS 源码
(`"main": "./index.ts"`),框架经 tsx 跑它。

在部署的 `deployment.json` 中将 `bot` 设为包名即可引用。存在同名 `bots/<名>/` 时优先使用仓内版本。
一个进程只跑一个 bot,所以装了好几个 bot 包也只 import 被引用的那一个,其余在扩展页上标
「已装,本部署未用」。bot 的 `id` 不得与仓内 `bots/` 任一目录同名:WebUI 面板产物按
`persona:<id>` 找,撞名会拿到仓内那份。

`memoryName` 是 Memory 页的标题;缺省回落到 `persona.memory` 的类名,`check:extension` 对缺名的包给警告。

包目录只读。`promptDocs` 里没给 `deploymentPath` 的模板在 WebUI 里能看不能存;要让部署者改,
在声明里给出部署侧的覆盖路径(通常在 `loaded.rootDir` 下)。bot 要挂的 World 若也是扩展,
在 `declares` 里声明 id 即可,没装时是灰卡。

## 校验

```bash
pnpm check:extension <包目录>
```

检查会读取 manifest、导入入口、按 kind 核对默认导出结构并确认面板产物存在,随后验证构造与声明接口:
World 在假部署(默认配置、无密钥)下调用 `create()`、`tools()`、`envPromptVars()`、
`webUi(language)`,检查工具名与 Core 保留名及内建 World 的冲突;provider 按假端点调用
`create()`;bot 按假部署调用 `build()`。检查不调用 `start()`,不验证真实服务运行。输出只有英文。
装配层会为未启用的 World 创建实例,因此所有 World 都必须能以默认配置构造。

配置组声明的每个路径都要落在自己的段内,否则是失败。World 是 `worlds.<id>.`,并且要在
`defaults()` 里有对应项——缺默认值时 WebUI 照样渲染旋钮、照样写回 config.json,而读到的是代码里
另一处的兜底值。

provider 是 `providers.<端点名>.options.`。写回的三道闸(服务端的端点保存、WebUI 草稿、
模块配置写入)都只认 `providers.<端点名>.` 前缀:段外的路径渲染得出旋钮、一改就报越界;
段内 `options` 之外的路径三道都放行,值直接盖掉框架自己编辑的 `baseUrl`、`secret`、`multimodal`
与 `spec`。这些值存在端点条目里,不经 `defaults()`,因此只核对段。

## 契约版本

三类扩展各有一个契约版本,`cortico.api` 必须等于自己这一类的那个:world **6**、provider **6**、
bot **7**。版本不符的扩展不能加载,页面显示「需要升级」。

加一的判据按类分:`WorldDefinition` 不兼容变更只加 world,`ProviderModule` 只加 provider,
`BotDefinition`(连同 `BotParts`、`Persona`、`LoadedConfig`)只加 bot;`WebUiPanelContext`
与其余共用接口变更时三类一起加。同一次发布里的多处变更合计加一。扩展 API 与 WebUI 协议分别版本化。

## 已有扩展

- `cortico-world-vtuber`:Live2D VTuber 演出(VTube Studio、流式 TTS、强制对齐、字幕 overlay)。
- `cortico-world-asr`:麦克风语音识别(RtAudio 采集、能量门限切分、FireRedASR2-AED 后端)。
- `cortico-provider-grok`:xAI Grok 端点与设备码授权。

这些包独立于本仓库发布。声卡原生模块、Python 推理环境、VTS 等运行时依赖由相应扩展说明。
