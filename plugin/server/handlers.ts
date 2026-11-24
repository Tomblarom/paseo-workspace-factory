import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  factoryApply,
  factoryAssign,
  factoryAssignPreview,
  factoryCheckpoint,
  factoryCheckpointPreview,
  factoryCleanup,
  factoryCleanupPlan,
  factoryDrain,
  factoryFresh,
  factoryFreshPreview,
  factoryHistoryOpen,
  factoryModelsCatalog,
  factoryPlan,
  factoryRelocate,
  factoryRelocatePreview,
  factoryResume,
  factoryResumeApply,
  factoryRetire,
  factoryScopes,
  factoryScopesCandidates,
  factoryStatus,
  factorySwitch,
  factorySwitchPreview,
  factoryWorkerPick,
  factoryWorkers,
} from "../shared/factory.js";
import {
  assignFingerprint,
  checkpointFingerprint,
  freshFingerprint,
  isPlanHash,
  relocateFingerprint,
  switchFingerprint,
} from "../shared/preview.js";
import {
  applyPlans,
  createAuthorization,
  createExecutors,
  fileProgress,
  storeAuthorization,
  withApplyLock,
} from "./factory/apply.js";
import { assignScope } from "./factory/assign.js";
import {
  attachProjectArchivedAgents,
  collectCleanupCandidates,
  formatLoss,
  planCleanupOps,
  selectApplyRunPlans,
} from "./factory/cleanup.js";
import { isAdvisorSlot, isSensitiveProfile, workerPriority } from "./factory/config.js";
import { DRAIN_DEFAULT_TIMEOUT_MS, drain, parseTimeout } from "./factory/drain.js";
import { createRunner } from "./factory/factory.js";
import { createGh } from "./factory/github.js";
import { createGit } from "./factory/local.js";
import { formatCatalog, paseoRunFlags, resolveProfile } from "./factory/models.js";
import { planHash } from "./factory/planner.js";
import { relocateScope } from "./factory/relocate.js";
import { formatWorkersText, readWorkers, workersReport } from "./factory/supervision.js";
import { assessWorker, readGitState } from "./factory/workers.js";
import {
  LABEL,
  LEGACY_PREFIX,
  METADATA_KEY,
  createPaseoCli,
  daemonPassword,
  lookupCreationReceipt,
  paseoBinary,
  readPaseoState,
} from "./factory/paseo.js";
import { daemonHost, runtime } from "./factory/runtime.js";
import { applyResume } from "./resume-apply.js";
import type { ResumeClearSettings } from "../shared/idle-cleanup.js";
import { listScopes } from "./factory/scope.js";
import { scopeCandidates, scopeRows } from "./factory/scopes-view.js";
import { AGENTS_KEY } from "./factory/agent-state.js";
import {
  buildResumeBrief,
  freshSteer,
  lastAssistantText,
  parseCheckpointBlock,
  readGitBrief,
  resolveTargetEntry,
  steerStatus,
  switchSteer,
  writeCheckpoint,
} from "./factory/steer.js";
import type { ConfigLoader } from "./config.js";
import { getQuotaSnapshot } from "./quota.js";

/** Slot to configured provider/model, so the panel can show profile drift. */
function expectedProfiles(config: any): Record<string, { profile: string; provider: string; model: string }> {
  const out: Record<string, { profile: string; provider: string; model: string }> = {};
  for (const [slot, name] of Object.entries<string>(config.steers?.slots ?? {})) {
    const profile = config.profiles?.[name] ?? {};
    out[slot] = { profile: name, provider: profile.provider ?? "?", model: profile.model ?? "?" };
  }
  return out;
}

function workspaceIdFromAddress(address: string): string | null {
  const prefixed = address.match(/^(?:workspace|worktree)\s*:\s*(.+)$/i);
  if (prefixed) return prefixed[1].trim() || null;
  if (/^wks_[A-Za-z0-9]+$/.test(address)) return address;
  return null;
}

/**
 * Resolves a scope address like the CLI (scope id, wks_ id, path, legacy
 * local/ alias), or the scope of the current workspace when no address is
 * given. A workspace without a scope gets a clear message plus the plan
 * call that would adopt it; anything else passes through to legacy discovery.
 */
async function resolveEntryForAddress(
  paseo: any,
  repo: string | undefined,
  workspaceId: string | undefined,
): Promise<{ target: any; scope: any; deprecatedAlias: boolean }> {
  const address = repo?.trim() || (workspaceId ? `workspace:${workspaceId}` : "");
  if (!address) {
    throw new Error(
      "Which project? Pass a scope address (owner/repo, scope id, wks_… or folder path), or run the command inside a workspace.",
    );
  }
  const paseoState: any = await readPaseoState(paseo);
  const resolved: any = resolveTargetEntry(address, paseoState);
  if (!resolved.scope) {
    const wid = workspaceIdFromAddress(address);
    const ws = wid ? paseoState.workspaces.find((w: any) => w.id === wid) : null;
    if (wid && !ws) throw new Error(
        `Unknown workspace ${JSON.stringify(wid)}. Check the id, or run /factory scopes to see the managed projects.`,
      );
    if (ws) {
      const title = ws.title ?? ws.name ?? ws.id;
      const suggestion =
        scopeCandidates(paseoState).find((c: any) => c.workspaceId === ws.id)?.suggestedPlan ??
        `paseo-factory plan workspace:${ws.id}`;
      throw new Error(
        `Workspace "${title}" is not managed by the factory yet. To set it up, preview a plan: ${suggestion}`,
      );
    }
  }
  return {
    target: resolved.entry,
    scope: resolved.scope ? { id: resolved.scope.id, kind: resolved.scope.kind } : null,
    deprecatedAlias: resolved.deprecatedAlias === true,
  };
}

