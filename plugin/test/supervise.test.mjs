// Worker supervision plugin side (S-B): shared decisions plus the server wiring
// (registration, turn transitions, wakes, batching, quiet periods, watchdog,
// failover) against a fake Paseo client. Server modules load through the
// ts-resolve-hooks remap (.js specifiers to .ts sources); core register rules
// stay in server/core/ and are reused, never reimplemented.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";

register("./ts-resolve-hooks.mjs", import.meta.url);

const supervise = await import("../server/supervise.ts");
const { LockBusy } = await import("../server/core/lock.mjs");
// Shared modules import each other through `.js` specifiers, so
// they must load dynamically after the resolve hook is registered.
const {
  DRAIN_METADATA_KEY,
  SUPERVISION_SETTINGS_DEFAULTS,
  WORKER_METADATA_KEY,
  buildWorkerMetadata,
  firstUserText,
  formatScopeTakeover,
  hasAdvisorRequest,
  isDrainMarkerActive,
  isWorkerMetadata,
  maxStampMs,
  scopeLastWakeAt,
  steerWakeResponse,
} = await import("../shared/supervise.ts");
const { factorySupervisionSettings } = await import("../shared/settings.ts");
import { LABEL, METADATA_KEY, PARENT_LABEL, readPaseoState } from "../server/core/paseo.mjs";
import { WORKERS_KEY } from "../server/core/supervision.mjs";
import { AGENTS_KEY } from "../server/core/agent-state.mjs";
import { CHECKPOINT_KEY, SwitchRefused, switchSteer } from "../server/core/steer.mjs";
import { normalizeZerosubState } from "../server/core/zerosub.mjs";

const REPO = "example-owner/example-repo";
const NOW = new Date("2026-11-24T12:00:00.000Z").getTime();
const at = (ms) => new Date(ms).toISOString();
const MIN = 60_000;

beforeEach(() => supervise.resetSupervisionForTests());

// ---------------------------------------------------------------------------
// Fakes: a tiny daemon (projects/workspaces/agents/timelines) plus settings.
// ---------------------------------------------------------------------------

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
    createdAt: at(NOW - 24 * 3_600_000),
  };
  world.workspaces.push(ws);
  return ws;
}

function addAgent(world, fields) {
  const agent = {
    id: `agent-${++world.seq}`,
    provider: "codex",
    model: "m",
    status: "idle",
    archivedAt: null,
    labels: {},
    metadata: {},
    title: null,
    workspaceId: null,
    activeTurn: null,
    pendingPermissions: [],
    updatedAt: at(NOW - MIN),
    lastUserMessageAt: null,
    ...fields,
  };
  world.agents.push(agent);
  return agent;
}

function setTimeline(world, agentId, entries) {
  world.timelines[agentId] = structuredClone(entries);
}

function turnEntries(turnId, userText, assistantText) {
  const entries = [];
  if (userText !== null) entries.push({ turnId, item: { type: "user_message", text: userText } });
  if (assistantText !== null) entries.push({ turnId, item: { type: "assistant_message", text: assistantText } });
  return entries;
}

const checkpointOf = (task, status) =>
  ["```text", "CHECKPOINT", `- task: ${task}`, "- tests: npm test", "- blockers: none", "- next: ship", ...(status ? [`- status: ${status}`] : []), "```"].join("\n");
const ADVISOR_BLOCK = ["```text", "ADVISOR-REQUEST", "question: which index?", "context: src/a.mjs slow", "why: two options tie", "```"].join("\n");

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
          world.calls.push(["agent.send", id, text]);
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

const noLock = (_name, fn) => fn({ verify() {} });
const settings = (overrides = {}) => ({ ...SUPERVISION_SETTINGS_DEFAULTS, ...overrides });
const depsOf = (overrides = {}) => ({
  settings: settings(),
  lock: noLock,
  log: () => {},
  nowMs: NOW,
  nowIso: at(NOW),
  bootCheckDone: true,
  draining: false,
  ...overrides,
});
const sendsTo = (world, id) => world.calls.filter((c) => c[0] === "agent.send" && c[1] === id).map((c) => c[2]);

function scopeMeta({ activeSteer = "A", epoch = 3, workers = {}, agents = {}, checkpoint = null, scopeId = REPO, kind = "github" } = {}) {
  const meta = { [METADATA_KEY]: { main: true, activeSteer, epoch, scope: { id: scopeId, kind, locator: scopeId } } };
  if (Object.keys(workers).length) meta[WORKERS_KEY] = structuredClone(workers);
  if (Object.keys(agents).length) meta[AGENTS_KEY] = structuredClone(agents);
  if (checkpoint) meta[CHECKPOINT_KEY] = structuredClone(checkpoint);
  return meta;
}

function provisioned(world, { workers = {}, agents = {}, checkpoint = { task: "ship it", tests: [], blockers: [], next: null } } = {}) {
  const ws = addWorkspace(world, { metadata: scopeMeta({ workers, agents, checkpoint }) });
  const steers = {
    A: addAgent(world, { title: "Steer A", workspaceId: ws.id, labels: { [LABEL.repo]: REPO, [LABEL.role]: "steer", [LABEL.slot]: "A", [LABEL.scope]: REPO } }),
    B: addAgent(world, { title: "Steer B", workspaceId: ws.id, labels: { [LABEL.repo]: REPO, [LABEL.role]: "steer", [LABEL.slot]: "B", [LABEL.scope]: REPO } }),
    C: addAgent(world, { title: "Steer C", workspaceId: ws.id, labels: { [LABEL.repo]: REPO, [LABEL.role]: "steer", [LABEL.slot]: "C", [LABEL.scope]: REPO } }),
  };
  return { ws, steers };
}

function addWorker(world, ws, fields = {}) {
  return addAgent(world, {
    title: "Worker",
    workspaceId: ws.id,
    labels: { [LABEL.role]: "worker", [LABEL.scope]: REPO, [LABEL.owner]: "A" },
    ...fields,
  });
}

const entry = (state, task = "do it", extra = {}) => ({
  task, startedBy: "A", startedAt: at(NOW - 30 * MIN), epoch: 3, state, status: null, resumes: 0, lastWakeAt: null, pendingWake: null, ...extra,
});

const drainMarker = (timeoutAt, extra = {}) => ({ startedAt: at(NOW - MIN), timeoutAt, pid: 123, ...extra });

// ---------------------------------------------------------------------------
// Shared decisions (pure, no imports).
// ---------------------------------------------------------------------------

test("hasAdvisorRequest finds fenced and bare blocks only", () => {
  assert.equal(hasAdvisorRequest(ADVISOR_BLOCK), true);
  assert.equal(hasAdvisorRequest("stuck\nADVISOR-REQUEST\nquestion: x"), true);
  assert.equal(hasAdvisorRequest("  ```\n  ADVISOR-REQUEST:\n  ```"), true);
  assert.equal(hasAdvisorRequest(checkpointOf("t", "done")), false);
  assert.equal(hasAdvisorRequest("advisor-request"), false);
  assert.equal(hasAdvisorRequest("an ADVISOR-REQUEST is needed"), false);
  assert.equal(hasAdvisorRequest(null), false);
  assert.equal(hasAdvisorRequest(undefined), false);
});

test("firstUserText returns the first user message", () => {
  const entries = turnEntries("t1", "build it", "done");
  assert.equal(firstUserText(entries), "build it");
  assert.equal(firstUserText([{ item: { type: "assistant_message", text: "x" } }]), null);
  assert.equal(firstUserText([]), null);
  assert.equal(firstUserText(null), null);
  assert.equal(firstUserText("nope"), null);
});

test("worker metadata builds, validates, and clips the excerpt", () => {
  assert.deepEqual(
    buildWorkerMetadata({ scopeId: REPO, startedBy: "A", epoch: 3, task: "build it" }),
    { scopeId: REPO, startedBy: "A", epoch: 3, task: "build it" },
  );
  assert.equal(buildWorkerMetadata({ scopeId: REPO, startedBy: "", epoch: 3.5, task: "x" }).startedBy, null);
  assert.equal(buildWorkerMetadata({ scopeId: REPO, startedBy: "A", epoch: 3.5, task: "x" }).epoch, null);
  assert.equal(buildWorkerMetadata({ scopeId: REPO, startedBy: "A", epoch: 3, task: "y".repeat(500) }).task.length, 300);
  assert.equal(buildWorkerMetadata({ scopeId: REPO, startedBy: "A", epoch: 3, task: "a\nb\tc" }).task, "a b c");
  assert.equal(isWorkerMetadata({ scopeId: REPO, startedBy: "A", epoch: 3, task: "t" }), true);
  assert.equal(isWorkerMetadata({ scopeId: "", task: "t" }), false);
  assert.equal(isWorkerMetadata({ scopeId: REPO }), false);
  assert.equal(isWorkerMetadata(null), false);
  assert.equal(isWorkerMetadata("x"), false);
});

test("domain and hub takeover texts intervene instead of switching", () => {
  const domain = formatScopeTakeover({ scopeId: REPO, epoch: 4, kind: "domain", reason: "no answer within 10m", openWorkers: [{ id: "w-1", state: "interrupted" }] });
  assert.match(domain, /no steer answers \(no answer within 10m\)/);
  assert.match(domain, /As the domain steer/);
  assert.match(domain, /`hub:` blocker/);
  assert.ok(!domain.includes("--to"), "no switch for domain steers");
  const hub = formatScopeTakeover({ scopeId: REPO, epoch: 4, kind: "hub", reason: "x", openWorkers: [] });
  assert.match(hub, /As the hub steer/);
  assert.match(hub, /`user:` blocker only as the last step/);
});

test("steerWakeResponse separates answered, busy, and unanswered", () => {
  const wake = at(NOW - 5 * MIN);
  assert.equal(steerWakeResponse({ entry: { lastTurnEndedAt: at(NOW - MIN), outcome: "completed" }, status: "idle", lastWakeAt: wake }), "answered");
  assert.equal(steerWakeResponse({ entry: { lastTurnEndedAt: at(NOW - MIN), outcome: "failed" }, status: "idle", lastWakeAt: wake }), "unanswered");
  assert.equal(steerWakeResponse({ entry: { lastTurnEndedAt: at(NOW - MIN), outcome: "canceled" }, status: "idle", lastWakeAt: wake }), "unanswered");
  assert.equal(steerWakeResponse({ entry: { lastTurnEndedAt: at(NOW - 10 * MIN), outcome: "completed" }, status: "idle", lastWakeAt: wake }), "unanswered");
  assert.equal(steerWakeResponse({ entry: { openTurnId: "t9", turnStartedAt: at(NOW - 10 * MIN) }, status: "running", lastWakeAt: wake }), "busy");
  assert.equal(steerWakeResponse({ entry: null, status: "running", lastWakeAt: wake }), "busy");
  assert.equal(steerWakeResponse({ entry: null, status: "idle", lastWakeAt: wake }), "unanswered");
  assert.equal(steerWakeResponse({ entry: null, status: "idle", lastWakeAt: null }), "answered");
  assert.equal(steerWakeResponse({ entry: null, status: "idle", lastWakeAt: "not-a-date" }), "answered");
});

test("scopeLastWakeAt and maxStampMs pick the latest valid stamp", () => {
  assert.equal(scopeLastWakeAt({ a: entry("running", "t", { lastWakeAt: at(NOW - 2 * MIN) }), b: entry("done", "t", { lastWakeAt: at(NOW - MIN) }) }), at(NOW - MIN));
  assert.equal(scopeLastWakeAt({ a: entry("running") }), null);
  assert.equal(scopeLastWakeAt({ a: entry("running", "t", { lastWakeAt: "nope" }) }), null);
  assert.equal(scopeLastWakeAt(null), null);
  assert.equal(maxStampMs(at(NOW - 2 * MIN), at(NOW - MIN), null, "nope"), NOW - MIN);
  assert.equal(maxStampMs(null, undefined, 7), null);
});

test("isDrainMarkerActive honors timeoutAt plus a minute of grace", () => {
  assert.equal(DRAIN_METADATA_KEY, "wsf.drain");
  const live = drainMarker(at(NOW + MIN));
  assert.equal(isDrainMarkerActive(live, NOW), true);
  assert.equal(isDrainMarkerActive(live, NOW + 2 * MIN), true, "timeoutAt + 1 min still quiet");
  assert.equal(isDrainMarkerActive(live, NOW + 2 * MIN + 1), false, "past the grace the marker is ignored");
  for (const bad of [null, undefined, "x", 42, [], {}, { timeoutAt: "not-a-date" }, { startedAt: at(NOW) }]) {
    assert.equal(isDrainMarkerActive(bad, NOW), false, `ignored: ${JSON.stringify(bad)}`);
  }
  assert.equal(isDrainMarkerActive(live, Number.NaN), false);
});

test("supervision settings: host scope, enabled by default", () => {
  assert.equal(factorySupervisionSettings.id, "factory-supervision");
  assert.equal(factorySupervisionSettings.scope, "host");
  assert.deepEqual(factorySupervisionSettings.schema.parse({}), SUPERVISION_SETTINGS_DEFAULTS);
  assert.equal(SUPERVISION_SETTINGS_DEFAULTS.enabled, true);
  assert.equal(SUPERVISION_SETTINGS_DEFAULTS.batchMinutes, 0);
  assert.equal(SUPERVISION_SETTINGS_DEFAULTS.wakeDebounceSeconds, 20);
  assert.equal(SUPERVISION_SETTINGS_DEFAULTS.watchdogMinutes, 15);
  assert.equal(SUPERVISION_SETTINGS_DEFAULTS.staleMinutes, 60);
  assert.equal(SUPERVISION_SETTINGS_DEFAULTS.answerMinutes, 10);
  assert.equal(SUPERVISION_SETTINGS_DEFAULTS.maxAutoResumes, 2);
});

// ---------------------------------------------------------------------------
// agent.create.after: registration plus immutable metadata.
// ---------------------------------------------------------------------------

test("create.after registers steer-started agents as running with metadata", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const worker = addWorker(world, ws, { title: "PWM worker" });
  setTimeline(world, worker.id, turnEntries("t0", "Fix the PWM table", null));
  const paseo = fakeClient(world);
  const result = await supervise.runCreateAfter(
    paseo,
    { id: worker.id, parentAgentId: steers.A.id, background: false },
    depsOf(),
  );
  assert.deepEqual(result, { ok: true, action: "registered", scopeId: REPO, epoch: 3, startedBy: "A", metaWritten: true });
  const written = world.workspaces[0].metadata[WORKERS_KEY][worker.id];
  assert.equal(written.state, "running");
  assert.equal(written.task, "Fix the PWM table");
  assert.equal(written.startedBy, "A");
  assert.equal(written.epoch, 3);
  assert.deepEqual(world.agents.find((a) => a.id === worker.id).metadata[WORKER_METADATA_KEY], {
    scopeId: REPO, startedBy: "A", epoch: 3, task: "Fix the PWM table",
  });
});

test("create.after retries a busy workspace lock and preserves a result captured before registration", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const worker = addWorker(world, ws, { title: "Late registration" });
  ws.metadata[WORKERS_KEY] = { [worker.id]: entry("done", "", { lastWakeAt: at(NOW) }) };
  let attempts = 0;
  const lock = async (name, fn) => {
    if (++attempts === 1) throw new LockBusy("brief contention");
    return noLock(name, fn);
  };
  const result = await supervise.runCreateAfter(fakeClient(world), {
    id: worker.id, parentAgentId: steers.A.id,
  }, depsOf({ lock }));
  assert.equal(result.action, "registered");
  assert.equal(attempts, 2);
  const tracked = ws.metadata[WORKERS_KEY][worker.id];
  assert.equal(tracked.state, "done");
  assert.equal(tracked.lastWakeAt, at(NOW));
  assert.equal(tracked.task, "Late registration");
});

