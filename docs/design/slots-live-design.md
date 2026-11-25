# Live steer slots and plugin-only settings

A slot identifies one live steer within a Factory scope. Factory assigns the letter when it creates
or adopts the steer. The running agent supplies its provider and model. Model priorities in
Factory settings govern creation. Both the plugin and the shell CLI use the plugin's effective settings.

## Current state

| Area | Definition and consumers today |
| --- | --- |
| File config | `src/config.mjs` loads the JSON file, validates `profiles`, `steers.slots`, `steers.prepare`, `steers.initialActive` and `workers.priority`, and supports `workers.defaultProfile` as a legacy worker fallback. Its helpers resolve role, sensitivity and profile by slot. |
| Model selection | `src/models.mjs` derives a steer slot's fallback order from surrounding configured slots. It also implements slot/profile and worker-priority edits that the CLI can write to the file. `src/steer-add.mjs` checks both configured and live occupancy, selects a startable profile, and prepares a slot/profile config edit alongside creation. |
| Provisioning | `src/planner.mjs` plans `prepare` or `--slots`, derives the active letter from `initialActive`, and checks adoption and live agents against the configured set. `src/apply.mjs` stores those options in the authorization, re-plans under lock, and reconciles creation through idempotency keys and receipts. |
| Live state | `src/discovery.mjs` finds labelled steers and candidates, resolves ZeroSub continuations and marks older same-letter holders superseded when creation times identify a unique newest agent. `src/steer.mjs` switches among discovered holders but reads advisor, sensitivity, quota pool and expected model from slot profiles. Fresh starts from the slot profile and its configured fallbacks. `plugin/server/supervise.ts` uses slot profiles for advisor and pool checks. `src/supervision.mjs` builds the failover chain from live rows, with slot order and quota/account adjustments. |
| Plugin settings | `plugin/shared/settings.ts` defines host `factory-config` v2 with `profiles`, `slots`, `prepare`, `initialActive`, `workerPriority`, quota and host fields. `plugin/server/config.ts` reads the file and overlays saved settings. Its settings-only path requires GitHub owner and checkout root. `plugin/client/settings-factory.tsx` edits the overlay, including slots, preparation and initial active steer. |

## Data and settings

- Keep named profiles, shared by `steerPriority` and `workerPriority`. A profile carries provider,
  model, optional thinking and mode, advisor and sensitive flags, and an optional quota pool.
  Named entries let a single edit update both creation lists and preserve current worker failure
  reporting by profile name. Both lists contain unique references. Steer priority requires at
  least one coordinator profile. Worker priority excludes advisor profiles and retains the
  public-repository and sanitized-brief safeguards for sensitive providers.
- Store quota thresholds and sampling interval, GitHub owner, and checkout root in the host
  document. Require the owner and root for GitHub provisioning. A local scope with an explicit
  path can use the plugin's defaults before GitHub setup. Carry forward supported file-only
  preferences in the plugin where needed, including clone protocol, upstream remote, title
  templates, active marker, handoff language, context warnings, catalog exceptions and advisor
  purpose mappings. Keep display, cleanup, resume and supervision in their existing documents.
- Retain `wsf.scope`, `wsf.role` and `wsf.slot` labels and scope state in Paseo. Track each
  assigned letter's holder ID and generation in scope metadata, with a record of superseded
  and released IDs. Keep the active letter for display and bind coordination to its holder
  ID and scope epoch. The metadata also records the holder's coordination role and any
  explicit quota-pool or privacy classification. Profile edits affect future creation.
- Status, routing and refresh read provider/model from the resolved live agent; use the agent's
  effective thinking/mode when available. An agent's actual ZeroSub account takes precedence
  for quota decisions. A saved pool override applies only to the provider/model it was
  recorded for; otherwise use the live provider's pool. Re-evaluate privacy on any provider
  change and block sensitive payloads when classification is uncertain. Surface ambiguous
  roles for review and omit them from automatic handoff. Profile name is optional creation
  provenance.

## Slot lifecycle

- Allocate the lowest free letter A–Z per scope. Gaps can be reused without renumbering.
  Closed or background tabs still occupy their letter. On exhaustion, report all letters in
  use and show the occupied slots. Titles are adoption hints; labels and holder identity
  determine occupancy. Duplicate or half-labelled candidates that make ownership ambiguous
  require explicit resolution.
- `steer add` previews the next letter and uses the first startable coordinator profile from
  `steerPriority` or an explicit one-run model/profile choice. Use an explicit advisor choice to
  create a second-opinion steer. Adoption takes an explicit agent ID, verifies its scope,
  workspace, role and parent, and assigns a free letter. Adopting an already registered holder
  is idempotent. Advisor or privacy classification that cannot be resolved safely is reviewed
  at adoption. Neither operation writes a profile or reserves a slot in settings.
