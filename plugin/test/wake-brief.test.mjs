// Pending wake briefs (F4): a wake staged behind a /clear is delivered only
// when the brief send succeeded. Tests cover clear→brief success, failure→
// pending→retry, LockBusy retry, restart→boot resend, and no double delivery.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-resolve-hooks.mjs", import.meta.url);

const supervise = await import("../server/supervise.ts");
const turnHook = await import("../server/turn-hook.ts");
const { collectSteerStates } = await import("../server/steer-feed.ts");
const { applyResume } = await import("../server/resume-apply.ts");
const { deliverSteer, finishSteerDelivery, dispatchAssignmentReport } = await import("../server/steer-delivery.ts");
const { LockBusy } = await import("../server/core/lock.mjs");
import { LABEL, METADATA_KEY } from "../server/core/paseo.mjs";
import { AGENTS_KEY } from "../server/core/agent-state.mjs";
import { ASSIGNMENT_KEY } from "../server/core/assign.mjs";
import { WORKERS_KEY } from "../server/core/supervision.mjs";
import { CHECKPOINT_KEY } from "../server/core/steer.mjs";

const REPO = "example-owner/example-repo";
const NOW = new Date("2026-11-24T12:00:00.000Z").getTime();
const at = (ms) => new Date(ms).toISOString();
const MIN = 60_000;

beforeEach(() => supervise.resetSupervisionForTests());

function makeWorld() {
  return { workspaces: [], agents: [], timelines: {}, calls: [], seq: 0, sendFails: false };
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
    createdAt: at(NOW - 24 * 3_600_000),
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
    persistence: { sessionId: `sess-${world.seq}` },
    updatedAt: at(NOW - MIN),
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
          if (world.sendFails) throw new Error("agent unreachable");
          world.calls.push(["agent.send", id, text, options]);
          await world.onSend?.(id, text, options);
        },
        setMetadata: async (patch) => {
          Object.assign(findAgent(id).metadata, structuredClone(patch));
        },
        commands: async () => ({ commands: world.commands ?? [] }),
        timeline: {
          refetch: async () => ({ entries: structuredClone(world.timelines[id] ?? []) }),
          subscribe: (handler) => {
            world.onTimeline = handler;
            return Object.assign(() => { world.onTimeline = null; }, { ready: Promise.resolve() });
          },
        },
      }),
    },
    providers: { snapshot: async () => ({ entries: [] }) },
  };
}

const noLock = (_name, fn) => fn({ verify() {} });
const sendsTo = (world, id) => world.calls.filter((c) => c[0] === "agent.send" && c[1] === id).map((c) => c[2]);

function scopeMeta({ activeSteer = "A", epoch = 3, workers = {}, agents = {}, checkpoint = null } = {}) {
  const meta = { [METADATA_KEY]: { main: true, activeSteer, epoch, scope: { id: REPO, kind: "github", locator: REPO } } };
  if (Object.keys(workers).length) meta[WORKERS_KEY] = structuredClone(workers);
  if (Object.keys(agents).length) meta[AGENTS_KEY] = structuredClone(agents);
  if (checkpoint) meta[CHECKPOINT_KEY] = structuredClone(checkpoint);
  return meta;
}

const entry = (state, task = "do it", extra = {}) => ({
  task, startedBy: "A", startedAt: at(NOW - 30 * MIN), epoch: 3, state, status: null, resumes: 0, lastWakeAt: null, pendingWake: null, ...extra,
});

function provisioned(world) {
  const ws = addWorkspace(world, { metadata: scopeMeta({ checkpoint: { task: "t", tests: [], blockers: [], next: null } }) });
  const steer = addAgent(world, {
    title: "Steer A",
    workspaceId: ws.id,
    labels: { [LABEL.repo]: REPO, [LABEL.role]: "steer", [LABEL.slot]: "A", [LABEL.scope]: REPO },
  });
  return { ws, steer };
}

function clearTurnTimeline(world, agentId, turnId = "t-clear") {
  const saved = world.workspaces[0].metadata[AGENTS_KEY]?.[agentId];
  const messageId = saved?.action?.cleanup?.messageId;
  world.timelines[agentId] = [
    { turnId, item: { type: "user_message", text: "/clear", messageId } },
    { turnId, item: { type: "assistant_message", text: "cleared" } },
  ];
}

test("clear then brief succeeds via turn-after: delivered once", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world);
  const workerId = "worker-1";
  world.workspaces[0].metadata[WORKERS_KEY] = {
    [workerId]: entry("done", "t", { pendingWake: { state: "done", queuedAt: at(NOW - 3 * MIN) } }),
  };
  const note = `[factory] Scope ${REPO}, epoch 3: worker ${workerId} done.`;
  world.workspaces[0].metadata[AGENTS_KEY] = {
    [steer.id]: {
      needsResume: { reason: "daemon-restart", at: at(NOW - MIN) },
      action: {
        kind: "delivery", wakeId: "wake-1", renewal: "clear", phase: "renewing",
        queuedAt: at(NOW - MIN), epoch: 3, note,
        batch: { workspaceId: ws.id, epoch: 3, events: [{ workerId, state: "done" }] },
        cleanup: { kind: "clear", at: at(NOW - MIN), sessionId: "sess-before", reason: "resume", note },
      },
    },
  };
  steer.persistence.sessionId = "sess-after";
  clearTurnTimeline(world, steer.id);
  await turnHook.handleTurnAfter(
    { agent: { id: steer.id }, turnId: "t-clear", outcome: { kind: "completed" } },
    { paseo: fakeClient(world) },
    { getResumeBrief: async () => "Resume body", lock: noLock },
  );
  const texts = sendsTo(world, steer.id);
  assert.equal(texts.length, 1);
  assert.match(texts[0], /\[Factory resume\]/);
  assert.match(texts[0], /Resume body/);
  assert.match(texts[0], new RegExp(`worker ${workerId} done`));
  const agents = world.workspaces[0].metadata[AGENTS_KEY][steer.id];
  assert.equal(agents.needsResume, null);
  assert.equal(agents.action.phase, "done");
  assert.equal(agents.action.cleanup, null);
  const worker = world.workspaces[0].metadata[WORKERS_KEY][workerId];
  assert.ok(worker.lastWakeAt, "delivered stamps lastWakeAt");
  assert.equal(worker.pendingWake, null);
});

