// Pure client logic for the steer pill and shared Factory actions.
import type { PluginRpcContract, RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginButtonBehavior, PluginComposer } from "@getpaseo/plugin/client";
import type {
  factoryFresh, factoryFreshPreview, factorySteerActivate, factorySteerBrief, factorySwitch, factorySwitchPreview, QuotaConfirmation,
} from "../shared/factory.js";
import type { SteerFaceState } from "../shared/steer-state.js";
import type { SteerPillRow } from "./steer-pill.js";

export function activationMenuBehavior(
  { agentId, workspaceId }: Pick<SteerPillRow, "agentId" | "workspaceId">,
  epoch: number,
  activate: (input: RpcInput<typeof factorySteerActivate>) => Promise<void>,
): PluginButtonBehavior {
  return { kind: "action", onPress: () => activate({ agentId, workspaceId, epoch }) };
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const STEER_MENU_LABELS = {
  activate: "Activate Steer",
  retryActivation: "Retry activation delivery",
  handover: "Handover",
  reset: "Reset Steer",
  openFactory: "Open Factory",
  close: "Close",
} as const;

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
  if (attempt.uncertain) throw new Error("The composer update could not be confirmed. Open Review brief in Factory and check the draft.");
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
  provider: string | null;
  model: string | null;
  state: SteerFaceState;
  eligible: boolean;
  /** English reason on unavailable rows, null when eligible. */
  reason: string | null;
  needsRecovery: boolean;
}

function unresolvedSteerStatus(row: SteerPillRow): boolean {
  return row.state === "unknown" && (row.detail !== "Not enough data" || !row.liveStatus);
}

function handoverReason(
  row: SteerPillRow,
  opts: { ambiguousSlot: boolean; forActivation?: boolean },
): { eligible: boolean; reason: string | null; needsRecovery: boolean } {
  if (row.active && !opts.forActivation) return { eligible: false, reason: "Already active", needsRecovery: false };
  if (row.advisor) {
    return { eligible: false, reason: "Advisor steers never coordinate", needsRecovery: false };
  }
  if (row.state === "retired") return { eligible: false, reason: "retired", needsRecovery: false };
  if (opts.ambiguousSlot || unresolvedSteerStatus(row)) {
    const detail = row.detail && row.detail !== "Not enough data" ? ` (${row.detail})` : "";
    return { eligible: false, reason: `Ambiguous membership${detail}`, needsRecovery: false };
  }
  const live = (row.liveStatus ?? "").trim().toLowerCase();
  if (row.state === "running" || live === "running" || live === "initializing") {
    return { eligible: false, reason: "Busy (turn running)", needsRecovery: false };
  }
  if (row.state === "waiting" && !(opts.forActivation && row.active)) {
    return { eligible: false, reason: `Busy (${row.detail})`, needsRecovery: false };
  }
  if (row.permissionNeeded) {
    return { eligible: false, reason: "Permission request pending", needsRecovery: false };
  }
  if (!opts.forActivation && steerQuotaConfirmation(row) === "depleted") {
    const reset = row.resetUnknown || !row.resetAt ? "reset unknown" : "waiting for reset";
    return { eligible: false, reason: `Quota depleted (${reset})`, needsRecovery: false };
  }
  return { eligible: true, reason: null, needsRecovery: row.state === "needs-resume" };
}

/**
 * Handover candidates: every holder of the scope in slot order with state,
 * provider/model and a reason on unavailable rows. The scope comes from the
 * current tab; without it there is no submenu.
 */
export function handoffTargets(
  rows: SteerPillRow[],
  selfAgentId: string,
  forActivation = false,
): HandoffTarget[] {
  const self = rows.find((row) => row.agentId === selfAgentId) ?? null;
  if (!self || !self.scopeId) return [];
  const holders = rows
    .filter((row) => row.workspaceId === self.workspaceId && row.scopeId === self.scopeId && row.slot)
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
    const verdict = handoverReason(row, { ambiguousSlot: (perSlot.get(slot) ?? 0) > 1, forActivation });
    return {
      slot,
      agentId: row.agentId,
      provider: row.provider,
      model: row.model,
      state: row.state,
      eligible: verdict.eligible,
      reason: verdict.reason,
      needsRecovery: verdict.needsRecovery,
    };
  });
}

// ---------------------------------------------------------------------------
// Reset eligibility and stale previews
// ---------------------------------------------------------------------------

export function steerQuotaConfirmation(row: SteerPillRow): QuotaConfirmation | null {
  if (row.quotaConfirmation !== undefined) return row.quotaConfirmation;
  return row.limited || row.state === "limited" ? "depleted" : null;
}

export function quotaConfirmationText(quota: QuotaConfirmation, row?: Pick<SteerPillRow, "resetAt" | "resetUnknown">): string {
  if (quota === "unknown") return "Quota is unknown. The provider may reject a new turn.";
  if (!row?.resetAt || row.resetUnknown) return "Quota is depleted. The reset time is unknown.";
  return `Quota is depleted. Reported reset: ${new Date(row.resetAt).toLocaleString()}.`;
}

export function resetSteerBlock(row: SteerPillRow): string | null {
  const live = (row.liveStatus ?? "").trim().toLowerCase();
  if (row.state === "running" || live === "running" || live === "initializing") {
    return "This steer is running. Wait for the turn to end.";
  }
  if (row.permissionNeeded) return "A permission request is waiting. Answer it first.";
  if (row.state === "waiting") return `Busy (${row.detail}). Try again after it finishes.`;
  if (row.state === "retired") return "This tab was replaced. Open the current holder instead.";
  if (unresolvedSteerStatus(row)) return `Steer status is unknown: ${row.detail}.`;
  if (!row.scopeId || !row.slot) return "Steer membership is unavailable";
  return null;
}

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

