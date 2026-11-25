// needsResume flags (E4): limit patterns, failed-turn classification, boot
// check flags for closed/interrupted steers, the attention feed rows, and the
// F4 wake-to-resume wiring. Server modules load through the
// ts-resolve-hooks remap; static assertions pin the turn-hook wiring the way
// plugin/test/boot-check.test.mjs does.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { register } from "node:module";

register("./ts-resolve-hooks.mjs", import.meta.url);

const bootCheck = await import("../server/boot-check.ts");
const sweep = await import("../server/cold-sweep.ts");
const supervise = await import("../server/supervise.ts");
const {
  CLEANUP_DEFAULTS,
  RESUME_LIMIT_PATTERNS,
  bootResumeReason,
  isLimitFailure,
  isNeedsResumeReason,
  needsResumeForFailedTurn,
  countActiveResumeRows,
  resumeReminderText,
} = await import("../shared/idle-cleanup.ts");
// Shared modules import the generated defaults through `.js` specifiers, so
// they must load dynamically after the resolve hook is registered.
const { factoryResumeSettings } = await import("../shared/settings.ts");
import { LABEL, METADATA_KEY } from "../../src/paseo.mjs";
import { AGENTS_KEY } from "../../src/agent-state.mjs";
import { WORKERS_KEY } from "../../src/supervision.mjs";
import { CHECKPOINT_KEY } from "../../src/steer.mjs";

const REPO = "example-owner/example-repo";
const NOW = new Date("2026-11-24T12:00:00.000Z").getTime();
const at = (ms) => new Date(ms).toISOString();
const MIN = 60_000;
const HOUR = 3_600_000;

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
    createdAt: at(NOW - 24 * HOUR),
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

