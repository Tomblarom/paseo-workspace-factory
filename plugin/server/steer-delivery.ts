import { randomUUID } from "node:crypto";
import { AGENTS_KEY } from "./factory/agent-state.js";
import { withLock, workspaceLockName } from "./factory/lock.js";
import { METADATA_KEY, LEGACY_PREFIX, readPaseoState } from "./factory/paseo.js";
import { defaultCreateRewindClient, rewindAndBrief } from "./factory/rewind.js";
import { listScopes, sameScopeId } from "./factory/scope.js";
import { buildRewindRecord } from "./factory/steer.js";
import { markWakeSent, updateWorkerEntry } from "./factory/supervision.js";
import { runCleanup } from "./cold-sweep.js";
import { collectSteerStates } from "./steer-feed.js";
import {
  cleanupIdentity, formatResumeMessage, mayResumeClear, RESUME_PENDING_REASON,
  type CleanupSettings, type ResumeClearSettings,
} from "../shared/idle-cleanup.js";

type Lock = (name: string, fn: (held: { verify: () => void }) => Promise<any>) => Promise<any>;
type Renewal = "clear" | "rewind";
type Phase = "renewing" | "ready" | "blocked" | "sent";
type WakeEvent = { workerId: string; state: string };

export interface SteerDeliveryDeps {
  getCleanupSettings?: () => Promise<CleanupSettings | null>;
  getResumeSettings?: () => Promise<ResumeClearSettings | null>;
  keepChatHistory?: () => Promise<boolean>;
  buildBrief?: (paseo: any, workspaceId: string, agentId: string) => Promise<string>;
  runCleanupFn?: typeof runCleanup;
  rewindClient?: typeof defaultCreateRewindClient;
  lock?: Lock;
  now?: () => string;
  onTakeoverDelivered?: (paseo: any, batch: EventBatch, agentId: string) => Promise<void>;
}

export interface DeliveryResult {
  status: "sent" | "pending" | "blocked";
  cleared: boolean;
  renewed?: boolean;
  deliveryId?: string;
  detail: string;
}

export interface EventBatch {
  workspaceId: string;
  epoch: number | null;
  events: WakeEvent[];
  /** A takeover request only starts the answer timer in the source scope. */
  takeover?: { scopeId: string; activeSlot: string | null; reason: string };
}

interface DeliveryInput {
  workspaceId: string;
  agentId: string;
  text?: string;
  renewalNote?: string;
  manual?: boolean;
  epoch?: number;
  batch?: EventBatch;
  state?: any;
  sendOptions?: { activeTurnBehavior: "steer" };
}

export interface PendingSteerDelivery {
  wakeId: string;
  renewal: Renewal;
  phase: Phase;
  queuedAt: string;
  epoch: number | null;
  note: string;
  packet?: string;
  batch?: EventBatch;
  lastError?: string;
}

const productionLock = withLock as unknown as Lock;
const runRewind = rewindAndBrief as unknown as (
  id: string, brief: string, options: {
    skipBrief: true; previousBriefId?: string; createClient: typeof defaultCreateRewindClient;
  },
) => Promise<{ status: string; messageId?: string; error?: string }>;
const markWorker = updateWorkerEntry as unknown as (args: {
  client: any; workspaceId: string; workerId: string; lock: Lock;
  patch: (worker: any, metadata: any) => Record<string, unknown> | null;
}) => Promise<any>;
const rewindRecord = buildRewindRecord as unknown as (
  args: { messageId?: string; now: () => Date }
) => Record<string, unknown>;
const markSent = markWakeSent as unknown as (worker: any, options: { at: string; clearPending: boolean }) => any;

function scopeState(meta: any) {
  return meta[METADATA_KEY] ?? meta[LEGACY_PREFIX];
}

