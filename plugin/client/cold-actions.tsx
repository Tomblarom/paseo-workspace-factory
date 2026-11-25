import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  factoryFresh,
  factoryFreshPreview,
  factoryHistoryOpen,
  factoryResume,
  factoryResumeApply,
} from "../shared/factory.js";
import type { NeedsResumeReason } from "./cold-panel.js";

interface ColdActionsProps {
  agentId: string;
  workspaceId: string;
  /** Fresh is manual-only and additive; offered only to the active steer. */
  canFresh: boolean;
  /** Own steer slot; a non-active steer is refreshed per slot. */
  slot?: string | null;
  hasHistory: boolean;
  /** Set when the attention feed flags this steer for resume; shows "Resume jetzt". */
  needsResume: NeedsResumeReason | null;
  /** Non-active, non-advisor steer: resume also takes over coordination. */
  takeover: boolean;
  theme: PluginHostProps["theme"];
  compact: boolean;
}

const FRESH_HINT =
  "Renews the agent in the same tab with a rewind and the saved brief (about 8k uncached tokens instead of the whole old context). The old chat stays visible. If no rewind point exists, a new agent takes over.";
const COLD_HINT =
  "Keeps writing in the old chat. The whole context is processed again without cache, which is the most expensive option. Opens the saved history as a tab.";
const RESUME_HINT = "Clears the context and posts the resume brief.";

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
  slot = null,
  hasHistory,
  needsResume,
  takeover,
  theme,
  compact,
}: ColdActionsProps) {
  const [hover, setHover] = useState<string | null>(null);
  const callResume = useRpc(factoryResume);
  const callResumeApply = useRpc(factoryResumeApply);
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
      actions: { gap: 6 },
      row: { flexDirection: "row" as const, gap: 6, flexWrap: "nowrap" as const },
      button: {
        paddingVertical: 5,
        paddingHorizontal: 10,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
      },
      buttonText: { color: theme.colors.accentForeground, fontSize: 14 },
      coldButton: {
        paddingVertical: 5,
        paddingHorizontal: 10,
        borderRadius: 8,
        backgroundColor: "#f87171",
      },
      coldText: { color: "#450a0a", fontSize: 14 },
      freshButton: {
        paddingVertical: 5,
        paddingHorizontal: 10,
        borderRadius: 8,
        backgroundColor: theme.colors.statusSuccess,
      },
      freshText: { color: "#ffffff", fontSize: 13 },
      body: { color: theme.colors.foreground, fontSize: 14 },
      hint: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 16, height: 64 },
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

  const onResumeApply = async () => {
    setBusy("resumeApply");
    setError(null);
    setNotice(null);
    try {
      const applied = await callResumeApply({
        agentId,
        workspaceId,
        ...(takeover ? { takeover: true as const } : {}),
      });
      setBrief(null);
      setNotice(
        typeof applied.detail === "string" && applied.detail !== ""
          ? applied.detail
          : "Resume läuft: Der Kontext wird geleert, danach kommt der Resume-Brief in die Timeline.",
      );
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
      const preview = await callFreshPreview({ workspaceId, ...(slot && !canFresh ? { slot } : {}) });
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
      const applied = await callFresh({ workspaceId, slot: fresh.slot, fingerprint: fresh.fingerprint });
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
        {needsResume ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Resume now"
            style={styles.button}
            disabled={busy !== null}
            onHoverIn={() => setHover("resume")}
            onHoverOut={() => setHover(null)}
            onPress={() => void onResumeApply()}
          >
            <Text style={styles.buttonText}>{busy === "resumeApply" ? "…" : "Resume jetzt"}</Text>
          </Pressable>
        ) : null}
        {canFresh || slot ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Continue fresh"
            style={styles.freshButton}
            disabled={busy !== null}
            onHoverIn={() => setHover("fresh")}
            onHoverOut={() => setHover(null)}
            onPress={() => void onFreshPreview()}
          >
            <Text style={styles.freshText}>{busy === "fresh" ? "…" : "Continue Fresh"}</Text>
          </Pressable>
        ) : null}
        {hasHistory ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Continue cold"
            style={styles.coldButton}
            disabled={busy !== null}
            onHoverIn={() => setHover("cold")}
            onHoverOut={() => setHover(null)}
            onPress={() => void onHistory()}
          >
            <Text style={styles.coldText}>{busy === "history" ? "…" : "Continue Cold"}</Text>
          </Pressable>
        ) : null}
      </View>
      <Text style={styles.hint} numberOfLines={4}>
        {hover === "fresh" ? FRESH_HINT : hover === "cold" ? COLD_HINT : hover === "resume" ? RESUME_HINT : " "}
      </Text>
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