- Fresh replaces the existing holder at the same letter. Try its live provider/model and
  effective options first, then role-compatible creation priority if a replacement model is
  needed. Show the actual choice in preview and keep the role and privacy safeguards. Rewind
  keeps the ID and letter. A verified ZeroSub continuation carries the same letter and
  classification to the continuation ID. Preserve checkpoint and worker lineage in both paths.
- Release a letter when its current holder is archived and outstanding transitions are
  reconciled. An older superseded holder can remain visible in history and cannot reclaim
  the letter when the current holder disappears. An unarchived former holder requires review
  if its letter has been released. If the active holder disappears, keep the checkpoint and
  explicitly record the vacancy before reuse; a new holder at that letter needs activation.
  Bind worker ownership and queued handoff/wake requests to holder ID and generation so
  letter reuse cannot attach old work or authorize a stale request. For legacy letter-only
  ownership, recover from parent lineage where possible and surface unresolved workers.
- Keep the shared apply lock while provisioning a workspace. Once it exists, use the same
  workspace lock for allocation, adoption, fresh and slot reconciliation across CLI and
  plugin. Re-read holders and scope epoch under lock. Bind previews and creation keys
  to scope, generation, exact request and the previously observed holder state. Journal the
  pending request before creation, verify receipts on retry and publish the new holder only
  after verification. Pending generations block further allocation until reconciliation.

## Switch and failover

Explicit `switch --to B` resolves B to a unique live coordinator in the main workspace. Keep
the current busy-agent, parent, caller-takeover and epoch checks; recheck the target ID and
generation before activation. Show quota and cache estimates in the preview when available.
Automatic failover and manual switch suggestions share a live-candidate selector.

1. Resolve continuations and remove archived, retired, superseded, ambiguous, advisor,
   interrupted and currently ineligible agents. A closed but wakeable agent is eligible.
2. For quota failover, exclude exhausted candidates and those sharing the failing account
   or pool, unless account evidence confirms a separate usable account. Respect ZeroSub's
   existing first chance to act, account reset times and the exhaustion threshold. Prefer
   measured usable capacity; treat missing quota as unknown.
3. Within the eligible quota tier, prefer a likely reusable cache using turn activity and the
   cache profile for the live provider/model. Treat warmth as an estimate and use existing
   usage/context size when available to avoid re-prefilling a large cold context. Break ties
   by slot letter. Keep attempted holder IDs per scope epoch and bounded retries.
4. Keep domain and hub escalation, and wait for a known reset where the current policy
   calls for it. If there is no eligible target, explain why. Creating a new steer still
   requires a confirmed provisioning operation.

## Plan and apply

- Discover live steers first. An initialized scope with a live active coordinator needs no
  steer creation. For a new scope, apply explicit adoptions to the planned inventory first.
  Activate the first eligible adopted coordinator in request order, or select one initial
  coordinator from `steerPriority` and allocate its letter. Standbys are added separately.
  Put an explicit bootstrap conflict in the preview when there is no startable profile or
  there are unresolved ownership candidates. Repair an initialized scope with a missing
  active holder through a reviewed switch or bootstrap; report existing holders first.
- Preview the holder IDs for adoption and exact model/options, letter, workspace, generation
  and quota/account choice for creation. Represent activation as a checked step that refers
  to the verified holder returned by the adoption or creation operation. Until then the
  scope may have no active holder. Preserve ownership, fork/clone, scope and detach checks.
- Bind confirmation to the observed scope state, relevant effective settings and exact
  operations. On apply, reload settings, rediscover under lock, verify the authorization and
  reconcile completed steps from receipts before evaluating remaining operations. If a
  relevant setting, holder or selected model/account changed, require a new preview before
  running the changed operation. A retry after creation and before activation uses the same
  holder. A retired scope blocks provisioning.

## Settings RPC and offline behavior

Use the authenticated internal `DaemonClient.invokePluginRpc` transport already used by
ZeroSub `zerosub.state` and the in-flight `factory.prompt-settings` reader. Add a typed,
read-only RPC on plugin `workspace-factory`, for example:

| Contract | Shape |
| --- | --- |
| Request | `factory.settings.effective({ version: 1 })` |
| Success | `{ version: 1, settings: …, revisions: … }` with a validated effective snapshot, document revisions for diagnostics and the daemon's resolved shared state paths. Include the prompt preference used by CLI commands; the plugin's own handlers read through the same loader. |
| Failure | Distinguish daemon unreachable, Factory RPC unavailable or incompatible, and invalid/unready settings. Include the missing field when applicable. Auth failures remain identifiable. |

