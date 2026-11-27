import { settingsRpc, type RpcInput } from "@getpaseo/plugin";
import { useSyncExternalStore } from "react";
import type {
  PluginAgentCommandContext,
  PluginButtonBehavior,
  PluginButtonMenuEntry,
  PluginButtonRegistration,
  PluginClientContext,
  PluginWorkspaceCommandContext,
  PluginWorkspacePanelProps,
} from "@getpaseo/plugin/client";
import { copyText, Modal } from "@getpaseo/plugin/client/ui";
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
import { createFactoryResultStores } from "./client/factory-store.js";
import { createFactorySteerFeed } from "./client/factory-workspace-state.js";
import { FactorySidebarItem } from "./client/factory-sidebar-item.js";
import { submitFactoryCommand } from "./client/factory-submit.js";
import { dismissFactoryResultPill, showFactoryResultPill } from "./client/result-pill.js";
import { FactorySettings } from "./client/settings-factory.js";
import { ActivateSteer } from "./client/activate-steer.js";
import { ResetSteerForm } from "./client/steer-menu-content.js";
import {
  activationMenuBehavior,
  describeSteerMenu,
  handoverSteer,
  menuKeyFor,
  quotaConfirmationText,
  type resetSteer,
  transferStagedBrief,
  type InitializeNewSteer,
} from "./client/steer-menu.js";
import {
  attentionPillId,
  markSteerPillsDisconnected,
  steerAgentIds,
  steerRowsOf,
  syncSteerPills,
  teardownSteerPills,
  type SteerPillMap,
  type SteerPillRow,
} from "./client/steer-pill.js";
import { assertSteerContext } from "./shared/agent-guard.js";
import { attentionStatus } from "./shared/context-continuation.js";
import {
  factoryCold, factoryResume, factorySteerActivate, factorySteerBrief, factorySteers, factorySwitch, factorySwitchPreview,
} from "./shared/factory.js";
import { factorySteerMenuSettings } from "./shared/settings.js";

const SETTINGS_SCREEN_ID = "factory-settings";

function guardAgent(agent: PluginAgentCommandContext["agent"], what: string): void {
  assertSteerContext(agent, what);
}

function openFactory({ openPanel }: PluginWorkspaceCommandContext | PluginAgentCommandContext): void {
  openPanel("factory");
}

function buildSteerMenuBehavior(
  row: SteerPillRow,
  rows: SteerPillRow[],
  actions: {
    activate: Parameters<typeof activationMenuBehavior>[2];
    handover: (source: SteerPillRow, target: { slot: string; agentId: string }) => Promise<void>;
    reset: (row: SteerPillRow) => void;
    copyBrief: (row: SteerPillRow) => Promise<void>;
    openFactory: (row: SteerPillRow) => void;
  },
): { behavior: PluginButtonBehavior; menuKey: string } {
  const descriptor = describeSteerMenu(row, rows);
  const items = descriptor.map((entry): PluginButtonMenuEntry => {
    if (entry.kind === "separator") return entry;
    const item = { kind: "item" as const, id: entry.id, title: entry.title, icon: entry.icon, disabled: entry.disabled };
    switch (entry.kind) {
      case "activate": {
        const condition = entry.quotaConfirmation;
        if (!condition) return { ...item, behavior: activationMenuBehavior(row, entry.activationEpoch, actions.activate) };
        return { ...item, behavior: { kind: "popover", Content: (props) => props.context === "agent" && (
          <ActivateSteer {...props} epoch={entry.activationEpoch} alternatives={entry.activationAlternatives}
            quota={{ condition, text: quotaConfirmationText(condition, row) }} />
        ) } };
      }
      case "handover": {
        const { target } = entry;
        return { ...item, behavior: { kind: "action", onPress: () => {
          if (target && !entry.disabled) return actions.handover(row, target);
        } } };
      }
      case "reset":
        return { ...item, behavior: { kind: "action", onPress: () => actions.reset(row) } };
      case "copy-brief":
        return { ...item, behavior: { kind: "action", onPress: () => actions.copyBrief(row) } };
      case "open-factory":
        return { ...item, behavior: { kind: "action", onPress: () => actions.openFactory(row) } };
    }
  });
  return { behavior: { kind: "menu", items }, menuKey: menuKeyFor(descriptor) };
}

