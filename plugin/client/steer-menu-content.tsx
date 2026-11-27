import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import { factoryFresh, factoryFreshPreview } from "../shared/factory.js";
import { factorySteerMenuSettings } from "../shared/settings.js";
import type { FactorySteerFeed } from "./factory-workspace-state.js";
import { isExpiredPreviewError, normalizeInitializeNewSteer, resetQuotaConfirmationText, resetSteer, resetSteerBlock, steerQuotaConfirmation } from "./steer-menu.js";

interface ResetSteerFormProps extends Pick<PluginHostProps, "host" | "theme"> {
  agentId: string;
  workspaceId: string;
  close(): void;
  feed: FactorySteerFeed;
  onReset: (source: { workspaceId: string; agentId: string }, outcome: Awaited<ReturnType<typeof resetSteer>>) => Promise<void>;
}

export function ResetSteerForm({ agentId, workspaceId, host, theme, close, feed, onReset }: ResetSteerFormProps) {
  const settings = useSettings(factorySteerMenuSettings);
  const callPreview = useRpc(factoryFreshPreview);
  const apply = useRpc(factoryFresh);
  const { rows, disconnected } = useSyncExternalStore(feed.subscribe, feed.getSnapshot, feed.getSnapshot);
  const row = disconnected ? undefined : rows?.find((entry) => entry.agentId === agentId && entry.workspaceId === workspaceId);
  const blocked = row ? resetSteerBlock(row) : "This steer is no longer available.";
  const quota = row ? steerQuotaConfirmation(row) : null;
  const resetQuota = quota ?? "available";
  const slot = row?.slot;
  const preview = useQuery({
    queryKey: ["workspace-factory", "reset-steer", host.id, workspaceId, agentId, slot, resetQuota],
    queryFn: async () => {
      const plan = await callPreview({ workspaceId, slot: slot ?? undefined, resetQuota });
      if (plan.from !== agentId || plan.workspaceId !== workspaceId || plan.slot !== slot) {
        throw new Error("The steer changed. Open Reset Steer again for the current holder.");
      }
      if (plan.refreshMode !== "rewind") {
        throw new Error("An in-place rewind is unavailable. Use /factory fresh to preview and confirm a replacement.");
      }
      return plan;
    },
    enabled: !blocked && Boolean(slot),
    retry: false,
    gcTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const plan = preview.data;
  const canReset = plan?.refreshMode === "rewind" && settings.status === "ready" && !preview.isFetching && !blocked && !busy;
  const settingsError = settings.status === "error" || settings.status === "invalid" ? settings.error : null;
  const foreground = { color: theme.colors.foreground };
  const button = { minHeight: 36, paddingHorizontal: 12, borderRadius: 8, justifyContent: "center" } as const;

  async function confirmReset() {
    if (!canReset || !plan || !slot || running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      const source = { agentId, workspaceId, slot };
      const initialize = normalizeInitializeNewSteer(settings.status === "ready" ? settings.values.initializeNewSteer : undefined);
      const outcome = await resetSteer(source, plan, initialize, apply, resetQuota);
      if (!outcome.result.applied && !outcome.result.idempotent) {
        throw new Error(String(outcome.result.deliveryError ?? "Factory could not confirm the reset."));
      }
      await onReset(source, outcome);
      close();
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown));
      if (isExpiredPreviewError(thrown)) void preview.refetch();
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 4 }}>
      {quota ? <Text style={{ color: theme.colors.statusWarning }}>
        {resetQuotaConfirmationText(quota, row)}
      </Text> : null}
      {preview.isFetching ? <Text style={foreground}>Checking rewind availability…</Text> : null}
      {plan && !blocked ? <Text style={{ color: theme.colors.foregroundMuted }}>
        This rewinds the conversation and removes later messages from this tab.
      </Text> : null}
      {error || blocked || preview.error || settingsError ? (
        <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>
          {error ?? blocked ?? preview.error?.message ?? settingsError}
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