test("brief send fails via turn-after: pending, retried next tick, delivered once", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world);
  const workerId = "worker-1";
  world.workspaces[0].metadata[WORKERS_KEY] = {
    [workerId]: entry("done", "t", { pendingWake: { state: "done", queuedAt: at(NOW - 3 * MIN) } }),
  };
  const note = `[factory] Scope ${REPO}, epoch 3: worker ${workerId} done.`;
  world.workspaces[0].metadata[AGENTS_KEY] = {
    [steer.id]: {
      needsResume: { reason: "daemon-restart", at: at(NOW - MIN) },
      action: {
        kind: "delivery", wakeId: "wake-1", renewal: "clear", phase: "renewing",
        queuedAt: at(NOW - MIN), epoch: 3, note,
        batch: { workspaceId: ws.id, epoch: 3, events: [{ workerId, state: "done" }] },
        cleanup: { kind: "clear", at: at(NOW - MIN), sessionId: "sess-before", reason: "resume", note },
      },
    },
  };
  steer.persistence.sessionId = "sess-after";
  clearTurnTimeline(world, steer.id);
  world.sendFails = true;
  await turnHook.handleTurnAfter(
    { agent: { id: steer.id }, turnId: "t-clear", outcome: { kind: "completed" } },
    { paseo: fakeClient(world) },
    { getResumeBrief: async () => "Resume body", lock: noLock },
  );
  assert.equal(sendsTo(world, steer.id).length, 0, "failed send records nothing");
  const kept = world.workspaces[0].metadata[AGENTS_KEY][steer.id];
  assert.ok(kept.needsResume, "needsResume kept");
  assert.equal(kept.action.wakeId, "wake-1");
  assert.equal(kept.action.phase, "uncertain");
  assert.ok(kept.action.lastError);
  assert.ok(world.workspaces[0].metadata[WORKERS_KEY][workerId].pendingWake, "workers stay queued");
  world.sendFails = false;
  const retry = await supervise.retryPendingWakeBrief(
    fakeClient(world),
    { id: REPO, workspaceId: ws.id },
    { lock: noLock, log: () => {}, nowMs: NOW + MIN, nowIso: at(NOW + MIN), buildBrief: async () => "Resume body" },
  );
  assert.equal(retry.delivered, true);
  assert.equal(retry.target, steer.id);
  assert.equal(sendsTo(world, steer.id).length, 1, "retried once");
  assert.match(sendsTo(world, steer.id)[0], new RegExp(`worker ${workerId} done`));
  assert.equal(world.workspaces[0].metadata[AGENTS_KEY][steer.id].action.phase, "done");
  assert.equal(world.workspaces[0].metadata[WORKERS_KEY][workerId].pendingWake, null);
  const again = await supervise.retryPendingWakeBrief(
    fakeClient(world),
    { id: REPO, workspaceId: ws.id },
    { lock: noLock, log: () => {}, nowMs: NOW + 2 * MIN, nowIso: at(NOW + 2 * MIN), buildBrief: async () => "Resume body" },
  );
  assert.equal(again.attempted, false);
  assert.equal(sendsTo(world, steer.id).length, 1, "no double delivery");
});

test("lock busy on the turn-after follow-up is retried", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world);
  const workerId = "worker-1";
  world.workspaces[0].metadata[WORKERS_KEY] = {
    [workerId]: entry("done", "t", { pendingWake: { state: "done", queuedAt: at(NOW - 3 * MIN) } }),
  };
  const note = `[factory] Scope ${REPO}, epoch 3: worker ${workerId} done.`;
  world.workspaces[0].metadata[AGENTS_KEY] = {
    [steer.id]: {
      needsResume: { reason: "daemon-restart", at: at(NOW - MIN) },
      action: {
        kind: "delivery", wakeId: "wake-1", renewal: "clear", phase: "renewing",
        queuedAt: at(NOW - MIN), epoch: 3, note,
        batch: { workspaceId: ws.id, epoch: 3, events: [{ workerId, state: "done" }] },
        cleanup: { kind: "clear", at: at(NOW - MIN), sessionId: "sess-before", reason: "resume", note },
      },
    },
  };
  steer.persistence.sessionId = "sess-after";
  clearTurnTimeline(world, steer.id);
  let calls = 0;
  const flaky = async (name, fn) => {
    calls += 1;
    if (calls === 1) throw new LockBusy(`Workspace lock ${name} is held by another process`);
    return noLock(name, fn);
  };
  await turnHook.handleTurnAfter(
    { agent: { id: steer.id }, turnId: "t-clear", outcome: { kind: "completed" } },
    { paseo: fakeClient(world) },
    { getResumeBrief: async () => "Resume body", lock: flaky },
  );
  assert.ok(calls >= 2, "busy lock retried");
  assert.equal(sendsTo(world, steer.id).length, 1);
  assert.equal(world.workspaces[0].metadata[AGENTS_KEY][steer.id].action.phase, "done");
  assert.equal(world.workspaces[0].metadata[WORKERS_KEY][workerId].pendingWake, null);
});

