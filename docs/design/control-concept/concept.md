# Workspace Factory control concept

Accepted direction, 2026-11-26, with the user's additions incorporated below.
Detailed delivery and acceptance are in [implementation-plan.md](implementation-plan.md).
Native extension details remain subject to source investigation and live validation.

The proposal follows the [task brief](README.md) and the repository mission. Its
evidence comes from the four accepted research reports. Their source inspection
includes the changing development checkout and Paseo v0.17.4. Runtime behavior,
provider compatibility and cost savings still require validation.

## 1. Product direction

The user manages work through **Create Steer**, **Handover**, **Reset Steer**
and **Open Factory**, with **Activate Steer** on a standby and **Create Steer |
and activate** on a native New-Agent tab. The Factory selects an eligible
execution route, explains its decision and preserves work across provider sessions.
Basic control must work without a model turn, intelligence or remaining quota
from the currently controlling steer.

Paseo owns agents, sessions, workspaces, native model controls and execution.
The Factory owns coordination authority, continuity, quota-aware routing and
automation policy. Existing delivery journals, locks and provider mechanisms
remain the execution foundation. Shared decision logic replaces contradictory
entry-point rules.

The requested default direction is automatic continuation after reset, automatic
steer creation when due work has no suitable holder, and efficiency-led routing.
These defaults become effective through an explicit settings migration or
onboarding choice. Existing installations retain their approved behavior during
migration.

## 2. Identity, roles and model preferences

| Dimension | Authority and proposed behavior |
| --- | --- |
| Identity | Live `Steer X` title in the main workspace, resolved to one eligible holder. Letters express identity. |
| Control | Scope metadata and epoch identify the controlling holder. Duplicate titles suspend affected control operations until resolved. |
| Role | Explicit steer, worker or advisor classification. Advisor restrictions survive model changes. |
| Privacy | Effective scope/task restrictions and route classification. Unknown scope publicity excludes sensitive routes. |
| Execution | Actual provider, model, account, thinking, speed, mode and session read from Paseo and available account integration. |
| Preferences | Host-wide desired model choices and role-specific priorities used for creation and routing. |
| Context | Size, session baseline and estimated cache warmth, each carrying freshness or unknown status. |

Remove configured slot inventories, `prepare`, `initialActive`, slot-to-profile
bindings, letter-derived fallback order and automatic profile alignment. Allocate
a free letter from live membership at creation. One steer is a complete setup.

Keep named model presets where they provide reusable creation defaults. Presets
reference native provider/model options and carry Factory route classification.
Maintain separate steer, worker and advisor priorities. Native model controls
remain the way to change one agent. A local change or one-run creation override
leaves host preferences intact. Only an explicit settings save changes preferences.

A one-run request can constrain the selected model. Eligibility checks still
apply, and an unavailable explicit choice produces a reason and alternatives.
Model preference alone grants neither advisor permission nor permission to share
private material. Sensitive steers receive the same scope/privacy admission as
sensitive workers. A native change to an incompatible provider makes the route
ineligible for further Factory delivery until resolved.

Evaluate the live destination and the provenance of the payload separately.
Factory checkpoints, timeline excerpts, worker and assignment state, and quota
identity can mix sources. A shared provider or a public repository does not
establish that these packets are safe to share. Sensitive routes require
verified public scope visibility and explicitly eligible technical content.
Advisor routes also require eligible technical context. Hold a packet when its
provenance cannot establish eligibility. Recheck the restriction on dispatch,
composer staging, and rerouting. A confirmed receipt can settle without a send.

Existing model-quality requirements remain hard constraints. The proposed
`mechanical | bounded | open` worker tiers in TODO.md are a separate pending
decision. This redesign can consume an approved task requirement without adding
another model taxonomy.

Evidence and affected paths are in [settings research](research-settings.md).

## 3. Host settings and one effective policy

Use the plugin's host settings as the configuration source. Scope metadata stores
operational state, work and explicit assignment constraints. Host setup is reused
by every project. The proposed settings navigation has six flat sections.

