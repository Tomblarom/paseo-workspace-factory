import { settingsRpc } from "@getpaseo/plugin";
import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import type { ComponentType } from "react";

let clientRef: PluginClientContext | null = null;
let itemComponent: ComponentType<PluginSidebarItemProps> | null = null;
let removeItem: (() => void) | null = null;

export function initSidebarController(
  client: PluginClientContext,
  component: ComponentType<PluginSidebarItemProps>,
): void {
  clientRef = client;
  itemComponent = component;
}

/** Adds or removes the sidebar entry at runtime, without a reload. */
export function setSidebarVisible(visible: boolean): void {
  if (!clientRef || !itemComponent) return;
  if (visible && !removeItem) {
    removeItem = clientRef.addSidebarHeaderItem({
      id: "factory",
      title: "Workspace Factory",
      Component: itemComponent,
    });
  } else if (!visible && removeItem) {
    removeItem();
    removeItem = null;
  }
}

/** Registers the entry when a stored device setting opts in; stays hidden otherwise. */
export async function syncSidebarFromSettings(): Promise<void> {
  if (!clientRef) return;
  try {
    const state = await clientRef.rpc(settingsRpc("factory-sidebar").read, {});
    if (state.status === "ready") {
      const values = state.values as unknown as { visible?: unknown };
      setSidebarVisible(values.visible === true);
    }
  } catch {
    // Unreadable means default off.
  }
}
