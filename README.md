<!-- Owner: src/bot.ts (BotDefinition), src/core/types.ts (CoreApi, Persona, World) -->

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/cortico-banner-dark.svg">
    <img src="assets/cortico-banner.svg" alt="Cortico" width="806">
  </picture>
</p>

<p align="center">
  English ｜
  <a href="README_zh.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/Pal-AI-Lab/Cortico/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Pal-AI-Lab/Cortico/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Node ≥ 22" src="https://img.shields.io/badge/node-%E2%89%A5%2022-00A870">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-000000?logo=typescript&logoColor=white&labelColor=3178C6">
  <img alt="pre-release" src="https://img.shields.io/badge/status-pre--release-8A8496">
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-00A870"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ｜
  <a href="#the-four-layers">Architecture</a> ｜
  <a href="#documentation">Documentation</a> ｜
  <a href="PHILOSOPHY.md">Design Stance</a> ｜
  <a href="docs/extensions.md">Extensions</a> ｜
  <a href="#community">Community</a> ｜
  <a href="CONTRIBUTING.md">Contributing</a> ｜
  <a href="https://github.com/Pal-AI-Lab/Cortico/issues">Issue Tracker</a>
</p>

Cortico is an agent harness designed around an event stream, built for autonomous, continuously running agents with mixed real-time input. It suits persona bots, AI streamers, roleplay, companionship, and many other downstream tasks. A Cortico bot is far more than a chat bot: with an extensible agent system designed around the event stream, Cortico helps you build persistent AI agents capable of handling complex inputs. It supports flexible external extensions, allowing a single bot to simultaneously observe and act across multiple environments—including chat platforms, live games, and even physical environments. Cortico's goal: bring your AI to the world!

## Features

