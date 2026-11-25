# Factory Paseo plugin — design

New to the factory? Start with [Getting started](../getting-started.md); this page is the detailed reference.

The plugin lives in `plugin/`. Users can install it from a Git checkout or a built release directory. [Installation and updates](../getting-started.md#quickstart-in-paseo)

Scope: how the workspace factory (`src/`, ESM, Node `>=22`) could be driven from inside Paseo through the public plugin API: slash commands, plugin RPC, Command Center items, a settings screen, and (not available) agent tab order.

Sources checked (Paseo 0.16.2: local `paseo plugin init` scaffold plus the deployed docs; links are the evidence for each answer):

- <https://paseo.sh/llms.txt> (doc index)
- <https://paseo.sh/docs/plugins.md> (quickstart: scaffold, install, reload, logs)
- <https://paseo.sh/docs/plugins/reference.md> (full API contract)
- <https://paseo.sh/docs/plugins/publishing.md> (dependencies, locks, build step)
- <https://paseo.sh/docs/sdk/reference.md> (the `paseo` API plugins receive)
- <https://paseo.sh/docs/sdk/agents.md>, <https://paseo.sh/docs/workspaces.md>

## Verdicts

| Question | Verdict |
|---|---|
| (a) `/factory status\|checkpoint\|switch\|plan` slash commands, two-stage with plan hash | Feasible via `addSlashCommand` (client-side) + RPC + panel/modal for preview and confirm |
| (b) Execution via plugin RPC; factory core from `src/` reused | Feasible; core must be vendored under `server/` (or shipped as an npm dependency) — imports from outside the package do not exist |
| (c) Command Center entries | Feasible via `addCommandCenterItem` (`global`/`workspace`/`agent`) |
| (d) Settings screen for steer slots / worker default profile, catalog-backed, sidebar entry | Feasible via `addSettingsScreen` + `defineSettings` (`host` scope, including the chat-display toggle); provider catalog via `paseo.providers`. The sidebar entry is registered synchronously and shown/hidden in Paseo's own sidebar settings |
| (e) Agent tab order (Steers A..Z, then workers by number) | No native interface; Paseo owns tabs. Convention + read-only panel only; never edit state files |
| (f) `pluginsEnabled` prerequisite | Enable plugins on the target Paseo daemon. See [installation](../getting-started.md#quickstart-in-paseo). |

## (a) Slash commands

`client.addSlashCommand({ name, description, argumentHint, context, onSubmit })` registers a `/name args` command in the message composer. Evidence ([reference](https://paseo.sh/docs/plugins/reference.md#slash-commands)):

- Runs in the Paseo client; the text is never sent to the agent. There are no server-side slash commands.
- `context` is `"workspace"` or `"agent"`. Use `"workspace"`: an `agent` command is not offered on drafts, while a workspace command is.
- `onSubmit` receives the matching Command Center callback context plus `args` (raw text after the name, trimmed; parsing is the plugin's job), including `rpc(contract, input)`, `openPanel`, `openScreen`, and the `paseo` SDK.
- Paseo owns autocomplete, input clearing, and the error toast. It does not wait for `onSubmit` and shows no pending state — pending UI belongs in a panel or composer pill.
- Precedence is built-in commands, then plugin commands, then provider commands; lower precedence loses. Commands do not run while the composer has attachments.

Design: register one `factory` command (single name, minimal collision surface) and parse the subcommand from `args`:

- `/factory status [repo]` → `rpc(factory.status, …)`, render result in a workspace panel (plus short toast).
- `/factory plan <repo…>` → `rpc(factory.plan, …)` dry-run; the RPC returns the stored plan hash and op list; the panel shows the preview with the hash.
- `/factory apply <hash>` (or a Confirm button in the preview panel) → `rpc(factory.apply, { hash })`; the server executes only the stored authorization for that hash, mirroring `apply --confirm <hash>`.
- `/factory checkpoint …`, `/factory switch --to B [--apply]` map to the same RPC pairs: preview RPC first, mutating RPC second.

This preserves the factory safety model (dry-run first, confirmed plan only; see [docs/concepts.md](../concepts.md)): the hash is the confirmation token, and stage two never runs without stage one's stored artifact.

Implemented: inline output instead of the panel (E6). `onSubmit` opens the panel only when `args` is empty. For subcommands, errors are thrown and appear as error toasts (the only toast path in `onSubmit`; already used by the worker guard), while success appears as a short transient composer pill "Factory: \<one-liner\>" on the calling agent, with a popover for details (rendered from the existing `setFactoryResult` store, so the same renderers as the panel). The pill disappears after 60 s or on the next `/factory`. `resume` shows no success of its own; it becomes visible through the brief arriving in the timeline. Previews that need confirmation (`plan`, `switch --apply`, `checkpoint`, `fresh`, `apply`) still open the panel, because a button is needed. An agent answer as output (timeline renderer) is rejected: it would cost tokens in the agent context. `/factory resume` (clear plus brief, steers only) and `/factory resume --brief` (read-only brief, the old path) share this output model.

## (b) Execution via plugin RPC; reusing the factory core

Plugin RPC is defined for exactly this: "work that is not a normal Paseo operation" ([reference](https://paseo.sh/docs/plugins/reference.md#add-plugin-specific-backend-behavior)). Contract: one Zod contract in `shared/` (`defineRpc`), handler in `index.server.ts` (`server.handle`), called from client code via `useRpc()` or the callback `rpc(contract, input)`. Inputs are validated in the plugin process, outputs on the client. Handlers receive the same `PaseoApi` as `{ paseo }`; backend code "can use Node APIs and dependencies installed in the plugin directory".

The bundling boundary is strict ([quickstart](https://paseo.sh/docs/plugins.md), [reference](https://paseo.sh/docs/plugins/reference.md#runtime-modules)):

| Directory | Compiled into | May use |
|---|---|---|
| `client/` | App bundle only | React Native, hooks, surfaces, callbacks |
| `server/` | Daemon bundle only | Node APIs, local files, credentials, RPC handlers |
| `shared/` | Both | Zod contracts and plain values only |

Importing across that line, putting a code module at the plugin root, or importing a `node:` module from client code is a compile error; server imports of React/client SDK entries fail likewise. Entries accept `.ts` or `.tsx`; the scaffold typechecks `**/*.ts(x)` only.

Consequences for reusing `src/`:

1. The plugin cannot import the factory checkout. "[R]epository-only import aliases and files outside the package do not reach users" ([publishing](https://paseo.sh/docs/plugins/publishing.md#3-check-the-package-and-publish)). The core must travel inside the plugin package.
2. Recommended for the pilot: vendor the core as TypeScript under `server/factory/` (the modules are dependency-free ESM; only the `paseo`/`gh`/`git` CLIs and the daemon SDK are external). Replace the factory's own SDK connect (`loadSdk`/`connect` in `src/paseo.mjs`) with the handler's `{ paseo }`; keep `child_process` calls to `gh`, `git`, and the `paseo` CLI, which remain available in the daemon subprocess.
3. Alternative: publish the core as an npm dependency. That requires the dependency in `dependencies` (not `devDependencies`), a published `npm-shrinkwrap.json` locking the whole tree, and usually a `"build": [["npm", "ci", "--omit=dev", "--ignore-scripts"]]` step plus npm on the daemon `PATH` ([publishing](https://paseo.sh/docs/plugins/publishing.md#2-lock-installed-dependencies), [reference](https://paseo.sh/docs/plugins/reference.md#cli-reference)). Heavier; only worth it if the core is shared with other consumers.
4. Not recommended: shelling out to an installed `paseo-factory` binary from the handler. It works (Node `child_process`), but couples the plugin to an out-of-band install on every daemon host.
5. Verify during implementation: the daemon subprocess Node version must satisfy the factory's `engines: node >= 22` (log `process.version` via `paseo plugin logs`). No `.mjs` outside the compiled roots: keep vendored code as `.ts` so the plugin compiler and `npm run typecheck` cover it.
6. Plans, authorizations, journals, and locks (`runtime.stateDir`) stay daemon-host files; the server side can keep the same layout and the single-host `flock` model. The receipt-lookup version pin (`RECEIPT_LOOKUP_TESTED_VERSIONS` in `src/paseo.mjs`) must be re-verified against the daemon the plugin runs on.

## (c) Command Center entries

`client.addCommandCenterItem({ id, title, icon, keywords?, context, onSelect })` ([reference](https://paseo.sh/docs/plugins/reference.md#command-center-items)). `context` is `global`, `workspace`, or `agent`; workspace items need an active cached workspace, agent items a focused agent tab. Every callback receives `paseo`, `rpc`, `openScreen`, the `workspace`/`agent` snapshots, and `openPanel`. Open with Cmd/Ctrl+K.

Design: workspace-context items bound to the focused Main workspace, reusing the same RPCs as (a): "Factory: status", "Factory: plan", "Factory: checkpoint", "Factory: switch steer…", each opening the factory panel with the result. Global items are possible but add repo-selection UI; keep the first cut workspace-scoped.

## (d) Settings screen

Settings are a first-class contribution ([reference](https://paseo.sh/docs/plugins/reference.md#settings-screens)):

- `client.addSettingsScreen({ id, title, icon, Component })` in `index.client.tsx`. The plugin row under Settings → Plugins gains a cog opening the first screen; several screens become tabs in registration order. No sidebar item is required to reach them. `openSettings(id)` (also from Command Center callbacks) opens them programmatically.
- UI kit from `@getpaseo/plugin/client/ui`: `SettingsSection`, `SettingsCard`, `SettingsRow`, `SettingsSwitch`, `SettingsSelect`, `SettingsInput`, `SettingsAction`.
- Persistence: `defineSettings({ id, scope, version, schema, migrate? })` in `shared/`, registered via `server.registerSettings` in `index.server.ts`, read via `useSettings()` (client) or `read()` / `subscribe()` (server). Writes are atomic, host-validated, revision guarded (`save(values, revision)` returns `false` on conflict; `reset()` restores schema defaults; `reload()` re-reads).
- Paseo stores settings as ordinary host-side JSON per installation. Restart, reload, disable, and update preserve settings. Removing the installation deletes its settings, and reinstalling that ID starts with defaults. Settings RPCs use the `daemon.manage` permission. [Paseo settings persistence](https://paseo.sh/docs/plugins/reference.md#persisted-values)
- Scope: `"host"` documents are shared by authorized clients; `"device"` documents stay on one device and are explicitly "for layout preferences".

Design:

- `host`-scope documents for the factory configuration: `factory-config` (steer slots `A`–`Z` → profile name, `prepare` list, `initialActive`, worker `priority` list, profiles with advisor/sensitive flags, quota), plus `factory-cleanup`, `factory-resume` and `factory-supervision` for idle cleanup, resume and supervision. Schema defaults must make `{}` parse into a complete document (define a single-steer-`A` default mirroring `config.example.json`).
- Catalog-backed selects via the handler/client `paseo.providers` API ([SDK](https://paseo.sh/docs/sdk/reference.md#clientproviders)): `snapshot()` (the factory already consumes `result.entries` in `readPaseoState`), `listModels`, `listModes`, `listFeatures`, `waitForReady`; reuse the `validateProfilesAgainstCatalog` logic for the same "not startable" conflicts the CLI reports.
- Sidebar entry: registered synchronously in `contribute()` via `addSidebarHeaderItem`; Settings → Sidebar reorder/hide is user-owned. (A `device`-scope visibility toggle with runtime add/remove was tried and dropped: async registration never landed in Paseo's native sidebar list. The old `factory-sidebar` stored value is ignored.)
- Optional follow-up (not in the first cut): a workspace row badge (`addWorkspaceRowBadgeItem`) showing the active steer per Main workspace row. Note these start visible with a Show-menu toggle.

## (e) Agent tab order: no native interface

There is no plugin API or SDK call that sets the order of agent tabs in a workspace. Evidence:

- Panel registration (`addWorkspacePanel`/`addAgentPanel`) fields are only `id`, `title`, `icon`, `locations`, `Component` — no order field — and "Paseo owns tab focus, splitting, closing, persistence, query state…" ([reference](https://paseo.sh/docs/plugins/reference.md#workspace-panels)).
- The SDK workspace handle exposes `id`, `projectId`, `directory`, `name`, `status`, `current()`, `refresh()`, `setTitle(title)`, `archive()`, `subscribe()` — no layout or tab operations ([SDK](https://paseo.sh/docs/sdk/reference.md#clientworkspaces)).
- `agents.list` accepts `scope`/`filter`/`sort`/`page`, but that orders API results (the daemon directory query), not client tabs ([SDK](https://paseo.sh/docs/sdk/reference.md#clientagents)).
- Reordering exists only for sidebar items, and only by the user in Settings → Sidebar ([reference](https://paseo.sh/docs/plugins/reference.md#sidebar-items)). The workspaces product doc describes sessions as tabs with no ordering API ([workspaces](https://paseo.sh/docs/workspaces.md)).

Explicitly out of scope: editing Paseo state or layout files directly. They are daemon-owned, racy to touch from outside, and unsupported; this design does not do it.

Workaround (convention, not enforcement): keep deterministic titles ("Steer A", …) and worker numbering so manual order is obvious, and optionally render the desired order in the read-only factory panel from (a) as a guide.

## (f) Prerequisite `pluginsEnabled`: describe only

The daemon-wide switch lives under Settings → Plugins → Enable plugins and is the root `pluginsEnabled` field in the daemon's `config.json`; after a file edit apply it with `paseo reload --json`. A configured plugin stays `disabled` until both the global switch and its own switch are on; no daemon restart is required ([quickstart](https://paseo.sh/docs/plugins.md#install-and-try-it), [reference](https://paseo.sh/docs/plugins/reference.md#cli-reference)). A missing field counts as `false`; never infer the global value from one plugin's `disabled` status. For the local daemon, `paseo daemon status --json` reports its home and the file is `<home>/config.json`.

Quoted rule for automation: "An automated tool must read the current value and get your explicit permission before turning it on." Enabling means trusting unsandboxed code: "server code and preparation commands run with the daemon user's access on the daemon machine, and client code runs inside the Paseo app".

This task deliberately does neither: `pluginsEnabled` was not read for modification, not enabled, and nothing was installed. The `paseo plugin init` scaffold used for research lived in a throwaway directory under `/tmp` and was inspected only.

## Package shape

A plugin is its own package (`paseo-plugin.json` + `package.json` with a `files` list covering the entries and `client/`/`server/`/`shared/`). The smallest repo-local shape is a top-level `plugin/` directory installed from a directory path or via Git with a `:plugin` path suffix ([sources](https://paseo.sh/docs/plugins/reference.md#plugin-sources)):

```text
plugin/
  paseo-plugin.json          # id, requirements.paseo >= <tested daemon>
  index.client.tsx           # screens, sidebar item, slash command,
                             # Command Center items, panel
  index.server.ts            # server.handle(...) per RPC + registerSettings
  shared/factory.ts          # defineRpc contracts + defineSettings documents
  shared/…
  server/factory/…           # vendored core (planner, discovery, steer…)
  server/handlers.ts         # thin handlers mapping RPC input to core calls
  client/factory-panel.tsx   # status/plan preview/confirm UI
  client/settings-*.tsx      # host + device settings screens
```

RPC set (thin wrapper over the CLI operations in `src/cli.mjs`): read-only first (`factory.status`, `factory.plan`, `factory.switchPreview`), then writes behind stored artifacts (`factory.apply {hash}`, `factory.checkpoint`, `factory.switch {to, apply}`). `requirements.paseo` must track the daemon the RPCs are tested against (today that would be `>=0.16.2`).

## Development checks

Run `npm run typecheck` and `npm test` in `plugin/`. On a test daemon, use `paseo plugin ls` to check that the plugin is running and exercise the contribution and its error state. The plugin’s `factory.ping` RPC reports the daemon subprocess’s Node version, which must be 22 or later.

Receipt lookup verifies the `creation.subscribe` capability (internal `DaemonClient`, `creationLifecycle` feature, response shape) and fails closed. Re-verify it after a Paseo upgrade with the crash test in `docs/configuration.md`.

## Decisions

- Core reuse: dev-time sync, no hand duplication. `npm run plugin:sync` (`scripts/plugin-sync.mjs`) copies `src/*.mjs` except the CLI entry to `plugin/server/factory/*.ts`, rewrites `.mjs` imports to `.js` for the TypeScript bundler resolution, and adds an `@ts-nocheck` banner. `src/` stays the single source of truth; re-run after `src/` changes. Rationale: the plugin compiler only bundles in-package files, and the scaffold typechecks `**/*.ts(x)` only, so `.ts` is the only documented shape; a daemon-side build copy from `../src` fails for Git `:plugin` installs where only the subdir is staged; an npm dependency needs a publish, a shrinkwrap, and npm on the daemon `PATH`; shelling out couples the plugin to an out-of-band binary install.
- Config layering: the file stays the source of truth for `github`, `checkoutRoot`, `runtime`, and `knownLimits`; the host-scope settings document replaces slots, prepare, start steer, and the worker priority list and overlays profiles per name. The server re-validates the merged config with the CLI validator. Settings edits never touch live steers; the panel shows profile drift per steer.
- Writes: `factory.apply` quotes the stored plan hash (stored authorization, same checks as the CLI); `factory.switch` and `factory.checkpoint` quote a preview fingerprint that the server recomputes from fresh state and refuses when stale. `/factory switch --apply` and `/factory checkpoint` only preview; the panel button confirms. RPC names stay lowercase with dots (`factory.switch.preview`).
- Sidebar: registered synchronously; the entry ("Workspace Factory", with a resume counter for the active steer) opens the plugin settings page. The sidebar row uses `client.openSettings(id)` to open the registered plugin settings page with Paseo’s responsive layout and scrolling. Chat display: a host-scope `checkpointInChat` toggle (default on) drives a timeline transformer that collapses CHECKPOINT blocks to one line when off.
- Tab order: read-only recommendation only (steers A-Z, then workers); no layout manipulation, no state file edits.
- Tests: pure logic (`shared/factory-args.ts`, `shared/preview.ts`, `shared/settings-validate.ts`) runs under `node --test` with type stripping; the root script passes `--experimental-strip-types` so Node 22.6+ works too.
- Optional scope address: every `/factory` subcommand resolves the scope of the current workspace when no address is given (server-side, same resolution as the CLI). A workspace without a scope gets a clear error plus the adopting `plan` call. `scopes`/`cleanup` report on the whole instance and take no address.
- Worker guard: the slash command and the four Command Center entries use agent context and reject workers at runtime (parented or `wsf.role=worker`); Paseo shows the refusal as a toast. One extra workspace entry (**Factory: open panel**) keeps the panel reachable from drafts. Tradeoff: the command stays in autocomplete everywhere (the API has no visibility predicate) and is unavailable in drafts. Upstream proposal: an `isAvailable(context)` predicate for `addSlashCommand` (and Command Center items).

## Notification suppression for workers: research

Question: can the plugin suppress Paseo finish notifications for factory workers? Verdict: no, this is a gap. Evidence (read-only, Paseo 0.16.2):

- Plugin hooks: `agent.turn.after` is a non-waiting notification whose handler may change nothing ([hooks](https://paseo.sh/docs/plugins/hooks.md)). No before-hook or lifecycle API touches attention or notifications.
- `requiresAttention` / `attentionReason` are read-only agent snapshot fields ([reference](https://paseo.sh/docs/plugins/reference.md)).
- The public SDK has no notify, mute, or attention API; only the daemon-internal `AgentAttentionRequiredNotification.shouldNotify` exists (`@getpaseo/client`, not exposed to plugins).
- `background: true` hides an agent from tabs, lists, and notifications, but it is creation-only ([SDK](https://paseo.sh/docs/sdk/agents.md)); factory workers are regular tabbed agents and cannot be converted afterwards.
- MCP `create_agent` has `notifyOnFinish: false`, but only for MCP-launched agents ([MCP](https://paseo.sh/docs/mcp.md)).
- An unofficial label hack circulates (internal behavior, may break); not used here.

Upstream proposal: a per-agent notification preference, e.g. a `notifyOnFinish`-like field on agent create/update plus SDK and `paseo agent update` support, or a waiting `agent.attention.before` plugin hook that may suppress the notification.

## Cold cache research

In Claude root sessions, Paseo forwards `/clear` and `/compact` as provider commands and persists the new session ID after a clear. [Command-forwarding evidence](cold-context-resume.md)

(1) Cache TTL. Claude Code requests 1h for the main conversation on a Claude subscription within plan usage, 5min for usage credits, API keys, and cloud providers, and 5min for subagents; it drops to 5min once a subscription draws on usage credits. Overridable per bucket (`promptCacheTtl` / `CLAUDE_CODE_PROMPT_CACHE_TTL`, `subagentPromptCacheTtl`, v2.1.242+); confirm via `usage.cache_creation` (`ephemeral_1h` vs `ephemeral_5m` tokens) ([caching](https://code.claude.com/docs/en/prompt-caching)). Paseo Claude usage counts against the normal Claude plan ([provider](https://paseo.sh/docs/supported-providers/claude-code.md)), so factory steers normally run on the 1h TTL while inside plan usage. Local `claude` here is v2.1.330, above all cited gates.

(2) Idle time and context size per agent. The agent snapshot carries `lastUsage` (`contextWindowUsed/MaxTokens`, cached tokens, cost), `lastUserMessageAt`, `updatedAt`, `status`, `activeTurn.startedAt`, and `attentionTimestamp`. Factory records `lastTurnEndedAt` from `agent.turn.after` to measure how long the agent has been idle.

(3) Claude Code compacts near the context limit and supports idle compaction on the one-hour cache lifetime. Factory’s `compact-warm` mode targets the period before the cache expires, when the compaction request can reuse cached input. A Claude Code `SessionStart` hook can inject the resume brief after `/clear` or compaction. [Claude Code caching](https://code.claude.com/docs/en/prompt-caching) · [Claude Code hooks](https://code.claude.com/docs/en/hooks-reference) · [Factory resume setup](../configuration.md#resume-brief)

For live validation of command effects, see the [provider live checks](../provider-live-check.md).

## Worker supervision

The plugin’s hooks, wakes, watchdog, and failover in `server/supervise.ts` reuse `src/supervision.mjs` through the synced factory copy. Plugin-specific text and scans live in `shared/supervise.ts`. [Supervision design](supervision-design.md)

- `agent.create.after` registers agents started by a labelled scope steer as `running` and writes the immutable worker metadata (`wsf.worker`: scope id, starting steer, epoch, task excerpt); background agents are skipped.
- A second `agent.turn.after` hook transitions supervised workers (CHECKPOINT status, ADVISOR-REQUEST, missing CHECKPOINT, failed/canceled) and wakes the steer that is active at send time: immediately for every actionable outcome (debounced by `wakeDebounceSeconds`), queued during the quiet periods (drain flag, before the boot check). Archived workers lose their entry; steers, unassigned and background agents are ignored; `closed` agents stay supervised.
- The boot check chains `handleBootFinished`: restart marks interrupt workers, then one combined wake per scope lists every interrupted worker.
- `startSupervisionTimer` (10 s tick) flushes due wakes and runs the watchdog every `watchdogMinutes`: backfill adopted workers without an entry, drop archived entries, reconcile restart marks that never got a turn.after (CLI drain marks `planned-restart`, then the daemon restarts), mark idle `running` workers `stale` (wake debounced), and walk the failover chain on unanswered wakes (`answerMinutes`): next slot, then domain, then hub, each asked once with a takeover request (`switch --to <slot> --apply` for steers), logged as checkpoint source `failover`. A completed turn since the wake answers it; a still-running turn waits; anything else fails over.
- No auto-archive: wakes carry an "archive accepted workers" hint listing done workers, and the steer archives per the standing rule. The plugin never calls `archive` and never wakes background agents. Open workers at `maxAutoResumes` continuations add an advisor hint (consult an advisor, then `domain:`/`hub:`).
- Settings (`factory-supervision`, host scope): `enabled` (default on), `wakeDebounceSeconds` (20), `batchMinutes` (0, compatibility), `watchdogMinutes` (15), `staleMinutes` (60), `answerMinutes` (10), `maxAutoResumes` (2). Off silences registration, wakes, and watchdog.
- Idle cleanup uses the register state and skips `running`, `blocked`, and `interrupted` workers (`isSupervisionProtectedState`).
- Limits: the CLI drain does not signal the plugin yet, so drain-quiet currently only engages when set (failover and flush take an explicit `draining` flag; tests cover it) — a drain marker is the follow-up. Like all plugin sends, wakes probably raise the normal attention (see Limits in the supervision design).

## Build a release directory

The snapshot builder produces a content-hashed release directory for installation, distribution, or testing. From the repo root, install the development dependencies and run the builder.

```sh
clear
npm ci --prefix plugin && npm run build-snapshot
```

1. The builder (`scripts/build-snapshot.mjs`) verifies `plugin/server/factory/`, then typechecks and tests the plugin. If the mirror is stale, run `npm run plugin:sync` first. The builder copies the plugin sources into `<releases-dir>/workspace-factory-<hash12>` and omits `node_modules`, `package-lock.json`, and `test/`. The releases dir defaults to `~/projects/paseo/releases` and can be set with `--out-dir`. The sorted list of files and their hashes produces the same 12-character SHA-256 prefix for identical content.
2. The script prints install and rollback commands. The release installs as a directory source. **Removing an existing `workspace-factory` installation deletes its settings.** Save the values you need before running the printed commands. Scripted installation requires `npm run build-snapshot -- --install --confirm <hash12>` with the built hash. [Install a built release](../getting-started.md#install-a-built-release)
3. Use `paseo plugin ls` to check for `running`, `paseo plugin logs workspace-factory` to check startup, and `/factory ping` to check the app connection. `npm run build-snapshot -- --prune` previews cleanup of old snapshots while keeping the installed and previous snapshots. Deletion requires `--prune --confirm`.

Never edit Paseo state files directly.

## Measuring warm compaction

On approved scratch sessions with similar chat lengths, leave one session idle until the cache expires and compact the other before expiry. Send the same small prompt after the same idle duration in both sessions and compare first-turn token usage with `paseo inspect`. Record the provider, model, idle interval, and cached and uncached input counts. [Provider live checks](../provider-live-check.md)