function scopeMeta({ activeSteer = "A", epoch = 3, workers = {}, agents = {}, checkpoint = null } = {}) {
  const meta = {
    [METADATA_KEY]: { main: true, activeSteer, epoch, scope: { id: REPO, kind: "github", locator: REPO } },
  };
  if (Object.keys(workers).length) meta[WORKERS_KEY] = structuredClone(workers);
  if (Object.keys(agents).length) meta[AGENTS_KEY] = structuredClone(agents);
  if (checkpoint) meta[CHECKPOINT_KEY] = structuredClone(checkpoint);
  return meta;
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
const sendsTo = (world, id) =>
  world.calls.filter((c) => c[0] === "agent.send" && c[1] === id).map((c) => c[2]);

// ---------------------------------------------------------------------------
// Limit patterns and failed-turn classification (pure).
// ---------------------------------------------------------------------------

test("RESUME_LIMIT_PATTERNS matches limit/quota failures only", () => {
  assert.ok(Array.isArray(RESUME_LIMIT_PATTERNS) && RESUME_LIMIT_PATTERNS.length > 0);
  for (const pattern of RESUME_LIMIT_PATTERNS) assert.ok(pattern instanceof RegExp);
  for (const text of [
    "Claude usage limit reached, resets 3pm",
    "Usage Limit hit for claude-sonnet",
    "ERROR: rate limit exceeded, retry later",
    "RateLimit: too many requests",
    "quota exceeded for this project",
    "API quota reset in 10 minutes",
    "request failed with HTTP 429",
    "Limit reached: daily budget spent",
  ]) {
    assert.equal(isLimitFailure(text), true, text);
  }
  for (const text of [null, undefined, "", "turn failed: exit 1", "context window exceeded", "model overloaded, retry", "canceled by user"]) {
    assert.equal(isLimitFailure(text), false, String(text));
  }
});

test("needsResumeForFailedTurn flags failed steers as limit or failed", () => {
  assert.deepEqual(
    needsResumeForFailedTurn({ role: "steer", outcome: "failed", error: "rate limit exceeded", at: "t" }),
    { reason: "limit", at: "t" },
  );
  assert.deepEqual(
    needsResumeForFailedTurn({ role: "steer", outcome: "failed", error: "exit 1", at: "t" }),
    { reason: "failed", at: "t" },
  );
  assert.deepEqual(
    needsResumeForFailedTurn({ role: "steer", outcome: "failed", error: null, at: "t" }),
    { reason: "failed", at: "t" },
  );
  assert.equal(
    needsResumeForFailedTurn({ role: "worker", outcome: "failed", error: "rate limit", at: "t" }),
    null,
  );
  assert.equal(
    needsResumeForFailedTurn({ role: "steer", outcome: "canceled", error: "rate limit", at: "t" }),
    null,
  );
  assert.equal(
    needsResumeForFailedTurn({ role: "steer", outcome: "completed", error: null, at: "t" }),
    null,
  );
  assert.equal(isNeedsResumeReason("daemon-restart"), true);
  assert.equal(isNeedsResumeReason("limit"), true);
  assert.equal(isNeedsResumeReason("failed"), true);
  assert.equal(isNeedsResumeReason("cold"), true);
  assert.equal(isNeedsResumeReason("idle"), false);
  assert.equal(isNeedsResumeReason(null), false);
});

// ---------------------------------------------------------------------------
// Boot check: closed or interrupted steers need resume.
// ---------------------------------------------------------------------------

const steerLabels = (slot) => ({ [LABEL.repo]: REPO, [LABEL.role]: "steer", [LABEL.slot]: slot, [LABEL.scope]: REPO });
const bootDaemonStart = NOW - 5 * MIN;

async function boot(world, extra = {}) {
  const logged = [];
  const marks = await bootCheck.runBootCheck({
    paseo: fakeClient(world),
    getDaemonStartedAt: () => at(bootDaemonStart),
    now: () => at(NOW),
    lock: noLock,
    readExcerpt: async () => "tail",
    readGit: () => null,
    log: (message) => void logged.push(message),
    getConfig: async () => ({ steers: { slots: { A: "p", B: "p", C: "adv" } }, profiles: { p: {}, adv: { advisor: true } } }),
    ...extra,
  });
  return { marks, logged, entries: world.workspaces[0].metadata[AGENTS_KEY] ?? {} };
}

function bootWorld({ activeSteer = "A", agents }) {
  const world = makeWorld();
  const ws = addWorkspace(world, {
    metadata: scopeMeta({ activeSteer, checkpoint: { task: "ship it", tests: [], blockers: [], next: null } }),
  });
  const made = {};
  for (const [key, spec] of Object.entries(agents)) {
    made[key] = addAgent(world, { title: key, workspaceId: ws.id, status: "closed", labels: steerLabels(spec.slot), ...spec.fields });
  }
  world.workspaces[0].metadata[AGENTS_KEY] = Object.fromEntries(
    Object.entries(agents).filter(([, spec]) => spec.entry).map(([key, spec]) => [made[key].id, spec.entry]),
  );
  return { world, made };
}

test("boot rule: closed steer with an old turn is not marked", async () => {
  const { world, made } = bootWorld({ agents: { b: { slot: "B", entry: { lastTurnEndedAt: at(NOW - 30 * HOUR) } } } });
  const { marks, entries } = await boot(world);
  assert.equal(marks.length, 0);
  assert.equal(entries[made.b.id].needsResume, undefined);
});

test("boot rule: every recently active steer is marked, not only the active one", async () => {
  const { world, made } = bootWorld({
    activeSteer: "A",
    agents: {
      a: { slot: "A", entry: { lastTurnEndedAt: at(NOW - 2 * HOUR) } },
      b: { slot: "B", entry: { lastTurnEndedAt: at(NOW - 2 * HOUR) } },
    },
  });
  const { marks, entries, logged } = await boot(world);
  assert.equal(marks.length, 2);
  assert.deepEqual(entries[made.a.id].needsResume, { reason: "daemon-restart", at: at(NOW) });
  assert.deepEqual(entries[made.b.id].needsResume, { reason: "daemon-restart", at: at(NOW) });
  assert.match(logged.join("\n"), /0 open turn, 1 active recent, 1 recent/);
});

test("boot rule: active steer with a recent last turn is marked, an old one is not", async () => {
  const recent = bootWorld({ agents: { a: { slot: "A", entry: { lastTurnEndedAt: at(NOW - 23 * HOUR) } } } });
  const r = await boot(recent.world);
  assert.equal(r.marks[0]?.cause, "closed");
  assert.deepEqual(r.entries[recent.made.a.id].needsResume, { reason: "daemon-restart", at: at(NOW) });
  assert.match(r.logged.join("\n"), /0 interrupted turn\(s\).*0 open turn, 1 active recent, 0 recent/);
  const old = bootWorld({ agents: { a: { slot: "A", entry: { lastTurnEndedAt: at(NOW - 30 * HOUR) } } } });
  const o = await boot(old.world);
  assert.equal(o.marks.length, 0);
  assert.equal(o.entries[old.made.a.id].needsResume, undefined);
  const custom = await boot(bootWorld({ agents: { a: { slot: "A", entry: { lastTurnEndedAt: at(NOW - 30 * HOUR) } } } }).world, { getRecentHours: () => 48 });
  assert.equal(custom.marks.length, 1);
});

test("boot rule: non-active steer with an open turn is marked and interrupted", async () => {
  const { world, made } = bootWorld({
    agents: { b: { slot: "B", fields: { status: "idle" }, entry: { openTurnId: "t1", turnStartedAt: at(NOW - 30 * MIN) } } },
  });
  const { marks, entries, logged } = await boot(world);
  assert.equal(marks[0]?.cause, "interrupted");
  assert.equal(entries[made.b.id].interrupted.reason, "daemon-restart");
  assert.deepEqual(entries[made.b.id].needsResume, { reason: "daemon-restart", at: at(NOW) });
  assert.match(logged.join("\n"), /1 interrupted turn\(s\).*1 open turn, 0 active recent, 0 recent/);
});

test("boot rule: advisor without an open turn is not marked, with one it is", async () => {
  const idle = bootWorld({ activeSteer: "C", agents: { c: { slot: "C", entry: { lastTurnEndedAt: at(NOW - HOUR) } } } });
  assert.equal((await boot(idle.world)).marks.length, 0);
  const open = bootWorld({
    agents: { c: { slot: "C", entry: { openTurnId: "t1", turnStartedAt: at(NOW - 30 * MIN) } } },
  });
  const o = await boot(open.world);
  assert.equal(o.marks[0]?.cause, "interrupted");
  assert.equal(o.entries[open.made.c.id].needsResume.reason, "daemon-restart");
});

test("boot rule: config failure fails closed for the active-recent rule", async () => {
  const { world } = bootWorld({ agents: { a: { slot: "A", entry: { lastTurnEndedAt: at(NOW - HOUR) } } } });
  const { marks } = await boot(world, { getConfig: async () => { throw new Error("x"); } });
  assert.equal(marks.length, 0);
});

test("boot rule: foreign scope, missing scope label, missing slot, retired scope and archived are not marked", async () => {
  const { world, made } = bootWorld({ agents: { a: { slot: "A", entry: { lastTurnEndedAt: at(NOW - HOUR) } } } });
  const entry = { lastTurnEndedAt: at(NOW - HOUR) };
  const noLabel = addAgent(world, { workspaceId: world.workspaces[0].id, status: "closed", labels: {} });
  const foreign = addAgent(world, { workspaceId: world.workspaces[0].id, status: "closed", labels: { ...steerLabels("A"), [LABEL.scope]: "other/scope" } });
  const noSlot = addAgent(world, { workspaceId: world.workspaces[0].id, status: "closed", labels: { [LABEL.repo]: REPO, [LABEL.role]: "steer", [LABEL.scope]: REPO } });
  const archived = addAgent(world, { workspaceId: world.workspaces[0].id, status: "closed", archivedAt: at(NOW), labels: steerLabels("A") });
  for (const agent of [noLabel, foreign, noSlot, archived]) world.workspaces[0].metadata[AGENTS_KEY][agent.id] = entry;
  const { marks } = await boot(world);
  assert.deepEqual(marks.map((m) => m.agentId), [made.a.id]);
  world.workspaces[0].metadata[AGENTS_KEY][made.a.id] = entry;
  delete world.workspaces[0].metadata[AGENTS_KEY][made.a.id].needsResume;
  world.workspaces[0].metadata[METADATA_KEY].retired = true;
  assert.equal((await boot(world)).marks.length, 0);
});

test("boot rule: stale daemon-restart entries are removed at the next boot, other reasons stay", async () => {
  const { world, made } = bootWorld({
    agents: {
      b: { slot: "B", entry: { lastTurnEndedAt: at(NOW - 30 * HOUR), needsResume: { reason: "daemon-restart", at: at(NOW - HOUR) } } },
      a: { slot: "A", entry: { lastTurnEndedAt: at(NOW - HOUR), needsResume: { reason: "daemon-restart", at: at(NOW - HOUR) } } },
      c: { slot: "B", entry: { needsResume: { reason: "limit", at: at(NOW - HOUR) } } },
    },
  });
  const { marks, entries, logged } = await boot(world);
  assert.equal(marks.length, 0);
  assert.equal(entries[made.b.id].needsResume, undefined);
  assert.equal(entries[made.b.id].lastTurnEndedAt, at(NOW - 30 * HOUR));
  assert.equal(entries[made.a.id].needsResume.reason, "daemon-restart");
  assert.equal(entries[made.c.id].needsResume.reason, "limit");
  assert.match(logged.join("\n"), /1 stale flag\(s\) removed/);
});

test("bootResumeReason marks active and non-active recent steers, advisors only with an open turn", () => {
  const daemonStartedAt = at(NOW);
  const recent = at(NOW - 2 * HOUR);
  const old = at(NOW - 30 * HOUR);
  assert.equal(bootResumeReason({ openTurn: false, active: true, advisor: false, lastTurnEndedAt: recent, daemonStartedAt, recentHours: 24 }), "active-recent");
  assert.equal(bootResumeReason({ openTurn: false, active: false, advisor: false, lastTurnEndedAt: recent, daemonStartedAt, recentHours: 24 }), "recent");
  assert.equal(bootResumeReason({ openTurn: false, active: false, advisor: false, lastTurnEndedAt: old, daemonStartedAt, recentHours: 24 }), null);
  assert.equal(bootResumeReason({ openTurn: false, active: false, advisor: false, lastTurnEndedAt: null, daemonStartedAt, recentHours: 24 }), null);
  assert.equal(bootResumeReason({ openTurn: false, active: false, advisor: true, lastTurnEndedAt: recent, daemonStartedAt, recentHours: 24 }), null);
  assert.equal(bootResumeReason({ openTurn: true, active: false, advisor: true, lastTurnEndedAt: null, daemonStartedAt, recentHours: 24 }), "open-turn");
});

test("resumeReminderText: active keeps the short label, others name the last steer", () => {
  assert.deepEqual(
    resumeReminderText({ reasonLabel: "Paseo restarted", canFresh: true, advisor: false, activeSteer: "A" }),
    { pill: "Resume required · Paseo restarted", title: "Resume required · Paseo restarted", body: "" },
  );
  assert.deepEqual(
    resumeReminderText({ reasonLabel: "Usage limit reached", canFresh: false, advisor: false, activeSteer: "A" }),
    {
      pill: "Steer A coordinated last",
      title: "Steer A coordinated last",
      body: "Continuing here makes this the active steer.",
    },
  );
  assert.deepEqual(
    resumeReminderText({ reasonLabel: "Last reply failed", canFresh: false, advisor: true, activeSteer: "A" }).pill,
    "Resume required · Last reply failed",
  );
  assert.equal(
    resumeReminderText({ reasonLabel: "Paseo restarted", canFresh: false, advisor: false, activeSteer: null }).pill,
    "Another steer coordinated last",
  );
});

test("sidebar counter counts only resume rows of active steers", () => {
  const rows = [
    { reason: "daemon-restart", canFresh: true },
    { reason: "daemon-restart", canFresh: false },
    { reason: "limit", canFresh: true },
    { reason: "cold", canFresh: true },
    { canFresh: true },
  ];
  assert.equal(countActiveResumeRows(rows), 2);
  assert.equal(countActiveResumeRows([]), 0);
});

test("runBootCheck keeps an existing needsResume reason", async () => {
  const world = makeWorld();
  const ws = addWorkspace(world, {
    metadata: scopeMeta({
      checkpoint: { task: "ship it", tests: [], blockers: [], next: null },
    }),
  });
  const closed = addAgent(world, {
    title: "Steer B",
    status: "closed",
    workspaceId: ws.id,
    labels: { [LABEL.repo]: REPO, [LABEL.role]: "steer", [LABEL.slot]: "B", [LABEL.scope]: REPO },
  });
  world.workspaces[0].metadata[AGENTS_KEY] = {
    [closed.id]: { needsResume: { reason: "limit", at: at(NOW - HOUR) } },
  };
  await bootCheck.runBootCheck({
    paseo: fakeClient(world),
    getDaemonStartedAt: () => at(NOW - 5 * MIN),
    now: () => at(NOW),
    lock: noLock,
    readExcerpt: async () => null,
    readGit: () => null,
    log: () => {},
  });
  assert.deepEqual(world.workspaces[0].metadata[AGENTS_KEY][closed.id].needsResume, {
    reason: "limit",
    at: at(NOW - HOUR),
  });
});

// ---------------------------------------------------------------------------
// Attention feed rows.
// ---------------------------------------------------------------------------

test("collectColdAgents carries reason: cold rows and needsResume rows", async () => {
  const world = makeWorld();
  const ws = addWorkspace(world, { metadata: scopeMeta({}) });
  const cold = addAgent(world, {
    title: "Steer A",
    workspaceId: ws.id,
    lastUsage: { contextWindowUsedTokens: 120_000 },
    labels: { [LABEL.repo]: REPO, [LABEL.role]: "steer", [LABEL.slot]: "A", [LABEL.scope]: REPO },
  });
  const flagged = addAgent(world, {
    title: "Steer B",
    workspaceId: ws.id,
    labels: { [LABEL.repo]: REPO, [LABEL.role]: "steer", [LABEL.slot]: "B", [LABEL.scope]: REPO },
  });
  const warm = addAgent(world, {
    title: "Steer C",
    workspaceId: ws.id,
    lastUsage: { contextWindowUsedTokens: 120_000 },
    labels: { [LABEL.repo]: REPO, [LABEL.role]: "steer", [LABEL.slot]: "C", [LABEL.scope]: REPO },
  });
  world.workspaces[0].metadata[AGENTS_KEY] = {
    [cold.id]: { lastTurnEndedAt: at(NOW - 2 * HOUR) },
    [flagged.id]: {
      lastTurnEndedAt: at(NOW - 2 * MIN),
      needsResume: { reason: "limit", at: at(NOW - MIN) },
    },
    [warm.id]: { lastTurnEndedAt: at(NOW - 2 * MIN) },
  };
  const rows = await sweep.collectColdAgents(
    fakeClient(world),
    { ...CLEANUP_DEFAULTS, mode: "compact-warm" },
    NOW,
  );
  const byId = new Map(rows.map((r) => [r.agentId, r]));
  assert.equal(byId.get(cold.id)?.reason, "cold");
  assert.equal(byId.get(flagged.id)?.reason, "limit");
  assert.equal(byId.has(warm.id), false);
  assert.equal(byId.get(flagged.id)?.workspaceId, ws.id);
  assert.equal(byId.get(flagged.id)?.slot, "B");
  assert.equal(byId.get(flagged.id)?.activeSteer, "A");
  assert.equal(byId.get(flagged.id)?.canFresh, false);
  assert.equal(byId.get(flagged.id)?.advisor, false);
  const advised = await sweep.collectColdAgents(
    fakeClient(world),
    { ...CLEANUP_DEFAULTS, mode: "compact-warm" },
    NOW,
    { steers: { slots: { A: "p", B: "adv" } }, profiles: { p: {}, adv: { advisor: true } } },
  );
  const advisedById = new Map(advised.map((r) => [r.agentId, r]));
  assert.equal(advisedById.get(flagged.id)?.advisor, true);
  assert.equal(advisedById.get(cold.id)?.advisor, false);
});

test("collectColdAgents surfaces a valid freshHint below the cold threshold", async () => {
  const world = makeWorld();
  const ws = addWorkspace(world, { metadata: scopeMeta({}) });
  const hint = "package boundary: valid checkpoint, no open workers";
  const hinted = addAgent(world, {
    title: "Steer A",
    workspaceId: ws.id,
    lastUsage: { contextWindowUsedTokens: 120_000 },
    labels: steerLabels("A"),
  });
  const stale = addAgent(world, {
    title: "Steer B",
    workspaceId: ws.id,
    lastUsage: { contextWindowUsedTokens: 120_000 },
    labels: steerLabels("B"),
  });
  const running = addAgent(world, {
    title: "Steer C",
    workspaceId: ws.id,
    status: "running",
    lastUsage: { contextWindowUsedTokens: 120_000 },
    labels: steerLabels("C"),
  });
  const pending = addAgent(world, {
    title: "Steer D",
    workspaceId: ws.id,
    lastUsage: { contextWindowUsedTokens: 120_000 },
    labels: steerLabels("D"),
  });
  const flagged = addAgent(world, {
    title: "Steer E",
    workspaceId: ws.id,
    labels: steerLabels("E"),
  });
  world.workspaces[0].metadata[AGENTS_KEY] = {
    // Still cooling on the short Claude route, with a stored recommendation.
    [hinted.id]: {
      lastTurnEndedAt: at(NOW - 4 * MIN),
      freshHint: { at: at(NOW - 2 * MIN), reason: hint },
    },
    // Recorded before the last turn: stale, stays hidden.
    [stale.id]: {
      lastTurnEndedAt: at(NOW - 4 * MIN),
      freshHint: { at: at(NOW - 2 * HOUR), reason: hint },
    },
    // Valid hint, but the agent is not idle.
    [running.id]: {
      lastTurnEndedAt: at(NOW - 4 * MIN),
      freshHint: { at: at(NOW - 2 * MIN), reason: hint },
    },
    // A pending C5 action hides the hint like a plain cold row.
    [pending.id]: {
      lastTurnEndedAt: at(NOW - 4 * MIN),
      freshHint: { at: at(NOW - 2 * MIN), reason: hint },
      pendingAction: { kind: "compact", at: at(NOW - MIN), reason: "idle" },
    },
    // needsResume keeps its reason; the hint rides along for after the resume.
    [flagged.id]: {
      lastTurnEndedAt: at(NOW - 2 * MIN),
      needsResume: { reason: "limit", at: at(NOW - MIN) },
      freshHint: { at: at(NOW - MIN), reason: hint },
    },
  };
  const rows = await sweep.collectColdAgents(
    fakeClient(world),
    { ...CLEANUP_DEFAULTS, mode: "compact-warm" },
    NOW,
  );
  const byId = new Map(rows.map((r) => [r.agentId, r]));
  assert.equal(byId.get(hinted.id)?.freshHint, hint);
  assert.equal(byId.get(hinted.id)?.reason, "cold");
  assert.equal(byId.get(hinted.id)?.workspaceId, ws.id);
  assert.equal(byId.get(hinted.id)?.canFresh, true);
  assert.equal(byId.has(stale.id), false);
  assert.equal(byId.has(running.id), false);
  assert.equal(byId.has(pending.id), false);
  assert.equal(byId.get(flagged.id)?.reason, "limit");
  assert.equal(byId.get(flagged.id)?.freshHint, hint);
});

// ---------------------------------------------------------------------------
// F4: a woken steer with needsResume gets an automatic resume.
// ---------------------------------------------------------------------------

test("sendScopeWake auto-resumes a flagged steer instead of the wake text", async () => {
  supervise.resetSupervisionForTests();
  const world = makeWorld();
  const ws = addWorkspace(world, {
    metadata: scopeMeta({
      checkpoint: { task: "t", tests: [], blockers: [], next: null },
    }),
  });
  const steerA = addAgent(world, {
    title: "Steer A",
    workspaceId: ws.id,
    labels: { [LABEL.repo]: REPO, [LABEL.role]: "steer", [LABEL.slot]: "A", [LABEL.scope]: REPO },
  });
  const workerId = "worker-1";
  world.workspaces[0].metadata[WORKERS_KEY] = {
    [workerId]: {
      task: "do it",
      startedBy: "A",
      startedAt: at(NOW - 30 * MIN),
      epoch: 3,
      state: "done",
      status: "done",
      resumes: 0,
      lastWakeAt: null,
      pendingWake: null,
    },
  };
  world.workspaces[0].metadata[AGENTS_KEY] = {
    [steerA.id]: { needsResume: { reason: "daemon-restart", at: at(NOW - HOUR) } },
  };
  const resumed = [];
  const sent = await supervise.sendScopeWake(
    fakeClient(world),
    { scope: { id: REPO, workspaceId: ws.id }, events: [{ workerId, state: "done" }] },
    {
      settings: { enabled: true, batchMinutes: 10, watchdogMinutes: 15, staleMinutes: 60, answerMinutes: 10, maxAutoResumes: 2 },
      lock: noLock,
      log: () => {},
      nowMs: NOW,
      nowIso: at(NOW),
      delivery: { runCleanupFn: async (_paseo, agentId, kind, reason, options) => {
        resumed.push({ agentId, ...options });
        return { workspaceId: ws.id, sessionId: null, kind, reason };
      } },
    },
  );
  assert.equal(sent.sent, false, "clear path stays pending until the brief is sent");
  assert.equal(sent.reason, "brief-pending");
  assert.equal(sent.target, steerA.id);
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].workspaceId, ws.id);
  assert.equal(resumed[0].agentId, steerA.id);
  assert.match(resumed[0].note, new RegExp(`worker ${workerId} done`));
  assert.equal(sendsTo(world, steerA.id).length, 0, "no plain wake text on auto-resume");
  const entry = world.workspaces[0].metadata[WORKERS_KEY][workerId];
  assert.equal(entry.lastWakeAt, null, "not delivered until the brief succeeds");
  assert.deepEqual(entry.pendingWake, { state: "done", queuedAt: at(NOW) });
  const pending = world.workspaces[0].metadata[AGENTS_KEY][steerA.id].pendingWakeBrief;
  assert.ok(pending?.wakeId, "pending wake brief staged");
  assert.equal(pending.batch.events.length, 1);
  assert.match(pending.note, new RegExp(`worker ${workerId} done`));

  const immediate = await supervise.sendScopeWake(
    fakeClient(world),
    { scope: { id: REPO, workspaceId: ws.id }, events: [{ workerId, state: "done" }] },
    {
      settings: { enabled: true, batchMinutes: 10, watchdogMinutes: 15, staleMinutes: 60, answerMinutes: 10, maxAutoResumes: 2 },
      lock: noLock,
      log: () => {},
      nowMs: NOW,
      nowIso: at(NOW),
      delivery: { buildBrief: async () => "Resume body" },
    },
  );
  assert.equal(immediate.sent, false, "retry stays queued until the clear is confirmed");
  assert.equal(sendsTo(world, steerA.id).length, 0);
});

