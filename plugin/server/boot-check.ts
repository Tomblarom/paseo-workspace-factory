// P1 boot check: marks factory turns that died with a daemon restart.
// A restart kills running agents mid-turn without agent.turn.after, so the
// open-turn tracking from turn.before (wsf.agents openTurnId/turnStartedAt)
// is the only trace. At plugin start, every open turn whose start predates
// the daemon start becomes an interrupted record with reason "daemon-restart"
// (C2 shape plus reason) and clears the open fields, so a second plugin start
// finds nothing to mark. Never throws out of ensureBootChecked.
import { execFileSync } from "node:child_process";
import { LEGACY_PREFIX, METADATA_KEY, paseoBinary, readPaseoState } from "./factory/paseo.js";
import { listScopes } from "./factory/scope.js";
import { withWorkspaceLock } from "./factory/lock.js";
import { createGit } from "./factory/local.js";
import { lastAssistantText, readGitSnapshot } from "./factory/steer.js";
import {
  buildRestartInterrupted,
  isOpenTurnBeforeRestart,
} from "./factory/agent-state.js";
import { isAdvisorSlot } from "./factory/config.js";
import { factoryIdentity } from "../shared/auto-checkpoint.js";
import { pendingSteerDelivery } from "./steer-delivery.js";
import { RESUME_PENDING_REASON, RESUME_CLEAR_DEFAULTS, bootResumeReason } from "../shared/idle-cleanup.js";

const CHECKPOINT_KEY = `${METADATA_KEY}.checkpoint`;
const AGENTS_KEY = `${METADATA_KEY}.agents`;
const LEGACY_CHECKPOINT_KEY = `${LEGACY_PREFIX}.checkpoint`;

export interface BootMark {
  agentId: string;
  scopeId: string;
  workspaceId: string;
  /** "closed" marks a steer that only needs resume (no interrupted turn). */
  cause?: "interrupted" | "closed";
}

export interface BootCheckDeps {
  getDaemonStartedAt?: () => Promise<string | null> | string | null;
  now?: () => string;
  lock?: (
    name: string,
    fn: (held: { verify: () => void }) => Promise<unknown>,
  ) => Promise<unknown>;
  readExcerpt?: (paseo: unknown, agentId: string, openTurnId: string | null) => Promise<string | null>;
  readGit?: (scope: {
    directory?: string | null;
  }) => { branch: string; sha: string; changes: number } | null;
  log?: (message: string) => void;
  /** Hours an active steer's last turn may predate the daemon start; default 24. */
  getRecentHours?: () => Promise<number | null | undefined> | number | null | undefined;
  /** Effective config for advisor slots. Absent: no advisors known; throwing: all steers treated as advisors (fail closed). */
  getConfig?: () => Promise<unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Parses `paseo daemon status --json` output: field `startedAt` (Paseo 0.16.2).
 * Returns null when the output has no usable startedAt.
 */
export function parseDaemonStartedAt(output: string): string | null {
  const status = output.trim() ? (JSON.parse(output) as { startedAt?: unknown } | null) : null;
  const startedAt = status?.startedAt;
  return typeof startedAt === "string" && startedAt ? startedAt : null;
}

export type DaemonStatusRunner = (binary: string, args: string[]) => string;

/**
 * Daemon start time from `paseo daemon status --json`. Deliberately run
 * WITHOUT `--host`: with an explicit host the CLI reports the connected
 * client view (host, serverId, connectedDaemon, ...) and no `startedAt`; only
 * the local-home view has it. Errors are logged (message only, short) and the
 * result is null (fail closed: no marks).
 */
export function readDaemonStartedAtViaCli(
  run: DaemonStatusRunner = (binary, args) =>
    execFileSync(binary, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    }),
  log: (message: string) => void = console.log,
  binary?: string,
): string | null {
  try {
    const bin = binary ?? (paseoBinary as unknown as () => string)();
    const startedAt = parseDaemonStartedAt(run(bin, ["daemon", "status", "--json"]));
    if (!startedAt) log("[factory] boot check: daemon status has no startedAt field");
    return startedAt;
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    log(`[factory] boot check: daemon status failed (${raw.replace(/\s+/g, " ").slice(0, 200)})`);
    return null;
  }
}

async function defaultReadExcerpt(paseo: any, agentId: string, openTurnId: string | null): Promise<string | null> {
  try {
    const page: any = await paseo.agents.ref(agentId).timeline.refetch({
      direction: "tail",
      limit: 1,
      wholeTurns: true,
    });
    const all = Array.isArray(page?.entries) ? page.entries : [];
    const entries = openTurnId ? all.filter((e: any) => e.turnId === undefined || e.turnId === openTurnId) : all;
    return (lastAssistantText as unknown as (p: unknown) => string | null)({ entries });
  } catch {
    return null;
  }
}

