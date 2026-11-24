# Factory Paseo plugin — design

New to the factory? Start with [Getting started](getting-started.md); this page is the detailed reference.

Status: implemented in `plugin/` (built, typechecked, installed as a snapshot).

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
| (d) Settings screen for steer slots / worker default profile, catalog-backed, sidebar entry default off | Feasible via `addSettingsScreen` + `defineSettings` (`host` scope; `device` scope for the sidebar toggle); provider catalog via `paseo.providers` |
| (e) Agent tab order (Steers A..Z, then workers by number) | No native interface; Paseo owns tabs. Convention + read-only panel only; never edit state files |
| (f) `pluginsEnabled` prerequisite | Describe only (done below). Not enabled by this task; nothing installed |

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

This preserves the factory safety model (dry-run first, confirmed plan only; see [docs/concepts.md](concepts.md)): the hash is the confirmation token, and stage two never runs without stage one's stored artifact.

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
- Persistence location and lifetime: ordinary host-side JSON per installation. "Values survive daemon restart, plugin reload, disable, and updates. Removing an installation deletes its settings." Not a credential vault; settings RPCs use the `daemon.manage` permission.
- Scope: `"host"` documents are shared by authorized clients; `"device"` documents stay on one device and are explicitly "for layout preferences".

Design:

