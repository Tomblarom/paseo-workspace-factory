# Cold context and interrupted agents — detailed plan

Status: planned (TODO §10, C1–C7). "resume" below always means the **factory
resume brief** (`paseo-factory resume`, `/factory resume`), never Claude's own
session resume (`claude --resume`, `/resume`).

## Goal

1. A Claude session that has been idle longer than its prompt-cache TTL must not
   re-read its whole history on the next message.
2. The agent that continues still knows its task and next step, from a small
   brief instead of the old transcript.
3. Any agent that stops without a clean CHECKPOINT (limit, cancel, error) leaves
   enough state for another steer to take over cheaply.

## Evidence (Paseo 0.16.2)

| Fact | Source |
|---|---|
| `/clear` and `/compact` reach Claude Code as commands (root sessions) | Claude provider: `CLAUDE_ROOT_ONLY_COMMANDS` contains `clear`, `compact`; prompts go to the SDK as user messages and Claude Code expands the command |
| A new Claude session id after a command is accepted and persisted, with a "session changed" notice | Claude provider: init handling replaces `claudeSessionId` |
| Turn end with outcome `completed`/`failed`/`canceled` is observable without waiting | plugin hook `agent.turn.after`; turn content via `timeline.refetch({ direction: "tail", limit: 1, wholeTurns: true })` |
| A prompt cannot be intercepted or redirected | `agent.turn.before` does not wait |
| A resumed session cannot be emptied at open | `agent.open.before` changes env/tools/MCP/metadata only |

Consequence: the context must be made small **before** the next user message,
and the state must be stored **after every turn**, without model calls.

## Data model

All state lives in the scope's main workspace metadata (written under the
workspace lock from `src/lock.mjs`; agent labels stay string-only):

```text
wsf.checkpoint  (existing)  + source: agent|auto|manual, agentId, turnId,
                              capturedAt, interrupted: {agentId, at} | null
wsf.agents      { <agentId>: {
                    lastTurnId, lastTurnEndedAt, outcome,
                    contextTokens,               // from agent usage, if known
                    note,                        // last CHECKPOINT block of a non-active steer or worker
                    noteAt,
                    interrupted: { at, outcome, error, excerpt, git } | null,
                    cleared: { at, mode, checkpointAt } | null,
                    pendingAction: { kind: clear|compact, at } | null } }
```

Bounds: `excerpt` ≤ 1500 chars (tail of the last answer), `error` ≤ 300 chars,
`note` ≤ 1500 chars; entries of archived agents are dropped on write.

## C2 Auto-checkpoint (plugin, `agent.turn.after`)

Only for factory agents (label `wsf.scope`; roles `steer`, `worker`).

| Turn | Agent | Action |
|---|---|---|
| completed, CHECKPOINT found | active steer of the scope | scope checkpoint := block (source `agent`, epoch unchanged, else skip + log) |
| completed, CHECKPOINT found | other steer / worker | `wsf.agents[id].note` |
| completed, no block | any | record turn only; checkpoint counts as stale for this agent |
| failed / canceled | any | `interrupted` record (outcome, error, excerpt, git: branch, sha, changed-file count); scope checkpoint gets `interrupted` flag, task/next stay |
| our own `/clear` or `/compact` turn | any | resolve `pendingAction` → `cleared`; nothing else |

Reuse the CHECKPOINT parser of `checkpoint --from-agent`. Never call a model,
never throw out of the hook (log and continue).

## C3 Resume brief (core, CLI, RPC, slash)

`buildResumeBrief(scope, { agentId })` next to the handoff builder; `switch`
and `fresh` use the same builder.

- Header: scope id/kind, the caller's role and slot, active steer, epoch, and
  one line "You are the active steer" / "You are not active: answer only".
- Checkpoint: task, next, tests, blockers; source and age; warnings for stale
  or interrupted state, with the excerpt.
