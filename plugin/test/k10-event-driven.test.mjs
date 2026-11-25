// K10 minimal: one shared timer per feed type (broadcast to all
// subscribers, immediate push on hooked lifecycle events) and archive-driven
// worker retirement (a close never retires). Server modules load through the
// ts-resolve-hooks remap.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";

register("./ts-resolve-hooks.mjs", import.meta.url);

const feed = await import("../server/steer-feed.ts");
const sweep = await import("../server/cold-sweep.ts");
const quota = await import("../server/quota.ts");
const supervise = await import("../server/supervise.ts");
const { CLEANUP_DEFAULTS } = await import("../shared/idle-cleanup.ts");
const { SUPERVISION_SETTINGS_DEFAULTS } = await import("../shared/supervise.ts");
import { LABEL, METADATA_KEY } from "../server/core/paseo.mjs";
import { WORKERS_KEY } from "../server/core/supervision.mjs";
import { AGENTS_KEY } from "../server/core/agent-state.mjs";

const NOW = Date.parse("2026-11-25T12:00:00.000Z");
const MIN = 60_000;
const SCOPE = "o/r";
const flush = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  supervise.resetSupervisionForTests();
  quota.resetQuotaForTests();
});

// ---------------------------------------------------------------------------
// Fakes: a tiny daemon plus feed dependencies.
// ---------------------------------------------------------------------------

function makeWorld() {
  return { workspaces: [], agents: [], calls: [], seq: 0 };
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
    createdAt: new Date(NOW - 24 * 3_600_000).toISOString(),
  };
  world.workspaces.push(ws);
  return ws;
}

function addAgent(world, fields) {
  const agent = {
    id: `agent-${++world.seq}`,
    provider: "codex",
    model: "gpt-6.2-sol",
    status: "idle",
    archivedAt: null,
    labels: {},
    metadata: {},
    title: null,
    workspaceId: null,
    activeTurn: null,
    pendingPermissions: [],
    updatedAt: new Date(NOW - MIN).toISOString(),
    lastUserMessageAt: null,
    ...fields,
  };
  world.agents.push(agent);
  return agent;
}

const page = (entries) => ({ entries: structuredClone(entries), pageInfo: { hasMore: false } });

function fakeClient(world) {
  const findWs = (id) => world.workspaces.find((w) => w.id === id) ?? null;
  const findAgent = (id) => world.agents.find((a) => a.id === id) ?? null;
  return {
    projects: { list: async () => ({ projects: [] }) },
    workspaces: {
      list: async () => page(world.workspaces),
      ref: (id) => ({
        refresh: async () => structuredClone(findWs(id)),
        setMetadata: async (patch) => {
          world.calls.push(["workspace.setMetadata", id]);
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
          world.calls.push(["agent.send", id, text]);
        },
        setMetadata: async (patch) => {
          Object.assign(findAgent(id).metadata, structuredClone(patch));
        },
        timeline: { refetch: async () => ({ entries: [] }) },
      }),
    },
    providers: { snapshot: async () => ({ entries: [] }) },
  };
}

const noLock = (_name, fn) => fn({ verify() {} });

function scopeWorld() {
  const world = makeWorld();
  const ws = addWorkspace(world, {
    metadata: {
      [METADATA_KEY]: { main: true, activeSteer: "A", epoch: 3, scope: { id: SCOPE, kind: "github" } },
    },
  });
  const steer = addAgent(world, {
    title: "Steer A",
    workspaceId: ws.id,
    labels: { [LABEL.scope]: SCOPE, [LABEL.role]: "steer", [LABEL.slot]: "A" },
  });
  return { world, ws, steer, paseo: fakeClient(world) };
}

function subscribeFeed(serve, paseo, deps) {
  const pushes = [];
  const controller = new AbortController();
  serve(
    null,
    { paseo, push: async (event) => { pushes.push(structuredClone(event)); }, signal: controller.signal },
    deps,
  );
  return { pushes, abort: () => controller.abort() };
}

function countTimers(fn) {
  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;
  const counts = { created: 0, cleared: 0 };
  global.setInterval = (...args) => {
    counts.created += 1;
    return realSetInterval(...args);
  };
  global.clearInterval = (...args) => {
    counts.cleared += 1;
    return realClearInterval(...args);
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      global.setInterval = realSetInterval;
      global.clearInterval = realClearInterval;
    })
    .then(() => counts);
}

