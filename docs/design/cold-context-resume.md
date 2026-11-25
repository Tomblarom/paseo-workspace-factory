# Cold context and interrupted agents — detailed plan

For the provider-by-provider manual validation matrix, see [Provider live checks](../provider-live-check.md).

New to the factory? Start with [Getting started](../getting-started.md); this page is the detailed reference.

Status: C2–C6 and R are implemented. The remaining [C1 and C7 live checks](#c1--c7-checks-live-scratch-agent-only) use approved scratch agents. The factory resume brief is available from `paseo-factory resume` and `/factory resume --brief`. Section R covers `/factory resume`, which can clear a Claude steer's context before delivering the brief. `fresh` refreshes in the same tab via Paseo rewind when possible ([Same-tab refresh via rewind](#same-tab-refresh-via-rewind)); C5 can execute `fresh-recommended` as a rewind for Codex when `rewindFresh` allows it.

## Goal

1. A Claude session that has been idle longer than its prompt-cache TTL must not re-read its whole history on the next message.
2. The agent that continues still knows its task and next step, from a small brief instead of the old transcript.
3. Any agent that stops without a clean CHECKPOINT (limit, cancel, error) leaves enough state for another steer to take over cheaply.

## Evidence (Paseo 0.16.2)

| Fact | Source |
|---|---|
| `/clear` and `/compact` reach Claude Code as commands (root sessions) | Claude provider: `CLAUDE_ROOT_ONLY_COMMANDS` contains `clear`, `compact`; prompts go to the SDK as user messages and Claude Code expands the command |
| A new Claude session id after a command is accepted and persisted, with a "session changed" notice | Claude provider: init handling replaces `claudeSessionId` |
| Turn end with outcome `completed`/`failed`/`canceled` is observable without waiting | plugin hook `agent.turn.after`; turn content via `timeline.refetch({ direction: "tail", limit: 1, wholeTurns: true })` |
| A prompt cannot be intercepted or redirected | `agent.turn.before` does not wait |
| A resumed session cannot be emptied at open | `agent.open.before` changes env/tools/MCP/metadata only |

Consequence: the context must be made small **before** the next user message, and the state must be stored **after every turn**, without model calls.

## Data model

All state lives in the scope's main workspace metadata (written under the workspace lock from `src/lock.mjs`; agent labels stay string-only):

```text
wsf.checkpoint  (existing)  + source: agent|auto|manual, agentId, turnId,
                              capturedAt, interrupted: {agentId, at} | null
wsf.agents      { <agentId>: {
                    lastTurnId, lastTurnEndedAt, outcome,
                    contextTokens,               // from agent usage, if known
                    note,                        // last CHECKPOINT block of a non-active steer or worker
                    noteAt,
                    interrupted: { at, outcome, error, excerpt, git } | null,
                    cleared: { at, mode, checkpointAt } | null,  // mode: clear|compact|rewind
                    refreshed: { at, mode: rewind, messageId?, briefMessageId? } | null,
                    pendingAction: { kind: clear|compact, at } | null,
                    compactions,                 // verified warm compactions, capped at 99
                    compactionPendingBase,       // true until the first post-compact turn settles the base
                    lastCompactBaseTokens,       // context size after the last compact, if known
                    freshHint: { at, reason } | null } }
```

Bounds: `excerpt` ≤ 1500 chars (tail of the last answer), `error` ≤ 300 chars, `note` ≤ 1500 chars, `freshHint.reason` ≤ 300 chars; entries of archived agents are dropped on write. `refreshed.messageId` is the rewind point (first user message), `refreshed.briefMessageId` the resume brief delivered after the rewind (when it landed as user_message).

## C2 Auto-checkpoint (plugin, `agent.turn.after`)

Only for factory agents (label `wsf.scope`; roles `steer`, `worker`).

| Turn | Agent | Action |
|---|---|---|
| completed, CHECKPOINT found | active steer of the scope | scope checkpoint := block (source `agent`, epoch unchanged, else skip + log) |
| completed, CHECKPOINT found | other steer / worker | `wsf.agents[id].note` |
| completed, no block | any | record turn only; checkpoint counts as stale for this agent |
| failed / canceled | any | `interrupted` record (outcome, error, excerpt, git: branch, sha, changed-file count); scope checkpoint gets `interrupted` flag, task/next stay |
| our own `/clear` or `/compact` turn | any | resolve `pendingAction` → `cleared`; nothing else |

Reuse the CHECKPOINT parser of `checkpoint --from-agent`. Never call a model, never throw out of the hook (log and continue).

Hybrid tracking: a resolved compact spends one warm compaction (counter, capped at 99), arms `compactionPendingBase`, and clears `freshHint`; a resolved clear wipes the compaction debt (counter, base, flag) and the hint. The first completed turn after a compact stores `lastCompactBaseTokens` from usage when known; every real (non-cleanup) turn clears `freshHint`, because the package moved on.

## C3 Resume brief (core, CLI, RPC, slash)

`buildResumeBrief(scope, { agentId })` next to the handoff builder; `switch` and `fresh` use the same builder.

- Header: scope id/kind, the caller's role and slot, active steer, epoch, and one line "You are the active steer" / "You are not active: answer only".
- Checkpoint: task, next, tests, blockers; source and age; warnings for stale or interrupted state, with the excerpt.
- Git: branch, short sha, ahead/behind, changed files (count + up to 10 paths).
- Workers: id, title, status, first line of their last note.
- Open items: `hub:` blockers.
- Budget: ≤ 6000 characters, enforced by truncation and a test.

Commands: `paseo-factory resume [scope] [--agent <id>] [--json]` (scope and agent default to the caller's workspace and `PASEO_AGENT_ID`), `/factory resume --brief`, RPC `factory.resume`. All three only read: same agent, context untouched. The CLI semantics never change, because the AGENTS.md resume rule points at this read path. The clearing restart path is `/factory resume` (section R).

## C4 Instruction rule

Add to the steer and worker instruction blocks:

```text
If your conversation context is empty or was cleared and you do not know your
task, run `<factory> resume` first and continue from its checkpoint and next
step. Do not use the provider's own session resume. Read only what the brief
points to.
```

Verify in C1 that a cleared Claude session still loads the project instructions that carry this rule. If not, see `seedAfterClear` in C5.

## C5 Idle cleanup (plugin timer)

Plugin server interval every 5 minutes (cleared in cleanup). All conditions must hold, checked again right before sending:

- provider in `providers` (default `["claude"]`), role in `roles` (steers and workers),
- status idle, no pending permission, no `pendingAction`,
- clear mode: `now - lastTurnEndedAt ≥ idleMinutes` (default 60); compact mode: idle past the profile-derived threshold below while the group cache is still warm,
- `contextTokens ≥ minContextTokens` (default 60000; unknown → skip; efficiency compacts from 10000),
- valid state: active steer → scope checkpoint `capturedAt ≥ lastTurnEndedAt`, not interrupted; others → `noteAt ≥ lastTurnEndedAt`,
- not cleared since the last turn, no label `wsf.keepContext=true`.

| Mode | Action | Cost |
|---|---|---|
| `off` | nothing; C6 hint only | 0 |
| `clear` (default) | send `/clear`; optional `seedAfterClear` sends a one-line "context was cleared, run resume before the next task". Codex agents are compacted instead (no native `/clear`), without needing the acknowledgement | 0 (seed: one small turn; Codex compact: one turn) |
| `compact-warm` | compact mid-package agents while the cache is still warm (profile threshold ≤ idle < group TTL), only with provider quota available; cold, over-compacted, or boundary agents get `fresh-recommended` (recorded hint, no send) | one turn on cached context, also when nobody returns |

Automatic `fresh` (new agent) is not offered: creating agents stays behind plan → confirm. Safety: per-agent cooldown (one action per idle period), daily cap per host, every action logged (`paseo plugin logs`) and recorded in `wsf.agents`. Settings (host scope): `mode`, `profile`, `idleMinutes`, `minContextTokens`, `providers`, `roles`, `seedAfterClear`, `rewindFresh`.

### Cache reference and cost profiles

The factory keeps a simplified prompt-cache reference per model group (constants in `plugin/shared/cache-profiles.ts`, pinned by tests; keep both in sync):

| Group | Cache TTL | Cached input | Notes |
|---|---|---|---|
| Claude | 60 min (5 min on some billing paths) | ~0.1× | native `/clear` and `/compact` |
| OpenAI GPT-5.6+ (gpt-6.x Sol/Terra/Astra) | 30 min (docs say 30 or more; measured <30min ~96%, 30–180min ~82%, >3h ≤30%) | 0.05× (Sol) | auto-compact around 360–420k; `/clear` is not native |
| OpenAI ≤5.5 | 10 min (upper bound of the 5–10 min in_memory window; the ~30 min 24h variant behaves like GPT-5.6+) | model-dependent | |
| Others (Muse, Copilot, …) | 30 min (conservative, like GPT-5.6+) | unknown | a Claude model on another provider follows the Claude row |

The `profile` setting (default `balanced`) derives the per-group compact threshold — the idle time after which a still-warm agent is compacted:

| Profile | Compact when idle past | Small contexts |
|---|---|---|
| Maximum efficiency | half the TTL (Claude 30, GPT-5.6+ 15, ≤5.5 5 min) | from 10k tokens |
| Balanced (default) | shortly before the TTL (Claude 50, GPT-5.6+ 25, ≤5.5 8 min) | configured floor (60k) |
| Comfort (side product, as-is) | just before the TTL (Claude 58, GPT-5.6+ 28, ≤5.5 8 min) | configured floor (60k) |

Hybrid compact/fresh rule (from the Codex compact-vs-fresh measurements): mid-package agents compact while warm, because the working detail survives; at package boundaries a fresh agent plus the brief is cheaper than another compact. In order: an already-cold context is never compacted (always `fresh-recommended`); after 2 warm compactions or with a post-compact base above ~60k tokens the decision is `fresh-recommended`; at a package boundary — a valid checkpoint/note with no open workers (running/blocked/interrupted) for steers, an idle worker with a fresh note — the decision is `fresh-recommended`. The hint is recorded on the entry (once per idle period) and never auto-creates an agent. Otherwise the compact needs provider quota: the sweep reuses the core quota reader (`quotaExhausted` on the sampled `paseo usage` snapshot) and blocks the compact on proven exhaustion, as does a flagged `needsResume: limit`; the hint itself is free and ignores both. Unknown quota fails open on purpose: sampling is best-effort, and blocking on unknown would silently disable the cleanup; a compact that hits a real limit is flagged by the turn hook as a limit, which blocks later compacts. Agents without a valid package state (no task checkpoint or note) are left to cool untouched: cooling costs nothing, and resume creates a fresh agent when needed. Guiding rule: no agent with a large context should go cold; a small, compacted context may go cold, because that is cheaper than keeping it warm forever.

Rewind execution (opt-in): with the `rewindFresh` cleanup setting on (default off), a `fresh-recommended` decision for a provider without native `/clear` (Codex) is executed as a same-tab Paseo rewind instead of only recording the hint. The sweep re-checks the decision against a fresh snapshot first (a pending action or a moved-on decision stops the rewind, like a send), then rewinds to the first user message without sending a brief — the agent resumes from its checkpoint on its next turn. The run is recorded as `cleared`/`refreshed` with mode `rewind` and counts against the daily cap; a failed rewind records `lastActionFailed` (retry needs a new real turn), while a missing rewind point or an unsupported/unreachable daemon falls back to the hint. Claude keeps its native `/clear` path and is never rewound by the sweep.

## C6 Cold hint (manual)

The composer pill and **Factory: Kontext** panel show the reason the chat needs attention, for example **Kontext kalt · seit 2 h inaktiv**, **Paseo wurde neu gestartet**, or **Nutzungslimit erreicht**. Both surfaces offer the same action.

- **Weiterschreiben** puts the cursor in the existing chat without sending a message. It is offered when there is no refresh signal or when a failed turn or limit leaves a recent, small context.
- **Kontext auffrischen** prepares a shorter conversation from the saved work brief. The confirmation explains which visible history will disappear before the agent starts a turn. The same-tab action is offered for steers. If the tab cannot be refreshed safely, the panel explains that the action is unavailable.
- **Gespeicherten Verlauf in neuem Tab öffnen** appears when an earlier session was saved. It opens that conversation for reference without starting a turn.

## R — `/factory resume` as the restart path

`/factory resume`, typed in the steer's own tab, saves the state and sends a work brief from the main workspace. On providers configured for native clearing, it first clears the context of the same agent (same id, same tab, same name). For the recommended action after an interruption, open the composer pill or **Factory: Kontext** panel.

### Scope (E3)

| Way | Agent | Context | When |
|---|---|---|---|
| `resume` (CLI / `/factory resume --brief`) | same | kept | only read, e.g. worker or user |
| **`/factory resume` (new)** | same | cleared (claude) | steer after restart, crash, limit, or cold |
| `fresh` | same tab (rewind) or new tab (fallback) | empty | agent broken or model change |
| `switch` | other slot | — | handover |
| C5 compact/clear | same | auto | idle, without user |

### Flow and safety (E2)

1. Guard: steers only. Workers get an error toast.
2. Preview fingerprint as in switch/fresh (agent status, sessionId, checkpoint time). `/factory resume` in the steer's own tab counts as confirmation, because the target is the caller itself. For a foreign agent (`--agent <id>`): preview in the panel, confirm by button.
3. **Running → no clearing.** The RPC answers "running; retry after the turn ends" as an error toast. No auto-stop; the user can `stop` first.
4. Save the checkpoint: the agent's last answer is read with the `auto-checkpoint` parser (as `checkpoint --from-agent`). A valid CHECKPOINT block newer than the scope checkpoint is written; otherwise the scope checkpoint stays and the brief carries `interrupted` if needed. Only then is the context cleared.
5. `previousSessions` is recorded before the clear (already exists). The old history stays reachable as an extra tab via `factory.history.open` / `paseo agent import`.
6. Closed agent (after restart): `send` is expected to reopen it. Still unverified live; if it fails, an error toast says "open the tab, then retry".
7. No rate/day cap for manual resume (the C5 cap does not apply). One open `pendingAction` per agent, so a double-click is idempotent.

Technically the RPC reuses the C5 cleanup (`sendCleanupCommand` without sourceAgentId, same `pendingAction`/`previousSessions` bookkeeping; the single-agent logic of `sweepAgent` is extracted as `runCleanup` and shared). The brief is sent by the turn-hook only after a verified clear (new sessionId), as `[Factory resume]` plus the full `buildResumeBrief` — never directly behind the RPC, so the brief does not land in the old context and no turn is spent on the `resume` call. A text without effect yields `effectFailed` and locks the provider capability. `/compact` is not needed in resume (the history may be lost; compact stays with C5 for warm idle), and `fresh` is no fallback (the tab must survive; it stays a manual panel action).

### Provider matrix (E1)

Setting `resumeClear.providers`, default `["claude"]` (native `/clear` is verified for claude only):

| Provider | Action | Fallback |
|---|---|---|
| claude | `/clear`, verify effect, brief | on `effectFailed`: brief without clearing, note "context not cleared" |
| codex, copilot, muse | no clearing by default, brief only | opt-in per setting once a live check proves `/clear` or `/compact` for the provider; same effect verification protects |

**Live check Codex (2026-11-24, scratch agent gpt-6.2-sol, Paseo 0.16.2):** `/clear` is not a native command for Codex. The model answered in prose ("treating your next message as a new task") and pretended to forget; the context was **not** cleared (input tokens rose from 20101 to 23050, the history stayed in the same thread). `/compact` is native: the timeline shows `[Compacted]` and the same agent and tab survive. Consequence: keep `resumeClear.providers` at `["claude"]`; for Codex steers use `/compact` (cache-warm) or `fresh` (same-tab rewind with the CHECKPOINT brief, new agent only as fallback), never `/clear`.

### Attention pill (E5)

New field `wsf.agents[id].needsResume = {reason, at}`, reasons `daemon-restart | limit | failed | cold` (`cold` comes from the existing C6 feed and gets no pill of its own). It is set by the boot check (steers that were `closed` or had an interrupted turn) and by the turn-hook on `failed` (limit/quota pattern in the failure text → `limit`, else `failed`), and cleared on verified resume or a successful normal turn.

- The affected steer gets one composer pill driven by the attention feed. A restart, usage limit, or failed turn takes precedence in the label. The action also considers context age, size, and any saved refresh recommendation.
- After a daemon restart or a limit, every steer of a labelled scope whose last turn ended within `recentHours` (default 24) shows the pill, not only the last active one. Advisors only with an open turn, as before.
- The pill applies the same continuation choice to active, inactive and advisor steers. A non-active steer can take over through the explicit `/factory resume` command in its own tab. Advisor steers cannot take over.
- Factory sidebar item with a counter "n steers need resume" (existing sidebar element; no panel badge). The counter counts only the active steer; non-active reminders do not count as urgent.
- The pill is visible while the attention feed reports a reason. The regular composer remains available.

## Same-tab refresh via rewind

`fresh` (CLI `paseo-factory fresh`, panel Fresh) refreshes steers and workers in the same tab via Paseo rewind instead of creating a new agent: `DaemonClient.rewindAgent(agentId, firstUserMessageId, 'conversation')` with the first `user_message` from `fetchAgentTimeline(id, { limit: 0, projection: 'canonical' })`, then the refresh packet as the resume brief. The agent keeps its tab, id, labels and title; no epoch change, no takeover, no retire notice, no superseded twin. The preview names `rewind` vs `new agent` (`refreshMode`); the applied run records `cleared`/`refreshed` with mode `rewind` in `wsf.agents`.

Only real `user_message` entries are rewind points. A brief sent via `paseo send` from inside an agent (with `PASEO_AGENT_ID`) arrives as a `tool_call` (`paseo-agent-message`), and rewinding to it fails ("could not find user message"). The brief after a rewind therefore goes through `DaemonClient.sendMessage` with an explicit `messageId` and WITHOUT a caller agent id, so it arrives as `user_message` and the next refresh rewinds to exactly that brief. The brief's message id is recorded in `refreshed.briefMessageId` when it landed. (Keeping earlier agents' history in the tab is a later package; not implemented.)

Fallback and failure: a new parent-free agent is created only when no rewind point exists (agents driven only via `send` have no `messageId`) or the provider lacks rewind — the result carries the fallback reason as a warning. A failed rewind aborts with no side effects: nothing sent, nothing recorded, no new agent. A second apply while a cleanup action is pending, or with no new turn recorded since the rewind, is idempotent (no second rewind, no second brief). DaemonClient access lives in one small injectable module (`src/rewind.mjs`, fail-soft like the ZeroSub reader); tests inject a fake, production passes the real factory.

## C1 / C7 Checks (live, scratch agent only)

C1: on a scratch Claude agent (with approval): `/clear` → new session id notice, context tokens drop, project instructions still present, Paseo attention/notification behaviour; same for `/compact`. C7: build ~150k context, wait past the TTL, measure the first turn's usage without action and after `/clear` + resume; record numbers here, then choose the default `mode`.

## Interrupted handover

`status` and `scopes` show `interrupted` and stale checkpoints. `switch` to another steer is allowed with an interrupted checkpoint; the handoff carries the resume brief and the line "Previous steer was interrupted at …; verify git state before continuing."

## Work split

| Package | Owner | Files |
|---|---|---|
| C3 brief, checkpoint fields, `wsf.agents` helpers with lock, `status`/`switch`/`fresh` integration | core worker | `src/steer.mjs`, `src/paseo.mjs`, new `src/agent-state.mjs`, `src/cli.mjs` |
| C2 hook, C5 timer, C6 pill, settings, RPC/slash `resume` | plugin worker | `plugin/**` (core via `plugin-sync`) |
| C4 instruction text, docs | docs worker or steer | `docs/steer-instructions.md`, `AGENTS.md`, this file |
| C1, C7 live checks | steer, with user approval for scratch agents | none |

Order: C1 → C3 and C2 in parallel → C4 → C5/C6 → C7 → choose the default. Tests with fakes for every rule in the C2 table, every C5 condition (each one false → no action), the brief budget, and lock/epoch races.

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
- Native first (C1): Claude Code `SessionStart` hooks with source `clear`/`compact` can inject the resume brief automatically. Offer it as documented optional setup (C4b); the instruction rule stays as fallback for other providers. Cache TTL is 1 h on subscription plans, 5 min otherwise, so `idleMinutes` 60 and the balanced profile (Claude 50) fit plan usage; the cache reference table above documents the 5 min case and the other groups.
- Tabs must survive (user requirement). Paseo 0.16.2 code: a new Claude session id is adopted by the same agent (id and tab stay, a "switched to a new session" notice is appended) and becomes the persisted session; the timeline store is in memory and is rebuilt from the transcript of the current session id after a daemon restart or reload. So `/clear` keeps the old timeline only until the next restart; `/compact` keeps the session id and its transcript. Consequences: `compact-warm` is the default candidate once a live check confirms it; `clear` records the previous session id in `wsf.agents[id].previousSessions` before sending, offers "open old history" via `paseo agent import <session-id>` as an extra tab, and stays disabled until the live check and the user accept this limit; `fresh` only adds a tab.
- Restoring after `/clear` (code check): Paseo persists only the session handle per agent and rebuilds the timeline from the current session's transcript; no CLI/SDK/plugin API resets an agent's session id. Same-tab restore therefore needs a Paseo change (proposal: keep `previousSessionIds` in the Claude persistence and replay their transcripts before the current one). `paseo agent import <old-session-id>` restores the full old history as a new tab. `/compact` writes a `compact_boundary` into the same transcript; the replay reads the file linearly, shows a `compaction` item and hides the summary, so the full history stays in the same tab after a restart.
- Live check C1 (scratch agent): `/clear` and `/compact` only act when the message has no source agent; a message sent by an agent arrives as "[Message received] …" text, has no effect and still costs a turn. Code: the server wraps only messages with `sourceAgentId`; the SDK sets it only when passed explicitly; the CLI fills it from `PASEO_AGENT_ID`. Rule: C5 sends through the plugin SDK without `sourceAgentId`, never through a CLI subprocess; factory CLI paths that send these commands drop `PASEO_AGENT_ID`. The first action per agent verifies its effect (compaction marker or session-change notice), otherwise the mode switches off with a hint. Confirmed live: `/clear` keeps agent id and tab but only the new session survives a reload; `paseo agent import <old-session-id> --provider claude` restores the old history as a new tab; `/compact` keeps the full history after a reload.