test("restart between clear and brief: boot check re-sends once", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world);
  const workerId = "worker-1";
  world.workspaces[0].metadata[WORKERS_KEY] = {
    [workerId]: entry("done", "t", { pendingWake: { state: "done", queuedAt: at(NOW - 3 * MIN) } }),
  };
  const note = `[factory] Scope ${REPO}, epoch 3: worker ${workerId} done.`;
  world.workspaces[0].metadata[AGENTS_KEY] = {
    [steer.id]: {
      needsResume: { reason: "daemon-restart", at: at(NOW - MIN) },
      previousSessions: ["session-before-restart"],
      action: {
        kind: "delivery", wakeId: "wake-1", renewal: "clear", phase: "ready",
        queuedAt: at(NOW - MIN), epoch: 3, note,
        batch: { workspaceId: ws.id, epoch: 3, events: [{ workerId, state: "done" }] },
        facts: { cleared: { at: at(NOW - MIN), mode: "clear" }, actionVerified: true },
      },
    },
  };
  const result = await supervise.runBootFinished(
    fakeClient(world),
    [],
    {
      settings: { enabled: true, batchMinutes: 0, wakeDebounceSeconds: 20, watchdogMinutes: 15, staleMinutes: 60, answerMinutes: 10, maxAutoResumes: 2 },
      lock: noLock, log: () => {}, nowMs: NOW, nowIso: at(NOW), buildBrief: async () => "Resume body",
    },
  );
  assert.equal(result.wakes.length, 1);
  assert.equal(result.wakes[0].sent, true);
  assert.equal(sendsTo(world, steer.id).length, 1);
  assert.match(sendsTo(world, steer.id)[0], new RegExp(`worker ${workerId} done`));
  assert.equal(world.workspaces[0].metadata[AGENTS_KEY][steer.id].action.phase, "done");
  assert.equal(world.workspaces[0].metadata[WORKERS_KEY][workerId].pendingWake, null);
  const flush = await supervise.flushAllScopes(
    fakeClient(world),
    {
      settings: { enabled: true, batchMinutes: 0, wakeDebounceSeconds: 20, watchdogMinutes: 15, staleMinutes: 60, answerMinutes: 10, maxAutoResumes: 2 },
      lock: noLock, log: () => {}, nowMs: NOW + MIN, nowIso: at(NOW + MIN), bootCheckDone: true, buildBrief: async () => "Resume body",
    },
  );
  assert.equal(sendsTo(world, steer.id).length, 1, "boot resend happens once");
  assert.ok(flush.every((f) => f.flushed === false));
});

test("flush retries at most once per tick without duplicate briefs", async () => {
  const world = makeWorld();
  const ws = addWorkspace(world, { metadata: scopeMeta({ checkpoint: { task: "t", tests: [], blockers: [], next: null } }) });
  const steerA = addAgent(world, {
    title: "Steer A", workspaceId: ws.id,
    labels: { [LABEL.repo]: REPO, [LABEL.role]: "steer", [LABEL.slot]: "A", [LABEL.scope]: REPO },
  });
  const steerB = addAgent(world, {
    title: "Steer B", workspaceId: ws.id,
    labels: { [LABEL.repo]: REPO, [LABEL.role]: "steer", [LABEL.slot]: "B", [LABEL.scope]: REPO },
  });
  world.workspaces[0].metadata[WORKERS_KEY] = {
    "worker-1": entry("done", "t", { pendingWake: { state: "done", queuedAt: at(NOW - 3 * MIN) } }),
    "worker-2": entry("blocked", "t", { pendingWake: { state: "blocked", queuedAt: at(NOW - 2 * MIN) } }),
  };
  world.workspaces[0].metadata[AGENTS_KEY] = {
    [steerA.id]: {
      needsResume: { reason: "daemon-restart", at: at(NOW - MIN) },
      previousSessions: ["session-before-a"],
      action: {
        kind: "delivery", wakeId: "wake-a", renewal: "clear", phase: "ready",
        queuedAt: at(NOW - 2 * MIN), epoch: 3, note: "note a",
        batch: { workspaceId: ws.id, epoch: 3, events: [{ workerId: "worker-1", state: "done" }] },
        facts: { cleared: { at: at(NOW - MIN), mode: "clear" }, actionVerified: true },
      },
    },
    [steerB.id]: {
      needsResume: { reason: "daemon-restart", at: at(NOW - MIN) },
      previousSessions: ["session-before-b"],
      action: {
        kind: "delivery", wakeId: "wake-b", renewal: "clear", phase: "ready",
        queuedAt: at(NOW - MIN), epoch: 3, note: "note b",
        batch: { workspaceId: ws.id, epoch: 3, events: [{ workerId: "worker-2", state: "blocked" }] },
        facts: { cleared: { at: at(NOW - MIN), mode: "clear" }, actionVerified: true },
      },
    },
  };
  const deps = {
    settings: { enabled: true, batchMinutes: 0, wakeDebounceSeconds: 20, watchdogMinutes: 15, staleMinutes: 60, answerMinutes: 10, maxAutoResumes: 2 },
    lock: noLock, log: () => {}, nowMs: NOW, nowIso: at(NOW), bootCheckDone: true, buildBrief: async () => "Resume body",
  };
  const first = await supervise.flushScope(fakeClient(world), { id: REPO, workspaceId: ws.id }, deps);
  assert.equal(first.flushed, true);
  assert.equal(world.calls.filter((c) => c[0] === "agent.send").length, 1, "one brief per tick");
  const remaining = [steerA.id, steerB.id]
    .map((id) => world.workspaces[0].metadata[AGENTS_KEY][id].action)
    .filter((action) => action && action.phase !== "done");
  assert.equal(remaining.length, 1, "one pending left for the next tick");
  const second = await supervise.flushScope(
    fakeClient(world), { id: REPO, workspaceId: ws.id }, { ...deps, nowMs: NOW + MIN, nowIso: at(NOW + MIN) },
  );
  assert.equal(second.flushed, true);
  assert.equal(world.calls.filter((c) => c[0] === "agent.send").length, 2);
  const third = await supervise.flushScope(
    fakeClient(world), { id: REPO, workspaceId: ws.id }, { ...deps, nowMs: NOW + 2 * MIN, nowIso: at(NOW + 2 * MIN) },
  );
  assert.equal(third.flushed, false);
  assert.equal(world.calls.filter((c) => c[0] === "agent.send").length, 2, "no double delivery");
});

