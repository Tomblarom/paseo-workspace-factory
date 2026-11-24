// Idle cleanup (C5) decisions and the cold hint (C6) predicate. Pure module:
// it imports only the sibling cache reference, so plain node:test can use it
// (tests register test/ts-resolve-hooks.mjs for the .js specifier). The
// server sweep (server/cold-sweep.ts) applies the returned decision; the
// client renders isCold/coldHintText results. Timeline fetching, locks,
// metadata writes, and the timer live server-side.
import {
  CACHE_GROUPS,
  compactAtMinutes,
  effectiveMinContextTokens,
  groupForProviderModel,
  isCleanupProfile,
  isCompactOnlyGroup,
  type CacheGroup,
  type CleanupProfile,
} from "./cache-profiles.js";
import { FRESH_BASE_TOKENS, MAX_WARM_COMPACTIONS } from "./auto-checkpoint.js";

export const CLEAR_COMMAND = "/clear";
export const COMPACT_COMMAND = "/compact Keep: task, decisions, open ids, next step.";
export const SEED_AFTER_CLEAR =
  "Context was cleared to save prompt-cache cost. Run the factory resume brief before the next task.";
/** Old session ids kept per agent for "open old history" (C6). */
export const PREVIOUS_SESSIONS_MAX = 5;

/** Header marking a resume brief in the agent timeline (R-A). */
export const RESUME_BRIEF_HEADER = "[Factory resume]";
/** pendingAction.reason for a resume clear; the turn hook sends the brief for these. */
export const RESUME_PENDING_REASON = "resume";
/** pendingAction.reason for an automatic C5 sweep clear (seed path, unchanged). */
export const SWEEP_PENDING_REASON = "idle";
/** Notice heading the brief when it arrives without a cleared context. */
export const RESUME_NOT_CLEARED_NOTICE =
  "Kontext nicht geleert: der Clear-Befehl blieb ohne Wirkung; der Brief unten ist der aktuelle Stand.";

/** Why a steer needs `/factory resume` (E4); "cold" keeps the C6 hint shape. */
export type NeedsResumeReason = "daemon-restart" | "limit" | "failed" | "cold";

export interface NeedsResume {
  reason: NeedsResumeReason;
  at: string;
}

export function isNeedsResumeReason(value: unknown): value is NeedsResumeReason {
  return value === "daemon-restart" || value === "limit" || value === "failed" || value === "cold";
}

/**
 * Failure-text patterns that classify a failed steer turn as a provider limit
 * (E4). Best-effort until live failures pin the exact wording per provider
 * (claude usage limit, codex rate limit); everything else counts as "failed".
 */
export const RESUME_LIMIT_PATTERNS: readonly RegExp[] = [
  /usage\s*limit/i,
  /rate\s*limit/i,
  /too many requests/i,
  /\bquota\b/i,
  /\blimit\s*(reached|exceeded|reset|hit)\b/i,
  /http\s*429\b/i,
];