export async function getStatus(
  input: RpcInput<typeof factoryStatus>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
): Promise<any> {
  const config = await loader.loadEffectiveConfig();
  const { target, scope, deprecatedAlias } = await resolveEntryForAddress(
    paseo,
    input.repo,
    input.workspaceId,
  );
  // The synced core is unchecked; pass its options as any.
  const runnerOptions: any = { config, client: paseo, gh: createGh(), git: createGit() };
  const runner = createRunner(runnerOptions);
  const [discovery] = await runner.discoverAll([target]);
  return {
    ...steerStatus(discovery),
    expectedProfiles: expectedProfiles(config),
    scope,
    deprecatedAlias,
  };
}

export async function getScopes(
  _input: RpcInput<typeof factoryScopes>,
  { paseo }: PluginHandlerContext,
): Promise<any> {
  return { rows: scopeRows(await readPaseoState(paseo)) };
}

export async function getScopeCandidates(
  _input: RpcInput<typeof factoryScopesCandidates>,
  { paseo }: PluginHandlerContext,
): Promise<any> {
  return { rows: scopeCandidates(await readPaseoState(paseo)) };
}

export async function getCleanup(
  _input: RpcInput<typeof factoryCleanup>,
  { paseo }: PluginHandlerContext,
): Promise<any> {
  const cleanupOptions: any = { git: createGit() };
  return { candidates: collectCleanupCandidates(await readPaseoState(paseo), cleanupOptions) };
}

export async function getResume(
  input: RpcInput<typeof factoryResume>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
): Promise<any> {
  // Scope resolution: explicit scope > agent label wsf.scope > caller workspace.
  const agentId = input.agentId?.trim() || null;
  let address = input.repo?.trim() || "";
  if (!address && agentId) {
    const found: any = (await readPaseoState(paseo)).agents.find((a: any) => a.id === agentId);
    const scopeId =
    found?.labels?.[LABEL.scope] ?? found?.labels?.[`${LEGACY_PREFIX}.scope`] ??
    found?.labels?.[LABEL.repo] ?? found?.labels?.[`${LEGACY_PREFIX}.repo`];
    if (typeof scopeId === "string" && scopeId) address = scopeId;
  }
  const config = await loader.loadEffectiveConfig();
  const { target, scope } = await resolveEntryForAddress(
    paseo,
    address || undefined,
    input.workspaceId,
  );
  const runnerOptions: any = { config, client: paseo, gh: createGh(), git: createGit() };
  const runner = createRunner(runnerOptions);
  const [discovery] = await runner.discoverAll([target]);
  const status: any = steerStatus(discovery);
  const git = createGit();
  const briefOptions: any = {
    agentId,
    agentState: discovery.mainWorkspace?.metadata?.[AGENTS_KEY] ?? null,
    git: status.workspace ? readGitBrief(git, status.workspace.directory) : null,
    scope: discovery.scope ?? scope ?? null,
    config,
    quotaSnapshot: getQuotaSnapshot(),
    quotaWarnPct: config.quota?.warnPct ?? 75,
  };
  const brief: string = buildResumeBrief(status, briefOptions);
  return {
    scope: scope?.id ?? status.repo,
    kind: scope?.kind ?? null,
    epoch: status.state?.epoch ?? null,
    agentId,
    brief,
  };
}

/**
 * Builds the resume brief for one steer (shared by the resume RPC and the
 * turn hook, which sends the brief after a verified resume clear). Scope
 * resolution mirrors getResume: the agent's scope label wins, else the
 * workspace address.
 */
export function createResumeBriefBuilder(loader: ConfigLoader) {
  return async (paseo: any, workspaceId: string, agentId: string): Promise<string> => {
    const found: any = (await readPaseoState(paseo)).agents.find((a: any) => a.id === agentId);
    const scopeId =
    found?.labels?.[LABEL.scope] ?? found?.labels?.[`${LEGACY_PREFIX}.scope`] ??
    found?.labels?.[LABEL.repo] ?? found?.labels?.[`${LEGACY_PREFIX}.repo`];
    const address =
      typeof scopeId === "string" && scopeId ? scopeId : `workspace:${workspaceId}`;
    const config = await loader.loadEffectiveConfig();
    const { target, scope } = await resolveEntryForAddress(paseo, address, workspaceId);
    const runnerOptions: any = { config, client: paseo, gh: createGh(), git: createGit() };
    const runner = createRunner(runnerOptions);
    const [discovery] = await runner.discoverAll([target]);
    const status: any = steerStatus(discovery);
    const git = createGit();
    const briefOptions: any = {
      agentId,
      agentState: discovery.mainWorkspace?.metadata?.[AGENTS_KEY] ?? null,
      git: status.workspace ? readGitBrief(git, status.workspace.directory) : null,
      scope: discovery.scope ?? scope ?? null,
    };
    return buildResumeBrief(status, briefOptions);
  };
}

