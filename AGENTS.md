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
- Never end a turn with open TODO items unless a worker or watcher is running.
  After accepting a result, start the next package immediately; use 2–3 workers
  in parallel when their files do not conflict.
- Address the user informally by default (German: "du", never "Sie") unless asked otherwise.
- Keep steer chats short (see [docs/saving-context.md](docs/saving-context.md)):
  end each work package with a CHECKPOINT so the next switch/fresh starts clean.
- Delegate routine work to a cheap worker; batch tool calls, filter big outputs;
  write big artifacts to files and paste only summary + path.
- If `status` marks your agent id as retired, you no longer coordinate.
- Supervision survives interruptions: workers belong to the scope and the
  active steer supervises them. After starting workers, end your turn; the
  factory wakes you. A worker without a CHECKPOINT is not done. Escalate
  worker → steer → advisor → `domain:`/`hub:`; ask the user only with a
  `user:` blocker. On a takeover request, run `switch --to <your slot> --apply`.
  Details in [docs/supervision-design.md](docs/supervision-design.md).
- Wait per agent, not for all: start one background watcher that ends when the
  FIRST watched agent (worker or steer you asked) stops running, handle it,
  then start the next watcher. A watcher that waits for all agents hides
  finished results. An answer from another steer also needs such a watcher.
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