test("sendScopeWake without health information and without a recovery flag sends the plain wake text", async () => {
  supervise.resetSupervisionForTests();
  const world = makeWorld();
  const ws = addWorkspace(world, {
    metadata: scopeMeta({
      checkpoint: { task: "t", tests: [], blockers: [], next: null },
    }),
  });
  const steerA = addAgent(world, {
    title: "Steer A",
    workspaceId: ws.id,
    labels: { [LABEL.repo]: REPO, [LABEL.role]: "steer", [LABEL.slot]: "A", [LABEL.scope]: REPO },
  });
  const workerId = "worker-1";
  const register = () => ({
    [workerId]: {
      task: "do it",
      startedBy: "A",
      startedAt: at(NOW - 30 * MIN),
      epoch: 3,
      state: "done",
      status: "done",
      resumes: 0,
      lastWakeAt: null,
      pendingWake: null,
    },
  });
  world.workspaces[0].metadata[WORKERS_KEY] = register();
  const deps = {
    settings: { enabled: true, batchMinutes: 10, watchdogMinutes: 15, staleMinutes: 60, answerMinutes: 10, maxAutoResumes: 2 },
    lock: noLock,
    log: () => {},
    nowMs: NOW,
    nowIso: at(NOW),
  };
  const plain = await supervise.sendScopeWake(
    fakeClient(world),
    { scope: { id: REPO, workspaceId: ws.id }, events: [{ workerId, state: "done" }] },
    deps,
  );
  assert.equal(plain.sent, true);
  assert.equal(plain.resumed, undefined);
  assert.equal(sendsTo(world, steerA.id).length, 1);


});

