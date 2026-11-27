import type { RpcOutput } from "@getpaseo/plugin";
import type { PluginClientContext, PluginHostProps } from "@getpaseo/plugin/client";
import { useComposers, useRpc, useSettings, useSubscription } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  factorySteerAdd,
  factorySteerAddPreview,
  factorySteerBrief,
  factorySteers,
  factorySwitch,
  factorySwitchPreview,
} from "../shared/factory.js";
import { factorySteerMenuSettings } from "../shared/settings.js";
import {
  isExpiredPreviewError,
  normalizeInitializeNewSteer,
  resetSteerBlock,
  transferStagedBrief,
  type BriefTarget,
  type ComposerTransferAttempt,
} from "./steer-menu.js";
import { steerRowsOf, type SteerPillRow } from "./steer-pill.js";

type CreateFlow = { kind: "create"; preview: RpcOutput<typeof factorySteerAddPreview> };
type SwitchFlow = {
  kind: "switch";
  to: string;
  toAgentId: string;
  preview: RpcOutput<typeof factorySwitchPreview>;
};
type StagedFlow = { kind: "staged"; target: BriefTarget; recoveryId?: string };
type OperationFlow = CreateFlow | SwitchFlow | StagedFlow;

interface FactorySteerOperationProps {
  agentId: string;
  workspaceId: string;
  theme: PluginHostProps["theme"];
  compact: boolean;
  close: () => void;
  initialAction: "create" | "handover" | "staged";
  initialSlot?: string;
  initialAgentId?: string;
  expectedControllerId?: string;
  composers: PluginClientContext["composers"];
}