test("create.after skips background agents and non-steer parents", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const paseo = fakeClient(world);
  const bg = addWorker(world, ws);
  assert.deepEqual(
    (await supervise.runCreateAfter(paseo, { id: bg.id, parentAgentId: steers.A.id, background: true }, depsOf())).action,
    "skip",
  );
  const orphan = addWorker(world, ws);
  assert.equal((await supervise.runCreateAfter(paseo, { id: orphan.id, parentAgentId: null, background: false }, depsOf())).reason, "no-parent");
  const sub = addWorker(world, ws);
  const parentWorker = addWorker(world, ws);
  assert.equal((await supervise.runCreateAfter(paseo, { id: sub.id, parentAgentId: parentWorker.id, background: false }, depsOf())).reason, "parent-not-steer");
  const foreign = addAgent(world, { title: "Steer X", workspaceId: ws.id, labels: { [LABEL.role]: "steer", [LABEL.slot]: "X" } });
  const foreignChild = addWorker(world, ws);
  assert.equal((await supervise.runCreateAfter(paseo, { id: foreignChild.id, parentAgentId: foreign.id, background: false }, depsOf())).reason, "parent-not-steer");
  assert.ok(!world.workspaces[0].metadata[WORKERS_KEY], "no register writes for skipped agents");
  assert.equal((await supervise.runCreateAfter(paseo, { id: bg.id, parentAgentId: steers.A.id, background: false }, depsOf({ settings: settings({ enabled: false }) }))).action, "disabled");
});

test("create.after never overwrites worker metadata and falls back for excerpts", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const paseo = fakeClient(world);
  const fixed = addWorker(world, ws, { title: "Later title", metadata: { [WORKER_METADATA_KEY]: { scopeId: REPO, startedBy: "A", epoch: 2, task: "original" } } });
  const result = await supervise.runCreateAfter(paseo, { id: fixed.id, parentAgentId: steers.A.id, background: false }, depsOf());
  assert.equal(result.metaWritten, false);
  assert.deepEqual(world.agents.find((a) => a.id === fixed.id).metadata[WORKER_METADATA_KEY].task, "original");
  // No timeline: the title becomes the excerpt; without a title it stays empty.
  assert.equal(world.workspaces[0].metadata[WORKERS_KEY][fixed.id].task, "Later title");
  const untitled = addWorker(world, ws, { title: null });
  await supervise.runCreateAfter(paseo, { id: untitled.id, parentAgentId: steers.B.id, background: false }, depsOf());
  assert.equal(world.workspaces[0].metadata[WORKERS_KEY][untitled.id].task, "");
  assert.equal(world.workspaces[0].metadata[WORKERS_KEY][untitled.id].startedBy, "B");
});

// ---------------------------------------------------------------------------
// agent.turn.after: transitions, immediate/batched/queued wakes.
// ---------------------------------------------------------------------------

async function turnedOut(world, worker, { outcome = "completed", turnId = "t1", assistant = null, user = "do it" } = {}, depOverrides = {}) {
  setTimeline(world, worker.id, turnEntries(turnId, user, assistant));
  return supervise.runWorkerTurnAfter(
    fakeClient(world),
    { agent: { id: worker.id, background: false }, turnId, outcome: { kind: outcome } },
    depsOf(depOverrides),
  );
}

test("turn end maps CHECKPOINT status, advisor requests, and failures", async () => {
  const world = makeWorld();
  const { ws } = provisioned(world);
  const mk = (task) => {
    const w = addWorker(world, ws);
    world.workspaces[0].metadata[WORKERS_KEY] = { ...(world.workspaces[0].metadata[WORKERS_KEY] ?? {}), [w.id]: entry("running", task) };
    return w;
  };
  const cases = [
    ["done", checkpointOf("a", "done"), "completed", "checkpoint-done", "done", "done"],
    ["none", checkpointOf("b", null), "completed", "checkpoint-none", "done", "done"],
    ["partial", checkpointOf("c", "partial"), "completed", "checkpoint-partial", "partial", "partial"],
    ["blocked", checkpointOf("d", "blocked"), "completed", "checkpoint-blocked", "blocked", "blocked"],
    ["advisor", `${checkpointOf("e", "done")}\n${ADVISOR_BLOCK}`, "completed", "advisor-request", "blocked", "blocked"],
    ["missing", "looks done, no block", "completed", "turn-no-checkpoint", "partial", null],
    ["failed", checkpointOf("g", "done"), "failed", "turn-failed", "interrupted", null],
    ["canceled", checkpointOf("h", "done"), "canceled", "turn-canceled", "interrupted", null],
  ];
  for (const [task, assistant, outcome, event, state, status] of cases) {
    const worker = mk(task);
    const result = await turnedOut(world, worker, { outcome, assistant });
    assert.equal(result.event, event, task);
    assert.equal(result.state, state, task);
    const written = world.workspaces[0].metadata[WORKERS_KEY][worker.id];
    assert.equal(written.state, state, task);
    assert.equal(written.status, status, task);
  }
});

test("a worker result without a CHECKPOINT label routes normally and a missing block requests a checkpoint", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const worker = addWorker(world, ws);
  ws.metadata[WORKERS_KEY] = { [worker.id]: entry("running", "Write parser tests") };

  const report = ["Result", "```text", "task: Write parser tests", "tests: npm test", "blockers: none", "next: none", "```"].join("\n");
  const complete = await turnedOut(world, worker, { assistant: report });
  assert.equal(complete.state, "done");
  assert.match(sendsTo(world, steers.A.id)[0], /result reported/);

  const nowMs = NOW + MIN;
  const missing = await turnedOut(world, worker, { turnId: "t2", assistant: "The tests are green." }, { nowMs, nowIso: at(nowMs) });
  assert.equal(missing.state, "partial");
  assert.equal(ws.metadata[WORKERS_KEY][worker.id].status, null);
  const wake = sendsTo(world, steers.A.id)[1];
  assert.match(wake, /incomplete checkpoint.*record its result, tests, blockers and next step/);
  assert.doesNotMatch(wake, /interrupted|whether the worker can continue/);

  const failedAt = NOW + 2 * MIN;
  const failed = await turnedOut(world, worker, { turnId: "t3", outcome: "failed", assistant: report },
    { nowMs: failedAt, nowIso: at(failedAt) });
  assert.equal(failed.state, "interrupted");
  assert.match(sendsTo(world, steers.A.id)[2], /interrupted.*whether the worker can continue/);
});

test("a worker registered through create.after wakes the active steer without wsf labels", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const paseo = fakeClient(world);
  const worker = addWorker(world, ws, {
    labels: {},
    parentAgentId: steers.A.id,
  });
  await supervise.runCreateAfter(paseo, { id: worker.id, parentAgentId: steers.A.id }, depsOf());
  assert.equal(worker.metadata[WORKER_METADATA_KEY].scopeId, REPO);
  assert.deepEqual(worker.labels, {});
  ws.metadata[METADATA_KEY].activeSteer = "B";
  const result = await turnedOut(world, worker, { assistant: checkpointOf("t", "done") });
  assert.equal(result.event, "checkpoint-done");
  assert.equal(result.state, "done");
  assert.equal(result.action, "sent");
  assert.equal(result.target, steers.B.id);
  assert.ok(ws.metadata[WORKERS_KEY][worker.id].lastWakeAt);
  assert.equal(ws.metadata[WORKERS_KEY][worker.id].pendingWake, null);
  const unlabelled = addWorker(world, ws, { labels: {} });
  assert.equal((await turnedOut(world, unlabelled, { assistant: checkpointOf("u", "done") })).reason, "not-worker");
});

test("a failed worker wake stays queued and flush delivers it after recovery", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const worker = addWorker(world, ws);
  ws.metadata[WORKERS_KEY] = { [worker.id]: entry("running", "t") };
  setTimeline(world, worker.id, turnEntries("t1", "do it", checkpointOf("t", "done")));
  const broken = fakeClient(world);
  const ref = broken.agents.ref;
  broken.agents.ref = (id) => ({ ...ref(id), send: async () => { throw new Error("temporarily unavailable"); } });
  const outcome = await supervise.runWorkerTurnAfter(
    broken,
    { agent: { id: worker.id }, turnId: "t1", outcome: { kind: "completed" } },
    depsOf(),
  );
  assert.equal(outcome.action, "queued");
  assert.equal(outcome.reason, "resume-refused");
  assert.equal(ws.metadata[WORKERS_KEY][worker.id].pendingWake.state, "done");
  supervise.resetSupervisionForTests();
  const [result] = await supervise.flushAllScopes(fakeClient(world), depsOf());
  assert.equal(result.target, steers.A.id);
  assert.equal(ws.metadata[WORKERS_KEY][worker.id].pendingWake, null);
  assert.ok(ws.metadata[WORKERS_KEY][worker.id].lastWakeAt);
});

test("worker completion waits for an active steer to finish its current turn", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const worker = addWorker(world, ws);
  ws.metadata[WORKERS_KEY] = { [worker.id]: entry("running", "t") };
  steers.A.status = "running";
  const outcome = await turnedOut(world, worker, { assistant: checkpointOf("t", "done") });
  assert.equal(outcome.action, "queued");
  assert.equal(outcome.reason, "target-busy");
  assert.deepEqual(sendsTo(world, steers.A.id), []);
  assert.equal(ws.metadata[WORKERS_KEY][worker.id].pendingWake.state, "done");
  steers.A.status = "idle";
  const [result] = await supervise.flushAllScopes(fakeClient(world), depsOf());
  assert.equal(result.flushed, true);
  assert.equal(sendsTo(world, steers.A.id).length, 1);
  assert.equal(ws.metadata[WORKERS_KEY][worker.id].pendingWake, null);
});

test("a legacy composer stage does not block a worker wake or lose its packet", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const worker = addWorker(world, ws);
  const steer = steers.A;
  const stage = { kind: "stage", phase: "staged", wakeId: "composer-stage", packet: "USER DRAFT", epoch: ws.metadata[METADATA_KEY].epoch };
  ws.metadata[AGENTS_KEY] = { [steer.id]: { action: stage } };
  ws.metadata[WORKERS_KEY] = { [worker.id]: entry("running", "t") };

  const outcome = await turnedOut(world, worker, { assistant: checkpointOf("t", "done") });
  assert.equal(outcome.action, "sent");
  assert.equal(ws.metadata[WORKERS_KEY][worker.id].pendingWake, null);
  const [wake] = sendsTo(world, steer.id);
  assert.match(wake, /Worker \(t\): result reported/);
  assert.doesNotMatch(wake, /USER DRAFT/);
  const sentAction = ws.metadata[AGENTS_KEY][steer.id].action;

  const { deliverSteerBrief } = await import("../server/steer-brief.ts");
  const paseo = fakeClient(world);
  const input = { workspaceId: ws.id, agentId: steer.id, stageId: stage.wakeId, epoch: stage.epoch, claimId: "wake-test" };
  const brief = await deliverSteerBrief(paseo, { ...input, action: "composer" }, { lock: noLock });
  assert.equal(brief.packet, stage.packet);
  assert.equal(brief.stageId, stage.wakeId);
  assert.equal((await deliverSteerBrief(paseo, { ...input, action: "composer-complete" }, { lock: noLock })).transferred, true);
  assert.deepEqual(ws.metadata[AGENTS_KEY][steer.id].action, sentAction);
  assert.equal(ws.metadata[AGENTS_KEY][steer.id].stagedBrief, null);
  assert.equal(sendsTo(world, steer.id).length, 1);
});

test("all actionable outcomes wake immediately; simultaneous events debounce", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const mk = (task) => {
    const w = addWorker(world, ws);
    world.workspaces[0].metadata[WORKERS_KEY] = { ...(world.workspaces[0].metadata[WORKERS_KEY] ?? {}), [w.id]: entry("running", task) };
    return w;
  };
  const blocked = mk("blocked task");
  const done = mk("done task");
  const partial = mk("partial task");
  const missing = mk("missing task");
  assert.equal((await turnedOut(world, done, { assistant: checkpointOf("d", "done") })).action, "sent");
  assert.equal((await turnedOut(world, blocked, { assistant: checkpointOf("b", "blocked") })).action, "deferred");
  assert.equal((await turnedOut(world, missing, { assistant: "no block here" })).action, "deferred");
  // Every send spends the debounce window: simultaneous outcomes queue together.
  const deferred = await turnedOut(world, partial, { assistant: checkpointOf("p", "partial") });
  assert.equal(deferred.action, "deferred");
  const texts = sendsTo(world, steers.A.id);
  assert.equal(texts.length, 1);
  assert.match(texts[0], /Worker \(done task\): result reported/);
  assert.doesNotMatch(texts[0], /paseo-factory resume|Ignore if your epoch|Archive accepted|agent-\d/);
  assert.ok(!texts[0].includes("blocked task"));
  const pending = world.workspaces[0].metadata[WORKERS_KEY][partial.id].pendingWake;
  assert.deepEqual(pending, { state: "partial", queuedAt: at(NOW) });
});

test("wake goes to the steer active at send time, never the parent", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  world.workspaces[0].metadata[METADATA_KEY].activeSteer = "B";
  world.workspaces[0].metadata[METADATA_KEY].epoch = 4;
  const worker = addWorker(world, ws);
  world.workspaces[0].metadata[WORKERS_KEY] = { [worker.id]: entry("running", "parented by A", { epoch: 3 }) };
  const result = await turnedOut(world, worker, { assistant: checkpointOf("b", "blocked") });
  assert.equal(result.action, "sent");
  assert.equal(result.target, steers.B.id);
  assert.equal(sendsTo(world, steers.A.id).length, 0);
  assert.match(sendsTo(world, steers.B.id)[0], /parented by A.*blocked/);
});

test("quiet periods queue instead of sending; flush sends after the window", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const mk = (task) => {
    const w = addWorker(world, ws);
    world.workspaces[0].metadata[WORKERS_KEY] = { ...(world.workspaces[0].metadata[WORKERS_KEY] ?? {}), [w.id]: entry("running", task) };
    return w;
  };
  const duringBoot = mk("boot task");
  const bootResult = await turnedOut(world, duringBoot, { assistant: checkpointOf("b", "blocked") }, { bootCheckDone: false });
  assert.equal(bootResult.action, "queued");
  assert.equal(bootResult.reason, "boot");
  const duringDrain = mk("drain task");
  const drainResult = await turnedOut(world, duringDrain, { assistant: checkpointOf("d", "done") }, { draining: true });
  assert.equal(drainResult.action, "queued");
  assert.equal(drainResult.reason, "drain");
  assert.equal(world.calls.filter((c) => c[0] === "agent.send").length, 0);
  // After the quiet period the queued wakes flush as one combined wake.
  const flushed = await supervise.flushAllScopes(fakeClient(world), depsOf({ nowMs: NOW + 11 * MIN, nowIso: at(NOW + 11 * MIN) }));
  assert.equal(flushed.filter((f) => f.flushed).length, 1);
  const texts = sendsTo(world, steers.A.id);
  assert.equal(texts.length, 1);
  assert.match(texts[0], /boot task.*blocked/);
  assert.match(texts[0], /drain task.*result reported/);
});

test("drain marker quiets wakes like the drain flag; stale markers are ignored", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const mk = (task) => {
    const w = addWorker(world, ws);
    world.workspaces[0].metadata[WORKERS_KEY] = { ...(world.workspaces[0].metadata[WORKERS_KEY] ?? {}), [w.id]: entry("running", task) };
    return w;
  };
  const marked = mk("marked task");
  world.workspaces[0].metadata[DRAIN_METADATA_KEY] = drainMarker(at(NOW + 10 * MIN));
  const queued = await turnedOut(world, marked, { assistant: checkpointOf("m", "done") });
  assert.equal(queued.action, "queued");
  assert.equal(queued.reason, "drain");
  assert.equal(world.calls.filter((c) => c[0] === "agent.send").length, 0);
  // Stale marker (past timeoutAt + 1 min): the wake goes out.
  world.workspaces[0].metadata[DRAIN_METADATA_KEY] = drainMarker(at(NOW - 2 * MIN));
  const stale = mk("stale task");
  const sent = await turnedOut(world, stale, { assistant: checkpointOf("s", "done") });
  assert.equal(sent.action, "sent");
  assert.equal(sendsTo(world, steers.A.id).length, 1);
});

