# Steer instructions and task/answer template

New to the factory? Start with [Getting started](getting-started.md); this page is the detailed reference.

Steers learn their role from the plugin: it appends the static role rules below to every interactive factory steer session, so managed repositories no longer need a steer block in their `AGENTS.md`. Only steers the hook cannot reach still need the rules in their project instructions: copilot steers (the ACP adapter ignores appended system prompts) and antigravity steers (unverified) — copy the steer text from `plugin/server/core/role-prompts.mjs` into the repository's `AGENTS.md`.

## Instruction block

The exact steer rule text lives in a single source, `plugin/server/core/role-prompts.mjs` (`STEER_ROLE_PROMPT`); there is no second copy. The plugin appends it to every interactive factory steer session (codex, claude, muse) via the native `agent.open.before` hook. Where the role texts name the factory CLI, the plugin renders the runnable command once per host: `node <installed plugin dir>/cli.mjs` — the CLI ships inside the plugin package, so checkout, release snapshot and registry installs all contain it. Each appended steer/advisor text ends with a stable identifier line (bumped only when the text changes), and the hook logs one line per append as the delivery evidence trail. In short, every steer checks it is active before coordinating, takes over only through handoffs and `switch`, runs `paseo-factory resume` after a cleared context, reuses workers by id, starts them only with the model from `paseo-factory worker pick`, never writes to git or GitHub unless asked, and ends state-changing answers with a fenced CHECKPOINT block.

## Supervision

The plugin wakes the active steer for worker results, stale work and pending recovery. Without the plugin, use `paseo wait` during the active turn and `paseo-factory workers` to inspect the register. Archive each worker (`paseo archive <id>`) as soon as you have accepted its result against the task. Running, blocked and interrupted workers remain attached. This is the standing exception to the no-archive rule above, for your own accepted workers only. [Supervision design](design/supervision-design.md)


Assigning to another scope (`assign <scope> --apply`) records you as requester; the factory reports that steer's `done`/`blocked` CHECKPOINT back to you automatically. Do not unset `PASEO_AGENT_ID` for `assign`, or pass `--report-to <your-agent-id>`. Then end the turn; the report wakes you. Work in packages: once a package is done or delegated and its CHECKPOINT is written, end the turn instead of polling.

## Cold resume

