import { actionFact } from "./core/action-facts.mjs";
import { AGENTS_KEY } from "./core/agent-state.mjs";
import { ASSIGNMENT_KEY } from "./core/assign.mjs";
import { METADATA_KEY } from "./core/paseo.mjs";
import { sameScopeId } from "./core/scope.mjs";
import { readStagedSteerBrief, readSteerAction } from "./core/steer-action.mjs";
import { readWorkers } from "./core/supervision.mjs";

export const WORKSPACE_ACTIVITY_LIMIT = 20;

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
  | { kind: "renewal"; state: "confirmed"; reason: "context-cleared" | "context-compacted" | "context-rewound" }
  | { kind: "renewal"; state: "uncertain"; reason: "renewal-unconfirmed" }
  | { kind: "recovery"; state: "pending"; reason: (typeof recoveryReasons)[keyof typeof recoveryReasons] }
  | { kind: "delivery"; state: DeliveryPhase["state"]; reason: DeliveryPhase["reason"] | "delivery-blocked-after-attempt" }
  | { kind: "assignment"; state: "recorded" | "delivered"; reason: "assignment-recorded" | "assignment-report-delivered" }
  | { kind: "worker-wake"; state: "pending"; reason: (typeof wakeReasons)[keyof typeof wakeReasons] | "worker-update" }
  | { kind: "worker-wake"; state: "recorded"; reason: "wake-recorded" };

export type WorkspaceActivityEvent = ActivityDetails & { observedAt: string | null };

export interface WorkspaceActivity {
  kind: "recent-recorded-activity";
  events: WorkspaceActivityEvent[];
}

/** The workspace and agent membership come from the same host observation. */
export interface WorkspaceActivityObservation {
  workspace: { id: string; metadata?: Record<string, unknown> | null } | null;
  agents: readonly { id: string; workspaceId?: string | null }[];
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

type RecordEvent = (details: ActivityDetails, time: unknown) => void;

function recordRenewal(entry: Record<string, unknown>, record: RecordEvent) {
  const cleared = asRecord(actionFact(entry, "cleared"));
  const refreshed = asRecord(actionFact(entry, "refreshed"));
  if (cleared?.mode === "clear" && actionFact(entry, "actionVerified") === true) {
    record({ kind: "renewal", state: "confirmed", reason: "context-cleared" }, cleared.at);
  } else if (cleared?.mode === "compact" && actionFact(entry, "actionVerified") === true) {
    record({ kind: "renewal", state: "confirmed", reason: "context-compacted" }, cleared.at);
  } else if (cleared?.mode === "rewind" || (!cleared && refreshed?.mode === "rewind")) {
    record({ kind: "renewal", state: "confirmed", reason: "context-rewound" },
      cleared?.at ?? (refreshed?.mode === "rewind" ? refreshed.at : null));
  }
  const failure = asRecord(actionFact(entry, "lastActionFailed"));
  if (failure) record({ kind: "renewal", state: "uncertain", reason: "renewal-unconfirmed" }, failure.at);
}

function recordDelivery(
  action: Record<string, unknown> | null,
  agentId: string,
  workspaceId: string,
  scopeId: unknown,
  record: RecordEvent,
) {
  if (!action) return;
  const authority = asRecord(action.authority);
  if (authority && (authority.agentId !== agentId ||
      (typeof scopeId === "string" && !sameScopeId(authority.scopeId, scopeId)))) return;
  const batch = asRecord(action.batch);
  if (batch && batch.workspaceId !== workspaceId) return;
  // Joint reports can contain evidence from several scopes. This view uses the
  // verified workspace's own assignment receipt for that activity.
  if (action.assignment || action.assignments) return;
  const deliveryKind = ["delivery", "fresh-delivery", "switch", "activate", "stage"].some((kind) => action.kind === kind);
  const implicitDelivery = action.kind === undefined && ["send", "clear", "rewind"].some((mode) => action.renewal === mode);
  if (!deliveryKind && !implicitDelivery) return;
  // A scope change can block further delivery while the original attempt is unresolved.
  if (action.phase === "blocked" && typeof action.attemptedAt === "string" && action.attemptedAt) {
    record({ kind: "delivery", state: "uncertain", reason: "delivery-blocked-after-attempt" }, action.attemptedAt);
    return;
  }
  const phase = lookup<DeliveryPhase>(deliveryPhases, action.phase);
  if (phase) record({ kind: "delivery", state: phase.state, reason: phase.reason }, phase.time ? action[phase.time] : null);
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

  const events: WorkspaceActivityEvent[] = [];
  const record: RecordEvent = (details, time) => events.push({ ...details, observedAt: recordedTime(time) });
  if (typeof state.previousSteer === "string" && state.previousSteer && typeof state.activeSteer === "string") {
    record({ kind: "holder-change", state: "recorded", reason: /^[A-Z]$/.test(state.previousSteer) ? "slot-changed" : "holder-replaced" }, state.switchedAt);
  }
  const assignment = asRecord(metadata?.[ASSIGNMENT_KEY]);
  if (typeof assignment?.by === "string" && assignment.by) {
    const reportedAt = recordedTime(assignment.reportedAt);
    if (reportedAt) record({ kind: "assignment", state: "delivered", reason: "assignment-report-delivered" }, reportedAt);
    else record({ kind: "assignment", state: "recorded", reason: "assignment-recorded" }, assignment.at);
  }

  const members = new Set(agents.filter((agent) => agent.workspaceId === workspaceId).map((agent) => agent.id));
  const entries = asRecord(metadata?.[AGENTS_KEY]);
  const workers = readWorkers(metadata);
  for (const agentId of [...members].sort()) {
    const entry = asRecord(entries && lookup(entries, agentId));
    if (entry) {
      recordRenewal(entry, record);
      const recovery = asRecord(entry.needsResume);
      const reason = lookup(recoveryReasons, recovery?.reason);
      if (reason) record({ kind: "recovery", state: "pending", reason }, recovery?.at);
      const action = asRecord(readSteerAction(entry));
      recordDelivery(action, agentId, workspaceId, scope?.id, record);
      if (action?.phase !== "staged") {
        const staged = asRecord(readStagedSteerBrief(entry));
        if (staged?.phase === "staged") recordDelivery(staged, agentId, workspaceId, scope?.id, record);
      }
    }
    const worker = asRecord(lookup(workers, agentId));
    const pendingWake = asRecord(worker?.pendingWake);
    if (pendingWake) {
      const reason = lookup(wakeReasons, pendingWake.state ?? worker?.state) ?? "worker-update";
      record({ kind: "worker-wake", state: "pending", reason }, pendingWake.queuedAt);
    } else if (recordedTime(worker?.lastWakeAt)) {
      record({ kind: "worker-wake", state: "recorded", reason: "wake-recorded" }, worker?.lastWakeAt);
    }
  }

  events.sort((a, b) => (b.observedAt ?? "").localeCompare(a.observedAt ?? ""));
  return { kind: "recent-recorded-activity", events: events.slice(0, WORKSPACE_ACTIVITY_LIMIT) };
}