1. 🆓 Free and open source!
2. 🤖 A native agent harness: everything is designed around the agent.
3. 🔌 Modular LLM provider components: built on the Responses protocol inside, supporting various upstream LLM APIs as well as locally deployed models outside.
4. 🧠 Unconstrained internal context management, giving much freedom for the design of agent behaviour patterns and Memory systems.
5. 🧩 An extension system (Cortico World), isolated from the inside, with event delivery and tool calls as its input and output: excellent compatibility and nearly unlimited extensibility.
6. 🖥️ A WebUI that is straightforward to operate.
7. 🪄 An Extension Creator system built for AI development ([Cortina](https://github.com/Pal-AI-Lab/Cortina)): a non-developer can use an AI agent to build the extension they want, or move an existing implementation onto Cortico!

## Build Extensions with Cortina

Use <picture><source media="(prefers-color-scheme: dark)" srcset="assets/cortina-banner-dark.png"><img src="assets/cortina-banner.png" alt="Cortina" height="28"></picture> to build the Cortico extension or adaptation you want, fast!

How to use: first, clone the repository from [https://github.com/Pal-AI-Lab/Cortina](https://github.com/Pal-AI-Lab/Cortina) to your machine.

1. Open that workspace with any coding agent.
2. Say hello! Cortina assists and guides you through the Cortico extension development / adaptation you want, all through conversation.
3. No coding experience or knowledge needed.
4. Once the extension is finished, publish it to npm to share it with everyone~

<sub>Cortina is designed on the [TINA (There Is No App) Spec](https://github.com/Pal-AI-Lab/ThereIsNoApp) proposed by Pal AI Lab. There is no app here: language is the code, the agent is the runtime.</sub>

## Quick Start

Requires Node 22+.

```bash
corepack pnpm install
pnpm start
```

### 1. First Launch & Web Console
On your first launch with an empty deployment directory, Cortico automatically initializes a default deployment named `mybot` (using the reference bot `cormini` with terminal chat enabled) and spins up the web console at:

**`http://127.0.0.1:7788/`**

The terminal page opens with three onboarding steps: configure a model endpoint, inspect active Worlds, and adjust the system prompt. Once an endpoint is configured, click **Say hello** to let the bot initiate conversation. All endpoints, credentials, and runtime parameters can be adjusted directly from the console; saved changes apply to the next request, and a managed runtime's launch parameters apply on its next start.

### 2. Managing Deployments
Each deployment is an isolated configuration directory inside `deployments/` (see [deployment.md](docs/deployment.md)). To add another one:

```bash
pnpm start --new
```

Pick a bot package, a directory name and a display name; the new deployment starts right away, with endpoints and everything else configured from the console. To start a specific deployment by name:

```bash
pnpm start second
```

The launcher scripts (`pnpm start`, `./start.sh`, and `start.bat` on Windows) automatically install missing dependencies, build web console assets if absent, list every deployment for selection on an interactive terminal (including an entry for creating a new one), and restart processes on request from the console.

## The Four Layers

Cortico strictly separates concerns across four distinct layers:

| Layer | Responsibility | Directory |
|---|---|---|
| **Core** | Manages session lifecycles, event streams, and model invocations. Semantics-free. | `src/core/` |
| **Persona** | Defines the semantics of a bot category: context synthesis, cognitive loop, and Memory protocols. | `bots/<name>/persona/` |
| **Memory** | The authoritative persistence store for internal state; layout and lifecycle are chosen by the Persona. | `<deployment>/memory/` |
| **World** | The isolated boundary to an external environment: event ingestion, tool declarations, and environment prompts. | `src/worlds/<id>/` |
| **Bot** | Assembly definition: couples one Persona with a designated set of Worlds. | `bots/<name>/index.ts` |

## Documentation

| Document | Topic |
|---|---|
| [deployment.md](docs/deployment.md) | Deployment layouts, deployment roots, and launcher behaviors |
| [configuration.md](docs/configuration.md) | Four-layer config cascading, configuration groups, and hot reload |
| [providers.md](docs/providers.md) | Provider modules, model catalogs, endpoint configurations, and pricing |
| [runtimes.md](docs/runtimes.md) | Local runtimes and model files for `llamacpp` |
| [console.md](docs/console.md) | Console architecture, live monitoring, and custom module pages |
| [sessions.md](docs/sessions.md) | Session lifecycle, token capacity management, and context handoff |
| [runs.md](docs/runs.md) | Runtime directories, structured logs, and `pnpm logq` CLI |
| [personas.md](docs/personas.md) | Persona lifecycle hooks, Memory architecture, and bot assembly |
| [worlds.md](docs/worlds.md) | The World contract: events, tools, and environment prompts |
| [extensions.md](docs/extensions.md) | Extension package specifications, manifests, and dynamic loading |
| [environment-variables.md](docs/environment-variables.md) | `CORTICO_*` environment configuration and the `.env` hierarchy |
| [windows.md](docs/windows.md) | Windows environment compatibility and setup |
| [development.md](docs/development.md) | Development workflows, dual tsconfig setup, and test architecture |

## Built-in Worlds

| World | ID | Integration & Capabilities |
|---|---|---|
| Terminal | `terminal` | Interactive two-way conversation within the web console |
| QQ | `qq` | Multi-group and direct message channels with optional vision model transcription |
| Bilibili Live | `bilibili` | Real-time danmaku, superchats, gifts, guards, and viewer traffic monitoring with local OBS overlay |
| Minecraft | `minecraft` | Mineflayer client for vanilla servers: game state observations and high-level autonomous action dispatch |
| Web Search | `websearch` | Real-time web search integration powered by Brave Search API |

## Model Providers

| Provider | Supported Services |
|---|---|
| `openai-responses-compat` | Any model API supporting the Responses protocol specification |
| `llamacpp` | Local `llama-server` runtime with automated binary download and process management |

Additional upstream protocols and providers can be integrated seamlessly via extensions.

## Community

Join our groups to follow the project and talk with other developers!

* QQ Group: 681195563
* Discord Server: https://discord.gg/DR37WB5zJf

## Contributing

We welcome issues and pull requests!

* Please read [CONTRIBUTING.md](CONTRIBUTING.md) for architectural guidelines and code separation rules.
* Refer to [AGENTS.md](AGENTS.md) for our engineering conventions and code review checklist.
* AI-assisted contributions are welcome, provided the author thoroughly understands and can explain all submitted logic.

Run automated verifications before submitting:

```bash
pnpm test
pnpm run typecheck
```

For changes touching frontend browser code, also run:

```bash
pnpm typecheck:web
pnpm build:web
```

## Built With Cortico

Building something cool with Cortico? Submit a pull request to share it here!

* [@可缇Corti](https://space.bilibili.com/3707044056009191) — An AI VTuber from the future
* ...and more!
