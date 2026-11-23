import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { FactoryPopover } from "./factory-popover.js";

export function FactorySidebarItem({ openPopover }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Factory"
      onPress={() => openPopover(FactoryPopover)}
    />
  );
}
