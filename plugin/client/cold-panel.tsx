import type {
  PluginAgentPanelProps,
  PluginHostProps,
} from "@getpaseo/plugin/client";
import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { useSubscription } from "@getpaseo/plugin/client";
import { useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { factoryCold } from "../shared/factory.js";
import { coldHintText } from "../shared/idle-cleanup.js";
import { ColdActions } from "./cold-actions.js";

const NO_INPUT = {};

interface ColdRow {
  workspaceId: string;
  agentId: string;
  title: unknown;
  contextTokens: number;
  idleMinutes: number;
  hasHistory: boolean;
  canFresh: boolean;
}

interface ColdSelf {
  rows: ColdRow[] | null;
  self: ColdRow | null;
  autoDisabled: boolean;
  autoDisabledReason: string | null;
}

/** Follows the server's cold list and picks the row for one agent. */
function useColdSelf(agentId: string): ColdSelf {
  const [rows, setRows] = useState<ColdRow[] | null>(null);
  const [autoDisabled, setAutoDisabled] = useState(false);
  const [autoDisabledReason, setAutoDisabledReason] = useState<string | null>(null);
  const onEvent = useCallback((event: any) => {
    setRows(Array.isArray(event?.cold) ? (event.cold as ColdRow[]) : []);
    setAutoDisabled(event?.autoDisabled === true);
    setAutoDisabledReason(
      typeof event?.autoDisabledReason === "string" ? event.autoDisabledReason : null,
    );
  }, []);
  useSubscription(factoryCold, NO_INPUT, onEvent);
  const self = useMemo(
    () => (rows ?? []).find((row) => row.agentId === agentId) ?? null,
    [rows, agentId],
  );
  return { rows, self, autoDisabled, autoDisabledReason };
}

function useColdStyles(theme: PluginHostProps["theme"], compact: boolean) {
  return useMemo(
    () => ({
      screen: { flex: 1, padding: compact ? 16 : 24, gap: compact ? 8 : 12 },
      title: { color: theme.colors.foreground, fontSize: compact ? 18 : 20 },
      body: { color: theme.colors.foreground, fontSize: 14 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
      warn: { color: theme.colors.statusWarning, fontSize: 13 },
    }),
    [theme, compact],
  );
}

function ColdBody({
  agentId,
  workspaceId,
  theme,
  compact,
}: {
  agentId: string;
  workspaceId: string;
  theme: PluginHostProps["theme"];
  compact: boolean;
}) {
  const styles = useColdStyles(theme, compact);
  const { rows, self, autoDisabled, autoDisabledReason } = useColdSelf(agentId);
  if (!rows) {
    return (
      <View style={styles.screen}>
        <Text style={styles.muted}>Checking context…</Text>
      </View>
    );
  }
  return (
    <View style={styles.screen}>
      {self ? (
        <View style={styles.screen}>
          <Text style={styles.title}>
            {coldHintText(self.contextTokens, self.idleMinutes * 60_000)}
          </Text>
          <Text style={styles.muted}>
            Idle {self.idleMinutes}m with a large context. Resume here, hand over to a fresh agent,
            or reopen the saved history.
          </Text>
          <ColdActions
            agentId={agentId}
            workspaceId={workspaceId}
            canFresh={self.canFresh}
            hasHistory={self.hasHistory}
            theme={theme}
            compact={compact}
          />
        </View>
      ) : (
        <Text style={styles.muted}>Context warm. Nothing to clean.</Text>
      )}
      {autoDisabled ? (
        <Text style={styles.warn}>
          Automatic cleanup is off
          {autoDisabledReason ? `: ${autoDisabledReason}` : ""}. Change the cleanup mode setting to
          probe again.
        </Text>
      ) : null}
    </View>
  );
}

/** Per-agent panel; shows the cold hint only for its own cold agent. */
export function FactoryColdPanel({ agentId, workspaceId, theme, layout }: PluginAgentPanelProps) {
  return (
    <ScrollView>
      <ColdBody agentId={agentId} workspaceId={workspaceId} theme={theme} compact={layout.compact} />
    </ScrollView>
  );
}

/** Composer pill popover content; the pill itself is managed by the entry. */
export function FactoryColdPillContent(props: PluginButtonContentProps) {
  // Pills always carry the agent context; anything else renders the warm line.
  const agentId = props.context === "agent" ? props.agentId : "";
  return (
    <ColdBody
      agentId={agentId}
      workspaceId={props.workspaceId}
      theme={props.theme}
      compact={props.layout.compact}
    />
  );
}
