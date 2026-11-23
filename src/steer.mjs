// Active-steer state, task checkpoints and steer switching.
// Factory-owned state lives in two workspace metadata keys of the main workspace:
//   ari.wsf            { main, activeSteer, epoch, previousSteer?, switchedAt? }
//   ari.wsf.checkpoint { task, tests[], blockers[], epoch, updatedAt }
// Paseo has no compare-and-set for metadata, so writes from factory processes are
// serialized by a per-workspace flock on this host; agents, the UI and other hosts
// are not blocked. Between held.verify() and the daemon write remains a short
// window in which a replaced lock file is not noticed.
import { LABEL, METADATA_KEY, parentOf } from './paseo.mjs';
import { withLock } from './lock.mjs';
import { runtime } from './runtime.mjs';

export const CHECKPOINT_KEY = `${METADATA_KEY}.checkpoint`;
export class SwitchRefused extends Error {}

const BUSY = new Set(['running', 'initializing']);

export function steerStatus(discovery) {
  const main = discovery.mainWorkspace;
  const state = main?.metadata?.[METADATA_KEY] ?? null;
  const steers = discovery.steers.labelled
    .filter((a) => !a.archivedAt)
    .map((a) => ({ slot: a.labels[LABEL.slot], id: a.id, title: a.title, provider: a.provider, model: a.model, status: a.status, parent: parentOf(a), workspaceId: a.workspaceId }))
    .sort((a, b) => a.slot.localeCompare(b.slot));
  const steerById = new Map(steers.map((s) => [s.id, s]));
  const workers = discovery.workers.map((w) => ({
    id: w.id, title: w.title, provider: w.provider, model: w.model, status: w.status, cwd: w.cwd,
    parentSlot: steerById.get(parentOf(w))?.slot ?? null, parent: parentOf(w),
  }));
  return {
    repo: discovery.forkName,
    workspace: main ? { id: main.id, title: main.title ?? main.name, directory: main.workspaceDirectory } : null,
    state,
    checkpoint: main?.metadata?.[CHECKPOINT_KEY] ?? null,
    steers,
    workers,
  };
}

