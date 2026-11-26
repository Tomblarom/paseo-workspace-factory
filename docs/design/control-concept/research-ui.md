# User interaction surfaces: research

Evidence: source inspection on 2026-11-26, not a live UI reproduction. Factory
files were being edited concurrently; the references describe the observed
working tree, not necessarily a released or settled implementation.
`Paseo@v0.17.4` below means the public source tag at commit
`2b3559b107243306986176b80beb0e779f9fe53e`. Facts are source-verified unless
explicitly marked **Inference**, **Assumption**, or **Open**.

## 1. Current state

### Steer pill and menu

- The client subscribes to `factory.steers` and registers one persistent native
  composer pill per returned steer; worker attention uses a different feed and
  pill. History-only tabs without a composer are skipped. The pill is patched
  in place and the menu only replaced when its serialized descriptor changes,
  avoiding remounts on ordinary feed ticks. On disconnect it keeps membership
  but displays unknown. `plugin/index.client.tsx:188-265`,
  `plugin/client/steer-pill.ts:416-513`.
- The host-wide feed combines live agent data, workspace metadata, settings,
  ZeroSub and quota samples; it pushes on subscription and lifecycle events
  plus a shared minute timer, not per-agent polling.
  `plugin/server/steer-feed.ts:144-207,219-249,319-371`;
  `plugin/index.server.ts:228-253`.
- The face is `slot · state`, or `slot · settings changed`. Hover text adds
  Active/Standby/Advisor/Retired, tokens and quota summary; the visible face
  does not show all lower-priority facts. `plugin/client/steer-pill.ts:220-303`.
- Current menu, in order (conditional entries explicitly marked):
  1. **Revert settings** and **Continue with fresh context…**, only on an
     observed settings change; revert can be disabled.
  2. **Create steer…**: preview, then confirm. Creation does not hand over.
  3. **Hand over to…**: holder submenu, then a target-specific preview.
  4. **Resume…** for `needs-resume`, otherwise **Refresh context…**.
  5. **Change settings…**: same-provider model, thinking, speed and route preview.
  6. **Initialize staged brief…**, only when present; send or dismiss.
  7. **Open Factory**. Separators divide warning and navigation sections.
  `plugin/client/steer-menu.ts:14-45,358-472`;
  `plugin/client/steer-menu-content.tsx:333-366,501-595,865-930`.
- Menu entries are native `menu`/`popover`/`action` descriptors; each
  target's confirmation is a separate popover, not a custom row embedded
  directly in the handover menu. `plugin/index.client.tsx:57-121`.
- Handover lists rows in the same scope sorted by slot and agent ID; it includes
  the current tab as well as other holders. The active row is disabled.
  Advisors, retired, ambiguous or unknown, running/initializing, waiting,
  permission-pending and quota-limited rows are disabled with a reason.
  A `needs-resume` row is eligible and marked as needing recovery.
  `plugin/client/steer-menu.ts:111-182,400-427`.
- The scope's live-title rule is authoritative: a parentless main-workspace
  tab titled `Steer X` holds X; duplicates are ambiguous, continuation rules
  apply, and archive frees the slot. The feed resolves holders and marks
  duplicates ambiguous before the client filters them.
  `docs/design/slots-live-design.md:17-29`;
  `plugin/server/steer-feed.ts:169-203`.
- Handover preview shows epoch change, packet size and checkpoint presence.
  **Confirm handover** uses configured delivery (`send`, `composer`, `later`);
  **Resume and hand over…** additionally appears for a `needs-resume` target
  with an allowed route and calls the *same* switch confirmation with forced
  `send`. It does not directly invoke the resume RPC.
  `plugin/client/steer-menu-content.tsx:373-419,742-771`;
  `plugin/shared/settings.ts:144-153`.
- Sent switch delivery passes through server delivery policy: it may send a
  brief into a warm/cooling context or renew by clear/rewind, depending on size,
  warmth, recovery and settings. Authority can already have changed when
  delivery becomes pending or fails. Composer staging waits up to five seconds,
  then falls back to sending; `later` keeps a staged packet.
  `plugin/server/core/steer.mjs:906-955`;
  `plugin/server/steer-delivery.ts:133-149,754-769`;
  `plugin/client/steer-menu-content.tsx:209-258,294-323`.
