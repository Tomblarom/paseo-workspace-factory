import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createConfigLoader } from "./server/config.js";
import { registerPromptSettings } from "./server/prompt-settings.js";
import {
  activateSteer,
  applyAssign,
  applyFresh,
  applyPlan,
  applyResumeRpc,
  applySteerAddRpc,
  applySteerSettingsRpc,
  applySwitch,
  createResumeBriefBuilder,
  deliverSteerBriefRpc,
  getCleanup,
  getModelsCatalog,
  getPlan,
  getResume,
  getScopeCandidates,
  getScopes,
  getStatus,
  getWorkers,
  getWorkspaceResources,
  listWorkersModels,
  openHistory,
  pickWorker,
  previewAssign,
  previewCheckpoint,
  previewFresh,
  previewSteerAdd,
  previewSteerSettingsRpc,
  previewSwitch,
  revertSteerSettingsRpc,
  runDrain,
  startWorkerRpc,
  writeCheckpointRpc,
} from "./server/handlers.js";
import { listModels, setModels } from "./server/models-rpc.js";
import {
  notifyColdFeed,
  readCleanupSettings,
  serveColdSubscription,
  startCleanupTimer,
} from "./server/cold-sweep.js";
import { notifySteerFeed, serveSteerSubscription } from "./server/steer-feed.js";
import { readResumeSettings } from "./server/resume-apply.js";
import { deliverSteer, type SteerDeliveryDeps } from "./server/steer-delivery.js";
import { adoptContinuation, handleTurnAfter, handleTurnBefore, reportContinuationAssignment } from "./server/turn-hook.js";
import { ensureBootChecked } from "./server/boot-check.js";
import { RESUME_CLEAR_DEFAULTS } from "./shared/idle-cleanup.js";
import {
  captureSupervisionPaseo,
  handleArchiveAfter,
  handleBootFinished,
  handleCreateAfter,
  handleWorkerTurnAfter,
  recordTakeoverDelivery,
  requestQuotaFailover,
  supervisionQuiet,
  readSupervisionSettings,
  startSupervisionTimer,
} from "./server/supervise.js";
import { startQuotaTimer } from "./server/quota.js";
import { getQuota } from "./server/quota-rpc.js";
import { getWorkspaceActivity } from "./server/workspace-activity.js";
import { factoryWorkspaceActivity } from "./shared/workspace-activity.js";
import { readZerosubStateSafe } from "./server/zerosub-runtime.js";
import { isAdvisorSteer } from "./server/core/config.mjs";
import { ROLE_RULES_ID, rolePromptForOpen, withFactoryCli, workerEnvAdditions } from "./server/core/role-prompts.mjs";
import { readPaseoAgents } from "./server/core/paseo.mjs";
import { continuedFromId, resolveFactoryLabels } from "./server/core/zerosub.mjs";
import { factoryIdentity } from "./shared/auto-checkpoint.js";
import { shortHolderId } from "./server/core/steer-create.mjs";
import {
  factoryApply,
  factoryAssign,
  factoryAssignPreview,
  factoryCheckpoint,
  factoryCheckpointPreview,
  factoryCleanup,
  factoryCold,
  factoryDrain,
  factoryFresh,
  factoryFreshPreview,
  factoryHistoryOpen,
  factoryModelsCatalog,
  factoryModelsList,
  factoryModelsSet,
  factoryPlan,
  factoryQuota,
  factoryResume,
  factoryResumeApply,
  factoryScopes,
  factoryScopesCandidates,
  factoryStatus,
  factorySteerActivate,
  factorySteerAdd,
  factorySteerAddPreview,
  factorySteerBrief,
  factorySteerDelivery,
  factorySteerSettings,
  factorySteerSettingsPreview,
  factorySteerSettingsRevert,
  factorySteers,
  factorySwitch,
  factorySwitchPreview,
  factoryWorkerList,
  factoryWorkerPick,
  factoryWorkerStart,
  factoryWorkers,
  factoryWorkspaceResources,
} from "./shared/factory.js";
import {
  factoryCleanupSettings,
  factoryConfigSettings,
  factoryDisplaySettings,
  factoryResumeSettings,
  factorySteerMenuSettings,
  factorySupervisionSettings,
} from "./shared/settings.js";