function deliveryFixture({ provider = "claude", minutesIdle = 0, tokens = 1000 } = {}) {
  const world = makeWorld();
  const { ws, steer } = provisioned(world);
  steer.provider = provider;
  steer.model = provider === "codex" ? "gpt-6.2-sol" : "claude-sonnet";
  steer.lastUsage = { contextWindowUsedTokens: tokens };
  ws.metadata[AGENTS_KEY] = {
    [steer.id]: minutesIdle === null ? {} : { lastTurnEndedAt: at(NOW - minutesIdle * MIN) },
  };
  const workerId = "worker-1";
  ws.metadata[WORKERS_KEY] = { [workerId]: entry("done", "task") };
  const client = fakeClient(world);
  const scope = { id: REPO, workspaceId: ws.id };
  const buildBrief = async () => "Compact checkpoint";
  const deps = { nowMs: NOW, lock: noLock, log: () => {}, buildBrief };
  const wake = (delivery) => supervise.sendScopeWake(client, {
    scope, events: [{ workerId, state: "done" }],
  }, { ...deps, delivery });
  const recheck = () => supervise.retryPendingWakeBrief(client, scope, deps);
  return { ws, steer, workerId, world, client, wake, recheck, deps, buildBrief };
}

for (const [label, minutesIdle] of [["warm", 1], ["cooling", 4.5], ["unknown", null]]) {
  test(`a ${label} steer receives the original wake`, async () => {
    const { wake, world, steer } = deliveryFixture({ minutesIdle });
    assert.equal((await wake()).sent, true);
    const sends = sendsTo(world, steer.id);
    assert.equal(sends.length, 1);
    assert.match(sends[0], /^\[factory\]/);
    assert.match(sends[0], /worker worker-1 done/);
  });
}

test("a cold Claude wake waits for a verified clear even when the hook runs during send", async () => {
  const { wake, recheck, ws, steer, workerId, world, client, deps, buildBrief } = deliveryFixture({ minutesIdle: 6 });
  const hook = () => turnHook.handleTurnAfter(
    { agent: { id: steer.id }, turnId: "t-clear", outcome: { kind: "completed" } },
    { paseo: client },
    { getResumeBrief: buildBrief, lock: deps.lock },
  );
  world.onSend = async (_id, text) => {
    if (text !== "/clear") return;
    const worker = ws.metadata[WORKERS_KEY][workerId];
    const state = ws.metadata[AGENTS_KEY][steer.id];
    assert.ok(worker.pendingWake);
    assert.equal(worker.lastWakeAt, null);
    assert.equal(state.action.cleanup.kind, "clear");
    assert.equal(state.action.phase, "renewing");
    assert.equal((await recheck()).delivered, false);
    assert.deepEqual(sendsTo(world, steer.id), ["/clear"]);
    steer.persistence.sessionId = "new-session";
    clearTurnTimeline(world, steer.id);
    await hook();
  };
  await wake();
  await hook();
  await recheck();
  assert.equal(sendsTo(world, steer.id).length, 2);
  assert.match(sendsTo(world, steer.id)[1], /\[Factory resume\]\nCompact checkpoint\n\n.*worker worker-1 done/s);
  assert.ok(ws.metadata[WORKERS_KEY][workerId].lastWakeAt);
  assert.equal(ws.metadata[WORKERS_KEY][workerId].pendingWake, null);
});

test("a native clear with a replaced timeline needs the matching live session change", async () => {
  const { wake, ws, steer, world, client, deps, buildBrief } = deliveryFixture({ minutesIdle: 6 });
  const previous = steer.persistence.sessionId;
  await wake();
  steer.persistence.sessionId = "native-new-session";
  world.timelines[steer.id] = [{
    item: { type: "assistant_message", text: `Claude switched to a new session: ${previous} -> native-new-session` },
  }];
  await turnHook.handleTurnAfter(
    { agent: { id: steer.id }, turnId: "clear-without-user-row", outcome: { kind: "completed" } },
    { paseo: client }, { getResumeBrief: buildBrief, lock: deps.lock },
  );
  assert.equal(ws.metadata[AGENTS_KEY][steer.id].action.facts.cleared.sessionId, "native-new-session");
  assert.match(sendsTo(world, steer.id)[1], /^\[Factory resume\]/);
});

test("an unverified clear leaves the brief and worker event pending", async () => {
  const { wake, recheck, ws, steer, workerId, world, client, deps, buildBrief } = deliveryFixture({ minutesIdle: 6 });
  assert.equal((await wake()).sent, false);
  clearTurnTimeline(world, steer.id);
  world.timelines[steer.id][1].item.text = "I switched to a new session.";
  ws.metadata[AGENTS_KEY][steer.id].action.facts = { actionVerified: true };
  await turnHook.handleTurnAfter(
    { agent: { id: steer.id }, turnId: "t-clear", outcome: { kind: "completed" } },
    { paseo: client },
    { getResumeBrief: buildBrief, lock: deps.lock },
  );
  assert.equal((await recheck()).delivered, false);
  assert.deepEqual(sendsTo(world, steer.id), ["/clear"]);
  assert.equal(ws.metadata[AGENTS_KEY][steer.id].action.phase, "blocked");
  assert.equal(ws.metadata[AGENTS_KEY][steer.id].action.facts.cleared, null);
  assert.match(ws.metadata[AGENTS_KEY][steer.id].action.facts.lastActionFailed.error, /session unchanged/);
  assert.equal(ws.metadata[WORKERS_KEY][workerId].lastWakeAt, null);
  assert.ok(ws.metadata[WORKERS_KEY][workerId].pendingWake);
});