- Refresh route: blocked during running, waiting, permission, retired or
  unknown; limited yields quota details. Claude with clear allowed and history
  not kept uses resume preview/apply; otherwise fresh preview chooses rewind or
  replacement. Codex is routed to fresh/rewind. Resume can take over the slot.
  `plugin/client/steer-menu.ts:190-248`;
  `plugin/client/steer-menu-content.tsx:421-479,773-822`.
- Settings preview offers catalog choices and explains `Apply here` versus
  `Refresh`; maximum-efficiency lock can disable it. Revert restores the
  observed turn-end tuple only if server validation permits.
  `plugin/client/steer-menu-content.tsx:501-595,865-930`;
  `plugin/client/steer-menu.ts:454-465`.

### State dimensions and “needs resume”

- A single prioritized face mixes membership/ownership (`unknown`, `retired`),
  runtime (`running`), quota (`limited`), pending operation (`waiting`),
  interruption (`needs-resume`), context readiness, cache age and context
  size (`ready`, `cold`, `large`, `cooling`, `warm`). Connected/membership
  checks precede these; a special resume fallback precedes waiting.
  `plugin/shared/steer-state.ts:29-58,790-875`.
- `needs-resume` is a Factory recovery projection, not proof that the provider
  session is unusable or that context must be cleared. It covers restart,
  failed turn, recovered limit and unrecovered interruption, subject to
  higher-priority conditions. `cold` is a separate refresh recommendation.
  `plugin/shared/steer-state.ts:815-857`.
- The turn hook marks failed steers as `limit` or `failed` using best-effort
  error-text patterns; successful ordinary turns clear the flag. Boot recovery
  can mark an open turn or recently active steer after daemon restart; closed
  alone is insufficient and advisors qualify only with an open turn.
  `plugin/server/turn-hook.ts:427-448`;
  `plugin/shared/idle-cleanup.ts:50-88,100-125`;
  `plugin/server/boot-check.ts:351-362`.
- **Inference:** the one-word face hides simultaneous conditions; “needs
  resume” can mean “a prior recovery marker exists”, while the resulting
  action may simply deliver a brief rather than reset the provider session.
  `plugin/shared/steer-state.ts:790-875`;
  `plugin/server/steer-delivery.ts:133-149`.

### Factory tab and available data

- Factory is a workspace panel, opened from the pill or Command Center;
  the sidebar row opens settings, not this panel.
  `plugin/index.client.tsx:148-160,268-289,299-306`;
  `plugin/client/factory-sidebar-item.tsx:1-7`.
- The panel begins with an optional free-text project/scope/workspace/path
  field. Empty means the current workspace; Status, Plan and Resume pass this
  address to their RPCs. Scopes, Candidates, Cleanup and Quota are host-wide.
  There is no scope picker or automatically refreshing overview in this panel.
  `plugin/client/factory-panel.tsx:70-88,142-195,405-499`.
- Status renders active slot/epoch, scope kind, task, steer and worker rows and
  suggested tab order. Scopes renders a flat list of kind, active slot/model,
  epoch, checkpoint age/next, hub escalations and context usage.
  Quota renders sampled time, thresholds, session/week percentages, reset,
  and configured steer/worker pool mappings.
  `plugin/client/factory-panel.tsx:747-840,918-963`.
- Scope RPC rows also carry `domain`, `children`, domain escalations, inbox,
  restart interruptions and usage, but the Scopes panel does not render these
  hierarchy/inbox fields. CLI formatting has additional grouping/labels.
  `plugin/server/core/scopes-view.mjs:64-103,127-168`;
  `plugin/client/factory-panel.tsx:807-840`.
- Available sources are distinct: `factory.steers` is a live status
  subscription; `factory.status` includes scope checkpoint, steers and workers;
  `factory.scopes` supplies cross-scope projections; `factory.quota` supplies
  sampled pools. Worker state and turn hooks live in workspace metadata.
  `plugin/shared/factory.ts:25-54,750-773,875-918`;
  `plugin/server/core/agent-state.mjs:1-20`;
  `plugin/server/handlers.ts:175-200`.
- Lifecycle hooks notify feeds and write console/journal events, but the
  Factory panel itself does not subscribe to an activity/log stream. A
  separate timeline transformer can shorten CHECKPOINT messages.
  `plugin/index.server.ts:237-258`;
  `plugin/server/handlers.ts:1097-1101`;
  `plugin/client/checkpoint-display.ts:13-23,47-66`.
