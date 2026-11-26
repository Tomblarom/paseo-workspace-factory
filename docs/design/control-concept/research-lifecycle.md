# Lifecycle and handover research

Read-only investigation, 2026-11-26. **Fact** means inspected source, docs or CLI
help; **inference** and **open** are labelled. The Factory checkout has concurrent
uncommitted changes, so line pointers describe the inspected working tree, not
necessarily a released build. No live agent, reset or delivery was exercised.
Paseo provider evidence below is pinned to public **v0.17.4** source, not the
older local Paseo checkout. `paseo agent --help` was also inspected.

## 1. Current state

### Authority, state and checkpoints

- **Fact:** A parentless live tab holds a slot by its `Steer X` title; duplicates
  are ambiguous. A ZeroSub continuation may inherit its origin's title. The
  marker is presentation, not authority. `docs/design/slots-live-design.md:17-29`;
  `plugin/server/core/discovery.mjs:285-316`.
- **Fact:** Scope metadata carries active slot, active agent and epoch. Under
  the workspace lock `guardScope` re-reads the epoch and unique live holder;
  advisors cannot hold authority. A switch increments epoch, an in-place rewind
  does not. `plugin/server/core/scope-guard.mjs:41-54`;
  `plugin/server/core/steer.mjs:901-925,1075-1103`.
- **Fact:** Turn hooks record turns, usage and failures. A completed active steer
  CHECKPOINT updates scope state; other steers/workers get a note. Failures
  record interruption; scope writes are fenced. `plugin/shared/auto-checkpoint.ts:264-316`;
  `plugin/server/turn-hook.ts:475-555`.
- **Fact:** Boot/restart and failed-turn flags drive `needsResume`. A brief is
  reconstructed without a model call from live scope/epoch, caller identity,
  checkpoint and interruption, Git, workers, assignments, worker-model and
  quota information; missing/stale checkpoint is called out.
  `plugin/server/boot-check.ts:225-290,352-365`;
  `plugin/server/core/steer.mjs:572-625`;
  `plugin/server/handlers.ts:218-261`.
- **Why:** The task/checkpoint belongs to the scope, not a provider session;
  short briefs and warm reuse avoid needlessly reprefilling a long context.
  `docs/design/cold-context-resume.md:147-183`; `TODO.md:6-11`.

### Continuation and reset paths

- **Read-only resume:** CLI `resume` and `/factory resume --brief` change no
  tab, session, authority, epoch, worker or delivery.
  `docs/design/cold-context-resume.md:151-159`; `plugin/server/handlers.ts:218-261`.
- **Apply resume:** `/factory resume`, menu Resume, or a confirmed foreign
  agent invokes `applyResume`. It rejects running/initializing targets and wrong
  scope, optionally checks a preview fingerprint, saves a newer valid active
  CHECKPOINT from the last answer, then uses shared delivery admission/policy.
  `plugin/server/resume-apply.ts:185-237,256-284`.
- **Takeover on resume:** Optional `takeover: true` switches an eligible
  non-active steer first, with `send: false`; failure is reported as skipped,
  and resume delivery still proceeds. An advisor cannot take over.
  `plugin/server/handlers.ts:312-370`.
- **Interrupted worker resume:** warm/small worker receives its own brief;
  cold/large/unknown goes through worker Fresh. Only interrupted workers are
  accepted, busy or replaced workers are blocked/rerouted. Rewind retains ID,
  parent and owner; replacement retains the original parent/owner and moves
  an interrupted worker's register entry, without changing scope epoch.
  `plugin/server/resume-apply.ts:44-93`;
  `plugin/server/core/steer.mjs:1541-1571,1620-1665`.
- **Shared renewal:** warm/cooling can receive original text; cold, large,
  retry and explicit manual recovery when no clear is available renew first.
  Unknown warmth: normal automatic delivery can send, manual/recovery renews.
  Claude may `/clear` only when enabled and `keepChatHistory` is false;
  otherwise renewal is conversation rewind. `plugin/server/steer-delivery.ts:133-145,751-765`.
