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
    action === "continue" ? "Weiterschreiben" : confirmation ? "Kontext jetzt auffrischen" : "Kontext auffrischen";

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
        setNotice("Der Chat wurde aufgefrischt. Der Arbeitsstand wurde gesendet.");
      } else if (applied.idempotent === true) {
        setNotice("Der Chat wurde bereits aufgefrischt.");
      } else {
        setError("Der Arbeitsstand konnte nicht gesendet werden.");
      }
      return;
    }

    const next = await callFreshPreview({ workspaceId, slot });
    if (next.from !== agentId) {
      setError("Für diesen Chat ist das Auffrischen nicht mehr verfügbar.");
    } else if (next.refreshMode !== "rewind") {
      // The existing new-agent fallback also prompts the old agent.
      setError("Dieser Chat lässt sich hier nicht auffrischen.");
    } else {
      setPreview(next);
    }
  });

  const onOpenHistory = () => run(async () => {
    await callHistory({ agentId });
    setNotice("Der gespeicherte Verlauf wurde in einem eigenen Tab geöffnet.");
  });

  return (
    <View style={styles.actions}>
      {confirmation ? (
        <Text style={styles.muted}>
          Der Chat wird zurückgesetzt. Spätere Nachrichten verschwinden aus diesem Tab und der Agent
          setzt hier mit einem kurzen Arbeitsstand fort.
        </Text>
      ) : null}
      {action === "unavailable" ? (
        <Text style={styles.muted}>Dieser Chat kann hier nicht aufgefrischt werden.</Text>
      ) : (
        <Pressable
          accessibilityRole="button"
          style={styles.button}
          disabled={busy || running || (action === "continue" && !composer)}
          onPress={() => void onPrimary()}
        >
          <Text style={styles.buttonText}>{busy ? "Bitte warten…" : primaryLabel}</Text>
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
            {confirmation ? "Abbrechen" : "Gespeicherten Verlauf in neuem Tab öffnen"}
          </Text>
        </Pressable>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {notice ? <Text style={styles.ok}>{notice}</Text> : null}
    </View>
  );
}
