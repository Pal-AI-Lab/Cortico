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

Cortico is an event-driven agent harness for persona bots: autonomous response, continuous
operation, mixed and real-time input. It ships no persona and no memory scheme of its own, and
it is not aimed at question-answering chatbots or coding agents. A bot picks one Persona,
declares a set of Worlds, and runs as a deployment with its own console, config, secrets and
memory. [PHILOSOPHY.md](PHILOSOPHY.md) states the design stance every change is held to.

| Layer | Owns | Lives in |
|---|---|---|
| **Core** | The lifecycle of sessions, the event stream and model calls. No semantics of its own | `src/core/` |
| **Persona** | The semantics of one class of bot: context, cognitive flow, the Memory protocol | `bots/<name>/persona/` |
| **Memory** | The only authoritative carrier of a bot's internal state; its form is the Persona's choice | `<deployment>/memory/` |
| **World** | The only boundary to one external environment: events, tools, environment prompt | `src/worlds/<id>/` |
| **Bot** | The assembly: one Persona, a set of Worlds | `bots/<name>/index.ts` |

## Features

- **Events, not request and response.** A World records environment changes as events and
  delivers them to a session; the bot decides whether to act. Not acting is the default.
- **Continuous operation.** When the context reaches its capacity, the Persona's handoff
  strategy carries the bot into a new session. Restarting the process or changing the model does
  not change the bot's identity.
- **Persona and Memory are yours.** The Persona supplies prompts, context and the Memory
  protocol; the form of Memory is unconstrained. Core writes no prose for the model.
- **One bot in several environments at once.** Terminal, QQ, Bilibili live, Minecraft and web
  search are separate Worlds; the deployment decides which are mounted.
- **A console per deployment.** Every knob is a JSON Schema property declared by its owning
  module and rendered by the console; edits take effect without a restart.
- **Three extension points.** A World, a provider or a bot, each shipped as an npm package,
  searchable and installable from the console.
- **Models belong to the endpoint.** Model name, sampling and prices live in the provider entry.
  The Persona never names a model.

## Quick Start

Node 22+.

```bash
corepack pnpm install
```

Create a deployment that uses the reference bot `cormini`. It enables only terminal
conversation by default:

```bash
mkdir -p deployments/mybot && echo '{ "bot": "cormini" }' > deployments/mybot/deployment.json
```

The default endpoint reaches DeepSeek through `openai-responses-compat` and needs a key:

```bash
mkdir -p deployments/providers/deepseek && echo "DEEPSEEK_API_KEY=your-key" > deployments/providers/deepseek/.env
```

Other endpoints are created on the console's model page; a key can also be filled in after
startup and takes effect when saved. Start the deployment:

```bash
pnpm start mybot
```

The console is at `http://127.0.0.1:7788/`.

`./start.sh` (on Windows, double-click `start.bat`) installs missing dependencies, builds the
console bundle if absent, offers a deployment menu, and restarts the process when the console
asks for it.

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

Everything else ships as an extension: `cortico-world-vtuber`, `cortico-world-asr`,
`cortico-world-pvz`, `cortico-world-canvas`, `cortico-provider-grok`.
`templates/extension/` holds a minimal installable package for each of the three kinds, and
[Cortina](https://github.com/Pal-AI-Lab/Cortina) generates one.

## Model Providers

| Provider | Talks to |
|---|---|
| `openai-responses-compat` | Model services that expose the Responses API |
| `llamacpp` | A local llama-server, including release download and process supervision |

Other protocols arrive as extensions. Endpoints are shared by every deployment under the same
deployment root; `providers/<endpoint>/` holds that endpoint's model, sampling, key and price
configuration.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first: it states
what is accepted, what belongs in an extension instead, and the one rule — contributors must be
able to explain all submitted code, including code written with a coding agent.
[AGENTS.md](AGENTS.md) is the review checklist.

```bash
pnpm test
```

```bash
pnpm run typecheck
```

Browser changes also require `pnpm typecheck:web`, and `pnpm build:web` rebuilds the console
bundle.
