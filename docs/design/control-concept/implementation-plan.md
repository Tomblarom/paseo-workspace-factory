# Control concept implementation plan

Implementation authorized, 2026-11-26. The user accepted the [concept](concept.md) and its
three decisions, with additions for native context/history separation,
role-specific reset, managed-steer lifecycle, pre-dispatch and causal hover repair.
This plan incorporates the two reviewed native research reports and specifies
delivery gates. The user approved same-tab provider-session renewal and the three
native extensions in principle, and asked to start with P0. Native contracts need
runtime validation before dependent Factory implementation grows around them.

## Delivery boundaries

Factory changes are implemented in this repository. Native context/timeline,
dispatch and menu changes belong in Paseo, each in its own appropriate PR
workspace under the user's in-principle approval. Prepare concrete evidence and
bounded proposals first. Existing contribution rules govern the appropriate
upstream form, publication and draft PRs.

Prefer existing provider operations and the native SDK. Add a native operation
only for a demonstrated gap. Factory code consumes the agreed result and
capability rather than reproducing a timeline store, prompt queue or runtime.

The three user-facing automation choices stay independent and shallow.

| Setting | Choices | Accepted default |
| --- | --- | --- |
| After reset | Continue assigned open work / Composer / Wait | Continue assigned open work |
| No suitable steer | Create / Offer creation / Wait | Create |
| Routing strategy | Efficiency / Balanced / Preference | Efficiency |

Keep history retention and idle maintenance as their existing separate concerns.
Steer creation uses these routing preferences without changing them. Avoid new
per-slot, per-menu, per-provider priority and nested automation configuration.
Choose bounded internal retry rules with evidence before exposing more controls.

## Baseline and dependencies

The development checkout is serving the live plugin. On 2026-11-26 its existing
uncommitted changes include title membership, quota admission, K7 delivery and
recovery changes. The P0 local integration below records their acceptance.
Reading the diff establishes implementation state. Historical research reports establish
intent and observed evidence, with their stated version limitations.

| Gate | Evidence needed | Work it enables |
| --- | --- | --- |
| B0 | Accepted existing changes, clear file ownership, current tests/typecheck and exact daemon/client version | Trustworthy implementation baseline |
| N1 | Native session/timeline contract and provider feasibility | Full Reset Steer with history retention |
| N2 | Native waiting pre-dispatch contract and preserved original request | Transparent renewal for ordinary user prompts |
| N3 | Reproduced native submenu highlight cause and regression case | Causal hover correction |
| Z1 | Loaded ZeroSub supports `move_before_limit`, and scratch validation confirms binding, runtime account, context and cache observations | Early same-steer account move as an eligible routing option |

