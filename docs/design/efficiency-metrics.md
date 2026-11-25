# Measuring Workspace Factory efficiency

## Headline

Measure the **percentage reduction in list-price token cost per accepted work package**
versus one long-lived Paseo agent. This measures what it takes to deliver the same
verified work, including rereads, worker turns, cleanup, handoff briefs and failed
attempts. A count of raw or weighted input tokens alone misses output cost.
Cold starts, quota left at reset and recovery time explain trade-offs separately.

A package starts when the harness releases its task and ends when an independent
checker accepts it or the run hits its preset deadline or budget. Attribute setup,
including the cost of warming the first session, to the first package. Attribute
background work between packages to the preceding package, including final
cleanup. Count each provider request once, even if a parent summary reports child
usage. Failed and retried work stays in the numerator.

```text
request_cost_USD = (U*pU + R*pR + sum(W[t]*pW[t] for each TTL t) + O*pO)
                   / 1,000,000
cost_per_package(arm) = sum(request_cost_USD for all attempts in arm)
                        / number of packages accepted in arm
reduction_pct = 100 * (1 - cost_per_package(factory) / cost_per_package(baseline))
```

`U` is input at the uncached rate, `R` is cache-read input, `W5` and `W60`
are separately priced writes of each Claude lifetime, and `O` is billable output.
When the provider includes reasoning in its output total, use that total once.
Prices are USD per million tokens. Use the actual model and mode of each request
and a single dated rate table for both arms. An arm with zero accepted packages
has no finite estimate.