test("an ordinary turn with a stale /clear row does not verify or release a pending clear", async () => {
  const { wake, recheck, ws, steer, world, client, deps, buildBrief } = deliveryFixture({ minutesIdle: 6 });
  await wake();
  const state = ws.metadata[AGENTS_KEY][steer.id];
  state.action.facts = { actionVerified: true };
  world.timelines[steer.id] = [
    { item: { type: "user_message", text: "/clear", messageId: "some-old-request" } },
    { turnId: "ordinary", item: { type: "user_message", text: "Continue working" } },
    { turnId: "ordinary", item: { type: "assistant_message", text: "Starting a new session later." } },
  ];
  await turnHook.handleTurnAfter(
    { agent: { id: steer.id }, turnId: "ordinary", outcome: { kind: "completed" } },
    { paseo: client }, { getResumeBrief: buildBrief, lock: deps.lock },
  );
  const current = ws.metadata[AGENTS_KEY][steer.id];
  assert.equal(current.action.cleanup.messageId, state.action.cleanup.messageId);
  assert.equal(current.action.facts?.cleared, undefined);
  assert.equal((await recheck()).delivered, false);
  assert.deepEqual(sendsTo(world, steer.id), ["/clear"]);
});

test("a ready brief with the original provider session is held visibly", async () => {
  const { ws, steer, world, recheck } = deliveryFixture({ minutesIdle: 6 });
  ws.metadata[AGENTS_KEY][steer.id] = {
    previousSessions: [steer.persistence.sessionId],
    action: {
      kind: "delivery", wakeId: "ready-1", renewal: "clear", phase: "ready",
      queuedAt: at(NOW), epoch: 3, note: "",
      facts: { cleared: { mode: "clear", at: at(NOW) }, actionVerified: true },
    },
  };
  assert.equal((await recheck()).delivered, false);
  assert.deepEqual(sendsTo(world, steer.id), []);
  assert.equal(ws.metadata[AGENTS_KEY][steer.id].action.phase, "blocked");
});

test("a warm steer below the floor gets the queued wake after its turn without renewal", async () => {
  const { ws, steer, workerId, world, client, deps } = deliveryFixture({ minutesIdle: 1, tokens: 99_999 });
  steer.model = "claude-opus";
  steer.lastUsage.contextWindowMaxTokens = 1_000_000;
  const scope = { id: REPO, workspaceId: ws.id };
  ws.metadata[WORKERS_KEY][workerId].pendingWake = { state: "done", queuedAt: at(NOW) };
  steer.activeTurn = { turnId: "in-progress" };
  const run = () => supervise.flushScope(client, scope, { ...deps, bootCheckDone: true, settings: { enabled: true } });
  assert.equal((await run()).reason, "target-busy");
  assert.deepEqual(sendsTo(world, steer.id), []);
  steer.activeTurn = null;
  assert.equal((await run()).flushed, true);
  assert.equal(sendsTo(world, steer.id).length, 1);
  assert.match(sendsTo(world, steer.id)[0], /worker worker-1 done/);
  assert.equal(ws.metadata[AGENTS_KEY][steer.id].action.cleanup, undefined);
});

test("a new turn between clear reservation and dispatch leaves the wake queued", async () => {
  const { ws, steer, workerId, world, wake } = deliveryFixture({ minutesIdle: 6 });
  // Insert the competing turn after observing the clear reservation, before
  // the SDK returns its next steer snapshot to the sender.
  const original = ws.metadata;
  let reserved = false;
  Object.defineProperty(ws, "metadata", { get() {
    if (original[AGENTS_KEY][steer.id].action?.cleanup?.kind === "clear") {
      reserved = true;
      steer.activeTurn = { turnId: "new-turn" };
    }
    return original;
  } });
  assert.equal((await wake()).sent, false);
  assert.equal(reserved, true);
  assert.deepEqual(sendsTo(world, steer.id), []);
  assert.equal(original[AGENTS_KEY][steer.id].action.cleanup, undefined);
  assert.equal(original[AGENTS_KEY][steer.id].action.phase, "done");
  assert.ok(original[WORKERS_KEY][workerId].pendingWake);
});

test("a steer that starts working during the rewind lookup keeps its queued wake", async () => {
  const { ws, steer, workerId, world, wake } = deliveryFixture({ provider: "codex", minutesIdle: 31 });
  let rewinds = 0;
  assert.equal((await wake({ rewindClient: async () => ({
    fetchAgentTimeline: async () => {
      steer.activeTurn = { turnId: "new-codex-turn" };
      return { entries: [{ item: { type: "user_message", messageId: "rewind-point" } }] };
    },
    rewindAgent: async () => { rewinds += 1; },
  }) })).sent, false);
  assert.equal(rewinds, 0);
  assert.deepEqual(sendsTo(world, steer.id), []);
  assert.equal(ws.metadata[AGENTS_KEY][steer.id].action, null);
  assert.ok(ws.metadata[WORKERS_KEY][workerId].pendingWake);
});

test("a turn that starts while building a resume brief defers delivery and refreshes the checkpoint", async () => {
  const { ws, steer, world, client, deps } = deliveryFixture({ minutesIdle: 6 });
  ws.metadata[AGENTS_KEY][steer.id] = {
    action: {
      kind: "delivery", wakeId: "ready", renewal: "clear", phase: "ready",
      queuedAt: at(NOW), epoch: 3, note: "",
      facts: { cleared: { mode: "clear", sessionId: steer.persistence.sessionId }, actionVerified: true },
    },
  };
  const input = { workspaceId: ws.id, agentId: steer.id };
  const held = await finishSteerDelivery(client, input, { ...deps, buildBrief: async () => {
    steer.activeTurn = { turnId: "new-turn" };
    return "Old checkpoint";
  } });
  assert.equal(held.status, "pending");
  assert.equal(ws.metadata[AGENTS_KEY][steer.id].action.packet, undefined);
  assert.deepEqual(sendsTo(world, steer.id), []);
  steer.activeTurn = null;
  assert.equal((await finishSteerDelivery(client, input, { ...deps, buildBrief: async () => "Current checkpoint" })).status, "sent");
  assert.deepEqual(sendsTo(world, steer.id), ["[Factory resume]\nCurrent checkpoint"]);
});

