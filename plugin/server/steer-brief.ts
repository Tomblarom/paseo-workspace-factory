// Manual stage is an action with no effect until the user requests delivery.
import { AGENTS_KEY } from "./core/agent-state.mjs";
import { withLock, workspaceLockName } from "./core/lock.mjs";
import { METADATA_KEY, readPaseoState } from "./core/paseo.mjs";
import { actionEntry, newSteerAction, readSteerAction } from "./core/steer-action.mjs";
import { deliverSteer, type SteerDeliveryDeps } from "./steer-delivery.js";
import { cleanupIdentity } from "../shared/idle-cleanup.js";

const takeLock = withLock as any;
export type SteerBriefDeps = SteerDeliveryDeps;
export interface StagedBrief { packet: string; at: string; kind: string }

function steerOrThrow(state: any, agentId: string): void {
  const agent = (state.agents ?? []).find((a: any) => a?.id === agentId);
  if (!agent) throw new Error(`Unknown agent ${JSON.stringify(agentId)}`);
  if (cleanupIdentity(agent.labels ?? null)?.role !== "steer") throw new Error(`Staged briefs are only for steers; ${agentId} is not a steer.`);
}

export async function stageSteerBrief(paseo: any, input: { workspaceId: string; agentId: string; packet: string; kind: string }, deps: SteerBriefDeps = {}): Promise<void> {
  if (!input.packet?.trim()) throw new Error("Nothing to stage: the packet is empty.");
  steerOrThrow(await readPaseoState(paseo), input.agentId);
  const workspace = paseo.workspaces.ref(input.workspaceId);
  await (deps.lock ?? takeLock)(workspaceLockName(input.workspaceId), async (held: any) => {
    const meta = (await workspace.refresh())?.metadata ?? {};
    const entries = meta[AGENTS_KEY] ?? {};
    const previous = readSteerAction(entries[input.agentId]);
    if (previous && previous.phase !== "done" && previous.phase !== "staged") throw new Error("A steer delivery is already pending.");
    const at = deps.now?.() ?? new Date().toISOString();
    const epoch = meta[METADATA_KEY]?.epoch ?? null;
    const action = { ...newSteerAction({ kind: "stage", epoch, at, text: input.packet, phase: "staged" }), at, stageKind: input.kind, ...(previous?.phase === "done" ? { lastDeliveryId: previous.wakeId } : previous?.lastDeliveryId ? { lastDeliveryId: previous.lastDeliveryId } : {}) };
    held.verify();
    await workspace.setMetadata({ [AGENTS_KEY]: { ...entries, [input.agentId]: actionEntry(entries[input.agentId], action) } });
  });
}

export async function deliverSteerBrief(paseo: any, input: { workspaceId: string; agentId: string; action: "send" | "dismiss" }, deps: SteerBriefDeps = {}): Promise<{ agentId: string; delivered: boolean; dismissed: boolean; detail: string }> {
  const agentId = input.agentId.trim();
  const state: any = await readPaseoState(paseo);
  steerOrThrow(state, agentId);
  const workspace = paseo.workspaces.ref(input.workspaceId);
  const action = await (deps.lock ?? takeLock)(workspaceLockName(input.workspaceId), async (held: any) => {
    const meta = (await workspace.refresh())?.metadata ?? {};
    const entries = meta[AGENTS_KEY] ?? {};
    const previous = readSteerAction(entries[agentId]);
    if (!previous || previous.phase !== "staged") return null;
    const next = input.action === "dismiss" ? (previous.lastDeliveryId ? { wakeId: previous.lastDeliveryId, phase: "done" } : null) : { ...previous, phase: "reserved", needsResumeAt: entries[agentId]?.needsResume?.at ?? null, queuedAt: previous.queuedAt ?? new Date().toISOString(), epoch: meta[METADATA_KEY]?.epoch ?? null,
      note: previous.stageKind === "switch" ? "" : previous.packet };
    held.verify();
    await workspace.setMetadata({ [AGENTS_KEY]: { ...entries, [agentId]: actionEntry(entries[agentId], next) } });
    return previous;
  });
  if (!action) return { agentId, delivered: false, dismissed: false, detail: "No staged brief for this steer. It was already sent or dismissed." };
  if (input.action === "dismiss") return { agentId, delivered: false, dismissed: true, detail: "Staged brief dismissed." };
  const result = await deliverSteer(paseo, { workspaceId: input.workspaceId, agentId, actionId: action.wakeId, text: action.packet, state,
    ...(action.stageKind === "switch" ? { renewalNote: "" } : {}) }, deps);
  return { agentId, delivered: result.status === "sent", dismissed: false, detail: result.status === "sent" && result.detail === "Message sent." ? "Staged brief sent." : result.detail };
}
