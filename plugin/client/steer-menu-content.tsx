import type { RpcOutput } from "@getpaseo/plugin";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useComposers, useRpc, useSettings, useSubscription } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  factoryFresh,
  factoryFreshPreview,
  factoryHistoryOpen,
  factoryResume,
  factoryResumeApply,
  factorySteerAdd,
  factorySteerAddPreview,
  factorySteerBrief,
  factorySteerSettings,
  factorySteerSettingsPreview,
  factorySteerSettingsRevert,
  factorySteers,
  factorySwitch,
  factorySwitchPreview,
} from "../shared/factory.js";
import { factoryConfigSettings, factorySteerMenuSettings } from "../shared/settings.js";
import type { FactorySettingsValues } from "../shared/settings-validate.js";
import {
  STEER_MENU_LABELS,
  isExpiredPreviewError,
  needsDeliveryRetry,
  normalizeInitializeNewSteer,
  resumeActionLabel,
  resumeRouteFor,
  stageComposerText,
} from "./steer-menu.js";
import { steerRowsOf, type SteerPillRow } from "./steer-pill.js";

type CreateFlow = { kind: "create"; preview: RpcOutput<typeof factorySteerAddPreview> };
type SwitchFlow = {
  kind: "switch";
  to: string;
  toAgentId: string;
  preview: RpcOutput<typeof factorySwitchPreview>;
  resumedTarget: boolean;
};
type ResumeFlow = { kind: "resume"; brief: RpcOutput<typeof factoryResume> };
type FreshFlow = { kind: "fresh"; preview: RpcOutput<typeof factoryFreshPreview>; note: string | null };
type SettingsFlow = {
  kind: "settings";
  choices: RpcOutput<typeof factorySteerSettingsPreview>;
  sel: { model: string; thinking: string | null; speed: string | null };
  preview: RpcOutput<typeof factorySteerSettingsPreview> | null;
};
type RevertFlow = {
  kind: "revert";
  observed: { provider: string | null; model: string | null; thinking: string | null; speed: string | null; sessionId: string | null };
};
type StagedFlow = { kind: "staged" };
type MenuFlow = CreateFlow | SwitchFlow | ResumeFlow | FreshFlow | SettingsFlow | RevertFlow | StagedFlow;

export type SteerMenuAction =
  | "create"
  | "handover"
  | "refresh"
  | "fresh-context"
  | "settings"
  | "revert"
  | "staged";

export interface SteerMenuProps {
  agentId: string;
  workspaceId: string;
  theme: PluginHostProps["theme"];
  compact: boolean;
  close: () => void;
  initialAction: SteerMenuAction;
  initialSlot?: string;
  initialAgentId?: string;
  observed?: RevertFlow["observed"] | null;
}

