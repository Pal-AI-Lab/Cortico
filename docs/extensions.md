<!-- Owner: src/extensions.ts, src/extensions/manifest.ts -->

# 扩展

扩展是一个 npm 包,给一份部署补一个 World、一个 provider 或一个 bot。仓库内建的 World 与
provider 仅包含参考 bot 所需的实现;其他平台或模型通信协议通过扩展提供。

## 安装

安装会向 `extensions/package.json` 添加依赖,重启进程后加载。支持以下方式:

- 控制台「扩展」页:一进页就列出 npm 上带 `cortico-world` / `cortico-provider` / `cortico-bot`
  关键字的包,可按名字、描述、关键字筛选,按下载量 / 发布时间 / 名字 / 被依赖数排序,一页 12 张。
  点开一张卡才取那个包的详情(契约版本、是否自带控制台面板、体积、依赖、版本史),安装键在详情里。
  或在「手动安装」里填 `name@version`。
- 控制台「手动安装」填本机目录的绝对路径:以 link 方式装入,改源码后重启生效。
- 命令行,在仓库根下:

```bash
cd extensions && corepack pnpm add --ignore-workspace <包名或目录>
```

`--ignore-workspace` 不能省:少了它 pnpm 会把 `extensions/` 当成仓库工作区的一员写进根
lockfile。

扩展页显示 `已加载`、`加载失败` 及原因、`待重启` 等状态。
`extensions/` 整个目录不进版本控制,是部署状态。

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
  "cortico": { "kind": "world", "api": 5, "consoleClient": "dist/console.js", "consoleStyle": "dist/console.css" }
}
```

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

控制台面板可选。自定义面板的 `src/console/client.ts` 默认导出 `{ panels: { <id>: { mount(ctx) } } }`,
用 esbuild 打成 `dist/console.js`(+ `.css`),路径写进 manifest;浏览器侧对 `cortico/*` 只能
`import type`。面板契约在 `src/web/shared/client-panel.ts`。

配置段归 World 包:`worlds.<id>` 的形状由 `defaults()` 定。bot 通过 `declares` 声明默认启用的 World,
也可提供 World 配置覆盖;部署 `config.json` 的同名段优先于包默认值。

## 写一个 provider 扩展

`"kind": "provider"`,关键字 `cortico-provider`,默认导出 `ProviderModule`(见
[providers.md](providers.md))。控制台页 id 是 `llm:<id>`,面板与 World 扩展同一套契约。

模块自己的旋钮走 `config(name, entry, language)`:owner 是 `provider:<id>`,路径一律在
`providers.<端点名>.options.` 下。端点条目里 `options` 之外的字段——`baseUrl`、`secret`、
`multimodal` 与 `spec`——由框架自己编辑,模块不声明它们。

面板在 `console(host)` 里声明。`llm:<id>` 这一页在控制台里没有自己的入口(左栏不列 `kind: 'llm'`
的页,`#/provider/llm:*` 会被换成 `#/providers`),模块面板只在端点编辑页露面,排法见
[providers.md](providers.md) 的「控制台」一节;`ctx.scope.instance` 是端点名。

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
「已装,本部署未用」。bot 的 `id` 不得与仓内 `bots/` 任一目录同名:控制台面板产物按
`persona:<id>` 找,撞名会拿到仓内那份。

`memoryName` 是 Memory 页的标题;缺省回落到 `persona.memory` 的类名,`check:extension` 对缺名的包给警告。

包目录只读。`promptDocs` 里没给 `deploymentPath` 的模板在控制台里能看不能存;要让部署者改,
在声明里给出部署侧的覆盖路径(通常在 `loaded.rootDir` 下)。bot 要挂的 World 若也是扩展,
在 `declares` 里声明 id 即可,没装时是灰卡。

## 校验

```bash
pnpm check:extension <包目录>
```

检查会读取 manifest、导入入口、按 kind 核对默认导出结构并确认面板产物存在,随后验证构造与声明接口:
World 在假部署(默认配置、无密钥)下调用 `create()`、`tools()`、`envPromptVars()`、
`console(language)`,检查工具名与 Core 保留名及内建 World 的冲突;provider 按假端点调用
`create()`;bot 按假部署调用 `build()`。检查不调用 `start()`,不验证真实服务运行。
装配层会为未启用的 World 创建实例,因此所有 World 都必须能以默认配置构造。

配置组声明的每个路径都要落在自己的段内,否则是失败。World 是 `worlds.<id>.`,并且要在
`defaults()` 里有对应项——缺默认值时控制台照样渲染旋钮、照样写回 config.json,而读到的是代码里
另一处的兜底值。

provider 是 `providers.<端点名>.options.`。写回的三道闸(服务端的端点保存、控制台草稿、
模块配置写入)都只认 `providers.<端点名>.` 前缀:段外的路径渲染得出旋钮、一改就报越界;
段内 `options` 之外的路径三道都放行,值直接盖掉框架自己编辑的 `baseUrl`、`secret`、`multimodal`
与 `spec`。这些值存在端点条目里,不经 `defaults()`,因此只核对段。

## 契约版本

三类扩展各有一个契约版本,`cortico.api` 必须等于自己这一类的那个:world **5**、provider **5**、
bot **5**。版本不符的扩展不能加载,页面显示「需要升级」。

加一的判据按类分:`WorldDefinition` 不兼容变更只加 world,`ProviderModule` 只加 provider,
`BotDefinition`(连同 `BotParts`、`Persona`、`LoadedConfig`)只加 bot;`ConsolePanelContext`
与其余共用接口变更时三类一起加。同一次发布里的多处变更合计加一。扩展 API 与控制台协议分别版本化。

## 已有扩展

- `cortico-world-vtuber`:Live2D VTuber 演出(VTube Studio、流式 TTS、强制对齐、字幕 overlay)。
- `cortico-world-asr`:麦克风语音识别(RtAudio 采集、能量门限切分、FireRedASR2-AED 后端)。
- `cortico-provider-grok`:xAI Grok 端点与设备码授权。

这些包独立于本仓库发布。声卡原生模块、Python 推理环境、VTS 等运行时依赖由相应扩展说明。
