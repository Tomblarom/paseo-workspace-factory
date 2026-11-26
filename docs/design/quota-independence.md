# Quota-independent start and continuation

The user submits work once. Factory starts it on an eligible route or shows when it can retry.
The same prompt, attachments, permissions and stop controls apply at high, low and zero quota.
Execution still needs provider capacity. At zero eligible capacity, the accepted request stays
recoverable without a model turn. Closing the app has no effect on accepted work.

This design builds on scope checkpoints, the worker register, live steers and Paseo's native
send, rewind and session APIs. It describes the current implementation separately for each goal.

## A. Start the same way at any quota level

**Today.** The documented workflow sends the prompt to the active steer. Quota controls work
mainly around profile selection and unattended supervision. A worker wake uses the account
bound to the steer. A bound account can lack usage windows, particularly with API billing.
Its missing or stale percentages remain unknown. A limit reported for that account and
model still blocks delivery until recovery. Provider-pool usage applies to unbound routes. The turn-before hook tracks the open turn and never
checks quota or context. The composer can already show a cold or resume pill before typing.
[`concepts.md:15–21`](../concepts.md#work-in-one-scope) ·
[`supervise.ts:550–601`](../../plugin/server/supervise.ts#L550-L601) ·
[`turn-hook.ts:113–136`](../../plugin/server/turn-hook.ts#L113-L136) ·
[`index.client.tsx:77–110`](../../plugin/index.client.tsx#L77-L110)

**Gap.** A normal composer submission can reach a known exhausted account or a large cold
session. There is no Factory record of a pending user request to route during a reset. A wake
checks `needsResume`, but ordinary wakes and takeover messages can open cold sessions. CLI
switch sends directly after changing the active slot. Paseo SDK 0.16.2 exposes turn-before
as a non-waiting notification and composer contributions as controls. A plugin cannot
intercept the ordinary Send with those APIs.
[`supervise.ts:640–659`](../../plugin/server/supervise.ts#L640-L659) ·
[`supervise.ts:1257–1287`](../../plugin/server/supervise.ts#L1257-L1287) ·
[`steer.mjs:858–882`](../../src/steer.mjs#L858-L882) ·
[Paseo lifecycle hook contract](https://github.com/getpaseo/paseo/blob/main/public-docs/plugins/hooks.md#hooks)

**Design.** Use one preflight decision for Factory-owned starts (wake, switch, takeover,
resume and worker start) and the composer warning. Return the eligible live holder, effective
provider/model/account, quota evidence, estimated cache state and a reasoned disposition
(ready, needs renewal, wait for reset, or needs review). Recheck holder, outstanding
permissions, busy state and route under the existing workspace lock before a transition.
With ample or tight usable quota, dispatch immediately when the route is suitable. With no
eligible capacity, persist a wait and retry on a refreshed quota sample at the next known
reset for an eligible route. Use bounded backoff and expose the wait when the reset time is
unknown. If no route meets role, privacy or permission requirements, expose the blocker for
review. Keep ordinary starts responsive when cached quota evidence is missing.

Use the existing pill for read-only advice in the standard composer first. A Factory-owned
submit action can offer the full flow for input it can faithfully retain and resend. Verify
native attachment references, draft clearing on durable acceptance, sender identity and
permissions before offering that action for attached input. Full parity for ordinary Send
requires a native pre-dispatch contract that can accept, defer or route the original message
envelope with a stable ID and an acknowledged disposition. Keep pending state on the host,
using a native message reference where available. Avoid copying full prompts into checkpoints.

## B. Recover after a limit, crash, stop or app close

**Today.** Turn-after reads the newest turn for a fenced CHECKPOINT on completion. Active
steer blocks update the scope checkpoint; other blocks become per-agent notes. A failure
or cancellation records a bounded answer tail and git summary. If a task checkpoint exists,
its task and next step remain and the checkpoint gains an interruption flag. A recognized
failed steer limit also sets `needsResume` and calls failover immediately. Boot reconciliation
marks persisted open turns interrupted and sets steer resume flags. Scope-owned workers
survive handoff and their actionable outcomes can queue wakes.
[`auto-checkpoint.ts:256–309`](../../plugin/shared/auto-checkpoint.ts#L256-L309) ·
[`auto-checkpoint.ts:334–344`](../../plugin/shared/auto-checkpoint.ts#L334-L344) ·
[`turn-hook.ts:311–328`](../../plugin/server/turn-hook.ts#L311-L328) ·
[`turn-hook.ts:371–385`](../../plugin/server/turn-hook.ts#L371-L385) ·
[`turn-hook.ts:465–480`](../../plugin/server/turn-hook.ts#L465-L480) ·
[`boot-check.ts:335–388`](../../plugin/server/boot-check.ts#L335-L388) ·
[`concepts.md:47–51`](../concepts.md#supervision-survives-interruptions)

**Gap.** A mid-turn limit without a new block leaves the last checkpoint plus unverified
evidence. A limit on the first turn may leave no task or next step at all. The brief then asks
the user to confirm the task. A missed or reordered notification can race the open-turn
write. Cancellation yields interruption metadata but no dedicated pause/continue policy.
Daemon restart can rebuild interruption marks, but the normal failover scan needs open workers
and a recorded wake. A manual switch can commit its epoch and lose the handoff send. A wake
can mark events sent while the resume has only requested Claude's clear. A crash between
rewind and brief can leave the tab refreshed with no delivered brief.
[`steer.mjs:564–584`](../../src/steer.mjs#L564-L584) ·
[`steer.mjs:858–882`](../../src/steer.mjs#L858-L882) ·
[`turn-hook.ts:113–136`](../../plugin/server/turn-hook.ts#L113-L136) ·
[`supervise.ts:640–659`](../../plugin/server/supervise.ts#L640-L659) ·
[`supervise.ts:1163–1172`](../../plugin/server/supervise.ts#L1163-L1172) ·
[`resume-apply.ts:228–248`](../../plugin/server/resume-apply.ts#L228-L248) ·
[`rewind.mjs:150–164`](../../src/rewind.mjs#L150-L164)

**Design.** Persist a small pending request under the scope lock before dispatch. Bind it to
the native message reference or bounded Factory-owned payload, scope epoch, holder ID/generation,
and the last verified checkpoint revision. Track acceptance, dispatch, start, recovery and
completion separately. Reuse work-package CHECKPOINTs and per-worker notes as durable progress.
Turn hooks reconcile by delivery and turn IDs, with a terminal turn unable to become open again.
On boot or failover, recover pending user requests alongside worker events, including scopes
with zero workers. Bind a delivery to stable message IDs or creation receipts where supported.
If acceptance is uncertain, inspect native state or ask for review before resending. A send
receipt alone is insufficient evidence that an interrupted request was handled.

Build one bounded handoff brief with the accepted request, current CHECKPOINT, verified git
state, outstanding worker IDs, and a reference to evidence of uncheckpointed progress.
Label the excerpt as a hint. For a worker use its own registered assignment, note and next
step. Inspect the workspace and effect receipts before repeating work. Keep unresolved
permissions for review and require reconciliation before retrying external side effects.
Missing evidence may cost rework since the last checkpoint. Resume automatically after
recoverable limit or crash according to policy. An explicit user Stop pauses that request
until Continue. Treat an ambiguous cancellation as paused for review. A closed app leaves
daemon supervision in charge. Carry the request through a generation change and retire the
old attempt when the new holder has actually accepted it.

## C. Warn before costly turns and renew by opt-in

**Today.** Status has an optional token-size warning, disabled by default. The composer
feed uses a generic idle/size threshold or saved fresh recommendation. Idle cleanup
defaults to Claude, 60 minutes and 100k context tokens. Idle clear needs acknowledgment.
The configurable warm compact mode runs on a five-minute sweep, requires recent checkpoint
or note and protects interrupted workers. The cache model estimates TTL by model group.
The sweep recommends fresh after the TTL, after repeated compaction, at a package boundary or
at a large post-compact base. Its Codex same-tab rewind is opt-in, requires an eligible
sweep configuration and stages no brief. Manual `fresh` can rewind or use a confirmed
replacement. Supervision is on by default and its automatic wake resume can request Claude
clear independently of idle-cleanup acknowledgment. Outside the resume clear allowlist it
sends the brief into the existing session, including Codex with default settings.
[`saving-context.md:10–22`](../saving-context.md#seeing-usage) ·
[`steer.mjs:147–153`](../../src/steer.mjs#L147-L153) ·
[`cold-sweep.ts:362–406,572–585,704–727`](../../plugin/server/cold-sweep.ts#L362-L406) ·
[`idle-cleanup.ts:213–224,409–461,468–539`](../../plugin/shared/idle-cleanup.ts#L409-L461) ·
[`cache-profiles.ts:21–44,95–99`](../../plugin/shared/cache-profiles.ts#L21-L44) ·
[`settings.ts:132–167`](../../plugin/shared/settings.ts#L132-L167) ·
[`supervision-design.md:93`](supervision-design.md#failover) ·
[`resume-apply.ts:228–278`](../../plugin/server/resume-apply.ts#L228-L278)

**Gap.** Before Send there is no unified warning for likely uncached input, a costly
model/thinking choice for a known routine task, or consecutive turns without a CHECKPOINT.
Missing checkpoint evidence currently inhibits cleanup without telling the user why.
The generic 60-minute badge misses shorter modeled cache windows, and a five-minute sweep
can miss an entire warm-compaction interval. The compact guard checks the routed
ZeroSub account (provider-wide sample only as fallback) and skips unknown quota.
Fresh recommendations occur before the sweep's cap check and the optional rewind fetches
the first anchor again, dropping the brief anchor. The proactive account hint itself sends
another prompt. Measured cache warmth and exact compaction cost are often unavailable.
[`idle-cleanup.ts:449–509`](../../plugin/shared/idle-cleanup.ts#L449-L509) ·
[`cold-sweep.ts:193–200,347–359,379–406`](../../plugin/server/cold-sweep.ts#L347-L359) ·
[`cold-context-resume.md:112–131`](cold-context-resume.md#cache-reference-and-cost-profiles) ·
[`turn-hook.ts:388–395,454–457`](../../plugin/server/turn-hook.ts#L454-L457) ·
[`findings-compact-vs-fresh.md:3–16`](codex-research/findings-compact-vs-fresh.md#L3-L16)

**Design.** Evaluate likely cache warmth using last real activity, observed context size,
live model and a configurable account/cache profile. Label missing usage and uncertain TTL
as estimates or unknown. Count completed ordinary turns since the last valid checkpoint or
note and prompt for a checkpoint at a work-package boundary. Use explicit routine/complex
task intent for worker cost warnings and priority, with a manual model choice. Combine reasons
in the existing pill, status and switch preview. Recompute before dispatch and keep warnings
out of model prompts.

Make mutation separate from advice. Require opt-in for proactive clear or rewind at dispatch,
and retain explicit choices for compact and Claude history handling. Leave a healthy warm
session alone unless a measured benefit justifies a configured warm compact. Prefer a
verified same-tab Codex rewind and use the saved brief anchor with the smallest native
timeline lookup available. For Claude use the supported clear path only with consent and
retain the previous session for history import. Bind confirmation to holder, generation,
session, checkpoint revision and exact action. Use the same cap and pending-action checks
for all automatic renewals. Deliver one brief with the first actionable request when
possible. If rewind/clear is unsupported, ambiguous or fails, retain the request and offer
a confirmed fresh replacement or explicit same-context continuation. Record the effect
before declaring success. Replacement keeps the role and worker lineage and sends no
notice that reopens the old session. Reserve real quota for work when the chosen route's
headroom is limited or unknown.

## D. Share limited quota across Codex and Claude

**Today.** `quota.mjs` understands pool thresholds, per-account limits and reset times.
ZeroSub can supply agent routes and preferred account pins, with best-effort fallback to
sampled usage. Supervision lets ZeroSub handle a move or continuation first and can wait for
a known reset. Candidate ordering considers failing pool, account headroom and slot order.
Slots currently mix configured profiles with discovered agents. The ongoing redesign makes
a slot the identity of one live steer, uses actual provider/model and explicit role/privacy
state for live routing, and uses plugin priorities for creation.
[`concepts.md:39–57`](../concepts.md#quota-pools-and-zerosub-accounts) ·
[`quota.mjs:58–119,129–148`](../../src/quota.mjs#L58-L119) ·
[`zerosub.mjs:31–76,268–299`](../../src/zerosub.mjs#L31-L76) ·
[`supervision.mjs:316–338,377–420`](../../src/supervision.mjs#L377-L420) ·
[`slots-live-design.md:19–41,67–95`](slots-live-design.md#switch-and-failover)

**Gap.** Failover can select another exhausted or busy holder, including domain/hub, and
pool evidence can disagree with the live account. The ZeroSub normalizer counts expired
windows, accepts unknown versions and drops move waiting state. Its single pending-account
field can misstate which route is live. Brief and CLI worker picks do not use the same
snapshot inputs and plain launch flags omit the account pin applied by `worker start`.
Quota display can attribute a family maximum and a generic five-hour label to the wrong route.
The CLI lacks the plugin's quota view. Native recurring prompts can spend model turns
after takeover. Factory's fallback checks delivery state before waking a steer.
[`supervise.ts:1231–1287`](../../plugin/server/supervise.ts#L1231-L1287) ·
[`zerosub.mjs:31–76`](../../src/zerosub.mjs#L31-L76) ·
[`quota.mjs:168–185`](../../src/quota.mjs#L168-L185) ·
[`cli.mjs:146–149,859–876`](../../src/cli.mjs#L859-L876) ·
[`workers.mjs:29–40`](../../src/workers.mjs#L29-L40) ·
[`supervision-design.md:62–79`](supervision-design.md#wake-rules)

**Design.** Use the slot redesign's live holder and generation, effective settings and
candidate selector. Prefer the actual per-agent account, then a valid pool override, then the
live provider pool. Normalize version, timestamp, per-window reset and live versus pending
route separately. Keep independently reported active limits. Wait for an in-place move only
while it can complete, honor deliberate holds, and resolve verified continuation IDs before
sending. Refresh after reset and show account/pool, actual window, percent used, sample age
and next retry in status/resume. Filter known exhaustion, busy candidates and privacy/role
conflicts across local/domain/hub routes before ranking. Preserve escalation order, favor
measured usable quota and lower expected context cost within each tier, and use slot priority
to break ties. Reuse worker profile selection and the pinning start path across UI, CLI and
briefs. Bound concurrent claims on the same account and track attempted holders by epoch.
Apply destination data-sharing policy before cross-provider handoff. Use state-only timers
for retries and watchdogs, and debounce wakes when events change.

## Findings and implementation order

The efficiency audit identified cold wakes, old-session Codex resume,
bad failover picks, oversized briefs, wrong worker recovery scope, stale quota windows,
costly heartbeat turns, unbounded rewind lookups and missing cost measurements. They also
record mismatched slot configuration and actions whose labels did not match their effects.
Keep one bounded checkpoint and link direct paths or doc anchors in handoffs to avoid
re-reading whole files for isolated facts.

1. **P0 — Baseline and shared decision.** Reuse existing quota and cache helpers with live
   holder adapters during the slot migration. Surface route-specific quota and cold,
   expensive-routine and checkpoint-age warnings in status, the composer and previews.
   Unit-test stale/missing samples, explicit limits, TTL boundaries, known task tiers and
   busy/ambiguous holders. Assert advice uses no model turn.
2. **P0 — Recover Factory deliveries.** Persist requests and versioned wake events before
   dispatch. Reuse epoch locks and receipts, reconcile on boot and build bounded steer/worker
   briefs. Fault-inject first-turn limit without CHECKPOINT, stop, missed and reordered
   hooks, concurrent takeover, crash before send and crash after send before acknowledgment.
3. **P1 — Safe routing and renewal.** Apply preflight to Factory starts, wire Codex rewind
   and opt-in Claude clear to the common recovery flow, and fix the account selector and
   routine worker pick. Test reset and ZeroSub move/hold/restart fixtures, cap and consent
   gates, failed rewind or clear, changed holder and privacy boundaries. Run scratch Codex
   and Claude checks for native effects and tab history after daemon restart.
4. **P1 — Composer parity and cost.** Verify or request native pre-dispatch support and
   expand from Factory-owned submissions. Test identical draft/attachment and permission
   behavior with high, low and exhausted quota, and resume after app close. Measure queue
   delay, first-turn cached/uncached input, tool rereads and available account quota deltas
   by trigger/model/idle age. Avoid prompt or account identity in aggregate measurements.

## Open questions

1. Can Paseo provide durable prompt admission, native message references including
   attachments, and a retry disposition that covers ordinary Send and CLI input?
2. Which explicit scopes may auto-wait or switch providers, and should a confirmed
   replacement ever become an opt-in automatic operation?
3. Which native cancellation reasons reliably distinguish a user Stop from provider and
   resource interruption across Codex, Claude and ZeroSub?

## Decision 2026-11-26: no proactive quota handover

The warn threshold is informative only (status, pill, quota line in briefs). Remove the
proactive account hint (`proactiveSwitchDecision`, `proactiveHintDecision`,
`proactiveHintForTurn` and its agent-state fact). Reasons: it sends its own prompt, i.e. an
extra model turn; the switch it proposes is refused while the receiving steer is running
(the hint itself starts that turn); and a handover at 75 % gives up up to a quarter of the
window, a warm cache and pays a new initialization without evidence that this is cheaper.
Real limits are covered without it: ZeroSub continues a limited agent on another account,
the factory follows the continuation (slots-live-design decision 5), and ZeroSub
chooses the start account at creation (decision 6). Factory previews may show the
roomiest account as quota evidence. Exclusion of accounts uses
`exhaustedPct` everywhere; `steer add` no longer treats the warn threshold as exhausted.

Policy (configurable defaults, pragmatic, not empirically tuned): below `warnPct` 93 % work
normally; from 93 % warn only in status, pill and briefs that are delivered anyway; from
`exhaustedPct` 95 % prefer a holder on another account with room at the next delivery that
happens anyway (wake, report, resume), judged by the quota at dispatch time. Never interrupt
a running turn and never send a prompt only to warn or to hand over. This reuses the
existing delivery target choice (deliverSteer and the failover order); if that cannot pick
another holder at dispatch, note the gap instead of adding switching infrastructure.

## Open P0 — Quota admission before context renewal

Live evidence: three Assignment Reports were delivered once each to the active Claude
holder. All three turns failed at the quota limit, two after a confirmed `/clear`. A
subsequent worker-completion wake triggered automatic failover, and the next steer took
over successfully. The recorded failover reason named the configured Codex pool while
the failed holder was running Claude. The takeover proves the mechanism works. The
reason string does not establish which account or window was depleted.

- **Admission and failure detection.** `flushScopeWake` checks the configured pool and
  can invoke `runFailoverCheck` or wait for a reset. Reports reserve a target and Resume
  passes an agent ID into `deliverSteer`. That function chooses send, clear or rewind
  without a shared admission decision. The failed-turn fallback also missed this case:
  `isLimitFailure` returns false for `You've hit your 5-hour limit`, and the live holder
  was recorded as `needsResume: failed`, so the limit-specific forced check did not run.
- **Holder resolution.** The server resolves one live holder per affected slot. The
  feed also projected archived rows for both slots, and the menu counted those rows
  as competing holders. It even marked both rows of the active slot as active by slot
  alone. Use the same resolved holder IDs for routing, the feed and menu eligibility.
  Keep genuinely ambiguous live membership blocked.
- **Continuation and batching.** K7 `reportedAt` records delivery, which can precede a
  failed recipient turn. Source assignments already preserve the report text, target
  and stable action ID. The successor brief omits these records, duplicates the
  checkpoint in handoff and resume sections, and clips `next` before applying the
  overall budget. The existing worker `EventBatch` and K7 receipt reconciliation provide
  a path to group reports without a new queue. A report action currently retains one
  source reference, so grouping requires preserving all source/action pairs and
  reconciling each source receipt.

Reuse the worker-wake admission and failover mechanisms across wakes, Assignment Reports
and Resume. Resolve the live holder and effective account/model first. Use fresh account
evidence with the configured `exhaustedPct`, falling back to the provider pool when
only pool evidence is available. Preserve the existing fail-soft behavior for unknown
quota. Admit before reserving renewal or clearing/rewinding context, and revalidate the
holder, epoch, quota, busy state and permissions at the existing guarded dispatch points.
If ZeroSub has continued or is moving the holder, follow that decision. Otherwise use
the existing failover order or defer to an eligible reset via the current sweep. Keep
explicit tab recovery and takeover targets subject to the existing authority and consent
checks. Route scope work via failover without silently editing a different tab. Treat
provider-reported hard limits as admission evidence and feed them into the same path.

Gather reports already pending for the same resolved recipient and epoch into one K7
delivery when useful, with a bounded brief and stable source references. Do not delay a
ready report to create a batch. Rebind only deliveries known to be unattempted, and
reconcile attempted or uncertain deliveries by receipt before any resend. Surface
outgoing assignments and reports delivered without a corresponding completed recipient
turn in one canonical successor brief, using the existing source records and compact
references. Preserve delivery receipts independently of the processing state.

With the original holder and epoch still valid, the daemon can reconcile an exact
send replay against its durable receipt. After an authority change, reconciliation
requires a read-only acceptance receipt keyed by recipient and message ID. The
current Paseo contract exposes that receipt through send only. Keep unresolved
reports queued until positive acceptance evidence is available. A timeline row alone
cannot establish acceptance.

ZeroSub's `move_before_limit` adds a candidate when delivery is due, the active
Claude or Pi agent is idle with no user pin, and another eligible subscription
account has enough quota. Rank the move with handover, renewal and creation
using the [effective routing plan](control-concept/implementation-plan.md#p1-routing-acceptance).
An automatic binding can move. A user pin, including a pin applied by creation
metadata, is an explicit routing constraint. A confirmed move can preserve the
holder and provider conversation while cache reuse on the target account is
still unknown. Verify the runtime account and quota before sending. The move
result and the K7 send receipt track separate effects.

Acceptance: each of the three entry points refuses renewal on a known exhausted holder.
A pending report alone can trigger the demonstrated takeover, or wait for quota when no
route is eligible. Reproduce the Claude wording and the archived B/E rows. Verify that
batched reports survive interruption and epoch changes without duplicate messages or lost
source receipts, and that a successor can continue from one brief after a failed handler
turn. Reuse the existing sweep, K7 records and delivery locks.

### P0 bounded acceptance and remaining work

- Shared admission reads the live target's provider/model and account, applies the
  configured threshold and hard-limit evidence, and is rechecked at reservation and
  guarded effects (`plugin/server/steer-admission.ts:14`,
  `plugin/server/steer-delivery.ts:314,512,729,877`). Claude limit wording feeds the
  existing forced-failover path (`plugin/shared/idle-cleanup.ts:65`,
  `plugin/server/turn-hook.ts:581`). Resume keeps explicit authority and consent.
- A lone report can request takeover without a worker; the candidate can switch itself
  without a turn from the exhausted holder, or the sweep retains the report until a
  route becomes available (`plugin/test/turn-hint.test.mjs:565,699`).
  Direct reports, report sweep and forced failover respect boot and global/source/target
  drain; confirmed receipts can still be reconciled (`plugin/server/supervise.ts:319,1075,1313`,
  `plugin/test/turn-hint.test.mjs:605`, `plugin/test/supervise.test.mjs:832`).
- Live title-based holder resolution excludes archived rows and refuses genuine
  ambiguity (`plugin/server/core/scope-guard.mjs:16`,
  `plugin/test/steer-menu.test.mjs:98,120`). Already-pending K7 reports share one turn
  with independent source receipts; interruptions, failed recipient turns and epoch
  changes are covered (`plugin/test/turn-hint.test.mjs:364,401,497`).
  The successor brief includes outgoing work and marks delivery as unverified processing
  (`plugin/server/core/discovery.mjs:365`, `plugin/server/core/steer.mjs:572,705`,
  `test/resume-brief.test.mjs:138`).
- Fixture measurement: three short pending `result 1`–`result 3` reports go from
  three turns / 24 total report characters to one turn / 172 characters including
  source/action identifiers. For the interrupted handoff fixture, the baseline
  `steer.mjs` run against the current shared fixture dependencies produces 1,553
  characters and two checkpoint sections; current produces 1,190 and one. These
  isolated comparisons do not predict live token use.
- **Native dependency:** an uncertain send after an epoch change cannot be safely
  reconciled or replayed without read-only positive acceptance evidence keyed by
  recipient and message ID; keep it visibly blocked (`plugin/server/core/steer-action.mjs:33`,
  `plugin/test/turn-hint.test.mjs:497`). A timeline row alone is insufficient.
  Full retained-history renewal and ordinary composer pre-dispatch remain separate
  native dependencies of the control plan, not claims of this package.
- **Local follow-up:** failed or incomplete boot scans need bounded retry and
  per-scope recovery; quiet admission does not repair the boot once-flag risk
  (`plugin/index.server.ts:159`, `docs/design/control-concept/research-automation.md:142`).
  Due-delivery initiation belongs to
  [Z1](control-concept/implementation-plan.md#z1--native-early-account-move).
  The development host now runs
  [1.34.0](https://github.com/kapybara-org/zerosub/releases/tag/v1.34.0).
  The merged [ZeroSub #108](https://github.com/kapybara-org/zerosub/pull/108)
  ships the one-agent RPC. Delivery admission now waits while ZeroSub
  reports a different live account from the destination.
  The combined regression in `plugin/test/turn-hint.test.mjs` clears supervision
  memory after a confirmed takeover request and verifies that K7 preserves the
  answer window, rejects a stale switch and delivers the report once to the
  successor. A real daemon restart and provider behavior still need live
  validation.
