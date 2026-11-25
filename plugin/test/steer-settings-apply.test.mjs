// Step-4 settings server: preview, apply (Apply here vs bound Refresh) and
// revert with apply-time rechecks. Fake Paseo client and injected daemon
// clients only; no sends leave the test, no live paired runs.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-resolve-hooks.mjs", import.meta.url);

const settings = await import("../server/steer-settings.ts");
const { factorySteerSettings, factorySteerSettingsPreview, factorySteerSettingsRevert } = await import("../shared/factory.ts");
import { LABEL, METADATA_KEY } from "../../src/paseo.mjs";
import { AGENTS_KEY } from "../../src/agent-state.mjs";

const REPO = "example-owner/example-repo";
const NOW = Date.parse("2026-11-25T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60_000;

const CATALOG = [
  {
    provider: "codex",
    enabled: true,
    status: "ready",
    models: [
      { id: "gpt-6.2-sol", thinkingOptions: [{ id: "high" }, { id: "low" }] },
      { id: "gpt-5.5", thinkingOptions: [] },
    ],
  },
  {
    provider: "claude",
    enabled: true,
    status: "ready",
    models: [{ id: "claude-opus-4-6", thinkingOptions: [{ id: "think" }] }],
  },
];

function makeWorld() {
  return { workspaces: [], agents: [], calls: [], seq: 0, catalog: CATALOG };
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
    createdAt: iso(NOW - 60 * MIN),
  };
  world.workspaces.push(ws);
  return ws;
}

function addAgent(world, fields) {
  const agent = {
    id: `agent-${++world.seq}`,
    provider: "codex",
    model: "gpt-6.2-sol",
    thinkingOptionId: "high",
    effectiveThinkingOptionId: "high",
    options: {},
    persistence: { sessionId: "sess-1" },
    status: "idle",
    archivedAt: null,
    labels: {},
    pendingPermissions: [],
    lastUsage: { contextWindowUsedTokens: 5000 },
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
          world.calls.push(["agent.send", id, text]);
        },
        timeline: { refetch: async () => ({ entries: [] }) },
      }),
    },
    providers: { snapshot: async () => ({ entries: structuredClone(world.catalog) }) },
  };
}

const noLock = (_name, fn) => fn({ verify() {} });

function provisioned(world, { entry = {}, agentFields = {}, wsf = {} } = {}) {
  const ws = addWorkspace(world, {
    metadata: {
      [METADATA_KEY]: { main: wsPlaceholder(), activeSteer: "A", epoch: 3, scope: { id: REPO, kind: "github" }, ...wsf },
      [AGENTS_KEY]: {},
    },
  });
  // The workspace id is only known after creation; patch main + entries.
  ws.metadata[METADATA_KEY].main = ws.id;
  const steer = addAgent(world, {
    title: "Steer A",
    workspaceId: ws.id,
    labels: { [LABEL.repo]: REPO, [LABEL.role]: "steer", [LABEL.slot]: "A", [LABEL.scope]: REPO },
    ...agentFields,
  });
  ws.metadata[AGENTS_KEY] = { [steer.id]: structuredClone(entry) };
  return { ws, steer };
}

function wsPlaceholder() {
  return "wks_main";
}

const depsOf = (over = {}) => ({
  lock: noLock,
  now: () => iso(NOW),
  nowMs: () => NOW,
  loadCatalog: async () => structuredClone(CATALOG),
  getCleanupSettings: async () => ({ profile: "balanced", minContextTokens: 60000 }),
  getConfig: async () => ({ steers: { slots: { A: "p" } }, profiles: { p: {} } }),
  getZerosub: async () => null,
  buildBrief: async () => "BRIEF",
  ...over,
});

const sendsTo = (world, id) =>
  world.calls.filter((c) => c[0] === "agent.send" && c[1] === id).map((c) => c[2]);
const entryOf = (world, wsId, agentId) =>
  world.workspaces.find((w) => w.id === wsId).metadata[AGENTS_KEY]?.[agentId] ?? null;

