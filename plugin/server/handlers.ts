import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  factoryApply,
  factoryAssign,
  factoryAssignPreview,
  factoryCheckpoint,
  factoryCheckpointPreview,
  factoryCleanup,
  factoryDrain,
  factoryFresh,
  factoryFreshPreview,
  factoryHistoryOpen,
  factoryModelsCatalog,
  factoryPlan,
  factoryResume,
  factoryResumeApply,
  factoryScopes,
  factoryScopesCandidates,
  factoryStatus,
  factorySteerBrief,
  factorySwitch,
  factorySwitchPreview,
  factorySteerAdd,
  factorySteerAddPreview,
  factorySteerSettings,
  factorySteerSettingsPreview,
  factorySteerSettingsRevert,
  factoryWorkerList,
  factoryWorkerPick,
  factoryWorkerStart,
  factoryWorkers,
} from "../shared/factory.js";
import {
  assignFingerprint,
  checkpointFingerprint,
  freshFingerprint,
  isPlanHash,
  steerAddFingerprint,
  switchFingerprint,
} from "../shared/preview.js";
import {
  applyPlanDomain,
  applyPlanMain,
  applyPlanName,
  normalizePlanAdopt,
  normalizePlanAdoptWorker,
} from "../shared/factory-args.js";
import {
  applyPlans,
  createAuthorization,
  createExecutors,
  fileProgress,
  storeAuthorization,
  withApplyLock,
} from "./core/apply.mjs";
import { assignScope } from "./core/assign.mjs";
import { liveSlotHolders } from "./core/discovery.mjs";
import {
  attachProjectArchivedAgents,
  collectCleanupCandidates,
} from "./core/cleanup.mjs";
import { isAdvisorSlot, isSensitiveProfile, workerPriority } from "./core/config.mjs";
import { DRAIN_DEFAULT_TIMEOUT_MS, drain, parseTimeout } from "./core/drain.mjs";
import { createRunner } from "./core/factory.mjs";
import { createGh } from "./core/github.mjs";
import { createGit } from "./core/local.mjs";
import { formatCatalog, paseoRunFlags, resolveProfile, resolveWorkerPick, usedProfilesByLiveSteers, workerListRows, workerModelLine } from "./core/models.mjs";
import { QUOTA_DEFAULTS, readProfileHealth, storeProfileFailure } from "./core/quota.mjs";
import { applySteerAdd, formatSteerAddPreview, planSteerAdd } from "./core/steer-add.mjs";
import { planHash } from "./core/planner.mjs";
import { defaultCreateRewindClient } from "./core/rewind.mjs";
import { deliverSteerBrief, stageSteerBrief } from "./steer-brief.js";
import { formatWorkersPruneText, formatWorkersText, pruneWorkerRegister, readWorkers, staleWorkerEntries, workersReport } from "./core/supervision.mjs";
import { discoveryScopeAliases } from "./core/scope-guard.mjs";
import { startScopedWorker } from "./core/workers.mjs";
import { formatStatus, scopeCandidates, scopeRows } from "./core/scopes-view.mjs";
import {
  LABEL,
  METADATA_KEY,
  createPaseoCli,
  daemonPassword,
  lookupCreationReceipt,
  paseoBinary,
  readPaseoState,
} from "./core/paseo.mjs";
import { daemonHost, runtime } from "./core/runtime.mjs";
import { applyResume } from "./resume-apply.js";
import { deliverSteer, type SteerDeliveryDeps } from "./steer-delivery.js";
import { defaultPickAddress, listScopes } from "./core/scope.mjs";
import { AGENTS_KEY } from "./core/agent-state.mjs";
import {
  buildResumeBrief,
  freshSteer,
  lastAssistantText,
  parseCheckpointBlock,
  readGitBrief,
  resolveTargetEntry,
  restartInterruptions,
  steerStatus,
  switchSteer,
  workerResumeAnswer,
  writeCheckpoint,
} from "./core/steer.mjs";
import type { ConfigLoader, HostSettingsReader } from "./config.js";
import { getQuotaSampledAt, getQuotaSnapshot } from "./quota.js";
import { settingsFromConfig, validateFactorySettings, type FactorySettingsValues } from "../shared/settings-validate.js";
import { readZerosubStateSafe } from "./zerosub-runtime.js";
import { workerIdentityFromMetadata } from "../shared/supervise.js";
import { filterStaleWorkerEvents } from "./worker-wakes.js";
import { loadCatalog } from "./models-rpc.js";
import { applySteerSettings, previewSteerSettings, revertSteerSettings } from "./steer-settings.js";

function workspaceIdFromAddress(address: string): string | null {
  const prefixed = address.match(/^(?:workspace|worktree)\s*:\s*(.+)$/i);
  if (prefixed) return prefixed[1].trim() || null;
  if (/^wks_[A-Za-z0-9]+$/.test(address)) return address;
  return null;
}

/** Scope id of one agent snapshot: scope/repo labels, else worker metadata. */
function agentScopeId(agent: any): string | null {
  const id = agent?.labels?.[LABEL.scope] ?? agent?.labels?.[LABEL.repo] ?? workerIdentityFromMetadata(agent)?.scopeId;
  return typeof id === "string" && id ? id : null;
}

/**
 * Resolves a scope address like the CLI (scope id, wks_ id, path, legacy
 * local/ alias), or the scope of the current workspace when no address is
 * given. A workspace without a scope gets a clear message plus the plan
 * call that would adopt it; anything else passes through to legacy discovery.
 * Callers pass their snapshot so each RPC reads the daemon state once.
 */
async function resolveEntryForAddress(
  paseo: any,
  repo: string | undefined,
  workspaceId: string | undefined,
  state?: any,
): Promise<{ target: any; scope: any; deprecatedAlias: boolean }> {
  const address = repo?.trim() || (workspaceId ? `workspace:${workspaceId}` : "");
  if (!address) {
    throw new Error(
      "Which project? Pass a scope address (owner/repo, scope id, wks_… or folder path), or run the command inside a workspace.",
    );
  }
  const paseoState: any = state ?? (await readPaseoState(paseo));
  const resolved: any = resolveTargetEntry(address, paseoState);
  if (!resolved.scope) {
    const wid = workspaceIdFromAddress(address);
    const ws = wid ? paseoState.workspaces.find((w: any) => w.id === wid) : null;
    if (wid && !ws) throw new Error(
        `Unknown workspace ${JSON.stringify(wid)}. Check the id, or run /factory scopes to see the managed projects.`,
      );
    if (ws) {
      const title = ws.title ?? ws.name ?? ws.id;
      const suggestion =
        scopeCandidates(paseoState, { factoryCmd: "/factory" }).find((c: any) => c.workspaceId === ws.id)?.suggestedPlan ??
        `/factory plan workspace:${ws.id}`;
      throw new Error(
        `Workspace "${title}" is not managed by the factory yet. To set it up, preview a plan: ${suggestion}`,
      );
    }
  }
  return {
    target: resolved.entry,
    scope: resolved.scope ? { id: resolved.scope.id, kind: resolved.scope.kind } : null,
    deprecatedAlias: resolved.deprecatedAlias === true,
  };
}

export async function getStatus(
  input: RpcInput<typeof factoryStatus>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
): Promise<any> {
  const { config, scope, deprecatedAlias, status } = await discoverOne(
    paseo,
    loader,
    input.repo,
    input.workspaceId,
    input.agentId ?? null,
  );
  return {
    ...status,
    scope,
    deprecatedAlias,
    text: (formatStatus as any)(status, config.usage?.warnContextTokens),
  };
}

export async function getScopes(
  _input: RpcInput<typeof factoryScopes>,
  { paseo }: PluginHandlerContext,
): Promise<any> {
  return { rows: scopeRows(await readPaseoState(paseo)) };
}

export async function getScopeCandidates(
  _input: RpcInput<typeof factoryScopesCandidates>,
  { paseo }: PluginHandlerContext,
): Promise<any> {
  return { rows: scopeCandidates(await readPaseoState(paseo), { factoryCmd: "/factory" }) };
}

