# P0 Daemon-Restart Acceptance Runbook (External)

Short, externally executable runbook for the P0 daemon-restart acceptance check.
Run this **outside** of Paseo (in a regular shell on the development host) at a quiet operating boundary where no other work is active.

## 1. Pre-flight guard (must report `0 running`)

Do **not** restart the daemon if any agent is currently running or initializing.

```bash
node -e '
import("/home/code/projects/paseo-workspace-factory/plugin/server/core/paseo.mjs").then(async ({ connect, readPaseoState }) => {
  const c = await connect();
  const s = await readPaseoState(c);
  const busy = s.agents.filter(a => !a.archivedAt && (a.status === "running" || a.status === "initializing" || a.activeTurn));
  console.log("Busy agents:", busy.length, busy.map(a => ({ id: a.id, title: a.title, status: a.status })));
  c.close();
  if (busy.length > 0) process.exit(2);
});
'
```

Proceed only when exit code is `0` (`Busy agents: 0 []`).

## 2. Minimal scratch setup (1 isolated scope, 1 open worker report)

```bash
SCRATCH_DIR=$(mktemp -d /tmp/wsf-restart-accept-XXXXXX)
git -C "$SCRATCH_DIR" init -q && echo "restart-check" > "$SCRATCH_DIR/README.md" && git -C "$SCRATCH_DIR" add README.md && git -C "$SCRATCH_DIR" commit -qm init
paseo workspace create "$SCRATCH_DIR" --title "Main" --background
```

Note the printed `WS_ID`, then enroll + create 1 steer + 1 completed worker with a queued wake (or pause supervision before the worker finishes, then restart while `pendingWake` is queued):

```bash
export WS_ID="<wks_...>"
export SCRATCH_DIR="<dir>"
paseo-factory plan --local "$SCRATCH_DIR"
paseo-factory apply --local "$SCRATCH_DIR"
```

Record before restart:
- `paseo-factory status` (active steer ID, epoch, open workers)
- `paseo plugin logs workspace-factory | tail -n 20`

## 3. External daemon restart

```bash
paseo daemon restart
```

Wait ~15s for the plugin to boot and complete `boot check` + `supervise: boot finished`.

## 4. Post-restart verification

Check logs and scope state:

```bash
paseo plugin logs workspace-factory | tail -n 40
paseo-factory status
```

Expected pass criteria:
1. `[paseo] Plugin ready`, `[factory] boot check: ...`, and `[factory] supervise: boot finished ...` appear cleanly with no unhandled errors.
2. **No duplicate takeover or duplicate delivery** for the same scope/epoch.
3. **No turn sent to any hard-limited holder** (if a steer has an active `quotaLimit`, it receives `0` turns).
4. **Open worker report preserved** in `wsf.workers` and delivered/resumed cleanly after restart.

## 5. Cleanup

Archive all scratch agents and the scratch workspace, then remove `$SCRATCH_DIR`:

```bash
paseo workspace archive "$WS_ID"
rm -rf "$SCRATCH_DIR"
```
