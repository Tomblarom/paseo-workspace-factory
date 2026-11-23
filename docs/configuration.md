# Configuration

The config is looked up in this order: `--config <path>`, `$PASEO_FACTORY_CONFIG`, `$XDG_CONFIG_HOME/paseo-workspace-factory/config.json` (default `~/.config/paseo-workspace-factory/config.json`). Start from [`config.example.json`](../config.example.json). Keep it outside the repository; it is personal.

## Fields

| Field | Description |
|---|---|
| `version` | `1` |
| `github.owner` | Account that owns the forks. |
| `github.cloneProtocol` | `https` or `ssh`. |
| `github.upstreamRemote` | Remote name for the parent repository (usually `upstream`). |
| `checkoutRoot` | Absolute directory below which repositories are cloned. |
| `workspaceTitle` | Template for the main workspace title (`{name}`, `{subject}`; default `Main`). |
| `handoffLanguage` | `en` (default) or `de`. |
| `profiles.<name>` | `provider`, `model`, `thinking` (or `null` for the provider default), `mode`. Validated against the live provider catalog before a steer is planned. |
| `knownLimits` | Optional extra catalog exceptions (same shape as the built-in list, see below). |
| `steers.slots` | Slot letter (A–Z) → profile name. Changing a slot's profile does not change an existing steer; the plan only reports the difference. Default is a single steer `A`; add `B`, `C`, … with their profiles as needed. |
| `steers.prepare` | Slots created for every repository (default `["A"]`). Overridden per run with `plan --slots` (must be a subset of defined slots). |
| `steers.initialActive` | Active steer after provisioning (must be in `prepare`; with `--slots` it falls back to the first slot when needed). |
| `workers.defaultProfile` | Profile name for workers. |
| `advisors.profiles` | Optional purpose → profile name mapping for second opinions (see below). |
| `usage.warnContextTokens` | Optional positive integer (default off): `status` warns for agents above it, with a switch/fresh recommendation. |
| `runtime.stateDir` | Plans, progress, journals and locks (default `$XDG_STATE_HOME/paseo-workspace-factory`). |
| `runtime.scratchDir` | Scratch repositories of live tests (default `<stateDir>/scratch`). |
| `runtime.paseo.url` | Daemon WebSocket URL (default `ws://127.0.0.1:6767/ws`). |
| `runtime.paseo.bin` | `paseo` CLI (default `paseo` on PATH); its installation also provides the SDK. |
| `runtime.paseo.passwordFile` | File with the daemon password, if the daemon requires one. |

Environment overrides: `PASEO_FACTORY_STATE_DIR`, `PASEO_FACTORY_SCRATCH_DIR`, `PASEO_WS_URL`, `PASEO_FACTORY_PASEO_BIN`, `PASEO_PASSWORD_FILE`, `PASEO_PASSWORD`.

Per-run slot selection: `plan <repo> --slots D` (comma-separated, e.g. `--slots B,D`) plans only those slots instead of `steers.prepare`. `--adopt X=<agent-id>` accepts any slot defined in `steers.slots`; adopting a slot outside `prepare` plans only the adopted slot(s), not the rest of `prepare`.

## Label and metadata prefix

Factory labels and metadata keys use the neutral `wsf.*` prefix (see [concepts](concepts.md)). Records created by the pilot still carry `ari.wsf.*`: they are read transparently and a normal `plan` proposes `labels.migrate` ops to rewrite them. No configuration is needed.

## Scopes

Every entry plans a scope of one kind:

| Kind | Id | Locator | Provisioning |
|---|---|---|---|
| `github` | `owner/repo` | the fork | fork, clone, upstream remote, project, main workspace |
| `dir` | `--name` else folder | directory | project (if missing), main workspace |
| `workspace` | `--name` else `<parent>@<branch>` else folder | existing workspace id | metadata only; no new project or workspace |
| `hub` | `--name` else `hub` | directory or workspace | like `dir`/`workspace`; at most one live hub per host |

Commands address a scope by id first, then by `wks_…`/`workspace:<id>`, then by path, then by the legacy `local/<folder>` alias (input only; usage prints a deprecation note). An id already used by another live scope — or by two entries of one run — is a conflict resolved with `--name`.

## Local mode

A repository entry with a local directory needs no GitHub repository:

```json
[{ "local": "/path/to/project" }]
[{ "local": "/path/to/project", "name": "notes" }]
```

