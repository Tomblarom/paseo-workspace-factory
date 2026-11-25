import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";

/** Plain sidebar row: no warnings or status text; those live in the panels. */
export function FactorySidebarItem({ openSettings }: PluginSidebarItemProps & { openSettings: () => void }) {
  return <SidebarRow icon="Factory" label="Workspace Factory" onPress={openSettings} />;
}
