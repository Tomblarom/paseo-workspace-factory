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
const { createConfigLoader } = await import("../server/config.ts");
const { collectSteerStates } = await import("../server/steer-feed.ts");
const { factoryWorkspaceResources } = await import("../shared/factory.ts");
import { LABEL, METADATA_KEY, PARENT_LABEL } from "../server/core/paseo.mjs";
import { AGENTS_KEY } from "../server/core/agent-state.mjs";
import { LockBusy } from "../server/core/lock.mjs";
import { PROFILE_HEALTH_KEY } from "../server/core/quota.mjs";
import { formatStatus, scopeCandidates } from "../server/core/scopes-view.mjs";
import { formatSlotProfileSuggestion, resolveWorkerPick, workerListRows } from "../server/core/models.mjs";
import { formatWorkersPruneText, formatWorkersText, workersReport, WORKERS_KEY } from "../server/core/supervision.mjs";
import { buildSteerCreate } from "../server/core/steer-create.mjs";
import { steerAddFingerprint } from "../shared/preview.ts";

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
          if (world.createAgent) return world.createAgent(id, req);
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

test("plan RPC normalizes one live bootstrap letter without consulting configured slots", async () => {
  const world = makeWorld();
  const ws = world.workspaces[0];
  delete ws.metadata[METADATA_KEY];
  const steer = world.agents[0];
  steer.title = "Steer Z";
  steer.labels[LABEL.slot] = "Z";
  const context = { paseo: fakePaseo(world) };
  const entry = { local: [ws.workspaceDirectory] };
  await assert.rejects(handlers.getPlan({ ...entry, slots: ["A", "Z"] }, context, loader), /one live coordinator/);
  const { plans: [preview] } = await handlers.getPlan({ ...entry, slots: [" z "] }, context, loader);
  assert.equal(preview.status, "pending", JSON.stringify(preview.conflicts));
  assert.equal(preview.ops[0].params.metadata[METADATA_KEY].activeAgentId, steer.id);
});

function activationWorld() {
  const world = makeWorld();
  const [workspace] = world.workspaces;
  const [active, target, worker] = world.agents;
  target.status = "idle";
  const alternative = { ...target, id: "steer-c", title: "Steer C", labels: { ...target.labels, [LABEL.slot]: "C" } };
  world.agents.push(alternative);
  const localLoader = { ...loader, loadEffectiveConfig: async () => ({ ...CONFIG, steers: { ...CONFIG.steers, activeMarker: "" } }) };
  const paseo = fakePaseo(world);
  const deps = { getZerosub: async () => null };
  const activate = (agentId = target.id, epoch = 3, workspaceId = workspace.id, extra = {}) =>
    handlers.activateSteer({ workspaceId, agentId, epoch }, { paseo }, localLoader, { ...deps, ...extra });
  return { world, workspace, active, target, worker, alternative, paseo, activate };
}

test("own-tab activation retries a lost delivery receipt with the same target, epoch, packet and message ID", async () => {
  const { world, workspace, active, target, paseo, activate } = activationWorld();
  const meta = workspace.metadata;
  meta[`${METADATA_KEY}.checkpoint`] = { task: "Latest stored checkpoint", tests: [], blockers: [], epoch: 3 };
  meta[AGENTS_KEY] = { [active.id]: { quotaLimit: { provider: active.provider, model: active.model } } };
  const childMetadata = {
    [`${METADATA_KEY}.checkpoint`]: { task: "Delegated build" },
    [`${METADATA_KEY}.assignment`]: { by: active.id, requesterWorkspaceId: workspace.id, reportActionId: "build-report" },
  };
  world.workspaces.push({ ...workspace, id: "wks_assignment", metadata: childMetadata });
  const workers = structuredClone(meta[WORKERS_KEY]);
  let previousTimelineReads = 0;
  const sends = [];
  const ref = paseo.agents.ref;
  paseo.agents.ref = (id) => ({
    ...ref(id),
    ...(id === active.id ? { timeline: { refetch: async () => { previousTimelineReads++; throw new Error("unavailable"); } } } : {}),
    async send(text, options) {
      sends.push({ id, text, options });
      if (sends.length === 1) throw new Error("lost receipt after enqueue");
    },
  });

  assert.notEqual((await activate()).status, "sent");
  const uncertain = meta[AGENTS_KEY][target.id].action;
  assert.equal(uncertain.phase, "uncertain");
  assert.equal(uncertain.kind, "activate");
  assert.equal(meta[METADATA_KEY].activeAgentId, target.id);
  assert.equal(meta[METADATA_KEY].epoch, 4);
  const pendingRows = collectSteerStates(world, {});
  assert.equal(pendingRows.find((row) => row.agentId === target.id).activationEpoch, 3);
  assert.equal(pendingRows.find((row) => row.agentId === active.id).activationEpoch, 4);

  // A different click at the new epoch must wait for the uncertain receipt.
  await assert.rejects(activate(active.id, 4), /awaiting reconciliation/);
  assert.equal((await activate()).status, "sent");
  assert.equal((await activate()).status, "sent");
  assert.equal(meta[METADATA_KEY].epoch, 4);
  assert.equal(meta[AGENTS_KEY][target.id].action.phase, "done");
  assert.deepEqual(meta[WORKERS_KEY], workers);
  assert.equal(previousTimelineReads, 0);
  assert.equal(sends.length, 2);
  assert.deepEqual(sends[0], sends[1]);
  assert.equal(sends[0].id, target.id);
  assert.equal(sends[0].options.messageId, uncertain.wakeId);
  assert.match(sends[0].text, /Latest stored checkpoint/);
  assert.match(sends[0].text, /Check tests/);
  assert.match(sends[0].text, /Delegated build/);
  assert.equal(childMetadata[`${METADATA_KEY}.assignment`].reportActionId, "build-report");
  assert.equal(collectSteerStates(world, {}).find((row) => row.agentId === target.id).activationEpoch, null);
});

