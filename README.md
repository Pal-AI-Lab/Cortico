<!-- Owner: src/bot.ts (BotDefinition), src/core/types.ts (CoreApi, Persona, World) -->

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/cortico-banner-dark.svg">
    <img src="assets/cortico-banner.svg" alt="Cortico" width="680">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/Pal-AI-Lab/Cortico/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Pal-AI-Lab/Cortico/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Node ≥ 22" src="https://img.shields.io/badge/node-%E2%89%A5%2022-00A870">
  <img alt="pre-release" src="https://img.shields.io/badge/status-pre--release-8A8496">
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-00A870"></a>
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="PHILOSOPHY.md">设计说明</a> ·
  <a href="docs/">文档</a> ·
  <a href="docs/extensions.md">扩展</a> ·
  <a href="CONTRIBUTING.md">贡献</a> ·
  <a href="https://github.com/Pal-AI-Lab/Cortico/issues">Issues</a>
</p>

Cortico 是基于事件流的 Agent Harness，支持人格 Bot 的自主响应、持续运行、混合输入与实时交互。
框架不预设人格或记忆方案，也不面向问答式聊天或 coding agent。设计说明见
[PHILOSOPHY.md](PHILOSOPHY.md)。

## 特性

- **事件流而非请求应答**：World 把环境变化写成事件投递给 session，Bot 自行决定是否行动；不行动是默认行为。
- **持续运行**：上下文达到容量上限时按 Persona 的交接策略续接，进程重启、模型更换都不改变 Bot 的身份。
- **人格与记忆由部署方定义**：Persona 提供提示词、上下文与记忆协议，Memory 的形式不受框架规定；Core 不生成任何语义内容。
- **一个 Bot 同时在多个环境里**：终端、QQ、哔哩哔哩直播、Minecraft、网页搜索各是一个 World，挂载与否由部署配置决定。
- **本机控制台**：每份部署一个 Web 控制台，配置项由各模块声明、控制台渲染，热更新生效。
- **扩展点只有三个**：World、provider、bot，各由一个 npm 包提供，控制台内搜索安装。
- **模型属于端点**：模型名、采样、价格写在 provider 端点配置里，Persona 不指定模型。

## 四层设计

| 层 | 职责 | 位置 | 文档 |
|---|---|---|---|
| **Core** | session、事件流与模型调用的生命周期；不拥有任何语义 | `src/core/` | [src/core/README.md](src/core/README.md) |
| **Persona** | 一类 Bot 的语义：上下文构造、认知流程、对 Memory 的解释 | `bots/<名>/persona/` | [docs/personas.md](docs/personas.md) |
| **Memory** | Bot 内部状态的唯一权威载体，形式由 Persona 决定 | `<部署>/memory/` | [docs/personas.md](docs/personas.md) |
| **World** | 与一个外部环境之间的唯一边界：事件、工具、环境提示词 | `src/worlds/<id>/` | [docs/worlds.md](docs/worlds.md) |
| **Bot** | 装配定义：选一个 Persona，声明一组 World | `bots/<名>/index.ts` | [bots/README.md](bots/README.md) |

## 快速开始

Node 22+。

```bash
corepack pnpm install
```

创建一份使用参考 bot `cormini` 的部署。该 bot 默认只启用终端对话：

```bash
mkdir -p deployments/mybot && echo '{ "bot": "cormini" }' > deployments/mybot/deployment.json
```

默认端点通过 `openai-responses-compat` 连接 DeepSeek，需要配置密钥：

```bash
mkdir -p deployments/providers/deepseek && echo "DEEPSEEK_API_KEY=你的key" > deployments/providers/deepseek/.env
```

其他端点可在控制台「语言模型」页创建；密钥也可以启动后填写，保存即生效，不必重启。启动部署：

```bash
pnpm start mybot
```

控制台在 `http://127.0.0.1:7788/`。

`./start.sh`（Windows 上双击 `start.bat`）会安装缺失的依赖、构建缺失的控制台产物，
提供部署选择菜单，并在控制台请求重启后重新启动进程。

## 控制台

每份部署一个本机 Web 控制台：终端、运行诊断、用量、语言模型、World 总览、扩展、设置。World、
Persona、provider 各自声明控制台页面；新增 World 无需修改 `src/web/**`。界面语言随请求走，
中英各一份。[docs/console.md](docs/console.md)

## 内建 World

`World` 将环境变化记录为事件，将外部操作声明为工具，并提供环境提示词。`WorldHost` 提供事件库
读取、事件投递和可选的认知任务接口。[docs/worlds.md](docs/worlds.md)

| World | id | 接入内容 |
|---|---|---|
| 终端对话 | `terminal` | 控制台终端里的双向对话 |
| QQ | `qq` | 多个群聊与私聊；图片可选经视觉模型转文字 |
| 哔哩哔哩直播 | `bilibili` | 弹幕、礼物、醒目留言、上舰、进场与人流读数只读接入，附本机 Overlay |
| Minecraft | `minecraft` | mineflayer 玩家客户端连原版服务器，游戏状态转文字观察，高层意图转游戏操作 |
| 网页搜索 | `websearch` | Brave 搜索接口 |

其余 World 以扩展形式提供。

## 模型端点

Provider 适配模型服务的通信协议。端点由同一部署根下的各部署共用，每个 `providers/<端点名>/`
目录存放该端点的模型、采样、密钥和价格配置。[docs/providers.md](docs/providers.md)

