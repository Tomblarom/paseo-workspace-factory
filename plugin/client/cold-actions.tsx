import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  factoryFresh,
  factoryFreshPreview,
  factoryHistoryOpen,
  factoryResume,
} from "../shared/factory.js";

interface ColdActionsProps {
  agentId: string;
  workspaceId: string;
  /** Fresh is manual-only and additive; offered only to the active steer. */
  canFresh: boolean;
  hasHistory: boolean;
  theme: PluginHostProps["theme"];
  compact: boolean;
}

interface FreshPreview {
  slot: string;
  epoch: number;
  packet: string;
  packetChars: number;
  checkpoint: boolean;
  fingerprint: string;
}

/**
 * The C6 cold-context actions, shared by the agent panel and the composer
 * pill popover: resume (read-only brief), fresh (two-stage, manual only,
 * additive), and opening the saved old history (click only).
 */
export function ColdActions({
  agentId,
  workspaceId,
  canFresh,
  hasHistory,
  theme,
  compact,
}: ColdActionsProps) {
  const callResume = useRpc(factoryResume);
  const callFreshPreview = useRpc(factoryFreshPreview);
  const callFresh = useRpc(factoryFresh);
  const callHistory = useRpc(factoryHistoryOpen);
  const [brief, setBrief] = useState<string | null>(null);
  const [fresh, setFresh] = useState<FreshPreview | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const styles = useMemo(
    () => ({
      actions: { gap: compact ? 8 : 12 },
      row: { flexDirection: "row" as const, gap: 8, flexWrap: "wrap" as const },
      button: {
        paddingVertical: 10,
        paddingHorizontal: 14,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
      },
      buttonText: { color: theme.colors.accentForeground, fontSize: 14 },
      body: { color: theme.colors.foreground, fontSize: 14 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
      error: { color: theme.colors.statusDanger, fontSize: 14 },
      ok: { color: theme.colors.statusSuccess, fontSize: 14 },
    }),
    [theme, compact],
  );

  const fail = (error: unknown) =>
    setError(error instanceof Error ? error.message : String(error));

  const onResume = async () => {
    setBusy("resume");
    setError(null);
    setNotice(null);
    try {
      const result = await callResume({ agentId, workspaceId });
      setBrief(result.brief);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(null);
    }
  };

  const onFreshPreview = async () => {
    setBusy("fresh");
    setError(null);
    setNotice(null);
    try {
      const preview = await callFreshPreview({ workspaceId });
      setFresh({
        slot: preview.slot,
        epoch: preview.epoch,
        packet: preview.packet,
        packetChars: preview.packetChars,
        checkpoint: preview.checkpoint,
        fingerprint: preview.fingerprint,
      });
    } catch (error) {
      fail(error);
    } finally {
      setBusy(null);
    }
  };

  const onFreshApply = async () => {
    if (!fresh) return;
    setBusy("fresh");
    setError(null);
    try {
      const applied = await callFresh({ workspaceId, fingerprint: fresh.fingerprint });
      setFresh(null);
      setNotice(
        `Fresh Steer ${String(applied.slot)} is active (epoch ${String(applied.epoch)}). ` +
          `The old agent stays untouched; archive it in Paseo when done.`,
      );
    } catch (error) {
      fail(error);
    } finally {
      setBusy(null);
    }
  };

  const onHistory = async () => {
    setBusy("history");
    setError(null);
    setNotice(null);
    try {
      const opened = await callHistory({ agentId });
      setNotice(
        opened.detail
          ? `Old history opened: ${opened.detail}`
          : `Old history of session ${opened.sessionId} opened as a new tab.`,
      );
    } catch (error) {
      fail(error);
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={styles.actions}>
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Show resume brief"
          style={styles.button}
          disabled={busy !== null}
          onPress={() => void onResume()}
        >
          <Text style={styles.buttonText}>{busy === "resume" ? "…" : "Resume"}</Text>
        </Pressable>
        {canFresh ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Hand over to a fresh steer"
            style={styles.button}
            disabled={busy !== null}
            onPress={() => void onFreshPreview()}
          >
            <Text style={styles.buttonText}>{busy === "fresh" ? "…" : "Fresh"}</Text>
          </Pressable>
        ) : null}
        {hasHistory ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open old history"
            style={styles.button}
            disabled={busy !== null}
            onPress={() => void onHistory()}
          >
            <Text style={styles.buttonText}>
              {busy === "history" ? "…" : "Alten Verlauf öffnen"}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {notice ? <Text style={styles.ok}>{notice}</Text> : null}
      {brief ? <Text style={styles.body}>{brief}</Text> : null}
      {fresh ? (
        <View style={styles.actions}>
          <Text style={styles.muted}>
            Fresh hands Steer {fresh.slot} to a new agent (epoch {fresh.epoch},{" "}
            {fresh.checkpoint ? "with" : "without"} checkpoint, {fresh.packetChars} chars). The old
            agent keeps its tab.
          </Text>
          <Text style={styles.body}>{fresh.packet}</Text>
          <View style={styles.row}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Confirm fresh steer"
              style={styles.button}
              disabled={busy !== null}
              onPress={() => void onFreshApply()}
            >
              <Text style={styles.buttonText}>Fresh bestätigen</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Discard fresh preview"
              style={styles.button}
              disabled={busy !== null}
              onPress={() => setFresh(null)}
            >
              <Text style={styles.buttonText}>Verwerfen</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}