- Git: branch, short sha, ahead/behind, changed files (count + up to 10 paths).
- Workers: id, title, status, first line of their last note.
- Open items: `hub:` blockers.
- Budget: ≤ 6000 characters, enforced by truncation and a test.

Commands: `paseo-factory resume [scope] [--agent <id>] [--json]` (scope and
agent default to the caller's workspace and `PASEO_AGENT_ID`),
`/factory resume`, RPC `factory.resume`.

## C4 Instruction rule

Add to the steer and worker instruction blocks:

```text
If your conversation context is empty or was cleared and you do not know your
task, run `<factory> resume` first and continue from its checkpoint and next
step. Do not use the provider's own session resume. Read only what the brief
points to.
```

Verify in C1 that a cleared Claude session still loads the project
instructions that carry this rule. If not, see `seedAfterClear` in C5.

## C5 Idle cleanup (plugin timer)

Plugin server interval every 5 minutes (cleared in cleanup). All conditions
must hold, checked again right before sending:

- provider in `providers` (default `["claude"]`), role in `roles`,
- status idle, no pending permission, no `pendingAction`,
- `now - lastTurnEndedAt ≥ idleMinutes` (default 60),
- `contextTokens ≥ minContextTokens` (default 60000; unknown → skip),
- valid state: active steer → scope checkpoint `capturedAt ≥ lastTurnEndedAt`,
  not interrupted; others → `noteAt ≥ lastTurnEndedAt`,
- not cleared since the last turn, no label `wsf.keepContext=true`.

| Mode | Action | Cost |
|---|---|---|
| `off` (default until C7) | nothing; C6 hint only | 0 |
| `clear` | send `/clear`; optional `seedAfterClear` sends a one-line "context was cleared, run resume before the next task" | 0 (seed: one small turn) |
| `compact-warm` | at `compactAtMinutes` (default 50, before a 1 h TTL expires) send `/compact Keep: task, decisions, open ids, next step.` | one turn on cached context, also when nobody returns |

Automatic `fresh` (new agent) is not offered: creating agents stays behind
plan → confirm. Safety: per-agent cooldown (one action per idle period), daily
cap per host, every action logged (`paseo plugin logs`) and recorded in
`wsf.agents`. Settings (host scope): `mode`, `idleMinutes`, `compactAtMinutes`,
`minContextTokens`, `providers`, `roles`, `seedAfterClear`.

## C6 Cold hint (manual)

Composer pill on factory agents that are cold (idle ≥ `idleMinutes`, context ≥
`minContextTokens`) and not handled by C5: "Cold · 350k" with actions
"Clear + resume" (sends `/clear`), "Fresh" (opens the `fresh` preview),
"Dismiss".

## C1 / C7 Checks (live, scratch agent only)

C1: on a scratch Claude agent (with approval): `/clear` → new session id
notice, context tokens drop, project instructions still present, Paseo
attention/notification behaviour; same for `/compact`. C7: build ~150k context,
wait past the TTL, measure the first turn's usage without action and after
`/clear` + resume; record numbers here, then choose the default `mode`.

## Interrupted handover

`status` and `scopes` show `interrupted` and stale checkpoints. `switch` to
another steer is allowed with an interrupted checkpoint; the handoff carries
the resume brief and the line "Previous steer was interrupted at …; verify git
state before continuing."

## Work split

| Package | Owner | Files |
|---|---|---|
| C3 brief, checkpoint fields, `wsf.agents` helpers with lock, `status`/`switch`/`fresh` integration | core worker | `src/steer.mjs`, `src/paseo.mjs`, new `src/agent-state.mjs`, `src/cli.mjs` |
| C2 hook, C5 timer, C6 pill, settings, RPC/slash `resume` | plugin worker | `plugin/**` (core via `plugin-sync`) |
| C4 instruction text, docs | docs worker or steer | `docs/steer-instructions.md`, `AGENTS.md`, this file |
| C1, C7 live checks | steer, with user approval for scratch agents | none |

Order: C1 → C3 and C2 in parallel → C4 → C5/C6 → C7 → choose the default.
Tests with fakes for every rule in the C2 table, every C5 condition (each one
false → no action), the brief budget, and lock/epoch races.

## Review decisions (implementation round 1)

- Race check: "epoch unchanged, else skip" is evaluated under the workspace lock.
- A failed or canceled `/clear`/`/compact` turn resolves `pendingAction` into `lastActionFailed { at, error }`; it is not an `interrupted` record (our action, not agent work). No retry in the same idle period; the next attempt needs a new real turn.
- Without a scope checkpoint, the interrupted state lives only in `wsf.agents[id].interrupted`; `status`, `scopes` and the brief must show agent-level interrupted records.
- `interrupted` is cleared only by a completed turn that carries a CHECKPOINT block, or by a checkpoint from the active steer (`agent`/`manual`/`assign`); `auto` never clears it.
- `assign` writes checkpoints with `source: "assign"` and `assignedBy` (agent id when known).
- Resume scope resolution: explicit scope > agent label `wsf.scope` > the caller's workspace scope.
- One core lock helper (exported from `src/lock.mjs`) names and takes workspace locks; plugin and core must not duplicate the lock name.
- Pruning of archived agents through `dropIds` is enough for now.
- C5 modes are `off | clear | compact-warm` only; `fresh` stays manual (C6), because creating agents needs plan → confirm.
- Native first (C1): Claude Code `SessionStart` hooks with source `clear`/`compact` can inject the resume brief automatically. Offer it as documented optional setup (C4b); the instruction rule stays as fallback for other providers. Cache TTL is 1 h on subscription plans, 5 min otherwise, so `idleMinutes` 60 / `compactAtMinutes` 50 fit plan usage; document the 5 min case.
- Tabs must survive (user requirement). Paseo 0.16.2 code: a new Claude session id is adopted by the same agent (id and tab stay, a "switched to a new session" notice is appended) and becomes the persisted session; the timeline store is in memory and is rebuilt from the transcript of the current session id after a daemon restart or reload. So `/clear` keeps the old timeline only until the next restart; `/compact` keeps the session id and its transcript. Consequences: `compact-warm` is the default candidate once a live check confirms it; `clear` records the previous session id in `wsf.agents[id].previousSessions` before sending, offers "open old history" via `paseo agent import <session-id>` as an extra tab, and stays disabled until the live check and the user accept this limit; `fresh` only adds a tab.
- Restoring after `/clear` (code check): Paseo persists only the session handle per agent and rebuilds the timeline from the current session's transcript; no CLI/SDK/plugin API resets an agent's session id. Same-tab restore therefore needs a Paseo change (proposal: keep `previousSessionIds` in the Claude persistence and replay their transcripts before the current one). `paseo agent import <old-session-id>` restores the full old history as a new tab. `/compact` writes a `compact_boundary` into the same transcript; the replay reads the file linearly, shows a `compaction` item and hides the summary, so the full history stays in the same tab after a restart.
- Live check C1 (scratch agent): `/clear` and `/compact` only act when the message has no source agent; a message sent by an agent arrives as "[Message received] …" text, has no effect and still costs a turn. Code: the server wraps only messages with `sourceAgentId`; the SDK sets it only when passed explicitly; the CLI fills it from `PASEO_AGENT_ID`. Rule: C5 sends through the plugin SDK without `sourceAgentId`, never through a CLI subprocess; factory CLI paths that send these commands drop `PASEO_AGENT_ID`. The first action per agent verifies its effect (compaction marker or session-change notice), otherwise the mode switches off with a hint. Confirmed live: `/clear` keeps agent id and tab but only the new session survives a reload; `paseo agent import <old-session-id> --provider claude` restores the old history as a new tab; `/compact` keeps the full history after a reload.
