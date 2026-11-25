import type {
  PluginAgentCommandContext,
  PluginButtonRegistration,
  PluginClientContext,
  PluginWorkspaceCommandContext,
} from "@getpaseo/plugin/client";
import {
  FactoryColdPanel,
  FactoryColdPillContent,
  attentionRowsOf,
} from "./client/cold-panel.js";
import { CheckpointShort, checkpointShortSchema } from "./client/checkpoint-short.js";
import {
  initCheckpointDisplay,
  syncCheckpointDisplayFromSettings,
} from "./client/checkpoint-display.js";
import { FactoryPanel } from "./client/factory-panel.js";
import { FactorySidebarItem } from "./client/factory-sidebar-item.js";
import { submitFactoryCommand } from "./client/factory-submit.js";
import { dismissFactoryResultPill, showFactoryResultPill } from "./client/result-pill.js";
import { FactorySettings } from "./client/settings-factory.js";
import { getFactoryResult } from "./client/factory-store.js";
import { subscribeOpenFactory } from "./client/steer-nav.js";
import { currentSteerHost, setSteerResult } from "./client/steer-results.js";
import { FactorySteerPillContent } from "./client/steer-pill-content.js";
import {
  attentionPillId,
  markSteerPillsDisconnected,
  steerAgentIds,
  steerRowsOf,
  syncSteerPills,
  teardownSteerPills,
  type SteerPillMap,
} from "./client/steer-pill.js";
import { assertSteerContext } from "./shared/agent-guard.js";
import { attentionStatus } from "./shared/context-continuation.js";
import { factoryCold, factorySteers } from "./shared/factory.js";

const SETTINGS_SCREEN_ID = "factory-settings";

function guardAgent(agent: PluginAgentCommandContext["agent"], what: string): void {
  assertSteerContext(agent, what);
}