| Section | Content |
| --- | --- |
| Host & Projects | Host readiness, optional GitHub defaults, known project enrollment. |
| Models & Routing | Named presets, priorities for each role, task constraints and efficiency/preference balance. |
| Context & Recovery | History preference, reset behavior, cache estimates and justified idle maintenance. |
| Automation | After-reset behavior, no-suitable-steer behavior, interruption recovery and initialization. |
| Quota | One warning/exhaustion policy, sampling and freshness, account/reset details. |
| Chat & Display | Pill detail, checkpoint presentation and activity display. |

Retain the existing 93% warning and 95% exhaustion defaults initially. Enforce
warning at or below exhaustion. Every routing, renewal, cleanup, preview and
display path reads the same effective thresholds and freshness rule. The existing
two-sample-interval freshness rule is the proposed starting point. Provider hard
limits and explicit reset times remain separate observations.

Stale or unavailable usage is displayed as unknown. Refresh native quota data
when an otherwise due operation needs it. A known hard limit blocks the affected
route. Unknown usage alone can permit ordinary continuation if no contrary limit
exists. Quota-consuming maintenance such as compaction requires demonstrated
headroom. Revalidate the actual selected account at execution.

The current **Maximum efficiency / Balanced / Comfort** setting controls cleanup
timing and also affects a Factory model editor. Replace the broad implication
with an explicit **Idle context maintenance** setting. Put routing's
**Efficiency / Balanced / Preference** choice under Models & Routing. Preserve
existing cleanup timing on migration. Evaluate duplicate Factory/native
compaction using passive measurements before selecting provider defaults.

Implement one effective-policy calculation by reusing the existing profile,
admission and context projections. Its result identifies the eligible route,
reason, required preparation, estimated context effect, settings revision and
observations used. UI previews, slash commands, CLI, worker briefs, creation,
renewal and supervision consume this result. Execution rechecks changing facts
under the existing guards. This calculation stays specific to Factory decisions.

## 4. Efficient routing

Evaluate candidates in this sequence.

1. Resolve current authority, unique holder, scope, pending operations and task.
2. Apply role, privacy, capability, permission, availability and hard-limit rules.
3. Compare continuing as-is, moving the same steer to another account, handing
   over, renewing context and creating a steer. Use actual account quota,
   reset windows, provider context, estimated cache warmth, initialization
   effort, recent errors and model preference. Renewal can be preparation on
   an eligible route. A fresh session on the same exhausted account still
   needs an eligible quota route.
4. Select preparation and delivery, then validate the decision at execution.

Efficiency mode favors reuse of suitable warm context and available quota when
the observations justify it. Preference mode gives configured model order greater
weight within eligible routes. Balanced combines the two. Every mode preserves
task-quality and privacy requirements.

Use deterministic comparisons and publish the deciding reasons. Begin with
observable priorities and confidence labels. Introduce numeric cost weights only
when measurements support them. Cache TTL indicates estimated warmth. Provider
quota percentages describe their own account/window and cannot serve as a common
currency across providers.

A ZeroSub move may preserve the steer and resume its provider session under
different credentials. Context continuity and cache reuse are separate
observations. Treat destination cache warmth as unknown until measured.
Explicit user pins constrain routing. An automatic binding remains eligible
for a native move, ranked by the same criteria as the other options.

Automatic selection and explicit user selection are distinct inputs to this
same policy. An explicitly activated steer or chosen model is a constraint,
not a preference rank. Apply eligibility, quota, privacy, role and consistency
checks, and choose the appropriate preparation on that target. Never activate
a cheaper substitute silently. If the requested route is unavailable, explain
why and offer eligible alternatives for a separate user choice.

Warnings update the UI. Failover or renewal runs when useful work is due. Passive
metrics track accepted-package cost, turns, cached/uncached input, failed attempts,
rework and recovery latency with unknown usage identified. The existing
[measurement design](../efficiency-metrics.md) supplies the baseline. Savings
claims await comparable evidence.

## 5. Reset Steer