/** True when a turn failure text looks like a provider limit or quota. */
export function isLimitFailure(text: string | null | undefined): boolean {
  if (typeof text !== "string" || !text) return false;
  return RESUME_LIMIT_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

/**
 * needsResume value for a failed steer turn (limit vs failed), else null.
 * Only steers are resumed; workers and canceled turns never flag.
 */
export function needsResumeForFailedTurn(args: {
  role: string;
  outcome: string;
  error: string | null;
  at: string;
}): NeedsResume | null {
  if (args.role !== "steer" || args.outcome !== "failed") return null;
  return { reason: isLimitFailure(args.error) ? "limit" : "failed", at: args.at };
}

/** Providers allowed to receive /clear during `/factory resume`. */
export interface ResumeClearSettings {
  providers: string[];
  /** Boot check: a steer whose last turn ended this recently before the daemon start is marked. */
  recentHours: number;
}

/** Mirrors the defaults of the host-scope resume settings document. */
export const RESUME_CLEAR_DEFAULTS: ResumeClearSettings = {
  providers: ["claude"],
  recentHours: 24,
};

export type BootResumeReason = "open-turn" | "active-recent" | "recent";

/**
 * Boot-check rule for needsResume (steers only). `closed` alone is never a
 * reason: after a daemon restart nearly everything is closed. Marked when
 * (a) a turn was open at the restart, or (b) the steer's last turn ended less
 * than `recentHours` before the daemon start — the active steer (`active`)
 * and every other recently active steer alike. The reminder text differs
 * (see resumeReminderText), but the flag is the same. Advisors qualify only
 * under (a).
 */
export function bootResumeReason(args: {
  openTurn: boolean;
  active: boolean;
  advisor: boolean;
  lastTurnEndedAt: string | null | undefined;
  daemonStartedAt: string;
  recentHours: number;
}): BootResumeReason | null {
  if (args.openTurn) return "open-turn";
  if (args.advisor) return null;
  const ended = Date.parse(String(args.lastTurnEndedAt ?? ""));
  const started = Date.parse(args.daemonStartedAt);
  if (!Number.isFinite(ended) || !Number.isFinite(started)) return null;
  if (started - ended >= args.recentHours * 3_600_000) return null;
  return args.active ? "active-recent" : "recent";
}

/**
 * Reminder text for a steer flagged with needsResume. The active steer (and
 * any advisor, which can never take over) keeps the short "Resume nötig ·
 * <Grund>"; any other recently active steer is told who steered last and
 * that resuming here takes over coordination.
 */
export function resumeReminderText(args: {
  reasonLabel: string;
  canFresh: boolean;
  advisor: boolean;
  activeSteer: string | null | undefined;
}): { pill: string; title: string; body: string } {
  const active = `Resume nötig · ${args.reasonLabel}`;
  if (args.canFresh || args.advisor) return { pill: active, title: active, body: "" };
  const who = args.activeSteer ? `Steer ${args.activeSteer}` : "ein anderer Steer";
  return {
    pill: `Zuletzt steuerte ${who}`,
    title: `Zuletzt steuerte ${who}`,
    body: "Du kannst hier weitermachen; dieser Steer wird dann zum steuernden.",
  };
}

/** Sidebar counter: attention rows that need resume AND belong to an active steer (canFresh). */
export function countActiveResumeRows(
  rows: readonly { reason?: string; canFresh?: boolean }[],
): number {
  return rows.filter(
    (row) =>
      (row.reason === "daemon-restart" || row.reason === "limit" || row.reason === "failed") &&
      row.canFresh === true,
  ).length;
}

/** True when the provider may be cleared during resume (E1 matrix). */
export function mayResumeClear(
  provider: unknown,
  settings: ResumeClearSettings | null | undefined,
): boolean {
  if (typeof provider !== "string" || !provider) return false;
  return (settings?.providers ?? RESUME_CLEAR_DEFAULTS.providers).includes(provider);
}

/**
 * Full timeline message for a resume brief: the header plus the brief, or the
 * header plus the not-cleared notice when the context was kept (effectFailed
 * or a provider without clear support).
 */
export function formatResumeMessage(brief: string, opts?: { cleared?: boolean }): string {
  const body = brief.trim();
  if (opts?.cleared === false) return `${RESUME_BRIEF_HEADER} (${RESUME_NOT_CLEARED_NOTICE})\n${body}`;
  return `${RESUME_BRIEF_HEADER}\n${body}`;
}

// Label keys mirror LABEL in core paseo.mjs (shared/ must not import server/).
const SCOPE_KEY = "wsf.scope";
const ROLE_KEY = "wsf.role";
const SLOT_KEY = "wsf.slot";
const KEEP_KEY = "wsf.keepContext";
const LEGACY_SCOPE_KEY = "ari.wsf.scope";
// Steers created before wsf.scope (or by relocate) carry only the repo label;
// for steers the repo label is the scope id, as in core discovery.
const REPO_KEY = "wsf.repo";
const LEGACY_REPO_KEY = "ari.wsf.repo";
const LEGACY_ROLE_KEY = "ari.wsf.role";
const LEGACY_SLOT_KEY = "ari.wsf.slot";
const LEGACY_KEEP_KEY = "ari.wsf.keepContext";

export interface CleanupSettings {
  mode: "off" | "clear" | "compact-warm";
  /** Cost profile: derives the per-group compact threshold (balanced default). */
  profile: CleanupProfile;
  idleMinutes: number;
  minContextTokens: number;
  providers: string[];
  roles: string[];
  seedAfterClear: boolean;
  clearAcknowledged: boolean;
  dailyCap: number;
}

/** Mirrors the defaults of the host-scope cleanup settings document. */
export const CLEANUP_DEFAULTS: CleanupSettings = {
  mode: "clear",
  profile: "balanced",
  idleMinutes: 60,
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
  const scopeId =
    labels[SCOPE_KEY] ?? labels[LEGACY_SCOPE_KEY] ?? labels[REPO_KEY] ?? labels[LEGACY_REPO_KEY] ?? "";
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
  /** Model id for the cache-group classifier; null falls back to the provider. */
  model: string | null;
  /**
   * Provider quota for the compact gate: false blocks the compact, true or
   * unknown (null/undefined) allows it. Unknown fails open on purpose: quota
   * sampling is best-effort, and a compact that hits a real limit is flagged
   * by the turn hook as needsResume=limit, which blocks later compacts.
   */
  quotaAvailable?: boolean | null;
  /**
   * Scope workers with unfinished state (running/blocked/interrupted).
   * A steer with none is at a package boundary (fresh hint); unknown
   * (null/undefined) counts as mid-package, like before. Workers ignore it:
   * an idle worker with a fresh note is always at its package boundary.
   */
  openWorkers?: number | null;
  status: string;
  archivedAt: string | null;
  pendingPermissionCount: number;
  lastTurnEndedAt: string | null;
  contextTokens: number | null;
  activeSteer: unknown;
  checkpoint: Record<string, unknown> | null;
  /** The agent's own wsf.agents entry, if any. */
  entry: Record<string, unknown> | null;
  /**
   * The agent's wsf.workers register state, if any (read by the server sweep;
   * absent or null means unsupervised). Supervision-protected states skip.
   */
  workerState?: string | null;
  settings: CleanupSettings;
  actionsToday: number;
  /** A cleanup command demonstrably had no effect; the mode is off. */
  effectBlocked: boolean;
  nowMs: number;
}

/**
 * Idle cleanup (C5) skips agents whose register state is running, blocked or
 * interrupted, so an unfinished worker is not cleared before its steer has
 * seen it. Mirrors isCleanupProtected in core supervision.mjs (shared/ must
 * not import server/).
 */
export function isSupervisionProtectedState(state: unknown): boolean {
  return state === "running" || state === "blocked" || state === "interrupted";
}

export interface CleanupDecision {
  /** `fresh-recommended` is a recorded hint; the sweep sends nothing for it. */
  action: "clear" | "compact-warm" | "fresh-recommended" | null;
  /** The exact text to send; null when nothing is sent. */
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
  model?: string | null;
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
  /** The agent's wsf.workers register state, if any. */
  workerState?: string | null;
  /** Provider quota for the compact gate (null/undefined = unknown, allowed). */
  quotaAvailable?: boolean | null;
  /** Scope workers with unfinished state (null/undefined = unknown). */
  openWorkers?: number | null;
}): CleanupInput {
  const lastTurnEndedAt = args.entry?.lastTurnEndedAt;
  return {
    agentId: args.agent.id,
    labels: args.agent.labels ?? null,
    provider: args.agent.provider,
    model: typeof args.agent.model === "string" ? args.agent.model : null,
    quotaAvailable: args.quotaAvailable ?? null,
    openWorkers: args.openWorkers ?? null,
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
    workerState: args.workerState ?? null,
    settings: args.settings,
    actionsToday: args.actionsToday,
    effectBlocked: args.effectBlocked,
    nowMs: args.nowMs,
  };
}

