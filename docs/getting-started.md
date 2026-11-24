# Getting started

New here? This page explains what the workspace factory does, why it exists, and how to use it in about ten minutes. The other pages in [docs](README.md) go deeper; you do not need them to start.

## The problem

You work on a project with AI coding agents in [Paseo](https://paseo.sh). One agent coordinates: it plans, delegates to helpers and keeps track of the task. Sooner or later that agent stops being a good fit:

- its provider limit is used up,
- its chat got so long that every message is slow and expensive,
- another model would suit the next step better.

Starting a new agent by hand means explaining the whole task again, or letting the new agent read the old chat, which costs as much as the long chat itself. Setting up each project the same way (fork, checkout, Paseo project, workspace, agents) is also repetitive manual work.

## The idea in five sentences

1. The factory sets up each project the same way: checkout, Paseo project, one home workspace and a few coordinating agents called **steers**.
2. Steers are named by letter (A, B, C …) and can use different providers and models, so when one runs out you still have another.
3. Exactly one steer is **active** at a time; it leaves a short **checkpoint** (task, tests, blockers, next step) after each piece of work.
4. **Switching** hands the work to another steer with a message built from the checkpoint and the git state, without replaying the chat and without a model call.
5. Every change is shown as a preview first and only runs after you confirm it.

## Ten-minute quickstart

You need Linux with Node.js 22 or later, git, the GitHub CLI `gh` (logged in), `flock`, and a running Paseo daemon with its `paseo` CLI.

**1. Install and configure (2 minutes).**

```sh
clear
git clone <this repo> && cd paseo-workspace-factory
mkdir -p ~/.config/paseo-workspace-factory
cp config.example.json ~/.config/paseo-workspace-factory/config.json
```

Open the config file and set at least `github.owner` (your GitHub user), `checkoutRoot` (where checkouts go) and one entry under `profiles` (which provider and model a steer uses). Every field is explained in [configuration](configuration.md#fields).

**2. Preview the setup (1 minute).** Nothing is written yet:

```sh
clear
node src/cli.mjs plan https://github.com/<you>/<repo>
```

The plan lists every step (fork, clone, Paseo project, workspace, steers) and ends with a short code, the **plan hash**.

Already have agents named like `Steer A` or `Steer A [kn]` in that workspace? The plan stops and names them; confirm one with `--adopt A=<agent-id>` to take it over instead of creating a new steer. Several local checkouts of the same repository? The plan asks you to pick one with `--checkout <path>`.

**3. Run it (2 minutes).**

```sh
clear
node src/cli.mjs apply --confirm <hash>
```

Only the plan you just saw runs. If something fails halfway, run the same command again; finished steps are skipped.

**4. Look at it (1 minute).**

```sh
clear
node src/cli.mjs status <you>/<repo>
```

You see the active steer, its checkpoint and all helpers. In Paseo you now have a workspace with a tab "Steer A". Give that steer its task as usual.

**5. Hand over (4 minutes).** When Steer A should stop, ask it to end its answer with a CHECKPOINT block (the [steer instructions](steer-instructions.md) make this automatic), store it and switch:

```sh
clear
node src/cli.mjs checkpoint <you>/<repo> --from-agent <steer-a-id>
node src/cli.mjs switch <you>/<repo> --to B             # preview the handover
node src/cli.mjs switch <you>/<repo> --to B --apply     # do it
```

Steer B receives one compact message and continues. No local project? Use `plan --local <path>` instead of a GitHub URL (see [local mode](configuration.md#local-mode)).

### The same inside Paseo (plugin)

With the plugin installed, type `/factory help` in any steer chat. Normal use goes through `/factory`; the `node src/cli.mjs` commands in this guide stay as reference (same names, same previews, `--apply` instead of the panel button).

| You want to … | Type |
|---|---|
| see who is active and what the task is | `/factory status` |
| preview setting up a project | `/factory plan <you>/<repo>` |
| run a previewed plan | `/factory apply <hash>` |
| hand over to Steer B | `/factory switch --to B`, then confirm in the panel |
| restart your steer after a break | `/factory resume` (clears the chat, then shows task and next step) |
| only read the status report | `/factory resume --brief` |
| replace the active steer with a new agent | `/factory fresh`, then confirm in the panel |
| move a project to another checkout | `/factory relocate --to <path>`, then confirm in the panel |
| send a task to a project's steer (hub/domain) | `/factory assign --task "…"`, then confirm in the panel |
| see the helper agents of a project | `/factory workers` |
| check whether an agent could be archived | `/factory retire <agent-id>` (preview only) |
| list providers and models | `/factory models` |
| wait until nothing runs (safe restart) | `/factory drain` |
| tidy up leftovers | `/factory cleanup`, or `/factory cleanup --plan` then `/factory apply <hash>` |
| manage the worker model priority | `/factory worker list`, `/factory worker set 1 <model>`, `/factory worker pick` |
| manage steer slots and models | `/factory steer list`, `/factory steer set B <model>` |
| mark a model as advisor-only or sensitive | `/factory model advisor <profile> on`, `/factory model sensitive <profile> on` |

Without a project name, commands use the workspace you are in. Every change shows a preview in the Factory panel with a confirm button. Settings live under Settings → Plugins → Factory.

## Glossary in plain words

| Word | What it means |
|---|---|
| Steer | An agent that coordinates the work of one project. Several exist (A, B, C …); one is in charge. |
| Active steer | The steer in charge right now. The others wait. |
| Slot | The letter of a steer (A–Z). Each slot has a profile. |
| Profile | A named choice of provider, model, thinking level and permission mode, e.g. `codex-high`. |
| Worker | A helper agent for one bounded task. Workers stay where they are when the steer changes. |
| Checkpoint | Four short lines: task, tests, blockers, next step. The memory that survives a handover. |
| CHECKPOINT block | The checkpoint written at the end of an agent's answer, as a code block. The factory reads it from there. |
| Switch / handover | Make another steer the active one and send it the checkpoint. |
| Fresh | Replace the active steer with a brand-new agent of the same slot, to start with an empty chat. |
| Resume brief | A short status report (task, next step, git, helpers) for an agent that lost or cleared its chat. |
| Plan / apply | Plan shows what would change and stores it under a hash; apply runs exactly that plan. |
| Scope | One coordinated unit, usually one project: its home workspace, steers, checkpoint and helpers. |
| Main workspace | The scope's home workspace in Paseo. |
| Hub | An optional scope that coordinates other scopes (hands out tasks, manages models). Only for setups with many projects. |
| Domain | A project that coordinates a group of related projects, e.g. one product made of several repositories. Sits between the hub and those projects. |
| Epoch (shown as "round") | Handover counter. It goes up by one on every switch; previews made before a switch become invalid. |
| Cold context | An agent idle for so long that its next message is expensive (the provider cache expired). |

## Typical workflows

**Start a new project.** `plan <repo>` → read the preview → `apply --confirm <hash>` → give Steer A its task.

**Provider limit reached.** Store the checkpoint → `switch --to B --apply`. Step by step: [provider limit workflow](workflow-provider-limit.md).

**Chat got too long.** `checkpoint` → `fresh <repo> --apply`: a new agent of the same slot takes over; the old tab stays. Tips to keep chats short: [saving context](saving-context.md).

**Back after a break.** In the steer's own tab, `/factory resume` is the way back after a restart, crash, or limit: it saves the checkpoint, clears the chat, and then shows the task and next step without reading the old chat. A "Resume nötig" pill on the steer asks you to do this when needed. `resume` on the CLI (or `/factory resume --brief`) only reads the same report and never clears anything. The plugin can also tidy up idle agents automatically; see [cold context](cold-context-resume.md).

**Many projects.** `scopes` shows one line per project; a hub hands out work with `assign`. Related projects can be grouped under a domain (`plan <project> --domain <domain-id>`), whose steer coordinates them. See [scopes and the hub](scopes-design.md) and [domains](configuration.md#domains).

**Tidy up.** `cleanup` lists leftovers (test scopes, missing folders, empty projects) and what would be lost; it only reads.

## Safety at a glance

- `plan`, `status`, `scopes`, `resume` and `cleanup` only read.
- Writes need a confirmation that matches the preview you saw; if the state changed in between, the factory refuses and asks you to preview again.
- Nothing is deleted or archived unless you explicitly allow it.

Details: [concepts and safety model](concepts.md).