**Reset Steer** acts on the current tab and directly starts the permitted reset
operation. Use the native Lucide export `ListRestart`. Running, permission-pending
or unresolved operations show a specific unavailable reason and keep reset from
racing the current turn.

At invocation, capture the mounted native composer's selected model/options and
the agent, scope, epoch and settings revision. Reconcile these with the server's
live tuple, capability and account admission. A concurrent selection change
invalidates the operation before reset. Reconstruct the latest valid work state
from authoritative checkpoints and worker records. Explicit reset opens a fresh
provider session under the same Paseo agent ID. The new session receives its
regular launch instructions and any eligible continuation packet. Past chat
messages remain in Paseo's timeline according to the user's history setting.

Preserve agent identity, current control, worker ownership and worktree files.
Resolve role, authority and work ownership before constructing the continuation
packet.

| Reset target | Continuation eligibility |
| --- | --- |
| Controlling steer | May continue verified open work assigned to its current authority. Completed, absent or conflicting work leaves it idle. |
| Standby steer | Keeps standby status. May continue only its own explicit open assignment. The scope's coordinator task cannot initialize parallel coordination. |
| Advisor | Keeps read-only advisor status. May continue only its own unfinished explicit question. Scope coordination and worker supervision stay with the controlling steer. |

Reset itself preserves the epoch and controlling holder. Recheck authority and
assignment revision before sending, because handover or task completion can
occur during renewal. A stale continuation is held for reconciliation. Follow
the configured behavior only for eligible assigned work after verified reset.

| After reset | Behavior |
| --- | --- |
| Continue automatically | Send one bounded, role-specific packet for eligible open work through shared delivery. Accepted default. |
| Put brief in composer | Stage the eligible assignment's packet for the destination composer and keep it available until acknowledged. |
| Wait | Keep the valid work state and show that work is waiting for an explicit continuation. |

The composer choice must remain staged if the destination is unavailable. Remove
the current five-second automatic-send fallback for this explicit preference.
Use a stable stage identity and acknowledgement to reconcile insertion and prevent
automatic delivery of a packet already staged. A crash between insertion and
acknowledgement needs reconciliation through native draft support or an explicit
pending state.

### History and provider limits

The requested combination of context reset and optional full chat retention has
an unresolved native dependency. Paseo v0.17.4 rebuilds the timeline after rewind.
Rewinding to an anchor may remove later visible messages and can retain earlier
context. Source evidence supports conversation rewind for Claude and Codex.
The inspected Copilot, Muse and Antigravity contracts lack that route.

Preserving visible history is the accepted initial preference.
A direct reset is enabled only when its verified effect is covered by the user's
history preference. The menu/tooltip explains the effect in advance. If native
capabilities cannot satisfy it, show the specific limitation and an explicit
**Create Steer** alternative. A replacement requires a separate user action.
An uncertain reset outcome remains visible for recovery.

Validate that the new session uses the selected model and that retained chat
rows stay visible across reconnect and restart without being sent to the
provider. The user approved the generic native session and timeline contract on
2026-11-26. Earlier Codex guidance proposed rewind as a way to keep the same tab.
The accepted contract uses each provider's native session creation path.
Temporary unavailability on older versions is a compatibility state.
[Native reset research](research-native-reset.md)

Provider details and evidence are in [lifecycle research](research-lifecycle.md).

## 6. Handover, Activate Steer and Create Steer

**Handover** is enabled on the controlling tab. It opens one popover containing
eligible target selection and an inline confirmation area. After selecting a
target, show **Reuse context**, **Renew context**, or a concrete blocking reason,
then one **Handover** button. This uses native popover content and avoids the
current third menu level. Advisors, retired tabs, ambiguous holders and self
are excluded. Temporary blockers can be explained in Factory's Steers view.

The server decides target preparation from the same policy used by recovery.
Reuse suitable warm context. Renew cold, oversized or incompatible context when
the permitted native route supports it. Otherwise show a blocked target or an
explicit creation alternative. Preserve workers and use the newest verified
checkpoint. Normal handover sends no additional request to the previous steer.

