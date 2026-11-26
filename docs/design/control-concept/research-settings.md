# Configuration, model preferences and policy — research

Read-only investigation, 2026-11-26. **Fact** means verified in the current
working-tree source or the stated CLI help; it does not imply a live end-to-end
test. **Design** means a documented decision or proposal, not necessarily
implemented. **Inference** is a consequence of the cited paths, not a measured
production incident. The working tree includes concurrent, uncommitted changes;
line pointers describe that snapshot.

## 1. Current state

### Authority and scope

- **Fact:** All six settings documents are Paseo **host** settings:
  `factory-config`, display, cleanup, resume, steer-menu and supervision
  (`plugin/shared/settings.ts:58`, `:84`, `:112`, `:133`, `:146`, `:161`).
  There is no project-scoped settings document here.
- **Fact:** `factory-config` contains profiles, slot/profile bindings, prepare,
  initial active, worker priority, quota and GitHub owner/checkout root. Defaults
  are one Codex profile and A, with null host fields (`plugin/shared/settings.ts:30-75`).
  V1 migration converts `workerDefault` to a list and supplies advisor/sensitive
  flags (`plugin/shared/settings.ts:5-27`).
- **Fact:** `createConfigLoader` reads only plugin settings, rejects unavailable,
  invalid or incomplete settings and builds a core config. It does not read a
  legacy config file (`plugin/server/config.ts:18-54`,
  `plugin/shared/settings-validate.ts:182-209`).
  The packaged CLI is a thin RPC client requiring the running plugin; model
  management is in the composer, not a second CLI config
  (`plugin/cli.mjs:1-22`, `:100-115`).
- **Fact:** The settings UI edits the same document, fetches provider snapshots
  and validates used profiles (`plugin/client/settings-factory.tsx:42-54`,
  `:112-125`, `:185-191`). Composer model edits plan on the server and save
  through the revision-guarded host settings RPC
  (`plugin/server/models-rpc.ts:110-165`,
  `plugin/client/factory-submit.ts:282-309`).
- **Fact:** Per-scope operational state is different from settings: workspace
  metadata stores scope identity, active steer and epoch; per-workspace profile
  health is separately stored in metadata (`plugin/server/core/scope.mjs:1-4`,
  `plugin/server/core/quota.mjs:10-11`, `:44-72`).

### Models, priorities and policy

- **Fact:** A named profile stores provider, model, thinking, permission mode,
  advisor and sensitive flags; `pool` exists in core but not the plugin schema
  (`plugin/shared/settings.ts:30-38`, `plugin/server/core/quota.mjs:75-79`).
  Thinking and mode are nullable; their null means provider default, not speed.
- **Fact:** `steers.slots` maps each letter to a profile; `prepare` selects
  planned slots, `initialActive` must be among them and cannot be an advisor.
  The UI explicitly edits each of these (`plugin/server/core/config.mjs:164-181`,
  `plugin/client/settings-factory.tsx:300-403`).
- **Fact:** Worker priority is ordered; legacy `defaultProfile` falls back to
  the first priority and is also written for older readers
  (`plugin/server/core/config.mjs:39-48`,
  `plugin/shared/settings-validate.ts:201-205`).
- **Fact:** Steer fallback is the slot's profile followed by subsequent and
  then preceding slots, deduplicated; a later fallback already used by a live
  steer is skipped (`plugin/server/core/models.mjs:46-63`, `:180-190`).
  `steer add` selects from existing slot order then other profiles unless an
  explicit profile is requested (`plugin/server/core/models.mjs:264-310`).
- **Fact:** Resolution skips unknown, recently unhealthy, exhausted, wrong-role
  and catalog-invalid profiles, then picks the first eligible entry; ZeroSub
  accounts take precedence where present and the roomiest eligible account is
  suggested (`plugin/server/core/models.mjs:140-202`).
