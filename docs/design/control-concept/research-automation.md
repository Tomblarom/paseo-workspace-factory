# Automation, recovery and efficiency: research

Scope: read-only investigation of the current working tree, including uncommitted changes, on 2026-11-26.
`V` means verified in code/docs by inspection, not a live runtime test. `D` means a documented decision, observation or proposed design.
`I` means inference or option, not demonstrated behavior. Line references refer
to this changing checkout; recheck them before implementation.

## 1. Current state

### Authority and continuity

- **V** A scope has workspace metadata for active slot, epoch, checkpoint, per-agent actions and worker register.
  The workspace lock is cooperative and host-local, not an authentication or cross-host lock.
  The inode is verified before writes; it does not exclude arbitrary Paseo/UI writes
  (`plugin/server/core/lock.mjs:1-12,30-75`).
- **D/V** Membership is a live parentless `Steer X` title in the scope main workspace;
  optional active marker/suffix is not authority. Multiple live holders or multiple continuations are ambiguous,
  not newest-wins. Continuations may inherit the origin's title; archive frees membership
  (`docs/design/slots-live-design.md:17-30`,
  `plugin/server/core/discovery.mjs:285-317`).
- **V** `scopeHolder` requires exactly one eligible holder; `guardScope` rereads scope/epoch,
  active slot, holder ID and retirement/advisor state under lock
  (`plugin/server/core/scope-guard.mjs:11-54`). Title-to-label reconciliation
  lets label-based paths find newly titled steers, but can lag or fail
  (`plugin/server/steer-title-labels.ts:1-30`).
- **V** Only a valid active-steer CHECKPOINT becomes scope state; other agents get notes.
  Failed turns retain prior task/next with interruption evidence.
  Resume warns rather than reconstructing unknown intent; first-turn failure
  can leave no task (`docs/design/cold-context-resume.md:27-78`,
  `docs/design/quota-independence.md:54-76`).
- **V** Resume's preview can bind agent status, session and checkpoint timestamp; execution checks current authority.
  Worker resume is restricted to interrupted workers, even though a partial worker may also need continuation
  (`plugin/server/resume-apply.ts:44-65,185-237`).

### Supervision, restart and delivery

- **D/V** Workers belong to the scope, not the starting steer. Their register records state, assignment and wake bookkeeping;
  turn-end parses CHECKPOINT, queues actionable changes before delivery, and backfills missing registered workers
  (`docs/design/supervision-design.md:32-62`,
  `plugin/server/supervise.ts:780-905`).
- **V** Wake resolves the current holder at dispatch, refuses busy/unavailable targets, filters stale events and checks quota;
  events remain queued on failure.
  Workers are debounced and grouped, not woken periodically for no news
  (`plugin/server/supervise.ts:585-684,1013-1050`).
- **V** The 10-second fallback scans pending deliveries/reports; an independent configurable watchdog reconciles restart marks,
  removes archived workers and conditionally marks idle running workers stale, then checks failover.
  Stale events are rechecked against live state (`plugin/server/supervise.ts:1053-1079,
  1505-1624,1642-1685`, `plugin/server/worker-wakes.ts:5-21`).
- **V** Drain waits for running Factory agents, suppresses supervision via per-scope markers, and on timeout records planned interruptions.
  It does not restart the daemon. Markers clear in `finally` or expire after timeout plus one minute; queued work can then be delivered
  (`plugin/server/core/drain.mjs:1-7,177-253`).
- **V** Boot is triggered lazily by the first available Paseo handle. It marks pre-restart open turns and eligible steers,
  then supervision reconciles interrupted workers and tries combined wakes
  (`plugin/index.server.ts:147-171,239-245`,
  `plugin/server/boot-check.ts:340-404`,
  `plugin/server/supervise.ts:1099-1202`).
- **V** Failed boot is not retried: `checked` is set before the scan and the error returns an empty result;
  the post-boot chain still runs. Turn hooks now retry `LockBusy` for up to two seconds, unlike the historical finding's second claim
  (`plugin/server/boot-check.ts:456-474`,
  `plugin/server/turn-hook.ts:176-195`,
  `plugin/server/supervise.ts:220-243`).
- **V** `deliverSteer` covers Factory wake, takeover, switch and steer resume, combining cache/context projection with send,
  verified clear or rewind. One durable per-target action carries epoch, packet and optional event batch;
  renewal, send and recovery recheck busy state and quota
  (`plugin/server/steer-delivery.ts:691-761,799-889`).
