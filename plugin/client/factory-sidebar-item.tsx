import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useSubscription } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useCallback, useState } from "react";
import { Text } from "react-native";
import { factoryCold } from "../shared/factory.js";
import { countActiveResumeRows } from "../shared/idle-cleanup.js";
import { attentionRowsOf } from "./cold-panel.js";

const NO_INPUT = {};

// Screen that hosts the settings page. The sidebar props offer no openSettings
// (only command contexts do), so the same component is registered as a
// screen, and the row opens that.
export const SETTINGS_SCREEN_ID = "factory-settings-screen";

export function FactorySidebarItem({ openScreen, theme }: PluginSidebarItemProps) {
  const [resumeCount, setResumeCount] = useState(0);
  const onEvent = useCallback((event: any) => {
    setResumeCount(countActiveResumeRows(attentionRowsOf(event)));
  }, []);
  useSubscription(factoryCold, NO_INPUT, onEvent);
  return (
    <SidebarRow
      icon="Factory"
      label="Workspace Factory"
      onPress={() => openScreen({ screenId: SETTINGS_SCREEN_ID })}
      trailing={
        resumeCount > 0 ? (
          <Text style={{ color: theme.colors.statusWarning, fontSize: 13 }}>
            {resumeCount === 1 ? "1 Steer braucht Resume" : `${resumeCount} Steers brauchen Resume`}
          </Text>
        ) : undefined
      }
    />
  );
}
