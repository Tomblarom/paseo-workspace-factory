// Pending wake briefs (F4): a wake staged behind a /clear is delivered only
// when the brief send succeeded. Tests cover clear→brief success, failure→
// pending→retry, LockBusy retry, restart→boot resend, and no double delivery.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-resolve-hooks.mjs", import.meta.url);

const supervise = await import("../server/supervise.ts");
const turnHook = await import("../server/turn-hook.ts");
const { LockBusy } = await import("../server/factory/lock.ts");
import { LABEL, METADATA_KEY } from "../../src/paseo.mjs";
import { AGENTS_KEY } from "../../src/agent-state.mjs";
import { WORKERS_KEY } from "../../src/supervision.mjs";
import { CHECKPOINT_KEY } from "../../src/steer.mjs";

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
        send: async (text) => {
          if (world.sendFails) throw new Error("agent unreachable");
          world.calls.push(["agent.send", id, text]);
        },
        setMetadata: async (patch) => {
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
  world.timelines[agentId] = [
    { turnId, item: { type: "user_message", text: "/clear" } },
    { turnId, item: { type: "assistant_message", text: "cleared" } },
  ];
}

test("clear then brief succeeds via turn-after: delivered once", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world);
  const workerId = "worker-1";
  world.workspaces[0].metadata[WORKERS_KEY] = {
    [workerId]: entry("done", "t", { pendingWake: { state: "done", queuedAt: at(NOW) } }),
  };
  const note = `[factory] Scope ${REPO}, epoch 3: worker ${workerId} done.`;
  world.workspaces[0].metadata[AGENTS_KEY] = {
    [steer.id]: {
      needsResume: { reason: "daemon-restart", at: at(NOW - MIN) },
      pendingAction: { kind: "clear", at: at(NOW - MIN), sessionId: "sess-before", reason: "resume", note },
      pendingWakeBrief: {
        wakeId: "wake-1", note, events: [{ workerId, state: "done" }],
        queuedAt: at(NOW - MIN), attempts: 0, lastAttemptAt: null, lastError: null, scopeId: REPO, epoch: 3,
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
  assert.equal(agents.pendingWakeBrief, null);
  assert.equal(agents.pendingAction, null);
  const worker = world.workspaces[0].metadata[WORKERS_KEY][workerId];
  assert.ok(worker.lastWakeAt, "delivered stamps lastWakeAt");
  assert.equal(worker.pendingWake, null);
});

test("brief send fails via turn-after: pending, retried next tick, delivered once", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world);
  const workerId = "worker-1";
  world.workspaces[0].metadata[WORKERS_KEY] = {
    [workerId]: entry("done", "t", { pendingWake: { state: "done", queuedAt: at(NOW) } }),
  };
  const note = `[factory] Scope ${REPO}, epoch 3: worker ${workerId} done.`;
  world.workspaces[0].metadata[AGENTS_KEY] = {
    [steer.id]: {
      needsResume: { reason: "daemon-restart", at: at(NOW - MIN) },
      pendingAction: { kind: "clear", at: at(NOW - MIN), sessionId: "sess-before", reason: "resume", note },
      pendingWakeBrief: {
        wakeId: "wake-1", note, events: [{ workerId, state: "done" }],
        queuedAt: at(NOW - MIN), attempts: 0, lastAttemptAt: null, lastError: null, scopeId: REPO, epoch: 3,
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
  assert.equal(kept.pendingWakeBrief.wakeId, "wake-1");
  assert.equal(kept.pendingWakeBrief.attempts, 1);
  assert.ok(kept.pendingWakeBrief.lastError);
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
  assert.equal(world.workspaces[0].metadata[AGENTS_KEY][steer.id].pendingWakeBrief, null);
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
    [workerId]: entry("done", "t", { pendingWake: { state: "done", queuedAt: at(NOW) } }),
  };
  const note = `[factory] Scope ${REPO}, epoch 3: worker ${workerId} done.`;
  world.workspaces[0].metadata[AGENTS_KEY] = {
    [steer.id]: {
      needsResume: { reason: "daemon-restart", at: at(NOW - MIN) },
      pendingAction: { kind: "clear", at: at(NOW - MIN), sessionId: "sess-before", reason: "resume", note },
      pendingWakeBrief: {
        wakeId: "wake-1", note, events: [{ workerId, state: "done" }],
        queuedAt: at(NOW - MIN), attempts: 0, lastAttemptAt: null, lastError: null, scopeId: REPO, epoch: 3,
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
  assert.equal(world.workspaces[0].metadata[AGENTS_KEY][steer.id].pendingWakeBrief, null);
  assert.equal(world.workspaces[0].metadata[WORKERS_KEY][workerId].pendingWake, null);
});

test("restart between clear and brief: boot check re-sends once", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world);
  const workerId = "worker-1";
  world.workspaces[0].metadata[WORKERS_KEY] = {
    [workerId]: entry("done", "t", { pendingWake: { state: "done", queuedAt: at(NOW) } }),
  };
  const note = `[factory] Scope ${REPO}, epoch 3: worker ${workerId} done.`;
  world.workspaces[0].metadata[AGENTS_KEY] = {
    [steer.id]: {
      needsResume: { reason: "daemon-restart", at: at(NOW - MIN) },
      pendingWakeBrief: {
        wakeId: "wake-1", note, events: [{ workerId, state: "done" }],
        queuedAt: at(NOW - MIN), attempts: 0, lastAttemptAt: null, lastError: null, scopeId: REPO, epoch: 3,
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
  assert.equal(world.workspaces[0].metadata[AGENTS_KEY][steer.id].pendingWakeBrief, null);
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
    "worker-1": entry("done", "t", { pendingWake: { state: "done", queuedAt: at(NOW) } }),
    "worker-2": entry("blocked", "t", { pendingWake: { state: "blocked", queuedAt: at(NOW) } }),
  };
  world.workspaces[0].metadata[AGENTS_KEY] = {
    [steerA.id]: {
      needsResume: { reason: "daemon-restart", at: at(NOW - MIN) },
      pendingWakeBrief: {
        wakeId: "wake-a", note: "note a", events: [{ workerId: "worker-1", state: "done" }],
        queuedAt: at(NOW - 2 * MIN), attempts: 0, lastAttemptAt: null, lastError: null, scopeId: REPO, epoch: 3,
      },
    },
    [steerB.id]: {
      needsResume: { reason: "daemon-restart", at: at(NOW - MIN) },
      pendingWakeBrief: {
        wakeId: "wake-b", note: "note b", events: [{ workerId: "worker-2", state: "blocked" }],
        queuedAt: at(NOW - MIN), attempts: 0, lastAttemptAt: null, lastError: null, scopeId: REPO, epoch: 3,
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
  const remaining = [
    world.workspaces[0].metadata[AGENTS_KEY][steerA.id].pendingWakeBrief,
    world.workspaces[0].metadata[AGENTS_KEY][steerB.id].pendingWakeBrief,
  ].filter(Boolean);
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
