import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useRef, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import { factoryFresh, factoryFreshPreview } from "../shared/factory.js";
import { factorySteerMenuSettings } from "../shared/settings.js";
import type { FactorySteerFeed } from "./factory-workspace-state.js";
import { useAutosave } from "./settings-autosave.js";
import { resetQuotaConfirmationText, resetSteer, resetSteerBlock, steerQuotaConfirmation } from "./steer-menu.js";

type ResetSteerPopoverProps = Extract<PluginButtonContentProps, { context: "agent" }> & {
  feed: FactorySteerFeed;
  onReset: (source: { workspaceId: string; agentId: string }, outcome: Awaited<ReturnType<typeof resetSteer>>) => Promise<void>;
};

export function ResetSteerPopover({ agentId, workspaceId, theme, close, feed, onReset }: ResetSteerPopoverProps) {
  const { state, change } = useAutosave(factorySteerMenuSettings);
  const preview = useRpc(factoryFreshPreview);
  const apply = useRpc(factoryFresh);
  const { rows, disconnected } = useSyncExternalStore(feed.subscribe, feed.getSnapshot, feed.getSnapshot);
  const row = disconnected ? undefined : rows?.find((entry) => entry.agentId === agentId && entry.workspaceId === workspaceId);
  const blocked = row ? resetSteerBlock(row) : "This steer is no longer available.";
  const quota = row ? steerQuotaConfirmation(row) : null;
  const [choice, setChoice] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const clearChatHistory = choice ?? (state.status === "ready" && !state.values.keepChatHistory);
  const canReset = state.status === "ready" && !blocked && !busy;
  const settingsError = state.status === "error" || state.status === "invalid" ? state.error : null;
  const foreground = { color: theme.colors.foreground };
  const button = { minHeight: 36, paddingHorizontal: 12, borderRadius: 8, justifyContent: "center" } as const;

  async function confirmReset() {
    if (!canReset || !row?.slot || running.current) return;
    running.current = true;
    setChoice(clearChatHistory);
    setBusy(true);
    setError(null);
    try {
      const source = { agentId, workspaceId, slot: row.slot };
      const outcome = await resetSteer(source, clearChatHistory, async (keepChatHistory) => {
        const saved = await change("history")((current) => ({ ...current, keepChatHistory }));
        if (saved.status !== "saved") {
          throw new Error(saved.status === "superseded" ? "The history setting could not be saved." : saved.error);
        }
        return saved.values.initializeNewSteer;
      }, preview, apply, quota ?? "available");
      if (!outcome.result.applied && !outcome.result.idempotent) {
        throw new Error(String(outcome.result.deliveryError ?? "Factory could not confirm the reset."));
      }
      await onReset(source, outcome);
      close();
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 4, width: 260, maxWidth: "100%" }}>
      {quota ? <Text style={{ color: theme.colors.statusWarning }}>
        {resetQuotaConfirmationText(quota, row)}
      </Text> : null}
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: clearChatHistory, disabled: !canReset }}
        disabled={!canReset} onPress={() => setChoice(!clearChatHistory)}
        style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 36 }}>
        <Icon name={clearChatHistory ? "SquareCheck" : "Square"} size={18} color={theme.colors.foreground} />
        <Text style={foreground}>Clear chat history</Text>
      </Pressable>
      <Text style={{ color: theme.colors.foregroundMuted }}>
        {clearChatHistory ? "If this tab cannot be cleared, a new agent continues and the original chat stays available."
          : "A new agent continues. The original chat stays available in this tab."}
      </Text>
      {state.status === "loading" ? <Text style={foreground}>Loading settings…</Text> : null}
      {error || blocked || settingsError ? (
        <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>
          {error ?? blocked ?? settingsError}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
        <Pressable accessibilityRole="button" disabled={busy} onPress={close} style={button}>
          <Text style={foreground}>Cancel</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityState={{ busy }} disabled={!canReset}
          onPress={() => void confirmReset()}
          style={[button, { backgroundColor: theme.colors.accent, opacity: canReset ? 1 : 0.55 }]}>
          <Text style={{ color: theme.colors.accentForeground }}>Reset</Text>
        </Pressable>
      </View>
    </View>
  );
}
