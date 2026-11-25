# paseo-workspace-factory

Workspace Factory is a policy layer on top of Paseo for turning available
agent quota into accepted work with as little repeated context as practical.

It is designed for setups where:

- work can move between multiple providers or accounts as quota becomes scarce;
- the active coordinator must be replaceable without replaying the whole chat;
- workers should survive coordinator handoffs and daemon/provider interruptions;
- several projects or scopes need one scheduling and governance policy;
- context, cache state, retries, and failover should be treated as resource costs.

Paseo remains the runtime. It owns agents, provider sessions, workspaces,
worktrees, persistence, timelines, usage sources, and the application UI.
Workspace Factory adds scheduling policy and durable coordination state on
top of those primitives.

> Status: early preview.
>
> The project has an explicit efficiency measurement design, but this README
> does not claim measured savings until equivalent-work benchmarks have been
> completed.

## Why this exists

A long-lived coordinator is convenient, but it couples unfinished work to one
provider session and one growing conversation. When quota is exhausted, a
provider fails, the daemon restarts, or the conversation becomes expensive to
reuse, continuing the same task can require rereading substantial history.

Workspace Factory externalizes the minimum coordination state needed to
continue:

- current task and next step;
- tests and blockers;
- git state;
- active workers and their assignments;
- active coordinator slot and epoch;
- provider/account eligibility and known quota state.

Handoffs use this state to build a compact resume brief instead of treating
the full conversation as the only source of truth.

See:
- `docs/saving-context.md`
- `docs/design/quota-independence.md`
- `docs/design/cold-context-resume.md`
- `docs/design/efficiency-metrics.md`

## Core loop

```mermaid
flowchart LR
    Work[Accepted work] --> Route[Choose eligible provider/account]
    Route --> Steer[Active steer]
    Steer --> Workers[Bounded workers]
    Steer --> State[Durable checkpoint]
    Workers --> State
    State --> Decide{Continue cheaply?}
    Decide -->|yes| Steer
    Decide -->|cold / oversized / quota / failure| Next[Renew or hand off]
    Next --> Route
