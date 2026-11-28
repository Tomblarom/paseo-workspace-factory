# Registry readiness

**Keep `plugin/paseo-plugin.json` at `"requirements": { "paseo": ">=0.17.1" }`.** The API floor is **0.17.0**. That tag introduced the `appendSystemPrompt` return field used to deliver Factory role instructions. Paseo published the 0.17.0 CLI, daemon and SDK on npm. GitHub has a source tag for 0.17.0 and its release endpoint reports 404. The 0.17.1 GitHub release includes macOS, Windows and Linux desktop builds. Factory ships both server and client entries, so 0.17.1 is the first verified public desktop release with the full API. The settings-store test used Paseo 0.17.4. [0.17.0 source][v017] · [0.17.0 CLI on npm][npm017] · [0.17.1 desktop release][desktop0171]

## Paseo API inventory

Versions are the first stable source tags containing the contracts in use, including newer signatures where a contribution changed. The evidence comes from upstream tags and commits in the local Paseo checkout. A release tag establishes source availability. The table does not record live tests on every version.

| API, hook or slot used | Introduced | Tagged source or commit |
| --- | --- | --- |
| Split `index.server.ts` and `index.client.tsx` entries, `requirements.paseo`, `PluginServerContext` and `PluginClientContext` | 0.8.0 | [Entry migration][split] · [Client contract][client08] |
| `defineRpc`, `server.handle` for RPCs, handler `ctx.paseo`, contribution and command `rpc`, `useRpc` | 0.8.0 | [SDK][plugin08] · [Client contract][client08] |
| `defineSettings` with version and `migrate`, `registerSettings`, host settings `read`, `settingsRpc` read/write contracts, `useSettings` with save and reload | 0.8.0 | [Settings API][settings08] · [Host store][store08] · [Client contract][client08] |
| `addSettingsScreen`, `openSettings` and host UI `SettingsAction`, `SettingsCard`, `SettingsInput` with `getText` and `replaceText`, `SettingsRow`, `SettingsSection`, `SettingsSelect`, `SettingsSwitch` | 0.8.0 | [Client contract][client08] · [UI declarations][ui08] |
| `addWorkspacePanel` workspace slot and `locations: ["workspace"]`, `openPanel(id, {workspaceId, agentId})` and command-context `openPanel(id)` | 0.8.0 | [Panel and command contracts][client08] |
| `addWorkspacePanel` without a `context` field and dedicated `addAgentPanel` with `params.agentId` | 0.13.0 | [Panel split][panels] · [Client contract][client013] |
| `addCommandCenterItem` workspace action and `addSlashCommand` agent action with `argumentHint` | 0.8.0 | [Client contract][client08] |
| `addComposerPill` scoped by workspace and agent, button `update` and `remove`, component icons, action/menu/popover behavior and item/separator entries | 0.8.0 | [Client contract][client08] · [Button contract][buttons08] |
| `addTimelineRenderer` with a versioned schema and `addTimelineTransformer` with item type and phase | 0.8.0 | [Client contract][client08] |
| `useAgent`, `usePaseo` and host/theme/layout props | 0.8.0 | [SDK][plugin08] · [Client contract][client08] |
| `useHosts` | 0.9.0 | [Client exports][client09] |
| `addSidebarHeaderItem`, `SidebarRow`, manifest `name`, `icon` and `media` | 0.11.0 | [Sidebar introduction][sidebar] · [Manifest reference][reference] |
| `Icon`, `Modal` with `Modal.Content`, `Markdown`, `copyText` and `useToast` | 0.13.0 | [UI declarations][ui013] |
| `server.addHook` for `agent.turn.before`, `agent.turn.after`, `agent.create.after`, `agent.archive.after` and `agent.open.before`, including the latter's `request.env`, labels, purpose and reason | 0.15.0 | [Hook rename and runtime][hooks] · [Hook contracts][hooks015] |
| `agent.open.before` reads `request.metadata`. Turn-end processing reads the timeline with `wholeTurns`. | 0.16.0 | [Hook contracts][hooks016] · [SDK timeline][sdk016] |
| `defineSubscription`, `server.handle` with `push` and `signal`, `client.subscribe` with `onClosed` and `release`, `useSubscription` | 0.16.0 | [Streaming RPC introduction][streams] · [RPC contracts][rpc016] |
| `client.composers` and `useComposers({agentId})`, composer `prompt`, `setPrompt`, `insertText` and `focus`, plus `useAgents` with a host filter | 0.16.0 | [Composer and metadata introduction][composer] · [Client SDK][plugin016] |
| `agent.open.before` returns `appendSystemPrompt` | **0.17.0** | [Prompt injection implementation][append] · [Hook contracts][hooks017] |