// ---------------------------------------------------------------------------
// Static wiring (repo pattern): turn hook, entry, stub removal.
// ---------------------------------------------------------------------------

test("turn hook sends the resume brief after a verified resume clear", () => {
  const turnHook = readFileSync(new URL("../server/turn-hook.ts", import.meta.url), "utf8");
  assert.ok(turnHook.includes("RESUME_PENDING_REASON"), "distinguishes resume clears");
  assert.ok(turnHook.includes("getResumeBrief"), "brief builder is a hook dep");
  assert.ok(turnHook.includes("finishSteerDelivery"), "confirmed clear releases the queued brief");
  assert.ok(turnHook.includes("needsResumeForFailedTurn"), "failed steer turns flag");
  assert.ok(turnHook.includes("needsResume: null"), "flag clears on success");
});

test("server entry registers resume RPC, attention feed, and F4 wiring", () => {
  const serverEntry = readFileSync(new URL("../index.server.ts", import.meta.url), "utf8");
  assert.ok(serverEntry.includes("factoryResumeApply"), "resume RPC registered");
  assert.ok(serverEntry.includes("factoryCold"), "attention feed registered");
  assert.ok(serverEntry.includes("factoryResumeSettings"), "resume settings registered");
  assert.ok(serverEntry.includes("delivery, getZerosub"), "supervision uses the shared delivery policy");
  assert.ok(serverEntry.includes("getResumeBrief"), "turn hook gets the brief builder");
  const settingsModule = readFileSync(new URL("../shared/settings.ts", import.meta.url), "utf8");
  assert.ok(settingsModule.includes('id: "factory-resume"'), "resume settings document exists");
  assert.deepEqual(factoryResumeSettings.schema.parse({}), { providers: ["claude"], recentHours: 24 });
});

