import type {
  PluginAgentPanelProps,
  PluginHostProps,
} from "@getpaseo/plugin/client";
import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { useSubscription } from "@getpaseo/plugin/client";
import { useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { factoryCold } from "../shared/factory.js";
import { coldHintText, resumeReminderText } from "../shared/idle-cleanup.js";
import { ColdActions } from "./cold-actions.js";

const NO_INPUT = {};

/** Why an agent needs attention. "cold" keeps the C6 pill; the rest need resume. */
export type AttentionReason = "daemon-restart" | "limit" | "failed" | "cold";

export type NeedsResumeReason = "daemon-restart" | "limit" | "failed";

interface ColdRow {
  workspaceId: string;
  agentId: string;
  title: unknown;
  contextTokens: number;
  idleMinutes: number;
  hasHistory: boolean;
  canFresh: boolean;
  reason?: AttentionReason;
  slot: string | null;
  activeSteer: string | null;
  advisor: boolean;
}

export type AttentionRow = ColdRow;

function isAttentionReason(value: unknown): value is AttentionReason {
  return value === "daemon-restart" || value === "limit" || value === "failed" || value === "cold";
}

/**
 * Reads the attention feed, tolerating the pre-R-A server shape: rows come
 * from `attention` when present, else from the `factory.cold` alias `cold`.
 */
export function attentionRowsOf(event: unknown): AttentionRow[] {
  const record = event as { attention?: unknown; cold?: unknown } | null;
  const list = Array.isArray(record?.attention)
    ? (record.attention as unknown[])
    : Array.isArray(record?.cold)
      ? (record.cold as unknown[])
      : [];
  const rows: AttentionRow[] = [];
  for (const entry of list) {
    const row = entry as Record<string, unknown> | null;
    if (typeof row?.agentId !== "string" || typeof row?.workspaceId !== "string") continue;
    rows.push({
      workspaceId: row.workspaceId,
      agentId: row.agentId,
      title: row.title,
      contextTokens: typeof row.contextTokens === "number" ? row.contextTokens : 0,
      idleMinutes: typeof row.idleMinutes === "number" ? row.idleMinutes : 0,
      hasHistory: row.hasHistory === true,
      canFresh: row.canFresh === true,
      ...(isAttentionReason(row.reason) ? { reason: row.reason } : {}),
      slot: typeof row.slot === "string" ? row.slot : null,
      activeSteer: typeof row.activeSteer === "string" ? row.activeSteer : null,
      advisor: row.advisor === true,
    });
  }
  return rows;
}

/** The resume reason of a row, or null for plain cold rows. */
export function resumeReasonOf(row: AttentionRow): NeedsResumeReason | null {
  return row.reason === "daemon-restart" || row.reason === "limit" || row.reason === "failed"
    ? row.reason
    : null;
}

/** Short German reason label for pill titles ("Resume nötig · Neustart"). */
export function resumeReasonLabel(reason: NeedsResumeReason): string {
  if (reason === "daemon-restart") return "Neustart";
  if (reason === "limit") return "Limit";
  return "Fehler";
}

function resumeReasonSentence(reason: NeedsResumeReason): string {
  if (reason === "daemon-restart") {
    return "Paseo restarted; fetch the state back with Resume instead of continuing in a cold context.";
  }
  if (reason === "limit") {
    return "An API limit stopped this steer; once it resets, Resume brings it back cleanly.";
  }
  return "The last turn failed; Resume saves the state and restarts the context.";
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
    setRows(attentionRowsOf(event));
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
  const needsResume = self ? resumeReasonOf(self) : null;
  const reminder =
    self && needsResume
      ? resumeReminderText({
          reasonLabel: resumeReasonLabel(needsResume),
          canFresh: self.canFresh,
          advisor: self.advisor,
          activeSteer: self.activeSteer,
        })
      : null;
  return (
    <View style={styles.screen}>
      {self ? (
        <View style={styles.screen}>
          <Text style={styles.title}>
            {reminder ? reminder.title : coldHintText(self.contextTokens, self.idleMinutes * 60_000)}
          </Text>
          <Text style={styles.muted}>
            {needsResume && reminder
              ? reminder.body
                ? `${reminder.body} ${resumeReasonSentence(needsResume)}`
                : resumeReasonSentence(needsResume)
              : `Idle ${self.idleMinutes}m with a large context. Read the brief, hand over to a fresh agent, or reopen the saved history.`}
          </Text>
          <ColdActions
            agentId={agentId}
            workspaceId={workspaceId}
            canFresh={self.canFresh}
            hasHistory={self.hasHistory}
            needsResume={needsResume}
            takeover={needsResume !== null && !self.canFresh && !self.advisor}
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
