# Configuration

The config is looked up in this order: `--config <path>`, `$PASEO_FACTORY_CONFIG`, `$XDG_CONFIG_HOME/paseo-workspace-factory/config.json` (default `~/.config/paseo-workspace-factory/config.json`). Start from [`config.example.json`](../config.example.json). Keep it outside the repository; it is personal.

## Fields

| Field | Description |
|---|---|
| `version` | `1` |
| `github.owner` | Account that owns the forks. |
| `github.cloneProtocol` | `https` or `ssh`. |
| `github.upstreamRemote` | Remote name for the parent repository (usually `upstream`). |
| `checkoutRoot` | Absolute directory below which repositories are cloned. |
| `workspaceTitle` | Title of the main workspace (`Main`). |
| `handoffLanguage` | `en` (default) or `de`. |
| `profiles.<name>` | `provider`, `model`, `thinking` (or `null` for the provider default), `mode`. Validated against the live provider catalog before a steer is planned. |
| `steers.slots` | Slot letter → profile name. Changing a slot's profile does not change an existing steer; the plan only reports the difference. |
| `steers.prepare` | Slots created for every repository. |
| `steers.initialActive` | Active steer after provisioning. |
| `workers.defaultProfile` | Profile name for workers. |
| `runtime.stateDir` | Plans, progress, journals and locks (default `$XDG_STATE_HOME/paseo-workspace-factory`). |
| `runtime.scratchDir` | Scratch repositories of live tests (default `<stateDir>/scratch`). |
| `runtime.paseo.url` | Daemon WebSocket URL (default `ws://127.0.0.1:6767/ws`). |
| `runtime.paseo.bin` | `paseo` CLI (default `paseo` on PATH); its installation also provides the SDK. |
| `runtime.paseo.passwordFile` | File with the daemon password, if the daemon requires one. |

Environment overrides: `PASEO_FACTORY_STATE_DIR`, `PASEO_FACTORY_SCRATCH_DIR`, `PASEO_WS_URL`, `PASEO_FACTORY_PASEO_BIN`, `PASEO_PASSWORD_FILE`, `PASEO_PASSWORD`.

## Known provider exceptions

Some settings appear in the catalog but are rejected when an agent is created. The factory reports these during planning:

- Copilot with Claude models rejects a thinking level — use `"thinking": null`.

## Live tests

Not part of `npm test`; each needs an explicit approval variable and keeps everything it creates:

| Command | What it does |
|---|---|
| `WSF_LIVE_WRITE=approved node test/integration-live.mjs` | Scratch repo, one workspace, one agent without prompt: idempotency, key conflict, parent freedom, metadata read-back. |
| `WSF_LIVE_CRASH=approved node test/integration-crash.mjs` | Real apply runner killed right after the workspace create; a new process recovers the id through the receipt. |
| `WSF_LIVE_CLEANUP=approved node test/integration-live.mjs --cleanup <manifest>` | Fail-closed cleanup: archives only fully verified scratch resources; never deletes files. |
