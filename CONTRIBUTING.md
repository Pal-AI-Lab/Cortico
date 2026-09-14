# Contributing to Cortico

Cortico is pre-release.

## Philosophy

The framework stays small: a runtime for long-running persona bots, a reference Persona, and the
Worlds the reference bots use. What one bot, one platform or one operator needs is an extension
outside this repository. A change to `src/core` whose purpose is one bot's behavior is
declined; the accepted form is a hook the Persona fills in. [PHILOSOPHY.md](PHILOSOPHY.md) is
the reference for what is and is not the framework's job.

## The one rule

Contributors must understand and be able to explain all submitted code, including code written
with a coding agent. Pull requests that fail this requirement are closed.

## What is accepted

- Bug fixes in the runtime, the console, the extension loader and the bundled Worlds and
  providers, with a test that fails before the fix.
- Boundary fixes: removing bot-specific semantics from `src/core`, moving a default to its
  owner.
- New Worlds and providers as extension packages (see [docs/extensions.md](docs/extensions.md)).
  A World enters this repository only when the reference bots use it and its tests run without
  any one operator's setup.
- Persona content (constitutions, notes, memories, people files) is not accepted and is not
  covered by the license.

## Limits and guards

A cap, a queue bound, a timeout or a retry is accepted only with evidence that the failure it
prevents has happened: lines from a run directory, a crash, a profile. The value carries its
derivation from the path it protects, naming what produces the load and what drains it. A guard
the path cannot reach is dead code asserting a risk the code does not have; one that discards
real work when it fires says which work and why that is the better outcome. Looking safer is not
a reason.

## Before opening an issue

- One problem per issue: what happened, what you expected, how to reproduce it.
- For a bot misbehaving at runtime, attach lines from its run directory (`data/runs/<run>/`),
  not a screenshot.
- For a feature request, say why a Persona hook, a World or an extension cannot do it today.

## Before opening a pull request

- Open an issue first for anything larger than a local fix.
- Every pull request must explain its changes in plain language, with at least one paragraph
  in Chinese and one in English.
- All submitted natural-language content, including descriptions, UI copy, prompts,
  documentation, code comments and commit messages, must be written and reviewed against the
  [AI slop checklist](AGENTS.md#ai-slop-checklist) before submission.
- Run `pnpm test` and `pnpm run typecheck`. Browser changes also require `pnpm typecheck:web`:

```bash
pnpm test
```

```bash
pnpm run typecheck
```

```bash
pnpm typecheck:web
```

- [AGENTS.md](AGENTS.md) is the review checklist.
- One topic per pull request; commit messages as AGENTS.md describes.
- A change to an on-disk layout or to the meaning of already written content (event
  vocabulary, config keys, Memory layout) ships with a migration: dry-run by default, backup
  before writing, atomic replace, existing cursors stay valid. Users are never asked to clear
  their data.

## Licensing

MIT, inbound = outbound. You keep the copyright to your work; there is no contributor license
agreement. No third-party code, data tables or assets unless their license allows it and the
required notice travels with the file.

## Questions

Open an issue. There is no chat channel yet.