/** DaemonClient fake for model/thinking/options writes; mutates the world agent. */
function configClientFor(world, { fail = {} } = {}) {
  return async () => ({
    calls: world.calls,
    async setAgentModel(agentId, model) {
      world.calls.push(["setAgentModel", agentId, model]);
      if (fail.model) throw new Error(fail.model);
      world.agents.find((a) => a.id === agentId).model = model;
    },
    async setAgentThinkingOption(agentId, thinking) {
      world.calls.push(["setAgentThinkingOption", agentId, thinking]);
      if (fail.thinking) throw new Error(fail.thinking);
      const agent = world.agents.find((a) => a.id === agentId);
      agent.thinkingOptionId = thinking;
      agent.effectiveThinkingOptionId = thinking;
    },
    async setAgentOptions(agentId, patch) {
      world.calls.push(["setAgentOptions", agentId, structuredClone(patch)]);
      if (fail.speed) throw new Error(fail.speed);
      Object.assign(world.agents.find((a) => a.id === agentId).options, structuredClone(patch));
    },
    async close() {},
  });
}

/** DaemonClient fake for the bound rewind. */
function rewindClientFor(world, { outcome = "rewound", sent = [] } = {}) {
  return async () => ({
    async fetchAgentTimeline() {
      return { entries: [{ item: { type: "user_message", messageId: "msg-1" } }] };
    },
    async rewindAgent(agentId, messageId) {
      world.calls.push(["rewindAgent", agentId, messageId]);
      if (outcome === "unsupported") throw new Error("rewind not supported");
      if (outcome === "failed") throw new Error("rewind exploded");
    },
    async sendMessage(agentId, text) {
      sent.push([agentId, text]);
      world.calls.push(["daemon.sendMessage", agentId, text]);
    },
    async close() {},
    __outcome: outcome,
  });
}

// The real rewindAndBrief reads the timeline through the injected client;
// for no-point outcomes return an empty timeline instead.
function rewindClientNoPoint(world) {
  return async () => ({
    async fetchAgentTimeline() {
      return { entries: [] };
    },
    async rewindAgent(agentId, messageId) {
      world.calls.push(["rewindAgent", agentId, messageId]);
    },
    async close() {},
  });
}

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

test("settings RPC contracts validate preview, apply and revert", () => {
  assert.equal(factorySteerSettingsPreview.name, "factory.steer.settings.preview");
  assert.equal(factorySteerSettings.name, "factory.steer.settings");
  assert.equal(factorySteerSettingsRevert.name, "factory.steer.settings.revert");
  assert.deepEqual(
    factorySteerSettingsPreview.input.parse({ workspaceId: "w", agentId: "a", thinking: null }),
    { workspaceId: "w", agentId: "a", thinking: null },
  );
  assert.throws(() => factorySteerSettings.input.parse({ workspaceId: "w", agentId: "a", fingerprint: "f", route: "new-tab" }));
  assert.throws(() => factorySteerSettingsRevert.input.parse({ workspaceId: "w", agentId: "a" }));
});

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

test("preview reports a no-op with the catalog choices", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world, { entry: { lastTurnEndedAt: iso(NOW - 5 * MIN) } });
  const preview = await settings.previewSteerSettings(
    fakeClient(world),
    { workspaceId: ws.id, agentId: steer.id },
    depsOf(),
  );
  assert.equal(preview.noop, true);
  assert.equal(preview.route, "apply-here");
  assert.deepEqual(preview.models, ["gpt-6.2-sol", "gpt-5.5"]);
  assert.deepEqual(preview.thinkingOptions, ["high", "low"]);
  assert.ok(preview.fingerprint);
});

test("preview routes a small cold change to Apply here", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world, { entry: { lastTurnEndedAt: iso(NOW - 120 * MIN) } });
  const preview = await settings.previewSteerSettings(
    fakeClient(world),
    { workspaceId: ws.id, agentId: steer.id, thinking: "low" },
    depsOf(),
  );
  assert.equal(preview.noop, false);
  assert.equal(preview.route, "apply-here");
  assert.equal(preview.requested.thinking, "low");
  assert.equal(preview.cacheRisk, true);
});

