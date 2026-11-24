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
    adoptScoped: z.record(z.string(), z.record(z.string(), z.string())).optional(),
    local: z.array(z.string().min(1)).max(20).optional(),
    hub: z.array(z.string().min(1)).max(20).optional(),
    checkout: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    subject: z.string().min(1).optional(),
    main: z.string().min(1).optional(),
    domain: z.string().max(200).optional(),
    adoptWorker: z.record(z.string(), z.string().nullable()).optional(),
    detach: z.boolean().optional(),
    retitle: z.boolean().optional(),
    renameProject: z.string().min(1).optional(),
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
  slot: z.string().nullable().optional(),
  activeSteer: z.string().nullable().optional(),
  advisor: z.boolean().optional(),
});

/**
 * One attention row: a cold agent (reason "cold" or absent) or a steer that
 * needs `/factory resume` (daemon-restart, limit, failed). The server pushes
 * the same rows under both `attention` and the legacy `cold` key.
 */
const attentionAgent = coldAgent.extend({
  reason: z.enum(["daemon-restart", "limit", "failed", "cold"]).optional(),
});

const attentionEvent = (required: "attention" | "cold") =>
  z.looseObject({
    attention: required === "attention" ? z.array(attentionAgent) : z.array(attentionAgent).optional(),
    cold: required === "cold" ? z.array(attentionAgent) : z.array(attentionAgent).optional(),
    autoDisabled: z.boolean(),
    autoDisabledReason: z.unknown().optional(),
  });

export const factoryAttention = defineSubscription({
  name: "factory.attention",
  input: z.object({}),
  event: attentionEvent("attention"),
});

/** Legacy alias of factory.attention; the payload carries both keys. */
export const factoryCold = defineSubscription({
  name: "factory.cold",
  input: z.object({}),
  event: attentionEvent("cold"),
});

