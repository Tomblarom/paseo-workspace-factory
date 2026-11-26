// Turn, continuation and delivery tests with a fake Paseo client.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-resolve-hooks.mjs", import.meta.url);

const { handleTurnAfter, handleTurnBefore, adoptContinuation, reportContinuationAssignment } = await import("../server/turn-hook.ts");
const { runBootCheck } = await import("../server/boot-check.ts");
const { flushAllScopes } = await import("../server/supervise.ts");
const { deliverSteer, dispatchAssignmentReport } = await import("../server/steer-delivery.ts");
import { LABEL, METADATA_KEY, PARENT_LABEL } from "../server/core/paseo.mjs";
import { ASSIGNMENT_KEY } from "../server/core/assign.mjs";
import { guardScope } from "../server/core/scope-guard.mjs";
import { resolveScopeMembers } from "../server/core/discovery.mjs";
import { AGENTS_KEY } from "../server/core/agent-state.mjs";
import { normalizeZerosubState } from "../server/core/zerosub.mjs";
import { newSteerAction } from "../server/core/steer-action.mjs";

const REPO = "example-owner/example-repo";

function makeWorld() {
  return { workspaces: [], agents: [], timelines: {}, calls: [], seq: 0 };
}

function addWorkspace(world, { metadata }) {
  const ws = {
    id: `wks_${String(++world.seq).padStart(4, "0")}`,
    projectId: "prj_1",
    workspaceDirectory: "/p/demo",
    workspaceKind: "local_checkout",
    title: "Main",
    name: "Main",
    metadata: structuredClone(metadata),
    createdAt: "2026-11-23T12:00:00.000Z",
  };
  world.workspaces.push(ws);
  return ws;
}

function addAgent(world, fields) {
  const agent = {
    id: `agent-${++world.seq}`,
    provider: "claude",
    model: "m",
    status: "idle",
    archivedAt: null,
    labels: {},
    metadata: {},
    title: null,
    workspaceId: null,
    activeTurn: null,
    pendingPermissions: [],
    updatedAt: "2026-11-24T11:59:00.000Z",
    lastUserMessageAt: null,
    ...fields,
  };
  world.agents.push(agent);
  return agent;
}

function fakeClient(world) {
  const findWs = (id) => world.workspaces.find((w) => w.id === id) ?? null;
  const findAgent = (id) => world.agents.find((a) => a.id === id) ?? null;
  const page = (entries) => ({ entries: structuredClone(entries), pageInfo: { hasMore: false } });
  return {
    projects: { list: async () => ({ projects: [] }) },
    workspaces: {
      list: async () => page(world.workspaces),
      ref: (id) => ({
        refresh: async () => structuredClone(findWs(id)),
        setMetadata: async (patch) => {
          world.calls.push(["workspace.setMetadata", id, structuredClone(patch)]);
          Object.assign(findWs(id).metadata, structuredClone(patch));
        },
      }),
    },
    agents: {
      list: async () => page(world.agents),
      ref: (id) => ({
        refresh: async () => {
          const agent = findAgent(id);
          return agent ? { agent: structuredClone(agent) } : null;
        },
        send: async (text, options) => {
          if (world.sendFails) throw new Error("send failed");
          world.receipts ??= new Set();
          if (options?.messageId && world.receipts.has(options.messageId)) return;
          world.calls.push(["agent.send", id, text]);
          if (options?.messageId) world.receipts.add(options.messageId);
          if (world.lostSendResponse) { world.lostSendResponse = false; throw new Error("response lost"); }
        },
        setMetadata: async (patch) => {
          world.calls.push(["agent.setMetadata", id, structuredClone(patch)]);
          Object.assign(findAgent(id).metadata, structuredClone(patch));
        },
        timeline: {
          refetch: async () => ({ entries: structuredClone(world.timelines[id] ?? []) }),
        },
      }),
    },
    providers: { snapshot: async () => ({ entries: [] }) },
  };
}

const sendsTo = (world, id) => world.calls.filter((c) => c[0] === "agent.send" && c[1] === id).map((c) => c[2]);

function scopeMeta({ agents = {} } = {}) {
  const meta = { [METADATA_KEY]: { main: true, activeSteer: "A", epoch: 3, scope: { id: REPO, kind: "github", locator: REPO } } };
  if (Object.keys(agents).length) meta[AGENTS_KEY] = structuredClone(agents);
  return meta;
}

