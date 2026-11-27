import { createHash } from "node:crypto";
import { appendFileSync, closeSync, constants, ftruncateSync, lstatSync, openSync,
  readSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { exportAllowlistedLedger, normalizeProviderUsage } from "./core/efficiency-metrics.mjs";
import { retryOnLockBusy, withLock } from "./core/lock.mjs";
import { runtime } from "./core/runtime.mjs";

const FILE_NAME = "efficiency-ledger.jsonl";
const MAX_BYTES = 512 * 1024;
const ROTATE_MS = 7 * 86_400_000;
const RETAIN_MS = 2 * ROTATE_MS;
const MAX_ROW_BYTES = 4096;

type TurnObservation = {
  provider: string | null;
  usage: unknown;
  agentId: string;
  sessionId: string | null;
  accountId?: string | null;
  scopeId: string;
  turnId: string | null;
  route: "normal" | "wake" | "handoff" | "resume" | "fresh" | "cleanup";
  outcome: "completed" | "failed" | "canceled";
  startedAt: unknown;
  endedAt: string;
  previousTurnEndedAt: unknown;
  preTurnContextTokens: unknown;
  quota?: { sessionPct?: unknown; weeklyPct?: unknown; sampledAt?: unknown; resetsAt?: unknown; weeklyResetAt?: unknown } | null;
};

function alias(kind: string, id: unknown): string | undefined {
  if (typeof id !== "string" || !id) return undefined;
  return createHash("sha256").update(kind).update("\0").update(id).digest("hex").slice(0, 16);
}

function timestamp(value: unknown): number | null {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isSafeInteger(ms) && ms >= 0 ? ms : null;
}

function percent(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function ledgerLine(turn: TurnObservation): Buffer {
  const provider = turn.provider?.toLowerCase();
  const startedAt = timestamp(turn.startedAt);
  const previousEnd = timestamp(turn.previousTurnEndedAt);
  const [event] = exportAllowlistedLedger([{
    kind: "turn", provider, route: turn.route, outcome: turn.outcome,
    agentAlias: alias("agent", turn.agentId), sessionAlias: alias("session", turn.sessionId),
    accountAlias: alias("account", turn.accountId), providerTurnId: alias("turn", turn.turnId),
    startedAt, endedAt: timestamp(turn.endedAt), preTurnContextTokens: turn.preTurnContextTokens,
    usage: normalizeProviderUsage(provider, turn.usage),
  }]);
  const quota = turn.quota;
  return Buffer.from(JSON.stringify({
    // Passive-only fields are explicitly projected here. The core allowlist covers the shared fields.
    startedAt: null, preTurnContextTokens: null,
    ...event,
    scopeAlias: alias("scope", turn.scopeId),
    idleMs: startedAt !== null && previousEnd !== null && startedAt >= previousEnd ? startedAt - previousEnd : null,
    incomplete: true, // Paseo's lastUsage snapshot does not establish whole-turn coverage.
    ...(quota ? { quota: {
      sessionPct: percent(quota.sessionPct), weeklyPct: percent(quota.weeklyPct),
      sampledAt: timestamp(quota.sampledAt), resetsAt: timestamp(quota.resetsAt), weeklyResetAt: timestamp(quota.weeklyResetAt),
    } } : {}),
  }) + "\n");
}

/** Only inspect the first row so appends stay bounded and old rows age even in a busy file. */
function retainedFile(path: string, now: number) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile()) throw new Error("Efficiency ledger path is not a regular file");
  const prefix = Buffer.alloc(MAX_ROW_BYTES);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let read: number;
  try {
    read = readSync(fd, prefix);
  } finally {
    closeSync(fd);
  }
  const newline = prefix.subarray(0, read).indexOf(10);
  let oldest: unknown;
  if (newline >= 0) {
    try { oldest = JSON.parse(prefix.toString("utf8", 0, newline))?.endedAt; } catch { /* discard unreadable files */ }
  }
  if (typeof oldest === "number" && Number.isSafeInteger(oldest) && oldest >= 0 &&
      now - oldest < RETAIN_MS && stat.size <= MAX_BYTES) return { age: now - oldest, size: stat.size };
  unlinkSync(path);
  return null;
}

/** Observe a completed turn using data already in memory. The hook isolates I/O failures. */
export async function observeEfficiencyTurn(
  readEnabled: (() => Promise<boolean>) | undefined,
  observe: () => TurnObservation,
): Promise<void> {
  if (process.env.PASEO_FACTORY_EFFICIENCY_LEDGER !== "1" && await readEnabled?.() !== true) return;
  const line = ledgerLine(observe());
  if (line.length > MAX_ROW_BYTES) return;
  const { stateDir, lockDir } = runtime();
  const path = join(stateDir, FILE_NAME);
  const backup = `${path}.1`;
  await retryOnLockBusy(() => withLock("efficiency-ledger", (held: { verify(): void }) => {
    held.verify();
    const now = Date.now();
    retainedFile(backup, now);
    const current = retainedFile(path, now);
    const rotate = current && (current.age >= ROTATE_MS || current.size + line.length > MAX_BYTES);
    if (rotate) renameSync(path, backup);
    const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      appendFileSync(fd, line);
    } catch (error) {
      ftruncateSync(fd, rotate ? 0 : current?.size ?? 0);
      throw error;
    } finally {
      closeSync(fd);
    }
  }, { dir: lockDir, timeoutMs: 250 }), { timeoutMs: 250 });
}
