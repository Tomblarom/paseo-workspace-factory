// Idle cleanup (C5) decisions and the cold hint (C6) predicate. Pure module:
// no imports, so plain node:test can use it. The server sweep
// (server/cold-sweep.ts) applies the returned decision; the client renders
// isCold/coldHintText results. Timeline fetching, locks, metadata writes,
// and the timer live server-side.

export const CLEAR_COMMAND = "/clear";
export const COMPACT_COMMAND = "/compact Keep: task, decisions, open ids, next step.";
export const SEED_AFTER_CLEAR =
  "Context was cleared to save prompt-cache cost. Run the factory resume brief before the next task.";
/** Old session ids kept per agent for "open old history" (C6). */
export const PREVIOUS_SESSIONS_MAX = 5;

// Label keys mirror LABEL in core paseo.mjs (shared/ must not import server/).
const SCOPE_KEY = "wsf.scope";
const ROLE_KEY = "wsf.role";
const SLOT_KEY = "wsf.slot";
const KEEP_KEY = "wsf.keepContext";
const LEGACY_SCOPE_KEY = "ari.wsf.scope";
const LEGACY_ROLE_KEY = "ari.wsf.role";
const LEGACY_SLOT_KEY = "ari.wsf.slot";
const LEGACY_KEEP_KEY = "ari.wsf.keepContext";

export interface CleanupSettings {
  mode: "off" | "clear" | "compact-warm";
  idleMinutes: number;
  compactAtMinutes: number;
  minContextTokens: number;
  providers: string[];
  roles: string[];
  seedAfterClear: boolean;
  clearAcknowledged: boolean;
  dailyCap: number;
}

/** Mirrors the defaults of the host-scope cleanup settings document. */
export const CLEANUP_DEFAULTS: CleanupSettings = {
  mode: "off",
  idleMinutes: 60,
  compactAtMinutes: 50,
  minContextTokens: 60000,
  providers: ["claude"],
  roles: ["steer", "worker"],
  seedAfterClear: false,
  clearAcknowledged: false,
  dailyCap: 20,
};

export interface FactoryIdentity {
  scopeId: string;
  role: string;
  slot: string | null;
}

/** Factory steer/worker from agent labels (legacy prefix accepted), else null. */
export function cleanupIdentity(
  labels: Record<string, string> | null | undefined,
): FactoryIdentity | null {
  if (!labels) return null;
  const scopeId = labels[SCOPE_KEY] ?? labels[LEGACY_SCOPE_KEY] ?? "";
  const role = labels[ROLE_KEY] ?? labels[LEGACY_ROLE_KEY] ?? "";
  if (!scopeId || (role !== "steer" && role !== "worker")) return null;
  const slot = labels[SLOT_KEY] ?? labels[LEGACY_SLOT_KEY] ?? null;
  return { scopeId, role, slot: slot || null };
}

/** Explicit per-agent opt-out survives every mode. */
export function hasKeepContext(labels: Record<string, string> | null | undefined): boolean {
  if (!labels) return false;
  return (
    labels[KEEP_KEY] === "true" || labels[LEGACY_KEEP_KEY] === "true"
  );
}

export interface CleanupInput {
  agentId: string;
  labels: Record<string, string> | null;
  provider: string;
  status: string;
  archivedAt: string | null;
  pendingPermissionCount: number;
  lastTurnEndedAt: string | null;
  contextTokens: number | null;
  activeSteer: unknown;
  checkpoint: Record<string, unknown> | null;
  /** The agent's own wsf.agents entry, if any. */
  entry: Record<string, unknown> | null;
  settings: CleanupSettings;
  actionsToday: number;
  /** A cleanup command demonstrably had no effect; the mode is off. */
  effectBlocked: boolean;
  nowMs: number;
}

export interface CleanupDecision {
  action: "clear" | "compact-warm" | null;
  /** The exact text to send; null when no action is taken. */
  command: string | null;
  /** Why the action is (not) taken; the sweep logs it. */
  reason: string;
}

