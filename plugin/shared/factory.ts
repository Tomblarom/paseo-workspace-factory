import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

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
    agentId: z.string().min(1).optional(),
  }),
  output: z.looseObject({
    repo: z.string(),
    workspace: z.unknown().optional(),
    state: z.unknown().optional(),
    checkpoint: z.unknown().optional(),
    steers: z.array(steerSummary),
    workers: z.array(workerSummary),
    pendingWorkerWakeCount: z.number().int().nonnegative().optional(),
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
  // K13: single-workspace enrollment only (each address list holds at most
  // one entry, and exactly one address overall). Retired: allowFork,
  // adoptScoped, checkout, subject, retitle, renameProject.
  input: z.object({
    repos: z.array(z.string().min(1)).max(1).optional(),
    workspaceId: z.string().min(1).optional(),
    slots: z.array(z.string()).optional(),
    adopt: z.record(z.string(), z.string()).optional(),
    local: z.array(z.string().min(1)).max(1).optional(),
    hub: z.array(z.string().min(1)).max(1).optional(),
    name: z.string().min(1).optional(),
    main: z.string().min(1).optional(),
    domain: z.string().max(200).optional(),
    adoptWorker: z.record(z.string(), z.string().nullable()).optional(),
    detach: z.boolean().optional(),
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
    callerId: z.string().min(1).optional(),
    language: z.enum(["en", "de"]).optional(),
  }),
  output: z.looseObject({
    repo: z.string(),
    workspaceId: z.string(),
    from: z.string(),
    to: z.string(),
    fromId: z.string().nullable(),
    toId: z.string(),
    epoch: z.number(),
    packet: z.string(),
    packetChars: z.number(),
    checkpoint: z.boolean(),
    checkpointAt: z.string().nullable(),
    fingerprint: z.string(),
    scope: z.unknown().optional(),
    deprecatedAlias: z.boolean().optional(),
  }),
});

/** CLI switch delivery uses the daemon's steer projection and host settings. */
export const factorySteerDelivery = defineRpc({
  name: "factory.steer.delivery",
  input: z.object({
    workspaceId: z.string().min(1),
    agentId: z.string().min(1),
    epoch: z.number().int(),
    text: z.string().min(1),
    renewalNote: z.string().optional(),
    actionId: z.string().optional(),
  }),
  output: z.object({
    status: z.enum(["sent", "pending", "blocked"]),
    cleared: z.boolean(),
    detail: z.string(),
    deliveryId: z.string().optional(),
  }),
});

export const factorySwitch = defineRpc({
  name: "factory.switch",
  input: z.object({
    repo: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
    to: z.string().min(1),
    fingerprint: z.string().min(1),
    /** "stage" applies without sending; "none" applies without sending or staging. */
    deliver: z.enum(["send", "stage", "none"]).optional(),
    /** Notify the outgoing steer (costs one of its turns). Default false. */
    notifyPrevious: z.boolean().optional(),
    callerId: z.string().min(1).optional(),
    language: z.enum(["en", "de"]).optional(),
    wait: z.boolean().optional(),
  }),
  output: z.looseObject({
    repo: z.string(),
    from: z.string(),
    to: z.string(),
    epoch: z.number(),
    applied: z.boolean(),
    delivered: z.boolean(),
    deliveryPending: z.boolean().optional(),
    workerHandoverPending: z.boolean().optional(),
    deliveryBlocked: z.boolean().optional(),
    /** True when the packet was staged (deliver=stage or a failed send). */
    staged: z.boolean().optional(),
    stagedTo: z.string().nullable().optional(),
    stageId: z.string().optional(),
    packet: z.string().optional(),
    packetChars: z.number().optional(),
    checkpoint: z.boolean().optional(),
    deliveryError: z.unknown().optional(),
    previousNotified: z.boolean().optional(),
  }),
});

export const quotaConfirmation = z.enum(["unknown", "depleted"]);
export type QuotaConfirmation = z.infer<typeof quotaConfirmation>;