- Panel and transient slash-result pill share one module-global result; later
  commands replace it. The single transient pill expires after 60 seconds.
  This is not a per-scope dashboard or durable activity history.
  `plugin/client/factory-store.ts:119-135`;
  `plugin/client/result-pill.tsx:17,80-106`.

### `/factory` command-to-UI map

- `/factory` and `help [topic]`: help; bare command opens panel, explicit help
  uses a transient result pill. `status`, `scopes [--candidates]`, `cleanup`,
  `workers`, `models`, `quota`: read-only result pill; Status/Scopes/Candidates/
  Cleanup/Quota also have panel buttons. `drain`: result in panel.
- `plan`, `apply`, `checkpoint`, `switch`, `fresh`, `assign`, `steer add`:
  panel preview/confirmation or applied result. Pill Create/Hand over/Refresh
  reuse related RPCs but have their own popover confirmation.
- `resume --brief`: read-only brief/result pill; resume on the calling agent
  applies directly, while an explicitly different agent first opens panel
  confirmation. Panel Resume button requests the brief.
- `worker list|pick|set|rm`, `steer list|set|rm`, `model advisor|sensitive`:
  model/role list or settings change, transient result; `--dry-run` previews.
  The separate plugin settings screen also edits configuration.
- Command inventory/help: `plugin/shared/factory-args.ts:13-190`;
  dispatch and panel/pill outcomes: `plugin/client/factory-submit.ts:50-286`;
  registration: `plugin/index.client.tsx:161-185`.

## 2. Contradictions, redundancies, superseded parts

- The slot decision explicitly overrides older “superseded holder” wording in
  the same design document. Feed now filters archived/origin tabs, yet pill,
  menu and state code retain `retired`/successor presentation paths; scope
  retirement and recorded replacement can still produce retired, so these
  branches are not all proven dead.
  `docs/design/slots-live-design.md:17-29,59-80`;
  `plugin/server/steer-feed.ts:177-195,226-233,275-281`;
  `plugin/shared/steer-state.ts:797-804`.
- `handoffTargets` includes self, so its “no other holders” fallback is not
  reached merely because self is the only row. An inactive self can be an
  eligible takeover candidate; whether that is desired is a product question.
  `plugin/client/steer-menu.ts:149-167,400-409`.
- Unknown status is labeled “Ambiguous membership” even when its cause is
  merely insufficient data; separate explanations would avoid a false claim.
  `plugin/client/steer-menu.ts:120-122`;
  `plugin/shared/steer-state.ts:874-875`.
- “Resume and hand over…” and “Confirm handover” do not expose two distinct
  recovery algorithms: both switch; the former forces immediate send and
  server policy selects renewal. The former can still send warm context as-is.
  Naming them as guaranteed different resets would be misleading.
  `plugin/client/steer-menu-content.tsx:381-395,742-768`;
  `plugin/server/steer-delivery.ts:133-149`.
- The shared result store can display a result initiated in another scope or
  tab; the tab's text input does not establish a scoped result namespace.
  `plugin/client/factory-store.ts:119-135`;
  `plugin/client/factory-panel.tsx:86-88,417-425`.
- An existing finding reports arbitrary active selection for duplicate titles,
  but the concurrently edited scope projection now explicitly returns no
  active holder unless exactly one is found. Treat the finding as potentially
  superseded, not as verified fixed without the responsible worker's result.
  `FINDINGS.md:9`; `plugin/server/core/scopes-view.mjs:29-36`.
- TODO already calls for live slots, plugin-only settings and clearer quota
  display; command help still describes configured steer slots. Existing
  finding documents conflicting worker write instructions.
  `TODO.md:17-23,56-58`; `plugin/shared/factory-args.ts:159-170`;
  `FINDINGS.md:11`.

## 3. Verified native/provider constraints

- **Native hover cause, source verified; runtime reproduction open:** in
  `Paseo@v0.17.4:packages/app/src/components/ui/menu/menu-sub.tsx:66-103`,
  the open submenu trigger gets `active={isOpen}`. The host gives active and
  hovered rows the same `surface2` fill
  (`.../menu/menu-item.tsx:373-381,546-555`).
  Thus the opener remains highlighted while its page stays open, independently
  of Factory hover code. The hover grace is 260 ms; entering the flyout cancels
  closure (`.../menu/menu-surface.tsx:41-47,181-202,329-341`).