// ---------------------------------------------------------------------------
// Per-agent results
// ---------------------------------------------------------------------------

/** Result key per host and agent, so one steer's result never replaces another's. */
export function steerResultKey(hostId: string, agentId: string): string {
  return `${hostId}::${agentId}`;
}

// ---------------------------------------------------------------------------
// Native menu descriptor
// ---------------------------------------------------------------------------

export type SteerMenuEntryDescriptor =
  | { kind: "separator"; id: string }
  | {
    kind: "activate";
    id: "activate";
    title: string;
    icon: string;
    disabled: boolean;
    activationEpoch: number;
    quotaConfirmation: QuotaConfirmation | null;
    activationAlternatives: { agentId: string; slot: string }[];
  }
  | {
    kind: "handover";
    id: "handover";
    title: string;
    icon: string;
    disabled: boolean;
    targets: { id: string; title: string; disabled: boolean; slot: string; agentId: string }[];
  }
  | { kind: "reset" | "open-factory"; id: string; title: string; icon: string; disabled?: boolean };

export function describeSteerMenu(self: SteerPillRow, rows: SteerPillRow[]): SteerMenuEntryDescriptor[] {
  const items: SteerMenuEntryDescriptor[] = [];
  const targets = handoffTargets(rows, self.agentId);
  if (self.slot && self.scopeId && !self.advisor && self.state !== "retired" && self.activationEpoch != null) {
    const target = handoffTargets(rows, self.agentId, true).find((entry) => entry.agentId === self.agentId);
    const disabled = target?.eligible !== true;
    const quotaConfirmation = steerQuotaConfirmation(self);
    const label = self.active ? STEER_MENU_LABELS.retryActivation : STEER_MENU_LABELS.activate;
    items.push({
      kind: "activate", id: "activate", icon: "ArrowRight", disabled, activationEpoch: self.activationEpoch,
      title: disabled ? `${label} (${target?.reason ?? "unavailable"})` : label,
      quotaConfirmation,
      activationAlternatives: targets.filter((entry) => entry.eligible && entry.agentId !== self.agentId)
        .map(({ agentId, slot }) => ({ agentId, slot })),
    });
  }

  const destinations = self.active ? targets.filter(({ agentId }) => agentId !== self.agentId) : [];
  items.push({
    kind: "handover", id: "handover", title: STEER_MENU_LABELS.handover, icon: "ArrowRightLeft",
    disabled: destinations.length === 0,
    targets: destinations.map(({ slot, agentId, eligible, reason }) => ({
      id: `handover-${agentId}`, title: `Steer ${slot} · ${reason ?? "Standby"}`,
      disabled: !eligible, slot, agentId,
    })),
  });
  items.push({
    kind: "reset", id: "reset", title: STEER_MENU_LABELS.reset, icon: "ListRestart",
    disabled: resetSteerBlock(self) !== null,
  });
  items.push({ kind: "separator", id: "sep-open" });
  items.push({ kind: "open-factory", id: "open-factory", title: STEER_MENU_LABELS.openFactory, icon: "Factory" });
  return items;
}

type Call<Contract extends PluginRpcContract> =
  (input: RpcInput<Contract>) => Promise<RpcOutput<Contract>>;

export async function handoverSteer(
  source: Pick<SteerPillRow, "workspaceId" | "agentId">,
  target: { slot: string; agentId: string },
  initialize: InitializeNewSteer,
  preview: Call<typeof factorySwitchPreview>,
  apply: Call<typeof factorySwitch>,
): Promise<RpcOutput<typeof factorySwitch>> {
  const input = { workspaceId: source.workspaceId, callerId: source.agentId, to: target.slot };
  const plan = await preview(input);
  if (plan.workspaceId !== source.workspaceId || plan.fromId !== source.agentId || plan.toId !== target.agentId) {
    throw new Error("The controller or destination changed. Choose the handover again.");
  }
  return apply({ ...input, fingerprint: plan.fingerprint, deliver: initialize === "send" ? "send" : "stage" });
}

export async function resetSteer(
  { workspaceId, agentId, slot }: Pick<SteerPillRow, "workspaceId" | "agentId"> & { slot: string },
  clearChatHistory: boolean,
  saveHistory: (keepChatHistory: boolean) => Promise<InitializeNewSteer>,
  preview: Call<typeof factoryFreshPreview>,
  apply: Call<typeof factoryFresh>,
  resetQuota?: RpcInput<typeof factoryFresh>["resetQuota"],
): Promise<{ result: RpcOutput<typeof factoryFresh>; initialize: InitializeNewSteer }> {
  const keepChatHistory = !clearChatHistory;
  const input = { workspaceId, slot, keepChatHistory, ...(resetQuota ? { resetQuota } : {}) };
  const plan = await preview(input);
  if (plan.workspaceId !== workspaceId || plan.from !== agentId || plan.slot !== slot) {
    throw new Error("The steer changed. Open Reset Steer again for the current holder.");
  }
  const initialize = await saveHistory(keepChatHistory);
  const result = await apply({ ...input, fingerprint: plan.fingerprint,
    deliver: initialize === "send" && (!resetQuota || resetQuota === "available") ? "send" : "stage", notifyPrevious: false });
  return { result, initialize };
}

/** Stable key for a descriptor; the pill patches its behavior only on change. */
export function menuKeyFor(entries: SteerMenuEntryDescriptor[]): string {
  return JSON.stringify(entries);
}
