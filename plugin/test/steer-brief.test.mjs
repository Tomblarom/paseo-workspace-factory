// Staged steer briefs (step 3): stage, exactly-once send, dismiss, and the
// restore-after-failure that keeps a retry available. Fake Paseo client only;
// no sends leave the test.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-resolve-hooks.mjs", import.meta.url);

const briefs = await import("../server/steer-brief.ts");
const { factorySteerBrief } = await import("../shared/factory.ts");
const { factorySteerMenuSettings } = await import("../shared/settings.ts");
import { LABEL, METADATA_KEY } from "../../src/paseo.mjs";
import { AGENTS_KEY } from "../../src/agent-state.mjs";

const REPO = "example-owner/example-repo";

function makeWorld() {
  return { workspaces: [], agents: [], calls: [], seq: 0, sendFails: false };
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
    createdAt: new Date().toISOString(),
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
    pendingPermissions: [],
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
        refresh: async () => ({ agent: structuredClone(findAgent(id)) }),
        send: async (text) => {
          world.calls.push(["agent.send", id, text]);
          if (world.sendFails) throw new Error("agent unreachable");
        },
      }),
    },
    providers: { snapshot: async () => ({ entries: [] }) },
  };
}

const noLock = (_name, fn) => fn({ verify() {} });
const sendsTo = (world, id) =>
  world.calls.filter((c) => c[0] === "agent.send" && c[1] === id).map((c) => c[2]);
const stagedOf = (world, wsId, agentId) =>
  world.workspaces.find((w) => w.id === wsId).metadata[AGENTS_KEY]?.[agentId]?.stagedBrief ?? null;

function provisioned(world) {
  const ws = addWorkspace(world, {
    metadata: { [METADATA_KEY]: { main: true, activeSteer: "A", epoch: 1 } },
  });
  const steer = addAgent(world, {
    title: "Steer B",
    workspaceId: ws.id,
    labels: { [LABEL.repo]: REPO, [LABEL.role]: "steer", [LABEL.slot]: "B", [LABEL.scope]: REPO },
  });
  return { ws, steer };
}

// ---------------------------------------------------------------------------
// Contracts and settings
// ---------------------------------------------------------------------------

test("factory.steer.brief contract validates send and dismiss", () => {
  assert.equal(factorySteerBrief.name, "factory.steer.brief");
  assert.deepEqual(
    factorySteerBrief.input.parse({ workspaceId: "w", agentId: "a", action: "send" }),
    { workspaceId: "w", agentId: "a", action: "send" },
  );
  assert.deepEqual(
    factorySteerBrief.output.parse({ agentId: "a", delivered: true, detail: "d" }),
    { agentId: "a", delivered: true, detail: "d" },
  );
  assert.throws(() => factorySteerBrief.input.parse({ workspaceId: "w", agentId: "a", action: "drop" }));
});

test("the steer menu settings default to composer staging without history", () => {
  assert.equal(factorySteerMenuSettings.id, "factory-steer-menu");
  assert.equal(factorySteerMenuSettings.scope, "host");
  assert.deepEqual(factorySteerMenuSettings.schema.parse({}), {
    initializeNewSteer: "composer",
    keepChatHistory: false,
  });
});

// ---------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------

test("stage stores the packet for the steer", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world);
  const paseo = fakeClient(world);
  await briefs.stageSteerBrief(
    paseo,
    { workspaceId: ws.id, agentId: steer.id, packet: "PACKET", kind: "switch" },
    { lock: noLock, now: () => "2026-11-25T12:00:00.000Z" },
  );
  assert.deepEqual(stagedOf(world, ws.id, steer.id), {
    packet: "PACKET",
    at: "2026-11-25T12:00:00.000Z",
    kind: "switch",
  });
  assert.deepEqual(sendsTo(world, steer.id), [], "staging sends nothing");
});

test("stage refuses empty packets, unknown agents and non-steers", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world);
  const worker = addAgent(world, {
    title: "Worker",
    workspaceId: ws.id,
    labels: { [LABEL.scope]: REPO, [LABEL.role]: "worker", [LABEL.owner]: "A" },
  });
  const paseo = fakeClient(world);
  await assert.rejects(
    briefs.stageSteerBrief(paseo, { workspaceId: ws.id, agentId: steer.id, packet: "  ", kind: "switch" }, { lock: noLock }),
    /Nothing to stage/,
  );
  await assert.rejects(
    briefs.stageSteerBrief(paseo, { workspaceId: ws.id, agentId: "agt_nope", packet: "P", kind: "switch" }, { lock: noLock }),
    /Unknown agent/,
  );
  await assert.rejects(
    briefs.stageSteerBrief(paseo, { workspaceId: ws.id, agentId: worker.id, packet: "P", kind: "switch" }, { lock: noLock }),
    /only for steers/,
  );
});

// ---------------------------------------------------------------------------
// Deliver
// ---------------------------------------------------------------------------