test("activation prepares the selected cold tab while another standby is ready", async () => {
  const { world, workspace, target, activate } = activationWorld();
  workspace.metadata[AGENTS_KEY] = { [target.id]: { lastTurnEndedAt: "2026-10-01T08:00:00Z" } };
  const prepared = [];
  const result = await activate(target.id, 3, workspace.id, {
    now: () => "2026-11-26T12:00:00Z",
    runCleanupFn: async (_paseo, id, kind) => { prepared.push([id, kind]); },
  });
  assert.equal(result.status, "pending");
  assert.deepEqual(prepared, [[target.id, "clear"]]);
  assert.deepEqual(world.sent, []);
  assert.equal(workspace.metadata[METADATA_KEY].activeAgentId, target.id);
  assert.equal(workspace.metadata[AGENTS_KEY][target.id].action.routing.intent.agentId, target.id);
});

test("own-tab activation takes a vacant slot's authority once and preserves delegated work", async () => {
  const { world, workspace, active, target, activate } = activationWorld();
  const meta = workspace.metadata;
  meta[METADATA_KEY].activeAgentId = active.id;
  active.archivedAt = "2026-11-26T11:59:00Z";
  const workers = structuredClone(meta[WORKERS_KEY]);
  const assignment = { by: active.id, requesterWorkspaceId: workspace.id, reportActionId: "build-report" };
  const assignmentKey = `${METADATA_KEY}.assignment`;
  world.workspaces.push({ ...workspace, id: "wks_assignment", metadata: { [assignmentKey]: assignment } });

  await assert.rejects(activate(target.id, 2), /authority changed/);
  assert.equal((await activate()).status, "sent");
  const receipt = meta[AGENTS_KEY][target.id].action;
  assert.equal(receipt.kind, "activate");
  assert.equal(receipt.phase, "done");
  assert.equal((await activate()).status, "sent");
  assert.deepEqual(meta[AGENTS_KEY][target.id].action, receipt);
  assert.equal(meta[METADATA_KEY].epoch, 4);
  assert.equal(meta[METADATA_KEY].activeAgentId, target.id);
  assert.equal(meta[METADATA_KEY].previousSteer, "A");
  assert.deepEqual(meta[WORKERS_KEY], workers);
  assert.deepEqual(world.workspaces[1].metadata[assignmentKey], assignment);
  assert.deepEqual(world.sent.map(([id]) => id), [target.id]);
});

test("overlapping activations of the same tab and epoch share one outcome", async () => {
  const { world, workspace, target, paseo, activate } = activationWorld();
  const workspaceRef = paseo.workspaces.ref;
  const writingAuthority = Promise.withResolvers();
  const allowWrite = Promise.withResolvers();
  paseo.workspaces.ref = (id) => {
    const handle = workspaceRef(id);
    return {
      ...handle,
      async setMetadata(patch) {
        if (patch[METADATA_KEY]?.epoch === 4) {
          writingAuthority.resolve();
          await allowWrite.promise;
        }
        await handle.setMetadata(patch);
      },
    };
  };

  const first = activate();
  await Promise.race([writingAuthority.promise, first]);
  const second = activate();
  const completed = Promise.allSettled([first, second]);
  await new Promise((resolve) => setImmediate(resolve));
  allowWrite.resolve();
  const outcomes = (await completed).map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
  assert.equal(outcomes[0].status, "sent");
  assert.deepEqual(outcomes[0], outcomes[1]);
  assert.equal(workspace.metadata[METADATA_KEY].epoch, 4);
  assert.deepEqual(world.sent.map(([id]) => id), [target.id]);
});

test("activation refuses a busy live controller and a holder that appears after discovery", async () => {
  const { world, workspace, active, target, activate } = activationWorld();
  active.pendingPermissions = [{ id: "open" }];
  await assert.rejects(activate(), /active steer is busy/);
  active.archivedAt = "2026-11-26T11:59:00Z";
  await assert.rejects(activate(target.id, 3, workspace.id, { lock: async (_name, run) => {
    active.archivedAt = null;
    return run({ verify() {} });
  } }), /Active steer changed since discovery/);
  assert.equal(workspace.metadata[METADATA_KEY].epoch, 3);
  assert.deepEqual(world.sent, []);
});