N1 and N2 can share a verified context-renewal primitive. A waiting hook by itself
provides no timeline separation. Current public hook documentation describes
`agent.turn.before` as a notification. Planning must distinguish the installed
0.17.4 behavior from later docs and APIs. [Paseo hook reference](https://paseo.sh/docs/plugins/hooks.md)

### Dependency decisions from research

The reports inspect public Paseo v0.17.4, tag commit
`2b3559b107243306986176b80beb0e779f9fe53e`. The installed CLI reports 0.17.4.
Matching installed daemon/client bundles to that source remains a B0 check.
Provider behavior and the reported pointer sequence remain live-unverified.

- **N1 — Propose native provider-session renewal in the existing agent.** Reuse
  native session creation and lifecycle serialization. Preserve the Paseo ID,
  ownership, selected model/options and a durable segmented timeline. Existing
  rewind replaces the visible timeline and can retain pre-anchor context.
  The user clarified on 2026-11-26 that rewind was a suggested Codex mechanism.
  Configurable visible-history retention and efficient provider-context renewal
  define the requirement. Paseo owns the provider-independent operation and
  uses each provider's native session creation. Factory owns admission and
  continuation policy.
- **N1 restart gate — Persist fresh intent before effects.** A fresh session may
  initially lack a resumable handle. The current no-handle loader creates from
  the record through a path that deletes committed timeline rows. Native renewal
  must preserve history and its new session binding across that restart window.
  Require operation receipts, session boundaries, stale-selection checks and
  old-segment rewind handling before Factory enables the action. Source supports
  new-session paths for Claude, Codex, Copilot and Muse. Each needs live proof.
  [Reset research](research-native-reset.md)
- **N2 — Propose a host-owned pre-dispatch transaction.** A short policy decision
  starts a durable, cancellable pending transaction when renewal is needed.
  Paseo retains the captured request, attachment lifetime and stable identity,
  reserves per-agent ordering, and exposes read-only transaction/receipt status.
  A nested public send while holding the current recipient lane would deadlock.
  Initialization needs a host-owned path within the reservation and successful
  completion before the original is dispatched. Preserve each captured message
  unchanged and define ordering with queued agent envelopes explicitly.
- **N3 — Correct native menu ancestry presentation.** Open submenu ancestry,
  pointer hover and keyboard focus share the same fill. Propose a distinct
  ancestry presentation while preserving focus, accessible expanded state and
  existing navigation/grace behavior. Reproduce the exact interaction before
  choosing the final visual change. N3 is independent of N1/N2.
  [Dispatch and menu research](research-native-dispatch-menu.md)

Factory P0/P1 and independent P3/P5 work can proceed while native work is
reviewed. P2 consumes N1. Transparent renewal in P4 consumes N1 and N2. The
reported hover acceptance consumes N3. Upstream proposals and publication require
their own workspaces and the repository's contribution process.

## P0 — Reconcile the working baseline

Inspect the registered quota worker's durable result and current diff. Accept or
finish that package through its existing assignment before modifying shared
admission/delivery paths. Record which changes already implement this plan.
Use the current plugin tests and typecheck as the baseline. Investigate failures
before attributing them to the redesign. Assign disjoint writer paths or serialize
overlapping work.

Deliverable is an accepted baseline plus a remaining-work map. It should prevent
duplicate implementations of K7 coalescing, holder resolution and quota admission.
Reload the live plugin only at a coordinated boundary after required checks.

### P0 local integration — 2026-11-26

The combined working tree at `a603b76ecd77` includes the accepted worker
changes and passes root `npm test`, plugin typecheck and `git diff --check`.
The enabled development plugin points at this checkout. The installed CLI,
SDK and running daemon report 0.17.4. The daemon reports Claude, Codex,
Copilot and Muse available. The active app client build and live provider
behavior still need verification. The coordinated development plugin reload
reported readiness and completed boot recovery.

The current diff already contains the following implementation areas.

| Area | Existing work to accept | Remaining acceptance |
| --- | --- | --- |
| Identity | Title-based membership, unique-holder resolution, feed/menu projection and continuation handling | Preserve authority checks and reject duplicate live titles consistently |
| Quota | Common delivery admission and configured exhaustion threshold passed to account selection/execution | Verify live account/holder rechecks before renewal and dispatch |
| Reports | Bounded K7 batching, per-source receipts and successor assignment references | Verify boot/drain barriers and epoch changes, retain uncertain outcomes visibly |
| Lifecycle | Turn-order race handling and context/recovery state readers | Verify the final combined working tree before reload |

The combined single-report regression clears the in-memory supervision state
between receipt and takeover, exercises the boot barrier, and verifies that
the confirmed K7 action preserves the successor's answer window. A repeated
switch from the old discovery snapshot is refused. The new holder receives the
queued report once, and the exhausted holder receives no dispatch.

The installed daemon bundle confirms that reload resumes a persisted provider
handle and that conversation rewind replaces the visible timeline. Its
`agent.turn.before` is emitted as a notification, matching the SDK's
`waits: false`. The daemon routes durable send receipts through send, while
the public agent handle offers no read-only lookup. Uncertain acceptance
after an epoch change stays visibly pending until Paseo can supply a receipt
without another dispatch. These are installed-contract checks. Provider
session renewal, dispatch ordering and the submenu interaction still require
their native runtime cases.

The user's additional failover requirement is an explicit regression gate.
With the active holder at a proven hard limit, due scope work must initiate
eligible takeover or persist a quota wait without another provider turn from
that holder. A prepared takeover request must reach an eligible successor and
complete the guarded authority transition. Include a single assignment report
with no workers, exhausted successor candidates, restart and a stale/duplicate
takeover attempt. Assert zero dispatches to the exhausted holder, one controller
and preserved worker/report ownership. Resolve the native ordering and receipt
requirements before running this through live scratch agents.

## P1 — Separate identity and consolidate policy

Use live unique-holder discovery for membership and persisted epoch/holder for
control. Move creation preferences to role-specific host priorities. Migrate
slot bindings to ordered, deduplicated route preferences. Preserve actual live
models, advisor/privacy restrictions and assignments. Review conflicting legacy
role classifications and duplicated quota settings during migration.

Consolidate existing selection, quota admission and context projection into the
effective decision used by creation, delivery, workers, cleanup and previews.
Keep observations and effects distinct so an execution recheck can reject stale
authority, route, account or settings. A native model change edits that agent.
Explicit one-run model requirements constrain eligibility without editing global
preferences.

The decision takes an automatic or explicit intent. An explicit target steer
or provider/model is a hard selection constraint. All admission and preparation
rules still apply, but a cheaper automatic alternative cannot replace it.
Return the restriction and alternatives when the request cannot execute.
Handover, Activate Steer and Create Steer and activate use this same policy and
the guarded authority/delivery backend, without a model turn or a fresh
checkpoint from the previous controller. Their UI belongs to P3/P5.

Primary areas are `shared/settings*`, `server/config.ts`, `server/core/models.mjs`,
`core/discovery.mjs`, `core/scope-guard.mjs`, `steer-admission.ts`, quota consumers
and models RPC. Paths are relative to `plugin/`.

Acceptance covers duplicate titles, one-steer startup, native model changes,
unchanged preferences after creation, per-role priorities, sensitive routes on
private/unknown scopes, advisor exclusion, actual pinned account quota, stale
observations, revision conflicts and migration of existing installations.
Every entry point must explain the same eligibility decision from the same
observation. Migration must preserve pending delivery identity.

Factory creation uses account quota to screen profiles and leaves the actual
account choice to ZeroSub. ZeroSub 1.34.0 treats `zerosub.account` creation
metadata as a user pin and supplies no per-request automatic account hint.
The next-agent setting is host-wide and also represents a user choice.
Preview account IDs describe quota evidence. Evaluate the actual runtime
route for subsequent work. Legacy completed receipts can replay their
original request, including a pin, without changing the existing binding.

### P1 routing acceptance

For due work, generate eligible alternatives and select via the configured
Efficiency, Balanced or Preference strategy. Keep the deciding evidence in
the preview. An account move has no fixed priority.

| Alternative | Evidence that can make it the best choice |
| --- | --- |
| Continue as-is | The current session is suitable, with quota headroom and little preparation. |
| Same steer, different account | The target is eligible, the conversation can resume, and reload cost plus potentially uncached input is lower than the viable alternatives. |
| Handover | An eligible standby has sufficient quota, task-relevant warm context or a shorter path to useful work. Include the brief, transfer and expected rereads. |
| Context renewal | An eligible account remains available and the expected cost of a fresh brief and rereads is lower than carrying the existing context. Renewal itself adds no account headroom. |
| Create a steer | The approved creation strategy permits it and the available routes lack the capability or headroom needed for the work. Include initialization, brief and worker/assignment continuity costs. |

Use observed cached/uncached input, provider context size and quota windows,
task fit, reload latency, brief size and initialization turns. Avoid scoring
raw quota percentages across unlike windows. If no candidate can execute,
use the existing wait or explicit offer and explain the restriction.

Implementation boundary (2026-11-26): `plugin/server/steer-routing.ts` supplies
Delivery and Failover with one captured config, account/pool quota, cross-workspace
hard-limit evidence and context-preparation policy per decision. Admission of
all alternatives uses that snapshot. `core/routing.mjs` compares admitted routes
and constrains explicit selection; effect-time quota and authority checks still
read current state. Delivery persists the decision and explicit target intent
in its existing K7 action. The intent survives renewal/restart and prevents a
send after the requested runtime model changes.

Failover compares admitted successors within the first viable local/domain/hub
escalation tier. Preparation replaces the old raw quota-percent ordering.
Missing input/cache/latency measurements stay unknown; preparation turns and
structural preference order are the currently available evidence. A pending
durable takeover is reconciled before selecting another route, and its answer
window starts only after confirmed delivery. Existing receipts, epochs and
ownership remain authoritative. Coverage is in `plugin/test/steer-routing.test.mjs`,
`plugin/test/{turn-hint,supervise}.test.mjs` and `test/routing.test.mjs`.

The comparator supports all five kinds. Production admits executable
delivery/preparation and existing successor routes. Measured input/latency
evidence, native account-move execution with durable reconciliation, and automatic
creation/renewal alternatives await their respective acceptance gates.

Host settings v3 adds separate steer, advisor and worker priorities, the routing
strategy and an original-document rollback/role snapshot. Creation previews can
use the role priorities without changing them. Routing ranks the observed runtime
tuple against those presets and leaves unknown matches unknown. Legacy slot,
prepare and initial-active fields still serve role, renewal and planning callers.
Cut those callers over to live identity before deleting the fields, letter-derived
fallback or slot alignment.

Revisioned model lists/edits and steer-creation previews now build configuration,
values and revision from one captured native settings read. Discovery shares
that configuration. A concurrent save therefore leaves an old preview bound to
its old revision and the native save guard rejects it; it cannot advertise or
write a mixed observation. Coverage is in `plugin/test/settings-revision.test.mjs`
and `plugin/test/cli-handlers.test.mjs`.

On 2026-11-26, the combined migration and consumer changes passed `npm test`,
plugin typecheck and `git diff --check`. After the development plugin reloaded,
Paseo 0.17.4 reported it running and boot recovery completed. The read-only model
list and steer-creation preview returned the same settings revision. The preview
showed the v2 source snapshot, all three priority lists and the migrated Efficiency
strategy. An unknown profile was refused. The existing scope still resolved Steer C
as the controller at epoch 17. This check covered the live RPC path.

New steer creation stores the coordination role as native agent metadata.
Existing titled holders acquire a durable role label on their next turn or
when a rename updates their slot, using the previous slot and preserving migrated
advisor restrictions. Adoption records the role in the same label update.
Continuation resolution inherits it from the origin. Status, session opens,
authority checks, handover, supervision and resume use the holder's role.
New creation preserves the original request key and replays completed legacy
receipts with their original metadata. Coverage includes an archived advisor
origin, a rename across slot profiles, a model change and a lost creation reply.
Status and scope summaries classify sensitivity from the running provider.
Adoption checks that provider even when it matches the slot preset. Applying an
adoption rechecks the agent and requires public-scope evidence for a restricted
provider. Creation and renewal profile selection now require explicit public-scope
evidence for sensitive profiles, including advisors, explicit provider/model requests
and configured but unprovisioned slots. Apply rechecks visibility before creation;
unknown visibility is refused. Steer B verified the combined tree with `npm test`,
plugin typecheck and `git diff --check` on 2026-11-26 (epoch 18).

Delivery boundary (2026-11-26): route candidates and the K7 delivery, assignment,
resume and switch guards classify the live provider, not the slot preset. Scope
visibility uses exact native GitHub scope identity and GitHub's visibility flag;
local, worktree and unresolved scope evidence stays unknown. Sensitive targets
are excluded for private or unknown scopes. Public scope alone does not establish
that a checkpoint, chat excerpt, worker result or assignment is sanitized: there
is no verified cross-provider brief boundary, so sensitive delivery/preparation
also refuses on public scopes with an actionable reason. Existing sent receipts
can settle, but an uncertain attempted send is not replayed through a now-denied
route; its bytes, identity and pending work remain intact. Explicit routing is
never silently replaced. Tests exercise visibility, advisors, runtime drift,
handover authority and pending assignment/send receipts.
The advisor check also applies to non-sensitive providers and inherits the
role from a verified continuation origin. Raw packets aggregate checkpoint,
timeline, worker, assignment, Git and quota data. The provider of the current
holder or the scope's visibility cannot establish the provenance of these
fields. An `ADVISOR-REQUEST` is a worker signal for the steer to review, and
its free text carries no authorization to share it. All existing Factory
packet builders produce unverified content for this purpose. The Factory
holds these packets for restricted routes, including same-provider advisors
and advisor routes with unknown origins. There is no automatic sanitizer or
caller-supplied flag that can authorize the packet.

Fresh and Resume now recheck the target before native preparation, direct brief
delivery, old-holder notification and composer staging. A denied brief stays in
Factory state. Pending attempts keep their bytes and message ID across policy
changes. Reconciliation can settle a confirmed send without sending again.
Direct core callers without a live admission callback still use their supplied
configuration and discovery evidence. The settings Refresh route and staged
composer reads also check current admission. Composer acknowledgement names
the specific stage. Agent-addressed Resume checks the requested subject and a
separately identified CLI caller, while unaddressed host-side inspection stays
available. Native advisor creation and ordinary native sends carry no Factory
payload attestation or authenticated calling-agent identity in the current
plugin API. The forwarding boundary for those native operations is manual.

Account-bound steer delivery tolerates unavailable quota measurements. A
quota-triggered takeover rechecks the holder and limit on a new routing
observation. When the evidence disappears, the worker result stays queued for
the holder. Regression coverage includes an API holder without usage windows,
a sibling subscription at its weekly limit, and a limit becoming unknown during
wake delivery (`plugin/test/supervise.test.mjs`).

### Z1 — Native early account move

ZeroSub [released the RPC in 1.34.0](https://github.com/kapybara-org/zerosub/releases/tag/v1.34.0).
The development host now runs 1.34.0. Reload preserved all 213 existing
bindings and the live RPC smoke check returned `auto_switch_off` for a
synthetic agent. A successful live move needs automatic switching and two
suitable accounts for a supported provider. Gate execution on the actual
installed contract, include unknown-method handling for older installations
and keep the other routes available. Use the
[merged RPC contract](https://github.com/kapybara-org/zerosub/commit/b42e7688ab6e9b6c67310b4b3e4b9b391c233c4e).

- Consider the move only for an open eligible Claude or Pi steer with due
  work and a suitable subscription target for the same provider/model.
  Honor ZeroSub auto-switch settings and its guards. `user` bindings,
  including pins created through the account RPC or creation metadata,
  remain in force. Distinguish these from `auto` bindings and unpinned
  routes. The [1.34.0 state schema](https://github.com/kapybara-org/zerosub/blob/v1.34.0/shared/model.ts#L471-L497)
  uses `pinned: true` for both user picks and automatic moves. Exclude
  known user pins, including positive `allowLimited` evidence. Treat an
  otherwise ambiguous binding as conditionally eligible in preview.
  When that route is selected and the live account and quota are verified,
  let the native move RPC enforce binding ownership and return
  `user_pinned` if applicable. The Factory never changes a pin to make the
  candidate eligible.
- Keep `stopBackgroundWork: false`. Recheck scope epoch, exact holder,
  effective policy, live account and quota at execution. Use one bounded
  in-flight attempt for the pending delivery. `moved` and `already` require
  a fresh runtime/account and quota check before send. `waiting` schedules
  no move at ZeroSub and permits a later replan. Resolve `pending` or a
  lost reply through `zerosub.state` and the matching switch observation
  before another move or dispatch. Replan from the verified runtime after
  a refusal or a move that landed elsewhere.
- A reload can preserve the steer ID, visible history and provider
  conversation while the destination account has a cold or unknown cache.
  Validate the live account, conversation continuity and first-turn cache
  reads/writes independently with sanitized same-model cases. Compare
  continuation latency and input cost with handover, renewal and creation
  using comparable work. Only use observed cache reuse in later decisions.
- Cover a user pin arriving after preview, an eligible automatic binding,
  old or unavailable RPC, busy/background work, exhausted destination,
  `waiting`, lost reply, `pending` through restart and a changed epoch.
  Exercise `pinned: true` for both binding kinds against the native guard.
  Assert preserved ownership, zero sends before confirmation and one continuation.

The `moveZerosubBeforeLimit` adapter in `plugin/server/core/zerosub.mjs`
implements the published RPC with `stopBackgroundWork: false` and no retries,
pin edits or sends. Unknown-method rejection returns `unsupported`; connection
failure before invocation returns `unavailable`; a lost reply or incomplete
legacy response returns `uncertain`. These states must remain distinct in the
delivery integration. The adapter does not execute automatically yet.
`test/zerosub-move.test.mjs` exercises these outcomes with injected clients.

`core/steer-account-move.mjs` now provides guarded attempt and read-only
reconciliation entry points. A move is recorded inside the existing delivery
action before the native RPC; a duplicate or restarted caller cannot invoke it
again for that delivery. Quota admission and the final send guard reject an
unresolved move even if native pending state disappears. Action replacement
cannot discard its unresolved record. Effective-policy validation is mandatory
at attempt and reconciliation, alongside exact-holder/epoch, idle runtime,
provider/model and preserved conversation checks. No native follow-up is sent.

After `moved`/`already`, fresh runtime/account and quota must confirm continuation.
A lost reply or `pending` also requires a recent matching `near_limit` switch row.
Native rows name accounts by display label rather than ID; ambiguous/renamed
labels leave recovery pending. Refusal, waiting, unsupported/unavailable RPC,
landing elsewhere or a now-exhausted destination resolve for replanning only;
the old action cannot dispatch or repeat the move. Tests in
`test/steer-account-move.test.mjs` cover concurrency, metadata-write failure,
restart, mismatched evidence, authority/policy changes and one final continuation.

Delivery and assignment recovery now reconcile an existing move before renewal or
dispatch. They recheck account-specific quota, current policy, conversation and
authority. The pending action retains the attempt across restart. A confirmed
destination can continue once. Uncertain outcomes wait for native evidence.
A settled refusal or exhausted destination records its eligibility observation.
The same holder can resume after an eligibility change, with the original move
receipt, routing intent and source acknowledgments. Restart and identical
observations do not repeat the native move. Legacy entries first establish a
baseline. Stop, permissions and stale epochs still defer delivery.
Cross-holder route selection and the live account-pair/auto-switch gate remain
open. Regression coverage is in `plugin/test/turn-hint.test.mjs`.

Delete configured slot inventory, `prepare`, `initialActive`, slot-profile
alignment and letter-derived model fallback once their callers use live identity.
Delete duplicated quota sources and hard-coded fallback thresholds once every
consumer uses the effective settings. Inspect legacy core knobs for real callers
before removal.

## P2 — Make reset role-safe and establish native renewal

Use the proposed N1 contract in the reviewed reset report. The required
observable result is same agent/tab identity with renewed provider context,
selected supported model and the chosen visible-history effect. Timeline history
must survive reconnect/restart when retention is selected. Worktree files and
worker ownership remain associated with the same scope. Verify whether existing
rewind, reload or native provider operations can meet this result before extending
Paseo. The research establishes the gap for full reset with retained history in
v0.17.4. Unsupported versions show an explicit compatibility limitation.

Use a role-specific continuation packet and one guarded reset operation. Capture
composer selection at click time and verify it against live state before effects.
Reset preserves control and epoch. Recheck work assignment and authority before
continuation. Reset of a stale active tab cannot initialize a second coordinator.

| Target and task | Expected result after reset |
| --- | --- |
| Controlling, assigned open work | Configured continuation strategy applies once. |
| Controlling, completed or absent task | Idle, with no synthetic work prompt. |
| Standby, no own assignment | Standby and idle. |
| Standby, explicit unfinished assignment | Only that assignment is eligible for continuation. |
| Advisor, explicit unfinished question | Only read-only advisor work is eligible. |
| Advisor, answered/absent question | Idle advisor. |
| Authority/task changes during renewal | Preserve current authority and reconcile the stale continuation before dispatch. |

Exercise keep and clear on the same agent ID with the same selected model and
options. Verify a new provider-session identity and inspect its first request
with a controlled test provider to establish that the old timeline was never
sent as input. Use a synthetic marker to check isolation with real providers.
Verify role instructions and continuity separately. Cover failure after the
native effect, restart between renewal and the first prompt, and stale history
settings. Verify old timeline anchors against the new session boundary.

Apply the same preparation decision to handover while preserving its distinct
authority transition. Replace user-facing Fresh/Refresh/Resume with Reset Steer.
Keep read-only brief inspection and compatibility aliases required by callers.
Keep internal mechanisms only where they implement a necessary provider contract.

## P3 — Simplify creation, handover and managed-steer lifecycle

Create a standby without an initialization turn. First handover or activation
initializes its coordination work. In an uninitialized native New-Agent tab,
**Create Steer | and activate** replaces Reset Steer: the left region creates
an idle standby, the right creates it and explicitly activates it. Both use
the native composer's selected provider/model/thinking/mode/options and a free
letter from title-based membership. Creation must use that exact draft tab,
without an initial “ping”, prompt or inference for standby creation.

**Activate Steer** on an existing standby targets that tab. **Handover** targets
another steer. **Create Steer and activate** targets the created steer. Use one
backend transition/preparation/continuation path and an explicit selection
constraint, with the latest valid work, worker and assignment state. None
requires another turn, consent from the old model or a newly written checkpoint.
Native Stop, permissions, role/privacy, quota and busy-operation checks remain.

Reserve create-and-activate as one durable operation. Preserve the creation
request fingerprint, receipt, scope epoch and selected target. After creation
but before activation/dispatch succeeds, recovery reuses the created agent.
Settle uncertain sends and in-flight authority changes before retrying; no
second creation, silent alternate model/steer, implicit rollback or lost report.

Native capability check (public docs and deployed Paseo 0.17.4, 2026-11-26):

- [`addComposerItem` and `useComposer`](https://paseo.sh/docs/plugins/reference.md#composer-items)
  render in agent and draft composers and expose provider, model, thinking,
  mode and effective options. Deployed `@getpaseo/plugin/dist/client/composer.d.ts:23-36`
  confirms these fields. An atomic click-time selection contract needs validation.
- That interface and `PluginComposerItemProps` do not expose draft workspace/tab
  identity (`composer.d.ts:23-69`). Known-workspace `agents.create` can omit a
  prompt, but there is no public operation to attach its result to that exact
  originating draft. [`composers({ agentId })`](https://paseo.sh/docs/plugins/reference.md#reach-a-composer-by-reference)
  addresses existing agents; drafts are not addressable by reference.
- Exact draft identity and attachment therefore need a native extension or a
  newly released equivalent before this flow can ship. Do not infer identity
  from global focus or create a substitute tab. No upstream publication is
  authorized by recording this requirement. Direct activation in an existing
  agent tab has the required identity and can proceed independently.
- Native button descriptors have no split behavior. Prefer native controls
  for the two independent regions in composer/popover content; assess a native
  split component only if those controls cannot satisfy accessibility/placement.

Remove create-time Send/Composer/Later controls and associated dead branches.
Keep the post-reset strategy separate. Eliminate the five-second send fallback
for a user who selected composer staging. A stable staged packet remains pending
until acknowledgement or explicit user action.

For due work, use P1's effective decision to evaluate existing routes and
automatic creation.
Persist creation provenance, the reserved attempt and its receipt using existing
metadata/journals. One pending creation is reconciled before another begins.
Limit failed attempts per recovery generation with durable backoff. Reset times
and changed eligibility can reopen routing. Configuration selects Create, Offer
or Wait through the same backend decision.

Investigate native archive/unarchive and history discoverability before enabling
cleanup. The minimal candidate policy is event-driven reuse and cleanup at work
completion or replacement acceptance. A Factory-created idle standby may become
an archive candidate only after all the following checks.

- It holds no coordination authority or unfinished explicit assignment.
- It has no dependent workers, permission request, staged brief, pending report,
  uncertain operation or reserved delivery.
- Another suitable live steer covers the need it served, and its result has been
  accepted where required.
- Native archival preserves discoverable history, and the candidate remains idle
  through the final scope/runtime recheck.

Existing manual steers keep explicit user lifecycle control. Archival needs an
approved automation policy before effects are enabled. The initial implementation
can present safe candidates while native reversibility is verified. Avoid fixed
standby counts and idle TTLs until actual accumulation demonstrates a need.

Acceptance covers repeated exhaustion/recovery cycles without duplicate creation,
reused standby after quota reset, restart after a lost creation response, stale
receipt to a missing agent, concurrent work arriving before archive, worker
dependency guards, preserved history and explicit manual-steer protection.

## P4 — Native pre-dispatch and causal menu repair

Prepare N2 as a native operation contract covering the queued original prompt,
attachments, options/model, stable message identity and cancellation. The waiting
point must precede provider dispatch, serialize with other sends, and permit
native preparation without recursive interception. Stop, timeout, plugin failure
and daemon restart need explicit recoverable outcomes. Preserve prompt bytes and
attachment identity through successful preparation. Ordinary send with no required
preparation should keep a cheap path.

After N1/N2 are available, connect the shared Factory decision to this gate.
Choose transparent renewal only for eligible work and observed need. The
original user prompt follows preparation once. Retrying an uncertain operation
requires native receipt reconciliation. Keep direct Factory send paths on the
same policy. Upstream review determines the exact typed API. A 30-second waiting
hook only bounds the policy decision. Longer initialization uses the durable
transaction with visible progress, cancellation and an overall deadline. Stop or
timeout preserves the original for recovery. Permission-response messages need
an explicit native path that remains usable while preparation is pending.

Prepare N3 with the original pointer path, state transition and native menu test.
Correct active submenu ancestry/focus styling at its source. Verify moving the
pointer between sibling rows, entering/leaving the submenu, confirmation pages,
keyboard focus and compact/touch interaction. Implementing the simpler handover
popover does not complete this regression's acceptance.

## P5 — Shared UI, onboarding and recovery

Expose the contextual actions from P3 through native components, including
the New-Agent menu before initialization and **Activate Steer** in a standby's
own tab. The split create action has two independent hit targets with separate
accessible names and keyboard focus. No previous-controller model turn is part
of the interaction. Handover uses target
selection plus inline preparation summary and one confirmation. Reset runs
directly under its role/capability guards. Native controls own one-agent model
selection. Use the exact `ListRestart` icon export supported by the client.

Replace the CLI-result panel with the workspace-scoped Overview, Steers,
Resources and Activity projections. Reuse subscriptions, worker register,
checkpoints and quota journals. Scope every result store. Show unknown/stale data
and simultaneous control/runtime/context/quota conditions. Keep diagnostic IDs
behind detail views. Validate desktop, compact layout and keyboard behavior.

Host onboarding happens once. Project enrollment handles empty and existing
workspaces, one steer, adoption and ambiguous titles. GitHub requirements apply
only where the operation needs them. Audit discovery scans and path assumptions
with loader validation.

Consolidate worker wakes, reports and boot/failover recovery on effective policy.
Preserve receipts for each event when combining deliveries. Debounce live worker
follow-ups, support real partial-worker continuation, persist retry generations
and honor boot/drain barriers on every path. Preserve user Stop and permissions.
Surface worker evidence independently of coordinator acceptance. Test these cases
with epoch changes, successor checkpoints and interrupted renewal.

Additional P3/P5 acceptance from the observed failover:

| Scenario | Required result |
| --- | --- |
| Old controller is quota-limited, unresponsive or unable to follow instructions | Activate a standby from its own tab using the newest valid work state; zero old-controller model turns or checkpoint requests. |
| Two uninitialized New-Agent tabs in different workspaces | The menu is present in each; creating changes only the originating draft to its resulting steer. No “ping”, substitute tab or global-focus guess. |
| Change provider, model, thinking, mode and options immediately before clicking | Capture the exact current tuple and preserve it through creation and receipt recovery; no automatic model replacement or host-preference mutation. |
| Click the two regions of Create Steer \| and activate separately | Create-only remains standby with zero prompt dispatches/inference; activation continues work once on the created target. Measure native inference, not just absence of a prompt field. |
| Repeated click, reconnect or crash after creation but before activation | One agent, one reserved operation and creation receipt, one epoch transition and one confirmed continuation; reuse the created agent. |
| Activate an explicit cold/large target while a cheaper standby exists | Prepare the requested target and activate it; no silent substitution. A quota/privacy/role/capability refusal explains why and offers separately selectable alternatives. |
| Concurrent handover/activation, title collision or stale composer/scope revision | Existing holder/epoch/receipt guards admit one consistent operation; preserve workers, assignments and uncertain K7 delivery. |
| Keyboard, touch, narrow layout and accessibility | Each split region has its own focus/action/name; pending and failed creation/activation are visible and resumable. |

Keep automatic-routing eligibility tests separate from explicit-intent tests,
while exercising the same backend functions. Do not make UI acceptance depend
on a model issuing the correct CLI command. Gate exact-draft scenarios on the
verified native capability above; direct existing-tab activation is independent.

## Validation and release gates

Run focused regression checks for each changed contract, then `npm test` and
`npm run typecheck --prefix plugin` before live reload. Keep new tests focused on
the migration, role/authority, concurrency and provider regressions identified
above. Record tests against the final accepted working tree.

For native work, verify against the exact released daemon/client and provider
versions intended for support. Use sanitized scratch agents after authorization.
Each provider passes context/history/model/reset cases independently. For UI,
capture actual clean before/after evidence and reproduce the original hover case.

At a coordinated reload, verify plugin status/logs and run the user quick-start
below. Keep old settings, unresolved receipts and journals readable during
rollback. Gate consumers of new native APIs by actual capability/version.
Registry publication and upstream publication follow their existing approvals.

Passive real-work measurements track accepted-package cost, repeated input,
initialization turns, renewal outcomes and unused quota. Tune routing or idle
compaction when those observations justify a change. Avoid synthetic savings
claims and a new benchmark requirement for independent functional work.

## Quick-start for implementation acceptance

1. Open Factory in an empty local workspace and establish one controlling steer.
2. In a native uninitialized New-Agent tab, use Create Steer. Expect that exact
   tab to become a standby, with no initialization turn or inference. Repeat
   with and activate and expect the created steer to become controlling once.
3. Change that standby's model natively, reset it and inspect history. Expect
   preserved identity/standby role and no coordinator prompt.
4. Assign work to the controller, reset it and hand over to the standby. Repeat
   through Activate Steer from the standby's own tab with the old controller
   unavailable. Expect one continuation and one controller, with the same
   workers/assignments and no extra old-controller turn.
5. Reset an advisor with and without an unfinished question. Expect role-bound
   behavior and unchanged coordination.
6. Send an ordinary prompt through the native dispatch gate with cold context.
   Expect verified preparation followed by the original prompt and attachments.
7. Exercise quota failure and recovery twice. Expect bounded creation/reuse,
   preserved results and safe lifecycle handling.
8. Repeat the original submenu hover interaction and reconnect/restart checks.
   Expect corrected native highlighting and retained history/pending work.

## Next implementation package

Default enrollment now adopts one eligible live coordinator or creates one in
an empty workspace. Explicit enrollment selects a live coordinator letter and
rechecks tab identity, role, authority and worker ownership at apply time.
Saved legacy plans and their receipts remain recoverable. Fresh preserves the
supported live runtime and saves the original creation request for receipt
recovery. A historical receipt without
that request still requires a reconstructable key. Factory delivery and
composer staging hold unverified briefs for restricted targets. Enrollment,
Fresh and brief admission passed the combined suite with isolated test state
and four test processes on 2026-11-26. Following reload, the live model list
and Create Steer preview returned the same settings revision; an unknown
profile was refused. The new enrollment code planned the current live holder
without writes and refused a different initial letter for the enrolled scope.
End-to-end creation and Fresh recovery are still open
for live acceptance.

Create Steer binds confirmation to the settings revision and allocates the
first free letter from live workspace membership. Duplicate titles refuse
allocation. The workspace lock and journal protect concurrent confirmation,
archived-letter reuse and recovery of an uncertain response. The standard
model list and settings show role priorities. Compatibility readers retain the
legacy slots for old plans and selection aliases. Direct P3/P5 activation
from a standby tab checks holder, epoch and admission and reuses the same
continuation action after a lost reply. After reload, the live RPCs returned
the first free letter and refused a stale settings revision and a stale
activation epoch. Steer C verified the combined allocation, receipt recovery
and activation regressions with the full suite and plugin typecheck. Successful
creation and standby activation still need an isolated live workspace.
Exact-draft creation depends on native draft identity and attachment. Z1 recovery
covers durable same-holder replanning. The live move still needs an eligible
account pair and auto-switch.

P5 worker wakes can now reserve a delivery alongside a retained composer brief.
The composer packet keeps its original ID and can still be opened or dismissed.
An unresolved delivery from an older epoch holds only the events bound to its
receipt. New completion events can wake the current holder independently.
Explicit send uses the original stage and epoch. Composer transfer and send
claim the stage exclusively, and an absent composer leaves the packet staged.
After client restart an unresolved transfer requires inspecting the target
draft before confirming insertion or releasing the claim. The native SDK
does not provide a durable composer insertion receipt. Live RPCs refused an
old-epoch send and a replaced stage ID and kept the stored brief. After reload
the pending worker wakes reached the expected busy-controller barrier. When
Steer C ended its turn, the two completion events arrived in one wake. Both
register entries record delivery at `20:56:51.995Z`. The live delivery action
is complete in epoch 19 and the inspect RPC still finds the epoch 17 stage
with its packet stored and no outstanding composer claim.
This covers completions already recorded by Factory. A completion missed during
boot still needs native access to the latest terminal turn ID and outcome bound
to its persisted timeline. Paseo 0.17.4 exposes the outcome as a live event and
does not replay it on restart. An idle snapshot and a terminal-looking assistant
message cannot distinguish a completed turn from a later canceled one.

Workspace Overview and Steers reuse workspace status and the existing live
steer feed. Result and confirmation state are scoped to the host and workspace.
The overview counts queued completion wakes from the worker register, including
workers whose completion closed their work. On Paseo 0.17.4 the live status
RPC reported one queued completion with zero open workers. The desktop web
panel showed that wake and the retained composer brief, and Enter activated
the refresh control. The 390-pixel layout kept the overview and steer list
accessible. Switching workspaces in the same web session kept the first
workspace's result and pending wake out of the second panel. The overview
also rendered with dark mode requested by the browser. Resources and Activity
still need their projections.

Track read-only dispatch receipt recovery with the existing
[Paseo issue #9947](https://github.com/getpaseo/paseo/issues/9947) and
[PR #9548](https://github.com/getpaseo/paseo/pull/9548). Recheck the released
capability before adding a Factory consumer.
