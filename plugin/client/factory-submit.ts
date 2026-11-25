import { settingsRpc } from "@getpaseo/plugin";
import type { PluginAgentCommandContext } from "@getpaseo/plugin/client";
import {
  factoryApply,
  factoryAssignPreview,
  factoryCheckpointPreview,
  factoryCleanup,
  factoryDrain,
  factoryFreshPreview,
  factoryModelsCatalog,
  factoryModelsList,
  factoryModelsSet,
  factoryPlan,
  factoryQuota,
  factoryResume,
  factoryResumeApply,
  factoryScopes,
  factoryScopesCandidates,
  factoryStatus,
  factorySteerAddPreview,
  factorySwitchPreview,
  factoryWorkerPick,
  factoryWorkers,
} from "../shared/factory.js";
import { factoryHelp, parseFactoryArgs } from "../shared/factory-args.js";
import { formatModelChange, formatModelList } from "../shared/models-format.js";
import { setFactoryResult } from "./factory-store.js";

interface SubmitContext {
  rpc: PluginAgentCommandContext["rpc"];
  workspaceId: string;
  agentId?: string;
}

const CURRENT_WORKSPACE = "(current workspace)";

/**
 * Where one /factory invocation surfaces: the Factory panel (empty args and
 * previews with a confirm button), a transient composer pill (read results),
 * or neither (resume applies; the brief arrives in the timeline).
 */
export interface FactorySubmitOutcome {
  openPanel: boolean;
  /** Short summary after "Factory: ", shown on the transient pill. */
  pill: string | null;
}

const PANEL: FactorySubmitOutcome = { openPanel: true, pill: null };

function pill(summary: string): FactorySubmitOutcome {
  return { openPanel: false, pill: summary };
}

/**
 * Runs one /factory invocation: parse, call the matching RPC, publish the
 * result. The scope address is optional everywhere; without one the server
 * resolves the scope of the current workspace. Writes stay two-stage: apply
 * quotes the stored plan hash, while checkpoint, switch and a foreign resume
 * only preview here and apply from the panel button. Errors propagate to the
 * caller, which shows them as an error toast.
 */