export async function getCleanup(
  _input: RpcInput<typeof factoryCleanup>,
  { paseo }: PluginHandlerContext,
): Promise<any> {
  const cleanupOptions: any = { git: createGit() };
  return { candidates: collectCleanupCandidates(await readPaseoState(paseo), cleanupOptions) };
}

export async function getResume(
  input: RpcInput<typeof factoryResume>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
): Promise<any> {
  const agentId = input.agentId?.trim() || null;
  const { config, discovery, scope, deprecatedAlias, status } = await discoverOne(paseo, loader, input.repo?.trim() || undefined, input.workspaceId, agentId);
  const git = createGit();
  const agentState = discovery.mainWorkspace?.metadata?.[AGENTS_KEY] ?? null;
  const briefOptions: any = {
    agentId,
    workerLastAnswer: await workerResumeAnswer(paseo, status, agentId),
    promptOptions: await loader.loadPromptOptions(paseo),
    agentState,
    git: status.workspace ? readGitBrief(git, status.workspace.directory) : null,
    scope: discovery.scope ?? scope ?? null,
    config,
    workerModel: (workerModelLine as any)(config, discovery),
    quotaSnapshot: getQuotaSnapshot(),
    quotaWarnPct: config.quota?.warnPct ?? QUOTA_DEFAULTS.warnPct,
  };
  const brief: string = buildResumeBrief(status, briefOptions);
  const restartInterrupted = status.restartInterrupted ?? restartInterruptions({ checkpoint: status.checkpoint, agentState });
  return {
    scope: scope?.id ?? status.repo,
    kind: scope?.kind ?? null,
    epoch: status.state?.epoch ?? null,
    agentId,
    brief,
    openWorkers: status.openWorkers ?? [],
    interrupted: status.checkpoint?.interrupted ?? null,
    ...(restartInterrupted.length ? { restartInterrupted } : {}),
    deprecatedAlias,
    scopeInfo: scope,
  };
}

/**
 * Builds the resume brief for one agent (shared by the resume RPC and the
 * turn hook, which sends the brief after a verified resume clear). Scope
 * resolution mirrors getResume: the agent's scope label wins, else the
 * workspace address.
 */
export function createResumeBriefBuilder(loader: ConfigLoader) {
  return async (paseo: any, workspaceId: string, agentId: string): Promise<string> => {
    const { discovery, scope, status } = await discoverOne(paseo, loader, undefined, workspaceId, agentId);
    const metadata = discovery.mainWorkspace?.metadata;
    status.openWorkers = await filterStaleWorkerEvents(paseo, metadata,
      (status.openWorkers ?? []).map((entry: any) => ({ ...entry, workerId: entry.id })));
    const git = createGit();
    const briefOptions: any = {
      agentId,
      workerLastAnswer: await workerResumeAnswer(paseo, status, agentId),
      promptOptions: await loader.loadPromptOptions(paseo),
      agentState: metadata?.[AGENTS_KEY] ?? null,
      git: status.workspace ? readGitBrief(git, status.workspace.directory) : null,
      scope: discovery.scope ?? scope ?? null,
    };
    return buildResumeBrief(status, briefOptions);
  };
}

export async function applyResumeRpc(
  input: RpcInput<typeof factoryResumeApply>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
  extra?: SteerDeliveryDeps,
): Promise<any> {
  let tookOver: { from: string; to: string; epoch: number } | null = null;
  let takeoverSkipped: string | null = null;
  const applied = await applyResume(
    paseo,
    {
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      ...(input.fingerprint ? { fingerprint: input.fingerprint } : {}),
    },
    {
      ...extra,
      getConfig: () => loader.loadEffectiveConfig(),
      buildBrief: extra?.buildBrief ?? createResumeBriefBuilder(loader),
      refreshWorker: async (workspaceId, workerId) => {
        const { config, discovery } = await discoverOne(paseo, loader, undefined, workspaceId);
        const git = createGit();
        return freshSteer({
          client: paseo, discovery, config, workerId, git,
          apply: true, notifyPrevious: false,
          lookupReceipt: lookupCreationReceipt,
          execute: createExecutors({ client: paseo, paseoCli: createPaseoCli() }),
          rewindClient: extra?.rewindClient ?? defaultCreateRewindClient,
          promptOptions: await loader.loadPromptOptions(paseo),
        } as any);
      },
      beforeDelivery: input.takeover === true ? async () => {
        try {
          tookOver = await takeoverIfNonActive(paseo, loader, input.agentId);
        } catch (error) {
          takeoverSkipped = error instanceof Error ? error.message : String(error);
        }
      } : undefined,
    },
  );
  const switched = tookOver as { from: string; to: string; epoch: number } | null;
  return {
    ...applied,
    tookOver,
    takeoverSkipped,
    detail:
      `${applied.detail}` +
      (switched ? ` Steer ${switched.to} is now in charge (was ${switched.from}, round ${switched.epoch}).` : "") +
      (takeoverSkipped ? ` Takeover skipped: ${takeoverSkipped}` : ""),
  };
}

/**
 * Self-takeover after a resume: makes the steer the active one when it is
 * not. Returns null when it already is. Advisors refuse (they never
 * coordinate), as does any other switch refusal.
 */
async function takeoverIfNonActive(
  paseo: any,
  loader: ConfigLoader,
  agentId: string,
): Promise<{ from: string; to: string; epoch: number } | null> {
  const snapshot: any = await readPaseoState(paseo);
  const found: any = snapshot.agents.find((a: any) => a.id === agentId);
  const scopeId = agentScopeId(found);
  const slot = found?.labels?.[LABEL.slot];
  if (!scopeId) throw new Error("agent has no factory scope label");
  if (typeof slot !== "string" || !/^[A-Z]$/.test(slot)) throw new Error("agent has no steer slot label");
  const config = await loader.loadEffectiveConfig();
  if ((isAdvisorSlot as unknown as (c: unknown, s: string) => boolean)(config, slot)) {
    throw new Error("advisor steers never coordinate");
  }
  const { target } = await resolveEntryForAddress(paseo, scopeId, undefined, snapshot);
  const runnerOptions: any = { config, client: paseo, gh: createGh(), git: createGit() };
  const [discovery] = await createRunner(runnerOptions).discoverAll([target], { state: snapshot });
  const status: any = steerStatus(discovery);
  if (status.state?.activeSteer === slot) return null;
  const switchOptions: any = {
    client: paseo,
    discovery,
    promptOptions: await loader.loadPromptOptions(paseo),
    toSlot: slot,
    apply: true,
    send: false,
    git: createGit(),
    config,
    callerId: agentId,
    paseoCli: createPaseoCli(),
  };
  const switched: any = await switchSteer(switchOptions);
  return { from: switched.from, to: switched.to, epoch: switched.epoch };
}

export async function previewFresh(
  input: RpcInput<typeof factoryFreshPreview>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
): Promise<any> {
  const { config, discovery, scope, deprecatedAlias } = await discoverOne(
    paseo,
    loader,
    input.repo,
    input.workspaceId,
  );
  const freshOptions: any = { client: paseo, discovery, config, apply: false, slot: input.slot ?? null, git: createGit(), rewindClient: defaultCreateRewindClient, promptOptions: await loader.loadPromptOptions(paseo) };
  const dry: any = await freshSteer(freshOptions);
  return {
    repo: dry.repo,
    workspaceId: dry.workspaceId,
    slot: dry.slot,
    from: dry.from,
    epoch: dry.epoch,
    profile: dry.profile,
    provider: dry.provider,
    model: dry.model,
    packet: dry.packet,
    packetChars: dry.packetChars,
    checkpoint: dry.checkpoint,
    checkpointAt: dry.checkpointAt ?? null,
    warnings: Array.isArray(dry.warnings) ? dry.warnings : [],
    refreshMode: dry.refreshMode ?? "new-agent",
    fingerprint: freshFingerprint(freshIdentityOf(dry)),
    scope,
    deprecatedAlias,
  };
}

