# Changelog

## Unreleased

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
- Plugin idle cleanup (C5, default `off`; `clear`/`compact-warm`, re-check before sending, auto-off after a failed attempt), cold-context pill/panel (C6) and `/factory resume`.
- Scope and hub docs: concepts (scope, hub, roles), configuration (kinds, addressing, alias) and the hub instruction block.

## 0.0.0 – initial import

Discovery, hash-confirmed apply with stored authorizations, receipt-based recovery, flock locks, steer checkpoints and switching, worker previews, offline and gated live tests.