- **Fact:** `worker pick`, `worker list` and `worker start` share the scoped
  resolver. It establishes repository publicity, reads per-workspace health,
  and checks ZeroSub (`plugin/server/handlers.ts:1190-1263`, `:1266-1348`).
  A `--failed <profile> --reason <text>` mark lasts 10 minutes and classifies
  capacity, quota, limit, auth or other; it is workspace-local and verified
  after writing (`plugin/server/core/quota.mjs:8-40`, `:55-72`).
- **Fact:** An advisor profile cannot be picked as a worker or initial
  coordinator; advisor role text is read-only. Sensitive workers require a
  provably public repo and a sanitized brief; unknown publicity is treated
  as private (`plugin/server/core/models.mjs:169-179`,
  `plugin/server/core/role-prompts.mjs:21`, `:36-42`).
  Sanitization of the task itself is an instruction, not content inspection.
- **Fact:** Migrated Muse profiles default sensitive unless explicitly set;
  explicit flags win. Provider-level adoption classification is sensitive
  if any profile for that provider is sensitive
  (`plugin/shared/settings.ts:12-19`, `plugin/server/core/config.mjs:61-89`).
  Sensitive steer profiles are not generally blocked; the planner's
  private/unknown adoption guard applies to a sensitive-provider **mismatch**
  (`plugin/server/core/models.mjs:125-129`,
  `plugin/server/core/planner.mjs:219-231`).

### Quota, cleanup and native options

- **Fact:** Defaults are warn **93%**, exhausted **95%**; both are 0–100
  settings (`plugin/shared/defaults.mjs:14-18`,
  `plugin/shared/settings.ts:69-72`). `warnPct` informs status/briefs;
  `exhaustedPct`, provider limits and `limitedUntil` affect eligibility
  (`plugin/server/core/quota.mjs:139-149`, `:232-277`).
- **Design:** Warn should not trigger its own turn or proactive handoff;
  95% is used on an otherwise due delivery. Defaults are pragmatic, not
  empirically tuned (`docs/design/quota-independence.md:247-265`).
  Shared admission before renewal remains open (`TODO.md:10`).
- **Fact:** Sampling defaults to a minimum 10 minutes, polled on a one-minute
  timer; the shared freshness rule is two sample intervals, normally 20 min
  (`plugin/shared/defaults.mjs:18-30`, `plugin/server/quota.ts:87-112`).
  Admission separately hard-codes a 30-minute sample window
  (`plugin/server/steer-admission.ts:17-29`).
- **Fact:** There are two independent quota objects: `factory-config.quota`
  and `factory-supervision.quota` (`plugin/shared/settings.ts:69-72`, `:174-178`).
  Supervision prefers effective config then supervision then defaults
  (`plugin/server/supervise.ts:616`, `:663`, `:1388`).
  Cleanup instead reads the supervision object through `readQuotaSettings`
  (`plugin/index.server.ts:123-125`, `:329`,
  `plugin/server/cold-sweep.ts:699-706`).
- **Fact:** The UI's *Maximum efficiency*, *Balanced* and *Comfort* are
  **cleanup/cache profiles**, not model or quota presets
  (`plugin/client/settings-cleanup.tsx:53-58`).
  Given TTL T minutes, compact starts at max(1, floor(T/2)), at
  T − max(2, clamp(round(T/6), 1, 10)), or at T − 2 respectively.
  Efficiency lowers the configured compact floor to at most 10,000 tokens;
  the others retain it (`plugin/shared/cache-profiles.ts:89-115`, `:181-184`).
- **Fact:** Profiles act on compact timing, not all cleanup: clear uses its
  own idle and size thresholds. Cleanup also checks mode, provider, role,
  permission, status, supervision and checkpoint
  (`plugin/shared/idle-cleanup.ts:409-458`). Defaults are mode `clear`,
  `balanced`, 60 idle minutes, 100,000 tokens, Claude, both roles and 20/day;
  clear requires acknowledgment (`plugin/shared/settings.ts:112-127`,
  `plugin/shared/idle-cleanup.ts:417-420`).