test("send delivers the staged packet exactly once", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world);
  const paseo = fakeClient(world);
  await briefs.stageSteerBrief(
    paseo,
    { workspaceId: ws.id, agentId: steer.id, packet: "PACKET", kind: "fresh" },
    { lock: noLock },
  );
  const first = await briefs.deliverSteerBrief(
    paseo,
    { workspaceId: ws.id, agentId: steer.id, action: "send" },
    { lock: noLock },
  );
  assert.deepEqual(first, {
    agentId: steer.id,
    delivered: true,
    dismissed: false,
    detail: "Staged brief sent.",
  });
  assert.deepEqual(sendsTo(world, steer.id), ["PACKET"]);
  assert.equal(stagedOf(world, ws.id, steer.id), null);
  const second = await briefs.deliverSteerBrief(
    paseo,
    { workspaceId: ws.id, agentId: steer.id, action: "send" },
    { lock: noLock },
  );
  assert.equal(second.delivered, false);
  assert.match(second.detail, /already sent or dismissed/);
  assert.deepEqual(sendsTo(world, steer.id), ["PACKET"], "no duplicate send");
});

test("send with nothing staged stays quiet", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world);
  const sent = await briefs.deliverSteerBrief(
    fakeClient(world),
    { workspaceId: ws.id, agentId: steer.id, action: "send" },
    { lock: noLock },
  );
  assert.equal(sent.delivered, false);
  assert.equal(sent.dismissed, false);
  assert.deepEqual(sendsTo(world, steer.id), []);
});

test("dismiss drops the packet without sending", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world);
  const paseo = fakeClient(world);
  await briefs.stageSteerBrief(
    paseo,
    { workspaceId: ws.id, agentId: steer.id, packet: "PACKET", kind: "switch" },
    { lock: noLock },
  );
  const dismissed = await briefs.deliverSteerBrief(
    paseo,
    { workspaceId: ws.id, agentId: steer.id, action: "dismiss" },
    { lock: noLock },
  );
  assert.deepEqual(dismissed, {
    agentId: steer.id,
    delivered: false,
    dismissed: true,
    detail: "Staged brief dismissed.",
  });
  assert.deepEqual(sendsTo(world, steer.id), []);
  const after = await briefs.deliverSteerBrief(
    paseo,
    { workspaceId: ws.id, agentId: steer.id, action: "send" },
    { lock: noLock },
  );
  assert.equal(after.delivered, false);
});

test("a failed send restores the packet, so the retry stays available", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world);
  const paseo = fakeClient(world);
  await briefs.stageSteerBrief(
    paseo,
    { workspaceId: ws.id, agentId: steer.id, packet: "PACKET", kind: "fresh" },
    { lock: noLock },
  );
  world.sendFails = true;
  await assert.rejects(
    briefs.deliverSteerBrief(paseo, { workspaceId: ws.id, agentId: steer.id, action: "send" }, { lock: noLock }),
    /still staged/,
  );
  assert.equal(stagedOf(world, ws.id, steer.id)?.packet, "PACKET");
  world.sendFails = false;
  const retry = await briefs.deliverSteerBrief(
    paseo,
    { workspaceId: ws.id, agentId: steer.id, action: "send" },
    { lock: noLock },
  );
  assert.equal(retry.delivered, true);
  assert.deepEqual(sendsTo(world, steer.id), ["PACKET", "PACKET"]);
});

test("the restore keeps a newer concurrent stage", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world);
  const inner = fakeClient(world);
  let staged = false;
  const paseo = {
    ...inner,
    agents: {
      ...inner.agents,
      ref: (id) => ({
        ...inner.agents.ref(id),
        send: async (text) => {
          // A concurrent stage lands while the first send is in flight.
          if (!staged) {
            staged = true;
            await briefs.stageSteerBrief(
              inner,
              { workspaceId: ws.id, agentId: steer.id, packet: "NEWER", kind: "switch" },
              { lock: noLock },
            );
          }
          world.calls.push(["agent.send", id, text]);
          throw new Error("agent unreachable");
        },
      }),
    },
  };
  await briefs.stageSteerBrief(
    inner,
    { workspaceId: ws.id, agentId: steer.id, packet: "OLDER", kind: "switch" },
    { lock: noLock },
  );
  await assert.rejects(
    briefs.deliverSteerBrief(paseo, { workspaceId: ws.id, agentId: steer.id, action: "send" }, { lock: noLock }),
    /still staged/,
  );
  assert.equal(stagedOf(world, ws.id, steer.id)?.packet, "NEWER");
  const retry = await briefs.deliverSteerBrief(
    inner,
    { workspaceId: ws.id, agentId: steer.id, action: "send" },
    { lock: noLock },
  );
  assert.equal(retry.delivered, true);
  assert.deepEqual(sendsTo(world, steer.id), ["OLDER", "NEWER"]);
});

test("deliver refuses unknown agents and non-steers", async () => {
  const world = makeWorld();
  const { ws } = provisioned(world);
  const worker = addAgent(world, {
    title: "Worker",
    workspaceId: ws.id,
    labels: { [LABEL.scope]: REPO, [LABEL.role]: "worker", [LABEL.owner]: "A" },
  });
  const paseo = fakeClient(world);
  await assert.rejects(
    briefs.deliverSteerBrief(paseo, { workspaceId: ws.id, agentId: "agt_nope", action: "send" }, { lock: noLock }),
    /Unknown agent/,
  );
  await assert.rejects(
    briefs.deliverSteerBrief(paseo, { workspaceId: ws.id, agentId: worker.id, action: "send" }, { lock: noLock }),
    /only for steers/,
  );
});