// ---------------------------------------------------------------------------
// One shared timer per feed type, immediate push on events.
// ---------------------------------------------------------------------------

test("steer subscribers share one timer and update together on notify", async () => {
  const { world, steer, paseo } = scopeWorld();
  world.workspaces[0].metadata[AGENTS_KEY] = {
    [steer.id]: { lastTurnEndedAt: new Date(NOW - 5 * MIN).toISOString() },
  };
  let settingsReads = 0;
  const deps = {
    readSettings: async () => {
      settingsReads += 1;
      return CLEANUP_DEFAULTS;
    },
    getConfig: async () => null,
    readSupervision: async () => ({ quotaSampleMinutes: 10 }),
  };
  const counts = await countTimers(async () => {
    const first = subscribeFeed(feed.serveSteerSubscription, paseo, deps);
    await flush();
    const second = subscribeFeed(feed.serveSteerSubscription, paseo, deps);
    await flush();
    assert.equal(first.pushes.length, 2, "initial push plus the second subscriber's refresh");
    assert.equal(second.pushes.length, 1);
    assert.equal(first.pushes[0].steers[0].agentId, steer.id);
    // One shared compute per event push, fresh settings every time.
    const readsBefore = settingsReads;
    steer.title = "Steer A renamed";
    feed.notifySteerFeed();
    await flush();
    assert.equal(settingsReads, readsBefore + 1);
    assert.equal(first.pushes.at(-1).steers[0].title, "Steer A renamed");
    assert.equal(second.pushes.at(-1).steers[0].title, "Steer A renamed");
    first.abort();
    second.abort();
  });
  assert.equal(counts.created, 1, "two subscribers share one timer");
  assert.equal(counts.cleared, 1, "last unsubscribe stops the timer");
});

test("cold subscribers share one timer and update together on notify", async () => {
  const { world, steer, paseo } = scopeWorld();
  world.workspaces[0].metadata[AGENTS_KEY] = {
    [steer.id]: { needsResume: { reason: "daemon-restart", at: new Date(NOW - MIN).toISOString() } },
  };
  const deps = { readSettings: async () => CLEANUP_DEFAULTS };
  const counts = await countTimers(async () => {
    const first = subscribeFeed(sweep.serveColdSubscription, paseo, deps);
    await flush();
    const second = subscribeFeed(sweep.serveColdSubscription, paseo, deps);
    await flush();
    assert.equal(first.pushes[0].attention.length, 1);
    assert.equal(second.pushes[0].attention.length, 1);
    delete world.workspaces[0].metadata[AGENTS_KEY][steer.id].needsResume;
    sweep.notifyColdFeed();
    await flush();
    assert.deepEqual(first.pushes.at(-1).attention, []);
    assert.deepEqual(second.pushes.at(-1).attention, []);
    first.abort();
    second.abort();
  });
  assert.equal(counts.created, 1, "two subscribers share one timer");
  assert.equal(counts.cleared, 1, "last unsubscribe stops the timer");
});

// ---------------------------------------------------------------------------
// Archive retires; close never retires.
// ---------------------------------------------------------------------------

const workerEntry = (over = {}) => ({
  task: "do it",
  startedBy: "A",
  startedAt: new Date(NOW - 30 * MIN).toISOString(),
  epoch: 3,
  state: "running",
  status: null,
  resumes: 0,
  lastWakeAt: null,
  pendingWake: null,
  ...over,
});

const superviseDeps = (over = {}) => ({
  settings: { ...SUPERVISION_SETTINGS_DEFAULTS },
  lock: noLock,
  log: () => {},
  nowMs: NOW,
  nowIso: new Date(NOW).toISOString(),
  bootCheckDone: true,
  draining: false,
  ...over,
});

function workerWorld(entryOver = {}) {
  const { world, ws, steer } = scopeWorld();
  const worker = addAgent(world, {
    title: "Worker",
    workspaceId: ws.id,
    labels: { [LABEL.role]: "worker", [LABEL.scope]: SCOPE, [LABEL.owner]: "A" },
  });
  world.workspaces[0].metadata[WORKERS_KEY] = { [worker.id]: workerEntry(entryOver) };
  return { world, ws, steer, worker, paseo: fakeClient(world) };
}

