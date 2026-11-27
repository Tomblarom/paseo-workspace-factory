import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { factoryPlan, factoryStatus } from "../shared/factory.js";
import { parseFactoryArgs } from "../shared/factory-args.js";
import { steerRouteNames, type SteerModel } from "../shared/model-label.js";
import { steerQuotaConfirmation, resetSteerBlock } from "./steer-menu.js";
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

export function steerModelName(model: string | null, catalog: readonly SteerModel[] = []) {
  return steerRouteNames(model, null, catalog).modelName;
}

export function handoverRouteLabel(
  { model, thinking, accountAlias }: Pick<SteerPillRow, "model" | "thinking" | "accountAlias">,
  catalog: readonly SteerModel[] = [],
) {
  const { modelName, thinkingName } = steerRouteNames(model, thinking, catalog);
  return `${modelName}, ${thinkingName}, ${accountAlias ? `ZeroSub ${accountAlias}` : "ZeroSub account unknown"}`;
}

export function steerActionEligibility(row: SteerPillRow) {
  const reason = resetSteerBlock(row);
  return {
    reset: reason,
    resume: reason ?? (steerQuotaConfirmation(row) === "depleted" ? "Quota depleted"
      : row.state === "needs-resume" ? null : "No recovery pending"),
  };
}

export function enrollmentPlan(error: Error | null, workspaceId: string): RpcInput<typeof factoryPlan> | undefined {
  const message = error?.message.replace(/ requestType=plugin\.rpc\.invoke\.request code=handler_error$/, "");
  const suggestion = message?.match(/ is not managed by the factory yet\. To set it up, preview a plan: \/factory (plan .+)$/)?.[1];
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
  const active = steers.filter((row) => row.active);
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

type SteerAttention = "permission" | "brief" | "waiting" | "recovery" | "membership";

function steerAttention(row: SteerPillRow): { kind: SteerAttention; detail: string }[] {
  const items: ReturnType<typeof steerAttention> = [];
  if (row.permissionNeeded) items.push({ kind: "permission", detail: "Permission requested" });
  if (row.stagedBrief) items.push({ kind: "brief", detail: "Brief staged" });
  if (row.state === "waiting") items.push({ kind: "waiting", detail: row.detail || "Waiting to continue" });
  if (row.state === "needs-resume") items.push({ kind: "recovery", detail: row.detail || "Recovery pending" });
  if (row.state === "unknown" && row.detail === "Membership ambiguous") {
    items.push({ kind: "membership", detail: row.detail });
  }
  return items;
}

export function pendingWorkspaceWork(status: WorkspaceStatus | undefined, steers: readonly SteerPillRow[]) {
  const workerCounts = new Map<string, number>();
  const count = (condition: string) => workerCounts.set(condition, (workerCounts.get(condition) ?? 0) + 1);
  const workers = new Set<string>();
  const openWorkers = Array.isArray(status?.openWorkers) ? status.openWorkers : [];
  for (const worker of openWorkers) {
    const entry = record(worker);
    const id = label(entry?.id);
    if (!id || workers.has(id)) continue;
    workers.add(id);
    const state = label(entry?.state);
    count(state ? workerConditions[state] ?? "Worker status unknown" : "Worker status unknown");
  }
  for (const worker of status?.workers ?? []) {
    if (workers.has(worker.id)) continue;
    workers.add(worker.id);
    if (worker.status === "running") count("Workers in progress");
  }
  const workerRunning = workerCounts.get("Workers in progress");
  workerCounts.delete("Workers in progress");
  if (status?.pendingWorkerWakeCount) workerCounts.set("Worker updates queued", status.pendingWorkerWakeCount);
  const steerItems = steers.flatMap((steer) => steerAttention(steer).map((item) => ({ ...item, steer })));
  const observedOperations = steerItems.filter(({ kind }) => kind !== "membership").length;
  return {
    workerCount: status ? workers.size : null,
    workerRunning,
    workerItems: [...workerCounts].map(([condition, count]) => `${condition} (${count})`),
    steerItems,
    operationCount: status?.pendingWorkerWakeCount === undefined ? null : observedOperations + status.pendingWorkerWakeCount,
  };
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
  const context = row.tokens === null ? "Context unknown"
    : `${row.tokens.toLocaleString()} tokens${row.large ? " · large" : ""}`;
  const cache = ({ warm: "Warm", cooling: "Cooling", cold: "Cold" } as Record<string, string>)[row.warmth] ?? "Cache unknown";
  const usage = row.quotaRows.flatMap(({ usedPct, stale }) => !stale && usedPct !== null ? [usedPct] : []);
  const quota = row.limited ? "Quota limited" : row.awaitingUpdate || row.quotaRows.some((window) => window.stale)
    ? "Awaiting quota update" : usage.length ? `${Math.round(Math.max(...usage))}% used` : "Quota unknown";
  return {
    runtime,
    context,
    cache: row.headerFacts.includes("Estimated") ? `${cache} (estimated)` : cache,
    quota,
    attention: steerAttention(row).map(({ detail }) => detail).join(" · "),
  };
}
