# Worker notifications: research notes (observation phase)

Status: research only, nothing implemented. The user wants to observe first (2026-11-24).
Goal: decide which agents' notifications Paseo sends, per agent or role.

## What Paseo does today (getpaseo/paseo main, installed 0.16.2)

- **Delegated agents are silent.** `agent-manager.ts` → `broadcastAgentAttention()` returns early for `isDelegatedAgent(agent)`, which is any agent with the `paseo.parent-agent-id` label (getpaseo/paseo PR 1293, merged 2026-06-02). This silences everything: finished, error and permission. No push and no in-app alert.
- **Factory workers carry that label.** `src/workers.mjs` starts them with the steer as parent. So worker turns should not notify, but worker errors and permission requests are silent too.
- **Background and internal agents never raise attention** (`raisesAttention()` = `!internal && !background`). `background: true` is fixed at creation and also hides the agent from tabs and lists (getpaseo/paseo PR 8683).
- **Push policy** (`agent-attention-policy.ts`): a present client focused on the agent suppresses the alert. A present client gets an in-app alert. Otherwise a push is sent, except for reason `error`, which is never pushed.
- **Client side:** `wantsSourceNotification(ws, "agent_attention_required")` is per connection or device, not per agent.
- **No plugin hook** can cancel or filter a notification (`packages/plugin/src/server/lifecycle.ts` has no attention event).
- A side effect of `agent run` from inside an agent: Paseo adds the parent label automatically. That silences the new agent and makes it a delegated child. Use `paseo agent detach` for top-level agents such as steers.

## Upstream state

| Item | State | Content |
|---|---|---|
| getpaseo/paseo Discussion 6831 | open, 5 upvotes | "Let callers mute 'finished' pushes for child agents": a creation-time policy set by the caller. This is what the factory would need. |
| getpaseo/paseo PR 7175 | open since 2026-10 | Per-agent "Mute completion alerts" in the tab menu (completion only; errors and permissions unchanged) |
| getpaseo/paseo PR 6913 | open | Host-wide switch to turn off finished notifications |
| getpaseo/paseo PR 6630 | open draft | Per-device notification preferences |
| getpaseo/paseo PR 10223 | open | Skip a finished alert while child work is still active (parent idles during a child run) |
| getpaseo/paseo Issue 7173 | closed, not planned | Per-agent mute; redirected to Discussion 6831 |

## Likely sources of the alerts the user sees (unverified)

The daemon log (`~/.paseo/*daemon.log`, "Sending push notification") does not record the agent id, so alerts could not be attributed.

1. **Steers woken by a worker result.** The worker is silent, but the steer's follow-up turn ends `finished` and alerts. PR 10223 covers a related race.
2. **Top-level helper agents without a parent label.** On 2026-11-24 there were 61 live, unlabelled, non-background agents, e.g. "PR presentation · …" and "[Handoff] …".

To check during observation, note the title of the agent behind each unwanted alert.

## Option if we act later

Contribute a per-agent notification policy to Paseo: `all | errors-and-permissions | off`. Callers and plugins could set it at creation and change it later, and the tab menu would offer it. It would build on PR 7175 and Discussion 6831. The factory would then set it per role, for example steers `all` and workers `errors-and-permissions`. That would also fix today's gap that delegated workers stay silent on errors and permission requests.
