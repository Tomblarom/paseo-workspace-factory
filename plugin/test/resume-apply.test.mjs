// Manual `/factory resume` server path (R-A): RPC guards, checkpoint saving,
// provider gating, idempotency, and the runCleanup extraction shared with the
// C5 sweep. Server modules load through the ts-resolve-hooks remap; the fake
// Paseo client mirrors plugin/test/supervise.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-resolve-hooks.mjs", import.meta.url);

const resumeApply = await import("../server/resume-apply.ts");
const sweep = await import("../server/cold-sweep.ts");
const {
  CLEAR_COMMAND,
  COMPACT_COMMAND,
  RESUME_CLEAR_DEFAULTS,
  RESUME_PENDING_REASON,
  SWEEP_PENDING_REASON,
  formatResumeMessage,
  mayResumeClear,
} = await import("../shared/idle-cleanup.ts");
import { resumeFingerprint } from "../shared/preview.ts";
import { factoryResumeSettings } from "../shared/settings.ts";
import { factoryAttention, factoryCold, factoryResumeApply } from "../shared/factory.ts";
import { LABEL, METADATA_KEY } from "../../src/paseo.mjs";
import { AGENTS_KEY } from "../../src/agent-state.mjs";
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

function scopeMeta({ activeSteer = "A", epoch = 3, agents = {}, checkpoint = null } = {}) {
  const meta = {
    [METADATA_KEY]: { main: true, activeSteer, epoch, scope: { id: REPO, kind: "github", locator: REPO } },
  };
  if (Object.keys(agents).length) meta[AGENTS_KEY] = structuredClone(agents);
  if (checkpoint) meta[CHECKPOINT_KEY] = structuredClone(checkpoint);
  return meta;
}

