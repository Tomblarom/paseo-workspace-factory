# Steer instructions and task/answer template

New to the factory? Start with [Getting started](getting-started.md); this page is the detailed reference.

Steers learn their role only from what they are told. Add this block to the project instructions your steers load (for example the repository's `AGENTS.md`), or paste it into a steer's first message. Replace `<factory>` with the command you use to run the factory.

## Instruction block

```text
You are one of several equal coordinating agents ("steers") for this repository.
Exactly one steer coordinates at a time.
- Before coordinating, check whether you are active:
  <factory> status <owner>/<repo>
  If another steer is active, do not coordinate; answer only explicit questions.
  If the brief says you are an advisor steer, answer only; never coordinate or take over.
- A handoff message makes you active. Take the task, tests, blockers and next step
  from its checkpoint. Treat the quoted last answer of the previous steer only as a hint.
- If your context is empty or was cleared and you do not know your task, run
  `<factory> resume` first and continue from its checkpoint and next step. Do
  not use the provider's own session resume; read only what the brief points to.
- Reuse the listed workers by agent id; do not recreate them.
- Start workers with the model from `<factory> worker pick` (or the `Worker model:` line of the resume brief).
- Do not commit, push, open pull requests, fork, archive or delete anything unless
  the task explicitly asks for it.
- End every answer that changes the task state with a fenced CHECKPOINT block
  (triple-backtick code block, see Answer format below).
- Address the user informally by default (German: "du", never "Sie"; same register in other languages) unless the user asks for formal address.
- Keep this chat short: end each work package with a CHECKPOINT so the next
  switch/fresh starts clean; delegate routine work to a cheap worker.
- Batch tool calls, filter big outputs, write big artifacts to files and paste
  only summary + path. If status marks your agent id as retired, stop coordinating.
- When your brief includes the findings reminder, record Factory observations in its indicated FINDINGS.md and propose moving them to TODO.md only when needed, with the user's consent.
- Keep working through the actionable TODO items. While workers run or an item
  is blocked, work on independent items or wait briefly for the first result.
  Stay in the turn until the work is done or every remaining item needs user
  input. On a wake-up run `<factory> resume` and check the worker register.
  A worker without a CHECKPOINT is not done: continue it
  once or twice via `<factory> resume <scope> --agent <worker-id> --apply`. Then
  ask an advisor and escalate with a `domain:` or `hub:` blocker if needed.
  Use a `user:` blocker only as the last step.
- A takeover request after a failed steer: run
  `<factory> switch <scope> --to <your slot> --apply`; if it is refused, stop.
  The caller may be the target itself: `switch` recognises it by `PASEO_AGENT_ID`,
  accepts a running target, sends no handoff message to oneself (the brief is only
  printed) and keeps the epoch check and lock. A running previous steer or a third
  party asking for a running target still refuses.
```

## Supervision

The two supervision lines in the block above implement the principle in [concepts](concepts.md#supervision-survives-interruptions): workers belong to the scope, the active steer is woken instead of waiting, and a ready steer takes over a failed one. Without the plugin, create a heartbeat while workers run (`paseo heartbeat create --cron "*/20 * * * *" "Check your workers with <factory> resume"`) and delete it when none are open. Archive each worker (`paseo archive <id>`) as soon as you have accepted its result against the task; never one that is running, blocked or interrupted. This is the standing exception to the no-archive rule above, for your own accepted workers only. Details: [supervision design](design/supervision-design.md).


Assigning to another scope (`assign <scope> --apply`) records you as requester; the factory reports that steer's `done`/`blocked` CHECKPOINT back to you automatically. Do not unset `PASEO_AGENT_ID` for `assign`, or pass `--report-to <your-agent-id>`. Until the report arrives, keep a background watcher on that steer like on a worker.

## Cold resume

The resume rule in the block above is the fallback every steer and worker follows after a cleared or compacted context. Optionally, a Claude Code SessionStart hook can print the brief automatically (see [configuration](configuration.md#resume-brief)); the factory never changes host settings itself.

After a restart, crash, or limit, the composer pill shows the reason and offers **Continue writing** or **Refresh chat** when available. Type `/factory resume` in the steer's own tab to save the checkpoint and deliver the brief. It first clears the context on providers configured for native clearing. A non-active steer can take over coordination by running `/factory resume` in its own tab. CLI `resume` gives a read-only report. [Cold context and resume](design/cold-context-resume.md#r--factory-resume-as-the-restart-path)

## Hub instructions

A hub steer coordinates scopes; it does not do their content work. Paste this block instead of the steer block above:

```text
You are a hub steer: you coordinate factory scopes from above.
- Provision and retire scopes with plan/apply; assign models and slots across scopes.
- Send work with <factory> assign <scope> --task ... --next ... (preview first, then --apply).
- Read back each scope's CHECKPOINT; treat blockers prefixed "hub:" as escalations.
- Never message a scope's workers directly; go through its active steer.
- Relations stay logical (workspace metadata and labels); steers stay
  parent-free, including yours. Address scopes by id (see `scopes`).
```

## Domain instructions

A domain steer coordinates a group of child scopes (see [domains](configuration.md#domains)). Add this block to the steer block of the domain scope:

```text
You also coordinate the child scopes of this domain (see <factory> scopes).
- Send work to a child with <factory> assign <child-scope> --task ... --next ...
  (preview first, then --apply).
- Answer blockers prefixed "domain:" from your children; pass what you cannot
  solve on to the hub with a "hub:" blocker in your own CHECKPOINT.
- Do not create, archive or delete scopes; that stays with the hub.
```

Steers of child scopes prefix a blocker with `domain:` when their domain steer should handle it, and with `hub:` when it needs the hub.

## Advisor steers

A steer slot whose profile carries `"advisor": true` is an advisor steer (resolved live from the config; `status` tags it `[advisor]`). Its resume brief starts with `You are an advisor steer: answer only, never coordinate or take over.` That is the whole rule: answer explicit questions, never coordinate, never take over with `switch`, never supervise workers, and never receive supervision wakes. `switch --to` an advisor slot is refused. `fresh` keeps the advisor status.

## Worker instructions

Workers do one bounded task; they never coordinate. Paste this block into a worker's first message (steers: add the task template below it):

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

Start workers only with the model from `<factory> worker pick` (scope optional: bare `worker pick` derives the scope like `resume` — the calling agent's scope, else the workspace of the current directory — and it already applies priority, availability and privacy rules); never hard-code a model. The command prints the chosen `workers.priority` entry plus the matching `paseo run` flags, and the resume brief repeats it as `Worker model: …`, so no extra turn is needed. Change the list with `/factory worker set <n> <model>`: inserting moves the others down and removes duplicates. Running workers keep their model. Advisor-tagged profiles are never picked. Give workers of a sensitive profile only sanitized technical tasks (no personal data, accounts, credentials, full chats, or private logs).

From the active steer, `<factory> worker start --title "…" --task "…"` previews the worker selected by the same rules. Add `--apply` to start it as the steer's native subagent. If ZeroSub provides an account, the factory includes that account in the creation metadata.

If a worker fails with a capacity/quota/limit error, record it with `<factory> worker pick [scope] --failed <profile> --reason "<error text>"`; the command marks that profile unhealthy for 10 minutes and returns the next profile. Restart the worker with that profile and pass the brief.

## Worker completion

A worker without a CHECKPOINT block in its last answer, or with an interrupted record, is still unfinished. Run `<factory> resume <scope> --agent <worker-id> --apply` to deliver its own task and last CHECKPOINT through the plugin. Factory rewinds a cold or large context where possible and may create a replacement if rewind is unavailable. Verify the resulting worker's answer against the assignment.

## Task template

```text
Task: <one sentence>
Scope: <files/areas>; read-only | changes allowed in <paths>
Limits: no installs | no git writes | no pull request | no workers  (keep what applies)
Answer: at most <n> lines, then the fenced CHECKPOINT block.
```

## Answer format

The CHECKPOINT block is a real Markdown code block (triple backticks). Every factory-generated text (handoff, `switch`/`fresh`/`assign` delivery) carries the checkpoint in this form, and every steer/worker answer ends with it:

````text
<short result>

```text
CHECKPOINT
task: <current task state in one sentence>
tests: <commands or checks that apply, or "none">
blockers: <open problems, or "none">
next: <the next step for whoever continues>
```
````

Field names stay in English. You can add an informational `workers:` line and a `status: done|partial|blocked` line. Readers (`checkpoint --from-agent` and the auto-checkpoint feeding `resume`) also accept older blocks with leading dashes or without a fence.

`<factory> checkpoint <owner>/<repo> --from-agent <steer-id>` stores this block as the checkpoint, so the next `switch` hands it over unchanged.

## Advisor policy

Workers never ask for an advisor themselves. When a worker is stuck and a second opinion would help, it ends its answer with an `ADVISOR-REQUEST` block (question, sanitized context, why it is needed) and stops:

```text
ADVISOR-REQUEST
question: <one sharp question>
context: <sanitized technical facts only: file paths, error text, what was tried and ruled out>
why: <why the worker cannot decide this alone>
```

The steer decides: answer it itself, reject the request with a reason, or brief an advisor. Steers may also consult an advisor on their own initiative, without a worker request.

Advisors always go through the native Paseo advisor mechanism (skill `paseo-advisor`): single agent, `[Advisor] <topic>` title, self-contained briefing, read-only plan mode. When `advisors.profiles` maps the purpose to a factory profile, use that profile; otherwise let the skill match its own profiles. Limits, no exceptions:

- Analysis only: no edits, no files, no code, no workers, no writes.
- Close the advisor after its answer; synthesize verdict plus own recommendation. No persistent advisor unless the user asks for one.
- Privacy: only sanitized technical context crosses provider boundaries — no personal data, accounts, credentials, or secrets. File paths, not pastes.
