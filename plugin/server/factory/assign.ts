// @ts-nocheck
// GENERATED from src/assign.mjs by npm run plugin:sync. Do not edit.
// Hub→scope assignment (S6). Preview first; --apply writes the scope checkpoint
// epoch-checked (same per-workspace lock as switches and checkpoints) and
// delivers it to the active scope steer. A busy steer is allowed: unlike a
// switch, an assignment changes neither the active steer nor the epoch, and
// sending only queues a message. Retired scopes refuse.
import { CHECKPOINT_KEY, formatCheckpointBlock, steerStatus } from './steer.js';
import { METADATA_KEY } from './paseo.js';
import { withLock, workspaceLockName } from './lock.js';
import { formatQuotaLine } from './quota.js';

export class AssignRefused extends Error {}

const none = 'none recorded';

/** Deterministic assignment packet (no wall-clock time, so preview == delivery). */
export function buildAssignment(status, { slot, steerId, epoch, task, tests, blockers, next, workerModel = null, config = null, quotaSnapshot = null, quotaWarnPct = 75 }) {
  const lines = [
    `Assignment for ${status.repo} (epoch ${epoch}).`,
    `Active steer ${slot} (${steerId}): this assignment replaces the recorded checkpoint.`,
    ...(status.domain ? [`Domain ${status.domain}: prefix blockers for the domain steer with \`domain:\`, for the hub with \`hub:\`.`] : []),
    ...((status.domainChildren ?? []).length ? [`Domain scope for ${status.domainChildren.length} child scope(s) (${status.domainChildren.join(', ')}); lifecycle (create/archive/delete) stays with the hub.`] : []),
    ...(workerModel ? [workerModel] : []),
    ...(formatQuotaLine(config, quotaSnapshot, { warnPct: quotaWarnPct }) ? [formatQuotaLine(config, quotaSnapshot, { warnPct: quotaWarnPct })] : []),
    'Task checkpoint:',
    `- Task: ${task}`,
    `- Tests: ${tests?.length ? tests.join('; ') : none}`,
    `- Open blockers: ${blockers?.length ? blockers.join('; ') : none}`,
    `- Next step: ${next ? next : 'not recorded'}`,
    formatCheckpointBlock({ task, tests, blockers, next }),
  ];
  return lines.join('\n');
}

/**
 * Preview returns the assignment and its packet; apply, under the workspace
 * lock: re-read, check the expected epoch and active steer (plus the optional
 * --expect-epoch from the preview), write, read back, release; delivery
 * happens after the lock is released.
 */
export async function assignScope({ client, discovery, task, tests = [], blockers = [], next = null, apply = false, send = true, expectEpoch, assignedBy = null, lock = withLock, now = () => new Date(), workerModel = null, config = null, quotaSnapshot = null, quotaWarnPct = config?.quota?.warnPct ?? 75 }) {
  const status = steerStatus(discovery);
  if (!status.workspace || !status.state) throw new AssignRefused('No factory main workspace with steer state; run the factory first');
  const expected = status.state;
  if (expected.retired === true) {
    throw new AssignRefused(`Scope ${status.repo} is retired${expected.movedTo ? ` (moved to ${expected.movedTo})` : ''}; assign to its successor instead`);
  }
  if (typeof task !== 'string' || !task.trim()) throw new AssignRefused('An assignment needs a task');
  const holders = status.steers.filter((s) => s.slot === expected.activeSteer);
  if (!holders.length) throw new AssignRefused(`No live Steer ${expected.activeSteer} to assign to for ${status.repo}; plan and apply one first`);
  if (holders.length > 1) throw new AssignRefused(`Steer ${expected.activeSteer} has several live agents (${holders.map((s) => s.id).join(', ')}); archive the retired one in Paseo, then rerun`);
  const target = holders[0];
  if (target.parent) throw new AssignRefused(`Steer ${expected.activeSteer} has parent ${target.parent}; refusing to assign to a subagent`);
  if (target.workspaceId !== status.workspace.id) throw new AssignRefused(`Steer ${expected.activeSteer} is not in the main workspace`);
  if (expectEpoch !== undefined && expectEpoch !== expected.epoch) {
    throw new AssignRefused(`Scope epoch is ${expected.epoch}, expected ${expectEpoch} (--expect-epoch from the preview); re-run the preview`);
  }

  const fields = { task: task.trim(), tests, blockers, next: next?.trim() || null };
  const packet = buildAssignment(status, { slot: target.slot, steerId: target.id, epoch: expected.epoch, workerModel, config, quotaSnapshot, quotaWarnPct, ...fields });
  const result = {
    scope: status.repo, epoch: expected.epoch, slot: target.slot, steerId: target.id,
    domain: status.domain ?? null, domainChildren: [...(status.domainChildren ?? [])],
    fields, packet, packetChars: packet.length, previous: status.checkpoint?.task ?? null,
    applied: false, delivered: false, deliveryError: null,
  };
  if (!apply) return result;

  const workspace = client.workspaces.ref(status.workspace.id);
  await lock(workspaceLockName(status.workspace.id), async (held) => {
    const fresh = (await workspace.refresh())?.metadata?.[METADATA_KEY];
    if (!fresh || fresh.epoch !== expected.epoch || fresh.activeSteer !== expected.activeSteer) {
      throw new AssignRefused(`Scope state changed (expected ${expected.activeSteer}@${expected.epoch}, found ${fresh?.activeSteer}@${fresh?.epoch}); rerun assign`);
    }
    if (fresh.retired === true) throw new AssignRefused(`Scope ${status.repo} was retired concurrently; assign to its successor instead`);
    const stamp = now().toISOString();
    const checkpoint = { ...fields, epoch: fresh.epoch, updatedAt: stamp, source: 'assign', assignedBy, capturedAt: stamp, interrupted: null };
    held.verify(); // the lock file must still be the locked inode right before the write
    await workspace.setMetadata({ [CHECKPOINT_KEY]: checkpoint });
    const written = (await workspace.refresh())?.metadata?.[CHECKPOINT_KEY];
    if (written?.task !== checkpoint.task || written?.epoch !== checkpoint.epoch) throw new Error('Assignment checkpoint not verifiable after write');
    result.checkpoint = checkpoint;
  });
  result.applied = true;
  if (send) {
    try {
      await client.agents.ref(target.id).send(packet);
      result.delivered = true;
    } catch (error) {
      result.deliveryError = error.message; // the assignment stands; resend the packet manually
    }
  }
  return result;
}