export const factorySteerActivate = defineRpc({
  name: "factory.steer.activate",
  input: z.object({
    workspaceId: z.string().min(1),
    agentId: z.string().min(1),
    epoch: z.number().int().nonnegative(),
    confirmQuota: quotaConfirmation.optional(),
  }).strict(),
  output: z.object({
    status: z.enum(["sent", "pending", "blocked"]),
    detail: z.string(),
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
  fromSteer: z.string().regex(/^[A-Za-z]$/).optional(),
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
  input: z.object({
    ...checkpointArgs,
    fingerprint: z.string().min(1),
    callerId: z.string().min(1).optional(),
  }),
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
    callerId: z.string().min(1).optional(),
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
  warmth: z.enum(["warm", "cooling", "cold", "unknown"]).optional(),
  large: z.boolean().optional(),
  hasHistory: z.boolean(),
  canFresh: z.boolean(),
  slot: z.string().nullable().optional(),
  activeSteer: z.string().nullable().optional(),
  advisor: z.boolean().optional(),
  /** Valid stored fresh recommendation, also below the cold threshold; null when none. */
  freshHint: z.string().nullable().optional(),
});

/**
 * One attention row: a cold agent (reason "cold" or absent), a steer that
 * needs `/factory resume` (daemon-restart, limit, failed), or an idle agent
 * with a valid stored fresh recommendation (`freshHint`, also below the cold
 * threshold). The server pushes the same rows under both `attention` and the
 * legacy `cold` key.
 */
const attentionAgent = coldAgent.extend({
  reason: z.enum(["daemon-restart", "limit", "failed", "cold"]).optional(),
});

const attentionEvent = z.looseObject({
  attention: z.array(attentionAgent).optional(),
  cold: z.array(attentionAgent),
  autoDisabled: z.boolean(),
  autoDisabledReason: z.unknown().optional(),
});

/** Attention feed (cold agents, resume needs, fresh hints); the payload carries both keys. */
export const factoryCold = defineSubscription({
  name: "factory.cold",
  input: z.object({}),
  event: attentionEvent,
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
    status: z.enum(["sent", "pending", "blocked"]).optional(),
    detail: z.string(),
    tookOver: z.looseObject({ from: z.string(), to: z.string(), epoch: z.number() }).nullable().optional(),
    takeoverSkipped: z.string().nullable().optional(),
  }),
});

export const factoryFreshPreview = defineRpc({
  name: "factory.fresh.preview",
  input: z.object({
    slot: z.string().regex(/^[A-Za-z]$/).optional(),
    workerId: z.string().trim().min(1).optional(),
    provider: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional(),
    repo: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
    /** Skip in-place rewind and leave the original chat intact. */
    keepChatHistory: z.boolean().optional(),
    resetQuota: z.enum(["available", "unknown", "depleted"]).optional(),
  }),
  output: z.looseObject({
    repo: z.string(),
    workspaceId: z.string(),
    slot: z.string(),
    kind: z.enum(["steer", "worker"]).optional(),
    workerId: z.string().optional(),
    from: z.unknown().optional(),
    epoch: z.number(),
    profile: z.unknown().optional(),
    provider: z.unknown().optional(),
    model: z.unknown().optional(),
    routeEvidence: z.unknown().optional(),
    refreshMode: z.string().optional(),
    packet: z.string(),
    packetChars: z.number(),
    checkpoint: z.boolean(),
    checkpointAt: z.string().nullable(),
    warnings: z.array(z.string()).optional(),
    fingerprint: z.string(),
    scope: z.unknown().optional(),
    deprecatedAlias: z.boolean().optional(),
  }),
});

