// Steer menu actions (docs/design/steer-menu.md, step 3): pure, testable
// client logic. The React menu lives in steer-menu-content.tsx (plain
// node:test cannot import .tsx); planning and apply stay server-side in the
// /factory RPCs, the menu only calls them. All UI text is English.
import { STEER_STATE_LABELS, type SteerFaceState } from "../shared/steer-state.js";
import type { SteerPillRow } from "./steer-pill.js";

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const STEER_MENU_LABELS = {
  create: "Create steer…",
  handover: "Hand over to…",
  openFactory: "Open Factory",
  back: "Back",
  cancel: "Cancel",
  close: "Close",
  confirmCreate: "Confirm creation",
  confirmHandover: "Confirm handover",
  confirmRefresh: "Confirm refresh",
  confirmResume: "Confirm resume",
  retryDelivery: "Retry delivery",
  initializeNow: "Initialize now",
  dismissBrief: "Dismiss brief",
  resumeAndHandover: "Resume and hand over…",
  openSavedChat: "Open saved chat in new tab",
} as const;

/** "Resume…" for a tab that needs recovery, else "Refresh context…". */
export function resumeActionLabel(state: SteerFaceState): string {
  return state === "needs-resume" ? "Resume…" : "Refresh context…";
}

// ---------------------------------------------------------------------------
// "Initialize new steer" setting
// ---------------------------------------------------------------------------

export type InitializeNewSteer = "send" | "composer" | "later";

export const INITIALIZE_NEW_STEER_DEFAULT: InitializeNewSteer = "composer";

export function normalizeInitializeNewSteer(value: unknown): InitializeNewSteer {
  return value === "send" || value === "composer" || value === "later"
    ? value
    : INITIALIZE_NEW_STEER_DEFAULT;
}

export type DeliveryMode = "send" | "composer" | "later";

/**
 * Delivery for a staged packet. "composer" needs a mounted client for the
 * destination tab; without one it falls back to sending the brief.
 */
export function resolveDelivery(
  setting: unknown,
  opts: { composerMounted: boolean },
): DeliveryMode {
  const want = normalizeInitializeNewSteer(setting);
  if (want === "composer" && !opts.composerMounted) return "send";
  return want;
}

/**
 * How the packet enters the destination composer: a fresh composer takes the
 * whole prompt, a composer with a draft gets the brief appended at the cursor.
 */
export function stageComposerText(
  currentPrompt: string,
  packet: string,
): { method: "setPrompt" | "insertText"; text: string } {
  if (currentPrompt.trim() === "") return { method: "setPrompt", text: packet };
  return { method: "insertText", text: `\n\n${packet}` };
}

// ---------------------------------------------------------------------------
// Handover targets
// ---------------------------------------------------------------------------

export interface HandoffTarget {
  slot: string;
  agentId: string;
  title: string | null;
  provider: string | null;
  model: string | null;
  state: SteerFaceState;
  stateLabel: string;
  eligible: boolean;
  /** English reason on unavailable rows, null when eligible. */
  reason: string | null;
  /** The destination needs recovery first ("Resume and hand over…"). */
  needsRecovery: boolean;
  permissionNeeded: boolean;
  limited: boolean;
  resetUnknown: boolean;
}

function handoverReason(
  row: SteerPillRow,
  opts: { ambiguousSlot: boolean },
): { eligible: boolean; reason: string | null; needsRecovery: boolean } {
  if (row.active) return { eligible: false, reason: "Already active", needsRecovery: false };
  if (row.advisor) {
    return { eligible: false, reason: "Advisor steers never coordinate", needsRecovery: false };
  }
  if (row.state === "retired") return { eligible: false, reason: "Retired", needsRecovery: false };
  if (opts.ambiguousSlot || row.state === "unknown") {
    const detail = row.detail && row.detail !== "Not enough data" ? ` (${row.detail})` : "";
    return { eligible: false, reason: `Ambiguous membership${detail}`, needsRecovery: false };
  }
  const live = (row.liveStatus ?? "").trim().toLowerCase();
  if (row.state === "running" || live === "running" || live === "initializing") {
    return { eligible: false, reason: "Busy (turn running)", needsRecovery: false };
  }
  if (row.state === "waiting") {
    return { eligible: false, reason: `Busy (${row.detail})`, needsRecovery: false };
  }
  if (row.permissionNeeded) {
    return { eligible: false, reason: "Permission request pending", needsRecovery: false };
  }
  if (row.state === "limited" || row.limited) {
    const reset = row.resetUnknown || !row.resetAt ? "reset unknown" : "waiting for reset";
    return { eligible: false, reason: `Quota depleted (${reset})`, needsRecovery: false };
  }
  if (row.state === "needs-resume") {
    return { eligible: true, reason: null, needsRecovery: true };
  }
  return { eligible: true, reason: null, needsRecovery: false };
}

/**
 * Handover submenu rows: every holder of the scope in slot order with state,
 * provider/model and a reason on unavailable rows. The scope comes from the
 * current tab; without it there is no submenu.
 */
