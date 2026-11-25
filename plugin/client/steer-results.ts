// Per-agent Factory results for the steer pill (docs/design/steer-menu.md,
// step 3). The global factory-store result feeds the Factory panel and the
// transient result pill; this keyed store feeds each steer tab's own menu, so
// a result from one steer never replaces another tab's open menu.
import type { FactoryPanelResult } from "./factory-store.js";
import { steerResultKey } from "./steer-menu.js";

const current = new Map<string, FactoryPanelResult>();
const listeners = new Map<string, Set<() => void>>();

// The client bundle is host-scoped in practice (one client per host), but the
// /factory command context carries no host id. Each mounted pill registers
// its host id, so /factory results land under the same key the pill reads.
let defaultHostId = "local";

export function registerSteerHost(hostId: string): void {
  if (hostId) defaultHostId = hostId;
}

export function currentSteerHost(): string {
  return defaultHostId;
}

function emit(key: string): void {
  for (const listener of listeners.get(key) ?? []) listener();
}

export function getSteerResult(hostId: string, agentId: string): FactoryPanelResult | null {
  return current.get(steerResultKey(hostId, agentId)) ?? null;
}

export function setSteerResult(
  hostId: string,
  agentId: string,
  next: FactoryPanelResult,
): void {
  current.set(steerResultKey(hostId, agentId), next);
  emit(steerResultKey(hostId, agentId));
}

export function clearSteerResult(hostId: string, agentId: string): void {
  const key = steerResultKey(hostId, agentId);
  if (!current.has(key)) return;
  current.delete(key);
  emit(key);
}

export function subscribeSteerResult(
  hostId: string,
  agentId: string,
  listener: () => void,
): () => void {
  const key = steerResultKey(hostId, agentId);
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}