test("activation refuses stale epochs, other workspaces, and non-steer or ambiguous targets", async () => {
  const { world, workspace, active, target, worker, alternative, activate } = activationWorld();
  await assert.rejects(activate(target.id, 2), /authority changed/);
  await assert.rejects(activate(target.id, 3, "wks_other"), /Unknown workspace/);
  await assert.rejects(activate(worker.id), /no longer a live steer/);
  await assert.rejects(activate(active.id), /already active/);
  assert.equal((await activate(alternative.id)).status, "sent");
  await assert.rejects(activate(target.id, 3), /authority changed/);
  world.agents.push({ ...target, id: "duplicate-b" });
  await assert.rejects(activate(target.id, 4), /Expected one .* Steer B, found 2/);
  assert.equal(workspace.metadata[METADATA_KEY].activeAgentId, alternative.id);
  assert.equal(workspace.metadata[METADATA_KEY].epoch, 4);
  assert.deepEqual(world.sent.map(([id]) => id), [alternative.id]);
});

test("activation refuses a limited target and pending permissions before changing authority", async () => {
  const { world, workspace, target, activate } = activationWorld();
  workspace.metadata[AGENTS_KEY] = { [target.id]: { quotaLimit: { provider: target.provider, model: target.model } } };
  await assert.rejects(activate(), /cannot be activated: provider limit/);
  target.pendingPermissions = [{ id: "open" }];
  await assert.rejects(activate(), /permission request/);
  target.labels[LABEL.steerRole] = "advisor";
  await assert.rejects(activate(), /Only a live coordinator steer/);
  assert.equal(workspace.metadata[METADATA_KEY].epoch, 3);
  assert.deepEqual(world.sent, []);
});

test("activation rechecks the scope epoch under the handover lock", async () => {
  const { world, workspace, target, alternative, activate } = activationWorld();
  const scope = workspace.metadata[METADATA_KEY];
  await assert.rejects(activate(target.id, 3, workspace.id, { lock: async (_name, run) => {
    Object.assign(scope, { activeSteer: "C", activeAgentId: alternative.id, epoch: 4 });
    return run({ verify() {} });
  } }), /Scope state changed since discovery/);
  assert.equal(scope.epoch, 4);
  assert.equal(scope.activeAgentId, alternative.id);
  assert.deepEqual(world.sent, []);
});

test("resume inspection without a destination stays available; advisor CLI output cannot borrow a coordinator target", async () => {
  const world = makeWorld();
  const [active, advisor] = world.agents;
  advisor.labels[LABEL.steerRole] = "advisor";
  const [workspace] = world.workspaces;
  workspace.metadata[`${METADATA_KEY}.checkpoint`] = { task: "SYNTHETIC_PRIVATE_CHECKPOINT" };
  workspace.metadata[AGENTS_KEY] = { "w-live": { note: "SYNTHETIC_PRIVATE_LOG" } };
  const paseo = fakePaseo(world);

  const manual = await handlers.getResume({ workspaceId: MAIN }, { paseo }, loader, { getZerosub: async () => null });
  assert.match(manual.brief, /SYNTHETIC_PRIVATE_CHECKPOINT/);
  for (const provider of [advisor.provider, active.provider]) {
    advisor.provider = provider;
    for (const address of [{ agentId: advisor.id }, { agentId: active.id, callerId: advisor.id }]) {
      await assert.rejects(handlers.getResume({ workspaceId: MAIN, ...address }, { paseo }, loader), (error) => {
        assert.match(error.message, /advisor brief requires verified/);
        assert.doesNotMatch(error.message, /SYNTHETIC_/);
        return true;
      });
    }
  }
  const unclassified = { ...advisor, id: "native-advisor", title: "[Advisor] Technical question", labels: {} };
  world.agents.push(unclassified);
  await assert.rejects(handlers.getResume({ workspaceId: MAIN, agentId: active.id, callerId: unclassified.id },
    { paseo }, loader), /recipient has no verified Factory identity/);

  await assert.rejects(handlers.getResume({ workspaceId: MAIN, agentId: active.id }, { paseo }, {
    ...loader,
    loadPromptOptions: async () => {
      active.labels[LABEL.steerRole] = "advisor";
      return loader.loadPromptOptions();
    },
  }, { getZerosub: async () => null }), /advisor brief requires verified/);
});

test("Fresh RPC refuses a newly sensitive route immediately before rewind and restores the staged action", async () => {
  const world = makeWorld();
  const [ws] = world.workspaces;
  const { id: agentId } = world.agents[0];
  const stage = { kind: "stage", wakeId: "staged-id", phase: "staged", packet: "pending brief" };
  ws.metadata[AGENTS_KEY] = { [agentId]: { action: stage } };
  const paseo = fakePaseo(world);
  const config = structuredClone(CONFIG);
  const effectReads = [];
  let pages = 0;
  const deps = {
    getScopePublic: async (current) => { effectReads.push(current.metadata.visibility); return current.metadata.visibility; },
    rewindClient: async () => ({
      fetchAgentTimeline: async () => {
        if (++pages === 3) {
          config.profiles.sol.sensitive = true;
          ws.metadata.visibility = false;
        }
        return { entries: [{ item: { type: "user_message", messageId: "point" } }] };
      },
      rewindAgent: async () => assert.fail("rewind must be refused before dispatch"),
      sendMessage: async () => assert.fail("brief must not be sent"),
    }),
  };
  const liveLoader = { ...loader, loadEffectiveConfig: async () => structuredClone(config) };
  const preview = await handlers.previewFresh({ workspaceId: MAIN }, { paseo }, liveLoader, deps);
  assert.equal(preview.refreshMode, "rewind");
  await assert.rejects(handlers.applyFresh({ workspaceId: MAIN, fingerprint: preview.fingerprint, deliver: "stage" },
    { paseo }, liveLoader, deps), /sensitive runtime requires a public scope/);
  assert.deepEqual(effectReads, [false]);
  assert.deepEqual(ws.metadata[AGENTS_KEY][agentId].action, stage);
  assert.equal(world.agents.length, 3);
  assert.deepEqual(world.sent, []);
});

