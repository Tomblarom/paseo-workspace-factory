# Configuration

New to the factory? Start with [Getting started](getting-started.md); this page is the detailed reference.

Factory configuration lives in Paseo under Settings → Plugins → Factory. The host settings hold profiles, separate steer, advisor and worker priorities, quota thresholds, GitHub owner and checkout root. Workspace membership and authority come from the live agents and the scope's recorded holder and epoch. The agent CLI reads those settings through the running plugin. The legacy Factory configuration file is ignored.

## Fields

| Field | Description |
|---|---|
| `version` | `1` |
| `github.owner` | Account that owns the forks (scope identity and visibility checks). |
| `github.cloneProtocol`, `github.upstreamRemote`, `workspaceTitle`, `workspaceTitleMultiRepo` | Ignored since bulk provisioning was removed. |
| `checkoutRoot` | Absolute directory that scopes checkouts against; also a scan root for discovery. |
| `handoffLanguage` | Fixed `en` (override per switch with `--language`). |
| `profiles.<name>` | `provider`, `model`, `thinking` (or `null` for the provider default), `mode`, `advisor` (boolean, default `false`), `sensitive` (boolean, default `false`; `muse` profiles migrate to `true` unless set). Validated against the live provider catalog before a steer is planned. Advisor-tagged profiles are second-opinion candidates; they are never picked for workers or non-advisor slots (see [Advisors](#advisors) and [Managing models](#managing-models-from-the-cli)). Sensitive profiles only get sanitized technical tasks (see [Privacy](#privacy-sensitive-profiles)). |
| `knownLimits` | Built-in catalog exceptions only (see below); not configurable. |
| `steers.priority`, `advisors.priority` | Ordered profile names for coordinator and advisor creation. Live membership supplies the steer letters. |
| `steers.slots`, `steers.prepare`, `steers.initialActive` | Legacy slot presets retained for saved plans and older commands. Current enrollment reads live workspace membership. |
| `steers.activeMarker` | Tab-title prefix on the active steer (`▷ Steer E`; default `"▷"`). `switch --apply` and resume-takeover move the marker between live tabs. Fresh gives the replacement the active marker; empty disables the marker. Title matching tolerates the prefix. |
| `workers.priority` | Ordered profile-name list for workers, highest priority first. A missing `priority` reads as `[defaultProfile]`; writing sets `defaultProfile` to `priority[0]` for older readers. |
| `workers.defaultProfile` | First entry of `workers.priority`, kept for backwards compatibility. Prefer `workers.priority`. |
| `usage.warnContextTokens` | No longer read. |
| `quota.warnPct` / `quota.exhaustedPct` | Session quota warning/exhaustion thresholds (defaults `93` and `95`). |
| `profiles.<name>.pool` | Pools default to the profile's provider; profiles in one pool share availability and failover preference. |
| `wsf.profileHealth` (workspace metadata) | Runtime-only profile failure marks, written under the workspace lock from a fresh read as their own top-level key (never inside the `wsf` scope state, so a concurrent switch/epoch is kept). `worker pick --failed <profile> --reason <text>` records the failure; the profile is skipped for 10 minutes with its classified reason, without changing config or the provider catalog. A legacy nested `profileHealth` field inside the `wsf` scope state is still read. |
| `runtime.stateDir` | Plans, progress, journals and locks (default `$XDG_STATE_HOME/paseo-workspace-factory`, override with `PASEO_FACTORY_STATE_DIR`). Not in the plugin settings. |
| `runtime.paseo.url` | Daemon WebSocket URL (default `ws://127.0.0.1:6767/ws`, override with `PASEO_WS_URL`). Not in the plugin settings. |
| `runtime.paseo.bin` | `paseo` CLI (default `paseo` on PATH, override with `PASEO_FACTORY_PASEO_BIN`); its installation also provides the SDK. Not in the plugin settings. |
| `runtime.paseo.passwordFile` | File with the daemon password, if the daemon requires one (override with `PASEO_PASSWORD_FILE` or `PASEO_PASSWORD`). Not in the plugin settings. |

Enrollment creates Steer A in an empty workspace using an eligible profile from the steer priority. If several registered coordinators are available, `plan <scope> --slots D` selects one existing letter as the initial holder. An enrolled scope changes its holder through Handover or Activate Steer.

Existing agents can become steers. Use `--adopt A=<agent-id>` to confirm the tab that holds Steer A in the main workspace. Adoption records membership and uses the agent's live model. A title with a number, such as `Steer 3`, requires an explicit letter. Sensitive agents require verified public repository visibility. [Privacy](#privacy-sensitive-profiles)

## Findings in prompts

Only for an install from the git checkout (build from source): the setting "Ask agents to record factory findings" (`findingsInPrompts` in the `factory-display` settings document, on by default) adds a short reminder to resume, switch, fresh, assignment, relocation and worker-start prompts. Agents then record observations about using the factory in `FINDINGS.md` of that checkout and move entries to `TODO.md` only with the user's consent. The plugin detects the install from its own path; a built release has no checkout, so the reminder is never added and the setting is shown disabled.

## Label and metadata prefix

Factory labels and metadata keys use the neutral `wsf.*` prefix (see [concepts](concepts.md)). No configuration is needed. Records created by the pilot still carry duplicate `ari.wsf.*` agent labels next to their `wsf.*` counterparts (Paseo cannot remove agent labels); they are ignored. Upgrading from a version before the one-time migration: run `migrate --apply` from commit `fc118f6` first, then upgrade.

## Scopes

`plan` enrolls exactly one existing Paseo workspace as a factory scope (or repairs it). Open the workspace natively first, then plan it by scope id, `workspace:<id>` or `--local <path>`. Nothing is forked, cloned or created: the checkout, project and workspace must already exist. Re-running `plan` on an enrolled scope only repairs it (missing steer slots, labels, metadata).

Every entry plans a scope of one kind:

| Kind | Id | Locator | Enrollment needs |
|---|---|---|---|
| `github` | `owner/repo` | the fork | existing checkout with the fork as origin + existing Main workspace |
| `dir` | `--name` else folder | directory | existing directory + existing Main workspace |
| `workspace` | `--name` else `<parent>@<branch>` else folder | existing workspace id | the existing worktree workspace |
| `hub` | `--name` else `hub` | directory or workspace | like `dir`/`workspace`; at most one live hub per host |

Commands address a scope by id first, then by `wks_…`/`workspace:<id>`, then by path, then by the legacy `local/<folder>` alias (input only; usage prints a deprecation note). An id already used by another live scope is a conflict resolved with `--name`.

### GitHub scopes: which checkout, which main workspace

Several local checkouts may share the fork as origin (for example one per task). `plan` then picks one only on a clear signal: the checkout that already has a factory main workspace, else the checkout that is a Paseo project root, else `<checkoutRoot>/<repo>`. Otherwise the plan reports a conflict listing the paths; enroll one workspace directly (`workspace:<id>` or `--local <path>`).

`--main workspace:<id>` makes an existing Paseo worktree workspace the main workspace of the github scope, for example when the coordinating workspace is itself a worktree. The scope id stays `owner/repo` (not `<parent>@<branch>` as for a worktree scope), and apply checks again that the workspace is still that worktree in the same directory (if it moved, apply stops and asks for a new dry-run). Later `plan` and `status` runs find the scope on that worktree without `--main`.

## Local mode

A repository entry with a local directory needs no GitHub repository:

```json
[{ "local": "/path/to/project" }]
[{ "local": "/path/to/project", "name": "notes" }]
```

```text
/factory plan --local /path/to/project
/factory plan --local /path/to/project --name notes
```

The path must exist (a git checkout or a plain folder). The factory makes no `gh` calls. The entry becomes a scope of kind `dir` with the scope id `--name` else the folder name; `local/<folder>` stays an input alias only. Planned are only the adoption of the existing Main workspace (with the scope id in its metadata) and the steer slots (including `--adopt` and `--slots`). The plan hash and the stored authorization cover the entry, so `apply --confirm <hash>` runs without GitHub as well. A scope id already used by another live scope is a conflict resolved with `--name`.

## Worktree workspaces

An existing Paseo worktree workspace (`workspaceKind: worktree`, usually a Paseo-owned worktree below the daemon's worktree directory) can be adopted as the factory main workspace instead of creating a duplicate project workspace. Point a local entry at its directory or at its workspace id:

```json
[{ "local": "/path/to/worktree-dir" }]
[{ "workspace": "wks_0123456789abcdef" }]
```

```text
/factory plan --local /path/to/worktree-dir
/factory plan workspace:wks_0123456789abcdef
```

The scope id is `--name`, else `<parent>@<branch>` — the parent from the owning project checkout (a github scope when its origin parses to `owner/repo`, else a dir scope for the project folder, else no parent) plus the worktree branch — else the worktree folder (detached or unreadable branch). `status`, `checkpoint`, `switch`, `fresh` and `workers` accept the scope id as well as the `local/<folder>` alias and the workspace id (`workspace:<id>` or the bare `wks_...` id). The plan sets the factory metadata including the scope on the existing worktree workspace (`workspace.main.adopt`, or the non-destructive `workspace.main.scope` repair when metadata without a scope exists) and plans the steer slots as usual (`Steer A` titles, `--adopt` for unlabelled candidates, `--slots` to select one live initial coordinator). New steers are labelled `wsf.scope=<id>` next to `wsf.repo`; steers labelled with the legacy `local/<folder>` name keep matching. Existing agents of the workspace are only listed in the plan notes for reuse by id; they are never renamed or archived. Discovery without a worktree match behaves exactly as before; when several directories or workspaces share a folder name, `local/<folder>` is a conflict and the full path, the scope id or the workspace id disambiguates.

Archive frees the canonical scope ID. A new worktree of the same branch can use
the same `<parent>@<branch>` ID even when Paseo adds a number to its directory.
An old folder-based name can return nearby live worktree scopes as suggestions.
Use the exact ID, the workspace address or `plan --name` during enrollment when
a branch ID is unavailable.

## Workspace titles

Workspace titles stay as they are. The factory never renames workspaces or projects (`--retitle`, `--rename-project`, `--subject` and the `workspaceTitle`/`workspaceTitleMultiRepo` templates were removed with bulk provisioning). Rename natively in Paseo if you want a different title.

## Hub scope

`plan --hub <path|workspace:<id>> [--name]` adopts a scope of kind `hub` (default id `--name` else `hub`); at most one hub scope lives on a host, anything beyond is a conflict. An existing dir scope converts in place with `plan --hub <same path>`: the `scope.convert` op rewrites only the scope field to kind `hub` (keeping the id unless `--name` renames), while steers, epoch and checkpoint stay untouched. Only dir scopes convert; hub operations never write into member scopes.

## Domains

A domain groups several scopes under one coordinating scope, for example one product made of several repositories: Hub → Domain → Child. It is a role, not a scope kind: any live scope except a hub can be the domain of others.

- `plan <child> --domain <domain-scope-id>` stores the pointer in the child's scope field (`scope.domain` op, epoch-checked at apply). A newly enrolled scope gets it with its main workspace. `--domain ""` clears it.
- The domain must be a live scope (enroll it first) and cannot be the child itself; hubs carry no domain.
- The relation is logical only: no Paseo parent, steers stay top-level, and creating, archiving or deleting scopes stays with the hub.
- Escalation: a child steer prefixes blockers with `domain:` for its domain steer and with `hub:` for the hub. The domain steer hands work down with `assign <child>`, the same epoch-checked preview and apply as from the hub.
- `scopes` groups the rows (hub first, then each domain with its children, then the rest) and lists each domain's open `domain:` items. `status`, the `assign` preview and the resume brief name the domain and its children.

## Worker adoption

`plan --adopt-worker <agent-id>[@<slot>]` (one entry) labels any live, unlabelled agent as a scope worker (`wsf.scope`, `wsf.role=worker`, `wsf.owner=<slot>`, defaulting to the active steer); agents in other workspaces are allowed and stay where they are — Paseo cannot move them. Already-adopted workers are reported, anything else labelled is a conflict. A legacy `Steer X` candidate with a parent stays a conflict unless `--detach` plans a native `agent detach` op first (parent freedom verified after, then the adoption labels it). `status` and `workers` list labelled workers including a foreign workspace.

## Worker register

`workers [scope] [--json]` prints the supervision register of one scope: the `wsf.workers` map in the main workspace metadata, written under the workspace lock with one entry per supervised worker. Each entry carries `task` (≤ 300 chars), `startedBy`, `startedAt`, `epoch`, `state` (`running`, `done`, `partial`, `blocked`, `interrupted`, `stale`), `status` (last `- status:` of its CHECKPOINT), `resumes` (automatic continuations in the current assignment), `lastWakeAt` and `pendingWake` (wake bookkeeping); the map is bounded and oldest `done` entries go first.

Open entries for live workers (everything except `done`) also appear with task and state in `status`, in `resume` and in the `switch`/`fresh` handoff, and a checkpoint with source `failover` names the previous steer and the takeover reason. `workers [scope] --prune [--apply]` removes entries whose agent is archived or unknown to the daemon (dry-run by default; `--apply` removes under the workspace lock through the register helpers, never by editing state directly). The prune preview reports the count of entries to remove. Live agents keep their entry whatever its state. Details: [supervision design](design/supervision-design.md).

## Assigning work to a scope

`assign <scope> --task <text> [--test <text>]... [--blocker <text>]... [--next <text>]` saves a hub→scope assignment preview and prints `paseo-factory assign --confirm <hash>`. If you preview from a Paseo agent, confirm with the same `PASEO_AGENT_ID`. The hash binds the target workspace, scope, holder and epoch, the requester, report target, delivery option, and the previewed text. If the authority or checkpoint changed, generate a new preview. Each hash can start the write and delivery once. If confirmation was interrupted after the write started, check the target before making a new preview.

Confirmation writes the scope checkpoint and delivers the assignment to the active scope steer. Set `--no-send` when making the preview to write the checkpoint without delivery. For automation, pass `--apply` with the task to assign immediately. Apply re-reads scope authority under the workspace lock. `--expect-epoch <n>` lets automation specify the expected epoch. Delivery to a running steer queues the assignment. The packet carries the factory steer rules with the exact CHECKPOINT format (before the real block, because readers take the last block), since steers in other repositories never see this repository's AGENTS.md. `--report-to <agent-id>` (default: the calling agent from `PASEO_AGENT_ID`; do not unset it for `assign`) records the requester in `wsf.assignment` ({ by, epoch, at, reportedAt }). When the active steer of that scope ends a completed turn with a CHECKPOINT of status `done` or `blocked`, the plugin turn hook sends the block (plus GitHub links from the answer) to the requester once and stamps `reportedAt`; an answer that mentions CHECKPOINT but has no parseable block is reported as `unparsed` with an excerpt, so a malformed block cannot swallow the report. A new assignment resets the record.

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

## Same-tab refresh (rewind)

**Reset Steer** rewinds the live tab to a usable user message through Paseo. The agent keeps its ID, title, labels and runtime settings. Factory records the rewind in `wsf.agents` and sends or stages the continuation brief. A separate `/factory fresh [--slot E | --worker <id>]` preview can request replacement when rewind is unavailable. Use `--keep-chat-history` to request replacement directly and `--model <provider/model>` to choose another route. The replacement confirmation explicitly approves archiving the outgoing agent. Factory lists only live agents.


The idle cleanup can execute its `fresh-recommended` hint the same way for Codex chats (no native `/clear`): Settings → Plugins → Factory → Idle agents → “Rewind ‘fresh’ Codex chats in place” (default off; Claude chats always keep their native `/clear`). Details: [cold context design](design/cold-context-resume.md#same-tab-refresh-via-rewind).

## Steer menu

Every steer tab carries a Factory pill with its context state. The active
steer's menu lists its Handover destinations with context, model, thinking
and ZeroSub profile. A standby can use **Activate Steer**. **Reset Steer** opens
a confirmation in the Factory panel and uses a rewind in the same tab when
one is available. The confirmation explains the action when quota is unknown
or depleted. **Open Factory** opens the workspace panel, including its Pause
or Resume control and the current checkpoint.

Change a steer’s own settings with Paseo’s native agent controls. The profile
priorities in the Factory settings apply to future route selection.

Settings → Plugins → Factory → Steer menu:

- **Initialize new steer** (`initializeNewSteer` in the `factory-steer-menu` settings document): how a new or replaced steer's brief is delivered — send the brief at once, place the brief in the Paseo composer (default), or leave the composer empty and initialize later from the Factory panel. When the composer is unavailable, the brief remains staged.
- **Keep chat history** (`keepChatHistory`, default off) preserves steer chats during automatic delivery and idle cleanup. For cold or large contexts, automatic delivery first uses native compaction when supported. Manual refresh remains available through its preview.

## Advisors

Second opinions ("Advisor") are policy only: the factory creates no advisor agents itself. Steers brief advisors through the native Paseo advisor mechanism (skill `paseo-advisor`); workers that get stuck end their answer with an `ADVISOR-REQUEST` block and stop, and the steer decides whether to answer, reject, or consult an advisor. Format and limits (read-only, close after the answer, sanitized context only) live in [steer instructions](steer-instructions.md#advisor-policy). The steer lets the skill match its own profiles. The factory never launches advisors by itself and never reports their usage.

A profile with `"advisor": true` marks its model as a second-opinion candidate for the `paseo-advisor` skill. The tag doubles as the explicit approval for expensive models ("expensive models only on explicit request"). Skipped profiles are reported with their reason; advisor-tagged profiles are never picked for workers or non-advisor slots. A steer slot whose profile carries the tag is an advisor steer: it answers only and never coordinates (see [concepts](concepts.md#advisor-steers-and-priority)).

## Quota pools

In the Paseo composer, run `/factory quota` (or press **Quota** in the Factory panel) to see provider quota pools with their warn/exhausted state plus which steer or worker uses each pool. The view is read-only. Thresholds live in Settings → Plugins → Factory → Quota: `warnPct` (default 93) and `exhaustedPct` (default 95). The plugin samples quota in the background (result pill; the sidebar warns when a non-advisor steer's pool reaches the warn level).

Profiles belong to a quota pool named by `profiles.<name>.pool`, or by their provider when `pool` is omitted. A pool at `quota.exhaustedPct` is skipped by profile resolution. Briefs show a preferred different pool at `quota.warnPct`; configure at least two non-advisor steer pools to make that failover useful.

Optional ZeroSub: when the ZeroSub daemon plugin is installed, no Factory configuration is needed — families with ZeroSub accounts (matched by provider, e.g. `claude`) use account-based pools instead: real usage percents and `resetsAt` per account, judged against the same `quota.warnPct`/`quota.exhaustedPct`, and `/factory quota` lists the accounts with the same warn/exhausted states. Profile resolution reports the roomiest account of the picked family (`worker pick` shows it as `[account <id>]`); a family whose accounts are all exhausted is skipped with the earliest reset time. Steer failover drops candidates on the same exhausted account and prefers the account with the most room. The state is read best-effort via the internal `DaemonClient` plugin RPC `zerosub`/`zerosub.state` (the high-level client has no plugin RPC); any failure falls back to the usage snapshot, and account `email`/`organization`/`home` fields are never stored. A steer bound to a ZeroSub account uses the quota for that account. API accounts may report
no usage windows. In that case `/factory quota` shows “Usage unavailable” and the steer
can receive work until an applicable limit is reported. Unbound routes can use a provider
pool when its usage report is unambiguous.

## Managing models from the CLI

Use these commands in the Paseo composer. See [Agent CLI](#agent-cli) for the commands agents run via `paseo-factory`.

```text
/factory models
/factory worker list [scope] | /factory worker pick [scope] | /factory worker set <n> <profile|provider/model> [--thinking X] [--mode Y] [--profile name] [--dry-run] | /factory worker rm <n> [--dry-run]
/factory steer list | /factory steer set <n|slot> <profile|provider/model> [--thinking X] [--mode Y] [--profile name] [--dry-run] | /factory steer rm <n|slot> [--dry-run]
/factory model advisor|sensitive <profile|provider/model> on|off [--dry-run]
```

Use `/factory steer add [slot] [profile|provider/model]` to create a steer in the current scope. Omit the slot to use the first free letter among live workspace agents. Omit the profile to select an eligible route by role priority. The preview shows the model, account eligibility evidence and why alternatives were skipped. Confirm to create the agent in this workspace with the selected route. Select **Activate Steer** in an existing standby tab to make it the coordinator.

Model lists are ordered by priority, highest first. `worker set <n> <model>` inserts the model at position n; the entries from n onwards move down by one, and an existing copy of the same model is removed, so every model appears once. `worker rm <n>` removes an entry and closes the gap. Steer slots never shift: `steer set <n|slot>` replaces the slot's profile (`steer set 2 X` is `steer set B X`); a number past the end is refused, a free letter within reach creates the slot without opening a gap. `set` creates or updates a profile (named by `--profile`, otherwise the slot's/entry's current profile, or `<provider>-<model>` for a new entry) after validating against the live catalog including the built-in exceptions. Omitted `--thinking`/`--mode` keep the stored value (new profiles default to `"thinking": null` and no mode); use `--thinking null` for the provider default. A temporarily unavailable model is still stored, but with a warning — a fallback list may hold such entries; an unknown provider/model syntax is an error. When a model is not available in the live catalog, the next entry that is available and allowed for the role and repository (advisor and sensitive rules) is used. `rm` keeps the profile; `steer rm` also repairs `prepare`/`initialActive`. Writes act directly (reversible, no hash), like saving in Settings; plan and apply only concern agents. `--dry-run` shows the change instead of saving it. `/factory worker|steer|model …` saves in the host settings document, which is the effective source.

Profile selection reads the priority for the requested role and checks
availability, quota and repository visibility. Workers and coordinating
steers skip advisor profiles. Enrollment and `steer add` use the current
steer priority when no explicit profile is selected. The `steer set` and
`steer rm` commands still edit the legacy slot presets. Fresh keeps the live
route unless a different model is explicitly selected.

`worker pick` prints the chosen profile plus the matching `paseo run` flags (`--provider … --model … [--thinking …] [--mode …]`). Steers start workers with that model (see [steer instructions](steer-instructions.md#worker-instructions)); the resume brief carries it as `Worker model: …`.

Migration: the plugin settings document migrates v1 → v2 (`workerPriority: [workerDefault]`, plus `profiles[*].advisor` and `profiles[*].sensitive`). The effective config keeps both `workers.priority` and `workers.defaultProfile` (`priority[0]`) for older readers.

## Privacy: sensitive profiles

In the Paseo composer, run `/factory model sensitive <profile|provider/model> on|off [--dry-run]` to flip the flag (acts directly, like `/factory model advisor …`; without `--dry-run` it is saved at once in the plugin settings). The same flag is a switch per profile in Settings → Plugins → Factory → Profiles. A profile with `"sensitive": true` only gets sanitized technical tasks: no personal data, accounts, credentials, full chat histories, or private logs — only the public code the task needs.

Profiles with provider `muse` migrate to sensitive unless the flag is set explicitly (explicit `false` wins); every other provider defaults to open. Sensitive profiles are skipped for worker selection and steer creation, including explicit steer requests and new-agent refresh, unless GitHub reports the scope's repository as public; private and unknown scopes fail closed. Adopting a sensitive agent as a steer follows the same rule. This creation check does not itself guard delivery to existing agents. `worker list`, `steer list`, `status` and `/factory scopes` (composer: `/factory worker list`, `/factory steer list`, `/factory status`, `/factory scopes`) tag such entries `[sensitive]`, and a validation warning is shown when an advisor profile is also sensitive. Composer: `/factory model sensitive <profile|provider/model> on|off [--dry-run]`.

## Known provider exceptions

Some settings appear in the catalog but are rejected when an agent is created. The factory reports these during planning as a `steer.<slot>` conflict when no fallback entry is startable (`Profile "<name>" for Steer <slot> is not startable: <reason>`), so the plan stops before apply instead of failing there (while a fallback exists, the plan only notes it):

- Copilot with Claude models rejects a thinking level — use `"thinking": null`.

Paseo's public provider catalog and diagnostics expose availability, models, and settings. A provider may still reject a combination at creation time. Factory uses the catalog and the built-in exceptions during preview. A live provider test creates a separate scratch agent. [Paseo SDK reference](https://paseo.sh/docs/sdk/reference.md#clientproviders)

## Version binding

The receipt lookup (`lookupCreationReceipt` in `plugin/server/core/paseo.mjs`) speaks the internal `creation.subscribe` protocol message, which Paseo exposes only through the internal `DaemonClient` (the public SDK uses it itself to reattach to running creations). Its shape is not covered by the public SDK contract, so the lookup verifies the capability instead of pinning a version, and fails closed:

- Before use it verifies that the internal `DaemonClient` module shipping with `runtime.paseo.bin` loads and offers the methods the exchange needs, and after connecting that the daemon advertises the `creationLifecycle` feature flag.
- Every response is shape-checked (snapshot kind, idempotency key, known phase, revision). A missing capability, a failed import, connect or exchange, or an unrecognized shape aborts with an error — the lookup never reports "no receipt" on failure, so `apply` never re-creates without a receipt.

After a Paseo upgrade, re-run the crash test below; if the daemon changed the subscribe shape, the lookup fails closed until the validation (known phases in `CREATION_SNAPSHOT_PHASES`) is updated and the crash test passes.

Idempotency keys use the `wsf:` namespace (`wsf-it:` and `wsf-crash:` in the live tests). An apply interrupted before the rename from `ari-wsf:` must be replanned: stored authorizations hash their keys, so the old plan no longer matches and `apply` refuses it.

## Cleanup

In the Paseo composer, run `/factory cleanup` for the read-only report over the whole instance, one candidate each with a loss inventory (live agents and running turns, Paseo-owned worktree, git state): scratch scopes (label `wsf.scratch`, set by the live tests), workspaces with a missing directory, empty projects, several projects on one path, and `non_git` projects without a scope. It never writes. Or press **Cleanup** in the Factory panel for the same report.

Each candidate names the native command that archives it — `paseo archive <agent-id>` for agents, `paseo workspace archive <workspace-id>` for workspaces, `paseo project delete <project-id>` for projects — so review the loss inventory (including ignored files with count and first paths) and run the native command yourself. Archived agents alone are recoverable (soft-delete), but deleting their project destroys them permanently. [Agent CLI](#agent-cli)

## Relocate

Removed: to move a scope, create a new scope at the target and switch.

## Planned restarts

In the Paseo composer, run `/factory drain [--timeout 10m]` (a duration like `30s`, `10m` or `1h`; default `10m`); the Factory panel shows whether the instance is cleanly restartable. It waits until no factory agent is running, so a daemon restart kills no turn. Agents still running after the timeout are marked `interrupted` with reason `planned-restart` (git snapshot, last answer tail, open-turn tracking cleared, so the post-restart boot check keeps the planned reason). `drain` never restarts anything itself.

`status`, `scopes` and `resume` (composer: `/factory status`, `/factory scopes`, `/factory resume --brief`) show the marks as `Agent <id> durch Neustart unterbrochen (planned-restart)`.

## Live tests

Not part of `npm test`; each needs an explicit approval variable and keeps everything it creates:

| Command | What it does |
|---|---|
| `WSF_LIVE_WRITE=approved node test/integration-live.mjs` | Scratch repo, one workspace, one agent without prompt: idempotency, key conflict, parent freedom, metadata read-back. |
| `WSF_LIVE_CRASH=approved node test/integration-crash.mjs` | Real apply runner killed right after a steer create; a new process recovers the id through the receipt. |
| `WSF_LIVE_CLEANUP=approved node test/integration-live.mjs --cleanup <manifest>` | Fail-closed cleanup: archives only fully verified scratch resources; never deletes files. |

## Agent CLI

`paseo-factory` is a thin RPC client of the running `workspace-factory` plugin for agent-facing commands (`paseo-factory --help` shows the exact options):

```text
paseo-factory status [scope] [--json]
paseo-factory resume [scope] [--agent <id>] [--json]
paseo-factory resume [scope] --agent <worker> --apply [--json]
paseo-factory checkpoint [scope] --task <text> [--test <text>]... [--blocker <text>]... [--next <text>]
paseo-factory checkpoint [scope] --from-agent <steer-id> [--next <text>]
paseo-factory switch [scope] --to <slot> [--apply] [--no-send] [--wait] [--notify-previous] [--language en|de]
paseo-factory assign <scope> --task <text> [--test <text>]... [--blocker <text>]... [--next <text>] [--report-to <agent-id>] [--expect-epoch <n>] [--apply] [--no-send] [--json]
paseo-factory assign --confirm <hash> [--json]
paseo-factory workers [scope] [--prune] [--apply] [--json]
paseo-factory worker pick [scope] [--failed <profile> --reason <text>] [--json]
paseo-factory worker start [scope] --task <text> [--title <title>] [--apply] [--json]
paseo-factory worker list [scope] [--json]
```

Setup, model configuration, and maintenance (`plan`, `apply`, `fresh`, `steer`, `model`, `models`, `scopes`, `cleanup`, `drain`) live in `/factory` in the Paseo composer and Settings → Plugins → Factory.