function fakeClient(world, { sendFails = false } = {}) {
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
          if (sendFails) throw new Error("agent is closed");
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

const CHECKPOINT_TEXT = (task) =>
  ["```text", "CHECKPOINT", `- task: ${task}`, "- tests: npm test", "- blockers: none", "- next: ship", "```"].join("\n");

function provisioned(world, { agents = {}, checkpoint = { task: "ship it", tests: [], blockers: [], next: null } } = {}) {
  const ws = addWorkspace(world, { metadata: scopeMeta({ agents, checkpoint }) });
  const steer = addAgent(world, {
    title: "Steer A",
    workspaceId: ws.id,
    labels: { [LABEL.repo]: REPO, [LABEL.role]: "steer", [LABEL.slot]: "A", [LABEL.scope]: REPO },
  });
  return { ws, steer };
}

// ---------------------------------------------------------------------------
// Contracts and settings.
// ---------------------------------------------------------------------------

test("factory.resume.apply contract and resume settings defaults", () => {
  assert.equal(factoryResumeApply.name, "factory.resume.apply");
  assert.deepEqual(factoryResumeApply.input.parse({ workspaceId: "w", agentId: "a" }), {
    workspaceId: "w",
    agentId: "a",
  });
  assert.deepEqual(
    factoryResumeApply.output.parse({ agentId: "a", cleared: true, detail: "d" }),
    { agentId: "a", cleared: true, detail: "d" },
  );
  assert.equal(factoryAttention.name, "factory.attention");
  assert.equal(factoryCold.name, "factory.cold");
  const payload = {
    attention: [],
    cold: [],
    autoDisabled: false,
  };
  assert.deepEqual(factoryAttention.event.parse(payload).attention, []);
  assert.deepEqual(factoryCold.event.parse(payload).cold, []);
  const row = {
    workspaceId: "w",
    agentId: "a",
    contextTokens: 1,
    idleMinutes: 2,
    hasHistory: false,
    canFresh: false,
    reason: "limit",
  };
  assert.equal(factoryAttention.event.parse({ ...payload, attention: [row] }).attention[0].reason, "limit");
  const freshRow = { ...row, reason: "cold", freshHint: "package boundary" };
  assert.equal(
    factoryAttention.event.parse({ ...payload, attention: [freshRow] }).attention[0].freshHint,
    "package boundary",
  );
  assert.equal(
    factoryAttention.event.parse({ ...payload, attention: [row] }).attention[0].freshHint,
    undefined,
    "pre-change rows without the hint still parse",
  );
  assert.equal(factoryResumeSettings.id, "factory-resume");
  assert.equal(factoryResumeSettings.scope, "host");
  assert.deepEqual(factoryResumeSettings.schema.parse({}), RESUME_CLEAR_DEFAULTS);
  assert.deepEqual(RESUME_CLEAR_DEFAULTS, { providers: ["claude"], recentHours: 24 });
});

test("resumeFingerprint pins agent status, session, and checkpoint time", () => {
  const base = { agentId: "a", status: "idle", sessionId: "s1", checkpointAt: "2026-11-24T10:00:00.000Z" };
  const fp = resumeFingerprint(base);
  assert.equal(typeof fp, "string");
  assert.equal(resumeFingerprint({ ...base }), fp);
  for (const changed of [
    { ...base, status: "running" },
    { ...base, sessionId: "s2" },
    { ...base, checkpointAt: "2026-11-24T11:00:00.000Z" },
    { ...base, agentId: "b" },
  ]) {
    assert.notEqual(resumeFingerprint(changed), fp);
  }
});

test("mayResumeClear gates clear by provider with claude default", () => {
  assert.equal(mayResumeClear("claude", null), true);
  assert.equal(mayResumeClear("claude", undefined), true);
  assert.equal(mayResumeClear("codex", null), false);
  assert.equal(mayResumeClear("codex", { providers: ["claude", "codex"] }), true);
  assert.equal(mayResumeClear("muse", { providers: ["claude"], recentHours: 24 }), false);
  assert.equal(mayResumeClear(null, null), false);
  assert.equal(mayResumeClear("", null), false);
});

test("formatResumeMessage heads the brief, with notice when not cleared", () => {
  assert.equal(formatResumeMessage("brief body"), "[Factory resume]\nbrief body");
  const noted = formatResumeMessage("brief body", { cleared: false });
  assert.match(noted, /^\[Factory resume\] \(The context was kept because the clear command had no effect\./);
  assert.match(noted, /brief body$/);
  assert.equal(formatResumeMessage("  padded  \n"), "[Factory resume]\npadded");
});

// ---------------------------------------------------------------------------
// Checkpoint saving decision.
// ---------------------------------------------------------------------------

test("shouldSaveResumeCheckpoint saves only newer valid blocks", () => {
  const block = { task: "do it" };
  assert.equal(
    resumeApply.shouldSaveResumeCheckpoint({ block: null, checkpoint: null, lastTurnEndedAt: null }),
    false,
  );
  assert.equal(
    resumeApply.shouldSaveResumeCheckpoint({ block: { task: "  " }, checkpoint: null, lastTurnEndedAt: null }),
    false,
  );
  assert.equal(
    resumeApply.shouldSaveResumeCheckpoint({ block, checkpoint: null, lastTurnEndedAt: null }),
    true,
  );
  assert.equal(
    resumeApply.shouldSaveResumeCheckpoint({
      block,
      checkpoint: { task: "  " },
      lastTurnEndedAt: null,
    }),
    true,
  );
  const old = { task: "old", capturedAt: at(NOW - 2 * HOUR) };
  assert.equal(
    resumeApply.shouldSaveResumeCheckpoint({ block, checkpoint: old, lastTurnEndedAt: at(NOW - HOUR) }),
    true,
    "last turn ended after the checkpoint capture",
  );
  assert.equal(
    resumeApply.shouldSaveResumeCheckpoint({ block, checkpoint: old, lastTurnEndedAt: at(NOW - 3 * HOUR) }),
    false,
    "checkpoint is newer than the last turn",
  );
  assert.equal(
    resumeApply.shouldSaveResumeCheckpoint({ block, checkpoint: { task: "t" }, lastTurnEndedAt: at(NOW) }),
    true,
    "unstamped checkpoint loses to a fresh block",
  );
  assert.equal(
    resumeApply.shouldSaveResumeCheckpoint({ block, checkpoint: old, lastTurnEndedAt: null }),
    true,
    "unknown recency saves: the block is the freshest word",
  );
});

// ---------------------------------------------------------------------------
// applyResume: guards.
// ---------------------------------------------------------------------------

test("applyResume guards workers and unknown agents, refuses running steers", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world);
  const worker = addAgent(world, {
    title: "Worker",
    workspaceId: ws.id,
    labels: { [LABEL.role]: "worker", [LABEL.scope]: REPO },
  });
  const paseo = fakeClient(world);
  await assert.rejects(
    resumeApply.applyResume(paseo, { workspaceId: ws.id, agentId: worker.id }, { lock: noLock }),
    /only for steers/,
  );
  await assert.rejects(
    resumeApply.applyResume(paseo, { workspaceId: ws.id, agentId: "agent-gone" }, { lock: noLock }),
    /Unknown agent/,
  );
  steer.status = "running";
  await assert.rejects(
    resumeApply.applyResume(paseo, { workspaceId: ws.id, agentId: steer.id }, { lock: noLock }),
    /running/,
  );
  assert.equal(world.calls.filter((c) => c[0] === "agent.send").length, 0);
});