export async function submitFactoryCommand(
  args: string,
  ctx: SubmitContext,
): Promise<FactorySubmitOutcome> {
  const parsed = parseFactoryArgs(args);
  const at = new Date().toISOString();
  if (parsed.command === "help") {
    setFactoryResult({ kind: "info", at, text: factoryHelp(parsed.topic) });
    // Bare /factory keeps the panel as its home; a help topic is a quick read.
    return args.trim() === "" ? PANEL : pill("Help");
  }
  if (parsed.command === "worker" || parsed.command === "steer" || parsed.command === "model") {
    return submitModels(parsed, ctx, at);
  }
  if (parsed.command === "steerAdd") {
    const inputs = {
      ...(parsed.slot !== undefined ? { slot: parsed.slot } : {}),
      ...(parsed.spec !== undefined ? { spec: parsed.spec } : {}),
      ...(parsed.thinking !== undefined ? { thinking: parsed.thinking } : {}),
      ...(parsed.mode !== undefined ? { mode: parsed.mode } : {}),
      ...(parsed.profile !== undefined ? { profile: parsed.profile } : {}),
    };
    const preview = await ctx.rpc(factorySteerAddPreview, {
      workspaceId: ctx.workspaceId,
      ...inputs,
    });
    if (parsed.dryRun) {
      setFactoryResult({ kind: "info", at, text: preview.text });
      return pill("Steer add");
    }
    // The preview stays on screen until the panel button confirms it; the
    // confirm saves the slot/profile settings first, then creates the steer.
    setFactoryResult({
      kind: "steerAddPreview",
      workspaceId: ctx.workspaceId,
      at,
      inputs,
      preview,
    });
    return PANEL;
  }
  if (parsed.command === "status") {
    const status = await ctx.rpc(
      factoryStatus,
      parsed.repo ? { repo: parsed.repo } : { workspaceId: ctx.workspaceId },
    );
    setFactoryResult({ kind: "status", repo: parsed.repo ?? CURRENT_WORKSPACE, at, status });
    return pill(`Status ${parsed.repo ?? CURRENT_WORKSPACE}`);
  }
  if (parsed.command === "scopes") {
    if (parsed.candidates) {
      const candidates = await ctx.rpc(factoryScopesCandidates, {});
      setFactoryResult({ kind: "scopeCandidates", at, candidates });
      return pill("Candidates");
    }
    const scopes = await ctx.rpc(factoryScopes, {});
    setFactoryResult({ kind: "scopes", at, scopes });
    return pill("Projects");
  }
  if (parsed.command === "cleanup") {
    const cleanup = await ctx.rpc(factoryCleanup, {});
    setFactoryResult({ kind: "cleanup", at, cleanup });
    return pill("Cleanup");
  }
  if (parsed.command === "workers") {
    const workers = await ctx.rpc(
      factoryWorkers,
      parsed.repo ? { repo: parsed.repo } : { workspaceId: ctx.workspaceId },
    );
    setFactoryResult({ kind: "info", at, text: workers.text });
    return pill("Workers");
  }
  if (parsed.command === "models") {
    const catalog = await ctx.rpc(factoryModelsCatalog, {});
    setFactoryResult({ kind: "info", at, text: catalog.text });
    return pill("Models");
  }
  if (parsed.command === "drain") {
    const drain = await ctx.rpc(
      factoryDrain,
      parsed.timeout === undefined ? {} : { timeout: parsed.timeout },
    );
    setFactoryResult({ kind: "info", at, text: drain.text });
    return PANEL;
  }
  if (parsed.command === "quota") {
    const quota = await ctx.rpc(factoryQuota, {});
    setFactoryResult({ kind: "quota", at, quota });
    return pill("Quota");
  }
  if (parsed.command === "fresh") {
    const address = parsed.repo ? { repo: parsed.repo } : { workspaceId: ctx.workspaceId };
    const preview = await ctx.rpc(factoryFreshPreview, { ...address, ...(parsed.slot ? { slot: parsed.slot } : {}) });
    setFactoryResult({
      kind: "freshPreview",
      repo: parsed.repo,
      workspaceId: ctx.workspaceId,
      at,
      preview,
    });
    return PANEL;
  }
  if (parsed.command === "assign") {
    const address = parsed.repo ? { repo: parsed.repo } : { workspaceId: ctx.workspaceId };
    const inputs = {
      task: parsed.task,
      tests: parsed.tests,
      blockers: parsed.blockers,
      ...(parsed.next ? { next: parsed.next } : {}),
    };
    const preview = await ctx.rpc(factoryAssignPreview, { ...address, ...inputs });
    setFactoryResult({
      kind: "assignPreview",
      repo: parsed.repo,
      workspaceId: ctx.workspaceId,
      at,
      inputs,
      preview,
    });
    return PANEL;
  }
  if (parsed.command === "resume") {
    if (parsed.brief) {
      const resume = await ctx.rpc(factoryResume, {
        ...(parsed.repo ? { repo: parsed.repo } : { workspaceId: ctx.workspaceId }),
        ...(parsed.agentId ?? ctx.agentId ? { agentId: (parsed.agentId ?? ctx.agentId) as string } : {}),
      });
      setFactoryResult({ kind: "resume", repo: parsed.repo ?? CURRENT_WORKSPACE, at, resume });
      return pill("Resume brief");
    }
    const target = parsed.agentId ?? ctx.agentId;
    if (!target) throw new Error("/factory resume needs an agent: run it in a steer chat.");
    if (parsed.agentId && parsed.agentId !== ctx.agentId) {
      // A foreign agent is never cleared on a bare command: preview in the
      // panel and confirm there.
      setFactoryResult({ kind: "resumePreview", workspaceId: ctx.workspaceId, agentId: target, at });
      return PANEL;
    }
    const applied = await ctx.rpc(factoryResumeApply, {
      workspaceId: ctx.workspaceId,
      agentId: target,
      takeover: true,
    });
    setFactoryResult({ kind: "resumeApplied", workspaceId: ctx.workspaceId, agentId: target, at, applied });
    if (applied.status === "blocked") return pill(applied.detail);
    return { openPanel: false, pill: null };
  }
  if (parsed.command === "plan") {
    const plan = await ctx.rpc(factoryPlan, {
      ...(parsed.repos.length || parsed.local?.length || parsed.hub?.length ? {} : { workspaceId: ctx.workspaceId }),
      ...(parsed.repos.length ? { repos: parsed.repos } : {}),
      ...(parsed.slots ? { slots: parsed.slots } : {}),
      ...(parsed.adopt ? { adopt: parsed.adopt } : {}),
      ...(parsed.local?.length ? { local: parsed.local } : {}),
      ...(parsed.hub?.length ? { hub: parsed.hub } : {}),
      ...(parsed.name !== undefined ? { name: parsed.name } : {}),
      ...(parsed.main !== undefined ? { main: parsed.main } : {}),
      ...(parsed.domain !== undefined ? { domain: parsed.domain } : {}),
      ...(parsed.adoptWorker ? { adoptWorker: parsed.adoptWorker } : {}),
      ...(parsed.detach ? { detach: true as const } : {}),
    });
    setFactoryResult({ kind: "plan", repos: [...parsed.repos, ...(parsed.local ?? []), ...(parsed.hub ?? [])], at, plan });
    return PANEL;
  }
  if (parsed.command === "apply") {
    const applied = await ctx.rpc(factoryApply, { hash: parsed.hash });
    setFactoryResult({ kind: "applied", at, applied });
    return PANEL;
  }
  if (parsed.command === "checkpoint") {
    const inputs = {
      ...(parsed.task ? { task: parsed.task } : {}),
      ...(parsed.fromAgent ? { fromAgent: parsed.fromAgent } : {}),
      ...(parsed.fromSteer ? { fromSteer: parsed.fromSteer } : {}),
      tests: parsed.tests,
      blockers: parsed.blockers,
      ...(parsed.next ? { next: parsed.next } : {}),
    };
    const address = parsed.repo ? { repo: parsed.repo } : { workspaceId: ctx.workspaceId };
    const preview = await ctx.rpc(factoryCheckpointPreview, { ...address, ...inputs });
    setFactoryResult({
      kind: "checkpointPreview",
      repo: parsed.repo,
      workspaceId: ctx.workspaceId,
      at,
      inputs,
      preview,
    });
    return PANEL;
  }
  if (parsed.command !== "switch") throw new Error(`Unhandled /factory command ${parsed.command}`);
  const address = parsed.repo ? { repo: parsed.repo } : { workspaceId: ctx.workspaceId };
  const preview = await ctx.rpc(factorySwitchPreview, { ...address, to: parsed.to });
  setFactoryResult({
    kind: "switchPreview",
    repo: parsed.repo,
    workspaceId: ctx.workspaceId,
    to: parsed.to,
    requestedApply: parsed.apply,
    at,
    preview,
  });
  return PANEL;
}

