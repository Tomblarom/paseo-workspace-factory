// Persistent steer composer pill (docs/design/steer-menu.md, step 2): pure,
// testable client logic. The React popover lives in steer-pill-content.tsx
// (plain node:test cannot import .tsx), the registration call sites live in
// index.client.tsx. All UI text is English.
import type {
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginClientContext,
  PluginHostProps,
} from "@getpaseo/plugin/client";
import type { ComponentType } from "react";
import {
  STEER_STATE_LABELS,
  formatCountdown,
  type SteerFaceState,
  type SteerPrimaryAction,
} from "../shared/steer-state.js";

/** Pill id prefixes; each family owns its prefix so pills coexist. */
export const STEER_PILL_ID_PREFIX = "factory-steer-";
export const ATTENTION_PILL_ID_PREFIX = "factory-attention-";
export const RESULT_PILL_ID_PREFIX = "factory-result-";

export function steerPillId(agentId: string): string {
  return `${STEER_PILL_ID_PREFIX}${agentId}`;
}

export function attentionPillId(agentId: string): string {
  return `${ATTENTION_PILL_ID_PREFIX}${agentId}`;
}

export function resultPillId(agentId: string): string {
  return `${RESULT_PILL_ID_PREFIX}${agentId}`;
}

// ---------------------------------------------------------------------------
// Feed rows
// ---------------------------------------------------------------------------

export interface SteerQuotaRowView {
  id: string;
  scope: "account" | "model" | "pool";
  usedPct: number | null;
  resetsAt: string | null;
  stale: boolean;
}

export interface SteerPillRow {
  agentId: string;
  workspaceId: string;
  scopeId: string | null;
  slot: string | null;
  title: string | null;
  provider: string | null;
  model: string | null;
  liveStatus: string | null;
  advisor: boolean;
  active: boolean;
  permissionNeeded: boolean;
  stagedBrief: boolean;
  successor: string | null;
  state: SteerFaceState;
  warmth: string;
  tokens: number | null;
  large: boolean;
  limited: boolean;
  resetAt: string | null;
  resetUnknown: boolean;
  awaitingUpdate: boolean;
  quotaRows: SteerQuotaRowView[];
  headerFacts: string[];
  primaryAction: SteerPrimaryAction;
  detail: string;
  nextBoundaryAt: string | null;
}

function isSteerState(value: unknown): value is SteerFaceState {
  return typeof value === "string" && value in STEER_STATE_LABELS;
}