function freshIdentityOf(dry: any): {
  repo: string;
  workspaceId: string | null;
  slot: string;
  from: string | null;
  epoch: number;
  refreshMode: string | null;
  provider: string | null;
  model: string | null;
  checkpointAt: string | null;
} {
  return {
    repo: dry.repo,
    workspaceId: typeof dry.workspaceId === "string" ? dry.workspaceId : null,
    slot: dry.slot,
    from: typeof dry.from === "string" ? dry.from : null,
    epoch: dry.epoch,
    refreshMode: typeof dry.refreshMode === "string" ? dry.refreshMode : null,
    provider: typeof dry.provider === "string" ? dry.provider : null,
    model: typeof dry.model === "string" ? dry.model : null,
    checkpointAt: typeof dry.checkpointAt === "string" ? dry.checkpointAt : null,
  };
}

/**
 * Stages the applied packet for later delivery: on deliver=stage, or after a
 * send that was attempted and failed (partial apply: the state stands, the
 * retry stays available through factory.steer.brief). A staging failure never
 * fails the apply; it is only reported.
 */
async function stageAppliedPacket(
  paseo: any,
  args: { workspaceId: unknown; agentId: unknown; packet: unknown; kind: string; deliver: unknown; deliveryError: unknown },
): Promise<{ staged: boolean; stagedTo: string | null; stagingError: string | null }> {
  const quiet = { staged: false, stagedTo: null, stagingError: null };
  const packet = typeof args.packet === "string" && args.packet.trim() ? args.packet : null;
  const agentId = typeof args.agentId === "string" && args.agentId ? args.agentId : null;
  const workspaceId = typeof args.workspaceId === "string" && args.workspaceId ? args.workspaceId : null;
  if (!packet || !agentId || !workspaceId) return quiet;
  if (args.deliver !== "stage" && (args.deliveryError === null || args.deliveryError === undefined)) return quiet;
  try {
    await stageSteerBrief(paseo, { workspaceId, agentId, packet, kind: args.kind });
  } catch (error) {
    return { staged: false, stagedTo: null, stagingError: error instanceof Error ? error.message : String(error) };
  }
  return { staged: true, stagedTo: agentId, stagingError: null };
}

