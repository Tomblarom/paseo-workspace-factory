# Native pre-dispatch and submenu hover research

Research only, 2026-11-26. **Fact** means inspected source, not a live test. `P` links refer to public Paseo **v0.17.4**, annotated tag commit
`2b3559b107243306986176b80beb0e779f9fe53e`. Installed `paseo --version` says
`0.17.4`; the installed daemon/client bundles were not compared with the tag.
Current official [hook docs at main commit e4dc119](https://github.com/getpaseo/paseo/blob/e4dc119df8a6754bfd2e65d0a7bd34b7e80c52b6/public-docs/plugins/hooks.md#L25-L34)
were checked separately. No agents, UI, daemon state, private logs, or accounts
were exercised.

## Send path: inspected facts

- Composer submit trims text, rejects empty/no-attachment input, queues locally while running unless forced, otherwise clears the draft before sending and
  restores text/attachments on an error:
  [P submit.ts:25-79](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/app/src/composer/submit.ts#L25-L79).
  Client and plugin slash commands can be consumed before ordinary submit; an `onSubmitMessage` callback is another entry:
  [P composer/index.tsx:1678-1695,1855-1874](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/app/src/composer/index.tsx#L1678-L1695).
- Normal dispatch generates a client message ID, begins an optimistic timeline
  row, encodes images, and sends text, ID, active-turn behavior, images and
  attachments; on success/failure it accepts/rejects the submission:
  [P actions.ts:188-232](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/app/src/composer/actions.ts#L188-L232).
  Attachments include files, workspace files/resources, plugin resources, forge items and browser screenshots; images are separate wire data:
  [P attachments/submit.ts:30-88](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/app/src/composer/attachments/submit.ts#L30-L88).
  The client also supports `sessionMode`, source/provenance and generates an
  ID if absent: [P daemon-client.ts:4271-4307](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/client/src/daemon-client.ts#L4271-L4307).
- An app-local queue holds its own ID, text and attachments; editing removes
  an item and send-now removes then requeues on failure. Idle-triggered drain
  calls the normal dispatch function with `steer` and **generates a new send
  ID**, not the queue ID:
  [P actions.ts:246-256,275-329](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/app/src/composer/actions.ts#L246-L256),
  [P host-runtime.ts:2810-2863](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/app/src/runtime/host-runtime.ts#L2810-L2863).
  Composer normally maps its setting to `interrupt` or `steer`; pending
  permissions affect the queue choice:
  [P composer/index.tsx:1678-1695,1739-1759](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/app/src/composer/index.tsx#L1739-L1759).
- The daemon resolves the agent and builds the prompt from the wire request.
  Human sends take the direct path; agent-sourced sends are admitted to a
  different server inbox and can receive `accepted: true, deliveryStatus: queued` before provider dispatch. A human message can carry previously
  queued agent messages in one provider prompt, each with its own envelope:
  [P session.ts:9138-9264](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/server/src/server/session.ts#L9138-L9264),
  [P delivery.ts:487-507](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/server/src/server/agent/agent-messages/delivery.ts#L487-L507).
  Other surfaces use this orchestration, but initial agent creation has a
  separate start path: [P agent-prompt.ts:369-405,463-485](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/server/src/server/agent/agent-prompt.ts#L369-L405),
  [P create.ts:460](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/server/src/server/agent/create-agent/create.ts#L460).
- `agent.turn.before` is a non-waiting `turn_started` notification containing
  agent and turn ID, not the message; it cannot defer send.
  `agent.open.before` only modifies launch inputs. Current official docs say
  waiting hooks fail at 30 seconds; notifications neither block nor return a
  decision: [hook table](https://github.com/getpaseo/paseo/blob/e4dc119df8a6754bfd2e65d0a7bd34b7e80c52b6/public-docs/plugins/hooks.md#L50-L67),
  [P lifecycle/index.ts:193-199](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/server/src/server/plugins/lifecycle/index.ts#L193-L199).
- The private `beforeDispatch` callback is receipt bookkeeping, not a plugin hook. It runs after load/mode setting and before starting a run, inside
  `sendDirect`'s serialized recipient lane. Waiting there for a normal send to
  the **same** recipient would deadlock:
  [P agent-prompt.ts:259-263,441-459](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/server/src/server/agent/agent-prompt.ts#L259-L263),
  [P delivery.ts:291-302,605-629](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/server/src/server/agent/agent-messages/delivery.ts#L291-L302).
- Durable receipts key on agent and message ID, compare the request fingerprint, and distinguish pending/completed. A pending receipt can mean provider
  acceptance already happened and returns `agent_request_outcome_unknown` on
  retry; completed is deduplicated. It is not a read-only status API:
  [P message-receipts/index.ts:7-60](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/server/src/server/message-receipts/index.ts#L7-L60).
  Public [getpaseo/paseo#9654](https://github.com/getpaseo/paseo/issues/9654)
  documents the restart ambiguity; [getpaseo/paseo#9947](https://github.com/getpaseo/paseo/issues/9947)
  requests read-only receipt recovery and distinguishes pre-dispatch failure.
- Send and Stop both require `workspace.write`/`hub.execute`; permission
  responses require `workspace.write`. Human direct messages pass
  `clearPendingPermissions: true`, agent messages false:
  [P operation-permissions.ts:38-45,193](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/server/src/server/authorization/operation-permissions.ts#L38-L45),
  [P session.ts:9177-9213](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/server/src/server/session.ts#L9177-L9213).
  Stop holds the server inbox; app Stop currently targets a running agent:
  [P delivery.ts:535-552](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/server/src/server/agent/agent-messages/delivery.ts#L535-L552),
  [P actions.ts:170-185](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/app/src/composer/actions.ts#L170-L185).

## Smallest useful native contract: proposal, not existing behavior

1. Add an opt-in, capability-gated **human-composer pre-dispatch gate** at a
   daemon-owned admission boundary, before provider dispatch and before any
   destructive permission/mode side effects. Include immediate send, app queue
   drain and send-now; identify their source explicitly. Client-only slash
   commands and initial-agent creation are outside this first contract unless
   separately specified. Other CLI/MCP/plugin or agent sends are not silently
   intercepted. Resolve stable workspace/agent and authorized caller first.
2. Freeze the complete post-composer wire request (trimmed text, image bytes,
   attachment descriptors/order, message ID, mode, active-turn behavior and
   provenance) in host custody. Pass a minimal metadata-only event and an opaque
   transaction ID to a trusted plugin; do not require exposing prompt contents
   or attachments through this API. Trusted plugins are not a process sandbox.
   Allow **continue unchanged**, **renew then continue**, or
   **reject with reason**; the plugin cannot replace the original request.
   The host, not Factory, owns original dispatch and attachment lifetime.
3. Reserve the agent's place in the native delivery ordering and serialize
   transactions per agent. A narrowly scoped host-owned renewal operation can
   run within that reservation without re-entering the public send lane or
   retriggering the gate; external sends stay ordered/held, never gain the
   bypass. Revalidate agent identity, authority/epoch, capability, busy state
   and permissions immediately before renewal and original dispatch. Do not
   hold an ordinary `sendDirect` callback while awaiting a nested public send.
   Define ordering with already queued agent messages explicitly: if strict
   unmodified provider input is required, settle prior messages as separate
   ordered turns and prevent batching with the original; otherwise preserve
   native envelope batching and promise only the unchanged individual message.
4. Renewal is an explicitly authorized, provider-capability-checked operation:
   perform clear/rewind and, if needed, a separate initialization turn, await
   its *successful completion*, then dispatch the captured original once with
   the original identity. Do not merge an initialization prompt into it. If
   reset is unsupported, busy, pending permission, or initialization fails,
   expose a blocked state and retain the original; never silently send in stale
   context. A user message intended to answer a permission must not be consumed
   as a reset trigger; bypass/ask explicitly without auto-approving permission.
5. A simple 30-second waiting hook is insufficient for a renewal turn that may
   await tools or a person. Use a short bounded decision followed by a visible,
   cancellable, durable pending transaction with an explicit overall deadline;
   never treat timeout as permission to send. Stop cancels renewal and prevents
   original dispatch if not yet admitted; preserve it for explicit edit/retry.
   Pending permissions are visible and resolved only by the authorized user,
   with cancellation/timeout paths; no lock may hide the permission response.
6. Expose read-only transaction/receipt status (`pending`, definitely
   not-dispatched, provider-accepted, rejected/canceled, **unknown**) and
   stable IDs across reconnect/restart; persist captured request and phase
   safely before acknowledging deferral. Resolve disconnect/crash at every
   phase without automatic replay of ambiguous provider acceptance. A durable
   host admission is not provider acceptance or successful processing; do not
   claim exactly-once provider execution without provider idempotency/evidence.
   Client UI must show progress/failure and recover the original rather than
   losing it or creating a fresh ID on uncertain retry.

**Acceptance scenarios to implement upstream:** immediate/queued/send-now with
images, files, plugin resources and each behavior/mode; exact captured payload
and identity after a separate renewal; no accidental interception of slash,
agent or creation sends; concurrent sends and pre-existing server inbox without
deadlock/reordering; unsupported renewal; permission already pending or raised
by initialization; Stop before/during/after provider admission; deadline,
disconnect, plugin reload and daemon crash at every durable transition;
duplicate requests and conflict; ambiguous acceptance remains visible and is
never replayed automatically. Verify the API denies unauthorized inspection,
release, alteration or bypass. Provider-specific clear/rewind
effects and initialization completion require live verification.

## Submenu highlight: inspected cause and proposal

- The submenu trigger supplies `active={isOpen}` independently of pointer
  location: [P menu-sub.tsx:66-103](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/app/src/components/ui/menu/menu-sub.tsx#L66-L103).
  `active`, hover and keyboard focus use the same `surface2` fill, so open
  ancestry visually looks hovered while a different row is actually hovered:
  [P menu-item.tsx:370-383,546-555](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/app/src/components/ui/menu/menu-item.tsx#L370-L383).
  Focus is an independent contributor, so removing `active` alone does not
  prove a visually unhighlighted row after keyboard focus.
- Hover-open delay is 90 ms and close grace 260 ms; entering the flyout cancels
  close. Popover pages contributed as non-menu content have `hoverIntent:
  false`, which locks pointer-driven close while open. Touch pointer events do
  not count as hover:
  [P menu-surface.tsx:41-47,181-202,247-260,329-341](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/app/src/components/ui/menu/menu-surface.tsx#L41-L47),
  [P buttons/view.tsx:220-239](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/app/src/plugins/buttons/view.tsx#L220-L239),
  [P menu-pointer.ts:3-12](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/app/src/components/ui/menu/menu-pointer.ts#L3-L12).
  Popovers support arrow navigation and Enter/Space; Escape closes the overlay;
  compact sheets use Tab order:
  [P keyboard-navigation.web.ts:2-35](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/app/src/components/ui/menu/keyboard-navigation.web.ts#L2-L35),
  [P menu-overlay.tsx:407-416](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/app/src/components/ui/menu/menu-overlay.tsx#L407-L416),
  [P menu-item.tsx:401-410](https://github.com/getpaseo/paseo/blob/v0.17.4/packages/app/src/components/ui/menu/menu-item.tsx#L401-L410).
- **Proposal:** retain page/path state and grace/lock behavior, but render open
  ancestry distinctly from current hover and keyboard focus (or omit ancestry
  fill if product chooses), with visible focus and accessible expanded state.
  Do not simply close the submenu faster or disable its `active` navigation.
  This is a shared native menu fix, not Factory pill styling.
- **Reproduce/accept, not yet run:** desktop hover a Factory handover submenu
  trigger for >90 ms, move across the gap to a child, then a sibling/confirmation;
  parent ancestry must not be mistaken for the currently hovered row, the
  flyout survives the gap and closes after >260 ms when appropriate. Open a
  confirmation and verify pointer movement does not dismiss it. Keyboard: use
  arrows and Enter/Space, verify distinct focus, reachable nested content,
  Escape and focus restoration. Touch/compact sheet: tap, release, navigate
  and back/dismiss without delayed hover-close; also test mouse on touch device.
  Check screen-reader semantics, disabled rows, multiple nested levels and
  both themes. Existing exact sticky-highlight issue/fix was not established.

**Boundary:** both changes require Paseo upstream work and approval before any
external contribution; Factory can consume capability-gated APIs only after
they exist. The causal styling is source-proven, the reported exact pointer
sequence, accessibility result, installed bundle equivalence, and renewal
behavior remain live-unverified.