test("applyResume is idempotent while a cleanup is pending", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world, {
    checkpoint: { task: "t", tests: [], blockers: [], next: null },
  });
  world.workspaces[0].metadata[AGENTS_KEY] = {
    [steer.id]: { pendingAction: { kind: "clear", at: at(NOW), sessionId: "s", reason: "resume" } },
  };
  const result = await resumeApply.applyResume(
    fakeClient(world),
    { workspaceId: ws.id, agentId: steer.id },
    { lock: noLock },
  );
  assert.equal(result.agentId, steer.id);
  assert.equal(result.cleared, true);
  assert.match(result.detail, /already running/);
  assert.equal(world.calls.filter((c) => c[0] === "agent.send").length, 0);
});

test("applyResume verifies the preview fingerprint when given", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world, {
    checkpoint: { task: "t", tests: [], blockers: [], next: null, capturedAt: at(NOW - HOUR) },
  });
  const good = resumeFingerprint({
    agentId: steer.id,
    status: "idle",
    sessionId: steer.persistence.sessionId,
    checkpointAt: at(NOW - HOUR),
  });
  const calls = [];
  const ok = await resumeApply.applyResume(
    fakeClient(world),
    { workspaceId: ws.id, agentId: steer.id, fingerprint: good },
    { lock: noLock, log: () => {}, runCleanupFn: async (...args) => void calls.push(args) },
  );
  assert.equal(ok.cleared, true);
  assert.equal(calls.length, 1);
  await assert.rejects(
    resumeApply.applyResume(
      fakeClient(world),
      { workspaceId: ws.id, agentId: steer.id, fingerprint: "0".repeat(16) },
      { lock: noLock },
    ),
    /changed since the resume preview/,
  );
});

// ---------------------------------------------------------------------------
// applyResume: checkpoint save + clear vs brief paths.
// ---------------------------------------------------------------------------

test("applyResume saves a newer CHECKPOINT block, keeps a newer scope checkpoint", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world, {
    agents: {},
    checkpoint: { task: "old task", tests: [], blockers: [], next: null, capturedAt: at(NOW - 2 * HOUR) },
  });
  world.workspaces[0].metadata[AGENTS_KEY] = { [steer.id]: { lastTurnEndedAt: at(NOW - HOUR) } };
  world.timelines[steer.id] = [
    { turnId: "t1", item: { type: "user_message", text: "do it" } },
    { turnId: "t1", item: { type: "assistant_message", text: `done\n${CHECKPOINT_TEXT("new task")}` } },
  ];
  const result = await resumeApply.applyResume(
    fakeClient(world),
    { workspaceId: ws.id, agentId: steer.id },
    { lock: noLock, log: () => {}, runCleanupFn: async () => ({ workspaceId: ws.id, sessionId: null, kind: "clear", reason: "resume" }) },
  );
  assert.equal(result.cleared, true);
  assert.match(result.detail, /Checkpoint saved/);
  const written = world.workspaces[0].metadata[CHECKPOINT_KEY];
  assert.equal(written.task, "new task");
  assert.equal(written.source, "resume");

  // Same block, but the scope checkpoint is newer: keep it.
  const world2 = makeWorld();
  const setup2 = provisioned(world2, {
    agents: {},
    checkpoint: { task: "scope task", tests: [], blockers: [], next: null, capturedAt: at(NOW - MIN) },
  });
  world2.workspaces[0].metadata[AGENTS_KEY] = {
    [setup2.steer.id]: { lastTurnEndedAt: at(NOW - HOUR) },
  };
  world2.timelines[setup2.steer.id] = [
    { turnId: "t1", item: { type: "user_message", text: "do it" } },
    { turnId: "t1", item: { type: "assistant_message", text: `done\n${CHECKPOINT_TEXT("stale task")}` } },
  ];
  const kept = await resumeApply.applyResume(
    fakeClient(world2),
    { workspaceId: setup2.ws.id, agentId: setup2.steer.id },
    { lock: noLock, log: () => {}, runCleanupFn: async () => ({ workspaceId: setup2.ws.id, sessionId: null, kind: "clear", reason: "resume" }) },
  );
  assert.equal(kept.cleared, true);
  assert.doesNotMatch(kept.detail, /Checkpoint saved/);
  assert.equal(world2.workspaces[0].metadata[CHECKPOINT_KEY].task, "scope task");
});

