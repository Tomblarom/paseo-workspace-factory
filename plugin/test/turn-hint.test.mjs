// Turn, continuation and delivery tests with a fake Paseo client.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-resolve-hooks.mjs", import.meta.url);

const { handleTurnAfter, handleTurnBefore, adoptContinuation, reportContinuationAssignment } = await import("../server/turn-hook.ts");
const { runBootCheck } = await import("../server/boot-check.ts");
const { flushAllScopes, resetSupervisionForTests, supervisionQuiet } = await import("../server/supervise.ts");
const { deliverSteer, dispatchAssignmentReport, finishSteerDelivery } = await import("../server/steer-delivery.ts");
const { DRAIN_METADATA_KEY } = await import("../shared/supervise.ts");
import { LABEL, METADATA_KEY, PARENT_LABEL } from "../server/core/paseo.mjs";
import { ASSIGNMENT_KEY } from "../server/core/assign.mjs";
import { guardScope } from "../server/core/scope-guard.mjs";
import { resolveScopeMembers } from "../server/core/discovery.mjs";
import { AGENTS_KEY } from "../server/core/agent-state.mjs";
import { normalizeZerosubState } from "../server/core/zerosub.mjs";
import { newSteerAction } from "../server/core/steer-action.mjs";
import { attemptSteerAccountMove } from "../server/core/steer-account-move.mjs";
import { WORKERS_KEY } from "../server/core/supervision.mjs";
import { switchSteer } from "../server/core/steer.mjs";

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
    title: fields.labels?.[LABEL.role] === "steer" ? `Steer ${fields.labels[LABEL.slot]}` : null,
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
          world.sendAttempts = (world.sendAttempts ?? 0) + 1;
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

test("turn.before labels an unlabelled steer tab through the injected writer", async () => {
  const world = makeWorld();
  const { ws } = provisioned(world);
  const candidate = addAgent(world, { title: "Steer C", workspaceId: ws.id, labels: { other: "kept" } });
  const writes = [];
  await handleTurnBefore({ agent: { id: candidate.id }, turnId: "t1" }, { paseo: fakeClient(world) }, {
    ...turnDeps(world),
    setTitleLabels: async (id, labels) => {
      writes.push([id, labels]);
      Object.assign(candidate.labels, labels);
    },
  });
  assert.deepEqual(writes, [[candidate.id, { [LABEL.role]: "steer", [LABEL.slot]: "C", [LABEL.scope]: REPO, [LABEL.repo]: REPO }]]);
  assert.equal(candidate.labels.other, "kept");
  assert.equal(ws.metadata[AGENTS_KEY][candidate.id].openTurnId, "t1");
});