function provisioned(world, { agents } = {}) {
  const ws = addWorkspace(world, { metadata: scopeMeta({ agents }) });
  const steers = {
    A: addAgent(world, { title: "Steer A", workspaceId: ws.id, labels: { [LABEL.repo]: REPO, [LABEL.role]: "steer", [LABEL.slot]: "A", [LABEL.scope]: REPO } }),
    B: addAgent(world, { title: "Steer B", workspaceId: ws.id, labels: { [LABEL.repo]: REPO, [LABEL.role]: "steer", [LABEL.slot]: "B", [LABEL.scope]: REPO } }),
  };
  return { ws, steers };
}

function checkpointOf(task, status) {
  return ["```text", "CHECKPOINT", `- task: ${task}`, "- tests: npm test", "- blockers: none", "- next: ship", ...(status ? [`- status: ${status}`] : []), "```"].join("\n");
}

function setTurn(world, agentId, assistantText) {
  world.timelines[agentId] = [
    { turnId: "t1", item: { type: "user_message", text: "do it" } },
    { turnId: "t1", item: { type: "assistant_message", text: assistantText } },
  ];
}

const config = {
  profiles: { sonnet: { provider: "claude", model: "s" } },
  steers: { slots: { A: "sonnet", B: "sonnet" } },
  quota: { warnPct: 75, exhaustedPct: 90 },
};

function zerosubFor(steers, pctA, pctB = 20) {
  const account = (id, pct) => ({
    id, family: "claude", label: id, kind: "oauth", plan: "pro",
    status: "active", isDefault: false, limitedUntil: null,
    usage: { fetchedAt: new Date(Date.now() - 60_000).toISOString(), windows: [{ id: "five_hour", label: "5h", usedPercent: pct, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }], cached: false },
    agentCount: 1,
  });
  const route = (agentId, accountId) => ({ agentId, family: "claude", accountId, pinned: false, pendingAccountId: null, movable: true });
  return normalizeZerosubState({
    accounts: [account("acc-a", pctA), account("acc-b", pctB)],
    agents: [route(steers.A.id, "acc-a"), route(steers.B.id, "acc-b")],
  });
}

async function completedSteerTurn(world, steers, deps) {
  setTurn(world, steers.A.id, checkpointOf("ship it", null));
  await handleTurnAfter(
    { agent: { id: steers.A.id }, turnId: "t1", outcome: { kind: "completed" } },
    { paseo: fakeClient(world) },
    deps,
  );
}

const noLock = async (_name, fn) => fn({ verify() {} });
const turnDeps = (world) => ({
  lock: noLock,
  zerosub: null,
  setContinuationLabels: async (id, labels) => {
    world.calls.push(["agent.labels", id, structuredClone(labels)]);
    Object.assign(world.agents.find((agent) => agent.id === id).labels, labels);
  },
});
const finish = (world, agent) => handleTurnAfter(
  { agent: { id: agent.id }, turnId: "t1", outcome: { kind: "completed" } },
  { paseo: fakeClient(world) },
  turnDeps(world),
);

test("turn end adopts a continuation chain and only its live end holds authority", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  ws.metadata[METADATA_KEY].activeAgentId = steers.A.id;
  steers.A.status = "error";
  const middle = addAgent(world, { workspaceId: ws.id, labels: { "zerosub.continued-from": steers.A.id } });
  const live = addAgent(world, { workspaceId: ws.id, title: "Steer 3", labels: { "zerosub.continued-from": middle.id } });
  setTurn(world, live.id, checkpointOf("continued", "done"));
  const members = resolveScopeMembers({ agents: world.agents, workspaces: world.workspaces }, {
    mainWorkspace: ws, matchKeys: [REPO], labelledFound: [steers.A], scopeName: REPO, projectIds: new Set(),
  });
  assert.deepEqual(members.digitCandidates, []);
  live.title = "Steer A";
  const legacy = resolveScopeMembers({ agents: world.agents, workspaces: world.workspaces }, {
    mainWorkspace: ws, matchKeys: [REPO], labelledFound: [steers.A], scopeName: REPO, projectIds: new Set(),
  });
  assert.deepEqual(legacy.legacy, []);
  await finish(world, live);
  assert.equal(live.labels[LABEL.role], "steer");
  assert.equal(live.labels[LABEL.slot], "A");
  assert.equal(ws.metadata[`${METADATA_KEY}.checkpoint`].task, "continued");
  const guard = { client: fakeClient(world), held: { verify() {} }, workspaceId: ws.id, scopeId: REPO, epoch: 3, agentId: steers.A.id };
  await assert.rejects(guardScope(guard), /Active steer changed/);
  assert.equal((await guardScope({ ...guard, agentId: live.id })).holder.id, live.id);
  await finish(world, live);
  assert.equal(world.calls.filter(([kind]) => kind === "agent.labels").length, 1);
});