test("a stored stale-worker brief cannot wake a steer after its worker is archived and removed", async () => {
  const { ws, steer, world, workerId, recheck } = deliveryFixture({ minutesIdle: 6 });
  addAgent(world, { id: workerId, archivedAt: at(NOW - MIN) });
  delete ws.metadata[WORKERS_KEY][workerId];
  const batch = { workspaceId: ws.id, epoch: 3, events: [{ workerId, state: "stale" }] };
  ws.metadata[AGENTS_KEY][steer.id] = {
    action: {
      kind: "delivery", wakeId: "old-wake", renewal: "clear", phase: "ready",
      queuedAt: at(NOW), epoch: 3, note: `worker ${workerId} stale`, batch,
      packet: `[Factory resume]\nOld checkpoint\n[factory] Scope ${REPO}, epoch 3: worker ${workerId} stale.`,
      facts: { cleared: { mode: "clear", sessionId: steer.persistence.sessionId }, actionVerified: true },
    },
  };
  assert.equal((await recheck()).delivered, false);
  assert.deepEqual(sendsTo(world, steer.id), []);
  assert.equal(ws.metadata[AGENTS_KEY][steer.id].action.phase, "done");
});

for (const [name, provider, minutesIdle, tokens] of [
  ["cold Codex", "codex", 31, 1000],
  ["warm Codex with a large context", "codex", 1, 100_000],
  ["an oversized context with unknown warmth", "codex", null, 100_000],
]) {
  test(`${name} rewinds before delivering a wake and assigns the next brief anchor`, async () => {
    const { wake, recheck, ws, steer, workerId, world } = deliveryFixture({ provider, minutesIdle, tokens });
    ws.metadata[AGENTS_KEY][steer.id].action = {
      kind: "delivery", wakeId: "prev", phase: "done",
      facts: { refreshed: { briefMessageId: "brief-anchor" } },
    };
    const rewindClient = async () => ({
      fetchAgentTimeline: async () => ({
        entries: ["first", "brief-anchor"].map((messageId) => ({ item: { type: "user_message", messageId } })),
      }),
      rewindAgent: async (...args) => {
        assert.equal((await recheck()).delivered, false);
        assert.equal(ws.metadata[WORKERS_KEY][workerId].lastWakeAt, null);
        assert.deepEqual(sendsTo(world, steer.id), []);
        world.calls.push(["rewind", ...args]);
      },
    });
    const result = await wake({ rewindClient });
    assert.equal(result.sent, true);
    assert.equal(result.resumed, true);
    const [rewind, send] = world.calls.filter(([kind]) => kind === "rewind" || kind === "agent.send");
    assert.deepEqual(rewind, ["rewind", steer.id, "brief-anchor", "conversation"]);
    assert.match(send[2], /\[Factory resume\]\nCompact checkpoint\n\n.*worker worker-1 done/s);
    assert.ok(send[3].messageId);
    assert.equal(ws.metadata[AGENTS_KEY][steer.id].action.facts.refreshed.briefMessageId, send[3].messageId);
    assert.equal(ws.metadata[WORKERS_KEY][workerId].pendingWake, null);
    assert.equal((await recheck()).attempted, false);
    assert.equal(sendsTo(world, steer.id).length, 1);
  });
}

for (const [provider, minutesIdle, tokens, outcome] of [
  ["claude", 6, 1000, "completed"], ["claude-api", 1, 100_000, "completed"], ["claude-api", 1, 100_000, "failed"],
]) {
  test(`${provider} delivers the original wake after native compaction ${outcome}`, async () => {
    const { wake, ws, steer, workerId, world, client } = deliveryFixture({ provider, minutesIdle, tokens });
    ws.metadata[WORKERS_KEY][workerId].pendingWake = { state: "done", queuedAt: at(NOW) };
    const delivery = { keepChatHistory: async () => true, rewindClient: async () => assert.fail("must not rewind") };
    assert.equal((await wake(delivery)).sent, false);
    const [[, , command, { messageId }]] = world.calls.filter(([kind]) => kind === "agent.send");
    assert.match(command, /^\/compact\b/);
    assert.equal(ws.metadata[AGENTS_KEY][steer.id].action.renewal, "send");
    assert.ok(ws.metadata[WORKERS_KEY][workerId].pendingWake);
    const turnId = "t-compact";
    world.timelines[steer.id] = [
      { turnId, item: { type: "user_message", text: command, messageId } },
      ...(outcome === "completed" ? [{ turnId, item: { type: "compaction", status: "completed" } }] : []),
    ];
    await turnHook.handleTurnAfter({ agent: { id: steer.id }, turnId, outcome: { kind: outcome } },
      { paseo: client }, { lock: noLock, log: () => {}, delivery });
    const sends = sendsTo(world, steer.id);
    assert.equal(sends.length, 2);
    assert.match(sends[1], /^\[factory\].*worker worker-1 done/s);
    assert.equal(ws.metadata[WORKERS_KEY][workerId].pendingWake, null);
  });
}

test("a Codex wake waits for out-of-band native compaction without a turn hook", async () => {
  const { wake, ws, steer, world } = deliveryFixture({ provider: "codex", minutesIdle: 31 });
  world.commands = [{ name: "compact", kind: "command" }];
  const { promise: compactSent, resolve } = Promise.withResolvers();
  world.onSend = (_id, command) => { if (command === "/compact") resolve(); };
  const deliver = wake({ keepChatHistory: async () => true, rewindClient: async () => assert.fail("must not rewind") });
  await compactSent;
  assert.deepEqual(sendsTo(world, steer.id), ["/compact"]);
  world.onTimeline({ agentId: steer.id, event: { type: "timeline", item: { type: "compaction", status: "completed", trigger: "manual" } } });
  assert.equal((await deliver).sent, true);
  assert.match(sendsTo(world, steer.id)[1], /^\[factory\].*worker worker-1 done/s);
  assert.equal(ws.metadata[AGENTS_KEY][steer.id].action.cleanup, null);
  assert.equal(world.onTimeline, null);
});