export async function applyResumeRpc(
  input: RpcInput<typeof factoryResumeApply>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
  extra?: {
    getResumeSettings?: () => Promise<ResumeClearSettings | null>;
    buildBrief?: (paseo: any, workspaceId: string, agentId: string) => Promise<string>;
  },
): Promise<any> {
  const applied: any = await applyResume(
    paseo,
    {
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      ...(input.fingerprint ? { fingerprint: input.fingerprint } : {}),
    },
    {
      ...(extra?.getResumeSettings ? { getResumeSettings: extra.getResumeSettings } : {}),
      buildBrief: extra?.buildBrief ?? createResumeBriefBuilder(loader),
    },
  );
  // Resume AND takeover for a non-active steer: after the resume the steer
  // becomes the controlling one (self-takeover: no handoff to itself, no
  // wait). Advisors and already-active steers skip; a failed takeover never
  // undoes the resume, it is only reported.
  let tookOver: { from: string; to: string; epoch: number } | null = null;
  let takeoverSkipped: string | null = null;
  if (input.takeover === true) {
    try {
      const taken = await takeoverIfNonActive(paseo, loader, input.agentId);
      if (taken) tookOver = taken;
    } catch (error) {
      takeoverSkipped = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    ...applied,
    tookOver,
    takeoverSkipped,
    detail:
      `${applied.detail}` +
      (tookOver ? ` Steer ${tookOver.to} is now in charge (was ${tookOver.from}, round ${tookOver.epoch}).` : "") +
      (takeoverSkipped ? ` Takeover skipped: ${takeoverSkipped}` : ""),
  };
}

/**
 * Self-takeover after a resume: makes the steer the active one when it is
 * not. Returns null when it already is. Advisors refuse (they never
 * coordinate), as does any other switch refusal.
 */
async function takeoverIfNonActive(
  paseo: any,
  loader: ConfigLoader,
  agentId: string,
): Promise<{ from: string; to: string; epoch: number } | null> {
  const found: any = (await readPaseoState(paseo)).agents.find((a: any) => a.id === agentId);
  const scopeId =
    found?.labels?.[LABEL.scope] ?? found?.labels?.[`${LEGACY_PREFIX}.scope`] ??
    found?.labels?.[LABEL.repo] ?? found?.labels?.[`${LEGACY_PREFIX}.repo`];
  const slot = found?.labels?.[LABEL.slot] ?? found?.labels?.[`${LEGACY_PREFIX}.slot`];
  if (typeof scopeId !== "string" || !scopeId) throw new Error("agent has no factory scope label");
  if (typeof slot !== "string" || !/^[A-Z]$/.test(slot)) throw new Error("agent has no steer slot label");
  const config = await loader.loadEffectiveConfig();
  if ((isAdvisorSlot as unknown as (c: unknown, s: string) => boolean)(config, slot)) {
    throw new Error("advisor steers never coordinate");
  }
  const { target } = await resolveEntryForAddress(paseo, scopeId, undefined);
  const runnerOptions: any = { config, client: paseo, gh: createGh(), git: createGit() };
  const [discovery] = await createRunner(runnerOptions).discoverAll([target]);
  const status: any = steerStatus(discovery);
  if (status.state?.activeSteer === slot) return null;
  const switchOptions: any = {
    client: paseo,
    discovery,
    toSlot: slot,
    apply: true,
    send: false,
    git: createGit(),
    config,
    callerId: agentId,
    paseoCli: createPaseoCli(),
  };
  const switched: any = await switchSteer(switchOptions);
  return { from: switched.from, to: switched.to, epoch: switched.epoch };
}

export async function previewFresh(
  input: RpcInput<typeof factoryFreshPreview>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
): Promise<any> {
  const { config, discovery, scope, deprecatedAlias } = await discoverOne(
    paseo,
    loader,
    input.repo,
    input.workspaceId,
  );
  const freshOptions: any = { client: paseo, discovery, config, apply: false, git: createGit() };
  const dry: any = await freshSteer(freshOptions);
  return {
    repo: dry.repo,
    slot: dry.slot,
    from: dry.from,
    epoch: dry.epoch,
    profile: dry.profile,
    provider: dry.provider,
    model: dry.model,
    packet: dry.packet,
    packetChars: dry.packetChars,
    checkpoint: dry.checkpoint,
    fingerprint: freshFingerprint({ repo: dry.repo, slot: dry.slot, epoch: dry.epoch }),
    scope,
    deprecatedAlias,
  };
}

export async function applyFresh(
  input: RpcInput<typeof factoryFresh>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
): Promise<any> {
  const { config, discovery } = await discoverOne(paseo, loader, input.repo, input.workspaceId);
  const git = createGit();
  const dryOptions: any = { client: paseo, discovery, config, apply: false, git };
  const dry: any = await freshSteer(dryOptions);
  const fresh = freshFingerprint({ repo: dry.repo, slot: dry.slot, epoch: dry.epoch });
  if (fresh !== input.fingerprint) {
    throw new Error(
      "Something changed since the fresh preview (for example another switch). Open the preview again and confirm the new one.",
    );
  }
  const executeOptions: any = {
    client: paseo,
    gh: createGh(),
    git,
    paseoCli: createPaseoCli(),
  };
  const applyOptions: any = {
    client: paseo,
    discovery,
    config,
    apply: true,
    git,
    lookupReceipt: lookupCreationReceipt,
    execute: createExecutors(executeOptions),
    paseoCli: createPaseoCli(),
  };
  const applied: any = await freshSteer(applyOptions);
  return applied;
}

export async function openHistory(
  input: RpcInput<typeof factoryHistoryOpen>,
  { paseo }: PluginHandlerContext,
): Promise<any> {
  const agentId = input.agentId.trim();
  const state: any = await readPaseoState(paseo);
  const agent: any = state.agents.find((a: any) => a.id === agentId);
  if (!agent) throw new Error(`Unknown agent ${JSON.stringify(agentId)}`);
  const scopeId =
    agent.labels?.[LABEL.scope] ?? agent.labels?.[`${LEGACY_PREFIX}.scope`] ??
    agent.labels?.[LABEL.repo] ?? agent.labels?.[`${LEGACY_PREFIX}.repo`] ?? null;
  const scope: any = typeof scopeId === "string" && scopeId
    ? (listScopes(state) as any[]).find((s: any) => s.id === scopeId) ?? null
    : null;
  if (!scope) throw new Error(`Agent ${agentId} has no live factory scope`);
  const entries = scope.workspace?.metadata?.[AGENTS_KEY] ?? {};
  const sessions = entries[agentId]?.previousSessions;
  const sessionId = Array.isArray(sessions) && sessions.length ? sessions[sessions.length - 1] : null;
  if (typeof sessionId !== "string" || !sessionId || sessionId.startsWith("-")) {
    throw new Error(`Agent ${agentId} has no saved earlier chat to open (nothing was cleared yet).`);
  }
  const provider = typeof agent.provider === "string" && agent.provider ? agent.provider : "claude";
  // CLI import on click only (manual, additive: a new tab). Env mirrors the
  // factory CLI wrapper: no sender identity is inherited.
  const env = { ...process.env };
  delete env.PASEO_AGENT_ID;
  const password = daemonPassword();
  if (password) env.PASEO_PASSWORD = password;
  let output: string;
  try {
    output = execFileSync(
      paseoBinary(),
      ["--host", daemonHost(), "agent", "import", sessionId, "--provider", provider],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env, timeout: 120_000 },
    );
  } catch (error) {
    const detail = error instanceof Error
      ? String((error as any).stderr ?? error.message).trim()
      : String(error);
    throw new Error(`paseo agent import failed: ${detail}`);
  }
  return { agentId, sessionId, imported: true, detail: output.trim().slice(0, 500) };
}

