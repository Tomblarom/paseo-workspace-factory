# Native provider capabilities vs. Workspace Factory mechanisms

Investigation only (TODO 22, Priorität C). Read-only research; no config changed.
Sources: installed provider CLIs, installed Paseo 0.17.4 bundle
(`/opt/paseo/releases/0.17.4/lib/node_modules/@getpaseo/...`, compiled JS + builtin-plugin
TS sources), provider docs. The Paseo source checkout at `~/projects/paseo/paseo` is
v0.11.1-era, so all Paseo evidence below comes from the installed 0.17.4 daemon bundle.
Codex schema generated to `/tmp/wsf-provcap/schema` (scratch, regenerable).

Installed versions: Claude Code 2.1.330 (Agent SDK 0.3.326 bundled) · Codex 0.171.0 ·
Muse 1.4.25 · Copilot CLI 1.0.115 · Paseo 0.17.4.

## Shared Paseo mechanism (all providers)

- `agent.create.before` can change `config` (incl. `providerOptions`, create-time only) and
  `env` (`@getpaseo/server .../agent/agent-manager.js` ~line 926).
- `agent.open.before` runs on **every** open (create/resume/refresh/import); the returned
  `env` becomes `launchContext.env` (`agent-manager.js` `buildLaunchContext` ~4646).
  Mutable fields: `env`, `appendSystemPrompt`, `tools`, `mcpServers`
  (`@getpaseo/plugin/dist/server/lifecycle.d.ts`).
- Env layers: daemon provider config `runtimeSettings.env` (global per provider) +
  per-agent overlay, no allowlist (only parent-session vars cleared)
  (`provider-launch-config.js` `createProviderEnvSpec`). Rule of thumb: **env-var-based
  native settings are per-agent scopable via the factory hook (label-filtered);
  config-file/CLI-flag settings are not** (global or unsupported args).

## Claude Code (via Claude Agent SDK `query()`)

SDK spawns its bundled CLI; Paseo overlays `launchEnv` onto the subprocess env
(`providers/claude/query.js:40-47`); `launchEnv` = `launchContext.env`
(`providers/claude/agent.js:1189,1215`). Caveat: env-var support follows the
**bundled** SDK CLI (0.3.326), not the installed `claude` 2.1.330; version mapping unknown.

