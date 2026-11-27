# Codebase consolidation and Paseo native first

Status: plan accepted 2026-11-25 (rework in place, see §0); stage 0 in progress.

**Principle.** The Factory decides, Paseo executes. Factory keeps only what its goal needs
(turn available quota across providers and accounts into finished work, with minimal redundant
context and high continuity) and what Paseo or installed plugins do not cover adequately. Fewer
lines alone are not success: recovery safety, clarity and testability must not drop.

## 0. Decision: rework in place, no new repository (2026-11-25)

A fresh repository was considered and rejected:

- The core model (scope, active steer, epoch, checkpoint, worker register) is sound; the analysis
  found duplication and dead surface, not a wrong architecture. Stages 1–3 are mostly removals
  and merges, which a rewrite would have to redo anyway.
- The Factory coordinates its own development and runs live. A new repository would need a
  parallel install, a migration of the live workspace metadata (`ari.wsf*`) and a cut-over,
  all of which K16 already covers in place.
- About 1,200 tests encode invariants learned from real failures (receipt binding, epoch
  rollback, delivery crash windows). A rewrite would lose them or have to port them one by one.
- The commit history is the evidence trail for the "origin" column below.

The largest structural cut (K12: core only in `plugin/`, CLI as a thin RPC client) is done in
place after its spike. Revisit only if that spike shows the plugin compiler cannot host the core.

Evidence (read-only, against installed Paseo **0.17.4** daemon and SDK code, not docs):

- [consolidation/native-audit.md](consolidation/native-audit.md): every own mechanism vs. the
  native capability and its actual guarantee, class 1–6.
- [consolidation/feature-inventory.md](consolidation/feature-inventory.md): every entry point,
  caller, config key, CLI/plugin boundary.
- [consolidation/internal-architecture.md](consolidation/internal-architecture.md): persisted
  state, lock/epoch checks, delivery and recovery paths, candidates A–G.

Classes: 1 replaceable by Paseo · 2 substantially simplifiable · 3 thin adapter · 4 Factory
decision logic · 5 historical · 6 not yet assessable.

## 1. Baseline (commit `a7c5cb6`)

| Metric | Value |
|---|---|
| Hand-written production code | 87 modules, 32,626 lines (27,468 non-blank, non-comment): `src/` 28 modules 11,320 · `plugin/server` 19 · 8,504 · `plugin/shared` 17 · 6,085 · `plugin/client` 21 · 6,074 · entries 2 · 643 |
| Largest modules | `src/steer.mjs` 1,658 · `plugin/server/supervise.ts` 1,748 · `plugin/server/handlers.ts` 1,647 · `plugin/client/factory-panel.tsx` 1,532 |
| Generated (separate) | the generated in-package core copy, 27 files, 10,353 lines (removed by K12a): same JS as `src/` with `.js` imports and `@ts-nocheck`; physical copy, no second logic |
| Tests / docs (separate) | 91 files, 29,073 lines / 24 files, 2,963 lines |
| Background timers | 5 `setInterval` (`quota.ts:71`, `steer-feed.ts:367`, `cold-sweep.ts:686`, `:782`, `supervise.ts:1705`), 5 `setTimeout` |
| Subprocesses | `paseo` CLI: 9 subcommands at ≈15 call sites (`usage`, `daemon status` ×2, `agent import`, `clone`, `project create/rename/delete`, `workspace rename`, `agent detach`, `agent update --label`); plus `git`, `gh`, `flock`. All synchronous (`execFileSync`/`spawnSync`) |
| Internal Paseo API access | ≈29 sites in 7 files: internal `DaemonClient` receipt lookup (`src/paseo.mjs`), internal rewind (`src/rewind.mjs`), model/thinking setters (`steer-settings.ts`), ZeroSub internal RPC |
| Persisted state | 15 `wsf.*` metadata keys/labels; 32 fields per `wsf.agents[id]` record, 11 of them operation/pending/verification fields (`pendingAction`, `pendingWakeBrief`, `stagedBrief`, `cleared`, `actionVerified`, `lastActionFailed`, `refreshed`, `freshHint`, `needsResume`, `lastSteerDeliveryId`, `workerResumeMessageId`); legacy `ari.wsf*` prefix still read |
| Delivery / recovery | 10 separate primary delivery paths, 5 recovery owners (internal-architecture.md §Delivery) |
| Configuration | 6 plugin settings documents with ≈36 keys; JSON config file with ≈20 key groups; ≈10 environment variables |
| Public surface | 31 CLI usage lines in 21 command families; 41 plugin RPCs; `/factory` slash command with ≈30 subcommands; 6 settings screens; panel, steer pill, attention pill, Command Center (5 items), sidebar item |

## 2. Main findings