test("archived, parented, wrong-workspace and cyclic continuations are not adopted", async () => {
  for (const kind of ["archived", "parent", "workspace", "cycle"]) {
    const world = makeWorld();
    const { ws, steers } = provisioned(world);
    const live = addAgent(world, {
      workspaceId: kind === "workspace" ? "elsewhere" : ws.id,
      archivedAt: kind === "archived" ? "2026-01-01" : null,
      labels: { "zerosub.continued-from": kind === "cycle" ? "loop" : steers.A.id, ...(kind === "parent" ? { [PARENT_LABEL]: "parent" } : {}) },
    });
    if (kind === "cycle") addAgent(world, { id: "loop", workspaceId: ws.id, labels: { "zerosub.continued-from": live.id } });
    setTurn(world, live.id, checkpointOf("bad", "done"));
    await finish(world, live);
    assert.equal(world.calls.filter(([name]) => name === "agent.labels").length, 0, kind);
    assert.equal(ws.metadata[`${METADATA_KEY}.checkpoint`], undefined, kind);
  }
});

test("a worker continuation inherits its factory identity without inheriting the origin's parent", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const origin = addAgent(world, { workspaceId: ws.id, labels: {
    [LABEL.role]: "worker", [LABEL.scope]: REPO, [LABEL.owner]: "A", [PARENT_LABEL]: steers.A.id,
  } });
  const live = addAgent(world, { workspaceId: ws.id, labels: { "zerosub.continued-from": origin.id } });
  setTurn(world, live.id, checkpointOf("worker", "done"));
  await finish(world, live);
  assert.equal(live.labels[LABEL.role], "worker");
  assert.equal(live.labels[LABEL.owner], "A");
  assert.equal(live.labels[PARENT_LABEL], undefined);
  assert.ok(ws.metadata[AGENTS_KEY][live.id]);
});

test("an interrupted first continuation turn is tracked without early adoption", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const live = addAgent(world, { workspaceId: ws.id, labels: { "zerosub.continued-from": steers.A.id } });
  ws.metadata[AGENTS_KEY] = { [steers.A.id]: { lastTurnEndedAt: "2026-01-01T10:00:00Z" } };
  const paseo = fakeClient(world);
  await handleTurnBefore({ agent: { id: live.id }, turnId: "t1" }, { paseo }, {
    ...turnDeps(world), now: () => "2026-01-01T11:00:00Z",
  });
  assert.equal(ws.metadata[AGENTS_KEY][live.id].openTurnId, "t1");
  assert.equal(live.labels[LABEL.role], undefined);
  const marks = await runBootCheck({
    paseo, lock: noLock, getDaemonStartedAt: () => "2026-01-01T12:00:00Z",
    now: () => "2026-01-01T12:01:00Z", readExcerpt: async () => null,
    readGit: () => null, log: () => {},
  });
  assert.ok(marks.some((mark) => mark.agentId === live.id));
  assert.ok(!marks.some((mark) => mark.agentId === steers.A.id));
  assert.equal(ws.metadata[AGENTS_KEY][live.id].interrupted.reason, "daemon-restart");
});

