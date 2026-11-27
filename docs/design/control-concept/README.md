# Control concept redesign (task brief, 2026-11-26)

Status: direction and the three concept decisions accepted by the user on
2026-11-26. Additions are incorporated in [concept.md](concept.md). The
[implementation plan](implementation-plan.md) incorporates the reviewed native
[reset](research-native-reset.md) and [dispatch/menu](research-native-dispatch-menu.md)
reports. On 2026-11-26 the user approved same-tab provider-session renewal and
the generic native extensions, and authorized implementation starting with P0.
Live validation gates dependent Factory work. Failover must work without a
further turn by an exhausted controlling steer.

## Goal

Rework the whole control concept of the Workspace Factory: backend, configuration, model
preferences, automated decisions, onboarding, resume and user interaction, as one product.
Paseo stays the agent runtime; the factory is the policy, coordination and optimisation
layer. Maximise accepted work per quota with minimal user effort; continue work
independently of provider sessions; steers replaceable without losing progress; workers
independent of the current steer; hide complexity without making decisions opaque.

## Requirements from the user (orientation, not a fixed plan)

1. **Identity vs model.** Steer letters are identity only (title-based membership, see
   slots-live-design.md). Separate: identity, current provider/model/account, thinking/speed,
   global model preferences, role/permissions, control authority, cache/context state. Find
   which slot configuration becomes obsolete. A manual model change on a steer must never
   change global preferences.
2. **Host-global configuration.** Factory config and model preferences per Paseo host.
   Possibly categories: Host & Projects, Models & Profiles, Routing & Priorities, Context &
   Recovery, Automation, Quota, Chat & Display. Separate priorities for steers, workers,
   advisors. Real selection still respects provider availability, quota, accounts, model
   capability, privacy, advisor rules, profile health. Examine profiles vs native Paseo model
   options (thinking, speed). Remove duplicated/conflicting settings (e.g. several quota
   thresholds). One effective policy for backend, CLI, slash commands and frontend.
3. **Configurable automation** (settings, not fixed rules; avoid deep hierarchies; reconcile
   with cost profiles Maximum Efficiency / Balanced / Comfort):
   - After Reset Steer: continue open work automatically / put resume brief in composer /
     wait. User preference: **continue automatically**.
   - Failover when no steer is suitable: create one / offer creation / wait. User
     preference: **create automatically**.
   - Efficiency vs model preference: efficiency / preference / balance. User preference:
     **efficiency**.
4. **Steer menu.** Primary actions: Create Steer, Handover, Reset Steer, Open Factory.
   "Handover" (not "Hand over to..."); disabled when the current tab does not hold control;
   remove "Change Settings"; no needless ellipses; Resume and Refresh Context replaced by
   Reset Steer (Lucide icon `list-restart`); fix hover bug (highlight sticks to the entry
   that opened a submenu); no third menu level for handover confirmation, yet an elegant,
   unambiguous confirmation. Determine which problems are factory vs native Paseo menu.
5. **Reset Steer.** Runs directly, no confirmation; resets the current steer tab; cheapest
   context renewal; resumes from the newest valid work state; uses the model selected in the
   native prompt input at reset time; opens a fresh provider session in the same tab;
   clears visible chat history only if enabled in
   settings; keeps identity, control authority, workers; then follows the configured resume
   strategy. Context reset and chat-history deletion are different things; providers that
   cannot separate them are handled transparently (no silent history deletion, no silent tab
   replacement). Collapse Resume/Fresh/Refresh/Clear/Rewind/Context Renewal for the user.
6. **Handover.** User only picks the target steer; factory decides how to prepare it: keep
   warm reusable context, reset a cold target before continuing, handle large/unsuitable or
   model-changed contexts, newest valid checkpoint as basis, workers kept, no needless
   prompts to the previous steer, no duplicate briefs or worker results. No user choice
   between "Resume and hand over" and "Confirm handover". Possible UX: pick target with an
   inline confirmation area saying whether context is reused or renewed. Show only relevant
   targets (no duplicate holders, advisors, other unsuitable).
7. **Create Steer.** Uses backend policy to suggest a steer (preferences, existing steers,
   providers/accounts, quota, capability, efficiency, role/privacy); user may override.
   Review steer-add/preview and init strategies Send/Composer/Later. Creating a steer in a
   project is separate from changing global preferences; no need to configure a global slot
   first.
8. **Factory tab.** Replace the CLI-like GUI with a reactive project overview. Idea:
   Overview (controlling steer, model, task, next step, checkpoint state, tests/blockers,
   worker activity, interruptions, effective automation strategy); Steers (present steers,
   control, models/accounts, cache, context size, availability, actions, effective
   preferences); Resources (provider/account quota, windows/resets, ZeroSub, alternatives,
   preferred and eligible worker models, why models are skipped); Activity (handovers,
   renewals, failovers, worker recovery, pending deliveries, errors, automatic decisions).
   Reuse steer feed, quota projection, checkpoints, worker register; no second routing or
   recovery logic in the UI; no raw UUIDs/epochs/plan hashes as primary UI (detail views
   only). Scope derived from the current workspace, no scope input. Hub/domain without
   cluttering the project view.
9. **Onboarding.** Host onboarding (Paseo/providers, host config, model preferences,
   efficiency/automation strategy) vs project onboarding (detect workspace and existing
   steers, adopt agents, create first steer, establish control). A configured host is not
   set up again per project. Question whether GitHub owner and checkout root are required for
   all scope kinds. A single steer is a valid entry point.
10. **States.** Separate control authority, runtime status, cache warmth, context size,
    provider/account availability, quota, interruption, pending factory operations. A steer
    can be controlling, idle and cold at once. Compact pill shows the most important state;
    details via tooltip/menu/Factory tab. Is "needs resume" still a useful visible state?
11. **Automation and consistency.** Supervision, worker wakes, watchdog, failover, boot
    recovery: auto-resume after interruptions, quota failover, optional auto-create, cache-
    and context-aware worker wakes, daemon restarts, interrupted workers, pending worker
    reports, missing/stale checkpoints, resume after drain, no failover loops, no needless
    model turns, no duplicate agents or deliveries. Keep locks, epochs, fingerprints, unique
    holder resolution, persistent delivery state. Simpler UI must not weaken consistency.
    Address FINDINGS.md.
12. **Efficiency as decision criterion**, not trying preferred models in order: task
    suitability, cache warmth and expected context cost, context size, remaining quota,
    account availability and resets, initialisation cost, existing steers, error history,
    role/privacy. Hard eligibility, privacy and safety rules are never traded for
    efficiency. Deterministic decisions without model calls where state suffices. Build on
    efficiency-metrics.md; never claim unmeasured quota savings.

## Expected approach

Analyse the actual state including uncommitted local changes; understand why mechanisms
exist; find contradictions and needless complexity; challenge decisions that work against
the goal; prefer reuse and simplification; verify real Paseo interfaces and provider
capabilities; one consistent target picture for backend, settings, frontend, CLI and
automation; consider migration, existing installations, running workspaces, regression
tests; docs, visible actions and behaviour must agree. Mockups and categories are hints;
better solutions are welcome with reasons.

## Research (read-only workers, one report each)

- research-settings.md — configuration, model preferences, policy
- research-ui.md — steer menu/pill, Factory tab, hover bug, slash commands
- research-lifecycle.md — reset/rewind/fresh/refresh/resume, handover, steer-add
- research-automation.md — supervision, failover, recovery, efficiency, FINDINGS mapping

Baseline reconciliation (P0) is in progress. The implementation plan tracks
the remaining delivery gates.
