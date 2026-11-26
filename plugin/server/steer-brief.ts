// Manual stage is an action with no effect until the user requests delivery.
import { randomUUID } from "node:crypto";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { factorySteerBrief } from "../shared/factory.js";
import { AGENTS_KEY } from "./core/agent-state.mjs";
import { retryOnLockBusy, withLock, workspaceLockName } from "./core/lock.mjs";
import { METADATA_KEY, readPaseoState } from "./core/paseo.mjs";
import { actionEntry, newSteerAction, readStagedSteerBrief, readSteerAction } from "./core/steer-action.mjs";
import { deliverSteer, type SteerDeliveryDeps } from "./steer-delivery.js";
import { readPrivacyAdmission } from "./steer-admission.js";
import { cleanupIdentity } from "../shared/idle-cleanup.js";

const takeLock = withLock as any;
export type SteerBriefDeps = SteerDeliveryDeps;
export interface StagedBriefIdentity { stageId: string; epoch: number | null }

function steerOrThrow(state: any, agentId: string): void {
  const agent = (state.agents ?? []).find((a: any) => a?.id === agentId);
  if (!agent) throw new Error(`Unknown agent ${JSON.stringify(agentId)}`);
  if (cleanupIdentity(agent.labels ?? null)?.role !== "steer") throw new Error(`Staged briefs are only for steers; ${agentId} is not a steer.`);
}

export async function stageSteerBrief(paseo: any, input: { workspaceId: string; agentId: string; packet: string; kind: string; epoch?: number | null }, deps: SteerBriefDeps = {}): Promise<StagedBriefIdentity> {
  if (!input.packet?.trim()) throw new Error("Nothing to stage: the packet is empty.");
  steerOrThrow(await readPaseoState(paseo), input.agentId);
  const workspace = paseo.workspaces.ref(input.workspaceId);
  return retryOnLockBusy(() => (deps.lock ?? takeLock)(workspaceLockName(input.workspaceId), async (held: any) => {
    const meta = (await workspace.refresh())?.metadata ?? {};
    const entries = meta[AGENTS_KEY] ?? {};
    const entry = entries[input.agentId];
    const previous = readSteerAction(entry);
    if (previous && previous.phase !== "done" && previous.phase !== "staged") throw new Error("A steer delivery is already pending.");
    const at = deps.now?.() ?? new Date().toISOString();
    const epoch = meta[METADATA_KEY]?.epoch ?? null;
    if (input.epoch !== undefined && input.epoch !== epoch) throw new Error("Scope authority changed before staging the brief.");
    const staged = readStagedSteerBrief(entry);
    if (staged?.composerClaim && staged.epoch === epoch) throw new Error("A brief transfer to the composer is already pending.");
    const action = { ...newSteerAction({ kind: "stage", epoch, at, text: input.packet, phase: "staged" }), at, stageKind: input.kind, ...(previous?.phase === "done" ? { lastDeliveryId: previous.wakeId } : previous?.lastDeliveryId ? { lastDeliveryId: previous.lastDeliveryId } : {}) };
    held.verify();
    await workspace.setMetadata({ [AGENTS_KEY]: { ...entries, [input.agentId]: actionEntry({ ...entry, stagedBrief: null }, action) } });
    return { stageId: action.wakeId, epoch };
  }));
}