function text(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") return value === "" ? "-" : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

const NO_INPUT = {};
// Keep an unacknowledged transfer when its popover is closed and reopened.
const composerAttempts = new Map<string, ComposerTransferAttempt & { running: boolean }>();

export function FactorySteerOperation({
  agentId,
  workspaceId,
  theme,
  compact,
  close,
  initialAction,
  initialSlot,
  initialAgentId,
  expectedControllerId,
  composers,
}: FactorySteerOperationProps) {
  const callSteerAddPreview = useRpc(factorySteerAddPreview);
  const callSteerAdd = useRpc(factorySteerAdd);
  const callSwitchPreview = useRpc(factorySwitchPreview);
  const callSwitch = useRpc(factorySwitch);
  const callBrief = useRpc(factorySteerBrief);
  const menuSettings = useSettings(factorySteerMenuSettings);

  const [rows, setRows] = useState<SteerPillRow[] | null>(null);
  const onEvent = useCallback((event: unknown) => {
    setRows(steerRowsOf(event));
  }, []);
  useSubscription(factorySteers, NO_INPUT, onEvent);
  const self = rows?.find((row) => row.agentId === agentId) ?? null;

  const [flow, setFlow] = useState<OperationFlow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingComposer, setPendingComposer] = useState(false);
  const [postStage, setPostStage] = useState<{ target: BriefTarget; slot: string | null; retry: boolean } | null>(null);
  const startedRef = useRef(false);

  const initializeNewSteer = normalizeInitializeNewSteer(
    menuSettings.status === "ready" ? menuSettings.values.initializeNewSteer : undefined,
  );
  const composerAgentId = postStage?.target.agentId ?? agentId;
  const [destComposer] = useComposers({ agentId: composerAgentId });
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

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

  const clearStage = (target: BriefTarget) => {
    composerAttempts.delete(target.stageId);
    setPostStage(null);
    setFlow((current) => current?.kind === "staged" ? null : current);
  };

  const onPlaceBrief = (target: BriefTarget, automatic = false): void => {
    setPendingComposer(false);
    const composer = () => mounted.current ? composers({ agentId: target.agentId })[0] : undefined;
    const attempt = composerAttempts.get(target.stageId) ?? {
      claimId: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36)}`,
      placed: false,
      running: false,
    };
    if (attempt.running) return;
    attempt.running = true;
    composerAttempts.set(target.stageId, attempt);
    void run(async () => {
      try {
        await transferStagedBrief(callBrief, target, composer, attempt, automatic);
        clearStage(target);
        setNotice("Brief placed in the composer. It goes out with the next prompt.");
        composer()?.focus().catch(() => {});
      } finally {
        attempt.running = false;
      }
    });
  };

  useEffect(() => {
    if (pendingComposer && postStage && destComposer && !busy) onPlaceBrief(postStage.target, true);
    // The stage and composer availability determine when to start the transfer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingComposer, postStage, destComposer, busy]);

  const onInitializeNow = (target: BriefTarget): void => {
    setPendingComposer(false);
    void run(async () => {
      const sent = await callBrief({ ...target, action: "send" });
      if (sent.delivered) clearStage(target);
      setNotice(sent.detail);
    });
  };

  const onDismissBrief = (target: BriefTarget): void => {
    setPendingComposer(false);
    void run(async () => {
      const dismissed = await callBrief({ ...target, action: "dismiss" });
      if (dismissed.dismissed) clearStage(target);
      setNotice(dismissed.detail);
    });
  };

  const onResolveTransfer = (target: BriefTarget, recoveryId: string, resolution: "placed" | "retry"): void => {
    void run(async () => {
      if (composerAttempts.get(target.stageId)?.running) throw new Error("The composer transfer is still running.");
      const result = await callBrief({ ...target, action: "composer-resolve", recoveryId, resolution });
      if (!result.resolved) throw new Error(result.detail);
      if (resolution === "placed") clearStage(target);
      else {
        composerAttempts.delete(target.stageId);
        setFlow({ kind: "staged", target });
      }
      setNotice(result.detail);
    });
  };

  // Shared post-apply delivery: delivered, staged for the composer, staged
  // for later, or a partial apply with a retry.
  const afterDelivery = (args: {
    head: string;
    tail: string | null;
    toAgentId: string;
    slot: string | null;
    stageId?: string;
    epoch?: number | null;
    delivered: boolean;
    deliveryError?: unknown;
  }): void => {
    const tail = args.tail ? ` ${args.tail}` : "";
    if (args.delivered) {
      setNotice(`${args.head}${tail}${args.deliveryError ? ` ${text(args.deliveryError)}` : ""}`);
      return;
    }
    if (args.stageId && args.epoch !== undefined) {
      setPostStage({ target: { workspaceId, agentId: args.toAgentId, stageId: args.stageId, epoch: args.epoch }, slot: args.slot, retry: initializeNewSteer === "send" });
      setPendingComposer(initializeNewSteer === "composer");
      setNotice(args.head);
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
      const preview = current.preview;
      if (!preview.fingerprint) throw new Error("Choose an eligible steer before creating it.");
      const added = await callSteerAdd({ workspaceId: preview.workspaceId, slot: preview.slot, fingerprint: preview.fingerprint, revision: preview.revision, creationId: preview.creationId });
      setFlow(null);
      setNotice(
        `Steer ${added.slot} created (${added.provider}/${added.model}). ` +
          "The current coordinator stays active until a handover.",
      );
    });
  };

  // --- Handover confirmation in the Factory panel -------------------------

  const matchesHandover = (preview: SwitchFlow["preview"], toAgentId: string) =>
    preview.workspaceId === workspaceId && preview.toId === toAgentId &&
    (expectedControllerId === undefined || preview.fromId === expectedControllerId);

  const startHandover = (toSlot: string, toAgentId: string): void => {
    void run(async () => {
      const preview = await callSwitchPreview({ workspaceId, to: toSlot });
      if (!matchesHandover(preview, toAgentId)) {
        throw new Error("The controller or destination changed. Choose the handover again.");
      }
      setFlow({ kind: "switch", to: toSlot, toAgentId, preview });
    });
  };

  const onConfirmSwitch = (current: SwitchFlow, sendNow = false): void => {
    void run(async () => {
      const deliver = sendNow || initializeNewSteer === "send" ? "send" : "stage";
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
          if (!matchesHandover(preview, current.toAgentId)) {
            setFlow(null);
            throw new Error("The controller or destination changed. Choose the handover again.");
          }
          setFlow({ ...current, preview });
          setNotice("The preview expired. Review the new preview.");
          return;
        }
        throw thrown;
      }
      setFlow(null);
      if (applied.workerHandoverPending) {
        setNotice(`Steer ${applied.to} is now active. Worker transfer is pending.`);
        return;
      }
      if (applied.deliveryPending) {
        setNotice(`Steer ${applied.to} is now active. The brief is queued pending context renewal.`);
        return;
      }
      afterDelivery({
        head: `Steer ${applied.to} is now active (epoch ${applied.epoch}).`,
        tail: "The previous tab keeps its chat; it no longer coordinates.",
        toAgentId: applied.stagedTo ?? current.toAgentId,
        slot: current.to,
        stageId: applied.stageId,
        epoch: applied.epoch,
        delivered: applied.delivered,
        deliveryError: applied.deliveryError ?? applied.stagingError,
      });
    });
  };

  // --- Staged brief (this tab) ------------------------------------------------------

  const startStaged = (): void => {
    void run(async () => {
      const brief = await callBrief({ workspaceId, agentId, action: "inspect" });
      if (!brief.stageId || brief.epoch === undefined) throw new Error(brief.detail);
      setFlow({ kind: "staged", target: { workspaceId, agentId, stageId: brief.stageId, epoch: brief.epoch }, recoveryId: brief.recoveryId });
    });
  };

  // --- Auto-start ---------------------------------------------------------------

  const needsRows = initialAction === "handover";

  useEffect(() => {
    if (startedRef.current) return;
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
    if (!rows) return;
    startedRef.current = true;
    if (!self) return;
    if (!initialSlot || !initialAgentId) {
      setError("Handover target is missing.");
      return;
    }
    startHandover(initialSlot, initialAgentId);
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

  const renderStagedBrief = (target: BriefTarget, slot: string | null = null, retry = false): ReactNode => (
    <View style={{ gap: 4 }}>
      <Text style={styles.body}>Brief staged{slot ? ` for Steer ${slot}` : " for this tab"}.</Text>
      {pendingComposer && !destComposer ? <Text style={styles.label}>Waiting for the destination composer…</Text> : null}
      {actionButton("place-composer", "Place in composer", "Place the staged brief in the composer", () => onPlaceBrief(target))}
      {actionButton("init-now", retry ? "Retry delivery" : "Initialize now",
        "Send the staged brief now", () => onInitializeNow(target))}
      {actionButton("dismiss", "Dismiss brief", "Dismiss the staged brief",
        () => onDismissBrief(target), { primary: false })}
    </View>
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
          {actionButton("confirm-create", "Confirm creation", "Confirm steer creation", () =>
            onConfirmCreate(flow),
          )}
          {actionButton("cancel-create", "Cancel", "Cancel steer creation", cancelFlow, {
            primary: false,
          })}
        </View>
      );
    }
    if (flow.kind === "switch") {
      const preview = flow.preview;
      const targetRow = rows?.find((entry) => entry.agentId === flow.toAgentId) ?? null;
      const canRecover = targetRow?.state === "needs-resume" && resetSteerBlock(targetRow) === null;
      return (
        <View style={{ gap: 4 }}>
          <Text style={[styles.section, { fontWeight: "600" }]}>Steer {preview.from} → Steer {flow.to}</Text>
          <Text style={styles.body}>{preview.checkpoint ? "Continue from the saved task checkpoint." : "Continue with the available workspace state."}</Text>
          <Text style={styles.label}>{initializeNewSteer === "send" ? "Send the continuation brief after the handover." : "Stage the continuation brief for the destination."}</Text>
          {canRecover
            ? actionButton("resume-handover", "Resume and hand over", `Resume Steer ${flow.to} and hand over`, () =>
              onConfirmSwitch(flow, true),
            )
            : null}
          {actionButton("confirm-switch", "Confirm handover", "Confirm handover", () =>
            onConfirmSwitch(flow),
          )}
          {actionButton("cancel-switch", "Cancel", "Cancel handover", cancelFlow, {
            primary: false,
          })}
        </View>
      );
    }
    const { target, recoveryId } = flow;
    if (!recoveryId) return renderStagedBrief(target);
    return (
      <View style={{ gap: 4 }}>
        <Text style={styles.body}>A composer transfer is awaiting confirmation. Close this dialog and check the draft after the previous attempt has stopped.</Text>
        {actionButton("confirm-placed", "Brief is in the draft", "Confirm that the brief is in the composer draft",
          () => onResolveTransfer(target, recoveryId, "placed"))}
        {actionButton("release-transfer", "Brief is missing from the draft", "Release the transfer after checking the composer draft",
          () => onResolveTransfer(target, recoveryId, "retry"), { primary: false })}
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
          accessibilityLabel="Close steer operation"
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
        {postStage ? renderStagedBrief(postStage.target, postStage.slot, postStage.retry) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {notice ? <Text style={styles.ok}>{notice}</Text> : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close steer operation"
          style={styles.button}
          onPress={close}
        >
          <Text style={styles.buttonText}>Close</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}
