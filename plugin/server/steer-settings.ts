// Catalog-backed steer settings (docs/design/steer-menu.md, step 4): preview,
// apply and revert for "Change settings…". Same provider only (a running
// agent keeps its provider); access mode, other provider options, account
// policy and role are preserved. Only erasable TypeScript: node --test
// imports this file with type stripping (see plugin/test/ts-resolve-hooks.mjs).
import { AGENTS_KEY, buildSettingsBaseline, updateAgentEntry } from "./core/agent-state.mjs";
import { withLock, workspaceLockName } from "./core/lock.mjs";
import { METADATA_KEY, paseoBinary, readPaseoState } from "./core/paseo.mjs";
import { runtime } from "./core/runtime.mjs";
import { listScopes } from "./core/scope.mjs";
import { buildRewindRecord, freshRewindIdempotent, requireFreshPrivacy, SwitchRefused } from "./core/steer.mjs";
import { actionFact } from "./core/action-facts.mjs";
import { defaultCreateRewindClient, rewindAndBrief, sendUserBrief } from "./core/rewind.mjs";
import { cleanupIdentity } from "../shared/idle-cleanup.js";
import { openTurnOf } from "../shared/auto-checkpoint.js";
import { settingsFingerprint } from "../shared/preview.js";
import { resolveQuota } from "../shared/steer-state.js";
import {
  checkSupportedCombination,
  checkSupportedSpeed,
  chooseSettingsRoute,
  isNoopChange,
  listSupportedModels,
  normalizeModel,
  normalizeProvider,
  normalizeThinking,
  speedOfLiveOptions,
  speedPatchFor,
  thinkingOptionsFor,
  tupleFromLive,
  tuplesEqual,
  type SettingsTuple,
} from "../shared/steer-settings.js";
import { collectSteerStates } from "./steer-feed.js";
import { stageSteerBrief } from "./steer-brief.js";
import { readPrivacyAdmission } from "./steer-admission.js";

const updateEntry = updateAgentEntry as unknown as (args: any) => Promise<any>;

const takeLock = withLock as unknown as (
  name: string,
  fn: (held: { verify: () => void }) => Promise<any>,
) => Promise<any>;
const lockName = workspaceLockName as unknown as (workspaceId: string) => string;
const buildBaseline = buildSettingsBaseline as unknown as (args: any) => any;
const buildRecord = buildRewindRecord as unknown as (args: any) => any;
const rewindIdem = freshRewindIdempotent as unknown as (entry: any) => string | null;
const rewindBrief = rewindAndBrief as unknown as (
  agentId: string,
  briefText: string,
  opts?: any,
) => Promise<any>;
const defaultClientFactory = defaultCreateRewindClient as unknown as (
  args: { url: string; cliPath: string },
) => Promise<any>;
const paseoBin = paseoBinary as unknown as () => string;
const factoryRuntime = runtime as unknown as () => { paseo: { url: string } };

