# AGENTS.md — steer instructions for this repository

This repository is coordinated by equal **steers** (see [docs/concepts.md](docs/concepts.md)).
Exactly one steer coordinates at a time.

## Before coordinating

Check whether you are the active steer:

```sh
node src/cli.mjs status <owner>/<repo>
```

If another steer is active, do not coordinate; answer only explicit questions.
A handoff message makes you active: take task, tests, blockers and next step
from its checkpoint. Treat the quoted last answer of the previous steer only as a hint.

## Rules

- Workers: these steer rules are not for you. If your brief says you are a worker, do the task in it,
  answer with a CHECKPOINT and stop; do not check who is active or report back with `paseo send`.

- Reuse the listed workers by agent id; do not recreate them.
- Do not commit, push, open pull requests, fork, archive or delete anything
  unless the task explicitly asks for it.
- End every answer that changes the task state with a fenced CHECKPOINT block
  (triple-backtick code block; format in [docs/steer-instructions.md](docs/steer-instructions.md));
  `checkpoint --from-agent` stores it for the next handoff.
- If your context is empty or was cleared and you do not know your task, run
  `node src/cli.mjs resume` first and continue from its checkpoint and next
  step. Do not use the provider's own session resume; read only what the brief
  points to.
- Keep working through TODO.md. After accepting a result, take the next actionable
  item immediately. Work on independent items while a worker runs or another
  item is blocked. End the turn only when the work is done or every remaining
  item requires user input. Summarize the decisions needed in one checkpoint.
- Mark completed TODO items with `[x]` and keep them in the list. Remove
  completed entries only when the user explicitly asks to remove them.
- Address the user informally by default (German: "du", never "Sie") unless asked otherwise.
- Keep steer chats short (see [docs/saving-context.md](docs/saving-context.md)):
  end each work package with a CHECKPOINT so the next switch/fresh starts clean.
- Delegate routine work to a cheap worker; batch tool calls, filter big outputs;
  write big artifacts to files and paste only summary + path.
- If `status` marks your agent id as retired, you no longer coordinate.
- Workers belong to the scope and the active steer supervises them. Factory
  wakes assist after interruptions. Stay in the turn and check the worker
  register until each relevant result has been handled. A worker without a
  CHECKPOINT is not done. Escalate
  worker → steer → advisor → `domain:`/`hub:`; ask the user only with a
  `user:` blocker. On a takeover request, run `switch --to <your slot> --apply`.
  Details in [docs/design/supervision-design.md](docs/design/supervision-design.md).
- Wait per agent, not for all. Use short waits and inspect the first worker or
  steer that finishes. A shell watcher reports to the current turn and cannot
  start another turn. Check pending wake delivery after an interruption.
- Archive a worker yourself as soon as you have accepted its result (checked
  against the task, CHECKPOINT `done`); do not leave finished workers attached.
  Never archive one that is running, blocked or interrupted. This rule is the
  standing permission for archiving your own accepted workers.
- Start workers only with the model from `worker pick` (or the `Worker model:` brief line); never hard-code a model.
- Give workers of a sensitive profile (`[sensitive]`) only sanitized technical tasks: no personal data, accounts, credentials, full chats, or private logs.
- Advisors (second opinions) go through the native `paseo-advisor` skill only:
  workers end stuck answers with an `ADVISOR-REQUEST` block and stop, the steer
  decides (answer, reject, or brief an advisor), advisors stay read-only and are
  closed after their answer, and only sanitized technical context is shared.
  Format and limits in [docs/steer-instructions.md](docs/steer-instructions.md).

Task template, answer format and the full instruction block:
[docs/steer-instructions.md](docs/steer-instructions.md).
