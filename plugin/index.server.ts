import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createConfigLoader } from "./server/config.js";
import {
  applyFresh,
  applyPlan,
  applySwitch,
  getCleanup,
  getPlan,
  getResume,
  getScopeCandidates,
  getScopes,
  getStatus,
  openHistory,
  previewCheckpoint,
  previewFresh,
  previewSwitch,
  writeCheckpointRpc,
} from "./server/handlers.js";
import { ping } from "./server/ping.js";
import {
  readCleanupSettings,
  serveColdSubscription,
  startCleanupTimer,
} from "./server/cold-sweep.js";
import { handleTurnAfter } from "./server/turn-hook.js";
import {
  factoryApply,
  factoryCheckpoint,
  factoryCheckpointPreview,
  factoryCleanup,
  factoryCold,
  factoryFresh,
  factoryFreshPreview,
  factoryHistoryOpen,
  factoryPing,
  factoryPlan,
  factoryResume,
  factoryScopes,
  factoryScopesCandidates,
  factoryStatus,
  factorySwitch,
  factorySwitchPreview,
} from "./shared/factory.js";
import { factoryCleanupSettings, factoryConfigSettings } from "./shared/settings.js";

export default function contribute(server: PluginServerContext) {
  const hostSettings = server.registerSettings(factoryConfigSettings);
  const cleanupSettings = server.registerSettings(factoryCleanupSettings);
  // factorySidebarSettings has scope "device": it belongs to the client (useSettings), the daemon must not register it.
  const loader = createConfigLoader(hostSettings);
  const readSettings = () => readCleanupSettings(cleanupSettings);
  server.handle(factoryPing, ping);
  server.handle(factoryStatus, (input, ctx) => getStatus(input, ctx, loader));
  server.handle(factoryPlan, (input, ctx) => getPlan(input, ctx, loader));
  server.handle(factorySwitchPreview, (input, ctx) => previewSwitch(input, ctx, loader));
  server.handle(factorySwitch, (input, ctx) => applySwitch(input, ctx, loader));
  server.handle(factoryCheckpointPreview, (input, ctx) => previewCheckpoint(input, ctx, loader));
  server.handle(factoryCheckpoint, (input, ctx) => writeCheckpointRpc(input, ctx, loader));
  server.handle(factoryApply, (input, ctx) => applyPlan(input, ctx, loader));
  server.handle(factoryScopes, getScopes);
  server.handle(factoryScopesCandidates, getScopeCandidates);
  server.handle(factoryCleanup, getCleanup);
  server.handle(factoryResume, (input, ctx) => getResume(input, ctx, loader));
  server.handle(factoryFreshPreview, (input, ctx) => previewFresh(input, ctx, loader));
  server.handle(factoryFresh, (input, ctx) => applyFresh(input, ctx, loader));
  server.handle(factoryHistoryOpen, openHistory);
  server.handle(factoryCold, (input, ctx) =>
    serveColdSubscription(input, ctx, { readSettings }),
  );
  const removeTurnHook = server.addHook("agent.turn.after", (payload, context) =>
    handleTurnAfter(payload, context, { getCleanupSettings: readSettings }),
  );
  const stopCleanupTimer = startCleanupTimer({ readSettings });
  return () => {
    removeTurnHook();
    stopCleanupTimer();
  };
}
