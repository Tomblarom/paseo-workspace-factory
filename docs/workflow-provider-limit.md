# Workflow example: provider limit reached

The active steer (slot A) hits its provider limit in the middle of a task.
Goal: record where the work stands, then hand coordination to Steer B on a
different provider, without replaying chat history. Workers stay where they
are and are reused by agent id. See [concepts](concepts.md) for the terms
used here (active steer, epoch, checkpoint, handoff).

All commands below use `<you>/<repo>` for the repository as shown by `status`.

## 0. Check the current state

```sh
node src/cli.mjs status <you>/<repo>
```

Expected output (ids shortened):

```text
<you>/<repo> · workspace ws-1 · active Steer A (epoch 1)
  checkpoint 2026-11-23T12:00:00.000Z
    task: Migrate the planner to the new slot config
    next: Review the dry-run output
  Steer A  aaa111…  codex/gpt-6.2-sol  idle
  Steer B  bbb222…  claude/claude-sonnet-5-5  idle
  worker ccc333… "docs worker" muse/muse-spark-1.3-contributor idle ← Steer A
```

This tells you the active steer (A), the epoch (1), the last checkpoint and
which target slots exist. If Steer B is missing here, jump to
[No target slot](#no-target-slot-provision-one-first) before switching.

## 1. Checkpoint the limited steer

Take the CHECKPOINT block from the last answer of Steer A (full agent id or
a unique prefix both work):

```sh
node src/cli.mjs checkpoint <you>/<repo> --from-agent <steer-A-id> --next "Continue with the planner migration"
```

Expected output, the stored checkpoint as JSON:

```json
{
  "task": "Migrate the planner to the new slot config",
  "tests": ["npm test"],
  "blockers": [],
  "next": "Continue with the planner migration",
  "epoch": 1,
  "updatedAt": "2026-11-23T12:05:00.000Z"
}
```

Notes:

- `--next` is optional and overrides the `next:` line of the CHECKPOINT block.
- `--from-agent` fails when the id is not a steer of this repository
  (`<id> is not a steer of <repo>`) or when the steer's last answer has no
  CHECKPOINT block with a `task:` line. In the latter case, write the
  checkpoint manually with `--task/--test/--blocker/--next` instead.
- Checkpoint *before* switching: the handoff carries this checkpoint to the
  new steer. Without one the handoff says `NONE RECORDED` and the new steer
  must confirm the task with the user instead of continuing.

## 2. Preview the switch (dry-run)

```sh
node src/cli.mjs switch <you>/<repo> --to B
```

Expected output:

```text
Dry-run: Steer A → B (epoch 2) · handoff 1234 characters, built without a model call
---
Steer handoff for <you>/<repo>: epoch 1 → 2.
…
```

The dry-run prints the full handoff packet but changes nothing and delivers
nothing. Check that the checkpoint lines and the worker list are correct.
A `· NO task checkpoint` suffix here means step 1 was skipped.

## 3. Switch, deliver and wait for the reply

```sh
node src/cli.mjs switch <you>/<repo> --to B --apply --wait
```

Expected output:

```text
Switched: Steer A → B (epoch 2) · handoff 1234 characters, built without a model call · delivered
---
Steer handoff for <you>/<repo>: epoch 1 → 2.
…
--- reply of Steer B
<the new steer's first answer>
```

What happened: the factory wrote `activeSteer: B, epoch: 2` to the workspace
metadata (under the per-workspace lock, after re-checking the expected
epoch), delivered the handoff to Steer B, and `--wait` printed Steer B's
first answer (waits up to 10 minutes; only takes effect when delivered).

Optional: add `--notify-previous` to also send a short notice to Steer A
that it no longer coordinates. This costs one turn of the previous steer,
so only use it when that steer is still able to act. The output then ends
with `· previous steer notified`.

If delivery fails, the output ends with `· delivery failed: <reason>` but
the switch still stands — resend the printed packet to Steer B manually.

## No target slot: provision one first

Switching to a slot that has no steer fails:

```text
Steer B does not exist for <you>/<repo>
```

This is expected with the default config, which provisions only slot A.
Fix it by adding the slot to `steers.slots` in your config (outside the
repository), then planning and applying just that slot:

```sh
# config: "steers": { "slots": { "A": "codex-high", "B": "claude-sonnet" }, … }
node src/cli.mjs plan <you>/<repo> --slots B
node src/cli.mjs apply --confirm <hash>
```

`--slots` must name slots defined in `steers.slots`. Alternatively, adopt an
existing unlabelled agent into the slot:

```sh
node src/cli.mjs plan <you>/<repo> --adopt B=<agent-id>
node src/cli.mjs apply --confirm <hash>
```

Then retry the switch from step 2. See [configuration](configuration.md)
for the slot and profile fields.

## Other switch refusals

| Error | Meaning |
|---|---|
| `Steer B is already active` | Nothing to do. |
| `Steer B is running` (or `initializing`) | The target is busy; wait for its turn to end. |
| `Active Steer A is running; stop it or wait …` | The current steer is mid-turn; wait, then retry. |
| `Steer B has parent …` | Only parent-free steers coordinate; pick another slot. |
| `Steer B is not in the main workspace` | Pick a steer from the main workspace. |
| `Steer state changed (expected …); rerun the switch` | Someone else switched first; re-check `status`. |
