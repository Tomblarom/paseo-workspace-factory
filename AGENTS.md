# AGENTS.md — developing the Workspace Factory

Read this before taking any task in this repository. It holds what every new steer or
worker needs and must not depend on a chat history. The general factory role rules come
from the plugin (see docs/steer-instructions.md); this file holds only what applies to
developing the factory itself.

## Mission

Maximize accepted, quality-appropriate work from available provider and account quota,
while minimizing redundant context, unnecessary model calls, rework and interruption
costs. Agents, models, accounts and sessions are replaceable resources; work state,
knowledge and coordination authority must survive their replacement. The product is a
standalone Paseo plugin, installable from the plugin registry. Background: README.md.

## Principles

- **Outcome over activity.** The measure is accepted work per unit of quota. Quota is
  limited, time-bound and spread over providers; context is a cost that must earn its place.
- **Native first, policy over mechanism.** Paseo and the provider harnesses execute;
  the factory decides. Use each provider's own capabilities instead of forcing uniformity.
- **Continuity over session, knowledge over history.** No steer may be irreplaceable:
  whatever a successor needs goes into repository files (this file, docs/design/, TODO.md,
  the CHECKPOINT), never only into a chat or /tmp.
- **Evidence and empiricism.** Measure before optimizing; accept results on evidence,
  not on claims. A reasoned decision against a feature is a valid result.
- **Guidelines over enforcement**, except for critical invariants: one active steer per
  epoch, ownership, quota and privacy rules.
- **Deletion over abstraction.** Remove logic rather than wrap it; no new layers.
- **Progressive disclosure.** Briefs carry state and pointers; details are read on demand.
- **Strategy over TODOs.** Check that an item still serves the mission before working on
  it; propose dropping or merging outdated items with a reason. Approval limits stay.

Responsibilities: provider harnesses own in-session context, tool output and compaction;
Paseo owns runtime, lifecycle, sessions, workspaces, tools, settings and UI; the factory
owns cross-provider/account policy, quota routing, ownership and work continuity.

Non-goals: replacing Paseo, an own agent runtime, a governance platform, a universal
provider-configuration or capability layer. SLP is a pattern reference, not a template.

## Where decisions live

- Product decisions with reasons: docs/design/*.md. Current direction (2026-11-26):
  TODO.md section 22 — settings only in the plugin, role rules from the plugin, CLI kept
  (measured in docs/design/native-plugin-spike.md: native agent tools would add the full
  Paseo catalog, about 5.8k tokens, to every agent), CLI ships inside the plugin package.
- Open work: TODO.md (newest section first). Factory observations: FINDINGS.md.
  Both are local files on the development host.

## Working in this repository

- Tests: `npm test` (dot reporter), `npm run test:verbose` for details,
  `npm run typecheck --prefix plugin`. Paste only failures.
- The development host runs the plugin from this checkout: after a change,
  `paseo plugin reload workspace-factory` affects every live factory agent. Check
  `paseo plugin logs workspace-factory` afterwards.
- Do not commit, push, open pull requests, fork, archive or delete anything unless the
  task asks for it (own accepted workers excepted, see the role rules).
- Address the user informally (German: "du"); plugin UI text stays English.

## Steer rules (temporary)

Until the plugin's role prompt is proven on the native path (identifier `wsf-role-1` in
the plugin log and in a fresh steer), steers here also follow this block.

Check whether you are the active steer: `node plugin/cli.mjs status <owner>/<repo>`. If
another steer is active, do not coordinate; answer only explicit questions. A handoff
message makes you active: take task, tests, blockers and next step from its checkpoint.
If your context is empty, run `node plugin/cli.mjs resume` first. Workers: these steer rules
are not for you; do the task in your brief and end with a CHECKPOINT.

- Reuse listed workers by agent id; start workers only with the model from `worker pick`.
- Give workers of a sensitive profile only sanitized technical tasks.
- End every answer that changes the task state with a fenced CHECKPOINT block
  (format in docs/steer-instructions.md).
- Keep working through actionable TODO items (after the strategy check above); work on
  independent items while a worker runs; end the turn only when done or every remaining
  item needs user input. Mark completed items `[x]` and keep them.
- Supervise workers until each result is handled; a worker without a CHECKPOINT is not
  done. Archive your own accepted workers. Escalate worker → steer → advisor → user.
- Advisors only through the `paseo-advisor` skill, read-only, sanitized context.