export async function applyFresh(
  input: RpcInput<typeof factoryFresh>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
): Promise<any> {
  const { config, discovery } = await discoverOne(paseo, loader, input.repo, input.workspaceId);
  const git = createGit();
  const promptOptions = await loader.loadPromptOptions(paseo);
  const dryOptions: any = { client: paseo, discovery, config, apply: false, slot: input.slot ?? null, git, rewindClient: defaultCreateRewindClient, promptOptions };
  const dry: any = await freshSteer(dryOptions);
  const fresh = freshFingerprint(freshIdentityOf(dry));
  if (fresh !== input.fingerprint) {
    throw new Error(
      "Something changed since the fresh preview (for example another switch). Open the preview again and confirm the new one.",
    );
  }
  const executeOptions: any = {
    client: paseo,
    paseoCli: createPaseoCli(),
  };
  const applyOptions: any = {
    client: paseo,
    discovery,
    promptOptions,
    config,
    apply: true,
    send: input.deliver !== "stage",
    notifyPrevious: input.notifyPrevious !== false,
    slot: input.slot ?? null,
    git,
    lookupReceipt: lookupCreationReceipt,
    execute: createExecutors(executeOptions),
    paseoCli: createPaseoCli(),
    rewindClient: defaultCreateRewindClient,
    // Step 4 binds the previewed rewind route: no silent fallback to a new
    // agent at apply time. A bound failure keeps the brief (staged below).
    ...(dry.refreshMode === "rewind" ? { requireRefreshMode: "rewind" } : {}),
  };
  let applied: any;
  try {
    applied = await freshSteer(applyOptions);
  } catch (error) {
    const packet = (error as { packet?: unknown } | null)?.packet;
    const from = typeof dry.from === "string" && dry.from ? dry.from : null;
    const workspaceId = typeof dry.workspaceId === "string" && dry.workspaceId ? dry.workspaceId : null;
    if (typeof packet === "string" && packet.trim() && from && workspaceId) {
      try {
        await stageSteerBrief(paseo, { workspaceId, agentId: from, packet, kind: "fresh" });
      } catch {
        // Staging is best-effort; the message below still keeps the brief.
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message} The brief is staged for this tab; retry from the steer menu.`);
    }
    throw error;
  }
  if (!applied.applied) return applied;
  const destination = typeof applied.to === "string" && applied.to ? applied.to : applied.from;
  return {
    ...applied,
    ...(await stageAppliedPacket(paseo, {
      workspaceId: dry.workspaceId,
      agentId: destination,
      packet: applied.packet,
      kind: "fresh",
      deliver: input.deliver,
      deliveryError: applied.deliveryError,
    })),
  };
}

export async function deliverSteerBriefRpc(
  input: RpcInput<typeof factorySteerBrief>,
  { paseo }: PluginHandlerContext,
  delivery?: SteerDeliveryDeps,
): Promise<any> {
  return deliverSteerBrief(paseo, {
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    action: input.action,
  }, delivery);
}

export interface SteerSettingsHandlerExtra {
  getCleanupSettings?: () => Promise<any>;
  getSupervisionSettings?: () => Promise<any>;
  buildBrief?: (paseo: any, workspaceId: string, agentId: string) => Promise<string>;
  getZerosub?: () => Promise<any>;
}

async function steerSettingsDeps(
  loader: ConfigLoader,
  extra?: SteerSettingsHandlerExtra,
): Promise<{
  loadCatalog: (paseo: any) => Promise<any[]>;
  getCleanupSettings?: () => Promise<any>;
  getConfig: () => Promise<any>;
  getZerosub: () => Promise<any>;
  quotaSnapshot: Record<string, any> | null;
  poolSampledAtMs: number | null;
  quotaSampleMinutes?: number;
}> {
  const supervision = extra?.getSupervisionSettings ? await extra.getSupervisionSettings().catch(() => null) : null;
  const sampleMinutes = typeof supervision?.quotaSampleMinutes === "number" ? supervision.quotaSampleMinutes : undefined;
  return {
    loadCatalog: (paseo: any) => loadCatalog(paseo),
    ...(extra?.getCleanupSettings ? { getCleanupSettings: extra.getCleanupSettings } : {}),
    getConfig: () => loader.loadEffectiveConfig(),
    getZerosub: extra?.getZerosub ?? readZerosubStateSafe,
    quotaSnapshot: getQuotaSnapshot(),
    poolSampledAtMs: getQuotaSampledAt(),
    ...(sampleMinutes !== undefined ? { quotaSampleMinutes: sampleMinutes } : {}),
  };
}

export async function previewSteerSettingsRpc(
  input: RpcInput<typeof factorySteerSettingsPreview>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
  extra?: SteerSettingsHandlerExtra,
): Promise<any> {
  return previewSteerSettings(paseo, {
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
    ...(input.speed !== undefined ? { speed: input.speed } : {}),
  }, await steerSettingsDeps(loader, extra));
}

export async function applySteerSettingsRpc(
  input: RpcInput<typeof factorySteerSettings>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
  extra?: SteerSettingsHandlerExtra,
): Promise<any> {
  const deps = await steerSettingsDeps(loader, extra);
  return applySteerSettings(paseo, {
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    fingerprint: input.fingerprint,
    route: input.route,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
    ...(input.speed !== undefined ? { speed: input.speed } : {}),
    ...(input.deliver !== undefined ? { deliver: input.deliver } : {}),
  }, {
    ...deps,
    buildBrief: extra?.buildBrief ?? createResumeBriefBuilder(loader),
    rewindClient: defaultCreateRewindClient,
    configClient: defaultCreateRewindClient,
  });
}

export async function revertSteerSettingsRpc(
  input: RpcInput<typeof factorySteerSettingsRevert>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
  extra?: SteerSettingsHandlerExtra,
): Promise<any> {
  const deps = await steerSettingsDeps(loader, extra);
  return revertSteerSettings(paseo, {
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    observed: {
      provider: input.observed?.provider ?? null,
      model: input.observed?.model ?? null,
      thinking: input.observed?.thinking ?? null,
      speed: input.observed?.speed ?? null,
      sessionId: input.observed?.sessionId ?? null,
    },
  }, {
    ...deps,
    configClient: defaultCreateRewindClient,
  });
}

export async function openHistory(
  input: RpcInput<typeof factoryHistoryOpen>,
  { paseo }: PluginHandlerContext,
): Promise<any> {
  const agentId = input.agentId.trim();
  const state: any = await readPaseoState(paseo);
  const agent: any = state.agents.find((a: any) => a.id === agentId);
  if (!agent) throw new Error(`Unknown agent ${JSON.stringify(agentId)}`);
  const scopeId = agent.labels?.[LABEL.scope] ?? agent.labels?.[LABEL.repo] ?? null;
  const scope: any = typeof scopeId === "string" && scopeId
    ? (listScopes(state) as any[]).find((s: any) => s.id === scopeId) ?? null
    : null;
  if (!scope) throw new Error(`Agent ${agentId} has no live factory scope`);
  const entries = scope.workspace?.metadata?.[AGENTS_KEY] ?? {};
  const sessions = entries[agentId]?.previousSessions;
  const sessionId = Array.isArray(sessions) && sessions.length ? sessions[sessions.length - 1] : null;
  if (typeof sessionId !== "string" || !sessionId || sessionId.startsWith("-")) {
    throw new Error(`Agent ${agentId} has no saved earlier chat to open (nothing was cleared yet).`);
  }
  const provider = typeof agent.provider === "string" && agent.provider ? agent.provider : "claude";
  // CLI import on click only (manual, additive: a new tab). Env mirrors the
  // factory CLI wrapper: no sender identity is inherited.
  const env = { ...process.env };
  delete env.PASEO_AGENT_ID;
  const password = daemonPassword();
  if (password) env.PASEO_PASSWORD = password;
  let output: string;
  try {
    output = execFileSync(
      paseoBinary(),
      ["--host", daemonHost(), "agent", "import", sessionId, "--provider", provider],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env, timeout: 120_000 },
    );
  } catch (error) {
    const detail = error instanceof Error
      ? String((error as any).stderr ?? error.message).trim()
      : String(error);
    throw new Error(`paseo agent import failed: ${detail}`);
  }
  return { agentId, sessionId, imported: true, detail: output.trim().slice(0, 500) };
}

function checkedSlots(raw: string[] | undefined, config: any): string[] | undefined {
  if (raw === undefined) return undefined;
  const slots = raw.map((s) => String(s).trim().toUpperCase()).filter(Boolean);
  for (const slot of slots) {
    if (!/^[A-Z]$/.test(slot)) throw new Error(`slots expects slot letters A-Z, got ${JSON.stringify(slot)}`);
  }
  if (new Set(slots).size !== slots.length) throw new Error("slots contains duplicates");
  for (const slot of slots) {
    if (!config.steers.slots[slot]) throw new Error(`slots names slot ${slot}, which is not defined in steers.slots`);
  }
  return slots.length ? slots : undefined;
}

export async function getPlan(
  input: RpcInput<typeof factoryPlan>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
): Promise<any> {
  const config = await loader.loadEffectiveConfig();
  const slots = checkedSlots(input.slots, config);
  const repos = input.repos ?? [];
  const localFlags = input.local ?? [];
  const hubFlags = input.hub ?? [];
  if (repos.length + localFlags.length + hubFlags.length > 1) {
    throw new Error("plan takes at most one workspace address; enroll one existing workspace at a time");
  }
  for (const flag of localFlags) {
    if (!flag?.trim()) throw new Error("--local needs a directory path");
    const abs = resolve(flag);
    try {
      if (!statSync(abs).isDirectory()) throw new Error();
    } catch {
      throw new Error(`--local path ${flag} does not exist or is not a directory`);
    }
  }
  // --hub plans a hub-kind scope, like the CLI: a directory path or a
  // worktree workspace id (workspace:<id>, worktree:<id> or bare wks_…).
  const hubEntries = hubFlags.map((flag) => {
    if (!flag?.trim()) throw new Error("--hub needs a directory path or workspace:<id>");
    const trimmed = flag.trim();
    const prefixed = trimmed.match(/^(?:workspace|worktree)\s*:\s*(.+)$/i);
    if (prefixed) {
      const workspace = prefixed[1].trim();
      if (!workspace) throw new Error(`--hub needs a workspace id, got ${flag}`);
      return { workspace, hub: true };
    }
    if (/^wks_[A-Za-z0-9]+$/.test(trimmed)) return { workspace: trimmed, hub: true };
    const abs = resolve(trimmed);
    try {
      if (!statSync(abs).isDirectory()) throw new Error();
    } catch {
      throw new Error(`--hub path ${flag} does not exist or is not a directory`);
    }
    return { local: abs, hub: true };
  });
  // No address: plan the scope of the current workspace (one shared snapshot).
  const snapshot: any = repos.length || localFlags.length || hubEntries.length ? null : await readPaseoState(paseo);
  let entries: any[] = snapshot
    ? [(await resolveEntryForAddress(paseo, undefined, input.workspaceId, snapshot)).target]
    : [...repos, ...localFlags.map((p) => ({ local: resolve(p) })), ...hubEntries];
  // Single-entry options attach in CLI order (name, main, domain); each helper
  // re-validates count and conflicts for direct RPC callers, like the CLI.
  if (input.name !== undefined) entries = applyPlanName(entries, input.name) as any[];
  if (input.main !== undefined) entries = applyPlanMain(entries, input.main) as any[];
  if (input.domain !== undefined) entries = applyPlanDomain(entries, input.domain) as any[];
  const adopt = normalizePlanAdopt(input.adopt ?? {}, entries.length);
  const adoptWorker = normalizePlanAdoptWorker(input.adoptWorker ?? {}, entries.length);
  const detach = input.detach ?? false;
  const runnerOptions: any = { config, client: paseo, gh: createGh(), git: createGit() };
  const runner = createRunner(runnerOptions);
  const planOptions: any = { adopt, adoptWorker, detach, ...(slots ? { slots } : {}), ...(snapshot ? { state: snapshot } : {}) };
  const plans = await runner.runPlans(entries, planOptions);
  const hash = planHash(plans, config);
  if (plans.some((p: any) => p.ops.length)) {
    const authOptions: any = {
      entries,
      adopt,
      adoptWorker,
      detach,
      ...(slots ? { slots } : {}),
    };
    storeAuthorization(runtime().planDir, createAuthorization(plans, config, authOptions), config);
  }
  return { hash, plans };
}

function checkedSlot(raw: string, what: string): string {
  const slot = String(raw).trim().toUpperCase();
  if (!/^[A-Z]$/.test(slot)) throw new Error(`${what} expects a single slot letter A-Z`);
  return slot;
}

/** One snapshot per RPC: config, state, scope resolution, discovery, status. Explicit address wins, else the agent's scope label, else the caller workspace. */
async function discoverOne(
  paseo: any,
  loader: ConfigLoader,
  repo: string | undefined,
  workspaceId?: string,
  agentId?: string | null,
): Promise<any> {
  const config = await loader.loadEffectiveConfig();
  const snapshot: any = await readPaseoState(paseo);
  const agent: any = agentId ? (snapshot.agents ?? []).find((a: any) => a?.id === agentId) ?? null : null;
  const workerWs = !repo && agentId && !agentScopeId(agent)
    ? (snapshot.workspaces ?? []).find((w: any) => (readWorkers as any)(w.metadata)[agentId]) ?? null
    : null;
  const address = repo?.trim() || (agent ? agentScopeId(agent) ?? (workerWs ? `workspace:${workerWs.id}` : undefined) : undefined);
  const { target, scope, deprecatedAlias } = await resolveEntryForAddress(paseo, address, workspaceId, snapshot);
  const runner = createRunner({ config, client: paseo, gh: createGh(), git: createGit() } as any);
  const [discovery] = await runner.discoverAll([target], { state: snapshot });
  return {
    config,
    runner,
    discovery,
    scope,
    deprecatedAlias,
    snapshot,
    agent,
    status: (steerStatus as any)(discovery, { config, warnContextTokens: config.usage?.warnContextTokens }),
  };
}

function switchIdentityOf(dry: any): {
  repo: string;
  workspaceId: string | null;
  from: string;
  to: string;
  fromId: string | null;
  toId: string | null;
  epoch: number;
  checkpointAt: string | null;
} {
  return {
    repo: dry.repo,
    workspaceId: typeof dry.workspaceId === "string" ? dry.workspaceId : null,
    from: dry.from,
    to: dry.to,
    fromId: typeof dry.fromId === "string" ? dry.fromId : null,
    toId: typeof dry.toId === "string" ? dry.toId : null,
    epoch: dry.epoch,
    checkpointAt: typeof dry.checkpointAt === "string" ? dry.checkpointAt : null,
  };
}

export async function previewSwitch(
  input: RpcInput<typeof factorySwitchPreview>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
): Promise<any> {
  const { config, discovery, scope, deprecatedAlias } = await discoverOne(paseo, loader, input.repo, input.workspaceId);
  const to = checkedSlot(input.to, "--to");
  const switchOptions: any = {
    client: paseo,
    discovery,
    promptOptions: await loader.loadPromptOptions(paseo),
    toSlot: to,
    apply: false,
    git: createGit(),
    config,
    workerModel: (workerModelLine as any)(config, discovery),
    callerId: input.callerId ?? null,
    language: input.language ?? runtime().handoffLanguage,
  };
  const dry: any = await switchSteer(switchOptions);
  return {
    repo: dry.repo,
    workspaceId: dry.workspaceId,
    from: dry.from,
    to: dry.to,
    fromId: dry.fromId ?? null,
    toId: dry.toId,
    epoch: dry.epoch,
    packet: dry.packet,
    packetChars: dry.packetChars,
    checkpoint: dry.checkpoint,
    checkpointAt: dry.checkpointAt ?? null,
    fingerprint: switchFingerprint(switchIdentityOf(dry)),
    scope,
    deprecatedAlias,
  };
}

export async function applySwitch(
  input: RpcInput<typeof factorySwitch>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
  delivery?: SteerDeliveryDeps,
): Promise<any> {
  const { config, discovery } = await discoverOne(paseo, loader, input.repo, input.workspaceId);
  const to = checkedSlot(input.to, "--to");
  const git = createGit();
  const promptOptions = await loader.loadPromptOptions(paseo);
  const language = input.language ?? runtime().handoffLanguage;
  const workerModel = (workerModelLine as any)(config, discovery);
  const callerId = input.callerId ?? null;
  const dryOptions: any = { client: paseo, discovery, promptOptions, toSlot: to, apply: false, git, config, workerModel, callerId, language };
  const dry: any = await switchSteer(dryOptions);
  const fresh = switchFingerprint(switchIdentityOf(dry));
  if (fresh !== input.fingerprint) {
    throw new Error(
      "Something changed since the switch preview (for example another switch or checkpoint). Run /factory switch again and confirm the new preview.",
    );
  }
  const applyOptions: any = {
    client: paseo,
    discovery,
    promptOptions,
    config,
    toSlot: to,
    apply: true,
    send: input.deliver !== "stage" && input.deliver !== "none",
    stage: input.deliver === "stage",
    notifyPrevious: input.notifyPrevious === true,
    wait: input.wait === true,
    callerId,
    language,
    workerModel,
    git,
    paseoCli: createPaseoCli(),
    deliverSteer: (args: Parameters<typeof deliverSteer>[1]) => deliverSteer(paseo, args, {
      ...delivery, buildBrief: delivery?.buildBrief ?? createResumeBriefBuilder(loader),
    }),
  };
  const applied: any = await switchSteer(applyOptions);
  if (applied.applied && input.deliver === "stage") return { ...applied, staged: true, stagedTo: applied.toId, stagingError: null };
  if (!applied.applied || applied.deliveryPending || applied.deliveryBlocked) return applied;
  return {
    ...applied,
    ...(await stageAppliedPacket(paseo, {
      workspaceId: dry.workspaceId,
      agentId: dry.toId,
      packet: applied.packet,
      kind: "switch",
      deliver: input.deliver,
      deliveryError: applied.deliveryError,
    })),
  };
}

interface CheckpointArgs {
  task?: string;
  fromAgent?: string;
  fromSteer?: string;
  tests?: string[];
  blockers?: string[];
  next?: string;
}

async function resolveCheckpointFields(
  paseo: any,
  status: any,
  discovery: any,
  input: CheckpointArgs,
): Promise<{ task: string; tests: string[]; blockers: string[]; next: string | null; agentId?: string }> {
  const hasTask = typeof input.task === "string" && input.task.trim() !== "";
  const hasAgent = typeof input.fromAgent === "string" && input.fromAgent.trim() !== "";
  const hasSteer = typeof input.fromSteer === "string" && input.fromSteer.trim() !== "";
  if ((hasTask ? 1 : 0) + (hasAgent ? 1 : 0) + (hasSteer ? 1 : 0) !== 1) {
    throw new Error("checkpoint needs exactly one of a task, --from-steer or --from-agent");
  }
  if (hasAgent || hasSteer) {
    let steer: any;
    if (hasSteer) {
      const slot = (input.fromSteer as string).trim().toUpperCase();
      const matches = (liveSlotHolders as any)(status.steers, slot);
      if (matches.length > 1) throw new Error(`Steer ${slot} has several live agents`);
      steer = matches[0];
      if (!steer) throw new Error(`Steer ${slot} is not a live steer of ${discovery.forkName}`);
    } else {
      const ref = (input.fromAgent as string).trim();
      const matches = status.steers.filter((s: any) => s.id === ref || s.id.startsWith(ref));
      if (matches.length > 1) throw new Error(`${ref} matches several steers; use the full agent id`);
      steer = matches[0];
      if (!steer) throw new Error(`${ref} is not a steer of ${discovery.forkName}`);
    }
    const text = lastAssistantText(
      await paseo.agents.ref(steer.id).timeline.refetch({ direction: "tail", limit: 20 }),
    );
    const fields: any = parseCheckpointBlock(text);
    if (!fields) {
      throw new Error(`The last answer of Steer ${steer.slot} has no CHECKPOINT block with a task line`);
    }
    return {
      agentId: steer.id,
      task: fields.task,
      tests: fields.tests ?? [],
      blockers: fields.blockers ?? [],
      next: input.next?.trim() ? (input.next as string).trim() : (fields.next ?? null),
    };
  }
  return {
    task: (input.task as string).trim(),
    tests: input.tests ?? [],
    blockers: input.blockers ?? [],
    next: input.next?.trim() ? (input.next as string).trim() : null,
  };
}

export async function previewCheckpoint(
  input: RpcInput<typeof factoryCheckpointPreview>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
): Promise<any> {
  const { discovery, scope, deprecatedAlias, status } = await discoverOne(paseo, loader, input.repo, input.workspaceId);
  if (!status.workspace || !status.state) {
    throw new Error(
      "This project is not set up by the factory yet (no main workspace with steers). Run /factory plan, then /factory apply <hash>.",
    );
  }
  const fields = await resolveCheckpointFields(paseo, status, discovery, input);
  const epoch = status.state.epoch ?? null;
  return {
    repo: status.repo,
    workspaceId: status.workspace.id,
    epoch,
    fields,
    scope,
    deprecatedAlias,
    fingerprint: checkpointFingerprint({
      repo: status.repo,
      workspaceId: status.workspace.id,
      epoch,
      agentId: fields.agentId ?? null,
      holderId: (liveSlotHolders as any)(status.steers, status.state.activeSteer).map((s: any) => s.id).join(","),
      task: fields.task,
      tests: fields.tests,
      blockers: fields.blockers,
      next: fields.next,
    }),
  };
}

export async function writeCheckpointRpc(
  input: RpcInput<typeof factoryCheckpoint>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
): Promise<any> {
  const { config, discovery, status } = await discoverOne(paseo, loader, input.repo, input.workspaceId);
  if (!status.workspace || !status.state) {
    throw new Error(
      "This project is not set up by the factory yet (no main workspace with steers). Run /factory plan, then /factory apply <hash>.",
    );
  }
  const fields = await resolveCheckpointFields(paseo, status, discovery, input);
  const epoch = status.state.epoch ?? null;
  const fresh = checkpointFingerprint({
    repo: status.repo,
    workspaceId: status.workspace.id,
    epoch,
    agentId: fields.agentId ?? null,
    holderId: (liveSlotHolders as any)(status.steers, status.state.activeSteer).map((s: any) => s.id).join(","),
    task: fields.task,
    tests: fields.tests,
    blockers: fields.blockers,
    next: fields.next,
  });
  if (fresh !== input.fingerprint) {
    throw new Error(
      "Something changed since the checkpoint preview (steer state or the agent's answer). Run /factory checkpoint again and confirm the new preview.",
    );
  }
  const writeOptions: any = {
    client: paseo,
    discovery,
    config,
    ...fields,
    ...(input.callerId ? { callerId: input.callerId } : {}),
  };
  const checkpoint = await writeCheckpoint(writeOptions);
  return { checkpoint };
}

export async function applyPlan(
  input: RpcInput<typeof factoryApply>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
): Promise<any> {
  if (!isPlanHash(input.hash)) {
    throw new Error("apply needs the 16-character plan hash shown at the end of /factory plan");
  }
  const config = await loader.loadEffectiveConfig();
  const planDir = runtime().planDir;
  const journalDir = runtime().journalDir;
  const lockOptions: any = undefined;
  const result: any = await withApplyLock(async (held: any) => {
    let authorization: any;
    try {
      authorization = JSON.parse(readFileSync(join(planDir, `${input.hash}.json`), "utf8"));
    } catch {
      throw new Error(
        `No saved plan with hash ${input.hash}. Run /factory plan, check the preview, then apply the hash it shows.`,
      );
    }
    if (authorization?.kind === "cleanup") {
      throw new Error(
        "This is a stored cleanup plan, and cleanup plans are no longer applied; use the read-only cleanup report and archive natively (paseo archive, paseo workspace archive, paseo project delete).",
      );
    }
    mkdirSync(journalDir, { recursive: true, mode: 0o700 });
    const journalFile = join(journalDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
    const executeOptions: any = {
      client: paseo,
      paseoCli: createPaseoCli(),
    };
    const applyOptions: any = {
      authorization,
      config,
      confirm: input.hash,
      lookupReceipt: lookupCreationReceipt,
      progress: fileProgress(join(planDir, `${input.hash}.progress.json`)),
      guard: () => held.verify(),
      runPlans: (list: any, options: any) => {
        const runnerOptions: any = { config, client: paseo, gh: createGh(), git: createGit() };
        return createRunner(runnerOptions).runPlans(list, options);
      },
      execute: createExecutors(executeOptions),
      journal: (event: any) => {
        held.verify();
        appendFileSync(journalFile, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, {
          mode: 0o600,
        });
      },
    };
    const outcome: any = await applyPlans(applyOptions);
    held.verify();
    return { ...outcome, journal: journalFile };
  }, lockOptions);
  return result;
}

export async function getModelsCatalog(
  _input: RpcInput<typeof factoryModelsCatalog>,
  { paseo }: PluginHandlerContext,
): Promise<any> {
  const entries = ((await paseo.providers.snapshot()) as any)?.entries ?? [];
  return { text: (formatCatalog as any)(entries) };
}

export async function getWorkers(
  input: RpcInput<typeof factoryWorkers>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
): Promise<any> {
  const { discovery, scope, deprecatedAlias, status } = await discoverOne(
    paseo,
    loader,
    input.repo,
    input.workspaceId,
    input.agentId ?? null,
  );
  const scopeId = discovery.scope?.id ?? status.repo;
  const epoch = discovery.mainWorkspace?.metadata?.[METADATA_KEY]?.epoch ?? null;
  if (input.prune) {
    const stale = (staleWorkerEntries as any)((readWorkers as any)(discovery.mainWorkspace?.metadata ?? null), discovery.agents ?? []);
    if (!input.apply) {
      return {
        scope: scopeId,
        epoch,
        stale,
        applied: false,
        deprecatedAlias,
        scopeInfo: scope,
        text: (formatWorkersPruneText as any)(scopeId, epoch, stale),
      };
    }
    if (!discovery.mainWorkspace) {
      throw new Error("workers --prune --apply needs a factory main workspace with worker state");
    }
    const pruned: any = await (pruneWorkerRegister as any)({
      client: paseo,
      workspaceId: discovery.mainWorkspace.id,
      agents: discovery.agents ?? [],
    });
    return {
      scope: scopeId,
      epoch,
      removed: pruned.removed,
      applied: true,
      deprecatedAlias,
      scopeInfo: scope,
      text: (formatWorkersPruneText as any)(scopeId, epoch, pruned.removed, { applied: true }),
    };
  }
  const report = (workersReport as any)((readWorkers as any)(discovery.mainWorkspace?.metadata ?? null));
  return {
    scope: scopeId,
    epoch,
    workers: report,
    deprecatedAlias,
    scopeInfo: scope,
    text: (formatWorkersText as any)(scopeId, epoch, report),
  };
}

export interface ZerosubHandlerExtra {
  getZerosub?: () => Promise<any>;
}

async function readHandlerZerosub(extra?: ZerosubHandlerExtra): Promise<any> {
  const reader = extra?.getZerosub ?? readZerosubStateSafe;
  try {
    return await reader();
  } catch {
    return null;
  }
}

async function resolveWorkerSelection(
  paseo: any,
  loader: ConfigLoader,
  input: { repo?: string; workspaceId?: string; agentId?: string; cwd?: string; failed?: string; reason?: string },
  extra?: ZerosubHandlerExtra,
): Promise<any> {
  if (input.failed !== undefined && !input.reason) {
    throw new Error("worker pick --failed needs --reason <text>");
  }
  if (input.reason !== undefined && input.failed === undefined) {
    throw new Error("worker pick --reason needs --failed <profile>");
  }
  const config = await loader.loadEffectiveConfig();
  const snapshot: any = await readPaseoState(paseo);
  const scopeAddress = input.repo?.trim() || (defaultPickAddress as any)(snapshot, {
    agentId: input.agentId,
    workspaceId: input.workspaceId,
    cwd: input.cwd ?? null,
  });
  let entries: any[];
  let repoPublic: boolean | null = null;
  let discovery: any = null;
  let scope: any = null;
  if (scopeAddress) {
    const resolved: any = resolveTargetEntry(scopeAddress, snapshot);
    scope = resolved.scope;
    const runner = createRunner({ config, client: paseo, gh: createGh(), git: createGit() } as any);
    [discovery] = await runner.discoverAll([resolved.entry], { state: snapshot });
    entries = discovery.providers ?? [];
    let priv = discovery.github?.fork?.repo?.private;
    const parent = scope?.parent ?? discovery.scope?.parent;
    const parentAddress = parent?.kind === "github"
      ? parent.id
      : typeof parent === "string"
        ? parent
        : scopeAddress.includes("@")
          ? scopeAddress.split("@")[0]
          : null;
    if (priv === undefined && parentAddress && parentAddress !== scopeAddress) {
      try {
        const parentResolved: any = resolveTargetEntry(parentAddress, snapshot);
        const [parentDiscovery] = await runner.discoverAll([parentResolved.entry], { state: snapshot });
        priv = parentDiscovery?.github?.fork?.repo?.private;
      } catch {
        // unknown stays unknown (fail-closed)
      }
    }
    repoPublic = priv === false ? true : priv === true ? false : null;
  } else {
    entries = snapshot.providers ?? [];
  }
  let profileHealth = readProfileHealth(discovery?.mainWorkspace?.metadata);
  if (input.failed !== undefined) {
    if (!scopeAddress) throw new Error("worker pick --failed needs a scope so the failure can be recorded");
    const failed = config.profiles?.[input.failed];
    if (!failed) throw new Error(`Unknown profile "${input.failed}"`);
    if (!discovery?.mainWorkspace) {
      throw new Error("worker pick --failed needs a factory main workspace with worker state");
    }
    const record: any = await (storeProfileFailure as any)({
      client: paseo,
      workspaceId: discovery.mainWorkspace.id,
      profile: { ...failed, name: input.failed },
      text: input.reason,
    });
    profileHealth = { ...(profileHealth ?? {}), [record.profile]: record };
  }
  const zerosub = await readHandlerZerosub(extra);
  const selection: any = (resolveWorkerPick as any)(config, entries, {
    repoPublic,
    profileHealth,
    zerosub,
  });
  return { config, snapshot, discovery, scope, entries, repoPublic, selection };
}

export async function pickWorker(
  input: RpcInput<typeof factoryWorkerPick>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
  extra?: ZerosubHandlerExtra,
): Promise<any> {
  const { config, repoPublic, selection } = await resolveWorkerSelection(paseo, loader, input, extra);
  const { profile, skipped, zerosubAccount } = selection;
  if (!profile) {
    const tried = skipped.length
      ? skipped.map((s: any) => `"${s.name}" (${s.reason})`).join("; ")
      : "no worker profiles configured";
    throw new Error(`No startable worker profile (tried ${tried})`);
  }
  const sensitive = (isSensitiveProfile as any)(config, profile.name);
  const text = [
    `Worker pick: "${profile.name}" (${profile.provider}/${profile.model})${sensitive ? " [sensitive: give only sanitized technical tasks]" : ""}${zerosubAccount ? ` [account ${zerosubAccount}]` : ""}`,
    `paseo run ${(paseoRunFlags as any)(profile)}`,
    ...skipped.map((s: any) => `skipped "${s.name}": ${s.reason}`),
  ].join("\n");
  return {
    profile: profile.name,
    provider: profile.provider,
    model: profile.model,
    thinking: profile.thinking ?? null,
    mode: profile.mode ?? null,
    sensitive,
    zerosubAccount: zerosubAccount ?? null,
    flags: (paseoRunFlags as any)(profile),
    skipped,
    repoPublic,
    text,
  };
}

export async function listWorkersModels(
  input: RpcInput<typeof factoryWorkerList>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
  extra?: ZerosubHandlerExtra,
): Promise<any> {
  const { config, entries, repoPublic, selection } = await resolveWorkerSelection(paseo, loader, input, extra);
  const rows: any[] = (workerListRows as any)(config, entries, selection);
  const priority: string[] = (workerPriority as any)(config);
  const lines = [`Worker priority (default "${config.workers?.defaultProfile ?? "-"}", → currently picked):`];
  for (const row of rows) {
    const tags = `${row.advisor ? " [advisor]" : ""}${row.sensitive ? " [sensitive]" : ""}`;
    lines.push(`${row.chosen ? "→" : " "} ${row.position}. ${row.profile}${tags} ${row.startable ? "✓" : "✗"} ${row.provider}/${row.model}${row.startable ? "" : ` (${row.issues.join("; ")})`}`);
  }
  if (!rows.length) lines.push("(no worker profiles configured)");
  return {
    defaultProfile: config.workers?.defaultProfile ?? null,
    priority,
    chosen: selection.profile?.name ?? null,
    repoPublic,
    entries: rows,
    text: lines.join("\n"),
  };
}

export async function startWorkerRpc(
  input: RpcInput<typeof factoryWorkerStart>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
  extra?: ZerosubHandlerExtra,
): Promise<any> {
  if (!input.task?.trim()) throw new Error("worker start needs --task <text>");
  if (!input.callerId?.trim()) throw new Error("Run worker start from the active steer");
  const { config, discovery, selection } = await resolveWorkerSelection(paseo, loader, input, extra);
  if (!discovery) throw new Error("worker start needs a Factory scope");
  const { profile, skipped, zerosubAccount } = selection;
  if (!profile) {
    const tried = skipped.length
      ? skipped.map((s: any) => `"${s.name}" (${s.reason})`).join("; ")
      : "no worker profiles configured";
    throw new Error(`No startable worker profile (tried ${tried})`);
  }
  const result: any = await (startScopedWorker as any)({
    client: paseo,
    status: (steerStatus as any)(discovery, { config }),
    callerId: input.callerId,
    aliases: (discoveryScopeAliases as any)(discovery),
    profile,
    accountId: zerosubAccount,
    prompt: input.task,
    title: input.title,
    apply: Boolean(input.apply),
    promptOptions: await loader.loadPromptOptions(paseo),
  });
  const text = result.agentId
    ? `Started worker ${result.agentId} (${result.provider}) in ${result.scope}`
    : `Dry-run: worker in ${result.scope} (${result.provider})${result.accountId ? ` · account ${result.accountId}` : ""}; add --apply to start`;
  return { ...result, text };
}

export async function runDrain(
  input: RpcInput<typeof factoryDrain>,
  { paseo }: PluginHandlerContext,
): Promise<any> {
  const timeoutMs = input.timeout === undefined ? (DRAIN_DEFAULT_TIMEOUT_MS as number) : (parseTimeout as any)(input.timeout);
  const result: any = await (drain as any)({ client: paseo, timeoutMs, git: createGit() });
  return { ...result, text: formatDrainText(result) };
}

function formatDrainText(result: any): string {
  const waited = `${Math.round((result.waitedMs ?? 0) / 1000)}s`;
  const timeout = `${Math.round((result.timeoutMs ?? 0) / 1000)}s`;
  const initial = result.initial ?? [];
  if (result.clean && !initial.length) return "Drain: no running factory agents — safe to restart.";
  if (result.clean) return `Drain: ${initial.length} factory agent(s) idle after ${waited} — safe to restart.`;
  const markedIds = new Set((result.marked ?? []).map((m: any) => m.agentId));
  const lines = [
    `Drain: timeout after ${waited} (limit ${timeout}), ${result.running.length} still running — marked planned-restart:`,
  ];
  for (const a of result.running) {
    const what = a.role === "steer" && a.slot ? `steer ${a.slot}` : a.role;
    lines.push(
      `  - ${a.id} ${what} in ${a.scopeId} ${a.status}${markedIds.has(a.id) ? " — marked planned-restart" : " — NOT marked (scope gone)"}`,
    );
  }
  lines.push("Restart would interrupt them; run status/resume for the last answer tails.");
  return lines.join("\n");
}

export async function previewAssign(
  input: RpcInput<typeof factoryAssignPreview>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
  extra?: ZerosubHandlerExtra,
): Promise<any> {
  const { config, discovery, scope, deprecatedAlias } = await discoverOne(paseo, loader, input.repo, input.workspaceId);
  const zerosub = await readHandlerZerosub(extra);
  const dry: any = await (assignScope as any)({
    client: paseo,
    discovery,
    config,
    promptOptions: await loader.loadPromptOptions(paseo),
    task: input.task,
    tests: input.tests ?? [],
    blockers: input.blockers ?? [],
    next: input.next ?? null,
    apply: false,
    assignedBy: input.callerId ?? null,
    reportTo: input.reportTo ?? input.callerId ?? null,
    workerModel: (workerModelLine as any)(config, discovery),
    quotaSnapshot: getQuotaSnapshot(),
    quotaWarnPct: config.quota?.warnPct ?? QUOTA_DEFAULTS.warnPct,
    zerosub,
    ...(input.expectEpoch !== undefined ? { expectEpoch: input.expectEpoch } : {}),
  });
  return {
    scope: dry.scope,
    epoch: dry.epoch,
    slot: dry.slot,
    steerId: dry.steerId,
    domain: dry.domain,
    domainChildren: dry.domainChildren,
    fields: dry.fields,
    reportTo: dry.reportTo,
    previous: dry.previous,
    packet: dry.packet,
    packetChars: dry.packetChars,
    applied: false,
    delivered: false,
    deliveryError: null,
    deprecatedAlias,
    scopeInfo: scope,
    fingerprint: assignFingerprint({
      scope: dry.scope,
      epoch: dry.epoch,
      steerId: dry.steerId,
      task: dry.fields.task,
      tests: dry.fields.tests,
      blockers: dry.fields.blockers,
      next: dry.fields.next,
    }),
  };
}

export async function applyAssign(
  input: RpcInput<typeof factoryAssign>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
  extra?: ZerosubHandlerExtra,
): Promise<any> {
  const { config, discovery, snapshot } = await discoverOne(paseo, loader, input.repo, input.workspaceId);
  const promptOptions = await loader.loadPromptOptions(paseo);
  const zerosub = await readHandlerZerosub(extra);
  const workerModel = (workerModelLine as any)(config, discovery);
  const quotaSnapshot = getQuotaSnapshot();
  const quotaWarnPct = config.quota?.warnPct ?? QUOTA_DEFAULTS.warnPct;
  const dry: any = await (assignScope as any)({
    client: paseo,
    discovery,
    config,
    promptOptions,
    task: input.task,
    tests: input.tests ?? [],
    blockers: input.blockers ?? [],
    next: input.next ?? null,
    apply: false,
    assignedBy: input.callerId ?? null,
    reportTo: input.reportTo ?? input.callerId ?? null,
    workerModel,
    quotaSnapshot,
    quotaWarnPct,
    zerosub,
    ...(input.expectEpoch !== undefined ? { expectEpoch: input.expectEpoch } : {}),
  });
  const fresh = assignFingerprint({
    scope: dry.scope,
    epoch: dry.epoch,
    steerId: dry.steerId,
    task: dry.fields.task,
    tests: dry.fields.tests,
    blockers: dry.fields.blockers,
    next: dry.fields.next,
  });
  if (fresh !== input.fingerprint) {
    throw new Error(
      "Something changed since the assign preview (for example a switch). Run /factory assign again and confirm the new preview.",
    );
  }
  let requester: any = null;
  if (input.callerId) {
    const caller = (snapshot.agents ?? []).find((agent: any) => agent.id === input.callerId);
    const source = (listScopes(snapshot) as any[]).find((item: any) => item.workspaceId === caller?.workspaceId);
    const sourceState = source?.workspace?.metadata?.[METADATA_KEY];
    if (!caller || !source || !Number.isInteger(sourceState?.epoch)) {
      throw new Error("The requesting agent has no current factory scope authority");
    }
    requester = {
      workspaceId: source.workspaceId,
      scopeId: source.id,
      epoch: sourceState.epoch,
      agentId: caller.id,
      aliases: [caller.labels?.[LABEL.scope], caller.labels?.[LABEL.repo]].filter(Boolean),
    };
  }
  const applied: any = await (assignScope as any)({
    client: paseo,
    discovery,
    config,
    promptOptions,
    task: input.task,
    tests: input.tests ?? [],
    blockers: input.blockers ?? [],
    next: input.next ?? null,
    apply: true,
    send: input.send !== false,
    expectEpoch: input.expectEpoch ?? dry.epoch,
    assignedBy: input.callerId ?? null,
    requester,
    reportTo: input.reportTo ?? input.callerId ?? null,
    workerModel,
    quotaSnapshot,
    quotaWarnPct,
    zerosub,
  });
  return applied;
}

export async function previewSteerAdd(
  input: RpcInput<typeof factorySteerAddPreview>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
  hostSettings: HostSettingsReader | null,
): Promise<any> {
  if (!hostSettings) throw new Error("Factory settings are not available; edit the config file instead");
  const state = await hostSettings.read();
  if (state.status !== "ready") {
    throw new Error(`Factory settings are ${state.status}: ${(state as any).error ?? "unreadable"}; open the settings page and save them again`);
  }
  const { discovery, status } = await discoverOne(paseo, loader, input.repo, input.workspaceId);
  if (!status.workspace || !status.state) {
    throw new Error(
      "This project is not set up by the factory yet (no main workspace with steers). Run /factory plan, then /factory apply <hash>.",
    );
  }
  const config = await loader.loadEffectiveConfig();
  if (status.state.retired) throw new Error("This scope is retired; choose an active scope.");
  const liveSteers = (discovery.steers?.labelled ?? []).filter((a: any) => !a.archivedAt);
  const scopeId = discovery.scope?.id ?? discovery.forkName;
  const repo = discovery.forkName;
  const workspaceId = status.workspace.id;
  const used = (usedProfilesByLiveSteers as any)(config, liveSteers);
  const quotaSnapshot = getQuotaSnapshot();
  const profileHealth = readProfileHealth(discovery.mainWorkspace?.metadata);
  const zerosub = await readZerosubStateSafe().catch(() => null);
  const plan: any = (planSteerAdd as any)(config, discovery.providers ?? [], liveSteers, {
    slot: input.slot ?? null,
    spec: input.spec ?? null,
    thinking: input.thinking,
    mode: input.mode,
    profile: input.profile,
    scopeId,
    workspaceId,
    repo,
    usedProfiles: used,
    quotaSnapshot,
    profileHealth,
    zerosub,
  });
  const values = (settingsFromConfig as any)(plan.config, state.values as FactorySettingsValues);
  const errors = (validateFactorySettings as any)(values);
  if (errors.length) throw new Error(`The change does not fit the settings:\n- ${errors.join("\n- ")}`);
  const text = (formatSteerAddPreview as any)(plan, { scopeId });
  return {
    scope: scopeId,
    repo,
    workspaceId,
    slot: plan.slot,
    profile: plan.profileName,
    provider: plan.profile?.provider ?? null,
    model: plan.profile?.model ?? null,
    advisor: plan.advisorSlot === true,
    account: plan.zerosubAccount,
    skipped: plan.skipped,
    earliestReset: plan.earliestReset,
    summary: plan.summary,
    notes: plan.notes,
    warnings: plan.warnings,
    text,
    fingerprint: plan.fingerprintInput ? (steerAddFingerprint as any)(plan.fingerprintInput) : null,
    revision: (state as any).revision ?? "",
    values,
  };
}

export async function applySteerAddRpc(
  input: RpcInput<typeof factorySteerAdd>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
): Promise<any> {
  const { discovery, status } = await discoverOne(paseo, loader, input.repo, input.workspaceId);
  if (!status.workspace || !status.state) {
    throw new Error(
      "This project is not set up by the factory yet (no main workspace with steers). Run /factory plan, then /factory apply <hash>.",
    );
  }
  const config = await loader.loadEffectiveConfig();
  if (status.state.retired) throw new Error("This scope is retired; choose an active scope.");
  const slot = input.slot?.trim().toUpperCase();
  if (!slot || !config.steers.slots[slot]) {
    throw new Error("The confirmed slot is not saved in the Factory settings. Run /factory steer add again and confirm it in the panel.");
  }
  const liveSteers = (discovery.steers?.labelled ?? []).filter((a: any) => !a.archivedAt);
  const executeOptions: any = {
    client: paseo,
    gh: createGh(),
    git: createGit(),
    paseoCli: createPaseoCli(),
  };
  return (applySteerAdd as any)(config, discovery.providers ?? [], liveSteers, {
    slot,
    spec: input.spec ?? null,
    thinking: input.thinking,
    mode: input.mode,
    profile: input.profile,
    scopeId: discovery.scope?.id ?? discovery.forkName,
    workspaceId: status.workspace.id,
    repo: discovery.forkName,
    fingerprint: input.fingerprint,
    fingerprintOf: steerAddFingerprint,
    usedProfiles: (usedProfilesByLiveSteers as any)(config, liveSteers),
    quotaSnapshot: getQuotaSnapshot(),
    profileHealth: readProfileHealth(discovery.mainWorkspace?.metadata),
    zerosub: await readZerosubStateSafe().catch(() => null),
    lookupReceipt: lookupCreationReceipt,
    execute: (createExecutors as any)(executeOptions),
  });
}