test("boot normalizes a chain and recovers a completed live continuation report", async () => {
  for (const status of ["done", "blocked"]) {
    const world = makeWorld();
    const { ws, steers } = provisioned(world);
    ws.metadata[METADATA_KEY].activeAgentId = steers.A.id;
    steers.A.status = "error";
    const middle = addAgent(world, { workspaceId: ws.id, labels: { "zerosub.continued-from": steers.A.id } });
    const live = addAgent(world, { title: "Steer A", workspaceId: ws.id, labels: { "zerosub.continued-from": middle.id } });
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

function threePendingReports(world, { busy = false } = {}) {
  const requesterWs = addWorkspace(world, { metadata: { [METADATA_KEY]: { main: true, activeSteer: "A", epoch: 1, scope: { id: "requester/repo", kind: "github", locator: "requester/repo" } } } });
  const labels = (slot) => ({ [LABEL.role]: "steer", [LABEL.slot]: slot, [LABEL.scope]: "requester/repo" });
  const requester = addAgent(world, { workspaceId: requesterWs.id, status: busy ? "running" : "idle", labels: labels("A") });
  const successor = addAgent(world, { workspaceId: requesterWs.id, labels: labels("B") });
  const sources = [1, 2, 3].map((n) => addWorkspace(world, { metadata: {
    [METADATA_KEY]: { main: true, activeSteer: "A", epoch: 1, scope: { id: `source/${n}`, kind: "github", locator: `source/${n}` } },
    [ASSIGNMENT_KEY]: { by: requester.id, requesterWorkspaceId: requesterWs.id, epoch: 1,
      reportActionId: `report-${n}`, reportText: `result ${n}`, reportedAt: null },
  } }));
  return { requesterWs, requester, successor, sources };
}

test("three already-pending reports share one turn with independent source receipts", async () => {
  const world = makeWorld();
  const { requester, sources } = threePendingReports(world);
  const deps = { lock: noLock, zerosub: null };
  assert.equal((await dispatchAssignmentReport(fakeClient(world), sources[0].id, deps)).status, "sent");
  assert.equal(sendsTo(world, requester.id).length, 1);
  for (const [index, source] of sources.entries()) {
    assert.match(sendsTo(world, requester.id)[0], new RegExp(`result ${index + 1}`));
    assert.ok(source.metadata[ASSIGNMENT_KEY].reportedAt);
    assert.equal(source.metadata[ASSIGNMENT_KEY].reportActionId, `report-${index + 1}`);
    await dispatchAssignmentReport(fakeClient(world), source.id, deps);
  }
  setTurn(world, requester.id, "interrupted");
  await handleTurnAfter({ agent: { id: requester.id }, turnId: "t1",
    outcome: { kind: "failed", error: { message: "You've hit your 5-hour limit" } } },
  { paseo: fakeClient(world) }, { ...turnDeps(world), getSupervisionSettings: async () => ({ enabled: false }) });
  for (const source of sources) await dispatchAssignmentReport(fakeClient(world), source.id, deps);
  assert.ok(sources.every((source) => source.metadata[ASSIGNMENT_KEY].reportedAt));
  assert.equal(sendsTo(world, requester.id).length, 1);
});

test("reports queued while the holder is busy join its reserved report", async () => {
  const world = makeWorld();
  const { requesterWs, requester, sources } = threePendingReports(world, { busy: true });
  for (const source of sources.slice(1)) source.metadata[ASSIGNMENT_KEY].reportActionId = null;
  const deps = { lock: noLock, zerosub: null };
  await dispatchAssignmentReport(fakeClient(world), sources[0].id, deps);
  sources[1].metadata[ASSIGNMENT_KEY].reportActionId = "report-2";
  sources[2].metadata[ASSIGNMENT_KEY].reportActionId = "report-3";
  requester.status = "idle";
  await finishSteerDelivery(fakeClient(world), { workspaceId: requesterWs.id, agentId: requester.id }, deps);
  assert.equal(sendsTo(world, requester.id).length, 1);
  assert.match(sendsTo(world, requester.id)[0], /result 3/);
  assert.ok(sources.every((source) => source.metadata[ASSIGNMENT_KEY].reportedAt));
});

test("interrupted source bookkeeping retains all batch receipts across an epoch", async () => {
  const world = makeWorld();
  const { requesterWs, requester, successor, sources } = threePendingReports(world);
  const paseo = fakeClient(world);
  const ref = paseo.workspaces.ref;
  let failReceipt = true;
  paseo.workspaces.ref = (id) => {
    const handle = ref(id);
    if (id !== sources[1].id) return handle;
    return { ...handle, setMetadata: async (patch) => {
      if (failReceipt && patch[ASSIGNMENT_KEY]?.reportedAt) { failReceipt = false; throw new Error("source write interrupted"); }
      return handle.setMetadata(patch);
    } };
  };
  const deps = { lock: noLock, zerosub: null };
  await dispatchAssignmentReport(paseo, sources[0].id, deps);
  assert.equal(sendsTo(world, requester.id).length, 1);
  assert.ok(sources[0].metadata[ASSIGNMENT_KEY].reportedAt);
  assert.equal(sources[1].metadata[ASSIGNMENT_KEY].reportedAt, null);
  requesterWs.metadata[METADATA_KEY].activeSteer = "B";
  requesterWs.metadata[METADATA_KEY].activeAgentId = successor.id;
  requesterWs.metadata[METADATA_KEY].epoch = 2;
  await dispatchAssignmentReport(paseo, sources[1].id, deps);
  assert.ok(sources.every((source) => source.metadata[ASSIGNMENT_KEY].reportedAt));
  assert.equal(sendsTo(world, requester.id).length, 1);
  assert.equal(sendsTo(world, successor.id).length, 0);
});

test("an interrupted batch binding is recovered without losing a source", async () => {
  const world = makeWorld();
  const { requester, sources } = threePendingReports(world);
  const paseo = fakeClient(world);
  const ref = paseo.workspaces.ref;
  let failBinding = true;
  paseo.workspaces.ref = (id) => {
    const handle = ref(id);
    if (id !== sources[1].id) return handle;
    return { ...handle, setMetadata: async (patch) => {
      if (failBinding && patch[ASSIGNMENT_KEY]?.reportTarget?.deliveryId) { failBinding = false; throw new Error("binding interrupted"); }
      return handle.setMetadata(patch);
    } };
  };
  const deps = { lock: noLock, zerosub: null };
  await assert.rejects(dispatchAssignmentReport(paseo, sources[0].id, deps), /binding interrupted/);
  assert.equal(sendsTo(world, requester.id).length, 0);
  await dispatchAssignmentReport(paseo, sources[2].id, deps);
  assert.equal(sendsTo(world, requester.id).length, 1);
  assert.ok(sources.every((source) => source.metadata[ASSIGNMENT_KEY].reportedAt));
});

test("a stale caller cannot omit reports added to the reserved batch", async () => {
  const world = makeWorld();
  const { requesterWs, requester, sources } = threePendingReports(world);
  const target = { workspaceId: requesterWs.id, agentId: requester.id, epoch: 1, scopeId: "requester/repo", deliveryId: "report-1" };
  const refs = sources.map((source) => ({ workspaceId: source.id, actionId: source.metadata[ASSIGNMENT_KEY].reportActionId,
    text: source.metadata[ASSIGNMENT_KEY].reportText }));
  for (const source of sources) source.metadata[ASSIGNMENT_KEY].reportTarget = target;
  requesterWs.metadata[AGENTS_KEY] = { [requester.id]: { action: {
    ...newSteerAction({ kind: "assignment", id: "report-1", epoch: 1, phase: "reserved", text: "result 1\nresult 2\nresult 3" }),
    authority: { scopeId: "requester/repo", agentId: requester.id }, assignment: refs[0], assignments: refs,
  } } };
  await deliverSteer(fakeClient(world), { ...target, actionId: "report-1", text: "result 1" }, { lock: noLock, zerosub: null });
  assert.match(sendsTo(world, requester.id)[0], /result 3/);
  assert.ok(sources.every((source) => source.metadata[ASSIGNMENT_KEY].reportedAt));
});

test("an unattempted batch follows the holder across an epoch change", async () => {
  const world = makeWorld();
  const { requesterWs, requester, successor, sources } = threePendingReports(world, { busy: true });
  const deps = { lock: noLock, zerosub: null };
  await dispatchAssignmentReport(fakeClient(world), sources[0].id, deps);
  assert.equal(sendsTo(world, requester.id).length, 0);
  requester.status = "idle";
  requesterWs.metadata[METADATA_KEY].activeSteer = "B";
  requesterWs.metadata[METADATA_KEY].activeAgentId = successor.id;
  requesterWs.metadata[METADATA_KEY].epoch = 2;
  const pending = await finishSteerDelivery(fakeClient(world), { workspaceId: requesterWs.id, agentId: requester.id }, deps);
  assert.equal(pending.status, "pending");
  await dispatchAssignmentReport(fakeClient(world), sources[0].id, deps);
  assert.equal(sendsTo(world, requester.id).length, 0);
  assert.equal(sendsTo(world, successor.id).length, 1);
  assert.ok(sources.every((source) => source.metadata[ASSIGNMENT_KEY].reportedAt));
});

test("an assignment batch keeps its receipts when the successor route becomes an advisor", async () => {
  const world = makeWorld();
  const { requesterWs, requester, successor, sources } = threePendingReports(world, { busy: true });
  const packet = "SYNTHETIC_PRIVATE_REPORT";
  sources[0].metadata[ASSIGNMENT_KEY].reportText = packet;
  const paseo = fakeClient(world);
  const deps = { lock: noLock, zerosub: null, getScopePublic: async () => true };
  await dispatchAssignmentReport(paseo, sources[0].id, deps);
  const oldTarget = structuredClone(sources[0].metadata[ASSIGNMENT_KEY].reportTarget);
  requester.status = "idle";
  requesterWs.metadata[METADATA_KEY].activeSteer = "B";
  requesterWs.metadata[METADATA_KEY].activeAgentId = successor.id;
  requesterWs.metadata[METADATA_KEY].epoch = 2;
  successor.provider = "codex";
  successor.metadata = { [LABEL.steerRole]: "advisor" };

  const held = await dispatchAssignmentReport(paseo, sources[0].id, deps);
  assert.equal(held.status, "pending");
  assert.doesNotMatch(held.detail, /SYNTHETIC_PRIVATE_/);
  assert.deepEqual(sources[0].metadata[ASSIGNMENT_KEY].reportTarget, oldTarget);
  assert.equal(sources[0].metadata[ASSIGNMENT_KEY].reportText, packet);
  assert.ok(sources.every((source) => !source.metadata[ASSIGNMENT_KEY].reportedAt));
  assert.deepEqual(sendsTo(world, successor.id), []);

  successor.metadata = { [LABEL.steerRole]: "coordinator" };
  assert.equal((await dispatchAssignmentReport(paseo, sources[0].id, deps)).status, "sent");
  assert.match(sendsTo(world, successor.id)[0], /SYNTHETIC_PRIVATE_REPORT/);
  assert.equal(sendsTo(world, successor.id).length, 1);
  assert.ok(sources.every((source) => source.metadata[ASSIGNMENT_KEY].reportedAt));
});

test("an uncertain batch recovers every source receipt in its original epoch", async () => {
  const world = makeWorld();
  const { requester, sources } = threePendingReports(world);
  const deps = { lock: noLock, zerosub: null };
  world.lostSendResponse = true;
  await dispatchAssignmentReport(fakeClient(world), sources[0].id, deps);
  assert.ok(sources.every((source) => !source.metadata[ASSIGNMENT_KEY].reportedAt));
  assert.equal((await dispatchAssignmentReport(fakeClient(world), sources[1].id, deps)).status, "sent");
  assert.ok(sources.every((source) => source.metadata[ASSIGNMENT_KEY].reportedAt));
  assert.equal(sendsTo(world, requester.id).length, 1);
});

test("an uncertain batch is not replayed or rebound after an epoch change", async () => {
  const world = makeWorld();
  const { requesterWs, requester, successor, sources } = threePendingReports(world);
  const deps = { lock: noLock, zerosub: null };
  world.lostSendResponse = true;
  await dispatchAssignmentReport(fakeClient(world), sources[0].id, deps);
  assert.equal(sources[1].metadata[ASSIGNMENT_KEY].reportTarget.deliveryId, "report-1");
  requesterWs.metadata[METADATA_KEY].activeSteer = "B";
  requesterWs.metadata[METADATA_KEY].activeAgentId = successor.id;
  requesterWs.metadata[METADATA_KEY].epoch = 2;
  for (const source of sources) {
    const result = await dispatchAssignmentReport(fakeClient(world), source.id, deps);
    assert.equal(result.status, "blocked");
    assert.match(result.detail, /receipt or renewal reconciliation/);
    assert.equal(source.metadata[ASSIGNMENT_KEY].reportTarget.agentId, requester.id);
    assert.equal(source.metadata[ASSIGNMENT_KEY].reportedAt, null);
  }
  assert.equal(sendsTo(world, requester.id).length, 1);
  assert.equal(sendsTo(world, successor.id).length, 0);
  assert.equal(world.sendAttempts, 1);
});

test("an oversized unrelated report does not delay a ready report", async () => {
  const world = makeWorld();
  const { requester, sources } = threePendingReports(world);
  sources[0].metadata[ASSIGNMENT_KEY].reportText = "x".repeat(7000);
  const deps = { lock: noLock, zerosub: null };
  await dispatchAssignmentReport(fakeClient(world), sources[1].id, deps);
  assert.ok(sources[1].metadata[ASSIGNMENT_KEY].reportedAt);
  assert.equal(sources[0].metadata[ASSIGNMENT_KEY].reportedAt, null);
  assert.equal(sendsTo(world, requester.id).length, 1);
});

test("reports for different resolved holders are not combined", async () => {
  const world = makeWorld();
  const { requester, sources } = threePendingReports(world);
  const otherWs = addWorkspace(world, { metadata: { [METADATA_KEY]: { main: true, activeSteer: "A", epoch: 1, scope: { id: "other/repo", kind: "github", locator: "other/repo" } } } });
  const other = addAgent(world, { workspaceId: otherWs.id, labels: { [LABEL.role]: "steer", [LABEL.slot]: "A", [LABEL.scope]: "other/repo" } });
  Object.assign(sources[2].metadata[ASSIGNMENT_KEY], { by: other.id, requesterWorkspaceId: otherWs.id });
  const deps = { lock: noLock, zerosub: null };
  await dispatchAssignmentReport(fakeClient(world), sources[0].id, deps);
  assert.ok(sources[0].metadata[ASSIGNMENT_KEY].reportedAt);
  assert.ok(sources[1].metadata[ASSIGNMENT_KEY].reportedAt);
  assert.equal(sources[2].metadata[ASSIGNMENT_KEY].reportedAt, null);
  assert.doesNotMatch(sendsTo(world, requester.id)[0], /result 3/);
  await dispatchAssignmentReport(fakeClient(world), sources[2].id, deps);
  assert.equal(sendsTo(world, other.id).length, 1);
});

test("an unattempted report follows the new holder after an epoch change", async () => {
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
  assert.equal(result.status, "sent");
  assert.ok(ws.metadata[ASSIGNMENT_KEY].reportedAt);
  assert.equal(sendsTo(world, requester.id).length, 0);
  assert.equal(sendsTo(world, successor.id).length, 1);
});

test("a lone report waits through a hard limit and requests takeover without renewing the recipient", async () => {
  const world = makeWorld();
  const { ws } = provisioned(world);
  const requesterWs = addWorkspace(world, { metadata: { [METADATA_KEY]: { main: true, activeSteer: "A", epoch: 1, scope: { id: "requester/repo", kind: "github", locator: "requester/repo" } } } });
  const labels = (slot) => ({ [LABEL.role]: "steer", [LABEL.slot]: slot, [LABEL.scope]: "requester/repo" });
  const requester = addAgent(world, { workspaceId: requesterWs.id, labels: labels("A") });
  const successor = addAgent(world, { workspaceId: requesterWs.id, labels: labels("B") });
  const now = new Date();
  const limitAt = new Date(now.getTime() - 10_000).toISOString();
  requesterWs.metadata[AGENTS_KEY] = { [requester.id]: { lastTurnEndedAt: new Date(now).toISOString(), needsResume: { reason: "limit", at: limitAt },
    quotaLimit: { at: limitAt, provider: "claude", model: "m", accountId: "acc-a" } } };
  ws.metadata[ASSIGNMENT_KEY] = { by: requester.id, requesterWorkspaceId: requesterWs.id, epoch: 3,
    reportActionId: "report-1", reportText: "completed assignment", reportedAt: null };
  const zerosub = zerosubFor({ A: requester, B: successor }, 5, 5);
  const deps = { lock: noLock, bootCheckDone: true, settings: { enabled: true, answerMinutes: 10, batchMinutes: 10, watchdogMinutes: 15, staleMinutes: 60, maxAutoResumes: 2 },
    getConfig: async () => config, delivery: { zerosub, buildBrief: async () => "brief" } };
  await flushAllScopes(fakeClient(world), deps);
  assert.equal(sendsTo(world, requester.id).length, 0);
  assert.equal(requesterWs.metadata[AGENTS_KEY][requester.id].action, undefined);
  assert.match(sendsTo(world, successor.id)[0], /takeover/i);
  assert.equal(ws.metadata[ASSIGNMENT_KEY].reportedAt, null);
  resetSupervisionForTests();
  await flushAllScopes(fakeClient(world), { ...deps, bootCheckDone: false });
  await flushAllScopes(fakeClient(world), deps);
  assert.equal(sendsTo(world, successor.id).length, 1, "boot recovery preserves the takeover answer window");
  assert.equal(ws.metadata[ASSIGNMENT_KEY].reportedAt, null);
  successor.status = "running";
  const discovery = {
    forkName: "requester/repo",
    scope: { id: "requester/repo", kind: "github", locator: "requester/repo" },
    mainWorkspace: structuredClone(requesterWs),
    steers: { labelled: structuredClone([requester, successor]), legacy: [] },
    workers: [], providers: [],
  };
  const switched = await switchSteer({ client: fakeClient(world), discovery, toSlot: "B",
    callerId: successor.id, apply: true, lock: noLock });
  assert.equal(switched.selfTakeover, true);
  assert.equal(switched.applied, true);
  await assert.rejects(switchSteer({ client: fakeClient(world), discovery, toSlot: "B",
    callerId: successor.id, apply: true, lock: noLock }), /scope state changed since discovery/i);
  assert.equal(requesterWs.metadata[METADATA_KEY].epoch, 2);
  assert.equal(requesterWs.metadata[METADATA_KEY].activeAgentId, successor.id);
  successor.status = "idle";
  await flushAllScopes(fakeClient(world), deps);
  assert.ok(ws.metadata[ASSIGNMENT_KEY].reportedAt);
  assert.equal(sendsTo(world, requester.id).length, 0);
  assert.equal(sendsTo(world, successor.id).length, 2);
});

test("pending reports wait for boot and source or recipient drain, then the sweep delivers", async () => {
  for (const quiet of ["boot", "global", "source", "recipient"]) {
    const world = makeWorld();
    const { ws } = provisioned(world);
    const requesterWs = addWorkspace(world, { metadata: { [METADATA_KEY]: { main: true, activeSteer: "A", epoch: 1, scope: { id: "requester/repo", kind: "github", locator: "requester/repo" } } } });
    const requester = addAgent(world, { workspaceId: requesterWs.id, labels: { [LABEL.role]: "steer", [LABEL.slot]: "A", [LABEL.scope]: "requester/repo" } });
    ws.metadata[ASSIGNMENT_KEY] = { by: requester.id, requesterWorkspaceId: requesterWs.id, epoch: 3,
      reportActionId: `quiet-${quiet}`, reportText: "completed assignment", reportedAt: null };
    const marker = { startedAt: new Date().toISOString(), timeoutAt: new Date(Date.now() + 60_000).toISOString(), pid: 123 };
    if (quiet === "source") ws.metadata[DRAIN_METADATA_KEY] = marker;
    if (quiet === "recipient") requesterWs.metadata[DRAIN_METADATA_KEY] = marker;
    const deps = { lock: noLock, bootCheckDone: quiet !== "boot", draining: quiet === "global",
      settings: { enabled: false }, delivery: { zerosub: null } };
    const direct = { ...deps.delivery, lock: noLock,
      assignmentQuiet: (paseo, sources, target) => supervisionQuiet(paseo, [...sources, target], deps) };
    await dispatchAssignmentReport(fakeClient(world), ws.id, direct);
    await flushAllScopes(fakeClient(world), deps);
    assert.equal(sendsTo(world, requester.id).length, 0, quiet);
    assert.equal(ws.metadata[ASSIGNMENT_KEY].reportedAt, null, quiet);
    assert.equal(requesterWs.metadata[AGENTS_KEY]?.[requester.id]?.action, undefined, quiet);
    deps.bootCheckDone = true;
    deps.draining = false;
    delete ws.metadata[DRAIN_METADATA_KEY];
    delete requesterWs.metadata[DRAIN_METADATA_KEY];
    await flushAllScopes(fakeClient(world), deps);
    assert.equal(sendsTo(world, requester.id).length, 1, quiet);
    assert.ok(ws.metadata[ASSIGNMENT_KEY].reportedAt, quiet);
  }
});

test("a report at a hard limit does not request takeover during quiet periods", async () => {
  for (const quiet of ["boot", "global", "source", "recipient"]) {
    const world = makeWorld();
    const { ws } = provisioned(world);
    const requesterWs = addWorkspace(world, { metadata: { [METADATA_KEY]: { main: true, activeSteer: "A", epoch: 1, scope: { id: "requester/repo", kind: "github", locator: "requester/repo" } } } });
    const labels = (slot) => ({ [LABEL.role]: "steer", [LABEL.slot]: slot, [LABEL.scope]: "requester/repo" });
    const requester = addAgent(world, { workspaceId: requesterWs.id, labels: labels("A") });
    const successor = addAgent(world, { workspaceId: requesterWs.id, labels: labels("B") });
    requesterWs.metadata[AGENTS_KEY] = { [requester.id]: { quotaLimit: { at: new Date().toISOString(), provider: "claude", model: "m", accountId: "acc-a" } } };
    ws.metadata[ASSIGNMENT_KEY] = { by: requester.id, requesterWorkspaceId: requesterWs.id, epoch: 3,
      reportActionId: `quiet-limit-${quiet}`, reportText: "completed assignment", reportedAt: null };
    const marker = { startedAt: new Date().toISOString(), timeoutAt: new Date(Date.now() + 60_000).toISOString(), pid: 123 };
    if (quiet === "source") ws.metadata[DRAIN_METADATA_KEY] = marker;
    if (quiet === "recipient") requesterWs.metadata[DRAIN_METADATA_KEY] = marker;
    await flushAllScopes(fakeClient(world), { lock: noLock, bootCheckDone: quiet !== "boot", draining: quiet === "global",
      settings: { enabled: true, answerMinutes: 10, batchMinutes: 10, watchdogMinutes: 15, staleMinutes: 60, maxAutoResumes: 2 },
      getConfig: async () => config, delivery: { zerosub: zerosubFor({ A: requester, B: successor }, 5, 5) } });
    assert.equal(sendsTo(world, requester.id).length, 0, quiet);
    assert.equal(sendsTo(world, successor.id).length, 0, quiet);
    assert.equal(ws.metadata[ASSIGNMENT_KEY].reportedAt, null, quiet);
  }
});

test("hard-limit evidence also excludes another tab on the same limited route", async () => {
  const world = makeWorld();
  const { ws } = provisioned(world);
  const requesterWs = addWorkspace(world, { metadata: { [METADATA_KEY]: { main: true, activeSteer: "A", epoch: 1, scope: { id: "requester/repo", kind: "github", locator: "requester/repo" } } } });
  const labels = (slot) => ({ [LABEL.role]: "steer", [LABEL.slot]: slot, [LABEL.scope]: "requester/repo" });
  const requester = addAgent(world, { workspaceId: requesterWs.id, labels: labels("A") });
  const candidate = addAgent(world, { workspaceId: requesterWs.id, labels: labels("B") });
  const limitAt = new Date(Date.now() - 10_000).toISOString();
  requesterWs.metadata[AGENTS_KEY] = { [requester.id]: { quotaLimit: { at: limitAt, provider: "claude", model: "m", accountId: "acc-a" } } };
  ws.metadata[ASSIGNMENT_KEY] = { by: requester.id, requesterWorkspaceId: requesterWs.id, epoch: 3,
    reportActionId: "same-route", reportText: "report", reportedAt: null };
  const zerosub = zerosubFor({ A: requester, B: candidate }, 5, 5);
  zerosub.agentAccount[candidate.id] = "acc-a";
  await flushAllScopes(fakeClient(world), { lock: noLock, bootCheckDone: true,
    settings: { enabled: true, answerMinutes: 10, batchMinutes: 10, watchdogMinutes: 15, staleMinutes: 60, maxAutoResumes: 2 },
    getConfig: async () => config, delivery: { zerosub } });
  assert.equal(sendsTo(world, requester.id).length, 0);
  assert.equal(sendsTo(world, candidate.id).length, 0);
  assert.equal(ws.metadata[ASSIGNMENT_KEY].reportedAt, null);
});

test("hard-limit evidence in another workspace blocks only the same account and model", async () => {
  for (const [limitedModel, limitedAccount] of [["m", "acc-a"], ["other-model", "acc-a"], ["m", "acc-b"]]) {
    const world = makeWorld();
    const { ws } = provisioned(world);
    const requesterWs = addWorkspace(world, { metadata: { [METADATA_KEY]: { main: true, activeSteer: "A", epoch: 1, scope: { id: "requester/repo", kind: "github", locator: "requester/repo" } } } });
    const requester = addAgent(world, { workspaceId: requesterWs.id, labels: { [LABEL.role]: "steer", [LABEL.slot]: "A", [LABEL.scope]: "requester/repo" } });
    addWorkspace(world, { metadata: { [AGENTS_KEY]: { other: {
      quotaLimit: { at: new Date(Date.now() - 10_000).toISOString(), provider: "claude", model: limitedModel, accountId: limitedAccount },
    } } } });
    ws.metadata[ASSIGNMENT_KEY] = { by: requester.id, requesterWorkspaceId: requesterWs.id, epoch: 3,
      reportActionId: "cross-scope", reportText: "report", reportedAt: null };
    const zerosub = zerosubFor({ A: requester, B: requester }, 5, 5);
    zerosub.agentAccount[requester.id] = "acc-a";
    const deps = { lock: noLock, getConfig: async () => config, zerosub };
    const result = await dispatchAssignmentReport(fakeClient(world), ws.id, deps);
    const sameRoute = limitedModel === "m" && limitedAccount === "acc-a";
    assert.equal(result.status, sameRoute ? "pending" : "sent");
    assert.equal(sendsTo(world, requester.id).length, sameRoute ? 0 : 1);
    if (sameRoute) {
      assert.equal(ws.metadata[ASSIGNMENT_KEY].reportedAt, null);
      zerosub.accounts.find((account) => account.id === "acc-a").sampledAt = new Date().toISOString();
      await dispatchAssignmentReport(fakeClient(world), ws.id, deps);
      assert.ok(ws.metadata[ASSIGNMENT_KEY].reportedAt);
      assert.equal(sendsTo(world, requester.id).length, 1);
    }
  }
});

test("a lone report stays durable without a candidate and recovers after a newer quota sample", async () => {
  const world = makeWorld();
  const { ws } = provisioned(world);
  const requesterWs = addWorkspace(world, { metadata: { [METADATA_KEY]: { main: true, activeSteer: "A", epoch: 1, scope: { id: "requester/repo", kind: "github", locator: "requester/repo" } } } });
  const requester = addAgent(world, { workspaceId: requesterWs.id, labels: { [LABEL.role]: "steer", [LABEL.slot]: "A", [LABEL.scope]: "requester/repo" } });
  const now = Date.now();
  const limitAt = new Date(now - 10_000).toISOString();
  requesterWs.metadata[AGENTS_KEY] = { [requester.id]: { lastTurnEndedAt: new Date(now).toISOString(), needsResume: { reason: "limit", at: limitAt },
    quotaLimit: { at: limitAt, provider: "claude", model: "m", accountId: "acc-a" } } };
  ws.metadata[ASSIGNMENT_KEY] = { by: requester.id, requesterWorkspaceId: requesterWs.id, epoch: 3,
    reportActionId: "report-2", reportText: "completed assignment", reportedAt: null };
  const zerosub = zerosubFor({ A: requester, B: requester }, 5, 5);
  zerosub.agentAccount[requester.id] = "acc-a";
  const deps = { lock: noLock, bootCheckDone: true, settings: { enabled: true, answerMinutes: 10, batchMinutes: 10, watchdogMinutes: 15, staleMinutes: 60, maxAutoResumes: 2 },
    getConfig: async () => config, delivery: { zerosub, buildBrief: async () => "brief" } };
  await flushAllScopes(fakeClient(world), deps);
  assert.equal(sendsTo(world, requester.id).length, 0);
  assert.equal(ws.metadata[ASSIGNMENT_KEY].reportedAt, null);
  zerosub.accounts.find((account) => account.id === "acc-a").sampledAt = new Date(now).toISOString();
  await flushAllScopes(fakeClient(world), deps);
  assert.ok(ws.metadata[ASSIGNMENT_KEY].reportedAt);
  assert.equal(sendsTo(world, requester.id).length, 1);
});

test("a lone report waits at the configured account threshold and resumes below it", async () => {
  const world = makeWorld();
  const { ws } = provisioned(world);
  const requesterWs = addWorkspace(world, { metadata: { [METADATA_KEY]: { main: true, activeSteer: "A", epoch: 1, scope: { id: "requester/repo", kind: "github", locator: "requester/repo" } } } });
  const requester = addAgent(world, { workspaceId: requesterWs.id, labels: { [LABEL.role]: "steer", [LABEL.slot]: "A", [LABEL.scope]: "requester/repo" } });
  ws.metadata[ASSIGNMENT_KEY] = { by: requester.id, requesterWorkspaceId: requesterWs.id, epoch: 3,
    reportActionId: "threshold", reportText: "completed assignment", reportedAt: null };
  const zerosub = zerosubFor({ A: requester, B: requester }, 92, 92);
  zerosub.agentAccount[requester.id] = "acc-a";
  const deps = { lock: noLock, getConfig: async () => config, zerosub };
  assert.equal((await dispatchAssignmentReport(fakeClient(world), ws.id, deps)).status, "pending");
  assert.equal(sendsTo(world, requester.id).length, 0);
  assert.equal(ws.metadata[ASSIGNMENT_KEY].reportedAt, null);
  assert.equal(requesterWs.metadata[AGENTS_KEY], undefined);
  zerosub.accounts.find((account) => account.id === "acc-a").windows[0].usedPct = 89;
  assert.equal((await dispatchAssignmentReport(fakeClient(world), ws.id, deps)).status, "sent");
  assert.ok(ws.metadata[ASSIGNMENT_KEY].reportedAt);
  assert.equal(sendsTo(world, requester.id).length, 1);
});

test("a report uses the new account only after ZeroSub confirms its live session", async () => {
  const world = makeWorld();
  const { ws } = provisioned(world);
  const requesterWs = addWorkspace(world, { metadata: { [METADATA_KEY]: { main: true, activeSteer: "A", epoch: 1, scope: { id: "requester/repo", kind: "github", locator: "requester/repo" } } } });
  const requester = addAgent(world, { workspaceId: requesterWs.id, labels: { [LABEL.role]: "steer", [LABEL.slot]: "A", [LABEL.scope]: "requester/repo" } });
  ws.metadata[ASSIGNMENT_KEY] = { by: requester.id, requesterWorkspaceId: requesterWs.id, epoch: 3,
    reportActionId: "move-in-progress", reportText: "completed assignment", reportedAt: null };
  const zerosub = zerosubFor({ A: requester, B: requester }, 100, 5);
  zerosub.agentAccount[requester.id] = "acc-b";
  zerosub.pending[requester.id] = "acc-a";
  const deps = { lock: noLock, getConfig: async () => config, zerosub,
    onQuotaBlocked: async () => assert.fail("A pending ZeroSub move does not trigger a new failover") };
  assert.equal((await dispatchAssignmentReport(fakeClient(world), ws.id, deps)).status, "pending");
  assert.equal(sendsTo(world, requester.id).length, 0);
  assert.equal(ws.metadata[ASSIGNMENT_KEY].reportedAt, null);
  delete zerosub.pending[requester.id];
  assert.equal((await dispatchAssignmentReport(fakeClient(world), ws.id, deps)).status, "sent");
  assert.equal(sendsTo(world, requester.id).length, 1);
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

test("a failed recipient turn does not revoke a report receipt or replay it", async () => {
  const world = makeWorld();
  const { ws } = provisioned(world);
  const requesterWs = addWorkspace(world, { metadata: { [METADATA_KEY]: { main: true, activeSteer: "A", epoch: 1, scope: { id: "requester/repo", kind: "github", locator: "requester/repo" } } } });
  const requester = addAgent(world, { workspaceId: requesterWs.id, labels: { [LABEL.role]: "steer", [LABEL.slot]: "A", [LABEL.scope]: "requester/repo" } });
  ws.metadata[ASSIGNMENT_KEY] = { by: requester.id, requesterWorkspaceId: requesterWs.id, epoch: 3,
    reportActionId: "receipt", reportText: "report", reportedAt: null };
  await dispatchAssignmentReport(fakeClient(world), ws.id, { lock: noLock, zerosub: null });
  const receipt = ws.metadata[ASSIGNMENT_KEY].reportedAt;
  assert.ok(receipt);
  setTurn(world, requester.id, "interrupted");
  await handleTurnAfter({ agent: { id: requester.id }, turnId: "t1",
    outcome: { kind: "failed", error: { message: "You've hit your 5-hour limit" } } },
  { paseo: fakeClient(world) }, { ...turnDeps(world), getSupervisionSettings: async () => ({ enabled: false }) });
  assert.equal(requesterWs.metadata[AGENTS_KEY][requester.id].needsResume.reason, "limit");
  assert.equal(ws.metadata[ASSIGNMENT_KEY].reportedAt, receipt);
  assert.equal(await dispatchAssignmentReport(fakeClient(world), ws.id, { lock: noLock, zerosub: null }), null);
  assert.equal(sendsTo(world, requester.id).length, 1);
});

test("a confirmed receipt survives an epoch change before source bookkeeping", async () => {
  const world = makeWorld();
  const { ws } = provisioned(world);
  const requesterWs = addWorkspace(world, { metadata: { [METADATA_KEY]: { main: true, activeSteer: "A", epoch: 1, scope: { id: "requester/repo", kind: "github", locator: "requester/repo" } } } });
  const requester = addAgent(world, { workspaceId: requesterWs.id, labels: { [LABEL.role]: "steer", [LABEL.slot]: "A", [LABEL.scope]: "requester/repo" } });
  ws.metadata[ASSIGNMENT_KEY] = { by: requester.id, requesterWorkspaceId: requesterWs.id, epoch: 3,
    reportActionId: "receipt-epoch", reportText: "report", reportedAt: null };
  await dispatchAssignmentReport(fakeClient(world), ws.id, { lock: noLock, zerosub: null });
  ws.metadata[ASSIGNMENT_KEY].reportedAt = null;
  requesterWs.metadata[AGENTS_KEY][requester.id].action.phase = "sent";
  requesterWs.metadata[METADATA_KEY].epoch = 2;
  await dispatchAssignmentReport(fakeClient(world), ws.id, { lock: noLock, zerosub: null });
  assert.ok(ws.metadata[ASSIGNMENT_KEY].reportedAt);
  assert.equal(sendsTo(world, requester.id).length, 1);
});

test("a legacy completed single-report action repairs a missing source receipt", async () => {
  const world = makeWorld();
  const { ws } = provisioned(world);
  const requesterWs = addWorkspace(world, { metadata: { [METADATA_KEY]: { main: true, activeSteer: "A", epoch: 1, scope: { id: "requester/repo", kind: "github", locator: "requester/repo" } } } });
  const requester = addAgent(world, { workspaceId: requesterWs.id, labels: { [LABEL.role]: "steer", [LABEL.slot]: "A", [LABEL.scope]: "requester/repo" } });
  ws.metadata[ASSIGNMENT_KEY] = { by: requester.id, requesterWorkspaceId: requesterWs.id, epoch: 3,
    reportActionId: "legacy", reportText: "report", reportedAt: null };
  requesterWs.metadata[AGENTS_KEY] = { [requester.id]: { action: {
    ...newSteerAction({ kind: "assignment", id: "legacy", epoch: 1, phase: "done", text: "report" }),
    assignment: { workspaceId: ws.id, actionId: "legacy" },
  } } };
  await dispatchAssignmentReport(fakeClient(world), ws.id, { lock: noLock, zerosub: null });
  assert.ok(ws.metadata[ASSIGNMENT_KEY].reportedAt);
  assert.equal(sendsTo(world, requester.id).length, 0);
});

test("an uncertain report is not rebound after an epoch change", async () => {
  const world = makeWorld();
  const { ws } = provisioned(world);
  const requesterWs = addWorkspace(world, { metadata: { [METADATA_KEY]: { main: true, activeSteer: "A", epoch: 1, scope: { id: "requester/repo", kind: "github", locator: "requester/repo" } } } });
  const labels = (slot) => ({ [LABEL.role]: "steer", [LABEL.slot]: slot, [LABEL.scope]: "requester/repo" });
  const requester = addAgent(world, { workspaceId: requesterWs.id, labels: labels("A") });
  const successor = addAgent(world, { workspaceId: requesterWs.id, labels: labels("B") });
  ws.metadata[ASSIGNMENT_KEY] = { by: requester.id, requesterWorkspaceId: requesterWs.id, epoch: 3,
    reportActionId: "uncertain-epoch", reportText: "report", reportedAt: null };
  world.lostSendResponse = true;
  await dispatchAssignmentReport(fakeClient(world), ws.id, { lock: noLock, zerosub: null });
  assert.equal(requesterWs.metadata[AGENTS_KEY][requester.id].action.phase, "uncertain");
  requesterWs.metadata[METADATA_KEY].activeSteer = "B";
  requesterWs.metadata[METADATA_KEY].activeAgentId = successor.id;
  requesterWs.metadata[METADATA_KEY].epoch = 2;
  const result = await dispatchAssignmentReport(fakeClient(world), ws.id, { lock: noLock, zerosub: null });
  assert.equal(result.status, "blocked");
  assert.match(result.detail, /receipt or renewal reconciliation/);
  assert.equal(ws.metadata[ASSIGNMENT_KEY].reportTarget.agentId, requester.id);
  assert.equal(ws.metadata[ASSIGNMENT_KEY].reportedAt, null);
  assert.equal(sendsTo(world, requester.id).length, 1);
  assert.equal(sendsTo(world, successor.id).length, 0);
});

test("a legacy report with a missing old delivery record is not rebound", async () => {
  const world = makeWorld();
  const { ws } = provisioned(world);
  const requesterWs = addWorkspace(world, { metadata: { [METADATA_KEY]: { main: true, activeSteer: "B", epoch: 2, scope: { id: "requester/repo", kind: "github", locator: "requester/repo" } } } });
  const labels = (slot) => ({ [LABEL.role]: "steer", [LABEL.slot]: slot, [LABEL.scope]: "requester/repo" });
  const requester = addAgent(world, { workspaceId: requesterWs.id, labels: labels("A") });
  const successor = addAgent(world, { workspaceId: requesterWs.id, labels: labels("B") });
  ws.metadata[ASSIGNMENT_KEY] = { by: requester.id, requesterWorkspaceId: requesterWs.id, epoch: 3,
    reportActionId: "legacy-missing", reportText: "report", reportedAt: null,
    reportTarget: { workspaceId: requesterWs.id, agentId: requester.id, epoch: 1, scopeId: "requester/repo" } };
  const result = await dispatchAssignmentReport(fakeClient(world), ws.id, { lock: noLock, zerosub: null });
  assert.equal(result.status, "blocked");
  assert.equal(ws.metadata[ASSIGNMENT_KEY].reportTarget.agentId, requester.id);
  assert.equal(sendsTo(world, successor.id).length, 0);
});

test("concurrent dispatchers cannot overwrite an attempted assignment action", async () => {
  const world = makeWorld();
  const { ws } = provisioned(world);
  const requesterWs = addWorkspace(world, { metadata: { [METADATA_KEY]: { main: true, activeSteer: "A", epoch: 1, scope: { id: "requester/repo", kind: "github", locator: "requester/repo" } } } });
  const requester = addAgent(world, { title: "Steer A", workspaceId: requesterWs.id, labels: { [LABEL.role]: "steer", [LABEL.slot]: "A", [LABEL.scope]: "requester/repo" } });
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
    const { ws, steers } = provisioned(world);
    await completedSteerTurn(world, steers, { getConfig: async () => config, zerosub: zerosubFor(steers, pct) });
    assert.equal(sendsTo(world, steers.A.id).length, 0, `${pct}%`);
    const entry = ws.metadata[AGENTS_KEY][steers.A.id];
    assert.deepEqual(entry.quotaSuccess, {
      accountId: "acc-a", provider: steers.A.provider, model: steers.A.model, at: entry.lastTurnEndedAt,
    });
    assert.ok(world.calls.some((c) => c[0] === "workspace.setMetadata"), "turn still recorded");
  }
});

test("a standby provider limit belongs to its runtime account and leaves the active holder alone", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const standby = steers.B.id;
  const zerosub = zerosubFor(steers, 10, 10);
  zerosub.pending[standby] = "old-runtime";
  const outcome = { kind: "failed", error: { message: "You've hit your 5-hour limit" } };
  const { runBootFinished } = await import("../server/supervise.ts");
  resetSupervisionForTests();
  try {
    const paseo = fakeClient(world);
    await runBootFinished(paseo, [], { settings: { enabled: true }, lock: noLock });
    await handleTurnAfter({ agent: { id: standby }, turnId: "limited", outcome }, { paseo },
      { ...turnDeps(world), zerosub, getConfig: async () => config });
    assert.equal(ws.metadata[AGENTS_KEY][standby].quotaLimit.accountId, "old-runtime");
    assert.equal(ws.metadata[METADATA_KEY].activeSteer, "A");
    assert.equal(world.calls.some(([kind]) => kind === "agent.send"), false);
  } finally {
    resetSupervisionForTests();
  }
});

test("a turn.before that arrives after its turn.after leaves the steer free", async () => {
  const { hasActiveAgentWork } = await import("../server/agent-context.ts");
  const { steerWakeResponse } = await import("../shared/supervise.ts");
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const paseo = fakeClient(world);
  setTurn(world, steers.A.id, "You've hit your 5-hour limit");
  // A provider limit ends the turn before the slower turn.before writes.
  await handleTurnAfter({ agent: { id: steers.A.id }, turnId: "t5", outcome: { kind: "failed", error: { message: "You've hit your 5-hour limit" } } },
    { paseo }, turnDeps(world));
  await handleTurnBefore({ agent: { id: steers.A.id }, turnId: "t5" }, { paseo }, turnDeps(world));
  assert.equal(ws.metadata[AGENTS_KEY][steers.A.id].openTurnId, null);
  await handleTurnBefore({ agent: { id: steers.A.id }, turnId: "t6" }, { paseo }, turnDeps(world));
  assert.equal(ws.metadata[AGENTS_KEY][steers.A.id].openTurnId, "t6");

  // Entries written before the fix: the open id is the ended turn.
  const stale = { openTurnId: "t5", lastTurnId: "t5" };
  assert.equal(hasActiveAgentWork({ status: "idle", activeTurn: null }, stale), false);
  assert.equal(steerWakeResponse({ entry: stale, status: "idle", lastWakeAt: "2026-01-01T00:00:00Z" }), "unanswered");
  assert.equal(hasActiveAgentWork({ status: "idle", activeTurn: null }, { openTurnId: "t6", lastTurnId: "t5" }), true);
  ws.metadata[AGENTS_KEY][steers.A.id] = { ...ws.metadata[AGENTS_KEY][steers.A.id], ...stale };
  setTurn(world, steers.A.id, checkpointOf("next", null));
  await handleTurnAfter({ agent: { id: steers.A.id }, turnId: "t7", outcome: { kind: "completed" } }, { paseo }, turnDeps(world));
  assert.equal(ws.metadata[AGENTS_KEY][steers.A.id].openTurnId, null);
});

test("an explicit model selection survives queued delivery and blocks a changed runtime through restart", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const paseo = fakeClient(world);
  const originalModel = steers.A.model;
  let changed = false;
  const deps = {
    lock: noLock,
    getConfig: async () => {
      if (!changed && ws.metadata[AGENTS_KEY]?.[steers.A.id]?.action?.routing) {
        changed = true;
        steers.A.model = "different-model";
      }
      return null;
    },
  };
  const result = await deliverSteer(paseo, {
    workspaceId: ws.id, agentId: steers.A.id, epoch: 3, text: "Continue the assigned work",
    intent: { mode: "explicit", agentId: steers.A.id, provider: steers.A.provider, model: originalModel },
  }, deps);
  assert.notEqual(result.status, "sent");
  assert.equal(sendsTo(world, steers.A.id).length, 0);
  const pending = ws.metadata[AGENTS_KEY][steers.A.id].action;
  assert.equal(pending.attemptedAt, undefined);
  const operationId = pending.wakeId;
  // No in-memory state is required to keep the explicit constraint.
  const retry = await finishSteerDelivery(paseo, { workspaceId: ws.id, agentId: steers.A.id }, { lock: noLock });
  assert.match(retry.detail, /explicit steer\/model selection changed/);
  assert.equal(sendsTo(world, steers.A.id).length, 0);
  steers.A.model = originalModel;
  const confirmed = await finishSteerDelivery(paseo, { workspaceId: ws.id, agentId: steers.A.id }, { lock: noLock });
  assert.equal(confirmed.status, "sent");
  assert.equal(ws.metadata[AGENTS_KEY][steers.A.id].action.wakeId, operationId);
  assert.equal(sendsTo(world, steers.A.id).length, 1);
  assert.equal(sendsTo(world, steers.B.id).length, 0);
});

test("privacy blocks a changed runtime before preparation and preserves an uncertain receipt", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const paseo = fakeClient(world);
  const action = { ...newSteerAction({ id: "pending-privacy", epoch: 3, text: "private result", phase: "uncertain" }),
    attemptedAt: "2026-11-26T17:00:00Z", authority: { scopeId: REPO, agentId: steers.A.id } };
  ws.metadata[AGENTS_KEY] = { [steers.A.id]: { action } };
  steers.A.provider = "muse";
  steers.A.model = "changed";
  let builds = 0, prepares = 0;
  const deps = { lock: noLock, getConfig: async () => config, getScopePublic: async () => true,
    buildBrief: async () => { builds++; return "brief"; },
    runCleanupFn: async () => { prepares++; } };
  const result = await finishSteerDelivery(paseo, { workspaceId: ws.id, agentId: steers.A.id }, deps);
  assert.match(result.detail, /verified sanitized brief/);
  assert.deepEqual(ws.metadata[AGENTS_KEY][steers.A.id].action, action);
  assert.equal(world.sendAttempts ?? 0, 0);
  assert.equal(builds, 0);
  assert.equal(prepares, 0);
});

test("runtime drift after route observation prevents preparation and dispatch", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  let prepares = 0, builds = 0, changed = false;
  const result = await deliverSteer(fakeClient(world), {
    workspaceId: ws.id, agentId: steers.A.id, epoch: 3, manual: true,
    intent: { mode: "explicit", agentId: steers.A.id },
  }, {
    lock: noLock, getScopePublic: async () => true,
    getConfig: async () => {
      if (!changed) { changed = true; steers.A.provider = "muse"; steers.A.model = "other"; }
      return config;
    },
    buildBrief: async () => { builds++; return "brief"; },
    runCleanupFn: async () => { prepares++; },
  });
  assert.notEqual(result.status, "sent");
  assert.equal(world.sendAttempts ?? 0, 0);
  assert.equal(builds, 0);
  assert.equal(prepares, 0);
});