test("Fresh RPC rechecks runtime after a successful rewind before sending the brief", async () => {
  const world = makeWorld();
  const [active] = world.agents;
  const paseo = fakePaseo(world);
  let rewinds = 0;
  const deps = {
    getScopePublic: async () => true,
    rewindClient: async () => ({
      fetchAgentTimeline: async () => ({ entries: [{ item: { type: "user_message", messageId: "point" } }] }),
      rewindAgent: async () => { rewinds++; active.provider = "muse"; },
      sendMessage: async () => assert.fail("brief must not be sent to the new runtime"),
    }),
  };
  const preview = await handlers.previewFresh({ workspaceId: MAIN }, { paseo }, loader, deps);
  const result = await handlers.applyFresh({ workspaceId: MAIN, fingerprint: preview.fingerprint, deliver: "send" },
    { paseo }, loader, deps);
  assert.equal(rewinds, 1);
  assert.equal(result.applied, true);
  assert.equal(result.delivered, false);
  assert.match(result.deliveryError, /verified sanitized brief/);
  assert.equal(result.staged, false);
  assert.equal(result.packet, "");
  assert.equal(world.workspaces[0].metadata[AGENTS_KEY][active.id].action.phase, "staged");
  assert.match(world.workspaces[0].metadata[AGENTS_KEY][active.id].action.packet, /Steer refresh/);
  assert.equal(world.workspaces[0].metadata[METADATA_KEY].epoch, 3);
  assert.deepEqual(world.sent, []);
});

test("Fresh retries journal contention after rewind and returns the staged result", async () => {
  const world = makeWorld();
  const [workspace] = world.workspaces;
  const [active] = world.agents;
  const paseo = fakePaseo(world);
  const ref = paseo.workspaces.ref;
  paseo.workspaces.ref = (id) => {
    const workspace = ref(id);
    return { ...workspace, setMetadata: (patch) => workspace.setMetadata(JSON.parse(JSON.stringify(patch))) };
  };
  let rewinds = 0;
  let lockBusy = false;
  const deps = {
    lock: async (name, run) => {
      if (lockBusy) {
        lockBusy = false;
        throw new LockBusy(`Workspace lock ${name} is held by another process`);
      }
      return run({ verify() {} });
    },
    rewindClient: async () => ({
      fetchAgentTimeline: async () => ({ entries: [{ item: { type: "user_message", messageId: "point" } }] }),
      rewindAgent: async () => { rewinds++; lockBusy = true; },
      sendMessage: async () => assert.fail("the staged brief must not be sent"),
    }),
  };
  const preview = await handlers.previewFresh({ workspaceId: MAIN }, { paseo }, loader, deps);
  assert.equal(preview.refreshMode, "rewind");
  const result = await handlers.applyFresh({ workspaceId: MAIN, fingerprint: preview.fingerprint, deliver: "stage" },
    { paseo }, loader, deps);
  const action = workspace.metadata[AGENTS_KEY][active.id].action;
  assert.equal(rewinds, 1);
  assert.equal(result.applied, true);
  assert.equal(result.delivered, false);
  assert.equal(result.staged, true);
  assert.equal(result.stagingError, null);
  assert.equal(result.stageId, action.wakeId);
  assert.equal(action.phase, "staged");
  assert.equal(action.facts.refreshed.messageId, "point");
  assert.equal(workspace.metadata[METADATA_KEY].epoch, 3);
  assert.equal(world.agents.length, 3);
  assert.deepEqual(world.sent, []);
});

test("Fresh reports an applied rewind if its journal cannot be settled", async () => {
  const world = makeWorld();
  const [workspace] = world.workspaces;
  const [active] = world.agents;
  const paseo = fakePaseo(world);
  let rewinds = 0;
  const deps = {
    lock: async (_name, run) => {
      if (rewinds) throw new Error("Factory journal unavailable");
      return run({ verify() {} });
    },
    rewindClient: async () => ({
      fetchAgentTimeline: async () => ({ entries: [{ item: { type: "user_message", messageId: "point" } }] }),
      rewindAgent: async () => { rewinds++; },
    }),
  };
  const preview = await handlers.previewFresh({ workspaceId: MAIN }, { paseo }, loader, deps);
  const result = await handlers.applyFresh({ workspaceId: MAIN, fingerprint: preview.fingerprint, deliver: "stage" },
    { paseo }, loader, deps);
  assert.equal(rewinds, 1);
  assert.equal(result.applied, true);
  assert.equal(result.refreshMode, "rewind");
  assert.equal(result.staged, false);
  assert.match(result.stagingError, /Rewind applied.*Factory journal unavailable/);
  assert.equal(workspace.metadata[AGENTS_KEY][active.id].action.phase, "rewinding");
  assert.equal(world.agents.length, 3);
});

