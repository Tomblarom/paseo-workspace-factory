# Saving context and quota

Every tool step reprocesses the whole chat history, so long steer chats burn through provider quota fast: a small task in a very long chat cost about a third of a five-hour limit. Rules of thumb:

- Keep steer chats short. Checkpoint completed work as you go and use `/factory switch` or `/factory fresh` when you need a handoff or a smaller context. Keep processing actionable work during an ongoing TODO run.
- Delegate routine work (commit, push, status, doc runs) to a cheap worker instead of doing it in the steer chat.
- Choose profiles by task type: frugal models for routine, strong ones for design and security; set the thinking level deliberately (`high`/`max` only for steers doing architecture work).
- Batch independent commands and filter large output. While workers are active, use short waits for the first result and work on independent items while they run.
- Write big artifacts (logs, diffs, test output) to files; paste only a summary and the path into the chat.

## Seeing usage

`status` shows per-agent context usage from the agent snapshot (`lastUsage`): `ctx <used>/<max>` per steer and worker, `ctx n/a` when Paseo reports none (nothing is estimated). Account-level quotas live in `paseo usage`, not per agent. The optional config `usage.warnContextTokens` (positive integer, default off) adds a warning with a switch/fresh recommendation once an agent exceeds it.

## Fresh steer

`fresh <repo>` previews a context refresh for the active steer. `fresh <repo> --apply` tries a same-tab rewind and delivers the checkpoint as a resume brief. It uses the previous brief when that brief is available as a user message, or the first user message otherwise. Same-tab refresh keeps the agent, slot and epoch.

`fresh <repo> --slot <S>` refreshes a non-active steer and `fresh <repo> --worker <id>` refreshes a worker. Each uses the agent's own note or the scope checkpoint. The preview names the new-agent fallback when a rewind is unavailable. In that case an active-steer refresh bumps the epoch, and `status` marks the previous holder superseded. A newly created steer has no parent, and a newly created worker keeps its previous parent when it has one. Creation receipts let a retry recover an interrupted creation.

## Lessons from live use

- **Keep worker contexts short.** Muse sessions with roughly 500k+ context tokens fail on resume (`session/resume timed out`); `paseo agent reload` does not recover them. Prefer a fresh worker with a file-based handover (task file + paths + last checkpoint) over reviving a long one. Close workers after each work package.
- **Send `/clear` and `/compact` without a source agent.** A message sent by an agent is wrapped as `[Message received] …` plain text and has no effect. Use the plugin SDK without `sourceAgentId`, or `env -u PASEO_AGENT_ID paseo send`. Details: [cold-context-resume.md](design/cold-context-resume.md).
- **Keep old tabs.** `/clear` keeps the agent id and tab, but after a reload only the new session is visible. The previous history can only be restored as a *new* tab (`paseo agent import <old-session-id> --provider claude`); restoring it in the same tab needs an upstream Paseo change. Prefer `/compact` (history stays) and never delete the old tab automatically.
- **CHECKPOINT is a fenced code block** in every state-changing answer (factory default, see [steer-instructions.md](steer-instructions.md)).