test("preview routes warm, large and unknown contexts to Refresh", async () => {
  const world = makeWorld();
  const warm = provisioned(world, { entry: { lastTurnEndedAt: iso(NOW - 5 * MIN) } });
  const warmPreview = await settings.previewSteerSettings(
    fakeClient(world),
    { workspaceId: warm.ws.id, agentId: warm.steer.id, thinking: "low" },
    depsOf(),
  );
  assert.equal(warmPreview.route, "refresh");

  const world2 = makeWorld();
  const large = provisioned(world2, {
    entry: { lastTurnEndedAt: iso(NOW - 120 * MIN) },
    agentFields: { lastUsage: { contextWindowUsedTokens: 90000 } },
  });
  const largePreview = await settings.previewSteerSettings(
    fakeClient(world2),
    { workspaceId: large.ws.id, agentId: large.steer.id, thinking: "low" },
    depsOf(),
  );
  assert.equal(largePreview.route, "refresh");

  const world3 = makeWorld();
  const unknown = provisioned(world3, {
    entry: { lastTurnEndedAt: iso(NOW - 120 * MIN) },
    agentFields: { lastUsage: null },
  });
  const unknownPreview = await settings.previewSteerSettings(
    fakeClient(world3),
    { workspaceId: unknown.ws.id, agentId: unknown.steer.id, thinking: "low" },
    depsOf(),
  );
  assert.equal(unknownPreview.route, "refresh");
});

test("preview flags the efficiency lock from the feed", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world, { entry: { lastTurnEndedAt: iso(NOW - 5 * MIN) } });
  const preview = await settings.previewSteerSettings(
    fakeClient(world),
    { workspaceId: ws.id, agentId: steer.id, thinking: "low" },
    depsOf({ getCleanupSettings: async () => ({ profile: "efficiency", minContextTokens: 60000 }) }),
  );
  assert.equal(preview.efficiencyLocked, true);
  assert.match(preview.lockReason, /Maximum efficiency/);
  assert.equal(preview.route, "refresh");
});

test("preview rejects unsupported settings without writing", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world, { entry: { lastTurnEndedAt: iso(NOW - 120 * MIN) } });
  await assert.rejects(
    settings.previewSteerSettings(fakeClient(world), { workspaceId: ws.id, agentId: steer.id, model: "gpt-9" }, depsOf()),
    /not offered by codex/,
  );
  await assert.rejects(
    settings.previewSteerSettings(fakeClient(world), { workspaceId: ws.id, agentId: steer.id, thinking: "ultra" }, depsOf()),
    /not available/,
  );
  assert.equal(world.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Apply here
// ---------------------------------------------------------------------------

test("apply-here writes and verifies the tuple, then stores baseline and confirmation", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world, { entry: { lastTurnEndedAt: iso(NOW - 120 * MIN) } });
  const client = fakeClient(world);
  const preview = await settings.previewSteerSettings(client, { workspaceId: ws.id, agentId: steer.id, thinking: "low" }, depsOf());
  assert.equal(preview.route, "apply-here");
  const applied = await settings.applySteerSettings(client, {
    workspaceId: ws.id,
    agentId: steer.id,
    fingerprint: preview.fingerprint,
    route: "apply-here",
    thinking: "low",
  }, depsOf({ configClient: configClientFor(world) }));
  assert.equal(applied.applied, true);
  assert.equal(applied.verified, true);
  assert.deepEqual(applied.current, { provider: "codex", model: "gpt-6.2-sol", thinking: "low", speed: null });
  assert.deepEqual(sendsTo(world, steer.id), []);
  const entry = entryOf(world, ws.id, steer.id);
  assert.equal(entry.settingsBaseline.thinking, "low");
  assert.equal(entry.settingsBaseline.sessionId, "sess-1");
  assert.equal(entry.settingsConfirmed.thinking, "low");
  assert.equal(entry.settingsConfirmed.fingerprint, preview.fingerprint);
  const kinds = world.calls.map((c) => c[0]);
  assert.ok(kinds.includes("setAgentThinkingOption"));
  assert.ok(!kinds.includes("setAgentModel"));
});

test("a no-op apply writes nothing", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world, { entry: { lastTurnEndedAt: iso(NOW - 120 * MIN) } });
  const client = fakeClient(world);
  const preview = await settings.previewSteerSettings(client, { workspaceId: ws.id, agentId: steer.id }, depsOf());
  const callsBefore = world.calls.length;
  const applied = await settings.applySteerSettings(client, {
    workspaceId: ws.id,
    agentId: steer.id,
    fingerprint: preview.fingerprint,
    route: "apply-here",
  }, depsOf({ configClient: configClientFor(world) }));
  assert.equal(applied.noop, true);
  assert.equal(applied.verified, true);
  assert.equal(world.calls.length, callsBefore);
});

