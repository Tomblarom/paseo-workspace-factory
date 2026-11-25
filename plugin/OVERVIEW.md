Workspace Factory provisions and steers standardized Paseo workspaces from GitHub repositories. It creates one main workspace per repository with steer agents in slots A to Z, tracks the active steer with its task checkpoint, and hands coordination from one steer to another.

## How it works

The plugin speaks to the daemon through RPCs. Reads show status and dry run plans. Writes stay two stage: a plan or preview first, then a confirm step that quotes the stored plan hash or the preview fingerprint. The server recomputes the fingerprint from fresh state and refuses stale previews, so a write never runs without the preview shown in the panel.

The `/factory` slash command offers status, scopes, cleanup, plan, apply, checkpoint, switch, and resume. Without a scope address, commands use the scope of the current workspace; in workers the command refuses with a hint. The Factory panel shows results with confirm buttons. Command Center items open the same panel. A sidebar entry shows a compact steer status; it is shown or hidden in Paseo's own sidebar settings.

## Cold context

The plugin tracks Factory turn outcomes, CHECKPOINT blocks, and interruptions without a model call. The composer pill and **Factory: context** panel show why a chat needs attention. **Continue writing** returns to the composer. **Refresh chat** previews a reset in the same steer tab and sends a short work brief after confirmation. **Open saved chat in new tab** is available when an earlier session was saved.

In a steer tab, `/factory resume` delivers the brief and first clears the context on providers configured for native clearing. `/factory resume --brief` shows the read-only report. The plugin generates handoff previews and messages in English.

Idle cleanup mode `compact-warm` can compact eligible chats before the cache expires and suggest a fresh context for cold chats. An opt-in setting can rewind eligible Codex chats in place. Mode `clear` can start a new session on providers with native `/clear` after you acknowledge the effect on chat history. Cleanup verifies the provider command’s effect and pauses with a hint if the command arrives as text.

## Setup

The plugin needs Paseo 0.16.2 or later on both the daemon and the app. The daemon host needs git, the gh CLI, the paseo CLI, flock, and Node 22 or later. Enter the GitHub owner and checkout root in Factory settings. The plugin also reads the factory CLI configuration file when present.

Install from a Git checkout or a built release directory on the Paseo host. A checkout updates with pull and reload, keeping settings. For a built release, note your settings before replacing the installation. Removing the plugin deletes its settings. The optional findings reminder is available for Git checkout installs. [Installation and updates](https://github.com/Tomblarom/paseo-workspace-factory/blob/main/docs/getting-started.md#quickstart-in-paseo)

Open **Settings → Plugins → Factory** to configure steer slots, worker profile priority, the idle cleanup mode, and CHECKPOINT display. Profile options come from the live Paseo provider catalog. The chat display switch changes what you see in the app. The model still receives the full CHECKPOINT.

## Capabilities and limits

Profile and slot changes never touch running steers. The panel marks a steer that drifts from its configured profile, and the next plan reports the difference.

The plugin reads daemon state, local git checkouts, and GitHub through gh. It writes workspaces, agents, workspace metadata, and plan files on the daemon host. Plugin code is trusted code: server code runs unsandboxed with the daemon user's access, and client code runs inside the Paseo app.

Limits: one daemon host per install, no waiting for a new steer's reply, no notification to the replaced steer, and no tab reordering. The panel only recommends a tab order of steers A to Z followed by workers, since Paseo owns tab layout. Creation receipts are verified through a capability-checked, fail-closed lookup of the daemon's `creation.subscribe` protocol.