The CLI bootstraps the connection using the existing Paseo endpoint, executable and
authentication environment/defaults. These identify the daemon before settings can be read.
Credentials and password paths stay out of the response. Use daemon-resolved state paths for
shared locks, plans and receipts, independent of the shell's local state-directory defaults.
Load settings once per command, with a fresh read for guarded apply, and close the RPC
client on exit. Keep a bounded connection/request deadline. Drop the file loader and writes,
`--config` and `PASEO_FACTORY_CONFIG`. Keep local help available. Operational commands stop
before side effects if settings are unavailable, with a message such as “Factory settings
are unavailable. Start the Paseo daemon and enable Workspace Factory, then retry.” Missing
or incompatible RPCs should identify the needed Factory update. Invalid settings point to
the relevant Factory settings UI. ZeroSub's optional quota adapter can still fall back.

Inject the RPC client factory, host settings reader, scope snapshots and clock in tests.
Use fixtures for response versions, readiness, missing host fields, timeouts, auth failures
and cleanup on errors. Assert that an unreadable or deliberately invalid legacy JSON path
has no effect. Check the CLI and plugin produce identical plans from the same snapshot.

## Migration and user surfaces

- Migrate `factory-config` v1 through v2 into v3. Build `steerPriority` from the saved
  `initialActive` coordinator, then saved prepared coordinators, then remaining slot
  coordinators by letter, deduplicated. Retain advisor profile definitions for explicit
  use, `workerPriority` and existing host values. Remove `slots`, `prepare` and
  `initialActive` from settings. When host values previously came from the JSON file,
  show which fields need to be entered in Factory settings. The old file stays on disk
  and is ignored, including alternate paths. Outstanding plans from the former format
  require a fresh preview.
- Reconcile existing scopes from Paseo labels, the active state, continuation and handoff
  evidence. Preserve existing letters and the active holder when it resolves uniquely.
  Surface ambiguous duplicates or classification for review; model match alone cannot
  reconstruct advisor or privacy flags. Keep such candidates out of automatic takeovers
  until classified. Preserve checkpoints and worker assignments where identity is known.
- Replace Settings slot/prepare/initial controls with ordered Steer models and Worker
  models. Keep named profile editing and catalog validation. Show actual live models,
  available letters, disabled targets and reasons in the scope panel; remove expected-model
  mismatch warnings based on old config. Update CLI and `/factory` usage, previews and docs
  together. `steer set`, `slot add/rm`, `--slots` and CLI profile/priority writes point users
  to Factory settings or the live steer actions. `steer add` and `plan --adopt` take model and
  agent choices respectively; legacy letter-selection syntax receives a migration hint.
  `status`, `models`, `fresh`, `switch`, `worker pick`, supervision and quota views consume the
  new snapshot or holder data. `--adopt-worker …@B` validates B against a live or planned
  holder and persists the resolved identity.

The main risks are stale messages after letter reuse, loss of file-only setup or agent
classification, cache estimates that make a poor tie-breaker, and a CLI/plugin version
mismatch on the internal Paseo client. Counter these with identity/epoch guards, visible
setup and review prompts, cache ranking behind quota, and a versioned RPC with explicit
errors. Keep CLI and generated `plugin/server/factory` modules in sync via `npm run plugin:sync`.

## Implementation sequence

| Review step | Tests |
| --- | --- |
| 1. Add the effective settings loader, RPC and v3 migration tests. Build the new snapshot from plugin settings only, with the old entry points still using their current schema during development. | v1/v2 documents, defaults, read-only RPC, transport errors and timeout, local-only setup, CLI/plugin snapshot parity and a fixture that detects legacy file reads. |
| 2. Add shared holder resolution, generation and adoption/replacement primitives. | Existing labels and sparse slots, archive/reuse and unarchive, superseded duplicates, rewind and ZeroSub continuation, generation guards, concurrent mutation and receipt recovery. |
| 3. Use live holders in status, resume, switch, worker ownership and supervision. | Actual model after a profile edit, advisor/privacy exclusions, quota/account/reset filtering, warm/cold/unknown cache ranking, stale wakes, and domain/hub escalation. |
| 4. Cut plan/apply and add over to dynamic allocation and make the CLI use the RPC. Enable v3 settings with the UI in step 5 in the same release. Remove the JSON loader and file writes, and reject old confirmations. | Empty, adopted-only, initialized and retired scopes; preserved checkpoints; missing host setup; plan drift and retry between create and activate; two competing allocators. |
| 5. Update settings and scope UI, composer/CLI help, and setup docs. | Priority reorder/validation, migration and readiness messages, CLI and composer argument handling, and manual preview → confirm → switch smoke test. Run the root and plugin suites and plugin typecheck at each step. |

## Product decisions (2026-11-25)

1. `plan`/`apply` provisions exactly one coordinator per scope; every further steer is added on demand with `steer add`.
2. Legacy steers whose advisor or privacy classification is unclear default to neither advisor nor sensitive; the classification is optional and is configured in the Factory panel.
3. A manual switch to a holder whose account is measured as exhausted asks for confirmation (warning with reset time and a better target) before it runs.
4. Settings UI fields only for what is needed: GitHub owner, checkout root, steer and worker model priorities, quota thresholds. All other former file options use fixed defaults; fields are added later only on demand.
