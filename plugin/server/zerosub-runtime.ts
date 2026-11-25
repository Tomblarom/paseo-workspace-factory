// Plugin-runtime ZeroSub reader (S-B/turn-hook side): fail-soft access to the
// normalized ZeroSub state plus the `zerosub-switch` timeline row. Unavailable
// ZeroSub (no daemon, no ZeroSub plugin, RPC error, unreadable timeline) always
// degrades to null, and every caller keeps its legacy behavior without it.
//
// Row parsing reuses the shared core (./core/zerosub.mjs):
// `pendingAccountId` only covers in-place moves (never Codex
// hand-offs), so the row is the authoritative no-double-reaction signal. A set
// `continuedIn` wins over everything (the conversation carries on there, even
// with outcome `stayed`); `continued: true` only means a follow-up was sent so
// the turn continues on its own (also on normal switches) — in both cases the
// factory sends no follow-up of its own. Reason `exhausted` with outcome
// `stayed` and no `continuedIn` means no account is free (the factory may
// proceed, waking at `resetsAt`). Only erasable TypeScript: node --test
// imports this file with type stripping (see plugin/test/ts-resolve-hooks.mjs).
import * as zerosubCore from "./core/zerosub.mjs";

// The synced core is unchecked (@ts-nocheck): talk to it as any.
const Z = zerosubCore as unknown as {
  readZerosubState: (args?: Record<string, unknown>) => Promise<ZerosubState | null>;
  SWITCH_ROW_KIND: string;
  parseSwitchData: (data: unknown) => ZerosubSwitchRow | null;
  latestSwitchRow: (timelinePayload: unknown) => ZerosubSwitchRow | null;
};

export const SWITCH_ROW_KIND: string = Z.SWITCH_ROW_KIND;

/** Normalized ZeroSub state ({ accounts, agentAccount, pending }) or null. */
export type ZerosubState = {
  accounts: any[];
  agentAccount: Record<string, string>;
  pending: Record<string, string>;
} | null;

/** Normalized `zerosub-switch` row, exactly the shared `parseSwitchData` shape. */
export interface ZerosubSwitchRow {
  family: string | null;
  from: string | null;
  to: string | null;
  toFamily: string | null;
  at: string | null;
  reason: string | null;
  outcome: string | null;
  resetsAt: string | null;
  continued: boolean;
  /** Agent id the conversation carries on in, or null (also set on `stayed`). */
  continuedIn: string | null;
}

export interface ZerosubSource {
  /** Already-resolved normalized state; null disables ZeroSub for the call. */
  zerosub?: ZerosubState;
  /** Fail-soft supplier used when `zerosub` is undefined. */
  getZerosub?: () => Promise<ZerosubState>;
}

/**
 * Pure normalizer for a `zerosub-switch` row's `data` object, shared with the
 * CLI core: missing fields become null, `detail` is never parsed, unknown
 * reason/family values are tolerated. A non-object returns null.
 */
export function parseZerosubSwitchData(data: unknown): ZerosubSwitchRow | null {
  return Z.parseSwitchData(data);
}

/**
 * Pure scan for the latest `zerosub-switch` row in timeline entries (each
 * `{ item }`, as `timeline.refetch` returns). Null when no entry carries one.
 */
export function findZerosubSwitch(entries: unknown): ZerosubSwitchRow | null {
  return Z.latestSwitchRow({ entries });
}

export interface SwitchFollowup {
  decision: "suppress" | "proceed";
  reason: "zerosub-continued" | "no-account-free" | "no-switch-signal" | "switch-no-action";
  continuedIn: string | null;
  /** resetsAt of an exhausted+stayed row, else null. */
  wakeAt: string | null;
}

/**
 * Pure follow-up decision for a switch row. A set `continuedIn` suppresses any
 * factory follow-up of its own (the conversation carries on there — follow
 * the continuation, never duplicate it), taking precedence even over
 * `exhausted`+`stayed`. `continued: true` without it also suppresses: a
 * follow-up was sent, so the turn continues on its own. `exhausted`+`stayed`
 * without `continuedIn` proceeds (no account is free, so ZeroSub will not
 * act) with the row's resetsAt as the wake time; anything else proceeds
 * exactly like the legacy behavior.
 */
export function zerosubSwitchFollowup(row: ZerosubSwitchRow | null): SwitchFollowup {
  if (!row) return { decision: "proceed", reason: "no-switch-signal", continuedIn: null, wakeAt: null };
  if (row.continuedIn) {
    return { decision: "suppress", reason: "zerosub-continued", continuedIn: row.continuedIn, wakeAt: null };
  }
  if (row.continued === true) {
    return { decision: "suppress", reason: "zerosub-continued", continuedIn: null, wakeAt: null };
  }
  if (row.reason === "exhausted" && row.outcome === "stayed") {
    return { decision: "proceed", reason: "no-account-free", continuedIn: null, wakeAt: row.resetsAt };
  }
  return { decision: "proceed", reason: "switch-no-action", continuedIn: null, wakeAt: null };
}

/**
 * One-line warning when a switch row forked the chat to another provider
 * family (host-wide "fork to other provider" acted): the factory switches
 * providers through its cheaper CHECKPOINT handoff instead. Null otherwise.
 */
export function zerosubForkWarning(row: ZerosubSwitchRow | null): string | null {
  if (!row?.toFamily) return null;
  return (
    `ZeroSub forked this chat to another provider (the ${row.toFamily} family); ` +
    `the factory switches providers via CHECKPOINT handoff — ` +
    `consider turning the host-wide "fork to other provider" setting off.`
  );
}

/** Epoch ms of a future ISO stamp, or null when missing, past, or unparsable. */
export function futureWakeAtMs(wakeAt: unknown, nowMs: number): number | null {
  if (typeof wakeAt !== "string" || !wakeAt) return null;
  const ms = Date.parse(wakeAt);
  return Number.isFinite(ms) && ms > nowMs ? ms : null;
}

/**
 * Production reader: the synced `readZerosubState` (DaemonClient plugin RPC
 * `zerosub.zerosub.state`, normalized). Never throws: any failure resolves
 * null so callers fall back to the usage adapter.
 */
export async function readZerosubStateSafe(): Promise<ZerosubState> {
  try {
    return await Z.readZerosubState();
  } catch {
    return null;
  }
}

/**
 * Resolves the normalized ZeroSub state for one call: an explicit `zerosub`
 * value (including null) wins, else the `getZerosub` supplier runs fail-soft,
 * else null. Production wires `getZerosub: readZerosubStateSafe`.
 */
export async function resolveZerosub(deps: ZerosubSource): Promise<ZerosubState> {
  if (deps.zerosub !== undefined) return deps.zerosub;
  if (typeof deps.getZerosub === "function") {
    try {
      return await deps.getZerosub();
    } catch {
      return null;
    }
  }
  return null;
}
