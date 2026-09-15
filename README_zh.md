<!-- Owner: src/bot.ts (BotDefinition), src/core/types.ts (CoreApi, Persona, World) -->

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/cortico-banner-dark.svg">
    <img src="assets/cortico-banner.svg" alt="Cortico" width="620">
  </picture>
</p>

<p align="center">
  <a href="README.md">English</a> ｜
  简体中文
</p>

<p align="center">
  <a href="https://github.com/Pal-AI-Lab/Cortico/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Pal-AI-Lab/Cortico/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Node ≥ 22" src="https://img.shields.io/badge/node-%E2%89%A5%2022-00A870">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-000000?logo=typescript&logoColor=white&labelColor=3178C6">
  <img alt="pre-release" src="https://img.shields.io/badge/status-pre--release-8A8496">
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-00A870"></a>
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ｜
  <a href="#文档">文档</a> ｜
  <a href="PHILOSOPHY.md">设计说明</a> ｜
  <a href="docs/extensions.md">扩展</a> ｜
  <a href="CONTRIBUTING.md">贡献</a> ｜
  <a href="https://github.com/Pal-AI-Lab/Cortico/issues">Issues</a>
</p>

| 层 | 职责 | 位置 |
|---|---|---|
| **Core** | session、事件流与模型调用的生命周期，不拥有任何语义 | `src/core/` |
| **Persona** | 一类 Bot 的语义：上下文构造、认知流程、对 Memory 的解释 | `bots/<名>/persona/` |
| **Memory** | Bot 内部状态的唯一权威载体，形式由 Persona 决定 | `<部署>/memory/` |
| **World** | 与一个外部环境之间的唯一边界：事件、工具、环境提示词 | `src/worlds/<id>/` |
| **Bot** | 装配定义：选一个 Persona，声明一组 World | `bots/<名>/index.ts` |

Cortico 是基于事件流系统设计的 Agent Harness，用于自主响应、持续运行、混合实时输入场景的智能体
开发，适用于人格 Bot、AI 主播、角色扮演、聊天陪伴等多种下游任务。Cortico Bot 远不只是聊天 Bot：
得益于围绕事件流设计的 Agent 系统，Cortico 可以帮助构建长期持续存在、适用于复杂输入的 AI 智能
体，它支持自由的外部扩展，能够同时观察和操作多个外部环境，包括聊天平台、实时游戏、甚至现实环
境。Cortico 的目标是：把你的 AI 带到这个世界！（Bring your AI to the world！）

## 特性

1. 免费开源！
2. 源生 Agent Harness，一切围绕 Agent 设计。
3. 模块化的 LLM Provider 组件，内部使用 Responses 协议，对外支持多种上游 LLM API，并支持使用本
   地部署模型。
4. 自由的内部上下文管理，支持不同的 AI 智能体行为模式，兼容多种 Memory 系统设计。
5. 插件系统（Cortico World）与内部隔离，采用事件投递／工具调用作为输入／输出，提供优秀的兼容性
   和近乎无限的可扩展能力。
6. 提供便于操作的 WebUI 支持。
7. 提供专用于 AI 开发的 Extension Creator 系统（[Cortina](https://github.com/Pal-AI-Lab/Cortina)），
   非专业开发者也可以使用 AI Agent 快速创建想要的扩展，或迁移现有的实现到 Cortico！

设计说明见 [PHILOSOPHY.md](PHILOSOPHY.md)。

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

`./start.sh`（Windows 上双击 `start.bat`）会安装缺失的依赖、构建缺失的控制台产物，提供部署选择
菜单，并在控制台请求重启后重新启动进程。

## 文档

| 页面 | 内容 |
|---|---|
| [deployment.md](docs/deployment.md) | 部署目录、部署根、启动器 |
| [configuration.md](docs/configuration.md) | 四层配置合并、配置组、热更新 |
| [providers.md](docs/providers.md) | Provider 模块、端点条目、模型目录、价格 |
| [runtimes.md](docs/runtimes.md) | `llamacpp` 的本机运行时与模型文件 |
| [console.md](docs/console.md) | 控制台与各模块声明的页面 |
| [sessions.md](docs/sessions.md) | Session、上下文容量、交接 |
| [runs.md](docs/runs.md) | run 目录、日志、`pnpm logq` |
| [personas.md](docs/personas.md) | Persona 钩子、Memory、bot 装配 |
| [worlds.md](docs/worlds.md) | World 契约：事件、工具、环境提示词 |
| [extensions.md](docs/extensions.md) | 扩展包、manifest、装载 |
| [environment-variables.md](docs/environment-variables.md) | `CORTICO_*` 与三处 `.env` |
| [windows.md](docs/windows.md) | Windows 兼容 |
| [development.md](docs/development.md) | 命令、两份 tsconfig、测试布局 |

## 内建 World

| World | id | 接入内容 |
|---|---|---|
| 终端对话 | `terminal` | 控制台终端里的双向对话 |
| QQ | `qq` | 多个群聊与私聊；图片可选经视觉模型转文字 |
| 哔哩哔哩直播 | `bilibili` | 弹幕、礼物、醒目留言、上舰、进场与人流读数只读接入，附本机 Overlay |
| Minecraft | `minecraft` | mineflayer 玩家客户端连原版服务器，游戏状态转文字观察，高层意图转游戏操作 |
| 网页搜索 | `websearch` | Brave 搜索接口 |

其余都以扩展形式提供：`cortico-world-vtuber`、`cortico-world-asr`、`cortico-world-pvz`、
`cortico-world-canvas`、`cortico-provider-grok`。`templates/extension/` 为三类扩展各提供一个能装
的最小包，[Cortina](https://github.com/Pal-AI-Lab/Cortina) 可以生成一个。

## 模型端点

| Provider | 接的是什么 |
|---|---|
| `openai-responses-compat` | 提供 Responses API 的模型服务 |
| `llamacpp` | 本机 llama-server，含官方 release 的下载与进程托管 |

其他协议通过扩展安装。端点由同一部署根下的各部署共用，每个 `providers/<端点名>/` 目录存放该端点
的模型、采样、密钥和价格配置。

## 贡献

欢迎 issue 与 pull request。先读 [CONTRIBUTING.md](CONTRIBUTING.md)：它写明什么会被接受、什么应该
做成扩展，以及唯一的硬要求——贡献者必须能解释自己提交的全部代码，用编码 agent 写的也一样。
[AGENTS.md](AGENTS.md) 是评审清单。

```bash
pnpm test
```

```bash
pnpm run typecheck
```

改动浏览器侧代码还需要 `pnpm typecheck:web`，`pnpm build:web` 重建控制台产物。

## 范例实现

来自未来的 AI Vtuber [@可缇Corti](https://space.bilibili.com/3707044056009191)，使用 Cortico 开发！
