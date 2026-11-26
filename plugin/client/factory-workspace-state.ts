import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { factoryPlan, factoryStatus } from "../shared/factory.js";
import { parseFactoryArgs } from "../shared/factory-args.js";
import type { SteerPillRow } from "./steer-pill.js";

export type WorkspaceStatus = RpcOutput<typeof factoryStatus>;

export function createFactorySteerFeed() {
  let snapshot = {
    rows: null as readonly SteerPillRow[] | null,
    receivedAt: Date.now(),
    disconnected: false,
  };
  const listeners = new Set<() => void>();
  const publish = (next: typeof snapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    update(rows: readonly SteerPillRow[]) {
      publish({ rows, receivedAt: Date.now(), disconnected: false });
    },
    disconnect() {
      publish({ ...snapshot, disconnected: true });
    },
  };
}

export type FactorySteerFeed = ReturnType<typeof createFactorySteerFeed>;

export function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
}

export function label(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

export function steerName(row: SteerPillRow): string {
  return row.slot ? `Steer ${row.slot}` : label(row.title) ?? "Unnamed steer";
}

export function enrollmentPlan(error: Error | null, workspaceId: string): RpcInput<typeof factoryPlan> | undefined {
  const suggestion = error?.message.match(/ is not managed by the factory yet\. To set it up, preview a plan: \/factory (plan .+)$/)?.[1];
  if (!suggestion) return;
  try {
    const plan = parseFactoryArgs(suggestion);
    if (plan.command !== "plan") return;
    if (plan.repos.length === 1 && plan.repos[0] === `workspace:${workspaceId}`) return { repos: plan.repos };
    if (plan.local?.length === 1) return { local: plan.local };
  } catch {
    // Keep the refresh action available if the server could not format a plan hint.
  }
}

export function workspaceSteers(rows: readonly SteerPillRow[] | null, workspaceId: string, assignedSlot?: string) {
  const steers = rows?.filter((row) => row.workspaceId === workspaceId) ?? [];
  const active = steers.filter((row) => row.active && row.state !== "retired");
  const candidate = active.length === 1 ? active[0] : undefined;
  const controller = candidate && !candidate.advisor && candidate.detail !== "Membership ambiguous"
    ? candidate : undefined;
  return {
    steers,
    controller,
    ambiguous: active.length > 1 || candidate?.detail === "Membership ambiguous" ||
      (!controller && steers.some((row) => row.slot === assignedSlot && row.detail === "Membership ambiguous")),
    advisorAssigned: candidate?.advisor === true,
  };
}

export function pendingWorkspaceWork(status: WorkspaceStatus | undefined, steers: readonly SteerPillRow[]) {
  const counts = new Map<string, number>();
  const count = (condition: string) => counts.set(condition, (counts.get(condition) ?? 0) + 1);
  const registered = new Set<string>();
  const openWorkers = Array.isArray(status?.openWorkers) ? status.openWorkers : [];
  for (const worker of openWorkers) {
    const entry = record(worker);
    const id = label(entry?.id);
    if (!id || registered.has(id)) continue;
    registered.add(id);
    const state = label(entry?.state);
    count(state ? workerConditions[state] ?? "Worker status unknown" : "Worker status unknown");
  }
  if (status?.pendingWorkerWakeCount) counts.set("Worker updates queued", status.pendingWorkerWakeCount);
  for (const worker of status?.workers ?? []) {
    if (!registered.has(worker.id) && worker.status === "running") count("Workers in progress");
  }
  for (const steer of steers) {
    if (steer.state === "retired") continue;
    if (steer.stagedBrief) count("Steer briefs staged");
    if (steer.permissionNeeded) count("Steer permission requests");
    if (steer.state === "waiting") count("Steers waiting");
    if (steer.state === "needs-resume") count("Steers awaiting recovery");
  }
  return Array.from(counts, ([condition, count]) => `${condition} (${count})`);
}

const workerConditions: Record<string, string> = {
  running: "Workers in progress",
  blocked: "Blocked workers",
  partial: "Partial worker results",
  interrupted: "Interrupted workers",
  stale: "Stale workers",
};

export function steerConditions(row: SteerPillRow) {
  const running = row.state === "running" || row.liveStatus === "running";
  const runtime = running ? "Running" : ({
    idle: "Idle", initializing: "Starting", closed: "Closed", error: "Error",
  } as Record<string, string>)[row.liveStatus ?? ""] ?? "Unknown";
  const tokens = row.tokens === null ? "Size unknown" : `${row.tokens.toLocaleString()} tokens`;
  const cache = ({ warm: "warm", cooling: "cooling", cold: "cold" } as Record<string, string>)[row.warmth] ?? "unknown";
  const estimated = row.headerFacts.includes("Estimated");
  const quota = row.limited ? "Limited" : row.awaitingUpdate || row.quotaRows.some((window) => window.stale)
    ? "Awaiting update" : row.quotaRows.some((window) => window.usedPct !== null)
      ? "Within sampled limits" : "Unknown";
  const attention = [
    row.permissionNeeded && "Permission requested",
    row.stagedBrief && "Brief staged",
    row.state === "waiting" && "Waiting to continue",
    row.state === "needs-resume" && row.detail,
    row.state === "unknown" && row.detail === "Membership ambiguous" && row.detail,
  ].filter(Boolean).join(" · ");
  return {
    runtime,
    context: `${tokens}${row.large ? " · large" : ""}, cache ${cache}${estimated ? " (estimated)" : ""}`,
    quota,
    attention,
  };
}
