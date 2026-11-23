import type { RpcOutput } from "@getpaseo/plugin";
import type { PluginPopoverProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { factoryStatus } from "../shared/factory.js";

function text(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") return value === "" ? "-" : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export function FactoryPopover({ theme, layout, close }: PluginPopoverProps) {
  const callStatus = useRpc(factoryStatus);
  const [repo, setRepo] = useState("");
  const [status, setStatus] = useState<RpcOutput<typeof factoryStatus> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const styles = useMemo(
    () => ({
      box: { padding: layout.compact ? 12 : 16, gap: 8, minWidth: 280 },
      title: { color: theme.colors.foreground, fontSize: 16 },
      label: { color: theme.colors.foregroundMuted, fontSize: 13 },
      body: { color: theme.colors.foreground, fontSize: 14 },
      error: { color: theme.colors.statusDanger, fontSize: 14 },
      input: {
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        padding: 8,
        fontSize: 14,
      },
      button: { padding: 10, borderRadius: 8, backgroundColor: theme.colors.accent },
      buttonText: { color: theme.colors.accentForeground, textAlign: "center" as const },
    }),
    [theme, layout.compact],
  );

  const load = useMutation({
    mutationFn: async (target: string) => callStatus({ repo: target }),
    onSuccess: (next) => {
      setStatus(next);
      setError(null);
    },
    onError: (err: unknown) => {
      setStatus(null);
      setError(err instanceof Error ? err.message : String(err));
    },
  });

  const state = (status?.state ?? null) as Record<string, unknown> | null;
  const checkpoint = (status?.checkpoint ?? null) as Record<string, unknown> | null;

  return (
    <View style={styles.box}>
      <Text style={styles.title}>Factory status</Text>
      <TextInput
        style={styles.input}
        value={repo}
        onChangeText={setRepo}
        placeholder="owner/repo"
        placeholderTextColor={theme.colors.foregroundMuted}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Load factory status"
        style={styles.button}
        disabled={load.isPending || !repo.trim()}
        onPress={() => load.mutate(repo.trim())}
      >
        <Text style={styles.buttonText}>Load</Text>
      </Pressable>
      {load.isPending ? <Text style={styles.label}>Loading…</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {status ? (
        <View style={{ gap: 2 }}>
          <Text style={styles.body}>
            Active Steer {text(state?.activeSteer)} (epoch {text(state?.epoch)})
          </Text>
          <Text style={styles.body}>
            Checkpoint: {checkpoint?.task ? text(checkpoint.task) : "none"}
          </Text>
          <Text style={styles.body}>
            Steers: {status.steers.map((s) => s.slot).join(", ") || "none"} · Workers:{" "}
            {status.workers.length}
          </Text>
        </View>
      ) : null}
      <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={close}>
        <Text style={styles.label}>Close</Text>
      </Pressable>
    </View>
  );
}