test("flush honors the drain marker and ignores stale ones", async () => {
  const world = makeWorld();
  const { ws } = provisioned(world);
  const paseo = fakeClient(world);
  const scope = { id: REPO, workspaceId: ws.id };
  const worker = addWorker(world, ws);
  world.workspaces[0].metadata[WORKERS_KEY] = {
    [worker.id]: entry("done", "t", { lastWakeAt: at(NOW - 2 * MIN), pendingWake: { state: "done", queuedAt: at(NOW - 2 * MIN) } }),
  };
  world.workspaces[0].metadata[DRAIN_METADATA_KEY] = drainMarker(at(NOW + 10 * MIN));
  assert.equal((await supervise.flushScope(paseo, scope, depsOf())).reason, "drain");
  world.workspaces[0].metadata[DRAIN_METADATA_KEY] = drainMarker(at(NOW - 2 * MIN));
  const flushed = await supervise.flushScope(paseo, scope, depsOf());
  assert.equal(flushed.flushed, true);
});

test("boot finished queues post-boot wakes while the drain marker is live", async () => {
  const world = makeWorld();
  const { ws } = provisioned(world);
  const worker = addWorker(world, ws);
  world.workspaces[0].metadata[WORKERS_KEY] = { [worker.id]: entry("running", "t") };
  world.workspaces[0].metadata[DRAIN_METADATA_KEY] = drainMarker(at(NOW + 10 * MIN));
  const result = await supervise.runBootFinished(
    fakeClient(world),
    [{ agentId: worker.id, scopeId: REPO }],
    depsOf(),
  );
  assert.deepEqual(result.marked, [worker.id]);
  assert.equal(result.wakes.length, 1);
  assert.equal(result.wakes[0].sent, false);
  assert.equal(result.wakes[0].reason, "drain");
  assert.ok(world.workspaces[0].metadata[WORKERS_KEY][worker.id].pendingWake, "interrupted news queued");
});

test("a paused host records boot interrupts and keeps quota failover and wake retries quiet until resumed", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const worker = addWorker(world, ws);
  ws.metadata[WORKERS_KEY] = { [worker.id]: entry("running", "boot task") };
  const paseo = fakeClient(world);
  const scope = { id: REPO, workspaceId: ws.id };
  let stored = factorySupervisionSettings.schema.parse({ paused: true });
  const handle = { read: async () => ({ status: "ready", values: structuredClone(stored) }) };
  const deps = depsOf({ delivery: { isFactoryPaused: async () => (await supervise.readSupervisionSettings(handle)).paused } });

  const boot = await supervise.runBootFinished(paseo, [{ agentId: worker.id, scopeId: REPO }], deps);
  assert.deepEqual(boot.marked, [worker.id]);
  assert.equal(boot.wakes[0].reason, "paused");
  assert.equal(ws.metadata[WORKERS_KEY][worker.id].pendingWake.state, "interrupted");
  await supervise.requestQuotaFailover(paseo, ws.id, steers.A.id, "quota exhausted", "codex", deps);
  assert.equal((await supervise.runFailoverCheck(paseo, scope, { ...deps, force: true })).reason, "paused");
  assert.equal((await supervise.retryPendingWakeBrief(paseo, scope, deps)).reason, "paused");
  assert.equal((await supervise.flushScope(paseo, scope, deps)).reason, "paused");
  assert.equal(sendsTo(world, steers.A.id).length + sendsTo(world, steers.B.id).length, 0);

  stored = { ...stored, paused: false };
  assert.equal((await supervise.flushScope(paseo, scope, deps)).flushed, true);
  assert.match(sendsTo(world, steers.A.id)[0], /boot task/);
});

test("watchdog skips failover while the drain marker is live", async () => {
  const { world, steers } = unansweredWorld();
  world.workspaces[0].metadata[DRAIN_METADATA_KEY] = drainMarker(at(NOW + 10 * MIN));
  const quiet = await supervise.watchdogScan(fakeClient(world), depsOf());
  assert.equal(quiet.failovers.length, 0);
  assert.equal(sendsTo(world, steers.B.id).length, 0);
  world.workspaces[0].metadata[DRAIN_METADATA_KEY] = drainMarker(at(NOW - 2 * MIN));
  const loud = await supervise.watchdogScan(fakeClient(world), failoverDeps(world));
  assert.equal(loud.failovers.length, 1);
});

test("flush respects the batch window and sends nothing when empty", async () => {
  const world = makeWorld();
  const { ws } = provisioned(world);
  const paseo = fakeClient(world);
  const scope = { id: REPO, workspaceId: ws.id };
  assert.equal((await supervise.flushScope(paseo, scope, depsOf())).reason, "none");
  const worker = addWorker(world, ws);
  world.workspaces[0].metadata[WORKERS_KEY] = {
    [worker.id]: entry("done", "t", { lastWakeAt: at(NOW - 1_000), pendingWake: { state: "done", queuedAt: at(NOW - 1_000) } }),
  };
  assert.equal((await supervise.flushScope(paseo, scope, depsOf())).reason, "window");
  const flushed = await supervise.flushScope(paseo, scope, depsOf({ nowMs: NOW + 21_000, nowIso: at(NOW + 21_000) }));
  assert.equal(flushed.flushed, true);
  assert.equal(world.workspaces[0].metadata[WORKERS_KEY][worker.id].pendingWake, null);
});

test("heartbeat checks ignore a healthy running worker and deliver a later queued result once", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const worker = addWorker(world, ws);
  const paseo = fakeClient(world);
  const register = ws.metadata[WORKERS_KEY] = { [worker.id]: entry("running") };
  assert.deepEqual(await supervise.flushAllScopes(paseo, depsOf()), []);
  assert.equal(sendsTo(world, steers.A.id).length, 0);

  register[worker.id] = entry("done", "work complete", { pendingWake: { state: "done", queuedAt: at(NOW) } });
  const checks = await Promise.all([
    supervise.flushAllScopes(paseo, depsOf()),
    supervise.flushAllScopes(paseo, depsOf()),
  ]);
  assert.equal(checks.flat().filter(({ flushed }) => flushed).length, 1);
  assert.deepEqual(await supervise.flushAllScopes(paseo, depsOf()), []);
  assert.equal(sendsTo(world, steers.A.id).length, 1);
});

test("wakes hint at an advisor past maxAutoResumes", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const stuck = addWorker(world, ws);
  const fresh = addWorker(world, ws);
  world.workspaces[0].metadata[WORKERS_KEY] = {
    [stuck.id]: entry("blocked", "stuck", { resumes: 2 }),
    [fresh.id]: entry("running", "fresh", { resumes: 1 }),
  };
  const result = await turnedOut(world, stuck, { assistant: checkpointOf("s", "blocked") });
  assert.equal(result.action, "sent");
  const texts = sendsTo(world, steers.A.id);
  assert.match(texts[0], /stuck.*Seek an independent assessment/);
  assert.ok(!texts[0].includes("(fresh)"), "workers below the threshold stay out of the hint");
});

test("immediate wakes piggyback queued batches", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const calm = addWorker(world, ws);
  const urgent = addWorker(world, ws);
  world.workspaces[0].metadata[WORKERS_KEY] = {
    [calm.id]: entry("done", "calm", { lastWakeAt: at(NOW - MIN), pendingWake: { state: "done", queuedAt: at(NOW - MIN) } }),
    [urgent.id]: entry("running", "urgent"),
  };
  const result = await turnedOut(world, urgent, { assistant: checkpointOf("u", "blocked") });
  assert.equal(result.action, "sent");
  const texts = sendsTo(world, steers.A.id);
  assert.equal(texts.length, 1);
  assert.match(texts[0], /calm.*result reported/);
  assert.match(texts[0], /urgent.*blocked/);
  assert.equal(world.workspaces[0].metadata[WORKERS_KEY][calm.id].pendingWake, null);
});

test("ignore rule: archived removed, unassigned skipped, closed supervised", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const gone = addWorker(world, ws, { archivedAt: at(NOW - MIN) });
  world.workspaces[0].metadata[WORKERS_KEY] = { [gone.id]: entry("running", "gone") };
  assert.equal((await turnedOut(world, gone, { assistant: checkpointOf("g", "done") })).action, "removed");
  assert.ok(!world.workspaces[0].metadata[WORKERS_KEY][gone.id], "archived entry removed");
  const stray = addAgent(world, { title: "Stray", workspaceId: ws.id, labels: {} });
  assert.equal((await turnedOut(world, stray, { assistant: checkpointOf("s", "done") })).reason, "not-worker");
  const steer = world.agents.find((a) => a.labels?.[LABEL.slot] === "A");
  assert.equal((await turnedOut(world, steer, { assistant: checkpointOf("a", "done") })).reason, "not-worker");
  const bg = addWorker(world, ws, { background: true });
  world.workspaces[0].metadata[WORKERS_KEY][bg.id] = entry("running", "bg");
  const bgResult = await supervise.runWorkerTurnAfter(
    fakeClient(world),
    { agent: { id: bg.id, background: true }, turnId: "t1", outcome: { kind: "completed" } },
    depsOf(),
  );
  assert.equal(bgResult.reason, "background");
  const closed = addWorker(world, ws, { status: "closed" });
  world.workspaces[0].metadata[WORKERS_KEY][closed.id] = entry("running", "closed task");
  const closedResult = await turnedOut(world, closed, { assistant: checkpointOf("c", "blocked") });
  assert.equal(closedResult.action, "sent");
  assert.equal(world.workspaces[0].metadata[WORKERS_KEY][closed.id].state, "blocked");
  assert.equal(sendsTo(world, steers.A.id).length, 1);
  assert.ok(world.calls.every((c) => c[0] !== "agent.send" || c[1] !== bg.id), "background agents never woken");
});

test("boot finished interrupts marked workers and sends one combined wake", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const w1 = addWorker(world, ws);
  const w2 = addWorker(world, ws);
  const w3 = addWorker(world, ws);
  world.workspaces[0].metadata[WORKERS_KEY] = {
    [w1.id]: entry("running", "one"),
    [w2.id]: entry("blocked", "two"),
    [w3.id]: entry("running", "three"),
  };
  assert.equal(supervise.isBootCheckDone(), false);
  const result = await supervise.runBootFinished(
    fakeClient(world),
    [{ agentId: w1.id, scopeId: REPO }, { agentId: steers.A.id, scopeId: REPO }, { agentId: w3.id, scopeId: REPO }],
    depsOf(),
  );
  assert.equal(supervise.isBootCheckDone(), true);
  assert.deepEqual(result.marked.sort(), [w1.id, w3.id].sort());
  assert.equal(world.workspaces[0].metadata[WORKERS_KEY][w1.id].state, "interrupted");
  assert.equal(world.workspaces[0].metadata[WORKERS_KEY][w3.id].state, "interrupted");
  assert.equal(world.workspaces[0].metadata[WORKERS_KEY][w2.id].state, "blocked");
  assert.equal(result.wakes.length, 1);
  assert.equal(result.wakes[0].sent, true);
  const texts = sendsTo(world, steers.A.id);
  assert.equal(texts.length, 1);
  assert.match(texts[0], /\(one\): interrupted/);
  assert.match(texts[0], /\(three\): interrupted/);
  assert.ok(!texts[0].includes("(two)"), "blocked workers are not in the interrupted wake");
});

test("boot finished backfills unregistered workers and queues while draining", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const fresh = addWorker(world, ws);
  const draining = addWorker(world, ws);
  world.workspaces[0].metadata[WORKERS_KEY] = { [draining.id]: entry("interrupted", "old") };
  const result = await supervise.runBootFinished(
    fakeClient(world),
    [{ agentId: fresh.id, scopeId: REPO }],
    depsOf({ draining: true }),
  );
  assert.deepEqual(result.marked, [fresh.id]);
  assert.equal(world.workspaces[0].metadata[WORKERS_KEY][fresh.id].state, "interrupted");
  assert.equal(result.wakes.length, 1);
  assert.equal(result.wakes[0].sent, false);
  assert.equal(result.wakes[0].reason, "drain");
  assert.equal(sendsTo(world, steers.A.id).length, 0);
  assert.ok(world.workspaces[0].metadata[WORKERS_KEY][fresh.id].pendingWake, "interrupted news queued");
  assert.ok(world.workspaces[0].metadata[WORKERS_KEY][draining.id].pendingWake, "old interrupted news queued too");
});

// ---------------------------------------------------------------------------
// Failover: unanswered wakes walk the chain, logged as source failover.
// ---------------------------------------------------------------------------

function unansweredWorld() {
  const world = makeWorld();
  const { ws, steers } = provisioned(world, {
    workers: {},
    agents: {},
    checkpoint: { task: "ship it", tests: ["npm test"], blockers: [], next: "release" },
  });
  const worker = addWorker(world, ws);
  world.workspaces[0].metadata[WORKERS_KEY] = {
    [worker.id]: entry("blocked", "stuck task", { lastWakeAt: at(NOW - 11 * MIN) }),
  };
  world.workspaces[0].metadata[AGENTS_KEY] = {
    [steers.A.id]: { lastTurnEndedAt: at(NOW - 30 * MIN), outcome: "completed", openTurnId: null, turnStartedAt: null },
  };
  return { world, ws, steers, worker };
}

function failoverDeps(world, overrides = {}) {
  return depsOf({
    ...overrides,
    delivery: {
      buildBrief: async (_paseo, workspaceId, agentId) => {
        const workspace = world.workspaces.find(({ id }) => id === workspaceId);
        assert.equal(workspace.metadata[METADATA_KEY].activeAgentId, agentId);
        return workspace.metadata[CHECKPOINT_KEY]?.task ?? "Resume assigned work";
      },
      workerHandoverCli: ([resource, verb, id, flag, value]) => {
        assert.deepEqual([resource, verb], ["agent", "update"]);
        const agent = world.agents.find((entry) => entry.id === id);
        if (flag === "--name") agent.title = value;
        else {
          assert.equal(flag, "--label");
          Object.assign(agent.labels, Object.fromEntries(value.split(",").map((label) => label.split("="))));
        }
      },
      ...overrides.delivery,
    },
  });
}

const MANAGED_CREATION_KEY = `${METADATA_KEY}.managedSteerCreation`;

function managedFailoverWorld() {
  const { world, ws, steers, worker } = unansweredWorld();
  steers.B.archivedAt = steers.C.archivedAt = at(NOW);
  const scope = { id: REPO, workspaceId: ws.id };
  const paseo = fakeClient(world);
  const catalog = { entries: [{ provider: "codex", enabled: true, status: "ready", models: [{ id: "m" }, { id: "m2" }] }] };
  paseo.providers.snapshot = async () => catalog;
  const receipts = new Map();
  const requests = [];
  const config = { routing: { noSuitableSteer: "create" }, steers: { priority: ["open"] },
    profiles: { open: { provider: "codex", model: "m" } } };
  let tail = Promise.resolve();
  const deps = failoverDeps(world, {
    getConfig: async () => config,
    lookupSteerCreation: async (kind, key) => {
      assert.equal(kind, "agent");
      return receipts.get(key) ?? null;
    },
    lock: (name, operation) => {
      const next = tail.then(() => noLock(name, operation));
      tail = next.catch(() => {});
      return next;
    },
  });
  const receipt = (request, fields) => receipts.set(request.idempotencyKey, {
    kind: "agent", idempotencyKey: request.idempotencyKey, workspaceId: ws.id, ...fields,
  });
  const complete = (request) => {
    const [provider, model] = request.config.provider.split("/");
    const agent = addAgent(world, { workspaceId: ws.id, title: request.title, labels: request.labels,
      metadata: request.metadata, provider, model });
    receipt(request, { phase: "completed", agentId: agent.id });
    return agent;
  };
  const native = { create: async (request) => complete(request) };
  const workspaceRef = paseo.workspaces.ref;
  paseo.workspaces.ref = (id) => ({ ...workspaceRef(id), agents: { async create(request) {
    assert.equal(id, ws.id);
    const state = ws.metadata[MANAGED_CREATION_KEY];
    assert.equal(state.phase, "pending");
    assert.equal(state.idempotencyKey, request.idempotencyKey);
    assert.equal(request.prompt, undefined);
    assert.equal(request.parent, undefined);
    assert.equal(request.metadata["zerosub.account"], undefined);
    assert.equal(request.metadata["wsf.createdBy"], "factory");
    requests.push(request);
    return native.create(request);
  } } });
  const check = (minutes = 0, overrides = {}) => supervise.runFailoverCheck(paseo, scope, {
    ...deps, nowMs: NOW + minutes * MIN, nowIso: at(NOW + minutes * MIN), ...overrides,
  });
  const addEscalations = () => {
    ws.metadata[METADATA_KEY].scope.domain = "shop";
    return ["shop", "hub"].map((scopeId) => {
      const external = addWorkspace(world, { metadata: scopeMeta({ scopeId, kind: scopeId === "hub" ? "hub" : "dir" }) });
      return addAgent(world, { title: "Steer A", workspaceId: external.id,
        labels: { [LABEL.role]: "steer", [LABEL.slot]: "A", [LABEL.scope]: scopeId } });
    });
  };
  return { world, ws, steers, worker, scope, deps, paseo, check, config, requests, receipt, complete, native, addEscalations };
}

