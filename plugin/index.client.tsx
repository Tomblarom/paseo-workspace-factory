import type {
  PluginAgentCommandContext,
  PluginButtonBehavior,
  PluginButtonContentProps,
  PluginButtonMenuEntry,
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
import { requestOpenFactory, subscribeOpenFactory } from "./client/steer-nav.js";
import { SteerMenu, type SteerMenuAction } from "./client/steer-menu-content.js";
import {
  describeSteerMenu,
  menuKeyFor,
  type SteerMenuEntryDescriptor,
} from "./client/steer-menu.js";
import {
  attentionPillId,
  markSteerPillsDisconnected,
  steerAgentIds,
  steerRowsOf,
  syncSteerPills,
  teardownSteerPills,
  type SteerObservedState,
  type SteerPillMap,
  type SteerPillRow,
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

/** One steer action as a popover: the menu item opens only its own flow. */
function steerActionPopover(
  action: SteerMenuAction,
  extra?: {
    targetSlot?: string;
    targetAgentId?: string;
    observed?: {
      provider: string | null;
      model: string | null;
      thinking: string | null;
      speed: string | null;
      sessionId: string | null;
    } | null;
  },
) {
  return function SteerActionContent(props: PluginButtonContentProps) {
    if (props.context !== "agent") return null;
    return (
      <SteerMenu
        key={`${props.agentId}-${action}`}
        agentId={props.agentId}
        workspaceId={props.workspaceId}
        theme={props.theme}
        compact={props.layout.compact}
        close={props.close}
        initialAction={action}
        initialSlot={extra?.targetSlot}
        initialAgentId={extra?.targetAgentId}
        observed={extra?.observed ?? null}
      />
    );
  };
}

function toMenuEntries(
  descriptor: SteerMenuEntryDescriptor[],
  ctx: { row: SteerPillRow; observed: SteerObservedState },
): PluginButtonMenuEntry[] {
  return descriptor.map((entry): PluginButtonMenuEntry => {
    if (entry.kind === "separator") return { kind: "separator", id: entry.id };
    if (entry.disabled === true) {
      return { kind: "item", id: entry.id, title: entry.title, icon: entry.icon, disabled: true, behavior: { kind: "action", onPress: () => {} } };
    }
    if (entry.submenu) {
      return { kind: "item", id: entry.id, title: entry.title, icon: entry.icon, behavior: { kind: "menu", items: toMenuEntries(entry.submenu, ctx) } };
    }
    switch (entry.action) {
      case "create":
        return { kind: "item", id: entry.id, title: entry.title, icon: entry.icon, behavior: { kind: "popover", Content: steerActionPopover("create") } };
      case "handover-target":
        return { kind: "item", id: entry.id, title: entry.title, icon: entry.icon, behavior: { kind: "popover", Content: steerActionPopover("handover", { targetSlot: entry.targetSlot, targetAgentId: entry.targetAgentId }) } };
      case "refresh":
      case "fresh-context":
        return { kind: "item", id: entry.id, title: entry.title, icon: entry.icon, behavior: { kind: "popover", Content: steerActionPopover(entry.action === "fresh-context" ? "fresh-context" : "refresh") } };
      case "settings":
        return { kind: "item", id: entry.id, title: entry.title, icon: entry.icon, behavior: { kind: "popover", Content: steerActionPopover("settings") } };
      case "revert": {
        const seen = ctx.observed.tracker.observed;
        return { kind: "item", id: entry.id, title: entry.title, icon: entry.icon, behavior: { kind: "popover", Content: steerActionPopover("revert", { observed: seen ? { ...seen, sessionId: ctx.row.sessionId } : null }) } };
      }
      case "staged-brief":
        return { kind: "item", id: entry.id, title: entry.title, icon: entry.icon, behavior: { kind: "popover", Content: steerActionPopover("staged") } };
      case "open-factory":
        return { kind: "item", id: entry.id, title: entry.title, icon: entry.icon, behavior: { kind: "action", onPress: () => requestOpenFactory({ workspaceId: ctx.row.workspaceId, agentId: ctx.row.agentId }) } };
      default:
        return { kind: "item", id: entry.id, title: entry.title, icon: entry.icon, disabled: true, behavior: { kind: "action", onPress: () => {} } };
    }
  });
}

/**
 * Native menu behavior for one steer tab. Keep-chat-history only switches
 * between the resume and fresh routes inside the Refresh popover (both are
 * enabled menu items), so the descriptor builds with a fixed value and the
 * popover reads the live setting.
 */
function buildSteerMenuBehavior(
  row: SteerPillRow,
  rows: SteerPillRow[],
  observed: SteerObservedState,
): { behavior: PluginButtonBehavior; menuKey: string } {
  const descriptor = describeSteerMenu(row, rows, {
    keepChatHistory: false,
    observedChanged: observed.changed,
    revertAllowed: observed.revertAllowed,
    revertReason: observed.revertReason,
  });
  return { behavior: { kind: "menu", items: toMenuEntries(descriptor, { row, observed }) }, menuKey: menuKeyFor(descriptor) };
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
  // The pill shows the native action menu; previews open as popovers.
  // Paseo re-subscribes after a reconnect; the close handler keeps the last
  // verified pills as Unknown until the next event refreshes them.
  const steerFeed = client.subscribe(
    factorySteers,
    {},
    (event) => {
      const rows = steerRowsOf(event);
      steerIds = steerAgentIds(rows);
      syncSteerPills(client, steerPills, rows, buildSteerMenuBehavior);
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