function checkedSlots(raw: string[] | undefined, config: any): string[] | undefined {
  if (raw === undefined) return undefined;
  const slots = raw.map((s) => String(s).trim().toUpperCase()).filter(Boolean);
  for (const slot of slots) {
    if (!/^[A-Z]$/.test(slot)) throw new Error(`slots expects slot letters A-Z, got ${JSON.stringify(slot)}`);
  }
  if (new Set(slots).size !== slots.length) throw new Error("slots contains duplicates");
  for (const slot of slots) {
    if (!config.steers.slots[slot]) throw new Error(`slots names slot ${slot}, which is not defined in steers.slots`);
  }
  return slots.length ? slots : undefined;
}

export async function getPlan(
  input: RpcInput<typeof factoryPlan>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
): Promise<any> {
  const config = await loader.loadEffectiveConfig();
  const slots = checkedSlots(input.slots, config);
  const adopt = input.adopt && Object.keys(input.adopt).length ? { "*": input.adopt } : {};
  for (const slot of Object.keys(input.adopt ?? {})) {
    if (!/^[A-Z]$/.test(slot.toUpperCase())) throw new Error(`adopt names slot ${JSON.stringify(slot)}, want A-Z`);
  }
  const repos = input.repos ?? [];
  // No address: plan the scope of the current workspace.
  const entries: any[] = repos.length
    ? repos
    : [(await resolveEntryForAddress(paseo, undefined, input.workspaceId)).target];
  const allowFork = input.allowFork ?? false;
  const runnerOptions: any = { config, client: paseo, gh: createGh(), git: createGit() };
  const runner = createRunner(runnerOptions);
  const planOptions: any = { allowFork, adopt, ...(slots ? { slots } : {}) };
  const plans = await runner.runPlans(entries, planOptions);
  const hash = planHash(plans, config);
  if (plans.some((p: any) => p.ops.length)) {
    const authOptions: any = {
      entries,
      allowFork,
      adopt,
      ...(slots ? { slots } : {}),
    };
    storeAuthorization(runtime().planDir, createAuthorization(plans, config, authOptions), config);
  }
  return { hash, plans };
}

