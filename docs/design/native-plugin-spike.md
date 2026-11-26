# Spike: native Paseo plugin with role tools (TODO 22, priority B)

Date: 2026-11-26 · Paseo 0.17.4 (daemon + source tag v0.17.4) · read-only spike, factory unchanged.
Scratch: `/tmp/wsf-spike` (paseo clone, `wsf-tools-spike` plugin, probe agents `wsf.spike=1`).

## Headline

Technically feasible for codex/claude, but on Paseo 0.17.4 plugin agent tools
cannot be delivered without also injecting the **full Paseo orchestration catalog
(measured: 40 tools, ~5,827 tokens)** into every agent — ~5× the factory's own
tool + prompt cost (~620 + ~600 tokens). That plus two provider gaps (muse: no
tools; copilot: no prompt) is the decision-relevant result; details below.

Decisive constraint (verified live + in code):

- Plugin tools reach MCP/native providers only when `daemon.mcp.injectIntoAgents`
  is true. Default is **false** (`packages/server/src/server/agent/config.ts:554`).
- Live: scratch plugin `wsf-tools-spike` attached `wsf_spike_note` + a
  `WSF-SPIKE-ROLE` prompt line to a labeled claude agent. The agent quoted the
  prompt line exactly, but reported the tool as unavailable ("No tool by that
  name ... from any connected MCP server"). Same hook return value, so the hook
  ran; delivery failed for lack of injection. No hook error in daemon log.
- `enabled: false` in a provider `paseoTools` policy disables plugin tools too,
  and `disabledTools` is a denylist only (`agent/paseo-tool-policy.ts`). There is
  no allowlist / plugin-tools-only mode in 0.17.4.

## Q1 — provider matrix

| Provider | Tools | appendSystemPrompt | Evidence |
| --- | --- | --- | --- |
| codex | yes (MCP) | yes (composed prompt + live snapshot updates, needs Codex ≥0.121.0) | `supportsMcpServers: true` (codex-app-server-agent.ts:288); `composeAgentSystemPrompt` incl. `pluginAppendSystemPrompt` (system-prompt.ts:20, codex-app-server-agent.ts:4056); hooks.md Codex notes |
| claude | yes (MCP) | yes | `supportsMcpServers: true` (claude/agent.ts:397); prompt spread (claude/agent.ts:3948); **live**: probe agent quoted the appended line verbatim |
| muse | **no** (upstream bug) | yes (first-turn `<system_instructions>`) | muse-code.md "Limitations in Muse 1.4.1": "Muse drops the returned tool namespace ... before Muse agents can use Paseo tools"; session.ts:244-247 injects prompt, :104-132 forwards MCP |
| copilot | yes (MCP via core ACP) | **no** | `supportsMcpServers: true` (copilot-acp-agent.ts:42), forwarded by `acpMcpServers()` (acp-agent.ts:3202); zero `systemPrompt` references in acp-agent.ts; hooks.md: "The ACP adapter does not send system instructions" |
| antigravity | yes (MCP via ACP) | partial/unknown | MCP forwarded (`toAcpMcpServers`, plugin acp-internal/connection.ts); docs: "receives the MCP servers configured for the agent"; prompt only via vendor capability `antigravity.systemPrompt.append` in agent _meta (antigravity-provider/server/provider.ts:15-17,42-46) — whether current `agy` advertises it is **unknown** (not tested live) |

Notes:

- Delivery is MCP for all five (`supportsNativePaseoTools` is true only for
  opencode/omp; plugin-provider.ts:2079 sets false). Muse forwards MCP config to
  its CLI but the CLI drops the namespace.
- Even native-tool providers need the global injection switch
  (`useNativeTools` requires `paseoToolsEnabled`, agent-manager.ts:6553-6556).

## Q2 — lifecycle

| Event | Tools | Appended prompt | Evidence |
| --- | --- | --- | --- |
| create (fresh/replacement) | attached per labels | applied | hooks.md; live probe (reason create) |
| resume (daemon restart) | re-attached, hooks rerun (`reason: resume`) | re-applied | hooks.md; agent-manager buildLaunchContext |
| plugin install/enable/disable/reload/update | picked up before next **idle** prompt via provider resume; running turn uninterrupted | same | runtime.ts:405-409 (`agent.open.before` → `invalidatePluginSessions`); agent-prompt.ts:151 `reloadStalePluginSession`; reload = close + `client.resumeSession(handle, …)` (agent-manager.ts:1971-2040), history + labels preserved |
| explicit `reload()` | immediate re-attach (`reason: refresh`), interrupts running turn | same | hooks.md; client index.ts:441-444 |
| plugin reload (live) | prompt after `plugin reload wsf-tools-spike` completed normally, conversation continued | same session | live: RELOADED probe 2026-11-26 |
| `refresh()` | no change (snapshot read only) | no change | hooks.md |
| rewind | unchanged (no hook rerun; provider thread fork/rollback) | codex may repeat an instruction snapshot | claude/rewind.ts, codex/rewind.ts operate on the live thread; hooks.md Codex note |
| Claude native `/clear` | unchanged (launch config, not conversation) | unchanged | structural (config vs conversation level); cache dropped by design. Unmeasured live |
| provider switch | n/a — no in-place switch API (no `setProvider` in `@getpaseo/client`); a switch is a new agent → create path | same | client/src grep; provider fixed at creation |
| adoption/import | per the adopted agent's stored labels/metadata (`reason: import`); history-only opens ignore tools | ignored for `purpose: history` | hooks.md reason/purpose table |
| label change on live agent | needs `reload()` to re-evaluate targeting | same | hooks.md agent-tools README |

Cost of a change: one provider resume per stale agent (close + resume from
persistence + hook rerun), history preserved, no new context read. Exact
prompt-cache effect (prefix reuse vs suffix invalidation from changed schemas /
snapshots) is **unknown** — not measurable here (codex quota exhausted, no
cache-billed route observed). Structural fact: schemas + prompt are cacheable
prefix; outputs are not.

## Q3 — role scoping vs authorization

- Visibility: the `agent.open.before` hook sees `request.labels` / `metadata`
  and decides per role (steer/worker/advisor). Labels are set at creation.
- Visibility ≠ authorization, two reasons:
  1. Agents can change labels: MCP tool "Update an agent name, labels, and/or
     runtime settings" (`agent/tools/paseo-tools.ts:2316-2343`). A worker could
     self-label as steer and receive steer tools at the next open.
  2. The execute context carries **no labels**: `AgentToolContext.agent` is
     `PluginHookAgent` (id, workspaceId, parentAgentId, provider, cwd, title,
     background, metadata) — `packages/plugin/src/server/agent-tools.ts`,
     `lifecycle.ts:71-82`. The server must re-read labels/metadata per call
     (SDK) or track them at open time; the open-time view can go stale.
- What native tools fix: caller identity becomes server-attested
  (`executePluginTool` resolves the live agent, agent-manager.ts:1096-1113).
  Today it is self-asserted `PASEO_AGENT_ID` env (src/cli.mjs:132,140,154,227,
  231,249) — any local process can claim any id, and
  `checkpoint --from-agent` resolves **any steer of the scope**
  (plugin/server/handlers.ts:941-947); `writeCheckpoint` does check
  agentId/callerId against the active holder (core/steer.mjs:1707 + callerId
  check) but both values are caller-supplied.
- What native tools do NOT fix: the A→B→A epoch race. The context has no
  turn/epoch id, and `agent.turn.before/after` turnIds never reach `execute`.
  A stale turn of agent A calling after A→B→A still presents agent A. The
  per-call `guardScope` (active holder + epoch, core/scope-guard.mjs) stays
  mandatory, plus a freshness token in tool inputs for state-changing calls
  (`assign` already has the `expectEpoch` pattern; generalize it: switch/assign
  responses mint epoch+nonce, mutating tools require it).
- Live check that server auth works today: `checkpoint`/`switch` as a worker
  (non-active-steer callerId) are refused ("Only the active steer can write
  this checkpoint", "Active Steer C is running...").

## Q4 — context cost (measured)

Method: Paseo token estimate = compact JSON bytes / 4 (same as
`measure-agent-tools-context.ts`).

Fixed context per steer agent:

| Item | Size | Tokens (est) | Source |
| --- | --- | --- | --- |
| Minimal steer tool schemas (8 tools: status, resume, checkpoint, workers, worker_pick, worker_start, switch, assign) | 2,470 B | ~620 | `/tmp/wsf-spike/measure-schemas.mjs` (hand-minimal; real zod→JSON schemas ~1.5–2×) |
| Full Paseo catalog (mandatory with injection on) | 23,308 B (40 tools; +browser: 36,632 B, 63 tools) | ~5,827 (~9,158 with browser) | `npm run measure:agent-tools` on v0.17.4 (scratch stub fix: `getPluginTools`); largest: create_agent 637, create_workspace 465, send_agent_prompt 424 |
| Draft steer role prompt | 2,416 B | ~600 | `/tmp/wsf-spike/draft-steer-prompt.txt` |
| Today's AGENTS.md steer block (deleted in target state) | 4,180 B | ~1,050 | `wc -c AGENTS.md` |
| Worker role prompt (draft: 2 lines, no tools) | ~200 B | ~50 | estimate |
| Advisor role prompt (draft: 3 lines, no tools) | ~250 B | ~65 | estimate |

Per-call cost (same outputs either way; measured live 2026-11-26):

| Call | Output bytes | Tokens (est) |
| --- | --- | --- |
| status | 1,304 | ~330 |
| resume --json (brief) | 2,160 | ~540 |
| workers | 403 | ~100 |
| worker list / pick | 282 / 207 | ~70 / ~50 |
| assign dry-run packet | 2,157 | ~540 |
| switch packet | unmeasured (refused for non-steer caller) | ~same order as assign |

CLI path per call = Bash tool call (~100–200 tokens framing + command) + output.
Tool path per call = tool call (~50–100 tokens) + output. Steady-state per-call
cost is output-dominated and nearly identical; the difference is fixed context
(role prompt + schemas + full catalog vs AGENTS.md block) and robustness
(no shell quoting, typed inputs, attested caller).

Cache behaviour: schemas + role prompt are prefix context (cacheable across
turns); outputs are not. Changing tools/rules reopens the session (Q2) and
invalidates the cached suffix provider-side; exact cost **unknown** (unmeasured).

## Q5 — what can be deleted

| Item | Verdict | Notes |
| --- | --- | --- |
| `src/cli.mjs` (273 lines, all commands) | delete | status, resume, checkpoint, workers, switch, assign, worker pick/list/start become agent tools calling core directly in-process |
| `package.json` bin `paseo-factory` + CLI docs | delete | README/Getting started rework |
| `connectPluginRpc` (plugin/server/core/paseo.mjs) | **keep** | also used daemon-side by zerosub.mjs:329 to read zerosub state; only the CLI's use goes |
| `factory.*` RPCs (plugin/shared/factory.ts) | keep | every CLI-used RPC is also used by `/factory` UI paths; tools call core functions directly, RPCs serve the user UI |
| Brief texts mentioning `paseo-factory …` (steer-brief, supervision, resume-apply) + `plugin/test/supervise.test.mjs` assertions | rewrite | briefs name tools instead of CLI commands |
| AGENTS.md steer block in managed repos | delete (goal: zero factory text) | role rules arrive via `appendSystemPrompt`; this repo's own AGENTS.md shrinks to a pointer during migration |
| docs/steer-instructions.md | keep as user docs + role-prompt source | trim to what the prompt doesn't carry |
| Worker CHECKPOINT-block convention | keep | workers get no tools; the block stays the worker→steer protocol (parse stays) |

Stays a user slash command: all of `/factory`
(status, scopes, cleanup, fresh, assign, workers, models, drain, quota, plan,
apply, checkpoint, switch, resume, worker, steer, model —
plugin/shared/factory-args.ts). Agents stop using the CLI; users keep the UI.

Recovery/diagnosis without CLI: `/factory status`, `wsf_status` tool,
`paseo plugin logs workspace-factory`, `paseo ls/logs/inspect`, steer + attention
feeds, native `paseo archive`. No shell needed on either side.

## Q6 — install, settings, versions

- Packaging: standard plugin (`paseo-plugin.json` + `index.server.ts`; deps via
  package.json/lock; `paseo plugin init` scaffold verified). No checkout, no
  config file, no CLI install in the target state.
- `paseo plugin install/update/remove`: verified install + listing live with the
  scratch plugin. Update swaps the source dir and restarts the plugin
  (plugins/index.ts:878+); settings untouched. Remove deletes
  `<paseoHome>/plugin-settings/<pluginId>` (plugins/index.ts:576-580,
  bootstrap.ts:699). So: **update preserves settings, remove deletes them** —
  matches the TODO 16 finding; closes "Einstellungsverlust nach Release" for
  registry installs.
- Minimal `requirements.paseo`: agent tools since **0.14.0** (CHANGELOG,
  #7938; example manifest `>=0.14.0-beta.1`); plugin agent instructions
  (`appendSystemPrompt`) since **0.17.1** (CHANGELOG, #9781). → manifest
  `>=0.17.1`; recommend testing/supporting `>=0.17.4` (this spike's version).
- Store install: registry path (`paseo plugin add owner/slug`, review pins) per
  public-docs/plugins/publishing.md; not exercised live (no publishing in scope).

## Recommendation

**Go native for roles + rules, but do not delete the CLI yet.** Order:

1. Ship role prompts via `agent.open.before` first (steer/worker/advisor by
   `wsf.role` label): zero provider dependency except copilot/antigravity gaps
   (below), immediate AGENTS.md shrinkage, no injection switch needed.
2. Add steer tools behind the injection prerequisite: document
   `daemon.mcp.injectIntoAgents: true` as required, with a per-provider
   `paseoTools.disabledTools` denylist template for worker profiles. Workers
   and advisors get no tools.
3. Keep the CLI as fallback until (a) muse fixes MCP tools upstream and
   (b) either Paseo offers plugin-tools-only delivery or the measured full
   catalog cost is accepted. Then delete per Q5 table.

Minimal tool set per role:

- Steer (8): wsf_status, wsf_resume (+apply for interrupted workers),
  wsf_checkpoint (from_self|task), wsf_workers (+prune/apply), wsf_worker_pick,
  wsf_worker_start, wsf_switch, wsf_assign. All mutating calls enforce
  guardScope + epoch/nonce freshness server-side.
- Worker: none (CHECKPOINT block stays).
- Advisor: none (read-only answer stays).

Caveats that must stay visible:

- Muse steers cannot use tools until the upstream namespace fix (prompt works).
- Copilot steers get tools but no role prompt (ACP adapter sends no system
  instructions) — keep AGENTS.md fallback or exclude copilot for steers.
- Antigravity role prompt depends on the CLI advertising
  `antigravity.systemPrompt.append` (unverified).
- Enabling injection exposes the full orchestration catalog to every agent;
  review the denylist per new Paseo release (no allowlist in 0.17.4).

## TODO impact (become obsolete or merge after migration)

- 16 "Konfigurationsdatei abschaffen" — merges (done by native install; CLI-RPC
  settings path already gone since 5434e17).
- 16 "Einstellungsverlust nach Release ausschließen" — obsolete for registry
  installs (update preserves settings, proven in code Q6).
- 16 "Release-Installation nachträglich auf Git umstellen" — already dropped
  (22/C decision).
- 17?/slots-live steps touching CLI settings — merge into tool inputs.
- 20 G (guidelines → role system text) — merges into role prompts.
- 20 S4 (wake/resume texts) — merges (briefs carry dynamic state only).
- 20 K8 remainder (A→B→A) — stays, changes shape: epoch/nonce in tool inputs.
- 21 K12 remainder (CLI thinning) — completes with CLI deletion.
- Icon/registry TODO — merges into store publication (Q6).
- 22/A output-efficiency items — unaffected (do regardless).
- 22/C "native Ausgabe-/Kompaktierungsgrenzen" (BASH_MAX_OUTPUT_LENGTH env,
  codex token limits via hook env) — stays, same hook carries it.

## Open / unknown

1. ~~Exact full-catalog token cost~~ — measured: ~5,827 tokens core (~9,158 with
   browser tools). The 8 factory tools (~620–1,200 tokens) are ~10–20% of the
   forced catalog; the other ~80–90% (create_agent, workspaces, schedules,
   terminals, …) lands in every steer/worker context with no allowlist.
2. Exact cache-invalidation cost of tool/rule changes (unmeasured; needs
   cache-billed runs).
3. Whether current `agy` advertises `antigravity.systemPrompt.append`.
4. Positive live proof of tool delivery with injection on (deliberately not
   enabled on the shared daemon during this spike).
5. Muse upstream fix version for MCP tools.