export const factoryFresh = defineRpc({
  name: "factory.fresh",
  input: z.object({
    slot: z.string().regex(/^[A-Za-z]$/).optional(),
    workerId: z.string().trim().min(1).optional(),
    provider: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional(),
    repo: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
    /** Skip in-place rewind and leave the original chat intact. */
    keepChatHistory: z.boolean().optional(),
    resetQuota: z.enum(["available", "unknown", "depleted"]).optional(),
    fingerprint: z.string().min(1),
    /** "stage" applies without sending; the packet is staged for later delivery. */
    deliver: z.enum(["send", "stage"]).optional(),
    /** Explicit approval to archive the source after creating the replacement. */
    archivePrevious: z.boolean().optional(),
  }),
  output: z.looseObject({
    repo: z.string(),
    slot: z.string(),
    from: z.unknown().optional(),
    to: z.unknown().optional(),
    epoch: z.number(),
    applied: z.boolean(),
    delivered: z.boolean(),
    /** The applied packet (for composer staging); empty on idempotent applies. */
    packet: z.string().optional(),
    refreshMode: z.string().optional(),
    idempotent: z.boolean().optional(),
    idempotentReason: z.string().nullable().optional(),
    /** True when the packet was staged (deliver=stage or a failed send). */
    staged: z.boolean().optional(),
    stagedTo: z.string().nullable().optional(),
    stageId: z.string().optional(),
    packetChars: z.number().optional(),
    checkpoint: z.boolean().optional(),
    deliveryError: z.unknown().optional(),
    previousNotified: z.boolean().optional(),
    reused: z.boolean().optional(),
  }),
});

const briefTarget = z.object({ workspaceId: z.string().min(1), agentId: z.string().min(1) });
const briefIdentity = briefTarget.extend({ stageId: z.string().min(1), epoch: z.number().int().nonnegative().nullable() });

