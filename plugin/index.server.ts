import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createConfigLoader } from "./server/config.js";
import { registerPromptSettings } from "./server/prompt-settings.js";
import {
  applyAssign,
  applyFresh,
  applyLabels,
  applyPlan,
  applyRelocate,
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
  getRetire,
  getScopeCandidates,
  getScopes,
  getStatus,
  getWorkers,
  openHistory,
  pickWorker,
  planCleanup,
  previewAssign,
  previewCheckpoint,
  previewFresh,
  previewLabels,
  previewRelocate,
  previewSteerAdd,
  previewSteerSettingsRpc,
  previewSwitch,
  revertSteerSettingsRpc,
  runDrain,
  writeCheckpointRpc,
} from "./server/handlers.js";
import { listModels, setModels } from "./server/models-rpc.js";
import { ping } from "./server/ping.js";
import {
  readCleanupSettings,
  serveColdSubscription,
  startCleanupTimer,
} from "./server/cold-sweep.js";
import { serveSteerSubscription } from "./server/steer-feed.js";
import { applyResume, readResumeSettings } from "./server/resume-apply.js";
import { handleTurnAfter, handleTurnBefore } from "./server/turn-hook.js";
import { ensureBootChecked } from "./server/boot-check.js";
import { RESUME_CLEAR_DEFAULTS } from "./shared/idle-cleanup.js";
import {
  captureSupervisionPaseo,
  handleBootFinished,
  handleCreateAfter,
  handleWorkerTurnAfter,
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
  factoryAttention,
  factoryCheckpoint,
  factoryCheckpointPreview,
  factoryCleanup,
  factoryCleanupPlan,
  factoryCold,
  factoryDrain,
  factoryFresh,
  factoryFreshPreview,
  factoryHistoryOpen,
  factoryLabels,
  factoryLabelsPreview,
  factoryModelsCatalog,
  factoryModelsList,
  factoryModelsSet,
  factoryPing,
  factoryPlan,
  factoryQuota,
  factoryRelocate,
  factoryRelocatePreview,
  factoryResume,
  factoryResumeApply,
  factoryRetire,
  factoryScopes,
  factoryScopesCandidates,
  factoryStatus,
  factorySteerAdd,
  factorySteerAddPreview,
  factorySteerBrief,
  factorySteerSettings,
  factorySteerSettingsPreview,
  factorySteerSettingsRevert,
  factorySteers,
  factorySwitch,
  factorySwitchPreview,
  factoryWorkerPick,
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
  server.registerSettings(factorySteerMenuSettings);
  const displaySettings = server.registerSettings(factoryDisplaySettings);
  const loader = createConfigLoader(hostSettings, registerPromptSettings(server, displaySettings));
  const readSettings = () => readCleanupSettings(cleanupSettings);
  const readSupervision = () => readSupervisionSettings(supervisionSettings);
  const readQuotaSettings = () => readSupervisionSettings(supervisionSettings);
  const readResume = () => readResumeSettings(resumeSettings);
  const buildResumeBrief = createResumeBriefBuilder(loader);
  // F4: a woken steer with needsResume gets an automatic resume instead of
  // the plain wake text; the wake text travels as the brief's note.
  const resumeSteer = (paseo: any, args: { workspaceId: string; agentId: string; note: string }) =>
    applyResume(
      paseo,
      { workspaceId: args.workspaceId, agentId: args.agentId },
      { getResumeSettings: readResume, buildBrief: buildResumeBrief, note: args.note },
    );
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
  const getZerosub = () => readZerosubStateSafe();
  const bootOnce = (paseo: unknown): void => {
    captureSupervisionPaseo(paseo);
    if (bootChained) {
      void ensureBootChecked(paseo, bootDeps);
      return;
    }
    bootChained = true;
    void ensureBootChecked(paseo, bootDeps).then((marks) =>
      handleBootFinished(paseo, marks, { getSettings: readSupervision, getConfig: () => loader.loadEffectiveConfig(), resumeSteer, getZerosub }),
    );
  };
  server.handle(factoryPing, ping);
  server.handle(factoryStatus, (input, ctx) => {
    bootOnce(ctx.paseo);
    return getStatus(input, ctx, loader);
  });
  server.handle(factoryPlan, (input, ctx) => getPlan(input, ctx, loader));
  server.handle(factorySwitchPreview, (input, ctx) => previewSwitch(input, ctx, loader));
  server.handle(factorySwitch, (input, ctx) => applySwitch(input, ctx, loader));
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
  server.handle(factoryRetire, getRetire);
  server.handle(factoryModelsCatalog, getModelsCatalog);
  server.handle(factoryWorkerPick, (input, ctx) => pickWorker(input, ctx, loader));
  server.handle(factoryDrain, runDrain);
  server.handle(factoryQuota, (input, ctx) => getQuota(input, ctx, loader, { getZerosub }));
  server.handle(factoryAssignPreview, (input, ctx) => previewAssign(input, ctx, loader));
  server.handle(factoryAssign, (input, ctx) => applyAssign(input, ctx, loader));
  server.handle(factoryRelocatePreview, (input, ctx) => previewRelocate(input, ctx, loader));
  server.handle(factoryRelocate, (input, ctx) => applyRelocate(input, ctx, loader));
  server.handle(factoryCleanupPlan, (input, ctx) => planCleanup(input, ctx, loader));
  server.handle(factoryLabelsPreview, previewLabels);
  server.handle(factoryLabels, (input, ctx) => applyLabels(input, ctx, loader));
  server.handle(factoryModelsList, (input, ctx) => listModels(input, ctx, loader, hostSettings));
  server.handle(factoryModelsSet, (input, ctx) => setModels(input, ctx, loader, hostSettings));
  server.handle(factorySteerAddPreview, (input, ctx) => previewSteerAdd(input, ctx, loader, hostSettings));
  server.handle(factorySteerAdd, (input, ctx) => applySteerAddRpc(input, ctx, loader));
  server.handle(factorySteerBrief, deliverSteerBriefRpc);
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
    return applyResumeRpc(input, ctx, loader, {
      getResumeSettings: readResume,
      buildBrief: buildResumeBrief,
    });
  });
  const serveAttention = (input: unknown, ctx: { paseo: any; push: (event: any) => Promise<void>; signal: AbortSignal }) => {
    bootOnce(ctx.paseo);
    serveColdSubscription(input, ctx, { readSettings, getConfig: () => loader.loadEffectiveConfig() });
  };
  server.handle(factoryCold, serveAttention);
  server.handle(factoryAttention, serveAttention);
  server.handle(factorySteers, (input, ctx) => {
    bootOnce(ctx.paseo);
    serveSteerSubscription(input, ctx, {
      readSettings,
      getConfig: () => loader.loadEffectiveConfig(),
      readSupervision,
      getZerosub,
    });
  });
  const removeTurnBefore = server.addHook("agent.turn.before", (payload, context) => {
    bootOnce(context.paseo);
    return handleTurnBefore(payload, context);
  });
  const removeTurnHook = server.addHook("agent.turn.after", (payload, context) => {
    bootOnce(context.paseo);
    return handleTurnAfter(payload, context, {
      getCleanupSettings: readSettings,
      getResumeBrief: buildResumeBrief,
      getConfig: () => loader.loadEffectiveConfig(),
      getSupervisionSettings: readSupervision,
      getZerosub,
    });
  });
  const removeCreateHook = server.addHook("agent.create.after", async (payload, context) => {
    captureSupervisionPaseo(context.paseo);
    await handleCreateAfter(payload, context, { getSettings: readSupervision });
  });
  // Second turn.after hook for worker supervision (own metadata key, own lock
  // pass; hook order is irrelevant).
  const removeSuperviseHook = server.addHook("agent.turn.after", async (payload, context) => {
    captureSupervisionPaseo(context.paseo);
    await handleWorkerTurnAfter(payload, context, { getSettings: readSupervision, getConfig: () => loader.loadEffectiveConfig(), resumeSteer, getZerosub });
  });
  const stopCleanupTimer = startCleanupTimer({ readSettings, getZerosub, getQuotaSettings: readQuotaSettings });
  const stopSupervisionTimer = startSupervisionTimer({ getSettings: readSupervision, getConfig: () => loader.loadEffectiveConfig(), resumeSteer, getZerosub });
  const stopQuotaTimer = startQuotaTimer({ getSettings: readQuotaSettings });
  return () => {
    removeTurnBefore();
    removeTurnHook();
    removeCreateHook();
    removeSuperviseHook();
    stopCleanupTimer();
    stopSupervisionTimer();
    stopQuotaTimer();
  };
}
