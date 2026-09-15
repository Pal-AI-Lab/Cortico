<!-- Owner: src/bot.ts (BotDefinition), src/core/types.ts (CoreApi, Persona, World) -->

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/cortico-banner-dark.svg">
    <img src="assets/cortico-banner.svg" alt="Cortico" width="620">
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
  <a href="#documentation">Documentation</a> ｜
  <a href="PHILOSOPHY.md">Design Stance</a> ｜
  <a href="docs/extensions.md">Extensions</a> ｜
  <a href="CONTRIBUTING.md">Contributing</a> ｜
  <a href="https://github.com/Pal-AI-Lab/Cortico/issues">Issue Tracker</a>
</p>

A Cortico bot is far more than a chat bot: with an extensible agent system designed around the event stream, 
Cortico helps you build agents that respond on their own, run continuously, and take mixed real-time input.
One bot can watch and act on several external environments at once: chat platforms, live games, even the 
physical environment. It is perfect for downstream tasks such as persona bots, AI streamers, roleplay, 
companionship and much more. Cortico's goal: bring your AI to the world!

## Features

1. 🆓 Free and open source!
2. 🤖 A native agent harness: everything is designed around the agent.
3. 🔌 Modular LLM provider components: Can connect to many LLM APIs as well as locally deployed servers.
4. 🧠 Unconstrained internal context management, giving much freedom for the design of agent behaviour
   patterns and Memory system.
6. 🧩 An extension system (Cortico World), isolated from the inside, with event delivery and tool
   calls as its input and output: excellent compatibility and nearly unlimited extensibility.
7. 🖥️ A WebUI that is straightforward to operate.
8. 🪄 An Extension Creator system built for AI development
   ([Cortina](https://github.com/Pal-AI-Lab/Cortina)): a non-developer can use an AI agent to
   build the extension they want, or move an existing implementation onto Cortico!

## Quick Start

Requires Node 22+.

```bash
corepack pnpm install
```

A deployment is a directory naming one bot. The reference bot `cormini` starts with terminal
conversation alone, and its default endpoint reaches DeepSeek through `openai-responses-compat`:

```bash
mkdir -p deployments/mybot deployments/providers/deepseek
echo '{ "bot": "cormini" }' > deployments/mybot/deployment.json
echo 'DEEPSEEK_API_KEY=your-key' > deployments/providers/deepseek/.env
```

On Windows PowerShell:

```powershell
mkdir deployments\mybot, deployments\providers\deepseek -Force
Set-Content deployments\mybot\deployment.json '{ "bot": "cormini" }' -Encoding utf8
Set-Content deployments\providers\deepseek\.env 'DEEPSEEK_API_KEY=your-key' -Encoding utf8
```

```bash
pnpm start mybot
```

The console is at `http://127.0.0.1:7788/`. Endpoints, keys, and every other knob are edited
there and take effect on save.

`pnpm start`, `./start.sh`, and `start.bat` on Windows all install missing dependencies, build
the console bundle when it is absent, offer a deployment menu, and restart the process when the
console asks for it.

## The Four Layers

| Layer | Owns | Lives in |
|---|---|---|
| **Core** | The lifecycle of sessions, the event stream and model calls. No semantics of its own | `src/core/` |
| **Persona** | The semantics of one class of bot: context, cognitive flow, the Memory protocol | `bots/<name>/persona/` |
| **Memory** | The only authoritative carrier of a bot's internal state; its form is the Persona's choice | `<deployment>/memory/` |
| **World** | The only boundary to one external environment: events, tools, environment prompt | `src/worlds/<id>/` |
| **Bot** | The assembly: one Persona, a set of Worlds | `bots/<name>/index.ts` |

## Documentation

| Page | Covers |
|---|---|
| [deployment.md](docs/deployment.md) | Deployment directories, the deployment root, the launcher |
| [configuration.md](docs/configuration.md) | The four-layer config merge, config groups, hot reload |
| [providers.md](docs/providers.md) | Provider modules, endpoint entries, model catalogs, prices |
| [runtimes.md](docs/runtimes.md) | Local runtimes and model files for `llamacpp` |
| [console.md](docs/console.md) | The per-deployment console and the pages modules declare |
| [sessions.md](docs/sessions.md) | Sessions, context capacity, handoff |
| [runs.md](docs/runs.md) | Run directories, logs, `pnpm logq` |
| [personas.md](docs/personas.md) | Persona hooks, Memory, bot assembly |
| [worlds.md](docs/worlds.md) | The World contract: events, tools, environment prompt |
| [extensions.md](docs/extensions.md) | Extension packages, the manifest, the loader |
| [environment-variables.md](docs/environment-variables.md) | `CORTICO_*` and the three `.env` files |
| [windows.md](docs/windows.md) | Windows compatibility |
| [development.md](docs/development.md) | Commands, the two tsconfigs, test layout |

## Built-in Worlds

| World | id | Connects |
|---|---|---|
| Terminal | `terminal` | Two-way conversation in the console terminal |
| QQ | `qq` | Several group chats and private chats; images optionally described by a vision model |
| Bilibili live | `bilibili` | Read-only danmaku, gifts, superchats, guard buys, entries and viewer counts, with a local overlay |
| Minecraft | `minecraft` | A mineflayer client on a vanilla server: game state as text observations, high-level intent as game actions |
| Web search | `websearch` | The Brave Search API |

Published extensions: `cortico-world-vtuber`, `cortico-world-asr`, `cortico-world-pvz`,
`cortico-world-canvas`, `cortico-provider-grok`. `templates/extension/` holds one minimal
package per kind, and [Cortina](https://github.com/Pal-AI-Lab/Cortina) generates one.

## Model Providers

| Provider | Talks to |
|---|---|
| `openai-responses-compat` | Model services that expose the Responses API |
| `llamacpp` | A local llama-server, including release download and process supervision |

Other providers can be added as extensions.

## Contributing
* [CONTRIBUTING.md](CONTRIBUTING.md) says what belongs in this repository and what belongs
in an extension.
* [AGENTS.md](AGENTS.md) is the review checklist.

A contributor may submit AI-generated code but they must be able to explain all submitted code. 

Run the following two commands before submitting pull request:

```bash
pnpm test
```

```bash
pnpm run typecheck
```

Browser changes also require `pnpm typecheck:web`, and `pnpm build:web` rebuilds the console
bundle.

## Built With Cortico
If you build something with Cortico, make a pull request to add to this list!

* [@可缇Corti](https://space.bilibili.com/3707044056009191), an AI VTuber from the future
* ...and more!
