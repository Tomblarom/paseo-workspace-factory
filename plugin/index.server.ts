import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createConfigLoader } from "./server/config.js";
import { registerPromptSettings } from "./server/prompt-settings.js";
import {
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
import { handleTurnAfter, handleTurnBefore } from "./server/turn-hook.js";
import { ensureBootChecked } from "./server/boot-check.js";
import { RESUME_CLEAR_DEFAULTS } from "./shared/idle-cleanup.js";
import {
  captureSupervisionPaseo,
  handleArchiveAfter,
  handleBootFinished,
  handleCreateAfter,
  handleWorkerTurnAfter,
  recordTakeoverDelivery,
  readSupervisionSettings,
  startSupervisionTimer,
} from "./server/supervise.js";
import { startQuotaTimer } from "./server/quota.js";
import { getQuota } from "./server/quota-rpc.js";
import { readZerosubStateSafe } from "./server/zerosub-runtime.js";
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
  const readQuotaSettings = () => readSupervisionSettings(supervisionSettings);
  const readResume = () => readResumeSettings(resumeSettings);
  const getZerosub = () => readZerosubStateSafe();
  const buildResumeBrief = createResumeBriefBuilder(loader);
  const delivery: SteerDeliveryDeps = {
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
  // P1 boot check: the server entry receives no PaseoApi of its own, so the
  // once-per-process check runs on the first available handle (first turn,
  // RPC, or subscription) — effectively at plugin start, before any new turn
  // is recorded. The first caller also chains the supervision post-boot step
  // (restart marks interrupt workers, then one combined wake per scope).
  const bootDeps = {
    getRecentHours: async () => (await readResume())?.recentHours ?? RESUME_CLEAR_DEFAULTS.recentHours,
    getConfig: () => loader.loadEffectiveConfig(),
  };
  let bootChained = false;
  // Fail-soft ZeroSub state for supervision wakes, failover, and the turn-end
  // hint; without ZeroSub every call resolves null and keeps legacy behavior.
  const bootOnce = (paseo: unknown): void => {
    captureSupervisionPaseo(paseo);
    if (bootChained) {
      void ensureBootChecked(paseo, bootDeps);
      return;
    }
    bootChained = true;
    void ensureBootChecked(paseo, bootDeps).then((marks) =>
      handleBootFinished(paseo, marks, { getSettings: readSupervision, getConfig: () => loader.loadEffectiveConfig(), delivery, getZerosub, buildBrief: buildResumeBrief }),
    );
  };
  server.handle(factoryStatus, (input, ctx) => {
    bootOnce(ctx.paseo);
    return getStatus(input, ctx, loader);
  });
  server.handle(factoryPlan, (input, ctx) => getPlan(input, ctx, loader));
  server.handle(factorySwitchPreview, (input, ctx) => previewSwitch(input, ctx, loader));
  server.handle(factorySwitch, (input, ctx) => applySwitch(input, ctx, loader, delivery));
  server.handle(factorySteerDelivery, (input, { paseo }) => deliverSteer(paseo, input, delivery));
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
    return getResume(input, ctx, loader);
  });
  server.handle(factoryFreshPreview, (input, ctx) => previewFresh(input, ctx, loader));
  server.handle(factoryFresh, (input, ctx) => applyFresh(input, ctx, loader));
  server.handle(factoryHistoryOpen, openHistory);
  server.handle(factoryWorkers, (input, ctx) => getWorkers(input, ctx, loader));
  server.handle(factoryModelsCatalog, getModelsCatalog);
  server.handle(factoryWorkerPick, (input, ctx) => pickWorker(input, ctx, loader));
  server.handle(factoryWorkerList, (input, ctx) => listWorkersModels(input, ctx, loader));
  server.handle(factoryWorkerStart, (input, ctx) => startWorkerRpc(input, ctx, loader));
  server.handle(factoryDrain, runDrain);
  server.handle(factoryQuota, (input, ctx) => getQuota(input, ctx, loader, { getZerosub }));
  server.handle(factoryAssignPreview, (input, ctx) => previewAssign(input, ctx, loader));
  server.handle(factoryAssign, (input, ctx) => applyAssign(input, ctx, loader));
  server.handle(factoryModelsList, (input, ctx) => listModels(input, ctx, loader, hostSettings));
  server.handle(factoryModelsSet, (input, ctx) => setModels(input, ctx, loader, hostSettings));
  server.handle(factorySteerAddPreview, (input, ctx) => previewSteerAdd(input, ctx, loader, hostSettings));
  server.handle(factorySteerAdd, (input, ctx) => applySteerAddRpc(input, ctx, loader));
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
  const removeTurnBefore = server.addHook("agent.turn.before", async (payload, context) => {
    bootOnce(context.paseo);
    await handleTurnBefore(payload, context);
    notifyFeeds();
  });
  const removeTurnHook = server.addHook("agent.turn.after", async (payload, context) => {
    bootOnce(context.paseo);
    await handleTurnAfter(payload, context, {
      getResumeBrief: buildResumeBrief,
      delivery,
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
  const stopCleanupTimer = startCleanupTimer({ readSettings, getZerosub, getQuotaSettings: readQuotaSettings });
  const stopSupervisionTimer = startSupervisionTimer({ getSettings: readSupervision, getConfig: () => loader.loadEffectiveConfig(), delivery, getZerosub, buildBrief: buildResumeBrief });
  const stopQuotaTimer = startQuotaTimer({ getSettings: readQuotaSettings });
  return () => {
    removeTurnBefore();
    removeTurnHook();
    removeCreateHook();
    removeSuperviseHook();
    removeArchiveHook();
    stopCleanupTimer();
    stopSupervisionTimer();
    stopQuotaTimer();
  };
}