test("handover rechecks the live target before changing scope authority", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const discovery = { forkName: REPO, scope: ws.metadata[METADATA_KEY].scope,
    github: { fork: { repo: { private: false } } },
    mainWorkspace: structuredClone(ws), steers: { labelled: structuredClone(Object.values(steers)), legacy: [] },
    workers: [], providers: [] };
  await assert.rejects(switchSteer({
    client: fakeClient(world), discovery, toSlot: "B", apply: true, config,
    lock: async (_name, fn) => { steers.B.provider = "muse"; steers.B.model = "changed"; return fn({ verify() {} }); },
  }), /verified sanitized brief/);
  assert.equal(ws.metadata[METADATA_KEY].activeSteer, "A");
  assert.equal(ws.metadata[METADATA_KEY].epoch, 3);
  assert.equal(world.sendAttempts ?? 0, 0);
});

test("sensitive assignment report stays pending without dispatch or quota failover", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  steers.A.provider = "muse";
  steers.A.metadata[LABEL.steerRole] = "advisor";
  const source = addWorkspace(world, { metadata: { [ASSIGNMENT_KEY]: {
    by: steers.A.id, requesterWorkspaceId: ws.id, reportActionId: "report", reportText: "result", reportedAt: null,
  } } });
  let quota = 0;
  const result = await dispatchAssignmentReport(fakeClient(world), source.id, {
    lock: noLock, getConfig: async () => config, getScopePublic: async () => false,
    onQuotaBlocked: async () => { quota++; },
  });
  assert.match(result.detail, /private or unknown/);
  assert.equal(source.metadata[ASSIGNMENT_KEY].reportedAt, null);
  assert.equal(source.metadata[ASSIGNMENT_KEY].reportTarget, undefined);
  assert.equal(world.sendAttempts ?? 0, 0);
  assert.equal(quota, 0);
});

