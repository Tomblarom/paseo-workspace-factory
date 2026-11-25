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

## Related work

[Paseo SLP](https://github.com/duongvm57/paseo-slp-plugin) (MIT) coordinates Supervisor,
Lead and Peer agents through a durable per-repository ledger with explicit ownership, review
selection and evidence. We reviewed it as a reference and adopt selected patterns step by step,
for example outcome-oriented briefs, risk-based instead of mandatory review, and results bound
to the revision they were checked on. Workspace Factory does not depend on it.

The focus differs. SLP governs *who may decide and accept what*: assignments, briefs, scopes,
reviews and planned owner handoffs with acknowledgment. Workspace Factory optimizes *how far the
available quota goes*: provider/account-aware routing, cache- and context-aware renewal, and
automatic coordinator failover after unplanned interruptions, using a compact checkpoint instead
of a full ledger.
