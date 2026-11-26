// Plugin RPC handler tests for the thin CLI surface (K12b): verifies every
// kept CLI RPC produces the same formatted output and enforces scope/caller rules.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

register("./ts-resolve-hooks.mjs", import.meta.url);

const handlers = await import("../server/handlers.ts");
import { LABEL, METADATA_KEY, PARENT_LABEL } from "../server/core/paseo.mjs";
import { formatStatus, scopeCandidates } from "../server/core/scopes-view.mjs";
import { formatSlotProfileSuggestion, resolveWorkerPick, workerListRows } from "../server/core/models.mjs";
import { formatWorkersPruneText, formatWorkersText, workersReport, WORKERS_KEY } from "../server/core/supervision.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "k12b-handlers-"));
test.after(() => rmSync(ROOT, { recursive: true, force: true }));

const SCOPE = "app";
const MAIN = "wks_app";

function makeWorld() {
  const dir = join(ROOT, "app");
  mkdirSync(dir, { recursive: true });
  const ws = {
    id: MAIN,
    projectId: "prj_app",
    workspaceDirectory: dir,
    workspaceKind: "local_checkout",
    title: "Main",
    name: "Main",
    metadata: {
      [METADATA_KEY]: {
        main: true,
        activeSteer: "A",
        epoch: 3,
        scope: { id: SCOPE, kind: "dir", locator: dir },
      },
      [WORKERS_KEY]: {
        "w-live": { task: "Check tests", startedBy: "A", startedAt: "2026-11-25T10:00:00Z", epoch: 3, state: "running", resumes: 0 },
        "w-stale": { task: "Old job", startedBy: "A", startedAt: "2026-11-25T09:00:00Z", epoch: 2, state: "done", resumes: 1 },
      },
    },
  };
  const steerA = {
    id: "steer-a", status: "idle", archivedAt: null, title: "Steer A", workspaceId: MAIN,
    provider: "codex", model: "gpt-6.2-sol",
    labels: { [LABEL.scope]: SCOPE, [LABEL.repo]: SCOPE, [LABEL.role]: "steer", [LABEL.slot]: "A" },
  };
  const steerB = {
    id: "steer-b", status: "running", archivedAt: null, title: "Steer B", workspaceId: MAIN,
    provider: "claude", model: "claude-sonnet",
    labels: { [LABEL.scope]: SCOPE, [LABEL.repo]: SCOPE, [LABEL.role]: "steer", [LABEL.slot]: "B" },
  };
  const workerLive = {
    id: "w-live", status: "idle", archivedAt: null, title: "Tests", workspaceId: MAIN,
    provider: "codex", model: "gpt-6.2-sol",
    labels: { [LABEL.scope]: SCOPE, [LABEL.role]: "worker", [LABEL.owner]: "A", [PARENT_LABEL]: "steer-a" },
  };
  const world = {
    projects: [{ projectId: "prj_app", projectRootPath: dir, projectDisplayName: SCOPE }],
    workspaces: [ws],
    agents: [steerA, steerB, workerLive],
    providers: [
      { provider: "codex", enabled: true, status: "ready", models: [{ id: "gpt-6.2-sol", thinkingOptions: [] }], modes: [{ id: "full-access" }] },
      { provider: "claude", enabled: true, status: "ready", models: [{ id: "claude-sonnet", thinkingOptions: [] }], modes: [{ id: "auto" }] },
    ],
    sent: [],
  };
  return world;
}

