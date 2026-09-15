<!-- Owner: src/extensions.ts, src/extensions/manifest.ts -->

# 扩展

扩展是一个 npm 包,给一份部署补一个 World、一个 provider 或一个 bot。仓库内建的 World 与
provider 仅包含参考 bot 所需的实现;其他平台或模型通信协议通过扩展提供。

## 安装

安装会向 `extensions/package.json` 添加依赖,重启进程后加载。支持以下方式:

- 控制台「扩展」页:搜索 npm 上带 `cortico-world` / `cortico-provider` / `cortico-bot` 关键字的包,点安装;
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
复制一份出来,改包名与 id,把 `tsconfig.json` 的 `paths` 与 `vitest.config.ts` 的 alias 指到你的 Cortico
checkout,`corepack pnpm install`,`pnpm test`。每个模板的 README 说它验证什么、装进实例后该看见什么。
扩展开发相关项目:[Cortina](https://github.com/Pal-AI-Lab/Cortina)。

## 写一个 World 扩展

`package.json`:

```jsonc
{
  "name": "cortico-world-discord",
  "type": "module",
  "main": "./src/index.ts",
  "keywords": ["cortico-world"],
  "cortico": { "kind": "world", "api": 4, "consoleClient": "dist/console.js", "consoleStyle": "dist/console.css" }
}
```

入口默认导出一个 `WorldDefinition`(契约见 [worlds.md](worlds.md)):

```ts
import type { WorldDefinition } from 'cortico/world.ts';
export default { id: 'discord', label: 'Discord', defaults: () => ({ ... }), create: (ctx) => new DiscordWorld(ctx) } satisfies WorldDefinition<DiscordSection>;
```

框架以 `cortico/<src 下的路径>` import:`cortico/world.ts`、`cortico/core/types.ts`、
`cortico/core/util.ts`。运行时由 `src/extensions/runtime.ts` 的模块钩子解析到框架源码本身;
开发期在包的 `tsconfig.json` 里写 `"paths": { "cortico/*": ["../BOT/src/*"] }`,vitest 里加同样
的 alias。`"type": "module"` 是硬要求。

控制台面板可选。自定义面板的 `src/console/client.ts` 默认导出 `{ panels: { <id>: { mount(ctx) } } }`,
用 esbuild 打成 `dist/console.js`(+ `.css`),路径写进 manifest;浏览器侧对 `cortico/*` 只能
`import type`。面板契约在 `src/web/shared/client-panel.ts`。

配置段归 World 包:`worlds.<id>` 的形状由 `defaults()` 定。bot 通过 `declares` 声明默认启用的 World,
也可提供 World 配置覆盖;部署 `config.json` 的同名段优先于包默认值。

## 写一个 provider 扩展

`"kind": "provider"`,关键字 `cortico-provider`,默认导出 `ProviderModule`(见
[providers.md](providers.md))。控制台页 id 是 `llm:<id>`,面板与 World 扩展同一套契约。

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

## 契约版本

`cortico.api` 必须等于框架的 `EXTENSION_API_VERSION`(现在是 4)。`WorldDefinition`、
`ProviderModule`、`BotDefinition`(连同 `BotParts`、`Persona`、`LoadedConfig`)或
`ConsolePanelContext` 任一不兼容变更时框架将版本加一,版本不符的扩展不能加载,页面显示「需要升级」。
扩展 API 与控制台协议分别版本化。

## 已有扩展

- `cortico-world-vtuber`:Live2D VTuber 演出(VTube Studio、流式 TTS、强制对齐、字幕 overlay)。
- `cortico-world-asr`:麦克风语音识别(RtAudio 采集、能量门限切分、FireRedASR2-AED 后端)。
- `cortico-provider-grok`:xAI Grok 端点与设备码授权。

这些包独立于本仓库发布。声卡原生模块、Python 推理环境、VTS 等运行时依赖由相应扩展说明。
