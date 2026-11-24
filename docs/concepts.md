# Concepts and safety model

New to the factory? Start with [Getting started](getting-started.md); this page is the detailed reference.

## Building blocks

| Term | Meaning |
|---|---|
| Scope | The unit of coordination: exactly one main workspace with factory metadata, its steers (slots A–Z), epoch, checkpoint and workers. Kinds: `github` (`owner/repo`), `dir` (plain directory), `workspace` (adopted existing workspace), `hub` (coordinator, at most one per host). The scope id lives in `wsf.scope`; steers carry it as label `wsf.scope`. |
| Main workspace | The scope's home workspace (any kind), holding the steers and the factory state in its metadata. Its title follows the `workspaceTitle` template. |
| Steer | Top-level coordinating agent (no parent), identified by labels `wsf.scope`, `wsf.role=steer`, `wsf.slot=<A..Z>` (`wsf.repo` kept for compatibility). The role is independent of provider and model. |
| Advisor steer | A steer slot whose profile carries `"advisor": true`, resolved live from the config. It answers explicit questions only and never coordinates, takes over, or receives supervision wakes. |
| Hub | A scope of kind `hub` whose steers coordinate other scopes (provisioning, lifecycle, models, adoption, priorities); see Roles below. |
| Domain | A role, not a kind: a scope whose steers coordinate a group of child scopes (e.g. one product made of several repositories). Children point to it with `scope.domain`; see [domains](configuration.md#domains). |
| Active steer | The one steer that coordinates now; stored as `wsf.activeSteer` in the workspace metadata. |
| Epoch | Counter in `wsf.epoch`, increased by every switch. |
| Checkpoint | Short task state in `wsf.checkpoint`: `task`, `tests`, `blockers`, `next`, `epoch`, `updatedAt`, plus `source` (`agent`/`auto`/`manual`/`assign`), `capturedAt`, and an `interrupted` flag when the last turn died. |
| Handoff | Message to the new steer, built deterministically from workspace, epoch, git (branch, SHA, changes), workers and the checkpoint, plus the resume brief when the checkpoint is interrupted. The previous steer's last answer is added only as a shortened, unverified hint. |
| Worker | Agent doing one bounded task: either created by a steer (parent = that steer) or adopted by label (`wsf.role=worker`, `wsf.owner=<slot>`), staying in its own workspace either way. Workers keep their parent after a switch and are reused by id. |

No separate registry exists: everything else is read live from Paseo.

## Scopes and roles

| Role | Responsible for | Not responsible for |
|---|---|---|
| Hub steer | provisioning and lifecycle plans for any scope, slot/model assignment, adoption, priorities across scopes, cleanup | content work inside a scope that has an active steer |
| Domain steer | tasks across its child scopes, handing work down with `assign`, answering `domain:` blockers | lifecycle (create/archive/delete) of scopes, which stays with the hub |
| Scope steer | tasks of its scope, its workers, its CHECKPOINT | other scopes, destructive lifecycle ops |
| Worker | one bounded task | coordination |

Relations stay logical (metadata/labels), never `parent`: steers stay parent-free. Hub → scope: `assign <scope> --task … --next …` writes the scope checkpoint (epoch-checked, preview first) and delivers it to the active scope steer. Scope → hub: the CHECKPOINT block; blockers prefixed `hub:` are escalations. With a domain the chain is Hub → Domain → Child: `domain:` blockers go to the domain steer, `hub:` blockers further to the hub.

## Advisor steers and priority

Steer priority is the slot order: A first, then B, C, … (`steer set 2 X` is `steer set B X`). The failover chain runs in the same order, so priority and failover always agree. Worker priority is the `workers.priority` list, highest first. When a model is unavailable, the factory falls back to the next entry — but only when creating (`plan`, `fresh`, `relocate`, `worker pick`); a running agent never changes its model, and a failed steer is taken over by the next slot instead.

An advisor steer (slot profile with `"advisor": true`) is planned only when it is in `prepare`, is never made active (`initialActive` must not be an advisor, `switch --to` refuses it), is skipped by failover, and gets no supervision wakes. `status`/`scopes` tag it `[advisor]`. Details: [managing models](configuration.md#managing-models-from-the-cli).

A profile with `"sensitive": true` only gets sanitized technical tasks; its workers are skipped on private or unknown-visibility repositories, and `status`/`scopes` tag them `[sensitive]`. Details: [privacy](configuration.md#privacy-sensitive-profiles).

## Supervision survives interruptions

Workers belong to the scope, not to the steer that started them; the active steer supervises every open worker of its scope. The supervision state lives in the main workspace, so a steer that was cleared, restarted or replaced continues from `resume`. A steer that starts workers does not simply go idle: the factory wakes the active steer immediately for every actionable worker outcome, with only a tiny debounce, and a watchdog wakes it when nothing happens. If the active steer does not answer, is advisor-flagged, or its quota pool is exhausted, the next ready steer from a different pool takes over on its own with an epoch-checked `switch`. A steer never ends its turn with open TODO items unless a worker or watcher is running; after each accepted result it starts the next package, using 2–3 non-conflicting workers in parallel. Escalation runs worker → steer → advisor → domain/hub steer; the user is asked only with a `user:` blocker, when all of these are stuck. An agent is ignored only when it is archived or has no scope assignment; `closed` never means done. Design: [supervision](supervision-design.md).

## Label and metadata prefix

Factory labels and metadata keys use the neutral `wsf.*` prefix. Records created by the pilot still carry `ari.wsf.*`: they are read transparently (the new prefix wins when both are present) and marked `legacyPrefix`, and a normal `plan` proposes one `labels.migrate` op per workspace and agent to rewrite them through the usual hash-confirmed apply. Workspace metadata is fully rewritten (old keys removed); agent labels only gain the new keys — neither the SDK nor `paseo agent update` can remove agent labels, so the old ones linger and stay readable. After the apply a fresh plan is clean.

## Provisioning safety

- **Dry-run first.** `plan` never writes to GitHub, git or Paseo. It stores the complete plan as an authorization (`plans/<hash>.json`, never overwritten).
- **Confirmed plan only.** `apply --confirm <hash>` executes only operations of that stored plan. After each step it rediscovers the state; the next operation must match the authorized one in every effect-relevant parameter, otherwise it stops and asks for a new dry-run.
- **Idempotent creation.** Workspaces and steers are created with daemon idempotency keys. If a create was sent but its result was lost, apply reads the daemon receipt for that key before anything else and either recovers the id, allows one first execution (no receipt, nothing observed) or stops.
- **Parent-free steers.** Steers are created through the SDK without `parent` and without a prompt; the parent label is verified after creation. CLI calls run without `PASEO_AGENT_ID`.
- **Paths.** Clone targets must stay below `checkoutRoot` without symlink components; the target directory's parent identity is re-checked right before cloning.
- **One apply at a time.** A kernel `flock` held by the factory process serializes `apply` runs on the host; switches and checkpoints use a per-workspace lock.
- **Conflicts are reported, never resolved automatically**: ambiguous checkouts, occupied targets, a different `upstream`, steers with a parent, duplicate main workspaces, profiles the provider cannot start, unconfirmed adoption of unlabelled "Steer X" agents (`--adopt X=<id>`).

## Limits

- Locks protect cooperating factory processes on one host only. Agents, the Paseo UI and other hosts are not blocked.
- The active steer is a coordination rule, not an execution lock: a standby steer you message directly will still act.
- The receipt lookup uses an internal Paseo protocol message; it is pinned to the tested daemon version and fails closed otherwise.
- Worker archiving is preview-only: Paseo removes owned worktrees with `git worktree remove --force` when a workspace is archived.
