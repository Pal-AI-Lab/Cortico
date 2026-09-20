<!-- Owner: bots/cormini/index.ts -->

# bots/cormini

The smallest complete Cortico bot; its default display name is 可缇mini. The `Cormini`
persona class is also the base class of `CortiSoulmate` (`bots/corti-soulmate/`) and
`CortiV` (`bots/cortiv/`); variants are independent classes, never constructor flags.

## Run it

```bash
pnpm start cormini
```

Needs an API key for the active endpoint: `DEEPSEEK_API_KEY` for the seeded DeepSeek
instance, in the process environment or in the endpoint's `.env` under
`<deployment root>/providers/<endpoint>/` (the console's provider page can write it there).
The package holds no deployment; see
[`bots/README.md`](../README.md) for what lives where.
Open `http://127.0.0.1:7788/` and talk to it in the terminal view.

## What it does

- **The workspace is the memory.** `workspace/` is the whole of it. The bot works on it
  with the standard file toolset: `read_file` (whole file or a line range), `write_file`,
  `edit_file` (exact-string replace), `delete_file`, `list_files` (folded directory
  listing), `glob_files` (by name pattern) and `grep_files` (by content); nothing else
  survives a context handoff. The file listing is part of the system prefix, so the bot
  always knows what it has.
- **The constitution is the prefix.** `persona/CONSTITUTION.seed.md` initializes
  `workspace/CONSTITUTION.md` on first run; the workspace copy is loaded verbatim on every
  session. Edits by hand or by the bot take effect at the next session start.
- **One session by default.** `declareSessions()` returns a single persistent session that
  receives events. `onHandoff()` returns `tail: null`, handing the rebuild back to
  the Core (the recent tail carries over mechanically).
- **Terminal only.** No platform adapters.
- **Soft-boundary jot warning.** At batch end it checks `sessionInfo` token gauges
  against a fixed 0.85 ratio: one warning round to write things down, then it requests
  the handoff itself (the Core keeps only the over-budget hard clamp).

The livestream memory system (viewer profiles with first-seen recall, post-handoff
parallel dream) is **not** here — it is `CortiV`'s own behavior, see
[`bots/cortiv/`](../cortiv/README.md).

## Scope

Cormini does not implement the reference persona's optional subsystems:

layered memory (MEMORY 0–4) · subconscious paths (association / rumination / dream) ·
proposals and constitutional review · draft-then-confirm gates · platform worlds ·
version history and checkpoints · usage accounting

## Framework-derived console

`index.ts` contributes only its own Console Provider (model tiers); the terminal chat panel
comes from the terminal module's own provider. `createBot()` derives events, logs, sessions, status,
storage, pause/resume, configuration, tool-library, and IO-module console surfaces from
the Core fields.
