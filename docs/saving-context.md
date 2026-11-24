# Saving context and quota

Every tool step reprocesses the whole chat history, so long steer chats burn through provider quota fast: a small task in a very long chat cost about a third of a five-hour limit. Rules of thumb:

- Keep steer chats short. After each work package, write a checkpoint and hand over (`checkpoint` + `switch`, or `fresh` for the same slot) instead of continuing in the same chat.
- Delegate routine work (commit, push, status, doc runs) to a cheap worker instead of doing it in the steer chat.
- Choose profiles by task type: frugal models for routine, strong ones for design and security; set the thinking level deliberately (`high`/`max` only for steers doing architecture work).
- Bundle tool loops: batch commands, filter big outputs (`tail`, `grep`, `--json` plus projection), no wait loops, no double checks without reason.
- Write big artifacts (logs, diffs, test output) to files; paste only a summary and the path into the chat.

## Seeing usage

`status` shows per-agent context usage from the agent snapshot (`lastUsage`): `ctx <used>/<max>` per steer and worker, `ctx n/a` when Paseo reports none (nothing is estimated). Account-level quotas live in `paseo usage`, not per agent. The optional config `usage.warnContextTokens` (positive integer, default off) adds a warning with a switch/fresh recommendation once an agent exceeds it.

## Fresh steer

`fresh <repo>` previews handing the active steer to a NEW agent of the same slot and profile (empty context); `fresh <repo> --apply` creates it, delivers the checkpoint handoff and bumps the epoch. The old steer keeps its chat and labels and gets only a short notice (one model turn); archive it in Paseo — until then the slot has two live agents and `switch`/`plan` refuse it as ambiguous. An interrupted apply is recovered through its creation receipt on the next `--apply`, never recreated.

## Lessons from live use

- **Keep worker contexts short.** Muse sessions with roughly 500k+ context tokens fail on resume (`session/resume timed out`); `paseo agent reload` does not recover them. Prefer a fresh worker with a file-based handover (task file + paths + last checkpoint) over reviving a long one. Close workers after each work package.
- **Send `/clear` and `/compact` without a source agent.** A message sent by an agent is wrapped as `[Message received] …` plain text and has no effect. Use the plugin SDK without `sourceAgentId`, or `env -u PASEO_AGENT_ID paseo send`. Details: [cold-context-resume.md](cold-context-resume.md).
- **Keep old tabs.** `/clear` keeps the agent id and tab, but after a reload only the new session is visible. The previous history can only be restored as a *new* tab (`paseo agent import <old-session-id> --provider claude`); restoring it in the same tab needs an upstream Paseo change. Prefer `/compact` (history stays) and never delete the old tab automatically.
- **CHECKPOINT is a fenced code block** in every state-changing answer (factory default, see [steer-instructions.md](steer-instructions.md)).
