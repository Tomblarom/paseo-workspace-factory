// Steer menu actions (docs/design/steer-menu.md, steps 3-4): pure, testable
// client logic. The pill uses the native menu behavior with one action per
// item; previews and confirmations open as popovers (steer-menu-content.tsx,
// which plain node:test cannot import). Planning and apply stay server-side
// in the /factory RPCs, the menu only calls them. All UI text is English.
// State words are lowercase, the way Paseo writes them.
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginComposer } from "@getpaseo/plugin/client";
import type { factorySteerBrief } from "../shared/factory.js";
import { STEER_STATE_LABELS, type SteerFaceState } from "../shared/steer-state.js";
import type { SteerPillRow } from "./steer-pill.js";

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const STEER_MENU_LABELS = {
  create: "Create steer…",
  activate: "Activate Steer",
  retryActivation: "Retry activation delivery",
  handover: "Hand over to…",
  changeSettings: "Change settings…",
  revertSettings: "Revert settings",
  freshContext: "Continue with fresh context…",
  stagedBrief: "Initialize staged brief…",
  openFactory: "Open Factory",
  back: "Back",
  cancel: "Cancel",
  close: "Close",
  confirmCreate: "Confirm creation",
  confirmHandover: "Confirm handover",
  confirmRefresh: "Confirm refresh",
  confirmResume: "Confirm resume",
  confirmSettings: "Apply settings",
  confirmRevert: "Revert settings",
  retryDelivery: "Retry delivery",
  initializeNow: "Initialize now",
  dismissBrief: "Dismiss brief",
  resumeAndHandover: "Resume and hand over…",
  openSavedChat: "Open saved chat in new tab",
} as const;

/** Lowercase state word for pill labels, titles and menu items. */
export function stateWord(state: SteerFaceState): string {
  return (STEER_STATE_LABELS[state] ?? "Unknown").toLowerCase();
}

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

type BriefInput = RpcInput<typeof factorySteerBrief>;
export type BriefRpc = (input: BriefInput) => Promise<RpcOutput<typeof factorySteerBrief>>;
export type BriefTarget = Omit<Extract<BriefInput, { action: "send" | "dismiss" }>, "action">;
export interface ComposerTransferAttempt { claimId: string; placed: boolean; uncertain?: boolean }

