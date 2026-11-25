import type { RpcOutput } from "@getpaseo/plugin";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useComposers, useRpc, useSettings } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import {
  factoryFresh,
  factoryFreshPreview,
  factoryHistoryOpen,
  factoryResume,
  factoryResumeApply,
  factorySteerAdd,
  factorySteerAddPreview,
  factorySteerBrief,
  factorySwitch,
  factorySwitchPreview,
} from "../shared/factory.js";
import { factoryConfigSettings, factorySteerMenuSettings } from "../shared/settings.js";
import type { FactorySettingsValues } from "../shared/settings-validate.js";
import type { FactoryPanelResult } from "./factory-store.js";
import {
  STEER_MENU_LABELS,
  handoffTargets,
  isExpiredPreviewError,
  needsDeliveryRetry,
  normalizeInitializeNewSteer,
  resumeActionLabel,
  resumeRouteFor,
  stageComposerText,
  type HandoffTarget,
} from "./steer-menu.js";
import { requestOpenFactory } from "./steer-nav.js";
import { setSteerResult } from "./steer-results.js";
import { formatQuotaRow, type SteerPillRow } from "./steer-pill.js";

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
type MenuFlow = CreateFlow | SwitchFlow | ResumeFlow | FreshFlow;

export interface SteerMenuProps {
  hostId: string;
  agentId: string;
  workspaceId: string;
  rows: SteerPillRow[];
  self: SteerPillRow;
  theme: PluginHostProps["theme"];
  compact: boolean;
  nowMs: number;
  close: () => void;
}

