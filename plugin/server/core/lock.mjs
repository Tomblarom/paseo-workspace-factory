// Per-workspace / global lock for cooperating factory processes on this host, based
// on a kernel flock(2) on a descriptor the factory's own Node process holds:
// - Node opens the stable lock file itself (O_NOFOLLOW: symlinks are refused);
// - a short-lived `flock -n -x 3` (util-linux) receives that descriptor as fd 3 and
//   locks the shared open file description, then exits; the lock stays with the
//   open file description, which Node keeps open for the whole critical section;
// - release closes the descriptor; when the Node process dies (even SIGKILL) the
//   kernel closes it and drops the lock. Node opens files close-on-exec, so other
//   child processes (git, paseo) never inherit and prolong the lock.
// There is no lock-holding helper, no time-based takeover, and the lock file is never
// deleted or replaced by the factory. Guarantee: only processes on this host that use
// this lock are serialized; agents, the Paseo UI and other hosts are not blocked.
import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { runtime } from './runtime.mjs';


export class LockBusy extends Error {}
export class LockError extends Error {}

/** Shared lock name for one workspace's factory metadata (switch, checkpoint, fresh, retire, scope top-up). */
export function workspaceLockName(workspaceId) {
  return `workspace-${workspaceId}`;
}

const CONFLICT_EXIT = 75;
const identityOf = (st) => `${st.dev}:${st.ino}`;

export async function acquireLock(name, { dir = runtime().lockDir, timeoutMs = 5000 } = {}) {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(name) || name.includes('..')) throw new LockError(`Invalid lock name ${name}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${name}.lock`);
  let fd;
  try {
    fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    throw new LockError(error.code === 'ELOOP' ? `Lock path ${path} is a symlink` : `Lock file ${path} cannot be opened (${error.code})`);
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile()) throw new LockError(`Lock path ${path} is not a regular file`);
    const result = spawnSync('flock', ['-n', '-x', '-E', String(CONFLICT_EXIT), '3'], { stdio: ['ignore', 'ignore', 'pipe', fd], timeout: timeoutMs });
    if (result.error) throw new LockError(`Lock ${name}: cannot run flock (${result.error.code ?? result.error.message})`);
    if (result.status === CONFLICT_EXIT) throw new LockBusy(`Workspace lock ${name} is held by another process`);
    if (result.status !== 0) throw new LockError(`Lock ${name}: flock exited with ${result.status ?? result.signal} ${String(result.stderr ?? '').trim()}`);
    const identity = identityOf(opened);
    let current;
    try {
      current = lstatSync(path, { bigint: true });
    } catch (error) {
      throw new LockError(`Lock file ${path} disappeared while locking (${error.code})`);
    }
    if (current.isSymbolicLink() || identityOf(current) !== identity) throw new LockError(`Lock file ${path} was replaced while locking`);
    let released = false;
    return {
      path,
      identity,
      /** Throws unless our descriptor is open, still the locked file, and the path names it. Call right before a write. */
      verify() {
        if (released) throw new LockError(`Lock ${name} already released`);
        let own;
        try {
          own = identityOf(fstatSync(fd, { bigint: true }));
        } catch (error) {
          throw new LockError(`Lock ${name}: descriptor is no longer valid (${error.code})`);
        }
        if (own !== identity) throw new LockError(`Lock ${name}: descriptor no longer refers to the locked file`);
        let onPath;
        try {
          onPath = lstatSync(path, { bigint: true });
        } catch (error) {
          throw new LockError(`Lock ${name} cannot be verified: ${error.code}`);
        }
        if (onPath.isSymbolicLink() || identityOf(onPath) !== identity) throw new LockError(`Lock file ${path} was replaced (${identity} -> ${identityOf(onPath)}); aborting`);
      },
      async release() {
        if (released) return;
        released = true;
        try {
          closeSync(fd);
        } catch {
          // already closed: the kernel released the lock with it
        }
      },
    };
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // nothing left to close
    }
    throw error;
  }
}

export async function withLock(name, fn, options) {
  const held = await acquireLock(name, options);
  try {
    return await fn(held);
  } finally {
    await held.release();
  }
}

/** One call for the common case: run fn under the lock for one workspace's factory metadata (also used by the plugin). */
export function withWorkspaceLock(workspaceId, fn, options) {
  return withLock(workspaceLockName(workspaceId), fn, options);
}