/** Branch, HEAD and dirty state straight from git; null when unreadable. */
export function readGitSnapshot(git, path) {
  try {
    const branch = git(path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    const sha = git(path, ['rev-parse', 'HEAD']).trim();
    const changes = git(path, ['status', '--porcelain']).split('\n').filter(Boolean).length;
    return { branch, sha, changes };
  } catch {
    return null;
  }
}

function clip(text, max) {
  const value = (text ?? '').trim().replace(/\s+\n/g, '\n');
  return value.length > max ? `${value.slice(0, max)} […]` : value;
}

const TEXT = {
  de: {
    head: (repo, e) => `Steer-Übergabe für ${repo}: Epoch ${e} → ${e + 1}.`,
    active: (to, from) => `Aktiv ist jetzt Steer ${to.slot} (${to.id}). Steer ${from.slot} (${from.id}) koordiniert nicht mehr.`,
    git: (g) => `Git: ${g.branch} @ ${g.sha.slice(0, 12)} · ${g.changes ? `${g.changes} geänderte/untracked Pfade` : 'sauber'}`,
    noGit: 'Git: Zustand nicht lesbar – vor Arbeitsbeginn selbst prüfen.',
    noCheckpoint: 'Aufgaben-Checkpoint: KEINER DOKUMENTIERT. Aktuellen Auftrag nicht aus dem Verlauf ableiten, sondern beim Nutzer bestätigen.',
    checkpoint: (cp, stale) => `Aufgaben-Checkpoint (Epoch ${cp.epoch ?? '?'}, ${cp.updatedAt ?? 'ohne Zeit'}${stale ? ', NICHT aus der aktuellen Epoch – auf Aktualität prüfen' : ''}):`,
    task: 'Auftrag', tests: 'Tests', blockers: 'Offene Blocker', next: 'Nächster Schritt', none: 'keine dokumentiert',
    noNext: 'nicht dokumentiert – vor neuer Arbeit beim Nutzer bestätigen',
    workers: 'Worker (per Agent-ID weiterverwenden, nicht neu anlegen):', noWorkers: 'Worker: keine.', parent: 'Parent Steer',
    hint: (slot) => `Unverifizierter Hinweis – letzte Antwort von Steer ${slot}, gekürzt, keine Auftragsquelle:`,
    notice: (to, e) => `Hinweis: Steer ${to.slot} (${to.id}) ist ab Epoch ${e} aktiv. Du koordinierst nicht mehr; nur auf ausdrückliche Anfrage antworten.`,
  },
  en: {
    head: (repo, e) => `Steer handoff for ${repo}: epoch ${e} → ${e + 1}.`,
    active: (to, from) => `Steer ${to.slot} (${to.id}) is now active. Steer ${from.slot} (${from.id}) no longer coordinates.`,
    git: (g) => `Git: ${g.branch} @ ${g.sha.slice(0, 12)} · ${g.changes ? `${g.changes} changed/untracked paths` : 'clean'}`,
    noGit: 'Git: state unreadable – check it yourself before starting.',
    noCheckpoint: 'Task checkpoint: NONE RECORDED. Do not infer the current task from history; confirm it with the user.',
    checkpoint: (cp, stale) => `Task checkpoint (epoch ${cp.epoch ?? '?'}, ${cp.updatedAt ?? 'no time'}${stale ? ', NOT from the current epoch – check whether it is still valid' : ''}):`,
    task: 'Task', tests: 'Tests', blockers: 'Open blockers', next: 'Next step', none: 'none recorded',
    noNext: 'not recorded – confirm with the user before starting new work',
    workers: 'Workers (reuse by agent id, do not recreate):', noWorkers: 'Workers: none.', parent: 'parent Steer',
    hint: (slot) => `Unverified hint – last answer of Steer ${slot}, shortened, not a task source:`,
    notice: (to, e) => `Note: Steer ${to.slot} (${to.id}) is active as of epoch ${e}. You no longer coordinate; reply only when asked explicitly.`,
  },
};

/**
 * Deterministic handoff text from Paseo/git state. No model call is made to build
 * it; the receiving steer still reads it as normal input on its next turn.
 */
export function buildHandoff(status, { from, to, epoch, git, lastMessage, maxLastChars = 800, language = 'en' }) {
  const t = TEXT[language] ?? TEXT.en;
  const lines = [t.head(status.repo, epoch), t.active(to, from), `Workspace ${status.workspace.id} · ${status.workspace.directory}`, git ? t.git(git) : t.noGit];
  const cp = status.checkpoint;
  if (!cp?.task) {
    lines.push(t.noCheckpoint);
  } else {
    lines.push(t.checkpoint(cp, cp.epoch !== epoch));
    lines.push(`- ${t.task}: ${cp.task}`);
    lines.push(`- ${t.tests}: ${cp.tests?.length ? cp.tests.join('; ') : t.none}`);
    lines.push(`- ${t.blockers}: ${cp.blockers?.length ? cp.blockers.join('; ') : t.none}`);
    lines.push(`- ${t.next}: ${cp.next ? cp.next : t.noNext}`);
  }
  if (status.workers.length) {
    lines.push(t.workers);
    for (const w of status.workers) lines.push(`- ${w.id} „${w.title}“ ${w.provider}/${w.model} · ${w.status}${w.parentSlot ? ` · ${t.parent} ${w.parentSlot}` : ''}`);
  } else {
    lines.push(t.noWorkers);
  }
  if (lastMessage) lines.push(t.hint(from.slot), clip(lastMessage, maxLastChars));
  return lines.join('\n');
}

export function previousSteerNotice(to, epoch, language = 'en') {
  return (TEXT[language] ?? TEXT.en).notice(to, epoch);
}

const NONE = /^(keine?|none|n\/a|-)\.?$/i;

/**
 * Parses the last `CHECKPOINT` block of an agent answer:
 *   CHECKPOINT
 *   task: …   tests: …   blockers: …   next: … (optional)
 * Values "none"/"keine" become empty lists. Returns null without a block or task.
 */
export function parseCheckpointBlock(text) {
  if (typeof text !== 'string') return null;
  const lines = text.split('\n');
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^\s*`*\s*CHECKPOINT\s*:?\s*`*\s*$/.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  const fields = {};
  for (const line of lines.slice(start + 1)) {
    const match = line.match(/^\s*[-*]?\s*(task|tests|blockers|next)\s*:\s*(.*)$/i);
    if (match) fields[match[1].toLowerCase()] = match[2].trim();
    else if (line.trim() === '' || /^\s*```/.test(line)) continue;
    else if (Object.keys(fields).length) break;
  }
  if (!fields.task) return null;
  const list = (value) => (!value || NONE.test(value) ? [] : [value]);
  return { task: fields.task, tests: list(fields.tests), blockers: list(fields.blockers), next: fields.next && !NONE.test(fields.next) ? fields.next : null };
}

export function lastAssistantText(timelinePayload) {
  const entries = timelinePayload?.entries ?? [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const item = entries[i]?.item;
    if (item?.type === 'assistant_message' && item.text) return item.text;
  }
  return null;
}

function lockName(workspaceId) {
  return `workspace-${workspaceId}`;
}

/**
 * Dry-run returns the handoff and the target state. Apply, under the workspace lock:
 * re-read, check the expected epoch and active steer, write, read back, release;
 * the handoff is delivered after the lock is released.
 */
export async function switchSteer({ client, discovery, toSlot, apply = false, send = true, wait = false, waitTimeoutMs = 600_000, notifyPrevious = false, language = runtime().handoffLanguage, git, lock = withLock, now = () => new Date() }) {
  const status = steerStatus(discovery);
  if (!status.workspace || !status.state) throw new SwitchRefused('No factory main workspace with steer state; run the factory first');
  const expected = status.state;
  const from = status.steers.find((s) => s.slot === expected.activeSteer);
  const to = status.steers.find((s) => s.slot === toSlot);
  if (!to) throw new SwitchRefused(`Steer ${toSlot} does not exist for ${status.repo}`);
  if (toSlot === expected.activeSteer) throw new SwitchRefused(`Steer ${toSlot} is already active`);
  if (to.parent) throw new SwitchRefused(`Steer ${toSlot} has parent ${to.parent}; refusing to make it coordinator`);
  if (to.workspaceId !== status.workspace.id) throw new SwitchRefused(`Steer ${toSlot} is not in the main workspace`);
  if (BUSY.has(to.status)) throw new SwitchRefused(`Steer ${toSlot} is ${to.status}`);
  if (from && BUSY.has(from.status)) throw new SwitchRefused(`Active Steer ${from.slot} is ${from.status}; stop it or wait for its turn to end first`);

  let lastMessage = null;
  if (from) {
    try {
      lastMessage = lastAssistantText(await client.agents.ref(from.id).timeline.refetch({ direction: 'tail', limit: 20 }));
    } catch {
      lastMessage = null;
    }
  }
  const fromInfo = from ?? { slot: expected.activeSteer, id: 'unknown' };
  const gitSnapshot = git ? readGitSnapshot(git, status.workspace.directory) : null;
  const packet = buildHandoff(status, { from: fromInfo, to, epoch: expected.epoch, git: gitSnapshot, lastMessage, language });
  const result = {
    repo: status.repo, from: fromInfo.slot, to: toSlot, epoch: expected.epoch + 1, packet,
    packetChars: packet.length, checkpoint: Boolean(status.checkpoint?.task), applied: false, delivered: false, deliveryError: null, reply: null, previousNotified: false,
  };
  if (!apply) return result;

  const workspace = client.workspaces.ref(status.workspace.id);
  await lock(lockName(status.workspace.id), async (held) => {
    const fresh = (await workspace.refresh())?.metadata?.[METADATA_KEY];
    if (!fresh || fresh.epoch !== expected.epoch || fresh.activeSteer !== expected.activeSteer) {
      throw new SwitchRefused(`Steer state changed (expected ${expected.activeSteer}@${expected.epoch}, found ${fresh?.activeSteer}@${fresh?.epoch}); rerun the switch`);
    }
    const next = { ...fresh, activeSteer: toSlot, epoch: fresh.epoch + 1, previousSteer: fresh.activeSteer, switchedAt: now().toISOString() };
    held.verify(); // the lock file must still be the locked inode right before the write
    await workspace.setMetadata({ [METADATA_KEY]: next });
    const written = (await workspace.refresh())?.metadata?.[METADATA_KEY];
    if (written?.epoch !== next.epoch || written?.activeSteer !== toSlot) throw new Error('Steer switch not verifiable after write');
  });
  result.applied = true;
  if (send) {
    try {
      await client.agents.ref(to.id).send(packet);
      result.delivered = true;
    } catch (error) {
      result.deliveryError = error.message; // switch stands; resend the packet manually
    }
  }
  if (notifyPrevious && from) {
    try {
      await client.agents.ref(from.id).send(previousSteerNotice(to, expected.epoch + 1, language)); // costs one turn of the previous steer
      result.previousNotified = true;
    } catch {
      result.previousNotified = false;
    }
  }
  if (wait && result.delivered) {
    const handle = client.agents.ref(to.id);
    await handle.waitForFinish(waitTimeoutMs);
    result.reply = lastAssistantText(await handle.timeline.refetch({ direction: 'tail', limit: 20 }));
  }
  return result;
}

/** Records a short task checkpoint for the current epoch (same lock as switches). */
export async function writeCheckpoint({ client, discovery, task, tests = [], blockers = [], next = null, lock = withLock, now = () => new Date() }) {
  const status = steerStatus(discovery);
  if (!status.workspace || !status.state) throw new SwitchRefused('No factory main workspace with steer state');
  if (typeof task !== 'string' || !task.trim()) throw new SwitchRefused('A checkpoint needs a task');
  const workspace = client.workspaces.ref(status.workspace.id);
  return lock(lockName(status.workspace.id), async (held) => {
    const fresh = (await workspace.refresh())?.metadata?.[METADATA_KEY];
    const checkpoint = { task: task.trim(), tests, blockers, next: next?.trim() || null, epoch: fresh?.epoch ?? null, updatedAt: now().toISOString() };
    held.verify();
    await workspace.setMetadata({ [CHECKPOINT_KEY]: checkpoint });
    return checkpoint;
  });
}
