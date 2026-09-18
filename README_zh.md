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
  <a href="#四层设计">四层设计</a> ｜
  <a href="#文档">文档</a> ｜
  <a href="PHILOSOPHY.md">设计说明</a> ｜
  <a href="docs/extensions.md">扩展</a> ｜
  <a href="#社区">社区</a> ｜
  <a href="CONTRIBUTING.md">贡献</a> ｜
  <a href="https://github.com/Pal-AI-Lab/Cortico/issues">Issues</a>
</p>

Cortico 是基于事件流系统设计的 Agent Harness，用于自主响应、持续运行、混合实时输入场景的智能体开发，适用于人格 Bot、AI 主播、角色扮演、聊天陪伴等多种下游任务。Cortico Bot 远不只是聊天 Bot：得益于围绕事件流设计的 Agent 系统，Cortico 可以帮助构建长期持续存在、适用于复杂输入的 AI 智能体，它支持自由的外部扩展，能够同时观察和操作多个外部环境，包括聊天平台、实时游戏、甚至现实环境。Cortico 的目标是：把你的 AI 带到这个世界！（Bring your AI to the world！）

## 特性

1. 🆓 免费开源！
2. 🤖 原生 Agent Harness，一切围绕 Agent 设计。
3. 🔌 模块化的 LLM Provider 组件，内部使用 Responses 协议，对外支持多种上游 LLM API，并支持使用本地部署模型。
4. 🧠 自由的内部上下文管理，支持不同的 AI 智能体行为模式，兼容多种 Memory 系统设计。
5. 🧩 外部环境（Cortico World）与内部隔离，采用事件投递／工具调用作为输入／输出，提供优秀的兼容性和近乎无限的可扩展能力。
6. 🖥️ 提供便于操作的 WebUI 支持。
7. 🪄 提供专用于 AI 开发的 Extension Creator 系统（[Cortina](https://github.com/Pal-AI-Lab/Cortina)），非专业开发者也可以使用 AI Agent 快速创建想要的扩展，或迁移现有的实现到 Cortico！

## 快速开始

运行环境需 Node 22+。

```bash
corepack pnpm install
pnpm start
```

### 1. 首次启动与控制台引导
首次启动且未检测到已有部署时，启动器会自动创建名为 `mybot` 的默认部署（基于参考实现 `cormini`，默认启用终端对话），并自动启动控制台服务：

**`http://127.0.0.1:7788/`**

在控制台的终端页面中，开场引导将协助你完成三项基础配置：配置语言模型端点、查看已挂载的 World、调整系统提示词。配置好可用端点后，点击「打个招呼」即可让 Bot 主动开口交流。模型端点、API 密钥与运行参数均可在控制台中可视化修改，保存后下一次请求生效；托管运行时的启动参数在它下一次启动时生效。

### 2. 多部署管理
每个部署对应 `deployments/` 下的一个独立子目录（详见 [deployment.md](docs/deployment.md)）。再建一份：

```bash
pnpm start --new
```

依次选择 bot 代码包、部署目录名与展示名称，建好后直接启动，端点等其余配置在控制台中完成。按名称启动指定部署：

```bash
pnpm start second
```

启动脚本（`pnpm start`、`./start.sh` 或 Windows 上的 `start.bat`）会自动安装缺失依赖、按需构建控制台前端产物，在交互式终端中列出全部部署供选择（含新建部署入口），并在控制台请求重启时自动重启守护进程。

## 四层设计

Cortico 采用严格解耦的四层架构设计：

| 层级 | 核心职责 | 所在路径 |
|---|---|---|
| **Core** | 管理会话（Session）、事件流分发与模型调用生命周期；内部无业务语义。 | `src/core/` |
| **Persona** | 定义一类 Bot 的核心语义：上下文构造、认知循环与对 Memory 的读写协议。 | `bots/<名称>/persona/` |
| **Memory** | Bot 内部持久化状态的唯一权威载体，结构与组织形态由 Persona 决定。 | `<部署>/memory/` |
| **World** | 与单个外部环境交互的隔离边界：处理环境事件输入、工具声明与环境提示词。 | `src/worlds/<id>/` |
| **Bot** | 部署装配定义：将一个指定的 Persona 与一组 World 组装成可运行实例。 | `bots/<名称>/index.ts` |

## 文档

| 页面 | 内容索引 |
|---|---|
| [deployment.md](docs/deployment.md) | 部署目录结构、部署根路径与启动器工作机制 |
| [configuration.md](docs/configuration.md) | 四层配置合并规则、配置组定义与参数热更新 |
| [providers.md](docs/providers.md) | Provider 模块、模型目录、端点配置与计费策略 |
| [runtimes.md](docs/runtimes.md) | `llamacpp` 本机运行时管理与模型文件配置 |
| [console.md](docs/console.md) | 控制台架构、运行时监控与各模块页面声明 |
| [sessions.md](docs/sessions.md) | Session 生命周期、上下文容量调度与交接机制 |
| [runs.md](docs/runs.md) | 运行记录目录、日志结构与 `pnpm logq` 检索工具 |
| [personas.md](docs/personas.md) | Persona 生命周期钩子、Memory 架构与装配机制 |
| [worlds.md](docs/worlds.md) | World 交互契约：事件投递、工具执行与环境提示词 |
| [extensions.md](docs/extensions.md) | 扩展包规范、Manifest 定义与动态加载器 |
| [environment-variables.md](docs/environment-variables.md) | `CORTICO_*` 环境变量规范与三层 `.env` 文件继承 |
| [windows.md](docs/windows.md) | Windows 环境兼容性与运行说明 |
| [development.md](docs/development.md) | 常用开发命令、双 tsconfig 架构与测试体系布局 |

## 内建 World

| World | ID | 接入环境与能力 |
|---|---|---|
| 终端对话 | `terminal` | 控制台内建交互终端，支持双向文字会话 |
| QQ | `qq` | 接入 QQ 群聊与私聊，支持可选的多模态视觉模型图像理解 |
| 哔哩哔哩直播 | `bilibili` | 实时监听弹幕、礼物、醒目留言（SC）、大航海、进场通知与人流指标，附带本机 OBS 画面 Overlay |
| Minecraft | `minecraft` | 基于 Mineflayer 接入 Minecraft 原版服务器，实现文字环境观察与高层动作执行 |
| 网页搜索 | `websearch` | 集成 Brave Search API 的实时网络信息检索能力 |

## 模型端点

| Provider | 适配模型服务 / 说明 |
|---|---|
| `openai-responses-compat` | 支持 Responses API 协议规范的模型服务与兼容网关 |
| `llamacpp` | 本机 `llama-server` 运行时集成，支持官方 Binary 自动下载与子进程生命周期托管 |

如需接入更多模型协议与供应商，可通过扩展系统无缝安装。

## 社区

加入我们的群组咨询项目进展，和其他开发者交流！

* QQ 群：681195563
* Discord Server：https://discord.gg/DR37WB5zJf

## 参与贡献

欢迎提交 Issue 与 Pull Request！

* 提交前请查阅 [CONTRIBUTING.md](CONTRIBUTING.md)（了解仓库边界与扩展开发规范）以及 [AGENTS.md](AGENTS.md)（代码审查清单）。
* 欢迎使用 AI 编码助手辅助开发，但贡献者必须能够清晰解释提交的所有代码逻辑。
* 提交 PR 前请确保自动化校验通过：

```bash
pnpm test
pnpm run typecheck
```

若涉及控制台前端代码改动，需额外执行：

```bash
pnpm typecheck:web
pnpm build:web
```

## 范例实现

如果你使用 Cortico 构建了有趣的 Bot，欢迎提交 PR 收录到这里！

* [@可缇Corti](https://space.bilibili.com/3707044056009191) — 来自未来的 AI VTuber。
* ...持续更新中！