The entry points also reach these daemon SDK and CLI surfaces through their handlers. Versions below refer to the operation itself or the additional contract named in the row.

| Daemon operation | Introduced | Tagged source |
| --- | --- | --- |
| Public SDK `createPaseoClient`, `agents.list/ref`, `workspaces.list/ref`, agent and workspace `refresh`, `providers.snapshot`, `config.get`, agent `send/archive`, timeline `refetch/subscribe` | 0.1.84 | [Client SDK][sdk0184] |
| Agent `detach` | 0.1.98 | [Client SDK][sdk0198] |
| Workspace `agents.create` and agent `waitForFinish` | 0.4.0 | [Client SDK][sdk04] |
| `projects.list` and agent `commands` | 0.7.0 | [Client SDK][sdk07] |
| Timeline subscription with a `ready` promise and release by calling the unsubscribe function | 0.8.0 | [Owned timeline subscription][owned08] |
| Creation `idempotencyKey`, `creationLifecycle` and the internal `creation.subscribe` receipt exchange | 0.9.0 | [Client SDK][sdk09] · [Receipt protocol][protocol09] |
| CLI SDK subpath `@getpaseo/client/internal/daemon-client` used for receipts, timeline and conversation rewind, user brief delivery, model and thinking updates, and plugin RPCs | 0.11.1 | [Client package exports][internal0111] · [DaemonClient methods at the compatibility floor][internal017] |
| `includeBackground` filtering | 0.12.0 | [Protocol schemas][protocol012] |
| Agent/workspace `setMetadata`, creation metadata, `timeline.refetch({ wholeTurns: true })` and internal `setAgentOptions` | 0.16.0 | [Metadata introduction][composer] · [Client SDK][sdk016] |
| Registry install by slug, used for distribution | 0.17.0 | [Registry and gallery implementation][gallery] · [CLI at 0.17.0][cli017] |

## Package and settings checks

- The npm dry run and snapshot build both ship the CLI, manifest, overview, icon and both entry points while excluding `test/` and `node_modules/`. The icon is a valid 256 × 256 PNG. The current npm package has development dependencies and host imports. It declares no runtime dependency tree or manifest build step. [Publishing guide][publishing]
- The registry test reads seeded, versioned settings through the installed Paseo host store when available and validates the results against the settings RPC contract. It reopens each migrated document and verifies the saved version and values, including the original v1/v2 config snapshots and the snapshot carried forward from v3. SDK-only CI exercises the same fixtures and RPC contract with a temporary file-backed adapter. [Registry test](../plugin/test/registry-package.test.mjs)
- All three requested migration families are host-scoped. Cleanup v2 retires `compactAtMinutes` and `seedAfterClear`. It preserves the remaining stored fields and uses the balanced profile by default. Factory's former device-scoped `factory-sidebar` v1 is retired. Paseo's native sidebar setting now controls visibility, and the old Factory value is ignored. [Settings definitions](../plugin/shared/settings.ts)

## Before release

- [ ] Choose the distribution source and confirm the first release version. For npm, the proposed metadata is `"version": "0.1.0"`, removal of `"private": true`, and `"repository": { "type": "git", "url": "git+https://github.com/Tomblarom/paseo-workspace-factory.git" }` for registry ownership. For the Git route, retain the private flag and select the reviewed commit in the `plugin/` subdirectory. [Publishing guide][publishing]
- [ ] Confirm that `assets/icon.png` is the final listing icon.
- [ ] Capture an interface screenshot with sample data. The `media` array can stay empty if the screenshot is supplied in the submission. Current registry guidance requires an interface image for visual plugins. [Registry media requirements][media]
- [x] On an isolated daemon (`Paseo 0.17.4`, fresh `--home` without `node_modules`), installed managed Git revision `4d6b83a` (`plugin/`), seeded non-default host settings (`factory-metrics.json`, `factory-display.json`), and ran `paseo plugin update workspace-factory --yes` to a successor commit (`outcome: "updated"`). Verified the plugin built cleanly, updated its revision, and preserved all seeded host settings. This check also caught and fixed a real bundling blocker: a static `import type ... from "@getpaseo/client"` in `plugin/server/steer-delivery.ts` (`4d6b83a`, guarded by `plugin/test/registry-package.test.mjs`). [Update behavior][updates]