- For nested popover confirmation pages, `hoverIntent: false` additionally
  locks pointer-driven close while open; these pages open by selection.
  `Paseo@v0.17.4:packages/app/src/plugins/buttons/view.tsx:220-239`;
  `.../components/ui/menu/menu-surface.tsx:247-260`. **Inference:** this
  makes the original highlighted trigger persist during confirmation. A live
  reproduction is still needed to establish the exact reported pointer path.
- Plugin menu entries are only item or separator; an item can have nested menu,
  action or arbitrary React popover content. Therefore a non-item confirmation
  area cannot be a *direct child* of a native menu, but can be a popover
  reached from a submenu item, as Factory already does.
  `Paseo@v0.17.4:packages/plugin/src/client/buttons.ts:12-29`;
  `.../app/src/plugins/buttons/view.tsx:143-176,220-239`.
- Lucide names are looked up as exact exports, not kebab-case names.
  Release dependency is `lucide-react-native ^1.50.0`; locally installed
  1.50.0 exports `ListRestart` and has `dist/cjs/icons/list-restart.js`.
  Use `ListRestart`, not literal `list-restart`. The source contract and local
  package were inspected; actual running client's bundled version/rendering
  was not tested. `Paseo@v0.17.4:packages/app/package.json:112`;
  `.../plugins/icons.ts:22-30,59-68`.
- Popover content receives `close`, host props and workspace/agent context,
  but not `openPanel`; Factory bridges navigation via the client registration.
  `Paseo@v0.17.4:packages/plugin/src/client/buttons.ts:6-12`;
  `plugin/client/steer-nav.ts:1-20`; `plugin/index.client.tsx:299-306`.
- Provider-specific clear/rewind and delivery claims are route-dependent:
  the Factory defaults to Claude clear, Codex fresh/rewind; its native-plugin
  spike reports separate resume-prompt gaps for Claude, Muse and Copilot.
  Those are documented research, not re-tested here.
  `plugin/shared/idle-cleanup.ts:91-98`;
  `docs/design/native-plugin-spike.md:243-258,259-309`.

## 4. Options and trade-offs

1. Keep the native menu and separate confirmation popovers; clarify labels,
   distinguish unavailable reasons and show status dimensions in Factory.
   Lowest custom UI cost; inherited active/hover ambiguity remains.
2. Ask upstream, with approval, to distinguish active submenu ancestry from
   pointer hover or expose a suitable style/API. Benefits all plugins and
   preserves native accessibility; depends on upstream prioritization and
   requires a reproducible desktop test before filing.
3. Use a single custom popover for target selection and confirmation.
   Allows richer explanatory content and independent highlight behavior, but
   duplicates native menu navigation, keyboard/accessibility and interaction
   maintenance; contrary to native-first unless a verified gap justifies it.
4. Make Factory a scope-aware overview using existing feed/RPC projections,
   checkpoint/worker status and hierarchy/inbox; retain detailed actions in
   previews. Better separation of authority, runtime, recovery and quota, but
   needs explicit freshness/error states and scoping rather than treating the
   current global last-result store as authoritative.

## 5. Open questions

- Should an inactive current tab appear as a self-takeover target, and should
  disabled targets stay visible for explanation or be filtered out?
- Should recovery handover always force renewal, or merely immediate delivery
  under policy? What wording describes the actual guarantee?
- Which single pill dimension deserves priority, and where should concurrent
  recovery, quota, running and estimated-cache facts be visible?
- Should Factory default to the current workspace, remember a scope, offer a
  hierarchy selector, or have separate hub and domain views?
- Should a panel expose events/logs at all, and what native data contract,
  retention, privacy and cross-scope access would be needed?
- Can the reported hover be reproduced on the actual installed desktop/web
  build and pointer path, including confirmation and keyboard navigation?

```CHECKPOINT
task: Complete read-only research of Factory interaction surfaces in this file.
tests: Source inspection only; no runtime/UI tests or code changes.
blockers: Live hover reproduction and actual running-client icon rendering not verified; working tree changed concurrently.
next: Steer integrates findings and decides UI scope, recovery wording and any upstream proposal.
```
