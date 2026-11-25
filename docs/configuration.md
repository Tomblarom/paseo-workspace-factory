# Configuration

New to the factory? Start with [Getting started](getting-started.md); this page is the detailed reference.

The config is looked up in this order: `--config <path>`, `$PASEO_FACTORY_CONFIG`, `$XDG_CONFIG_HOME/paseo-workspace-factory/config.json` (default `~/.config/paseo-workspace-factory/config.json`). Start from [`config.example.json`](../config.example.json). Keep it outside the repository; it is personal.

## Fields

| Field | Description |
|---|---|
| `version` | `1` |
| `github.owner` | Account that owns the forks. |
| `github.cloneProtocol` | `https` or `ssh`. |
| `github.upstreamRemote` | Remote name for the parent repository (usually `upstream`). |
| `checkoutRoot` | Absolute directory below which repositories are cloned. |
| `workspaceTitle` | Template for the main workspace title (`{name}`, `{repo}`, `{subject}`; default `Main`). |
| `workspaceTitleMultiRepo` | Optional multi-repo title template (same placeholders); used only when the scope's Paseo project hosts live scopes of several repos, else `workspaceTitle`. Unset disables it. |
| `handoffLanguage` | `en` (default) or `de`. |
| `profiles.<name>` | `provider`, `model`, `thinking` (or `null` for the provider default), `mode`, `advisor` (boolean, default `false`), `sensitive` (boolean, default `false`; `muse` profiles migrate to `true` unless set). Validated against the live provider catalog before a steer is planned. Advisor-tagged profiles are second-opinion candidates; they are never picked for workers or non-advisor slots (see [Advisors](#advisors) and [Managing models](#managing-models-from-the-cli)). Sensitive profiles only get sanitized technical tasks (see [Privacy](#privacy-sensitive-profiles)). |
| `knownLimits` | Optional extra catalog exceptions (same shape as the built-in list, see below). |
| `steers.slots` | Slot letter (A–Z) → profile name, in priority order: A first, then B, C, … (priority = slot order, 1=A, 2=B). Changing a slot's profile does not change an existing steer; the plan only reports the difference. Default is a single steer `A`; add `B`, `C`, … with their profiles as needed. Steer slots never shift: `steer set` replaces the slot's profile, a number addresses an existing position (2 is B), and only a free letter within reach creates a slot — no new gaps (existing configs still load). |
| `steers.prepare` | Slots created for every repository (default `["A"]`). Overridden per run with `plan --slots` (must be a subset of defined slots). Advisor slots are only planned when they are in `prepare`. |
| `steers.initialActive` | Active steer after provisioning (must be in `prepare` and must not be an advisor slot; with `--slots` it falls back to the first slot when needed). At least one non-advisor slot is required. |
| `steers.activeMarker` | Tab-title prefix on the active steer (`▷ Steer E`; default `"▷"`). `switch --apply`, `fresh` and resume-takeover move it to the new active steer and strip it from the old one (best-effort renames via `paseo agent update --name`); empty disables the marker. Title matching tolerates the prefix. |
| `workers.priority` | Ordered profile-name list for workers, highest priority first. A missing `priority` reads as `[defaultProfile]`; writing sets `defaultProfile` to `priority[0]` for older readers. |
| `workers.defaultProfile` | First entry of `workers.priority`, kept for backwards compatibility. Prefer `workers.priority`. |
| `advisors.profiles` | Optional purpose → profile name mapping for second opinions (see below). A validation warning is shown when a mapped profile is not advisor-tagged. |
| `usage.warnContextTokens` | Optional positive integer (default off): `status` warns for agents above it, with a switch/fresh recommendation. |
| `quota.warnPct` / `quota.exhaustedPct` | Session quota warning/exhaustion thresholds (defaults `75` and `95`). |
| `profiles.<name>.pool` | Optional quota-pool name. Defaults to the profile's provider; profiles in one pool share availability and failover preference. |
| `wsf.profileHealth` (workspace metadata) | Runtime-only profile failure marks, written under the workspace lock from a fresh read as their own top-level key (never inside the `wsf` scope state, so a concurrent switch/epoch is kept). `worker pick --failed <profile> --reason <text>` records the failure; the profile is skipped for 10 minutes with its classified reason, without changing config or the provider catalog. A legacy nested `profileHealth` field inside the `wsf` scope state is still read. |
| `runtime.stateDir` | Plans, progress, journals and locks (default `$XDG_STATE_HOME/paseo-workspace-factory`). |
| `runtime.scratchDir` | Scratch repositories of live tests (default `<stateDir>/scratch`). |
| `runtime.paseo.url` | Daemon WebSocket URL (default `ws://127.0.0.1:6767/ws`). |
| `runtime.paseo.bin` | `paseo` CLI (default `paseo` on PATH); its installation also provides the SDK. |
| `runtime.paseo.passwordFile` | File with the daemon password, if the daemon requires one. |

Environment overrides: `PASEO_FACTORY_STATE_DIR`, `PASEO_FACTORY_SCRATCH_DIR`, `PASEO_WS_URL`, `PASEO_FACTORY_PASEO_BIN`, `PASEO_PASSWORD_FILE`, `PASEO_PASSWORD`.

Per-run slot selection: `plan <repo> --slots D` (comma-separated, e.g. `--slots B,D`) plans only those slots instead of `steers.prepare`. `--adopt X=<agent-id>` accepts any slot defined in `steers.slots`; adopting a slot outside `prepare` plans only the adopted slot(s), not the rest of `prepare`.

If live steers already run in slots outside `prepare` (for example D and E while the config prepares A), `plan` refuses to create further steers and suggests a `--slots` list that includes the running ones; with that `--slots` they are acknowledged and the plan continues; when nothing needs creating, the running steers are only noted. A running slot that is not defined in `steers.slots` must be defined there or archived first.

Existing agents can become steers. Unlabelled agents in the main workspace whose title looks like a steer are candidates for that slot: `Steer A`, in any letter case, optionally with a suffix in brackets or after a separator (`Steer A [kn]`, `Steer A (fp)`, `Steer A · fp`). The plan reports such a candidate as a conflict until you confirm it with `--adopt A=<agent-id>`, so no existing agent is taken over silently. Adoption only adds the labels; title and model stay as they are. When the adopted model differs from the slot profile, the plan suggests the `steer set` command that points the slot at the live model (a preview-only option list when several profiles match). A title with a number (`Steer 3`) is never assigned to a slot automatically: `plan` lists it in the notes, and you adopt it explicitly with `--adopt C=<agent-id>`. Privacy rule: adopting an agent whose model differs from the slot profile is a conflict instead of an adoption when the agent's provider is sensitive (any same-provider profile with `"sensitive": true`; `muse` counts as sensitive unless set otherwise) and the repository is private or its visibility is unknown — a sensitive agent is only adopted for a repository that GitHub reports as public (see [Privacy](#privacy-sensitive-profiles)).

## Findings in prompts

Only for an install from the git checkout (build from source): the setting "Ask agents to record factory findings" (`findingsInPrompts` in the `factory-display` settings document, on by default) adds a short reminder to resume, switch, fresh, assignment, relocation and worker-start prompts. Agents then record observations about using the factory in `FINDINGS.md` of that checkout and move entries to `TODO.md` only with the user's consent. The plugin detects the install from its own path; a built release has no checkout, so the reminder is never added and the setting is shown disabled. The CLI asks the plugin; without a running plugin it uses its own checkout.

## Label and metadata prefix

Factory labels and metadata keys use the neutral `wsf.*` prefix (see [concepts](concepts.md)). Records created by the pilot still carry `ari.wsf.*`: they are read transparently and a normal `plan` proposes `labels.migrate` ops to rewrite them. No configuration is needed. `scopes` shows the hint `legacy-prefix` only while an old key still lacks its `wsf.*` counterpart. Paseo cannot remove agent labels, so after the migration the old labels stay next to their new counterparts; that counts as done: no hint, and `scopes --json` marks the row `legacyKeysMigrated: true`.

`labels [scope|agent-id] [--json]` audits the agent labels of every scope (or one scope/agent): steers should carry `wsf.repo`/`wsf.scope`/`wsf.role`/`wsf.slot`, workers `wsf.scope`/`wsf.role`/`wsf.owner`, and pending `ari.wsf.*` keys are migrated along. Dry-run is the default (one line per agent with its fix); `--apply` sets/overwrites the labels via `agent update` (verified after the write). Archived agents and agents of unrelated scopes are never touched; agents whose role, slot or owner cannot be derived are reported without a fix.

In the Paseo composer, run `/factory labels <scope-or-agent-id>` and review the audit. Omit the address to audit all Factory scopes. Select **Set labels** to apply the previewed changes. The Factory asks for a new preview if the audit changed since you opened it.

## Scopes

Every entry plans a scope of one kind:

| Kind | Id | Locator | Provisioning |
|---|---|---|---|
| `github` | `owner/repo` | the fork | fork, clone, upstream remote, project, main workspace |
| `dir` | `--name` else folder | directory | project (if missing), main workspace |
| `workspace` | `--name` else `<parent>@<branch>` else folder | existing workspace id | metadata only; no new project or workspace |
| `hub` | `--name` else `hub` | directory or workspace | like `dir`/`workspace`; at most one live hub per host |

Commands address a scope by id first, then by `wks_…`/`workspace:<id>`, then by path, then by the legacy `local/<folder>` alias (input only; usage prints a deprecation note). An id already used by another live scope — or by two entries of one run — is a conflict resolved with `--name`.

### GitHub scopes: which checkout, which main workspace

Several local checkouts may share the fork as origin (for example one per task). `plan` then picks one only on a clear signal: the checkout that already has a factory main workspace, else the checkout that is a Paseo project root, else `<checkoutRoot>/<repo>`. Otherwise the plan reports a conflict listing the paths; choose one with `--checkout <path>` (one entry) or per-entry `"checkout"` in a repos file.

`--main workspace:<id>` (one github entry, or per-entry `"main"`) makes an existing Paseo worktree workspace the main workspace of the github scope, for example when the coordinating workspace is itself a worktree. The scope id stays `owner/repo` (not `<parent>@<branch>` as for a worktree scope), no project or workspace is created, and apply checks again that the workspace is still that worktree in the same directory (if it moved, apply stops and asks for a new dry-run). Later `plan` and `status` runs find the scope on that worktree without `--main`.

## Local mode

A repository entry with a local directory needs no GitHub repository:

```json
[{ "local": "/path/to/project" }]
[{ "local": "/path/to/project", "name": "notes" }]
```

```text
/factory plan --local /path/to/project --local /path/to/other
/factory plan --local /path/to/project --name notes
```

The path must exist (a git checkout or a plain folder). The factory makes no `gh` calls and plans no fork, clone or upstream remote. Each entry becomes a scope of kind `dir` with the scope id `--name` (or per-entry `"name"`) else the folder name; `--name` needs exactly one entry while repos-file entries may each carry their own `"name"`. `local/<folder>` stays an input alias only. Planned are only the Paseo project registration (when missing), the main workspace (created or adopted, with the scope id in its metadata) and the steer slots (including `--adopt`, `--adopt <scope-id>:A=<agent-id>` with several entries, and `--slots`). The plan hash and the stored authorization cover the entries, so `apply --confirm <hash>` runs without GitHub as well. A scope id already used by another live scope (or by two entries of one run) is a conflict resolved with `--name`.

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

The scope id is `--name` (or per-entry `"name"`), else `<parent>@<branch>` — the parent from the owning project checkout (a github scope when its origin parses to `owner/repo`, else a dir scope for the project folder, else no parent) plus the worktree branch — else the worktree folder (detached or unreadable branch). `status`, `checkpoint`, `switch`, `fresh` and `workers` accept the scope id as well as the `local/<folder>` alias and the workspace id (`workspace:<id>` or the bare `wks_...` id). The plan registers no new Paseo project and creates no duplicate workspace: it sets the factory metadata including the scope on the existing worktree workspace (`workspace.main.adopt`, or the non-destructive `workspace.main.scope` top-up when metadata without a scope exists) and plans the steer slots as usual (`Steer A` titles, `--adopt` for unlabelled candidates, `--slots` for a subset). New steers are labelled `wsf.scope=<id>` next to `wsf.repo`; steers labelled with the legacy `local/<folder>` name keep matching. Existing agents of the workspace are only listed in the plan notes for reuse by id; they are never renamed or archived. Discovery without a worktree match behaves exactly as before; when several directories or workspaces share a folder name, `local/<folder>` is a conflict and the full path, the scope id or the workspace id disambiguates.

## Workspace titles

`workspaceTitle` is a template for the main workspace title (default `"Main"`): `{name}` is the scope short form (the repo name for github, else the scope id), `{repo}` the short repository name (the scope id without the `@branch` suffix of worktree scopes and without the owner: `web` for `example/web` and `example/web@feat`), `{subject}` the entry subject (`--subject <text>` with one entry, or per-entry `"subject"` in repos-file). New workspaces are created with the rendered title. An existing main workspace with a deviating title is only reported; `plan --retitle` plans a `workspace.retitle` op (native workspace rename, verified after). A template needing `{subject}` without one, or with an unknown placeholder, is a plan conflict. `--rename-project <name>` (one entry) plans a `project.rename` op onto the scope project, but only when the project already exists and the name differs.

Optional `workspaceTitleMultiRepo` (e.g. `"{repo} · {subject}"`, unset by default) overrides `workspaceTitle` only when the scope's Paseo project hosts live scopes of several repos — a worktree scope counts as its parent's repo, and the planned scope itself does not count until it exists. Otherwise `workspaceTitle` applies, so single-repo projects keep short titles while shared projects disambiguate (`web · USB pass`). Template errors name the active field (`workspace.title` conflict); converging already-created titles after the second repo arrives goes through the usual `--retitle` note.

`Main` is the factory handle. An existing main workspace titled `Main`, `<repo> · Main` or `<name> · Main` (with its own scope's name) is always accepted: the title templates never propose to rename it, so a naming rule like `<Repo> · <Subject>` cannot collide with the handle.

## Hub scope

`plan --hub <path|workspace:<id>> [--name]` creates or adopts a scope of kind `hub` (default id `--name` else `hub`); at most one hub scope lives on a host, anything beyond is a conflict. An existing dir scope converts in place with `plan --hub <same path>`: the `scope.convert` op rewrites only the scope field to kind `hub` (keeping the id unless `--name` renames), while steers, epoch and checkpoint stay untouched. Only dir scopes convert; hub operations never write into member scopes.

## Domains

A domain groups several scopes under one coordinating scope, for example one product made of several repositories: Hub → Domain → Child. It is a role, not a scope kind: any live scope except a hub can be the domain of others.

- `plan <child> --domain <domain-scope-id>` (one entry, or per-entry `"domain"`) stores the pointer in the child's scope field (`scope.domain` op, epoch-checked at apply). A new scope gets it with its main workspace. `--domain ""` clears it.
- The domain must be a live scope or planned in the same run (one run creates the domain first, then its children) and cannot be the child itself; hubs carry no domain.
- The relation is logical only: no Paseo parent, steers stay top-level, and creating, archiving or deleting scopes stays with the hub.
- Escalation: a child steer prefixes blockers with `domain:` for its domain steer and with `hub:` for the hub. The domain steer hands work down with `assign <child>`, the same epoch-checked preview and apply as from the hub.
- `scopes` groups the rows (hub first, then each domain with its children, then the rest) and lists each domain's open `domain:` items. `status`, the `assign` preview and the resume brief name the domain and its children.

## Worker adoption

`plan --adopt-worker <agent-id>[@<slot>]` (one entry) labels any live, unlabelled agent as a scope worker (`wsf.scope`, `wsf.role=worker`, `wsf.owner=<slot>`, defaulting to the active steer); agents in other workspaces are allowed and stay where they are — Paseo cannot move them. Already-adopted workers are reported, anything else labelled is a conflict. A legacy `Steer X` candidate with a parent stays a conflict unless `--detach` plans a native `agent detach` op first (parent freedom verified after, then the adoption labels it). `status` and `workers` list labelled workers including a foreign workspace.

## Worker register

`workers [scope] [--json]` prints the supervision register of one scope: the `wsf.workers` map in the main workspace metadata, written under the workspace lock with one entry per supervised worker. Each entry carries `task` (≤ 300 chars), `startedBy`, `startedAt`, `epoch`, `state` (`running`, `done`, `partial`, `blocked`, `interrupted`, `stale`), `status` (last `- status:` of its CHECKPOINT), `resumes` (automatic continuations in the current assignment), `lastWakeAt` and `pendingWake` (wake bookkeeping); the map is bounded and oldest `done` entries go first.

Open entries (everything except `done`) also appear with task and state in `status`, in `resume` and in the `switch`/`fresh` handoff, and a checkpoint with source `failover` names the previous steer and the takeover reason. `workers [scope] --prune [--apply]` removes entries whose agent is archived or unknown to the daemon (dry-run by default; `--apply` removes under the workspace lock through the register helpers, never by editing state directly). Live agents keep their entry whatever its state. Details: [supervision design](design/supervision-design.md).

## Assigning work to a scope

`assign <scope> --task <text> [--test <text>]... [--blocker <text>]... [--next <text>]` previews a hub→scope assignment; `--apply` writes the scope checkpoint and delivers it to the active scope steer (skip delivery with `--no-send`). The write is epoch-checked: apply re-reads the scope state under the workspace lock and refuses when the epoch or active steer moved since discovery. `--expect-epoch <n>` additionally binds apply to the previewed epoch. Retired scopes refuse (naming the `movedTo` successor); a running steer still receives the assignment, since delivery only queues a message. The packet carries the factory steer rules with the exact CHECKPOINT format (before the real block, because readers take the last block), since steers in other repositories never see this repository's AGENTS.md. `--report-to <agent-id>` (default: the calling agent from `PASEO_AGENT_ID`; do not unset it for `assign`) records the requester in `wsf.assignment` ({ by, epoch, at, reportedAt }). When the active steer of that scope ends a completed turn with a CHECKPOINT of status `done` or `blocked`, the plugin turn hook sends the block (plus GitHub links from the answer) to the requester once and stamps `reportedAt`; an answer that mentions CHECKPOINT but has no parseable block is reported as `unparsed` with an excerpt, so a malformed block cannot swallow the report. A new assignment resets the record.

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

`fresh` refreshes a steer or worker in the same tab via Paseo rewind when the agent has a real user message to rewind to: the context is rewound to the first user message and the refresh packet is delivered as the resume brief (sent without a caller id, so the next refresh rewinds to exactly that brief). The agent keeps its tab, id, labels and title; nothing is created and the epoch stays. The preview shows `rewind` vs `new agent`. A new parent-free agent is only the fallback when no rewind point exists (send-only history) or the provider lacks rewind; a failed rewind aborts without sending, recording, or creating anything, and a second apply without a new turn is idempotent. The run is recorded in `wsf.agents` as `cleared`/`refreshed` with mode `rewind`.

The idle cleanup can execute its `fresh-recommended` hint the same way for Codex chats (no native `/clear`): Settings → Plugins → Factory → Idle agents → “Rewind ‘fresh’ Codex chats in place” (default off; Claude chats always keep their native `/clear`). Details: [cold context design](design/cold-context-resume.md#same-tab-refresh-via-rewind).

## Steer menu

Every steer tab carries a persistent Factory pill (for example `A · warm`); hovering shows tokens and quota on a second line. Opening it shows nothing but the action menu: **Create steer…**, **Hand over to…** (submenu of holders A, B, C …; unavailable holders are disabled with the short reason in the title), **Resume… / Refresh context…**, **Change settings…** (model, thinking and speed from the live provider catalog, same provider), and **Open Factory**. Every write previews first, confirms, then applies through the same operations as `/factory steer add`, `/factory switch`, `/factory resume` and `/factory fresh`; an expired preview is re-requested for review. Handover and replacement send exactly one brief to the destination and no prompt to the outgoing tab. **Resume…** clears the context in place (Claude: native `/clear`); with **Keep chat history** it rewinds instead. Codex has no native clear, so a Codex refresh always rewinds. A settings change applies in place on a small cold context and otherwise refreshes first (bound rewind, then apply and verify); under Maximum efficiency a warm, cooling or running steer greys the change out. Native Paseo setting edits cannot be disabled, so an external change shows `C · settings changed` with **Revert settings** and **Continue with fresh context…**.

Settings → Plugins → Factory → Steer menu:

- **Initialize new steer** (`initializeNewSteer` in the `factory-steer-menu` settings document): how a new or replaced steer's brief is delivered — send the brief at once, place the brief in the Paseo composer (default; goes out with the next own prompt, falls back to sending when no composer tab is open), or leave the composer empty and initialize later from the steer menu.
- **Keep chat history** (`keepChatHistory`, default off): Refresh rewinds instead of clearing. Always on for Codex (no native clear).

## Advisors

Second opinions ("Advisor") are policy only: the factory creates no advisor agents itself. Steers brief advisors through the native Paseo advisor mechanism (skill `paseo-advisor`); workers that get stuck end their answer with an `ADVISOR-REQUEST` block and stop, and the steer decides whether to answer, reject, or consult an advisor. Format and limits (read-only, close after the answer, sanitized context only) live in [steer instructions](steer-instructions.md#advisor-policy).

Optional `advisors.profiles` maps an advisor purpose to a factory profile from `profiles` (validated on load; unknown profiles are rejected):

```json
"advisors": {
  "profiles": { "design": "senior-reviewer", "routine": "cheap" }
}
```

Without a mapping the steer lets the skill match its own profiles. The factory never launches advisors by itself and never reports their usage.

A profile with `"advisor": true` marks its model as a second-opinion candidate for the `paseo-advisor` skill. The tag doubles as the explicit approval for expensive models ("expensive models only on explicit request"). Skipped profiles are reported with their reason; advisor-tagged profiles are never picked for workers or non-advisor slots, and a validation warning is shown when `advisors.profiles` names a profile without the tag. A steer slot whose profile carries the tag is an advisor steer: it answers only and never coordinates (see [concepts](concepts.md#advisor-steers-and-priority)).

## Quota pools

In the Paseo composer, run `/factory quota` (or press **Quota** in the Factory panel) to see provider quota pools with their warn/exhausted state plus which steer or worker uses each pool. The view is read-only. Thresholds live in Settings → Plugins → Factory → Quota: `warnPct` (default 75), `exhaustedPct` (default 95), and the sample cadence `quotaSampleMinutes` (whole minutes, at least 10). The plugin samples quota in the background (result pill; the sidebar warns when a non-advisor steer's pool reaches the warn level).

Profiles belong to a quota pool named by `profiles.<name>.pool`, or by their provider when `pool` is omitted. A pool at `quota.exhaustedPct` is skipped by profile resolution. Briefs show a preferred different pool at `quota.warnPct`; configure at least two non-advisor steer pools to make that failover useful.

Optional ZeroSub: when the ZeroSub daemon plugin is installed, no Factory configuration is needed — families with ZeroSub accounts (matched by provider, e.g. `claude`) use account-based pools instead: real usage percents and `resetsAt` per account, judged against the same `quota.warnPct`/`quota.exhaustedPct`, and `/factory quota` lists the accounts with the same warn/exhausted states. Profile resolution reports the roomiest account of the picked family (`worker pick` shows it as `[account <id>]`); a family whose accounts are all exhausted is skipped with the earliest reset time. Steer failover drops candidates on the same exhausted account and prefers the account with the most room. The state is read best-effort via the internal `DaemonClient` plugin RPC `zerosub`/`zerosub.state` (the high-level client has no plugin RPC); any failure falls back to the usage snapshot, and account `email`/`organization`/`home` fields are never stored. Without ZeroSub the usage snapshot applies unchanged.

## Managing models from the CLI

Use these commands in the Paseo composer. The catalog and priority checks also apply to the [CLI commands for scripts](#cli-reference-for-scripts).

```text
/factory models
/factory worker list [scope] | /factory worker pick [scope] | /factory worker set <n> <profile|provider/model> [--thinking X] [--mode Y] [--profile name] [--dry-run] | /factory worker rm <n> [--dry-run]
/factory steer list | /factory steer set <n|slot> <profile|provider/model> [--thinking X] [--mode Y] [--profile name] [--dry-run] | /factory steer rm <n|slot> [--dry-run]
/factory model advisor|sensitive <profile|provider/model> on|off [--dry-run]
```

Use `/factory steer add [slot] [profile|provider/model]` to create a steer in the current scope. Omit the slot to suggest a free one. Omit the profile to use the configured profile for the slot or pick an eligible one by priority. The preview shows the model, any selected ZeroSub account, and why alternatives were skipped. Confirm in the panel to save the slot and create the agent. Use `/factory switch` to activate it. The default slots for other scopes stay unchanged.

Model lists are ordered by priority, highest first. `worker set <n> <model>` inserts the model at position n; the entries from n onwards move down by one, and an existing copy of the same model is removed, so every model appears once. `worker rm <n>` removes an entry and closes the gap. Steer slots never shift: `steer set <n|slot>` replaces the slot's profile (`steer set 2 X` is `steer set B X`); a number past the end is refused, a free letter within reach creates the slot without opening a gap. `set` creates or updates a profile (named by `--profile`, otherwise the slot's/entry's current profile, or `<provider>-<model>` for a new entry) after validating against the live catalog including `knownLimits`. Omitted `--thinking`/`--mode` keep the stored value (new profiles default to `"thinking": null` and no mode); use `--thinking null` for the provider default. A temporarily unavailable model is still stored, but with a warning — a fallback list may hold such entries; an unknown provider/model syntax is an error. When a model is not available in the live catalog, the next entry that is available and allowed for the role and repository (advisor and sensitive rules) is used. `rm` keeps the profile; `steer rm` also repairs `prepare`/`initialActive`. Writes act directly (reversible, no hash), like saving in Settings; plan and apply only concern agents. CLI writes are atomic (tmp + rename, file mode kept); `--dry-run` prints the new config instead of writing it. From the plugin, `/factory worker|steer|model …` calls an RPC that writes the host settings document, which overlays the file and is therefore the effective source.

Aliases (deprecated, print a hint on use): `slot set B …` is `steer set B …`, `slot rm B` is `steer rm B`, and `worker-default X` is `worker set 1 X`.

Resolution with availability fallback: the factory picks the first list entry that passes the catalog check and matches the role. Workers use `workers.priority` and always skip advisor profiles; sensitive profiles are skipped unless the repository is provably public. Steer slot S uses `[slots[S], then the profiles of the following slots, then the previous ones]`; a non-advisor slot takes only non-advisor profiles, an advisor slot only advisor profiles, and a fallback never picks a profile a living steer of the same scope already uses (no duplicates). Skipped profiles appear as notes (`B: muse not available → copilot-sonnet`); when nothing is available, steers get a plan conflict and workers an error listing the reasons. The fallback applies only when creating (`plan`, `fresh`, `relocate`, `worker pick`): running agents never change their model — a failed steer is taken over by the next slot via failover. When `fresh` creates with a fallback profile, the result suggests the `steer set` command that would point the slot at the created model. The plugin caches the catalog for 60 s.

`worker pick` prints the chosen profile plus the matching `paseo run` flags (`--provider … --model … [--thinking …] [--mode …]`). Steers start workers with that model (see [steer instructions](steer-instructions.md#worker-instructions)); the resume brief carries it as `Worker model: …`.

Migration: configs with only `workers.defaultProfile` read as `workers.priority: [defaultProfile]`. Every write sets `defaultProfile` to `priority[0]`, so older readers keep working. The plugin settings document migrates v1 → v2 the same way (`workerPriority: [workerDefault]`, plus `profiles[*].advisor` and `profiles[*].sensitive`) and writes both `workers.priority` and `workers.defaultProfile`.

## Privacy: sensitive profiles

In the Paseo composer, run `/factory model sensitive <profile|provider/model> on|off [--dry-run]` to flip the flag (acts directly, like `/factory model advisor …`; without `--dry-run` it is saved at once in the plugin settings). The same flag is a switch per profile in Settings → Plugins → Factory → Profiles. A profile with `"sensitive": true` only gets sanitized technical tasks: no personal data, accounts, credentials, full chat histories, or private logs — only the public code the task needs.

Profiles with provider `muse` migrate to sensitive unless the flag is set explicitly (explicit `false` wins); every other provider defaults to open. Workers of a sensitive profile are skipped by `worker pick` (`/factory worker pick`) and the `Worker model:` brief line unless GitHub reports the repository as public (private or unknown counts as private); adopting a sensitive agent as a steer follows the same rule. `worker list`, `steer list`, `status` and `scopes` (composer: `/factory worker list`, `/factory steer list`, `/factory status`, `/factory scopes`) tag such entries `[sensitive]`, and a validation warning is shown when an advisor profile is also sensitive. CLI equivalent: `paseo-factory model sensitive <profile|provider/model> on|off [--dry-run]`.

## Known provider exceptions

Some settings appear in the catalog but are rejected when an agent is created. The factory reports these during planning as a `steer.<slot>` conflict when no fallback entry is startable (`Profile "<name>" for Steer <slot> is not startable: <reason>`), so the plan stops before apply instead of failing there (while a fallback exists, the plan only notes it):

- Copilot with Claude models rejects a thinking level — use `"thinking": null`.

Paseo's public provider catalog and diagnostics expose availability, models, and settings. A provider may still reject a combination at creation time. Factory uses the catalog and known exceptions during preview. A live provider test creates a separate scratch agent. [Paseo SDK reference](https://paseo.sh/docs/sdk/reference.md#clientproviders)

Extend the built-in list with optional `knownLimits` (validated on load; an entry needs `provider`, `model` and/or `modelPattern`, `field` (`thinking` or `mode`), and `reason`):

```json
"knownLimits": [
  { "provider": "example", "modelPattern": "^large-", "field": "thinking", "reason": "Example provider rejects thinking for large models; use thinking: null" }
]
```

`model` matches exactly, `modelPattern` is a regular expression against the model id; when both are given, both must match. A rule only fires when the profile actually sets that field.

## Version binding

The receipt lookup (`lookupCreationReceipt` in `src/paseo.mjs`) speaks the internal `creation.subscribe` protocol message, which Paseo exposes only through the internal `DaemonClient` (the public SDK uses it itself to reattach to running creations). Its shape is not covered by the public SDK contract, so the lookup verifies the capability instead of pinning a version, and fails closed:

- Before use it verifies that the internal `DaemonClient` module shipping with `runtime.paseo.bin` loads and offers the methods the exchange needs, and after connecting that the daemon advertises the `creationLifecycle` feature flag.
- Every response is shape-checked (snapshot kind, idempotency key, known phase, revision). A missing capability, a failed import, connect or exchange, or an unrecognized shape aborts with an error — the lookup never reports "no receipt" on failure, so `apply` never re-creates without a receipt.

After a Paseo upgrade, re-run the crash test below; if the daemon changed the subscribe shape, the lookup fails closed until the validation (known phases in `CREATION_SNAPSHOT_PHASES`) is updated and the crash test passes.

Idempotency keys use the `wsf:` namespace (`wsf-it:` and `wsf-crash:` in the live tests). An apply interrupted before the rename from `ari-wsf:` must be replanned: stored authorizations hash their keys, so the old plan no longer matches and `apply` refuses it.

## Cleanup

In the Paseo composer, run `/factory cleanup` for the read-only report over the whole instance, one candidate each with a loss inventory (live agents and running turns, Paseo-owned worktree, git state): scratch scopes (label `wsf.scratch`, set by the live tests), workspaces with a missing directory, empty projects, several projects on one path, `non_git` projects without a scope, and retired factory scopes. It never writes. Or press **Cleanup** in the Factory panel for the same report.

`/factory cleanup --plan [--allow-destructive] [--allow-ignored] [--only <id,…>]` turns the report into a hash-confirmed plan shown in the Factory panel. Confirmation there is required: press **Apply \<hash\>** (or run `/factory apply <hash>`); the plan alone writes nothing. Ops: `workspace.archive` (native archive), `project.delete` (only for projects empty then or emptied by the plan's own archives), `scope.retire` (non-destructive: sets `retired: true`, clears the active steer, agents stay; currently planned by no flow, reserved for relocate). Destructive ops are listed separately with their loss inventory. Without `--allow-destructive` they become hints instead; duplicate paths, scopeless projects, orphan scratch agents and missing-directory worktrees always stay hints (human choice, no `agent.archive` op, unverifiable git state). Apply re-checks every destructive op right before running it — no running agents (never archived), no new agents since plan, clean worktree without unpushed commits, empty project — and any drift stops the run instead of skipping the op. Ignored files are inventoried with count and first paths; archiving a worktree with ignored files outside the build allowlist (`node_modules`, `dist`, `build`, `target`, `__pycache__`, `.venv`) refuses unless the plan carries explicit `allowIgnored` (`--allow-ignored`, hashed). Archived agents alone are recoverable (soft-delete), but deleting their project destroys them permanently: `project.delete` inventories archived members, marks its summary irreversible, and verifies them against the plan.

`--only` with an unknown candidate ID is an error. Filters are part of the hashed authorization. [Script commands](#cli-reference-for-scripts)

## Relocate

`relocate <scope> --to <path|project> [--apply]` moves a scope: a new main workspace at the target (created, or adopted when bare), fresh steers of every live slot with the checkpoint handoff, and the old scope retired with `movedTo` (the target directory). The filesystem move itself is the operator's job — the target directory must already exist. Preview is the default; `--apply` executes under the old workspace lock with receipt recovery, so a retry resumes instead of duplicating. Archival of the old scope goes through `cleanup --plan`, never automatically; until then the slot is held twice (`status` marks the older holder superseded while `switch`/`plan` follow the newest) and the scope id resolves ambiguously, so address the new scope by workspace id or path. Retired scopes refuse coordination (`switch`, `fresh`, `assign`) and steer planning; `status` shows `RETIRED → movedTo`. Opt-in live check on scratch resources only: `WSF_LIVE_CLEANUP_PLAN=approved node test/integration-cleanup-plan.mjs`.

The scope field — including a domain pointer (`scope.domain`) — is carried over to the new main workspace verbatim and shown in the preview as `domain <id>` (see [domains](#domains)).

## Planned restarts

In the Paseo composer, run `/factory drain [--timeout 10m]` (a duration like `30s`, `10m` or `1h`; default `10m`); the Factory panel shows whether the instance is cleanly restartable. It waits until no factory agent is running, so a daemon restart kills no turn. Agents still running after the timeout are marked `interrupted` with reason `planned-restart` (git snapshot, last answer tail, open-turn tracking cleared, so the post-restart boot check keeps the planned reason). `drain` never restarts anything itself.

`status`, `scopes` and `resume` (composer: `/factory status`, `/factory scopes`, `/factory resume --brief`) show the marks as `Agent <id> durch Neustart unterbrochen (planned-restart)`.

## Live tests

Not part of `npm test`; each needs an explicit approval variable and keeps everything it creates:

| Command | What it does |
|---|---|
| `WSF_LIVE_WRITE=approved node test/integration-live.mjs` | Scratch repo, one workspace, one agent without prompt: idempotency, key conflict, parent freedom, metadata read-back. |
| `WSF_LIVE_CRASH=approved node test/integration-crash.mjs` | Real apply runner killed right after the workspace create; a new process recovers the id through the receipt. |
| `WSF_LIVE_CLEANUP=approved node test/integration-live.mjs --cleanup <manifest>` | Fail-closed cleanup: archives only fully verified scratch resources; never deletes files. |

## CLI reference for scripts

The CLI reads its configuration from the host file. Use `paseo-factory --help` for the complete command list, including scripting flags such as `--repos-file`, `--json`, and `--out`.

```text
paseo-factory models [--json]
paseo-factory worker list [scope] [--json]
paseo-factory worker set <n> <profile|provider/model> [--thinking X] [--mode Y] [--profile name] [--dry-run]
paseo-factory worker rm <n> [--dry-run]
paseo-factory worker pick [scope] [--json]
paseo-factory steer list [--json]
paseo-factory steer set <n|slot> <profile|provider/model> [--thinking X] [--mode Y] [--profile name] [--dry-run]
paseo-factory steer rm <n|slot> [--dry-run]
paseo-factory model advisor|sensitive <profile|provider/model> on|off [--dry-run]
paseo-factory cleanup [--json]
paseo-factory cleanup --plan [--allow-destructive] [--allow-ignored] [--only <id,...>] [--json]
paseo-factory apply --confirm <hash>
paseo-factory drain [--timeout 10m] [--json]
```

`drain` returns 0 when the daemon can safely restart and 2 when the timeout marked remaining turns as `planned-restart`. To restart only after a successful drain, use this in a shell on the Paseo host:

```sh
clear
if paseo-factory drain --timeout 10m; then
  paseo daemon restart
else
  echo "Agents still running. Check the planned-restart marks before restarting." >&2
  exit 2
fi
```