test("a partial write reports what landed and what is missing", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world, { entry: { lastTurnEndedAt: iso(NOW - 120 * MIN) } });
  const client = fakeClient(world);
  const preview = await settings.previewSteerSettings(
    client,
    { workspaceId: ws.id, agentId: steer.id, model: "gpt-5.5", thinking: null },
    depsOf(),
  );
  // gpt-5.5 offers no thinking options, so thinking:null is the only valid
  // request; fail the model write to force a partial result.
  const applied = await settings.applySteerSettings(client, {
    workspaceId: ws.id,
    agentId: steer.id,
    fingerprint: preview.fingerprint,
    route: preview.route,
    model: "gpt-5.5",
    thinking: null,
  }, depsOf({ configClient: configClientFor(world, { fail: { model: "provider refused" } }) }));
  assert.equal(applied.applied, true);
  assert.equal(applied.verified, false);
  assert.match(applied.detail, /partly applied|not applied/);
  assert.match(applied.detail, /provider refused/);
});

test("apply refuses a stale preview instead of writing", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world, { entry: { lastTurnEndedAt: iso(NOW - 120 * MIN) } });
  const client = fakeClient(world);
  await assert.rejects(
    settings.applySteerSettings(client, {
      workspaceId: ws.id,
      agentId: steer.id,
      fingerprint: "deadbeefdeadbeef",
      route: "apply-here",
      thinking: "low",
    }, depsOf({ configClient: configClientFor(world) })),
    /Something changed since the settings preview/,
  );
  assert.ok(!world.calls.some((c) => String(c[0]).startsWith("setAgent")));
});

// ---------------------------------------------------------------------------
// Apply-time rechecks
// ---------------------------------------------------------------------------

test("apply rechecks busy state under the scope lock", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world, { entry: { lastTurnEndedAt: iso(NOW - 120 * MIN) } });
  const client = fakeClient(world);
  const preview = await settings.previewSteerSettings(client, { workspaceId: ws.id, agentId: steer.id, thinking: "low" }, depsOf());
  world.agents.find((a) => a.id === steer.id).status = "running";
  await assert.rejects(
    settings.applySteerSettings(client, {
      workspaceId: ws.id,
      agentId: steer.id,
      fingerprint: preview.fingerprint,
      route: "apply-here",
      thinking: "low",
    }, depsOf({ configClient: configClientFor(world) })),
    /running/,
  );
  assert.ok(!world.calls.some((c) => String(c[0]).startsWith("setAgent")));
});

test("apply rechecks pending permissions under the scope lock", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world, { entry: { lastTurnEndedAt: iso(NOW - 120 * MIN) } });
  const client = fakeClient(world);
  const preview = await settings.previewSteerSettings(client, { workspaceId: ws.id, agentId: steer.id, thinking: "low" }, depsOf());
  world.agents.find((a) => a.id === steer.id).pendingPermissions = [{ id: "perm-1" }];
  await assert.rejects(
    settings.applySteerSettings(client, {
      workspaceId: ws.id,
      agentId: steer.id,
      fingerprint: preview.fingerprint,
      route: "apply-here",
      thinking: "low",
    }, depsOf({ configClient: configClientFor(world) })),
    /permission request is waiting/,
  );
  assert.ok(!world.calls.some((c) => String(c[0]).startsWith("setAgent")));
});

test("a refresh apply rechecks quota under the scope lock", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world, { entry: { lastTurnEndedAt: iso(NOW - 5 * MIN) } });
  const client = fakeClient(world);
  const preview = await settings.previewSteerSettings(client, { workspaceId: ws.id, agentId: steer.id, thinking: "low" }, depsOf());
  assert.equal(preview.route, "refresh");
  const depleted = {
    codex: { sessionPct: 95, resetsAt: iso(NOW + 60 * MIN) },
  };
  await assert.rejects(
    settings.applySteerSettings(client, {
      workspaceId: ws.id,
      agentId: steer.id,
      fingerprint: preview.fingerprint,
      route: "refresh",
      thinking: "low",
    }, depsOf({
      configClient: configClientFor(world),
      rewindClient: rewindClientFor(world),
      quotaSnapshot: depleted,
      poolSampledAtMs: NOW,
      quotaSampleMinutes: 10,
    })),
    /Quota depleted/,
  );
  assert.ok(!world.calls.some((c) => c[0] === "rewindAgent"));
  assert.ok(!world.calls.some((c) => String(c[0]).startsWith("setAgent")));
});