[v017]: https://github.com/getpaseo/paseo/tree/70300fcda04d4225bddaa64a4d19bbbae2cda616
[npm017]: https://www.npmjs.com/package/@getpaseo/cli/v/0.17.0
[desktop0171]: https://github.com/getpaseo/paseo/releases/tag/v0.17.1
[split]: https://github.com/getpaseo/paseo/commit/1f5b6143d6
[plugin08]: https://github.com/getpaseo/paseo/tree/v0.8.0/packages/plugin/src
[client08]: https://github.com/getpaseo/paseo/blob/v0.8.0/packages/plugin/src/client/contracts.ts
[settings08]: https://github.com/getpaseo/paseo/blob/v0.8.0/packages/plugin/src/settings.ts
[store08]: https://github.com/getpaseo/paseo/blob/v0.8.0/packages/server/src/server/plugins/settings/index.ts
[buttons08]: https://github.com/getpaseo/paseo/blob/v0.8.0/packages/plugin/src/client/buttons.ts
[ui08]: https://github.com/getpaseo/paseo/blob/v0.8.0/packages/plugin/src/client/ui.ts
[client09]: https://github.com/getpaseo/paseo/blob/v0.9.0/packages/plugin/src/client/index.ts
[sidebar]: https://github.com/getpaseo/paseo/commit/3a9304607c
[reference]: https://paseo.sh/docs/plugins/reference
[panels]: https://github.com/getpaseo/paseo/commit/4fe006df86
[client013]: https://github.com/getpaseo/paseo/blob/v0.13.0/packages/plugin/src/client/contracts.ts
[ui013]: https://github.com/getpaseo/paseo/blob/v0.13.0/packages/plugin/src/client/ui.ts
[hooks]: https://github.com/getpaseo/paseo/commit/986687b8fd
[hooks015]: https://github.com/getpaseo/paseo/blob/v0.15.0/packages/plugin/src/server/lifecycle.ts
[hooks016]: https://github.com/getpaseo/paseo/blob/v0.16.0/packages/plugin/src/server/lifecycle.ts
[streams]: https://github.com/getpaseo/paseo/commit/d4ac64f335
[rpc016]: https://github.com/getpaseo/paseo/blob/v0.16.0/packages/plugin/src/rpc.ts
[composer]: https://github.com/getpaseo/paseo/commit/28c188513e
[plugin016]: https://github.com/getpaseo/paseo/tree/v0.16.0/packages/plugin/src/client
[append]: https://github.com/getpaseo/paseo/commit/3d30aaec426
[hooks017]: https://github.com/getpaseo/paseo/blob/v0.17.0/packages/plugin/src/server/lifecycle.ts
[sdk0184]: https://github.com/getpaseo/paseo/blob/v0.1.84/packages/client/src/index.ts
[sdk0198]: https://github.com/getpaseo/paseo/blob/v0.1.98/packages/client/src/index.ts
[sdk04]: https://github.com/getpaseo/paseo/blob/v0.4.0/packages/client/src/index.ts
[sdk07]: https://github.com/getpaseo/paseo/blob/v0.7.0/packages/client/src/index.ts
[owned08]: https://github.com/getpaseo/paseo/commit/18aaec2772
[sdk09]: https://github.com/getpaseo/paseo/blob/v0.9.0/packages/client/src/index.ts
[protocol09]: https://github.com/getpaseo/paseo/blob/v0.9.0/packages/protocol/src/messages.ts
[internal0111]: https://github.com/getpaseo/paseo/blob/v0.11.1/packages/client/package.json
[internal017]: https://github.com/getpaseo/paseo/blob/v0.17.0/packages/client/src/daemon-client.ts
[protocol012]: https://github.com/getpaseo/paseo/blob/v0.12.0/packages/protocol/src/messages.ts
[sdk016]: https://github.com/getpaseo/paseo/blob/v0.16.0/packages/client/src/index.ts
[gallery]: https://github.com/getpaseo/paseo/commit/ef146bc62d
[cli017]: https://github.com/getpaseo/paseo/blob/v0.17.0/packages/cli/src/commands/plugin/index.ts
[publishing]: https://paseo.sh/docs/plugins/publishing
[media]: https://paseo.sh/docs/plugins/publishing#icons-and-screenshots
[updates]: https://paseo.sh/docs/plugins#install-a-published-plugin