- **V** Before a send, the action is persisted as uncertain with stable message ID.
  Exact replay may reconcile against Paseo's receipt while authority is current;
  an attempted packet cannot simply be retargeted after an epoch change
  (`plugin/server/core/steer-action.mjs:1-2,29-79`).
- **V** K7 creates a deterministic report action on a completed active-steer `done`/`blocked` checkpoint,
  stores source text before dispatch, and retries from the sweep. The current tree groups already-pending reports
  for one target and epoch, up to 6000 characters, preserving source/action pairs; it does not delay a report deliberately
  (`plugin/shared/assignment-report.ts:55-104`,
  `plugin/server/turn-hook.ts:224-278`,
  `plugin/server/steer-delivery.ts:306-411`,
  `plugin/server/supervise.ts:1053-1066`).
- **V** Unattempted K7 deliveries can be released and rebound; attempted, renewing or uncertain actions stay blocked for reconciliation.
  A non-Factory requester is currently rejected. `reportedAt` means accepted delivery, not successful processing by the recipient
  (`plugin/server/steer-delivery.ts:203-221,229-237,271-302,415-475,651-675`).

### Quota, routing and efficiency

- **V** `resolveProfile` chooses a startable profile with role, public-repo privacy, catalog, health and quota checks;
  ZeroSub can pin the roomiest usable account in creation metadata. Worker creation guards authority and hashes its assignment into a stable key
  (`plugin/server/core/models.mjs:138-212`,
  `plugin/server/core/workers.mjs:14-47`).
- **V** The in-progress `steerQuotaAdmission` checks actual agent/account first, freshness, model windows, pool fallback and persisted provider limits;
  unknown quota is generally fail-soft. It is called by wake, report reservation, `deliverSteer`, retry/send and failover candidate checks
  (`plugin/server/steer-admission.ts:13-67`,
  `plugin/server/supervise.ts:612-639,1417-1436`,
  `plugin/server/steer-delivery.ts:306-319,629-636,691-715`).
- **V** Failover gives ZeroSub continuations and in-place moves first chance, checks the epoch again, ranks existing candidates,
  sends a takeover request and expects the candidate to perform the guarded switch. Known reset can defer work
  (`plugin/server/supervise.ts:1301-1404,1405-1480`).
- **V** Failover attempts are process-memory state keyed by scope and active slot; after candidates are exhausted the list cycles.
  A restart loses this history, and epoch is not its key
  (`plugin/server/supervise.ts:1405-1416,1273-1288`).
- **D** 93% warning is informational; 95% exhaustion applies at an otherwise due delivery, never as a standalone warning/handover turn.
  These defaults are pragmatic, not empirically tuned (`docs/design/quota-independence.md:247-266`).
- **D/V** Cache TTL and warmth are projections, not measured hits. Delivery uses a fixed context-size floor,
  while cleanup may compact only with proven headroom; idle, quota and session observations can be unknown
  (`docs/design/cold-context-resume.md:95-137,171-201`).
- **D** Measured initialization example: 41.3k initial context, 13 requests before first question,
  about 0.93M input tokens including 865k cache reads; this is one baseline, not a savings estimate
  (`docs/design/efficiency-metrics.md:224-233`).
- **D** The intended headline is list-price-equivalent cost per independently accepted package, including failed attempts.
  Current per-agent last-usage snapshots omit or conflate relevant requests/cache writes; no complete paired savings result is established.
  The proposed ten-pair/provider benchmark, real-reset sampling and usage reconciliation remain future work
  (`docs/design/efficiency-metrics.md:3-31,47-57,73-102,123-187,199-222`,
  `TODO.md:29-30`).

## 2. Contradictions, redundancies and gaps

- **V** There is no single effective-policy function for all decisions. Shared pieces exist: profile selection (`models.mjs:140-212`),
  quota admission (`steer-admission.ts:13-67`), failover order (`supervision.mjs:376-420`) and cache projection/delivery (`steer-delivery.ts:740-761`).
  They consume different snapshots and answer different questions. The worker brief calls `resolveProfile` without quota/ZeroSub while RPC pick passes ZeroSub;
  plain run flags do not contain the account pin
  (`plugin/server/core/models.mjs:329-363`,
  `plugin/server/handlers.ts:1257-1262`).
