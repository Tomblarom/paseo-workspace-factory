// Worker supervision (S-B) plugin-side decisions. Pure module: no imports, so
// both the plugin bundles and plain node:test use it. The core register rules
// (transitions, wake planning, failover chain, escalation) live in
// src/supervision.mjs; server/supervise.ts uses them through the synced factory
// copy. This module only holds what the core does not: worker metadata, the
// ADVISOR-REQUEST scan, the first-turn excerpt, the drain-marker quiet check,
// wake text extras (archive hint, takeover requests), the
// answered/busy/unanswered classification, and the settings mirror.

/** Agent metadata key carrying the immutable worker facts (plugin-owned). */
export const WORKER_METADATA_KEY = "wsf.worker";
/** Workspace metadata key carrying the live drain marker; mirrors DRAIN_KEY in core drain.mjs. */
export const DRAIN_METADATA_KEY = "wsf.drain";
/** Stale-marker grace; mirrors DRAIN_GRACE_MS in core drain.mjs. */
export const DRAIN_GRACE_MS = 60_000;
/** Task excerpt bound; mirrors TASK_MAX in core supervision.mjs. */
export const TASK_EXCERPT_MAX = 300;
/** Wake text lists at most this many worker ids, then "+N more". */
export const WAKE_LIST_MAX = 5;

export interface SupervisionSettings {
  enabled: boolean;
  batchMinutes: number;
  wakeDebounceSeconds: number;
  watchdogMinutes: number;
  staleMinutes: number;
  answerMinutes: number;
  maxAutoResumes: number;
  quota: { exhaustedPct: number; warnPct: number };
  quotaSampleMinutes: number;
}

/**
 * Mirrors the defaults of the host-scope supervision settings document
 * (shared/settings.ts); {} parses into the same document.
 */
export const SUPERVISION_SETTINGS_DEFAULTS: SupervisionSettings = {
  enabled: true,
  batchMinutes: 0,
  wakeDebounceSeconds: 20,
  watchdogMinutes: 15,
  staleMinutes: 60,
  answerMinutes: 10,
  maxAutoResumes: 2,
  quota: { exhaustedPct: 95, warnPct: 75 },
  quotaSampleMinutes: 10,
};

export interface WorkerMetadata {
  scopeId: string;
  startedBy: string | null;
  epoch: number | null;
  task: string;
}

function clipExcerpt(task: unknown): string {
  const text = String(task ?? "").trim().replace(/\s+/g, " ");
  return text.length > TASK_EXCERPT_MAX ? text.slice(0, TASK_EXCERPT_MAX) : text;
}

/** Fixed worker facts for the plugin metadata map; written once, never updated. */
export function buildWorkerMetadata(args: {
  scopeId: string;
  startedBy: string | null;
  epoch: number | null;
  task: string | null;
}): WorkerMetadata {
  return {
    scopeId: args.scopeId,
    startedBy: typeof args.startedBy === "string" && args.startedBy ? args.startedBy : null,
    epoch: typeof args.epoch === "number" && Number.isInteger(args.epoch) ? args.epoch : null,
    task: clipExcerpt(args.task),
  };
}

/** True for a metadata value this module wrote (scope id plus excerpt). */
export function isWorkerMetadata(value: unknown): value is WorkerMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.scopeId === "string" && !!record.scopeId && typeof record.task === "string";
}

export function workerIdentityFromMetadata(agent: { metadata?: Record<string, unknown> } | null) {
  const worker = agent?.metadata?.[WORKER_METADATA_KEY];
  return isWorkerMetadata(worker) ? { scopeId: worker.scopeId, role: "worker" as const, slot: null } : null;
}

/**
 * True when the answer carries an ADVISOR-REQUEST block (fenced or bare),
 * mirroring the CHECKPOINT header scan in core steer.mjs.
 */
export function hasAdvisorRequest(text: string | null | undefined): boolean {
  if (typeof text !== "string" || !text) return false;
  return text
    .split("\n")
    .some((line) => /^\s*`*\s*ADVISOR-REQUEST\s*:?\s*`*\s*$/.test(line));
}