| setting | installed? | Paseo path | per-agent scope | default | evidence |
|---|---|---|---|---|---|
| `BASH_MAX_OUTPUT_LENGTH` | yes | env via `agent.open.before` | yes (factory labels) | 30000 chars, max 150000 | [env-vars](https://code.claude.com/docs/en/env-vars) |
| `TASK_MAX_OUTPUT_LENGTH` | no (removed 2.1.277, no-op) | — | — | — | env-vars doc |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | yes (k-suffix needs ≥2.1.304) | env via hook | yes | per-model window | env-vars doc |
| `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` | yes (needs ≥2.1.290) | env via hook | yes | 200000, min 100000 | env-vars doc |
| auto-compaction | yes, on by default | `DISABLE_AUTO_COMPACT=1` / `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` via env | yes | on | env-vars doc |
| idle compaction | yes, on by default | `idleCompaction=false` setting (unknown via Paseo) or `DISABLE_AUTO_COMPACT` | via env only | on ≥200k tokens | env-vars doc |
| `providerOptions` for claude | unknown | `agent.create.before` `config.providerOptions` (create only) | unknown | — | not examined |

Project instructions: `CLAUDE.md` (+ local/user variants) loads — Paseo passes
`settingSources: ["user","project","local"]` (`agent.js:55,3238`). Still present after
/clear, compaction, resume, adoption: unknown (not live-tested; native default is yes).
Observed 2026-11-26 (steer session in this repo, Claude via Paseo): the repository's
`AGENTS.md` was loaded as project instructions although no `CLAUDE.md` exists, so the
loaded file set is wider than `CLAUDE.md` alone.

## Codex (via `codex app-server`, one process per session)

Paseo spawns `codex app-server` with `baseEnv = runtimeSettings + launchEnv`
(`codex-app-server-agent.js:6585-6610,6634`); passes **no** `-c` overrides (only
`--enable goals`). `CODEX_HOME` is resolved from that env (`:408,:6531`), so a per-agent
`CODEX_HOME` would give a per-agent `config.toml` — but also a separate session
store/auth; heavy, not recommended. Keys verified against installed 0.171.0 via
`codex app-server generate-json-schema`.

| setting | installed? | Paseo path | per-agent scope | default | evidence |
|---|---|---|---|---|---|
| `model_auto_compact_token_limit` (+`_scope`) | yes | `config.toml` only (no `-c` from Paseo) | only via per-agent `CODEX_HOME` | unknown | generated schema `v2/ConfigReadResponse.json` |
| `tool_output_token_limit` | no (absent from 0.171.0 schema) | — | — | — | generated schema |
| `model_post_turn_compact_threshold_percent` | no (absent) | — | — | — | generated schema |
| MCP output limits | none found | — | — | — | generated schema |
| `/compact` | yes (prompt command) | factory already sends it | n/a | manual | factory `COMPACT_COMMAND` |

Project instructions: native `AGENTS.md` from cwd; no Paseo interference found (Paseo's
`instruction-snapshot.js` only snapshots Paseo's own instructions). Presence after
clear/compact/resume/adoption: unknown (not live-tested).

## Muse Code (via builtin provider plugin `muse-provider`)

Spawns `muse serve` per session; per-session `config.env` is merged into the spawn env
(`builtin-plugins/muse-provider/server/session.ts:89`). `serveArgs` come from
`providerOptions`, but the schema is strict and allows **only**
`sandbox`/`trustWorkspace` — unknown keys throw (`options.ts:17-32`).
`muse serve -c KEY=VALUE` exists (per-host settings) but is unreachable via Paseo 0.17.4.

| setting | installed? | Paseo path | per-agent scope | default | evidence |
|---|---|---|---|---|---|
| `--max-tool-output-bytes` | only on `muse exec`, **not** on `muse serve` → unusable via Paseo | none | no | unknown | `muse exec --help` / `muse serve --help` |
| `context_compaction.provider_context_limit_tokens` | unknown (not in configuration doc; exec has `--context-compaction-*` flags, serve has no equivalent) | none (`-c` unreachable) | no | unknown | [configuration](https://dev.meta.ai/docs/muse-code/configuration) |
| auto-compaction | unknown (no documented knob on serve path) | none | no | unknown | — |
| `MUSE_*` env | plausibly honored (provider hashes `META_\|MUSE_` env into catalog key, `catalog.ts:23`) | env via hook | yes, but no known compaction key | — | `catalog.ts` |

Project instructions: per-level `AGENTS.md`, `CLAUDE.md`, `.agents/AGENTS.md`,
`.claude/CLAUDE.md` (deeper wins; project rules need workspace trust). Paseo passes
`--trust-workspace` by default (`trustWorkspace` default true, `options.ts`) → project
rules load. Presence after clear/compact/resume/adoption: unknown (not live-tested).

## Copilot CLI (via `copilot --acp`, generic ACP agent)

ACP spawn overlays `launchEnv` onto the child env (`acp-agent.js:899-905,1183-1207`);
Paseo passes no extra args (`copilot-acp-agent.js:65`). Settings live in
`~/.copilot/settings.json` or `$COPILOT_HOME` (global unless `COPILOT_HOME` is
per-agent-scoped via env — possible in principle, not examined).

| setting | installed? | Paseo path | per-agent scope | default | evidence |
|---|---|---|---|---|---|
| large-output offload | yes | `COPILOT_LARGE_OUTPUT_THRESHOLD_BYTES` env via hook ("set before starting the CLI") | yes | 20 KiB → temp file + preview | [context-management](https://docs.github.com/en/copilot/concepts/prompting-and-context/context-management) |
| background auto-compaction (~80%, pause ~95%) | yes, on by default | none found (no disable env documented) | no | on | same doc |
| manual `/compact` | yes | n/a (in-session command) | n/a | manual | same doc |

Project instructions: `AGENTS.md` + related files load by default (CLI offers
`--no-custom-instructions` to disable; Paseo does not pass it). Exact file list and
presence after clear/compact/resume/adoption: unknown.

## Mapping to factory mechanisms

Factory side: `plugin/server/cold-sweep.ts` + `plugin/shared/idle-cleanup.ts`
(`CLEAR_COMMAND=/clear`, `COMPACT_COMMAND=/compact Keep: …`) + `cache-profiles.ts`
(TTL profiles); `usage.warnContextTokens` warning threshold (`handlers.ts`);
`fresh`/rewind (`core/rewind.mjs`, `resume-apply.ts`).

| factory mechanism | native counterpart | verdict | notes / risks |
|---|---|---|---|
| cold-context sweep (cost-based `/clear`+`/compact`) | Claude auto/idle compaction, Copilot background compaction, Codex auto-compact limit | **keep**, optionally simplify trigger | different trigger (cache-cost vs window-size); **competing compaction** risk: factory `/compact` + native auto-compact = double summarization. Coordination knob: `DISABLE_AUTO_COMPACT=1` per-agent env on factory steers (Claude) — needs live measurement first |
| idle cleanup / auto-compact (TODO 15) | same as above | **keep** (quota-gated, native is not) | native compaction spends quota outside factory decisions; factory gates on known quota |
| `usage.warnContextTokens` | `/context` (Copilot), status line (Claude) | **keep** | native surfaces don't push warnings to the factory |
| rewind/fresh | native compaction, checkpoints (Copilot) | **keep** | only fresh drops cache-cost entirely; compaction never replaces it |
| output bounding (prompt-level short reporters) | `BASH_MAX_OUTPUT_LENGTH` (Claude), `COPILOT_LARGE_OUTPUT_THRESHOLD_BYTES` (Copilot) | **adopt** (few lines, no new layer) | per-worker env in the existing `agent.open.before` hook; complements prompt-level brevity |
| Codex output/compaction tuning | `model_auto_compact_token_limit` (global `config.toml` only) | **keep** factory behavior; no per-agent adoption | per-agent `CODEX_HOME` splits session store/auth — bypasses factory ownership; global config would affect the user's own CLI too |
| Muse output/compaction tuning | none reachable | **keep** | no usable knob via Paseo 0.17.4 |

## Recommendation (no new abstraction layer)

1. Set `BASH_MAX_OUTPUT_LENGTH` (workers, e.g. well below 30000) and
   `COPILOT_LARGE_OUTPUT_THRESHOLD_BYTES` (workers, at/below 20 KiB) in the existing
   `agent.open.before` hook, filtered to factory labels. 2–3 lines, per-agent, no
   global effect.
2. Decide compaction ownership per provider **after** live measurement: either disable
   native auto-compact on factory steers (`DISABLE_AUTO_COMPACT=1`, Claude) so the
   sweep owns timing, or drop the factory proactive compact where native idle
   compaction provably suffices. Do not run both blindly (double summarization).
3. No per-agent `CODEX_HOME`, no `providerOptions` plumbing, no Muse changes in 0.17.4.
4. Cache note: env changes apply at next open/resume and don't themselves invalidate
   prompt cache (content-keyed); `appendSystemPrompt` changes do — keep role prompts
   stable per the native-plugin spike.

Open questions: Codex `model_auto_compact_token_limit` default; Muse compaction key
names/defaults; Copilot compaction disable knob; instruction persistence across
clear/compact/resume/adoption for all four (needs live scratch-agent runs);
Claude SDK-bundled-CLI vs installed-CLI env-var parity.
