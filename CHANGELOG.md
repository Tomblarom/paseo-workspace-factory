# Changelog

## Unreleased

- Configuration outside the repository (`--config`, `$PASEO_FACTORY_CONFIG`, XDG path) with `config.example.json`; host settings (state dir, daemon URL, `paseo` binary, password file) in `runtime` or environment variables.
- Checkpoints: `next` field, `--from-agent` reads the CHECKPOINT block of a steer's last answer, `status` shows the checkpoint and marks one from an older epoch.
- Switch: `--wait` shows the new steer's reply, `--notify-previous` sends a short notice to the replaced steer, handoff in English (default) or German.
- Planning reports known provider exceptions (Copilot Claude models reject a thinking level).
- Docs: concepts and safety model, configuration, steer instructions with task/answer template.
- Steer slots A–Z freely selectable (single-steer default in `config.example.json`); `--adopt` takes any defined slot and plans only the adoption; `plan --slots A,B` overrides `prepare` per run.

## 0.0.0 – initial import

Discovery, hash-confirmed apply with stored authorizations, receipt-based recovery, flock locks, steer checkpoints and switching, worker previews, offline and gated live tests.