export default function contribute(client: PluginClientContext) {
  const panelSteers = createFactorySteerFeed();
  const workspaceResults = createFactoryResultStores();
  let resetRequest: Pick<SteerPillRow, "agentId" | "workspaceId"> | null = null;
  const resetListeners = new Set<() => void>();

  function setResetRequest(request: typeof resetRequest) {
    resetRequest = request;
    for (const listener of resetListeners) listener();
  }

  function getResetRequest() {
    return resetRequest;
  }

  function subscribeToReset(listener: () => void) {
    resetListeners.add(listener);
    return () => { resetListeners.delete(listener); };
  }

  function reportSteerResult({ workspaceId, agentId }: Pick<SteerPillRow, "workspaceId" | "agentId">, summary: string, detail: string) {
    const results = workspaceResults(workspaceId);
    results.setResult({ kind: "info", at: new Date().toISOString(), text: detail });
    showFactoryResultPill(client, { workspaceId, agentId, summary, results });
  }

  async function briefResult(workspaceId: string, result: {
    epoch: number;
    delivered: boolean;
    stageId?: string;
    stagedTo?: string | null;
    deliveryError?: unknown;
    stagingError?: unknown;
  }, initialize: InitializeNewSteer): Promise<string> {
    if (result.delivered) return "The continuation brief was sent.";
    const error = result.deliveryError ?? result.stagingError;
    const { stageId, stagedTo } = result;
    if (!stageId || !stagedTo) return String(error ?? "");
    const staged = "Review the staged brief in Factory.";
    if (error) return `${error} ${staged}`;
    if (initialize !== "composer") return staged;
    const composer = () => client.composers({ agentId: stagedTo })[0];
    if (!composer()) return staged;
    try {
      const claimId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36)}`;
      await transferStagedBrief((input) => client.rpc(factorySteerBrief, input),
        { workspaceId, agentId: stagedTo, stageId, epoch: result.epoch }, composer, { claimId, placed: false }, true);
      void composer()?.focus().catch(() => {});
      return "The continuation brief was placed in the destination composer.";
    } catch (thrown) {
      return `${thrown instanceof Error ? thrown.message : String(thrown)} ${staged}`;
    }
  }

  async function reportReset(
    source: Pick<SteerPillRow, "workspaceId" | "agentId">,
    { result, initialize }: Awaited<ReturnType<typeof resetSteer>>,
  ) {
    const summary = result.idempotent ? "Steer already reset" : "Steer reset";
    const chat = result.idempotent ? "" : "The context was reset in this tab.";
    const brief = result.idempotent ? "" : await briefResult(source.workspaceId, result, initialize);
    reportSteerResult(source, summary, [`${summary}.`, chat, brief].filter(Boolean).join(" "));
  }

  const steerActions = {
    async activate(input: RpcInput<typeof factorySteerActivate>) {
      const result = await client.rpc(factorySteerActivate, input);
      const summary = result.status === "sent" ? "Steer active" :
        result.status === "pending" ? "Activation pending" : "Continuation blocked";
      reportSteerResult(input, summary, result.detail);
    },
    async handover(source: SteerPillRow, target: { slot: string; agentId: string }) {
      try {
        const state = await client.rpc(settingsRpc(factorySteerMenuSettings.id).read, {});
        if (state.status !== "ready") throw new Error(state.error);
        const { initializeNewSteer } = factorySteerMenuSettings.schema.parse(state.values);
        const result = await handoverSteer(source, target, initializeNewSteer,
          (input) => client.rpc(factorySwitchPreview, input), (input) => client.rpc(factorySwitch, input));
        if (!result.applied) throw new Error(String(result.deliveryError ?? "Factory could not confirm the handover."));
        const detail = result.workerHandoverPending ? "Worker transfer is pending."
          : result.deliveryPending ? "The brief is queued pending context renewal."
          : result.deliveryBlocked ? String(result.deliveryError ?? "Continuation is blocked. Review recovery in Factory.")
            : await briefResult(source.workspaceId, result, initializeNewSteer);
        const summary = `Steer ${result.to} active`;
        reportSteerResult(source, summary, [`Steer ${result.to} is now active (epoch ${result.epoch}).`, detail].filter(Boolean).join(" "));
      } catch (thrown) {
        reportSteerResult(source, "Handover blocked", thrown instanceof Error ? thrown.message : String(thrown));
      }
    },
    reset({ workspaceId, agentId }: SteerPillRow) {
      client.openPanel("factory", { workspaceId, agentId });
      setResetRequest({ workspaceId, agentId });
    },
    async copyBrief({ workspaceId, agentId }: SteerPillRow) {
      const { brief } = await client.rpc(factoryResume, { workspaceId, agentId });
      await copyText(brief);
    },
    openFactory({ workspaceId, agentId }: SteerPillRow) {
      client.openPanel("factory", { workspaceId, agentId });
    },
  };

  function FactoryWorkspacePanel(props: PluginWorkspacePanelProps) {
    const request = useSyncExternalStore(subscribeToReset, getResetRequest, getResetRequest);
    const close = () => {
      if (getResetRequest() === request) setResetRequest(null);
    };
    return (
      <>
        <FactoryPanel key={props.workspaceId} {...props} steerFeed={panelSteers}
          results={workspaceResults(props.workspaceId)} composers={client.composers} />
        {request?.workspaceId === props.workspaceId ? (
          <Modal open title="Reset Steer" onOpenChange={(open) => { if (!open) close(); }}>
            <Modal.Content>
              <ResetSteerForm key={request.agentId} {...request} host={props.host} theme={props.theme}
                close={close} feed={panelSteers} onReset={reportReset} />
            </Modal.Content>
          </Modal>
        ) : null}
      </>
    );
  }

  client.addWorkspacePanel({
    id: "factory",
    title: "Factory",
    icon: "Factory",
    locations: ["workspace"],
    Component: FactoryWorkspacePanel,
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
      const results = workspaceResults(workspace.id);
      const outcome = await submitFactoryCommand(args, {
        rpc,
        workspaceId: workspace.id,
        agentId: agent.id,
        setFactoryResult: results.setResult,
      });
      if (outcome.openPanel) {
        openPanel("factory");
      } else if (outcome.pill) {
        showFactoryResultPill(client, {
          workspaceId: workspace.id,
          agentId: agent.id,
          summary: outcome.pill,
          results,
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
  // Handover, Reset and Copy are direct actions in the native menu.
  // Paseo re-subscribes after a reconnect; the close handler keeps the last
  // verified pills as Unknown until the next event refreshes them.
  const steerFeed = client.subscribe(
    factorySteers,
    {},
    (event) => {
      const rows = steerRowsOf(event);
      panelSteers.update(rows);
      steerIds = steerAgentIds(rows);
      syncSteerPills(client, steerPills, rows, (row, allRows) =>
        buildSteerMenuBehavior(row, allRows, steerActions));
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
    { onClosed: () => {
      panelSteers.disconnect();
      markSteerPillsDisconnected(steerPills);
    } },
  );
  client.addCommandCenterItem({
    id: "factory-open-panel",
    title: "Factory: open panel",
    icon: "Factory",
    keywords: ["steer", "panel", "status", "checkpoint", "plan", "switch"],
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
  return () => {
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
    setResetRequest(null);
    panelSteers.disconnect();
    void steerFeed.release().catch(() => {});
    teardownSteerPills(steerPills);
    dismissFactoryResultPill();
  };
}