test("client stub is replaced by the shared contracts", () => {
  assert.equal(existsSync(new URL("../client/resume-contract.ts", import.meta.url)), false);
  for (const file of ["factory-submit.ts", "factory-store.ts", "factory-panel.tsx"]) {
    const source = readFileSync(new URL(`../client/${file}`, import.meta.url), "utf8");
    assert.ok(!source.includes("resume-contract"), `${file} no longer imports the stub`);
    assert.ok(source.includes("factoryResumeApply"), `${file} uses the shared contract`);
  }
  const actions = readFileSync(new URL("../client/cold-actions.tsx", import.meta.url), "utf8");
  assert.ok(!actions.includes("factoryResumeApply"), "attention does not send a brief to an uncleared session");
  assert.ok(actions.includes("factoryFreshPreview"), "attention prepares the same-tab refresh");
});

// ---------------------------------------------------------------------------
// Sweep quota gate and Codex mapping (fake world, no live agents).
// ---------------------------------------------------------------------------

test("quotaAvailableForCleanup is true only with a reading that shows headroom", () => {
  assert.equal(sweep.quotaAvailableForCleanup("claude", null), null);
  assert.equal(sweep.quotaAvailableForCleanup("claude", undefined), null);
  assert.equal(sweep.quotaAvailableForCleanup("claude", {}), null);
  assert.equal(sweep.quotaAvailableForCleanup("claude", { claude: {} }), null);
  assert.equal(sweep.quotaAvailableForCleanup("claude", { claude: { sessionPct: 40 } }), true);
  assert.equal(sweep.quotaAvailableForCleanup("claude", { claude: { sessionPct: 95 } }), false);
  assert.equal(
    sweep.quotaAvailableForCleanup("codex", { codex: { sessionPct: 10, limitUntil: new Date(Date.now() + HOUR).toISOString() } }),
    false,
  );
});