| Provider | 接的是什么 |
|---|---|
| `openai-responses-compat` | 原生 Responses API 的模型服务 |
| `llamacpp` | 本机 llama-server，含官方 release 的下载与进程托管（[docs/runtimes.md](docs/runtimes.md)） |

其他协议通过扩展安装。

## 扩展

npm 包，补一个 World、provider 或 bot。装在 `extensions/` 下，控制台可搜可装，重启生效。
`cortico-world-vtuber`、`cortico-world-asr`、`cortico-world-pvz`、`cortico-world-canvas`、
`cortico-provider-grok` 都是扩展。`templates/extension/` 提供三类扩展模板；
相关开发项目见 [Cortina](https://github.com/Pal-AI-Lab/Cortina)。
[docs/extensions.md](docs/extensions.md)

## 部署与配置

一份部署是一个目录：`deployment.json` 引用代码包，`config.json` 覆盖包的默认配置，`.env`
存放 World 的密钥，`memory/` 存放 Memory，`data/` 存放运行数据。部署根由 `CORTICO_HOME`
指定，默认是 `deployments/`，整个目录不纳入版本控制；端点目录 `providers/` 与各部署平级。
[docs/deployment.md](docs/deployment.md)

配置是四层深合并：框架默认与 bot 默认 ← 包里的 `worlds/<id>/config.json` ← 端点表 ← 部署
`config.json`。每个参数在所属模块的 `ConfigGroup` 中通过 JSON Schema 声明；控制台据此渲染，
支持热更新并原子写回配置。[docs/configuration.md](docs/configuration.md)

## Session、Run 与日志

一个 session 是一次独立的模型对话，由 Persona 声明，其中恰好一个接收事件投递。Core 用
`hardTokens` 限制上下文容量；交接策略与阶段预算由 Persona 决定。[docs/sessions.md](docs/sessions.md)

一次进程运行对应一个 run。`data/runs/<run>/` 存放事件、运行日志、上下文记录与工具调用记录，
通过 session、轮次、调用、工具与事件标识关联。使用 `pnpm logq` 查询。[docs/runs.md](docs/runs.md)

## Persona 与 Bot

Persona 通过生命周期钩子提供提示词、上下文和记忆行为；Core 调用这些钩子，不生成语义内容。
Bot 是 `bots/<名>/index.ts` 中的装配定义。三个参考 bot：`corti-soulmate`、`cormini`、`cortiv`。
[docs/personas.md](docs/personas.md)

## 运行环境

`CORTICO_HOME`、`CORTICO_BOT`、`CORTICO_LOG`、`CORTICO_LANGUAGE`、`CORTICO_START_PAUSED`、
`CORTICO_OPEN_BROWSER`、`CORTICO_SUPERVISED`，以及三处 `.env` 的用途见
[docs/environment-variables.md](docs/environment-variables.md)；Windows 平台的兼容要求与实现
位置见 [docs/windows.md](docs/windows.md)。

## 仓库地图

| 路径 | 内容 | 参考 |
|---|---|---|
| `bin/cortico.mjs` | 启动器：安装依赖、选择部署和监管进程（纯 JS，无第三方依赖） | [docs/deployment.md](docs/deployment.md) |
| `src/core/` | Core | [src/core/README.md](src/core/README.md) |
| `src/bot.ts`、`src/world.ts`、`src/deploy.ts`、`src/paths.ts`、`src/launcher.ts` | 装配、部署、启动 | [docs/deployment.md](docs/deployment.md) |
| `src/providers/`、`src/protocol/open-responses/` | 模型端点与线协议 | [src/providers/README.md](src/providers/README.md) |
| `src/web/` | 控制台 | [src/web/README.md](src/web/README.md) |
| `src/extensions/` | 扩展装载 | [src/extensions/README.md](src/extensions/README.md) |
| `src/worlds/<id>/` | 内建 World，各有 README | [docs/worlds.md](docs/worlds.md) |
| `bots/<名>/` | bot 包 | [bots/README.md](bots/README.md) |
| `templates/extension/<kind>/` | 扩展包模板，三种 kind 各一个能装的最小包 | [templates/extension/README.md](templates/extension/README.md) |
| `scripts/` | 构建、日志查询、审计、迁移 | [docs/development.md](docs/development.md) |
| `tests/` | 测试 | [docs/development.md](docs/development.md) |
| `assets/` | 标识与 banner |  |

## 命令

| 命令 | 作用 |
|---|---|
| `pnpm start <部署名>` | 启动部署 |
| `pnpm bots` | 列出可启动的部署 |
| `pnpm test` | 全量测试 |
| `pnpm run typecheck` / `pnpm typecheck:web` | Node 侧 / 浏览器侧类型检查 |
| `pnpm build:web` | 构建控制台 |
| `pnpm dev:console` | 假数据控制台 |
| `pnpm logq` | 查运行日志 |
| `pnpm check:extension <目录>` | 校验扩展包 |
| `pnpm audit:release` | 发布审计 |

## 开发与贡献

命令、两份 tsconfig、测试布局与目录见 [docs/development.md](docs/development.md)。仓库规则在
[AGENTS.md](AGENTS.md)，贡献流程、评审标准与提 issue 的要求在
[CONTRIBUTING.md](CONTRIBUTING.md)。Cortico 尚未发布正式版本。

## 许可证

MIT。Persona 内容（宪章、笔记、记忆、人物档案）不在许可范围内，也不接受提交。