function fakePaseo(world) {
  const page = (entries) => ({ entries: structuredClone(entries), pageInfo: { hasMore: false } });
  const wsHandle = (id) => {
    const ws = () => world.workspaces.find((w) => w.id === id);
    return {
      refresh: async () => structuredClone(ws()),
      setMetadata: async (patch) => {
        Object.assign(ws().metadata, structuredClone(patch));
      },
      agents: {
        create: async (req) => {
          const created = {
            id: `w-created-${world.agents.length + 1}`,
            workspaceId: id,
            status: "idle",
            archivedAt: null,
            title: req.title,
            provider: req.config.provider,
            model: req.config.model,
            labels: { ...req.labels, ...(req.parent ? { [PARENT_LABEL]: req.parent } : {}) },
            metadata: req.metadata,
          };
          world.agents.push(created);
          return { refresh: async () => ({ agent: structuredClone(created) }) };
        },
      },
    };
  };
  return {
    projects: { list: async () => ({ projects: structuredClone(world.projects) }) },
    workspaces: {
      list: async () => page(world.workspaces),
      ref: wsHandle,
    },
    agents: {
      list: async () => page(world.agents.map((agent) => ({ agent }))),
      ref: (id) => ({
        refresh: async () => ({ agent: structuredClone(world.agents.find((a) => a.id === id) ?? null) }),
        send: async (text) => { world.sent.push([id, text]); },
        timeline: {
          refetch: async () => ({
            entries: [{
              item: {
                type: "assistant_message",
                text: "Done.\n\n```text\nCHECKPOINT\ntask: From steer A\ntests: npm test\nblockers: none\nnext: Merge\n```",
              },
            }],
          }),
        },
        waitForFinish: async () => {},
      }),
    },
    providers: { snapshot: async () => ({ entries: structuredClone(world.providers) }) },
  };
}

const CONFIG = {
  version: 1,
  github: { owner: "example", cloneProtocol: "https", upstreamRemote: "upstream" },
  checkoutRoot: ROOT,
  workspaceTitle: "Main",
  profiles: {
    sol: { provider: "codex", model: "gpt-6.2-sol", thinking: null, mode: "full-access" },
    sonnet: { provider: "claude", model: "claude-sonnet", thinking: null, mode: "auto" },
  },
  steers: { slots: { A: "sol", B: "sonnet" }, prepare: ["A", "B"], initialActive: "A" },
  workers: { priority: ["sol", "sonnet"], defaultProfile: "sol" },
};

const loader = {
  loadEffectiveConfig: async () => structuredClone(CONFIG),
  loadPromptOptions: async () => ({ findingsInPrompts: false, factoryRoot: null }),
};

test("getStatus and getWorkers (list + prune) match core text formatting", async () => {
  const world = makeWorld();
  const paseo = fakePaseo(world);
  const status = await handlers.getStatus({ repo: SCOPE }, { paseo }, loader);
  assert.equal(status.text, formatStatus(status));

  const workers = await handlers.getWorkers({ repo: SCOPE }, { paseo }, loader);
  const expectedReport = workersReport(world.workspaces[0].metadata[WORKERS_KEY]);
  assert.equal(workers.text, formatWorkersText(SCOPE, 3, expectedReport));

  const preview = await handlers.getWorkers({ repo: SCOPE, prune: true }, { paseo }, loader);
  assert.equal(preview.applied, false);
  assert.deepEqual(preview.stale.map((s) => s.id), ["w-stale"]);
  assert.equal(preview.text, formatWorkersPruneText(SCOPE, 3, preview.stale));

  const pruned = await handlers.getWorkers({ repo: SCOPE, prune: true, apply: true }, { paseo }, loader);
  assert.equal(pruned.applied, true);
  assert.deepEqual(pruned.removed.map((r) => r.id), ["w-stale"]);
  assert.equal(world.workspaces[0].metadata[WORKERS_KEY]["w-stale"], undefined);
});

test("getResume includes Worker model line and restartInterrupted metadata", async () => {
  const world = makeWorld();
  const res = await handlers.getResume({ repo: SCOPE, agentId: "steer-a" }, { paseo: fakePaseo(world) }, loader);
  assert.match(res.brief, /Worker model: codex\/gpt-6\.2-sol/);
  assert.equal(res.openWorkers.length, 1);
  assert.equal(res.openWorkers[0].id, "w-live");
});