async function submitModels(
  parsed: Extract<ReturnType<typeof parseFactoryArgs>, { command: "worker" | "steer" | "model" }>,
  ctx: SubmitContext,
  at: string,
): Promise<FactorySubmitOutcome> {
  if (parsed.command !== "model" && parsed.action === "list") {
    const list = await ctx.rpc(factoryModelsList, {});
    const text = formatModelList(parsed.command, list as any);
    setFactoryResult({ kind: "info", at, text });
    return pill(parsed.command === "worker" ? "Worker models" : "Steer slots");
  }
  if (parsed.command === "worker" && parsed.action === "pick") {
    const pick = await ctx.rpc(
      factoryWorkerPick,
      parsed.repo ? { repo: parsed.repo } : { workspaceId: ctx.workspaceId },
    );
    setFactoryResult({ kind: "info", at, text: pick.text });
    return pill("Worker pick");
  }
  const input =
    parsed.command === "model"
      ? { action: parsed.flag, spec: parsed.spec, on: parsed.on }
      : parsed.action === "rm"
        ? { action: `${parsed.command}-rm` as const, n: parsed.n }
        : {
            action: `${parsed.command}-set` as const,
            n: parsed.n,
            spec: parsed.spec,
            ...(parsed.thinking !== undefined ? { thinking: parsed.thinking } : {}),
            ...(parsed.mode !== undefined ? { mode: parsed.mode } : {}),
            ...(parsed.profile !== undefined ? { profile: parsed.profile } : {}),
          };
  const change = await ctx.rpc(factoryModelsSet, input);
  if (!parsed.dryRun) {
    // The server cannot write host settings; save through the settings RPC,
    // guarded by the revision the plan was made at.
    const saved = await ctx.rpc(settingsRpc("factory-config").write, {
      revision: change.revision,
      values: change.values as any,
    });
    if (saved.status !== "saved") {
      throw new Error(`Not saved: ${saved.error}. Run the command again.`);
    }
  }
  setFactoryResult({ kind: "info", at, text: formatModelChange(change as any, !parsed.dryRun) });
  return pill("Models");
}
