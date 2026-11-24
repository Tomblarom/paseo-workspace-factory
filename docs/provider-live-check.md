# Provider live checks

This is a manual, approval-gated test kit for provider behavior in the workspace factory. It is not part of CI. It creates short-lived scratch agents, sends real prompts, and can consume provider quota. Do not run it in production or with unapproved credentials.

## Running the kit

The daemon and plugin must be running, and the requested provider/model must be configured. The script refuses to run unless the operator explicitly approves the cost:

```sh
clear
WSF_PROVIDER_LIVE=approved node plugin/test/manual/provider-live-check.mjs --step=checkpoint --model=gpt-6.2-sol
```

Use `--step=all` or one of `checkpoint`, `interruption`, `handoff`, `compact`, `clear`, `wake`, `advisor`, and `limits`. Pass `--provider=<provider-id>` when the configured provider id is not `codex` for GPT models or `claude` for Claude models. The interruption and limit steps deliberately pause for an operator: stop/restart the daemon or reproduce a provider capacity failure, then verify the recorded state before accepting the result.

Every created agent has the labels `wsf.scratch=true` and a unique `wsf.scope=provider-live-*` scratch scope. The script archives every agent in a `finally` block. If the process is killed, archive the labelled scratch agents manually before rerunning. The warning and printed token-cost field are only an aid; provider billing remains authoritative.

## Matrix and acceptance criteria

Run the matrix for each model: normal steer models `gpt-6.2-sol` and `claude-sonnet-5-5`, plus advisor steer models `gpt-6.2-astra` and `claude-opus-5-5`.

| Scenario | Expected evidence |
| --- | --- |
| Valid CHECKPOINT | The steer returns a fenced `CHECKPOINT` with task, tests, blockers, and next. |
| Interruption | Daemon stop/restart or a stopped turn records `interrupted`; the affected steer has `needsResume`. |
| Switch/fresh handoff | The new steer understands the task and next step from the brief without replaying the old transcript. |
| `/compact` and `/clear` | `/compact` preserves the session and compact evidence; `/clear` changes the session id. Record the observed capability in `resumeClear.providers`. |
| Wake/heartbeat | The prompt arrives and the steer performs or describes the requested next action. |
| Advisor refusal | An advisor steer refuses coordination/takeover and retains its advisor tag. |
| Limit/capacity | A provider failure is explicit, marks interruption with a limit reason where applicable, and leaves a resumable brief. |

`compact` and `clear` are automated checks. Record whether the `/compact` session id and transcript survive a reload. The provider matrix is evidence for the default `resumeClear.providers` list in the factory configuration: keep only providers whose effect was observed and verified.

## Results template

Record one row per provider/model and scenario in this document (or in the corresponding release notes), including the observed token cost:

| Provider/model | Role | Scenario | Pass/fail | Notes/evidence | Token cost |
| --- | --- | --- | --- | --- | --- |
| `codex/gpt-6.2-sol` | steer | CHECKPOINT |  |  |  |
| `claude/claude-sonnet-5-5` | steer | interruption |  |  |  |
| `codex/gpt-6.2-astra` | advisor | advisor refusal |  |  |  |
| `claude/claude-opus-5-5` | advisor | limit/capacity |  |  |  |

Do not treat an unexecuted row as passing. Include the daemon/plugin version, date, provider id, and a short reference to the scope metadata or timeline evidence. Never paste credentials, private prompts, or full provider logs.