export const factorySteerBrief = defineRpc({
  name: "factory.steer.brief",
  input: z.discriminatedUnion("action", [
    briefTarget.extend({ action: z.literal("inspect") }),
    briefIdentity.extend({ action: z.enum(["send", "dismiss"]) }),
    briefIdentity.extend({ action: z.literal("composer"), claimId: z.string().min(1), automatic: z.boolean().optional() }),
    briefIdentity.extend({ action: z.enum(["composer-complete", "composer-release"]), claimId: z.string().min(1) }),
    briefIdentity.extend({ action: z.literal("composer-resolve"), recoveryId: z.string().min(1), resolution: z.enum(["placed", "retry"]) }),
  ]),
  output: z.looseObject({
    agentId: z.string(),
    delivered: z.boolean(),
    dismissed: z.boolean().optional(),
    transferred: z.boolean().optional(),
    resolved: z.boolean().optional(),
    recoveryId: z.string().optional(),
    packet: z.string().optional(),
    stageId: z.string().optional(),
    epoch: z.number().int().nonnegative().nullable().optional(),
    detail: z.string(),
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

const settingsTuple = z.looseObject({
  provider: z.string().nullable(),
  model: z.string().nullable(),
  thinking: z.string().nullable(),
  speed: z.string().nullable(),
});

// Catalog-backed settings preview for one steer (step 4, same provider
// only): the current tuple, the requested tuple, the supported model /
// thinking / speed choices, and the route (Apply here vs Refresh). Writes
// nothing. Access mode, other provider options, account policy and role are
// preserved and are not part of the preview.
export const factorySteerSettingsPreview = defineRpc({
  name: "factory.steer.settings.preview",
  input: z.object({
    workspaceId: z.string().min(1),
    agentId: z.string().min(1),
    /** Requested model id; omitted keeps the current model. */
    model: z.string().min(1).optional(),
    /** Requested thinking option id; null resets to the provider default. */
    thinking: z.string().nullable().optional(),
    /** Requested speed id ("fast"/"standard"/tier); null resets to default. */
    speed: z.string().nullable().optional(),
  }),
  output: z.looseObject({
    workspaceId: z.string(),
    agentId: z.string(),
    slot: z.string().nullable(),
    epoch: z.number().nullable(),
    sessionId: z.string().nullable(),
    provider: z.string().nullable(),
    current: settingsTuple,
    requested: settingsTuple,
    models: z.array(z.string()),
    thinkingOptions: z.array(z.string()),
    speeds: z.array(z.string()),
    noop: z.boolean(),
    route: z.enum(["apply-here", "refresh"]),
    routeReason: z.string(),
    cacheRisk: z.boolean(),
    efficiencyLocked: z.boolean(),
    lockReason: z.string().nullable(),
    warnings: z.array(z.string()),
    fingerprint: z.string(),
  }),
});

// Applies a previewed settings change (step 4). "apply-here" writes the
// tuple in place (small cold contexts and no-ops only); "refresh" rewinds
// the tab on a bound route (no silent fallback to a new agent), then
// applies and verifies the settings, then delivers or stages the brief per
// the Initialize new steer setting. The server rechecks quota, pending
// permissions and busy state under the scope lock.
export const factorySteerSettings = defineRpc({
  name: "factory.steer.settings",
  input: z.object({
    workspaceId: z.string().min(1),
    agentId: z.string().min(1),
    fingerprint: z.string().min(1),
    route: z.enum(["apply-here", "refresh"]),
    /** Requested tuple (must match the preview fingerprint); omitted keeps current. */
    model: z.string().min(1).optional(),
    thinking: z.string().nullable().optional(),
    speed: z.string().nullable().optional(),
    /** "stage" applies without sending; the packet is staged for later delivery. */
    deliver: z.enum(["send", "stage"]).optional(),
  }),
  output: z.looseObject({
    workspaceId: z.string(),
    agentId: z.string(),
    applied: z.boolean(),
    route: z.string(),
    verified: z.boolean(),
    current: settingsTuple,
    noop: z.boolean().optional(),
    delivered: z.boolean().optional(),
    staged: z.boolean().optional(),
    stagedTo: z.string().nullable().optional(),
    stageId: z.string().optional(),
    epoch: z.number().int().nonnegative().nullable().optional(),
    packet: z.string().optional(),
    packetChars: z.number().optional(),
    deliveryError: z.unknown().optional(),
    detail: z.string(),
  }),
});

// Restores the turn-end baseline after an observed external change (step 4).
// Refuses when the tab is busy, when nothing is staged to revert, or when
// the live tuple no longer equals the observed change (a newer change
// needs review first). Verifies the restored tuple after the write.
export const factorySteerSettingsRevert = defineRpc({
  name: "factory.steer.settings.revert",
  input: z.object({
    workspaceId: z.string().min(1),
    agentId: z.string().min(1),
    observed: z.looseObject({
      provider: z.string().nullable().optional(),
      model: z.string().nullable().optional(),
      thinking: z.string().nullable().optional(),
      speed: z.string().nullable().optional(),
      sessionId: z.string().nullable().optional(),
    }),
  }),
  output: z.looseObject({
    agentId: z.string(),
    applied: z.boolean(),
    verified: z.boolean(),
    restored: settingsTuple,
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

// Effective worker and steer priorities (settings document)
// with catalog availability. `revision` is the settings revision the lists were
// read at; `selected` is the profile a worker would start with now.
export const factoryModelsList = defineRpc({
  name: "factory.models.list",
  input: z.object({}),
  output: z.looseObject({
    revision: z.string().nullable(),
    workers: z.array(modelRow.extend({ selected: z.boolean() })),
    steers: z.array(modelRow.extend({ slot: z.string(), fallback: z.string().nullable() })),
    steerPreferences: z.array(modelRow).optional(),
    advisorPreferences: z.array(modelRow).optional(),
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
    agentId: z.string().min(1).optional(),
    prune: z.boolean().optional(),
    apply: z.boolean().optional(),
  }),
  output: z.looseObject({
    scope: z.string(),
    epoch: z.number().nullable(),
    workers: z.unknown().optional(),
    text: z.string(),
  }),
});

// Resolved worker profile plus `paseo run` flags, like `worker pick`.
export const factoryWorkerPick = defineRpc({
  name: "factory.worker.pick",
  input: z.object({
    repo: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
    agentId: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    failed: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
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
    repoPublic: z.boolean().nullable().optional(),
    text: z.string(),
  }),
});

// Scope-aware worker priority list with availability, like `worker list`.
export const factoryWorkerList = defineRpc({
  name: "factory.worker.list",
  input: z.object({
    repo: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
    agentId: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
  }),
  output: z.looseObject({
    defaultProfile: z.string().nullable(),
    priority: z.array(z.string()),
    chosen: z.string().nullable(),
    repoPublic: z.boolean().nullable(),
    entries: z.array(z.unknown()),
    text: z.string(),
  }),
});

// Start (or preview) a worker as the active steer's subagent.
export const factoryWorkerStart = defineRpc({
  name: "factory.worker.start",
  input: z.object({
    repo: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
    agentId: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    callerId: z.string().min(1),
    task: z.string().min(1),
    title: z.string().min(1).optional(),
    apply: z.boolean().optional(),
  }),
  output: z.looseObject({
    scope: z.string(),
    workspaceId: z.string(),
    parentId: z.string(),
    profile: z.string(),
    provider: z.string(),
    accountId: z.string().nullable(),
    agentId: z.string().optional(),
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
  reportTo: z.string().min(1).optional(),
  callerId: z.string().min(1).optional(),
  expectEpoch: z.number().int().optional(),
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
  input: z.object({
    ...assignArgs,
    fingerprint: z.string().min(1),
    send: z.boolean().optional(),
  }),
  output: z.looseObject({
    scope: z.string(),
    epoch: z.number(),
    slot: z.string(),
    steerId: z.string(),
    applied: z.boolean(),
    delivered: z.boolean(),
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
    accounts: z.array(z.object({
      account: z.string(),
      label: z.string().optional(),
      family: z.string(),
      usedPct: z.number().nullable(),
      resetsAt: z.string().nullable(),
      state: z.enum(["ok", "warn", "exhausted", "unknown"]),
    })).optional(),
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

const resourceWindow = z.object({
  alias: z.string(),
  state: z.enum(["available", "unavailable", "stale"]),
  usedPct: z.number().nullable(),
  sampledAt: z.string().nullable(),
  resetsAt: z.string().nullable(),
});

const resourceQuota = z.object({
  provider: z.string(),
  providerLabel: z.string(),
  alias: z.string(),
  limited: z.boolean(),
  quotaConfirmation: quotaConfirmation.nullable().optional(),
  limitedUntil: z.string().nullable(),
  sampledAt: z.string().nullable(),
  quotaKind: z.enum(["api", "subscription", "reported", "unknown"]),
  windows: z.array(resourceWindow),
});

export const resourceWorkerExclusion = z.enum([
  "unknown-profile", "recent-failure", "accounts-exhausted", "pool-exhausted",
  "role-mismatch", "scope-requires-public", "profile-in-use", "catalog-rejected",
]);

export const resourceSteerRouting = z.object({
  queuedAt: z.string().nullable(),
  intent: z.enum(["automatic", "explicit"]),
  strategy: z.enum(["efficiency", "balanced", "preference"]),
  reason: z.enum([
    "only eligible route", "equal evidence; retained candidate order",
    "selected by uncachedInputTokens", "selected by preparationTurns",
    "selected by latencyMs", "selected by preferenceRank",
  ]).nullable(),
  kind: z.enum(["continue", "move", "handover", "renewal", "create"]),
  preparation: z.enum(["send", "clear", "rewind"]),
  confidence: z.enum(["observed", "estimated", "unknown"]),
  evidence: z.object({
    uncachedInputTokens: z.number().nonnegative().nullable(),
    preparationTurns: z.number().nonnegative().nullable(),
    latencyMs: z.number().nonnegative().nullable(),
    preferenceRank: z.number().nonnegative().nullable(),
  }),
  epoch: z.number().int().nonnegative().nullable(),
  accountAlias: z.string().nullable(),
});

/** Read-only Resources snapshot for an exact enrolled workspace. */
export const factoryWorkspaceResources = defineRpc({
  name: "factory.workspace.resources",
  input: z.strictObject({ workspaceId: z.string().min(1) }),
  output: z.object({
    workspaceId: z.string(),
    warnPct: z.number(),
    exhaustedPct: z.number(),
    quotaSampleMinutes: z.number(),
    pools: z.array(resourceQuota),
    accounts: z.array(resourceQuota),
    zeroSubState: z.enum(["available", "unavailable"]),
    workerSelection: z.object({
      scopeVisibility: z.enum(["public", "private", "unknown"]),
      accountEvidence: resourceWindow.pick({ state: true, usedPct: true }).extend({
        quotaKind: resourceQuota.shape.quotaKind,
      }).nullable(),
      candidates: z.array(z.object({
        profile: z.string(),
        provider: z.string().nullable(),
        providerLabel: z.string().nullable(),
        model: z.string().nullable(),
        modelLabel: z.string().nullable(),
        poolAlias: z.string().nullable(),
        decision: z.discriminatedUnion("state", [
          z.object({ state: z.literal("selected"), accountAlias: z.string().nullable() }),
          z.object({ state: z.literal("excluded"), reason: resourceWorkerExclusion }),
          z.object({ state: z.literal("unevaluated") }),
        ]),
      })),
    }),
    steerRouting: resourceSteerRouting.nullable(),
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
// ZeroSub quota evidence, the observed settings document and its revision,
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
    creationId: z.uuid(),
    values: z.unknown(),
  }),
});

// Revalidate the confirmed selection against live membership under the workspace lock.
export const factorySteerAdd = defineRpc({
  name: "factory.steer.add",
  input: z.object({ ...steerAddArgs, fingerprint: z.string().min(1), revision: z.string().optional(), creationId: z.uuid().optional() }),
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

const steerQuotaRow = z.looseObject({
  id: z.string(),
  scope: z.enum(["account", "model", "pool"]),
  usedPct: z.number().nullable(),
  resetsAt: z.string().nullable(),
  stale: z.boolean(),
});

// One steer tab's projected face state (shared/steer-state.ts), pushed
// host-wide for the persistent composer pill (design step 2 subscribes).
const settingsTupleRow = z.looseObject({
  provider: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  thinking: z.string().nullable().optional(),
  speed: z.string().nullable().optional(),
  sessionId: z.string().nullable().optional(),
});

const steerStateRow = z.looseObject({
  scopeId: z.string(),
  workspaceId: z.string(),
  agentId: z.string(),
  slot: z.string().nullable(),
  title: z.unknown().optional(),
  provider: z.unknown().optional(),
  model: z.unknown().optional(),
  accountAlias: z.string().optional(),
  handoverRoute: z.string().optional(),
  liveStatus: z.unknown().optional(),
  advisor: z.boolean().optional(),
  active: z.boolean().optional(),
  activationEpoch: z.number().int().nonnegative().nullable().optional(),
  /** A permission request is waiting on this tab ("Review request"). */
  permissionNeeded: z.boolean().optional(),
  /** A brief is staged for this tab (initialize it from the steer menu). */
  stagedBrief: z.boolean().optional(),
  /** Live effective thinking option id (step 4), null for the provider default. */
  thinking: z.string().nullable().optional(),
  /** Live normalized speed id (step 4), null when the route reports none. */
  speed: z.string().nullable().optional(),
  /** Live provider session id (step 4), null when unknown. */
  sessionId: z.string().nullable().optional(),
  /** Turn-end settings baseline from wsf.agents (step 4), null when none. */
  baseline: settingsTupleRow.nullable().optional(),
  /** Last Factory-confirmed settings tuple (step 4), null when none. */
  confirmed: settingsTupleRow.nullable().optional(),
  /** Maximum efficiency locks settings changes on this steer (step 4). */
  settingsLocked: z.boolean().optional(),
  /** Short reason when locked, null otherwise. */
  settingsLockReason: z.string().nullable().optional(),
  /** Live continuation or current slot holder for a superseded tab. */
  successor: z.string().nullable().optional(),
  state: z.enum([
    "running",
    "limited",
    "waiting",
    "needs-resume",
    "ready",
    "cold",
    "large",
    "cooling",
    "warm",
    "unknown",
  ]),
  warmth: z.string(),
  tokens: z.number().nullable(),
  large: z.boolean(),
  limited: z.boolean(),
  resetAt: z.string().nullable(),
  resetUnknown: z.boolean(),
  awaitingUpdate: z.boolean(),
  quotaRows: z.array(steerQuotaRow),
  headerFacts: z.array(z.string()),
  primaryAction: z.string(),
  detail: z.string(),
  nextBoundaryAt: z.string().nullable(),
});

export const factorySteers = defineSubscription({
  name: "factory.steers",
  input: z.object({}),
  event: z.looseObject({
    steers: z.array(steerStateRow),
    updatedAt: z.string(),
  }),
});