export function pendingSteerDelivery(entry: any, workspaceId: string): PendingSteerDelivery | null {
  const pending = entry?.pendingWakeBrief;
  if (!pending || typeof pending.wakeId !== "string") return null;
  if (pending.renewal === "clear" || pending.renewal === "rewind") return pending;
  // The earlier format represented clears only. A legacy record can be
  // released once the clear has independently verifiable evidence.
  if (!Array.isArray(pending.events) || typeof pending.note !== "string") return null;
  const phase = pending.briefSent ? "sent" : entry.pendingAction ? "renewing" :
    entry.cleared?.mode === "clear" && entry.actionVerified === true ? "ready" : "blocked";
  return {
    wakeId: pending.wakeId,
    renewal: "clear",
    phase,
    queuedAt: typeof pending.queuedAt === "string" ? pending.queuedAt : "",
    epoch: pending.epoch ?? null,
    note: pending.note,
    batch: { workspaceId, epoch: pending.epoch ?? null, events: pending.events },
    ...(phase === "blocked" ? { lastError: "The previous context clear could not be confirmed. Retry recovery or use Fresh." } : {}),
  };
}

export function decideSteerDelivery({
  warmth, large, provider, manual, recovery, retry, settings, keepChatHistory,
}: {
  warmth?: string; large?: boolean; provider?: string; manual?: boolean; recovery?: boolean; retry?: boolean;
  settings: ResumeClearSettings | null; keepChatHistory: boolean;
}): "send" | Renewal {
  // Explicit recovery on a provider without clear support requires a rewind
  // even when there is no usage baseline or the cache happens to be warm.
  const mode = provider === "claude" && !keepChatHistory && mayResumeClear(provider, settings)
    ? "clear" : "rewind";
  if (large || warmth === "cold" || retry || (manual && mode === "rewind")) return mode;
  if (warmth === "warm" || warmth === "cooling") return "send";
  return manual || recovery ? mode : "send";
}

async function changeEntry(
  paseo: any, input: DeliveryInput, lock: Lock,
  change: (entry: any, meta: any) => Record<string, unknown> | null,
) {
  const workspace = paseo.workspaces.ref(input.workspaceId);
  return lock(workspaceLockName(input.workspaceId), async (held) => {
    const meta = (await workspace.refresh())?.metadata ?? {};
    const entries = meta[AGENTS_KEY] ?? {};
    const entry = entries[input.agentId] ?? {};
    const patch = change(entry, meta);
    if (!patch) return false;
    held.verify();
    await workspace.setMetadata({ [AGENTS_KEY]: { ...entries, [input.agentId]: { ...entry, ...patch } } });
    return true;
  });
}

function replacePending(
  paseo: any, input: DeliveryInput, lock: Lock, pending: PendingSteerDelivery,
  patch: Record<string, unknown> | ((entry: any) => Record<string, unknown>),
) {
  return changeEntry(paseo, input, lock, (entry) => {
    if (entry?.pendingWakeBrief?.wakeId !== pending.wakeId) return null;
    return typeof patch === "function" ? patch(entry) : patch;
  });
}

function blocked(detail: string, cleared = false): DeliveryResult {
  return { status: "blocked", cleared, detail };
}

const finishing = new Set<string>();

