# Native provider-session reset and retained timeline

Research only, 2026-11-26. Source: public Paseo **v0.17.4**, tag commit
`2b3559b107243306986176b80beb0e779f9fe53e`; links below point to that tag.
No live agents, providers or reset operations were exercised. **Fact** means
source behavior, not a runtime guarantee; **proposal** is not implemented.

## Result

A fresh provider session under the same Paseo agent ID with independently
retained timeline rows is the approved direction. The user clarified on
2026-11-26 that rewind was a suggested Codex implementation based on the old
architecture. The source findings below support a provider-independent operation
using native session creation. Runtime behavior still requires validation.

The extension needs more than replacing `resumeSession` with `createSession`:
restart before a new resumable provider handle exists can otherwise delete
the retained history. Selection fencing, durable reset state, timeline segment
boundaries and recovery are part of the minimum safe contract.

## Evidence: identity, timeline, sessions

- **Fact:** A managed agent has its own ID, config, labels, workspace, owner,
  provider session and persistence handle. Native reload closes the runtime and
  registers the same agent ID with those attributes; it preserves the in-memory
  timeline by default, but resumes the **existing handle** when present.
  `rehydrateFromDisk` instead discards memory and replays provider history.
  [agent-manager.ts:1953-2076](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/server/src/server/agent/agent-manager.ts#L1953-L2076).
- **Fact:** Canonical timeline rows are separately committed under the Paseo
  agent ID. Registration can seed from the durable timeline and marks history
  primed when rows exist; ordinary history hydration then skips provider replay.
  Durable writes are queued, error-logged and flush is best-effort, so a reset
  cannot assume an atomic timeline/handle commit.
  [agent-manager.ts:4707-4739](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/server/src/server/agent/agent-manager.ts#L4707-L4739),
  [4806-4832](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/server/src/server/agent/agent-manager.ts#L4806-L4832),
  [6139-6210](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/server/src/server/agent/agent-manager.ts#L6139-L6210).
- **Fact:** Import calls the provider's import method, allocates a **new**
  Paseo ID and registers imported rows and that provider handle. It is not
  same-tab history restoration or an independent history overlay.
  [agent-manager.ts:1857-1949](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/server/src/server/agent/agent-manager.ts#L1857-L1949).
- **Fact:** Conversation rewind resolves an acknowledged user message to its
  provider ID, invokes provider rewind, force-replays provider history, deletes
  committed timeline rows and emits `timeline_replacement`. On failure after
  a provider fork it persists the latest handle before returning an error.
  [agent-manager.ts:4217-4279](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/server/src/server/agent/agent-manager.ts#L4217-L4279),
  [5164-5208](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/server/src/server/agent/agent-manager.ts#L5164-L5208).
- **Fact:** Missing handles have a consequential restart path: the loader
  calls `createAgentFromRecord`; that goes through `createAgentInternal`,
  whose `deleteAgentState` deletes the committed timeline. The loader assumes
  a handle-less record has no accumulated history. A fresh session with kept
  history violates that assumption.
  [agent-loading.ts:112-135](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/server/src/server/agent/agent-loading.ts#L112-L135),
  [agent-manager.ts:1606-1663](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/server/src/server/agent/agent-manager.ts#L1606-L1663),
  [4284-4300](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/server/src/server/agent/agent-manager.ts#L4284-L4300).

## Provider evidence, not a live compatibility matrix

| Provider | New-session and rewind evidence | Reset assessment |
| --- | --- | --- |
| Claude | `createSession` constructs without a handle; rewind to the first effective anchor starts fresh, otherwise forks at a preceding answered turn. [agent.ts:1686-1735](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/server/src/server/agent/providers/claude/agent.ts#L1686-L1735), [3399-3414](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/server/src/server/agent/providers/claude/agent.ts#L3399-L3414), [3736-3769](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/server/src/server/agent/providers/claude/agent.ts#L3736-L3769). | Rewind can produce a fresh session but also replaces the timeline; new-session route is source-supported, untested. New session can initially have no handle. |
| Codex | `createSession` starts without a handle; `thread/start` is lazy. Rewind forks before the selected turn or forks then rolls back on older versions; selected/later turns leave the fork. [agent.ts:8307-8378](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/server/src/server/agent/providers/codex-app-server-agent.ts#L8307-L8378), [rewind.ts:57-113](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/server/src/server/agent/providers/codex/rewind.ts#L57-L113). | New-session route is source-supported, untested. The handle is not resumable until the thread is saved at turn notification; a thread ID alone is insufficient. [agent.ts:5471-5506](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/server/src/server/agent/providers/codex-app-server-agent.ts#L5471-L5506), [6958-6966](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/server/src/server/agent/providers/codex-app-server-agent.ts#L6958-L6966). |
| Copilot | ACP `createSession` calls `session/new`, while resume loads/resumes the handle; configured overrides are applied. Conversation rewind is explicitly false. [acp-agent.ts:1118-1218](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/server/src/server/agent/providers/acp-agent.ts#L1118-L1218), [1968-2047](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/server/src/server/agent/providers/acp-agent.ts#L1968-L2047), [copilot-acp-agent.ts:37-47](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/server/src/server/agent/providers/copilot-acp-agent.ts#L37-L47). | A new ACP session does not require rewind support. Actual Copilot version, durable load and selected options need live verification. |
| Muse | This release uses its **native MSP plugin**, not generic ACP: no persistence calls `session/start`; a handle calls `session/resume`. Its declared capabilities omit revert. [session.ts:102-135,171-199](https://github.com/getpaseo/paseo/blob/v0.17.4/plugins/muse-provider/server/session.ts#L102-L135), [provider.ts:26-35](https://github.com/getpaseo/paseo/blob/v0.17.4/plugins/muse-provider/server/provider.ts#L26-L35). | Source supports fresh start independently of rewind; live isolation, reconnect and model/options remain untested. First-turn system instructions are injected separately: [session.ts:238-248](https://github.com/getpaseo/paseo/blob/v0.17.4/plugins/muse-provider/server/session.ts#L238-L248). |

Claude/Codex first-anchor rewinds may remove the chosen turn but need not prove
freshness for arbitrary anchors. Provider transcripts, system/project
instructions, automatic memory and files are separate from conversation
history; a new session is not a guarantee of zero other context.

## Proposed minimal upstream contract

Add a daemon-level, capability-discoverable **new provider session for this
existing agent**, exposed to the plugin/client through a typed request and
response. Reuse the reload lifecycle lane, launch preparation, hooks, provider
`createSession`, registration and existing durable timeline rather than add a
Factory runtime or require a new provider protocol method. Provider plugin
`session.open` already permits no persistence and has separate history replay
control: [provider.ts:346-356](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/plugin/src/server/provider.ts#L346-L356).
Capability must mean the complete tested contract, including restart behavior,
not merely that `createSession` exists. Reject unsupported cases explicitly.

1. Require idle/no pending permission, unresolved send, background work or
   conflicting lifecycle action. Under the agent lifecycle lane, verify agent,
   current provider/session generation and an expected model/options revision;
   reject stale selections before effects. Drain events and ensure any legacy
   provider-only history is durably materialized before touching the old session.
2. Record an idempotent operation ID, intent and old binding durably. Stop
   the old writer and create a fresh session with the **same Paseo agent ID**,
   workspace/owner/title/labels/metadata and launch policy, hooks, environment,
   model, mode, thinking and effective provider options. Do not copy old provider
   messages into the new session. Refresh/clear session-scoped metrics, pending
   provider state and subagent projections as appropriate.
3. Keep-history: retain all committed old timeline rows and append new rows
   after a persistent **session boundary**; support pagination, reconnect,
   search and reload across it without provider replay overwriting old rows.
   Rewind from the new session must reject old-segment anchors or explicitly
   address their owning session; otherwise an old visible message could target
   the wrong provider thread. No file rewind is implied.
4. Clear-history: atomically transition the visible canonical timeline to an
   empty new generation and notify clients with replacement/invalidation; old
   pending writes, stale cursors or caches must not resurrect rows. Define
   this as clearing Paseo-visible history, **not secure erasure**: old provider
   transcripts/imports and independent client caches may still exist.
5. Commit new binding or an explicit **fresh-but-not-yet-resumable** state,
   timeline generation and operation outcome coherently. A no-handle restart
   must create from stored config **without** `deleteAgentState`, and preserve
   the intended segment/history policy; never resume the old handle by default.
   For Claude/Codex lazy handles, preserve the fresh intent until a genuinely
   resumable new handle is saved, including across restart before the first turn.
6. Report `completed`, `pending/reconciling` or explicit failure with an
   operation receipt. Crash/lost response after a provider effect is uncertain:
   reconcile by operation ID and persisted generation before retry, never
   silently send a brief or create another session. Before the commit, failure
   may leave the old session closed; recover it only if known safe and explicitly
   report the state. After commit, never roll back to the old binding silently.

The Factory keeps its own scope lock/epoch and worker ownership, revalidates
authority and account policy, and delivers or stages **one** checkpoint-based
brief only after the native operation is confirmed. A reset does not itself
change the controlling agent/epoch. This is a proposed integration, not proof
that current Factory or Paseo APIs already enforce it.

## Model and acceptance checks

The plugin composer exposes `agent.provider/model/mode/thinking/options` and
setters; `useComposers` resolves known agents even if their tabs are closed, but
requires the plugin client. [composer.tsx:25-64](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/plugin/src/client/composer.tsx#L25-L64),
[99-148](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/plugin/src/client/composer.tsx#L99-L148).
The server serializes model/mode/options mutations in its lifecycle lane and
stores the accepted selection, but composer observation and a reset request are
not one atomic action. [agent-manager.ts:2541-2585](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/server/src/server/agent/agent-manager.ts#L2541-L2585).
**Proposal:** pass the exact observed tuple/revision; validate inside the same
lane, preserve effective provider-returned selections, and reject concurrent
changes. No silent default/fallback; provider/account availability remains
Factory admission policy. Verify actual model on the first new turn.

Required upstream acceptance before enabling the action:

- For each of the four providers, create an old conversation with a distinctive
  marker; reset keep-history; verify unchanged Paseo ID/title/workspace/owner,
  old and new messages in order, and that the fresh provider does not receive
  the old conversation. Verify restored role instructions and selected model,
  thinking, mode and options; check project instructions and provider memory
  separately. No actual provider run was performed for this report.
- Restart before the first new prompt, during provider creation, after provider
  commit but before response, and after the new handle becomes durable. Reopen,
  reload and paginate; retained rows and correct binding survive, no duplicate
  resume packet or accidental old-session resume.
- Clear-history removes old rows from all active views and after reconnect/
  restart; retained provider transcripts are not represented as securely erased.
  Keep-history never clears a row; failed hydration/failed writes block success.
- Test first/later/missing/unacknowledged rewind anchors, pre-reset segment
  rewind rejection, files unchanged, provider rejection, busy/permission and
  stale-selection races, operation replay and lost acknowledgement. Preserve
  workers/authority and exercise Continue, Composer and Wait independently.

Current product documentation: [provider plugins](https://paseo.sh/docs/plugins/providers.md)
and [SDK agents](https://paseo.sh/docs/sdk/agents.md). The user authorized
implementation and early practical validation on 2026-11-26.

## N1 research note — Codex account change

Retained Paseo history plus a fresh Codex thread under the destination
credentials could let the same tab continue across accounts without loading
the previous account's encrypted reasoning. The old thread remains bound to
its original credentials. Continue from a short verified checkpoint, and
treat provider-context transfer and cache reuse as unverified. This path
would need native coordination between binding the account at session open,
confirming the new thread and releasing the queued prompt.

ZeroSub 1.34.0 already has an opt-in same-Codex-thread reload for compatible
members of one ChatGPT workspace with shared session storage. That path
resumes the existing thread. It falls back to a continuation tab for
incompatible accounts or a decryption failure. Test fresh-thread renewal
separately if N1 makes it possible, and compare first-turn cost and recovery
against the existing continuation. This remains a research observation.
[ZeroSub Codex behavior](https://github.com/kapybara-org/zerosub/tree/v1.34.0#keep-a-codex-chat-in-the-same-conversation-optional)