- **V** P0 text describes missing common admission and K7 grouping, but the dirty working tree already contains partial implementations.
  Do not treat either the design's historical gaps or these unvalidated changes as final behavior (`docs/design/quota-independence.md:268-315`,
  `plugin/server/steer-admission.ts:13-67`,
  `plugin/server/steer-delivery.ts:321-411`).
- **V** Slot design after its title decision still contains older claims that labels/holder generations determine occupancy
  and superseded holders cannot reclaim it; the document itself says supersession text predates the decision
  (`docs/design/slots-live-design.md:17-30,46-50,60-90`).
- **V** Failover ranks by slot/pool/account, not cache cost; loop protection is volatile and deliberately cycles.
  `failoverChain` deduplicates by slot, so routing must not mistake that for the unique-holder ambiguity check
  (`plugin/server/core/supervision.mjs:376-420`,
  `plugin/server/supervise.ts:1405-1416`).
- **V** `steer add` has a preview fingerprint and creation receipt, but its
  fingerprint input omits the selected account, while the create key deliberately
  omits the account metadata too. A changed pin is therefore not bound by that
  fingerprint; verify receipt/request behavior before promising automatic
  account reselection (`plugin/server/core/steer-add.mjs:296-316,393-438`,
  `plugin/server/core/steer-create.mjs:44-69`).
- **V** Exact creation keys and receipts avoid many duplicate creates; general
  apply journals attempted operations and refuses unknown/contradictory results.
  However `steer add`'s matching-occupant fallback explicitly does not adjudicate
  workspace/parent, and an old receipt pointing to a removed resource is an open
  observation (`plugin/server/core/apply.mjs:48-74,253-271`,
  `plugin/server/core/steer-add.mjs:441-485`, `FINDINGS.md:21`).
- **I** Boot scan and open-turn notifications are asynchronous; the early
  once-flag plus a failed scan can let post-boot processing proceed without
  complete recovery. Retry must be bounded and preserve per-scope progress, not
  merely rerun successful sends (`plugin/index.server.ts:159-170,239-245`,
  `plugin/server/boot-check.ts:456-474`).
- **V** Supervision's old design says closed workers are never ignored, while
  watchdog *backfill* skips closed agents; already-registered closed workers
  remain represented. This is a narrower distinction than the prose suggests
  (`docs/design/supervision-design.md:19,72-74`,
  `plugin/server/supervise.ts:1524-1533`).
- **I** Separate report dispatch in `flushAllScopes` runs before `flushScope`'s
  drain/boot checks. Inspect and test this path before claiming all K7 deliveries
  are quiet during drain or boot (`plugin/server/supervise.ts:1018-1026,
  1053-1066`).

### Open FINDINGS mapping

Each row cites the observation, not an independently reproduced incident. `Yes` means the redesign could address it only if explicitly implemented;
`partial` means related but insufficient; `no` means outside this redesign.

