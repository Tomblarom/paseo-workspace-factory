// @ts-nocheck
// GENERATED from src/assign.mjs by npm run plugin:sync. Do not edit.
// Hub→scope assignment (S6). Preview first; --apply writes the scope checkpoint
// epoch-checked (same per-workspace lock as switches and checkpoints) and
// delivers it to the active scope steer. A busy steer is allowed: unlike a
// switch, an assignment changes neither the active steer nor the epoch, and
// sending only queues a message. Retired scopes refuse.
import { CHECKPOINT_KEY, checkpointRules, formatCheckpointBlock, steerStatus } from './steer.js';
import { liveSlotHolders } from './discovery.js';
import { METADATA_KEY } from './paseo.js';
import { withLock, workspaceLockName } from './lock.js';
import { discoveryScopeAliases, guardScope } from './scope-guard.js';
import { QUOTA_DEFAULTS, formatQuotaLine } from './quota.js';
import { findingsPassage } from './findings.js';

export class AssignRefused extends Error {}

/**
 * Who asked for the current assignment and whether the report went out:
 * { by, epoch, at, reportedAt }. Kept apart from the checkpoint, which turn
 * hooks overwrite; the plugin turn hook reports a done/blocked CHECKPOINT of
 * the active steer to `by` once and stamps reportedAt.
 */
export const ASSIGNMENT_KEY = `${METADATA_KEY}.assignment`;

const none = 'none recorded';

/** Deterministic assignment packet (pass the same `now` so preview == delivery). */
export function buildAssignment(status, { slot, steerId, epoch, task, tests, blockers, next, workerModel = null, config = null, quotaSnapshot = null, quotaWarnPct = QUOTA_DEFAULTS.warnPct, zerosub = null, reportTo = null, promptOptions, now = Date.now() }) {
  const findings = findingsPassage(promptOptions);
  const quotaLine = formatQuotaLine(config, quotaSnapshot, { warnPct: quotaWarnPct, zerosub, now });
  const lines = [
    `Assignment for ${status.repo} (epoch ${epoch}).`,
    `Active steer ${slot} (${steerId}): this assignment replaces the recorded checkpoint.`,
    ...(status.domain ? [`Domain ${status.domain}: prefix blockers for the domain steer with \`domain:\`, for the hub with \`hub:\`.`] : []),
    ...((status.domainChildren ?? []).length ? [`Domain scope for ${status.domainChildren.length} child scope(s) (${status.domainChildren.join(', ')}); lifecycle (create/archive/delete) stays with the hub.`] : []),
    ...(workerModel ? [workerModel] : []),
    ...(quotaLine ? [quotaLine] : []),
    'Task checkpoint:',
    `- Task: ${task}`,
    `- Tests: ${tests?.length ? tests.join('; ') : none}`,
    `- Open blockers: ${blockers?.length ? blockers.join('; ') : none}`,
    `- Next step: ${next ? next : 'not recorded'}`,
    ...(findings ? [findings] : []),
    // Rules first: their format example is a block too, and readers take the LAST block.
    checkpointRules({ reportTo }),
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
export async function assignScope({ client, discovery, task, tests = [], blockers = [], next = null, apply = false, send = true, expectEpoch, assignedBy = null, requester = null, reportTo = assignedBy, lock = withLock, now = () => new Date(), workerModel = null, config = null, quotaSnapshot = null, quotaWarnPct = config?.quota?.warnPct ?? QUOTA_DEFAULTS.warnPct, zerosub = null, promptOptions }) {
  const status = steerStatus(discovery);
  if (!status.workspace || !status.state) throw new AssignRefused('No factory main workspace with steer state; run the factory first');
  const expected = status.state;
  if (expected.retired === true) {
    throw new AssignRefused(`Scope ${status.repo} is retired${expected.movedTo ? ` (moved to ${expected.movedTo})` : ''}; assign to its successor instead`);
  }
  if (typeof task !== 'string' || !task.trim()) throw new AssignRefused('An assignment needs a task');
  const holders = liveSlotHolders(status.steers, expected.activeSteer);
  if (!holders.length) throw new AssignRefused(`No live Steer ${expected.activeSteer} to assign to for ${status.repo}; plan and apply one first`);
  if (holders.length > 1) throw new AssignRefused(`Steer ${expected.activeSteer} has several live agents (${holders.map((s) => s.id).join(', ')}); archive the retired one in Paseo, then rerun`);
  const target = holders[0];
  if (target.parent) throw new AssignRefused(`Steer ${expected.activeSteer} has parent ${target.parent}; refusing to assign to a subagent`);
  if (target.workspaceId !== status.workspace.id) throw new AssignRefused(`Steer ${expected.activeSteer} is not in the main workspace`);
  if (expectEpoch !== undefined && expectEpoch !== expected.epoch) {
    throw new AssignRefused(`Scope epoch is ${expected.epoch}, expected ${expectEpoch} (--expect-epoch from the preview); re-run the preview`);
  }

  const fields = { task: task.trim(), tests, blockers, next: next?.trim() || null };
  const report = typeof reportTo === 'string' && reportTo.trim() && reportTo.trim() !== target.id ? reportTo.trim() : null;
  const packet = buildAssignment(status, { slot: target.slot, steerId: target.id, epoch: expected.epoch, workerModel, config, quotaSnapshot, quotaWarnPct, zerosub, reportTo: report, promptOptions, ...fields });
  const result = {
    scope: status.repo, epoch: expected.epoch, slot: target.slot, steerId: target.id,
    domain: status.domain ?? null, domainChildren: [...(status.domainChildren ?? [])],
    fields, reportTo: report, packet, packetChars: packet.length, previous: status.checkpoint?.task ?? null,
    applied: false, delivered: false, deliveryError: null,
  };
  if (!apply) return result;

  const workspace = client.workspaces.ref(status.workspace.id);
  const write = async (held) => {
    const { state: fresh } = await guardScope({ client, held, workspaceId: status.workspace.id, scopeId: expected.scope?.id ?? status.repo, epoch: expected.epoch, agentId: target.id, slot: expected.activeSteer, aliases: discoveryScopeAliases(discovery), config });
    if (requester?.workspaceId === status.workspace.id) {
      await guardScope({ client, held, ...requester, config });
    }
    const stamp = now().toISOString();
    const checkpoint = { ...fields, epoch: fresh.epoch, updatedAt: stamp, source: 'assign', assignedBy, capturedAt: stamp, interrupted: null };
    held.verify(); // the lock file must still be the locked inode right before the write
    await workspace.setMetadata({ [CHECKPOINT_KEY]: checkpoint, [ASSIGNMENT_KEY]: report ? { by: report, epoch: fresh.epoch, at: stamp, reportedAt: null } : null });
    const written = (await workspace.refresh())?.metadata?.[CHECKPOINT_KEY];
    if (written?.task !== checkpoint.task || written?.epoch !== checkpoint.epoch) throw new Error('Assignment checkpoint not verifiable after write');
    result.checkpoint = checkpoint;
  };
  if (requester && requester.workspaceId !== status.workspace.id) {
    await lock(workspaceLockName(requester.workspaceId), async (held) => {
      await guardScope({ client, held, ...requester, config });
      await lock(workspaceLockName(status.workspace.id), write);
    });
  } else {
    await lock(workspaceLockName(status.workspace.id), write);
  }
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
