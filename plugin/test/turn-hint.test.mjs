// Turn-end proactive ZeroSub switch hint: at/above the account window's
// warnPct (with room elsewhere) a completed steer turn sends the handoff
// text, debounced to once per account window. Fake-state tests through
// handleTurnAfter against a fake Paseo client; the live RPC is never touched.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-resolve-hooks.mjs", import.meta.url);

const { handleTurnAfter } = await import("../server/turn-hook.ts");
import { LABEL, METADATA_KEY } from "../../src/paseo.mjs";
import { AGENTS_KEY } from "../../src/agent-state.mjs";
import { normalizeZerosubState } from "../../src/zerosub.mjs";

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

test("a superseded same-slot steer cannot save a scope checkpoint", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const newer = addAgent(world, { title: "Steer A", workspaceId: ws.id, labels: { [LABEL.scope]: REPO, [LABEL.role]: "steer", [LABEL.slot]: "A" } });
  ws.metadata[METADATA_KEY].activeAgentId = newer.id;
  await completedSteerTurn(world, steers, {});
  assert.equal(ws.metadata[`${METADATA_KEY}.checkpoint`], undefined);
});

test("steer turn at warnPct sends the proactive handoff and records the stamp", async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  await completedSteerTurn(world, steers, { getConfig: async () => config, zerosub: zerosubFor(steers, 80) });
  const texts = sendsTo(world, steers.A.id);
  assert.equal(texts.length, 1);
  assert.match(texts[0], /Account acc-a is at 80% of its window \(warn 75%\)/);
  assert.match(texts[0], new RegExp(`switch ${REPO.replace(/[./-]/g, (c) => `\\${c}`)} --to B --apply`));
  assert.equal(world.workspaces[0].metadata[AGENTS_KEY][steers.A.id].proactiveHint.accountId, "acc-a");
});

test("no hint below warnPct, without room, or without ZeroSub", async () => {
  for (const [name, pctA, pctB, zerosub] of [["below-warn", 74, 20, null], ["no-room", 80, 99, null]]) {
    const world = makeWorld();
    const { steers } = provisioned(world);
    await completedSteerTurn(world, steers, { getConfig: async () => config, zerosub: zerosub ?? zerosubFor(steers, pctA, pctB) });
    assert.equal(sendsTo(world, steers.A.id).length, 0, name);
  }
  const world = makeWorld();
  const { steers } = provisioned(world);
  await completedSteerTurn(world, steers, { getConfig: async () => config });
  assert.equal(sendsTo(world, steers.A.id).length, 0, "no-zerosub");
  assert.ok(world.calls.some((c) => c[0] === "workspace.setMetadata"), "turn still recorded");
});

test("hint debounces to once per account window", async () => {
  const world = makeWorld();
  const { steers } = provisioned(world);
  const hinted = {
    [steers.A.id]: {
      proactiveHint: { accountId: "acc-a", at: new Date(Date.now() - 1_000).toISOString(), resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
    },
  };
  world.workspaces[0].metadata[AGENTS_KEY] = structuredClone(hinted);
  await completedSteerTurn(world, steers, { getConfig: async () => config, zerosub: zerosubFor(steers, 80) });
  assert.equal(sendsTo(world, steers.A.id).length, 0, "same window stays quiet");
  // A fresh window (reset passed) re-hints.
  world.workspaces[0].metadata[AGENTS_KEY][steers.A.id].proactiveHint.resetsAt = new Date(Date.now() - 1_000).toISOString();
  await completedSteerTurn(world, steers, { getConfig: async () => config, zerosub: zerosubFor(steers, 80) });
  assert.equal(sendsTo(world, steers.A.id).length, 1, "re-hint after the reset");
});

test("worker turns and failing ZeroSub reads never hint", async () => {
  const world = makeWorld();
  const { ws, steers } = provisioned(world);
  const worker = addAgent(world, {
    title: "Worker", workspaceId: ws.id,
    labels: { [LABEL.role]: "worker", [LABEL.scope]: REPO, [LABEL.owner]: "A" },
  });
  setTurn(world, worker.id, checkpointOf("do it", "done"));
  await handleTurnAfter(
    { agent: { id: worker.id }, turnId: "t1", outcome: { kind: "completed" } },
    { paseo: fakeClient(world) },
    { getConfig: async () => config, zerosub: zerosubFor(steers, 80) },
  );
  assert.equal(world.calls.filter((c) => c[0] === "agent.send").length, 0, "workers get no switch hint");
  setTurn(world, steers.A.id, checkpointOf("ship it", null));
  await handleTurnAfter(
    { agent: { id: steers.A.id }, turnId: "t1", outcome: { kind: "completed" } },
    { paseo: fakeClient(world) },
    { getConfig: async () => config, getZerosub: async () => { throw new Error("offline"); } },
  );
  assert.equal(sendsTo(world, steers.A.id).length, 0, "failing reader stays silent");
  assert.ok(world.calls.some((c) => c[0] === "workspace.setMetadata"), "turn still recorded");
});