export function handoffTargets(
  rows: SteerPillRow[],
  selfAgentId: string,
): HandoffTarget[] {
  const self = rows.find((row) => row.agentId === selfAgentId) ?? null;
  if (!self || !self.scopeId) return [];
  const holders = rows
    .filter((row) => row.scopeId === self.scopeId && row.slot)
    .sort(
      (a, b) =>
        (a.slot as string).localeCompare(b.slot as string) || a.agentId.localeCompare(b.agentId),
    );
  const perSlot = new Map<string, number>();
  for (const row of holders) perSlot.set(row.slot as string, (perSlot.get(row.slot as string) ?? 0) + 1);
  return holders.map((row) => {
    const slot = row.slot as string;
    const verdict = handoverReason(row, { ambiguousSlot: (perSlot.get(slot) ?? 0) > 1 });
    return {
      slot,
      agentId: row.agentId,
      title: row.title,
      provider: row.provider,
      model: row.model,
      state: row.state,
      stateLabel: STEER_STATE_LABELS[row.state] ?? "Unknown",
      eligible: verdict.eligible,
      reason: verdict.reason,
      needsRecovery: verdict.needsRecovery,
      permissionNeeded: row.permissionNeeded,
      limited: row.state === "limited" || row.limited,
      resetUnknown: row.resetUnknown,
    };
  });
}

// ---------------------------------------------------------------------------
// Resume / refresh route selection
// ---------------------------------------------------------------------------

export type ResumeRoute =
  /** Verified safe in-place route: /factory resume clears and briefs. */
  | { kind: "resume-apply" }
  /** Rewind or replacement: /factory fresh planning, then confirm and apply. */
  | { kind: "fresh"; note: string | null }
  /** Quota depleted: show reset details instead of refreshing. */
  | { kind: "reset-details" }
  /** Refresh is unsafe right now; the reason says why. */
  | { kind: "blocked"; reason: string };

function isCodexProvider(provider: string | null): boolean {
  return typeof provider === "string" && /codex/i.test(provider);
}

/**
 * Safe route for "Resume… / Refresh context…" from the face state. A verified
 * safe in-place route (a provider with native clear, history not kept)
 * reuses /factory resume; everything else goes through /factory fresh
 * planning for a rewind or a replacement. Codex has no native clear, so a
 * Codex refresh always rewinds.
 */
export function resumeRouteFor(
  row: SteerPillRow,
  opts: { keepChatHistory: boolean; clearProviders?: string[] },
): ResumeRoute {
  const live = (row.liveStatus ?? "").trim().toLowerCase();
  if (row.state === "running" || live === "running" || live === "initializing") {
    return { kind: "blocked", reason: "This steer is running. Wait for the turn to end, then refresh." };
  }
  if (row.permissionNeeded) {
    return { kind: "blocked", reason: "A permission request is waiting. Answer it first, then refresh." };
  }
  if (row.state === "waiting") {
    return { kind: "blocked", reason: `Busy (${row.detail}). Try again after it finishes.` };
  }
  if (row.state === "retired") {
    return { kind: "blocked", reason: "This tab was replaced. Open the current holder instead." };
  }
  if (row.state === "unknown") {
    return { kind: "blocked", reason: `Steer status is unknown: ${row.detail}.` };
  }
  if (row.state === "limited" || row.limited) {
    return { kind: "reset-details" };
  }
  const providers = Array.isArray(opts.clearProviders) && opts.clearProviders.length
    ? opts.clearProviders
    : ["claude"];
  const clearable = typeof row.provider === "string" && providers.includes(row.provider);
  if (clearable && !opts.keepChatHistory) return { kind: "resume-apply" };
  if (isCodexProvider(row.provider)) {
    return { kind: "fresh", note: "Codex has no native clear, so refresh rewinds the chat." };
  }
  if (clearable && opts.keepChatHistory) {
    return { kind: "fresh", note: "Keep chat history is on, so refresh rewinds instead of clearing." };
  }
  return {
    kind: "fresh",
    note: "This provider has no verified in-place clear, so refresh rewinds or replaces the tab.",
  };
}

// ---------------------------------------------------------------------------
// Expired previews and partial applies
// ---------------------------------------------------------------------------

/**
 * Error prefixes that mean "the preview no longer matches the live state":
 * every preview-mismatch error starts with "Something changed since the …",
 * the scope-lock rechecks report the epoch move. A match must request a new
 * preview instead of retrying the apply.
 */
const EXPIRED_PREVIEW_PREFIXES = [
  "Something changed since the ",
  "Steer state changed (expected ",
  "the scope moved on (epoch changed)",
];

export function isExpiredPreviewError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return EXPIRED_PREVIEW_PREFIXES.some((prefix) => message.includes(prefix));
}

export interface DeliveryOutcome {
  applied: boolean;
  delivered: boolean;
  staged?: boolean;
}

/**
 * True when the apply landed but the brief did not go out and a staged retry
 * is available (partial apply: state stands, delivery can be retried through
 * the staged brief).
 */
export function needsDeliveryRetry(outcome: DeliveryOutcome): boolean {
  return outcome.applied === true && outcome.delivered !== true && outcome.staged === true;
}

// ---------------------------------------------------------------------------
// Per-agent results
// ---------------------------------------------------------------------------

/** Result key per host and agent, so one steer's result never replaces another's. */
export function steerResultKey(hostId: string, agentId: string): string {
  return `${hostId}::${agentId}`;
}