test("quotaAvailableForCleanup checks the routed ZeroSub account before the pool", () => {
  const nowMs = Date.parse("2026-11-24T12:00:00.000Z");
  const future = new Date(nowMs + HOUR).toISOString();
  const past = new Date(nowMs - HOUR).toISOString();
  const account = (id, windows) => ({
    id, family: "claude", status: "active", limitedUntil: null, exhausted: false,
    windows, maxUsedPct: Math.max(...windows.map((window) => window.usedPct)),
  });
  const zerosub = {
    accounts: [
      account("acc-roomy", [{ id: "five_hour", usedPct: 20, resetsAt: future }]),
      account("acc-full", [{ id: "five_hour", usedPct: 99, resetsAt: future }]),
      account("acc-stale", [{ id: "five_hour", usedPct: 99, resetsAt: past }]),
      account("acc-mixed", [
        { id: "five_hour", usedPct: 99, resetsAt: past },
        { id: "seven_day", usedPct: 20, resetsAt: future },
      ]),
    ],
    agentAccount: {
      "steer-roomy": "acc-roomy",
      "steer-full": "acc-full",
      "steer-stale": "acc-stale",
      "steer-mixed": "acc-mixed",
    },
    pending: { "steer-moved": "acc-roomy" },
  };
  const exhaustedPool = { claude: { sessionPct: 99 } };
  const healthyPool = { claude: { sessionPct: 10 } };
  const cases = [
    ["routed healthy account wins over exhausted pool", "steer-roomy", exhaustedPool, true],
    ["routed exhausted account blocks despite healthy pool", "steer-full", healthyPool, false],
    ["expired window on routed account is unknown, not exhausted", "steer-stale", healthyPool, null],
    ["expired window plus fresh headroom allows", "steer-mixed", null, true],
    ["pending move account is live", "steer-moved", exhaustedPool, true],
    ["unknown route falls back to healthy pool", "steer-unknown", healthyPool, true],
    ["unknown route falls back to exhausted pool", "steer-unknown", exhaustedPool, false],
    ["unknown route without pool is unknown", "steer-unknown", null, null],
    ["no agent falls back to the pool", null, healthyPool, true],
  ];
  for (const [name, agentId, snapshot, want] of cases) {
    assert.equal(sweep.quotaAvailableForCleanup("claude", snapshot, { agentId, zerosub, nowMs }), want, name);
  }
  const dangling = { ...zerosub, agentAccount: { ...zerosub.agentAccount, "steer-gone": "acc-missing" } };
  assert.equal(
    sweep.quotaAvailableForCleanup("claude", healthyPool, { agentId: "steer-gone", zerosub: dangling, nowMs }),
    true,
    "dangling route falls back to the pool",
  );
  assert.equal(
    sweep.quotaAvailableForCleanup("claude", null, { agentId: "steer-full", zerosub, exhaustedPct: 100, nowMs }),
    true,
    "configured threshold applies to the routed account",
  );
});

function subscriptionRoute(agentId, usedPct) {
  return {
    agentAccount: { [agentId]: "claude-subscription" },
    accounts: [{
      id: "claude-subscription", family: "claude", auth: "subscription",
      windows: usedPct === null ? [] : [{ usedPct }],
    }],
    pending: {},
  };
}

function sweepWorld({ provider = "claude", model = "m", idleMs = 55 * MIN, usage = 120_000, workers = {} } = {}) {
  const nowMs = Date.now();
  const stamp = (ms) => new Date(ms).toISOString();
  const world = makeWorld();
  const ws = addWorkspace(world, {
    metadata: scopeMeta({
      checkpoint: { task: "t", tests: [], blockers: [], next: null, capturedAt: stamp(nowMs - 5 * MIN) },
      workers,
    }),
  });
  const agent = addAgent(world, {
    title: "Steer A",
    workspaceId: ws.id,
    provider,
    model,
    lastUsage: { contextWindowUsedTokens: usage },
    labels: { [LABEL.repo]: REPO, [LABEL.role]: "steer", [LABEL.slot]: "A", [LABEL.scope]: REPO },
  });
  world.workspaces[0].metadata[AGENTS_KEY] = {
    [agent.id]: { lastTurnEndedAt: stamp(nowMs - idleMs) },
  };
  return { world, ws, agent, nowMs };
}