1. **Two live defects** (verified in code):
   - Receipt lookup admits only Paseo 0.16.2 (`src/paseo.mjs:211`, `:253`). On 0.17.4, every
     lookup-first creation path refuses: `steer add` (`src/steer-add.mjs:505`), new-agent
     `fresh` (`src/steer.mjs:470`), relocate and plan recovery. Replacement creation is broken in
     production.
   - `worker pick --failed` writes the whole `wsf` object from an earlier read without the scope
     lock (`src/cli.mjs:873–881`). A switch in between is rolled back (epoch, active steer).
2. **Most own mechanisms are justified, but over-implemented.** Native Paseo gives durable,
   keyed message and creation receipts, `waitForFinish`, archive/close/turn events and
   revisioned plugin settings. It has no epoch fence, no atomic send-if-idle, no public
   receipt lookup, no public rewind and no typed clear/compact effect. Factory's decision logic
   (quota routing, cache economics, takeover, worker register) stays class 4; most transport
   code around it is class 2/3.
3. **The delivery layer is the complexity hotspot**: 10 delivery paths, 5 recovery owners, three
   overlapping pending records, crash windows (switch commits the epoch before any delivery
   record; warm wake sent before acknowledgment; rewind before intent). This is the area of most
   of this week's bugs. The planned action record (K7) is the right fix and also the biggest
   internal reduction.
4. **Do not replace `paseo usage --json` with `providers.listUsage()`.** On 0.17.4 the public
   method is a legacy projection: it drops report/account IDs, retained last success and
   per-login errors, and cannot force refresh. Factory needs per-account data. Keep the CLI
   until a public modern report API exists; fix the parser and make sampling non-blocking.
5. **The surface is larger than the users.** Dead or caller-less: `ping` RPC, `FactoryPopover`,
   `factory.attention` alias,
   deprecated `slot set/rm` and `worker-default`, `advisors.profiles`, `runtime.scratchDir`, the
   top-level `quotaSampleMinutes` copy, `settingsObserved` clip branch, 4 of 5 Command Center
   items (all open the same panel). Duplicated logic: two quota defaults (90 vs. 95), two
   known-limit tables, two drain predicates, two rewind RPC wrappers.
6. **The largest structural reduction is the CLI/core split.** `src/` exists as a separate Node
   core because the CLI runs outside the plugin. With the decided "no factory CLI without a
   running plugin" (TODO 16), the CLI can become a thin RPC client; the core can then live only
   in `plugin/`, removing the 10k-line generated mirror and the sync step, and the CLI-only
   commands that humans no longer use (users operate via `/factory`).

## 3. Native-Paseo audit summary

| Area | Class | Decision |
|---|---|---|
| Workspace retitle, agent detach | 1 | public `workspaces.ref().setTitle()`, `agents.ref().detach()` instead of CLI |
| Agent/workspace creation, idempotency | 3 + 4 | keep keyed native create; keep Factory authorization, placement and account verification; share one request builder/verifier |
| Read-only receipt lookup | 3 | needed (native create is not a read-only lookup); fix 0.17.4 support, request public lookup upstream |
| Status, wait for turn end | 2 | subscriptions + `waitForFinish` instead of metadata polling (switch wait, drain) |
| Message delivery | 4 + 2 | keep Factory epoch/wake policy; use native message-ID receipts for exact replay instead of own resend logic |
| Archive | 3 | native; add `agent.archive.after` for immediate worker register cleanup instead of later scans |
| Projects (create/rename/delete), clone, label update | 3 | CLI bridge stays (no public SDK) |
| Resume after restart | 2 | native open/resume; do not enable native `resumeOnStartup` for Factory agents (no epoch/quota gates) |
| Rewind | 3 | internal RPC until a public one exists; one transport (two today) |
| Clear/compact verification | 3 | session-ID change + correlated message ID; tighten compaction proof (today any compaction row counts) |
| Usage/quota | 2 | keep CLI report path, non-blocking single sampler, typed parsing |
| Provider catalog | 2 | native catalog events instead of own 30 s cache |
| Factory profiles, routing, ZeroSub continuation | 4 | keep |
| Plugin settings storage | 2 | native settings only (with TODO 16) |
| Timers | 2 | event-driven projections; deadline scheduling only for time-based state (idle, cache age, quota reset, stale workers) |
| Client UI | 2/3 | native components and `useTabState`; keep Factory pills/actions; drop dead popover and duplicate Command Center items |

## 4. Candidate list

Size: **S** small, low risk, independent · **F** fundamental. Reductions are net production
lines, estimates to be checked in the diff; tests not counted.