test("recovery delivers directly when Keep chat history is on and the provider cannot compact", async () => {
  const { wake, ws, steer, world } = deliveryFixture({ provider: "unknown", minutesIdle: null, tokens: 100_000 });
  world.commands = [{ name: "compact", kind: "skill" }];
  ws.metadata[AGENTS_KEY][steer.id].needsResume = { reason: "daemon-restart", at: at(NOW - MIN) };
  assert.equal((await wake({ keepChatHistory: async () => true, rewindClient: async () => assert.fail("must not rewind") })).sent, true);
  assert.match(sendsTo(world, steer.id)[0], /^\[factory\].*worker worker-1 done/s);
  assert.equal(sendsTo(world, steer.id).length, 1);
});

test("an assignment report to the warm active holder keeps the chat and records the send", async () => {
  const { ws, steer, world, client } = deliveryFixture({ provider: "codex", minutesIdle: 1, tokens: 100_000 });
  const source = addWorkspace(world, { metadata: {
    [ASSIGNMENT_KEY]: { by: steer.id, requesterWorkspaceId: ws.id, epoch: 3, reportActionId: "report",
      reportText: "completed assignment", reportedAt: null },
  } });
  const deps = { lock: noLock, now: () => at(NOW), keepChatHistory: async () => true,
    rewindClient: async () => assert.fail("must not rewind") };
  assert.equal((await dispatchAssignmentReport(client, source.id, deps)).status, "sent");
  assert.deepEqual(sendsTo(world, steer.id), ["completed assignment"]);
  assert.ok(source.metadata[ASSIGNMENT_KEY].reportedAt);
  assert.equal(ws.metadata[AGENTS_KEY][steer.id].action.renewal, "send");
});

test("recovery sends a brief from a previously blocked rewind without attempting it again", async () => {
  const { ws, steer, world, client } = deliveryFixture({ provider: "codex", minutesIdle: 31 });
  ws.metadata[AGENTS_KEY][steer.id].action = {
    kind: "delivery", wakeId: "old-wake", epoch: 3, phase: "blocked", renewal: "rewind",
    note: "worker finished", queuedAt: at(NOW), lastError: "no usable rewind point",
  };
  const result = await finishSteerDelivery(client, { workspaceId: ws.id, agentId: steer.id }, {
    lock: noLock, keepChatHistory: async () => true, buildBrief: async () => "Checkpoint",
    rewindClient: async () => assert.fail("must not rewind"),
  });
  assert.equal(result.status, "sent");
  assert.deepEqual(sendsTo(world, steer.id), ["[Factory resume]\nCheckpoint\n\nworker finished"]);
});

test("recovery releases an expired optional compact and does not restore its cleanup record", async () => {
  const { ws, steer, world, client } = deliveryFixture({ minutesIdle: 6 });
  ws.metadata[AGENTS_KEY][steer.id].action = {
    kind: "activate", wakeId: "activation", epoch: 3, phase: "ready", renewal: "send", queuedAt: at(NOW),
    note: "Continue as active steer", cleanup: { kind: "compact", reason: "resume", at: at(Date.now() - 2 * MIN) },
  };
  const result = await finishSteerDelivery(client, { workspaceId: ws.id, agentId: steer.id }, {
    lock: noLock, keepChatHistory: async () => true, buildBrief: async () => "Checkpoint",
  });
  assert.equal(result.status, "sent");
  assert.deepEqual(sendsTo(world, steer.id), ["[Factory resume]\nCheckpoint\n\nContinue as active steer"]);
  assert.equal(ws.metadata[AGENTS_KEY][steer.id].action.cleanup, null);
});

test("resume without a rewind point exposes the fallback in the result and the steer pill", async () => {
  const { ws, client, steer, world, deps, buildBrief } = deliveryFixture({ provider: "codex", minutesIdle: 31, tokens: 110_000 });
  const result = await applyResume(client, { workspaceId: ws.id, agentId: steer.id }, {
    lock: deps.lock,
    now: () => at(NOW),
    buildBrief,
    rewindClient: async () => ({
      fetchAgentTimeline: async () => ({ entries: [{ item: { type: "tool_call", messageId: "not-a-user-message" } }] }),
      rewindAgent: async () => assert.fail("a send-only timeline has no rewind point"),
    }),
  });
  assert.equal(result.status, "blocked");
  assert.match(result.detail, /no usable rewind point.*Use Fresh/);
  const [row] = collectSteerStates(world, { settings: null, nowMs: NOW });
  assert.equal(row.state, "needs-resume");
  assert.equal(row.detail, result.detail);
  assert.deepEqual(sendsTo(world, steer.id), []);
});

test("a failed delivery rewind stays uncertain with its attempt marker, not a silent retry", async () => {
  const { ws, client, steer, world, deps, buildBrief } = deliveryFixture({ provider: "codex", minutesIdle: 31, tokens: 110_000 });
  const result = await applyResume(client, { workspaceId: ws.id, agentId: steer.id }, {
    lock: deps.lock,
    now: () => at(NOW),
    buildBrief,
    rewindClient: async () => ({
      fetchAgentTimeline: async () => ({ entries: [{ item: { type: "user_message", messageId: "first" } }] }),
      rewindAgent: async () => { throw new Error("provider forked, then failed"); },
    }),
  });
  assert.equal(result.status, "blocked");
  assert.match(result.detail, /uncertain.*Inspect/);
  const entry = ws.metadata[AGENTS_KEY][steer.id];
  assert.equal(entry.action.phase, "blocked");
  assert.ok(entry.action.rewindAttempt, "the uncertain attempt is retained for inspection");
  assert.deepEqual(sendsTo(world, steer.id), []);
  const [row] = collectSteerStates(world, { settings: null, nowMs: NOW });
  assert.equal(row.state, "needs-resume");
});

