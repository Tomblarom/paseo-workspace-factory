import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

export const factoryPing = defineRpc({
  name: "factory.ping",
  input: z.object({}),
  output: z.object({ ok: z.literal(true), nodeVersion: z.string() }),
});

const steerSummary = z.looseObject({
  slot: z.string(),
  id: z.string(),
  title: z.unknown().optional(),
  provider: z.unknown().optional(),
  model: z.unknown().optional(),
  status: z.unknown().optional(),
  parent: z.unknown().optional(),
  workspaceId: z.unknown().optional(),
});

const workerSummary = z.looseObject({
  id: z.string(),
  title: z.unknown().optional(),
  provider: z.unknown().optional(),
  model: z.unknown().optional(),
  status: z.unknown().optional(),
  parentSlot: z.unknown().optional(),
  parent: z.unknown().optional(),
});

export const factoryStatus = defineRpc({
  name: "factory.status",
  input: z.object({
    repo: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
  }),
  output: z.looseObject({
    repo: z.string(),
    workspace: z.unknown().optional(),
    state: z.unknown().optional(),
    checkpoint: z.unknown().optional(),
    steers: z.array(steerSummary),
    workers: z.array(workerSummary),
    scope: z.unknown().optional(),
    deprecatedAlias: z.boolean().optional(),
  }),
});

const scopeRow = z.looseObject({
  id: z.string(),
  kind: z.string(),
  workspaceId: z.string(),
});

export const factoryScopes = defineRpc({
  name: "factory.scopes",
  input: z.object({}),
  output: z.looseObject({ rows: z.array(scopeRow) }),
});

const scopeCandidate = z.looseObject({
  workspaceId: z.string(),
  title: z.unknown().optional(),
  directory: z.unknown().optional(),
  projectKind: z.unknown().optional(),
  worktree: z.boolean(),
  agents: z.array(z.unknown()),
  suggestedPlan: z.string(),
});

export const factoryScopesCandidates = defineRpc({
  name: "factory.scopes.candidates",
  input: z.object({}),
  output: z.looseObject({ rows: z.array(scopeCandidate) }),
});

const cleanupCandidate = z.looseObject({
  kind: z.string(),
  id: z.string(),
  title: z.unknown().optional(),
  path: z.unknown().optional(),
  detail: z.string(),
  action: z.string(),
  loss: z.unknown(),
});

export const factoryCleanup = defineRpc({
  name: "factory.cleanup",
  input: z.object({}),
  output: z.looseObject({ candidates: z.array(cleanupCandidate) }),
});

const planReport = z.looseObject({
  repo: z.string(),
  status: z.string(),
  ops: z.array(z.unknown()),
  conflicts: z.array(z.unknown()),
  notes: z.array(z.unknown()),
});

export const factoryPlan = defineRpc({
  name: "factory.plan",
  input: z.object({
    repos: z.array(z.string().min(1)).max(20).optional(),
    workspaceId: z.string().min(1).optional(),
    allowFork: z.boolean().optional(),
    slots: z.array(z.string()).optional(),
    adopt: z.record(z.string(), z.string()).optional(),
  }),
  output: z.looseObject({
    hash: z.string(),
    plans: z.array(planReport),
  }),
});

export const factorySwitchPreview = defineRpc({
  name: "factory.switch.preview",
  input: z.object({
    repo: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
    to: z.string().min(1),
  }),
  output: z.looseObject({
    repo: z.string(),
    from: z.string(),
    to: z.string(),
    epoch: z.number(),
    packet: z.string(),
    packetChars: z.number(),
    checkpoint: z.boolean(),
    fingerprint: z.string(),
    scope: z.unknown().optional(),
    deprecatedAlias: z.boolean().optional(),
  }),
});

export const factorySwitch = defineRpc({
  name: "factory.switch",
  input: z.object({
    repo: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
    to: z.string().min(1),
    fingerprint: z.string().min(1),
  }),
  output: z.looseObject({
    repo: z.string(),
    from: z.string(),
    to: z.string(),
    epoch: z.number(),
    applied: z.boolean(),
    delivered: z.boolean(),
    packetChars: z.number().optional(),
    checkpoint: z.boolean().optional(),
    deliveryError: z.unknown().optional(),
    previousNotified: z.boolean().optional(),
  }),
});