| Finding | Mechanism / likely redesign effect |
| --- | --- |
| `FINDINGS.md:9` | Duplicate holder projection; **partial**: current dirty `scopes-view.mjs:32-36` now refuses ambiguity, verify all surfaces. |
| `FINDINGS.md:10` | Reserved K7 / non-Factory requester; **partial**: unattempted rebinding exists, uncertain and non-Factory still need policy. |
| `FINDINGS.md:11` | Contradictory findings instructions; **no**: brief/role precedence. |
| `FINDINGS.md:12` | Obsolete action labels; **partial**: unified reset UX needs doc alignment. |
| `FINDINGS.md:13` | Drain caller prevents its own restart; **partial**: native post-drain execution needs separate authorization. |
| `FINDINGS.md:14` | Boot lock failure; **partial**: turn-hook retry now exists, boot once failure persists. |
| `FINDINGS.md:15` | Time-dependent quota fixture; **no**: test clock maintenance. |
| `FINDINGS.md:16` | Timing flakes; **no**: deterministic tests and load isolation. |
| `FINDINGS.md:17` | Private scope creates sensitive-provider steer; **yes** only with scope privacy eligibility before provisioning. |
| `FINDINGS.md:18` | Initial active title marker; **partial**: title and authority projections must agree. |
| `FINDINGS.md:19` | Test import hook order; **no**: test infrastructure. |
| `FINDINGS.md:20` | GitHub CLI PR editing; **no**: handbook/tool issue. |
| `FINDINGS.md:21` | Stale creation receipt after deletion; **yes** with live receipt/resource reconciliation. |
| `FINDINGS.md:22` | Partial workers cause costly continuation; **partial**: smaller packages/coalescing or guarded policy, not blind auto-continue. |
| `FINDINGS.md:23` | Order-sensitive request digest; **partial**: canonical versioned keys plus migration/reconciliation. |
| `FINDINGS.md:24` | Large cached contexts and tool output; **partial**: measured renewal and native limits, not assumed savings. |
| `FINDINGS.md:25` | Inferred vs persisted state in migration; **no** unless export/migration is redesigned. |
| `FINDINGS.md:26` | Worker exhausts weekly quota mid-task; **partial**: route eligibility and package sizing cannot guarantee completion. |
| `FINDINGS.md:27` | Scratch `--cwd` workspace semantics; **no**: native CLI usage. |
| `FINDINGS.md:28` | Old source checkout vs installed daemon; **no**: evidence/version hygiene. |
| `FINDINGS.md:29` | Codex generated schema coverage; **no**: provider evidence method. |
| `FINDINGS.md:30` | Inefficient reading brief; **no**: brief preparation. |
| `FINDINGS.md:31` | Codex response schema omits config option; **no**: verify versioned native schema. |
| `FINDINGS.md:32` | Follow-up races interrupted-worker wake; **yes** with live-state debounce/revalidation. |
| `FINDINGS.md:33` | Assigned hunks depend on dirty base; **no**: assignment/commit planning. |
| `FINDINGS.md:34` | Continuation report does not update stale scope checkpoint; **yes** with verified successor checkpoint reconciliation. |
| `FINDINGS.md:35` | Generic status command uses wrong scope; **yes** with scope-specific brief. |
| `FINDINGS.md:36` | Successor checkpoint not reflected after account switch; **yes** with continuation authority and revision checks. |
| `FINDINGS.md:37` | Empty-workspace onboarding; **yes** if bootstrap admits a verified existing workspace. |
| `FINDINGS.md:38` | Old checkpoint after later external changes; **partial**: freshness/evidence warning; no automatic assumption of current task. |
| `FINDINGS.md:39` | Global worker pick overrides task wish; **yes** with explicit one-run compatible choice. |
| `FINDINGS.md:40` | Wake stuck following failed failover; **yes** with durable pending state and bounded candidate progression. |
| `FINDINGS.md:41` | Partial worker resume rejected; **yes** with consistent eligible-state and continuation rules. |
| `FINDINGS.md:42` | Uncertain K7 after epoch change; **partial**: preserve pending; native read-only acceptance receipt needed for safe rebinding. |
| `FINDINGS.md:43` | Directory scope status command mismatch; **yes** with actual scope in brief. |
| `FINDINGS.md:44` | Worker completion vs stale steer checkpoint; **partial**: surface verified worker result, never invent a steer decision. |
| `FINDINGS.md:45` | Unregistered titled tab loses checkpoint; **partial**: title membership/label sync and ambiguity checks, then verify timing. |
| `FINDINGS.md:46` | Default account-only usage view; **yes** with actual route/account projection and freshness. |

## 3. Verified constraints

