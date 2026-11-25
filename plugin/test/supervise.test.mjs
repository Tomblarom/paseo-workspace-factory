// Worker supervision plugin side (S-B): shared decisions plus the server wiring
// (registration, turn transitions, wakes, batching, quiet periods, watchdog,
// failover) against a fake Paseo client. Server modules load through the
// ts-resolve-hooks remap (.js specifiers to .ts sources); core register rules
// stay in src/ and are reused, never reimplemented.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";

register("./ts-resolve-hooks.mjs", import.meta.url);

const supervise = await import("../server/supervise.ts");
const { LockBusy } = await import("../server/factory/lock.ts");
// Shared modules import the generated defaults through `.js` specifiers, so
// they must load dynamically after the resolve hook is registered.
const {
  DRAIN_METADATA_KEY,
  SUPERVISION_SETTINGS_DEFAULTS,
  WORKER_METADATA_KEY,
  archiveHintLine,
  buildWorkerMetadata,
  escalationHintLine,
  firstUserText,
  formatScopeTakeover,
  formatSteerTakeover,
  hasAdvisorRequest,
  isDrainMarkerActive,
  isWorkerMetadata,
  maxStampMs,
  scopeLastWakeAt,
  selectDoneIds,
  steerWakeResponse,
  withArchiveHint,
} = await import("../shared/supervise.ts");
const { factorySupervisionSettings } = await import("../shared/settings.ts");
import { LABEL, METADATA_KEY, readPaseoState } from "../../src/paseo.mjs";
import { WORKERS_KEY } from "../../src/supervision.mjs";
import { AGENTS_KEY } from "../../src/agent-state.mjs";
import { CHECKPOINT_KEY, SwitchRefused, switchSteer } from "../../src/steer.mjs";
import { normalizeZerosubState } from "../../src/zerosub.mjs";

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

test("archive hint lists done workers and caps the list", () => {
  assert.equal(archiveHintLine([]), null);
  const line = archiveHintLine(["w-2", "w-1"]);
  assert.match(line, /w-1, w-2/);
  assert.match(line, /`paseo archive <id>`/);
  assert.match(line, /never archive running, blocked or interrupted/);
  const many = archiveHintLine(["w-1", "w-2", "w-3", "w-4", "w-5", "w-6", "w-7"]);
  assert.match(many, /\(\+2 more\)/);
  assert.equal(withArchiveHint("base", []), "base");
  assert.equal(withArchiveHint("base", ["w-1"]), `base\n${archiveHintLine(["w-1"])}`);
  assert.deepEqual(selectDoneIds({ "w-b": entry("done"), "w-a": entry("running"), "w-c": entry("done"), "w-d": null }), ["w-b", "w-c"]);
  assert.deepEqual(selectDoneIds(null), []);
});

test("escalation hint points past-maxAutoResumes workers at an advisor", () => {
  assert.equal(escalationHintLine([]), null);
  const line = escalationHintLine([{ id: "w-2", resumes: 3 }, { id: "w-1", resumes: 2 }]);
  assert.match(line, /w-1 \(x2\), w-2 \(x3\)/);
  assert.match(line, /paseo-advisor skill/);
  assert.match(line, /domain:\/hub: blockers/);
  assert.match(line, /user: only as the last step/);
});