test("boot normalizes a chain and recovers a completed live continuation report", async () => {
  for (const status of ["done", "blocked"]) {
    const world = makeWorld();
    const { ws, steers } = provisioned(world);
    ws.metadata[METADATA_KEY].activeAgentId = steers.A.id;
    steers.A.status = "error";
    const middle = addAgent(world, { workspaceId: ws.id, labels: { "zerosub.continued-from": steers.A.id } });
    const live = addAgent(world, { workspaceId: ws.id, labels: { "zerosub.continued-from": middle.id } });
    const requesterWs = addWorkspace(world, { metadata: { [METADATA_KEY]: { main: true, activeSteer: "A", epoch: 1, scope: { id: "requester/repo", kind: "github", locator: "requester/repo" } } } });
    const requester = addAgent(world, { workspaceId: requesterWs.id, labels: { [LABEL.role]: "steer", [LABEL.slot]: "A", [LABEL.scope]: "requester/repo" } });
    ws.metadata[ASSIGNMENT_KEY] = { by: requester.id, requesterWorkspaceId: requesterWs.id, epoch: 3, at: "assigned", reportedAt: null };
    setTurn(world, middle.id, checkpointOf("superseded", "done"));
    setTurn(world, live.id, checkpointOf("continued", status));
    const deps = turnDeps(world);
    await runBootCheck({
      paseo: fakeClient(world), getDaemonStartedAt: () => null, log: () => {},
      normalizeContinuation: (paseo, agent) => adoptContinuation(paseo, agent, deps),
      reportContinuation: (paseo, agent, scope, config) => reportContinuationAssignment(paseo, agent, scope, config, deps),
    });
    assert.equal(middle.labels[LABEL.role], "steer");
    assert.equal(live.labels[LABEL.role], "steer");
    assert.equal(sendsTo(world, requester.id).length, 1);
    assert.match(sendsTo(world, requester.id)[0], new RegExp(status));
    assert.ok(ws.metadata[ASSIGNMENT_KEY].reportedAt);
  }
});

test("assignment reports follow the requester's active holder, then continuation, then requester", async () => {
  for (const route of ["scope", "continuation", "original"]) {
    const world = makeWorld();
    const { ws, steers } = provisioned(world);
    const source = addWorkspace(world, { metadata: { [METADATA_KEY]: { main: true, activeSteer: "A", epoch: 1, scope: { id: "source/repo", kind: "github", locator: "source/repo" } } } });
    const requester = addAgent(world, { workspaceId: source.id, labels: { [LABEL.role]: "steer", [LABEL.slot]: "A", [LABEL.scope]: "source/repo" } });
    let target = requester;
    if (route !== "original") {
      target = addAgent(world, { workspaceId: source.id, labels: { "zerosub.continued-from": requester.id } });
    }
    if (route === "scope") {
      const active = addAgent(world, { workspaceId: source.id, labels: { [LABEL.role]: "steer", [LABEL.slot]: "B", [LABEL.scope]: "source/repo" } });
      if (route === "scope") target = active;
      source.metadata[METADATA_KEY].activeSteer = "B";
      source.metadata[METADATA_KEY].activeAgentId = active.id;
    }
    ws.metadata[ASSIGNMENT_KEY] = { by: requester.id, requesterWorkspaceId: route === "scope" ? source.id : "missing", epoch: 3, at: "assigned", reportedAt: null };
    setTurn(world, steers.A.id, checkpointOf("done", "done"));
    await finish(world, steers.A);
    await finish(world, steers.A);
    assert.equal(sendsTo(world, target.id).length, 1, route);
  }
});

test("queued reports recover when a busy recipient or another action clears", async () => {
  for (const obstruction of ["busy", "other-action"]) {
    const world = makeWorld();
    const { ws, steers } = provisioned(world);
    const requesterWs = addWorkspace(world, { metadata: { [METADATA_KEY]: { main: true, activeSteer: "A", epoch: 1, scope: { id: "requester/repo", kind: "github", locator: "requester/repo" } } } });
    const requester = addAgent(world, { workspaceId: requesterWs.id, labels: { [LABEL.role]: "steer", [LABEL.slot]: "A", [LABEL.scope]: "requester/repo" } });
    ws.metadata[ASSIGNMENT_KEY] = { by: requester.id, requesterWorkspaceId: requesterWs.id, epoch: 3, at: "assigned", reportedAt: null };
    if (obstruction === "busy") requester.status = "running";
    else requesterWs.metadata[AGENTS_KEY] = { [requester.id]: { action: newSteerAction({ id: "other", epoch: 1, text: "other", phase: "reserved" }) } };
    setTurn(world, steers.A.id, checkpointOf("done", "done"));
    await finish(world, steers.A);
    assert.ok(ws.metadata[ASSIGNMENT_KEY].reportActionId);
    assert.equal(sendsTo(world, requester.id).length, 0);
    if (obstruction === "busy") requester.status = "idle";
    else requesterWs.metadata[AGENTS_KEY][requester.id].action.phase = "done";
    await flushAllScopes(fakeClient(world), { lock: noLock, bootCheckDone: true, settings: { enabled: false }, delivery: { zerosub: null } });
    assert.ok(ws.metadata[ASSIGNMENT_KEY].reportedAt);
    assert.equal(sendsTo(world, requester.id).length, 1);
  }
});