export async function transferStagedBrief(
  callBrief: BriefRpc,
  target: BriefTarget,
  composer: () => Pick<PluginComposer, "prompt" | "setPrompt" | "insertText"> | undefined,
  attempt: ComposerTransferAttempt,
  automatic = false,
): Promise<void> {
  const input = { ...target, claimId: attempt.claimId };
  if (attempt.uncertain) throw new Error("The composer update could not be confirmed. Reopen the staged brief menu and check the draft.");
  if (!attempt.placed) {
    const unavailable = "The destination composer is unavailable. The brief is still staged.";
    if (!composer()) throw new Error(unavailable);
    const brief = await callBrief({ ...input, action: "composer", automatic });
    if (!brief.packet) throw new Error(brief.detail);
    const dest = composer();
    if (!dest) {
      await callBrief({ ...input, action: "composer-release" });
      throw new Error(unavailable);
    }
    if (!dest.prompt.includes(brief.packet)) {
      const { method, text } = stageComposerText(dest.prompt, brief.packet);
      attempt.uncertain = true;
      dest[method](text);
      attempt.uncertain = false;
    }
    attempt.placed = true;
  }
  const result = await callBrief({ ...input, action: "composer-complete" });
  if (!result.transferred) throw new Error(result.detail);
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
  if (row.state === "retired") return { eligible: false, reason: "retired", needsRecovery: false };
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
  for (const row of holders) {
    if (row.state !== "retired") perSlot.set(row.slot as string, (perSlot.get(row.slot as string) ?? 0) + 1);
  }
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
      stateLabel: stateWord(row.state),
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

// ---------------------------------------------------------------------------
// Native menu descriptor (step 4 + pill scope change)
// ---------------------------------------------------------------------------

export type SteerMenuAction =
  | "create"
  | "activate"
  | "handover-target"
  | "refresh"
  | "settings"
  | "revert"
  | "fresh-context"
  | "staged-brief"
  | "open-factory"
  | "noop";

export type SteerMenuEntryDescriptor =
  | { kind: "separator"; id: string }
  | {
    kind: "item";
    id: string;
    title: string;
    icon: string;
    disabled?: boolean;
    action: SteerMenuAction;
    targetSlot?: string;
    targetAgentId?: string;
    activationEpoch?: number;
    activationAlternatives?: { agentId: string; slot: string }[];
    submenu?: SteerMenuEntryDescriptor[];
  };

export interface SteerMenuDescriptorOpts {
  keepChatHistory: boolean;
  /** True while the observed-change warning is active for this tab. */
  observedChanged: boolean;
  /** Revert availability for the retained observed tuple. */
  revertAllowed: boolean;
  /** Full revert reason from canRevertObserved (shortened for the title). */
  revertReason?: string | null;
}

function shortRevertReason(reason: string | null | undefined): string {
  if (!reason) return "unavailable";
  if (/turn is running/i.test(reason)) return "turn running";
  if (/changed again/i.test(reason)) return "changed again";
  return "unavailable";
}

function shortRefreshBlock(reason: string): string {
  if (/running/i.test(reason)) return "turn running";
  if (/permission/i.test(reason)) return "permission pending";
  if (/replaced/i.test(reason)) return "replaced";
  if (/unknown/i.test(reason)) return "status unknown";
  if (/Busy/i.test(reason)) return "busy";
  return "unavailable";
}

function shortLockReason(reason: string | null): string {
  if (!reason) return "locked";
  if (/turn is running/i.test(reason)) return "turn running";
  if (/Maximum efficiency/i.test(reason)) return "maximum efficiency";
  return "locked";
}

function handoverItemTitle(target: HandoffTarget): string {
  const head = `Steer ${target.slot} · ${target.stateLabel}`;
  if (target.eligible) return head;
  return `${head} — ${target.reason ?? "unavailable"}`;
}

/**
 * Native menu items for one steer tab: nothing but a list of actions.
 * Warning items (Revert, Continue with fresh context) come first while the
 * observed-change warning is active, then Create, Hand over to (submenu
 * with disabled holders carrying the short reason), Refresh/Resume, Change
 * settings (disabled with a short reason under Maximum efficiency), an
 * optional staged-brief item, a separator, and Open Factory.
 */
export function describeSteerMenu(
  self: SteerPillRow,
  rows: SteerPillRow[],
  opts: SteerMenuDescriptorOpts,
): SteerMenuEntryDescriptor[] {
  const items: SteerMenuEntryDescriptor[] = [];
  if (opts.observedChanged) {
    items.push({
      kind: "item",
      id: "revert-settings",
      title: opts.revertAllowed
        ? STEER_MENU_LABELS.revertSettings
        : `${STEER_MENU_LABELS.revertSettings} (${shortRevertReason(opts.revertReason)})`,
      icon: "Undo2",
      disabled: !opts.revertAllowed,
      action: "revert",
    });
    items.push({
      kind: "item",
      id: "fresh-context",
      title: STEER_MENU_LABELS.freshContext,
      icon: "RefreshCw",
      action: "fresh-context",
    });
    items.push({ kind: "separator", id: "sep-warning" });
  }
  items.push({ kind: "item", id: "create", title: STEER_MENU_LABELS.create, icon: "Plus", action: "create" });

  const targets = handoffTargets(rows, self.agentId);
  if (self.slot && self.scopeId && !self.advisor && self.state !== "retired" && self.activationEpoch != null) {
    const target = targets.find((entry) => entry.agentId === self.agentId);
    const disabled = !self.active && target?.eligible !== true;
    const label = self.active ? STEER_MENU_LABELS.retryActivation : STEER_MENU_LABELS.activate;
    const alternatives = targets.filter((entry) => entry.eligible && entry.agentId !== self.agentId)
      .map(({ agentId, slot }) => ({ agentId, slot }));
    items.push({ kind: "item", id: "activate", title: disabled ? `${label} (${target?.reason ?? "unavailable"})` : label,
      icon: "ArrowRight", action: "activate", disabled, activationEpoch: self.activationEpoch,
      ...(alternatives.length ? { activationAlternatives: alternatives } : {}) });
  }

  if (targets.length === 0) {
    items.push({
      kind: "item",
      id: "handover",
      title: `${STEER_MENU_LABELS.handover} (no other holders)`,
      icon: "ArrowRightLeft",
      disabled: true,
      action: "noop",
    });
  } else {
    items.push({
      kind: "item",
      id: "handover",
      title: STEER_MENU_LABELS.handover,
      icon: "ArrowRightLeft",
      action: "noop",
      submenu: targets.map((target) => ({
        kind: "item" as const,
        id: `handover-${target.agentId}`,
        title: handoverItemTitle(target),
        icon: "ArrowRight",
        disabled: !target.eligible,
        action: "handover-target" as const,
        targetSlot: target.slot,
        targetAgentId: target.agentId,
      })),
    });
  }

  const refreshLabel = resumeActionLabel(self.state);
  const route = resumeRouteFor(self, { keepChatHistory: opts.keepChatHistory });
  if (route.kind === "blocked") {
    items.push({
      kind: "item",
      id: "refresh",
      title: `${refreshLabel} (${shortRefreshBlock(route.reason)})`,
      icon: "RefreshCw",
      disabled: true,
      action: "noop",
    });
  } else if (route.kind === "reset-details") {
    items.push({
      kind: "item",
      id: "refresh",
      title: `${refreshLabel} (quota depleted)`,
      icon: "RefreshCw",
      disabled: true,
      action: "noop",
    });
  } else {
    items.push({ kind: "item", id: "refresh", title: refreshLabel, icon: "RefreshCw", action: "refresh" });
  }

  if (self.settingsLocked) {
    items.push({
      kind: "item",
      id: "settings",
      title: `${STEER_MENU_LABELS.changeSettings} (${shortLockReason(self.settingsLockReason)})`,
      icon: "Settings2",
      disabled: true,
      action: "noop",
    });
  } else {
    items.push({ kind: "item", id: "settings", title: STEER_MENU_LABELS.changeSettings, icon: "Settings2", action: "settings" });
  }

  if (self.stagedBrief) {
    items.push({ kind: "item", id: "staged", title: STEER_MENU_LABELS.stagedBrief, icon: "Send", action: "staged-brief" });
  }
  items.push({ kind: "separator", id: "sep-open" });
  items.push({ kind: "item", id: "open-factory", title: STEER_MENU_LABELS.openFactory, icon: "Factory", action: "open-factory" });
  return items;
}

/** Stable key for a descriptor; the pill patches its behavior only on change. */
export function menuKeyFor(entries: SteerMenuEntryDescriptor[]): string {
  return JSON.stringify(entries);
}