function moveRecoveryFixture({ phase = "ready", outcome = "moved" } = {}) {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const agent = steers.A;
  agent.persistence = { sessionId: "conversation" };
  const now = new Date().toISOString();
  const zerosub = zerosubFor(steers, 100, 10);
  zerosub.agentAccount[agent.id] = outcome === "waiting" ? "acc-a" : "acc-b";
  const action = {
    ...newSteerAction({ id: "move-delivery", epoch: 3, at: now, text: "pending work", phase }),
    authority: { scopeId: REPO, agentId: agent.id },
    accountMove: { phase: "uncertain", attemptedAt: now, fromAccountId: "acc-a", accountId: "acc-b",
      provider: agent.provider, model: agent.model, sessionId: "conversation",
      reply: { outcome, accountId: outcome === "waiting" ? "acc-a" : "acc-b" } },
  };
  ws.metadata[AGENTS_KEY] = { [agent.id]: { action } };
  const input = { workspaceId: ws.id, agentId: agent.id };
  const deps = { lock: noLock, getConfig: async () => config, getZerosub: async () => structuredClone(zerosub),
    now: () => now,
    readAccountMoveObservation: async () => ({ agent: structuredClone(agent), zerosub: structuredClone(zerosub), row: null }) };
  return { world, ws, agent, zerosub, input, deps, paseo: fakeClient(world),
    action: () => ws.metadata[AGENTS_KEY][agent.id].action };
}