/** First user message of turn timeline entries, or null when there is none. */
export function firstUserText(entries: unknown): string | null {
  if (!Array.isArray(entries)) return null;
  for (const entry of entries) {
    const item = (entry as { item?: { type?: unknown; text?: unknown } } | null)?.item;
    if (item?.type === "user_message" && typeof item.text === "string") return item.text;
  }
  return null;
}

/** Register ids in state `done`, sorted for deterministic wake text. */
export function selectDoneIds(
  register: Record<string, { state?: unknown } | null | undefined> | null | undefined,
): string[] {
  if (!register || typeof register !== "object") return [];
  return Object.keys(register)
    .filter((id) => register[id]?.state === "done")
    .sort();
}

/**
 * The "archive accepted workers" line for wake text (null when no worker is
 * done). The steer archives; the plugin never calls archive itself, per the
 * standing rule in AGENTS.md.
 */
export function archiveHintLine(doneIds: readonly string[]): string | null {
  if (!doneIds.length) return null;
  const shown = [...doneIds].sort().slice(0, WAKE_LIST_MAX).join(", ");
  const more = doneIds.length > WAKE_LIST_MAX ? ` (+${doneIds.length - WAKE_LIST_MAX} more)` : "";
  return (
    `Archive accepted workers with \`paseo archive <id>\` once you have checked each result ` +
    `against the task (done now: ${shown}${more}); never archive running, blocked or interrupted workers.`
  );
}

/** Appends the archive hint to a wake text when workers are done. */
export function withArchiveHint(base: string, doneIds: readonly string[]): string {
  const line = archiveHintLine(doneIds);
  return line ? `${base}\n${line}` : base;
}

export interface OverContinuedWorker {
  id: string;
  resumes: number;
}

/**
 * Advisor hint for workers continued past maxAutoResumes without progress
 * (null when none). The steer owns the escalation itself; the wake only
 * points at the next step.
 */
export function escalationHintLine(over: readonly OverContinuedWorker[]): string | null {
  if (!over.length) return null;
  const sorted = [...over].sort((a, b) => a.id.localeCompare(b.id));
  const shown = sorted
    .slice(0, WAKE_LIST_MAX)
    .map((w) => `${w.id} (x${w.resumes})`)
    .join(", ");
  const more = sorted.length > WAKE_LIST_MAX ? ` (+${sorted.length - WAKE_LIST_MAX} more)` : "";
  return (
    `Continued without progress (${shown}${more}): consult an advisor (paseo-advisor skill), ` +
    `then escalate with domain:/hub: blockers (user: only as the last step).`
  );
}

export interface OpenWorkerSummary {
  id: string;
  state: string;
}

function summarizeOpenWorkers(open: readonly OpenWorkerSummary[]): string {
  if (!open.length) return "Open workers: none recorded.";
  const shown = open
    .slice(0, WAKE_LIST_MAX)
    .map((w) => `${w.id} ${w.state}`)
    .join(", ");
  return `Open workers: ${shown}${open.length > WAKE_LIST_MAX ? ` (+${open.length - WAKE_LIST_MAX} more)` : ""}.`;
}

/**
 * Takeover request to the next live steer of the scope. The candidate takes
 * over with the epoch-checked switch; the loser of a race gets a refusal and
 * stops (core switchSteer).
 */
export function formatSteerTakeover(args: {
  scopeId: string;
  epoch: unknown;
  activeSlot: string;
  candidateSlot: string;
  reason: string;
  openWorkers: readonly OpenWorkerSummary[];
  factoryCmd?: string;
}): string {
  const cmd = args.factoryCmd ?? "paseo-factory";
  return (
    `[factory] Scope ${args.scopeId}, epoch ${String(args.epoch ?? "?")}: ` +
    `Steer ${args.activeSlot} is not answering (${args.reason}). ` +
    `Take over with \`${cmd} switch ${args.scopeId} --to ${args.candidateSlot} --apply\`; ` +
    `if it is refused, stop. ${summarizeOpenWorkers(args.openWorkers)} ` +
    `Run \`${cmd} resume\` after the takeover. Ignore if your epoch is newer.`
  );
}

/**
 * Takeover request to the domain or hub steer (last chain links): they have no
 * slot in this scope, so they intervene instead of switching.
 */