The resume rule in the block above is the fallback every steer and worker follows after a cleared or compacted context. Optionally, a Claude Code SessionStart hook can print the brief automatically (see [configuration](configuration.md#resume-brief)); the factory never changes host settings itself.

After a restart, crash, or limit, the composer pill shows the reason and offers **Continue writing** or **Refresh chat** when available. Type `/factory resume` in the steer's own tab to save the checkpoint and deliver the brief. It first clears the context on providers configured for native clearing. A non-active steer can take over coordination by running `/factory resume` in its own tab. CLI `resume` gives a read-only report. [Cold context and resume](design/cold-context-resume.md#r--factory-resume-as-the-restart-path)

## Hub instructions

A hub steer coordinates scopes; it does not do their content work. Paste this block instead of the steer block above:

```text
You are a hub steer: you coordinate factory scopes from above.
- Provision and retire scopes with /factory plan and /factory apply; assign models and slots across scopes.
- Send work with paseo-factory assign <scope> --task ... --next ... (preview first, then --apply).
- Read back each scope's CHECKPOINT; treat blockers prefixed "hub:" as escalations.
- Never message a scope's workers directly; go through its active steer.
- Relations stay logical (workspace metadata and labels); steers stay
  parent-free, including yours. Address scopes by id (see `/factory scopes`).
```

## Domain instructions

A domain steer coordinates a group of child scopes (see [domains](configuration.md#domains)). Add this block to the steer block of the domain scope:

```text
You also coordinate the child scopes of this domain (see /factory scopes).
- Send work to a child with paseo-factory assign <child-scope> --task ... --next ...
  (preview first, then --apply).
- Answer blockers prefixed "domain:" from your children; pass what you cannot
  solve on to the hub with a "hub:" blocker in your own CHECKPOINT.
- Do not create, archive or delete scopes; that stays with the hub.
```

Steers of child scopes prefix a blocker with `domain:` when their domain steer should handle it, and with `hub:` when it needs the hub.

## Advisor steers

A steer slot whose profile carries `"advisor": true` is an advisor steer (resolved live from the config; `status` tags it `[advisor]`). The plugin appends the advisor rule text (`ADVISOR_ROLE_PROMPT` in `plugin/server/core/role-prompts.mjs`, the single source) to its sessions via the same hook. Its resume brief starts with `You are an advisor steer: answer only, never coordinate or take over.` That is the whole rule: answer explicit questions, never coordinate, never take over with `switch`, never supervise workers, and never receive supervision wakes. `switch --to` an advisor slot is refused. `/factory fresh` keeps the advisor status. The brief line stays as the copilot/antigravity fallback.

## Worker instructions

Workers do one bounded task; they never coordinate. The exact worker rule text lives in a single source, `plugin/server/core/role-prompts.mjs` (`WORKER_ROLE_PROMPT`); `worker start` appends it to every worker prompt on all providers, so there is nothing to paste. (Steers: add the task template below the assignment.) In short, a worker does its assigned task, runs `paseo-factory resume` after a cleared context, and ends its answer with a fenced CHECKPOINT block — or with an ADVISOR-REQUEST block when a second opinion would help.

Start workers only with the model from `paseo-factory worker pick` (scope optional: bare `worker pick` derives the scope like `resume` — the calling agent's scope, else the workspace of the current directory — and it already applies priority, availability and privacy rules); never hard-code a model. The command prints the chosen `workers.priority` entry plus the matching `paseo run` flags, and the resume brief repeats it as `Worker model: …`, so no extra turn is needed. Change the list with `/factory worker set <n> <model>`: inserting moves the others down and removes duplicates. Running workers keep their model. Advisor-tagged profiles are never picked. Give workers of a sensitive profile only sanitized technical tasks (no personal data, accounts, credentials, full chats, or private logs).

From the active steer, `paseo-factory worker start --title "…" --task "…"` previews the worker selected by the same rules. Add `--apply` to start it as the steer's native subagent. If ZeroSub provides an account, the factory includes that account in the creation metadata.

If a worker fails with a capacity/quota/limit error, record it with `paseo-factory worker pick [scope] --failed <profile> --reason "<error text>"`; the command marks that profile unhealthy for 10 minutes and returns the next profile. Restart the worker with that profile and pass the brief.

## Worker completion

A worker without a CHECKPOINT block in its last answer still has unfinished work. Resume an interrupted worker or continue a partial CHECKPOINT with `paseo-factory resume <scope> --agent <worker-id> --apply`. The resume brief carries the worker's own task and latest checkpoint. It rewinds a cold or large context where possible and may create a replacement if rewind is unavailable. For an expanded assignment, include the new scope in the follow-up. A queued send acknowledges enqueueing. Use the recipient's timeline or active turn to confirm dispatch before reporting progress. Verify the result against the assignment before archiving the worker.

## Task template

```text
Task: <one sentence>
Scope: <files/areas>; read-only | changes allowed in <paths>
Limits: no installs | no git writes | no pull request | no workers  (keep what applies)
Answer: at most <n> lines, then the fenced CHECKPOINT block.
```

## Answer format

The CHECKPOINT block is a real Markdown code block (triple backticks). Every factory-generated text (handoff, `switch`/`/factory fresh`/`assign` delivery) carries the checkpoint in this form, and every steer/worker answer ends with it:

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

`paseo-factory checkpoint <owner>/<repo> --from-agent <steer-id>` stores this block as the checkpoint, so the next `switch` hands it over unchanged.

## Advisor policy

Workers never ask for an advisor themselves. When a worker is stuck and a second opinion would help, it ends its answer with an `ADVISOR-REQUEST` block (question, sanitized context, why it is needed) and stops:

```text
ADVISOR-REQUEST
question: <one sharp question>
context: <sanitized technical facts only: file paths, error text, what was tried and ruled out>
why: <why the worker cannot decide this alone>
```

The steer decides: answer it itself, reject the request with a reason, or brief an advisor. Steers may also consult an advisor on their own initiative, without a worker request.

Advisors always go through the native Paseo advisor mechanism (skill `paseo-advisor`): single agent, `[Advisor] <topic>` title, self-contained briefing, read-only plan mode. Let the skill match its own profiles. Limits, no exceptions:

- Analysis only: no edits, no files, no code, no workers, no writes.
- Close the advisor after its answer; synthesize verdict plus own recommendation. No persistent advisor unless the user asks for one.
- Privacy: only sanitized technical context crosses provider boundaries — no personal data, accounts, credentials, or secrets. File paths, not pastes.