export async function deliverSteerBrief(paseo: any, input: RpcInput<typeof factorySteerBrief>, deps: SteerBriefDeps = {}): Promise<RpcOutput<typeof factorySteerBrief>> {
  const agentId = input.agentId.trim();
  const state: any = await readPaseoState(paseo);
  steerOrThrow(state, agentId);
  const workspace = paseo.workspaces.ref(input.workspaceId);
  const result = { agentId, delivered: false, dismissed: false };
  const claim = await (deps.lock ?? takeLock)(workspaceLockName(input.workspaceId), async (held: any) => {
    const meta = (await workspace.refresh())?.metadata ?? {};
    const entries = meta[AGENTS_KEY] ?? {};
    const entry = entries[agentId];
    const current = readSteerAction(entry);
    const previous = readStagedSteerBrief(entry);
    const save = async (next: any) => {
      held.verify();
      await workspace.setMetadata({ [AGENTS_KEY]: { ...entries, [agentId]: next } });
    };
    if (input.action === "composer-complete" && entry?.composerTransfer?.stageId === input.stageId &&
        entry.composerTransfer.epoch === input.epoch && entry.composerTransfer.claimId === input.claimId) {
      return { ...result, transferred: true, detail: "Brief placed in the composer." };
    }
    if (!previous) return { ...result, detail: "No staged brief for this steer. It was already sent or dismissed." };
    const identity = { stageId: previous.wakeId, epoch: previous.epoch ?? null };
    const transfer = previous.composerClaim;
    if (input.action === "inspect") return { ...result, ...identity,
      ...(transfer ? { recoveryId: transfer.recoveryId } : {}), detail: "A brief is staged for this tab." };
    if (identity.stageId !== input.stageId || identity.epoch !== input.epoch) {
      return { ...result, detail: "The staged brief changed. Open its menu again." };
    }
    const owner = transfer?.id;
    const updateStage = (stage: any) => current?.phase === "staged"
      ? actionEntry(entry, stage) : { ...entry, stagedBrief: stage };
    if (input.action === "composer-resolve") {
      if (!transfer || transfer.recoveryId !== input.recoveryId) {
        return { ...result, detail: "The composer transfer changed. Open its menu again." };
      }
      if (input.resolution === "retry") {
        const { composerClaim: _claim, ...available } = previous;
        await save(updateStage({ ...available, manualComposerOnly: true }));
        return { ...result, resolved: true, detail: "Brief available for an explicit delivery choice." };
      }
    }
    if (input.action === "composer-release" || input.action === "composer-complete") {
      if (!owner || owner !== input.claimId) return { ...result, detail: "This attempt does not hold the composer transfer." };
      if (input.action === "composer-release") {
        const { composerClaim: _claim, ...available } = previous;
        await save(updateStage(available));
        return { ...result, detail: "Brief retained for another attempt." };
      }
    }
    if (input.action === "send" || input.action === "composer") {
      if (identity.epoch !== (meta[METADATA_KEY]?.epoch ?? null)) return { ...result, detail: "Scope authority changed since this brief was staged." };
      const agent = (await paseo.agents.ref(agentId).refresh())?.agent;
      if (agent?.workspaceId !== input.workspaceId || agent.archivedAt || agent.background === true ||
          cleanupIdentity(agent.labels)?.role !== "steer" || meta[METADATA_KEY]?.retired) {
        return { ...result, detail: "The target is no longer a live steer in this workspace." };
      }
      const privacy = await readPrivacyAdmission(agent, { ...deps, paseo }, input.workspaceId);
      if (!privacy.allowed) return { ...result, detail: `Staged brief waits: ${privacy.reason}.` };
      if (input.action === "composer") {
        if (owner && owner !== input.claimId) return { ...result, detail: "Another composer transfer holds this brief. Reopen its menu to review the transfer." };
        if (previous.manualComposerOnly && input.automatic) return { ...result, detail: "Choose how to deliver the recovered brief." };
        if (!owner) await save(updateStage({ ...previous, composerClaim: { id: input.claimId, recoveryId: randomUUID() } }));
        return { ...result, ...identity, detail: "Staged brief reserved for the composer.", packet: previous.packet };
      }
    }
    if (owner && input.action !== "composer-complete" && input.action !== "composer-resolve") return { ...result, detail: "A composer transfer holds this brief." };
    if (input.action === "send" && current && current.phase !== "done" && current.phase !== "staged") {
      return { ...result, detail: "A steer delivery is already pending." };
    }
    const lastDeliveryId = current?.phase === "done" ? current.wakeId : current?.lastDeliveryId;
    const delivery = current?.phase === "staged"
      ? (lastDeliveryId ? { wakeId: lastDeliveryId, phase: "done" } : null)
      : current;
    if (input.action !== "send") {
      const record = input.action === "dismiss" ? {} : { composerTransfer: { ...identity, claimId: owner } };
      await save(actionEntry({ ...entry, stagedBrief: null, ...record }, delivery));
      if (input.action === "dismiss") return { ...result, dismissed: true, detail: "Staged brief dismissed." };
      if (input.action === "composer-resolve") return { ...result, resolved: true, detail: "Brief marked as placed in the composer." };
      return { ...result, transferred: true, detail: "Brief placed in the composer." };
    }
    const next = {
      ...previous, phase: "reserved", needsResumeAt: entry?.needsResume?.at ?? null,
      queuedAt: previous.queuedAt ?? new Date().toISOString(),
      note: previous.stageKind === "switch" ? "" : previous.packet, ...(lastDeliveryId ? { lastDeliveryId } : {}),
    };
    await save(actionEntry({ ...entry, stagedBrief: null }, next));
    return { send: next };
  });
  if (!claim.send) return claim;
  const action = claim.send;
  const sent = await deliverSteer(paseo, { workspaceId: input.workspaceId, agentId, actionId: action.wakeId, text: action.packet, state,
    epoch: action.epoch ?? undefined,
    ...(action.stageKind === "switch" ? { renewalNote: "" } : {}) }, deps);
  return { ...result, delivered: sent.status === "sent", detail: sent.status === "sent" && sent.detail === "Message sent." ? "Staged brief sent." : sent.detail };
}