- **V** Paseo's current public hook reference says turn-before/after are
  non-waiting notifications; `agent.open.before` is waiting but only changes
  launch inputs. Therefore ordinary composer Send cannot be intercepted or
  durably deferred by these hooks. Checked public
  [hooks documentation](https://github.com/getpaseo/paseo/blob/main/public-docs/plugins/hooks.md)
  sections “Naming and timing” and hook table; installed daemon behavior was not
  separately tested. `docs/design/quota-independence.md:22-50` gives the same
  design boundary.
- **D** The earlier Paseo 0.16.2 investigation verified native Codex `/compact`
  and observed `/clear` did not clear Codex; Claude clear needs effect/session
  verification. This is recorded evidence, not a new live check
  (`docs/design/cold-context-resume.md:15-25,186-201`).
- **D** Reopening a closed agent by plugin send and mute/attention semantics
  were not established by the supervision live matrix; native heartbeat is
  attached to an agent, rather than following current authority
  (`docs/design/supervision-design.md:21-30,116-120,145-150`).
- **V** The repository's send path uses stable recipient/message ID and cannot
  safely probe acceptance after authority changes using a replay. The documented
  missing read-only receipt and no prompt-interception contract remain external
  limitations, not grounds for claiming exactly-once processing
  (`plugin/server/core/steer-action.mjs:29-56`,
  `docs/design/quota-independence.md:317-329`).

## 4. Options and trade-offs

1. **I: Keep current mechanisms, unify decisions.** One read-only effective
   decision over a fresh, typed observation: unique holder/epoch, role/privacy,
   permissions/busy state, actual provider/model/account and quota freshness,
   candidate eligibility, cache estimate and disposition/reasons. Adapt
   `resolveProfile`, `steerQuotaAdmission`, `failoverChain` and cache projection
   rather than inventing a second runtime. Revalidate under existing locks at
   each irreversible effect. Hard safety precedes cost ranking; unknown is
   explicit. Benefit: consistent UI/CLI/admission; cost: careful adapter and
   cross-path tests. Do not assert this function already exists.
2. **I: Auto-create as the no-eligible-candidate branch of a due failover**, not
   a periodic turn. `runFailoverCheck` currently ends at `no-candidates` /
   `candidates-ineligible` (`plugin/server/supervise.ts:1411-1436`). Reuse
   steer-add/create and its receipt journal, then explicitly activate via the
   epoch-guarded takeover path and deliver the existing bounded work once.
   The user preference for auto-create is recorded in
   `docs/design/control-concept/README.md:30-37`; it contradicts the older
   confirmed-provisioning-only decision (`docs/design/slots-live-design.md:109-111`),
   so this is a concept option, not already authorized behavior.
3. **I: Auto-create guards.** Require explicitly enabled scope policy and a
   real pending work item; wait for ZeroSub move/continuation or known reset as
   policy dictates. Reject ambiguous titles, retired scope, pending permissions,
   unsafe privacy/role, no usable account, stale hard limits, drain/boot or an
   unresolved previous attempt. Under the workspace lock re-read scope epoch,
   live slots, account/model and request; reserve one creation generation with
   stable exact request/account, fingerprint, durable attempt/receipt and
   bounded per-epoch retries/backoff. Reconcile lost responses before any create
   or activation. If uncertainty cannot be resolved, expose review/wait; never
   create in a loop or silently cross a privacy boundary.
4. **I: Unify recovery events, not state ownership.** Preserve worker register
   and K7 source records; combine already-ready reports/wakes in a bounded
   delivery when safe, with each receipt independently reconciled. A failed
   recipient turn is not successful processing. Persist failover attempts and
   reset timers by epoch/holder; use state-only sweeps, avoid prompt-only warnings,
   and do not replay uncertain sends after a holder change.
5. **I: Checkpoint confidence before automatic continuation.** Prefer newest
   verified active-holder or continuation checkpoint, report worker evidence
   separately, include changed-worktree/last-known status and outstanding
   assignments. If first-turn task or authority is missing, keep the request
   pending and surface review rather than fabricating a task. Resume after
   drain needs an explicit start condition and a boot-success barrier.
6. **I: Measure before deciding renewal/ranking defaults.** Compare actual
   accepted-package cost, cached/uncached usage, turns and recovery latency
   against matched baselines; record unknown usage. Cache warmth, quota
   utilization and initialization heuristics are explanatory signals, not proof
   that a new agent or proactive compact is cheaper.

## 5. Open questions

- What is the approved boundary for auto-create: per scope, provider, privacy,
  retry budget and spend, and is it allowed when reset is near?
- How should user Stop differ from provider failure when native cancellation
  reason is ambiguous? Which pending requests must remain paused?
- Can Paseo expose a read-only durable acceptance receipt and a native
  pre-dispatch contract for the original message, attachments and permissions?
- Which continuation checkpoint wins when the origin and successor both have
  recent blocks, and how is late completion prevented from overwriting authority?
- Should known-quota exhaustion defer explicit same-tab reset, or allow an
  explicitly confirmed recovery that cannot run yet?
- What native post-drain restart mechanism is permitted without self-blocking,
  and when is supervision allowed to resume if no restart actually occurs?
- How are estimated cache cost, quota freshness and model preference compared
  without silently downgrading task capability or revealing private material?

```text
CHECKPOINT
- task: Research automation, recovery and efficiency for control-concept redesign.
- tests: Read-only code/document inspection; public Paseo hook contract checked. No runtime tests.
- blockers: Shared checkout is changing; native acceptance receipt and several live provider/restart behaviors remain unverified.
- next: Steer consolidate options, reconcile concurrent changes and decide policy before implementation.
```
