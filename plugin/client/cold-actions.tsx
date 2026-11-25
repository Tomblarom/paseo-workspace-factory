import type { RpcOutput } from "@getpaseo/plugin";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useComposers, useRpc } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ContextAction } from "../shared/context-continuation.js";
import {
  factoryFresh,
  factoryFreshPreview,
  factoryHistoryOpen,
} from "../shared/factory.js";

interface ColdActionsProps {
  agentId: string;
  workspaceId: string;
  action: ContextAction;
  slot?: string | null;
  hasHistory?: boolean;
  running?: boolean;
  theme: PluginHostProps["theme"];
  close?: () => void;
}

export function ColdActions({
  agentId,
  workspaceId,
  action,
  slot,
  hasHistory,
  running,
  theme,
  close,
}: ColdActionsProps) {
  const [composer] = useComposers({ agentId });
  const callFreshPreview = useRpc(factoryFreshPreview);
  const callFresh = useRpc(factoryFresh);
  const callHistory = useRpc(factoryHistoryOpen);
  const [preview, setPreview] = useState<RpcOutput<typeof factoryFreshPreview> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setPreview(null), [action, slot]);

  const styles = useMemo(
    () => ({
      actions: { gap: 8, alignItems: "flex-start" as const },
      button: {
        paddingVertical: 8,
        paddingHorizontal: 12,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
      },
      buttonText: { color: theme.colors.accentForeground, fontSize: 14 },
      secondary: { paddingVertical: 8 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
      error: { color: theme.colors.statusDanger, fontSize: 14 },
      ok: { color: theme.colors.statusSuccess, fontSize: 14 },
    }),
    [theme],
  );

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await operation();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const confirmation = action === "refresh" ? preview : null;
  const primaryLabel =
    action === "continue" ? "Continue writing" : confirmation ? "Confirm refresh" : "Refresh chat";

  const onPrimary = () => run(async () => {
    if (action === "continue") {
      if (!composer) return;
      await composer.focus();
      close?.();
      return;
    }
    if (action !== "refresh" || !slot) return;

    if (confirmation) {
      const applied = await callFresh({
        workspaceId,
        slot: confirmation.slot,
        fingerprint: confirmation.fingerprint,
      });
      setPreview(null);
      if (applied.delivered) {
        setNotice("Chat refreshed and work brief sent.");
      } else if (applied.idempotent === true) {
        setNotice("This chat was already refreshed.");
      } else {
        setError("Could not send the work brief.");
      }
      return;
    }

    const next = await callFreshPreview({ workspaceId, slot });
    if (next.from !== agentId) {
      setError("Refresh is no longer available for this chat.");
    } else if (next.refreshMode !== "rewind") {
      // The existing new-agent fallback also prompts the old agent.
      setError("This chat cannot be refreshed here.");
    } else {
      setPreview(next);
    }
  });

  const onOpenHistory = () => run(async () => {
    await callHistory({ agentId });
    setNotice("Saved chat opened in a new tab.");
  });

  return (
    <View style={styles.actions}>
      {confirmation ? (
        <Text style={styles.muted}>
          This resets the chat and removes later messages from this tab. The agent continues here
          with a short work brief.
        </Text>
      ) : null}
      {action === "unavailable" ? (
        <Text style={styles.muted}>This chat cannot be refreshed here.</Text>
      ) : (
        <Pressable
          accessibilityRole="button"
          style={styles.button}
          disabled={busy || running || (action === "continue" && !composer)}
          onPress={() => void onPrimary()}
        >
          <Text style={styles.buttonText}>{busy ? "Please wait…" : primaryLabel}</Text>
        </Pressable>
      )}
      {confirmation || hasHistory ? (
        <Pressable
          accessibilityRole="button"
          style={styles.secondary}
          disabled={busy}
          onPress={confirmation ? () => setPreview(null) : () => void onOpenHistory()}
        >
          <Text style={styles.muted}>
            {confirmation ? "Cancel" : "Open saved chat in new tab"}
          </Text>
        </Pressable>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {notice ? <Text style={styles.ok}>{notice}</Text> : null}
    </View>
  );
}
