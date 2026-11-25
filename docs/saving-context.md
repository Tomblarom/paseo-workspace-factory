# Saving context and quota

Long steer chats increase input usage, especially after the provider’s prompt cache expires. Keep the context focused on the current work.

- Save a `CHECKPOINT` after each piece of work. Use `/factory switch` to hand off or `/factory fresh` to refresh the current context. Both build a brief from saved state so the agent can resume without replaying the transcript. [Concepts](concepts.md#hand-over-without-losing-context)
- Delegate routine tasks such as checking status or running documentation checks to a lower-cost worker. Order your worker profiles by preference. The picker checks catalog availability and known quota, and supervision can hand off to another eligible steer when a pool runs out. [Worker profile selection](configuration.md#managing-models-from-the-cli) · [Quota pools](concepts.md#quota-pools-and-zerosub-accounts)
- Batch independent commands and filter large output. While workers are active, use short waits for the first result and work on independent items while they run.
- Write big artifacts (logs, diffs, test output) to files; paste only a summary and the path into the chat.

## Seeing usage

`status` shows per-agent context usage from the agent snapshot (`lastUsage`): `ctx <used>/<max>` per steer and worker, `ctx n/a` when Paseo reports none (nothing is estimated). Account-level quotas live in `paseo usage`, not per agent. The optional config `usage.warnContextTokens` (positive integer, default off) adds a warning with a switch/fresh recommendation once an agent exceeds it.

## Idle chats

The plugin can flag long idle chats as cold. Optional `compact-warm` cleanup uses a model-group cache estimate and the configured cost profile to compact eligible chats during an open task while the cache is still warm. Cold chats and chats at the end of a work package can get a fresh recommendation. A host can also opt into automatic same-tab rewinds for eligible Codex chats. [Cold-context design](design/cold-context-resume.md) · [Cache profiles](design/codex-research/spec-cache-profiles.md)

## Fresh steer

`/factory fresh` previews a context refresh for the active steer and confirms via the Factory panel (or the Steer menu). It tries a same-tab rewind and delivers the checkpoint as a resume brief using the previous brief when available as a user message, or the first user message otherwise. Same-tab refresh keeps the agent, slot and epoch.

`/factory fresh` with a slot refreshes a non-active steer (or a worker via `/factory resume <scope> --agent <id> --apply` / panel). Each uses the agent's own note or the scope checkpoint. The preview names the new-agent fallback when a rewind is unavailable. In that case an active-steer refresh bumps the epoch, and `status` marks the previous holder superseded. A newly created steer has no parent, and a newly created worker keeps its previous parent when it has one. Creation receipts let a retry recover an interrupted creation.

## Lessons from live use

- **Keep worker contexts short.** Muse sessions with roughly 500k+ context tokens fail on resume (`session/resume timed out`); `paseo agent reload` does not recover them. Prefer a fresh worker with a file-based handover (task file + paths + last checkpoint) over reviving a long one. Close workers after each work package.
- **Send `/clear` and `/compact` without a source agent.** A message sent by an agent is wrapped as `[Message received] …` plain text and has no effect. Use the plugin SDK without `sourceAgentId`, or `env -u PASEO_AGENT_ID paseo send`. Details: [cold-context-resume.md](design/cold-context-resume.md).
- **Keep old tabs.** `/clear` keeps the agent id and tab, but after a reload only the new session is visible. The previous history can only be restored as a *new* tab (`paseo agent import <old-session-id> --provider claude`); restoring it in the same tab needs an upstream Paseo change. Prefer `/compact` (history stays) and never delete the old tab automatically.
- **CHECKPOINT is a fenced code block** in every state-changing answer (factory default, see [steer-instructions.md](steer-instructions.md)).