function isPrimaryAction(value: unknown): value is SteerPrimaryAction {
  return (
    value === "open-holder" ||
    value === "view-turn" ||
    value === "handoff-or-reset" ||
    value === "view-operation" ||
    value === "preview-recovery" ||
    value === "focus-or-deliver" ||
    value === "preview-refresh" ||
    value === "focus-reuse" ||
    value === "continue" ||
    value === "focus" ||
    value === "reload-or-open"
  );
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function quotaRowsOf(value: unknown): SteerQuotaRowView[] {
  if (!Array.isArray(value)) return [];
  const rows: SteerQuotaRowView[] = [];
  for (const entry of value) {
    const row = entry as Record<string, unknown> | null;
    if (!row || typeof row.id !== "string" || row.id === "") continue;
    rows.push({
      id: row.id,
      scope: row.scope === "model" || row.scope === "pool" ? row.scope : "account",
      usedPct: finiteOrNull(row.usedPct),
      resetsAt: textOrNull(row.resetsAt),
      stale: row.stale === true,
    });
  }
  return rows;
}

/** Reads the factory.steers feed, skipping entries without an agent target. */
export function steerRowsOf(event: unknown): SteerPillRow[] {
  const record = event as { steers?: unknown } | null;
  if (!record || !Array.isArray(record.steers)) return [];
  const rows: SteerPillRow[] = [];
  for (const entry of record.steers) {
    const row = entry as Record<string, unknown> | null;
    if (typeof row?.agentId !== "string" || row.agentId === "") continue;
    if (typeof row?.workspaceId !== "string" || row.workspaceId === "") continue;
    rows.push({
      agentId: row.agentId,
      workspaceId: row.workspaceId,
      scopeId: textOrNull(row.scopeId),
      slot: textOrNull(row.slot),
      title: textOrNull(row.title),
      provider: textOrNull(row.provider),
      model: textOrNull(row.model),
      liveStatus: textOrNull(row.liveStatus),
      advisor: row.advisor === true,
      active: row.active === true,
      permissionNeeded: row.permissionNeeded === true,
      stagedBrief: row.stagedBrief === true,
      successor: textOrNull(row.successor),
      state: isSteerState(row.state) ? row.state : "unknown",
      warmth: typeof row.warmth === "string" && row.warmth !== "" ? row.warmth : "unknown",
      tokens: finiteOrNull(row.tokens),
      large: row.large === true,
      limited: row.limited === true,
      resetAt: textOrNull(row.resetAt),
      resetUnknown: row.resetUnknown === true,
      awaitingUpdate: row.awaitingUpdate === true,
      quotaRows: quotaRowsOf(row.quotaRows),
      headerFacts: Array.isArray(row.headerFacts)
        ? row.headerFacts.filter((fact): fact is string => typeof fact === "string" && fact !== "")
        : [],
      primaryAction: isPrimaryAction(row.primaryAction) ? row.primaryAction : "reload-or-open",
      detail: typeof row.detail === "string" && row.detail !== "" ? row.detail : "Not enough data",
      nextBoundaryAt: textOrNull(row.nextBoundaryAt),
    });
  }
  return rows;
}

/** Agent ids covered by the steer feed (to skip their attention pills). */
export function steerAgentIds(rows: SteerPillRow[]): Set<string> {
  return new Set(rows.map((row) => row.agentId));
}

// ---------------------------------------------------------------------------
// Collapsed face
// ---------------------------------------------------------------------------

export const STEER_PILL_ICONS: Record<SteerFaceState, string> = {
  retired: "Archive",
  running: "Activity",
  limited: "Gauge",
  waiting: "Clock",
  "needs-resume": "RotateCcw",
  ready: "CircleCheck",
  cold: "Snowflake",
  large: "Layers",
  cooling: "Timer",
  warm: "Flame",
  unknown: "CircleHelp",
};

export interface SteerPillFace {
  /** Visible collapsed text, e.g. "A · Warm". */
  label: string;
  /** Tooltip and accessible title: slot, role, state, context size, quota. */
  title: string;
  icon: string;
  accessibilityLabel: string;
}

/** Role word for the face title and header. */
export function steerRole(row: Pick<SteerPillRow, "active" | "advisor" | "state">): string {
  if (row.advisor) return "Advisor";
  if (row.active) return "Active";
  if (row.state === "retired") return "Retired";
  return "Standby";
}

function maxUsedPct(row: SteerPillRow): number | null {
  let max: number | null = null;
  for (const quota of row.quotaRows) {
    if (quota.stale || quota.usedPct === null) continue;
    if (max === null || quota.usedPct > max) max = quota.usedPct;
  }
  return max;
}

/** Short quota suffix for the collapsed title ("" when nothing is known). */
export function quotaFaceSummary(row: SteerPillRow): string {
  if (row.limited) return " · Limited";
  if (row.awaitingUpdate) return " · Awaiting quota update";
  const max = maxUsedPct(row);
  return max === null ? "" : ` · ${Math.round(max)}% used`;
}

export function faceFor(row: SteerPillRow): SteerPillFace {
  const slot = row.slot ?? "?";
  const stateLabel = STEER_STATE_LABELS[row.state] ?? "Unknown";
  const context = row.tokens === null ? "" : ` · ${row.tokens.toLocaleString("en-US")} tokens`;
  const title = `Steer ${slot} · ${steerRole(row)} · ${stateLabel}${context}${quotaFaceSummary(row)}`;
  return {
    label: `${slot} · ${stateLabel}`,
    title,
    icon: STEER_PILL_ICONS[row.state] ?? "CircleHelp",
    accessibilityLabel: title,
  };
}

/** Face shown while the host is disconnected (membership is kept). */
export function disconnectedFace(row: SteerPillRow): SteerPillFace {
  const slot = row.slot ?? "?";
  const title = `Steer ${slot} · ${steerRole(row)} · Unknown · Host disconnected`;
  return { label: `${slot} · Unknown`, title, icon: "CircleHelp", accessibilityLabel: title };
}

export function sameFace(a: SteerPillFace, b: SteerPillFace): boolean {
  return a.label === b.label && a.title === b.title && a.icon === b.icon;
}

export type SteerPillTheme = PluginHostProps["theme"];

/** Semantic face color from the host theme (text and icon carry the state). */
export function steerStateColor(
  theme: SteerPillTheme,
  state: SteerFaceState,
  large: boolean,
): string {
  const colors = theme.colors;
  switch (state) {
    case "running":
      return colors.accent;
    case "limited":
      return colors.statusDanger;
    case "needs-resume":
    case "large":
    case "cooling":
      return colors.statusWarning;
    case "ready":
    case "warm":
      return colors.statusSuccess;
    case "cold":
      return large ? colors.statusWarning : colors.foregroundMuted;
    default:
      return colors.foregroundMuted;
  }
}

// ---------------------------------------------------------------------------
// Registration sync
// ---------------------------------------------------------------------------

export interface SteerPillEntry {
  registration: PluginButtonRegistration;
  face: SteerPillFace;
  row: SteerPillRow;
}

export type SteerPillMap = Map<string, SteerPillEntry>;

/**
 * Syncs one persistent pill per steer row. Faces patch in place and only
 * when they change (no re-register churn); the behavior/Content reference is
 * never replaced, so an open popover stays mounted across quota ticks.
 * Unknown agents (no composer, e.g. history-only tabs) are skipped until the
 * next event; rows missing from a connected event are authoritatively removed.
 */
export function syncSteerPills(
  client: Pick<PluginClientContext, "addComposerPill">,
  pills: SteerPillMap,
  rows: SteerPillRow[],
  Content: ComponentType<PluginButtonContentProps>,
): void {
  const seen = new Set<string>();
  for (const row of rows) {
    seen.add(row.agentId);
    const face = faceFor(row);
    const known = pills.get(row.agentId);
    if (known) {
      known.row = row;
      if (sameFace(known.face, face)) continue;
      try {
        known.registration.update({ title: face.title, label: face.label, icon: face.icon });
        known.face = face;
      } catch {
        // The composer went away; the next event re-adds the pill.
        pills.delete(row.agentId);
      }
      continue;
    }
    try {
      pills.set(row.agentId, {
        registration: client.addComposerPill({
          id: steerPillId(row.agentId),
          workspaceId: row.workspaceId,
          agentId: row.agentId,
          button: {
            title: face.title,
            label: face.label,
            icon: face.icon,
            behavior: { kind: "popover", Content },
          },
        }),
        face,
        row,
      });
    } catch {
      // No composer for this agent (history-only tab) — retry on next event.
    }
  }
  for (const [id, pill] of pills) {
    if (seen.has(id)) continue;
    try {
      pill.registration.remove();
    } catch {
      // Already gone.
    }
    pills.delete(id);
  }
}

/**
 * Marks every pill Unknown after the subscription closed. Registrations are
 * kept (last verified membership); the next connected event restores faces.
 * A failing update is kept too — sync cleans up composers that are truly gone.
 */
export function markSteerPillsDisconnected(pills: SteerPillMap): void {
  for (const entry of pills.values()) {
    const face = disconnectedFace(entry.row);
    if (sameFace(entry.face, face)) continue;
    try {
      entry.registration.update({ title: face.title, label: face.label, icon: face.icon });
      entry.face = face;
    } catch {
      // Transient; the next sync retries or re-adds the pill.
    }
  }
}

/** Removes every steer pill (plugin teardown). Foreign pills are untouched. */
export function teardownSteerPills(pills: SteerPillMap): void {
  for (const pill of pills.values()) {
    try {
      pill.registration.remove();
    } catch {
      // Already gone.
    }
  }
  pills.clear();
}

// ---------------------------------------------------------------------------
// Expanded content helpers
// ---------------------------------------------------------------------------

/** Expanded header, e.g. "Steer A · Active". */
export function steerHeaderTitle(row: SteerPillRow): string {
  const parts = [`Steer ${row.slot ?? "?"}`];
  if (row.active) parts.push("Active");
  if (row.advisor) parts.push("Advisor");
  if (!row.active && !row.advisor) parts.push(row.state === "retired" ? "Retired" : "Standby");
  return parts.join(" · ");
}

/** Read-only next-step hint (step 3 wires these to previews and actions). */
export const STEER_PRIMARY_ACTION_LABELS: Record<SteerPrimaryAction, string> = {
  "open-holder": "Open the current holder",
  "view-turn": "View the turn",
  "handoff-or-reset": "Hand over or show reset details",
  "view-operation": "View the operation",
  "preview-recovery": "Preview recovery",
  "focus-or-deliver": "Focus the composer",
  "preview-refresh": "Preview refresh",
  "focus-reuse": "Focus the composer",
  continue: "Continue now",
  focus: "Focus the composer",
  "reload-or-open": "Reload status or open Factory",
};

/** Context line, e.g. "Context 5,000 tokens" or "Context unknown". */
export function formatContextTokens(tokens: number | null): string {
  return tokens === null ? "Context unknown" : `Context ${tokens.toLocaleString("en-US")} tokens`;
}

/** Local countdown label for one reset ("resets in 1h 12m", "resetting now"). */
export function quotaCountdownLabel(resetsAt: string | null, nowMs: number): string | null {
  if (!resetsAt) return null;
  const ms = Date.parse(resetsAt);
  if (!Number.isFinite(ms)) return null;
  if (ms <= nowMs) return "resetting now";
  return `resets in ${formatCountdown(ms - nowMs)}`;
}

function formatUsedPct(usedPct: number): string {
  return Number.isInteger(usedPct) ? String(usedPct) : usedPct.toFixed(1);
}

/**
 * One quota row, e.g. "5h 54% used · resets in 1h 12m". Model windows carry a
 * "(model)" label, pool fallback rows "(pool)".
 */
export function formatQuotaRow(row: SteerQuotaRowView, nowMs: number): string {
  const scope = row.scope === "model" ? " (model)" : row.scope === "pool" ? " (pool)" : "";
  const head = `${row.id}${scope}`;
  const used =
    row.usedPct !== null
      ? `${head} ${formatUsedPct(row.usedPct)}% used`
      : row.stale
        ? `${head} · stale`
        : `${head} · no data`;
  const countdown = quotaCountdownLabel(row.resetsAt, nowMs);
  return countdown ? `${used} · ${countdown}` : used;
}

/**
 * Speed word from live composer options (Claude fast_mode, Codex
 * service_tier); null when the route reports none.
 */
export function speedOfOptions(options: unknown): string | null {
  if (!options || typeof options !== "object" || Array.isArray(options)) return null;
  const record = options as Record<string, unknown>;
  if (typeof record.fast_mode === "boolean") return record.fast_mode ? "Fast" : "Standard";
  if (typeof record.service_tier === "string" && record.service_tier.trim() !== "") {
    return `Tier ${record.service_tier.trim()}`;
  }
  return null;
}

/** Provider/model/thinking/speed line; null when nothing is known. */
export function describeRoute(parts: {
  provider?: string | null;
  model?: string | null;
  thinking?: string | null;
  speed?: string | null;
}): string | null {
  const items: string[] = [];
  if (parts.provider) items.push(parts.provider);
  if (parts.model) items.push(parts.model);
  if (parts.thinking) items.push(`thinking ${parts.thinking}`);
  if (parts.speed) items.push(parts.speed);
  return items.length ? items.join(" · ") : null;
}

/**
 * Delay until the next local tick: the next state boundary when it falls
 * inside the minute, else one minute for the countdown text.
 */
export function nextTickDelayMs(nextBoundaryAt: string | null, nowMs: number): number {
  const boundary = nextBoundaryAt ? Date.parse(nextBoundaryAt) : Number.NaN;
  if (Number.isFinite(boundary) && boundary > nowMs) {
    return Math.max(1_000, Math.min(60_000, boundary - nowMs));
  }
  return 60_000;
}

export interface SteerPopoverState {
  /** Open confirmation/preview (opaque); ticks must never replace it. */
  confirmation: unknown;
  nowMs: number;
}

/** Local countdown tick: advances the clock, keeps the confirmation as is. */
export function tickPopoverState(state: SteerPopoverState, nowMs: number): SteerPopoverState {
  return { confirmation: state.confirmation, nowMs };
}