- **Clear:** the same Paseo agent/tab survives while Claude receives `/clear`.
  The provider session must change and the turn hook must verify the effect;
  previous session ID is recorded for history import and the queued brief is
  released only after verification. An uncertain or ineffective clear blocks
  rather than claiming success. No scope epoch bump is part of clear itself.
  `plugin/server/cold-sweep.ts:604-669`;
  `plugin/server/turn-hook.ts:516-545`;
  `plugin/server/steer-delivery.ts:478-487,566-572`.
- **Menu Refresh/Resume:** state and settings select either resume-apply for
  eligible Claude without history retention, or Fresh preview for rewind/new
  agent; running, permission, uncertain and limited states block or show reset
  details. A warm Claude resume-apply may still send without clearing: it is
  not an unconditional reset. `plugin/client/steer-menu.ts:190-248`;
  `plugin/client/steer-menu-content.tsx:421-470`;
  `plugin/server/steer-delivery.ts:133-145`.
- **Fresh, same-tab:** `tryActiveRewind` and `tryTabRewind` look for a real
  `user_message` in paged canonical timeline, favoring a saved brief anchor.
  Conversation-only rewind preserves agent ID, tab, labels, slot and epoch;
  provider session may fork/change. Files are not rewound. A new brief is sent
  without source-agent ID to be a future rewindable user message, or staged.
  `plugin/server/core/rewind.mjs:33-83,134-149,193-235`;
  `plugin/server/core/steer.mjs:1083-1138,1330-1384`.
- **Fresh, replacement:** if pre-dispatch discovery finds no point/client,
  a new agent may be created from the slot profile/fallback, with a creation
  receipt. Active replacement changes active agent and increments epoch; a
  non-active replacement does neither. Old tab is renamed `Retired X` so its
  title releases membership; failure to rename is reported. The old chat
  remains in that tab. `plugin/server/core/steer.mjs:1206-1247,1259-1318,1480-1529`;
  `plugin/server/core/steer.mjs:817-829`.
- **Fresh failure safety:** after rewind dispatch, even an “unsupported” error
  is an uncertain outcome: no silent replacement or retry. Pre-dispatch
  no-point/unavailable can fall back. The confirmed rewind route is bound by
  the plugin RPC; on failure its packet is carried for staging.
  `plugin/server/core/rewind.mjs:134-149,167-189`;
  `plugin/server/core/steer.mjs:1018-1062`;
  `plugin/server/handlers.ts:456-511`.
- **Idle cleanup:** timer policy can compact warm contexts, clear Claude, or
  record a Fresh recommendation; optional `rewindFresh` can rewind a
  compact-only agent without sending a brief, preserving the previous brief
  where possible. Defaults require explicit clear acknowledgement and leave
  automatic rewind off. Guards include idle, permissions, fresh checkpoint or
  note, context floor, no unresolved action and quota for compact.
  `plugin/shared/idle-cleanup.ts:191-218,393-402,408-515`;
  `plugin/server/cold-sweep.ts:220-251,430-480,535-569`.

### Model selection and steer creation

- **Fact:** Rewind uses the existing live agent provider/model; Fresh fallback
  resolves the configured slot profile and quota-compatible fallback, and
  explicitly warns if the live model differs. Worker replacement uses the live
  provider/model, with thinking/mode from a unique matching profile or provider
  defaults. `plugin/server/core/steer.mjs:1097-1102,1206-1231,1547-1570`.
- **Fact:** Factory settings changes separately preview the live agent's
  model/thinking/speed tuple. `plugin/server/steer-settings.ts:96-122,181-227`.