test("steer creation reports a missing slot before looking up the workspace", async () => {
  const world = makeWorld();
  await assert.rejects(handlers.applySteerAddRpc(
    { workspaceId: MAIN, fingerprint: "confirmation-without-slot" }, { paseo: fakePaseo(world) }, loader,
  ), /Steer creation requires a slot/);
  assert.equal(world.agents.length, 3);
});

test("steer creation preview binds discovery, preferences and revision to one settings state", async () => {
  const world = makeWorld();
  const paseo = fakePaseo(world);
  const values = { profiles: structuredClone(CONFIG.profiles), slots: { ...CONFIG.steers.slots },
    prepare: [...CONFIG.steers.prepare], initialActive: CONFIG.steers.initialActive,
    workerPriority: [...CONFIG.workers.priority], githubOwner: "example", checkoutRoot: ROOT,
    quota: { exhaustedPct: 90, warnPct: 70 } };
  let reads = 0;
  const settings = { read: async () => {
    reads++;
    const snapshot = structuredClone(values);
    if (reads > 1) snapshot.profiles.sol.model = "changed-elsewhere";
    return { status: "ready", revision: `r${reads}`, values: snapshot };
  } };
  const out = await handlers.previewSteerAdd({ repo: SCOPE, slot: "C", spec: "sol" },
    { paseo }, createConfigLoader(settings), settings, async () => null);
  assert.equal(reads, 1);
  assert.equal(out.revision, "r1");
  assert.equal(out.model, "gpt-6.2-sol");
  assert.deepEqual(out.values, values, "a one-run creation returns the original host preferences");
  assert.equal(out.values.slots.C, undefined);
  await assert.rejects(handlers.applySteerAddRpc({ workspaceId: MAIN, slot: "C", spec: "sol",
    fingerprint: out.fingerprint, revision: out.revision }, { paseo }, createConfigLoader(settings), settings), /settings changed/);
  assert.equal(world.agents.length, 3, "preview creates no agent");
  assert.equal(world.sent.length, 0);
});

test("steer creation preview and apply refuse a sensitive profile when scope visibility is unknown", async () => {
  const world = makeWorld();
  const paseo = fakePaseo(world);
  const config = structuredClone(CONFIG);
  config.profiles.sol.sensitive = true;
  const values = { profiles: structuredClone(config.profiles), slots: { ...config.steers.slots },
    prepare: [...config.steers.prepare], initialActive: config.steers.initialActive,
    workerPriority: [...config.workers.priority], githubOwner: "example", checkoutRoot: ROOT,
    quota: { exhaustedPct: 90, warnPct: 70 } };
  const settings = { read: async () => ({ status: "ready", revision: "r1", values }) };
  const preview = await handlers.previewSteerAdd({ repo: SCOPE, slot: "C", spec: "sol" },
    { paseo }, createConfigLoader(settings), settings, async () => null);
  assert.equal(preview.profile, null);
  assert.equal(preview.fingerprint, null);
  assert.match(preview.text, /scope publicity is unknown; public scope required/);

  await assert.rejects(handlers.applySteerAddRpc({ repo: SCOPE, slot: "C", spec: "sol", fingerprint: "old" },
    { paseo }, { loadEffectiveConfig: async () => config }), /public scope required/);
  assert.equal(world.agents.length, 3);
});

