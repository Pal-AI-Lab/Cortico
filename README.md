<!-- Owner: src/bot.ts (BotDefinition), src/core/types.ts (CoreApi, Persona, World) -->

# Cortico

基于事件流的 Agent Harness，支持人格 Bot 的自主响应、持续运行、混合输入与实时交互。
框架不预设人格或记忆方案，也不面向问答式聊天或 coding agent。设计说明见
[PHILOSOPHY.md](PHILOSOPHY.md)。

四层:**Core** 持有 session、事件流与模型调用的生命周期,不拥有任何语义;**Persona** 定义一类
Bot 的语义与对 Memory 的解释;**Memory** 是 Bot 内部状态的唯一权威载体;**World** 是与一个外部
环境之间的唯一边界。一个 **Bot** 选一个 Persona、声明一组 World。

- [快速开始](#快速开始)
- [部署](#部署) · [配置](#配置) · [Provider](#provider) · [控制台](#控制台)
- [Session](#session) · [Run 与日志](#run-与日志)
- [Persona 与 Bot](#persona-与-bot) · [World](#world) · [扩展](#扩展)
- [环境变量](#环境变量) · [Windows](#windows) · [开发](#开发)
- [仓库地图](#仓库地图) · [命令](#命令)

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

## 部署

一份部署是一个目录：`deployment.json` 引用代码包，`config.json` 覆盖包的默认配置，`.env`
存放 World 的密钥，`memory/` 存放 Memory，`data/` 存放运行数据。部署根由 `CORTICO_HOME`
指定，默认是 `deployments/`，整个目录不纳入版本控制；端点目录 `providers/` 与各部署平级。
[docs/deployment.md](docs/deployment.md)

## 配置

四层深合并:框架默认与 bot 默认 ← 包里的 `worlds/<id>/config.json` ← 端点表 ← 部署
`config.json`。每个参数在所属模块的 `ConfigGroup` 中通过 JSON Schema 声明；控制台据此渲染，
支持热更新并原子写回配置。[docs/configuration.md](docs/configuration.md)

## Provider

Provider 适配模型服务的通信协议。内建 `openai-responses-compat`（原生 Responses API）与
`llamacpp`（本机 llama-server，支持下载和进程托管），其他实现通过扩展安装。
端点由同一部署根下的各部署共用，每个 `providers/<端点名>/` 目录存放该端点的模型、采样、
密钥和价格配置。模型由端点配置选择，Persona 不指定模型。
[docs/providers.md](docs/providers.md)

## 控制台

每份部署一个本机 Web 控制台:终端、运行诊断、用量、语言模型、World 总览、扩展、设置。World、
Persona、provider 各自声明控制台页面；新增 World 无需修改 `src/web/**`。
[docs/console.md](docs/console.md)

## Session

一个 session 是一次独立的模型对话，由 Persona 声明，其中恰好一个接收事件投递。
Core 用 `hardTokens` 限制上下文容量；交接策略与阶段预算由 Persona 决定。
[docs/sessions.md](docs/sessions.md)

## Run 与日志

一次进程运行对应一个 run。`data/runs/<run>/` 存放事件、运行日志、上下文记录与工具调用记录，
通过 session、轮次、调用、工具与事件标识关联。使用 `pnpm logq` 查询。[docs/runs.md](docs/runs.md)

## Persona 与 Bot

Persona 通过生命周期钩子提供提示词、上下文和记忆行为；Core 调用这些钩子，不生成语义内容。
Bot 是 `bots/<名>/index.ts` 中的装配定义。三个参考 bot：`corti-soulmate`、`cormini`、`cortiv`。
[docs/personas.md](docs/personas.md)

## World

`World` 将环境变化记录为事件，将外部操作声明为工具，并提供环境提示词。`WorldHost` 提供
事件库读取、事件投递和可选的认知任务接口。内建 terminal、qq、bilibili、minecraft、websearch。
[docs/worlds.md](docs/worlds.md)

## 扩展

npm 包,补一个 World、provider 或 bot。装在 `extensions/` 下,控制台可搜可装,重启生效。
`cortico-world-vtuber`、`cortico-world-asr`、`cortico-world-pvz`、`cortico-world-canvas`、
`cortico-provider-grok` 都是扩展。`templates/extension/` 提供三类扩展模板;
相关开发项目见 [Cortina](https://github.com/Pal-AI-Lab/Cortina)。
[docs/extensions.md](docs/extensions.md)

## 环境变量

`CORTICO_HOME`、`CORTICO_BOT`、`CORTICO_LOG`、`CORTICO_LANGUAGE`、`CORTICO_START_PAUSED`、
`CORTICO_OPEN_BROWSER`、`CORTICO_SUPERVISED`,以及三处 `.env` 的用途。
[docs/environment-variables.md](docs/environment-variables.md)

## Windows

Windows 平台兼容要求与实现位置。[docs/windows.md](docs/windows.md)

## 开发

命令、两份 tsconfig、测试布局、目录。[docs/development.md](docs/development.md);规则在
[AGENTS.md](AGENTS.md),贡献流程在 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 仓库地图

| 路径 | 内容 | 参考 |
|---|---|---|
| `bin/cortico.mjs` | 启动器：安装依赖、选择部署和监管进程（纯 JS，无第三方依赖） | [docs/deployment.md](docs/deployment.md) |
| `src/core/` | Core | [src/core/README.md](src/core/README.md) |
| `src/bot.ts`、`src/world.ts`、`src/deploy.ts`、`src/paths.ts`、`src/launcher.ts` | 装配、部署、启动 | [docs/deployment.md](docs/deployment.md) |
| `src/providers/`、`src/protocol/open-responses/` | 模型端点与线协议 | [src/providers/README.md](src/providers/README.md) |
| `src/web/` | 控制台 | [src/web/README.md](src/web/README.md) |
| `src/extensions/` | 扩展装载 | [src/extensions/README.md](src/extensions/README.md) |
| `src/worlds/<id>/` | 内建 World,各有 README | [docs/worlds.md](docs/worlds.md) |
| `bots/<名>/` | bot 包 | [bots/README.md](bots/README.md) |
| `templates/extension/<kind>/` | 扩展包模板,三种 kind 各一个能装的最小包 | [templates/extension/README.md](templates/extension/README.md) |
| `scripts/` | 构建、日志查询、审计、迁移 | [docs/development.md](docs/development.md) |
| `tests/` | 测试 | [docs/development.md](docs/development.md) |

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

MIT。