test("a report reserved for a previous holder is not silently retargeted", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const requesterWs = addWorkspace(world, { metadata: { [METADATA_KEY]: { main: true, activeSteer: "A", epoch: 1, scope: { id: "requester/repo", kind: "github", locator: "requester/repo" } } } });
  const requester = addAgent(world, { status: "running", workspaceId: requesterWs.id, labels: { [LABEL.role]: "steer", [LABEL.slot]: "A", [LABEL.scope]: "requester/repo" } });
  const successor = addAgent(world, { workspaceId: requesterWs.id, labels: { [LABEL.role]: "steer", [LABEL.slot]: "B", [LABEL.scope]: "requester/repo" } });
  ws.metadata[ASSIGNMENT_KEY] = { by: requester.id, requesterWorkspaceId: requesterWs.id, epoch: 3, at: "assigned", reportedAt: null };
  setTurn(world, steers.A.id, checkpointOf("done", "done"));
  await finish(world, steers.A);
  requester.status = "idle";
  requesterWs.metadata[METADATA_KEY].activeSteer = "B";
  requesterWs.metadata[METADATA_KEY].activeAgentId = successor.id;
  requesterWs.metadata[METADATA_KEY].epoch = 2;
  const result = await dispatchAssignmentReport(fakeClient(world), ws.id, { lock: noLock, zerosub: null });
  assert.equal(result.status, "blocked");
  assert.equal(ws.metadata[ASSIGNMENT_KEY].reportedAt, null);
  assert.equal(sendsTo(world, requester.id).length + sendsTo(world, successor.id).length, 0);
});

test("K7 leaves a report for a non-Factory requester queued and explicitly blocked", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const requester = addAgent(world, { workspaceId: "other", labels: {} });
  ws.metadata[ASSIGNMENT_KEY] = { by: requester.id, epoch: 3, at: "assigned", reportedAt: null, reportActionId: "action", reportText: "report" };
  const result = await dispatchAssignmentReport(fakeClient(world), ws.id, { lock: noLock, zerosub: null });
  assert.equal(result.status, "blocked");
  assert.match(result.detail, /not a live Factory steer/);
  assert.equal(ws.metadata[ASSIGNMENT_KEY].reportedAt, null);
  assert.equal(sendsTo(world, requester.id).length, 0);
});

test("an uncertain assignment report is recovered by the sweep without a second delivery", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const source = addWorkspace(world, { metadata: { [METADATA_KEY]: { main: true, activeSteer: "A", epoch: 1, scope: { id: "source/repo", kind: "github", locator: "source/repo" } } } });
  const requester = addAgent(world, { workspaceId: source.id, labels: { [LABEL.role]: "steer", [LABEL.slot]: "A", [LABEL.scope]: "source/repo" } });
  ws.metadata[ASSIGNMENT_KEY] = { by: requester.id, requesterWorkspaceId: source.id, epoch: 3, at: "assigned", reportedAt: null };
  setTurn(world, steers.A.id, checkpointOf("done", "done"));
  world.lostSendResponse = true;
  await finish(world, steers.A);
  assert.equal(ws.metadata[ASSIGNMENT_KEY].reportedAt, null);
  const action = source.metadata[AGENTS_KEY][requester.id].action;
  assert.equal(action.phase, "uncertain");
  assert.equal(action.wakeId, ws.metadata[ASSIGNMENT_KEY].reportActionId);
  await flushAllScopes(fakeClient(world), { lock: noLock, bootCheckDone: true, settings: { enabled: false }, delivery: { zerosub: null } });
  assert.ok(ws.metadata[ASSIGNMENT_KEY].reportedAt);
  assert.equal(sendsTo(world, requester.id).length, 1);
});

