import type { RpcOutput } from "@getpaseo/plugin";
import { useRpc, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { Pressable, Text, View } from "react-native";
import { factoryWorkspaceActivity } from "../shared/workspace-activity.js";
import type { FactoryResultStyles } from "./factory-panel.js";

type ActivityEvent = RpcOutput<typeof factoryWorkspaceActivity>["events"][number];

const titles: Record<ActivityEvent["kind"], string> = {
  "holder-change": "Controller changed",
  creation: "Agent creation",
  renewal: "Context renewal",
  recovery: "Recovery",
  delivery: "Brief delivery",
  assignment: "Assignment",
  "worker-wake": "Worker update",
};

const descriptions: Record<ActivityEvent["reason"], string> = {
  "slot-changed": "Control moved to another steer slot.",
  "holder-replaced": "A replacement agent took control.",
  "steer-created": "Steer agent created.",
  "worker-created": "Worker agent created.",
  "context-cleared": "Context cleared.",
  "context-compacted": "Context compacted.",
  "context-rewound": "Context rewound.",
  "renewal-unconfirmed": "Renewal could not be confirmed.",
  "daemon-restart": "Waiting to resume after a daemon restart.",
  "provider-limit": "Waiting to resume after a provider limit.",
  "turn-failed": "Waiting to resume after a failed turn.",
  "brief-staged": "Brief staged in the composer queue.",
  "delivery-queued": "Brief queued for delivery.",
  "waiting-for-renewal": "Delivery is waiting for context renewal.",
  "delivery-unconfirmed": "Delivery was attempted and is awaiting confirmation.",
  "delivery-blocked": "Delivery blocked.",
  "delivery-blocked-after-attempt": "Delivery blocked after an unconfirmed attempt.",
  "dispatch-acknowledged": "Paseo acknowledged the dispatch.",
  "assignment-recorded": "Assignment recorded.",
  "assignment-report-delivered": "Assignment report delivered.",
  "worker-completed": "Completion update queued.",
  "worker-partial": "Partial result update queued.",
  "worker-blocked": "Blocker update queued.",
  "worker-interrupted": "Interruption update queued.",
  "worker-stale": "Stale worker update queued.",
  "worker-update": "Worker update queued.",
  "wake-recorded": "Worker update recorded.",
};

interface Props extends Pick<PluginWorkspacePanelProps, "workspaceId" | "layout" | "host"> {
  offline: boolean;
  styles: FactoryResultStyles;
}

export function FactoryWorkspaceActivity({ workspaceId, layout, host, offline, styles }: Props) {
  const callActivity = useRpc(factoryWorkspaceActivity);
  const activity = useQuery({
    queryKey: ["workspace-factory", "activity", host.id, workspaceId],
    queryFn: async () => {
      const result = await callActivity({ workspaceId });
      if (result.workspaceId !== workspaceId) throw new Error("Factory returned activity for a different workspace.");
      return result;
    },
    enabled: !offline,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    retry: false,
  });
  const events = activity.data?.events;

  return (
    <>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "space-between" }}>
        <Text accessibilityRole="header" style={[styles.body, { fontSize: layout.compact ? 18 : 21, fontWeight: "600" }]}>
          Recent recorded activity
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Refresh workspace activity" disabled={offline || activity.isFetching}
          onPress={() => { void activity.refetch(); }} style={{ minHeight: 36, justifyContent: "center" }}>
          <Text style={activity.isFetching ? styles.label : [styles.body, { textDecorationLine: "underline" }]}>
            {activity.isFetching ? "Checking…" : "Refresh"}
          </Text>
        </Pressable>
      </View>
      {offline || activity.isError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {offline ? events ? "Host disconnected. Showing the last activity snapshot." : "Host disconnected. Activity unavailable."
            : events ? "Activity could not be refreshed. Showing the last snapshot." : "Workspace activity could not be loaded."}
        </Text>
      ) : null}
      {!offline && !events && activity.isPending ? <Text style={styles.label}>Loading workspace activity…</Text> : null}
      {events?.length === 0 ? <Text style={styles.label}>No activity recorded.</Text> : null}
      {events?.map((event, index) => (
        <View key={`${event.reason}-${event.observedAt}-${index}`} style={[styles.card, { gap: 6 }]}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "baseline", justifyContent: "space-between" }}>
            <Text style={[styles.body, { fontWeight: "600" }]}>{titles[event.kind]}</Text>
            <Text style={styles.label}>{event.observedAt ? new Date(event.observedAt).toLocaleString() : "Time unknown"}</Text>
          </View>
          <Text style={event.state === "blocked" || event.state === "uncertain" ? styles.conflict : styles.body}>{descriptions[event.reason]}</Text>
        </View>
      ))}
    </>
  );
}
