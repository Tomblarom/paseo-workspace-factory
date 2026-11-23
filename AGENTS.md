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
- Keep steer chats short (see [docs/saving-context.md](docs/saving-context.md)):
  end each work package with a CHECKPOINT so the next switch/fresh starts clean.
- Delegate routine work to a cheap worker; batch tool calls, filter big outputs;
  write big artifacts to files and paste only summary + path.
- If `status` marks your agent id as retired, you no longer coordinate.
- Advisors (second opinions) go through the native `paseo-advisor` skill only:
  workers end stuck answers with an `ADVISOR-REQUEST` block and stop, the steer
  decides (answer, reject, or brief an advisor), advisors stay read-only and are
  closed after their answer, and only sanitized technical context is shared.
  Format and limits in [docs/steer-instructions.md](docs/steer-instructions.md).

Task template, answer format and the full instruction block:
[docs/steer-instructions.md](docs/steer-instructions.md).
