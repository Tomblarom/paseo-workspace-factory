import type { RpcOutput } from "@getpaseo/plugin";
import type {
  factoryApply,
  factoryAssignPreview,
  factoryCheckpoint,
  factoryCheckpointPreview,
  factoryCleanup,
  factoryFreshPreview,
  factoryPlan,
  factoryQuota,
  factoryResume,
  factoryResumeApply,
  factoryScopes,
  factoryScopesCandidates,
  factoryStatus,
  factorySteerAdd,
  factorySteerAddPreview,
  factorySwitch,
  factorySwitchPreview,
} from "../shared/factory.js";

export interface CheckpointPreviewInputs {
  task?: string;
  fromAgent?: string;
  fromSteer?: string;
  tests: string[];
  blockers: string[];
  next?: string;
}

export interface AssignPreviewInputs {
  task: string;
  tests: string[];
  blockers: string[];
  next?: string;
}

export interface SteerAddPreviewInputs {
  slot?: string;
  spec?: string;
  thinking?: string;
  mode?: string;
  profile?: string;
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
  | {
      kind: "freshPreview";
      repo?: string;
      workspaceId: string;
      at: string;
      preview: RpcOutput<typeof factoryFreshPreview>;
    }
  | {
      kind: "assignPreview";
      repo?: string;
      workspaceId: string;
      at: string;
      inputs: AssignPreviewInputs;
      preview: RpcOutput<typeof factoryAssignPreview>;
    }
  | {
      kind: "steerAddPreview";
      repo?: string;
      workspaceId: string;
      at: string;
      inputs: SteerAddPreviewInputs;
      preview: RpcOutput<typeof factorySteerAddPreview>;
    }
  | {
      kind: "steerAdded";
      repo: string;
      at: string;
      added: RpcOutput<typeof factorySteerAdd>;
    }
  | { kind: "resume"; repo: string; at: string; resume: RpcOutput<typeof factoryResume> }
  | { kind: "resumePreview"; workspaceId: string; agentId: string; at: string }
  | {
      kind: "resumeApplied";
      workspaceId: string;
      agentId: string;
      at: string;
      applied: RpcOutput<typeof factoryResumeApply>;
    }
  | { kind: "quota"; at: string; quota: RpcOutput<typeof factoryQuota> }
  | { kind: "info"; at: string; text: string }
  | { kind: "error"; at: string; message: string };

export interface FactoryResultStore {
  getResult: () => FactoryPanelResult | null;
  setResult: (next: FactoryPanelResult) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createFactoryResultStores() {
  const workspaces = new Map<string, FactoryResultStore>();
  return (workspaceId: string): FactoryResultStore => {
    const existing = workspaces.get(workspaceId);
    if (existing) return existing;
    let current: FactoryPanelResult | null = null;
    const listeners = new Set<() => void>();
    const store: FactoryResultStore = {
      getResult: () => current,
      setResult(next) {
        current = next;
        for (const listener of listeners) listener();
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    };
    workspaces.set(workspaceId, store);
    return store;
  };
}