- **Fact:** Maximum efficiency additionally locks Factory's steer model,
  thinking and speed editor for running/warm/cooling contexts; the route
  requires Refresh. Other profiles still route risky changes through Refresh
  (`plugin/shared/steer-settings.ts:308-325`, `:352-380`).
- **Fact:** Factory profiles duplicate native provider/model/thinking/mode
  choices; native `paseo run --help` independently lists `--provider`,
  `--model`, `--thinking` and `--mode`. Factory uses a live provider catalog
  and validates model thinking options and provider modes
  (`plugin/server/core/config.mjs:264-300`).
  The Factory steer editor reads the live tuple and writes model, thinking and
  speed to the individual agent (`plugin/server/steer-settings.ts:94-104`,
  `:319-376`).
- **Fact:** Speed is not in the creation profile. The editor maps Claude speed
  to `fast_mode` and Codex speed to `service_tier`; choices/validation are
  provider-specific rather than a universal speed catalog
  (`plugin/server/steer-settings.ts:128-139`,
  `plugin/shared/steer-settings.ts:265-285`, `:509-533`).
  `paseo agent update --help` exposes `--thinking` but not model or speed;
  that help alone does not establish other native API/UI capabilities.

## 2. Contradictions, redundancies and superseded parts

- **Design vs fact:** Membership is now the live title `Steer X` in the
  main workspace; duplicates are ambiguous (`docs/design/slots-live-design.md:17-28`).
  The older plan's claims that labels/holder metadata determine occupancy
  and that older holders are superseded predate this decision
  (`docs/design/slots-live-design.md:57-76`).
  Configured letters, `prepare`, `initialActive`, slot-profile binding,
  letter-derived model priority and profile alignment are consequently
  candidates for deletion/replacement, **not yet removed**
  (`TODO.md:23`, `plugin/server/core/models.mjs:50-63`).
- **Fact:** Fresh replacement still starts from the configured slot profile and
  fallback, not necessarily the live model (`plugin/server/core/steer.mjs:1207-1215`,
  `:1413-1420`). A drift warning suggests a `steer set` command
  (`plugin/server/core/steer.mjs:1229`, `:1431`,
  `plugin/server/core/models.mjs:65-93`).
- **Fact / inference — global preference leak:** The per-agent editor calls
  native agent writes, not the host profile writer
  (`plugin/server/steer-settings.ts:319-376`). But accepting the suggested
  `steer set X provider/model` targets the existing slot profile by default;
  that profile can also be a worker or another slot. It is updated in place,
  with warnings, and the composer saves the result **host-wide**
  (`plugin/server/core/models.mjs:366-374`, `:450-457`, `:593-650`,
  `plugin/client/factory-submit.ts:299-309`). A live per-agent change is
  therefore not itself proven to mutate preferences; the alignment action can.
  Separately, confirmed `steer add` saves its planned host settings before
  creation (`plugin/server/handlers.ts:1531-1573`,
  `plugin/client/factory-panel.tsx:322-324`).
- **Fact:** Worker pick/list/start do not pass a sampled pool snapshot into
  `resolveWorkerPick`, despite its accepting one; without ZeroSub account
  data the pool check therefore sees null. The brief's `workerModelLine`
  passes neither ZeroSub nor a pool snapshot, so its selection can differ
  from scoped pick (`plugin/server/handlers.ts:1257-1263`,
  `plugin/server/core/models.mjs:140-165`, `:351-359`).
  The global models list assumes a public repo and omits workspace health;
  its selected entry is not a scope-specific authorization
  (`plugin/server/models-rpc.ts:72-95`).
- **Fact:** Quota duplication is behavioral, not just duplicate schema:
  config-driven selection/feed and supervision can use one threshold while
  automatic cleanup uses the separate supervision threshold
  (`plugin/server/steer-feed.ts:163-164`, `plugin/index.server.ts:125`, `:329`).
  The steer settings refresh calls `resolveQuota` without passing configured
  `exhaustedPct`; that resolver then falls back to 95%
  (`plugin/server/steer-settings.ts:514-525`,
  `plugin/shared/steer-state.ts:296-300`).