test("applyResume clears claude through runCleanup and passes the F4 note", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world);
  const calls = [];
  const result = await resumeApply.applyResume(
    fakeClient(world),
    { workspaceId: ws.id, agentId: steer.id },
    {
      lock: noLock,
      log: () => {},
      note: "wake: worker w-1 done",
      runCleanupFn: async (...args) => {
        calls.push(args);
        return { workspaceId: ws.id, sessionId: "s", kind: "clear", reason: "resume" };
      },
    },
  );
  assert.equal(result.cleared, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], steer.id);
  assert.equal(calls[0][2], "clear");
  assert.equal(calls[0][3], RESUME_PENDING_REASON);
  assert.equal(calls[0][4].note, "wake: worker w-1 done");
});

test("applyResume sends the brief immediately for providers without clear", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world);
  steer.provider = "codex";
  world.workspaces[0].metadata[AGENTS_KEY] = {
    [steer.id]: { needsResume: { reason: "limit", at: at(NOW - HOUR) } },
  };
  const briefs = [];
  const result = await resumeApply.applyResume(
    fakeClient(world),
    { workspaceId: ws.id, agentId: steer.id },
    {
      lock: noLock,
      buildBrief: async (_paseo, workspaceId, agentId) => {
        briefs.push([workspaceId, agentId]);
        return "Resume brief body";
      },
    },
  );
  assert.equal(result.cleared, false);
  assert.match(result.detail, /without clearing/);
  assert.match(result.detail, /codex/);
  assert.deepEqual(briefs, [[ws.id, steer.id]]);
  assert.deepEqual(sendsTo(world, steer.id), ["[Factory resume]\nResume brief body"]);
  assert.equal(world.workspaces[0].metadata[AGENTS_KEY][steer.id].needsResume, null);
});

test("applyResume maps a failed clear to the open-the-tab hint", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world);
  await assert.rejects(
    resumeApply.applyResume(fakeClient(world, { sendFails: true }), { workspaceId: ws.id, agentId: steer.id }, { lock: noLock }),
    /Open its tab, then try again/,
    "real runCleanup send failure surfaces with the hint",
  );
  assert.equal(world.workspaces[0].metadata[AGENTS_KEY][steer.id].lastActionFailed.error, "agent is closed");
});

// ---------------------------------------------------------------------------
// runCleanup extraction (shared by sweep and resume).
// ---------------------------------------------------------------------------

test("runCleanup sends /clear and records pendingAction plus previous sessions", async () => {
  assert.equal(SWEEP_PENDING_REASON, "idle");
  const world = makeWorld();
  const { ws, steer } = provisioned(world);
  world.workspaces[0].metadata[AGENTS_KEY] = { [steer.id]: { previousSessions: ["old"] } };
  const out = await sweep.runCleanup(fakeClient(world), steer.id, "clear", "resume", { lock: noLock });
  assert.equal(out.workspaceId, ws.id);
  assert.equal(out.sessionId, steer.persistence.sessionId);
  assert.deepEqual(sendsTo(world, steer.id), [CLEAR_COMMAND]);
  const entry = world.workspaces[0].metadata[AGENTS_KEY][steer.id];
  assert.equal(entry.pendingAction.kind, "clear");
  assert.equal(entry.pendingAction.reason, "resume");
  assert.equal(entry.pendingAction.sessionId, steer.persistence.sessionId);
  assert.deepEqual(entry.previousSessions, ["old", steer.persistence.sessionId]);
});

test("runCleanup sends /compact without previous sessions and carries a note", async () => {
  const world = makeWorld();
  const { steer } = provisioned(world);
  await sweep.runCleanup(fakeClient(world), steer.id, "compact", "idle", {
    lock: noLock,
    note: "wake note",
  });
  assert.deepEqual(sendsTo(world, steer.id), [COMPACT_COMMAND]);
  const entry = world.workspaces[0].metadata[AGENTS_KEY][steer.id];
  assert.equal(entry.pendingAction.kind, "compact");
  assert.equal(entry.pendingAction.note, "wake note");
  assert.equal(entry.previousSessions, undefined);
});

test("runCleanup on send failure writes lastActionFailed and rethrows", async () => {
  const world = makeWorld();
  const { steer } = provisioned(world);
  await assert.rejects(
    sweep.runCleanup(fakeClient(world, { sendFails: true }), steer.id, "clear", "resume", { lock: noLock }),
    /agent is closed/,
  );
  const entry = world.workspaces[0].metadata[AGENTS_KEY][steer.id];
  assert.equal(entry.lastActionFailed.error, "agent is closed");
  assert.equal(entry.pendingAction, undefined);
  await assert.rejects(
    sweep.runCleanup(fakeClient(world), "agent-gone", "clear", "resume", { lock: noLock }),
    /Unknown agent/,
  );
});