test("a cold switch delivery uses the compact brief and drops the outgoing transcript excerpt", async () => {
  const { ws, client, steer, world, deps, buildBrief } = deliveryFixture({ provider: "codex", minutesIdle: 31 });
  const result = await deliverSteer(client, {
    workspaceId: ws.id, agentId: steer.id, epoch: 3,
    text: "Full handoff: outgoing transcript excerpt", renewalNote: "Switch to this steer",
  }, {
    lock: deps.lock,
    now: () => at(NOW),
    buildBrief,
    rewindClient: async () => ({
      fetchAgentTimeline: async () => ({ entries: [{ item: { type: "user_message", messageId: "first" } }] }),
      rewindAgent: async () => {},
    }),
  });
  assert.equal(result.status, "sent");
  assert.deepEqual(sendsTo(world, steer.id), ["[Factory resume]\nCompact checkpoint\n\nSwitch to this steer"]);
});

test("a newer worker event stays queued when the renewed brief is accepted", async () => {
  const { wake, ws, steer, workerId, world, client, deps, buildBrief } = deliveryFixture({ minutesIdle: 6 });
  assert.equal((await wake()).sent, false);
  const worker = ws.metadata[WORKERS_KEY][workerId];
  worker.pendingWake = { state: "blocked", queuedAt: at(NOW + MIN) };
  steer.persistence.sessionId = "new-session";
  clearTurnTimeline(world, steer.id);
  await turnHook.handleTurnAfter(
    { agent: { id: steer.id }, turnId: "t-clear", outcome: { kind: "completed" } },
    { paseo: client },
    { getResumeBrief: buildBrief, lock: deps.lock },
  );
  assert.equal(sendsTo(world, steer.id).length, 2);
  assert.deepEqual(ws.metadata[WORKERS_KEY][workerId].pendingWake, { state: "blocked", queuedAt: at(NOW + MIN) });
});

test("an ambiguous send acknowledgement retries the same brief and message ID", async () => {
  const { wake, recheck, ws, steer, world } = deliveryFixture({ provider: "codex", minutesIdle: 31 });
  const receipts = new Map();
  world.onSend = async (_id, text, options) => {
    const { messageId } = options;
    if (receipts.has(messageId)) {
      assert.equal(receipts.get(messageId), text);
      return;
    }
    receipts.set(messageId, text);
    throw new Error("acknowledgement lost");
  };
  const rewindClient = async () => ({
    fetchAgentTimeline: async () => ({ entries: [{ item: { type: "user_message", messageId: "first" } }] }),
    rewindAgent: async () => {},
  });
  assert.equal((await wake({ rewindClient })).sent, false);
  assert.equal(ws.metadata[AGENTS_KEY][steer.id].action.phase, "uncertain");
  assert.equal((await recheck()).delivered, true);
  assert.equal(receipts.size, 1);
  assert.equal(sendsTo(world, steer.id).length, 2, "both requests use the same receipt");
  assert.equal((await recheck()).attempted, false);
});

test("a later resume marker survives acknowledgement of an earlier warm wake", async () => {
  const { wake, ws, steer, world } = deliveryFixture({ minutesIdle: 1 });
  const later = { reason: "limit", at: at(NOW + MIN) };
  world.onSend = async () => {
    ws.metadata[AGENTS_KEY][steer.id].needsResume = later;
  };
  assert.equal((await wake()).sent, true);
  assert.deepEqual(ws.metadata[AGENTS_KEY][steer.id].needsResume, later);
});

test("a lost worker acknowledgement resumes after the recorded admission without another prompt", async () => {
  const { wake, recheck, ws, steer, workerId, world, client } = deliveryFixture({ minutesIdle: 1 });
  ws.metadata[WORKERS_KEY][workerId].pendingWake = { state: "done", queuedAt: at(NOW - MIN) };
  const ref = client.workspaces.ref;
  let failAck = true;
  client.workspaces.ref = (id) => {
    const handle = ref(id);
    return { ...handle, setMetadata: async (patch) => {
      if (patch[WORKERS_KEY] && failAck && ws.metadata[AGENTS_KEY][steer.id].action?.phase === "sent") {
        failAck = false;
        throw Error("worker acknowledgement disconnected");
      }
      return handle.setMetadata(patch);
    } };
  };
  assert.equal((await wake()).sent, false);
  assert.equal(ws.metadata[AGENTS_KEY][steer.id].action.phase, "sent");
  assert.equal(ws.metadata[WORKERS_KEY][workerId].pendingWake.state, "done");
  assert.equal((await recheck()).delivered, true);
  assert.equal(ws.metadata[WORKERS_KEY][workerId].pendingWake, null);
  assert.equal(sendsTo(world, steer.id).length, 1);
});

test("a reserved switch retains the cold-context decision after recovery", async () => {
  const { ws, steer, world, client, deps, buildBrief } = deliveryFixture({ minutesIdle: 6 });
  const { newSteerAction } = await import("../server/core/steer-action.mjs");
  ws.metadata[AGENTS_KEY][steer.id].action = newSteerAction({
    id: "switch-id", kind: "switch", epoch: 3, at: at(NOW), text: "Original handoff", note: "Handoff note", phase: "reserved",
  });
  const result = await finishSteerDelivery(client, { workspaceId: ws.id, agentId: steer.id }, { lock: deps.lock, now: () => at(NOW), buildBrief });
  assert.equal(result.status, "pending");
  assert.deepEqual(sendsTo(world, steer.id), ["/clear"]);
  assert.equal(ws.metadata[AGENTS_KEY][steer.id].action.wakeId, "switch-id");
  assert.equal(ws.metadata[AGENTS_KEY][steer.id].action.phase, "renewing");
});
