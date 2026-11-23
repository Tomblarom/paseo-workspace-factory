import type { PluginAgentCommandContext } from "@getpaseo/plugin/client";
import {
  factoryApply,
  factoryCheckpointPreview,
  factoryCleanup,
  factoryPlan,
  factoryResume,
  factoryScopes,
  factoryScopesCandidates,
  factoryStatus,
  factorySwitchPreview,
} from "../shared/factory.js";
import { FACTORY_USAGE, parseFactoryArgs } from "../shared/factory-args.js";
import { setFactoryResult } from "./factory-store.js";

interface SubmitContext {
  rpc: PluginAgentCommandContext["rpc"];
  workspaceId: string;
  agentId?: string;
}

const CURRENT_WORKSPACE = "(current workspace)";

/**
 * Runs one /factory invocation: parse, call the matching RPC, publish the
 * result. The scope address is optional everywhere; without one the server
 * resolves the scope of the current workspace. Writes stay two-stage: apply
 * quotes the stored plan hash, while checkpoint and switch only preview here
 * and apply from the panel button.
 */
export async function submitFactoryCommand(args: string, ctx: SubmitContext): Promise<void> {
  const parsed = parseFactoryArgs(args);
  const at = new Date().toISOString();
  if (parsed.command === "help") {
    setFactoryResult({ kind: "info", at, text: FACTORY_USAGE });
    return;
  }
  if (parsed.command === "status") {
    const status = await ctx.rpc(
      factoryStatus,
      parsed.repo ? { repo: parsed.repo } : { workspaceId: ctx.workspaceId },
    );
    setFactoryResult({ kind: "status", repo: parsed.repo ?? CURRENT_WORKSPACE, at, status });
    return;
  }
  if (parsed.command === "scopes") {
    if (parsed.candidates) {
      const candidates = await ctx.rpc(factoryScopesCandidates, {});
      setFactoryResult({ kind: "scopeCandidates", at, candidates });
    } else {
      const scopes = await ctx.rpc(factoryScopes, {});
      setFactoryResult({ kind: "scopes", at, scopes });
    }
    return;
  }
  if (parsed.command === "cleanup") {
    const cleanup = await ctx.rpc(factoryCleanup, {});
    setFactoryResult({ kind: "cleanup", at, cleanup });
    return;
  }
  if (parsed.command === "resume") {
    const resume = await ctx.rpc(factoryResume, {
      ...(parsed.repo ? { repo: parsed.repo } : { workspaceId: ctx.workspaceId }),
      ...(parsed.agentId ?? ctx.agentId ? { agentId: (parsed.agentId ?? ctx.agentId) as string } : {}),
    });
    setFactoryResult({ kind: "resume", repo: parsed.repo ?? CURRENT_WORKSPACE, at, resume });
    return;
  }
  if (parsed.command === "plan") {
    const plan = await ctx.rpc(factoryPlan, {
      ...(parsed.repos.length ? { repos: parsed.repos } : { workspaceId: ctx.workspaceId }),
      ...(parsed.allowFork ? { allowFork: true as const } : {}),
      ...(parsed.slots ? { slots: parsed.slots } : {}),
    });
    setFactoryResult({ kind: "plan", repos: parsed.repos, at, plan });
    return;
  }
  if (parsed.command === "apply") {
    const applied = await ctx.rpc(factoryApply, { hash: parsed.hash });
    setFactoryResult({ kind: "applied", at, applied });
    return;
  }
  if (parsed.command === "checkpoint") {
    const inputs = {
      ...(parsed.task ? { task: parsed.task } : {}),
      ...(parsed.fromAgent ? { fromAgent: parsed.fromAgent } : {}),
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
    return;
  }
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
}