export interface SteerSettingsDeps {
  /** Lock for the entry writes; tests only. */
  lock?: (name: string, fn: (held: { verify: () => void }) => Promise<any>) => Promise<any>;
  now?: () => string;
  nowMs?: () => number;
  /** Live provider catalog; defaults to paseo.providers.snapshot(). */
  loadCatalog?: (paseo: any) => Promise<any[]>;
  getCleanupSettings?: () => Promise<{ profile?: unknown } | null>;
  getConfig?: () => Promise<any>;
  getZerosub?: () => Promise<any>;
  quotaSnapshot?: Record<string, any> | null;
  poolSampledAtMs?: number | null;
  quotaSampleMinutes?: number;
  /** DaemonClient factory for the bound rewind; tests inject a fake. */
  rewindClient?: (args: { url: string; cliPath: string }) => Promise<any>;
  /** DaemonClient factory for model/thinking/options writes; tests inject a fake. */
  configClient?: (args: { url: string; cliPath: string }) => Promise<any>;
  /** Resume brief builder for the Refresh route; required on that path. */
  buildBrief?: (paseo: any, workspaceId: string, agentId: string) => Promise<string>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

async function defaultCatalog(paseo: any): Promise<any[]> {
  const result = await paseo.providers.snapshot();
  return Array.isArray(result?.entries) ? result.entries : [];
}

function liveTupleOf(agent: any): { tuple: SettingsTuple; sessionId: string | null } {
  const provider = typeof agent?.provider === "string" ? agent.provider : null;
  const model = typeof agent?.model === "string" ? agent.model : null;
  const thinking = typeof agent?.effectiveThinkingOptionId === "string"
    ? agent.effectiveThinkingOptionId
    : (typeof agent?.thinkingOptionId === "string" ? agent.thinkingOptionId : null);
  const tuple = tupleFromLive({ provider, model, thinking, options: agent?.options ?? null });
  const sessionId = typeof agent?.persistence?.sessionId === "string" && agent.persistence.sessionId
    ? agent.persistence.sessionId
    : null;
  return { tuple, sessionId };
}

function requestedTupleOf(
  current: SettingsTuple,
  input: { model?: string; thinking?: string | null; speed?: string | null },
): SettingsTuple {
  const model = input.model !== undefined ? normalizeModel(input.model) : current.model;
  const thinking = input.thinking !== undefined ? normalizeThinking(input.thinking) : current.thinking;
  const speed = input.speed !== undefined
    ? (() => {
      const raw = input.speed;
      if (raw === null) return null;
      return tupleFromLive({ provider: current.provider, model: model ?? current.model, speed: raw }).speed;
    })()
    : current.speed;
  return {
    provider: current.provider,
    model,
    thinking,
    speed,
  };
}

function speedChoicesFor(provider: string | null, currentSpeed: string | null): string[] {
  const norm = typeof provider === "string" ? provider.trim().toLowerCase() : "";
  if (norm === "claude") return ["standard", "fast"];
  if (norm === "codex" || norm === "openai") {
    const out: string[] = [];
    if (currentSpeed) out.push(currentSpeed);
    if (!out.includes("default")) out.push("default");
    return out;
  }
  return currentSpeed ? [currentSpeed] : [];
}

async function steerScope(
  paseo: any,
  workspaceId: string,
  agentId: string,
  snapshot?: any,
): Promise<{ agent: any; scope: any; mainId: string; slot: string | null; epoch: number | null; entry: Record<string, unknown> | null }> {
  const state: any = snapshot ?? (await readPaseoState(paseo));
  const agent: any = (state.agents ?? []).find((a: any) => a?.id === agentId) ?? null;
  if (!agent) throw new Error(`Unknown agent ${JSON.stringify(agentId)}`);
  const identity = cleanupIdentity(agent.labels ?? null);
  if (!identity || identity.role !== "steer") {
    throw new Error(`Change settings is only for steers; ${agentId} is not a steer.`);
  }
  const scope: any = listScopes(state).find((s: any) => s.id === identity.scopeId) ?? null;
  if (!scope) throw new Error(`Agent ${agentId} has no live factory scope`);
  const mainId: string = scope.workspaceId;
  if (mainId !== workspaceId) {
    throw new Error(`Agent ${agentId} belongs to workspace ${mainId}, not ${workspaceId}.`);
  }
  const meta = scope.workspace?.metadata ?? {};
  const wsf = asRecord(meta[METADATA_KEY]);
  const entries = asRecord(meta[AGENTS_KEY]) ?? {};
  return {
    agent,
    scope,
    mainId,
    slot: typeof identity.slot === "string" && identity.slot ? identity.slot : null,
    epoch: typeof wsf?.epoch === "number" ? wsf.epoch : null,
    entry: asRecord(entries[agentId]),
  };
}

export interface SettingsPreviewInput {
  workspaceId: string;
  agentId: string;
  model?: string;
  thinking?: string | null;
  speed?: string | null;
}

/**
 * Catalog-backed settings preview (read-only): the current tuple, the
 * requested tuple, the supported choices, and the route. Throws on
 * unsupported settings with an English reason; writes nothing.
 */
export async function previewSteerSettings(
  paseo: any,
  input: SettingsPreviewInput,
  deps: SteerSettingsDeps = {},
): Promise<{
  workspaceId: string;
  agentId: string;
  slot: string | null;
  epoch: number | null;
  sessionId: string | null;
  provider: string | null;
  current: SettingsTuple;
  requested: SettingsTuple;
  models: string[];
  thinkingOptions: string[];
  speeds: string[];
  noop: boolean;
  route: "apply-here" | "refresh";
  routeReason: string;
  cacheRisk: boolean;
  efficiencyLocked: boolean;
  lockReason: string | null;
  warnings: string[];
  fingerprint: string;
}> {
  const agentId = input.agentId.trim();
  const paseoState: any = await readPaseoState(paseo);
  const { agent, mainId, slot, epoch } = await steerScope(paseo, input.workspaceId, agentId, paseoState);
  const { tuple: current, sessionId } = liveTupleOf(agent);
  const requested = requestedTupleOf(current, {
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
    ...(input.speed !== undefined ? { speed: input.speed } : {}),
  });
  const catalog = deps.loadCatalog ? await deps.loadCatalog(paseo) : await defaultCatalog(paseo);
  const combo = checkSupportedCombination(catalog, requested.provider, requested.model, requested.thinking);
  if (!combo.ok) throw new Error(combo.reason ?? "Unsupported settings.");
  const speedCheck = checkSupportedSpeed(requested.provider, requested.model, requested.speed);
  if (!speedCheck.ok) throw new Error(speedCheck.reason ?? "Unsupported speed.");
  const models = listSupportedModels(catalog, requested.provider);
  const thinkingOptions = thinkingOptionsFor(catalog, requested.provider, requested.model);
  const speeds = speedChoicesFor(requested.provider, current.speed);
  const noop = isNoopChange(current, requested);

  // Warmth, size and the efficiency lock come from the shared feed so the
  // preview and the pill agree.
  const cleanup = deps.getCleanupSettings ? await deps.getCleanupSettings().catch(() => null) : null;
  const config = deps.getConfig ? await deps.getConfig().catch(() => null) : null;
  const zerosub = deps.getZerosub ? await deps.getZerosub().catch(() => null) : null;
  const rows = collectSteerStates(paseoState, {
    settings: (cleanup ?? null) as any,
    config,
    zerosub,
    quotaSnapshot: deps.quotaSnapshot ?? null,
    poolSampledAtMs: deps.poolSampledAtMs ?? null,
    quotaSampleMinutes: deps.quotaSampleMinutes,
    nowMs: deps.nowMs ? deps.nowMs() : Date.now(),
  });
  const row = rows.find((entry) => entry.agentId === agentId) ?? null;
  const warmth = row?.warmth ?? "unknown";
  const large = row?.large === true;
  const tokens = typeof row?.tokens === "number" ? row.tokens : null;
  const efficiencyLocked = row?.settingsLocked === true;
  const lockReason = typeof row?.settingsLockReason === "string" ? row.settingsLockReason : null;
  const decision = chooseSettingsRoute({ current, requested, warmth, large, tokens, efficiencyLocked });
  const warnings: string[] = [];
  if (!noop && decision.cacheRisk) {
    warnings.push("This change risks the cached prefix. Refresh keeps the cache usable.");
  }
  if (!noop && requested.speed === "fast" && current.speed !== "fast") {
    warnings.push("Fast speed can carry different usage charges.");
  }
  const fingerprint = settingsFingerprint({
    workspaceId: mainId,
    agentId,
    epoch,
    sessionId,
    current: { provider: current.provider, model: current.model, thinking: current.thinking, speed: current.speed },
    requested: { provider: requested.provider, model: requested.model, thinking: requested.thinking, speed: requested.speed },
    route: decision.route,
  });
  return {
    workspaceId: mainId,
    agentId,
    slot,
    epoch,
    sessionId,
    provider: current.provider,
    current,
    requested,
    models,
    thinkingOptions,
    speeds,
    noop,
    route: decision.route,
    routeReason: decision.reason,
    cacheRisk: decision.cacheRisk,
    efficiencyLocked,
    lockReason,
    warnings,
    fingerprint,
  };
}

export interface SettingsApplyInput {
  workspaceId: string;
  agentId: string;
  fingerprint: string;
  route: "apply-here" | "refresh";
  model?: string;
  thinking?: string | null;
  speed?: string | null;
  deliver?: "send" | "stage";
}

interface FieldWrite {
  field: "model" | "thinking" | "speed";
  error: string | null;
}

async function openConfigClient(deps: SteerSettingsDeps): Promise<any> {
  const factory = deps.configClient ?? defaultClientFactory;
  const url = factoryRuntime().paseo.url;
  const cliPath = paseoBin();
  return factory({ url, cliPath });
}

/**
 * Writes the requested tuple field by field (model, then thinking, then
 * speed, so a model-induced reset lands before its replacements). A field
 * failure is collected and the remaining fields are still attempted, so a
 * partial write reports exactly what landed. Verifies the final effective
 * tuple by re-reading the agent.
 */
async function writeTuple(
  paseo: any,
  agentId: string,
  current: SettingsTuple,
  requested: SettingsTuple,
  deps: SteerSettingsDeps,
): Promise<{ writes: FieldWrite[]; actual: SettingsTuple; actualSessionId: string | null; verified: boolean }> {
  const writes: FieldWrite[] = [];
  const wantModel = requested.model !== current.model;
  const wantThinking = requested.thinking !== current.thinking;
  const wantSpeed = requested.speed !== current.speed;
  if (!wantModel && !wantThinking && !wantSpeed) {
    const snap = await paseo.agents.ref(agentId).refresh().catch(() => null);
    const live = liveTupleOf(snap?.agent ?? null);
    return { writes, actual: live.tuple, actualSessionId: live.sessionId, verified: tuplesEqual(live.tuple, requested) };
  }
  if (wantSpeed) {
    const patch = speedPatchFor(requested.provider, requested.model ?? current.model, requested.speed);
    if (patch === null && requested.speed !== null) {
      const provider = requested.provider ?? "this provider";
      throw new Error(`Speed change is not supported on ${provider}.`);
    }
  }
  const client = await openConfigClient(deps);
  try {
    if (wantModel && requested.model) {
      try {
        await client.setAgentModel(agentId, requested.model);
        writes.push({ field: "model", error: null });
      } catch (error) {
        writes.push({ field: "model", error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (wantThinking) {
      try {
        await client.setAgentThinkingOption(agentId, requested.thinking);
        writes.push({ field: "thinking", error: null });
      } catch (error) {
        writes.push({ field: "thinking", error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (wantSpeed) {
      const patch = speedPatchFor(requested.provider, requested.model ?? current.model, requested.speed);
      if (patch) {
        try {
          await client.setAgentOptions(agentId, patch);
          writes.push({ field: "speed", error: null });
        } catch (error) {
          writes.push({ field: "speed", error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
  } finally {
    await client?.close?.().catch(() => {});
  }
  const snap = await paseo.agents.ref(agentId).refresh().catch(() => null);
  const live = liveTupleOf(snap?.agent ?? null);
  return { writes, actual: live.tuple, actualSessionId: live.sessionId, verified: tuplesEqual(live.tuple, requested) };
}

function describeWrites(
  writes: FieldWrite[],
  actual: SettingsTuple,
  requested: SettingsTuple,
): { applied: string[]; missing: string[] } {
  const applied: string[] = [];
  const missing: string[] = [];
  for (const write of writes) {
    const landed = actual[write.field] === requested[write.field] && write.error === null;
    (landed ? applied : missing).push(write.field);
  }
  return { applied, missing };
}

async function sendBriefAsUser(
  paseo: any,
  agentId: string,
  brief: string,
  deps: SteerSettingsDeps,
  beforeSend: () => Promise<void>,
): Promise<void> {
  // Prefer the rewind transport so the brief arrives as a user message (the
  // next refresh rewinds to exactly that brief); without a rewind client,
  // or when the client has no send transport, fall back to the high-level
  // send (the server carries no caller id).
  if (deps.rewindClient) {
    const sendBrief = sendUserBrief as unknown as (
      agentId: string,
      brief: string,
      opts: { url: string; cliPath: string; createClient: (args: { url: string; cliPath: string }) => Promise<any>; beforeSend: () => Promise<void> },
    ) => Promise<boolean>;
    const sent = await sendBrief(agentId, brief, {
      url: factoryRuntime().paseo.url,
      cliPath: paseoBin(),
      createClient: deps.rewindClient,
      beforeSend,
    });
    if (sent) return;
  }
  await beforeSend();
  await paseo.agents.ref(agentId).send(brief);
}

/**
 * Applies a previewed settings change. Revalidates the preview (catalog,
 * session, epoch) and rechecks busy state, pending permissions and quota
 * (Refresh route) under the scope lock. Apply-here writes in place;
 * Refresh rewinds on a bound route (no silent fallback), then applies and
 * verifies, then delivers or stages the brief. A bound or config failure
 * keeps the brief staged and reports the last confirmed step.
 */
export async function applySteerSettings(
  paseo: any,
  input: SettingsApplyInput,
  deps: SteerSettingsDeps = {},
): Promise<{
  workspaceId: string;
  agentId: string;
  applied: boolean;
  route: string;
  verified: boolean;
  current: SettingsTuple;
  noop?: boolean;
  delivered?: boolean;
  staged?: boolean;
  stagedTo?: string | null;
  packet?: string;
  packetChars?: number;
  deliveryError?: unknown;
  detail: string;
}> {
  const agentId = input.agentId.trim();
  const lock = deps.lock ?? takeLock;
  const nowMs = deps.nowMs ? deps.nowMs() : Date.now();
  const preview = await previewSteerSettings(
    paseo,
    {
      workspaceId: input.workspaceId,
      agentId,
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
      ...(input.speed !== undefined ? { speed: input.speed } : {}),
    },
    deps,
  );
  if (preview.fingerprint !== input.fingerprint || preview.route !== input.route) {
    throw new Error(
      "Something changed since the settings preview (steer state, session or catalog). Open the preview again and confirm the new one.",
    );
  }
  if (!preview.noop && input.route === "apply-here" && preview.efficiencyLocked) {
    throw new Error(`${preview.lockReason ?? "Maximum efficiency protects this context."} Use Refresh.`);
  }
  if (preview.noop) {
    return {
      workspaceId: preview.workspaceId,
      agentId,
      applied: true,
      route: "apply-here",
      verified: true,
      current: preview.current,
      noop: true,
      detail: "No change.",
    };
  }

  // Apply-time rechecks under the scope lock: epoch, busy state, pending
  // permissions, and (Refresh route) quota. A failure throws before any
  // write; nothing is sent, recorded, or created.
  const checked = await lock(lockName(preview.workspaceId), async (held: { verify: () => void }) => {
    const workspace = paseo.workspaces.ref(preview.workspaceId);
    const metadata = (await workspace.refresh())?.metadata ?? {};
    const wsf = asRecord(metadata[METADATA_KEY]);
    if (!wsf) throw new Error("Scope state is gone.");
    if (typeof wsf.epoch === "number" && typeof preview.epoch === "number" && wsf.epoch !== preview.epoch) {
      throw new Error(
        "Something changed since the settings preview (the scope moved on). Open the preview again and confirm the new one.",
      );
    }
    const snap = await paseo.agents.ref(agentId).refresh().catch(() => null);
    const live = snap?.agent ?? null;
    if (!live) throw new Error(`Unknown agent ${JSON.stringify(agentId)}`);
    if (live.archivedAt) throw new Error("This tab was archived. Open the current holder instead.");
    const status = typeof live.status === "string" ? live.status : "";
    if (status === "running" || status === "initializing") {
      throw new Error("This steer is running. Wait for the turn to end, then change settings.");
    }
    const entries = asRecord(metadata[AGENTS_KEY]) ?? {};
    const entry = asRecord(entries[agentId]);
    if (openTurnOf(entry) !== null) {
      throw new Error("This steer is running. Wait for the turn to end, then change settings.");
    }
    if (Array.isArray(live.pendingPermissions) && live.pendingPermissions.length > 0) {
      throw new Error("A permission request is waiting. Answer it first, then change settings.");
    }
    if (input.route === "refresh") {
      const zerosub = deps.getZerosub ? await deps.getZerosub().catch(() => null) : null;
      const needsResume = asRecord(entry?.needsResume);
      const quota = resolveQuota({
        nowMs,
        agentId,
        model: typeof live.model === "string" ? live.model : null,
        zerosub,
        pool: typeof live.provider === "string" ? live.provider : null,
        quotaSnapshot: deps.quotaSnapshot ?? null,
        poolSampledAtMs: deps.poolSampledAtMs ?? null,
        quotaSampleMinutes: deps.quotaSampleMinutes,
        needsResumeReason: (needsResume?.reason ?? null) as any,
        needsResumeAt: typeof needsResume?.at === "string" ? (needsResume.at as string) : null,
      });
      if (quota.limited) {
        const reason = quota.limitedReasons.join("; ") || "Quota limited";
        throw new Error(`Quota depleted (${reason}). Wait for the reset, then refresh.`);
      }
      const refreshStamp = asRecord(entry?.settingsRefresh);
      if (typeof refreshStamp?.fingerprint === "string" && refreshStamp.fingerprint === input.fingerprint) {
        return { idempotent: true as const, entry, live };
      }
    }
    held.verify();
    return { idempotent: false as const, entry, live };
  });
  if (checked.idempotent === true) {
    const snap = await paseo.agents.ref(agentId).refresh().catch(() => null);
    const live = liveTupleOf(snap?.agent ?? null);
    return {
      workspaceId: preview.workspaceId,
      agentId,
      applied: false,
      route: "refresh",
      verified: tuplesEqual(live.tuple, preview.requested),
      current: live.tuple,
      delivered: false,
      staged: true,
      stagedTo: agentId,
      detail: "This settings refresh already applied.",
    };
  }

  if (input.route === "apply-here") {
    const { writes, actual, actualSessionId, verified } = await writeTuple(
      paseo,
      agentId,
      preview.current,
      preview.requested,
      deps,
    );
    const baseline = buildBaseline({
      provider: actual.provider,
      model: actual.model,
      thinking: actual.thinking,
      speed: actual.speed,
      sessionId: actualSessionId ?? preview.sessionId,
      turnId: null,
      at: deps.now ? deps.now() : new Date().toISOString(),
    });
    await updateEntry({
      client: paseo,
      workspaceId: preview.workspaceId,
      agentId,
      patch: {
        ...(baseline ? { settingsBaseline: baseline } : {}),
        settingsConfirmed: {
          provider: preview.requested.provider,
          model: preview.requested.model,
          thinking: preview.requested.thinking,
          speed: preview.requested.speed,
          fingerprint: input.fingerprint,
          at: deps.now ? deps.now() : new Date().toISOString(),
        },
      },
      liveIds: null,
      lock,
    });
    if (verified) {
      return {
        workspaceId: preview.workspaceId,
        agentId,
        applied: true,
        route: "apply-here",
        verified: true,
        current: actual,
        detail: "Settings applied here.",
      };
    }
    const { applied, missing } = describeWrites(writes, actual, preview.requested);
    const firstError = writes.find((write) => write.error)?.error ?? "the provider refused the write";
    return {
      workspaceId: preview.workspaceId,
      agentId,
      applied: true,
      route: "apply-here",
      verified: false,
      current: actual,
      deliveryError: firstError,
      detail: applied.length
        ? `Settings partly applied (${applied.join(", ")}). Missing: ${missing.join(", ")} (${firstError}). Retry from the preview.`
        : `Settings not applied (${firstError}). Nothing changed.`,
    };
  }

  // Refresh route: bound rewind (no silent fallback), then apply and
  // verify, then deliver or stage the brief. Any failure keeps the brief.
  const checkPrivacy = () => requireFreshPrivacy({ client: paseo, workspaceId: preview.workspaceId,
    scopeId: null, epoch: preview.epoch, agentId,
    admitTarget: (agent: any) => readPrivacyAdmission(agent, { ...deps, paseo }, preview.workspaceId),
  });
  await checkPrivacy();
  if (!deps.buildBrief) throw new Error("Settings refresh needs a brief builder (server misconfiguration).");
  const brief = await deps.buildBrief(paseo, preview.workspaceId, agentId);
  const stage = async () => {
    const identity = await stageSteerBrief(paseo, { workspaceId: preview.workspaceId, agentId, packet: brief, kind: "settings", epoch: preview.epoch }, { lock });
    try {
      await checkPrivacy();
      return { ...identity, packet: brief, packetChars: brief.length };
    } catch (error) {
      if (!(error instanceof SwitchRefused)) throw error;
      return {};
    }
  };
  const previousBriefId = typeof asRecord(actionFact(checked.entry, "refreshed"))?.briefMessageId === "string"
    ? (asRecord(actionFact(checked.entry, "refreshed"))?.briefMessageId as string)
    : null;
  const outcome = await rewindBrief(agentId, brief, {
    createClient: deps.rewindClient ?? defaultClientFactory,
    previousBriefId,
    skipBrief: true,
    beforeRewind: async () => { await checkPrivacy(); return true; },
  });
  if (outcome?.status !== "rewound") {
    const status = typeof outcome?.status === "string" ? outcome.status : "failed";
    const reason = typeof outcome?.error === "string" && outcome.error ? `: ${outcome.error}` : "";
    try {
      await stage();
    } catch {
      // Staging is best-effort; the message below still keeps the brief.
    }
    throw new Error(
      `Bound rewind route failed (${status}${reason}); nothing recorded, no new agent created. The brief is staged for this tab; open Review brief in Factory.`,
    );
  }
  const { writes, actual, actualSessionId, verified } = await writeTuple(
    paseo,
    agentId,
    preview.current,
    preview.requested,
    deps,
  );
  const record = buildRecord({
    checkpoint: null,
    messageId: outcome.messageId ?? null,
    briefMessageId: null,
    now: deps.now ? () => new Date(deps.now!()) : () => new Date(),
  });
  const baseline = buildBaseline({
    provider: actual.provider,
    model: actual.model,
    thinking: actual.thinking,
    speed: actual.speed,
    sessionId: actualSessionId ?? preview.sessionId,
    turnId: null,
    at: deps.now ? deps.now() : new Date().toISOString(),
  });
  await updateEntry({
    client: paseo,
    workspaceId: preview.workspaceId,
    agentId,
    patch: {
      ...record,
      ...(baseline ? { settingsBaseline: baseline } : {}),
      settingsConfirmed: {
        provider: preview.requested.provider,
        model: preview.requested.model,
        thinking: preview.requested.thinking,
        speed: preview.requested.speed,
        fingerprint: input.fingerprint,
        at: deps.now ? deps.now() : new Date().toISOString(),
      },
      settingsRefresh: { fingerprint: input.fingerprint, at: deps.now ? deps.now() : new Date().toISOString() },
    },
    liveIds: null,
    lock,
  });
  if (!verified) {
    const stagedPacket = await stage().catch(() => ({}));
    const { applied, missing } = describeWrites(writes, actual, preview.requested);
    const firstError = writes.find((write) => write.error)?.error ?? "the provider refused the write";
    return {
      workspaceId: preview.workspaceId,
      agentId,
      applied: true,
      route: "refresh",
      verified: false,
      current: actual,
      delivered: false,
      staged: true,
      stagedTo: agentId,
      ...stagedPacket,
      deliveryError: firstError,
      detail: applied.length
        ? `Chat rewound, but settings partly applied (${applied.join(", ")}). Missing: ${missing.join(", ")} (${firstError}). The brief is staged; retry settings, then initialize.`
        : `Chat rewound, but settings not applied (${firstError}). The brief is staged; retry settings, then initialize.`,
    };
  }
  if (input.deliver === "stage") {
    const stagedPacket = await stage();
    return {
      workspaceId: preview.workspaceId,
      agentId,
      applied: true,
      route: "refresh",
      verified: true,
      current: actual,
      delivered: false,
      staged: true,
      stagedTo: agentId,
      ...stagedPacket,
      detail: "Chat rewound and settings applied. The brief is staged.",
    };
  }
  try {
    await sendBriefAsUser(paseo, agentId, brief, deps, checkPrivacy);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stagedPacket = await stage().catch(() => ({}));
    return {
      workspaceId: preview.workspaceId,
      agentId,
      applied: true,
      route: "refresh",
      verified: true,
      current: actual,
      delivered: false,
      staged: true,
      stagedTo: agentId,
      ...stagedPacket,
      deliveryError: message,
      detail: `Chat rewound and settings applied, but the brief did not go out (${message}). It is staged; retry the delivery.`,
    };
  }
  return {
    workspaceId: preview.workspaceId,
    agentId,
    applied: true,
    route: "refresh",
    verified: true,
    current: actual,
    delivered: true,
    staged: false,
    packet: brief,
    packetChars: brief.length,
    detail: "Chat rewound and settings applied. Brief sent.",
  };
}

export interface SettingsRevertInput {
  workspaceId: string;
  agentId: string;
  observed: {
    provider?: string | null;
    model?: string | null;
    thinking?: string | null;
    speed?: string | null;
    sessionId?: string | null;
  };
}

/**
 * Restores the turn-end baseline after an observed external change. Refuses
 * when the tab is busy, when no comparable baseline exists, when the live
 * tuple already matches the baseline (already reverted), or when the live
 * tuple no longer equals the observed change (a newer change needs review
 * first). Verifies the restored tuple after the write.
 */
export async function revertSteerSettings(
  paseo: any,
  input: SettingsRevertInput,
  deps: SteerSettingsDeps = {},
): Promise<{
  agentId: string;
  applied: boolean;
  verified: boolean;
  restored: SettingsTuple;
  detail: string;
}> {
  const agentId = input.agentId.trim();
  const lock = deps.lock ?? takeLock;
  const { agent, mainId, entry } = await steerScope(paseo, input.workspaceId, agentId);
  const { tuple: live, sessionId: liveSessionId } = liveTupleOf(agent);
  const baselineRaw = asRecord(entry?.settingsBaseline);
  const baselineSession = typeof baselineRaw?.sessionId === "string" && baselineRaw.sessionId
    ? baselineRaw.sessionId
    : null;
  if (!baselineRaw || !baselineSession || baselineSession !== liveSessionId) {
    throw new Error("No comparable settings baseline for this tab.");
  }
  const baseline: SettingsTuple = {
    provider: normalizeProvider(baselineRaw.provider),
    model: normalizeModel(baselineRaw.model),
    thinking: normalizeThinking(baselineRaw.thinking),
    speed: typeof baselineRaw.speed === "string" && baselineRaw.speed.trim()
      ? baselineRaw.speed.trim().toLowerCase()
      : null,
  };
  if (tuplesEqual(live, baseline)) {
    return { agentId, applied: false, verified: true, restored: baseline, detail: "Settings already match the baseline." };
  }
  const observed = tupleFromLive({
    provider: input.observed?.provider ?? null,
    model: input.observed?.model ?? null,
    thinking: input.observed?.thinking ?? null,
    speed: input.observed?.speed ?? null,
  });
  const observedSession = typeof input.observed?.sessionId === "string" ? input.observed.sessionId : null;
  if (observedSession !== liveSessionId || !tuplesEqual(live, observed)) {
    throw new Error("Settings changed again. Review before reverting.");
  }

  await lock(lockName(mainId), async (held: { verify: () => void }) => {
    const snap = await paseo.agents.ref(agentId).refresh().catch(() => null);
    const current = snap?.agent ?? null;
    if (!current) throw new Error(`Unknown agent ${JSON.stringify(agentId)}`);
    const status = typeof current.status === "string" ? current.status : "";
    if (status === "running" || status === "initializing") {
      throw new Error("This steer is running. Wait for the turn to end, then revert.");
    }
    if (Array.isArray(current.pendingPermissions) && current.pendingPermissions.length > 0) {
      throw new Error("A permission request is waiting. Answer it first, then revert.");
    }
    const fresh = liveTupleOf(current);
    if (fresh.sessionId !== liveSessionId || !tuplesEqual(fresh.tuple, observed)) {
      throw new Error("Settings changed again. Review before reverting.");
    }
    held.verify();
  });

  const { actual, actualSessionId, verified } = await writeTuple(paseo, agentId, live, baseline, deps);
  const restored = buildBaseline({
    provider: actual.provider,
    model: actual.model,
    thinking: actual.thinking,
    speed: actual.speed,
    sessionId: actualSessionId ?? liveSessionId,
    turnId: null,
    at: deps.now ? deps.now() : new Date().toISOString(),
  });
  await updateEntry({
    client: paseo,
    workspaceId: mainId,
    agentId,
    patch: {
      ...(restored ? { settingsBaseline: restored } : {}),
      settingsConfirmed: {
        provider: baseline.provider,
        model: baseline.model,
        thinking: baseline.thinking,
        speed: baseline.speed,
        fingerprint: "revert",
        at: deps.now ? deps.now() : new Date().toISOString(),
      },
    },
    liveIds: null,
    lock,
  });
  if (!verified) {
    throw new Error("Revert applied, but the restored settings do not verify. Review before retrying.");
  }
  return { agentId, applied: true, verified: true, restored: baseline, detail: "Settings reverted." };
}