function stampMs(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** The agent snapshot fields the sweep reads (daemon and client shapes). */
export interface CleanupSnapshot {
  id: string;
  labels: Record<string, string> | null;
  provider: string;
  status: string;
  archivedAt: string | null;
  pendingPermissions?: readonly unknown[] | null;
  lastUsage?: {
    contextWindowUsedTokens?: unknown;
    ContextWindowUsedTokens?: unknown;
  } | null;
  LastUsage?: {
    contextWindowUsedTokens?: unknown;
    ContextWindowUsedTokens?: unknown;
  } | null;
}

function usedContextTokens(agent: CleanupSnapshot): number | null {
  const snapshot = agent.lastUsage ?? agent.LastUsage ?? null;
  const used = snapshot?.contextWindowUsedTokens ?? snapshot?.ContextWindowUsedTokens;
  return typeof used === "number" && Number.isFinite(used) ? used : null;
}

/**
 * Assembles one decideCleanupAction input from a live agent snapshot, its
 * wsf.agents entry, and the scope checkpoint. Keeps the server sweep thin.
 */
export function cleanupInputOf(args: {
  agent: CleanupSnapshot;
  entry: Record<string, unknown> | null;
  checkpoint: Record<string, unknown> | null;
  activeSteer: unknown;
  settings: CleanupSettings;
  actionsToday: number;
  effectBlocked: boolean;
  nowMs: number;
}): CleanupInput {
  const lastTurnEndedAt = args.entry?.lastTurnEndedAt;
  return {
    agentId: args.agent.id,
    labels: args.agent.labels ?? null,
    provider: args.agent.provider,
    status: args.agent.status,
    archivedAt: args.agent.archivedAt ?? null,
    pendingPermissionCount: Array.isArray(args.agent.pendingPermissions)
      ? args.agent.pendingPermissions.length
      : 0,
    lastTurnEndedAt: typeof lastTurnEndedAt === "string" ? lastTurnEndedAt : null,
    contextTokens: usedContextTokens(args.agent),
    activeSteer: args.activeSteer,
    checkpoint: args.checkpoint,
    entry: args.entry,
    settings: args.settings,
    actionsToday: args.actionsToday,
    effectBlocked: args.effectBlocked,
    nowMs: args.nowMs,
  };
}

/**
 * One C5 evaluation per agent. Every condition is checked on its own and the
 * first failure wins with a reason, so each rule is testable in isolation.
 * Unknown timestamps or context sizes fail closed (no action).
 */
export function decideCleanupAction(input: CleanupInput): CleanupDecision {
  const { settings } = input;
  const deny = (reason: string): CleanupDecision => ({ action: null, command: null, reason });
  if (input.effectBlocked) {
    return deny("automatic cleanup is disabled after a command without effect");
  }
  if (settings.mode === "off") return deny("mode is off");
  if (settings.mode === "clear" && !settings.clearAcknowledged) {
    return deny("mode clear needs the clearAcknowledged setting (the old timeline is only kept via import)");
  }
  const identity = cleanupIdentity(input.labels);
  if (!identity) return deny("not a factory steer or worker");
  if (!settings.roles.includes(identity.role)) {
    return deny(`role ${identity.role} is not in roles`);
  }
  if (!settings.providers.includes(input.provider)) {
    return deny(`provider ${input.provider} is not in providers`);
  }
  if (input.archivedAt) return deny("agent is archived");
  if (input.status !== "idle") return deny(`agent is ${input.status}`);
  if (input.pendingPermissionCount > 0) return deny("a permission request is pending");
  if (input.entry?.pendingAction) return deny("a cleanup action is already pending");
  if (input.entry?.lastActionFailed) {
    return deny("the last cleanup action failed; a new real turn is required first");
  }
  const thresholdMinutes = settings.mode === "clear" ? settings.idleMinutes : settings.compactAtMinutes;
  const lastEnd = stampMs(input.lastTurnEndedAt);
  if (lastEnd === null) return deny("the last turn end is unknown");
  const idleMs = input.nowMs - lastEnd;
  if (idleMs < thresholdMinutes * 60_000) {
    return deny(`idle ${Math.max(0, Math.floor(idleMs / 60_000))}m is below ${thresholdMinutes}m`);
  }
  if (input.contextTokens === null || input.contextTokens === undefined) {
    return deny("context size is unknown");
  }
  if (input.contextTokens < settings.minContextTokens) {
    return deny(`context ${input.contextTokens} is below ${settings.minContextTokens}`);
  }
  if (input.entry?.interrupted) return deny("the agent state is interrupted");
  const isActive =
    identity.role === "steer" && typeof identity.slot === "string" && identity.slot === input.activeSteer;
  if (isActive) {
    const task = input.checkpoint?.task;
    if (typeof task !== "string" || task.trim() === "") return deny("no task checkpoint");
    const stamped = stampMs(input.checkpoint?.capturedAt ?? input.checkpoint?.updatedAt);
    if (stamped === null || stamped < lastEnd) {
      return deny("the scope checkpoint is older than the last turn");
    }
    if (input.checkpoint?.interrupted) return deny("the scope checkpoint is flagged interrupted");
  } else {
    const noteAt = stampMs(input.entry?.noteAt);
    if (noteAt === null || noteAt < lastEnd) return deny("no note from the last turn");
  }
  const clearedAt = stampMs((input.entry?.cleared as Record<string, unknown> | null)?.at);
  if (clearedAt !== null && clearedAt >= lastEnd) {
    return deny("already cleaned after the last turn");
  }
  if (hasKeepContext(input.labels)) return deny("wsf.keepContext is set");
  if (input.actionsToday >= settings.dailyCap) return deny("the daily cap is reached");
  const command = settings.mode === "clear" ? CLEAR_COMMAND : COMPACT_COMMAND;
  return { action: settings.mode, command, reason: `${settings.mode} ${input.agentId}` };
}

export interface ColdInput {
  lastTurnEndedAt: string | null;
  contextTokens: number | null;
  idleMinutes: number;
  minContextTokens: number;
  nowMs: number;
}

/** Cold for C6: idle past the threshold with a context worth cleaning. */
export function isCold(input: ColdInput): boolean {
  const lastEnd = stampMs(input.lastTurnEndedAt);
  if (lastEnd === null) return false;
  if (input.contextTokens === null || input.contextTokens === undefined) return false;
  return (
    input.nowMs - lastEnd >= input.idleMinutes * 60_000 &&
    input.contextTokens >= input.minContextTokens
  );
}

function formatIdle(idleMs: number): string {
  const minutes = Math.floor(idleMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Short pill/panel line, e.g. "Kontext kalt · 350k · 2h". */
export function coldHintText(contextTokens: number, idleMs: number): string {
  return `Kontext kalt · ${Math.round(contextTokens / 1000)}k · ${formatIdle(idleMs)}`;
}

export interface CleanupEvidence {
  turnReadable: boolean;
  compactionSeen: boolean;
  markerSeen: boolean;
  sessionNoteSeen: boolean;
}

interface TimelineItemLike {
  item?: { type?: unknown; text?: unknown; message?: unknown } | null;
}

function itemTexts(entry: unknown): string[] {
  const item = (entry as TimelineItemLike | null)?.item;
  if (!item || typeof item !== "object") return [];
  const out: string[] = [];
  if (typeof item.text === "string") out.push(item.text);
  if (typeof item.message === "string") out.push(item.message);
  return out;
}

/**
 * Scans turn timeline entries for cleanup evidence. The notice wording is
 * best-effort until a live check pins the exact shape (C1/C7); the session-id
 * comparison in the caller stays the authoritative signal for /clear.
 */
export function scanCleanupEvidence(entries: readonly unknown[]): CleanupEvidence {
  const found: CleanupEvidence = {
    turnReadable: entries.length > 0,
    compactionSeen: false,
    markerSeen: false,
    sessionNoteSeen: false,
  };
  for (const entry of entries) {
    const item = (entry as TimelineItemLike | null)?.item;
    if (item?.type === "compaction") found.compactionSeen = true;
    for (const text of itemTexts(entry)) {
      if (/\[Compacted\]/.test(text)) found.markerSeen = true;
      if (/new session|session changed|switched to a new session|neue Session|neuer Session/i.test(text)) {
        found.sessionNoteSeen = true;
      }
    }
  }
  return found;
}

/**
 * Appends a session id to the previous-sessions history, deduplicated and
 * bounded. A null id keeps the list unchanged.
 */
export function pushPreviousSession(
  list: readonly string[] | null | undefined,
  sessionId: string | null | undefined,
): string[] {
  const kept = [...(list ?? [])].filter((id) => typeof id === "string" && id !== "");
  if (typeof sessionId !== "string" || sessionId === "") return kept;
  return [...kept.filter((id) => id !== sessionId), sessionId].slice(-PREVIOUS_SESSIONS_MAX);
}

/**
 * Sends a cleanup command through the plugin SDK. Never passes send options:
 * any sourceAgentId would wrap the command as plain "[Message received]"
 * text without effect (and still cost a turn). Never shell out to the CLI
 * for these commands: the CLI fills sourceAgentId from PASEO_AGENT_ID.
 */
export async function sendCleanupCommand(paseo: any, agentId: string, command: string): Promise<void> {
  await paseo.agents.ref(agentId).send(command);
}