export default function contribute(server: PluginServerContext) {
  const hostSettings = server.registerSettings(factoryConfigSettings);
  const cleanupSettings = server.registerSettings(factoryCleanupSettings);
  const supervisionSettings = server.registerSettings(factorySupervisionSettings);
  const resumeSettings = server.registerSettings(factoryResumeSettings);
  const steerMenuSettings = server.registerSettings(factorySteerMenuSettings);
  const displaySettings = server.registerSettings(factoryDisplaySettings);
  const loader = createConfigLoader(hostSettings, registerPromptSettings(server, displaySettings));
  const readSettings = () => readCleanupSettings(cleanupSettings);
  const readSupervision = () => readSupervisionSettings(supervisionSettings);
  const isFactoryPaused = async () => {
    const settings = await readSupervision();
    return !settings || settings.paused === true;
  };
  const readQuotaSettings = () => readSupervisionSettings(supervisionSettings);
  const readResume = () => readResumeSettings(resumeSettings);
  const getZerosub = () => readZerosubStateSafe();
  const buildResumeBrief = createResumeBriefBuilder(loader, { getZerosub });
  const delivery: SteerDeliveryDeps = {
    isFactoryPaused,
    getConfig: () => loader.loadEffectiveConfig(),
    assignmentQuiet: (paseo, sourceIds, targetId) => supervisionQuiet(paseo, [...sourceIds, targetId]),
    onQuotaBlocked: (paseo, workspaceId, agentId, reason, pool) =>
      requestQuotaFailover(paseo, workspaceId, agentId, reason, pool, {
        getSettings: readSupervision, getConfig: () => loader.loadEffectiveConfig(), delivery, getZerosub,
      }),
    getCleanupSettings: readSettings,
    getResumeSettings: readResume,
    getZerosub,
    buildBrief: buildResumeBrief,
    onTakeoverDelivered: async (paseo, batch, agentId) => {
      await recordTakeoverDelivery(paseo, batch, agentId);
    },
    keepChatHistory: async () => {
      const settings = await steerMenuSettings.read();
      return settings.status === "ready" && settings.values?.keepChatHistory === true;
    },
  };
  const automaticDelivery = { ...delivery, automatic: true };
  // P1 boot check: the server entry receives no PaseoApi of its own, so the
  // once-per-process check runs on the first available handle (first turn,
  // RPC, or subscription) — effectively at plugin start, before any new turn
  // is recorded. The first caller also chains the supervision post-boot step
  // (restart marks interrupt workers, then one combined wake per scope).
  const bootDeps = {
    getRecentHours: async () => (await readResume())?.recentHours ?? RESUME_CLEAR_DEFAULTS.recentHours,
    getConfig: () => loader.loadEffectiveConfig(),
    normalizeContinuation: (paseo: any, agent: any) => adoptContinuation(paseo, agent),
    reportContinuation: (paseo: any, agent: any, scope: any, config: unknown) =>
      reportContinuationAssignment(paseo, agent, scope, config, { delivery: automaticDelivery }),
  };
  let bootChained = false;
  // Fail-soft ZeroSub state for supervision wakes, failover, and the turn-end
  // hint; without ZeroSub every call resolves null and keeps legacy behavior.
  const bootOnce = (paseo: unknown): void => {
    captureSupervisionPaseo(paseo);
    if (bootChained) return;
    bootChained = true;
    void ensureBootChecked(paseo, bootDeps).then((marks) => {
      if (marks === null) {
        bootChained = false;
        return;
      }
      return handleBootFinished(paseo, marks, { getSettings: readSupervision, getConfig: () => loader.loadEffectiveConfig(), delivery, getZerosub, buildBrief: buildResumeBrief });
    });
  };
  server.handle(factoryStatus, (input, ctx) => {
    bootOnce(ctx.paseo);
    return getStatus(input, ctx, loader);
  });
  server.handle(factoryPlan, (input, ctx) => getPlan(input, ctx, loader));
  server.handle(factoryWorkspaceActivity, getWorkspaceActivity);
  server.handle(factorySwitchPreview, (input, ctx) => previewSwitch(input, ctx, loader));
  server.handle(factorySwitch, (input, ctx) => {
    bootOnce(ctx.paseo);
    return applySwitch(input, ctx, loader, delivery);
  });
  server.handle(factorySteerDelivery, (input, { paseo }) => {
    bootOnce(paseo);
    return deliverSteer(paseo, input, delivery);
  });
  server.handle(factoryCheckpointPreview, (input, ctx) => previewCheckpoint(input, ctx, loader));
  server.handle(factoryCheckpoint, (input, ctx) => writeCheckpointRpc(input, ctx, loader));
  server.handle(factoryApply, (input, ctx) => applyPlan(input, ctx, loader));
  server.handle(factoryScopes, (input, ctx) => {
    bootOnce(ctx.paseo);
    return getScopes(input, ctx);
  });
  server.handle(factoryScopesCandidates, getScopeCandidates);
  server.handle(factoryCleanup, getCleanup);
  server.handle(factoryResume, (input, ctx) => {
    bootOnce(ctx.paseo);
    return getResume(input, ctx, loader, { getZerosub });
  });
  server.handle(factoryFreshPreview, (input, ctx) => previewFresh(input, ctx, loader, delivery));
  server.handle(factoryFresh, (input, ctx) => {
    bootOnce(ctx.paseo);
    return applyFresh(input, ctx, loader, delivery);
  });
  server.handle(factoryHistoryOpen, openHistory);
  server.handle(factoryWorkers, (input, ctx) => getWorkers(input, ctx, loader));
  server.handle(factoryModelsCatalog, getModelsCatalog);
  server.handle(factoryWorkerPick, (input, ctx) => pickWorker(input, ctx, loader));
  server.handle(factoryWorkerList, (input, ctx) => listWorkersModels(input, ctx, loader));
  server.handle(factoryWorkerStart, (input, ctx) => startWorkerRpc(input, ctx, loader));
  server.handle(factoryDrain, runDrain);
  server.handle(factoryQuota, (input, ctx) => getQuota(input, ctx, loader, { getZerosub }));
  server.handle(factoryWorkspaceResources, (input, ctx) => getWorkspaceResources(input, ctx, loader, {
    getZerosub, getQuotaSettings: readQuotaSettings,
  }));
  server.handle(factoryAssignPreview, (input, ctx) => previewAssign(input, ctx, loader));
  server.handle(factoryAssign, (input, ctx) => applyAssign(input, ctx, loader));
  server.handle(factoryModelsList, (input, ctx) => listModels(input, ctx, loader, hostSettings));
  server.handle(factoryModelsSet, (input, ctx) => setModels(input, ctx, loader, hostSettings));
  server.handle(factorySteerAddPreview, (input, ctx) => previewSteerAdd(input, ctx, loader, hostSettings));
  server.handle(factorySteerAdd, (input, ctx) => applySteerAddRpc(input, ctx, loader, hostSettings));
  server.handle(factorySteerBrief, (input, ctx) => deliverSteerBriefRpc(input, ctx, delivery));
  const steerSettingsExtra = {
    getCleanupSettings: readSettings,
    getSupervisionSettings: readSupervision,
    buildBrief: buildResumeBrief,
    getZerosub,
  };
  server.handle(factorySteerSettingsPreview, (input, ctx) => previewSteerSettingsRpc(input, ctx, loader, steerSettingsExtra));
  server.handle(factorySteerSettings, (input, ctx) => applySteerSettingsRpc(input, ctx, loader, steerSettingsExtra));
  server.handle(factorySteerSettingsRevert, (input, ctx) => revertSteerSettingsRpc(input, ctx, loader, steerSettingsExtra));
  server.handle(factoryResumeApply, (input, ctx) => {
    bootOnce(ctx.paseo);
    return applyResumeRpc(input, ctx, loader, delivery);
  });
  server.handle(factoryCold, (input: unknown, ctx: { paseo: any; push: (event: any) => Promise<void>; signal: AbortSignal }) => {
    bootOnce(ctx.paseo);
    serveColdSubscription(input, ctx, { readSettings, getZerosub, getConfig: () => loader.loadEffectiveConfig() });
  });
  server.handle(factorySteers, (input, ctx) => {
    bootOnce(ctx.paseo);
    serveSteerSubscription(input, ctx, {
      readSettings,
      getConfig: () => loader.loadEffectiveConfig(),
      readSupervision,
      getZerosub,
    });
  });
  // K10: lifecycle events push the shared feed projections immediately.
  const notifyFeeds = (): void => { notifySteerFeed(); notifyColdFeed(); };
  server.handle(factorySteerActivate, async (input, ctx) => {
    bootOnce(ctx.paseo);
    try {
      return await activateSteer(input, ctx, loader, delivery);
    } finally {
      notifyFeeds();
    }
  });
  const removeTurnBefore = server.addHook("agent.turn.before", async (payload, context) => {
    bootOnce(context.paseo);
    await handleTurnBefore(payload, context, { getConfig: () => loader.loadEffectiveConfig() });
    notifyFeeds();
  });
  const removeTurnHook = server.addHook("agent.turn.after", async (payload, context) => {
    bootOnce(context.paseo);
    await handleTurnAfter(payload, context, {
      getResumeBrief: buildResumeBrief,
      delivery: automaticDelivery,
      getConfig: () => loader.loadEffectiveConfig(),
      getSupervisionSettings: readSupervision,
      getZerosub,
    });
    notifyFeeds();
  });
  const removeCreateHook = server.addHook("agent.create.after", async (payload, context) => {
    captureSupervisionPaseo(context.paseo);
    await handleCreateAfter(payload, context, { getSettings: readSupervision });
    notifyFeeds();
  });
  // Second turn.after hook for worker supervision (own metadata key, own lock
  // pass; hook order is irrelevant).
  const removeSuperviseHook = server.addHook("agent.turn.after", async (payload, context) => {
    captureSupervisionPaseo(context.paseo);
    await handleWorkerTurnAfter(payload, context, { getSettings: readSupervision, getConfig: () => loader.loadEffectiveConfig(), delivery, getZerosub, buildBrief: buildResumeBrief });
    notifyFeeds();
  });
  // Immediate worker retirement on archive; a close alone never retires.
  const removeArchiveHook = server.addHook("agent.archive.after", async (payload, context) => {
    captureSupervisionPaseo(context.paseo);
    await handleArchiveAfter(payload, context, { getSettings: readSupervision });
    notifyFeeds();
  });
  // Static role rules for interactive factory steers (workers get theirs via
  // `worker start`; history opens and non-factory agents stay unchanged).
  // The text is static (cache-stable); only the advisor choice reads config.
  const removeRoleHook = server.addHook("agent.open.before", async ({ request }, context) => {
    if (request.purpose !== "interactive") return;
    let labels = request.labels;
    if (labels?.["zerosub.continued-from"] && (!factoryIdentity(labels) || (labels["wsf.role"] === "steer" && !labels["wsf.steer-role"]))) {
      // An established continuation without recoverable role evidence stays read-only.
      if (labels["wsf.role"] === "steer") labels = { ...labels, "wsf.steer-role": "advisor" };
      try {
        const agents = await readPaseoAgents(context.paseo);
        const current = agents.find((agent: any) => agent.id === request.agentId);
        if (continuedFromId(current)) labels = resolveFactoryLabels(current, agents) ?? labels;
      } catch (error) {
        console.error(`[factory] role identity lookup failed (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    // Workers get output limits via env (their role text comes via `worker
    // start`); steers get the appended prompt below; the rest is untouched.
    if (labels?.["wsf.role"] === "worker") {
      const additions = (workerEnvAdditions as unknown as (args: { labels: unknown; purpose: unknown; env: unknown }) => Record<string, string> | null)({
        labels, purpose: request.purpose, env: request.env,
      });
      const count = additions ? Object.keys(additions).length : 0;
      const workerShortId = (shortHolderId as unknown as (id: unknown) => string)(request.agentId);
      console.log(`[factory] worker env limits set: agent ${workerShortId}, reason ${request.reason}, env ${count}`);
      if (!additions || count === 0) return;
      return { ...request, env: { ...request.env, ...additions } };
    }
    if (labels?.["wsf.role"] !== "steer") return;
    const role = labels["wsf.steer-role"] ?? request.metadata?.["wsf.steer-role"];
    let isAdvisor = role !== "coordinator";
    if (role === undefined && labels["wsf.slot"]) {
      try {
        const config = await loader.loadEffectiveConfig();
        isAdvisor = isAdvisorSteer(config, labels);
      } catch {
        isAdvisor = true;
      }
    }
    const text = (rolePromptForOpen as unknown as (args: { labels: unknown; purpose: unknown; isAdvisor: boolean }) => string | null)({
      labels, purpose: request.purpose, isAdvisor,
    });
    if (!text) return;
    // Name the runnable CLI for this host; never fail the open on it.
    let rendered = text;
    try {
      const promptOptions = await loader.loadPromptOptions(context.paseo);
      rendered = (withFactoryCli as unknown as (text: string, options: unknown) => string)(text, promptOptions);
    } catch {
      rendered = text;
    }
    // Evidence trail that the role rules were delivered (no prompt text).
    const shortId = (shortHolderId as unknown as (id: unknown) => string)(request.agentId);
    console.log(`[factory] role prompt ${ROLE_RULES_ID as unknown as string} appended: agent ${shortId}, reason ${request.reason}, role ${isAdvisor ? "advisor" : "steer"}`);
    return { ...request, appendSystemPrompt: [...(request.appendSystemPrompt ?? []), rendered] };
  });
  const stopCleanupTimer = startCleanupTimer({ isFactoryPaused, readSettings, getZerosub, getQuotaSettings: readQuotaSettings, keepChatHistory: delivery.keepChatHistory });
  const stopSupervisionTimer = startSupervisionTimer({ ensureBoot: bootOnce, getSettings: readSupervision, getConfig: () => loader.loadEffectiveConfig(), delivery, getZerosub, buildBrief: buildResumeBrief });
  const stopQuotaTimer = startQuotaTimer({ getSettings: readQuotaSettings });
  return () => {
    removeTurnBefore();
    removeTurnHook();
    removeCreateHook();
    removeSuperviseHook();
    removeArchiveHook();
    removeRoleHook();
    stopCleanupTimer();
    stopSupervisionTimer();
    stopQuotaTimer();
  };
}