test("wait and offer are distinct and leave the holder, work and creation state untouched", async () => {
  const { world, ws, check, config, requests, addEscalations } = managedFailoverWorld();
  const before = structuredClone(ws.metadata);
  config.routing.noSuitableSteer = "wait";
  assert.deepEqual(await check(), { action: "wait", reason: "no-suitable-steer-wait" });
  config.routing.noSuitableSteer = "offer";
  assert.deepEqual(await check(), { action: "wait", reason: "offer-create-steer",
    offer: { kind: "create-steer", scopeId: REPO, workspaceId: ws.id } });
  assert.deepEqual(ws.metadata, before);
  const [domain] = addEscalations();
  assert.equal((await check()).reason, "offer-create-steer");
  assert.deepEqual(world.calls, []);
  assert.deepEqual(requests, []);

  config.routing.noSuitableSteer = "wait";
  assert.equal((await check()).to.steerId, domain.id);
  assert.equal(ws.metadata[METADATA_KEY].epoch, 3);
});

test("an eligible local standby wins over creation and a cheaper domain or hub", async () => {
  const { world, ws, steers, check, requests, addEscalations, deps } = managedFailoverWorld();
  const escalations = addEscalations();
  steers.B.archivedAt = null;
  steers.B.provider = "claude";
  ws.metadata[AGENTS_KEY][steers.B.id] = { lastTurnEndedAt: at(NOW - 6 * MIN) };
  let renewals = 0;
  const result = await check(0, { delivery: { ...deps.delivery, runCleanupFn: async () => { renewals++; } } });
  assert.equal(result.reason, "brief-pending");
  assert.equal(ws.metadata[METADATA_KEY].activeAgentId, steers.B.id);
  assert.equal(renewals, 1);
  assert.equal(requests.length, 0);
  assert.equal(ws.metadata[MANAGED_CREATION_KEY], undefined);
  assert.deepEqual(escalations.flatMap((steer) => sendsTo(world, steer.id)), []);
});

test("the creation lock reuses a standby that arrived after planning", async () => {
  const { world, ws, steers, check, requests, deps } = managedFailoverWorld();
  let entered = false;
  const lock = (name, operation) => deps.lock(name, async (held) => {
    if (!entered) {
      entered = true;
      steers.B.archivedAt = null;
    }
    return operation(held);
  });
  assert.equal((await check(0, { lock })).to.steerId, steers.B.id);
  assert.equal(sendsTo(world, steers.B.id).length, 1);
  assert.equal(ws.metadata[MANAGED_CREATION_KEY], undefined);
  assert.equal(requests.length, 0);
});

test("automatic creation precedes domain/hub and two checks create and activate at most once", async () => {
  const { world, ws, steers, worker, check, requests, addEscalations, paseo, scope, deps } = managedFailoverWorld();
  const escalations = addEscalations();
  steers.A.archivedAt = at(NOW);
  const queuedAt = at(NOW - MIN);
  ws.metadata[WORKERS_KEY][worker.id].pendingWake = { state: "blocked", queuedAt };
  const outcomes = await Promise.all([check(0, { force: true, failingAgentId: null }), check(0, { force: true, failingAgentId: null })]);
  assert.equal(outcomes.filter(({ action }) => action === "failover").length, 1);
  const state = ws.metadata[MANAGED_CREATION_KEY];
  assert.equal(state.phase, "completed");
  assert.equal(requests.length, 1);
  assert.equal(ws.metadata[METADATA_KEY].epoch, 4);
  assert.equal(ws.metadata[METADATA_KEY].activeAgentId, state.agentId);
  assert.equal(ws.metadata[METADATA_KEY].activeSteer, "B");
  assert.equal(sendsTo(world, state.agentId).length, 1);
  assert.match(sendsTo(world, state.agentId)[0], /stuck task/);
  assert.equal(ws.metadata[WORKERS_KEY][worker.id].pendingWake, null);
  assert.deepEqual(escalations.flatMap((steer) => sendsTo(world, steer.id)), []);

  supervise.resetSupervisionForTests();
  assert.equal((await supervise.flushScope(paseo, scope, deps)).flushed, false);
  assert.equal(sendsTo(world, state.agentId).length, 1);
  assert.equal(requests.length, 1);
});

test("missing, unavailable and stale receipts preserve the reservation over restarts", async () => {
  const { world, ws, check, requests, native, receipt, complete, config } = managedFailoverWorld();
  native.create = async () => { throw new Error("lost creation response"); };
  assert.equal((await check()).reason, "managed-steer-receipt-missing");
  const [request] = requests;
  const persisted = structuredClone(ws.metadata[MANAGED_CREATION_KEY]);

  supervise.resetSupervisionForTests();
  assert.equal((await check(60, { lookupSteerCreation: async () => { throw new Error("offline"); } })).reason, "managed-steer-receipt-unavailable");
  receipt(request, { phase: "accepted" });
  assert.equal((await check(61)).reason, "managed-steer-receipt-pending");
  receipt(request, { phase: "failed", outcomeUnknown: true, failedStage: "agent" });
  assert.equal((await check(62)).reason, "managed-steer-outcome-unknown");
  receipt(request, { phase: "completed", agentId: "missing" });
  assert.equal((await check(63)).reason, "managed-steer-agent-missing");
  const target = complete(request);
  target.model = "wrong";
  assert.equal((await check(64)).reason, "managed-steer-agent-mismatch");
  assert.deepEqual(ws.metadata[MANAGED_CREATION_KEY], persisted);
  assert.equal(requests.length, 1);
  assert.equal(sendsTo(world, target.id).length, 0);

  target.model = "m";
  config.routing.noSuitableSteer = "wait";
  assert.equal((await check(65)).to.steerId, target.id);
  assert.equal(ws.metadata[MANAGED_CREATION_KEY].phase, "completed");
  assert.equal(requests.length, 1);
  assert.equal(sendsTo(world, target.id).length, 1);
});

test("confirmed creation failures back off durably, exhaust the cycle and reopen on changed eligibility", async () => {
  const { ws, check, requests, native, receipt, config, complete, addEscalations } = managedFailoverWorld();
  addEscalations();
  native.create = async (request) => {
    receipt(request, { phase: "failed", outcomeUnknown: false, failedStage: "agent", error: "creation refused" });
    throw new Error("creation refused");
  };
  assert.deepEqual(await check(), { action: "wait", reason: "managed-steer-backoff", wakeAt: at(NOW + MIN) });
  supervise.resetSupervisionForTests();
  assert.equal((await check(0.5)).reason, "managed-steer-backoff");
  assert.equal(requests.length, 1);
  assert.deepEqual(await check(1), { action: "wait", reason: "managed-steer-backoff", wakeAt: at(NOW + 3 * MIN) });
  assert.equal((await check(2)).reason, "managed-steer-backoff");
  assert.equal((await check(3)).reason, "managed-steer-exhausted");
  assert.equal((await check(40)).reason, "managed-steer-exhausted");
  assert.equal(requests.length, 3);
  assert.equal(new Set(requests.map(({ idempotencyKey }) => idempotencyKey)).size, 3);
  assert.equal(ws.metadata[MANAGED_CREATION_KEY].attempts, 3);
  assert.equal(ws.metadata[METADATA_KEY].epoch, 3);

  config.profiles.open.model = "m2";
  native.create = async (request) => complete(request);
  assert.equal((await check(41)).action, "failover");
  assert.equal(requests.length, 4);
  assert.equal(ws.metadata[MANAGED_CREATION_KEY].generation, 4);
  assert.equal(ws.metadata[MANAGED_CREATION_KEY].attempts, 1);
});

test("creation falls through to domain only when no local creation route is available", async () => {
  const { ws, check, config, requests, addEscalations } = managedFailoverWorld();
  const [domain] = addEscalations();
  config.profiles.open.model = "missing-from-catalog";
  assert.equal((await check()).to.steerId, domain.id);
  assert.equal(ws.metadata[MANAGED_CREATION_KEY], undefined);
  assert.equal(requests.length, 0);
});

test("managed creation checks the actual model limit and keeps its budget across quota ranking changes", async () => {
  const { ws, steers, check, native, requests, receipt } = managedFailoverWorld();
  const holder = steers.A;
  const resetAt = at(NOW + 30 * MIN);
  ws.metadata[AGENTS_KEY][holder.id].quotaLimit = { accountId: "limited", provider: holder.provider, model: holder.model, at: at(NOW), resetAt };
  const account = (id, usedPct) => ({ id, family: holder.provider, sampledAt: at(NOW - MIN),
    windows: [{ id: "5h", usedPct, resetsAt: resetAt }] });
  const route = (accounts) => ({ force: true, quotaTrigger: { accountId: "limited" },
    zerosub: { accounts, agentAccount: { [holder.id]: "limited" }, pending: {} } });
  const limited = account("limited", 0);
  assert.equal((await check(0, route([limited]))).reason, "managed-steer-unavailable");
  assert.equal(requests.length, 0);

  native.create = async (request) => receipt(request, { phase: "failed", outcomeUnknown: false, failedStage: "agent" });
  assert.equal((await check(0, route([limited, account("a", 10), account("b", 20)]))).reason, "managed-steer-backoff");
  assert.equal((await check(0.5, route([limited, account("b", 10), account("a", 20)]))).reason, "managed-steer-backoff");
  assert.equal(requests.length, 1);
  assert.equal(ws.metadata[MANAGED_CREATION_KEY].attempts, 1);
});

test("automatic creation rechecks epoch, pause, pending permission and ZeroSub moves before reserving", async () => {
  for (const reason of ["moved", "paused", "brief-pending", "wait-zerosub"]) {
    const { ws, steers, check, deps, requests } = managedFailoverWorld();
    let paused = false;
    let zerosub = null;
    const lock = (name, operation) => deps.lock(name, async (held) => {
      if (reason === "moved") ws.metadata[METADATA_KEY].epoch++;
      if (reason === "paused") paused = true;
      if (reason === "brief-pending") steers.A.pendingPermissions.push({});
      if (reason === "wait-zerosub") zerosub = { accounts: [], pending: { [steers.A.id]: "source" } };
      return operation(held);
    });
    const result = await check(0, { lock, getZerosub: async () => zerosub, delivery: { ...deps.delivery, isFactoryPaused: async () => paused } });
    assert.equal(result.reason, reason);
    assert.equal(ws.metadata[MANAGED_CREATION_KEY], undefined);
    assert.equal(requests.length, 0);
  }
});

test("forced failover respects boot and drain without requiring a worker", async () => {
  for (const quiet of ["boot", "global", "marker"]) {
    const { world, ws, steers } = unansweredWorld();
    ws.metadata[WORKERS_KEY] = {};
    if (quiet === "marker") ws.metadata[DRAIN_METADATA_KEY] = drainMarker(at(NOW + 10 * MIN));
    const result = await supervise.runFailoverCheck(fakeClient(world), { id: REPO, workspaceId: ws.id },
      depsOf({ force: true, bootCheckDone: quiet !== "boot", draining: quiet === "global" }));
    assert.equal(result.action, "wait", quiet);
    assert.equal(sendsTo(world, steers.B.id).length, 0, quiet);
  }
});

test("unanswered wake transfers local authority and sends one continuation", async () => {
  const { world, ws, steers, worker } = unansweredWorld();
  const paseo = fakeClient(world);
  const scope = { id: REPO, workspaceId: ws.id };
  worker.labels[PARENT_LABEL] = steers.A.id;
  const before = structuredClone(ws.metadata[WORKERS_KEY][worker.id]);
  const deps = failoverDeps(world);
  const result = await supervise.runFailoverCheck(paseo, scope, deps);
  assert.equal(result.action, "failover");
  assert.deepEqual(result.to, { kind: "steer", slot: "B", steerId: steers.B.id });
  const texts = sendsTo(world, steers.B.id);
  assert.equal(texts.length, 1);
  assert.match(texts[0], /\[Factory resume\]\nship it/);
  assert.doesNotMatch(texts[0], /switch .*--apply/);
  assert.equal(sendsTo(world, steers.A.id).length, 0);
  assert.equal(ws.metadata[METADATA_KEY].activeAgentId, steers.B.id);
  assert.equal(ws.metadata[METADATA_KEY].epoch, 4);
  assert.equal(worker.labels[PARENT_LABEL], steers.B.id);
  assert.equal(worker.labels[LABEL.owner], "B");
  const checkpoint = world.workspaces[0].metadata[CHECKPOINT_KEY];
  assert.equal(checkpoint.source, "failover");
  assert.deepEqual(checkpoint.failover, { kind: "local-switch", previousSteer: "A", reason: "no answer within 10m" });
  assert.equal(checkpoint.task, "ship it", "task preserved");
  assert.equal(checkpoint.epoch, 4);
  assert.deepEqual(ws.metadata[WORKERS_KEY][worker.id], before);
  assert.equal(ws.metadata[AGENTS_KEY][steers.B.id].action.phase, "done");
  assert.equal((await supervise.runFailoverCheck(paseo, scope, deps)).reason, "no-wake");
  assert.equal((await supervise.retryPendingWakeBrief(paseo, scope, deps)).delivered, false);
  assert.equal(sendsTo(world, steers.B.id).length, 1);
});

test("a due worker wake activates a standby when the active slot is vacant", async () => {
  const { world, ws, steers, worker } = unansweredWorld();
  steers.A.archivedAt = at(NOW - MIN);
  ws.metadata[METADATA_KEY].activeAgentId = steers.A.id;
  worker.labels[PARENT_LABEL] = steers.A.id;
  const pendingWake = { state: "done", queuedAt: at(NOW) };
  ws.metadata[WORKERS_KEY][worker.id] = entry("done", "deliver result", { pendingWake });
  const scope = { id: REPO, workspaceId: ws.id };
  const paseo = fakeClient(world);
  const deps = failoverDeps(world);
  const first = await supervise.sendScopeWake(paseo, { scope }, deps);
  assert.equal(first.sent, true);
  assert.equal(first.target, steers.B.id);
  assert.equal(ws.metadata[METADATA_KEY].activeAgentId, steers.B.id);
  assert.equal(ws.metadata[METADATA_KEY].epoch, 4);
  assert.equal(worker.labels[PARENT_LABEL], steers.B.id);
  assert.equal(ws.metadata[WORKERS_KEY][worker.id].pendingWake, null);
  assert.equal(sendsTo(world, steers.A.id).length, 0);
  assert.equal(sendsTo(world, steers.B.id).length, 1);
  assert.match(sendsTo(world, steers.B.id)[0], /deliver result\): result reported/);
  assert.equal((await supervise.retryPendingWakeBrief(paseo, scope, deps)).delivered, false);
  assert.equal((await supervise.sendScopeWake(paseo, { scope }, deps)).reason, "no-events");
});