export function formatScopeTakeover(args: {
  scopeId: string;
  epoch: unknown;
  kind: "domain" | "hub";
  reason: string;
  openWorkers: readonly OpenWorkerSummary[];
  factoryCmd?: string;
}): string {
  const cmd = args.factoryCmd ?? "paseo-factory";
  const tail =
    args.kind === "domain"
      ? `check \`${cmd} status ${args.scopeId}\` and reassign the work or escalate with a \`hub:\` blocker`
      : `check \`${cmd} status ${args.scopeId}\` and reassign the work or provision a new steer (a \`user:\` blocker only as the last step)`;
  return (
    `[factory] Scope ${args.scopeId}, epoch ${String(args.epoch ?? "?")}: ` +
    `no steer answers (${args.reason}). As the ${args.kind} steer, ${tail}. ` +
    `${summarizeOpenWorkers(args.openWorkers)} Ignore if this scope already moved on.`
  );
}

/** How the woken steer reacted: answered, still busy, or unanswered. */
export type SteerWakeResponse = "answered" | "busy" | "unanswered";

/**
 * Classifies the woken steer's reaction to the wake at lastWakeAt from its
 * wsf.agents entry and live status. A completed turn after the wake answered
 * it; a failed or canceled turn counts as unanswered (a provider limit or
 * error, per the design); a still-running turn is alive, so failover waits
 * instead of yanking a healthy busy steer. An unparsable or missing wake
 * stamp means no outstanding wake and counts as answered.
 */
export function steerWakeResponse(args: {
  entry: {
    openTurnId?: unknown;
    lastTurnEndedAt?: unknown;
    outcome?: unknown;
  } | null | undefined;
  status: string | null | undefined;
  lastWakeAt: string | null | undefined;
}): SteerWakeResponse {
  const wakeMs = typeof args.lastWakeAt === "string" ? Date.parse(args.lastWakeAt) : NaN;
  if (!Number.isFinite(wakeMs)) return "answered";
  const entry = args.entry ?? null;
  const endMs = typeof entry?.lastTurnEndedAt === "string" ? Date.parse(entry.lastTurnEndedAt) : NaN;
  if (Number.isFinite(endMs) && endMs > wakeMs && entry?.outcome === "completed") return "answered";
  if (entry?.openTurnId !== null && entry?.openTurnId !== undefined) return "busy";
  if (args.status === "running" || args.status === "initializing") return "busy";
  return "unanswered";
}

/** Latest lastWakeAt across the register, or null when no wake was sent. */
export function scopeLastWakeAt(
  register: Record<string, { lastWakeAt?: unknown } | null | undefined> | null | undefined,
): string | null {
  if (!register || typeof register !== "object") return null;
  let best: string | null = null;
  let bestMs = NaN;
  for (const entry of Object.values(register)) {
    const at = entry?.lastWakeAt;
    if (typeof at !== "string" || !at) continue;
    const ms = Date.parse(at);
    if (!Number.isFinite(ms)) continue;
    if (best === null || ms > bestMs) {
      best = at;
      bestMs = ms;
    }
  }
  return best;
}

/**
 * True while a drain marker claims a live drain (now <= timeoutAt + 1 min).
 * Malformed or expired markers are ignored (no quiet), so a crashed drain
 * self-expires. Mirrors isDrainMarkerActive in core drain.mjs.
 */
export function isDrainMarkerActive(marker: unknown, nowMs: number): boolean {
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return false;
  const timeoutAt = (marker as Record<string, unknown>).timeoutAt;
  const timeoutMs = typeof timeoutAt === "string" ? Date.parse(timeoutAt) : NaN;
  if (!Number.isFinite(timeoutMs)) return false;
  if (!Number.isFinite(nowMs)) return false;
  return nowMs <= timeoutMs + DRAIN_GRACE_MS;
}

/** Latest of several ISO stamps, or null when none parses. */
export function maxStampMs(...values: readonly unknown[]): number | null {
  let best: number | null = null;
  for (const value of values) {
    if (typeof value !== "string" || !value) continue;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) continue;
    if (best === null || ms > best) best = ms;
  }
  return best;
}
