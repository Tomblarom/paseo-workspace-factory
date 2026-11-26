// The tab title "Steer X" is steer membership; this writes the factory labels
// that readers still key on, so renaming a tab in Paseo is enough.
import { steerTitleLabelPatches } from "./core/discovery.mjs";
import { createPaseoCli } from "./core/paseo.mjs";

export type LabelWriter = (agentId: string, labels: Record<string, string>) => void | Promise<void>;

const defaultWriter: LabelWriter = (agentId, labels) => {
  createPaseoCli()(["agent", "update", agentId, "--label",
    Object.entries(labels).map(([key, value]) => `${key}=${value}`).join(",")]);
};

/**
 * Applies missing title labels (optionally for one agent only) and mirrors
 * them into `paseoState.agents`, so the caller's projection sees them at once.
 * Failures are logged per agent; the next feed tick or turn retries.
 */
export async function applySteerTitleLabels(paseoState: any, { agentId = null, write = defaultWriter, config = null }: { agentId?: string | null; write?: LabelWriter; config?: any } = {}): Promise<number> {
  let applied = 0;
  for (const patch of steerTitleLabelPatches(paseoState, config) as Array<{ agentId: string; labels: Record<string, string> }>) {
    if (agentId && patch.agentId !== agentId) continue;
    // A feed is host-wide. Backfill just the opening holder on its turn;
    // a title change still captures the old role together with its new slot.
    if (!agentId && Object.keys(patch.labels).every((key) => key === "wsf.steer-role")) continue;
    try {
      await write(patch.agentId, patch.labels);
      const agent = (paseoState?.agents ?? []).find((entry: any) => entry?.id === patch.agentId);
      if (agent) agent.labels = { ...(agent.labels ?? {}), ...patch.labels };
      applied += 1;
    } catch (error) {
      console.error(`[factory] steer title labels for ${patch.agentId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return applied;
}
