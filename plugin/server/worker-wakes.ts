import { AGENTS_KEY } from "./core/agent-state.mjs";
import { readWorkers } from "./core/supervision.mjs";
import { hasActiveAgentWork } from "./agent-context.js";

export function canMarkWorkerStale(agent: any, entry: any): boolean {
  return agent?.status === "idle" && !agent.archivedAt && agent.background !== true &&
    !entry?.replacedBy && !hasActiveAgentWork(agent, entry);
}

/** Old batches can outlive a worker, its register entry or its assignment. */
export async function filterStaleWorkerEvents<T extends { workerId: string; state: string }>(
  paseo: any, metadata: any, events: readonly T[],
): Promise<T[]> {
  const workers: Record<string, any> = readWorkers(metadata);
  const eligible = await Promise.all(events.map(async ({ workerId, state }) => {
    if (state !== "stale") return true;
    if (workers[workerId]?.state !== "stale") return false;
    const live = await paseo.agents.ref(workerId).refresh().catch(() => null);
    return canMarkWorkerStale(live?.agent, metadata?.[AGENTS_KEY]?.[workerId]);
  }));
  return events.filter((_, index) => eligible[index]);
}