const checkpointFields = z.object({
  task: z.string(),
  tests: z.array(z.string()),
  blockers: z.array(z.string()),
  next: z.string().nullable(),
});

const checkpointArgs = {
  repo: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  task: z.string().optional(),
  fromAgent: z.string().optional(),
  tests: z.array(z.string()).optional(),
  blockers: z.array(z.string()).optional(),
  next: z.string().optional(),
};

export const factoryCheckpointPreview = defineRpc({
  name: "factory.checkpoint.preview",
  input: z.object(checkpointArgs),
  output: z.looseObject({
    repo: z.string(),
    workspaceId: z.string(),
    epoch: z.number().nullable(),
    fields: checkpointFields,
    fingerprint: z.string(),
    scope: z.unknown().optional(),
    deprecatedAlias: z.boolean().optional(),
  }),
});

export const factoryCheckpoint = defineRpc({
  name: "factory.checkpoint",
  input: z.object({ ...checkpointArgs, fingerprint: z.string().min(1) }),
  output: z.looseObject({ checkpoint: z.unknown() }),
});

export const factoryApply = defineRpc({
  name: "factory.apply",
  input: z.object({ hash: z.string().regex(/^[0-9a-f]{16}$/) }),
  output: z.looseObject({
    hash: z.string(),
    report: z.unknown(),
    journal: z.unknown().optional(),
  }),
});

export const factoryResume = defineRpc({
  name: "factory.resume",
  input: z.object({
    repo: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
    agentId: z.string().min(1).optional(),
  }),
  output: z.looseObject({
    scope: z.string(),
    kind: z.unknown().optional(),
    epoch: z.unknown().optional(),
    agentId: z.unknown().optional(),
    brief: z.string(),
  }),
});

const coldAgent = z.looseObject({
  workspaceId: z.string(),
  agentId: z.string(),
  title: z.unknown().optional(),
  contextTokens: z.number(),
  idleMinutes: z.number(),
  hasHistory: z.boolean(),
  canFresh: z.boolean(),
});

export const factoryCold = defineSubscription({
  name: "factory.cold",
  input: z.object({}),
  event: z.looseObject({
    cold: z.array(coldAgent),
    autoDisabled: z.boolean(),
    autoDisabledReason: z.unknown().optional(),
  }),
});

export const factoryFreshPreview = defineRpc({
  name: "factory.fresh.preview",
  input: z.object({
    repo: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
  }),
  output: z.looseObject({
    repo: z.string(),
    slot: z.string(),
    from: z.unknown().optional(),
    epoch: z.number(),
    profile: z.unknown().optional(),
    provider: z.unknown().optional(),
    model: z.unknown().optional(),
    packet: z.string(),
    packetChars: z.number(),
    checkpoint: z.boolean(),
    fingerprint: z.string(),
    scope: z.unknown().optional(),
    deprecatedAlias: z.boolean().optional(),
  }),
});

export const factoryFresh = defineRpc({
  name: "factory.fresh",
  input: z.object({
    repo: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
    fingerprint: z.string().min(1),
  }),
  output: z.looseObject({
    repo: z.string(),
    slot: z.string(),
    from: z.unknown().optional(),
    to: z.unknown().optional(),
    epoch: z.number(),
    applied: z.boolean(),
    delivered: z.boolean(),
    packetChars: z.number().optional(),
    checkpoint: z.boolean().optional(),
    deliveryError: z.unknown().optional(),
    previousNotified: z.boolean().optional(),
    reused: z.boolean().optional(),
  }),
});

export const factoryHistoryOpen = defineRpc({
  name: "factory.history.open",
  input: z.object({ agentId: z.string().min(1) }),
  output: z.looseObject({
    agentId: z.string(),
    sessionId: z.string(),
    imported: z.boolean(),
    detail: z.string(),
  }),
});