test("sweepOnce skips the compact when the provider quota is unknown (fail closed)", async () => {
  const { world, agent, nowMs } = sweepWorld({ workers: { "worker-1": { state: "running" } } });
  const results = await sweep.sweepOnce({
    paseo: fakeClient(world),
    settings: { ...CLEANUP_DEFAULTS, mode: "compact-warm" },
    nowMs,
    zerosub: subscriptionRoute(agent.id, null),
    quotaSnapshot: null,
    lock: noLock,
    log: () => {},
  });
  assert.deepEqual(results, []);
  assert.deepEqual(sendsTo(world, agent.id), []);
});

test("sweepOnce compacts an eligible agent when quota shows headroom", async () => {
  const { world, agent, nowMs } = sweepWorld({ workers: { "worker-1": { state: "running" } } });
  const results = await sweep.sweepOnce({
    paseo: fakeClient(world),
    settings: { ...CLEANUP_DEFAULTS, mode: "compact-warm" },
    nowMs,
    zerosub: subscriptionRoute(agent.id, 40),
    quotaSnapshot: { claude: { sessionPct: 40 } },
    lock: noLock,
    log: () => {},
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].agentId, agent.id);
  assert.equal(results[0].sent, true);
  const sends = sendsTo(world, agent.id);
  assert.equal(sends.length, 1);
  assert.match(sends[0], /^\/compact /);
});

test("sweepOnce skips the compact when the provider quota is exhausted", async () => {
  const { world, agent, nowMs } = sweepWorld({ workers: { "worker-1": { state: "running" } } });
  const results = await sweep.sweepOnce({
    paseo: fakeClient(world),
    settings: { ...CLEANUP_DEFAULTS, mode: "compact-warm" },
    nowMs,
    zerosub: subscriptionRoute(agent.id, 95),
    quotaSnapshot: { claude: { sessionPct: 95 } },
    lock: noLock,
    log: () => {},
  });
  assert.deepEqual(results, []);
  assert.deepEqual(sendsTo(world, agent.id), []);
});

test("sweepOnce records fresh-recommended once per idle period, without sending", async () => {
  const { world, agent, nowMs } = sweepWorld();
  const settings = { ...CLEANUP_DEFAULTS, mode: "compact-warm" };
  const first = await sweep.sweepOnce({
    paseo: fakeClient(world),
    settings,
    nowMs,
    zerosub: subscriptionRoute(agent.id, null),
    quotaSnapshot: null,
    lock: noLock,
    log: () => {},
  });
  assert.equal(first.length, 1);
  assert.equal(first[0].action, "fresh-recommended");
  assert.equal(first[0].sent, false);
  assert.match(first[0].reason, /package boundary/);
  assert.deepEqual(sendsTo(world, agent.id), []);
  const hint = world.workspaces[0].metadata[AGENTS_KEY][agent.id].freshHint;
  assert.ok(hint?.at);
  assert.match(hint.reason, /package boundary/);
  // The cooldown keeps the next sweep quiet.
  const second = await sweep.sweepOnce({
    paseo: fakeClient(world),
    settings,
    nowMs,
    quotaSnapshot: null,
    lock: noLock,
    log: () => {},
  });
  assert.deepEqual(second, []);
});

test("sweepOnce maps mode clear to /compact for Codex, never /clear", async () => {
  const { world, agent, nowMs } = sweepWorld({
    provider: "codex",
    model: "gpt-6.2-sol",
    idleMs: 26 * MIN,
    workers: { "worker-1": { state: "running" } },
  });
  const results = await sweep.sweepOnce({
    paseo: fakeClient(world),
    settings: { ...CLEANUP_DEFAULTS, mode: "clear", providers: ["claude", "codex"] },
    nowMs,
    quotaSnapshot: { codex: { sessionPct: 10 } },
    lock: noLock,
    log: () => {},
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].action, "compact-warm");
  const sends = sendsTo(world, agent.id);
  assert.equal(sends.length, 1);
  assert.match(sends[0], /^\/compact /);
  assert.ok(!sends.some((text) => text.startsWith("/clear")), "no /clear is sent to Codex");
});

// ---------------------------------------------------------------------------
// Sweep rewind execution (fresh-recommended as same-tab rewind).
// ---------------------------------------------------------------------------

test("sweepOnce rewinds a fresh-recommended Codex agent when rewindFresh is on", async () => {
  const { world, ws, agent, nowMs } = sweepWorld({ provider: "codex", model: "gpt-6.2-sol", idleMs: 45 * MIN });
  ws.metadata[AGENTS_KEY][agent.id].refreshed = { briefMessageId: "saved-brief" };
  const calls = [];
  const results = await sweep.sweepOnce({
    paseo: fakeClient(world),
    settings: { ...CLEANUP_DEFAULTS, mode: "compact-warm", providers: ["claude", "codex"], rewindFresh: true },
    nowMs,
    quotaSnapshot: null,
    lock: noLock,
    log: () => {},
    rewindFn: async (id, options) => {
      assert.equal(options.previousBriefId, "saved-brief");
      calls.push(id);
      return { status: "rewound", messageId: "msg-1", briefMessageId: "saved-brief" };
    },
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].agentId, agent.id);
  assert.equal(results[0].action, "rewind");
  assert.equal(results[0].sent, true);
  assert.match(results[0].reason, /rewound .* to msg-1/);
  assert.deepEqual(calls, [agent.id]);
  assert.deepEqual(sendsTo(world, agent.id), [], "no SDK send: the rewind empties the context");
  const entry = world.workspaces[0].metadata[AGENTS_KEY][agent.id];
  assert.equal(entry.cleared.mode, "rewind");
  assert.equal(entry.refreshed.mode, "rewind");
  assert.equal(entry.refreshed.messageId, "msg-1");
  assert.equal(entry.refreshed.briefMessageId, "saved-brief");
  assert.equal(entry.pendingAction, undefined);
  // The recorded cleaning keeps the next sweep quiet.
  const second = await sweep.sweepOnce({
    paseo: fakeClient(world),
    settings: { ...CLEANUP_DEFAULTS, mode: "compact-warm", providers: ["claude", "codex"], rewindFresh: true },
    nowMs,
    quotaSnapshot: null,
    lock: noLock,
    log: () => {},
    rewindFn: async (id) => {
      calls.push(id);
      return { status: "rewound", messageId: "msg-2" };
    },
  });
  assert.deepEqual(second, []);
  assert.deepEqual(calls, [agent.id], "no second rewind in the same idle period");
});