| Reference tariff, Standard mode | Normalize provider fields | USD per million tokens and weights relative to uncached input |
| --- | --- | --- |
| Codex with ChatGPT sign-in, GPT-6.2 Sol | From a verified inclusive input total `I`, use `U = I - R` and `R = cachedInputTokens`. Cache fills are part of uncached input and carry no separate write charge. | `U $2` (1×), `R $0.10` (0.05×), no separate write rate, `O $10` (5×). [Codex Enterprise USD rate card](https://help.openai.com/en/articles/20001415-chatgpt-rate-card-enterprise-token-based-pricing), [Codex credit rate card](https://help.openai.com/en/articles/11481834-chatgpt-rate-card-business-enterpriseedu-credit-based-pricing), [Codex input accounting](https://github.com/openai/codex/blob/main/codex-rs/tui/src/token_usage.rs) |
| Claude, Sonnet 4.6 | Use `input_tokens` as `U`, `cache_read_input_tokens` as `R`, and the two TTL buckets in `cache_creation` as `W5` and `W60`. Their sum must match `cache_creation_input_tokens`. | `U $3` (1×), `R $0.30` (0.10×), `W5 $3.75` (1.25×), `W60 $6` (2×), `O $15` (5×). [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing), [Claude cache usage fields](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#1-hour-cache-duration) |

Verify tariffs at run registration. For other models take each weight as
`pComponent / pU`. Claude read weights vary by model. Keep Codex API-key runs a
separate tariff and verify their policy, including any cache-write price and
context tier. If a write is a distinct API billing bucket, subtract it from the
inclusive input total as well as reads before pricing. For subscriptions the
headline is a list-price equivalent. Account quota utilization has its own units.
[OpenAI API prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching),
[Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing)

Unknown usage is missing. For a known Claude write total `W` with unknown TTL
split, its input-price-equivalent cost lies between `1.25*W` and `2*W`.
Publish those bounds in diagnostics and require a complete, reconciled ledger
for the README point estimate. Require positive savings and all packages
accepted in both arms for the initial claim.

**Package size.** A package has no general size: the headline number is only defined for the
fixed suite below (packages A, B, C with scripted phases and deterministic acceptance), so both
arms always do identical work. Comparing real projects needs a size measure first, for example
one assigned task from release to `done` CHECKPOINT, classified by changed files, phases and
acceptance checks. That classification is an open design point; no live runs are planned yet.

## Supporting metrics

- **Cold-turn rate.** Count task and continuation turns, including worker and
  handoff work. Track maintenance-only turns separately. Compute idle age at
  turn start from the last observed request end in the same provider session.
  A turn is predicted cold or oversized when the age exceeds the
  pinned retention threshold or the last pre-turn context is at least 60,000
  tokens. Divide the union count by the number of classifiable continuing work
  turns. A turn with either known condition true qualifies, while a negative
  classification requires both known conditions to be false. Report each
  condition, their overlap, fresh-turn share and unknown counts. Report observed
  first-request hit ratio `R/(U+R+W5+W60)` by gap and route alongside it.
  Shared prefixes can still hit after a restart. Idle age and context size are
  proxies for the condition of the cache.
- **Unused quota at reset.** For each account and window reset, choose the
  latest provider observation with the matching reset timestamp from the last
  two minutes before reset. Unused share is `100 - usedPct`. Require a known
  provider observation time and mark stale or missing windows unknown. Report
  median and range by provider and window type, with coverage. Combine only
  comparable windows with capacities in a common unit, using
  `100 * sum(capacity * unusedPct/100) / sum(capacity)`. Overlapping session
  and weekly windows each get their own report. Sample real resets separately
  with dedicated accounts and matched offered work. The injected limit fixture
  measures recovery, while unused quota requires actual provider observations.
- **Recovery cost.** From the injected failure timestamp to the first harness-
  verified next-step milestone on the same package, report elapsed minutes,
  `sum(U+R+W5+W60+O)` and list-price cost across all recovery requests. Include a
  request started before the failure if it ends during recovery and flag it as
  the interrupted request. Count it once in package cost. Record time to first
  continuation turn separately and report unrecovered runs at the time cap.
- **Workflow checks.** Publish acceptance counts, elapsed and active time,
  requests per package, raw usage buckets and costs by delivery trigger and
  route. Include real wall time with idle gaps and time excluding only the
  scheduled idle intervals. Failover and recovery waits remain in both measures.

## Current evidence and gaps

| Source | What it exposes today and what the benchmark still needs |
| --- | --- |
| Paseo inspect and timeline | Paseo 0.16.2 exposes last-snapshot input, cached input, output and cost in `paseo inspect --json`. The CLI substitutes zero for missing individual fields. `paseo logs --json` emits projected items. The SDK fetches timeline rows and exposes the agent snapshot's `lastUsage`. Usage updates are stream events, outside the timeline item union. The manager retains the previous snapshot when completion lacks usage. [Inspect](https://github.com/getpaseo/paseo/blob/v0.16.2/packages/cli/src/commands/agent/inspect.ts#L108-L115), [CLI logs](https://github.com/getpaseo/paseo/blob/v0.16.2/packages/cli/src/commands/agent/logs.ts#L90-L96), [SDK timeline](https://github.com/getpaseo/paseo/blob/v0.16.2/packages/client/src/index.ts#L1020-L1027), [SDK lastUsage](https://github.com/getpaseo/paseo/blob/v0.16.2/packages/client/src/index.ts#L1113-L1118), [event types](https://github.com/getpaseo/paseo/blob/v0.16.2/packages/server/src/server/agent/agent-sdk-types.ts#L400-L419), [snapshot update](https://github.com/getpaseo/paseo/blob/v0.16.2/packages/server/src/server/agent/agent-manager.ts#L5371-L5377) |
| Paseo provider adapters | Codex projects `tokenUsage.last`, so its snapshot alone cannot account for a turn with multiple model calls. Claude maps the SDK result to input, cache reads, output and USD, omitting write counts from `AgentUsage`. The lifecycle bridge delivers the turn ID and outcome without the provider usage. [Codex projection](https://github.com/getpaseo/paseo/blob/v0.16.2/packages/server/src/server/agent/providers/codex-app-server-agent.ts#L1107-L1123), [Claude projection](https://github.com/getpaseo/paseo/blob/v0.16.2/packages/server/src/server/agent/providers/claude/agent.ts#L2214-L2244), [hook bridge](https://github.com/getpaseo/paseo/blob/v0.16.2/packages/server/src/server/plugins/lifecycle/index.ts#L187-L211) |
| Factory token counters | The hook stores the open turn ID and start time, then merges `lastTurn` and cumulative usage into labelled agents' metadata. The usage extractor can fall back to `agent.lastUsage`; its cache-read aliases omit Paseo's `cachedInputTokens` and absent fields become zero. These counters cannot reliably resolve per-turn cache semantics, retries or the Factory-off arm. [Turn start](../../plugin/server/turn-hook.ts#L113-L136), [turn finish](../../plugin/server/turn-hook.ts#L278-L326), [metadata merge](../../plugin/server/turn-hook.ts#L424-L435), [extractor and counters](../../plugin/server/quota.ts#L84-L128) |
| Quota and ZeroSub | The Factory keeps the last parsed `paseo usage --json` sample in memory, with a refresh interval of at least ten minutes through its timer. The parser keeps session and weekly percentages and the session reset. The optional `zerosub.state` gives per-account windows with used percentages and resets plus live and pending agent routes. The quota panel presents an account's maximum usage and earliest reset, which can come from different windows. Collect raw window observations with provider freshness and route changes over time. [Sampler](../../plugin/server/quota.ts#L12-L81), [Paseo usage parser](../../plugin/server/factory/quota.ts#L199-L227), [ZeroSub windows and routes](../../plugin/server/factory/zerosub.ts#L29-L78), [ZeroSub read](../../plugin/server/factory/zerosub.ts#L283-L302), [quota RPC](../../plugin/server/quota-rpc.ts#L94-L125) |
| Cold sweep | The panel estimates coldness from idle time and context size. Cleanup uses heuristic cache group TTLs and logs action or failure, with temporary pending-action metadata. The turn hook checks clear/compact evidence. These signals explain decisions but do not measure actual cache reads or total cleanup cost. A prior Codex study observed locally invisible usage for compaction. [Cold panel source](../../plugin/server/cold-sweep.ts#L698-L727), [cache profiles](../../plugin/shared/cache-profiles.ts#L21-L45), [fresh decision](../../plugin/shared/idle-cleanup.ts#L468-L481), [sweep log](../../plugin/server/cold-sweep.ts#L425-L455), [pending action](../../plugin/server/cold-sweep.ts#L531-L549), [effect checks](../../plugin/server/turn-hook.ts#L330-L348), [Codex observations](codex-research/findings-compact-vs-fresh.md#L3-L9) |
| Delivery paths | Plain wake and wake-triggered resume update worker wake state. Resume can send a brief directly or after a cleanup turn. Switch and fresh send their own handoff packets, and may notify the previous steer with another model turn. None of these write a shared usage join key, and one workflow can produce multiple sends. [Wakes](../../plugin/server/supervise.ts#L623-L661), [resume](../../plugin/server/resume-apply.ts#L226-L269), [after-clear brief and seed](../../plugin/server/turn-hook.ts#L488-L539), [switch](../../plugin/server/factory/steer.ts#L873-L890), [fresh](../../plugin/server/factory/steer.ts#L1149-L1165) |

Record a small, opt-in event ledger in both arms. Use `runId`, `packageId`,
`attemptId`, benchmark-local agent/session IDs and a time-stamped account alias.
Set `packageId` in the harness and inherit it across workers, notifications
and replacements. Store a delivery ID, parent delivery ID, message receipt
when available, enqueue/start/end times, and final outcome. Use two fields so
`trigger=worker-wake, route=resume` retains both meanings. Initial routes are
`normal`, `wake`, `handoff`, `resume`, `fresh` and `cleanup`. Record rewind,
clear, brief and previous-agent notices as linked steps.

Join on message receipt and provider turn/request IDs. When a receipt is
unavailable, accept a unique match from a serialized benchmark dispatch with
exactly one outstanding message per target. Keep ambiguous matches and
open turns across restart as unresolved until reconciled. Deduplicate requests
by provider request ID within their provider/account namespace, or by a
verified monotonic session counter delta when request IDs are unavailable.
Capture context and the previous request timestamp before the turn overwrites
them. Export an allowlist of numeric fields, enums and aliases.

## Paired benchmark

Pin a small dependency-free synthetic repository with three packages, fixed
prompts and hidden deterministic checks. Use stable commits or fixture checksums
and allow only expected paths in each diff. Each paired run uses separate fresh
checkouts of the same fixture. The baseline keeps the same agent through all
three packages, including after the abort.

| Package | Scripted phases | Acceptance |
| --- | --- | --- |
| A. CLI behavior | Diagnose a small date-filter bug, then implement it after a 60-second warm gap. | Boundary timestamps, invalid input, existing behavior and tests. |
| B. Config migration | Inspect a fixed synthetic migration guide and legacy fixtures, propose a migration, then implement after the long gap. | Expected old and new format round trips, malformed files, unchanged defaults. |
| C. Report refactor | Update two independent local report formats. Interrupt after the first format's verified patch and before the second phase has made its first edit. Resume and run the suite. | Both formats, preserved output fixtures, and a verified second-phase milestone after recovery. |

**Arms.** Factory off means normal Paseo with one persistent agent, native
auto-compaction and the user's scripted continuation after the gap or reset.
Factory on means one active steer with a fixed same-model profile, the published
Factory settings and a scripted decision rule for refresh when indicated, then
normal continuation. In C, use one same-model worker and its resulting wake.
Charge the steer and worker, including setup and integration. Pin native model,
reasoning, auth path, tools, settings, workspace instructions, turn/deadline
limits and test runner for both. Use a cloned copy of any common warm-up task and
charge it in both arms. Publish Factory-specific instructions and configuration
with the fixture. Test independent model-selection or account-routing changes
in a supplemental experiment with the same task and quota schedule.

**Idle gaps.** Start the gap at the phase's model turn completion in each arm.
Schedule the same next external action after that interval. Any intervening
Factory work is part of its cost and can refresh its cache. For Claude choose
seven minutes for a five-minute route or 65 minutes for a one-hour route. Claude
Code TTL varies by auth and request type. For Codex pin the observed auth path
and calibrate once against a matching synthetic prefix on a scratch thread.
Try 35 and 65 minutes first for current Codex. Extend to the applicable maximum
plus five minutes if a clearly expired cache is required and feasible. The
OpenAI API guide describes model-specific retention, while Codex sign-in has
separate pricing and should use measured cache evidence. Freeze the gap before
scoring. If no reliable crossing is observable, label it a long-gap cohort and
report the observed cache-hit distribution. [Claude Code TTL rules](https://code.claude.com/docs/en/prompt-caching#cache-lifetime),
[OpenAI API retention](https://developers.openai.com/api/docs/guides/prompt-caching#cache-retention)

**Abort and limit.** Have the fixture runner park the agent at a scripted
phase-two gate before the edit. Stop the running turn via Paseo in both arms
when that gate is reached. Start the recovery clock then. In a separate limit
variant use a harness-supplied quota snapshot that exhausts the active lane for
120 seconds. Give both arms the same reset and underlying provider access.
The baseline resumes the same agent at reset. Factory-on follows its configured
route. Exercise routing to an eligible alternate lane only in the supplemental
experiment. Smoke-test a limit-classified terminal event in a fake daemon and
label the live result a simulated gate, since a real abort and an injected quota
sample give different evidence from a provider returning a rate-limit error.

**Cost and variance.** Use fake-clock and recorded-usage fixtures in CI. Run one
unscored live pilot per provider to check the data path and freeze a USD budget
and wall-clock cap. Then schedule ten scored pairs per provider, five in each
arm order using a seeded shuffle. Keep provider accounts idle outside the
experiment, prevent cross-arm prefix warming with matched-length, early
run-specific salts where the harness controls the prefix, and report any
shared-prefix hits. Schedule idle gaps off the operator's clock. Publish all
attempts, manifests, exclusions and reasons. Replay only against declared
infrastructure failure criteria, keeping original results and replacements.
Report paired suite ratios, median, interquartile range and a seeded 95% paired
bootstrap interval for the headline from 10,000 resamples of whole pairs.
Use ten pairs as a first estimate and require the interval above zero before
putting savings in the README. Report providers individually. A provider-wide
headline needs an explicitly registered workload mix.

## Reporting and implementation

README template once the benchmark qualifies:
“X% lower list-price token cost per accepted package on the three-task
[Codex or Claude] benchmark.” Link to `docs/benchmarks/<YYYY-MM-DD>.md`.
The report records both arm costs and acceptance, the interval and all metrics.
Ship the manifest, frozen rate table, versioned raw numeric event rows and
per-pair results alongside it. Include the exact reproduction command and
fixture checksums. Keep a report for partial, null or adverse results.

1. **Prove usage coverage.** Start with the existing scratch live-check
   machinery and budget gate. Capture native Codex App Server usage updates
   and verify cumulative deltas against a sequence with multiple requests,
   a reconnect and an abort. Prototype a local Claude Code OTLP receiver with
   token-only projection. Supported versions emit per-request usage including
   write TTLs when the API reports them. Verify coverage of compaction, helper
   requests and interrupted work in both arms. If the provider cannot expose
   those charges, publish a partial report and hold the headline. [Live-check
   gate](../../plugin/test/manual/provider-live-check.mjs#L20-L43),
   [Codex App Server events](https://learn.chatgpt.com/docs/app-server#events),
   [Claude API request events](https://code.claude.com/docs/en/monitoring-usage#api-request-event)
2. **Normalize usage and connect deliveries.** Add the opt-in ledger beside
   the existing hooks and instrument the baseline through the same collector.
   Unit-test exact price arithmetic, SDK alias coverage, explicit zero vs
   missing fields, inclusive vs exclusive input, mixed TTLs, stale snapshots,
   repeated updates, session resets and child attribution. Add integration tests
   for one wake through resume/clear, switch, fresh, normal, and a raced or
   retried send.
3. **Build the fixture runner and reporter.** Exercise both arms against the
   fake clock, abort and quota fixtures. Test that acceptance is independent
   of agent status, costs include failed attempts, ambiguous joins block a
   complete report, stale quota stays unknown, and identical input reproduces
   the same aggregate and interval. Run the live pilot, then freeze and run
   the scored manifest. Update the README only from the resulting report.

## Open questions

1. Which provider, model and auth path should the first README number represent?
2. Which production Factory profile and refresh policy should the benchmark pin?
3. What live token budget and wall-clock cap should the scored manifest use?
4. Should the initial public report also include multi-account recovery, or
   should that remain a separate benchmark until reset samples are reliable?
