// Staged steer briefs (docs/design/steer-menu.md, step 3): one stored packet
// per steer for the "Initialize new steer" setting and for retries after a
// failed send. A switch/fresh apply with deliver=stage stores the packet here
// instead of sending it; the steer menu then places it into the destination
// composer, sends it later, or dismisses it. Sending is exactly-once: the
// stored packet is taken (cleared) under the workspace lock before the send,
// so a second call reports that nothing is staged instead of duplicating the
// brief. A failed send restores the packet, so the retry stays available.
// Only erasable TypeScript: node --test imports this file with type stripping
// (see plugin/test/ts-resolve-hooks.mjs).
import { AGENTS_KEY } from "./factory/agent-state.js";
import { updateAgentEntry } from "./factory/agent-state.js";
import { withLock, workspaceLockName } from "./factory/lock.js";
import { readPaseoState } from "./factory/paseo.js";
import { deliverSteer, type SteerDeliveryDeps } from "./steer-delivery.js";
import { cleanupIdentity } from "../shared/idle-cleanup.js";

// The synced core is unchecked (@ts-nocheck): resume-apply talks to it as any.
const updateEntry = updateAgentEntry as unknown as (args: any) => Promise<any>;
const takeLock = withLock as unknown as (
  name: string,
  fn: (held: { verify: () => void }) => Promise<any>,
) => Promise<any>;
const lockName = workspaceLockName as unknown as (workspaceId: string) => string;

export interface StagedBrief {
  packet: string;
  at: string;
  kind: string;
}

export type SteerBriefDeps = SteerDeliveryDeps;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stagedOf(entry: Record<string, unknown> | null): StagedBrief | null {
  const staged = asRecord(entry?.stagedBrief);
  if (!staged || typeof staged.packet !== "string" || !staged.packet.trim()) return null;
  return {
    packet: staged.packet,
    at: typeof staged.at === "string" ? staged.at : "",
    kind: typeof staged.kind === "string" ? staged.kind : "brief",
  };
}

async function steerOrThrow(paseo: any, agentId: string): Promise<void> {
  const state: any = await readPaseoState(paseo);
  const agent: any = (state.agents ?? []).find((a: any) => a?.id === agentId) ?? null;
  if (!agent) throw new Error(`Unknown agent ${JSON.stringify(agentId)}`);
  const identity = cleanupIdentity(agent.labels ?? null);
  if (!identity || identity.role !== "steer") {
    throw new Error(`Staged briefs are only for steers; ${agentId} is not a steer.`);
  }
}

/**
 * Stores one packet for the steer, replacing any earlier staged brief. The
 * packet stays server-side; the menu stages it into the composer or sends it
 * later through deliverSteerBrief.
 */
export async function stageSteerBrief(
  paseo: any,
  input: { workspaceId: string; agentId: string; packet: string; kind: string },
  deps: SteerBriefDeps = {},
): Promise<void> {
  if (typeof input.packet !== "string" || !input.packet.trim()) {
    throw new Error("Nothing to stage: the packet is empty.");
  }
  await steerOrThrow(paseo, input.agentId);
  const lock = deps.lock ?? takeLock;
  const at = deps.now ? deps.now() : new Date().toISOString();
  await updateEntry({
    client: paseo,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    patch: { stagedBrief: { packet: input.packet, at, kind: input.kind } },
    liveIds: null,
    lock,
  });
}

/**
 * Takes (clears) the stored packet under the workspace lock. Returns null
 * when nothing is staged; the caller sends outside the lock.
 */
async function takeStagedBrief(
  paseo: any,
  workspaceId: string,
  agentId: string,
  lock: (name: string, fn: (held: { verify: () => void }) => Promise<any>) => Promise<any>,
): Promise<StagedBrief | null> {
  const workspace = paseo.workspaces.ref(workspaceId);
  return lock(lockName(workspaceId), async (held: { verify: () => void }) => {
    const metadata = (await workspace.refresh())?.metadata ?? {};
    const state = { ...(asRecord(metadata[AGENTS_KEY]) ?? {}) };
    const taken = stagedOf(asRecord(state[agentId]));
    if (!taken) return null;
    state[agentId] = { ...(asRecord(state[agentId]) ?? {}), stagedBrief: null };
    held.verify();
    await workspace.setMetadata({ [AGENTS_KEY]: state });
    const written = (await workspace.refresh())?.metadata?.[AGENTS_KEY]?.[agentId] ?? null;
    if (asRecord(written)?.stagedBrief) {
      throw new Error(`Staged brief for ${agentId} not verifiable after write`);
    }
    return taken;
  });
}

/**
 * Restores a taken packet after a failed send, but only when nothing newer
 * was staged meanwhile (a concurrent stage wins over the restore).
 */
async function restoreWhenEmpty(
  paseo: any,
  workspaceId: string,
  agentId: string,
  taken: StagedBrief,
  lock: (name: string, fn: (held: { verify: () => void }) => Promise<any>) => Promise<any>,
): Promise<void> {
  const workspace = paseo.workspaces.ref(workspaceId);
  await lock(lockName(workspaceId), async (held: { verify: () => void }) => {
    const metadata = (await workspace.refresh())?.metadata ?? {};
    const state = { ...(asRecord(metadata[AGENTS_KEY]) ?? {}) };
    if (stagedOf(asRecord(state[agentId]))) return;
    state[agentId] = { ...(asRecord(state[agentId]) ?? {}), stagedBrief: taken };
    held.verify();
    await workspace.setMetadata({ [AGENTS_KEY]: state });
  });
}

/**
 * Sends ("send") or drops ("dismiss") the staged brief of one steer. A send
 * with nothing staged reports that instead of failing, so double clicks and
 * retries after a delivered brief stay quiet. A failed send restores the
 * packet, so the retry stays available.
 */
export async function deliverSteerBrief(
  paseo: any,
  input: { workspaceId: string; agentId: string; action: "send" | "dismiss" },
  deps: SteerBriefDeps = {},
): Promise<{ agentId: string; delivered: boolean; dismissed: boolean; detail: string }> {
  const agentId = input.agentId.trim();
  await steerOrThrow(paseo, agentId);
  const lock = deps.lock ?? takeLock;
  const taken = await takeStagedBrief(paseo, input.workspaceId, agentId, lock);
  if (!taken) {
    return {
      agentId,
      delivered: false,
      dismissed: false,
      detail: "No staged brief for this steer. It was already sent or dismissed.",
    };
  }
  if (input.action === "dismiss") {
    return { agentId, delivered: false, dismissed: true, detail: "Staged brief dismissed." };
  }
  try {
    const result = await deliverSteer(paseo, {
      workspaceId: input.workspaceId, agentId, text: taken.packet,
      ...(taken.kind === "switch" ? { renewalNote: "" } : {}),
    }, deps);
    if (result.status !== "blocked") {
      return { agentId, delivered: result.status === "sent", dismissed: false, detail: result.status === "sent" && !result.renewed ? "Staged brief sent." : result.detail };
    }
    await restoreWhenEmpty(paseo, input.workspaceId, agentId, taken, lock);
    return { agentId, delivered: false, dismissed: false, detail: result.detail };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await restoreWhenEmpty(paseo, input.workspaceId, agentId, taken, lock);
    throw new Error(`Could not send the staged brief to ${agentId} (${message}). It is still staged.`);
  }
}