function checkedSlot(raw: string, what: string): string {
  const slot = String(raw).trim().toUpperCase();
  if (!/^[A-Z]$/.test(slot)) throw new Error(`${what} expects a single slot letter A-Z`);
  return slot;
}

async function discoverOne(
  paseo: any,
  loader: ConfigLoader,
  repo: string | undefined,
  workspaceId?: string,
): Promise<any> {
  const config = await loader.loadEffectiveConfig();
  const { target, scope, deprecatedAlias } = await resolveEntryForAddress(paseo, repo, workspaceId);
  const runnerOptions: any = { config, client: paseo, gh: createGh(), git: createGit() };
  const runner = createRunner(runnerOptions);
  const [discovery] = await runner.discoverAll([target]);
  return { config, runner, discovery, scope, deprecatedAlias };
}

export async function previewSwitch(
  input: RpcInput<typeof factorySwitchPreview>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
): Promise<any> {
  const { discovery, scope, deprecatedAlias } = await discoverOne(paseo, loader, input.repo, input.workspaceId);
  const to = checkedSlot(input.to, "--to");
  const switchOptions: any = {
    client: paseo,
    discovery,
    toSlot: to,
    apply: false,
    git: createGit(),
  };
  const dry: any = await switchSteer(switchOptions);
  return {
    repo: dry.repo,
    from: dry.from,
    to: dry.to,
    epoch: dry.epoch,
    packet: dry.packet,
    packetChars: dry.packetChars,
    checkpoint: dry.checkpoint,
    fingerprint: switchFingerprint({ repo: dry.repo, from: dry.from, to: dry.to, epoch: dry.epoch }),
    scope,
    deprecatedAlias,
  };
}

export async function applySwitch(
  input: RpcInput<typeof factorySwitch>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
): Promise<any> {
  const { config, discovery } = await discoverOne(paseo, loader, input.repo, input.workspaceId);
  const to = checkedSlot(input.to, "--to");
  const git = createGit();
  const dryOptions: any = { client: paseo, discovery, toSlot: to, apply: false, git };
  const dry: any = await switchSteer(dryOptions);
  const fresh = switchFingerprint({ repo: dry.repo, from: dry.from, to: dry.to, epoch: dry.epoch });
  if (fresh !== input.fingerprint) {
    throw new Error(
      "Something changed since the switch preview (for example another switch or checkpoint). Run /factory switch again and confirm the new preview.",
    );
  }
  const applyOptions: any = { client: paseo, discovery, config, toSlot: to, apply: true, send: true, git, paseoCli: createPaseoCli() };
  const applied: any = await switchSteer(applyOptions);
  return applied;
}

interface CheckpointArgs {
  task?: string;
  fromAgent?: string;
  tests?: string[];
  blockers?: string[];
  next?: string;
}

async function resolveCheckpointFields(
  paseo: any,
  status: any,
  discovery: any,
  input: CheckpointArgs,
): Promise<{ task: string; tests: string[]; blockers: string[]; next: string | null }> {
  const hasTask = typeof input.task === "string" && input.task.trim() !== "";
  const hasAgent = typeof input.fromAgent === "string" && input.fromAgent.trim() !== "";
  if ((hasTask ? 1 : 0) + (hasAgent ? 1 : 0) !== 1) {
    throw new Error("checkpoint needs either a task or --from-agent, not both");
  }
  if (hasAgent) {
    const ref = (input.fromAgent as string).trim();
    const steer = status.steers.find((s: any) => s.id === ref || s.id.startsWith(ref));
    if (!steer) throw new Error(`${ref} is not a steer of ${discovery.forkName}`);
    const text = lastAssistantText(
      await paseo.agents.ref(steer.id).timeline.refetch({ direction: "tail", limit: 20 }),
    );
    const fields: any = parseCheckpointBlock(text);
    if (!fields) {
      throw new Error(`The last answer of Steer ${steer.slot} has no CHECKPOINT block with a task line`);
    }
    return {
      task: fields.task,
      tests: fields.tests ?? [],
      blockers: fields.blockers ?? [],
      next: input.next?.trim() ? (input.next as string).trim() : (fields.next ?? null),
    };
  }
  return {
    task: (input.task as string).trim(),
    tests: input.tests ?? [],
    blockers: input.blockers ?? [],
    next: input.next?.trim() ? (input.next as string).trim() : null,
  };
}

export async function previewCheckpoint(
  input: RpcInput<typeof factoryCheckpointPreview>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
): Promise<any> {
  const { discovery, scope, deprecatedAlias } = await discoverOne(paseo, loader, input.repo, input.workspaceId);
  const status: any = steerStatus(discovery);
  if (!status.workspace || !status.state) {
    throw new Error(
      "This project is not set up by the factory yet (no main workspace with steers). Run /factory plan, then /factory apply <hash>.",
    );
  }
  const fields = await resolveCheckpointFields(paseo, status, discovery, input);
  const epoch = status.state.epoch ?? null;
  return {
    repo: status.repo,
    workspaceId: status.workspace.id,
    epoch,
    fields,
    scope,
    deprecatedAlias,
    fingerprint: checkpointFingerprint({
      repo: status.repo,
      workspaceId: status.workspace.id,
      epoch,
      task: fields.task,
      tests: fields.tests,
      blockers: fields.blockers,
      next: fields.next,
    }),
  };
}

