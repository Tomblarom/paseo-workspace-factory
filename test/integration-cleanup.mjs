// Fail-closed cleanup for the live integration test. Everything is verified first;
// archiving happens only when every object is positively identified. Missing or
// unreadable evidence means: no archive call at all.
import { realpathSync } from 'node:fs';
import { parentOf, METADATA_KEY } from '../plugin/server/core/paseo.mjs';
import { runtime } from '../plugin/server/core/runtime.mjs';

function canonical(path, realpath) {
  try {
    return realpath(path);
  } catch {
    return null;
  }
}

/**
 * @param agents every agent the daemon lists (including archived), or null if unreadable
 * @returns { ok, reasons, targets }
 */
export async function verifyCleanup({ manifest, client, agents, scratchBase = runtime().scratchDir, realpath = realpathSync }) {
  const reasons = [];
  const targets = { agent: null, workspace: null };
  const base = canonical(scratchBase, realpath);
  const scratch = typeof manifest?.scratch === 'string' ? canonical(manifest.scratch, realpath) : null;
  if (!base) reasons.push('scratch base cannot be resolved');
  if (!scratch) reasons.push('manifest scratch path missing or unresolvable');
  else if (base && !(scratch.startsWith(`${base}/run-`) && !scratch.slice(base.length + 1).includes('/'))) reasons.push(`scratch ${scratch} is not a run directory directly under ${base}`);
  if (typeof manifest?.workspace !== 'string' || !/^wks_[0-9a-f]{16}$/.test(manifest.workspace)) reasons.push('manifest workspace id missing or malformed');
  if (!Array.isArray(agents)) reasons.push('agent list unavailable');
  if (reasons.length) return { ok: false, reasons, targets };

  let workspace = null;
  try {
    workspace = await client.workspaces.ref(manifest.workspace).refresh();
  } catch (error) {
    reasons.push(`workspace refresh failed: ${error.message}`);
  }
  if (!workspace) reasons.push('workspace snapshot missing');
  else {
    if (workspace.id !== manifest.workspace) reasons.push(`workspace id mismatch (${workspace.id})`);
    if (canonical(workspace.workspaceDirectory ?? '', realpath) !== scratch) reasons.push(`workspace directory ${workspace.workspaceDirectory} is not the scratch path`);
    if (workspace.workspaceKind !== 'local_checkout') reasons.push(`workspace kind ${workspace.workspaceKind} is not local_checkout`);
    if (workspace.metadata?.[METADATA_KEY]?.main !== true) reasons.push('workspace lacks the test metadata');
  }

  const live = agents.filter((a) => a.workspaceId === manifest.workspace && !a.archivedAt);
  const foreign = live.filter((a) => a.id !== manifest.agent);
  if (foreign.length) reasons.push(`workspace has agents not created by this run: ${foreign.map((a) => a.id).join(', ')}`);
  if (manifest.agent) {
    let agent = null;
    try {
      agent = (await client.agents.ref(manifest.agent).refresh())?.agent ?? null;
    } catch (error) {
      reasons.push(`agent refresh failed: ${error.message}`);
    }
    if (!agent) reasons.push('agent snapshot missing');
    else {
      if (agent.id !== manifest.agent) reasons.push(`agent id mismatch (${agent.id})`);
      if (agent.workspaceId !== manifest.workspace) reasons.push(`agent belongs to ${agent.workspaceId}`);
      if (agent.labels?.['wsf.role'] !== 'integration-test') reasons.push('agent lacks the integration-test label');
      if (parentOf(agent)) reasons.push(`agent has parent ${parentOf(agent)}`);
      if (!agent.archivedAt) targets.agent = agent.id;
    }
  }
  if (!reasons.length) targets.workspace = manifest.workspace;
  return { ok: reasons.length === 0, reasons, targets: reasons.length ? { agent: null, workspace: null } : targets };
}

/** Archives exactly the verified targets; stops at the first failure. Never deletes files. */
export async function performCleanup({ verification, client }) {
  if (!verification?.ok) return { status: 'refused', steps: [], reasons: verification?.reasons ?? ['not verified'] };
  const steps = [];
  try {
    if (verification.targets.agent) {
      await client.agents.ref(verification.targets.agent).archive();
      steps.push({ agent: verification.targets.agent, status: 'archived' });
    }
    const result = await client.workspaces.archive(verification.targets.workspace);
    if (result?.error) throw new Error(result.error);
    steps.push({ workspace: verification.targets.workspace, status: 'archived' });
    return { status: 'complete', steps };
  } catch (error) {
    steps.push({ status: 'failed', error: error.message });
    return { status: 'failed', steps };
  }
}
