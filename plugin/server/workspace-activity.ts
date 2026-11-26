import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { RESUME_PENDING_REASON } from "../shared/idle-cleanup.js";
import { WORKSPACE_ACTIVITY_LIMIT, type factoryWorkspaceActivity } from "../shared/workspace-activity.js";
import { actionFact } from "./core/action-facts.mjs";
import { AGENTS_KEY } from "./core/agent-state.mjs";
import { ASSIGNMENT_KEY } from "./core/assign.mjs";
import { LABEL, METADATA_KEY, readPaseoAgents } from "./core/paseo.mjs";
import { sameScopeId } from "./core/scope.mjs";
import { CHECKPOINT_KEY } from "./core/steer.mjs";
import { readStagedSteerBrief, readSteerAction } from "./core/steer-action.mjs";
import { readWorkers } from "./core/supervision.mjs";

export { WORKSPACE_ACTIVITY_LIMIT };

const deliveryPhases = {
  staged: { state: "pending", reason: "brief-staged", time: "queuedAt" },
  reserved: { state: "pending", reason: "delivery-queued", time: "queuedAt" },
  ready: { state: "pending", reason: "delivery-queued", time: "queuedAt" },
  renewing: { state: "pending", reason: "waiting-for-renewal", time: "queuedAt" },
  uncertain: { state: "uncertain", reason: "delivery-unconfirmed", time: "attemptedAt" },
  blocked: { state: "blocked", reason: "delivery-blocked", time: null },
  sent: { state: "delivered", reason: "dispatch-acknowledged", time: "observedAt" },
  done: { state: "delivered", reason: "dispatch-acknowledged", time: "observedAt" },
} as const;

const wakeReasons = {
  done: "worker-completed",
  partial: "worker-partial",
  blocked: "worker-blocked",
  interrupted: "worker-interrupted",
  stale: "worker-stale",
} as const;

const recoveryReasons = {
  "daemon-restart": "daemon-restart",
  limit: "provider-limit",
  failed: "turn-failed",
} as const;

type DeliveryPhase = (typeof deliveryPhases)[keyof typeof deliveryPhases];
type ActivityDetails =
  | { kind: "holder-change"; state: "recorded"; reason: "slot-changed" | "holder-replaced" }
  | { kind: "creation"; state: "recorded"; reason: "steer-created" | "worker-created" }
  | { kind: "renewal"; state: "confirmed"; reason: "context-cleared" | "context-compacted" | "context-rewound" }
  | { kind: "renewal"; state: "pending"; reason: "clear-reserved" }
  | { kind: "renewal"; state: "uncertain"; reason: "renewal-unconfirmed" | "clear-attempt-unconfirmed" }
  | { kind: "recovery"; state: "pending"; reason: (typeof recoveryReasons)[keyof typeof recoveryReasons] }
  | { kind: "delivery" | "takeover-request"; state: DeliveryPhase["state"]; reason: DeliveryPhase["reason"] | "delivery-blocked-after-attempt" }
  | { kind: "takeover-request"; state: "recorded"; reason: "takeover-recorded" }
  | { kind: "assignment"; state: "recorded" | "delivered"; reason: "assignment-recorded" | "assignment-report-delivered" }
  | { kind: "worker-wake"; state: "pending"; reason: (typeof wakeReasons)[keyof typeof wakeReasons] | "worker-update" }
  | { kind: "worker-wake"; state: "recorded"; reason: "wake-recorded" };

type ActivityOutput = RpcOutput<typeof factoryWorkspaceActivity>["events"][number];
type ActivityContext = Pick<ActivityOutput, "participant" | "from" | "cause" | "renewal">;
type Group = { kind: NonNullable<ActivityOutput["group"]>["kind"] };
export type WorkspaceActivityEvent = ActivityDetails & ActivityContext & Pick<ActivityOutput, "observedAt" | "group">;
type DraftEvent = WorkspaceActivityEvent & { related?: Group };

