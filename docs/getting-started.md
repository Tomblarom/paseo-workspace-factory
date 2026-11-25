# Getting started

New here? This page explains what the workspace factory does, why it exists, and how to use it in about ten minutes. The other pages in [docs](README.md) go deeper; you do not need them to start.

## The problem

You work on a project with AI coding agents in [Paseo](https://paseo.sh). One agent coordinates: it plans, delegates to helpers and keeps track of the task. Sooner or later that agent stops being a good fit:

- its provider limit is used up,
- its chat got so long that every message is slow and expensive,
- another model would suit the next step better.

Starting a new agent by hand means explaining the whole task again, or letting the new agent read the old chat, which costs as much as the long chat itself. Coordinating each project the same way (one home workspace, a few coordinating agents, one checkpoint) is also repetitive manual work.

## The idea in five sentences

1. The factory enrolls each project the same way: one existing home workspace and a few coordinating agents called **steers**.
2. Steers are named by letter (A, B, C …) and can use different providers and models, so when one runs out you still have another.
3. Exactly one steer is **active** at a time; it leaves a short **checkpoint** (task, tests, blockers, next step) after each piece of work.
4. **Switching** hands the work to another steer with a message built from the checkpoint and the git state, without replaying the chat and without a model call.
5. Every change is shown as a preview first and only runs after you confirm it.

## Quickstart in Paseo

You need Linux with Node.js 22 or later, git, the GitHub CLI `gh` (logged in), `flock`, and a running Paseo daemon with its `paseo` CLI.

Open **Settings → Plugins** on the target host and turn on **Enable plugins**. Choose an installation source on that host.

| [Build from source](#build-from-source) | [Install a built release](#install-a-built-release) |
|---|---|
| Use the `plugin/` directory of a Git checkout. Pull and reload to update, keeping your settings. | Use a prepared release directory. Replace the active installation with the next release and re-enter your settings. |
| The optional findings reminder asks agents to record observations in the Factory checkout. | The findings reminder is unavailable. |

### Build from source

Clone the repository on the Paseo host and install its `plugin/` directory.

```sh
clear
git clone https://github.com/Tomblarom/paseo-workspace-factory.git &&
  cd paseo-workspace-factory &&
  paseo plugin install "$PWD/plugin" &&
  paseo plugin ls workspace-factory
```

Paseo compiles the checked-in runtime sources when it loads the plugin. Installing from the checkout works without local `node_modules` or a separate build step. [Paseo plugin quickstart](https://paseo.sh/docs/plugins) · [Paseo CLI reference](https://paseo.sh/docs/cli#plugins)

To update, run these commands from the same checkout. Reload preserves your plugin settings. [Paseo settings persistence](https://paseo.sh/docs/plugins/reference.md#persisted-values)

```sh
clear
git pull && paseo plugin reload workspace-factory
```

Only installations from the Factory checkout can add a findings reminder to agent prompts. It asks agents to record their observations about the Factory in `<checkout>/FINDINGS.md`. **Ask agents to record factory findings** is on by default under **Settings → Plugins → Factory → Chat and prompts**.

### Install a built release

Use a prepared, self-contained `workspace-factory-<hash12>` directory on the Paseo host. For now, maintainers produce it with `npm run build-snapshot`. A future published release can provide the same directory. [Release build instructions](design/plugin-design.md#build-a-release-directory)

Replace the example path with the absolute path to your release directory.

```sh
clear
paseo plugin install /path/to/workspace-factory-0123456789ab &&
  paseo plugin ls workspace-factory
```

To update, note your values in **Settings → Plugins → Factory**. Run `paseo plugin remove workspace-factory`, install the new directory with the command above, then re-enter your values. **Removing the plugin deletes its settings. Reinstalling the same ID starts from defaults.** Paseo’s `plugin update` skips directory installs. [Paseo CLI reference](https://paseo.sh/docs/plugins/reference.md#cli-reference) · [Paseo settings persistence](https://paseo.sh/docs/plugins/reference.md#persisted-values)

### Configure and use the Factory

**1. Verify the installation.** When the plugin status is `running`, open a regular agent tab and type `/factory help` in the composer.

For first-time setup, open **Settings → Plugins → Factory** in Paseo. Under **Host**, enter your GitHub owner and an absolute checkout root on the Paseo host. Choose a profile for the first steer and save. Advanced host configuration is available in the [configuration reference](configuration.md#fields).

**2. Preview the enrollment.** Open the project's workspace natively in Paseo (checkout, project and workspace already exist — the factory creates none of them). Type `/factory plan` in the composer, or `/factory plan <you>/<repo>` from anywhere. The panel lists the planned workspace adoption and steers, along with a plan hash.

**3. Apply the plan.** Confirm it in the panel or use `/factory apply <hash>`. If a step fails, you can apply the same hash again. The factory skips steps it already completed.

**4. Start work.** Open the enrolled workspace and run `/factory status`. It shows the active steer and the current checkpoint. Give the active steer its task as a regular chat message.

**5. Hand over to another steer.** To create a second steer, run `/factory steer add B` in the project's workspace. Inspect the chosen profile and account, then select **Save slot and create steer**. Ask the active steer to leave a CHECKPOINT block. Run `/factory checkpoint --from-agent <steer-id>` and confirm it, then run `/factory switch --to B` and confirm the handoff. B becomes active and receives the checkpoint in its tab. [Steer instructions](steer-instructions.md)

## Composer commands

| You want to … | Type |
|---|---|
| see who is active and what the task is | `/factory status` |
| see all projects at a glance | `/factory scopes` |
| preview enrolling this workspace (or repair it) | `/factory plan`, or `/factory plan <you>/<repo>` |
| adopt an existing steer tab | `/factory plan --adopt B=<agent-id>`, then confirm the plan |
| create a steer in this scope | `/factory steer add [slot] [profile]`, then confirm the preview |
| enroll a local directory or a hub | `/factory plan --local <absolute-path>` or `/factory plan --hub <absolute-path>` |
| assign a scope to a domain | `/factory plan --domain <domain-id>`, then confirm the plan |
| register an existing worker | `/factory plan --adopt-worker <agent-id>`, then confirm the plan |
| run a previewed plan | `/factory apply <hash>` |
| hand over to Steer B | `/factory switch --to B`, then confirm in the panel |
| save the checkpoint from the last answer | `/factory checkpoint --from-agent <id>`, then confirm in the panel |
| restart your steer after a break | `/factory resume` (saves the checkpoint and shows the brief, clearing the context where supported) |
| only read the status report | `/factory resume --brief` |
| refresh the active steer's context | `/factory fresh`, then confirm in the panel |
| move a project to another checkout | enroll a scope at the target (`/factory plan`), then switch |
| send a task to a project's steer (hub/domain) | `/factory assign --task "…"`, then confirm in the panel |
| see the helper agents of a project | `/factory workers` |
| list providers and models | `/factory models` |
| see quota pools and who uses them | `/factory quota` |
| wait until nothing runs (safe restart) | `/factory drain` |
| tidy up leftovers | `/factory cleanup`, then archive natively (`paseo archive`, `paseo workspace archive`, `paseo project delete`) |
| audit and repair Factory labels | `/factory labels <scope-or-agent-id>`, then select **Set labels** to apply the previewed fixes |
| manage the worker model priority | `/factory worker list`, `/factory worker set 1 <model>`, `/factory worker pick` |
| manage steer slots and models | `/factory steer list`, `/factory steer set B <model>` |
| mark a model as advisor-only or sensitive | `/factory model advisor <profile> on`, `/factory model sensitive <profile> on` |

Without a project name, commands use the workspace you are in. The Factory panel shows previews for setup, checkpoints, and handoffs. Settings live under Settings → Plugins → Factory.

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
| Fresh | Refresh a steer or worker in the same tab via rewind where supported, or start a new agent. |
| Resume brief | A short status report (task, next step, git, helpers) for an agent that lost or cleared its chat. |
| Plan / apply | Plan shows what would change and stores it under a hash; apply runs exactly that plan. |
| Scope | One coordinated unit, usually one project: its home workspace, steers, checkpoint and helpers. |
| Main workspace | The scope's home workspace in Paseo. |
| Hub | An optional scope that coordinates other scopes (hands out tasks, manages models). Only for setups with many projects. |
| Domain | A project that coordinates a group of related projects, e.g. one product made of several repositories. Sits between the hub and those projects. |
| Epoch | Handover counter. It goes up by one on every switch; previews made before a switch become invalid. |
| Cold context | An agent idle for so long that its next message is expensive (the provider cache expired). |

## Typical workflows

**Start a new project.** Open its workspace natively in Paseo, run `/factory plan`, review the preview, then run `/factory apply <hash>` and give the active steer its task.

**Provider limit reached.** Save the checkpoint, run `/factory switch --to B`, and confirm the handoff. [Provider limit workflow](workflow-provider-limit.md)

**Chat got too long.** Save the checkpoint and run `/factory fresh`. Review whether the preview will rewind the current tab or create a new agent, then confirm. [Saving context](saving-context.md)

**Back after a break.** The composer pill shows why the chat needs attention, for example **Paseo restarted**. Open it or the **Factory: context** panel for the suggested action. In the steer's own tab, `/factory resume` saves the checkpoint and sends a brief with the task and next step. For providers with `/clear` enabled and verified, it clears the session before delivering the brief. Use CLI `resume` or `/factory resume --brief` for the read-only report. [Cold context and resume](design/cold-context-resume.md)

**Many projects.** `/factory scopes` shows one line per project. A hub hands out work with `/factory assign <scope> --task "…"`. [Scopes and the hub](design/scopes-design.md)

**Tidy up.** `/factory cleanup` lists leftovers such as test scopes, missing folders, and empty projects, and shows what would be lost.

## Safety at a glance

- `/factory status`, `/factory scopes`, and `/factory resume --brief` show the current state. `/factory plan` saves a preview and `/factory cleanup` shows potential cleanup candidates.
- Writes need a confirmation that matches the preview you saw; if the state changed in between, the factory refuses and asks you to preview again.
- Nothing is deleted or archived unless you explicitly allow it.

Details: [concepts and safety model](concepts.md).

## Troubleshooting

- **Work has stopped after an interruption.** Open the active steer and use `/factory resume --brief` and `/factory workers` to check the saved next step and see which workers finished. If you want that steer to resume, use `/factory resume` in its own tab.
- **A worker result is missing.** Find the worker by ID in `/factory workers` and check its last answer. A completed worker needs a CHECKPOINT with `task:`, `tests:`, `blockers:` and `next:` inside a fenced code block. [Checkpoint format](steer-instructions.md#answer-format)
- **A confirmation is refused.** Refresh the preview and inspect the current state. Factory checks the preview against the current scope or labels before it applies the change.