export const factoryResumeApply = defineRpc({
  name: "factory.resume.apply",
  input: z.object({
    workspaceId: z.string().min(1),
    agentId: z.string().min(1),
    fingerprint: z.string().min(1).optional(),
    /** Also take over when the steer is not active (self-takeover, skipped for advisors). */
    takeover: z.boolean().optional(),
  }),
  output: z.looseObject({
    agentId: z.string(),
    cleared: z.boolean(),
    detail: z.string(),
    tookOver: z.looseObject({ from: z.string(), to: z.string(), epoch: z.number() }).nullable().optional(),
    takeoverSkipped: z.string().nullable().optional(),
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

const modelRow = z.looseObject({
  position: z.number(),
  profile: z.string(),
  provider: z.string(),
  model: z.string(),
  thinking: z.string().nullable(),
  mode: z.string().nullable(),
  advisor: z.boolean(),
  sensitive: z.boolean(),
  available: z.boolean(),
  reasons: z.array(z.string()),
});

// Effective worker priority and steer slots (config file + settings document)
// with catalog availability. `revision` is the settings revision the lists were
// read at; `selected` is the profile a worker would start with now.
export const factoryModelsList = defineRpc({
  name: "factory.models.list",
  input: z.object({}),
  output: z.looseObject({
    revision: z.string().nullable(),
    workers: z.array(modelRow.extend({ selected: z.boolean() })),
    steers: z.array(modelRow.extend({ slot: z.string(), fallback: z.string().nullable() })),
    selectedWorker: z.string().nullable(),
    catalogError: z.string().nullable(),
  }),
});

// Plans one change on the effective config. The server cannot write the host
// settings document, so it returns the new document and the revision it read;
// the client saves it with the settings RPC (the same path as the settings page).
export const factoryModelsSet = defineRpc({
  name: "factory.models.set",
  input: z.object({
    action: z.enum(["worker-set", "worker-rm", "steer-set", "steer-rm", "advisor", "sensitive"]),
    n: z.string().min(1).optional(),
    spec: z.string().min(1).optional(),
    thinking: z.string().optional(),
    mode: z.string().optional(),
    profile: z.string().min(1).optional(),
    on: z.boolean().optional(),
  }),
  output: z.looseObject({
    summary: z.string(),
    notes: z.array(z.string()),
    warnings: z.array(z.string()),
    revision: z.string(),
    values: z.unknown(),
  }),
});

// Live provider catalog, rendered like the CLI `models` command.
export const factoryModelsCatalog = defineRpc({
  name: "factory.models.catalog",
  input: z.object({}),
  output: z.looseObject({ text: z.string() }),
});

// Worker register of one scope, rendered like the CLI `workers` command.
export const factoryWorkers = defineRpc({
  name: "factory.workers",
  input: z.object({
    repo: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
  }),
  output: z.looseObject({
    scope: z.string(),
    epoch: z.number().nullable(),
    workers: z.unknown(),
    text: z.string(),
  }),
});

// Retire assessment of one agent (preview only, like the CLI `retire`).
export const factoryRetire = defineRpc({
  name: "factory.retire",
  input: z.object({ agentId: z.string().min(1) }),
  output: z.looseObject({
    agentId: z.string(),
    assessment: z.unknown(),
    text: z.string(),
  }),
});

// Resolved worker profile plus `paseo run` flags, like `worker pick`.
export const factoryWorkerPick = defineRpc({
  name: "factory.worker.pick",
  input: z.object({
    repo: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
  }),
  output: z.looseObject({
    profile: z.string(),
    provider: z.string(),
    model: z.string(),
    thinking: z.string().nullable(),
    mode: z.string().nullable(),
    sensitive: z.boolean(),
    flags: z.string(),
    zerosubAccount: z.string().nullable(),
    skipped: z.unknown(),
    text: z.string(),
  }),
});

// Drain: wait until no factory agent runs (marks leftovers planned-restart).
export const factoryDrain = defineRpc({
  name: "factory.drain",
  input: z.object({ timeout: z.string().min(1).optional() }),
  output: z.looseObject({
    clean: z.boolean(),
    waitedMs: z.number(),
    timeoutMs: z.number(),
    running: z.unknown(),
    marked: z.unknown(),
    text: z.string(),
  }),
});

const assignArgs = {
  repo: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  task: z.string().min(1),
  tests: z.array(z.string()).optional(),
  blockers: z.array(z.string()).optional(),
  next: z.string().optional(),
};

export const factoryAssignPreview = defineRpc({
  name: "factory.assign.preview",
  input: z.object(assignArgs),
  output: z.looseObject({
    scope: z.string(),
    epoch: z.number(),
    slot: z.string(),
    steerId: z.string(),
    previous: z.string().nullable(),
    packet: z.string(),
    packetChars: z.number(),
    fingerprint: z.string(),
  }),
});

export const factoryAssign = defineRpc({
  name: "factory.assign",
  input: z.object({ ...assignArgs, fingerprint: z.string().min(1) }),
  output: z.looseObject({
    scope: z.string(),
    epoch: z.number(),
    slot: z.string(),
    steerId: z.string(),
    applied: z.boolean(),
    delivered: z.boolean(),
  }),
});

const relocateArgs = {
  repo: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  to: z.string().min(1),
};

export const factoryRelocatePreview = defineRpc({
  name: "factory.relocate.preview",
  input: z.object(relocateArgs),
  output: z.looseObject({
    scope: z.string(),
    fromWorkspace: z.string(),
    toDir: z.string(),
    toWorkspace: z.string().nullable(),
    adoptedWorkspace: z.boolean(),
    movedTo: z.string(),
    checkpoint: z.boolean(),
    notes: z.array(z.unknown()),
    steers: z.array(z.unknown()),
    packets: z.array(z.unknown()),
    fingerprint: z.string(),
  }),
});

export const factoryRelocate = defineRpc({
  name: "factory.relocate",
  input: z.object({ ...relocateArgs, fingerprint: z.string().min(1) }),
  output: z.looseObject({
    scope: z.string(),
    fromWorkspace: z.string(),
    toDir: z.string(),
    toWorkspace: z.unknown(),
    movedTo: z.string(),
    applied: z.boolean(),
  }),
});

// Cleanup plan (like `cleanup --plan`): stored under its hash, applied with /factory apply.
export const factoryCleanupPlan = defineRpc({
  name: "factory.cleanup.plan",
  input: z.object({
    allowDestructive: z.boolean().optional(),
    allowIgnored: z.boolean().optional(),
    only: z.array(z.string().min(1)).optional(),
  }),
  output: z.looseObject({
    hash: z.string(),
    plans: z.array(z.unknown()),
    hints: z.array(z.unknown()),
  }),
});

const quotaPool = z.looseObject({
  pool: z.string(),
  sessionPct: z.number().nullable(),
  weeklyPct: z.number().nullable().optional(),
  resetAt: z.string().nullable().optional(),
  state: z.enum(["ok", "warn", "exhausted"]),
  sampledAt: z.string().nullable(),
});

// Current quota snapshot per pool plus the pool of each steer slot and each
// worker priority entry. Read-only; states use the effective quota thresholds.
export const factoryQuota = defineRpc({
  name: "factory.quota",
  input: z.object({}),
  output: z.looseObject({
    sampledAt: z.string().nullable(),
    warnPct: z.number(),
    exhaustedPct: z.number(),
    pools: z.array(quotaPool),
    steers: z.array(
      z.looseObject({
        slot: z.string(),
        profile: z.string(),
        pool: z.string(),
        advisor: z.boolean(),
      }),
    ),
    workers: z.array(
      z.looseObject({
        position: z.number(),
        profile: z.string(),
        pool: z.string(),
      }),
    ),
  }),
});

const labelRow = z.looseObject({
  agentId: z.string(),
  title: z.string().nullable(),
  workspaceId: z.string().nullable(),
  scope: z.string().nullable(),
  kind: z.string().nullable(),
  slot: z.string().nullable(),
  owner: z.string().nullable(),
  labels: z.record(z.string(), z.string()),
  was: z.record(z.string(), z.string().nullable()),
  migrate: z.array(z.string()),
  note: z.string().nullable(),
});

// Label audit over the whole instance, one scope, or one agent (read-only).
// Without an address every project is audited, like the CLI `labels`.
export const factoryLabelsPreview = defineRpc({
  name: "factory.labels.preview",
  input: z.object({
    address: z.string().min(1).optional(),
  }),
  output: z.looseObject({
    address: z.string().nullable(),
    rows: z.array(labelRow),
    fixable: z.number(),
    text: z.string(),
    fingerprint: z.string(),
  }),
});

// Sets the previewed labels; the server recomputes the audit from fresh state
// and refuses the write when the fingerprint no longer matches.
export const factoryLabels = defineRpc({
  name: "factory.labels",
  input: z.object({
    address: z.string().min(1).optional(),
    fingerprint: z.string().min(1),
  }),
  output: z.looseObject({
    address: z.string().nullable(),
    rows: z.array(labelRow),
    applied: z.array(z.unknown()),
    text: z.string(),
  }),
});

const steerAddArgs = {
  repo: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  slot: z.string().min(1).max(2).optional(),
  spec: z.string().min(1).optional(),
  thinking: z.string().optional(),
  mode: z.string().optional(),
  profile: z.string().min(1).optional(),
};

// Steer-add preview for the current scope (read-only): the slot, profile and
// ZeroSub account the apply would use, the new settings document (unsaved)
// and the fingerprint the apply must quote. Writes nothing.
export const factorySteerAddPreview = defineRpc({
  name: "factory.steer.add.preview",
  input: z.object(steerAddArgs),
  output: z.looseObject({
    scope: z.string(),
    repo: z.string(),
    workspaceId: z.string(),
    slot: z.string(),
    profile: z.string().nullable(),
    provider: z.string().nullable(),
    model: z.string().nullable(),
    advisor: z.boolean(),
    account: z.string().nullable(),
    skipped: z.array(z.unknown()),
    earliestReset: z.string().nullable(),
    summary: z.string(),
    notes: z.array(z.string()),
    warnings: z.array(z.string()),
    text: z.string(),
    fingerprint: z.string().nullable(),
    revision: z.string(),
    values: z.unknown(),
  }),
});

// Creates the previewed steer; the server recomputes the preview from fresh
// state and refuses the write when the fingerprint no longer matches. The
// client saves `values` through the settings RPC first (guarded by
// `revision`), so a retry converges: a configured-but-unprovisioned slot
// provisions, a live-occupied slot returns the existing agent.
export const factorySteerAdd = defineRpc({
  name: "factory.steer.add",
  input: z.object({ ...steerAddArgs, fingerprint: z.string().min(1) }),
  output: z.looseObject({
    scope: z.string(),
    slot: z.string(),
    agentId: z.string(),
    profile: z.string(),
    provider: z.string(),
    model: z.string(),
    account: z.string().nullable(),
    applied: z.boolean(),
    reused: z.boolean().optional(),
    text: z.string(),
  }),
});