test("apply-here refuses a warm context that cooled into the preview", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world, { entry: { lastTurnEndedAt: iso(NOW - 120 * MIN) } });
  const client = fakeClient(world);
  const preview = await settings.previewSteerSettings(client, { workspaceId: ws.id, agentId: steer.id, thinking: "low" }, depsOf());
  assert.equal(preview.route, "apply-here");
  // A fresh turn lands before the apply: the recomputed preview now routes
  // to refresh, so the quoted apply-here fingerprint no longer binds.
  world.workspaces.find((w) => w.id === ws.id).metadata[AGENTS_KEY][steer.id].lastTurnEndedAt = iso(NOW - MIN);
  await assert.rejects(
    settings.applySteerSettings(client, {
      workspaceId: ws.id,
      agentId: steer.id,
      fingerprint: preview.fingerprint,
      route: "apply-here",
      thinking: "low",
    }, depsOf({ configClient: configClientFor(world) })),
    /Something changed since the settings preview/,
  );
});

// ---------------------------------------------------------------------------
// Bound refresh
// ---------------------------------------------------------------------------

test("a bound refresh rewinds, applies, verifies and stages the brief", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world, { entry: { lastTurnEndedAt: iso(NOW - 5 * MIN) } });
  const client = fakeClient(world);
  const preview = await settings.previewSteerSettings(client, { workspaceId: ws.id, agentId: steer.id, thinking: "low" }, depsOf());
  assert.equal(preview.route, "refresh");
  const applied = await settings.applySteerSettings(client, {
    workspaceId: ws.id,
    agentId: steer.id,
    fingerprint: preview.fingerprint,
    route: "refresh",
    thinking: "low",
    deliver: "stage",
  }, depsOf({ configClient: configClientFor(world), rewindClient: rewindClientFor(world) }));
  assert.equal(applied.applied, true);
  assert.equal(applied.verified, true);
  assert.equal(applied.delivered, false);
  assert.equal(applied.staged, true);
  assert.equal(applied.packet, "BRIEF");
  assert.ok(world.calls.some((c) => c[0] === "rewindAgent"));
  assert.ok(world.calls.some((c) => c[0] === "setAgentThinkingOption"));
  assert.deepEqual(sendsTo(world, steer.id), []);
  const entry = entryOf(world, ws.id, steer.id);
  assert.equal(entry.action?.facts?.cleared?.mode, "rewind");
  assert.equal(entry.action?.packet, "BRIEF");
  assert.equal(entry.settingsBaseline.thinking, "low");
});

test("a bound refresh that cannot rewind fails without a new agent and keeps the brief", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world, { entry: { lastTurnEndedAt: iso(NOW - 5 * MIN) } });
  const client = fakeClient(world);
  const preview = await settings.previewSteerSettings(client, { workspaceId: ws.id, agentId: steer.id, thinking: "low" }, depsOf());
  await assert.rejects(
    settings.applySteerSettings(client, {
      workspaceId: ws.id,
      agentId: steer.id,
      fingerprint: preview.fingerprint,
      route: "refresh",
      thinking: "low",
      deliver: "stage",
    }, depsOf({ configClient: configClientFor(world), rewindClient: rewindClientNoPoint(world) })),
    /Bound rewind route failed \(no-point\).*brief is staged/,
  );
  // No config write, no send, no new agent: the brief is staged for retry.
  assert.ok(!world.calls.some((c) => String(c[0]).startsWith("setAgent")));
  assert.deepEqual(sendsTo(world, steer.id), []);
  assert.equal(entryOf(world, ws.id, steer.id).action?.packet, "BRIEF");
});

test("an unsupported rewind fails the same bound way", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world, { entry: { lastTurnEndedAt: iso(NOW - 5 * MIN) } });
  const client = fakeClient(world);
  const preview = await settings.previewSteerSettings(client, { workspaceId: ws.id, agentId: steer.id, thinking: "low" }, depsOf());
  await assert.rejects(
    settings.applySteerSettings(client, {
      workspaceId: ws.id,
      agentId: steer.id,
      fingerprint: preview.fingerprint,
      route: "refresh",
      thinking: "low",
      deliver: "stage",
    }, depsOf({ configClient: configClientFor(world), rewindClient: rewindClientFor(world, { outcome: "unsupported" }) })),
    /Bound rewind route failed \(failed/,
  );
  assert.equal(entryOf(world, ws.id, steer.id).action?.packet, "BRIEF");
});

