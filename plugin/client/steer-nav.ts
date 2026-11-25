// "Open Factory" bridge (docs/design/steer-menu.md, step 3). A pill popover
// cannot open the workspace panel itself (PluginButtonContentProps has no
// openPanel in 0.17.4); it requests the navigation here and the client entry
// — which owns the PluginClientContext — opens the panel.
export interface OpenFactoryTarget {
  workspaceId: string;
  agentId?: string;
}

const listeners = new Set<(target: OpenFactoryTarget) => void>();

export function subscribeOpenFactory(listener: (target: OpenFactoryTarget) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function requestOpenFactory(target: OpenFactoryTarget): void {
  for (const listener of listeners) listener(target);
}