export async function writeCheckpointRpc(
  input: RpcInput<typeof factoryCheckpoint>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
): Promise<any> {
  const { discovery } = await discoverOne(paseo, loader, input.repo, input.workspaceId);
  const status: any = steerStatus(discovery);
  if (!status.workspace || !status.state) {
    throw new Error(
      "This project is not set up by the factory yet (no main workspace with steers). Run /factory plan, then /factory apply <hash>.",
    );
  }
  const fields = await resolveCheckpointFields(paseo, status, discovery, input);
  const epoch = status.state.epoch ?? null;
  const fresh = checkpointFingerprint({
    repo: status.repo,
    workspaceId: status.workspace.id,
    epoch,
    task: fields.task,
    tests: fields.tests,
    blockers: fields.blockers,
    next: fields.next,
  });
  if (fresh !== input.fingerprint) {
    throw new Error(
      "Something changed since the checkpoint preview (steer state or the agent's answer). Run /factory checkpoint again and confirm the new preview.",
    );
  }
  const writeOptions: any = { client: paseo, discovery, ...fields };
  const checkpoint = await writeCheckpoint(writeOptions);
  return { checkpoint };
}

export async function applyPlan(
  input: RpcInput<typeof factoryApply>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
): Promise<any> {
  if (!isPlanHash(input.hash)) {
    throw new Error("apply needs the 16-character plan hash shown at the end of /factory plan");
  }
  const config = await loader.loadEffectiveConfig();
  const planDir = runtime().planDir;
  const journalDir = runtime().journalDir;
  const lockOptions: any = undefined;
  const result: any = await withApplyLock(async (held: any) => {
    let authorization: any;
    try {
      authorization = JSON.parse(readFileSync(join(planDir, `${input.hash}.json`), "utf8"));
    } catch {
      throw new Error(
        `No saved plan with hash ${input.hash}. Run /factory plan, check the preview, then apply the hash it shows.`,
      );
    }
    mkdirSync(journalDir, { recursive: true, mode: 0o700 });
    const journalFile = join(journalDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
    const executeOptions: any = {
      client: paseo,
      gh: createGh(),
      git: createGit(),
      paseoCli: createPaseoCli(),
    };
    const applyOptions: any = {
      authorization,
      config,
      confirm: input.hash,
      lookupReceipt: lookupCreationReceipt,
      progress: fileProgress(join(planDir, `${input.hash}.progress.json`)),
      guard: () => held.verify(),
      // Cleanup authorizations re-plan from the stored filter, like the CLI.
      runPlans: (selectApplyRunPlans as any)(authorization, {
        repoRunPlans: (list: any, options: any) => {
          const runnerOptions: any = { config, client: paseo, gh: createGh(), git: createGit() };
          return createRunner(runnerOptions).runPlans(list, options);
        },
        client: paseo,
        git: createGit(),
      }),
      execute: createExecutors(executeOptions),
      journal: (event: any) => {
        held.verify();
        appendFileSync(journalFile, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, {
          mode: 0o600,
        });
      },
    };
    const outcome: any = await applyPlans(applyOptions);
    held.verify();
    return { ...outcome, journal: journalFile };
  }, lockOptions);
  return result;
}

export async function getModelsCatalog(
  _input: RpcInput<typeof factoryModelsCatalog>,
  { paseo }: PluginHandlerContext,
): Promise<any> {
  const entries = ((await paseo.providers.snapshot()) as any)?.entries ?? [];
  return { text: (formatCatalog as any)(entries) };
}

export async function getWorkers(
  input: RpcInput<typeof factoryWorkers>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
): Promise<any> {
  const { discovery } = await discoverOne(paseo, loader, input.repo, input.workspaceId);
  const status: any = steerStatus(discovery);
  const scopeId = discovery.scope?.id ?? status.repo;
  const epoch = discovery.mainWorkspace?.metadata?.[METADATA_KEY]?.epoch ?? null;
  const report = (workersReport as any)((readWorkers as any)(discovery.mainWorkspace?.metadata ?? null));
  return {
    scope: scopeId,
    epoch,
    workers: report,
    text: (formatWorkersText as any)(scopeId, epoch, report),
  };
}

export async function getRetire(
  input: RpcInput<typeof factoryRetire>,
  { paseo }: PluginHandlerContext,
): Promise<any> {
  const agentId = input.agentId.trim();
  const state: any = await readPaseoState(paseo);
  const worker = state.agents.find((a: any) => a.id === agentId);
  const ws = state.workspaces.find((w: any) => w.id === worker?.workspaceId);
  const backgroundWork = worker
    ? await paseo.agents.ref(worker.id).backgroundWork.list().catch(() => null)
    : null;
  const terminals = ws
    ? await paseo.terminals.list({ workspaceId: ws.id }).then((r: any) => r.entries ?? []).catch(() => null)
    : null;
  const gitState = ws ? (readGitState as any)(createGit(), ws.workspaceDirectory) : null;
  const assessment: any = (assessWorker as any)(worker, { ...state, gitState, backgroundWork, terminals });
  const lines = [
    `Retire preview for ${agentId} (preview only; archiving is disabled).`,
    assessment.archiveAgent
      ? "Agent: archivable."
      : `Agent: blocked (${(assessment.reasons ?? []).join("; ") || "unknown reason"}).`,
    assessment.archiveWorkspace
      ? "Workspace: archivable."
      : `Workspace: kept (${(assessment.workspaceReasons ?? []).join("; ") || "unknown reason"}).`,
  ];
  return { agentId, assessment, text: lines.join("\n") };
}

export async function pickWorker(
  input: RpcInput<typeof factoryWorkerPick>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
): Promise<any> {
  const config = await loader.loadEffectiveConfig();
  let entries: any[];
  let repoPublic: boolean | null = null;
  if (input.repo || input.workspaceId) {
    const { discovery } = await discoverOne(paseo, loader, input.repo, input.workspaceId);
    entries = discovery.providers ?? [];
    const priv = discovery.github?.fork?.repo?.private;
    repoPublic = priv === false ? true : priv === true ? false : null;
  } else {
    entries = ((await paseo.providers.snapshot()) as any)?.entries ?? [];
  }
  const { profile, skipped } = (resolveProfile as any)(config, entries, (workerPriority as any)(config), {
    role: "worker",
    repoPublic,
  });
  if (!profile) {
    const tried = skipped.length
      ? skipped.map((s: any) => `"${s.name}" (${s.reason})`).join("; ")
      : "no worker profiles configured";
    throw new Error(`No startable worker profile (tried ${tried})`);
  }
  const sensitive = (isSensitiveProfile as any)(config, profile.name);
  const text = [
    `Worker pick: "${profile.name}" (${profile.provider}/${profile.model})${sensitive ? " [sensitive: give only sanitized technical tasks]" : ""}`,
    `paseo run ${(paseoRunFlags as any)(profile)}`,
    ...skipped.map((s: any) => `skipped "${s.name}": ${s.reason}`),
  ].join("\n");
  return {
    profile: profile.name,
    provider: profile.provider,
    model: profile.model,
    thinking: profile.thinking ?? null,
    mode: profile.mode ?? null,
    sensitive,
    flags: (paseoRunFlags as any)(profile),
    skipped,
    text,
  };
}

export async function runDrain(
  input: RpcInput<typeof factoryDrain>,
  { paseo }: PluginHandlerContext,
): Promise<any> {
  const timeoutMs = input.timeout === undefined ? (DRAIN_DEFAULT_TIMEOUT_MS as number) : (parseTimeout as any)(input.timeout);
  const result: any = await (drain as any)({ client: paseo, timeoutMs, git: createGit() });
  return { ...result, text: formatDrainText(result) };
}

function formatDrainText(result: any): string {
  const waited = `${Math.round((result.waitedMs ?? 0) / 1000)}s`;
  const timeout = `${Math.round((result.timeoutMs ?? 0) / 1000)}s`;
  const initial = result.initial ?? [];
  if (result.clean && !initial.length) return "Drain: no running factory agents — safe to restart.";
  if (result.clean) return `Drain: ${initial.length} factory agent(s) idle after ${waited} — safe to restart.`;
  const markedIds = new Set((result.marked ?? []).map((m: any) => m.agentId));
  const lines = [
    `Drain: timeout after ${waited} (limit ${timeout}), ${result.running.length} still running — marked planned-restart:`,
  ];
  for (const a of result.running) {
    const what = a.role === "steer" && a.slot ? `steer ${a.slot}` : a.role;
    lines.push(
      `  - ${a.id} ${what} in ${a.scopeId} ${a.status}${markedIds.has(a.id) ? " — marked planned-restart" : " — NOT marked (scope gone)"}`,
    );
  }
  lines.push("Restart would interrupt them; run status/resume for the last answer tails.");
  return lines.join("\n");
}

export async function previewAssign(
  input: RpcInput<typeof factoryAssignPreview>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
): Promise<any> {
  const { discovery, scope } = await discoverOne(paseo, loader, input.repo, input.workspaceId);
  void scope;
  const dry: any = await (assignScope as any)({
    client: paseo,
    discovery,
    task: input.task,
    tests: input.tests ?? [],
    blockers: input.blockers ?? [],
    next: input.next ?? null,
    apply: false,
  });
  return {
    scope: dry.scope,
    epoch: dry.epoch,
    slot: dry.slot,
    steerId: dry.steerId,
    previous: dry.previous,
    packet: dry.packet,
    packetChars: dry.packetChars,
    fingerprint: assignFingerprint({
      scope: dry.scope,
      epoch: dry.epoch,
      task: dry.fields.task,
      tests: dry.fields.tests,
      blockers: dry.fields.blockers,
      next: dry.fields.next,
    }),
  };
}

export async function applyAssign(
  input: RpcInput<typeof factoryAssign>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
): Promise<any> {
  const { discovery } = await discoverOne(paseo, loader, input.repo, input.workspaceId);
  const dry: any = await (assignScope as any)({
    client: paseo,
    discovery,
    task: input.task,
    tests: input.tests ?? [],
    blockers: input.blockers ?? [],
    next: input.next ?? null,
    apply: false,
  });
  const fresh = assignFingerprint({
    scope: dry.scope,
    epoch: dry.epoch,
    task: dry.fields.task,
    tests: dry.fields.tests,
    blockers: dry.fields.blockers,
    next: dry.fields.next,
  });
  if (fresh !== input.fingerprint) {
    throw new Error(
      "Something changed since the assign preview (for example a switch). Run /factory assign again and confirm the new preview.",
    );
  }
  const applied: any = await (assignScope as any)({
    client: paseo,
    discovery,
    task: input.task,
    tests: input.tests ?? [],
    blockers: input.blockers ?? [],
    next: input.next ?? null,
    apply: true,
    send: true,
    expectEpoch: dry.epoch,
    assignedBy: null,
  });
  return applied;
}

export async function previewRelocate(
  input: RpcInput<typeof factoryRelocatePreview>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
): Promise<any> {
  const { config, discovery, scope } = await discoverOne(paseo, loader, input.repo, input.workspaceId);
  void scope;
  const dry: any = await (relocateScope as any)({
    client: paseo,
    discovery,
    config,
    to: input.to,
    apply: false,
    git: createGit(),
  });
  return {
    scope: dry.scope,
    fromWorkspace: dry.fromWorkspace,
    toDir: dry.toDir,
    toWorkspace: dry.toWorkspace,
    adoptedWorkspace: dry.adoptedWorkspace,
    movedTo: dry.movedTo,
    checkpoint: dry.checkpoint,
    notes: dry.notes,
    steers: dry.steers,
    packets: dry.packets,
    fingerprint: relocateFingerprint({
      scope: dry.scope,
      fromWorkspace: dry.fromWorkspace,
      toDir: dry.toDir,
      steers: dry.steers.map((s: any) => `${s.slot}:${s.profile}`),
      checkpoint: dry.checkpoint,
    }),
  };
}

export async function applyRelocate(
  input: RpcInput<typeof factoryRelocate>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
): Promise<any> {
  const { config, discovery } = await discoverOne(paseo, loader, input.repo, input.workspaceId);
  const git = createGit();
  const dry: any = await (relocateScope as any)({
    client: paseo,
    discovery,
    config,
    to: input.to,
    apply: false,
    git,
  });
  const fresh = relocateFingerprint({
    scope: dry.scope,
    fromWorkspace: dry.fromWorkspace,
    toDir: dry.toDir,
    steers: dry.steers.map((s: any) => `${s.slot}:${s.profile}`),
    checkpoint: dry.checkpoint,
  });
  if (fresh !== input.fingerprint) {
    throw new Error(
      "Something changed since the relocate preview (for example another relocate). Run /factory relocate again and confirm the new preview.",
    );
  }
  const executeOptions: any = { client: paseo, gh: createGh(), git, paseoCli: createPaseoCli() };
  const applied: any = await (relocateScope as any)({
    client: paseo,
    discovery,
    config,
    to: input.to,
    apply: true,
    git,
    lookupReceipt: lookupCreationReceipt,
    execute: createExecutors(executeOptions),
  });
  return applied;
}

export async function planCleanup(
  input: RpcInput<typeof factoryCleanupPlan>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
): Promise<any> {
  const config = await loader.loadEffectiveConfig();
  const only = input.only?.length ? [...input.only] : null;
  const paseoState: any = await (attachProjectArchivedAgents as any)(await readPaseoState(paseo), paseo);
  const { ops, hints } = (planCleanupOps as any)(paseoState, {
    allowDestructive: input.allowDestructive ?? false,
    allowIgnored: input.allowIgnored ?? false,
    only,
    git: createGit(),
  });
  const plans = [
    {
      repo: "cleanup",
      input: "cleanup",
      status: ops.length ? "pending" : "complete",
      ops,
      conflicts: [],
      notes: [
        ...hints.map((h: any) => `hint ${h.id}: ${h.reason}`),
        ...ops
          .filter((op: any) => op.kind !== "scope.retire" && op.loss)
          .map((op: any) => `DESTRUCTIVE ${op.key}: loss ${(formatLoss as any)(op.loss)}`),
      ],
      observed: {},
    },
  ];
  const hash = planHash(plans, config);
  if (ops.length) {
    const stored = storeAuthorization(
      runtime().planDir,
      { ...(createAuthorization as any)(plans, config, { entries: [{ cleanup: { allowDestructive: input.allowDestructive ?? false, allowIgnored: input.allowIgnored ?? false, only } }] }), kind: "cleanup" },
      config,
    );
    void stored;
  }
  return { hash, plans, hints };
}
