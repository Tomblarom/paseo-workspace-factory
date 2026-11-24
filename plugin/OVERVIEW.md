Workspace Factory provisions and steers standardized Paseo workspaces from GitHub repositories. It creates one main workspace per repository with steer agents in slots A to Z, tracks the active steer with its task checkpoint, and hands coordination from one steer to another.

## How it works

The plugin speaks to the daemon through RPCs. Reads show status and dry run plans. Writes stay two stage: a plan or preview first, then a confirm step that quotes the stored plan hash or the preview fingerprint. The server recomputes the fingerprint from fresh state and refuses stale previews, so a write never runs without the preview shown in the panel.

The `/factory` slash command offers status, scopes, cleanup, plan, apply, checkpoint, switch, and resume. Without a scope address, commands use the scope of the current workspace; in workers the command refuses with a hint. The Factory panel shows results with confirm buttons. Command Center items open the same panel. A sidebar entry shows a compact steer status; it is shown or hidden in Paseo's own sidebar settings.

## Cold context

Every factory turn is recorded without model calls, including CHECKPOINT blocks and interruptions. A cold agent (idle past the threshold with a large context) gets a "Kontext kalt" composer pill and agent panel with three manual actions: resume (read-only brief), fresh (two-stage handover to a new agent; the old one keeps its tab), and opening the saved old history as a new tab. `/factory resume` shows the same brief in the Factory panel.

The optional idle cleanup shrinks cold agents automatically: mode `compact-warm` compacts before the cache TTL expires, mode `clear` empties the session (only with the explicit acknowledge switch, since only the new session survives a reload). Automatic `fresh` is not offered. Cleanup sends through the plugin SDK only, verifies its effect on the first attempt per agent, and switches itself off with a hint when a command arrives as text.

## Setup

The plugin needs the factory config file on the daemon host, the same file the factory CLI reads. It also needs Paseo 0.16.2 or later on both the daemon and the app. The daemon host needs git, the gh CLI, the paseo CLI, flock, and Node 22 or later.

Settings live under Settings, Plugins, Factory. The host section edits steer slots, the prepare list, the start steer, the worker default profile, and the profiles they use, with provider, model, thinking, and mode taken from the live provider catalog. The idle cleanup section holds the automation mode (default off), thresholds, providers, roles, and the clear acknowledgement. The chat display section holds one host-wide switch for CHECKPOINT blocks in chat: on (default) shows the full block, off shortens it to one summary line (display only, no token savings). The sidebar section notes that the entry is shown or hidden in Paseo's own sidebar settings.

## Capabilities and limits

Profile and slot changes never touch running steers. The panel marks a steer that drifts from its configured profile, and the next plan reports the difference.

The plugin reads daemon state, local git checkouts, and GitHub through gh. It writes workspaces, agents, workspace metadata, and plan files on the daemon host. Plugin code is trusted code: server code runs unsandboxed with the daemon user's access, and client code runs inside the Paseo app.

Limits: one daemon host per install, no waiting for a new steer's reply, no notification to the replaced steer, and no tab reordering. The panel only recommends a tab order of steers A to Z followed by workers, since Paseo owns tab layout. Creation receipts are verified only on tested Paseo releases, currently 0.16.2.