function openFactory({ openPanel }: PluginWorkspaceCommandContext | PluginAgentCommandContext): void {
  openPanel("factory");
}

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "factory",
    title: "Factory",
    icon: "Factory",
    locations: ["workspace"],
    Component: FactoryPanel,
  });
  client.addAgentPanel({
    id: "factory-cold",
    title: "Factory: context",
    icon: "Snowflake",
    Component: FactoryColdPanel,
  });
  client.addSlashCommand({
    name: "factory",
    description: "Hand work between steers, check status, set up projects (try: /factory help)",
    argumentHint: "help | status | switch --to B | resume | plan …",
    context: "agent",
    async onSubmit({ args, agent, workspace, rpc, openPanel }) {
      guardAgent(agent, "/factory");
      // A new /factory call replaces the previous transient result pill.
      dismissFactoryResultPill();
      // Errors propagate and appear as an error toast; that is the only toast
      // path in onSubmit.
      const outcome = await submitFactoryCommand(args, {
        rpc,
        workspaceId: workspace.id,
        agentId: agent.id,
      });
      // The originating steer keeps its own result for its pill menu.
      const own = getFactoryResult();
      if (own) setSteerResult(currentSteerHost(), agent.id, own);
      if (outcome.openPanel) {
        openPanel("factory");
      } else if (outcome.pill) {
        showFactoryResultPill(client, {
          workspaceId: workspace.id,
          agentId: agent.id,
          summary: outcome.pill,
        });
      }
    },
  });
  // One pill per agent, with the same reason shown inside the popover.
  // Steer tabs carry the persistent steer pill instead; the attention feed
  // stays for workers (rows without a slot and outside the steer feed).
  const attentionPills = new Map<string, PluginButtonRegistration>();
  const steerPills: SteerPillMap = new Map();
  let steerIds = new Set<string>();
  const attentionFeed = client.subscribe(
    factoryCold,
    {},
    (event) => {
      const rows = attentionRowsOf(event);
      const seen = new Set<string>();
      for (const row of rows) {
        if (row.slot !== null || steerIds.has(row.agentId)) continue;
        seen.add(row.agentId);
        const title = attentionStatus(row);
        const icon = row.reason && row.reason !== "cold" ? "RotateCcw" : "Snowflake";
        const known = attentionPills.get(row.agentId);
        if (known) {
          try {
            known.update({ title, icon });
          } catch {
            // The composer went away; the next event re-adds the pill.
            attentionPills.delete(row.agentId);
          }
          continue;
        }
        try {
          attentionPills.set(
            row.agentId,
            client.addComposerPill({
              id: attentionPillId(row.agentId),
              workspaceId: row.workspaceId,
              agentId: row.agentId,
              button: {
                title,
                icon,
                behavior: { kind: "popover", Content: FactoryColdPillContent },
              },
            }),
          );
        } catch {
          // The agent or composer is gone; skip it until the next event.
        }
      }
      for (const [id, pill] of attentionPills) {
        if (seen.has(id)) continue;
        try {
          pill.remove();
        } catch {
          // Already gone.
        }
        attentionPills.delete(id);
      }
    },
  );
  // One persistent pill per steer tab, kept in sync with the host-wide feed.
  // Paseo re-subscribes after a reconnect; the close handler keeps the last
  // verified pills as Unknown until the next event refreshes them.
  const steerFeed = client.subscribe(
    factorySteers,
    {},
    (event) => {
      const rows = steerRowsOf(event);
      steerIds = steerAgentIds(rows);
      syncSteerPills(client, steerPills, rows, FactorySteerPillContent);
      // A steer row that arrived here replaces its attention pill, if any.
      for (const [id, pill] of attentionPills) {
        if (!steerIds.has(id)) continue;
        try {
          pill.remove();
        } catch {
          // Already gone.
        }
        attentionPills.delete(id);
      }
    },
    { onClosed: () => markSteerPillsDisconnected(steerPills) },
  );
  client.addCommandCenterItem({
    id: "factory-status",
    title: "Factory: status",
    icon: "Factory",
    keywords: ["steer", "checkpoint"],
    context: "agent",
    onSelect: (ctx) => {
      guardAgent(ctx.agent, "Factory");
      openFactory(ctx);
    },
  });
  client.addCommandCenterItem({
    id: "factory-plan",
    title: "Factory: plan",
    icon: "Factory",
    keywords: ["steer", "provision"],
    context: "agent",
    onSelect: (ctx) => {
      guardAgent(ctx.agent, "Factory");
      openFactory(ctx);
    },
  });
  client.addCommandCenterItem({
    id: "factory-checkpoint",
    title: "Factory: checkpoint",
    icon: "Factory",
    keywords: ["steer", "task"],
    context: "agent",
    onSelect: (ctx) => {
      guardAgent(ctx.agent, "Factory");
      openFactory(ctx);
    },
  });
  client.addCommandCenterItem({
    id: "factory-switch",
    title: "Factory: switch steer",
    icon: "Factory",
    keywords: ["steer", "handoff"],
    context: "agent",
    onSelect: (ctx) => {
      guardAgent(ctx.agent, "Factory");
      openFactory(ctx);
    },
  });
  client.addCommandCenterItem({
    id: "factory-open-panel",
    title: "Factory: open panel",
    icon: "Factory",
    keywords: ["steer", "panel"],
    context: "workspace",
    onSelect: openFactory,
  });
  client.addSettingsScreen({
    id: SETTINGS_SCREEN_ID,
    title: "Workspace Factory",
    icon: "Factory",
    Component: FactorySettings,
  });
  // Synchronous and unconditional: Paseo lists the entry in its own
  // sidebar settings, where the user shows or hides it.
  client.addSidebarHeaderItem({
    id: "factory",
    title: "Workspace Factory",
    Component: (props) => (
      <FactorySidebarItem {...props} openSettings={() => client.openSettings(SETTINGS_SCREEN_ID)} />
    ),
  });
  client.addTimelineRenderer({
    kind: "factory-checkpoint",
    version: 1,
    schema: checkpointShortSchema,
    Component: CheckpointShort,
  });
  const stopCheckpointDisplay = initCheckpointDisplay(client);
  void syncCheckpointDisplayFromSettings();
  // "Open Factory" from a pill popover: the popover cannot open the panel
  // itself, so the entry opens it (the panel defaults to this workspace).
  const stopOpenFactory = subscribeOpenFactory((target) => {
    try {
      client.openPanel("factory", { workspaceId: target.workspaceId, agentId: target.agentId });
    } catch {
      // The panel surface is gone; the pill menu still holds the result.
    }
  });
  return () => {
    stopOpenFactory();
    stopCheckpointDisplay();
    void attentionFeed.release().catch(() => {});
    for (const pill of attentionPills.values()) {
      try {
        pill.remove();
      } catch {
        // Already gone.
      }
    }
    attentionPills.clear();
    void steerFeed.release().catch(() => {});
    teardownSteerPills(steerPills);
    dismissFactoryResultPill();
  };
}