/**
 * One C5 evaluation per agent. Every condition is checked on its own and the
 * first failure wins with a reason, so each rule is testable in isolation.
 * Unknown timestamps or context sizes fail closed (no action); unknown quota
 * fails open (the turn hook flags a real limit, which then blocks compacts).
 * Compact-only groups (Codex) map mode clear to a compact, never a /clear.
 * Hybrid compact/fresh rule: mid-package agents compact while warm; cold,
 * over-compacted, or boundary agents get `fresh-recommended` (a recorded
 * hint, no send); agents without a valid package state cool untouched.
 */
export function decideCleanupAction(input: CleanupInput): CleanupDecision {
  const { settings } = input;
  const deny = (reason: string): CleanupDecision => ({ action: null, command: null, reason });
  const group: CacheGroup = groupForProviderModel(input.provider, input.model ?? null);
  const compactOnly = isCompactOnlyGroup(group);
  const compacting = settings.mode === "compact-warm" || (settings.mode === "clear" && compactOnly);
  const profile: CleanupProfile = isCleanupProfile(settings.profile) ? settings.profile : "balanced";
  if (input.effectBlocked) {
    return deny("automatic cleanup is disabled after a command without effect");
  }
  if (settings.mode === "off") return deny("mode is off");
  if (settings.mode === "clear" && !compactOnly && !settings.clearAcknowledged) {
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
  if (isSupervisionProtectedState(input.workerState ?? null)) {
    return deny(`supervised worker is ${input.workerState}; the steer has not seen it yet`);
  }
  if (input.status !== "idle") return deny(`agent is ${input.status}`);
  if (input.pendingPermissionCount > 0) return deny("a permission request is pending");
  if (input.entry?.pendingAction) return deny("a cleanup action is already pending");
  if (input.entry?.lastActionFailed) {
    return deny("the last cleanup action failed; a new real turn is required first");
  }
  const thresholdMinutes = compacting ? compactAtMinutes(profile, group) : settings.idleMinutes;
  const lastEnd = stampMs(input.lastTurnEndedAt);
  if (lastEnd === null) return deny("the last turn end is unknown");
  const idleMs = input.nowMs - lastEnd;
  if (idleMs < thresholdMinutes * 60_000) {
    return deny(`idle ${Math.max(0, Math.floor(idleMs / 60_000))}m is below ${thresholdMinutes}m`);
  }
  if (input.contextTokens === null || input.contextTokens === undefined) {
    return deny("context size is unknown");
  }
  const minTokens = compacting
    ? effectiveMinContextTokens(profile, settings.minContextTokens)
    : settings.minContextTokens;
  if (input.contextTokens < minTokens) {
    return deny(`context ${input.contextTokens} is below ${minTokens}`);
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
  // Hybrid rule: cold, over-compacted, or boundary agents get a fresh hint
  // instead of a compact. Unknown counts fail open toward compacting.
  const freshHintReason = (): string | null => {
    const ttlMinutes = CACHE_GROUPS[group].ttlMinutes;
    if (idleMs >= ttlMinutes * 60_000) {
      return `idle ${Math.max(0, Math.floor(idleMs / 60_000))}m already passed the ${ttlMinutes}m ${group} cache`;
    }
    const compactions = input.entry?.compactions;
    if (typeof compactions === "number" && compactions >= MAX_WARM_COMPACTIONS) {
      return `already compacted ${Math.floor(compactions)} times`;
    }
    const baseTokens = input.entry?.lastCompactBaseTokens;
    if (typeof baseTokens === "number" && baseTokens > FRESH_BASE_TOKENS) {
      return `post-compact base ${Math.floor(baseTokens)} tokens is above ${FRESH_BASE_TOKENS}`;
    }
    if (identity.role === "worker") {
      return "worker package done; start a new worker for the next task";
    }
    if (input.openWorkers === 0) {
      return "package boundary: valid checkpoint, no open workers";
    }
    return null;
  };
  if (compacting) {
    const fresh = freshHintReason();
    if (fresh) {
      const hintedAt = stampMs((input.entry?.freshHint as Record<string, unknown> | null)?.at);
      if (hintedAt !== null && hintedAt >= lastEnd) {
        return deny("fresh already recommended after the last turn");
      }
      return {
        action: "fresh-recommended",
        command: null,
        reason: `fresh-recommended ${input.agentId} (${fresh})`,
      };
    }
    if (input.quotaAvailable === false) return deny("provider quota is exhausted");
    const flagged = (input.entry?.needsResume ?? null) as { reason?: unknown } | null;
    if (flagged?.reason === "limit") return deny("a provider limit is flagged for this agent");
  }
  if (input.actionsToday >= settings.dailyCap) return deny("the daily cap is reached");
  if (compacting) {
    const mapped =
      settings.mode === "clear" ? ` (mode clear maps to compact: no native /clear for ${group})` : "";
    return {
      action: "compact-warm",
      command: COMPACT_COMMAND,
      reason: `compact-warm ${input.agentId}${mapped}`,
    };
  }
  return { action: "clear", command: CLEAR_COMMAND, reason: `clear ${input.agentId}` };
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
