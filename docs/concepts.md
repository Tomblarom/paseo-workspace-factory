# Concepts and safety model

## Building blocks

| Term | Meaning |
|---|---|
| Scope | The unit of coordination: exactly one main workspace with factory metadata, its steers (slots A–Z), epoch, checkpoint and workers. Kinds: `github` (`owner/repo`), `dir` (plain directory), `workspace` (adopted existing workspace), `hub` (coordinator, at most one per host). The scope id lives in `wsf.scope`; steers carry it as label `wsf.scope`. |
| Main workspace | The scope's home workspace (any kind), holding the steers and the factory state in its metadata. Its title follows the `workspaceTitle` template. |
| Steer | Top-level coordinating agent (no parent), identified by labels `wsf.scope`, `wsf.role=steer`, `wsf.slot=<A..Z>` (`wsf.repo` kept for compatibility). The role is independent of provider and model. |
| Hub | A scope of kind `hub` whose steers coordinate other scopes (provisioning, lifecycle, models, adoption, priorities); see Roles below. |
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
| Scope steer | tasks of its scope, its workers, its CHECKPOINT | other scopes, destructive lifecycle ops |
| Worker | one bounded task | coordination |

Relations stay logical (metadata/labels), never `parent`: steers stay parent-free. Hub → scope: `assign <scope> --task … --next …` writes the scope checkpoint (epoch-checked, preview first) and delivers it to the active scope steer. Scope → hub: the CHECKPOINT block; blockers prefixed `hub:` are escalations.

## Label and metadata prefix

Factory labels and metadata keys use the neutral `wsf.*` prefix. Records
created by the pilot still carry `ari.wsf.*`: they are read transparently
(the new prefix wins when both are present) and marked `legacyPrefix`, and a
normal `plan` proposes one `labels.migrate` op per workspace and agent to
rewrite them through the usual hash-confirmed apply. Workspace metadata is
fully rewritten (old keys removed); agent labels only gain the new keys —
neither the SDK nor `paseo agent update` can remove agent labels, so the old
ones linger and stay readable. After the apply a fresh plan is clean.

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