test("pickWorker, listWorkersModels and startWorkerRpc agree and record --failed", async () => {
  const world = makeWorld();
  const paseo = fakePaseo(world);
  // No live ZeroSub state: worker selection must be deterministic in tests.
  const noZerosub = { getZerosub: async () => null, lookupReceipt: async () => null, reservePins: false };
  const listBefore = await handlers.listWorkersModels({ cwd: world.workspaces[0].workspaceDirectory }, { paseo }, loader, noZerosub);
  const sel = resolveWorkerPick(CONFIG, world.providers, { repoPublic: listBefore.repoPublic, zerosub: null });
  assert.equal(listBefore.chosen, sel.profile.name);
  assert.deepEqual(listBefore.entries, workerListRows(CONFIG, world.providers, sel));

  const pickAfterFail = await handlers.pickWorker({
    repo: SCOPE, failed: "sol", reason: "429 rate limit",
  }, { paseo }, loader, noZerosub);
  assert.equal(pickAfterFail.profile, "sonnet");
  assert.match(pickAfterFail.text, /skipped "sol": recently failed/);

  const started = await handlers.startWorkerRpc({
    repo: SCOPE, callerId: "steer-a", task: "Check docs", title: "Docs", apply: true,
  }, { paseo }, loader, noZerosub);
  assert.equal(started.profile, "sonnet");
  assert.match(started.text, /^Started worker w-created-4 \(claude\/claude-sonnet\) in app$/);
});

test("checkpoint, self-takeover switch, and assign preserve caller guards", async () => {
  const world = makeWorld();
  const paseo = fakePaseo(world);
  const previewCp = await handlers.previewCheckpoint({ repo: SCOPE, fromAgent: "steer-a" }, { paseo }, loader);
  await assert.rejects(
    handlers.writeCheckpointRpc({ repo: SCOPE, fromAgent: "steer-a", fingerprint: previewCp.fingerprint, callerId: "steer-b" }, { paseo }, loader),
    /Only the active steer/,
  );
  const cp = await handlers.writeCheckpointRpc({ repo: SCOPE, fromAgent: "steer-a", fingerprint: previewCp.fingerprint, callerId: "steer-a" }, { paseo }, loader);
  assert.equal(cp.checkpoint.task, "From steer A");

  // Self-takeover by running Steer B succeeds and sends nothing to itself.
  const previewSw = await handlers.previewSwitch({ repo: SCOPE, to: "B", callerId: "steer-b" }, { paseo }, loader);
  const switched = await handlers.applySwitch({
    repo: SCOPE, to: "B", fingerprint: previewSw.fingerprint, callerId: "steer-b", deliver: "send",
  }, { paseo }, loader);
  assert.equal(switched.applied, true);
  assert.equal(switched.selfTakeover, true);
  assert.equal(switched.delivered, false);
  assert.deepEqual(world.sent, []);

  // Assign from Steer B (now active in its own scope) with --no-send writes checkpoint without sending.
  const noZerosub = { getZerosub: async () => null };
  const previewA = await handlers.previewAssign({ repo: SCOPE, task: "Follow up", callerId: "steer-b" }, { paseo }, loader, noZerosub);
  const assigned = await handlers.applyAssign({
    repo: SCOPE, task: "Follow up", fingerprint: previewA.fingerprint, callerId: "steer-b", send: false,
  }, { paseo }, loader, noZerosub);
  assert.equal(assigned.applied, true);
  assert.equal(assigned.delivered, false);
  assert.deepEqual(world.sent, []);
});

test("core suggestion helpers default to /factory for removed CLI commands", () => {
  assert.equal(formatSlotProfileSuggestion(CONFIG, "B", "codex", "gpt-6.2-sol"), '/factory steer set B "sol"');
  const candidates = scopeCandidates({ workspaces: [{ id: "wks_x", workspaceDirectory: "/tmp/x", metadata: {} }] });
  assert.equal(candidates[0].suggestedPlan, "/factory plan --local /tmp/x");
});
