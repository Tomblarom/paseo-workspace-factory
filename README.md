# paseo-workspace-factory (working title)

Turn GitHub repositories into standardized [Paseo](https://paseo.sh) development environments, and hand coordination from one agent to another without replaying chat history.

For each repository the factory sets up, idempotently and only after you confirm a dry-run:

- your fork (reused, or created with `--allow-fork`), a local checkout with an `upstream` remote,
- the Paseo project and a local workspace **Main**,
- several equal, top-level coordinating agents — **steers** A, B, C … — each on its own provider/model, none of them a child of another agent.

Exactly one steer coordinates at a time. When a provider limit is reached, the context grows too large or another model fits better, you record a short **checkpoint** and **switch** to another steer. The handoff message is built from Paseo and git state without a model call; workers stay where they are and are reused by agent id.

> Status: private preview. Not yet published; see [TODO.md](TODO.md) for what is missing before a release.

## Requirements

- Linux with util-linux (`flock`), Node.js ≥ 22, git, GitHub CLI (`gh`, authenticated)
- A running Paseo daemon (tested with 0.16.2) and its `paseo` CLI

## Quickstart

```sh
git clone <this repo> && cd paseo-workspace-factory
mkdir -p ~/.config/paseo-workspace-factory
cp config.example.json ~/.config/paseo-workspace-factory/config.json   # set github.owner, checkoutRoot, profiles

node src/cli.mjs plan https://github.com/<you>/<repo>        # dry-run; prints and stores the plan hash
node src/cli.mjs apply --confirm <hash>                      # executes exactly that plan
node src/cli.mjs status <you>/<repo>                         # active steer, epoch, checkpoint, steers, workers
```

Daily steering:

```sh
node src/cli.mjs checkpoint <you>/<repo> --task "…" --test "…" --blocker "…" --next "…"
node src/cli.mjs checkpoint <you>/<repo> --from-agent <steer-id>     # take the CHECKPOINT block of its last answer
node src/cli.mjs switch <you>/<repo> --to B                          # preview the handoff
node src/cli.mjs switch <you>/<repo> --to B --apply --wait           # switch, deliver, show the new steer's reply
```

`npm test` runs the offline suite (simulated daemon, real processes and filesystem). Live tests against a daemon are opt-in, see [docs/configuration.md](docs/configuration.md#live-tests).

## Documentation

- [Concepts and safety model](docs/concepts.md)
- [Configuration](docs/configuration.md)
- [Steer instructions and task/answer template](docs/steer-instructions.md)
