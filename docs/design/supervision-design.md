# Worker supervision that survives interruptions — design

New to the factory? Start with [Getting started](../getting-started.md); this page is the detailed reference.

Status: accepted (decisions F1–F4 below), implemented as packages S-A, S-B, S-C. Builds on restart detection and `drain` ([configuration](../configuration.md#planned-restarts)) and on the cold-context work ([cold context](cold-context-resume.md)).

## Principle

Supervising workers must survive an interruption: a daemon restart, a cleared or compacted context, or a steer that fails (provider limit, errors, no answer). Workers belong to the scope, not to the steer that started them; the active steer supervises every open worker of its scope. A steer that starts workers does not simply go idle: the factory wakes it when something happens and when nothing happens for too long. If the active steer cannot respond, the next ready steer takes over on its own. The user is asked only when the steer, an advisor and the next higher steer (domain, hub) are all stuck.

While the steer is working through a backlog, it stays in the turn, checks the worker register, and takes another actionable item when one is blocked. A shell watcher can report completion to that turn. Factory wakes provide recovery after an interruption.

## Decisions

- **F1 — self-failover:** a ready steer takes over on its own with `switch --to <itself> --apply` (epoch-checked, logged; the caller is recognised via `PASEO_AGENT_ID`, so a running target is allowed and no handoff is sent to itself, the brief is only printed). No user confirmation.
- **F2 — wake cadence:** wake immediately for every actionable worker outcome (`done`, `partial`, `blocked`, `interrupted`, or ended without CHECKPOINT). A tiny debounce (default 20 seconds, `wakeDebounceSeconds`) merges simultaneous events; `batchMinutes` is retained only as an optional compatibility setting and defaults to `0`. The active steer is the target unless its quota pool is exhausted or it is advisor-flagged; then the next non-advisor candidate from a different quota pool is woken immediately and the takeover is logged as `failover`.
- **F3 — user contact:** only a blocker prefixed `user:` is meant for the user. Everything below that level stays between agents.
- **F4 — auto-resume on wake (accepted):** a woken steer with `needsResume` gets automatic resume (clear plus brief, wake reason in the brief) instead of the normal wake text. Rationale: the wake comes from the plugin without a user anyway, and a cold context after a restart is expensive.
- **Ignore rule:** an agent is ignored only when it is archived (`archivedAt`) or has no scope assignment. `closed` is never "done" and never "irrelevant": after a daemon restart, live steers and workers can be closed until they are opened again.

## Native facts (Paseo 0.16.2)

- Plugin hooks `agent.create.after`, `agent.turn.before`, `agent.turn.after`, `agent.close.after`; the hook agent carries `parentAgentId`, `background` and a plugin-owned `metadata` map that Paseo never reads.
- The plugin sends messages with `paseo.agents.ref(id).send(text)` (no source agent, so no `[Message received]` wrapper); a closed agent is expected to be opened again when it receives a message (`agent.open.before` knows reason `resume`); not yet verified live.
- A parent can only be removed (`paseo agent detach`), never set. "Moving" a worker to another steer is therefore logical only.
- `paseo wait <id> [--timeout]` blocks inside one turn: fine for short waits, but it dies with the waiting turn (restart, interruption).
- `paseo heartbeat create --cron … <prompt>` sends a recurring prompt to one agent. It stays with that agent, so it does not follow a `switch` or `fresh`. Verified live (2026-11-23, scratch agent, archived): with `PASEO_AGENT_ID=<target>` the CLI creates a heartbeat for another agent; it fired on time and arrived as a `[Heartbeat]` prompt that the agent answered. So `switch`/`fresh` could move a factory-managed heartbeat (delete on the old steer, create on the new one) when the plugin is not installed.
- No public API mutes Paseo's attention or notifications ([plugin design](plugin-design.md#notification-suppression-for-workers-research)). A turn the plugin starts on a steer probably raises the normal "agent finished" attention; see Limits.

## Ownership and state

A worker belongs to a scope through the labels `wsf.scope` and `wsf.role=worker`; `wsf.owner` (who started it) is informational. Whoever is the active steer of the scope supervises it, so a switch, fresh or failover needs no relabelling.

Fixed facts live on the worker itself, in the plugin `metadata` of the agent: scope id, starting steer, start epoch and a short task excerpt (from the first turn). They travel with the agent, also into another workspace, so a worker in a foreign workspace is never mistaken for an unlabelled steer candidate there.

Changing state lives in the main workspace metadata under the workspace lock, key `wsf.workers`, one entry per worker:

| Field | Meaning |
|---|---|
| `task` | excerpt of the assignment (≤ 300 chars) |
| `startedBy`, `startedAt`, `epoch` | who started it, when, in which epoch |
| `state` | `running`, `done`, `partial`, `blocked`, `interrupted`, `stale` |
| `status` | last `- status:` value of its CHECKPOINT, if any |
| `resumes` | automatic continuations in the current assignment |
| `lastWakeAt`, `pendingWake` | wake bookkeeping (debounce, unanswered wakes) |

State transitions:

| Event | New state |
|---|---|
| worker created by a steer of the scope (`agent.create.after`, parent is a labelled steer) or adopted with `plan --adopt-worker` | `running` |
| turn ends with a CHECKPOINT, `- status: done` (or no status line) | `done` |
| turn ends with `- status: partial` | `partial` |
| turn ends with `- status: blocked` or an `ADVISOR-REQUEST` block | `blocked` |
| turn ends without a CHECKPOINT, failed or canceled; restart marks (`daemon-restart`, `planned-restart`) | `interrupted` |
| idle longer than the watchdog limit while `running` | `stale` |
| new assignment sent to the worker | `running`, `resumes` reset |
| worker archived | entry removed |

`resume`, the `switch`/`fresh` handoff and `status` list the open entries (everything except `done`) with task and state. `workers [scope]` prints the register.

## Wake rules

The plugin wakes the steer that is active **when the wake is sent**, read from the scope state — never the worker's parent. Every wake carries the scope id, the epoch and the worker ids; a steer ignores a wake whose epoch is older than the current one.

- Every actionable worker outcome queues a wake before delivery. The timer tries again after a failed send or when the active steer finishes its current turn.
- A wake behind a `/clear` stays pending (`wsf.agents.<steer>.pendingWakeBrief`) until the brief send succeeded in the turn-after hook; a failed follow-up (hook error, busy workspace lock, plugin stopped, provider error) keeps the workers queued and retries on the next supervise tick and the boot check, at most once per tick per scope, without duplicate briefs (take-before-send under the workspace lock, `wakeId`, `briefSent` flag — same exactly-once pattern as the staged steer brief).
- Debounced: simultaneous actionable events are collected and sent together within `wakeDebounceSeconds`; there is no 10-minute batch.
- Watchdog: a plugin timer (every 15 minutes) marks `running` workers that are idle beyond `staleMinutes` as `stale` and wakes the steer; it also re-sends a wake that got no answer (see Failover).
- Quiet periods: no wakes while `drain` runs, and none before the boot check after a restart has finished; then one combined wake lists every interrupted worker.
- Never woken or escalated: archived agents, agents without scope assignment, `background` agents, advisor steers.

Wake text (one message, English, short):

```text
[factory] Scope <id>, epoch <n>: worker <id> blocked; worker <id> done.
Run `<factory> resume` (or `workers`) and continue. Ignore if your epoch is newer.
```

Without the plugin the steer instructions ask the steer to create a heartbeat (`*/20 * * * *`) while workers run and to delete it when none are open.

## Failover

A wake counts as unanswered when the active steer does not start a turn within `answerMinutes` (default 10), or its turn fails with a provider limit or error. Then the plugin wakes the next candidate with a takeover request:

1. the next live steer of the scope in slot order (skipping retired, archived, interrupted and advisor ones),
2. the domain steer of the scope (skipped when it is an advisor, then on to the hub),
3. the hub steer (skipped when it is an advisor; then no candidate is left).

A candidate takes over with `<factory> switch <scope> --to <its slot> --apply`. `switch` is epoch-checked under the workspace lock, so two candidates cannot both win; the loser gets a refusal and stops. Each takeover is logged in the scope checkpoint (`source: "failover"`, previous steer, reason).

Not a failover: a restart (the closed steer is expected to be opened again by the wake; live test pending) and a cleared context (the woken steer follows the resume rule and reads the register).

Decision F4 (accepted): when the woken steer carries `needsResume` (set after a restart, limit, or failure; see [cold context](cold-context-resume.md#r--factory-resume-as-the-restart-path)), the wake turns into an automatic resume — clear plus brief, with the wake reason in the brief — instead of the normal wake text. A failover takeover (`switch --to <self> --apply`) keeps its handoff brief and clears additionally only when the taking steer itself has `needsResume` or is cold; a healthy steer is never cleared automatically. A limit on the active steer stays a failover trigger (F1); `needsResume=limit` is set in addition so the steer returns cleanly via its pill once the limit lifts. The C5 skip rule for open workers does not apply to manual resume; the brief names the open workers.

## Escalation: worker → steer → advisor → user

1. **Worker** ends every answer with a CHECKPOINT (`- status: done|partial|blocked`) or with an `ADVISOR-REQUEST` block and stops.
2. **Steer** continues the worker with the resume brief or reassigns the task. After `maxAutoResumes` (default 2) unsuccessful continuations it consults an advisor (existing advisor policy).
3. **Advisor** stuck too: the steer escalates with a `domain:` blocker (domain steer), which escalates further with `hub:` (hub steer).
4. **User**: only a `user:` blocker. `scopes` lists `user:` items first; the plugin shows them as a pill and in the panel.

## Interplay with restart detection and idle cleanup

- Supervision only reads the restart data (`turnStartedAt`, `interrupted.reason`) written by the boot check and `drain`; it never writes it.
- The idle cleanup (C5) skips agents whose register state is `running`, `blocked` or `interrupted`, so an unfinished worker is not cleared before its steer has seen it.
- A cleared steer loses nothing: the register and the checkpoint live in the main workspace.

## Settings (plugin, host scope)

`enabled` (default on), `wakeDebounceSeconds` (20), `batchMinutes` (0, compatibility), `watchdogMinutes` (15), `staleMinutes` (60), `answerMinutes` (10), `maxAutoResumes` (2).

## Limits

- Paseo has no API to mute attention: steer turns started by a wake probably raise the normal attention, so F3 can be met only partly. Batching keeps this low; an upstream request for a "silent" send or per-agent notification switch is the clean fix.
- Heartbeats stay with one agent and are only the fallback without the plugin.
- Supervision is per host; it does not watch agents of another daemon.

## Packages

| Package | Contents | Files |
|---|---|---|
| S-A core register | `wsf.workers` read/write under lock, state transitions as pure functions, register in `resume`/`switch`/`fresh`/`status`, `workers` prints it, `status` line stored, `failover` checkpoint source | new `src/supervision.mjs`, `src/steer.mjs`, `src/cli.mjs`, `src/workers.mjs`, tests |
| S-B plugin | `create.after` registration and worker metadata, turn-end transitions, immediate and debounced wakes, watchdog, failover chain, quiet periods, C5 skip rule, settings | new `plugin/server/supervise.ts`, `plugin/index.server.ts`, `plugin/shared/settings.ts`, `plugin/shared/idle-cleanup.ts`, tests |
| S-C docs | principle in concepts, steer instructions, AGENTS.md; this page | `docs/*`, `AGENTS.md` |

Order: S-A first (S-B reads its functions through `plugin-sync`), S-B after S-A is integrated, S-C in parallel.

## Tests

With fakes (`npm test`, `node --test plugin/test/*.mjs`):

- every state transition in the table, including ADVISOR-REQUEST → `blocked` and restart marks → `interrupted`;
- register writes under the lock, concurrent writers, epoch in every entry;
- wake target resolved at send time (after a switch the new steer gets the wake), stale-epoch wakes ignored;
- immediate vs batched wakes, batch window, one combined wake after the boot check, no wakes during `drain`;
- ignore rule: archived and unassigned agents ignored, closed agents still supervised, background agents never woken;
- failover: unanswered wake → next slot, then domain, then hub, skipping advisors on every level; two candidates race on `switch`, exactly one wins; logged checkpoint source;
- escalation counter: `maxAutoResumes` reached → advisor hint, then `domain:`/`hub:`;
- C5 skips `running`/`blocked`/`interrupted` workers.

Live (scratch agents only, archived afterwards):

- heartbeat for another agent: created via CLI, fires, arrives as a `[Heartbeat]` prompt — **done** (2026-11-23, passed);
- after a daemon restart: status of live steers and workers (`closed`?), a wake reopens a closed steer, heartbeats survive;
- `agent.create.after` carries `parentAgentId` for an agent a steer starts;
- attention: does a plugin-sent wake turn notify the user?