test("a vacant-slot wake leaves authority and the report intact when membership or due work changes", async () => {
  for (const race of ["ambiguous holder", "slot filled", "wake withdrawn"]) {
    const { world, ws, steers, worker } = unansweredWorld();
    const pendingWake = { state: "blocked", queuedAt: at(NOW) };
    ws.metadata[WORKERS_KEY][worker.id].pendingWake = pendingWake;
    steers.A.archivedAt = race === "ambiguous holder" ? null : at(NOW - MIN);
    if (race === "ambiguous holder") {
      addAgent(world, { title: steers.A.title, workspaceId: ws.id, labels: { ...steers.A.labels } });
    }
    const deps = failoverDeps(world, {
      lock: (name, operation) => {
        if (race === "slot filled") steers.A.archivedAt = null;
        if (race === "wake withdrawn") ws.metadata[WORKERS_KEY][worker.id].pendingWake = null;
        return noLock(name, operation);
      },
    });
    const scope = { id: REPO, workspaceId: ws.id };
    const result = await supervise.sendScopeWake(fakeClient(world), { scope }, deps);
    assert.equal(result.sent, false, race);
    assert.equal(ws.metadata[METADATA_KEY].epoch, 3, race);
    assert.equal(world.calls.length, 0, race);
  }
});

test("vacant-slot continuation preserves a newer worker event during acknowledgement", async () => {
  const { world, ws, steers, worker } = unansweredWorld();
  steers.A.archivedAt = at(NOW - MIN);
  const pendingWake = { state: "done", queuedAt: at(NOW - MIN) };
  const newer = { ...pendingWake, queuedAt: at(NOW + MIN) };
  ws.metadata[WORKERS_KEY][worker.id] = entry("done", "deliver result", { pendingWake });
  const scope = { id: REPO, workspaceId: ws.id };
  const paseo = fakeClient(world);
  const ref = paseo.agents.ref;
  paseo.agents.ref = (id) => {
    const handle = ref(id);
    return { ...handle, async send(text) {
      await handle.send(text);
      ws.metadata[WORKERS_KEY][worker.id].pendingWake = newer;
    } };
  };
  const first = await supervise.sendScopeWake(paseo, { scope }, failoverDeps(world));
  assert.equal(first.sent, true);
  assert.equal(sendsTo(world, steers.B.id).length, 1);
  assert.deepEqual(ws.metadata[WORKERS_KEY][worker.id].pendingWake, newer);
});

test("a cold successor holds authority during renewal and receives its continuation once", async () => {
  const { world, ws, steers, worker } = unansweredWorld();
  steers.C.archivedAt = at(NOW); // B is the only eligible route in this renewal test.
  steers.B.provider = "claude";
  steers.B.persistence = { sessionId: "old-session" };
  ws.metadata[AGENTS_KEY][steers.B.id] = { lastTurnEndedAt: at(NOW - 6 * MIN) };
  const paseo = fakeClient(world);
  const scope = { id: REPO, workspaceId: ws.id };
  const deps = failoverDeps(world, { delivery: { buildBrief: async () => "Task checkpoint" } });
  const outcome = await supervise.runFailoverCheck(paseo, scope, deps);
  assert.deepEqual(outcome, { action: "wait", reason: "brief-pending" });
  assert.equal(ws.metadata[METADATA_KEY].activeAgentId, steers.B.id);
  assert.deepEqual(sendsTo(world, steers.B.id), ["/clear"]);
  assert.equal(ws.metadata[WORKERS_KEY][worker.id].lastWakeAt, at(NOW - 11 * MIN));
  assert.equal(supervise.failoverStateForTests()[REPO], undefined);
  // The activation receipt owns the continuation even after restart.
  steers.C.archivedAt = null;
  supervise.resetSupervisionForTests();
  assert.deepEqual(await supervise.runFailoverCheck(paseo, scope, { ...deps, force: true }), { action: "wait", reason: "brief-pending" });
  assert.equal(sendsTo(world, steers.C.id).length, 0);
  assert.equal((await supervise.retryPendingWakeBrief(paseo, scope, deps)).delivered, false);

  // The verified clear is recorded by the turn hook, covered in wake-brief.test.
  const entry = ws.metadata[AGENTS_KEY][steers.B.id];
  entry.action.cleanup = null;
  steers.B.persistence.sessionId = "new-session";
  entry.action.facts = { ...entry.action.facts, cleared: { mode: "clear", sessionId: "new-session" }, actionVerified: true };
  entry.action.phase = "ready";
  assert.equal((await supervise.retryPendingWakeBrief(paseo, scope, deps)).delivered, true);
  assert.equal(sendsTo(world, steers.B.id).length, 2);
  assert.match(sendsTo(world, steers.B.id)[1], /\[Factory resume\]\nTask checkpoint/);
  assert.equal(ws.metadata[CHECKPOINT_KEY].source, "failover");
  assert.equal(ws.metadata[WORKERS_KEY][worker.id].lastWakeAt, at(NOW - 11 * MIN));
  assert.equal((await supervise.retryPendingWakeBrief(paseo, scope, deps)).delivered, false);
});

test("automatic failover compares preparation instead of just taking the next letter", async () => {
  const { world, ws, steers } = unansweredWorld();
  steers.B.provider = "claude";
  ws.metadata[AGENTS_KEY][steers.B.id] = { lastTurnEndedAt: at(NOW - 6 * MIN) };
  const result = await supervise.runFailoverCheck(fakeClient(world), { id: REPO, workspaceId: ws.id }, failoverDeps(world));
  assert.equal(result.action, "failover");
  assert.equal(result.to.steerId, steers.C.id);
  assert.equal(sendsTo(world, steers.B.id).length, 0);
  assert.equal(sendsTo(world, steers.C.id).length, 1);
});

test("concurrent automatic plans from one epoch commit a single controller and continuation", async () => {
  const { world, ws, steers } = unansweredWorld();
  const scope = { id: REPO, workspaceId: ws.id };
  const paseo = fakeClient(world);
  let release;
  const planned = new Promise((resolve) => { release = resolve; });
  let tail = Promise.resolve(), count = 0;
  const lock = (name, operation) => {
    const next = tail.then(() => planned).then(() => noLock(name, operation));
    tail = next.catch(() => {});
    if (++count === 2) release();
    return next;
  };
  const deps = failoverDeps(world, { lock });
  const attempts = await Promise.all([supervise.runFailoverCheck(paseo, scope, deps), supervise.runFailoverCheck(paseo, scope, deps)]);
  assert.deepEqual(attempts.map(({ action }) => action).sort(), ["failover", "wait"]);
  assert.equal(ws.metadata[METADATA_KEY].epoch, 4);
  assert.equal(ws.metadata[METADATA_KEY].activeAgentId, steers.B.id);
  assert.equal(sendsTo(world, steers.A.id).length + sendsTo(world, steers.C.id).length, 0);
  assert.equal(sendsTo(world, steers.B.id).length, 1);
});

test("local failover triggered by pendingWake delivers the wake in the handoff and clears pendingWake", async () => {
  const { world, ws, steers, worker } = unansweredWorld();
  const queuedAt = at(NOW - MIN);
  ws.metadata[WORKERS_KEY][worker.id].pendingWake = { state: "done", queuedAt };
  ws.metadata[AGENTS_KEY][steers.A.id].quotaLimit = { at: at(NOW - MIN), provider: "codex", model: "m" };
  const result = await supervise.runFailoverCheck(fakeClient(world), { id: REPO, workspaceId: ws.id }, failoverDeps(world, {
    force: true,
    failingAgentId: steers.A.id,
    includePendingWakes: true,
    quotaTrigger: {},
    failoverReason: "provider limit for pool (codex)",
  }));
  assert.equal(result.action, "failover");
  assert.equal(ws.metadata[METADATA_KEY].activeAgentId, steers.B.id);
  assert.equal(sendsTo(world, steers.A.id).length, 0);
  assert.equal(sendsTo(world, steers.B.id).length, 1);
  assert.match(sendsTo(world, steers.B.id)[0], /result reported/i);
  assert.equal(ws.metadata[WORKERS_KEY][worker.id].pendingWake, null);
});

test("local failover selects an executable route and preserves pending target operations", async () => {
  for (const unavailable of ["staged brief", "cleanup", "duplicate slot"]) {
    const { world, ws, steers } = unansweredWorld();
    const entries = ws.metadata[AGENTS_KEY];
    if (unavailable === "staged brief") {
      entries[steers.B.id] = { stagedBrief: { phase: "staged", wakeId: "draft", packet: "Prepared brief" } };
    }
    if (unavailable === "cleanup") {
      entries[steers.B.id] = { action: { kind: "cleanup", phase: "renewing", cleanup: { kind: "compact" } } };
    }
    if (unavailable === "duplicate slot") {
      addAgent(world, { title: steers.B.title, workspaceId: ws.id, labels: { ...steers.B.labels } });
    }
    const before = structuredClone(entries[steers.B.id]);
    const result = await supervise.runFailoverCheck(fakeClient(world), { id: REPO, workspaceId: ws.id }, failoverDeps(world));
    assert.equal(result.action, "failover", unavailable);
    assert.equal(ws.metadata[METADATA_KEY].activeAgentId, steers.C.id, unavailable);
    assert.deepEqual(ws.metadata[AGENTS_KEY][steers.B.id], before, unavailable);
    assert.equal(sendsTo(world, steers.B.id).length, 0, unavailable);
    assert.equal(sendsTo(world, steers.C.id).length, 1, unavailable);
  }
});

test("local failover rechecks authority, live work, quiet, admission and receipts under the lock", async () => {
  for (const change of ["holder", "permission", "pause", "drain", "quota", "source reset", "privacy", "receipt", "answer"]) {
    const { world, ws, steers, worker } = unansweredWorld();
    const scope = { id: REPO, workspaceId: ws.id };
    const before = structuredClone(ws.metadata[WORKERS_KEY][worker.id]);
    let crossing = false;
    if (change === "source reset") ws.metadata[AGENTS_KEY][steers.A.id].quotaLimit = { at: at(NOW), provider: "codex", model: "m" };
    const deps = failoverDeps(world, {
      ...(change === "source reset" ? { force: true, quotaTrigger: {} } : {}),
      lock: (name, operation) => {
        crossing = true;
        if (change === "holder") ws.metadata[METADATA_KEY].activeAgentId = steers.C.id;
        if (change === "permission") steers.A.pendingPermissions = [{ id: "prompt" }];
        if (change === "drain") ws.metadata[DRAIN_METADATA_KEY] = drainMarker(at(NOW + MIN));
        if (change === "quota") ws.metadata[AGENTS_KEY][steers.B.id] = { quotaLimit: { at: at(NOW), provider: "codex", model: "m" } };
        if (change === "source reset") delete ws.metadata[AGENTS_KEY][steers.A.id].quotaLimit;
        if (change === "receipt") ws.metadata[AGENTS_KEY][steers.C.id] = { action: {
          phase: "uncertain", wakeId: "unresolved", epoch: 3,
          batch: { workspaceId: ws.id, epoch: 3, events: [], takeover: { scopeId: REPO, activeSlot: "A" } },
        } };
        if (change === "answer") ws.metadata[AGENTS_KEY][steers.A.id].lastTurnEndedAt = at(NOW - MIN);
        return noLock(name, operation);
      },
      getConfig: async () => crossing && change === "privacy"
        ? { profiles: { sensitive: { provider: "codex", sensitive: true } } } : null,
      delivery: { isFactoryPaused: async () => crossing && change === "pause", getScopePublic: async () => true },
    });
    const result = await supervise.runFailoverCheck(fakeClient(world), scope, deps);
    assert.equal(crossing, true, change);
    assert.equal(result.action, "wait", change);
    assert.equal(ws.metadata[METADATA_KEY].epoch, 3, change);
    assert.equal(ws.metadata[METADATA_KEY].activeSteer, "A", change);
    assert.deepEqual(ws.metadata[WORKERS_KEY][worker.id], before, change);
    assert.equal(world.calls.length, 0, change);
  }
});

test("unavailable native worker handover leaves a pending continuation on the new holder", async () => {
  const { world, ws, steers, worker } = unansweredWorld();
  const scope = { id: REPO, workspaceId: ws.id };
  const paseo = fakeClient(world);
  worker.labels[PARENT_LABEL] = steers.A.id;
  const before = structuredClone(ws.metadata[WORKERS_KEY][worker.id]);
  const deps = failoverDeps(world);
  let available = false;
  const native = deps.delivery.workerHandoverCli;
  deps.delivery.workerHandoverCli = (args) => {
    if (!available) throw new Error("native operation unavailable");
    native(args);
  };
  assert.equal((await supervise.runFailoverCheck(paseo, scope, deps)).reason, "brief-pending");
  assert.equal(ws.metadata[METADATA_KEY].activeAgentId, steers.B.id);
  assert.equal(ws.metadata[AGENTS_KEY][steers.B.id].action.phase, "reserved");
  assert.equal((await supervise.flushScope(paseo, scope, deps)).reason, "brief-pending");
  assert.equal(worker.labels[PARENT_LABEL], steers.A.id);
  assert.equal(worker.labels[LABEL.owner], "A");
  assert.deepEqual(ws.metadata[WORKERS_KEY][worker.id], before);
  assert.equal(world.calls.filter(([kind]) => kind === "agent.send").length, 0);
  available = true;
  assert.equal((await supervise.flushScope(paseo, scope, deps)).flushed, true);
  assert.equal(ws.metadata[METADATA_KEY].workerHandover, undefined);
  assert.equal(worker.labels[PARENT_LABEL], steers.B.id);
  assert.equal(worker.labels[LABEL.owner], "B");
  assert.equal(sendsTo(world, steers.B.id).length, 1);
});

test("a lost authority write response resumes the stored switch without another transition", async () => {
  const { world, ws, steers, worker } = unansweredWorld();
  const scope = { id: REPO, workspaceId: ws.id };
  const paseo = fakeClient(world);
  const ref = paseo.workspaces.ref;
  paseo.workspaces.ref = (id) => {
    const handle = ref(id);
    return { ...handle, async setMetadata(patch) {
      await handle.setMetadata(patch);
      if (id === ws.id && patch[METADATA_KEY]?.epoch === 4 && patch[AGENTS_KEY]) throw new Error("response lost");
    } };
  };
  const deps = failoverDeps(world);
  assert.equal((await supervise.runFailoverCheck(paseo, scope, deps)).reason, "brief-pending");
  assert.equal(ws.metadata[METADATA_KEY].activeAgentId, steers.B.id);
  const receipt = ws.metadata[AGENTS_KEY][steers.B.id].action;
  assert.equal(receipt.phase, "reserved");
  assert.equal(sendsTo(world, steers.B.id).length, 0);
  supervise.resetSupervisionForTests();
  assert.equal((await supervise.flushScope(paseo, scope, deps)).flushed, true);
  assert.equal(ws.metadata[METADATA_KEY].epoch, 4);
  assert.equal(worker.labels[PARENT_LABEL], steers.B.id);
  assert.equal(ws.metadata[AGENTS_KEY][steers.B.id].action.wakeId, receipt.wakeId);
  assert.equal(sendsTo(world, steers.B.id).length, 1);
  assert.equal((await supervise.flushScope(paseo, scope, deps)).flushed, false);
});

test("failover excludes a sensitive runtime and leaves the worker wake pending", async () => {
  const { world, ws, steers, worker } = unansweredWorld();
  steers.B.provider = "muse";
  steers.B.model = "changed";
  steers.C.archivedAt = at(NOW);
  const before = structuredClone(ws.metadata[WORKERS_KEY][worker.id]);
  const result = await supervise.runFailoverCheck(fakeClient(world), { id: REPO, workspaceId: ws.id },
    depsOf({ delivery: { getScopePublic: async () => true } }));
  assert.equal(result.reason, "candidates-ineligible");
  assert.equal(sendsTo(world, steers.B.id).length, 0);
  assert.deepEqual(ws.metadata[WORKERS_KEY][worker.id], before);
  assert.equal(ws.metadata[METADATA_KEY].epoch, 3);
});

