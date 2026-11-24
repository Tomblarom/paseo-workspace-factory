# Proposal: beginner section for README.md

README.md belongs to the maintainer, so this is a suggestion only. It would go directly below the first paragraph of README.md and replace nothing; the existing Quickstart and Documentation sections stay as they are. The last change suggested at the bottom touches the Documentation list.

---

## In short

You work with AI coding agents in Paseo. One agent coordinates, but sooner or later it hits its provider limit or its chat grows too long and expensive. The factory keeps a few interchangeable coordinating agents (**steers** A, B, C …) per project, each on its own provider or model. The one in charge leaves a short **checkpoint** (task, tests, blockers, next step); **switching** hands it to another steer in one compact message, with no chat replay and no model call. Setting up a project (fork, checkout, Paseo workspace, steers) is one previewed, confirmed command.

New here? Read **[Getting started](docs/getting-started.md)**: the idea, a ten-minute quickstart, a glossary in plain words and the typical workflows.

---

Suggested addition to the Documentation list (first entry):

```markdown
- [Getting started](docs/getting-started.md) — start here
- [All documentation](docs/README.md)
```
