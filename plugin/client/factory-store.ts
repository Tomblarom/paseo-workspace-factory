import type { RpcOutput } from "@getpaseo/plugin";
import type {
  factoryApply,
  factoryCheckpoint,
  factoryCheckpointPreview,
  factoryCleanup,
  factoryPlan,
  factoryResume,
  factoryScopes,
  factoryScopesCandidates,
  factoryStatus,
  factorySwitch,
  factorySwitchPreview,
} from "../shared/factory.js";

export interface CheckpointPreviewInputs {
  task?: string;
  fromAgent?: string;
  tests: string[];
  blockers: string[];
  next?: string;
}

export type FactoryPanelResult =
  | { kind: "status"; repo: string; at: string; status: RpcOutput<typeof factoryStatus> }
  | { kind: "scopes"; at: string; scopes: RpcOutput<typeof factoryScopes> }
  | { kind: "scopeCandidates"; at: string; candidates: RpcOutput<typeof factoryScopesCandidates> }
  | { kind: "cleanup"; at: string; cleanup: RpcOutput<typeof factoryCleanup> }
  | { kind: "plan"; repos: string[]; at: string; plan: RpcOutput<typeof factoryPlan> }
  | { kind: "applied"; at: string; applied: RpcOutput<typeof factoryApply> }
  | {
      kind: "checkpointPreview";
      repo?: string;
      workspaceId: string;
      at: string;
      inputs: CheckpointPreviewInputs;
      preview: RpcOutput<typeof factoryCheckpointPreview>;
    }
  | {
      kind: "checkpointWritten";
      repo: string;
      at: string;
      written: RpcOutput<typeof factoryCheckpoint>;
    }
  | {
      kind: "switchPreview";
      repo?: string;
      workspaceId: string;
      to: string;
      requestedApply: boolean;
      at: string;
      preview: RpcOutput<typeof factorySwitchPreview>;
    }
  | { kind: "switched"; repo: string; at: string; result: RpcOutput<typeof factorySwitch> }
  | { kind: "resume"; repo: string; at: string; resume: RpcOutput<typeof factoryResume> }
  | { kind: "info"; at: string; text: string }
  | { kind: "error"; at: string; message: string };

let current: FactoryPanelResult | null = null;
const listeners = new Set<() => void>();

export function getFactoryResult(): FactoryPanelResult | null {
  return current;
}

export function setFactoryResult(next: FactoryPanelResult): void {
  current = next;
  for (const listener of listeners) listener();
}

export function subscribeFactoryResult(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
