<!-- Owner: scripts/publish-package.ts, src/extensions/runtime.ts -->

# cortico

Framework sources for [Cortico](https://github.com/Pal-AI-Lab/Cortico), published so that an
extension package resolves `cortico/*` while it is being written.

An extension supplies one World, one provider or one bot, and imports the framework by its path
under `src/`:

```ts
import type { WorldDefinition } from 'cortico/world.ts';
import type { EventEnvelope, WorldHost } from 'cortico/core/types.ts';
```

Inside a running instance those specifiers are resolved by the host's module hook to the
framework that instance runs. This package supplies the same files to the editor, the type
checker and the test runner. It has no entry point and starts nothing.

## Install

```bash
pnpm add -D cortico
```

The extension contract is API version 4; a package declares it as `"cortico": { "kind": ..., "api": 4 }`
in its own `package.json`. This package's minor version tracks the framework, so pin the range
your extension was written against.

`templates/extension/` in the repository holds a ready package for each kind, and
[docs/extensions.md](https://github.com/Pal-AI-Lab/Cortico/blob/main/docs/extensions.md) states
the packaging rules.

## Running a bot

Deployments, bot packages and the web console live in a checkout of the repository, which is
where a bot runs from:
[Quick Start](https://github.com/Pal-AI-Lab/Cortico#quick-start).

MIT licensed.
