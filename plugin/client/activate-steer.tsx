import { useMutation } from "@tanstack/react-query";
import { useComposers, useRpc, type PluginButtonContentProps } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { factorySteerActivate, type QuotaConfirmation } from "../shared/factory.js";
import { STEER_MENU_LABELS } from "./steer-menu.js";

type Alternative = { agentId: string; slot: string };
type Props = Pick<Extract<PluginButtonContentProps, { context: "agent" }>, "agentId" | "workspaceId" | "theme" | "close">
  & { epoch: number; alternatives?: Alternative[]; quota?: { condition: QuotaConfirmation; text: string } };

function OpenSteer({ agentId, slot, color, close }: Alternative & { color: string; close: () => void }) {
  const [composer] = useComposers({ agentId });
  const [error, setError] = useState(false);
  if (!composer) return null;
  return (
    <Pressable accessibilityRole="button" onPress={() => { void composer.focus().then(close, () => setError(true)); }}>
      <Text style={{ color, paddingVertical: 8 }}>{error ? `Retry opening Steer ${slot}` : `Open Steer ${slot}`}</Text>
    </Pressable>
  );
}

export function ActivateSteer({ workspaceId, agentId, epoch, theme, close, alternatives, quota }: Props) {
  const activate = useRpc(factorySteerActivate);
  const { mutate, data, error, isPending } = useMutation({ mutationFn: activate, retry: false });
  const started = useRef(false);
  useEffect(() => {
    if (started.current || quota) return;
    started.current = true;
    mutate({ workspaceId, agentId, epoch });
  }, [mutate, workspaceId, agentId, epoch, quota]);

  if (quota && !isPending && !data && !error) {
    return (
      <View style={{ gap: 4, width: 244, maxWidth: "100%" }}>
        <Text style={{ color: theme.colors.statusWarning }}>{quota.text}</Text>
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 12 }}>
          <Pressable accessibilityRole="button" onPress={close}>
            <Text style={{ color: theme.colors.foreground, paddingVertical: 7 }}>Cancel</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => mutate({ workspaceId, agentId, epoch, confirmQuota: quota.condition })}>
            <Text style={{ color: theme.colors.accent, paddingVertical: 7 }}>Activate</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const retry = !isPending && (error || data?.status === "pending" || data?.status === "blocked");
  return (
    <View style={{ gap: 4 }}>
      <Text accessibilityLiveRegion="polite" style={{ color: error ? theme.colors.statusDanger : theme.colors.foreground }}>
        {error?.message ?? data?.detail ?? "Activating this steer…"}
      </Text>
      {retry ? (
        <Pressable accessibilityRole="button" onPress={() => mutate({ workspaceId, agentId, epoch, confirmQuota: quota?.condition })}>
          <Text style={{ color: theme.colors.accent, paddingVertical: 8 }}>{STEER_MENU_LABELS.retryActivation}</Text>
        </Pressable>
      ) : null}
      {(error || data?.status === "blocked") && alternatives?.map((alternative) => (
        <OpenSteer key={alternative.agentId} {...alternative} color={theme.colors.accent} close={close} />
      ))}
      <Pressable accessibilityRole="button" onPress={close}>
        <Text style={{ color: theme.colors.foreground, paddingVertical: 8 }}>{STEER_MENU_LABELS.close}</Text>
      </Pressable>
    </View>
  );
}