**Activate Steer** appears in an existing standby's own tab and transfers
authority to that exact steer. It requires neither opening the previous tab
nor asking that model for a handover. Handover chooses another steer;
activation chooses the current tab; creation with activation chooses the new
steer. All three use the same backend authority transition, context preparation
and continuation operation. Use the newest valid work state, workers and
assignments; no extra model turn or newly written checkpoint from the previous
steer is required. Existing Stop, permission and busy-operation rules remain.

Preflight preparation, history effect and admission before committing control.
Keep the existing guarded authority transition with durable delivery intent.
After the epoch changes, failures show the new controlling steer with pending
delivery and recover that intent. A failed delivery cannot safely imply an
automatic authority rollback. Reconcile uncertain sends before any retargeting.

In an uninitialized native New-Agent tab, the menu offers a horizontal split
action **Create Steer | and activate** instead of Reset Steer. Both regions
are independently actionable. **Create Steer** creates a standby in that exact
tab from the native composer's current provider, model, thinking, mode and
options. Allocate a free title-based letter, preserve host preferences and
send no prompt or initialization turn. **and activate** performs the same
creation and transfers active authority to that steer. No preliminary “ping”
is needed. Capture the selection at click time and bind it to the reviewed
request; neither routing preference nor a later composer change can replace it.