test("delivery recovery reconciles a durable move before admission and sends only once", async () => {
  const f = moveRecoveryFixture();
  f.zerosub.pending[f.agent.id] = "acc-a";
  assert.equal((await finishSteerDelivery(f.paseo, f.input, f.deps)).status, "pending");
  assert.equal(f.action().accountMove.phase, "uncertain");
  assert.equal(sendsTo(f.world, f.agent.id).length, 0);
  delete f.zerosub.pending[f.agent.id];
  // A new call/dependency object represents a restart; the durable action owns the only attempt.
  assert.equal((await finishSteerDelivery(f.paseo, f.input, { ...f.deps })).status, "sent");
  assert.equal(f.action().accountMove.phase, "settled");
  assert.equal(f.action().accountMove.resolution, "ready");
  assert.equal((await finishSteerDelivery(f.paseo, f.input, { ...f.deps })), null);
  assert.equal(sendsTo(f.world, f.agent.id).length, 1);
  f.agent.persistence.sessionId = "later-conversation";
  assert.equal((await deliverSteer(f.paseo, { ...f.input, text: "later work" }, { lock: noLock, zerosub: null })).status, "sent");
  assert.equal(sendsTo(f.world, f.agent.id).length, 2);
});

test("reserved delivery retains the move claim across recovery and re-planning", async () => {
  const f = moveRecoveryFixture({ phase: "reserved" });
  assert.equal((await finishSteerDelivery(f.paseo, f.input, f.deps)).status, "sent");
  assert.equal(f.action().accountMove.phase, "settled");
  assert.equal(sendsTo(f.world, f.agent.id).length, 1);
});