| # | Candidate (current → change) | Why it exists | Files | Reduction | Invariants, risks, regression tests | Rec. | Size |
|---|---|---|---|---|---|---|---|
| K1 | 0.16.2-only receipt lookup blocks creation on 0.17.4 → validate lookup on 0.17.4 (no receipt, completed, in-flight, failed, unknown), replace version allowlist with a capability check | strict receipt binding (`1e56936`) pinned to the then-tested version | `src/paseo.mjs` | ≈0; fixes broken add/fresh/relocate | never create without proof; tests in `test/evidence-lookup`, controlled daemon restart | fix | S |
| K2 | lockless whole-`wsf` health write → locked fresh read, or own top-level key `wsf.profileHealth` (native patch is top-level) | quick CLI failure marking | `src/cli.mjs`, `src/quota.mjs` | ≈0 | no epoch rollback; test failure write racing a switch | fix | S |
| K3 | CLI subprocess for workspace rename / agent detach → public SDK | CLI was the only path when written | `src/apply.mjs` | 2 subprocess sites | keep read-back | replace | S |
| K4 | dead entry points and options (finding 5) → remove, update docs | historical, superseded by native or later design | handlers, client, `src/workers.mjs`, `src/config.mjs`, settings | ≈300–600 | check docs and external scripts; Command Center keeps "Open Factory panel" | remove | S |
| K5 | duplicated small logic (quota default, known limits, drain predicate, rewind transport) → one each | parallel CLI/plugin growth | `src/{quota,config,drain,rewind,steer}.mjs`, `plugin/shared/{steer-state,settings-validate,supervise}.ts` | ≈120–250 | 90/95 boundary, rewind anchor tests (`test/rewind`, `fresh-bound-rewind`) | merge | S |
| K6 | quota sampler: blocking `execFileSync` up to 15 s in the plugin, lossy parser → async single sampler, typed per-account parsing, keep CLI report source | only public per-account source | `plugin/server/quota.ts`, `src/quota.mjs`, `quota-rpc.ts` | small; fixes event-loop blocking | unknown stays unknown; stale samples flagged | simplify | S |
| K7 | action record (planned P0): 10 delivery paths, 5 recovery owners, 3 pending records → one intent/attempt/observe/finish record, one reconciler, native message-ID replay | grew per feature (`8c00f3f`, `d44c36c`, `6b458a3`, `ccf1d2b`, `3c41322`) | delivery, brief, supervise, boot, sweep, turn hook, resume, settings; `src/{agent-state,steer,rewind,assign,relocate}.mjs` | ≈170–300; −2 state shapes | crash/disconnect at every step; unknown success never starts a second turn; fixtures listed in internal-architecture.md §A | merge | F |
| K8 | scope guard (planned P0): scattered epoch checks with gaps (manual checkpoint, resume before takeover, same-slot hooks, inactive fresh) → one guard: expected scope, epoch, exact active agent | added per command | `src/{lock,agent-state,steer,workers,assign,cli}.mjs`, handlers, hooks | ≈45–95 (adds missing checks) | A→B→A, stale preview, self-takeover, allowed inactive maintenance | merge | F |
| K9 | creation: near-identical steer request builders (plan, add, fresh ×2, relocate) → one builder + placement verifier | each feature added its own | `src/{planner,steer,steer-add,apply,workers,relocate}.mjs` | ≈70–130 | foreign occupant, parent/account mismatch, same key changed request | merge | F (after K1) |
| K10 | timers → one subscribed projection for steer feed and attention (2 per-subscriber timers), `agent.archive.after` for worker register cleanup, deadline scheduler for idle/cache/quota/stale | polling was the simple first version | `steer-feed.ts`, `cold-sweep.ts`, `supervise.ts`, `quota.ts` | 5 intervals → 1–2 deadline schedulers; less load per open app | reconnect, daemon downtime, missed hook; keep bounded reconciliation | simplify | F |
| K11 | discovery: full daemon state read several times per RPC, 5 holder selectors → one snapshot per call, one holder selector | per-module needs | `src/{paseo,discovery,scope}.mjs`, feed, sweep, boot, settings, supervise | ≈50–110 | legacy labels, ZeroSub multi-hop, same-slot holders | simplify | F |
| K12 | CLI thin RPC client (with TODO 16): keep only agent-facing commands (`status`, `resume`, `checkpoint`, `worker pick/start`, `workers`, `switch`/takeover, `assign`); move core into `plugin/` as single source; delete generated mirror and the sync script (mirror half done in K12a, thin-client half open) | CLI predates the plugin | `src/cli.mjs`, `src/*`, the generated in-package copy, scripts, docs | −10,353 generated; `cli.mjs` 1,021 → ≈250; one copy of core | spike done (production compiler bundles `.mjs` in both bundles); CLI needs a running plugin (decided) | merge | F |
| K13 | plan/apply beyond onboarding → initial enrollment of one existing workspace + repair only; drop recurring top-up, retitle, project rename, expected-model drift, fork/clone knobs | built for bulk provisioning | `src/{planner,apply,factory,github}.mjs`, plan UI | ≈500–900 | keep durable compound replay for enrollment; ties to slots-live (TODO 17) | simplify | F |
| K14 | relocate (cross-workspace authority transfer, has a dual-live window after the first lock) | one-time moves | `src/relocate.mjs`, RPCs, UI | ≈350–450 | no proven routine demand; manual alternative: new scope + switch | remove (decision) | S–F |
| K15 | `cleanup --plan` generalized destructive orchestration → read-only scope health + native archive actions | before native archive covered ownership | `src/cleanup.mjs`, RPC, panel | ≈250–350 | keep loss inventory for test leftovers if retained | simplify (decision) | F |
| K16 | legacy `ari.wsf*` reads, `labels` command, legacy delivery shapes → migrate this host's records once, then remove branches | pilot prefix | `src/{paseo,labels,apply,planner}.mjs`, `steer-delivery.ts` | ≈250–400 | only after a store inventory proves no remaining legacy records | remove (staged) | S–F |
| K17 | optional seed after clear (extra model turn) | convenience | `turn-hook.ts`, settings | small | Resume/SessionStart must suffice | remove unless needed | S |
| K18 | config file, env endpoints, file-era knobs → TODO 16/17 already decided | standalone CLI | `src/{config,runtime}.mjs`, `plugin/server/config.ts`, settings | ≈400–700 | existing TODO 16/17; not a new task | (existing TODO) | F |