test("concurrent dispatchers cannot overwrite an attempted assignment action", async () => {
  const world = makeWorld();
  const { ws } = provisioned(world);
  const requesterWs = addWorkspace(world, { metadata: { [METADATA_KEY]: { main: true, activeSteer: "A", epoch: 1, scope: { id: "requester/repo", kind: "github", locator: "requester/repo" } } } });
  const requester = addAgent(world, { workspaceId: requesterWs.id, labels: { [LABEL.role]: "steer", [LABEL.slot]: "A", [LABEL.scope]: "requester/repo" } });
  ws.metadata[ASSIGNMENT_KEY] = { reportActionId: "action", reportText: "report", reportedAt: null };
  requesterWs.metadata[AGENTS_KEY] = { [requester.id]: { action: {
    ...newSteerAction({ kind: "assignment", id: "action", epoch: 1, text: "report", phase: "reserved" }),
    authority: { scopeId: "requester/repo", agentId: requester.id },
    assignment: { workspaceId: ws.id, actionId: "action" },
  } } };
  const paseo = fakeClient(world);
  const originalRef = paseo.agents.ref;
  let releaseSnapshots;
  const snapshots = new Promise((resolve) => { releaseSnapshots = resolve; });
  let refreshes = 0;
  let releaseSend;
  const sendGate = new Promise((resolve) => { releaseSend = resolve; });
  let enteredSend;
  const sent = new Promise((resolve) => { enteredSend = resolve; });
  let attempts = 0;
  paseo.agents.ref = (id) => {
    const ref = originalRef(id);
    if (id !== requester.id) return ref;
    return {
      ...ref,
      refresh: async () => {
        const snapshot = await ref.refresh();
        if (++refreshes <= 2) {
          if (refreshes === 2) releaseSnapshots();
          await snapshots;
        }
        return snapshot;
      },
      send: async (...args) => { attempts++; enteredSend(); await sendGate; return ref.send(...args); },
    };
  };
  let tail = Promise.resolve();
  const lock = async (_name, fn) => {
    const previous = tail;
    let release;
    tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try { return await fn({ verify() {} }); } finally { release(); }
  };
  const input = { workspaceId: requesterWs.id, agentId: requester.id, epoch: 1, actionId: "action", text: "report" };
  const first = deliverSteer(paseo, input, { lock, zerosub: null });
  const second = deliverSteer(paseo, input, { lock, zerosub: null });
  await sent;
  await Promise.race([first, second, new Promise((resolve) => setTimeout(resolve, 100))]);
  const beforeRelease = requesterWs.metadata[AGENTS_KEY][requester.id].action.phase;
  releaseSend();
  await Promise.all([first, second]);
  assert.equal(beforeRelease, "uncertain");
  assert.equal(attempts, 1);
  assert.equal(sendsTo(world, requester.id).length, 1);
});

test("a worker with no report due does not invoke the scope guard", async () => {
  const world = makeWorld();
  const { ws } = provisioned(world);
  const worker = addAgent(world, { workspaceId: ws.id, labels: { [LABEL.role]: "worker", [LABEL.scope]: REPO, [LABEL.owner]: "A" } });
  ws.metadata[ASSIGNMENT_KEY] = { by: "requester", epoch: 3, at: "assigned", reportedAt: null };
  setTurn(world, worker.id, checkpointOf("worker", "done"));
  const paseo = fakeClient(world);
  let lists = 0;
  const list = paseo.agents.list;
  paseo.agents.list = async (...args) => { lists++; return list(...args); };
  await handleTurnAfter({ agent: { id: worker.id }, turnId: "t1", outcome: { kind: "completed" } }, { paseo }, turnDeps(world));
  assert.equal(lists, 1);
  assert.equal(ws.metadata[ASSIGNMENT_KEY].reportedAt, null);
});

test("a superseded same-slot steer cannot save a scope checkpoint", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const newer = addAgent(world, { title: "Steer A", workspaceId: ws.id, labels: { [LABEL.scope]: REPO, [LABEL.role]: "steer", [LABEL.slot]: "A" } });
  ws.metadata[METADATA_KEY].activeAgentId = newer.id;
  await completedSteerTurn(world, steers, {});
  assert.equal(ws.metadata[`${METADATA_KEY}.checkpoint`], undefined);
});

test("a completed steer turn never sends a quota-only prompt", async () => {
  for (const pct of [74, 75, 89, 90, 99]) {
    const world = makeWorld();
    const { steers } = provisioned(world);
    await completedSteerTurn(world, steers, { getConfig: async () => config, zerosub: zerosubFor(steers, pct) });
    assert.equal(sendsTo(world, steers.A.id).length, 0, `${pct}%`);
    assert.ok(world.calls.some((c) => c[0] === "workspace.setMetadata"), "turn still recorded");
  }
});