```sh
paseo-factory plan --local /path/to/project --local /path/to/other
paseo-factory plan --local /path/to/project --name notes
```

The path must exist (a git checkout or a plain folder). The factory makes no `gh` calls and plans no fork, clone or upstream remote. Each entry becomes a scope of kind `dir` with the scope id `--name` (or per-entry `"name"`) else the folder name; `--name` needs exactly one entry while repos-file entries may each carry their own `"name"`. `local/<folder>` stays an input alias only. Planned are only the Paseo project registration (when missing), the main workspace (created or adopted, with the scope id in its metadata) and the steer slots (including `--adopt`, `--adopt <scope-id>:A=<agent-id>` with several entries, and `--slots`). The plan hash and the stored authorization cover the entries, so `apply --confirm <hash>` runs without GitHub as well. A scope id already used by another live scope (or by two entries of one run) is a conflict resolved with `--name`.

## Worktree workspaces

An existing Paseo worktree workspace (`workspaceKind: worktree`, usually a Paseo-owned worktree below the daemon's worktree directory) can be adopted as the factory main workspace instead of creating a duplicate project workspace. Point a local entry at its directory or at its workspace id:

```json
[{ "local": "/path/to/worktree-dir" }]
[{ "workspace": "wks_0123456789abcdef" }]
```

```sh
paseo-factory plan --local /path/to/worktree-dir
paseo-factory plan workspace:wks_0123456789abcdef
```

The scope id is `--name` (or per-entry `"name"`), else `<parent>@<branch>` — the parent from the owning project checkout (a github scope when its origin parses to `owner/repo`, else a dir scope for the project folder, else no parent) plus the worktree branch — else the worktree folder (detached or unreadable branch). `status`, `checkpoint`, `switch`, `fresh` and `workers` accept the scope id as well as the `local/<folder>` alias and the workspace id (`workspace:<id>` or the bare `wks_...` id). The plan registers no new Paseo project and creates no duplicate workspace: it sets the factory metadata including the scope on the existing worktree workspace (`workspace.main.adopt`, or the non-destructive `workspace.main.scope` top-up when metadata without a scope exists) and plans the steer slots as usual (`Steer A` titles, `--adopt` for unlabelled candidates, `--slots` for a subset). New steers are labelled `wsf.scope=<id>` next to `wsf.repo`; steers labelled with the legacy `local/<folder>` name keep matching. Existing agents of the workspace are only listed in the plan notes for reuse by id; they are never renamed or archived. Discovery without a worktree match behaves exactly as before; when several directories or workspaces share a folder name, `local/<folder>` is a conflict and the full path, the scope id or the workspace id disambiguates.

## Workspace titles

`workspaceTitle` is a template for the main workspace title (default `"Main"`): `{name}` is the scope short form (the repo name for github, else the scope id), `{subject}` the entry subject (`--subject <text>` with one entry, or per-entry `"subject"` in repos-file). New workspaces are created with the rendered title. An existing main workspace with a deviating title is only reported; `plan --retitle` plans a `workspace.retitle` op (native workspace rename, verified after). A template needing `{subject}` without one, or with an unknown placeholder, is a plan conflict. `--rename-project <name>` (one entry) plans a `project.rename` op onto the scope project, but only when the project already exists and the name differs.

## Hub scope

`plan --hub <path|workspace:<id>> [--name]` creates or adopts a scope of kind `hub` (default id `--name` else `hub`); at most one hub scope lives on a host, anything beyond is a conflict. An existing dir scope converts in place with `plan --hub <same path>`: the `scope.convert` op rewrites only the scope field to kind `hub` (keeping the id unless `--name` renames), while steers, epoch and checkpoint stay untouched. Only dir scopes convert; hub operations never write into member scopes.

## Worker adoption

`plan --adopt-worker <agent-id>[@<slot>]` (one entry) labels any live, unlabelled agent as a scope worker (`wsf.scope`, `wsf.role=worker`, `wsf.owner=<slot>`, defaulting to the active steer); agents in other workspaces are allowed and stay where they are — Paseo cannot move them. Already-adopted workers are reported, anything else labelled is a conflict. A legacy `Steer X` candidate with a parent stays a conflict unless `--detach` plans a native `agent detach` op first (parent freedom verified after, then the adoption labels it). `status` and `workers` list labelled workers including a foreign workspace.

## Assigning work to a scope

`assign <scope> --task <text> [--test <text>]... [--blocker <text>]... [--next <text>]` previews a hub→scope assignment; `--apply` writes the scope checkpoint and delivers it to the active scope steer (skip delivery with `--no-send`). The write is epoch-checked: apply re-reads the scope state under the workspace lock and refuses when the epoch or active steer moved since discovery. `--expect-epoch <n>` additionally binds apply to the previewed epoch. Retired scopes refuse (naming the `movedTo` successor); a running steer still receives the assignment, since delivery only queues a message.

## Resume brief

`resume [scope] [--agent <id>] [--json]` prints a cold-start brief instead of re-reading history: scope header with caller role, checkpoint (task, next, tests, blockers, source, age) with stale/interrupted warnings, git state, worker notes and open `hub:` items — at most 6000 characters. An explicit scope wins; otherwise the scope defaults to the calling agent's `wsf.scope` label, else its workspace, and the agent to `PASEO_AGENT_ID`. Per-agent turn/note/interrupt records live in `wsf.agents` (written under the workspace lock; bounded excerpts); a fresh checkpoint clears the interrupted flag (except source `auto`, which never clears it), and `switch`/`fresh` handoffs carry the brief when the checkpoint is interrupted.

Optional setup (the instruction rule stays the fallback; the factory never changes host settings): a Claude Code SessionStart hook can print the brief into the fresh context automatically after `/clear` or `/compact` (hook `source` `clear`|`compact`; verify on first use). Sketch for the user settings:

```json
"hooks": {
  "SessionStart": [
    { "matcher": "clear", "hooks": [{ "type": "command", "command": "paseo-factory resume" }] },
    { "matcher": "compact", "hooks": [{ "type": "command", "command": "paseo-factory resume" }] }
  ]
}
```

Use the absolute binary path when `paseo-factory` is not on the hook's `PATH`; inside factory agent sessions `PASEO_AGENT_ID` resolves scope and agent.

## Advisors

Second opinions ("Advisor") are policy only: the factory creates no advisor
agents itself. Steers brief advisors through the native Paseo advisor
mechanism (skill `paseo-advisor`); workers that get stuck end their answer
with an `ADVISOR-REQUEST` block and stop, and the steer decides whether to
answer, reject, or consult an advisor. Format and limits (read-only, close
after the answer, sanitized context only) live in
[steer instructions](steer-instructions.md#advisor-policy).

Optional `advisors.profiles` maps an advisor purpose to a factory profile
from `profiles` (validated on load; unknown profiles are rejected):

```json
"advisors": {
  "profiles": { "design": "senior-reviewer", "routine": "cheap" }
}
```

Without a mapping the steer lets the skill match its own profiles. The
factory never launches advisors by itself and never reports their usage.

## Managing models from the CLI

The same catalog check the planner uses is available without editing JSON:

```sh
paseo-factory models [--json]   # live providers, models, thinking options, modes
paseo-factory slot set B copilot/claude-sonnet-5.5 --mode allow-all [--thinking high] [--profile name] [--dry-run]
paseo-factory slot rm B [--dry-run]
paseo-factory worker-default <profile|provider/model> [--thinking X] [--mode Y] [--profile name] [--dry-run]
```

`slot set` creates or updates a profile (named by `--profile`, otherwise the slot's current profile, or `<provider>-<model>` for a new slot) and points the slot at it after validating against the live catalog including `knownLimits`. Omitted `--thinking`/`--mode` keep the stored value (new profiles default to `"thinking": null` and no mode); use `--thinking null` for the provider default. Changing a slot never changes an existing steer; the next plan reports the difference. `slot rm` keeps the profile and repairs `prepare`/`initialActive`. Writes are atomic (tmp + rename, file mode kept); `--dry-run` prints the new config instead of writing it.

## Known provider exceptions

Some settings appear in the catalog but are rejected when an agent is created. The factory reports these during planning as a `steer.<slot>` conflict (`Profile "<name>" for Steer <slot> is not startable: <reason>`), so the plan stops before apply instead of failing there:

- Copilot with Claude models rejects a thinking level — use `"thinking": null`.

Extend the built-in list with optional `knownLimits` (validated on load; an entry needs `provider`, `model` and/or `modelPattern`, `field` (`thinking` or `mode`), and `reason`):

```json
"knownLimits": [
  { "provider": "example", "modelPattern": "^large-", "field": "thinking", "reason": "Example provider rejects thinking for large models; use thinking: null" }
]
```

`model` matches exactly, `modelPattern` is a regular expression against the model id; when both are given, both must match. A rule only fires when the profile actually sets that field.

## Version binding

The receipt lookup (`lookupCreationReceipt` in `src/paseo.mjs`) speaks the internal `creation.subscribe` protocol message, which Paseo exposes only through the internal `DaemonClient` (the public SDK uses it itself to reattach to running creations). Its shape is not covered by the public SDK contract, so the lookup is pinned to tested releases and fails closed:

- Before use it verifies the installed `@getpaseo/client` version (the SDK shipping with `runtime.paseo.bin`) and, after connecting, the daemon version plus the `creationLifecycle` feature flag.
- Any version outside `RECEIPT_LOOKUP_TESTED_VERSIONS` (currently `0.16.2`), a missing feature flag, or a failed import, connect or exchange aborts with an error — the lookup never reports "no receipt" on failure, so `apply` never re-creates without a receipt.

After a Paseo upgrade, re-run the crash test below; only extend `RECEIPT_LOOKUP_TESTED_VERSIONS` once it passes.

Idempotency keys use the `wsf:` namespace (`wsf-it:` and `wsf-crash:` in the live tests). An apply interrupted before the rename from `ari-wsf:` must be replanned: stored authorizations hash their keys, so the old plan no longer matches and `apply` refuses it.

## Cleanup

`cleanup` reports candidates over the whole instance, one line each with a loss inventory (live agents and running turns, Paseo-owned worktree, git state): scratch scopes (label `wsf.scratch`, set by the live tests), workspaces with a missing directory, empty projects, several projects on one path, `non_git` projects without a scope, and retired factory scopes. It never writes.

`cleanup --plan [--allow-destructive] [--allow-ignored] [--only <id,...>]` turns the report into a hash-confirmed plan stored like `plan` (`apply --confirm <hash>` runs it). Ops: `workspace.archive` (native archive), `project.delete` (only for projects empty then or emptied by the plan's own archives), `scope.retire` (non-destructive: sets `retired: true`, clears the active steer, agents stay; currently planned by no flow, reserved for relocate). Destructive ops are listed separately with their loss inventory. Without `--allow-destructive` they become hints instead; duplicate paths, scopeless projects, orphan scratch agents and missing-directory worktrees always stay hints (human choice, no `agent.archive` op, unverifiable git state). Apply re-checks every destructive op right before running it — no running agents (never archived), no new agents since plan, clean worktree without unpushed commits, empty project — and any drift stops the run instead of skipping the op. Ignored files are inventoried with count and first paths; archiving a worktree with ignored files outside the build allowlist (`node_modules`, `dist`, `build`, `target`, `__pycache__`, `.venv`) refuses unless the plan carries explicit `allowIgnored` (`--allow-ignored`, hashed). Archived agents alone are recoverable (soft-delete), but deleting their project destroys them permanently: `project.delete` inventories archived members, marks its summary irreversible, and verifies them against the plan.

## Relocate

`relocate <scope> --to <path|project> [--apply]` moves a scope: a new main workspace at the target (created, or adopted when bare), fresh steers of every live slot with the checkpoint handoff, and the old scope retired with `movedTo` (the target directory). The filesystem move itself is the operator's job — the target directory must already exist. Preview is the default; `--apply` executes under the old workspace lock with receipt recovery, so a retry resumes instead of duplicating. Archival of the old scope goes through `cleanup --plan`, never automatically; until then the slot is held twice (switch/plan refuse the ambiguity) and the scope id resolves ambiguously, so address the new scope by workspace id or path. Retired scopes refuse coordination (`switch`, `fresh`, `assign`) and steer planning; `status` shows `RETIRED → movedTo`. Opt-in live check on scratch resources only: `WSF_LIVE_CLEANUP_PLAN=approved node test/integration-cleanup-plan.mjs`.

## Live tests

Not part of `npm test`; each needs an explicit approval variable and keeps everything it creates:

| Command | What it does |
|---|---|
| `WSF_LIVE_WRITE=approved node test/integration-live.mjs` | Scratch repo, one workspace, one agent without prompt: idempotency, key conflict, parent freedom, metadata read-back. |
| `WSF_LIVE_CRASH=approved node test/integration-crash.mjs` | Real apply runner killed right after the workspace create; a new process recovers the id through the receipt. |
| `WSF_LIVE_CLEANUP=approved node test/integration-live.mjs --cleanup <manifest>` | Fail-closed cleanup: archives only fully verified scratch resources; never deletes files. |