- **Fact:** `preferredQuotaPool` and the account choice in `formatQuotaLine`
  call quota helpers without forwarding a configured exhaustion threshold,
  hence use the default for those suggestions
  (`plugin/server/core/quota.mjs:253-273`).
  Core quota validation is nested under `if (config.usage !== undefined)`,
  so it does not validate quota at all when `usage` is absent; the plugin
  validator independently validates it (`plugin/server/core/config.mjs:211-225`,
  `plugin/shared/settings-validate.ts:116-126`).
- **Fact:** UI hints still say 75/90 while actual defaults and documentation
  say 93/95 (`plugin/client/settings-factory.tsx:643-644`,
  `plugin/shared/defaults.mjs:15`, `docs/configuration.md:25`).
  Neither validator shown enforces warn ≤ exhausted
  (`plugin/shared/settings-validate.ts:116-126`).
- **Fact:** Catalog validation is implemented separately in core and
  browser-safe shared code; a shared exception table records a Copilot/Claude
  thinking mismatch (`plugin/server/core/config.mjs:264-300`,
  `plugin/shared/settings-validate.ts:315-387`,
  `plugin/shared/defaults.mjs:47-60`). Live catalog and saved profiles are
  intentionally different: one is availability, the other is desired policy.
- **Fact:** `knownLimits`, `pool`, `usage.warnContextTokens`,
  `steers.activeMarker`, `handoffLanguage` and `runtime` remain in core
  interfaces, but are not emitted by settings conversion
  (`plugin/server/core/config.mjs:16-35`, `:173`, `:182-190`, `:211-215`,
  `plugin/shared/settings-validate.ts:185-209`). `pool` is also omitted when
  converting a core profile back to settings (`plugin/shared/settings-validate.ts:42-62`).
  Runtime environment overrides still exist; handoff defaults to English
  (`plugin/server/core/runtime.mjs:20-36`).
- **Fact:** `workspaceTitle`, `workspaceTitleMultiRepo`, clone protocol and
  upstream remote are retired planner knobs, though still accepted/validated;
  conversion emits `Main`, `https`, `upstream`
  (`plugin/server/core/config.mjs:104-112`,
  `plugin/shared/settings-validate.ts:190-197`).
  Scope design says titles are renamed natively (`docs/design/scopes-design.md:69-73`);
  the older slots draft's request to carry title templates forward is not
  evidence they still work (`docs/design/slots-live-design.md:38-44`).

## 3. Verified constraints

- **Fact:** The loader currently requires owner and absolute checkout root
  before **any** factory operation, regardless of scope
  (`plugin/server/config.ts:35-51`). This is a global validation constraint,
  not proof that each scope semantically needs GitHub.
- **Fact:** GitHub discovery calls `resolveGitHub` with owner; explicit local
  and workspace branches return before that call
  (`plugin/server/core/discovery.mjs:843-852`).
  However all normalized entries currently use `parentDir ?? checkoutRoot`
  and the runner scans `checkoutRoot` plus entry roots
  (`plugin/server/core/discovery.mjs:174-195`,
  `plugin/server/core/factory.mjs:38-49`). Removing the loader gate alone is
  insufficient: those path and scan assumptions also need a safe fallback.
- **Design:** GitHub needs owner/root for provisioning; a local explicit-path
  scope should work before GitHub setup (`docs/design/slots-live-design.md:38-42`).
  Current K13 design enrolls existing checkouts/workspaces rather than
  provisioning them (`docs/design/scopes-design.md:31-41`); assess separately
  whether existing GitHub scope discovery truly needs a configured fork owner.
  `hub` is a dir/workspace-like scope; a domain is a role/logical pointer,
  not a fifth scope kind (`plugin/server/core/scope.mjs:12`,
  `docs/design/scopes-design.md:50-53`, `:84-86`).
- **Fact:** `paseo run --help`, `paseo agent update --help` and
  `paseo provider --help` were inspected read-only: native create supports
  model/thinking/mode and provider models can be listed; agent update exposes
  thinking. No account data or provider catalog was fetched.
