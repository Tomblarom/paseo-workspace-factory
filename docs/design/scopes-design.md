# Scopes and the hub — design draft

New to the factory? Start with [Getting started](../getting-started.md); this page is the detailed reference.

The scope types and core workflows described here are implemented. See [Working with scopes](../configuration.md#scopes) for current command syntax.

## Problem

The factory is keyed by a GitHub repository (`owner/repo`). Everything that is not a single GitHub repository is a special case: `local/<folder>` for plain directories, `local/<worktree-folder>` (or `workspace:<id>`) for adopted worktrees. Observed gaps:

- Folder names collide (`local/<folder>`), and an adopted worktree of a GitHub repository loses its link to that repository.
- Only one local entry per plan; existing agents in other workspaces cannot be assigned as workers (only `--adopt X=<id>` for steers).
- The level above repositories — one coordinator that manages the Paseo instance, creates/adopts/archives workspaces, assigns steers, workers and models across repositories — has no model at all.
- Paseo cannot move a workspace to another project, and deleting a project removes its workspaces and their agents. Renaming/moving folders and cleaning up scratch projects therefore risks data loss.
- Titles that differ from the expected one (`<Repo> · <Subject>` vs `Main`) only produce a warning.
- Labels and metadata use a host-specific prefix (`ari.wsf.*`) in a public tool.

## Native facts (Paseo 0.16.2 CLI)

| Need | Native | Consequence |
|---|---|---|
| Rename workspace / project | `workspace rename`, `project rename` | Retitle is a normal plan op |
| Archive workspace | `workspace archive` (removes owned worktree with `--force`) | Destructive; needs git-clean precondition |
| Delete project | `project delete` (with all workspaces) | Never implicit |
| Move workspace between projects | none | Manual: create a new scope at the target and switch |
| Label existing agent | `agent update --label` | Agent adoption = labelling |
| Remove an agent's parent | `agent detach` | Parented candidate can become a steer |
| Move agent between workspaces | none | Adopted workers stay where they are |
| Project kinds | `git`, `non_git` | Hub usually lives in a `non_git` project |

## Decision 1 — first-class scope instead of `local/…`

A **scope** is the unit of coordination: exactly one main workspace carrying factory metadata, its steers (slots A–Z), epoch, checkpoint and workers. Today's "repository" becomes the scope of kind `github`.

| Kind | Locator | Enrollment needs (K13: existing workspaces only) |
|---|---|---|
| `github` | `owner/repo` | existing checkout with the fork as origin + existing Main workspace |
| `dir` | directory (git without GitHub, or non-git) | existing directory + existing Main workspace |
| `workspace` | existing workspace id (worktree or local) | the existing workspace; optional `parent` scope |
| `hub` | directory or workspace of the coordinating level | like `dir`/`workspace`, at most one per host |

Identity: metadata `wsf = { scope: { id, kind, locator, parent? }, main, activeSteer, epoch, … }`, steer label `wsf.scope=<id>`. `id` is `owner/repo` for `github`, otherwise a name: `--name`, else derived (`<folder>` for `dir`, `<parent>@<branch>` for a worktree of a known scope, `hub`). Ids are unique among live scopes; a collision is a plan conflict resolved with `--name`. Address resolution (CLI, plugin): scope id → `wks_…` id → path → legacy `local/<folder>` alias (kept, with a deprecation note).

| Alternative | Pro | Contra |
|---|---|---|
| A. Keep `local/<folder>` + worktree special cases | no work | collisions, no hierarchy, GitHub link lost, every new case is another branch in discovery |
| **B. Scope with kinds (recommended)** | one model for all cases, stable ids, reuses steer/checkpoint/switch unchanged | refactor of naming/resolution, label migration |
| C. External registry file of scopes | explicit list | second source of truth, stale state, against "read live from Paseo" |

## Decision 2 — the hub is a scope, not a parent

The coordinating level (administrator) is a scope of kind `hub` with its own slots, epoch, checkpoint, `switch` and `fresh` — no new mechanics.

| Role | Responsible for | Not responsible for |
|---|---|---|
| Hub steer | enrollment and lifecycle plans for any scope, slot/model assignment, adoption, priorities across scopes, cleanup | content work inside a scope that has an active steer |
| Scope steer | tasks of its scope, its workers, its CHECKPOINT | other scopes, destructive lifecycle ops |
| Worker | one bounded task | coordination |

Relations stay logical (metadata/labels), never `parent`: steers stay parent-free. Hub → scope: `assign <scope> --task … --next …` writes the scope checkpoint (epoch-checked, preview first) and delivers it to the active scope steer. Scope → hub: the CHECKPOINT block; blockers prefixed `hub:` are escalations. The hub reads one compact line per scope from `scopes` (kind, active steer, epoch, checkpoint age, next, `hub:` blockers, context use). Alternatives: hub as convention only (no tooling, the status quo) or hub steer as parent of scope steers (breaks parent-free steers, dies with the parent's lifecycle) — both rejected.

## Decision 3 — adoption is labelling, never moving

- Workspaces: exactly one `--local <path>` / `workspace:<id>` entry per plan (K13: single-workspace enrollment); a worktree of a known scope gets `parent` and the id `<parent>@<branch>`.
- Steers: `--adopt X=<id>`; a candidate with a parent is a conflict unless `--detach` plans a native `agent detach` op.
- Workers: `--adopt-worker <id>[@<slot>]` labels `wsf.scope`, `wsf.role=worker`, `wsf.owner=<slot>`. Agents in another workspace stay there (no native move); status shows their workspace.
- `scopes --candidates` lists unadopted workspaces/agents read-only.

## Decision 4 — lifecycle without data loss

- **Retitle** was removed (K13): workspace titles stay as they are; rename natively in Paseo.
- **Relocate** was removed (K14): to move a scope, create a new scope at the target and switch.
- Archive the previous workspace natively in Paseo when you are done with it.
- **Cleanup** is a read-only report (scratch scopes labelled `wsf.scratch`, missing directories, empty or duplicate projects). Each candidate carries a loss inventory — agents (running?), owned worktree, uncommitted changes, unpushed commits — plus the native command that archives it (`paseo archive`, `paseo workspace archive`, `paseo project delete`).

## Decision 5 — safety model unchanged, plus a destructive gate

Plan → `apply --confirm <hash>` for everything the Factory executes itself. The destructive cleanup orchestration (`workspace.archive`, `project.delete` ops with `--allow-destructive`) was removed (K15): the Factory only reports candidates with their loss inventory, and archiving/deleting happens through explicit native commands. Running agents are never archived by the Factory.

## Decision 6 — public and host-neutral

Neutral prefix `wsf.*` for labels and metadata; the pilot `ari.wsf.*` prefix was migrated once (`migrate --apply`, K16a) and its readers removed (K16b), so lingering duplicate agent labels are ignored. Scope ids and locators come from user config or the plan command line, never from repository files. Tests and docs use example owners and paths only.

## Decision 7 — domains between hub and scope

Some scopes belong together (one product, several repositories) and need a coordinator below the hub. A domain is a role on an existing scope, not a new kind: child scopes store a logical pointer `scope.domain=<id>` (set with `plan --domain`, epoch-checked), never a Paseo parent. Work flows Hub → Domain → Child through `assign`; escalations flow back as `domain:` (to the domain steer) and `hub:` (to the hub) blockers. Lifecycle stays with the hub. Details: [configuration](../configuration.md#domains).

## Implementation steps

See [Configuration](../configuration.md#scopes) for scope setup and [Getting started](../getting-started.md) for the composer commands.