test("preference strategy can select a cold earlier candidate while preserving renewal", async () => {
  const { world, ws, steers } = unansweredWorld();
  steers.B.provider = "claude";
  ws.metadata[AGENTS_KEY][steers.B.id] = { lastTurnEndedAt: at(NOW - 6 * MIN) };
  const result = await supervise.runFailoverCheck(fakeClient(world), { id: REPO, workspaceId: ws.id },
    failoverDeps(world, { getConfig: async () => ({ routing: { strategy: "preference" } }) }));
  assert.deepEqual(result, { action: "wait", reason: "brief-pending" });
  assert.deepEqual(sendsTo(world, steers.B.id), ["/clear"]);
  assert.equal(sendsTo(world, steers.C.id).length, 0);
});

test("an unattempted worker batch follows the scope through an epoch change", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const worker = addWorker(world, ws);
  const queuedAt = at(NOW - MIN);
  ws.metadata[WORKERS_KEY] = { [worker.id]: entry("done", "work", { pendingWake: { state: "done", queuedAt } }) };
  ws.metadata[AGENTS_KEY] = { [steers.A.id]: { action: {
    wakeId: "old-batch", phase: "reserved", renewal: "send", epoch: 3, queuedAt,
    batch: { workspaceId: ws.id, epoch: 3, events: [{ workerId: worker.id, state: "done", queuedAt }] },
  } } };
  ws.metadata[METADATA_KEY].activeSteer = "B";
  ws.metadata[METADATA_KEY].activeAgentId = steers.B.id;
  ws.metadata[METADATA_KEY].epoch = 4;
  const result = await supervise.flushScope(fakeClient(world), { id: REPO, workspaceId: ws.id }, depsOf());
  assert.equal(result.flushed, true);
  assert.equal(sendsTo(world, steers.A.id).length, 0);
  assert.equal(sendsTo(world, steers.B.id).length, 1);
  assert.equal(ws.metadata[WORKERS_KEY][worker.id].pendingWake, null);
});

test("an unresolved old-epoch receipt holds only its own worker event", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const old = addWorker(world, ws);
  const current = addWorker(world, ws);
  const queuedAt = at(NOW - MIN);
  const pendingWake = { state: "done", queuedAt };
  ws.metadata[WORKERS_KEY] = {
    [old.id]: entry("done", "previous result", { pendingWake }),
    [current.id]: entry("done", "new result", { pendingWake }),
  };
  ws.metadata[AGENTS_KEY] = { [steers.B.id]: { action: {
    wakeId: "previous-send", phase: "blocked", renewal: "rewind", epoch: 2, queuedAt, attemptedAt: queuedAt,
    batch: { workspaceId: ws.id, epoch: 2, events: [{ workerId: old.id, ...pendingWake }] },
  } } };

  const result = await supervise.flushScope(fakeClient(world), { id: REPO, workspaceId: ws.id }, depsOf());
  assert.equal(result.flushed, true);
  const [wake] = sendsTo(world, steers.A.id);
  assert.ok(wake.includes("new result"));
  assert.ok(!wake.includes("previous result"));
  assert.equal(sendsTo(world, steers.B.id).length, 0);
  assert.equal(ws.metadata[AGENTS_KEY][steers.B.id].action.wakeId, "previous-send");
  assert.deepEqual(ws.metadata[WORKERS_KEY][old.id].pendingWake, pendingWake);
  assert.equal(ws.metadata[WORKERS_KEY][current.id].pendingWake, null);
});

test("answered and busy steers stop failover; fresh wakes wait", async () => {
  const { world, ws, steers } = unansweredWorld();
  const paseo = fakeClient(world);
  const scope = { id: REPO, workspaceId: ws.id };
  world.workspaces[0].metadata[AGENTS_KEY][steers.A.id] = {
    lastTurnEndedAt: at(NOW - MIN), outcome: "completed", openTurnId: null, turnStartedAt: null,
  };
  assert.equal((await supervise.runFailoverCheck(paseo, scope, depsOf())).action, "answered");
  world.workspaces[0].metadata[AGENTS_KEY][steers.A.id] = {
    lastTurnEndedAt: at(NOW - 30 * MIN), outcome: "completed", openTurnId: "t9", turnStartedAt: at(NOW - 2 * MIN),
  };
  assert.equal((await supervise.runFailoverCheck(paseo, scope, depsOf())).action, "busy");
  world.workspaces[0].metadata[AGENTS_KEY][steers.A.id] = {
    lastTurnEndedAt: at(NOW - 30 * MIN), outcome: "completed", openTurnId: null, turnStartedAt: null,
  };
  const waiting = await supervise.runFailoverCheck(paseo, scope, depsOf({ nowMs: NOW - 5 * MIN, nowIso: at(NOW - 5 * MIN) }));
  assert.equal(waiting.action, "wait");
  assert.equal(world.calls.filter((c) => c[0] === "agent.send").length, 0);
});

test("external failover walks domain then hub and preserves the source authority", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world, { checkpoint: { task: "ship it", tests: [], blockers: [], next: null } });
  const worker = addWorker(world, ws);
  steers.B.archivedAt = steers.C.archivedAt = at(NOW);
  world.workspaces[0].metadata[WORKERS_KEY] = { [worker.id]: entry("interrupted", "lost", { lastWakeAt: at(NOW - 11 * MIN) }) };
  world.workspaces[0].metadata[AGENTS_KEY] = { [steers.A.id]: { lastTurnEndedAt: at(NOW - 60 * MIN), outcome: "completed" } };
  const domainWs = addWorkspace(world, { metadata: scopeMeta({ scopeId: "shop", kind: "dir", workers: {}, agents: {}, checkpoint: null }) });
  const domainSteer = addAgent(world, { title: "Steer A", workspaceId: domainWs.id, labels: { [LABEL.role]: "steer", [LABEL.slot]: "A", [LABEL.scope]: "shop" } });
  const hubWs = addWorkspace(world, { metadata: scopeMeta({ scopeId: "hub", kind: "hub", workers: {}, agents: {}, checkpoint: null }) });
  const hubSteer = addAgent(world, { title: "Steer A", workspaceId: hubWs.id, labels: { [LABEL.role]: "steer", [LABEL.slot]: "A", [LABEL.scope]: "hub" } });
  world.workspaces[0].metadata[METADATA_KEY].scope.domain = "shop";
  const paseo = fakeClient(world);
  const scope = { id: REPO, workspaceId: ws.id };
  const step = (minutes) => depsOf({ nowMs: NOW + minutes * MIN, nowIso: at(NOW + minutes * MIN) });
  const domain = await supervise.runFailoverCheck(paseo, scope, step(0));
  assert.deepEqual(domain.to, { kind: "domain", steerId: domainSteer.id, scopeId: "shop" });
  assert.match(sendsTo(world, domainSteer.id)[0], /As the domain steer/);
  supervise.resetSupervisionForTests();
  assert.equal((await supervise.runFailoverCheck(paseo, scope, { ...step(1), force: true })).reason, "takeover-answer-window");
  const hub = await supervise.runFailoverCheck(paseo, scope, step(11));
  assert.deepEqual(hub.to, { kind: "hub", steerId: hubSteer.id, scopeId: "hub" });
  assert.match(sendsTo(world, hubSteer.id)[0], /As the hub steer/);
  const cycle = await supervise.runFailoverCheck(paseo, scope, step(22));
  assert.deepEqual(cycle.to, domain.to);
  assert.equal(ws.metadata[METADATA_KEY].epoch, 3);
  assert.equal(ws.metadata[METADATA_KEY].activeSteer, "A");
});

test("a persisted legacy local takeover receipt still reconciles and honors its answer window", async () => {
  const { world, ws, steers, worker } = unansweredWorld();
  const scope = { id: REPO, workspaceId: ws.id };
  ws.metadata[AGENTS_KEY][steers.B.id] = { action: {
    kind: "delivery", phase: "ready", renewal: "send", wakeId: "legacy-takeover", epoch: 3, queuedAt: at(NOW - MIN),
    packet: "Take over with the existing guarded switch.",
    batch: { workspaceId: ws.id, epoch: 3, events: [{ workerId: worker.id, state: "blocked" }],
      takeover: { scopeId: REPO, activeSlot: "A", reason: "legacy request" } },
  } };
  const paseo = fakeClient(world);
  const deps = failoverDeps(world);
  assert.equal((await supervise.runFailoverCheck(paseo, scope, deps)).reason, "brief-pending");
  assert.equal((await supervise.retryPendingWakeBrief(paseo, scope, deps)).delivered, true);
  assert.equal(ws.metadata[AGENTS_KEY][steers.B.id].action.phase, "done");
  assert.equal(ws.metadata[METADATA_KEY].epoch, 3);
  supervise.resetSupervisionForTests();
  assert.equal((await supervise.runFailoverCheck(paseo, scope, { ...deps, force: true })).reason, "takeover-answer-window");
  assert.deepEqual(sendsTo(world, steers.B.id), ["Take over with the existing guarded switch."]);
  assert.equal(sendsTo(world, steers.C.id).length, 0);
});

test("failover follows a switch and clears when nothing is open", async () => {
  const { world, ws, worker } = unansweredWorld();
  const paseo = fakeClient(world);
  const scope = { id: REPO, workspaceId: ws.id };
  world.workspaces[0].metadata[METADATA_KEY].epoch = 4;
  world.workspaces[0].metadata[METADATA_KEY].activeSteer = "B";
  const moved = await supervise.runFailoverCheck(paseo, scope, failoverDeps(world));
  assert.equal(moved.action, "failover");
  assert.equal(moved.to.slot, "C", "chain continues after the active slot");
  world.workspaces[0].metadata[METADATA_KEY].switchedAt = at(NOW - 5 * MIN);
  world.workspaces[0].metadata[WORKERS_KEY] = { [worker.id]: entry("done", "old", { lastWakeAt: at(NOW - 60 * MIN) }) };
  assert.equal((await supervise.runFailoverCheck(paseo, scope, depsOf())).reason, "no-open");
  world.workspaces[0].metadata[WORKERS_KEY] = { [worker.id]: entry("blocked", "stuck") };
  assert.equal((await supervise.runFailoverCheck(paseo, scope, depsOf())).reason, "no-wake");
});

test("watchdog can fail over an unanswered final worker result and ignores an answered one", async () => {
  for (const answered of [false, true]) {
    const { world, ws, steers, worker } = unansweredWorld();
    ws.metadata[WORKERS_KEY][worker.id].state = "done";
    if (answered) ws.metadata[AGENTS_KEY][steers.A.id].lastTurnEndedAt = at(NOW - MIN);
    const result = await supervise.watchdogScan(fakeClient(world), failoverDeps(world));
    assert.equal(result.failovers.length, answered ? 0 : 1);
    assert.equal(sendsTo(world, steers.B.id).length, answered ? 0 : 1);
  }
});

test("failover log is epoch-checked and needs a task checkpoint", async () => {
  const world = makeWorld();
  const { ws } = provisioned(world, { checkpoint: { task: "ship it", tests: [], blockers: [], next: null } });
  const paseo = fakeClient(world);
  const args = { mainId: ws.id, previousSteer: "A", reason: "no answer within 10m" };
  assert.equal(await supervise.logFailoverCheckpoint(paseo, { ...args, expectedEpoch: 99 }, depsOf()), false);
  assert.equal(world.workspaces[0].metadata[CHECKPOINT_KEY].source, undefined);
  assert.equal(await supervise.logFailoverCheckpoint(paseo, { ...args, expectedEpoch: 3 }, depsOf()), true);
  assert.equal(world.workspaces[0].metadata[CHECKPOINT_KEY].source, "failover");
  delete world.workspaces[0].metadata[CHECKPOINT_KEY].task;
  assert.equal(await supervise.logFailoverCheckpoint(paseo, { ...args, expectedEpoch: 3 }, depsOf()), false);
});

test("failover race: exactly one of two candidates wins the switch", async () => {
  const world = makeWorld();
  provisioned(world);
  const paseo = fakeClient(world);
  const discoveryOf = () => ({
    forkName: REPO,
    scope: { id: REPO, kind: "github", locator: REPO },
    mainWorkspace: structuredClone(world.workspaces[0]),
    steers: { labelled: structuredClone(world.agents.filter((a) => a.labels?.[LABEL.role] === "steer")), legacy: [] },
    workers: [],
    providers: [],
  });
  const stale = discoveryOf();
  const first = await switchSteer({ client: paseo, discovery: stale, toSlot: "B", apply: true, lock: noLock });
  assert.equal(first.applied, true);
  assert.equal(first.epoch, 4);
  await assert.rejects(switchSteer({ client: paseo, discovery: stale, toSlot: "C", apply: true, lock: noLock }), SwitchRefused);
  assert.equal(world.workspaces[0].metadata[METADATA_KEY].activeSteer, "B");
});

test("turn backfills adopted workers and queues without a live holder or successor", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const adopted = addWorker(world, ws);
  world.workspaces[0].metadata[AGENTS_KEY] = { [adopted.id]: { note: "task: adopt me", noteAt: at(NOW - MIN) } };
  const result = await turnedOut(world, adopted, { assistant: checkpointOf("a", "partial") });
  assert.equal(result.action, "sent");
  const written = world.workspaces[0].metadata[WORKERS_KEY][adopted.id];
  assert.equal(written.state, "partial");
  assert.equal(written.startedBy, "A");
  world.workspaces[0].metadata[METADATA_KEY].activeSteer = "Z";
  for (const steer of Object.values(steers)) steer.archivedAt = at(NOW - MIN);
  const lonely = addWorker(world, ws);
  world.workspaces[0].metadata[WORKERS_KEY][lonely.id] = entry("running", "lonely");
  const queued = await turnedOut(world, lonely, { assistant: checkpointOf("l", "blocked") }, { settings: settings({ wakeDebounceSeconds: 0 }) });
  assert.equal(queued.action, "queued");
  assert.equal(queued.reason, "no-target");
  assert.ok(sendsTo(world, steers.A.id).length >= 1, "earlier wake still delivered");
});

// ---------------------------------------------------------------------------
// Watchdog: backfill, remove, reconcile, stale, failover per scope.
// ---------------------------------------------------------------------------

test("watchdog backfills adopted workers and drops archived entries", async () => {
  const world = makeWorld();
  const { ws } = provisioned(world);
  const adopted = addWorker(world, ws);
  const bg = addWorker(world, ws, { background: true });
  const gone = addWorker(world, ws, { archivedAt: at(NOW - MIN) });
  world.workspaces[0].metadata[AGENTS_KEY] = { [adopted.id]: { note: "task: adopt me", noteAt: at(NOW - MIN) } };
  world.workspaces[0].metadata[WORKERS_KEY] = { [gone.id]: entry("running", "gone") };
  const result = await supervise.watchdogScan(fakeClient(world), depsOf());
  assert.deepEqual(result.backfilled, [adopted.id]);
  assert.deepEqual(result.removed, [gone.id]);
  const written = world.workspaces[0].metadata[WORKERS_KEY][adopted.id];
  assert.equal(written.state, "running");
  assert.equal(written.task, "task: adopt me");
  assert.ok(!world.workspaces[0].metadata[WORKERS_KEY][bg.id], "background workers never backfilled");
  assert.ok(!world.workspaces[0].metadata[WORKERS_KEY][gone.id], "archived entries removed");
});

test("watchdog keeps entries of agents that are not live", async () => {
  const world = makeWorld();
  provisioned(world);
  world.workspaces[0].metadata[WORKERS_KEY] = { "w-ghost": entry("interrupted", "lost task") };
  const result = await supervise.watchdogScan(fakeClient(world), depsOf());
  assert.deepEqual(result.removed, []);
  assert.ok(world.workspaces[0].metadata[WORKERS_KEY]["w-ghost"], "ghost entries stay for resume");
});