export interface WorkspaceActivity {
  kind: "recent-recorded-activity";
  events: WorkspaceActivityEvent[];
}

/** The workspace and agent membership come from the same host. */
export interface WorkspaceActivityObservation {
  workspace: { id: string; metadata?: Record<string, unknown> | null } | null;
  agents: readonly { id: string; workspaceId?: string | null; createdAt?: string; labels?: Record<string, string> | null }[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function lookup<T>(map: Record<string, T>, key: unknown): T | undefined {
  return typeof key === "string" && Object.hasOwn(map, key) ? map[key] : undefined;
}

function recordedTime(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const iso = new Date(ms).toISOString();
  return iso === value || iso.replace(".000Z", "Z") === value ? iso : null;
}

function slotLabel(slot: unknown): string | undefined {
  return typeof slot === "string" && slot.length === 1 && /^[A-Z]$/.test(slot) ? `Steer ${slot}` : undefined;
}

function takeoverCause(reason: unknown): ActivityContext["cause"] {
  if (typeof reason !== "string") return;
  if (/^no answer within \d+m$/.test(reason)) return "no-answer";
  if (reason === "no live holder of the active slot") return "no-holder";
  if (reason === "provider limit on the active steer" || reason === "provider limit" ||
      reason.startsWith("provider limit for bound account (") || reason.startsWith("provider limit for pool (")) return "provider-limit";
  if (reason === "quota exhausted" || reason.startsWith("quota exhausted for bound account (") ||
      reason.startsWith("quota exhausted for pool (")) return "quota-exhausted";
  if (reason === "active steer is advisor-flagged") return "advisor-holder";
  if (reason === "sensitive runtime requires a public scope; visibility is private or unknown" ||
      reason === "sensitive runtime requires a verified sanitized brief; public repository visibility does not sanitize delivery" ||
      reason === "advisor brief requires verified sanitized technical context; Factory packet provenance is unverified") return "privacy";
}

type RecordEvent = (details: ActivityDetails, time: unknown, context?: ActivityContext) => DraftEvent;

function recordRenewal(entry: Record<string, unknown>, record: RecordEvent) {
  const cleared = asRecord(actionFact(entry, "cleared"));
  const refreshed = asRecord(actionFact(entry, "refreshed"));
  let rewind: DraftEvent | undefined;
  if (cleared?.mode === "clear" && actionFact(entry, "actionVerified") === true) {
    record({ kind: "renewal", state: "confirmed", reason: "context-cleared" }, cleared.at);
  } else if (cleared?.mode === "compact" && actionFact(entry, "actionVerified") === true) {
    record({ kind: "renewal", state: "confirmed", reason: "context-compacted" }, cleared.at);
  } else if (cleared?.mode === "rewind" || (!cleared && refreshed?.mode === "rewind")) {
    rewind = record({ kind: "renewal", state: "confirmed", reason: "context-rewound" },
      cleared?.at ?? (refreshed?.mode === "rewind" ? refreshed.at : null));
  }
  const failure = asRecord(actionFact(entry, "lastActionFailed"));
  if (failure) record({ kind: "renewal", state: "uncertain", reason: "renewal-unconfirmed" }, failure.at);
  return { rewind, refreshed };
}

function relatedRenewal(
  action: Record<string, unknown>,
  delivery: WorkspaceActivityEvent,
  { rewind, refreshed }: ReturnType<typeof recordRenewal>,
  record: RecordEvent,
) {
  if (action.renewal === "clear" && (action.phase === "renewing" || action.phase === "blocked")) {
    const cleanup = asRecord(action.cleanup);
    // The resume cleanup reservation stays inside the delivery while the clear is outstanding.
    if (cleanup?.kind === "clear" && cleanup.reason === RESUME_PENDING_REASON) {
      if (cleanup.uncertain === true) {
        return record({ kind: "renewal", state: "uncertain", reason: "clear-attempt-unconfirmed" }, cleanup.at);
      }
      if (action.phase === "blocked") {
        return record({ kind: "renewal", state: "uncertain", reason: "renewal-unconfirmed" }, cleanup.at);
      }
      return record({ kind: "renewal", state: "pending", reason: "clear-reserved" }, cleanup.at);
    }
  }
  if (action.renewal !== "rewind") return;
  const attempt = asRecord(action.rewindAttempt);
  if (attempt?.phase === "uncertain" && (action.phase === "renewing" || action.phase === "blocked")) {
    return record({ kind: "renewal", state: "uncertain", reason: "renewal-unconfirmed" }, attempt.at);
  }
  // The sender stamps its brief ID into the rewind fact only after acknowledgment.
  if (delivery.state === "delivered" && rewind && refreshed?.mode === "rewind" &&
      typeof action.wakeId === "string" && action.wakeId && action.wakeId === refreshed.briefMessageId &&
      rewind.observedAt && recordedTime(refreshed.at) === rewind.observedAt) return rewind;
}

function recordDelivery(
  action: Record<string, unknown> | null,
  agentId: string,
  workspaceId: string,
  scopeId: unknown,
  record: RecordEvent,
) {
  if (!action) return null;
  const authority = asRecord(action.authority);
  if (authority && (authority.agentId !== agentId ||
      (typeof scopeId === "string" && !sameScopeId(authority.scopeId, scopeId)))) return null;
  const batch = asRecord(action.batch);
  if (batch && batch.workspaceId !== workspaceId) return null;
  // Joint reports can contain evidence from several scopes. This view uses the
  // verified workspace's own assignment receipt for that activity.
  if (action.assignment || action.assignments) return null;
  const deliveryKind = ["delivery", "fresh-delivery", "switch", "activate", "stage"].some((kind) => action.kind === kind);
  const implicitDelivery = action.kind === undefined && ["send", "clear", "rewind"].some((mode) => action.renewal === mode);
  if (!deliveryKind && !implicitDelivery) return null;
  const phase = lookup<DeliveryPhase>(deliveryPhases, action.phase);
  if (!phase) return null;
  const takeover = asRecord(batch?.takeover);
  if (takeover && typeof scopeId === "string" && takeover.scopeId != null && !sameScopeId(takeover.scopeId, scopeId)) return null;
  const kind = takeover ? "takeover-request" : "delivery";
  const context = {
    from: slotLabel(takeover?.activeSlot),
    cause: takeoverCause(takeover?.reason),
    renewal: action.renewal === "clear" || action.renewal === "rewind" ? action.renewal : undefined,
  } satisfies ActivityContext;
  // A scope change can block further delivery while the original attempt is unresolved.
  const blockedAfterAttempt = action.phase === "blocked" && typeof action.attemptedAt === "string" && action.attemptedAt;
  const event = blockedAfterAttempt
    ? record({ kind, state: "uncertain", reason: "delivery-blocked-after-attempt" }, action.attemptedAt, context)
    : record({ kind, state: phase.state, reason: phase.reason }, phase.time ? action[phase.time] : null, context);
  return { event, takeover, batchEpoch: batch?.epoch };
}

/** Recent recorded activity represents the evidence retained in this observation. */
export function projectWorkspaceActivity(
  workspaceId: string,
  { workspace, agents }: WorkspaceActivityObservation,
): WorkspaceActivity | null {
  if (!workspaceId || workspace?.id !== workspaceId) return null;
  const metadata = workspace.metadata;
  const state = asRecord(metadata?.[METADATA_KEY]);
  const scope = asRecord(state?.scope);
  if (state?.main !== true || (scope?.kind === "workspace" && scope.locator != null && scope.locator !== workspaceId)) return null;

  const members = new Map(agents.filter((agent) => agent.workspaceId === workspaceId).map((agent) => [agent.id, agent]));
  const workers = readWorkers(metadata);
  const participant = (id: unknown) => {
    const agent = typeof id === "string" ? members.get(id) : undefined;
    if (!agent) return;
    if (lookup(workers, agent.id) || agent.labels?.[LABEL.role] === "worker") return "Worker";
    if (agent.labels?.[LABEL.role] === "steer") return slotLabel(agent.labels[LABEL.slot]) ?? "Steer";
  };
  const events: DraftEvent[] = [];
  const record: RecordEvent = (details, time, context = {}) => {
    const { participant, from, cause, renewal } = context;
    const event = {
      ...details,
      observedAt: recordedTime(time),
      ...(participant ? { participant } : {}),
      ...(from ? { from } : {}),
      ...(cause ? { cause } : {}),
      ...(renewal ? { renewal } : {}),
    };
    events.push(event);
    return event;
  };
  const holderGroup: Group = { kind: "holder-change" };
  let holderChange: DraftEvent | undefined;
  if (typeof state.previousSteer === "string" && state.previousSteer && typeof state.activeSteer === "string") {
    const previousSlot = slotLabel(state.previousSteer);
    holderChange = record(
      { kind: "holder-change", state: "recorded", reason: previousSlot ? "slot-changed" : "holder-replaced" },
      state.switchedAt,
      { from: previousSlot ?? participant(state.previousSteer), participant: slotLabel(state.activeSteer) ?? participant(state.activeAgentId) },
    );
  }
  const assignment = asRecord(metadata?.[ASSIGNMENT_KEY]);
  if (typeof assignment?.by === "string" && assignment.by) {
    const reportedAt = recordedTime(assignment.reportedAt);
    const target = asRecord(assignment.reportTarget);
    if (reportedAt) record({ kind: "assignment", state: "delivered", reason: "assignment-report-delivered" }, reportedAt, {
      participant: target?.workspaceId === workspaceId ? participant(target.agentId) : undefined,
    });
    else record({ kind: "assignment", state: "recorded", reason: "assignment-recorded" }, assignment.at, {
      from: assignment.requesterWorkspaceId == null || assignment.requesterWorkspaceId === workspaceId ? participant(assignment.by) : undefined,
    });
  }

  const checkpoint = asRecord(metadata?.[CHECKPOINT_KEY]);
  const failover = checkpoint?.source === "failover" ? asRecord(checkpoint.failover) : null;
  const failoverAt = recordedTime(checkpoint?.updatedAt);
  let failoverProjected = false;
  const entries = asRecord(metadata?.[AGENTS_KEY]);
  for (const agentId of [...members.keys()].sort()) {
    const agent = members.get(agentId)!;
    const agentLabel = participant(agentId);
    const forAgent: RecordEvent = (details, time, context) => record(details, time, { participant: agentLabel, ...context });
    const entry = asRecord(entries && lookup(entries, agentId));
    if (entry) {
      const renewal = recordRenewal(entry, forAgent);
      const recovery = asRecord(entry.needsResume);
      const reason = lookup(recoveryReasons, recovery?.reason);
      const recoveryEvent = reason ? forAgent({ kind: "recovery", state: "pending", reason }, recovery?.at) : undefined;
      const currentAction = asRecord(readSteerAction(entry));
      const staged = asRecord(readStagedSteerBrief(entry));
      for (const action of [currentAction, staged === currentAction || staged?.phase !== "staged" ? null : staged]) {
        if (!action) continue;
        const delivery = recordDelivery(action, agentId, workspaceId, scope?.id, forAgent);
        if (!delivery) continue;
        const { event, takeover, batchEpoch } = delivery;
        if (failover && takeover && event.state === "delivered" && failoverAt && event.observedAt === failoverAt &&
            Number.isSafeInteger(batchEpoch) && batchEpoch === checkpoint?.epoch &&
            takeover.activeSlot === failover.previousSteer && takeover.reason === failover.reason) {
          // The supervisor copies these fields from the acknowledged batch to the checkpoint.
          failoverProjected = true;
        }

        const forCurrentHolder = !takeover && agentId === state.activeAgentId &&
          Number.isSafeInteger(state.epoch) && action.epoch === state.epoch;
        // Switch writes the target and reserved/staged action together, with the same epoch and stamp.
        const switched = forCurrentHolder && holderChange?.reason === "slot-changed" &&
          holderChange.observedAt && recordedTime(action.queuedAt) === holderChange.observedAt &&
          (action.kind === "switch" || action.kind === "activate" || (action.kind === "stage" && action.stageKind === "switch"));
        // Fresh only writes this authority on the replacement's initial brief.
        const replaced = forCurrentHolder && holderChange?.reason === "holder-replaced" && agentId !== state.previousSteer &&
          action.kind === "fresh-delivery" && asRecord(action.authority)?.agentId === agentId;
        const resumed = action === currentAction && recoveryEvent?.observedAt &&
          recordedTime(action.needsResumeAt) === recoveryEvent.observedAt ? recoveryEvent : undefined;
        const renewed = action === currentAction ? relatedRenewal(action, event, renewal, forAgent) : undefined;
        const related = switched || replaced ? holderChange : undefined;
        if (related || resumed || renewed) {
          const group: Group = related ? holderGroup : { kind: takeover ? "takeover-request" : resumed ? "recovery" : "renewal" };
          event.related = group;
          if (related) related.related = group;
          if (resumed) resumed.related = group;
          if (renewed) renewed.related = group;
        }
      }
    }
    const worker = asRecord(lookup(workers, agentId));
    if (recordedTime(agent.createdAt)) {
      if (agentLabel === "Worker") forAgent({ kind: "creation", state: "recorded", reason: "worker-created" }, agent.createdAt);
      else if (agent.labels?.[LABEL.role] === "steer") {
        const creation = forAgent({ kind: "creation", state: "recorded", reason: "steer-created" }, agent.createdAt);
        if (holderChange?.reason === "holder-replaced" && agentId === state.activeAgentId && agentId !== state.previousSteer) {
          creation.related = holderGroup;
          holderChange.related = holderGroup;
        }
      }
    }
    const pendingWake = asRecord(worker?.pendingWake);
    if (pendingWake) {
      const reason = lookup(wakeReasons, pendingWake.state ?? worker?.state) ?? "worker-update";
      forAgent({ kind: "worker-wake", state: "pending", reason }, pendingWake.queuedAt);
    } else if (recordedTime(worker?.lastWakeAt)) {
      forAgent({ kind: "worker-wake", state: "recorded", reason: "wake-recorded" }, worker?.lastWakeAt);
    }
  }
  if (failover && !failoverProjected) {
    record({ kind: "takeover-request", state: "recorded", reason: "takeover-recorded" }, failoverAt, {
      from: slotLabel(failover.previousSteer),
      cause: takeoverCause(failover.reason),
    });
  }

  events.sort((a, b) => (b.observedAt ?? "").localeCompare(a.observedAt ?? ""));
  const recent = events.slice(0, WORKSPACE_ACTIVITY_LIMIT);
  const groups = new Map<Group, { index: number; count: number }>();
  recent.forEach(({ related }, index) => {
    if (!related) return;
    const group = groups.get(related);
    if (group) group.count += 1;
    else groups.set(related, { index, count: 1 });
  });
  return { kind: "recent-recorded-activity", events: recent.map(({ related, ...event }) => {
    const group = related && groups.get(related);
    return related && group && group.count > 1 ? { ...event, group: { kind: related.kind, index: group.index } } : event;
  }) };
}

export async function getWorkspaceActivity(
  { workspaceId }: RpcInput<typeof factoryWorkspaceActivity>,
  { paseo }: PluginHandlerContext,
) {
  const [workspace, agents] = await Promise.all([
    paseo.workspaces.ref(workspaceId).refresh(),
    readPaseoAgents(paseo),
  ]);
  const activity = projectWorkspaceActivity(workspaceId, { workspace, agents });
  if (!activity) throw new Error("Activity requires an enrolled Factory workspace.");
  return { workspaceId, ...activity };
}