function defaultReadGit(scope: { directory?: string | null }): {
  branch: string;
  sha: string;
  changes: number;
} | null {
  try {
    const git = (createGit as unknown as () => unknown)() as never;
    return (readGitSnapshot as unknown as (g: unknown, p: unknown) => {
      branch: string;
      sha: string;
      changes: number;
    } | null)(git, scope.directory ?? null);
  } catch {
    return null;
  }
}

/**
 * Marks every factory agent whose open turn started before the daemon
 * started. One workspace lock per scope; fresh metadata is re-read under the
 * lock and each candidate is re-checked, so a concurrent turn.before/after
 * cannot be overwritten. Returns the marked agents.
 */
export async function runBootCheck({
  paseo,
  getDaemonStartedAt,
  now,
  lock,
  readExcerpt,
  readGit,
  log,
  getRecentHours,
  getConfig,
}: BootCheckDeps & { paseo: any }): Promise<BootMark[]> {
  const logFn = log ?? console.log;
  const nowFn = now ?? (() => new Date().toISOString());
  let daemonStartedAt: string | null;
  try {
    const raw = getDaemonStartedAt ? await getDaemonStartedAt() : readDaemonStartedAtViaCli(undefined, logFn);
    daemonStartedAt = typeof raw === "string" && raw ? raw : null;
  } catch (error) {
    logFn(`[factory] boot check: daemon start lookup failed (${error instanceof Error ? error.message.slice(0, 200) : "error"})`);
    daemonStartedAt = null;
  }
  if (!daemonStartedAt) {
    logFn("[factory] boot check: daemon start unknown; skip");
    return [];
  }
  const state: any = await readPaseoState(paseo);
  const scopes: any[] = listScopes(state);
  const byId = new Map<string, any>(scopes.map((s: any) => [s.id, s]));
  const excerptOf = readExcerpt ?? defaultReadExcerpt;
  const gitOf = readGit ?? defaultReadGit;
  const takeLock = (lock ??
    withWorkspaceLock) as unknown as (
    workspaceId: string,
    fn: (held: { verify: () => void }) => Promise<unknown>,
  ) => Promise<unknown>;

  let recentHours: number = RESUME_CLEAR_DEFAULTS.recentHours;
  try {
    const raw = getRecentHours ? await getRecentHours() : null;
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) recentHours = raw;
  } catch {
    // default stands
  }
  let config: unknown = {};
  let configFailed = false;
  if (getConfig) {
    try {
      config = await getConfig();
    } catch {
      configFailed = true;
    }
  }

  // Candidates grouped by main workspace so each scope is locked once. A
  // closed steer is never a reason by itself (after a daemon restart nearly
  // everything is closed): steers qualify via bootResumeReason (open turn, or
  // any steer with a recent last turn). Workers only matter with an open
  // turn (interrupted record, no needsResume). Stale daemon-restart flags of
  // steers that no longer qualify are removed in the same pass.
  type Candidate = {
    agentId: string;
    entry: Record<string, unknown> | null;
    role: string;
    open: boolean;
    reason: string | null;
  };
  const grouped = new Map<string, { scope: any; agents: Candidate[]; stale: string[]; renewals: string[] }>();
  const groupOf = (scope: any) => {
    const mainId: string = scope.workspaceId;
    const group = grouped.get(mainId) ?? { scope, agents: [], stale: [], renewals: [] };
    grouped.set(mainId, group);
    return group;
  };
  const qualified = new Set<string>();
  const reasonCounts = { "open-turn": 0, "active-recent": 0, recent: 0 };
  for (const agent of state.agents ?? []) {
    if (agent?.archivedAt) continue;
    const identity = factoryIdentity(agent?.labels ?? null);
    if (!identity) continue;
    const scope = byId.get(identity.scopeId) ?? null;
    if (!scope) continue;
    const scopeMeta = asRecord(scope.workspace?.metadata?.[METADATA_KEY]);
    const entries = asRecord(scope.workspace?.metadata?.[AGENTS_KEY]) ?? {};
    const entry = asRecord(entries[agent.id]);
    const openCheck = entry
      ? (isOpenTurnBeforeRestart as unknown as (e: unknown, d: string) => boolean)(
          entry,
          daemonStartedAt,
        )
      : false;
    let reason: string | null = null;
    if (identity.role === "steer") {
      if (!identity.slot || scopeMeta?.retired === true) continue;
      const advisor = configFailed
        ? true
        : (isAdvisorSlot as unknown as (c: unknown, s: string) => boolean)(config, identity.slot);
      reason = (bootResumeReason as unknown as (a: unknown) => string | null)({
        openTurn: openCheck,
        active: scopeMeta?.activeSteer === identity.slot,
        advisor,
        lastTurnEndedAt: typeof entry?.lastTurnEndedAt === "string" ? entry.lastTurnEndedAt : null,
        daemonStartedAt,
        recentHours,
      });
      if (!reason) continue;
      qualified.add(agent.id);
      reasonCounts[reason as "open-turn" | "active-recent" | "recent"] += 1;
    } else if (!openCheck) {
      continue;
    }
    groupOf(scope).agents.push({ agentId: agent.id, entry, role: identity.role, open: openCheck, reason });
  }
  for (const scope of scopes) {
    const entries = asRecord(scope.workspace?.metadata?.[AGENTS_KEY]) ?? {};
    for (const [agentId, raw] of Object.entries(entries)) {
      const queued = pendingSteerDelivery(raw, scope.workspaceId);
      if (queued?.phase === "renewing" && Date.parse(queued.queuedAt) < Date.parse(daemonStartedAt)) {
        groupOf(scope).renewals.push(agentId);
      }
      const reason = asRecord(asRecord(raw)?.needsResume)?.reason;
      if (reason === "daemon-restart" && !qualified.has(agentId)) groupOf(scope).stale.push(agentId);
    }
  }
  if (!grouped.size) {
    logFn("[factory] boot check: marked 0 steer(s) (open turn 0, active recent 0, recent 0); no stale flags");
    return [];
  }

  const marked: BootMark[] = [];
  let staleTotal = 0;
  for (const [mainId, group] of grouped) {
    // Deterministic order: earliest turn start first, then agent id. The
    // scope flag names the first one when several died in one scope.
    const ordered = [...group.agents].sort((a, b) => {
      const aMs = Date.parse(String(a.entry?.turnStartedAt ?? ""));
      const bMs = Date.parse(String(b.entry?.turnStartedAt ?? ""));
      if (Number.isFinite(aMs) && Number.isFinite(bMs) && aMs !== bMs) return aMs - bMs;
      return a.agentId.localeCompare(b.agentId);
    });
    // Excerpts and git are read before the lock (best effort); the lock only
    // re-checks the open-turn condition and writes. Closed-only steers need
    // neither: they get needsResume without an interrupted record.
    const prepared: {
      agentId: string;
      role: string;
      open: boolean;
      openTurnId: string | null;
      excerpt: string | null;
      git: { branch: string; sha: string; changes: number } | null;
    }[] = [];
    for (const candidate of ordered) {
      const openTurnId =
        typeof candidate.entry?.openTurnId === "string" ? candidate.entry.openTurnId : null;
      let excerpt: string | null = null;
      let git: { branch: string; sha: string; changes: number } | null = null;
      if (candidate.open) {
        try {
          excerpt = await excerptOf(paseo, candidate.agentId, openTurnId);
        } catch {
          excerpt = null;
        }
        try {
          git = gitOf(group.scope);
        } catch {
          git = null;
        }
      }
      prepared.push({ agentId: candidate.agentId, role: candidate.role, open: candidate.open, openTurnId, excerpt, git });
    }
    const at = nowFn();
    await takeLock(mainId, async (held: any) => {
      const freshSnap: any = await paseo.workspaces.ref(mainId).refresh().catch(() => null);
      const freshMeta = freshSnap?.metadata ?? {};
      const freshAgents = asRecord(freshMeta[AGENTS_KEY]) ?? {};
      const freshCheckpoint =
        asRecord(freshMeta[CHECKPOINT_KEY]) ?? asRecord(freshMeta[LEGACY_CHECKPOINT_KEY]);
      const nextAgents: Record<string, unknown> = { ...freshAgents };
      let firstMarked: string | null = null;
      let resumeMarked = 0;
      let staleRemoved = 0;
      // An existing flag (e.g. limit from before the restart) wins over the
      // generic daemon-restart: only flag steers without needsResume.
      const flagResume = (agentId: string, role: string): void => {
        if (role !== "steer") return;
        const current = asRecord(nextAgents[agentId]);
        if (current?.needsResume) return;
        nextAgents[agentId] = {
          ...(current ?? {}),
          needsResume: { reason: "daemon-restart", at },
        };
        resumeMarked += 1;
        marked.push({ agentId, scopeId: group.scope.id, workspaceId: mainId, cause: "closed" });
      };
      for (const item of prepared) {
        const freshEntry = asRecord(nextAgents[item.agentId]);
        if (!item.open) {
          flagResume(item.agentId, item.role);
          continue;
        }
        const stillOpen = (isOpenTurnBeforeRestart as unknown as (e: unknown, d: string) => boolean)(
          freshEntry,
          daemonStartedAt,
        );
        if (!stillOpen || !freshEntry) continue;
        const interrupted = (buildRestartInterrupted as unknown as (args: {
          at: string;
          reason: string;
          error: string;
          excerpt: string | null;
          git: { branch: string; sha: string; changes: number } | null;
        }) => Record<string, unknown>)({
          at,
          reason: "daemon-restart",
          error: "daemon restarted during turn",
          excerpt: item.excerpt,
          git: item.git,
        });
        nextAgents[item.agentId] = {
          ...freshEntry,
          lastTurnId: item.openTurnId ?? freshEntry.lastTurnId ?? null,
          lastTurnEndedAt: at,
          outcome: "canceled",
          openTurnId: null,
          turnStartedAt: null,
          interrupted,
        };
        marked.push({ agentId: item.agentId, scopeId: group.scope.id, workspaceId: mainId, cause: "interrupted" });
        if (!firstMarked) firstMarked = item.agentId;
        // An interrupted steer resumes instead of continuing cold.
        if (item.role === "steer" && !asRecord(nextAgents[item.agentId])?.needsResume) {
          nextAgents[item.agentId] = {
            ...(asRecord(nextAgents[item.agentId]) ?? {}),
            needsResume: { reason: "daemon-restart", at },
          };
          resumeMarked += 1;
        }
      }
      // Migration: daemon-restart flags that no longer satisfy the rule go away.
      for (const agentId of group.stale) {
        const current = asRecord(nextAgents[agentId]);
        if (!current || asRecord(current.needsResume)?.reason !== "daemon-restart") continue;
        const { needsResume: _dropped, ...rest } = current;
        nextAgents[agentId] = rest;
        staleRemoved += 1;
      }
      let renewalsInterrupted = 0;
      for (const agentId of group.renewals) {
        const entry = asRecord(nextAgents[agentId]);
        const queued = pendingSteerDelivery(entry, mainId);
        if (!queued || queued.phase !== "renewing" ||
            !(Date.parse(queued.queuedAt) < Date.parse(daemonStartedAt))) continue;
        const pendingAction = asRecord(entry?.pendingAction);
        nextAgents[agentId] = {
          ...entry,
          ...(pendingAction?.reason === RESUME_PENDING_REASON ? { pendingAction: null } : {}),
          pendingWakeBrief: { ...queued, phase: "blocked", lastError: "Paseo restarted before context renewal was confirmed. Retry recovery or use Fresh." },
        };
        renewalsInterrupted += 1;
      }
      staleTotal += staleRemoved;
      if (!firstMarked && !resumeMarked && !staleRemoved && !renewalsInterrupted) return;
      const patch: Record<string, unknown> = { [AGENTS_KEY]: nextAgents };
      if (
        firstMarked &&
        freshCheckpoint &&
        typeof freshCheckpoint.task === "string" &&
        freshCheckpoint.task.trim() !== ""
      ) {
        patch[CHECKPOINT_KEY] = {
          ...freshCheckpoint,
          interrupted: { agentId: firstMarked, at, reason: "daemon-restart" },
        };
      }
      held.verify();
      await paseo.workspaces.ref(mainId).setMetadata(patch);
    });
  }
  logFn(
    `[factory] boot check: marked ${marked.filter((m) => m.cause !== "closed").length} interrupted turn(s) (daemon-restart); needsResume steers: ${reasonCounts["open-turn"]} open turn, ${reasonCounts["active-recent"]} active recent, ${reasonCounts.recent} recent; ${staleTotal} stale flag(s) removed`,
  );
  return marked;
}

let checked = false;

/**
 * Runs the boot check once per plugin process. The server entry receives no
 * PaseoApi of its own, so index.server.ts calls this on the first available
 * handle (first turn, RPC, or subscription) — effectively at plugin start,
 * before any new turn is recorded. Never throws.
 */
export async function ensureBootChecked(paseo: any, deps: BootCheckDeps = {}): Promise<BootMark[]> {
  if (checked) return [];
  checked = true;
  try {
    return await runBootCheck({ paseo, ...deps });
  } catch (error) {
    console.error(
      `[factory] boot check failed (${error instanceof Error ? error.message : String(error)})`,
    );
    return [];
  }
}

/** Clears the once-flag; tests only. */
export function resetBootCheckForTests(): void {
  checked = false;
}