test("watchdog reconciles restart marks only for idle workers", async () => {
  const world = makeWorld();
  const { ws } = provisioned(world);
  const drained = addWorker(world, ws);
  const recovering = addWorker(world, ws, { status: "running" });
  const moved = addWorker(world, ws);
  world.workspaces[0].metadata[WORKERS_KEY] = {
    [drained.id]: entry("running", "drained"),
    [recovering.id]: entry("running", "recovering"),
    [moved.id]: entry("running", "moved on"),
  };
  world.workspaces[0].metadata[AGENTS_KEY] = {
    [drained.id]: {
      lastTurnEndedAt: at(NOW - 20 * MIN), outcome: "canceled", openTurnId: null, turnStartedAt: null,
      interrupted: { at: at(NOW - 20 * MIN), reason: "planned-restart" },
    },
    [recovering.id]: {
      lastTurnEndedAt: at(NOW - 20 * MIN), outcome: "canceled", openTurnId: "t9", turnStartedAt: at(NOW - MIN),
      interrupted: { at: at(NOW - 20 * MIN), reason: "planned-restart" },
    },
    [moved.id]: {
      lastTurnEndedAt: at(NOW - MIN), outcome: "completed", openTurnId: null, turnStartedAt: null,
      interrupted: { at: at(NOW - 20 * MIN), reason: "daemon-restart" },
    },
  };
  const result = await supervise.watchdogScan(fakeClient(world), depsOf());
  assert.deepEqual(result.reconciled, [{ id: drained.id, event: "restart-planned" }]);
  assert.equal(world.workspaces[0].metadata[WORKERS_KEY][drained.id].state, "interrupted");
  assert.equal(world.workspaces[0].metadata[WORKERS_KEY][recovering.id].state, "running");
  assert.equal(world.workspaces[0].metadata[WORKERS_KEY][moved.id].state, "running");
});

test("watchdog marks idle running workers stale and queues the batch", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const idle = addWorker(world, ws, { updatedAt: at(NOW - 61 * MIN) });
  const busy = addWorker(world, ws, { status: "running", updatedAt: at(NOW - 61 * MIN) });
  const fresh = addWorker(world, ws, { updatedAt: at(NOW - MIN) });
  const blocked = addWorker(world, ws, { updatedAt: at(NOW - 61 * MIN) });
  world.workspaces[0].metadata[WORKERS_KEY] = {
    [idle.id]: entry("running", "idle", { startedAt: at(NOW - 61 * MIN) }),
    [busy.id]: entry("running", "busy", { startedAt: at(NOW - 61 * MIN) }),
    [fresh.id]: entry("running", "fresh", { startedAt: at(NOW - MIN) }),
    [blocked.id]: entry("blocked", "blocked", { startedAt: at(NOW - 61 * MIN) }),
  };
  world.workspaces[0].metadata[AGENTS_KEY] = {
    [idle.id]: { lastTurnEndedAt: at(NOW - 61 * MIN), outcome: "completed" },
    [fresh.id]: { lastTurnEndedAt: at(NOW - MIN), outcome: "completed" },
  };
  const result = await supervise.watchdogScan(fakeClient(world), depsOf());
  assert.deepEqual(result.stale, [idle.id]);
  assert.equal(world.workspaces[0].metadata[WORKERS_KEY][idle.id].state, "stale");
  assert.deepEqual(world.workspaces[0].metadata[WORKERS_KEY][idle.id].pendingWake, { state: "stale", queuedAt: at(NOW) });
  assert.equal(world.workspaces[0].metadata[WORKERS_KEY][blocked.id].state, "blocked");
  assert.equal(sendsTo(world, steers.A.id).length, 0, "no wake was ever sent, so no failover fires");
});

test("watchdog and wake delivery ignore archived, closed and missing stale workers", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const old = at(NOW - 90 * MIN);
  const archived = addWorker(world, ws, { archivedAt: old, updatedAt: old });
  const closed = addWorker(world, ws, { status: "closed", updatedAt: old });
  const closedWithoutEntry = addWorker(world, ws, { status: "closed", updatedAt: old });
  const pendingWake = { state: "stale", queuedAt: old };
  ws.metadata[AGENTS_KEY] = {
    [archived.id]: { note: "archived", lastTurnEndedAt: old },
    [closed.id]: { note: "closed", lastTurnEndedAt: old },
    [closedWithoutEntry.id]: { note: "closed without a register entry", lastTurnEndedAt: old },
    ghost: { note: "missing", lastTurnEndedAt: old },
  };
  ws.metadata[WORKERS_KEY] = {
    [closed.id]: entry("stale", "old", { pendingWake, lastWakeAt: old, startedAt: old }),
    ghost: entry("running", "old", { pendingWake, startedAt: old }),
  };
  const client = fakeClient(world);
  const scan = await supervise.watchdogScan(client, depsOf());
  assert.deepEqual(scan.backfilled, []);
  assert.deepEqual(scan.stale, []);
  assert.deepEqual(scan.failovers, []);
  const scope = { id: REPO, workspaceId: ws.id };
  assert.equal((await supervise.flushScope(client, scope, depsOf())).flushed, false);
  assert.equal((await supervise.sendScopeWake(client, {
    scope, events: [{ workerId: archived.id, state: "stale" }],
  }, depsOf())).sent, false);
  assert.deepEqual(sendsTo(world, steers.A.id), []);
});

test("a worker removed while the watchdog is preparing a stale event stays removed", async () => {
  const world = makeWorld();
  const { ws } = provisioned(world);
  const old = at(NOW - 90 * MIN);
  const worker = addWorker(world, ws, { updatedAt: old });
  ws.metadata[WORKERS_KEY] = { [worker.id]: entry("running", "old", { startedAt: old }) };
  const scan = await supervise.watchdogScan(fakeClient(world), depsOf({
    lock: (name, fn) => {
      delete ws.metadata[WORKERS_KEY][worker.id];
      return noLock(name, fn);
    },
  }));
  assert.deepEqual(scan.stale, []);
  assert.equal(ws.metadata[WORKERS_KEY][worker.id], undefined);
});

test("watchdog fails closed on unknown activity and refuses disabled scopes", async () => {
  const world = makeWorld();
  const { ws } = provisioned(world);
  const ghost = addWorker(world, ws, { updatedAt: "not-a-date", lastUserMessageAt: null });
  world.workspaces[0].metadata[WORKERS_KEY] = { [ghost.id]: { task: "ghost", state: "running", startedBy: "A", epoch: 3, status: null, resumes: 0, lastWakeAt: null, pendingWake: null } };
  const result = await supervise.watchdogScan(fakeClient(world), depsOf());
  assert.deepEqual(result.stale, []);
  assert.equal(world.workspaces[0].metadata[WORKERS_KEY][ghost.id].state, "running");
  const off = await supervise.watchdogScan(fakeClient(world), depsOf({ settings: settings({ enabled: false }) }));
  assert.equal(off.ran, false);
});

test("watchdog runs failover per scope unless quiet", async () => {
  const { world, steers } = unansweredWorld();
  const loud = await supervise.watchdogScan(fakeClient(world), failoverDeps(world));
  assert.equal(loud.failovers.length, 1);
  assert.equal(sendsTo(world, steers.B.id).length, 1);
  const quietBoot = await supervise.watchdogScan(fakeClient(world), depsOf({ bootCheckDone: false }));
  assert.equal(quietBoot.failovers.length, 0);
  const quietDrain = await supervise.watchdogScan(fakeClient(world), depsOf({ draining: true }));
  assert.equal(quietDrain.failovers.length, 0);
});

test("supervision timer flushes batches and scans on the watchdog cadence", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const worker = addWorker(world, ws);
  // Real clock: the timer ticks on Date.now, not the fixed test stamp.
  const past = new Date(Date.now() - 30 * MIN).toISOString();
  world.workspaces[0].metadata[WORKERS_KEY] = {
    [worker.id]: entry("done", "t", { lastWakeAt: past, pendingWake: { state: "done", queuedAt: past } }),
  };
  supervise.captureSupervisionPaseo(fakeClient(world));
  supervise.markBootCheckDone();
  let reads = 0;
  const stop = supervise.startSupervisionTimer({
    getSettings: async () => {
      reads += 1;
      return settings();
    },
    intervalMs: 5,
    lock: noLock,
    log: () => {},
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 40));
  } finally {
    stop();
  }
  assert.ok(reads >= 1, "timer reads settings");
  assert.equal(sendsTo(world, steers.A.id).length, 1, "timer flushed the due batch");
});

// ---------------------------------------------------------------------------
// Static wiring: hooks, settings, timers, core reuse, C5 rule.
// ---------------------------------------------------------------------------

const serverEntry = readFileSync(new URL("../index.server.ts", import.meta.url), "utf8");
const superviseServer = readFileSync(new URL("../server/supervise.ts", import.meta.url), "utf8");
const coldSweep = readFileSync(new URL("../server/cold-sweep.ts", import.meta.url), "utf8");

test("server entry wires supervision hooks, settings, and timers", () => {
  assert.ok(serverEntry.includes("factorySupervisionSettings"), "supervision settings registered");
  assert.ok(serverEntry.includes('registerSettings(factorySupervisionSettings)'), "settings handle kept");
  assert.ok(serverEntry.includes('"agent.create.after"'), "create.after registered");
  assert.ok(serverEntry.includes("handleCreateAfter"), "create handler wired");
  assert.ok(serverEntry.includes("handleWorkerTurnAfter"), "second turn.after handler wired");
  assert.ok(serverEntry.includes("handleBootFinished"), "post-boot step chained");
  assert.ok(serverEntry.includes("startSupervisionTimer"), "watchdog timer started");
  assert.ok(serverEntry.includes("stopSupervisionTimer"), "timer stopped on cleanup");
  assert.ok(serverEntry.includes("removeCreateHook"), "create hook removed on cleanup");
  assert.ok(serverEntry.includes("removeSuperviseHook"), "supervision hook removed on cleanup");
});

test("supervise.ts reuses the core and never archives or wakes blindly", () => {
  for (const name of [
    "turnEndEvent", "planWake", "resolveWakeTarget", "formatWakeMessage", "failoverChain",
    "updateWorkerEntry", "registerWorker", "removeWorker", "collectPendingWakes", "queuePendingWake",
    "shouldMarkStale", "openWorkers", "eventForRestartReason", "readWorkers",
    "steerWakeResponse", "hasAdvisorRequest", "formatScopeTakeover",
    "isDrainMarkerActive",
  ]) {
    assert.ok(superviseServer.includes(name), `supervise.ts uses ${name}`);
  }
  assert.ok(superviseServer.includes("deliverSteer("), "wakes and takeovers use the cache-aware delivery path");
  const deliveryServer = readFileSync(new URL("../server/steer-delivery.ts", import.meta.url), "utf8");
  assert.ok(deliveryServer.includes("markWakeSent"), "the common delivery reconciler acknowledges worker wakes");
  assert.ok(!superviseServer.includes(".archive("), "the plugin never archives (the steer does)");
  assert.ok(superviseServer.includes("background"), "background agents guarded");
  assert.ok(superviseServer.includes("ST.switchSteer"), "local failover reuses the authority switch");
  assert.ok(superviseServer.includes('source: "failover"'), "failover logged as checkpoint source");

});

test("cold sweep checks register entries before planning and applying cleanup", () => {
  assert.match(coldSweep, /isCleanupProtected\(reads\.workers\[agent\.id\]\)/);
  assert.match(coldSweep, /isCleanupProtected\(freshWorkers\[agent\.id\]\)/);
});

// ---------------------------------------------------------------------------
// ZeroSub wiring: pending moves defer, continued suppresses, exhausted waits.
// ---------------------------------------------------------------------------

const RESET_AT = at(NOW + 3 * 3_600_000);

function zsAccount(id, pct, resetsAt = RESET_AT) {
  return {
    id, family: "claude", label: id, kind: "oauth", plan: "pro",
    status: "active", isDefault: false, limitedUntil: null,
    usage: {
      fetchedAt: at(NOW - MIN),
      windows: [{ id: "five_hour", label: "5h", usedPercent: pct, resetsAt }],
      cached: false,
    },
    agentCount: 1,
  };
}

function zsRoute(agentId, accountId, pendingAccountId = null) {
  return { agentId, family: "claude", accountId, pinned: false, pendingAccountId, movable: true };
}

function zsState({ accounts, routes }) {
  return normalizeZerosubState({ accounts, agents: routes }, { now: NOW });
}

function zsSwitchData(overrides = {}) {
  return {
    family: "claude", from: "acc-old", to: "acc-new", reason: "limit", outcome: "switched",
    resetsAt: null, continued: false, continuedIn: null, toFamily: null, toProvider: null,
    detail: null, at: at(NOW - MIN), ...overrides,
  };
}

function zsSwitchEntry(data) {
  return {
    turnId: "t1",
    item: { type: "plugin", pluginId: "zerosub", kind: "zerosub-switch", version: 1, data },
  };
}

test("pending ZeroSub move defers the worker wake until the route clears or times out", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const worker = addWorker(world, ws);
  world.workspaces[0].metadata[WORKERS_KEY] = { [worker.id]: entry("running", "t") };
  const pending = () => zsState({
    accounts: [zsAccount("acc-old", 99), zsAccount("acc-new", 20)],
    routes: [zsRoute(worker.id, "acc-old", "acc-new")],
  });
  const deferred = await turnedOut(world, worker, { assistant: checkpointOf("t", "done") }, { zerosub: pending() });
  assert.equal(deferred.action, "deferred");
  assert.equal(deferred.reason, "wait-zerosub");
  assert.deepEqual(world.workspaces[0].metadata[WORKERS_KEY][worker.id].pendingWake, { state: "done", queuedAt: at(NOW) });
  assert.equal(sendsTo(world, steers.A.id).length, 0);
  // A move still pending past 10 minutes is assumed stuck: the wake goes out.
  const late = await turnedOut(
    world,
    worker,
    { assistant: checkpointOf("t", "done") },
    { zerosub: pending(), nowMs: NOW + 11 * MIN, nowIso: at(NOW + 11 * MIN) },
  );
  assert.equal(late.action, "sent");
  assert.equal(sendsTo(world, steers.A.id).length, 1);
});

test("continued switch row suppresses the factory follow-up but records the transition", async () => {
  const world = makeWorld();
  const { ws } = provisioned(world);
  const worker = addWorker(world, ws);
  world.workspaces[0].metadata[WORKERS_KEY] = { [worker.id]: entry("running", "t") };
  setTimeline(world, worker.id, [
    ...turnEntries("t1", "do it", "hit the limit, no block"),
    zsSwitchEntry({ ...zsSwitchData({ outcome: "continued", continued: true, continuedIn: { agentId: "agent-99", title: "cont." } }) }),
  ]);
  const result = await supervise.runWorkerTurnAfter(
    fakeClient(world),
    { agent: { id: worker.id, background: false }, turnId: "t1", outcome: { kind: "failed" } },
    depsOf(),
  );
  assert.equal(result.action, "skipped");
  assert.equal(result.reason, "zerosub-continued");
  assert.equal(world.workspaces[0].metadata[WORKERS_KEY][worker.id].state, "interrupted");
  assert.ok(!world.workspaces[0].metadata[WORKERS_KEY][worker.id].pendingWake, "nothing queued");
  assert.equal(world.calls.filter((c) => c[0] === "agent.send").length, 0);
});

test("continuedIn on a stayed row follows the continuation instead of failing over", async () => {
  const world = makeWorld();
  const { ws } = provisioned(world);
  const worker = addWorker(world, ws);
  world.workspaces[0].metadata[WORKERS_KEY] = { [worker.id]: entry("running", "t") };
  setTimeline(world, worker.id, [
    ...turnEntries("t1", "do it", "hit the limit, no block"),
    zsSwitchEntry(zsSwitchData({
      reason: "exhausted", outcome: "stayed", resetsAt: RESET_AT, continued: false,
      continuedIn: { agentId: "agent-99", title: "cont." },
    })),
  ]);
  const result = await supervise.runWorkerTurnAfter(
    fakeClient(world),
    { agent: { id: worker.id, background: false }, turnId: "t1", outcome: { kind: "failed" } },
    depsOf(),
  );
  assert.equal(result.action, "skipped");
  assert.equal(result.reason, "zerosub-continued");
  assert.equal(world.calls.filter((c) => c[0] === "agent.send").length, 0);
});

