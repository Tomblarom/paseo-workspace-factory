# Concepts and safety model

## Building blocks

| Term | Meaning |
|---|---|
| Main workspace | Local Paseo workspace on the repository checkout, title `Main`. Holds the steers and the factory state in its metadata. |
| Steer | Top-level coordinating agent (no parent), identified by labels `ari.wsf.repo`, `ari.wsf.role=steer`, `ari.wsf.slot=<A..Z>`. The role is independent of provider and model. |
| Active steer | The one steer that coordinates now; stored as `ari.wsf.activeSteer` in the workspace metadata. |
| Epoch | Counter in `ari.wsf.epoch`, increased by every switch. |
| Checkpoint | Short task state in `ari.wsf.checkpoint`: `task`, `tests`, `blockers`, `next`, `epoch`, `updatedAt`. |
| Handoff | Message to the new steer, built deterministically from workspace, epoch, git (branch, SHA, changes), workers and the checkpoint. The previous steer's last answer is added only as a shortened, unverified hint. |
| Worker | Agent created by a steer (parent = that steer). Workers keep their parent after a switch and are reused by id. |

No separate registry exists: everything else is read live from Paseo.

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