function text(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") return value === "" ? "-" : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * Steer menu: Create steer, Hand over to (submenu), Resume/Refresh and Open
 * Factory. Every write previews first, confirms, then applies through the
 * same RPCs as /factory; an expired preview is re-requested for review. Local
 * state (flows, notices) lives apart from the countdown clock, so quota ticks
 * never replace an open confirmation.
 */
export function SteerMenu({
  hostId,
  agentId,
  workspaceId,
  rows,
  self,
  theme,
  compact,
  nowMs,
  close,
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
  const menuSettings = useSettings(factorySteerMenuSettings);
  const configState = useSettings(factoryConfigSettings);

  const [handoverOpen, setHandoverOpen] = useState(false);
  const [flow, setFlow] = useState<MenuFlow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingComposer, setPendingComposer] = useState<{ agentId: string; packet: string } | null>(null);
  const [laterStage, setLaterStage] = useState<{ agentId: string; slot: string | null } | null>(null);
  const [historyAgent, setHistoryAgent] = useState<string | null>(null);
  const [retryStage, setRetryStage] = useState<{ agentId: string } | null>(null);
  const settleRef = useRef(false);

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
    }),
    [theme, compact],
  );

  const publish = (result: FactoryPanelResult): void => {
    setSteerResult(hostId, agentId, result);
  };

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

  const failResult = (message: string): void => {
    publish({ kind: "error", at: new Date().toISOString(), message });
  };

  const onOpenFactory = (): void => {
    requestOpenFactory({ workspaceId, agentId });
    close();
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

  // --- Create steer ----------------------------------------------------------

  const onCreate = (): void => {
    void run(async () => {
      const preview = await callSteerAddPreview({ workspaceId });
      setHandoverOpen(false);
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
      publish({ kind: "steerAdded", repo: added.scope, at: new Date().toISOString(), added });
      setNotice(
        `Steer ${added.slot} created (${added.provider}/${added.model}). ` +
          "The current coordinator stays active until a handover.",
      );
    });
  };

  // --- Hand over to… ----------------------------------------------------------

  const targets: HandoffTarget[] = useMemo(
    () => (handoverOpen || flow?.kind === "switch" ? handoffTargets(rows, agentId) : []),
    [handoverOpen, flow, rows, agentId],
  );

  const rowOf = (id: string): SteerPillRow | null => rows.find((row) => row.agentId === id) ?? null;

  const onHandoverPreview = (target: HandoffTarget): void => {
    void run(async () => {
      const preview = await callSwitchPreview({ workspaceId, to: target.slot });
      setFlow({ kind: "switch", to: target.slot, toAgentId: target.agentId, preview, resumedTarget: false });
    });
  };

  const onResumeAndHandover = (target: HandoffTarget): void => {
    void run(async () => {
      const row = rowOf(target.agentId);
      const route = row ? resumeRouteFor(row, { keepChatHistory }) : null;
      if (!route || route.kind !== "resume-apply") {
        throw new Error("No verified recovery route for this destination.");
      }
      await callResumeApply({ workspaceId, agentId: target.agentId });
      const preview = await callSwitchPreview({ workspaceId, to: target.slot });
      setFlow({ kind: "switch", to: target.slot, toAgentId: target.agentId, preview, resumedTarget: true });
      setNotice(`Steer ${target.slot} resumed. Review the handover.`);
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
      setHandoverOpen(false);
      publish({ kind: "switched", repo: applied.repo, at: new Date().toISOString(), result: applied });
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
      failResult(String(args.deliveryError));
      setError(`Applied, but the brief did not go out: ${text(args.deliveryError)}`);
      return;
    }
    setNotice(`${args.head}${tail}`);
  };

  // --- Resume / Refresh -------------------------------------------------------

  const onResume = (): void => {
    void run(async () => {
      const route = resumeRouteFor(self, { keepChatHistory });
      if (route.kind === "blocked") {
        setError(route.reason);
        return;
      }
      if (route.kind === "reset-details") {
        setHandoverOpen(true);
        setNotice("Quota depleted. Hand over to a steer with room, or wait for the reset.");
        return;
      }
      if (route.kind === "resume-apply") {
        const brief = await callResume({ workspaceId, agentId });
        setHandoverOpen(false);
        setFlow({ kind: "resume", brief });
        return;
      }
      if (!self.slot) {
        throw new Error("This tab has no steer slot.");
      }
      const preview = await callFreshPreview({ workspaceId, slot: self.slot });
      setHandoverOpen(false);
      setFlow({ kind: "fresh", preview, note: route.note });
    });
  };

  const onConfirmResume = (current: ResumeFlow): void => {
    void run(async () => {
      const applied = await callResumeApply({ workspaceId, agentId, takeover: true });
      setFlow(null);
      publish({
        kind: "resumeApplied",
        workspaceId,
        agentId,
        at: new Date().toISOString(),
        applied,
      });
      if (applied.cleared) setHistoryAgent(agentId);
      setNotice(applied.detail);
    });
  };

  const onConfirmFresh = (current: FreshFlow): void => {
    void run(async () => {
      if (!self.slot) throw new Error("This tab has no steer slot.");
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
      publish({
        kind: "info",
        at: new Date().toISOString(),
        text:
          `Refreshed Steer ${text(applied.slot)} ` +
          (rewound ? "(same tab, rewound)" : `(new agent ${text(applied.to)})`) +
          ".",
      });
      if (rewound) setHistoryAgent(agentId);
      afterDelivery({
        head: rewound ? "Chat refreshed in this tab." : `Steer ${text(applied.slot)} has a new agent.`,
        tail: rewound
          ? "Earlier messages left this tab."
          : "The old tab keeps its chat; archive it in Paseo when done.",
        toAgentId: toId,
        slot: typeof applied.slot === "string" ? applied.slot : self.slot,
        packet: applied.packet,
        staged: applied.staged,
        delivered: applied.delivered,
        deliveryError: applied.deliveryError,
      });
    });
  };

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

  const renderHandoverRow = (target: HandoffTarget): ReactNode => {
    const row = rowOf(target.agentId);
    const quota = row?.quotaRows.map((entry) => formatQuotaRow(entry, nowMs)).join(" · ") || null;
    const head = `Steer ${target.slot} · ${target.stateLabel}`;
    const route = [target.provider, target.model].filter(Boolean).join("/");
    const recoveryRow = row ? resumeRouteFor(row, { keepChatHistory }) : null;
    const canRecover = target.needsRecovery && recoveryRow?.kind === "resume-apply";
    return (
      <View key={target.agentId} style={styles.row}>
        <Text style={styles.body}>{head}</Text>
        {route ? <Text style={styles.label}>{route}</Text> : null}
        {quota ? <Text style={styles.label}>{quota}</Text> : null}
        {target.eligible ? (
          <View style={{ gap: 4 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Hand over to Steer ${target.slot}`}
              style={styles.secondary}
              disabled={busy}
              onPress={() => onHandoverPreview(target)}
            >
              <Text style={styles.body}>Hand over to {target.slot}</Text>
            </Pressable>
            {canRecover ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Resume Steer ${target.slot} and hand over`}
                style={styles.secondary}
                disabled={busy}
                onPress={() => onResumeAndHandover(target)}
              >
                <Text style={styles.label}>{STEER_MENU_LABELS.resumeAndHandover}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : (
          <Text style={styles.label}>{target.reason}</Text>
        )}
      </View>
    );
  };

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
          <Text style={styles.section}>{resumeActionLabel(self.state)}</Text>
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
          onConfirmFresh(flow),
        )}
        {actionButton("cancel-fresh", STEER_MENU_LABELS.cancel, "Cancel refresh", cancelFlow, {
          primary: false,
        })}
      </View>
    );
  };

  // A staged brief for this tab (feed truth, survives a popover reopen).
  const stagedHere = !laterStage && !pendingComposer && self.stagedBrief;

  return (
    <View style={{ gap: 8 }}>
      <Text style={styles.section}>Steer menu</Text>
      {handoverOpen && !flow ? (
        <View style={{ gap: 8 }}>
          {actionButton("back", `< ${STEER_MENU_LABELS.back}`, "Back to the steer menu", () =>
            setHandoverOpen(false),
          )}
          {targets.length === 0 ? (
            <Text style={styles.label}>No other holders in this scope.</Text>
          ) : (
            targets.map(renderHandoverRow)
          )}
        </View>
      ) : flow ? (
        renderFlow()
      ) : (
        <View style={{ gap: 8 }}>
          {actionButton("create", STEER_MENU_LABELS.create, "Create a new steer", onCreate)}
          {actionButton(
            "handover",
            STEER_MENU_LABELS.handover,
            "Hand over to another steer",
            () => setHandoverOpen(true),
          )}
          {actionButton(
            "resume",
            resumeActionLabel(self.state),
            self.state === "needs-resume" ? "Resume this steer" : "Refresh this steer",
            onResume,
          )}
          {actionButton("factory", STEER_MENU_LABELS.openFactory, "Open the Factory panel", onOpenFactory)}
        </View>
      )}
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
      {stagedHere ? (
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
    </View>
  );
}