test("steer takeover text carries the epoch-checked switch", () => {
  const text = formatSteerTakeover({
    scopeId: REPO, epoch: 4, activeSlot: "A", candidateSlot: "B",
    reason: "no answer within 10m", openWorkers: [{ id: "w-1", state: "blocked" }],
  });
  assert.match(text, new RegExp(`\\[factory\\] Scope ${REPO.replace(/[./-]/g, (c) => `\\${c}`)}, epoch 4`));
  assert.match(text, /Steer A is not answering \(no answer within 10m\)/);
  assert.match(text, new RegExp(`\`paseo-factory switch ${REPO.replace(/[./-]/g, (c) => `\\${c}`)} --to B --apply\``));
  assert.match(text, /if it is refused, stop/);
  assert.match(text, /Open workers: w-1 blocked/);
  assert.match(text, /`paseo-factory resume`/);
  assert.match(text, /Ignore if your epoch is newer/);
  const custom = formatSteerTakeover({
    scopeId: "s", epoch: 1, activeSlot: "A", candidateSlot: "C", reason: "x", openWorkers: [], factoryCmd: "wf",
  });
  assert.match(custom, /`wf switch s --to C --apply`/);
  assert.match(custom, /Open workers: none recorded/);
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
    ["missing", "looks done, no block", "completed", "turn-no-checkpoint", "interrupted", null],
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
  assert.equal(outcome.reason, "send-failed");
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
  assert.match(texts[0], new RegExp(`worker ${done.id} done`));
  assert.match(texts[0], /Run `paseo-factory resume`/);
  assert.match(texts[0], /Archive accepted workers/);
  assert.ok(!texts[0].includes(blocked.id));
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
  assert.match(sendsTo(world, steers.B.id)[0], /epoch 4/);
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
  assert.match(texts[0], new RegExp(`worker ${duringBoot.id} blocked`));
  assert.match(texts[0], new RegExp(`worker ${duringDrain.id} done`));
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

test("watchdog skips failover while the drain marker is live", async () => {
  const { world, steers } = unansweredWorld();
  world.workspaces[0].metadata[DRAIN_METADATA_KEY] = drainMarker(at(NOW + 10 * MIN));
  const quiet = await supervise.watchdogScan(fakeClient(world), depsOf());
  assert.equal(quiet.failovers.length, 0);
  assert.equal(sendsTo(world, steers.B.id).length, 0);
  world.workspaces[0].metadata[DRAIN_METADATA_KEY] = drainMarker(at(NOW - 2 * MIN));
  const loud = await supervise.watchdogScan(fakeClient(world), depsOf());
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
  assert.match(texts[0], new RegExp(`Continued without progress \\(${stuck.id} \\(x2\\)\\)`));
  assert.match(texts[0], /paseo-advisor skill/);
  assert.ok(!texts[0].includes(fresh.id), "workers below the threshold stay out of the hint");
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
  assert.match(texts[0], new RegExp(`worker ${calm.id} done`));
  assert.match(texts[0], new RegExp(`worker ${urgent.id} blocked`));
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
  assert.match(texts[0], new RegExp(`worker ${w1.id} interrupted`));
  assert.match(texts[0], new RegExp(`worker ${w3.id} interrupted`));
  assert.ok(!texts[0].includes(w2.id), "blocked workers are not in the interrupted wake");
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

test("unanswered wake fails over to the next slot and logs the takeover", async () => {
  const { world, ws, steers, worker } = unansweredWorld();
  const paseo = fakeClient(world);
  const scope = { id: REPO, workspaceId: ws.id };
  const result = await supervise.runFailoverCheck(paseo, scope, depsOf());
  assert.equal(result.action, "failover");
  assert.deepEqual(result.to, { kind: "steer", slot: "B", steerId: steers.B.id });
  assert.equal(result.logged, true);
  const texts = sendsTo(world, steers.B.id);
  assert.equal(texts.length, 1);
  assert.match(texts[0], new RegExp(`switch ${REPO.replace(/[./-]/g, (c) => `\\${c}`)} --to B --apply`));
  assert.match(texts[0], /no answer within 10m/);
  const checkpoint = world.workspaces[0].metadata[CHECKPOINT_KEY];
  assert.equal(checkpoint.source, "failover");
  assert.deepEqual(checkpoint.failover, { previousSteer: "A", reason: "no answer within 10m" });
  assert.equal(checkpoint.task, "ship it", "task preserved");
  const bumped = world.workspaces[0].metadata[WORKERS_KEY][worker.id].lastWakeAt;
  assert.equal(bumped, at(NOW));
  assert.deepEqual(supervise.failoverStateForTests()[REPO].asked, [steers.B.id]);
});

test("a cold takeover starts its answer window only after the renewed brief is sent", async () => {
  const { world, ws, steers, worker } = unansweredWorld();
  steers.B.provider = "claude";
  steers.B.persistence = { sessionId: "old-session" };
  ws.metadata[AGENTS_KEY][steers.B.id] = { lastTurnEndedAt: at(NOW - 6 * MIN) };
  const paseo = fakeClient(world);
  const scope = { id: REPO, workspaceId: ws.id };
  const deps = depsOf({ buildBrief: async () => "Takeover checkpoint" });
  const outcome = await supervise.runFailoverCheck(paseo, scope, deps);
  assert.deepEqual(outcome, { action: "wait", reason: "brief-pending" });
  assert.deepEqual(sendsTo(world, steers.B.id), ["/clear"]);
  assert.equal(ws.metadata[WORKERS_KEY][worker.id].lastWakeAt, at(NOW - 11 * MIN));
  assert.equal(supervise.failoverStateForTests()[REPO], undefined);
  assert.equal((await supervise.retryPendingWakeBrief(paseo, scope, deps)).delivered, false);

  // The verified clear is recorded by the turn hook, covered in wake-brief.test.
  const entry = ws.metadata[AGENTS_KEY][steers.B.id];
  entry.pendingAction = null;
  steers.B.persistence.sessionId = "new-session";
  entry.cleared = { mode: "clear", sessionId: "new-session" };
  entry.actionVerified = true;
  entry.pendingWakeBrief.phase = "ready";
  assert.equal((await supervise.retryPendingWakeBrief(paseo, scope, deps)).delivered, true);
  assert.equal(sendsTo(world, steers.B.id).length, 2);
  assert.match(sendsTo(world, steers.B.id)[1], /\[Factory resume\]\nTakeover checkpoint/);
  assert.equal(ws.metadata[CHECKPOINT_KEY].source, "failover");
  assert.equal(ws.metadata[WORKERS_KEY][worker.id].lastWakeAt, at(NOW));
  assert.deepEqual(supervise.failoverStateForTests()[REPO].asked, [steers.B.id]);
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

test("failover walks B, C, domain, hub, then cycles", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world, { checkpoint: { task: "ship it", tests: [], blockers: [], next: null } });
  const worker = addWorker(world, ws);
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
  assert.deepEqual((await supervise.runFailoverCheck(paseo, scope, step(0))).to, { kind: "steer", slot: "B", steerId: steers.B.id });
  assert.deepEqual((await supervise.runFailoverCheck(paseo, scope, step(11))).to, { kind: "steer", slot: "C", steerId: steers.C.id });
  const domain = await supervise.runFailoverCheck(paseo, scope, step(22));
  assert.deepEqual(domain.to, { kind: "domain", steerId: domainSteer.id, scopeId: "shop" });
  assert.match(sendsTo(world, domainSteer.id)[0], /As the domain steer/);
  const hub = await supervise.runFailoverCheck(paseo, scope, step(33));
  assert.deepEqual(hub.to, { kind: "hub", steerId: hubSteer.id, scopeId: "hub" });
  assert.match(sendsTo(world, hubSteer.id)[0], /As the hub steer/);
  const cycle = await supervise.runFailoverCheck(paseo, scope, step(44));
  assert.deepEqual(cycle.to, { kind: "steer", slot: "B", steerId: steers.B.id });
});

test("failover follows a switch and clears when nothing is open", async () => {
  const { world, ws, worker } = unansweredWorld();
  const paseo = fakeClient(world);
  const scope = { id: REPO, workspaceId: ws.id };
  world.workspaces[0].metadata[METADATA_KEY].epoch = 4;
  world.workspaces[0].metadata[METADATA_KEY].activeSteer = "B";
  const moved = await supervise.runFailoverCheck(paseo, scope, depsOf());
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
    const result = await supervise.watchdogScan(fakeClient(world), depsOf());
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

test("turn backfills adopted workers and queues without a live holder", async () => {
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
  const lonely = addWorker(world, ws);
  world.workspaces[0].metadata[WORKERS_KEY][lonely.id] = entry("running", "lonely");
  const queued = await turnedOut(world, lonely, { assistant: checkpointOf("l", "blocked") }, { settings: settings({ wakeDebounceSeconds: 0 }) });
  assert.equal(queued.action, "queued");
  assert.equal(queued.reason, "no-target");
  assert.ok(sendsTo(world, steers.A.id).length >= 1, "earlier wake still delivered");
});

// ---------------------------------------------------------------------------
// Watchdog: backfill, retire, reconcile, stale, failover per scope.
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
  const loud = await supervise.watchdogScan(fakeClient(world), depsOf());
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
const idleCleanup = readFileSync(new URL("../shared/idle-cleanup.ts", import.meta.url), "utf8");

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
    "markWakeSent", "shouldMarkStale", "openWorkers", "eventForRestartReason", "readWorkers",
    "steerWakeResponse", "hasAdvisorRequest", "formatSteerTakeover", "formatScopeTakeover",
    "escalationHintLine", "isDrainMarkerActive",
  ]) {
    assert.ok(superviseServer.includes(name), `supervise.ts uses ${name}`);
  }
  assert.ok(superviseServer.includes("deliverSteer("), "wakes and takeovers use the cache-aware delivery path");
  assert.ok(!superviseServer.includes(".archive("), "the plugin never archives (the steer does)");
  assert.ok(superviseServer.includes("background"), "background agents guarded");
  assert.ok(superviseServer.includes("formatSteerTakeover"), "takeover request sent on failover");
  assert.ok(superviseServer.includes('source: "failover"'), "failover logged as checkpoint source");
  const sharedServer = readFileSync(new URL("../shared/supervise.ts", import.meta.url), "utf8");
  assert.ok(sharedServer.includes("Take over with"), "takeover request text defined");
  assert.ok(sharedServer.includes("--to ${args.candidateSlot} --apply"), "takeover text carries the switch");
  assert.ok(sharedServer.includes("Archive accepted workers"), "archive hint text defined");
});

test("cold sweep feeds the register state into the C5 skip rule", () => {
  assert.ok(coldSweep.includes("WORKERS_KEY"), "sweep reads wsf.workers");
  assert.ok(coldSweep.includes("workerState"), "register state passed into cleanupInputOf");
  assert.ok(idleCleanup.includes("isSupervisionProtectedState"), "C5 skip rule exported");
  assert.match(idleCleanup, /state === "running" \|\| state === "blocked" \|\| state === "interrupted"/);
  assert.ok(idleCleanup.includes("the steer has not seen it yet"), "skip reason names the steer");
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

test("all accounts exhausted holds the wake until the earliest reset", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const worker = addWorker(world, ws);
  world.workspaces[0].metadata[WORKERS_KEY] = { [worker.id]: entry("running", "t") };
  const exhausted = zsState({ accounts: [zsAccount("acc-a", 99), zsAccount("acc-b", 95)], routes: [] });
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

test("wake text carries the ZeroSub quota line and fork warnings", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const config = {
    profiles: { sonnet: { provider: "claude", model: "s" } },
    steers: { slots: { A: "sonnet", B: "sonnet", C: "sonnet" } },
    quota: { warnPct: 75, exhaustedPct: 90 },
  };
  const worker = addWorker(world, ws);
  world.workspaces[0].metadata[WORKERS_KEY] = { [worker.id]: entry("running", "t") };
  const zerosub = zsState({
    accounts: [zsAccount("acc-old", 99), zsAccount("acc-new", 20)],
    routes: [zsRoute(worker.id, "acc-old")],
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
  assert.match(texts[0], /Quota: claude 99% \(5h\) — prefer acc-new/);
  assert.match(texts[0], /fork to other provider/);
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
    depsOf({ zerosub: pending(), nowMs: NOW + 11 * MIN, nowIso: at(NOW + 11 * MIN) }),
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
    depsOf({ zerosub }),
  );
  assert.equal(result.action, "failover");
  assert.equal(result.to.slot, "C", "B shares the exhausted account with A");
});

test("proactive hint fires at warnPct with room elsewhere, else stays quiet", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const paseoState = await readPaseoState(fakeClient(world));
  const scope = { id: REPO, workspaceId: ws.id };
  const wsf = world.workspaces[0].metadata[METADATA_KEY];
  const config = {
    profiles: { sonnet: { provider: "claude", model: "s" } },
    steers: { slots: { A: "sonnet", B: "sonnet", C: "sonnet" } },
    quota: { warnPct: 75, exhaustedPct: 90 },
  };
  const decide = (zerosub) => supervise.proactiveHintDecision({
    paseoState, scope, wsf, agentState: {}, config,
    agentId: steers.A.id, zerosub, nowMs: NOW, warnPct: 75, exhaustedPct: 90,
  });
  const routes = (pendingA = null) => [
    zsRoute(steers.A.id, "acc-a", pendingA),
    zsRoute(steers.B.id, "acc-b"),
    zsRoute(steers.C.id, "acc-b"),
  ];
  const hint = decide(zsState({ accounts: [zsAccount("acc-a", 80), zsAccount("acc-b", 20)], routes: routes() }));
  assert.equal(hint.decision, "hint");
  assert.equal(hint.to.slot, "B");
  assert.equal(hint.accountId, "acc-a");
  assert.equal(hint.usedPct, 80);
  assert.match(hint.text, /Account acc-a is at 80% of its window \(warn 75%\)/);
  assert.match(hint.text, new RegExp(`switch ${REPO.replace(/[./-]/g, (c) => `\\${c}`)} --to B --apply`));
  assert.equal(decide(null).decision, "skip");
  assert.equal(decide(null).reason, "no-zerosub");
  const calm = decide(zsState({ accounts: [zsAccount("acc-a", 74), zsAccount("acc-b", 20)], routes: routes() }));
  assert.equal(calm.decision, "skip");
  assert.equal(calm.reason, "below-warn");
  const moving = decide(zsState({ accounts: [zsAccount("acc-a", 80), zsAccount("acc-b", 20)], routes: routes("acc-b") }));
  assert.equal(moving.decision, "skip");
  assert.equal(moving.reason, "zerosub-move-pending");
  const full = decide(zsState({ accounts: [zsAccount("acc-a", 80), zsAccount("acc-b", 99)], routes: routes() }));
  assert.equal(full.decision, "skip");
  assert.equal(full.reason, "no-candidate-with-room");
});

test("boot finished queues post-boot wakes while all accounts are exhausted", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const worker = addWorker(world, ws);
  world.workspaces[0].metadata[WORKERS_KEY] = { [worker.id]: entry("running", "t") };
  const exhausted = zsState({ accounts: [zsAccount("acc-a", 99), zsAccount("acc-b", 95)], routes: [] });
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