function text(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") return value === "" ? "-" : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

const NO_INPUT = {};

/**
 * One steer action per popover: the native menu item opens its own
 * preview/confirm popover, which shows only that action's flow and result.
 * Every write previews first, confirms, then applies through the same RPCs
 * as /factory; an expired preview is re-requested for review.
 */
export function SteerMenu({
  agentId,
  workspaceId,
  theme,
  compact,
  close,
  initialAction,
  initialSlot,
  initialAgentId,
  observed,
}: SteerMenuProps) {
  const callSteerAddPreview = useRpc(factorySteerAddPreview);
  const callSteerAdd = useRpc(factorySteerAdd);
  const callSwitchPreview = useRpc(factorySwitchPreview);
  const callSwitch = useRpc(factorySwitch);
  const callResume = useRpc(factoryResume);
  const callResumeApply = useRpc(factoryResumeApply);
  const callFreshPreview = useRpc(factoryFreshPreview);
  const callFresh = useRpc(factoryFresh);
  const callBrief = useRpc(factorySteerBrief);
  const callHistory = useRpc(factoryHistoryOpen);
  const callSettingsPreview = useRpc(factorySteerSettingsPreview);
  const callSettings = useRpc(factorySteerSettings);
  const callRevert = useRpc(factorySteerSettingsRevert);
  const menuSettings = useSettings(factorySteerMenuSettings);
  const configState = useSettings(factoryConfigSettings);

  const [rows, setRows] = useState<SteerPillRow[] | null>(null);
  const onEvent = useCallback((event: unknown) => {
    setRows(steerRowsOf(event));
  }, []);
  useSubscription(factorySteers, NO_INPUT, onEvent);
  const self = rows?.find((row) => row.agentId === agentId) ?? null;

  const [flow, setFlow] = useState<MenuFlow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingComposer, setPendingComposer] = useState<{ agentId: string; packet: string } | null>(null);
  const [laterStage, setLaterStage] = useState<{ agentId: string; slot: string | null } | null>(null);
  const [historyAgent, setHistoryAgent] = useState<string | null>(null);
  const [retryStage, setRetryStage] = useState<{ agentId: string } | null>(null);
  const settleRef = useRef(false);
  const startedRef = useRef(false);

  const initializeNewSteer = normalizeInitializeNewSteer(
    menuSettings.status === "ready" ? menuSettings.values.initializeNewSteer : undefined,
  );
  const keepChatHistory =
    menuSettings.status === "ready" ? menuSettings.values.keepChatHistory === true : false;

  // Destination composer for "place the brief in the composer"; while idle
  // the hook watches this tab (harmless) so the call stays unconditional.
  const [destComposer] = useComposers({ agentId: pendingComposer?.agentId ?? agentId });

  const styles = useMemo(
    () => ({
      box: { padding: compact ? 12 : 16, gap: 8, minWidth: 280 },
      section: { color: theme.colors.foreground, fontSize: 14 },
      body: { color: theme.colors.foreground, fontSize: 14 },
      label: { color: theme.colors.foregroundMuted, fontSize: 13 },
      error: { color: theme.colors.statusDanger, fontSize: 14 },
      ok: { color: theme.colors.statusSuccess, fontSize: 14 },
      warn: { color: theme.colors.statusWarning, fontSize: 14 },
      button: {
        paddingVertical: compact ? 8 : 10,
        paddingHorizontal: 14,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
      },
      buttonText: { color: theme.colors.accentForeground, fontSize: 14, textAlign: "center" as const },
      secondary: { paddingVertical: 8 },
      row: {
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        padding: 10,
        gap: 2,
      },
      option: {
        paddingVertical: 6,
        paddingHorizontal: 10,
        borderRadius: 6,
        backgroundColor: theme.colors.surface1,
      },
      optionSelected: {
        paddingVertical: 6,
        paddingHorizontal: 10,
        borderRadius: 6,
        backgroundColor: theme.colors.accent,
      },
    }),
    [theme, compact],
  );

  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await operation();
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown));
    } finally {
      setBusy(false);
    }
  };

  const onOpenHistory = (target: string): void => {
    void run(async () => {
      await callHistory({ agentId: target });
      setNotice("Saved chat opened in a new tab.");
    });
  };

  // Places a staged packet into the destination composer once it is mounted.
  // The composer of a fresh agent mounts shortly after the apply; when none
  // appears within the grace period the brief is sent instead (fallback). The
  // ref settles exactly one path, so a late composer cannot duplicate a send.
  useEffect(() => {
    if (!pendingComposer) return;
    if (settleRef.current) return;
    if (destComposer) {
      settleRef.current = true;
      const { agentId: target, packet } = pendingComposer;
      const { method, text: staged } = stageComposerText(destComposer.prompt, packet);
      void (async () => {
        setBusy(true);
        try {
          if (method === "setPrompt") destComposer.setPrompt(staged);
          else destComposer.insertText(staged);
          await callBrief({ workspaceId, agentId: target, action: "dismiss" });
          setNotice("Brief placed in the composer. It goes out with the next prompt.");
          destComposer.focus().catch(() => {});
        } catch (thrown) {
          setError(thrown instanceof Error ? thrown.message : String(thrown));
        } finally {
          setBusy(false);
          setPendingComposer(null);
        }
      })();
      return;
    }
    const timer = setTimeout(() => {
      if (settleRef.current) return;
      settleRef.current = true;
      const { agentId: target } = pendingComposer;
      void (async () => {
        setBusy(true);
        try {
          const sent = await callBrief({ workspaceId, agentId: target, action: "send" });
          setNotice(
            sent.delivered ? "No composer tab open. Brief sent instead." : sent.detail,
          );
        } catch (thrown) {
          setError(thrown instanceof Error ? thrown.message : String(thrown));
        } finally {
          setBusy(false);
          setPendingComposer(null);
        }
      })();
    }, 5000);
    return () => clearTimeout(timer);
  }, [pendingComposer, destComposer, callBrief, workspaceId]);

  const beginComposerStage = (target: string, packet: string): void => {
    settleRef.current = false;
    setPendingComposer({ agentId: target, packet });
  };

  const onRetryDelivery = (target: string): void => {
    void run(async () => {
      const sent = await callBrief({ workspaceId, agentId: target, action: "send" });
      setRetryStage(null);
      setNotice(sent.delivered ? "Brief sent." : sent.detail);
      if (!sent.delivered) setLaterStage(null);
    });
  };

  const onInitializeNow = (target: string): void => {
    void run(async () => {
      const sent = await callBrief({ workspaceId, agentId: target, action: "send" });
      if (sent.delivered) {
        setLaterStage(null);
        setNotice("Brief sent.");
      } else {
        setNotice(sent.detail);
      }
    });
  };

  const onDismissBrief = (target: string): void => {
    void run(async () => {
      await callBrief({ workspaceId, agentId: target, action: "dismiss" });
      setLaterStage(null);
      setRetryStage(null);
      setNotice("Staged brief dismissed.");
    });
  };

  // Shared post-apply delivery: delivered, staged for the composer, staged
  // for later, or a partial apply with a retry.
  const afterDelivery = (args: {
    head: string;
    tail: string | null;
    toAgentId: string;
    slot: string | null;
    packet?: string;
    staged?: boolean;
    delivered: boolean;
    deliveryError?: unknown;
  }): void => {
    const tail = args.tail ? ` ${args.tail}` : "";
    if (args.delivered) {
      setNotice(`${args.head}${tail}`);
      return;
    }
    if (initializeNewSteer === "composer" && args.staged === true && args.packet) {
      beginComposerStage(args.toAgentId, args.packet);
      setNotice(`${args.head} Placing the brief in its composer…`);
      return;
    }
    if (needsDeliveryRetry({ applied: true, delivered: args.delivered, staged: args.staged })) {
      if (initializeNewSteer === "later") {
        setLaterStage({ agentId: args.toAgentId, slot: args.slot });
        setNotice(`${args.head} The brief is staged; initialize it from this menu or send it now.`);
      } else {
        setRetryStage({ agentId: args.toAgentId });
        setNotice(`${args.head} The brief did not go out; retry the delivery.`);
      }
      return;
    }
    if (args.deliveryError) {
      setError(`Applied, but the brief did not go out: ${text(args.deliveryError)}`);
      return;
    }
    setNotice(`${args.head}${tail}`);
  };

  // --- Create steer ----------------------------------------------------------

  const startCreate = (): void => {
    void run(async () => {
      const preview = await callSteerAddPreview({ workspaceId });
      setFlow({ kind: "create", preview });
    });
  };

  const onConfirmCreate = (current: CreateFlow): void => {
    void run(async () => {
      // The settings save between preview and apply makes staleness likely:
      // re-preview and compare before writing anything.
      const fresh = await callSteerAddPreview({ workspaceId });
      if (fresh.fingerprint !== current.preview.fingerprint) {
        setFlow({ kind: "create", preview: fresh });
        setNotice("The preview changed. Review the new preview.");
        return;
      }
      if (!fresh.fingerprint) {
        throw new Error("The preview has no fingerprint. Review the preview again.");
      }
      if (configState.status !== "ready") {
        throw new Error("Factory settings are not ready. Open the Factory settings and try again.");
      }
      const saved = await configState.save(fresh.values as FactorySettingsValues, fresh.revision);
      if (!saved) {
        throw new Error(
          `Not saved: ${configState.saveError ?? "revision conflict"}. Review the preview again.`,
        );
      }
      const added = await callSteerAdd({ workspaceId, slot: fresh.slot, fingerprint: fresh.fingerprint });
      setFlow(null);
      setNotice(
        `Steer ${added.slot} created (${added.provider}/${added.model}). ` +
          "The current coordinator stays active until a handover.",
      );
    });
  };

  // --- Hand over to… (one target, chosen in the menu submenu) ------------------

  const startHandover = (toSlot: string, toAgentId: string): void => {
    void run(async () => {
      const preview = await callSwitchPreview({ workspaceId, to: toSlot });
      setFlow({ kind: "switch", to: toSlot, toAgentId, preview, resumedTarget: false });
    });
  };

  const onResumeAndHandover = (toSlot: string, toAgentId: string): void => {
    void run(async () => {
      const row = rows?.find((entry) => entry.agentId === toAgentId) ?? null;
      const route = row ? resumeRouteFor(row, { keepChatHistory }) : null;
      if (!route || route.kind !== "resume-apply") {
        throw new Error("No verified recovery route for this destination.");
      }
      await callResumeApply({ workspaceId, agentId: toAgentId });
      const preview = await callSwitchPreview({ workspaceId, to: toSlot });
      setFlow({ kind: "switch", to: toSlot, toAgentId, preview, resumedTarget: true });
      setNotice(`Steer ${toSlot} resumed. Review the handover.`);
    });
  };

  const onConfirmSwitch = (current: SwitchFlow): void => {
    void run(async () => {
      const deliver = initializeNewSteer === "send" ? "send" : "stage";
      let applied: RpcOutput<typeof factorySwitch>;
      try {
        applied = await callSwitch({
          workspaceId,
          to: current.to,
          fingerprint: current.preview.fingerprint,
          deliver,
          notifyPrevious: false,
        });
      } catch (thrown) {
        if (isExpiredPreviewError(thrown)) {
          const preview = await callSwitchPreview({ workspaceId, to: current.to });
          setFlow({ ...current, preview });
          setNotice("The preview expired. Review the new preview.");
          return;
        }
        throw thrown;
      }
      setFlow(null);
      afterDelivery({
        head: `Steer ${applied.to} is now active (epoch ${applied.epoch}).`,
        tail: "The previous tab keeps its chat; it no longer coordinates.",
        toAgentId: current.toAgentId,
        slot: current.to,
        packet: applied.packet,
        staged: applied.staged,
        delivered: applied.delivered,
        deliveryError: applied.deliveryError,
      });
    });
  };

  // --- Resume / Refresh (this tab) ---------------------------------------------

  const startResume = (current: SteerPillRow): void => {
    void run(async () => {
      const route = resumeRouteFor(current, { keepChatHistory });
      if (route.kind === "blocked") {
        setError(route.reason);
        return;
      }
      if (route.kind === "reset-details") {
        setError("Quota depleted. Hand over to a steer with room, or wait for the reset.");
        return;
      }
      if (route.kind === "resume-apply") {
        const brief = await callResume({ workspaceId, agentId });
        setFlow({ kind: "resume", brief });
        return;
      }
      if (!current.slot) {
        throw new Error("This tab has no steer slot.");
      }
      const preview = await callFreshPreview({ workspaceId, slot: current.slot });
      setFlow({ kind: "fresh", preview, note: route.note });
    });
  };

  const onConfirmResume = (current: ResumeFlow): void => {
    void run(async () => {
      const applied = await callResumeApply({ workspaceId, agentId, takeover: true });
      setFlow(null);
      if (applied.cleared) setHistoryAgent(agentId);
      setNotice(applied.detail);
    });
  };

  const onConfirmFresh = (current: FreshFlow, slot: string | null): void => {
    void run(async () => {
      if (!slot) throw new Error("This tab has no steer slot.");
      const deliver = initializeNewSteer === "send" ? "send" : "stage";
      let applied: RpcOutput<typeof factoryFresh>;
      try {
        applied = await callFresh({
          workspaceId,
          slot: current.preview.slot,
          fingerprint: current.preview.fingerprint,
          deliver,
          notifyPrevious: false,
        });
      } catch (thrown) {
        if (isExpiredPreviewError(thrown)) {
          const preview = await callFreshPreview({ workspaceId, slot: current.preview.slot });
          setFlow({ ...current, preview });
          setNotice("The preview expired. Review the new preview.");
          return;
        }
        throw thrown;
      }
      setFlow(null);
      const toId = typeof applied.to === "string" && applied.to ? applied.to : agentId;
      const rewound = applied.refreshMode === "rewind" || toId === agentId;
      if (applied.idempotent === true) {
        setNotice("This chat was already refreshed.");
        return;
      }
      if (rewound) setHistoryAgent(agentId);
      afterDelivery({
        head: rewound ? "Chat refreshed in this tab." : `Steer ${text(applied.slot)} has a new agent.`,
        tail: rewound
          ? "Earlier messages left this tab."
          : "The old tab keeps its chat; archive it in Paseo when done.",
        toAgentId: toId,
        slot: typeof applied.slot === "string" ? applied.slot : slot,
        packet: applied.packet,
        staged: applied.staged,
        delivered: applied.delivered,
        deliveryError: applied.deliveryError,
      });
    });
  };

  // --- Change settings (this tab, same provider) ---------------------------------

  const startSettings = (): void => {
    void run(async () => {
      const choices = await callSettingsPreview({ workspaceId, agentId });
      setFlow({
        kind: "settings",
        choices,
        sel: {
          model: choices.current.model ?? choices.models[0] ?? "",
          thinking: choices.current.thinking,
          speed: choices.current.speed,
        },
        preview: null,
      });
    });
  };

  const onPreviewSettings = (current: SettingsFlow): void => {
    void run(async () => {
      const preview = await callSettingsPreview({
        workspaceId,
        agentId,
        model: current.sel.model || undefined,
        thinking: current.sel.thinking,
        speed: current.sel.speed,
      });
      setFlow({ ...current, choices: preview, preview });
    });
  };

  const onConfirmSettings = (current: SettingsFlow): void => {
    void run(async () => {
      const preview = current.preview;
      if (!preview) throw new Error("Preview the change first.");
      const deliver = initializeNewSteer === "send" ? "send" : "stage";
      let applied: RpcOutput<typeof factorySteerSettings>;
      try {
        applied = await callSettings({
          workspaceId,
          agentId,
          fingerprint: preview.fingerprint,
          route: preview.route,
          model: current.sel.model || undefined,
          thinking: current.sel.thinking,
          speed: current.sel.speed,
          deliver,
        });
      } catch (thrown) {
        if (isExpiredPreviewError(thrown)) {
          const next = await callSettingsPreview({
            workspaceId,
            agentId,
            model: current.sel.model || undefined,
            thinking: current.sel.thinking,
            speed: current.sel.speed,
          });
          setFlow({ ...current, choices: next, preview: next });
          setNotice("The preview expired. Review the new preview.");
          return;
        }
        throw thrown;
      }
      setFlow(null);
      if (applied.noop) {
        setNotice("No change.");
        return;
      }
      if (applied.route === "apply-here") {
        if (applied.verified) {
          setNotice(applied.detail);
        } else {
          setError(applied.detail);
        }
        return;
      }
      if (applied.verified) {
        afterDelivery({
          head: "Chat rewound and settings applied.",
          tail: null,
          toAgentId: agentId,
          slot: self?.slot ?? null,
          packet: applied.packet,
          staged: applied.staged,
          delivered: applied.delivered === true,
          deliveryError: applied.deliveryError,
        });
      } else {
        setRetryStage({ agentId });
        setError(applied.detail);
      }
    });
  };

  // --- Revert settings (restore the turn-end baseline) -----------------------------

  const startRevert = (seen: RevertFlow["observed"]): void => {
    setFlow({ kind: "revert", observed: seen });
  };

  const onConfirmRevert = (current: RevertFlow): void => {
    void run(async () => {
      const reverted = await callRevert({ workspaceId, agentId, observed: current.observed });
      setFlow(null);
      setNotice(reverted.detail);
    });
  };

  // --- Staged brief (this tab) ------------------------------------------------------

  const startStaged = (): void => {
    setFlow({ kind: "staged" });
  };

  // --- Auto-start ---------------------------------------------------------------

  const needsRows = initialAction === "handover" ||
    initialAction === "refresh" ||
    initialAction === "fresh-context" ||
    initialAction === "revert";

  useEffect(() => {
    if (startedRef.current) return;
    if (initialAction === "revert") {
      startedRef.current = true;
      if (!observed) {
        setError("No observed change to revert.");
        return;
      }
      startRevert(observed);
      return;
    }
    if (initialAction === "staged") {
      startedRef.current = true;
      startStaged();
      return;
    }
    if (initialAction === "create") {
      startedRef.current = true;
      startCreate();
      return;
    }
    if (initialAction === "settings") {
      startedRef.current = true;
      startSettings();
      return;
    }
    if (!rows) return;
    const current = rows.find((entry) => entry.agentId === agentId) ?? null;
    if (!current) {
      startedRef.current = true;
      return;
    }
    startedRef.current = true;
    if (initialAction === "handover") {
      const toSlot = initialSlot ?? "";
      const toAgentId = initialAgentId ?? rows.find((entry) => entry.slot === toSlot)?.agentId ?? "";
      if (!toSlot || !toAgentId) {
        setError("Handover target is missing.");
        return;
      }
      startHandover(toSlot, toAgentId);
      return;
    }
    startResume(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const cancelFlow = (): void => {
    setFlow(null);
    setError(null);
    setNotice(null);
  };

  const actionButton = (
    key: string,
    label: string,
    accessibilityLabel: string,
    onPress: () => void,
    opts?: { primary?: boolean },
  ): ReactNode => (
    <Pressable
      key={key}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={opts?.primary === false ? styles.secondary : styles.button}
      disabled={busy}
      onPress={onPress}
    >
      <Text style={opts?.primary === false ? styles.label : styles.buttonText}>
        {busy ? "Please wait…" : label}
      </Text>
    </Pressable>
  );

  const optionButton = (
    key: string,
    label: string,
    selected: boolean,
    accessibilityLabel: string,
    onPress: () => void,
  ): ReactNode => (
    <Pressable
      key={key}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={selected ? styles.optionSelected : styles.option}
      disabled={busy}
      onPress={onPress}
    >
      <Text style={selected ? styles.buttonText : styles.body}>{label}</Text>
    </Pressable>
  );

  const renderFlow = (): ReactNode => {
    if (!flow) return null;
    if (flow.kind === "create") {
      const preview = flow.preview;
      return (
        <View style={{ gap: 4 }}>
          <Text style={styles.section}>Create Steer {text(preview.slot)}</Text>
          <Text style={styles.body}>{text(preview.summary)}</Text>
          {preview.warnings.map((warning) => (
            <Text key={warning} style={styles.warn}>
              {warning}
            </Text>
          ))}
          {preview.notes.map((note) => (
            <Text key={note} style={styles.label}>
              {note}
            </Text>
          ))}
          {actionButton("confirm-create", STEER_MENU_LABELS.confirmCreate, "Confirm steer creation", () =>
            onConfirmCreate(flow),
          )}
          {actionButton("cancel-create", STEER_MENU_LABELS.cancel, "Cancel steer creation", cancelFlow, {
            primary: false,
          })}
        </View>
      );
    }
    if (flow.kind === "switch") {
      const preview = flow.preview;
      const targetRow = rows?.find((entry) => entry.agentId === flow.toAgentId) ?? null;
      const recoveryRoute = targetRow ? resumeRouteFor(targetRow, { keepChatHistory }) : null;
      const canRecover = targetRow?.state === "needs-resume" && recoveryRoute?.kind === "resume-apply";
      return (
        <View style={{ gap: 4 }}>
          <Text style={styles.section}>
            Hand over to Steer {flow.to} (epoch {text(preview.epoch)} → {text(preview.epoch + 1)})
          </Text>
          {flow.resumedTarget ? <Text style={styles.ok}>Destination resumed.</Text> : null}
          <Text style={styles.body}>
            {text(preview.packetChars)} characters, {preview.checkpoint ? "with" : "without"} task checkpoint.
          </Text>
          <Text style={styles.label}>
            One brief goes to the destination. The previous tab is updated through Factory state.
          </Text>
          {canRecover && !flow.resumedTarget
            ? actionButton("resume-handover", STEER_MENU_LABELS.resumeAndHandover, `Resume Steer ${flow.to} and hand over`, () =>
              onResumeAndHandover(flow.to, flow.toAgentId),
            )
            : null}
          {actionButton("confirm-switch", STEER_MENU_LABELS.confirmHandover, "Confirm handover", () =>
            onConfirmSwitch(flow),
          )}
          {actionButton("cancel-switch", STEER_MENU_LABELS.cancel, "Cancel handover", cancelFlow, {
            primary: false,
          })}
        </View>
      );
    }
    if (flow.kind === "resume") {
      return (
        <View style={{ gap: 4 }}>
          <Text style={styles.section}>{self ? resumeActionLabel(self.state) : "Resume"}</Text>
          <Text style={styles.warn}>
            This clears the chat in this tab. Earlier messages leave this tab.
          </Text>
          <Text style={styles.label}>{flow.brief.brief.slice(0, 400)}</Text>
          {actionButton("confirm-resume", STEER_MENU_LABELS.confirmResume, "Confirm resume", () =>
            onConfirmResume(flow),
          )}
          {actionButton("cancel-resume", STEER_MENU_LABELS.cancel, "Cancel resume", cancelFlow, {
            primary: false,
          })}
        </View>
      );
    }
    if (flow.kind === "fresh") {
      const preview = flow.preview;
      const rewind = preview.refreshMode !== "new-agent";
      return (
        <View style={{ gap: 4 }}>
          <Text style={styles.section}>
            {rewind ? "Refresh this chat (rewind)" : "Refresh with a new agent"}
          </Text>
          {flow.note ? <Text style={styles.body}>{flow.note}</Text> : null}
          <Text style={styles.warn}>
            {rewind
              ? "This resets the chat and removes later messages from this tab."
              : "This creates a new agent for the slot. The old tab keeps its chat."}
          </Text>
          <Text style={styles.body}>
            {text(preview.provider)}/{text(preview.model)} · {text(preview.packetChars)} characters,{" "}
            {preview.checkpoint ? "with" : "without"} task checkpoint.
          </Text>
          {(preview.warnings ?? []).map((warning) => (
            <Text key={warning} style={styles.warn}>
              {warning}
            </Text>
          ))}
          {actionButton("confirm-fresh", STEER_MENU_LABELS.confirmRefresh, "Confirm refresh", () =>
            onConfirmFresh(flow, self?.slot ?? null),
          )}
          {actionButton("cancel-fresh", STEER_MENU_LABELS.cancel, "Cancel refresh", cancelFlow, {
            primary: false,
          })}
        </View>
      );
    }
    if (flow.kind === "settings") {
      return renderSettingsFlow(flow);
    }
    if (flow.kind === "revert") {
      const baseline = self?.baseline ?? null;
      return (
        <View style={{ gap: 4 }}>
          <Text style={styles.section}>Revert settings</Text>
          <Text style={styles.body}>
            Restore {text(baseline?.model ?? "-")} · thinking {text(baseline?.thinking ?? "default")} ·{" "}
            {text(baseline?.speed ?? "default")}?
          </Text>
          <Text style={styles.label}>
            A revert cannot promise a cache hit or refund a turn already started.
          </Text>
          {actionButton("confirm-revert", STEER_MENU_LABELS.confirmRevert, "Confirm revert", () =>
            onConfirmRevert(flow),
          )}
          {actionButton("cancel-revert", STEER_MENU_LABELS.cancel, "Cancel revert", cancelFlow, {
            primary: false,
          })}
        </View>
      );
    }
    return (
      <View style={{ gap: 4 }}>
        <Text style={styles.body}>A brief is staged for this tab.</Text>
        {actionButton("init-now", STEER_MENU_LABELS.initializeNow, "Send the staged brief now", () =>
          onInitializeNow(agentId),
        )}
        {actionButton(
          "dismiss",
          STEER_MENU_LABELS.dismissBrief,
          "Dismiss the staged brief",
          () => onDismissBrief(agentId),
          { primary: false },
        )}
      </View>
    );
  };

  const renderSettingsFlow = (current: SettingsFlow): ReactNode => {
    const choices = current.preview ?? current.choices;
    const locked = choices.efficiencyLocked && !choices.noop;
    const select = (patch: Partial<SettingsFlow["sel"]>): void => {
      setFlow({ ...current, sel: { ...current.sel, ...patch }, preview: null });
      setError(null);
      setNotice(null);
    };
    return (
      <View style={{ gap: 4 }}>
        <Text style={styles.section}>Change settings…</Text>
        <Text style={styles.label}>
          Current: {text(choices.current.model)} · thinking {text(choices.current.thinking ?? "default")} ·{" "}
          {text(choices.current.speed ?? "default")}
        </Text>
        <Text style={styles.body}>Model</Text>
        {choices.models.map((model) => optionButton(
          `model-${model}`,
          model,
          current.sel.model === model,
          `Use model ${model}`,
          () => select({ model }),
        ))}
        <Text style={styles.body}>Thinking</Text>
        {[null, ...choices.thinkingOptions].map((thinking) => optionButton(
          `thinking-${thinking ?? "default"}`,
          thinking ?? "Default",
          current.sel.thinking === thinking,
          thinking ? `Use thinking ${thinking}` : "Use the provider default thinking",
          () => select({ thinking }),
        ))}
        <Text style={styles.body}>Speed</Text>
        {[null, ...choices.speeds].map((speed) => optionButton(
          `speed-${speed ?? "default"}`,
          speed ?? "Default",
          current.sel.speed === speed,
          speed ? `Use speed ${speed}` : "Use the provider default speed",
          () => select({ speed }),
        ))}
        {current.preview ? (
          <View style={{ gap: 4 }}>
            <Text style={styles.body}>
              Route: {current.preview.route === "refresh" ? "Refresh" : "Apply here"} · {current.preview.routeReason}
            </Text>
            {current.preview.warnings.map((warning) => (
              <Text key={warning} style={styles.warn}>
                {warning}
              </Text>
            ))}
            {locked ? (
              <Text style={styles.warn}>
                {text(choices.lockReason)} Change settings after a refresh.
              </Text>
            ) : (
              actionButton("confirm-settings", STEER_MENU_LABELS.confirmSettings, "Apply the settings change", () =>
                onConfirmSettings(current),
              )
            )}
          </View>
        ) : (
          actionButton("preview-settings", "Preview route", "Preview the settings route", () =>
            onPreviewSettings(current),
          )
        )}
        {actionButton("cancel-settings", STEER_MENU_LABELS.cancel, "Cancel settings change", cancelFlow, {
          primary: false,
        })}
      </View>
    );
  };

  if (needsRows && rows === null) {
    return (
      <View style={styles.box}>
        <Text style={styles.label}>Loading steer status…</Text>
      </View>
    );
  }
  if (needsRows && !self) {
    return (
      <View style={styles.box}>
        <Text style={styles.label}>Steer status unavailable.</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close steer menu"
          style={styles.button}
          onPress={close}
        >
          <Text style={styles.buttonText}>Close</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <ScrollView>
      <View style={styles.box}>
        {renderFlow()}
        {pendingComposer ? (
          <Text style={styles.label}>Placing the brief in the composer…</Text>
        ) : null}
        {laterStage ? (
          <View style={{ gap: 4 }}>
            <Text style={styles.body}>
              Brief staged{laterStage.slot ? ` for Steer ${laterStage.slot}` : ""}. Initialize it from
              this menu or send it now.
            </Text>
            {actionButton(
              "init-now",
              STEER_MENU_LABELS.initializeNow,
              "Send the staged brief now",
              () => onInitializeNow(laterStage.agentId),
            )}
            {actionButton(
              "dismiss",
              STEER_MENU_LABELS.dismissBrief,
              "Dismiss the staged brief",
              () => onDismissBrief(laterStage.agentId),
              { primary: false },
            )}
          </View>
        ) : null}
        {retryStage ? (
          <View style={{ gap: 4 }}>
            {actionButton(
              "retry",
              STEER_MENU_LABELS.retryDelivery,
              "Retry the brief delivery",
              () => onRetryDelivery(retryStage.agentId),
            )}
            {actionButton(
              "dismiss-retry",
              STEER_MENU_LABELS.dismissBrief,
              "Dismiss the staged brief",
              () => onDismissBrief(retryStage.agentId),
              { primary: false },
            )}
          </View>
        ) : null}
        {historyAgent ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open the saved chat in a new tab"
            style={styles.secondary}
            disabled={busy}
            onPress={() => onOpenHistory(historyAgent)}
          >
            <Text style={styles.label}>{STEER_MENU_LABELS.openSavedChat}</Text>
          </Pressable>
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {notice ? <Text style={styles.ok}>{notice}</Text> : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close steer menu"
          style={styles.button}
          onPress={close}
        >
          <Text style={styles.buttonText}>Close</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}
