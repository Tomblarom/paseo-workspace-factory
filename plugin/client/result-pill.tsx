import type {
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { useMemo, useSyncExternalStore } from "react";
import { ScrollView, Text, View } from "react-native";
import {
  ResultView,
  type FactoryResultActions,
  type FactoryResultStyles,
} from "./factory-panel.js";
import type { FactoryResultStore } from "./factory-store.js";
import { resultPillId } from "./steer-pill.js";

const RESULT_PILL_TTL_MS = 60_000;

export const READONLY_FACTORY_RESULT_ACTIONS: FactoryResultActions = {
  busy: true,
  apply: () => {},
  confirmCheckpoint: () => {},
  confirmSwitch: () => {},
  confirmResume: () => {},
  confirmFresh: () => {},
  confirmAssign: () => {},
  confirmSteerAdd: () => {},
};

/**
 * Popover of the transient /factory result pill. It renders the same
 * setFactoryResult content as the panel, read-only: anything with a confirm
 * button opens the panel instead, so the pill never needs working actions.
 */
function FactoryResultPillContent({ theme, layout, results }: PluginButtonContentProps & { results: FactoryResultStore }) {
  const result = useSyncExternalStore(results.subscribe, results.getResult, results.getResult);
  const styles = useMemo<FactoryResultStyles>(
    () => ({
      label: { color: theme.colors.foregroundMuted, fontSize: 13 },
      body: { color: theme.colors.foreground, fontSize: 14 },
      hash: { color: theme.colors.foreground, fontSize: 14 },
      error: { color: theme.colors.statusDanger, fontSize: 14 },
      conflict: { color: theme.colors.statusWarning, fontSize: 14 },
      ok: { color: theme.colors.statusSuccess, fontSize: 14 },
      card: {
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        padding: 12,
        gap: 4,
      },
      button: {
        paddingVertical: 10,
        paddingHorizontal: 14,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
      },
      buttonText: { color: theme.colors.accentForeground, fontSize: 14 },
    }),
    [theme, layout.compact],
  );
  if (!result) {
    return (
      <View style={{ padding: 12 }}>
        <Text style={styles.label}>No /factory result yet.</Text>
      </View>
    );
  }
  return (
    <ScrollView>
      <View style={{ padding: 12 }}>
        <ResultView result={result} styles={styles} actions={READONLY_FACTORY_RESULT_ACTIONS} />
      </View>
    </ScrollView>
  );
}

let current: PluginButtonRegistration | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function clearCurrent(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (current) {
    try {
      current.remove();
    } catch {
      // Already gone.
    }
    current = null;
  }
}

/** Removes the transient result pill, if any (next /factory, timeout, stop). */
export function dismissFactoryResultPill(): void {
  clearCurrent();
}

/**
 * Shows one transient "Factory: <summary>" composer pill on the calling
 * agent. It replaces any previous result pill and disappears after 60 s or
 * with the next /factory call.
 */
export function showFactoryResultPill(
  client: PluginClientContext,
  input: { workspaceId: string; agentId: string; summary: string; results: FactoryResultStore },
): void {
  clearCurrent();
  try {
    current = client.addComposerPill({
      id: resultPillId(input.agentId),
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      button: {
        title: "Factory",
        label: `Factory: ${input.summary}`,
        icon: "Factory",
        behavior: { kind: "popover", Content: (props) => <FactoryResultPillContent {...props} results={input.results} /> },
      },
    });
  } catch {
    // The agent or composer is gone; the panel still holds the result.
    return;
  }
  timer = setTimeout(clearCurrent, RESULT_PILL_TTL_MS);
}