test("move recovery waits for fresh account quota and replans on changed effective threshold", async () => {
  const f = moveRecoveryFixture();
  const target = f.zerosub.accounts.find((account) => account.id === "acc-b");
  target.sampledAt = "2020-01-01T00:00:00Z";
  assert.equal((await finishSteerDelivery(f.paseo, f.input, f.deps)).status, "pending");
  assert.equal(f.action().accountMove.phase, "uncertain");
  target.sampledAt = f.deps.now();
  target.windows[0].usedPct = 85;
  f.deps.getConfig = async () => ({ ...config, quota: { exhaustedPct: 80 } });
  assert.equal((await finishSteerDelivery(f.paseo, f.input, f.deps)).status, "pending");
  assert.equal(f.action().accountMove.resolution, "replan");
  assert.match((await deliverSteer(f.paseo, { ...f.input, actionId: "move-delivery" }, f.deps)).detail, /new route/);
  assert.equal(sendsTo(f.world, f.agent.id).length, 0);
});

test("move recovery respects a newer account-specific limit recorded in another workspace", async () => {
  const f = moveRecoveryFixture();
  addWorkspace(f.world, { metadata: { [AGENTS_KEY]: { other: {
    quotaLimit: { provider: "claude", model: "m", accountId: "acc-b", at: f.deps.now() },
  } } } });
  assert.equal((await finishSteerDelivery(f.paseo, f.input, f.deps)).status, "pending");
  assert.equal(f.action().accountMove.resolution, "replan");
  assert.equal(sendsTo(f.world, f.agent.id).length, 0);
});