Estimated total, without generated files: ≈2,500–4,500 production lines (8–14 %), 5 → 1–2
timers, 9 → ≈5 CLI subprocess commands, 10 → ≈3 delivery paths, 5 → 1 recovery owner,
3 → 1 pending record. With K12: additionally −10,353 generated lines and one build step.
A matching share of tests goes with removed features.

## 5. CLI/plugin boundary

- Physical duplication: the generated in-package core copy (removed by K12a). Logic maintained twice: small
  (K5) plus two configuration paths (file overlay vs. native settings, TODO 16).
- Plugin compiles the checked-in sources on load; there is no build step at install. The
  generated files therefore cannot simply be dropped from Git while `src/` stays the source.
  Removing them needs the core to move into `plugin/` (K12).
- Target: plugin server owns all policy and state changes. Humans use `/factory`, pill and
  panel. Agents use a small CLI that calls plugin RPCs. No second execution engine in the CLI.

## 6. Compatibility strategy

- **Minimum version: Paseo 0.17.4** (installed; plugin already builds against SDK 0.17.4).
  Drop 0.16.2 assumptions: receipt-lookup allowlist (K1) and the CLI restart heuristic that
  asks `daemon status --host`, which no longer returns `startedAt` on 0.17.4.
- **Capability checks instead of version lists** where detectable: client feature flags
  (`providerUsageList`), presence of creation-subscription support, plugin RPC capability.
- **Temporary upstream workarounds** (keep, each with an exit condition): internal receipt
  lookup, internal rewind, internal model/thinking setters, CLI for usage reports, projects,
  clone, label update, agent import.
- **Upstream gaps** (document, do not build infrastructure around them):
  1. atomic send-if-idle (internal `idleOnly` exists, not exposed);
  2. public read-only creation-receipt lookup;
  3. public modern usage reports per account (with refresh);
  4. public rewind with anchor semantics; public model/thinking setters;
  5. typed clear/compact with effect receipt or session-changed event;
  6. metadata compare-and-set (revision) for workspace/agent metadata;
  7. authenticated caller identity in plugin RPC context;
  8. SDK project create/rename/delete, agent label update, agent import;
  9. daemon instance ID / start time in the SDK;
  10. config-change hook (TODO 19 item 4).

## 7. Non-negotiables check

Every candidate keeps: cross-provider/account quota routing (K6 improves data quality),
cache-aware context economy (K7 keeps provider-specific evidence), coordinator switch and
continuity (K7/K8 close crash windows), recovery after provider/daemon interruption (K7 single
reconciler), no competing coordinators (K8, K2), no duplicate model calls (K7 native replay,
K17), reuse of existing workers (unchanged), verification of critical actions (K1, K7, tighter
compaction proof).

## 8. Stepwise plan

| Stage | Content | Decision needed |
|---|---|---|
| 0 | Defects K1, K2 | none (bugs) |
| 1 | Small reductions K3, K4, K5, K6, K17 | approve removal list K4 and K17 |
| 2 | P0 action record and scope guard (K7 + K8), then K9, K10, K11 | sequencing only |
| 3 | Surface: K12 (with TODO 16), K13 (with TODO 17), K14, K15, K16 | per item: keep or remove relocate, cleanup plan, plan scope, CLI command set |

Each stage records the technical baseline above again and the passive efficiency metric
(passive measurement from real work, no dedicated benchmark runs) before and after.