- **Fact:** Paseo's client plugin composer contract exposes
  `composer.agent.provider/model/mode/thinking/options`, including on a draft,
  plus setters; `useComposers` requires a mounted plugin client. This is not a
  server-side read of an unmounted draft. See
  [v0.17.4 composer.tsx:25-64](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/plugin/src/client/composer.tsx#L25-L64).
  **Open:** prove at reset time which effective selected model the provider
  actually uses under concurrent native control changes; bind/verify it rather
  than assuming profile and prompt selection agree.
- **Steer add:** preview chooses a slot/profile or explicit provider/model,
  thinking/mode, quota/account and proposed host settings; confirmation
  re-previews, saves the global settings revision, then creates a promptless
  top-level standby via fingerprint and creation receipt. Current coordinator,
  epoch, existing workers and deliveries stay unchanged.
  `plugin/server/core/steer-add.mjs:154-218,282-320,407-438,474-499`;
  `plugin/client/steer-menu-content.tsx:333-369`.
- **Fact:** `initializeNewSteer = send | composer | later` defaults to composer,
  but the add RPC has no initialization input or brief output and its menu
  handler just reports creation. The strategies actually apply to switch,
  Fresh and settings-refresh delivery, not initial steer-add.
  `plugin/shared/factory.ts:776-833`;
  `plugin/client/steer-menu-content.tsx:294-324,333-369,382-417,456-470,532-548`.

### Handover and delivery

- **Switch preview:** validate target slot, unique title holder, advisor,
  workspace/parent, busy source/target and takeover caller; build a packet
  from checkpoint, workspace/Git, worker register and bounded previous answer.
  Interrupted/assignment cases use the fuller resume brief.
  `plugin/server/core/steer.mjs:389-415,705-735,858-897`.
- **Switch apply:** under scope lock recheck source/target/epoch, atomically
  commit new active slot/agent and increment epoch with delivery intent;
  then update markers and deliver or stage. Target self-takeover returns the
  packet instead of messaging itself. Old steer gets no message by default in
  the plugin menu; optional explicit notice costs a previous-steer turn.
  Existing workers remain registered and are listed in the packet.
  `plugin/server/core/steer.mjs:899-970`;
  `plugin/client/steer-menu-content.tsx:382-417`.
- **Warm/cold projection inputs:** last turn/end or cache request start,
  live provider/model/thinking/speed/session, ZeroSub account and billing,
  token usage/stored context, configurable floor, last cleanup, pending action,
  and turn-end settings baseline. TTL and cache warmth are estimates, not
  evidence of an actual hit. A changed tuple with retained history is cold;
  unknown baseline/unsupported route yields unknown.
  `plugin/server/agent-context.ts:20-31,36-113`;
  `plugin/shared/cache-profiles.ts:61-76,161-170,178-194,207-242`;
  `plugin/server/steer-feed.ts:217-245`.
- **Delivery guards:** quota admission and busy checks precede dispatch and
  repeat under lock. One per-agent action records packet, epoch, stable
  `wakeId`, and phases; a send attempt is persisted as uncertain before
  dispatch. Exact recipient/bytes/options/message-ID replay uses the native
  durable receipt, while epoch/holder changes fence stale attempts.
  Worker events remain queued until confirmed; assignment reports bind to a
  target and are marked reported after acceptance.
  `plugin/server/steer-delivery.ts:691-797,817-918,629-675`;
  `plugin/server/core/steer-action.mjs:1-78`.
- **Staging:** Send goes through shared delivery; Dismiss removes the stage.
  Composer inserts into the mounted destination, then dismisses the server
  stage, without invoking shared renewal. If no composer mounts within five
  seconds it sends instead; Later leaves the stage for Send/Dismiss.
  `plugin/server/steer-brief.ts:19-56`;
  `plugin/client/steer-menu-content.tsx:210-257,294-324`.
- **Different guards:** preview hashes detect stale confirmation; locks fence
  authority; creation receipts deduplicate agents; message IDs/action phases
  guard retries. None makes the whole workflow atomic.
  `plugin/shared/preview.ts:9-34,37-93`; `plugin/server/core/steer-add.mjs:407-438,474-485`.

## 2. Contradictions, redundancies and superseded claims

- **Fact:** `TODO.md:93` says a user's rewind left chat visible; the Codex live
  observation says timeline retains only history before the anchor
  (`docs/design/codex-research/findings-compact-vs-fresh.md:19-26`).
  Paseo v0.17.4 forcibly hydrates provider history and emits
  `timeline_replacement` after rewind
  ([agent-manager.ts:4217-4258](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/server/src/server/agent/agent-manager.ts#L4217-L4258)).
  The menu itself says earlier messages left the tab
  (`plugin/client/steer-menu-content.tsx:479-495`). **Inference:** do not
  promise full visible-history preservation; distinguish old provider session
  recoverability, retained pre-anchor history and the current visible timeline.
- **Fact:** `docs/design/slots-live-design.md:17-29` supersedes old newest-wins
  prose. The comment at `plugin/server/core/steer.mjs:1141-1151` still says
  newest wins, but actual code renames the old tab at line 1300. A failed
  post-commit rename can leave duplicate titles and authority blocked.
- **Fact:** “Initialize new steer” documentation includes creation, but add
  creates without prompt and ignores the setting. `docs/configuration.md:161`;
  `plugin/server/core/steer-add.mjs:296-306`; `plugin/client/steer-menu-content.tsx:333-369`.
- **Fact:** Fresh preview finds a timeline anchor but does not check the
  provider's rewind capability; generic daemon `rewindAgent` existence is not
  provider support. An unsupported provider can therefore preview rewind and
  later fail as uncertain, rather than automatically taking replacement.
  `plugin/server/core/steer.mjs:994-1001,1089-1103`;
  `plugin/server/core/rewind.mjs:134-149`.
- **Fact:** Resume, Refresh, Fresh, settings refresh, rewind, cold renewal and
  sweep overlap but differ in fallbacks, checkpoints, model and staging.
  `plugin/client/steer-menu.ts:187-248`;
  `plugin/server/resume-apply.ts:256-278`;
  `plugin/server/core/steer.mjs:1169-1205`.
- **Inference/risk:** composer insertion followed by separate stage dismissal
  has a crash/error window: the draft can contain a packet while the server
  still retains it. The five-second `settleRef` prevents two local timer paths,
  not an atomic client/server acknowledgement.
  `plugin/client/steer-menu-content.tsx:210-257`.
- **Known issues:** stale unregistered-steer checkpoints, stuck K7, partial-worker
  resume refusal, Fresh safeguards and live matrix. `FINDINGS.md:10,41-45`;
  `TODO.md:10,21,83`.

## 3. Verified Paseo/provider constraints

Source verification: public Paseo **v0.17.4** tag via GitHub contents API;
CLI help was inspected locally. This is source evidence, not a live matrix.
The installed CLI help offers reload/send/import but no rewind command;
Factory uses the internal daemon client, not the high-level SDK.
`plugin/server/core/rewind.mjs:86-105`.

| Provider | v0.17.4 source evidence | Reset implications |
| --- | --- | --- |
| Claude | [agent.ts:400](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/server/src/server/agent/providers/claude/agent.ts#L400), [3399-3414](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/server/src/server/agent/providers/claude/agent.ts#L3399-L3414): conversation rewind; first anchor can start fresh session, otherwise fork/rebind. | Native `/clear` is Factory's verified route when enabled; rewind replaces provider-derived timeline. Project instructions after clear remain a live-check item. |
| Codex | [codex-app-server-agent.ts:291](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/server/src/server/agent/providers/codex-app-server-agent.ts#L291), [5509-5545](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/server/src/server/agent/providers/codex-app-server-agent.ts#L5509-L5545): conversation rewind/fork with version-dependent rollback. | A saved brief anchor may retain earlier context; target turn is removed. `/clear` was observed not native; `/compact` is native (`docs/design/cold-context-resume.md:201`). |
| Copilot | [copilot-acp-agent.ts:45](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/server/src/server/agent/providers/copilot-acp-agent.ts#L45): conversation rewind false. | No same-tab Factory rewind through this provider contract. |
| Muse | [provider.ts:26-35](https://github.com/getpaseo/paseo/blob/v0.17.4/plugins/muse-provider/server/provider.ts#L26-L35): negotiated capability list has no `session.revert.*`. | No Factory conversation rewind through this release's Muse plugin. |
| Antigravity | [provider.ts:104-110](https://github.com/getpaseo/paseo/blob/v0.17.4/plugins/antigravity-provider/server/provider.ts#L104-L110) uses generic ACP; [connection.ts:61-102,250-260](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/plugin/src/server/acp-internal/connection.ts#L61-L102) advertises no revert and rejects it. | No Factory conversation rewind through this release's ACP adapter. |

- **Fact:** Paseo's conversation rewind rehydrates its timeline and publishes
  replacement, with provider history as source. No inspected contract promises
  independently retaining the *entire* old chat while resetting context.
  The old provider session may remain separately recoverable; import is not
  the same as retaining it in the current tab.
  [agent-manager.ts:4247-4277](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/server/src/server/agent/agent-manager.ts#L4247-L4277);
  `docs/design/cold-context-resume.md:161-168`.
- **Fact:** Factory does not rewind files; rewind needs an acknowledged user
  message anchor, which send-only agents may lack. `plugin/server/core/rewind.mjs:1-14,33-43`;
  [agent-manager.ts:4224-4235](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/server/src/server/agent/agent-manager.ts#L4224-L4235).
- **Open:** No evidence here establishes a supported context-only reset with
  complete visible history preserved for any of the five providers. The
  older live observation is not sufficient to generalize this guarantee.
  `TODO.md:83,93`.

## 4. Options and trade-offs

1. **One Reset Steer action:** distinguish explicit reset from “continue
   warm”; capture/verify latest checkpoint, target ID/title/epoch and current
   selected model; preview actual provider capability, anchor and visible
   history effect. Keep same agent/authority/workers when supported.
   If not possible without forbidden history loss or replacement, stop with an
   explicit alternative/approval rather than silently doing either.
   Trade-off: fewer concepts, but provider gaps remain visible.
2. **One Handover action:** target picker and one confirmation; backend
   resolves live unique holder, quota, cache and context; warm sends a compact
   handoff, cold/large renews before delivery, and the previous steer is not
   prompted by default. Trade-off: reuse saves quota but may preserve stale
   context; checkpoint recency and uncertainty must be visible.
3. **Keep internal mechanisms, delete duplicate entry-point policy:** retain
   auto-checkpoint, projection, quota admission, session/history verification,
   lock/epoch/holder fences, receipts, pending events, staged delivery and
   recovery. Collapse user-facing resume/fresh/refresh/clear/rewind rather than
   discarding their different safety contracts. Do not silently substitute
   replacement for reset; separate switch from reset semantics.
4. **Initialization:** either keep Send/Composer/Later as a shared delivery
   preference across creation/reset/handover, with crash-safe acknowledgement,
   or make creation explicitly blank and initialize on first handover. The
   latter is simpler but must not be described as already initialized.
5. **History gap:** investigate native Paseo API and seek upstream approval
   before a workaround. An imported history tab is not same-tab preservation.

## 5. Open questions

- Is complete history mandatory on Reset? Should unsupported cases block or
  offer an explicitly approved new tab?
- Is Reset always cold? How should missing anchors or uncertain rewinds recover
  without duplicate authority?
- Does native prompt model equal the server snapshot at dispatch, including
  composer-less and concurrent-change cases?
- Should switch commit before renewal/staged input, or wait for delivery? How
  are queued wakes/reports rebound when a receipt is uncertain?
- Can composer insertion and packet acknowledgement be atomic?
- How should idle cleanup coexist with provider compaction and history
  preferences? Passive measurement and the live matrix remain open (`TODO.md:11,83`).

```text
CHECKPOINT
task: Investigated Factory context lifecycle, handover and Paseo provider constraints; report written.
tests: Read-only source/documentation and CLI-help inspection; no live reset or automated tests.
blockers: Provider live matrix and full visible-history preservation remain unverified; concurrent checkout changes may move pointers.
next: Steer integrates findings into the control concept and resolves reset/history and delivery semantics.
```