test("the final send rechecks the verified destination and fresh quota", async () => {
  const f = moveRecoveryFixture();
  let reads = 0;
  f.deps.getZerosub = async () => {
    const snapshot = structuredClone(f.zerosub);
    if (++reads >= 3) snapshot.agentAccount[f.agent.id] = "acc-a";
    return snapshot;
  };
  assert.notEqual((await finishSteerDelivery(f.paseo, f.input, f.deps)).status, "sent");
  assert.equal(f.action().accountMove.resolution, "ready");
  assert.equal(f.action().attemptedAt, undefined);
  assert.equal(sendsTo(f.world, f.agent.id).length, 0);
  f.deps.getZerosub = async () => structuredClone(f.zerosub);
  f.agent.status = "closed";
  assert.notEqual((await finishSteerDelivery(f.paseo, f.input, f.deps)).status, "sent");
  assert.equal(sendsTo(f.world, f.agent.id).length, 0);
  f.agent.status = "idle";
  assert.equal((await finishSteerDelivery(f.paseo, f.input, f.deps)).status, "sent");
  assert.equal(sendsTo(f.world, f.agent.id).length, 1);
});

test("assignment recovery preserves a reserved move claim and its report receipt", async () => {
  const f = moveRecoveryFixture({ phase: "reserved" });
  const source = addWorkspace(f.world, { metadata: {} });
  const target = { workspaceId: f.ws.id, agentId: f.agent.id, epoch: 3, scopeId: REPO, deliveryId: "move-delivery" };
  source.metadata[ASSIGNMENT_KEY] = { by: f.agent.id, requesterWorkspaceId: f.ws.id,
    reportActionId: "report", reportText: "pending work", reportTarget: target, reportedAt: null };
  f.action().kind = "assignment";
  f.action().assignment = { workspaceId: source.id, actionId: "report" };
  f.action().assignments = [{ workspaceId: source.id, actionId: "report", text: "pending work" }];
  assert.equal((await dispatchAssignmentReport(f.paseo, source.id, f.deps)).status, "sent");
  assert.equal(f.action().accountMove.resolution, "ready");
  assert.ok(source.metadata[ASSIGNMENT_KEY].reportedAt);
  assert.equal(sendsTo(f.world, f.agent.id).length, 1);
});

test("a reconciled no-effect assignment can rebind after the holder changes", async () => {
  const f = moveRecoveryFixture({ phase: "reserved", outcome: "waiting" });
  const source = addWorkspace(f.world, { metadata: {} });
  const target = { workspaceId: f.ws.id, agentId: f.agent.id, epoch: 3, scopeId: REPO, deliveryId: "move-delivery" };
  source.metadata[ASSIGNMENT_KEY] = { by: f.agent.id, requesterWorkspaceId: f.ws.id,
    reportActionId: "report", reportText: "pending work", reportTarget: target, reportedAt: null };
  f.action().kind = "assignment";
  f.action().assignment = { workspaceId: source.id, actionId: "report" };
  f.action().assignments = [{ workspaceId: source.id, actionId: "report", text: "pending work" }];
  assert.equal((await dispatchAssignmentReport(f.paseo, source.id, f.deps)).status, "pending");
  assert.equal(f.action().accountMove.resolution, "replan");
  const successor = f.world.agents.find((agent) => agent.id !== f.agent.id);
  f.ws.metadata[METADATA_KEY].epoch++;
  f.ws.metadata[METADATA_KEY].activeSteer = "B";
  assert.equal((await dispatchAssignmentReport(f.paseo, source.id, f.deps)).status, "sent");
  assert.equal(sendsTo(f.world, f.agent.id).length, 0);
  assert.equal(sendsTo(f.world, successor.id).length, 1);
  assert.ok(source.metadata[ASSIGNMENT_KEY].reportedAt);
});

test("lost move reply, no-effect and changed authority never dispatch without evidence", async () => {
  const f = moveRecoveryFixture();
  f.action().accountMove.reply = { outcome: "uncertain" };
  assert.equal((await finishSteerDelivery(f.paseo, f.input, f.deps)).status, "pending");
  assert.equal(f.action().accountMove.phase, "uncertain");
  f.ws.metadata[METADATA_KEY].epoch++;
  assert.equal((await finishSteerDelivery(f.paseo, f.input, f.deps)).status, "blocked");
  assert.equal(f.action().accountMove.phase, "uncertain");
  assert.equal(sendsTo(f.world, f.agent.id).length, 0);

  const waiting = moveRecoveryFixture({ outcome: "waiting" });
  assert.equal((await finishSteerDelivery(waiting.paseo, waiting.input, waiting.deps)).status, "pending");
  assert.equal(waiting.action().accountMove.resolution, "replan");
  assert.equal(sendsTo(waiting.world, waiting.agent.id).length, 0);
});

test("a lost move reply resumes from a matching switch observation after restart", async () => {
  const f = moveRecoveryFixture();
  f.action().accountMove.reply = { outcome: "uncertain" };
  assert.equal((await finishSteerDelivery(f.paseo, f.input, f.deps)).status, "pending");
  f.deps.readAccountMoveObservation = async () => ({ agent: structuredClone(f.agent),
    zerosub: structuredClone(f.zerosub), row: { family: "claude", from: "acc-a", to: "acc-b",
      at: f.deps.now(), reason: "near_limit", outcome: "switched" } });
  assert.equal((await finishSteerDelivery(f.paseo, f.input, { ...f.deps })).status, "sent");
  assert.equal(sendsTo(f.world, f.agent.id).length, 1);
});

test("a same-holder replan survives restart, waits for changed eligibility and preserves the move receipt", async () => {
  const f = moveRecoveryFixture();
  const account = f.zerosub.accounts.find((item) => item.id === "acc-b");
  account.windows[0].usedPct = 95;
  assert.equal((await finishSteerDelivery(f.paseo, f.input, f.deps)).status, "pending");
  const move = structuredClone(f.action().accountMove);
  const generation = structuredClone(f.action().accountMoveReplan);
  const writes = f.world.calls.filter((call) => call[0] === "workspace.setMetadata").length;
  for (let i = 0; i < 3; i++) {
    assert.equal((await finishSteerDelivery(f.paseo, f.input, { ...f.deps })).status, "pending");
  }
  assert.deepEqual(f.action().accountMoveReplan, generation);
  assert.equal(f.world.calls.filter((call) => call[0] === "workspace.setMetadata").length, writes);
  account.windows[0].usedPct = 10;
  assert.equal((await finishSteerDelivery(f.paseo, f.input, { ...f.deps })).status, "sent");
  assert.deepEqual(f.action().accountMove, move);
  assert.equal(f.action().accountMoveReplan.status, "ready");
  assert.equal(sendsTo(f.world, f.agent.id).length, 1);
  let nativeCalls = 0;
  assert.equal((await attemptSteerAccountMove({ client: f.paseo, workspaceId: f.ws.id, agentId: f.agent.id,
    actionId: "move-delivery", accountId: "acc-b", lock: noLock, validate: async () => true,
    move: async () => { nativeCalls++; } })).status, "reconcile");
  assert.equal(nativeCalls, 0);
});