test("model-specific quota leaves a healthy standby on the same account eligible", async () => {
  const { world, ws, steers } = unansweredWorld();
  steers.A.model = "limited-model";
  steers.B.model = "healthy-model";
  steers.C.archivedAt = at(NOW - MIN);
  const account = { id: "shared", family: "codex", sampledAt: at(NOW), windows: [
    { id: "limited", models: [steers.A.model], usedPct: 100, resetsAt: RESET_AT },
    { id: "healthy", models: [steers.B.model], usedPct: 20, resetsAt: RESET_AT },
  ] };
  const zerosub = { accounts: [account], agentAccount: {
    [steers.A.id]: account.id, [steers.B.id]: account.id,
  }, pending: {} };
  const result = await supervise.runFailoverCheck(fakeClient(world), { id: REPO, workspaceId: ws.id },
    failoverDeps(world, { zerosub, force: true, quotaTrigger: { accountId: account.id } }));
  assert.equal(result.action, "failover");
  assert.equal(ws.metadata[METADATA_KEY].activeAgentId, steers.B.id);
  assert.equal(sendsTo(world, steers.A.id).length, 0);
  assert.equal(sendsTo(world, steers.B.id).length, 1);
});

test("failover waits for a standby's pending account move to settle", async () => {
  const { world, ws, steers } = unansweredWorld();
  steers.A.provider = steers.B.provider = "claude";
  steers.C.archivedAt = at(NOW - MIN);
  const pending = zsState({
    accounts: [zsAccount("acc-full", 99), zsAccount("acc-roomy", 20)],
    routes: [zsRoute(steers.A.id, "acc-full"), zsRoute(steers.B.id, "acc-roomy", "acc-full")],
  });
  const ready = { ...pending, pending: {}, agentAccount: { ...pending.agentAccount, [steers.B.id]: "acc-roomy" } };
  const scope = { id: REPO, workspaceId: ws.id };
  const paseo = fakeClient(world);
  const waiting = await supervise.runFailoverCheck(paseo, scope, failoverDeps(world, { zerosub: pending }));
  assert.equal(waiting.action, "none");
  assert.equal(ws.metadata[METADATA_KEY].epoch, 3);
  assert.equal(sendsTo(world, steers.B.id).length, 0);
  const applied = await supervise.runFailoverCheck(paseo, scope, failoverDeps(world, { zerosub: ready }));
  assert.equal(applied.action, "failover");
  assert.equal(ws.metadata[METADATA_KEY].activeAgentId, steers.B.id);
  assert.equal(sendsTo(world, steers.B.id).length, 1);
});

test("a quota-triggered takeover waits when the bound account loses its usage reading", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const worker = addWorker(world, ws);
  ws.metadata[WORKERS_KEY] = { [worker.id]: entry("running", "t") };
  const limited = { id: "source", family: "codex", status: "limited", exhausted: true };
  const unknown = { id: "source", family: "codex", status: "ready", windows: [] };
  let reads = 0;
  const result = await turnedOut(world, worker, { assistant: checkpointOf("t", "done") }, {
    getZerosub: async () => ({ agentAccount: { [steers.A.id]: "source" }, pending: {},
      accounts: [++reads === 1 ? limited : unknown] }),
  });
  assert.equal(result.action, "queued");
  assert.equal(result.reason, "quota-limit-unconfirmed");
  assert.equal(world.calls.some(([kind]) => kind === "agent.send"), false);
  assert.ok(ws.metadata[WORKERS_KEY][worker.id].pendingWake);
  assert.equal(ws.metadata[METADATA_KEY].epoch, 3);
});

test("a worker result wakes the active API steer when a sibling subscription is exhausted", async () => {
  const { sampleQuotaAsync, getQuotaSampledAt, resetQuotaForTests } = await import("../server/quota.ts");
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const worker = addWorker(world, ws);
  ws.metadata[WORKERS_KEY] = { [worker.id]: entry("running", "t") };
  const zerosub = { agentAccount: { [steers.A.id]: "api" }, pending: {},
    accounts: [{ id: "api", family: "codex", auth: "api", status: "ready", windows: [] }] };
  try {
    await sampleQuotaAsync(() => JSON.stringify([{ sourceId: "codex", report: {
      windows: [{ id: "session", usedPct: 0 }, { id: "weekly", usedPct: 100 }],
    } }]));
    const nowMs = getQuotaSampledAt();
    const result = await turnedOut(world, worker, { assistant: checkpointOf("t", "done") },
      { getZerosub: async () => zerosub, nowMs, nowIso: at(nowMs) });
    assert.equal(result.action, "sent");
    assert.equal(sendsTo(world, steers.A.id).length, 1);
    assert.equal(sendsTo(world, steers.B.id).length, 0);
    assert.equal(ws.metadata[METADATA_KEY].epoch, 3);
  } finally {
    resetQuotaForTests();
  }
});

test("all accounts exhausted holds the wake until the earliest reset", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  steers.A.provider = "claude";
  steers.B.archivedAt = at(NOW - MIN);
  steers.C.archivedAt = at(NOW - MIN);
  const worker = addWorker(world, ws);
  world.workspaces[0].metadata[WORKERS_KEY] = { [worker.id]: entry("running", "t") };
  const exhausted = zsState({ accounts: [zsAccount("acc-a", 99), zsAccount("acc-b", 95)], routes: [zsRoute(steers.A.id, "acc-a")] });
  const queued = await turnedOut(world, worker, { assistant: checkpointOf("t", "done") }, { zerosub: exhausted });
  assert.equal(queued.action, "queued");
  assert.equal(queued.reason, "wait-reset");
  assert.equal(sendsTo(world, steers.A.id).length, 0);
  assert.ok(world.workspaces[0].metadata[WORKERS_KEY][worker.id].pendingWake, "news held, not dropped");
  // After the reset, with room again, the flush delivers the held wake.
  const roomy = normalizeZerosubState(
    { accounts: [zsAccount("acc-a", 20)], agents: [] },
    { now: NOW + 4 * 3_600_000 },
  );
  const flushed = await supervise.flushScope(
    fakeClient(world),
    { id: REPO, workspaceId: ws.id },
    depsOf({ zerosub: roomy, nowMs: NOW + 4 * 3_600_000, nowIso: at(NOW + 4 * 3_600_000) }),
  );
  assert.equal(flushed.flushed, true);
  assert.equal(sendsTo(world, steers.A.id).length, 1);
});

test("wake text keeps the actionable fork note and omits routine quota", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  steers.A.provider = "claude";
  const config = {
    profiles: { sol: { provider: "codex", model: "sol" } },
    steers: { slots: { A: "sol", B: "sol", C: "sol" } },
    quota: { warnPct: 75, exhaustedPct: 90 },
  };
  const worker = addWorker(world, ws);
  world.workspaces[0].metadata[WORKERS_KEY] = { [worker.id]: entry("running", "t") };
  const zerosub = zsState({
    accounts: [zsAccount("acc-old", 99), zsAccount("acc-live", 80), zsAccount("acc-new", 20)],
    routes: [zsRoute(worker.id, "acc-old"), zsRoute(steers.A.id, "acc-live")],
  });
  setTimeline(world, worker.id, [
    ...turnEntries("t1", "do it", checkpointOf("t", "done")),
    zsSwitchEntry(zsSwitchData({ outcome: "switched", toFamily: "codex" })),
  ]);
  const result = await supervise.runWorkerTurnAfter(
    fakeClient(world),
    { agent: { id: worker.id, background: false }, turnId: "t1", outcome: { kind: "completed" } },
    depsOf({ zerosub, getConfig: async () => config }),
  );
  assert.equal(result.action, "sent");
  const texts = sendsTo(world, steers.A.id);
  assert.equal(texts.length, 1);
  assert.doesNotMatch(texts[0], /^Quota:/m);
  assert.match(texts[0], /fork to other provider/);
});

test("wake omits quota when the live holder has a bound account without metrics", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  steers.A.provider = "claude";
  const worker = addWorker(world, ws);
  world.workspaces[0].metadata[WORKERS_KEY] = { [worker.id]: entry("running", "t") };
  const zerosub = zsState({
    accounts: [zsAccount("acc-other", 99), zsAccount("acc-live", null)],
    routes: [zsRoute(steers.A.id, "acc-live")],
  });
  const result = await turnedOut(world, worker, { assistant: checkpointOf("t", "done") }, { zerosub });
  assert.equal(result.action, "sent");
  const texts = sendsTo(world, steers.A.id);
  assert.equal(texts.length, 1);
  assert.doesNotMatch(texts[0], /^Quota:/m);
});

test("depleted accounts with no binding to the active steer cannot stall its wake", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const worker = addWorker(world, ws);
  ws.metadata[WORKERS_KEY] = { [worker.id]: entry("running", "Unbound route") };
  const zerosub = zsState({ accounts: [zsAccount("other", 99)], routes: [] });
  const result = await turnedOut(world, worker, { assistant: checkpointOf("Unbound route", "done") }, { zerosub });
  assert.equal(result.action, "sent");
  assert.equal(sendsTo(world, steers.A.id).length, 1);
});

test("a lone active steer gets its queued wake once a newer same-route success beats an old shared limit", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const active = steers.A;
  steers.B.archivedAt = at(NOW - MIN);
  steers.C.archivedAt = at(NOW - MIN);
  active.provider = "claude-api";
  active.model = "proxy-model";
  active.metadata = { "zerosub.account": "api" };
  active.persistence = { sessionId: "current-session" };
  const previous = at(NOW - 2 * MIN);
  addWorkspace(world, { metadata: { [AGENTS_KEY]: { other: {
    quotaLimit: { provider: active.provider, model: active.model, accountId: "api", at: previous, resetAt: null },
  } } } });
  const worker = addWorker(world, ws);
  ws.metadata[WORKERS_KEY] = { [worker.id]: entry("running", "Parser checks") };
  const zerosub = { accounts: [{ id: "api", family: "claude-api", auth: "api", status: "ready", windows: [] }],
    agentAccount: { [active.id]: "api" }, pending: {} };
  const delivery = { keepChatHistory: async () => true };
  const deps = depsOf({ zerosub, delivery });
  const scope = { id: REPO, workspaceId: ws.id };
  const turn = await turnedOut(world, worker, { assistant: checkpointOf("Parser checks", "done") }, { zerosub, delivery });
  assert.equal(turn.reason, "wait-quota");
  assert.deepEqual(sendsTo(world, active.id), []);
  assert.ok(ws.metadata[WORKERS_KEY][worker.id].pendingWake);

  const successAt = at(NOW - MIN);
  ws.metadata[AGENTS_KEY] = { [active.id]: {
    lastTurnId: "ok", lastTurnEndedAt: successAt, outcome: "completed",
    settingsBaseline: { provider: active.provider, model: active.model, sessionId: active.persistence.sessionId, turnId: "ok", at: successAt },
  } };
  active.status = "running";
  assert.equal((await supervise.flushScope(fakeClient(world), scope, deps)).reason, "target-busy");
  assert.ok(ws.metadata[WORKERS_KEY][worker.id].pendingWake);
  active.status = "idle";
  assert.equal((await supervise.flushScope(fakeClient(world), scope, deps)).flushed, true);
  assert.equal(ws.metadata[WORKERS_KEY][worker.id].pendingWake, null);
  assert.match(sendsTo(world, active.id)[0], /Parser checks.*result reported/);
  assert.equal(sendsTo(world, active.id).length, 1);
});

test("failover waits on the holder's pending move, then proceeds past the timeout", async () => {
  const { world, ws, steers } = unansweredWorld();
  const scope = { id: REPO, workspaceId: ws.id };
  const pending = () => zsState({
    accounts: [zsAccount("acc-old", 99), zsAccount("acc-new", 20)],
    routes: [
      zsRoute(steers.A.id, "acc-old", "acc-new"),
      zsRoute(steers.B.id, "acc-new"),
      zsRoute(steers.C.id, "acc-new"),
    ],
  });
  const waited = await supervise.runFailoverCheck(fakeClient(world), scope, depsOf({ zerosub: pending() }));
  assert.equal(waited.action, "wait");
  assert.equal(waited.reason, "wait-zerosub");
  assert.equal(world.calls.filter((c) => c[0] === "agent.send").length, 0);
  const later = await supervise.runFailoverCheck(
    fakeClient(world),
    scope,
    failoverDeps(world, { zerosub: pending(), nowMs: NOW + 11 * MIN, nowIso: at(NOW + 11 * MIN) }),
  );
  assert.equal(later.action, "failover");
  assert.equal(later.to.slot, "B");
});

test("failover stands down when ZeroSub continued the holder", async () => {
  const { world, ws, steers } = unansweredWorld();
  setTimeline(world, steers.A.id, [
    zsSwitchEntry(zsSwitchData({ outcome: "continued", continued: true, continuedIn: { agentId: "agent-9", title: "x" } })),
  ]);
  const result = await supervise.runFailoverCheck(fakeClient(world), { id: REPO, workspaceId: ws.id }, depsOf());
  assert.equal(result.action, "clear");
  assert.equal(result.reason, "zerosub-continued");
  assert.equal(world.calls.filter((c) => c[0] === "agent.send").length, 0);
});

test("failover with no candidates waits for the exhausted+stayed reset", async () => {
  const { world, ws, steers } = unansweredWorld();
  for (const id of [steers.B.id, steers.C.id]) {
    world.agents.find((a) => a.id === id).archivedAt = at(NOW - MIN);
  }
  setTimeline(world, steers.A.id, [
    zsSwitchEntry(zsSwitchData({ reason: "exhausted", outcome: "stayed", resetsAt: RESET_AT })),
  ]);
  const scope = { id: REPO, workspaceId: ws.id };
  const waited = await supervise.runFailoverCheck(fakeClient(world), scope, depsOf());
  assert.equal(waited.action, "wait");
  assert.equal(waited.reason, "wait-reset");
  assert.equal(waited.wakeAt, RESET_AT);
  setTimeline(world, steers.A.id, []);
  const legacy = await supervise.runFailoverCheck(fakeClient(world), scope, depsOf());
  assert.equal(legacy.action, "none");
  assert.equal(legacy.reason, "no-candidates");
});

test("failover skips steers on the exhausted failing account", async () => {
  const { world, ws, steers } = unansweredWorld();
  const zerosub = zsState({
    accounts: [zsAccount("acc-full", 99), zsAccount("acc-roomy", 20)],
    routes: [
      zsRoute(steers.A.id, "acc-full"),
      zsRoute(steers.B.id, "acc-full"),
      zsRoute(steers.C.id, "acc-roomy"),
    ],
  });
  const result = await supervise.runFailoverCheck(
    fakeClient(world),
    { id: REPO, workspaceId: ws.id },
    failoverDeps(world, { zerosub }),
  );
  assert.equal(result.action, "failover");
  assert.equal(result.to.slot, "C", "B shares the exhausted account with A");
});

test("boot finished queues post-boot wakes while all accounts are exhausted", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  steers.A.provider = "claude";
  steers.B.archivedAt = at(NOW - MIN);
  steers.C.archivedAt = at(NOW - MIN);
  const worker = addWorker(world, ws);
  world.workspaces[0].metadata[WORKERS_KEY] = { [worker.id]: entry("running", "t") };
  const exhausted = zsState({ accounts: [zsAccount("acc-a", 99), zsAccount("acc-b", 95)], routes: [zsRoute(steers.A.id, "acc-a")] });
  const result = await supervise.runBootFinished(
    fakeClient(world),
    [{ agentId: worker.id, scopeId: REPO }],
    depsOf({ zerosub: exhausted }),
  );
  assert.deepEqual(result.marked, [worker.id]);
  assert.equal(result.wakes.length, 1);
  assert.equal(result.wakes[0].sent, false);
  assert.equal(result.wakes[0].reason, "wait-reset");
  assert.equal(sendsTo(world, steers.A.id).length, 0);
  assert.ok(world.workspaces[0].metadata[WORKERS_KEY][worker.id].pendingWake, "interrupted news queued");
});
