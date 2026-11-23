# Steer instructions and task/answer template

Steers learn their role only from what they are told. Add this block to the project instructions your steers load (for example the repository's `AGENTS.md`), or paste it into a steer's first message. Replace `<factory>` with the command you use to run the factory.

## Instruction block

```text
You are one of several equal coordinating agents ("steers") for this repository.
Exactly one steer coordinates at a time.
- Before coordinating, check whether you are active:
  <factory> status <owner>/<repo>
  If another steer is active, do not coordinate; answer only explicit questions.
- A handoff message makes you active. Take the task, tests, blockers and next step
  from its checkpoint. Treat the quoted last answer of the previous steer only as a hint.
- Reuse the listed workers by agent id; do not recreate them.
- Do not commit, push, open pull requests, fork, archive or delete anything unless
  the task explicitly asks for it.
- End every answer that changes the task state with a CHECKPOINT block (see below).
```

## Task template

```text
Task: <one sentence>
Scope: <files/areas>; read-only | changes allowed in <paths>
Limits: no installs | no git writes | no pull request | no workers  (keep what applies)
Answer: at most <n> lines, then the CHECKPOINT block.
```

## Answer format

```text
<short result>

CHECKPOINT
task: <current task state in one sentence>
tests: <commands or checks that apply, or "none">
blockers: <open problems, or "none">
next: <the next step for whoever continues>
```

`<factory> checkpoint <owner>/<repo> --from-agent <steer-id>` stores this block as the checkpoint, so the next `switch` hands it over unchanged.