test("concurrent recovery instances retain one delivery receipt across a lost send reply", async () => {
  const f = moveRecoveryFixture();
  const account = f.zerosub.accounts.find((item) => item.id === "acc-b");
  account.windows[0].usedPct = 95;
  let tail = Promise.resolve();
  f.deps.lock = (_name, fn) => {
    const current = tail.then(() => fn({ verify() {} }));
    tail = current.catch(() => {});
    return current;
  };
  await finishSteerDelivery(f.paseo, f.input, f.deps);
  account.windows[0].usedPct = 10;
  f.world.lostSendResponse = true;
  const other = await import("../server/steer-delivery.ts?second-recovery-instance");
  await Promise.all([
    finishSteerDelivery(f.paseo, f.input, f.deps),
    other.finishSteerDelivery(f.paseo, f.input, { ...f.deps }),
  ]);
  if (f.action().phase !== "done") await finishSteerDelivery(f.paseo, f.input, { ...f.deps });
  assert.equal(f.action().phase, "done");
  assert.equal(f.action().wakeId, "move-delivery");
  assert.equal(sendsTo(f.world, f.agent.id).length, 1);
});

test("replan waits on Stop, permissions, source receipt and scope epoch", async () => {
  for (const obstacle of ["stop", "permission", "source", "epoch"]) {
    const f = moveRecoveryFixture({ phase: "reserved" });
    const source = addWorkspace(f.world, { metadata: {} });
    source.metadata[ASSIGNMENT_KEY] = { by: f.agent.id, requesterWorkspaceId: f.ws.id,
      reportActionId: "report", reportText: "pending work", reportedAt: null,
      reportTarget: { workspaceId: f.ws.id, agentId: f.agent.id, epoch: 3, scopeId: REPO, deliveryId: "move-delivery" } };
    f.action().kind = "assignment";
    f.action().assignment = { workspaceId: source.id, actionId: "report" };
    f.action().assignments = [{ workspaceId: source.id, actionId: "report", text: "pending work" }];
    const account = f.zerosub.accounts.find((item) => item.id === "acc-b");
    account.windows[0].usedPct = 95;
    await finishSteerDelivery(f.paseo, f.input, f.deps);
    account.windows[0].usedPct = 10;
    if (obstacle === "stop") f.ws.metadata[AGENTS_KEY][f.agent.id].interrupted = { at: f.deps.now(), outcome: "canceled" };
    if (obstacle === "permission") f.agent.pendingPermissions = [{ id: "p" }];
    if (obstacle === "source") source.metadata[ASSIGNMENT_KEY].reportedAt = f.deps.now();
    if (obstacle === "epoch") f.ws.metadata[METADATA_KEY].epoch++;
    assert.notEqual((await finishSteerDelivery(f.paseo, f.input, { ...f.deps })).status, "sent", obstacle);
    assert.equal(sendsTo(f.world, f.agent.id).length, 0, obstacle);
    assert.equal(f.action().accountMoveReplan.status, "waiting", obstacle);
  }
});

test("a refused move stays bounded until the original account becomes newly eligible", async () => {
  const f = moveRecoveryFixture({ outcome: "waiting" });
  await finishSteerDelivery(f.paseo, f.input, f.deps);
  const receipt = structuredClone(f.action().accountMove);
  assert.equal((await finishSteerDelivery(f.paseo, f.input, f.deps)).status, "pending");
  f.zerosub.accounts.find((item) => item.id === "acc-a").windows[0].usedPct = 10;
  assert.equal((await finishSteerDelivery(f.paseo, f.input, f.deps)).status, "sent");
  assert.deepEqual(f.action().accountMove, receipt);
  assert.equal(f.action().accountMoveReplan.accountId, "acc-a");
  assert.equal(sendsTo(f.world, f.agent.id).length, 1);
});

test("the replan send rechecks Stop and source receipts after admission", async () => {
  for (const obstacle of ["stop", "source"]) {
    const f = moveRecoveryFixture();
    const source = addWorkspace(f.world, { metadata: {} });
    source.metadata[ASSIGNMENT_KEY] = { by: f.agent.id, requesterWorkspaceId: f.ws.id,
      reportActionId: "report", reportText: "pending work", reportedAt: null,
      reportTarget: { workspaceId: f.ws.id, agentId: f.agent.id, epoch: 3, scopeId: REPO, deliveryId: "move-delivery" } };
    f.action().kind = "assignment";
    f.action().assignment = { workspaceId: source.id, actionId: "report" };
    f.action().assignments = [{ workspaceId: source.id, actionId: "report", text: "pending work" }];
    const account = f.zerosub.accounts.find((item) => item.id === "acc-b");
    account.windows[0].usedPct = 95;
    await finishSteerDelivery(f.paseo, f.input, f.deps);
    account.windows[0].usedPct = 10;
    let reads = 0;
    f.deps.getZerosub = async () => {
      if (++reads === 2) {
        if (obstacle === "stop") f.ws.metadata[AGENTS_KEY][f.agent.id].interrupted = { at: f.deps.now(), outcome: "canceled" };
        else source.metadata[ASSIGNMENT_KEY].reportedAt = f.deps.now();
      }
      return structuredClone(f.zerosub);
    };
    assert.notEqual((await finishSteerDelivery(f.paseo, f.input, f.deps)).status, "sent");
    assert.equal(sendsTo(f.world, f.agent.id).length, 0, obstacle);
    assert.equal(f.action().attemptedAt, undefined, obstacle);
  }
});

test("replanning a reserved delivery preserves its explicit routing constraint", async () => {
  const f = moveRecoveryFixture({ phase: "reserved" });
  f.action().routing = { intent: { mode: "explicit", agentId: f.agent.id, provider: "claude", model: "m" } };
  const account = f.zerosub.accounts.find((item) => item.id === "acc-b");
  account.windows[0].usedPct = 95;
  await finishSteerDelivery(f.paseo, f.input, f.deps);
  account.windows[0].usedPct = 10;
  let reads = 0;
  f.deps.getConfig = async () => {
    if (++reads === 3) f.agent.model = "different";
    return config;
  };
  assert.notEqual((await finishSteerDelivery(f.paseo, f.input, f.deps)).status, "sent");
  assert.equal(f.action().routing.intent.model, "m");
  assert.equal(sendsTo(f.world, f.agent.id).length, 0);
});

test("legacy replan records establish a baseline and wait for an eligibility transition", async () => {
  const f = moveRecoveryFixture();
  const account = f.zerosub.accounts.find((item) => item.id === "acc-b");
  account.windows[0].usedPct = 95;
  await finishSteerDelivery(f.paseo, f.input, f.deps);
  delete f.action().accountMoveReplan;
  account.windows[0].usedPct = 10;
  assert.equal((await finishSteerDelivery(f.paseo, f.input, f.deps)).status, "pending");
  assert.equal(f.action().accountMoveReplan.status, "waiting");
  assert.equal(sendsTo(f.world, f.agent.id).length, 0);
  account.windows[0].usedPct = 95;
  await finishSteerDelivery(f.paseo, f.input, f.deps);
  account.windows[0].usedPct = 10;
  assert.equal((await finishSteerDelivery(f.paseo, f.input, { ...f.deps })).status, "sent");
  assert.equal(sendsTo(f.world, f.agent.id).length, 1);
});

test("replan waits for the exact queued worker event and marks its receipt once", async () => {
  for (const phase of ["ready", "reserved"]) {
    const f = moveRecoveryFixture({ phase });
    const source = addWorkspace(f.world, { metadata: { [METADATA_KEY]: { epoch: 5 } } });
    const queuedAt = f.deps.now();
    source.metadata[WORKERS_KEY] = { worker: { state: "done", pendingWake: { state: "done", queuedAt } } };
    f.action().batch = { workspaceId: source.id, epoch: 5, events: [{ workerId: "worker", state: "done", queuedAt }] };
    const account = f.zerosub.accounts.find((item) => item.id === "acc-b");
    account.windows[0].usedPct = 95;
    await finishSteerDelivery(f.paseo, f.input, f.deps);
    account.windows[0].usedPct = 10;
    source.metadata[WORKERS_KEY].worker.pendingWake.queuedAt = "2026-11-27T00:00:00Z";
    assert.equal((await finishSteerDelivery(f.paseo, f.input, f.deps)).status, "pending");
    assert.equal(sendsTo(f.world, f.agent.id).length, 0);
    source.metadata[WORKERS_KEY].worker.pendingWake.queuedAt = queuedAt;
    assert.equal((await finishSteerDelivery(f.paseo, f.input, f.deps)).status, "sent");
    assert.equal(source.metadata[WORKERS_KEY].worker.pendingWake, null);
    assert.equal(sendsTo(f.world, f.agent.id).length, 1);
    assert.equal(f.action().batch.events[0].queuedAt, queuedAt);
  }
});