- `host`-scope documents for the factory configuration: `factory-config` (steer slots `A`–`Z` → profile name, `prepare` list, `initialActive`, worker `priority` list, profiles with advisor/sensitive flags, quota), plus `factory-cleanup`, `factory-resume` and `factory-supervision` for idle cleanup, resume and supervision. Schema defaults must make `{}` parse into a complete document (define a single-steer-`A` default mirroring `config.example.json`).
- Catalog-backed selects via the handler/client `paseo.providers` API ([SDK](https://paseo.sh/docs/sdk/reference.md#clientproviders)): `snapshot()` (the factory already consumes `result.entries` in `readPaseoState`), `listModels`, `listModes`, `listFeatures`, `waitForReady`; reuse the `validateProfilesAgainstCatalog` logic for the same "not startable" conflicts the CLI reports.
- Sidebar entry default off: `addSidebarHeaderItem`/`addSidebarFooterItem` take only `{ id, title, Component }` — there is no static default-hidden flag, and Settings → Sidebar reorder/hide is user-owned. The native way to default off is runtime registration: both add-functions "work after the entry returns" and return a remover, "the item appears and disappears without a reload" ([reference](https://paseo.sh/docs/plugins/reference.md#add-and-remove-items-at-runtime)). Drive that from a `device`-scope `sidebarVisible` setting defaulting to `false`, toggled from the settings screen. The settings stay reachable via the plugin row cog either way.
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
  index.client.tsx           # screens, sidebar item (runtime), slash command,
                             # Command Center items, panel
  index.server.ts            # server.handle(...) per RPC + registerSettings
  shared/factory.ts          # defineRpc contracts + defineSettings documents
  shared/…
  server/factory/…           # vendored core (planner, discovery, steer…)
  server/handlers.ts         # thin handlers mapping RPC input to core calls
  client/factory-panel.tsx   # status/plan preview/confirm UI
  client/settings-*.tsx      # host + device settings screens
```

RPC set (thin wrapper over the CLI operations in `src/cli.mjs`): read-only first (`factory.status`, `factory.plan`, `factory.switchPreview`), then writes behind stored artifacts (`factory.apply {hash}`, `factory.checkpoint`, `factory.switch {to, apply}`). `requirements.paseo` must track the daemon the RPCs are tested against (today that would be `>=0.16.2`, following the receipt-lookup pin).

## Implementation steps

Small, each independently verifiable (`npm run typecheck`, install/reload on a test daemon, `paseo plugin ls` shows `running`, exercise the contribution including its error state):

1. Scaffold + ping: `paseo plugin init`, one `factory.ping` RPC, no factory logic. Proves the boundary, toolchain, and daemon Node version.
2. Read-only core: vendor planner/discovery/steer read paths under `server/factory/`; add `factory.status` + `factory.plan` RPCs, the `factory` slash command (status/plan), and the preview panel showing the plan hash.
3. Command Center items for the same reads (workspace context).
4. Settings screens: host-scope slots/profile document with catalog-backed selects; device-scope sidebar toggle defaulting to off; runtime sidebar add/remove.
5. Writes: `factory.apply {hash}`, `factory.checkpoint`, `factory.switch`, each requiring the stage-one artifact; confirm buttons in the panel plus `/factory apply <hash>` / `/factory switch --to B --apply`.
6. Docs and packaging: `OVERVIEW.md`, manifest requirements, install instructions for a directory/Git source; re-verify the receipt pin on the target daemon.

## Open questions

- Daemon subprocess Node version on every target host (must satisfy `>= 22`); `factory.ping` reports it, verify before installing.
- Pilot distribution: directory install vs Git source with `:plugin` suffix; registry submission is out of scope for the pilot.
- Receipt pin re-verification on the target daemon (still `0.16.2`).

## Decisions

- Core reuse: dev-time sync, no hand duplication. `npm run plugin:sync` (`scripts/plugin-sync.mjs`) copies `src/*.mjs` except the CLI entry to `plugin/server/factory/*.ts`, rewrites `.mjs` imports to `.js` for the TypeScript bundler resolution, and adds an `@ts-nocheck` banner. `src/` stays the single source of truth; re-run after `src/` changes. Rationale: the plugin compiler only bundles in-package files, and the scaffold typechecks `**/*.ts(x)` only, so `.ts` is the only documented shape; a daemon-side build copy from `../src` fails for Git `:plugin` installs where only the subdir is staged; an npm dependency needs a publish, a shrinkwrap, and npm on the daemon `PATH`; shelling out couples the plugin to an out-of-band binary install.
- Config layering: the file stays the source of truth for `github`, `checkoutRoot`, `runtime`, and `knownLimits`; the host-scope settings document replaces slots, prepare, start steer, and the worker priority list and overlays profiles per name. The server re-validates the merged config with the CLI validator. Settings edits never touch live steers; the panel shows profile drift per steer.
- Writes: `factory.apply` quotes the stored plan hash (stored authorization, same checks as the CLI); `factory.switch` and `factory.checkpoint` quote a preview fingerprint that the server recomputes from fresh state and refuses when stale. `/factory switch --apply` and `/factory checkpoint` only preview; the panel button confirms. RPC names stay lowercase with dots (`factory.switch.preview`).
- Sidebar: device-scope `visible` defaulting to off, runtime add/remove; the entry ("Workspace Factory", with a resume counter for the active steer) opens the plugin settings page. Limit: sidebar props offer `openScreen` only — `openSettings(id)` exists solely on command contexts — so a dedicated screen hosts the same settings component. Startup sync reads the device document and stays hidden when unreadable.
- Tab order: read-only recommendation only (steers A-Z, then workers); no layout manipulation, no state file edits.
- Tests: pure logic (`shared/factory-args.ts`, `shared/preview.ts`, `shared/settings-validate.ts`) runs under `node --test` with type stripping; the root script passes `--experimental-strip-types` so Node 22.6+ works too.
- Optional scope address: every `/factory` subcommand resolves the scope of the current workspace when no address is given (server-side, same resolution as the CLI). A workspace without a scope gets a clear error plus the adopting `plan` call. `scopes`/`cleanup` report on the whole instance and take no address.
- Worker guard: the slash command and the four Command Center entries use agent context and reject workers at runtime (parented or `wsf.role=worker`); Paseo shows the refusal as a toast. One extra workspace entry ("Factory: Panel öffnen") keeps the panel reachable from drafts. Tradeoff: the command stays in autocomplete everywhere (the API has no visibility predicate) and is unavailable in drafts. Upstream proposal: an `isAvailable(context)` predicate for `addSlashCommand` (and Command Center items).
- Release snapshots are scripted (M5) but never auto-installed: `npm run build-snapshot` verifies the mirror, typecheck and plugin tests, builds the content-hashed snapshot, and prints the `remove`/`install`/rollback commands for explicit execution, so the settings-wiping `remove` step stays visible; installation and prune deletion only happen with `--confirm`.

## Notification suppression for workers: research

Question: can the plugin suppress Paseo finish notifications for factory workers? Verdict: no, this is a gap. Evidence (read-only, Paseo 0.16.2):

- Plugin hooks: `agent.turn.after` is a non-waiting notification whose handler may change nothing ([hooks](https://paseo.sh/docs/plugins/hooks.md)). No before-hook or lifecycle API touches attention or notifications.
- `requiresAttention` / `attentionReason` are read-only agent snapshot fields ([reference](https://paseo.sh/docs/plugins/reference.md)).
- The public SDK has no notify, mute, or attention API; only the daemon-internal `AgentAttentionRequiredNotification.shouldNotify` exists (`@getpaseo/client`, not exposed to plugins).
- `background: true` hides an agent from tabs, lists, and notifications, but it is creation-only ([SDK](https://paseo.sh/docs/sdk/agents.md)); factory workers are regular tabbed agents and cannot be converted afterwards.
- MCP `create_agent` has `notifyOnFinish: false`, but only for MCP-launched agents ([MCP](https://paseo.sh/docs/mcp.md)).
- An unofficial label hack circulates (internal behavior, may break); not used here.

Upstream proposal: a per-agent notification preference, e.g. a `notifyOnFinish`-like field on agent create/update plus SDK and `paseo agent update` support, or a waiting `agent.attention.before` plugin hook that may suppress the notification.

## Cold cache research (C1)

Read-only. Command forwarding (`/clear` and `/compact` reach root sessions; a new Claude session id is accepted and persisted) is settled by code findings, see the Evidence table in [cold-context-resume.md](cold-context-resume.md). Remaining points:

(1) Cache TTL. Claude Code requests 1h for the main conversation on a Claude subscription within plan usage, 5min for usage credits, API keys, and cloud providers, and 5min for subagents; it drops to 5min once a subscription draws on usage credits. Overridable per bucket (`promptCacheTtl` / `CLAUDE_CODE_PROMPT_CACHE_TTL`, `subagentPromptCacheTtl`, v2.1.242+); confirm via `usage.cache_creation` (`ephemeral_1h` vs `ephemeral_5m` tokens) ([caching](https://code.claude.com/docs/en/prompt-caching)). Paseo Claude usage counts against the normal Claude plan ([provider](https://paseo.sh/docs/supported-providers/claude-code.md)), so factory steers normally run on the 1h TTL while inside plan usage. Local `claude` here is v2.1.330, above all cited gates.

(2) Idle time and context size per agent. The agent snapshot carries `lastUsage` (`contextWindowUsed/MaxTokens`, cached tokens, cost), `lastUserMessageAt`, `updatedAt`, `status`, `activeTurn.startedAt`, and `attentionTimestamp` (`AgentSnapshotPayload`, `@getpaseo/protocol/messages`; `AgentUsage`, `@getpaseo/protocol/agent-types`). Idle time derives from status plus timestamps; there is no explicit last-turn-ended field, so C2 records `lastTurnEndedAt` from `agent.turn.after`.

(3) Native counterparts, use first. Claude Code compacts automatically near the limit (on by default, `/autocompact` window in settings) and can compact long idle conversations on the 1h TTL (`idleCompaction` setting, v2.1.290+); a cold `/compact` reprocesses history uncached, so `compact-warm` must run before TTL expiry ([caching](https://code.claude.com/docs/en/prompt-caching), [commands](https://code.claude.com/docs/en/commands)). `SessionStart` hooks fire on startup, resume, and after `/clear` or compaction (`source: startup|resume|clear|compact|fork`), and their stdout becomes context Claude sees; `PreCompact` stdout steers the summary ([hooks](https://code.claude.com/docs/en/hooks-reference)). Prefer a `SessionStart` hook (source `clear`/`compact`) that injects the C3 briefing over instruction text alone. Paseo resumes provider sessions after daemon restart via `agent.open.before`, which can also set env such as the TTL variables ([hooks](https://paseo.sh/docs/plugins/hooks.md)).

Recommendation for C2-C6 stands as in [cold-context-resume.md](cold-context-resume.md): build C2/C3/C4/C6 without new measurements; gate C5 on one approved scratch-agent run (timeline marker vs deletion, attention outcome, context numbers); keep `mode` default `off` until C7 measures. No live checks were run for C1; C1/C7 live checks need user approval for scratch agents.

## Worker supervision (S-B)

The plugin side of [supervision](supervision-design.md): `server/supervise.ts` (hooks, wakes, watchdog, failover) reuses the S-A core through the synced factory copy (`server/factory/supervision.js`, single source `src/supervision.mjs`), never duplicating its rules; plugin-only text and scans (worker metadata, ADVISOR-REQUEST detection, archive hint, takeover requests, answered/busy/unanswered) live in `shared/supervise.ts`, where plain `node:test` reaches them.

- `agent.create.after` registers agents started by a labelled scope steer as `running` and writes the immutable worker metadata (`wsf.worker`: scope id, starting steer, epoch, task excerpt); background agents are skipped.
- A second `agent.turn.after` hook transitions supervised workers (CHECKPOINT status, ADVISOR-REQUEST, missing CHECKPOINT, failed/canceled) and wakes the steer that is active at send time: immediately for every actionable outcome (debounced by `wakeDebounceSeconds`), queued during the quiet periods (drain flag, before the boot check). Archived workers lose their entry; steers, unassigned and background agents are ignored; `closed` agents stay supervised.
- The boot check chains `handleBootFinished`: restart marks interrupt workers, then one combined wake per scope lists every interrupted worker.
- `startSupervisionTimer` (10 s tick) flushes due wakes and runs the watchdog every `watchdogMinutes`: backfill adopted workers without an entry, drop archived entries, reconcile restart marks that never got a turn.after (CLI drain marks `planned-restart`, then the daemon restarts), mark idle `running` workers `stale` (wake debounced), and walk the failover chain on unanswered wakes (`answerMinutes`): next slot, then domain, then hub, each asked once with a takeover request (`switch --to <slot> --apply` for steers), logged as checkpoint source `failover`. A completed turn since the wake answers it; a still-running turn waits; anything else fails over.
- No auto-archive: wakes carry an "archive accepted workers" hint listing done workers, and the steer archives per the standing rule. The plugin never calls `archive` and never wakes background agents. Open workers at `maxAutoResumes` continuations add an advisor hint (consult an advisor, then `domain:`/`hub:`).
- Settings (`factory-supervision`, host scope): `enabled` (default on), `wakeDebounceSeconds` (20), `batchMinutes` (0, compatibility), `watchdogMinutes` (15), `staleMinutes` (60), `answerMinutes` (10), `maxAutoResumes` (2). Off silences registration, wakes, and watchdog.
- C5 feeds the register state into the cleanup decision and skips `running`/`blocked`/`interrupted` workers (`isSupervisionProtectedState`).
- Limits: the CLI drain does not signal the plugin yet, so drain-quiet currently only engages when set (failover and flush take an explicit `draining` flag; tests cover it) — a drain marker is the follow-up. Like all plugin sends, wakes probably raise the normal attention (see Limits in the supervision design).

## Update flow

The live instance runs a snapshot install: a content-hashed copy of the plugin sources under `<releases-dir>/workspace-factory-<hash12>`, installed with id `workspace-factory`. To ship a new snapshot (decided by the user, never automatically), run from the repo root:

1. `npm run build-snapshot` (`scripts/build-snapshot.mjs`). It fails when `plugin/server/factory/` is stale (re-run `npm run plugin:sync` first), then runs `npm run typecheck` and the plugin tests in `plugin/`, then builds the snapshot: a copy of `plugin/` without `node_modules`, `package-lock.json` and `test/` under `<releases>/workspace-factory-<hash12>` (default releases dir `~/projects/paseo/releases`, `--out-dir` overrides it). hash12 is the first 12 hex chars of sha256 over the sorted file list with file hashes, so identical content gives an identical directory and rebuilding is a no-op.
2. The script prints the exact install commands and the rollback command (previous snapshot from `paseo plugin ls --json`, text fallback) and never installs by default. Run the printed `paseo plugin remove workspace-factory` and `paseo plugin install <snapshot>` yourself (an already installed id is rejected, so remove first). Warning: removing deletes the installation's settings; note the slots/profiles first and re-enter them afterwards. Scripted installation exists only as `npm run build-snapshot -- --install --confirm <hash12>` naming the built hash.
3. Verify with `paseo plugin ls` (status `running`) and `paseo plugin logs workspace-factory` (clean start, `Plugin ready`); `/factory ping` answers; reload the app. Old snapshots: `npm run build-snapshot -- --prune` previews the cleanup (keeps the installed and the previous snapshot); files are deleted only with `--prune --confirm`.

Never edit Paseo state files directly.

## C7 measurement (manual procedure)

Needs a scratch agent and more than one hour of idle time, so it is not automated: send the same small prompt after >1 h idle once without and once with cleanup (`/compact`), compare first-turn token usage from `paseo inspect`, record the result here, then decide the default for `idleCleanup.mode` (stays `off` until measured).