Creation with activation is one resumable Factory operation. Persist the
operation and creation receipt before effects. If creation succeeds but the
authority transition or continuation is interrupted, reconcile and reuse that
agent. Never create another agent, replay an uncertain send to a different
target, or roll authority back implicitly. Native draft identity and exact-tab
attachment are capability gates; the [implementation plan](implementation-plan.md#p3--simplify-creation-handover-and-managed-steer-lifecycle)
records the current API gap. Creating a different tab or sending “ping” is not
an equivalent fallback.

Automatic creation is triggered by due work and no suitable existing steer.
It uses the same creation receipt and authority path. Reconcile actual account,
request fingerprint and live resource before retrying. A missing resource behind
an old receipt needs repair before that receipt can establish success.

Prefer reuse of eligible existing steers before creation. Track Factory-created
provenance so automatic cleanup can be restricted to those agents. Reevaluate
redundant idle standbys when work completes or a replacement becomes usable.
Native archival is a candidate only after proving that the agent holds no
authority, open assignment, dependent worker, permission, staged brief or pending
delivery. Recheck these conditions at execution and keep archived history
discoverable. Manual steers and unresolved operations require explicit handling.
The lifecycle policy belongs with automatic creation and should avoid additional
TTL, pool-size and per-provider configuration knobs unless evidence needs them.

## 7. Menu, pill and reactive Factory view

The controlling-tab menu contains **Create Steer**, **Handover**, **Reset Steer**
and **Open Factory**. A standby offers **Activate Steer**; a native New-Agent
tab replaces reset with **Create Steer | and activate**. Replace Resume/Refresh
and remove Change Settings. Surface
pending recovery through status and contextual actions inside Factory. A one-agent
model change is performed through native controls.

The observed sticky submenu highlight originates in Paseo's active-row styling.
Reproduce and address active ancestry versus pointer/focus highlighting in the
native menu. Acceptance covers the original submenu interaction as well as the
new handover popover. Keyboard focus, touch and accessibility must work through
native components. Source evidence is in [UI research](research-ui.md).

Keep orthogonal state dimensions in the server projection. A pill combines
letter/control marker with the most actionable condition, prioritizing blocked
delivery/permission/limit, recovery, runtime and context. Tooltip and Factory show
simultaneous conditions. Unknown data and ambiguous membership get distinct
labels. Replace user-facing **needs resume** with a concrete recovery description
such as **Interrupted**, **Waiting to continue** or **Delivery pending**.

Factory opens the current workspace's scope automatically. An unenrolled
workspace shows **Set up Factory here**. Related hub/domain navigation is
secondary and preserves workspace identity. Results and subscriptions are scoped
to the workspace, replacing the module-global last-result display.

| View | Useful content |
| --- | --- |
| Overview | Controlling steer, task/next step, checkpoint confidence, tests/blockers, workers, pending work and effective automation. |
| Steers | Live holders, role, model/account, runtime, context size, estimated cache state, quota eligibility and actions. |
| Resources | Provider/account windows, used quota, resets, freshness, eligible models, alternatives and exclusion reasons. |
| Activity | Handovers, renewal outcomes, recovery, creation, pending deliveries and their decision reasons. |

Reuse existing feeds, checkpoints, quota projections and journals. Add bounded
structured events only where existing records lack a necessary transition.
Activity omits prompt bodies and credentials. Account labels are user-facing
aliases. UUIDs, epochs and fingerprints belong in expandable diagnostics.
Disconnected views retain their last observation with explicit staleness.

## 8. Onboarding and commands

Host onboarding checks native providers, optional account integration, model
preferences, privacy boundaries and automation defaults once. Existing settings
populate the review. Project onboarding detects the current workspace, resolves
existing titled agents, offers adoption or creation and establishes one holder.
An empty workspace and an existing single-steer workspace are both entry points.

GitHub owner and checkout-root settings become prerequisites only for operations
that use them. Existing local/workspace enrollment derives its root from its
locator. Audit scanner and discovery assumptions together with loader validation.

The packaged CLI stays available to agents and scripts through plugin RPC.
Slash commands use the same operations and previews as the UI. Add the simple
reset vocabulary, migrate help and retain required compatibility aliases for
existing callers with explicit semantics. Read-only brief inspection remains
available. Each brief names the actual scope's runnable status command.

## 9. Recovery and consistency

Keep unique-holder checks, locks, epochs, guarded previews, creation receipts,
stable message IDs and persistent per-event delivery state. Revalidate actual
runtime/account and authority before each effect. Native acceptance and completed
processing remain separate observations.

Persist failover progress against scope, epoch and source holder. Try each
eligible candidate within a bounded attempt generation and back off after
exhaustion. Reevaluate on meaningful state changes, account reset or explicit
request. Automatic creation uses one reserved attempt and reconciles lost
responses before another create. Its retry policy must survive daemon restart.

Combine already-ready worker events and assignment reports into bounded delivery
when safe. Each source event retains its own receipt and processing status.
Worker results survive steer replacement. Partial idle workers need an explicit
continuation route consistent with their actual status. Debounce interruption
events against live worker state so an already-running follow-up avoids a
redundant steer wake.

Boot recovery retries bounded transient failures and records per-scope progress.
Every delivery path observes drain and boot barriers. A failed scan leaves
affected scopes visibly pending. User Stop pauses the affected work until a clear
continuation request. Ambiguous cancellation records a paused interruption.
Provider failures can use configured automatic recovery. A proven quota failure
must allow due work to trigger eligible takeover without another provider turn
from the exhausted controller. Preserve one controller, workers and report
receipts through that transition, or keep the work durably waiting for capacity.

Checkpoint confidence uses authority/continuation lineage, revision, timestamp
and available Git evidence. A successor's valid checkpoint can supersede its
origin's state. Late results cannot overwrite a newer holder's task. Completed
worker evidence updates the worker record and remains distinct from steer
acceptance. Missing or conflicting task state requires review before automatic
work continuation.

Ordinary composer Send currently lacks a native pre-dispatch gate. The Factory
can apply this policy to its own deliveries. Read-only acceptance receipt lookup
after an epoch change, draft acknowledgement and some provider/history behavior
are additional native dependencies. Preserve unresolved operations visibly until
they can be reconciled. See [automation research](research-automation.md).

The reviewed [dispatch research](research-native-dispatch-menu.md) proposes a
host-owned durable pre-dispatch transaction for transparent renewal before the
next user prompt. Paseo should retain the original prompt,
attachments, model options and delivery identity while the Factory decides
whether preparation is needed. Renewal, cancellation and dispatch need native
queue ordering and recoverable results. A Factory UI send wrapper would leave
other native send paths uncovered. Native extension work is a separate delivery
dependency with its own approval and acceptance.

## 10. Migration and delivery sequence

Proceed in reviewable stages after concept agreement.

1. Consolidate effective settings and quota admission. Preserve configured role,
   privacy and account rules. Bring briefs and previews onto the same resolver.
2. Separate live identity and route preferences. Convert slot bindings into
   role priorities, preserving order and deduplicating equivalent routes. Review
   ambiguous advisor/privacy classification. Preserve running agent tuples and
   ownership through migration.
3. Implement explicit reset and handover contracts with provider evidence.
   Simplify the menu and scoped staging, then align slash/CLI entry points.
4. Build the reactive workspace view and two-stage onboarding from shared data.
5. Enable approved recovery/auto-create policy with persistent attempt state.
   Evaluate idle compaction and routing weights from passive production data.

Version settings migrations, retain prior settings for reversible recovery, and
reject revision conflicts. If duplicated quota objects disagree, require a
one-time choice before affected automatic actions. Existing installations keep
their current history and automation choices until reviewed. New installs use
the agreed defaults. Preserve pending deliveries and creation keys through the
transition. A changed request digest needs versioned compatibility and receipt
reconciliation. Coordinate plugin reloads at package boundaries because the
development checkout serves all live Factory agents.

Proposed TODO consolidation after approval joins slot/configuration work,
reset/menu work, quota consistency and relevant recovery findings into these
stages. Native compaction stays measurement-dependent. The existing advisor
matrix and upstream/provider work keep their own acceptance requirements.

## 11. Acceptance and discussion walkthrough

For concept review, follow these cases from the current workspace's pill to
Factory. They are the implementation acceptance scenarios.

| Case | Expected result |
| --- | --- |
| Fresh host/local workspace | Setup works without GitHub defaults and establishes one controlling steer. |
| Change native model | Only that agent changes. Reset uses its verified selected model or reports a limitation. |
| Supported reset | Same tab/control/workers, verified renewal, chosen history effect, one continuation or staged brief. |
| Unsupported/history conflict | Specific reason and explicit alternative before a destructive effect. |
| Warm and cold handover | One confirmation with correct preparation, workers preserved and one bounded delivery. |
| Limit with due worker result | Account-aware admission, bounded failover/creation and preserved result. |
| Restart during delivery | Pending action reconciled against receipts and current epoch. |
| Stop or permission request | Work stays paused/blocked until the corresponding condition is resolved. |
| Duplicate title or stale checkpoint | Ambiguity/confidence shown and unsafe automatic continuation held. |
| Two workspace panels | Each shows its own work, freshness and pending actions. |

Required implementation checks cover settings migration/revision conflicts,
quota freshness/account selection, provider reset effects and model capture,
keyboard/touch interaction, stage acknowledgement, worker recovery, boot/drain,
epoch races, uncertain sends and creation receipts. Run the repository test suite
and plugin typecheck for code changes. This phase used document/source evidence.
Live reset, UI and provider tests are still pending.

## 12. Accepted decisions and planning additions

The user accepted the direction and the three proposed decisions on 2026-11-26.
Automatic continuation, automatic failover creation and efficiency remain
configurable defaults.

1. **Reset and history.** Preserve visible history by default and clear it only
   when the history setting requests it. Renew provider context in the same tab
   through the generic native session and timeline contract. Verify support per
   provider before enabling it.
2. **Creation and initialization.** Recommended manual creation makes a standby,
   with optional Start work here. Handover continues automatically after its
   confirmation. The configured post-reset behavior remains independent.
3. **Automatic creation boundary.** Recommended host opt-in, shown at project
   enrollment, uses eligible configured routes, one in-flight creation and bounded
   durable retries. A project may pause automation. Automatic creation stays
   within approved role/privacy/model constraints. Investigate reuse and safe
   archival as part of this lifecycle.

Planning also covers role-specific reset ownership, native pre-dispatch and a
causal native hover correction. Create-time initialization options can be removed
with promptless standby creation. Keep configuration shallow and consolidate
overlapping mechanisms. Implementation is authorized, starting with P0 and early
native runtime validation. Production rollout and upstream publication follow
their respective work packages.