test("steer add serializes competing confirmations and reuses an archived letter with a new key", async () => {
  const world = makeWorld();
  const paseo = fakePaseo(world);
  world.agents[1].labels = {};
  world.agents[1].status = "closed";
  const values = { profiles: structuredClone(CONFIG.profiles), slots: { ...CONFIG.steers.slots, C: "sonnet" },
    prepare: [...CONFIG.steers.prepare], initialActive: CONFIG.steers.initialActive,
    workerPriority: [...CONFIG.workers.priority], githubOwner: "example", checkoutRoot: ROOT,
    quota: { exhaustedPct: 90, warnPct: 70 } };
  const original = structuredClone(values);
  const settings = { read: async () => ({ status: "ready", revision: "r1", values }) };
  const configLoader = createConfigLoader(settings);
  const receipts = new Map();
  const readZerosub = async () => null;
  const lookupReceipt = async (_, key) => receipts.get(key) ?? null;
  const deps = { lookupReceipt, readZerosub, getZerosub: readZerosub };
  const preview = (spec) => handlers.previewSteerAdd(
    { workspaceId: MAIN, spec }, { paseo }, configLoader, settings, readZerosub,
  );
  const apply = (spec, plan) => handlers.applySteerAddRpc(
    { workspaceId: MAIN, slot: plan.slot, spec, fingerprint: plan.fingerprint, revision: plan.revision },
    { paseo }, configLoader, settings, deps,
  );
  const firstPlan = await preview("sol");
  const secondPlan = await preview("sonnet");
  assert.equal(firstPlan.slot, "C");
  assert.equal(secondPlan.slot, "C");
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const writes = [];
  world.createAgent = async (workspaceId, req) => {
    const existing = receipts.get(req.idempotencyKey);
    if (existing) throw new Error("Live replay should use the receipt directly");
    writes.push(req);
    if (writes.length === 1) {
      entered.resolve();
      await release.promise;
    }
    const [provider, model] = req.config.provider.split("/");
    const agent = { id: `steer-created-${writes.length}`, workspaceId, provider, model, title: req.title, labels: req.labels, metadata: req.metadata };
    world.agents.push(agent);
    receipts.set(req.idempotencyKey, { phase: "completed", idempotencyKey: req.idempotencyKey, agentId: agent.id });
    if (writes.length === 1) {
      throw new Error("Connection lost after native creation completed");
    }
    return { refresh: async () => ({ agent }) };
  };

  const running = apply("sol", firstPlan);
  await Promise.race([entered.promise, running]);
  try {
    await assert.rejects(apply("sonnet", secondPlan), /lock .*held by another process/);
  } finally {
    release.resolve();
  }
  await assert.rejects(running, /Connection lost after native creation completed/);
  const created = world.agents.at(-1);
  assert.equal(world.workspaces[0].metadata[`${METADATA_KEY}.steer-add-pending`].key, writes[0].idempotencyKey);
  const replay = await apply("sol", firstPlan);
  assert.equal(replay.reused, true);
  assert.equal(replay.agentId, created.id);
  assert.equal(world.workspaces[0].metadata[`${METADATA_KEY}.steer-add-pending`], null);
  await assert.rejects(apply("sonnet", secondPlan), /already occupied by live steer/);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].metadata[LABEL.steerRole], "coordinator");
  assert.equal(writes[0].metadata["zerosub.account"], undefined);

  created.archivedAt = "2026-11-26T20:00:00Z";
  const replacement = await preview("sol");
  assert.equal(replacement.slot, "C");
  assert.notEqual(replacement.fingerprint, firstPlan.fingerprint);
  await assert.rejects(apply("sol", firstPlan), /Something changed since the steer-add preview/);
  const applied = await apply("sol", replacement);
  assert.notEqual(applied.agentId, created.id);
  assert.notEqual(writes[1].idempotencyKey, writes[0].idempotencyKey);
  assert.deepEqual(values, original);
  assert.equal(world.workspaces[0].metadata[METADATA_KEY].activeSteer, "A");
  assert.equal(world.sent.length, 0);
});

test("steer add replays legacy pins and sends the recorded unpinned request for new receipts", async () => {
  const world = makeWorld();
  const paseo = fakePaseo(world);
  const settings = { read: async () => ({ status: "ready", revision: "r1", values: {
    profiles: CONFIG.profiles, slots: CONFIG.steers.slots, prepare: CONFIG.steers.prepare,
    initialActive: CONFIG.steers.initialActive, workerPriority: CONFIG.workers.priority,
    githubOwner: "example", checkoutRoot: ROOT, quota: { exhaustedPct: 90, warnPct: 70 },
  } }) };
  const configLoader = createConfigLoader(settings);
  const readZerosub = async () => null;
  const preview = await handlers.previewSteerAdd({ workspaceId: MAIN, spec: "sol" },
    { paseo }, configLoader, settings, readZerosub);
  const legacy = buildSteerCreate({
    keyScope: preview.repo, repo: preview.repo, scopeId: preview.scope, slot: preview.slot,
    workspaceId: MAIN, profile: CONFIG.profiles.sol, keyParts: ["steer", preview.slot, "g1"],
  });
  const oldFingerprint = steerAddFingerprint({
    repo: preview.repo, scope: preview.scope, workspaceId: MAIN, slot: preview.slot, profile: "sol",
    provider: preview.provider, model: preview.model, thinking: null, mode: "full-access", advisor: false,
  });
  const newKey = preview.text.match(/\[(wsf:[^\]]+)\]/)[1];
  for (const [fingerprint, key, expectedMetadata] of [
    [oldFingerprint, legacy.idempotencyKey, { "zerosub.account": "old-pin" }],
    [preview.fingerprint, newKey, { [LABEL.steerRole]: "coordinator" }],
  ]) {
    // A completed receipt can be visible before the new tab appears in the list.
    const agent = { id: "receipt-agent", workspaceId: MAIN, title: legacy.request.title, labels: legacy.request.labels,
      provider: preview.provider, model: preview.model, metadata: { ...expectedMetadata, "zerosub.account": "old-pin" } };
    const lookupReceipt = async (_, idempotencyKey) => idempotencyKey === key
      ? { idempotencyKey, phase: "completed", agentId: agent.id, agent }
      : null;
    const writes = [];
    world.createAgent = async (_, req) => {
      writes.push(req);
      assert.equal(req.idempotencyKey, key);
      assert.deepEqual(req.metadata, expectedMetadata);
      return { refresh: async () => ({ agent }) };
    };
    const result = await handlers.applySteerAddRpc({ workspaceId: MAIN, slot: preview.slot, spec: "sol", fingerprint,
      revision: preview.revision }, { paseo }, configLoader, settings, { lookupReceipt, readZerosub });
    assert.equal(result.reused, true);
    assert.equal(result.agentId, agent.id);
    assert.equal(writes.length, 1);
  }
});

