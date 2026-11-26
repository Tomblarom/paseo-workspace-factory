# Plugin icon and switching a release to a Git checkout

Investigated with the installed Paseo CLI, daemon and Web UI bundle at **0.16.2**.
The icon and update conclusions come from shipped code, a read-only daemon inventory
and the public registry. The expected screen rendering is inferred from the bundle.
The switch workflow below is a design.

## Why Settings shows a letter

The Factory asset already meets the manifest contract. Keep `plugin/paseo-plugin.json`
with `"icon": "assets/icon.png"` and ship `plugin/assets/icon.png` with the plugin.
The current image is 256 × 256, RGBA PNG, 6,230 bytes and mode `0600`. That mode is
sufficient when the daemon owns the file, as on the inspected host. Git tracks it as
`100644` (regular, non-executable). A distributor can ship it as `0644` to make it
readable to a different daemon user. The 0.16.2 manifest validator checks the
package-relative path and `.png` suffix, with no file open, byte or pixel limit.
Publishing requires a PNG and includes `assets/` in npm packaging. See the
[manifest reference](https://paseo.sh/docs/plugins/reference.md#project-files) and
[publishing guide](https://paseo.sh/docs/plugins/publishing.md#icons-and-screenshots).

1. The installed `dist/server/server/plugins/manifest.js` parses the manifest.
   `plugins/index.js` (`PluginService.listPlugins`) copies the path to `item.icon`,
   and `session.js` returns it via `plugin.list.request` → `plugin.list.response`.
   This RPC supplies metadata. The Settings image flow has no local asset URL or
   RPC for reading the referenced PNG.
2. The shipped Web UI entry `web-ui/_expo/static/js/web/index-3d51f4c450eeff5bd838a646e9c611f2.js`
   joins each installed row to a registry listing through `installedListingId`
   (Metro module `5802`). That requires `installation.identity.registry.id` on a
   managed Git or npm installation. `InstalledTab` (`5808`) passes `listing?.icon`
   to `PluginRow`, and `PluginPage` (`5812`) likewise uses the listing icon in the
   detail header. `PluginTile` (`5803`) loads it as `Image` with `{ uri: icon }` or
   renders the first letter of the display name. The daemon gets the listing from
   `index.json` or `plugins/<owner>/<slug>.json` via the registry RPC. The client
   loads the image URL supplied by that listing.
3. `paseo plugin ls --json` reports `assets/icon.png` for both running plugins.
   `workspace-factory` is a checkout-directory install without a registry ID.
   `agent-usage-plugin` is a managed Git install tied to `casonmo/agent-usage`.
   Its on-disk PNG is 512 × 512 RGBA, 90,998 bytes and also mode `0600`. Its public
   listing supplies an absolute GitHub image URL, independent of the local PNG.
   A read-only request to that URL returned HTTP 200 with `image/png`.
   The installed-list query has a 1-second stale time and the registry query a
   10-minute stale time with refetch on mount. Directory installs never enter the
   registry join, so waiting, refreshing or renaming the PNG cannot fill the row's
   image prop. See the [Agent Usage listing](https://plugins.paseo.sh/plugins/casonmo/agent-usage.json).

### Fix and verification

For a local directory install, Paseo needs to deliver the manifest PNG
through an authenticated asset RPC or URL scoped to the selected host and plugin ID,
and use that image in both Settings views when there is no registry icon. Resolve
the real asset path within the plugin directory, validate and bound the image bytes,
and key the cached image by asset digest so replacements refresh. Keep the existing
Factory file, manifest field and dimensions. A registry listing with an icon gives
0.16.2 an image when installed through that listing. An explicit `github:` install
has no registry association by itself.

On 0.16.2, confirm that `paseo plugin ls --json` reports the icon for
both comparison plugins, then open the Installed tab and each plugin's detail page
on the same host. Expect a Factory initial and the Agent Usage image if the registry
and image URL are reachable. For an upstream fix, require the 256 × 256 Factory PNG
to appear in both views for the same directory installation. Change its bytes at the
same path and verify that the image refreshes. Exercise missing, invalid and
out-of-package assets, and verify the registry comparison still renders.

## Switch to git install

Status 2026-11-26: not pursued (decision Steer C after a user note); findings
stay a development-checkout function. The design below is kept for reference.

### Options

| Option | Evidence and consequence |
| --- | --- |
| Local Git checkout and detached helper | Install `<checkout>/plugin` as a directory under the original runtime ID. The repository stays at a stable, user-owned path. `git pull` and `paseo plugin reload` are separate operations and reload preserves settings. A process outside the plugin lifetime can drive the native CLI and restore settings. |
| Paseo-managed Git | `paseo plugin install github:<owner>/<repo>:plugin` stages a full `git clone --no-checkout`, detaches at the selected commit and moves the checkout to `<PASEO_HOME>/plugins/<id>/<uuid>/checkout/plugin`. The repository root contains `.git`, confirmed for the installed Agent Usage plugin (which uses `checkout` directly). A Factory monorepo install there can satisfy today's `factoryRoot` probe. A successful `paseo plugin update <id>` creates a fresh checkout and recursively deletes the old version directory. Local or ignored `FINDINGS.md` disappears with it. Existing prompts also retain the old absolute path. Direct Git `--ref` selects the initial revision, and ordinary updates follow remote HEAD. |
| One-time settings import file | A target release could consume a versioned file from a private Factory state directory on start. Consumption would need host and target binding, validation, replay protection and a completion acknowledgement. The 0.16.2 server settings handle exposes `read` and `subscribe`. Writes go through registered settings RPCs. This option needs importer support in the target and rollback release, or private storage writes, so it adds little to the detached helper. |
| Slash command with preview and confirm | Extend the existing `/factory` panel flow with `/factory install-switch` and link the same preview from **Chat and prompts**. The slash command runs in the app. It can start the daemon-side operation after confirmation, but its plugin-owned panel and RPCs may disappear during replacement. Keep progress and recovery with the helper. |

Paseo 0.16.2 rejects an existing install ID, skips directory sources in `update`,
and exposes no supported source replacement that preserves settings. `removePlugin`
stops the plugin subprocess, then deletes `<PASEO_HOME>/plugin-settings/<id>`.
Removal retains directory sources, including the release directory. A failed
directory activation can leave a configured `failed` entry, so recovery must inspect
the installed path and status after an error. Managed staging and cleanup are in
`plugins/managed-source.js` (`prepareInstall`, `place`, `removeVersion`) and
`plugins/index.js` (`updateSource`, `removePlugin`). See the
[Paseo CLI reference](https://paseo.sh/docs/plugins/reference.md#cli-reference) and
[Factory source install](../getting-started.md#build-from-source).

### Recommended workflow

1. **Preview.** Use the selected daemon's plugin list for runtime ID, path and
   `installation.identity.kind`. Reuse `realpath` and `findFactoryCheckout` from
   `plugin/server/prompt-settings.ts` to recognize a checkout. `factoryRoot === null`
   alone proves only that checkout detection failed. Identify a built release by
   its Factory manifest and verified snapshot identity (today the builder uses
   `workspace-factory-<hash12>`). Start with the default `workspace-factory` ID,
   which the current prompt RPC looks up explicitly. Treat custom directories
   and managed sources as separate cases. Use the effective `checkoutRoot`
   (`factory-config` overrides the file value) plus `paseo-workspace-factory` as
   the default destination, with an explicit absolute host path if needed. An
   existing checkout may be used after verifying its origin, selected revision,
   plugin and writability.
   Preserve existing edits and findings. Preview `Tomblarom/paseo-workspace-factory`,
   exact commit, daemon, runtime ID, source and destination paths, expected
   interruption and rollback path. Confirm the plan before cloning or replacing.
2. **Prepare externally.** Reuse the installed Paseo CLI and Factory's existing
   `connectPluginRpc` transport (`src/paseo.mjs`, mirrored into the plugin). Run a
   short-lived Node helper packaged with the release, using an absolute executable,
   a stable working directory, `detached: true`, redirected stdio and `unref()`.
   Acknowledge the recorded job before authorizing removal. Use the verified local
   endpoint and daemon ID for both transports. Preflight `daemon.manage` and abort
   on host mismatch. Lock by daemon and runtime ID. Use a private job directory
   outside either plugin directory (`0700`, files `0600`) and atomic journal writes.
   Clone to a sibling staging directory and verify the reviewed commit, manifest,
   runtime compatibility and destination before moving it into place. The checked-in
   runtime needs no dependency install. Preserve a reusable checkout and old release.
3. **Export.** Read all five host settings documents via the registered
   `settings.<id>.read` RPC. Record document IDs, schema versions, values and source
   revisions in the private job backup. The documents are `factory-config`,
   `factory-display`, `factory-cleanup`, `factory-resume` and `factory-supervision`
   ([definitions](../../plugin/shared/settings.ts)). Abort on unreadable data or
   incompatible schemas. Start with known matching definitions, and add explicit
   forward transformations before supporting schema changes. Preserve values such
   as `findingsInPrompts: false` and nullable overrides. Show only document IDs and
   job status. Recheck source and revisions immediately before removal. Paseo has
   no transaction combining settings revisions with removal, so a concurrent edit
   in that final interval remains a race.
4. **Replace and restore.** Run the CLI removal and wait for its response and
   verified absence before installing the checkout under the same ID. Verify the
   expected real path and `running`. Restore via `settings.<id>.write`, using each
   newly read revision and checking `saved` plus read-back. The store handles
   schema validation, notification and per-document conflicts. Gate the new
   Factory's cleanup, supervision and other stateful handlers on the pending
   journal so they cannot act with default or partially restored settings.
   Finish only when settings match and `factory.prompt-settings` reports the new
   root. When enabled, a newly generated brief should point to `<checkout>/FINDINGS.md`.
5. **Recover.** Journal each transition so a fresh CLI invocation can resume a
   failed job even when the panel is unavailable. After interruption, reconcile
   the journal with the installed path and settings values before retrying.
   If activation or restoration fails, remove a failed candidate only after
   verifying its identity, reinstall the retained release by exact path and
   restore via its existing settings RPCs.
   If a different installation occupies the ID or settings have changed since a
   partial restore, stop and show the conflict without overwriting it. Retain the
   backup on failure and discard it only after verified completion or rollback.
   Report success or a recovery command from the journal when the UI reconnects.
   A retained release without the journal gate can briefly run with defaults
   during rollback. Cover that case in the supported release matrix.

The documented settings API registers the per-document RPCs in
`plugins/settings/index.js` and the shipped `@getpaseo/plugin` exports `settingsRpc`.
`plugin.rpc.invoke.request` requires `daemon.manage` in
`authorization/operation-permissions.js`. The existing Factory CLI already uses
the installed client's internal RPC transport. The helper can therefore work with
the retained release even if that release has no switch UI or importer. Keep the
transport compatibility check in preflight. See
[Paseo settings](https://paseo.sh/docs/plugins/reference.md#persisted-values) and
[slash commands](https://paseo.sh/docs/plugins/reference.md#slash-commands).

### Tests before shipping

- Unit-test detection (snapshot, recognized checkout, managed Git, unknown),
  checkout root and collisions, stale confirmation, daemon mismatch and settings
  export/restore with all five schemas, empty/default settings and explicit `false`.
- On a disposable 0.16.2 daemon, confirm from the release UI, close the client or
  kill the original plugin subprocess during replacement, and verify that the
  detached job finishes on the selected host. Check same runtime ID, checkout
  path, settings read-back and freshly generated steer and worker briefs. Append
  a fixture finding and verify it survives a local checkout update and reload.
- Inject clone, removal, activation and partial restore failures, a stale revision,
  and interruption at each journal boundary. Verify retry and rollback restore the
  original release and settings, concurrent confirmations cannot replace twice,
  and no backup values or credentials reach logs.

### Open questions

- Which Factory release tags should define the initial supported source/target pairs?
- Does the helper outlive plugin shutdown under every supported daemon service
  manager, or should some installations use the same helper from a host terminal?