- **Previously documented evidence, not re-tested:** Paseo 0.17.4 lifecycle
  hooks and provider option boundaries were investigated against the installed
  bundle (`docs/design/native-provider-capabilities.md:3-25`).
  The known Copilot/Claude catalog exception is an observed discrepancy, not
  proof of all providers' behavior (`plugin/shared/defaults.mjs:47-56`).
- **Fact:** Paseo's native settings edits cannot be disabled by this Factory
  editor; the documented response is detect/revert/refresh, not a pre-change
  veto (`docs/configuration.md:157`, `TODO.md:45`).
- **Fact:** `FINDINGS.md:17` records a sensitive Muse steer planned for a
  private dir; `FINDINGS.md:39` records a worker priority conflicting with a
  workspace instruction. These are reported observations, not reproduced here.

## 4. Options and trade-offs

1. **Keep the present profile/slot system.** Smallest migration, existing
   fallbacks and tags remain. Conflicts with title-only identity and retains
   global drift, misleading slot-based policy and independent quota sources.
2. **Separate creation policy from live identity (recommended direction).**
   Host-level steer and worker priority lists may reference named creation
   profiles; live title/holder supplies identity, actual agent tuple supplies
   model, and explicit holder/role/privacy state supplies authorization.
   One-run overrides must not mutate priority. Migration must preserve existing
   roles, sensitive defaults and health semantics; ambiguous classification
   needs review, not a silent coordinator default
   (`docs/design/slots-live-design.md:31-55`).
3. **Native model selection only.** Remove factory model/thinking/mode copies
   and use Paseo's selection at creation; least duplication. This loses the
   factory's ordered cross-provider fallback, quota-aware selection and
   profile-based privacy/role classification unless independently replaced.
   Native CLI help does not establish an equivalent priority API.
4. **Quota consolidation:** Make one host policy authoritative, pass its
   threshold and sampling/freshness consistently to existing consumers, and
   distinguish provider hard limits from configured policy. Preserve unknown
   quota behavior per operation; do not claim a new common policy is already
   implemented. Fixing only the UI labels would leave behavioral divergence.
5. **Scope-aware prerequisites:** Require owner/root only in the GitHub paths
   that actually use them; derive local/workspace roots from their own locator
   or known workspace. This improves onboarding but requires explicit handling
   of scans, legacy aliases and ambiguity, not merely removing validation.
6. **Cleanup controls:** Keep cache profile separate from model policy; measure
   provider-native compaction before retaining duplicate automation
   (`TODO.md:11`). Separating the efficiency settings lock from cleanup timing
   could make its extra effect explicit, but adds a user choice.

## 5. Open questions

- Which role/privacy facts should survive a native provider/model change, and
  who confirms an ambiguous advisor or sensitive classification?
- Should sensitive steers be allowed on private/unknown scopes at all, given
  worker selection is fail-closed but current steer selection is not?
- Are worker priorities host defaults only, or do explicit project/task
  overrides need durable per-scope state? How should overrides be authorized?
- What should `workerModelLine`, list and pick show when ZeroSub or pool data
  is unavailable, stale or disagrees? Should unknown remain fail-soft?
- Should `warnPct <= exhaustedPct` be enforced, and should every action share
  the 2× sampling freshness rule or explicitly justify another cutoff?
- Does any supported native catalog expose speed choices reliably enough to
  replace hard-coded provider mapping? Verify per installed provider/version.
- Are pool overrides, handoff language and custom catalog limits real user
  needs, or should unreachable legacy core knobs be deleted instead of ported?
- How should health be keyed after profile editing: name, provider/model or
  account? A name-only cooldown can follow an edited profile for 10 minutes.

```CHECKPOINT
task: Research settings, model preferences and policy; report written.
tests: Read-only source/document review and Paseo CLI help; no runtime changes or tests.
blockers: No live provider/account validation; concurrent working-tree changes may move pointers.
next: Steer integrates findings into the control concept and decides the open questions.
```
