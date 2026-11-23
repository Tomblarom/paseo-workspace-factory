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
- If your context is empty or was cleared and you do not know your task, run
  `<factory> resume` first and continue from its checkpoint and next step. Do
  not use the provider's own session resume; read only what the brief points to.
- Reuse the listed workers by agent id; do not recreate them.
- Do not commit, push, open pull requests, fork, archive or delete anything unless
  the task explicitly asks for it.
- End every answer that changes the task state with a fenced CHECKPOINT block
  (triple-backtick code block, see Answer format below).
- Keep this chat short: end each work package with a CHECKPOINT so the next
  switch/fresh starts clean; delegate routine work to a cheap worker.
- Batch tool calls, filter big outputs, write big artifacts to files and paste
  only summary + path. If status marks your agent id as retired, stop coordinating.
```

## Cold resume

The resume rule in the block above is the fallback every steer and worker
follows after a cleared or compacted context. Optionally, a Claude Code
SessionStart hook can print the brief automatically (see
[configuration](configuration.md#resume-brief)); the factory never changes
host settings itself.

## Hub instructions

A hub steer coordinates scopes; it does not do their content work. Paste this
block instead of the steer block above:

```text
You are a hub steer: you coordinate factory scopes from above.
- Provision and retire scopes with plan/apply; assign models and slots across scopes.
- Send work with <factory> assign <scope> --task ... --next ... (preview first, then --apply).
- Read back each scope's CHECKPOINT; treat blockers prefixed "hub:" as escalations.
- Never message a scope's workers directly; go through its active steer.
- Relations stay logical (workspace metadata and labels); steers stay
  parent-free, including yours. Address scopes by id (see `scopes`).
```

## Worker instructions

Workers do one bounded task; they never coordinate. Paste this block into a
worker's first message (steers: add the task template below it):

```text
You are a worker for this repository: do the assigned task, do not coordinate.
- Take task, scope and limits from your assignment; ask your steer when stuck.
- If your context is empty or was cleared and you do not know your task, run
  `<factory> resume` first and continue from its checkpoint and next step. Do
  not use the provider's own session resume; read only what the brief points to.
- End your answer with a fenced CHECKPOINT block (triple-backtick code
  block, see Answer format in the steer instructions).
- If a second opinion would help, end with an ADVISOR-REQUEST block instead
  and stop; your steer decides (see Advisor policy).
```

## Task template

```text
Task: <one sentence>
Scope: <files/areas>; read-only | changes allowed in <paths>
Limits: no installs | no git writes | no pull request | no workers  (keep what applies)
Answer: at most <n> lines, then the fenced CHECKPOINT block.
```

## Answer format

The CHECKPOINT block is a real Markdown code block (triple backticks). Every
factory-generated text (handoff, `switch`/`fresh`/`assign` delivery) carries
the checkpoint in this form, and every steer/worker answer ends with it:

````text
<short result>

```text
CHECKPOINT
- task: <current task state in one sentence>
- tests: <commands or checks that apply, or "none">
- blockers: <open problems, or "none">
- next: <the next step for whoever continues>
```
````

Field names stay fixed English; an optional `- workers:` line is allowed and
ignored. Readers (`checkpoint --from-agent`, the auto-checkpoint feeding
`resume`) also accept the bare form without a fence.

`<factory> checkpoint <owner>/<repo> --from-agent <steer-id>` stores this block as the checkpoint, so the next `switch` hands it over unchanged.

## Advisor policy

Workers never ask for an advisor themselves. When a worker is stuck and a
second opinion would help, it ends its answer with an `ADVISOR-REQUEST`
block (question, sanitized context, why it is needed) and stops:

```text
ADVISOR-REQUEST
question: <one sharp question>
context: <sanitized technical facts only: file paths, error text, what was tried and ruled out>
why: <why the worker cannot decide this alone>
```

The steer decides: answer it itself, reject the request with a reason, or
brief an advisor. Steers may also consult an advisor on their own initiative,
without a worker request.

Advisors always go through the native Paseo advisor mechanism (skill
`paseo-advisor`): single agent, `[Advisor] <topic>` title, self-contained
briefing, read-only plan mode. When `advisors.profiles` maps the purpose to
a factory profile, use that profile; otherwise let the skill match its own
profiles. Limits, no exceptions:

- Analysis only: no edits, no files, no code, no workers, no writes.
- Close the advisor after its answer; synthesize verdict plus own
  recommendation. No persistent advisor unless the user asks for one.
- Privacy: only sanitized technical context crosses provider boundaries —
  no personal data, accounts, credentials, or secrets. File paths, not pastes.
