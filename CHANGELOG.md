# Changelog

## Unreleased

- Legacy removal: the one-time `migrate` tool, the `ari.wsf.*` label/metadata readers, the K7 old per-agent field folding, the nested `profileHealth` fallback, the `labels` audit (`factory.labels` RPC, `/factory labels`, `labels.set`/`labels.migrate` ops) and the old delivery shapes are gone; lingering duplicate `ari.wsf.*` agent labels are ignored. Other installs must run `migrate --apply` from commit `fc118f6` before upgrading past this change.
- Assignment reports: `assign` records the requester (`--report-to`, default the calling agent) and the plugin sends the assigned steer's done/blocked CHECKPOINT back to it once; assignment packets carry the exact CHECKPOINT format; the parser also reads `## CHECKPOINT` / `**CHECKPOINT**` headings.
- Configuration outside the repository (`--config`, `$PASEO_FACTORY_CONFIG`, XDG path) with `config.example.json`; host settings (state dir, daemon URL, `paseo` binary, password file) in `runtime` or environment variables.
- Checkpoints: `next` field, `--from-agent` reads the CHECKPOINT block of a steer's last answer, `status` shows the checkpoint and marks one from an older epoch.
- Switch: `--wait` shows the new steer's reply, `--notify-previous` sends a short notice to the replaced steer, handoff in English (default) or German.
- Planning reports known provider exceptions (Copilot Claude models reject a thinking level).
- Docs: concepts and safety model, configuration, steer instructions with task/answer template.
- Steer slots A–Z freely selectable (single-steer default in `config.example.json`); `--adopt` takes any defined slot and plans only the adoption; `plan --slots A,B` overrides `prepare` per run.
- Catalog exceptions extensible via optional `knownLimits` config field (validated; `model`/`modelPattern`, `thinking`/`mode`); matches are plan conflicts with the reason instead of apply failures.
- Docs: repo-root `AGENTS.md` with the steer instruction block; worked example for "provider limit reached" (`checkpoint --from-agent`, `switch --to`).
- Receipt lookup pinned to tested Paseo releases (`RECEIPT_LOOKUP_TESTED_VERSIONS`, `0.16.2`): installed SDK and daemon versions verified, fail-closed without a receipt.
- Models from the CLI: `models` lists the live catalog, `slot set/rm` and `worker-default` edit the config after catalog validation (`--dry-run` previews, atomic writes).
- Local mode without GitHub: `{"local": <path>}` entries and `plan --local <path>` plan only project registration, main workspace and steer slots under `local/<folder>` with no `gh` calls.
- Paseo plugin pilot (`plugin/`, built, typechecked, installed locally): `/factory` commands, panel, settings, and two-stage writes via plugin RPC.
- Context savings: per-agent context usage in `status` with an optional `usage.warnContextTokens` warning, a `fresh` command for same-slot handoff, and `docs/saving-context.md`.
- Worktree workspaces: `plan --local <worktree-path>` and `workspace:<id>` adopt an existing Paseo worktree workspace as the main workspace with no new project or duplicate workspace.
- Neutral `wsf.*` label/metadata prefix (`ari.wsf.*` still read, `labels.migrate` op rewrites it); tests and docs use example owners and paths only.
- Neutral `wsf:` idempotency namespace and client ids (`ari-wsf:` keys need a fresh plan); read-only `cleanup` report with a loss inventory per candidate.
- Confirmable cleanup plans (`cleanup --plan`, destructive gate, `workspace.archive`/`project.delete`/`scope.retire` ops with apply-time rechecks).
- Scope relocation (`relocate --to`, new workspace plus fresh steers, old scope retired with `movedTo`); retired scopes refuse coordination and steer planning.
- Advisor policy (no agent creation): `ADVISOR-REQUEST` block and steer decision in the instruction docs, optional validated `advisors.profiles` config mapping.
- Hub→scope assignment: `assign <scope> --task …` previews, `--apply` writes the scope checkpoint epoch-checked and delivers it to the active scope steer.
- Resume brief: `resume [scope]` cold-start brief (≤6000 chars), `wsf.agents` turn/note/interrupt records under lock, checkpoint source/interrupted fields, brief in interrupted handoffs.
- Fenced CHECKPOINT standard: handoff, `switch`/`fresh`/`assign` deliveries and the answer template carry the checkpoint as a fenced code block; the parser reads fenced and bare blocks (optional `workers` line ignored).
- Cold-resume rules: resume scope precedence (explicit > `wsf.scope` label > workspace), interrupt flag cleared only by agent/manual/assign checkpoints (auto never clears), shared workspace-lock helper in `src/lock.mjs`.
- Instruction rule: steer/worker blocks and `AGENTS.md` require `resume` after a cleared context; optional Claude Code SessionStart hook (clear|compact) documented, host settings untouched.
- Plugin idle cleanup (`clear` and `compact-warm` with rechecks before sending), cold-context pill and panel, and `/factory resume`.
- Scope and hub docs: concepts (scope, hub, roles), configuration (kinds, addressing, alias) and the hub instruction block.
- Scope domains: `plan <scope> --domain <id>` groups scopes under a coordinating domain scope (Hub → Domain → Child); `domain:` blockers escalate to the domain steer, `hub:` further to the hub.
- Restart detection and `drain`: daemon restarts mark interrupted agents (`daemon-restart`, heuristic without the plugin); `drain` waits for a clean restart and marks leftovers `planned-restart` instead of killing turns.
- Worker register and supervision: `workers` shows the `wsf.workers` register; the plugin wakes the active steer on worker outcomes, watches idle workers, and fails over to the next slot, domain or hub when a steer stalls.
- `/factory resume` as the restart path: clears the steer's context and delivers the resume brief; a "Resume nötig" pill marks affected steers, and resuming on a non-active steer takes over coordination.
- Priority model lists: `worker list/set/rm/pick` and `steer list/set/rm` manage ordered profiles with availability fallback (`slot set/rm`, `worker-default` deprecated); `model advisor/sensitive` flip the flags; advisor profiles never coordinate, sensitive profiles only get sanitized tasks on provably public repositories.
- Quota pools and profile health: profiles share a quota pool (`pool`, `quota.warnPct/exhaustedPct`); exhausted pools are skipped with failover to another pool; `worker pick <scope> --failed <profile> --reason <text>` marks a profile unhealthy for 10 minutes.
- Composer workflows for configuring a host, adopting steers and workers, setting up scopes and domains, and reviewing label repairs. Script-specific CLI options remain available.
- Worker supervision accepts registered workers identified by metadata, persists delivery retries, and waits for a busy steer before delivering a wake. Interrupted handoffs show the receiving steer and epoch.
- CHECKPOINT output uses plain field lines inside the code fence. Readers also accept earlier field lines with dashes.
- The active steer can launch a worker through the native SDK with the account selected by ZeroSub.
- `/factory steer add` previews and creates a steer for the current scope, with quota-aware profile selection and receipt-based recovery.
- Domain follow-ups: `relocate` carries the scope's domain pointer (shown in the preview), and `plan` can create a domain scope and its child in the same run (domain first).
- [Installation and updates](docs/getting-started.md#quickstart-in-paseo) for Git checkouts and built release directories. The optional findings reminder targets the Factory checkout and is available for checkout installs.

## 0.0.0 – initial import

Discovery, hash-confirmed apply with stored authorizations, receipt-based recovery, flock locks, steer checkpoints and switching, worker previews, offline and gated live tests.