/** Releases a staged brief after the rewind RPC or the clear hook confirmed renewal. */
export async function finishSteerDelivery(
  paseo: any, input: DeliveryInput, deps: SteerDeliveryDeps = {},
): Promise<DeliveryResult | null> {
  const key = `${input.workspaceId}/${input.agentId}`;
  if (finishing.has(key)) return { status: "pending", cleared: false, detail: "The steer brief is being delivered." };
  finishing.add(key);
  const lock = deps.lock ?? productionLock;
  try {
    const meta = (await paseo.workspaces.ref(input.workspaceId).refresh())?.metadata ?? {};
    const entry = meta[AGENTS_KEY]?.[input.agentId];
    const pending = pendingSteerDelivery(entry, input.workspaceId);
    if (!pending) return null;
    const cleared = pending.renewal === "clear";
    const targetScope = scopeState(meta);
    if (!targetScope || targetScope.retired || targetScope.previousSteer === input.agentId ||
        (pending.epoch !== null && pending.epoch !== targetScope.epoch)) {
      await replacePending(paseo, input, lock, pending, { pendingWakeBrief: null });
      return null;
    }
    const agent = paseo.agents.ref(input.agentId);
    if (pending.phase !== "sent") {
      const snapshot = (await agent.refresh())?.agent;
      if (!snapshot || snapshot.archivedAt || snapshot.background === true) {
        await replacePending(paseo, input, lock, pending, { pendingWakeBrief: null });
        return null;
      }
      if (pending.phase === "blocked") return blocked(pending.lastError ?? "Context renewal needs attention.");
      if (pending.phase === "renewing" || entry?.pendingAction) {
        return { status: "pending", cleared, detail: "Context renewal is in progress. The brief follows confirmation." };
      }
      if (snapshot.activeTurn || snapshot.status === "running" || snapshot.status === "initializing" || snapshot.pendingPermissions?.length) {
        return { status: "pending", cleared, detail: "The renewed steer is busy. Its brief is queued." };
      }
    }
    let sent = pending;
    try {
      if (pending.phase !== "sent") {
        if (!sent.packet) {
          const brief = await deps.buildBrief?.(paseo, input.workspaceId, input.agentId);
          if (!brief) return { status: "pending", cleared, detail: "The renewed steer is waiting for its brief." };
          const full = pending.note ? `${brief}

${pending.note}` : brief;
          sent = { ...pending, packet: formatResumeMessage(full) };
          if (!await replacePending(paseo, input, lock, pending, { pendingWakeBrief: sent })) {
            return { status: "pending", cleared, detail: "Steer state changed while preparing the brief." };
          }
        }
        const current = (await paseo.workspaces.ref(input.workspaceId).refresh())?.metadata ?? {};
        if (current[AGENTS_KEY]?.[input.agentId]?.pendingWakeBrief?.wakeId !== pending.wakeId ||
            (pending.epoch !== null && pending.epoch !== scopeState(current)?.epoch)) {
          return { status: "pending", cleared, detail: "Steer state changed while preparing the brief." };
        }
        if (pending.batch?.takeover && pending.batch.workspaceId !== input.workspaceId) {
          const source = (await paseo.workspaces.ref(pending.batch.workspaceId).refresh())?.metadata ?? {};
          if (scopeState(source)?.epoch !== pending.batch.epoch) {
            await replacePending(paseo, input, lock, pending, { pendingWakeBrief: null });
            return null;
          }
        }
        // A stable user-message ID anchors the next rewind and deduplicates
        // retries if Paseo accepted the send before the metadata write failed.
        await agent.send(sent.packet, { messageId: pending.wakeId });
        sent = { ...sent, phase: "sent" };
        await replacePending(paseo, input, lock, pending, {
          pendingWakeBrief: sent,
          ...(pending.renewal === "rewind" ? { refreshed: { ...entry.refreshed, briefMessageId: pending.wakeId } } : {}),
        });
      }
      const batch = pending.batch;
      if (batch) {
        const at = deps.now?.() ?? new Date().toISOString();
        for (const event of batch.events) {
          await markWorker({
            client: paseo, workspaceId: batch.workspaceId, workerId: event.workerId, lock,
            patch: (worker, source) => {
              if (!worker || (batch.epoch !== null && batch.epoch !== scopeState(source)?.epoch)) return null;
              const queued = worker.pendingWake;
              const superseded = queued && (queued.state !== event.state ||
                Date.parse(queued.queuedAt) > Date.parse(pending.queuedAt));
              const marked = markSent(worker, { at, clearPending: !batch.takeover && !superseded });
              return { lastWakeAt: marked.lastWakeAt, pendingWake: marked.pendingWake };
            },
          });
        }
        if (batch.takeover) await deps.onTakeoverDelivered?.(paseo, batch, input.agentId);
      }
      await replacePending(paseo, input, lock, pending, (current) => ({
        pendingWakeBrief: null,
        lastSteerDeliveryId: pending.wakeId,
        ...(current.needsResume?.at === entry?.needsResume?.at ? { needsResume: null } : {}),
      }));
      return {
        status: "sent", cleared, renewed: true,
        detail: cleared ? "Context cleared and resume brief sent." : "Context rewound and resume brief sent.",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await replacePending(paseo, input, lock, pending, {
        pendingWakeBrief: { ...sent, lastError: message.slice(0, 300) },
      }).catch(() => {});
      return { status: "pending", cleared, detail: `Brief delivery is queued (${message}).` };
    }
  } finally {
    finishing.delete(key);
  }
}

/** Single entry for Factory wake, takeover, switch and explicit resume sends. */
export async function deliverSteer(
  paseo: any, input: DeliveryInput, deps: SteerDeliveryDeps = {},
): Promise<DeliveryResult> {
  const lock = deps.lock ?? productionLock;
  const [state, fresh, snapshot, settings, cleanup, keepChatHistory] = await Promise.all([
    input.state ?? readPaseoState(paseo),
    paseo.workspaces.ref(input.workspaceId).refresh(),
    paseo.agents.ref(input.agentId).refresh(),
    deps.getResumeSettings?.() ?? null,
    deps.getCleanupSettings?.() ?? null,
    deps.keepChatHistory?.() ?? false,
  ]);
  const meta = fresh?.metadata ?? {};
  const agent = snapshot?.agent ?? state.agents?.find((a: any) => a.id === input.agentId);
  const identity = cleanupIdentity(agent?.labels);
  const scope = scopeState(meta);
  if (identity?.role !== "steer" || !scope || agent.archivedAt || agent.background === true) {
    return blocked("The target is no longer a live Factory steer.");
  }
  if (input.epoch !== undefined && input.epoch !== scope.epoch) return blocked("The scope moved before the steer could be reached.");
  const entry = meta[AGENTS_KEY]?.[input.agentId];
  const existing = pendingSteerDelivery(entry, input.workspaceId);
  if (existing && existing.epoch === scope.epoch && !(input.manual && existing.phase === "blocked")) {
    if (existing.phase === "blocked") return blocked(existing.lastError ?? "Context renewal needs attention.");
    if (input.manual && existing.phase !== "renewing") {
      return (await finishSteerDelivery(paseo, input, deps)) ??
        { status: "pending", cleared: false, detail: "The steer brief is queued." };
    }
    return { status: "pending", cleared: existing.renewal === "clear", detail: "A steer brief is already queued." };
  }
  if (entry?.pendingAction || agent.activeTurn || agent.status === "running" ||
      agent.status === "initializing" || agent.pendingPermissions?.length) {
    return blocked("The steer is busy. Try again after the current operation.");
  }
  // Reuse the pill projection, with the freshly fetched agent and metadata.
  const projectionState = {
    ...state,
    agents: [...state.agents.filter((a: any) => a.id !== input.agentId), agent],
    workspaces: state.workspaces.map((ws: any) => ws.id === input.workspaceId ? { ...ws, metadata: meta } : ws),
  };
  const targetScope = listScopes(projectionState).find((candidate: any) =>
    candidate.workspaceId === input.workspaceId && sameScopeId(candidate.id, identity.scopeId));
  if (!targetScope || scope.retired === true) return blocked("The target does not belong to this live Factory scope.");
  const projected = collectSteerStates(projectionState, { settings: cleanup, nowMs: deps.now ? Date.parse(deps.now()) : undefined })
    .find((row) => row.agentId === input.agentId && row.workspaceId === input.workspaceId);
  const at = deps.now?.() ?? new Date().toISOString();
  const mode = decideSteerDelivery({
    warmth: projected?.warmth, large: projected?.large,
    provider: typeof agent.provider === "string" ? agent.provider.trim().toLowerCase() : undefined,
    recovery: !!entry?.needsResume, retry: existing?.phase === "blocked",
    manual: input.manual, settings, keepChatHistory,
  });
  if (mode === "send") {
    const brief = input.manual ? await deps.buildBrief?.(paseo, input.workspaceId, input.agentId) : null;
    const text = input.manual ? (brief && formatResumeMessage(brief)) : input.text;
    if (!text) return blocked("The steer delivery has no message.");
    const ref = paseo.agents.ref(input.agentId);
    if (input.sendOptions) await ref.send(text, input.sendOptions);
    else await ref.send(text);
    return { status: "sent", cleared: false, detail: input.manual ? "Resume brief sent into the warm context." : "Message sent." };
  }
  const original = existing?.epoch === (scope.epoch ?? null) ? existing : null;
  const eventBatch = input.batch ?? original?.batch;
  const pending: PendingSteerDelivery = {
    wakeId: randomUUID(),
    renewal: mode,
    phase: "renewing",
    queuedAt: at,
    epoch: typeof scope.epoch === "number" ? scope.epoch : null,
    note: (input.renewalNote ?? input.text ?? original?.note ?? "").slice(0, 1500),
    ...(eventBatch ? { batch: eventBatch } : {}),
  };
  const reserved = await changeEntry(paseo, input, lock, (current, currentMeta) => {
    if (scopeState(currentMeta)?.epoch !== scope.epoch || current.pendingAction) return null;
    const prior = pendingSteerDelivery(current, input.workspaceId);
    if (prior && prior.epoch === pending.epoch && !(input.manual && prior.phase === "blocked")) return null;
    return { pendingWakeBrief: pending };
  });
  if (!reserved) return { status: "pending", cleared: false, detail: "A steer operation is already queued." };

  // Wakes may be sent directly by callers that have not queued the workers
  // yet. Persist those events in the register before starting renewal.
  const batch = pending.batch;
  try {
    if (batch && !batch.takeover) {
      for (const event of batch.events) {
        await markWorker({
          client: paseo, workspaceId: batch.workspaceId, workerId: event.workerId, lock,
          patch: (worker, source) =>
            worker && !worker.pendingWake && (batch.epoch === null || batch.epoch === scopeState(source)?.epoch)
              ? { pendingWake: { state: event.state, queuedAt: at } } : null,
        });
      }
    }
    if (mode === "clear") {
      await (deps.runCleanupFn ?? runCleanup)(paseo, input.agentId, "clear", RESUME_PENDING_REASON, {
        workspaceId: input.workspaceId, lock, note: pending.note,
      });
      return { status: "pending", cleared: true, deliveryId: pending.wakeId, detail: "Clearing the context. The resume brief follows confirmation." };
    }
    const outcome = await runRewind(input.agentId, "", {
      createClient: deps.rewindClient ?? defaultCreateRewindClient,
      previousBriefId: entry?.refreshed?.briefMessageId,
      skipBrief: true,
    });
    if (outcome.status !== "rewound") {
      const why = outcome.status === "no-point" ? "no usable rewind point" :
        outcome.status === "unsupported" ? "the provider does not support rewind" :
        outcome.error ?? outcome.status;
      throw new Error(`Context rewind needs attention (${why}). Use Fresh to prepare a new tab or retry recovery.`);
    }
    await replacePending(paseo, input, lock, pending, {
      ...rewindRecord({ messageId: outcome.messageId, now: () => new Date(deps.now?.() ?? Date.now()) }),
      pendingWakeBrief: { ...pending, phase: "ready" },
    });
    const delivery = await finishSteerDelivery(paseo, input, deps);
    if (delivery && delivery.status !== "pending") return delivery;
    return {
      status: "pending", cleared: false, deliveryId: pending.wakeId,
      detail: delivery?.detail ?? "Context rewound. The resume brief is queued.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const detail = mode === "clear" ? `Resume could not clear ${input.agentId} (${message}). Open its tab, then try again.` : message;
    await replacePending(paseo, input, lock, pending, {
      pendingWakeBrief: { ...pending, phase: "blocked", lastError: detail.slice(0, 300) },
    });
    return blocked(detail);
  }
}