test("sweep daily cap counts only completed rewind RPCs, even if bookkeeping fails", async (t) => {
  const day = Date.parse("2030-01-01T12:00:00.000Z");
  t.mock.method(Date, "now", () => day);
  const { world, ws, agent, nowMs } = sweepWorld({ provider: "codex", model: "gpt-6.2-sol", idleMs: 45 * MIN });
  const workers = ["failed", "no-op", "rewound", "over-cap"].map((title) => addAgent(world, {
    title, workspaceId: ws.id, provider: agent.provider, model: agent.model, lastUsage: agent.lastUsage,
    labels: { [LABEL.role]: "worker", [LABEL.scope]: REPO },
  }));
  for (const worker of workers) {
    ws.metadata[AGENTS_KEY][worker.id] = { lastTurnEndedAt: at(nowMs - 45 * MIN), noteAt: at(nowMs - MIN) };
  }
  const calls = [];
  let failWrite = false;
  const results = await sweep.sweepOnce({
    paseo: fakeClient(world),
    settings: { ...CLEANUP_DEFAULTS, mode: "compact-warm", providers: ["codex"], rewindFresh: true, dailyCap: 1 },
    nowMs,
    quotaSnapshot: null,
    zerosub: null,
    lock: (name, fn) => failWrite ? Promise.reject(new Error("metadata write failed")) : noLock(name, fn),
    log: () => {},
    rewindFn: async (id) => {
      const title = world.agents.find((candidate) => candidate.id === id).title;
      const status = id === agent.id ? "no-point" : title;
      calls.push(status);
      failWrite = status === "rewound";
      return { status, ...(failWrite ? { messageId: "next-turn" } : {}) };
    },
  });
  assert.deepEqual(calls, ["no-point", "failed", "no-op", "rewound"]);
  assert.deepEqual(results.map(({ sent }) => sent), [false, false, false, true]);
  assert.match(results.at(-1).reason, /could not record it/);
});

test("sweepOnce keeps Claude on its native path even with rewindFresh on", async () => {
  const { world, agent, nowMs } = sweepWorld();
  const calls = [];
  const results = await sweep.sweepOnce({
    paseo: fakeClient(world),
    settings: { ...CLEANUP_DEFAULTS, mode: "compact-warm", rewindFresh: true },
    nowMs,
    quotaSnapshot: null,
    lock: noLock,
    log: () => {},
    rewindFn: async (id) => {
      calls.push(id);
      return { status: "rewound", messageId: "msg-1" };
    },
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].action, "fresh-recommended");
  assert.equal(results[0].sent, false);
  assert.deepEqual(calls, [], "Claude is never rewound by the sweep");
  assert.ok(world.workspaces[0].metadata[AGENTS_KEY][agent.id].freshHint);
});

test("sweepOnce without rewindFresh only hints a fresh-recommended Codex agent", async () => {
  const { world, agent, nowMs } = sweepWorld({ provider: "codex", model: "gpt-6.2-sol", idleMs: 45 * MIN });
  const calls = [];
  const results = await sweep.sweepOnce({
    paseo: fakeClient(world),
    settings: { ...CLEANUP_DEFAULTS, mode: "compact-warm", providers: ["claude", "codex"] },
    nowMs,
    quotaSnapshot: null,
    lock: noLock,
    log: () => {},
    rewindFn: async (id) => {
      calls.push(id);
      return { status: "rewound", messageId: "msg-1" };
    },
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].action, "fresh-recommended");
  assert.deepEqual(calls, [], "default off: the hint is recorded, nothing is rewound");
  assert.ok(world.workspaces[0].metadata[AGENTS_KEY][agent.id].freshHint);
});

test("sweepOnce falls back to the hint when the rewind has no point", async () => {
  const { world, agent, nowMs } = sweepWorld({ provider: "codex", model: "gpt-6.2-sol", idleMs: 45 * MIN });
  const results = await sweep.sweepOnce({
    paseo: fakeClient(world),
    settings: { ...CLEANUP_DEFAULTS, mode: "compact-warm", providers: ["claude", "codex"], rewindFresh: true },
    nowMs,
    quotaSnapshot: null,
    lock: noLock,
    log: () => {},
    rewindFn: async () => ({ status: "no-point" }),
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].action, "fresh-recommended");
  assert.equal(results[0].sent, false);
  const entry = world.workspaces[0].metadata[AGENTS_KEY][agent.id];
  assert.ok(entry.freshHint, "hint recorded as without the setting");
  assert.equal(entry.cleared, undefined);
});

test("sweepOnce records a failed rewind and retries only after a new real turn", async () => {
  const { world, agent, nowMs } = sweepWorld({ provider: "codex", model: "gpt-6.2-sol", idleMs: 45 * MIN });
  const settings = { ...CLEANUP_DEFAULTS, mode: "compact-warm", providers: ["claude", "codex"], rewindFresh: true };
  const results = await sweep.sweepOnce({
    paseo: fakeClient(world),
    settings,
    nowMs,
    quotaSnapshot: null,
    lock: noLock,
    log: () => {},
    rewindFn: async () => ({ status: "failed", error: "boom" }),
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].action, "fresh-recommended");
  assert.equal(results[0].sent, false);
  assert.match(results[0].reason, /rewind failed: boom/);
  const entry = world.workspaces[0].metadata[AGENTS_KEY][agent.id];
  assert.equal(entry.lastActionFailed.error, "boom");
  assert.equal(entry.cleared, undefined);
  const second = await sweep.sweepOnce({
    paseo: fakeClient(world),
    settings,
    nowMs,
    quotaSnapshot: null,
    lock: noLock,
    log: () => {},
    rewindFn: async () => ({ status: "rewound", messageId: "msg-2" }),
  });
  assert.deepEqual(second, [], "the failure blocks retries in the same idle period");
});
