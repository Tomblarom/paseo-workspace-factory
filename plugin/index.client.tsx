import type {
  PluginAgentCommandContext,
  PluginClientContext,
  PluginWorkspaceCommandContext,
} from "@getpaseo/plugin/client";
import { FactoryColdPanel, FactoryColdPillContent } from "./client/cold-panel.js";
import { FactoryPanel } from "./client/factory-panel.js";
import { FactorySidebarItem } from "./client/factory-sidebar-item.js";
import { submitFactoryCommand } from "./client/factory-submit.js";
import { FactorySettings } from "./client/settings-factory.js";
import { initSidebarController, syncSidebarFromSettings } from "./client/sidebar-visibility.js";
import { assertSteerContext } from "./shared/agent-guard.js";
import { factoryCold } from "./shared/factory.js";
import { coldHintText } from "./shared/idle-cleanup.js";

function guardAgent(agent: PluginAgentCommandContext["agent"], what: string): void {
  assertSteerContext(agent, what);
}

function openFactory({ openPanel }: PluginWorkspaceCommandContext | PluginAgentCommandContext): void {
  openPanel("factory");
}

interface ColdPill {
  update: (patch: { label?: string }) => void;
  remove: () => void;
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
    title: "Factory: Kontext",
    icon: "Snowflake",
    Component: FactoryColdPanel,
  });
  client.addSlashCommand({
    name: "factory",
    description: "Drive factory workspaces, with preview before writes",
    argumentHint: "status|scopes|cleanup|plan|apply|checkpoint|switch|resume …",
    context: "agent",
    async onSubmit({ args, agent, workspace, rpc, openPanel }) {
      guardAgent(agent, "/factory");
      await submitFactoryCommand(args, {
        rpc,
        workspaceId: workspace.id,
        agentId: agent.id,
      });
      openPanel("factory");
    },
  });
  // C6 composer pills: one "Kontext kalt" pill per cold factory agent, driven
  // by the server's cold feed. Pills appear and disappear without a reload.
  const coldPills = new Map<string, ColdPill>();
  const coldFeed = client.subscribe(
    factoryCold,
    {},
    (event) => {
      const rows = Array.isArray((event as any)?.cold) ? ((event as any).cold as any[]) : [];
      const seen = new Set<string>();
      for (const row of rows) {
        if (typeof row?.agentId !== "string" || typeof row?.workspaceId !== "string") continue;
        seen.add(row.agentId);
        const label = coldHintText(row.contextTokens ?? 0, (row.idleMinutes ?? 0) * 60_000);
        const known = coldPills.get(row.agentId);
        if (known) {
          try {
            known.update({ label });
          } catch {
            // The composer went away; the next event re-adds the pill.
            coldPills.delete(row.agentId);
          }
          continue;
        }
        try {
          coldPills.set(
            row.agentId,
            client.addComposerPill({
              id: `factory-cold-${row.agentId}`,
              workspaceId: row.workspaceId,
              agentId: row.agentId,
              button: {
                title: "Kontext kalt",
                label,
                icon: "Snowflake",
                behavior: { kind: "popover", Content: FactoryColdPillContent },
              },
            }),
          );
        } catch {
          // The agent or composer is gone; skip it until the next event.
        }
      }
      for (const [id, pill] of coldPills) {
        if (seen.has(id)) continue;
        try {
          pill.remove();
        } catch {
          // Already gone.
        }
        coldPills.delete(id);
      }
    },
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
    title: "Factory: Panel öffnen",
    icon: "Factory",
    keywords: ["steer", "panel"],
    context: "workspace",
    onSelect: openFactory,
  });
  client.addSettingsScreen({
    id: "factory-settings",
    title: "Factory",
    icon: "Factory",
    Component: FactorySettings,
  });
  initSidebarController(client, FactorySidebarItem);
  void syncSidebarFromSettings();
  return () => {
    void coldFeed.release().catch(() => {});
    for (const pill of coldPills.values()) {
      try {
        pill.remove();
      } catch {
        // Already gone.
      }
    }
    coldPills.clear();
  };
}
