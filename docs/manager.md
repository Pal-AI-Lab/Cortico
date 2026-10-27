<!-- Owner: src/manager/main.ts, src/manager/copy-contract.ts, src/web/client/manager/app.ts -->

# Multi-character management

Start the management center with the regular installer/build bootstrap:

```sh
pnpm start --manager
# LAN access, with an explicit port:
pnpm start --manager --host=0.0.0.0 --port=7790
```

The default address is `http://127.0.0.1:7790`. The first visit asks you to set a password. There is no default password. Sign in once on the same hostname to use the center and its managed character WebUIs. Changing the password or signing out everywhere invalidates existing sessions, including open WebSockets; characters continue running.

The center uses the original `CORTICO_HOME` deployment root. Its own password hash, task history, schedules and trash live in `<CORTICO_HOME>/.manager/`. Each character keeps its normal deployment directory, configuration, memory and runtime data. Providers and installed extension code are shared as in the regular launcher. Dependencies and installation commands are unchanged.

Characters start through `src/launcher.ts`, including its original Bot, World and provider loading, shutdown and restart handling. A managed character starts paused. Resume it when its model and external connections are configured. Stopping one character leaves the center and other characters available. Stopping the center gracefully stops the children it owns. Already-running standalone deployments should be shut down before starting them through the center; the existing instance lock prevents concurrent owners.

## Create and copy

The template list discovers repository Bot definitions and installed Bot extensions. A fresh character uses `createDeployment()` and the selected Bot's regular first-run initialization. Install or update extensions through Cortico's extension interface, then restart the center to reload its catalog.

Copying always preserves configuration, prompt overrides, avatar and theme. Memory, session, history, pending messages, timers, World state and external connections are separate options. Mutable runtime data requires a graceful source shutdown; the center performs the copy and restores the source's prior running/paused state. The new character remains stopped, receives a distinct WebUI port and never inherits process locks or login keys.

Session copies retain the event records and media needed to interpret that session. Pending-message copies include memory, session, history and World state; timer copies include memory. External accounts remain the same external identities when explicitly copied. Unselected connections are disabled and their declared credentials are omitted.

### Extension copy contracts

Optional metadata lives with the definition that owns the files:

```ts
// BotDefinition
copy: { settingsInMemory: ['CONSTITUTION.md'] }

// WorldDefinition
copy: {
  state: ['example-state.json'], // relative to dataDir
  connection: {
    keys: ['serverUrl', 'account'], // fields in worlds.<id>
    secrets: ['EXAMPLE_TOKEN'],    // entries in the deployment .env
  },
}
```

Use `copy: {}` for a World with no local state or external identity. An undeclared World connection is disabled by default when cloning. Unknown data files and custom memory/data paths are reported before copying, so an extension's mutable state is not silently dropped. A Bot without copy metadata can still be created and run; add its settings rules to enable cloning. External server state and resources outside the deployment are not duplicated by a local snapshot.

## Management operations

The center supports recoverable deletion, restoration and explicit permanent removal; one-time/daily run, pause and stop schedules; task results and failure details; history clearing, retention limits and pagination. Removing a character disables its schedules. Restoration leaves it stopped with an available WebUI port. Schedules persist across restarts. When the center resumes, overdue occurrences execute once; recurring schedules advance to their next future occurrence.

Standalone `pnpm start <deployment>` keeps its existing startup and authentication behavior. It has no management menu. Moving an existing deployment to managed operation is an explicit operational step, separate from installing this code.