// ---------------------------------------------------------------------------
// Revert
// ---------------------------------------------------------------------------

function observedWorld() {
  const world = makeWorld();
  const { ws, steer } = provisioned(world, {
    entry: {
      lastTurnEndedAt: iso(NOW - 120 * MIN),
      settingsBaseline: {
        provider: "codex",
        model: "gpt-6.2-sol",
        thinking: "high",
        speed: null,
        sessionId: "sess-1",
        turnId: "t-1",
        at: iso(NOW - 120 * MIN),
      },
    },
    agentFields: { thinkingOptionId: "low", effectiveThinkingOptionId: "low" },
  });
  return { world, ws, steer };
}

test("revert restores the baseline and verifies it", async () => {
  const { world, ws, steer } = observedWorld();
  const client = fakeClient(world);
  const reverted = await settings.revertSteerSettings(client, {
    workspaceId: ws.id,
    agentId: steer.id,
    observed: { provider: "codex", model: "gpt-6.2-sol", thinking: "low", speed: null, sessionId: "sess-1" },
  }, depsOf({ configClient: configClientFor(world) }));
  assert.equal(reverted.applied, true);
  assert.equal(reverted.verified, true);
  assert.deepEqual(reverted.restored, { provider: "codex", model: "gpt-6.2-sol", thinking: "high", speed: null });
  assert.equal(world.agents.find((a) => a.id === steer.id).thinkingOptionId, "high");
  assert.equal(entryOf(world, ws.id, steer.id).settingsBaseline.thinking, "high");
});

test("revert refuses a newer change before reverting", async () => {
  const { world, ws, steer } = observedWorld();
  // The settings changed again after the warning: live is now ultra.
  world.agents.find((a) => a.id === steer.id).thinkingOptionId = "ultra";
  world.agents.find((a) => a.id === steer.id).effectiveThinkingOptionId = "ultra";
  const client = fakeClient(world);
  await assert.rejects(
    settings.revertSteerSettings(client, {
      workspaceId: ws.id,
      agentId: steer.id,
      observed: { provider: "codex", model: "gpt-6.2-sol", thinking: "low", speed: null, sessionId: "sess-1" },
    }, depsOf({ configClient: configClientFor(world) })),
    /changed again/,
  );
  assert.ok(!world.calls.some((c) => String(c[0]).startsWith("setAgent")));
});

test("revert is idempotent once live matches the baseline", async () => {
  const { world, ws, steer } = observedWorld();
  world.agents.find((a) => a.id === steer.id).thinkingOptionId = "high";
  world.agents.find((a) => a.id === steer.id).effectiveThinkingOptionId = "high";
  const client = fakeClient(world);
  const reverted = await settings.revertSteerSettings(client, {
    workspaceId: ws.id,
    agentId: steer.id,
    observed: { provider: "codex", model: "gpt-6.2-sol", thinking: "low", speed: null, sessionId: "sess-1" },
  }, depsOf({ configClient: configClientFor(world) }));
  assert.equal(reverted.applied, false);
  assert.equal(reverted.verified, true);
  assert.match(reverted.detail, /already match/);
  assert.ok(!world.calls.some((c) => String(c[0]).startsWith("setAgent")));
});

test("revert refuses a running tab and a missing baseline", async () => {
  const busy = observedWorld();
  busy.world.agents.find((a) => a.id === busy.steer.id).status = "running";
  await assert.rejects(
    settings.revertSteerSettings(fakeClient(busy.world), {
      workspaceId: busy.ws.id,
      agentId: busy.steer.id,
      observed: { provider: "codex", model: "gpt-6.2-sol", thinking: "low", speed: null, sessionId: "sess-1" },
    }, depsOf({ configClient: configClientFor(busy.world) })),
    /running/,
  );

  const fresh = makeWorld();
  const { ws, steer } = provisioned(fresh, { entry: { lastTurnEndedAt: iso(NOW - 120 * MIN) } });
  await assert.rejects(
    settings.revertSteerSettings(fakeClient(fresh), {
      workspaceId: ws.id,
      agentId: steer.id,
      observed: { provider: "codex", model: "gpt-6.2-sol", thinking: "low", speed: null, sessionId: "sess-1" },
    }, depsOf({ configClient: configClientFor(fresh) })),
    /No comparable settings baseline/,
  );
});
