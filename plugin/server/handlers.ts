import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  factoryApply,
  factoryCheckpoint,
  factoryCheckpointPreview,
  factoryCleanup,
  factoryFresh,
  factoryFreshPreview,
  factoryHistoryOpen,
  factoryPlan,
  factoryResume,
  factoryScopes,
  factoryScopesCandidates,
  factoryStatus,
  factorySwitch,
  factorySwitchPreview,
} from "../shared/factory.js";
import {
  checkpointFingerprint,
  freshFingerprint,
  isPlanHash,
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
import { collectCleanupCandidates } from "./factory/cleanup.js";
import { createRunner } from "./factory/factory.js";
import { createGh } from "./factory/github.js";
import { createGit } from "./factory/local.js";
import { planHash } from "./factory/planner.js";
import {
  LABEL,
  LEGACY_PREFIX,
  createPaseoCli,
  daemonPassword,
  lookupCreationReceipt,
  paseoBinary,
  readPaseoState,
} from "./factory/paseo.js";
import { daemonHost, runtime } from "./factory/runtime.js";
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
    throw new Error("Pass a scope address, or run where a workspace is focused");
  }
  const paseoState: any = await readPaseoState(paseo);
  const resolved: any = resolveTargetEntry(address, paseoState);
  if (!resolved.scope) {
    const wid = workspaceIdFromAddress(address);
    const ws = wid ? paseoState.workspaces.find((w: any) => w.id === wid) : null;
    if (wid && !ws) throw new Error(`Unknown workspace ${JSON.stringify(wid)}`);
    if (ws) {
      const title = ws.title ?? ws.name ?? ws.id;
      const suggestion =
        scopeCandidates(paseoState).find((c: any) => c.workspaceId === ws.id)?.suggestedPlan ??
        `paseo-factory plan workspace:${ws.id}`;
      throw new Error(`Workspace "${title}" has no factory scope. Adopt it first: ${suggestion}`);
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
    const scopeId = found?.labels?.[LABEL.scope] ?? found?.labels?.[`${LEGACY_PREFIX}.scope`];
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
      "The fresh preview is stale (steer state changed); run it again and confirm the new preview",
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
    agent.labels?.[LABEL.scope] ?? agent.labels?.[`${LEGACY_PREFIX}.scope`] ?? null;
  const scope: any = typeof scopeId === "string" && scopeId
    ? (listScopes(state) as any[]).find((s: any) => s.id === scopeId) ?? null
    : null;
  if (!scope) throw new Error(`Agent ${agentId} has no live factory scope`);
  const entries = scope.workspace?.metadata?.[AGENTS_KEY] ?? {};
  const sessions = entries[agentId]?.previousSessions;
  const sessionId = Array.isArray(sessions) && sessions.length ? sessions[sessions.length - 1] : null;
  if (typeof sessionId !== "string" || !sessionId || sessionId.startsWith("-")) {
    throw new Error(`Agent ${agentId} has no saved previous session to open`);
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
  const { discovery } = await discoverOne(paseo, loader, input.repo, input.workspaceId);
  const to = checkedSlot(input.to, "--to");
  const git = createGit();
  const dryOptions: any = { client: paseo, discovery, toSlot: to, apply: false, git };
  const dry: any = await switchSteer(dryOptions);
  const fresh = switchFingerprint({ repo: dry.repo, from: dry.from, to: dry.to, epoch: dry.epoch });
  if (fresh !== input.fingerprint) {
    throw new Error(
      "The switch preview is stale (steer state changed); run /factory switch again and confirm the new preview",
    );
  }
  const applyOptions: any = { client: paseo, discovery, toSlot: to, apply: true, send: true, git };
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
    throw new Error("No factory main workspace with steer state; run the factory first");
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
    throw new Error("No factory main workspace with steer state; run the factory first");
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
      "The checkpoint preview is stale (steer state or the agent answer changed); preview again and confirm",
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
    throw new Error("apply needs a 16-hex plan hash from a stored dry-run");
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
      throw new Error(`No stored plan for hash ${input.hash}; run /factory plan first`);
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
      runPlans: (list: any, options: any) => {
        const runnerOptions: any = { config, client: paseo, gh: createGh(), git: createGit() };
        return createRunner(runnerOptions).runPlans(list, options);
      },
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