test("agent.archive.after retires the worker and drops its queued wake", async () => {
  const { world, worker, paseo } = workerWorld({
    state: "done",
    pendingWake: { state: "done", queuedAt: new Date(NOW - MIN).toISOString() },
  });
  const result = await supervise.runArchiveAfter(paseo, { id: worker.id }, superviseDeps());
  assert.deepEqual(result, { ok: true, action: "retired" });
  assert.equal(world.workspaces[0].metadata[WORKERS_KEY][worker.id], undefined);
});

test("agent.archive.after skips unknown, untracked and disabled cases", async () => {
  const { paseo } = workerWorld();
  assert.deepEqual(await supervise.runArchiveAfter(paseo, null, superviseDeps()), {
    ok: true,
    action: "skipped",
    reason: "no-id",
  });
  const { world, ws } = scopeWorld();
  const stranger = addAgent(world, {
    title: "Stranger",
    workspaceId: ws.id,
    labels: { [LABEL.role]: "worker", [LABEL.scope]: SCOPE },
  });
  const callsBefore = world.calls.length;
  const untracked = await supervise.runArchiveAfter(fakeClient(world), { id: stranger.id }, superviseDeps());
  assert.deepEqual(untracked, { ok: true, action: "skipped", reason: "not-tracked" });
  assert.equal(world.calls.length, callsBefore, "no writes for untracked ids");
  const disabled = await supervise.runArchiveAfter(
    paseo,
    { id: stranger.id },
    superviseDeps({ settings: { ...SUPERVISION_SETTINGS_DEFAULTS, enabled: false } }),
  );
  assert.deepEqual(disabled, { ok: true, action: "disabled" });
});

test("a closed worker stays supervised: turn.after never removes it", async () => {
  const { world, worker, steer, paseo } = workerWorld();
  worker.status = "closed";
  const result = await supervise.runWorkerTurnAfter(
    paseo,
    { agent: { id: worker.id }, turnId: "t1", outcome: { kind: "completed" } },
    superviseDeps(),
  );
  assert.notEqual(result.action, "removed");
  assert.ok(world.workspaces[0].metadata[WORKERS_KEY][worker.id], "entry retained after close");
  assert.equal(world.workspaces[0].metadata[WORKERS_KEY][worker.id].state, "interrupted");
  assert.ok(world.calls.some(([call, id]) => call === "agent.send" && id === steer.id));
});

// ---------------------------------------------------------------------------
// Static shape of the minimal wiring.
// ---------------------------------------------------------------------------

test("server entry pushes feeds on hooked events and retires on archive", () => {
  const entry = readFileSync(new URL("../index.server.ts", import.meta.url), "utf8");
  assert.ok(entry.includes('"agent.archive.after"'), "archive.after registered");
  assert.ok(entry.includes("handleArchiveAfter"), "archive handler wired");
  assert.ok(entry.includes("removeArchiveHook"), "archive hook removed on cleanup");
  assert.ok(!entry.includes("agent.close.after"), "no close hook, so close can never retire");
  const notifies = entry.match(/notifyFeeds\(\);/g) ?? [];
  assert.ok(notifies.length >= 5, `all hooks push feeds, got ${notifies.length}`);
  for (const name of ["startCleanupTimer", "startSupervisionTimer", "startQuotaTimer"]) {
    assert.ok(entry.includes(name), `${name} kept as the bounded fallback`);
  }
});

test("each feed type keeps exactly one shared timer call site", () => {
  const steerSource = readFileSync(new URL("../server/steer-feed.ts", import.meta.url), "utf8");
  const coldSource = readFileSync(new URL("../server/cold-sweep.ts", import.meta.url), "utf8");
  assert.equal(steerSource.match(/setInterval\(/g)?.length ?? 0, 1);
  assert.equal(coldSource.match(/setInterval\(/g)?.length ?? 0, 2, "sweep timer plus one shared cold timer");
  assert.ok(steerSource.includes("notifySteerFeed"), "steer feed exposes its event push");
  assert.ok(coldSource.includes("notifyColdFeed"), "cold feed exposes its event push");
});