test("workspace status counts queued wakes from completed workers", async () => {
  const world = makeWorld();
  world.workspaces[0].metadata[WORKERS_KEY]["w-done"] = {
    id: "w-done", state: "done", pendingWake: { state: "done", queuedAt: "2026-11-26T18:01:00Z" },
  };
  const status = await handlers.getStatus({ workspaceId: MAIN }, { paseo: fakePaseo(world) }, loader);
  assert.equal(status.pendingWorkerWakeCount, 1);
  assert.ok(status.openWorkers.every((worker) => worker.id !== "w-done"));
});

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
  const paseo = fakePaseo(world);
  const quotaSource = { zerosub: { accounts: [{ id: "acc-live", family: "codex", maxUsedPct: 94 }], agentAccount: { "steer-a": "acc-live" }, pending: {} } };
  const res = await handlers.getResume({ repo: SCOPE, agentId: "steer-a" }, { paseo }, loader, quotaSource);
  assert.match(res.brief, /Worker model: codex\/gpt-6\.2-sol/);
  assert.equal(res.openWorkers.length, 1);
  assert.equal(res.openWorkers[0].id, "w-live");
  const line = /^Quota: codex \(acc-live\) 94% used$/m;
  assert.match(res.brief, line);
  assert.match(await handlers.createResumeBriefBuilder(loader, quotaSource)(paseo, MAIN, "steer-a"), line);
});

test("pickWorker, listWorkersModels and startWorkerRpc agree and record --failed", async () => {
  const world = makeWorld();
  const paseo = fakePaseo(world);
  // No live ZeroSub state: worker selection must be deterministic in tests.
  const noZerosub = { getZerosub: async () => null, lookupReceipt: async () => null };
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

test("workspace Resources binds an exact enrolled workspace even with shared paths and scope IDs", async () => {
  const world = makeWorld();
  world.providers[0].label = "Codex";
  world.providers[0].models[0].label = "GPT-6.2 Sol";
  world.providers[0].models[0].description = "private-catalog-details";
  world.providers[1].models[0].label = "personal@example.com";
  const [workspace] = world.workspaces;
  const otherId = "wks_other";
  const other = structuredClone(workspace);
  other.id = otherId;
  other.metadata[PROFILE_HEALTH_KEY] = {
    sol: { class: "foreign-diagnostic", unhealthyUntil: "2099-11-26T23:00:00Z" },
  };
  const retired = { ...workspace, id: "wks_retired", metadata: {
    [METADATA_KEY]: { ...workspace.metadata[METADATA_KEY], retired: true },
  } };
  world.workspaces.push(other, retired, { ...workspace, id: "wks_unenrolled", metadata: {} });
  world.agents.push({ ...world.agents[0], id: "foreign-agent", workspaceId: otherId, provider: "foreign-provider" });
  const now = Date.now();
  const account = (id, family) => ({
    id, family, auth: "subscription", label: "personal@example.com", sampledAt: new Date(now).toISOString(),
    windows: [{ id: "private-window-id", usedPct: 12, resetsAt: new Date(now + 60_000).toISOString() }],
  });
  const zerosub = {
    accounts: [account("private-codex-id", "codex"), account("foreign-account-id", "foreign-provider")],
    agentAccount: { "steer-a": "private-codex-id", "foreign-agent": "foreign-account-id" },
    pending: {},
  };
  const before = structuredClone(world);
  const context = { paseo: fakePaseo(world) };
  const read = (workspaceId) => handlers.getWorkspaceResources({ workspaceId }, context, loader, {
    getZerosub: async () => zerosub,
  });
  const view = await read(MAIN);
  assert.deepEqual(factoryWorkspaceResources.output.parse(view), view);
  assert.equal(view.workspaceId, MAIN);
  assert.deepEqual(view.pools.map(({ provider }) => provider).sort(), ["claude", "codex"]);
  assert.equal(view.pools.find(({ provider }) => provider === "codex").providerLabel, "Codex");
  assert.deepEqual(view.accounts.map(({ provider }) => provider), ["codex"]);
  assert.equal(view.accounts[0].alias, "Subscription 1");
  assert.equal(view.accounts[0].windows[0].usedPct, 12);
  assert.equal(view.accounts[0].windows[0].alias, "Window 1");
  assert.equal(view.workerSelection.candidates[0].modelLabel, "GPT-6.2 Sol");
  assert.equal(view.workerSelection.candidates[1].modelLabel, null);
  assert.deepEqual(view.workerSelection.candidates[0].decision, {
    state: "selected", accountAlias: view.accounts[0].alias,
  });
  assert.doesNotMatch(JSON.stringify(view), /wks_other|foreign-|private-codex-id|personal@|private-window-id|private-catalog-details/);

  const otherView = await read(otherId);
  assert.equal(otherView.workspaceId, otherId);
  assert.ok(otherView.accounts.some(({ provider }) => provider === "foreign-provider"));
  assert.deepEqual(otherView.workerSelection.candidates.map(({ decision }) => decision), [
    { state: "excluded", reason: "recent-failure" }, { state: "selected", accountAlias: null },
  ]);
  assert.doesNotMatch(JSON.stringify(otherView), /foreign-diagnostic|foreign-agent|foreign-account-id/);
  assert.throws(() => factoryWorkspaceResources.input.parse({ repo: SCOPE }));
  for (const id of [SCOPE, "wks_unknown", "wks_unenrolled", "wks_retired"]) {
    await assert.rejects(read(id), /require an enrolled, active Factory workspace/);
  }
  assert.deepEqual(world, before);
});

test("workspace Resources reports the scoped worker decision and leaves later alternatives unevaluated", async () => {
  const world = makeWorld();
  const sol = CONFIG.profiles.sol;
  const config = {
    ...CONFIG,
    profiles: {
      ...CONFIG.profiles,
      sensitive: { ...sol, sensitive: true },
      unsupported: { ...sol, thinking: "catalog-detail" },
      late: { ...sol, sensitive: true },
    },
    workers: { priority: ["sensitive", "unsupported", "sol", "late", "sonnet"] },
  };
  const zerosub = {
    accounts: [{ id: "synthetic-claude", family: "claude", exhausted: true, windows: [] }],
    agentAccount: {}, pending: {},
  };
  const context = { paseo: fakePaseo(world) };
  const selectionLoader = { ...loader, loadEffectiveConfig: async () => config };
  const source = { getZerosub: async () => zerosub };
  const input = { workspaceId: MAIN };
  const view = await handlers.getWorkspaceResources(input, context, selectionLoader, source);
  const cli = await handlers.pickWorker(input, context, selectionLoader, source);
  assert.equal(view.workerSelection.scopeVisibility, "unknown");
  assert.deepEqual(view.workerSelection.candidates.map(({ decision }) => decision), [
    { state: "excluded", reason: "scope-requires-public" },
    { state: "excluded", reason: "catalog-rejected" },
    { state: "selected", accountAlias: null },
    { state: "unevaluated" },
    { state: "unevaluated" },
  ]);
  assert.equal(view.workerSelection.candidates.find(({ decision }) => decision.state === "selected").profile, cli.profile);
  assert.doesNotMatch(JSON.stringify(view), /catalog-detail|synthetic-claude/);

  zerosub.accounts.push({ id: "synthetic-limit", family: "codex", exhausted: true, windows: [] });
  const limited = await handlers.getWorkspaceResources(input, context, selectionLoader, source);
  assert.ok(limited.workerSelection.candidates.every(({ decision }) => decision.state === "excluded"));
  assert.ok(limited.workerSelection.candidates.every(({ decision }) => decision.reason === "accounts-exhausted"));
  assert.ok(limited.accounts.every(({ limited, limitedUntil }) => limited && limitedUntil === null));
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

test("Fresh RPC binds the requested route and rechecks live options before creation", async () => {
  const world = makeWorld();
  const [source] = world.agents;
  const paseo = fakePaseo(world);
  const scope = { workspaceId: MAIN };
  const input = { ...scope, provider: "claude", model: "claude-sonnet" };
  let changed = false;
  let lookups = 0;
  const deps = {
    zerosub: null,
    rewindClient: async () => ({ fetchAgentTimeline: async () => ({ entries: [] }) }),
    lookupFreshReceipt: async () => {
      if (changed && ++lookups === 2) source.options = { service_tier: "fast" };
      return null;
    },
    freshPaseoCli: () => assert.fail("the old tab must stay intact"),
  };
  const preview = await handlers.previewFresh(input, { paseo }, loader, deps);
  assert.equal(preview.model, "claude-sonnet");
  assert.equal(preview.refreshMode, "new-agent");
  await assert.rejects(handlers.applyFresh({ ...scope, fingerprint: preview.fingerprint }, { paseo }, loader, deps), /Something changed/);
  changed = true;
  await assert.rejects(handlers.applyFresh({ ...input, fingerprint: preview.fingerprint }, { paseo }, loader, deps), /Something changed/);
  assert.equal(world.agents.length, 3);
  assert.equal(world.workspaces[0].metadata[METADATA_KEY].epoch, 3);
  assert.equal(world.workspaces[0].metadata[AGENTS_KEY], undefined);
});

test("Fresh RPC confirms Worker replacement and carries the requested provider and model", async () => {
  const world = makeWorld();
  const worker = world.agents[2];
  const paseo = fakePaseo(world);
  const handle = paseo.workspaces.ref;
  const created = [];
  paseo.workspaces.ref = (id) => {
    const ref = handle(id);
    ref.agents.create = async (request) => {
      created.push(request);
      const [provider, model] = request.config.provider.split("/");
      const agent = {
        id: "worker-replaced", workspaceId: id, status: "idle", title: request.title,
        provider, model, labels: { ...request.labels, [PARENT_LABEL]: request.parent },
      };
      world.agents.push(agent);
      return { refresh: async () => ({ agent }) };
    };
    return ref;
  };
  const deps = {
    zerosub: null,
    rewindClient: async () => ({ fetchAgentTimeline: async () => ({ entries: [] }) }),
    lookupFreshReceipt: async () => null,
  };
  const input = { workspaceId: MAIN, workerId: worker.id, provider: "claude", model: "claude-sonnet" };
  const preview = await handlers.previewFresh(input, { paseo }, loader, deps);
  const result = await handlers.applyFresh({ ...input, fingerprint: preview.fingerprint, notifyPrevious: false },
    { paseo }, loader, deps);
  assert.equal(result.applied, true);
  assert.equal(result.to, "worker-replaced");
  assert.equal(result.epoch, 3);
  assert.equal(created.length, 1);
  assert.equal(created[0].config.provider, "claude/claude-sonnet");
  assert.equal(created[0].labels[LABEL.owner], "A");
  assert.equal(created[0].parent, "steer-a");
});
