// Staged steer briefs (step 3): stage, exactly-once send, dismiss, and the
// restore-after-failure that keeps a retry available. Fake Paseo client only;
// no sends leave the test.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-resolve-hooks.mjs", import.meta.url);

const briefs = await import("../server/steer-brief.ts");
const { factorySteerBrief, factorySteerDelivery } = await import("../shared/factory.ts");
const { factorySteerMenuSettings } = await import("../shared/settings.ts");
import { LABEL, METADATA_KEY } from "../server/core/paseo.mjs";
import { AGENTS_KEY } from "../server/core/agent-state.mjs";

const { transferStagedBrief } = await import("../client/steer-menu.ts");

const { finishSteerDelivery } = await import("../server/steer-delivery.ts");

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
const stagedOf = (world, wsId, agentId) => {
  const action = world.workspaces.find((w) => w.id === wsId).metadata[AGENTS_KEY]?.[agentId]?.action;
  return action?.phase === "staged" ? { packet: action.packet, at: action.at, kind: action.stageKind } : null;
};

function stageTarget(ws, steer) {
  const stage = ws.metadata[AGENTS_KEY][steer.id].action;
  return { workspaceId: ws.id, agentId: steer.id, stageId: stage.wakeId, epoch: stage.epoch };
}

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

test("factory.steer.brief requires the original ID and epoch for delivery", () => {
  assert.equal(factorySteerBrief.name, "factory.steer.brief");
  const send = { workspaceId: "w", agentId: "a", action: "send" };
  assert.throws(() => factorySteerBrief.input.parse(send));
  assert.throws(() => factorySteerBrief.input.parse({ ...send, stageId: "stage" }));
  assert.throws(() => factorySteerBrief.input.parse({ ...send, epoch: 1 }));
  const bound = { ...send, stageId: "stage", epoch: 1 };
  assert.deepEqual(
    factorySteerBrief.input.parse(bound),
    bound,
  );
  assert.deepEqual(
    factorySteerBrief.output.parse({ agentId: "a", delivered: true, detail: "d" }),
    { agentId: "a", delivered: true, detail: "d" },
  );
  assert.throws(() => factorySteerBrief.input.parse({ workspaceId: "w", agentId: "a", action: "drop" }));
});

test("delivery contracts do not let a caller attest payload provenance", () => {
  const claimed = { sanitized: true, sourceProvider: "codex", purpose: "advisor" };
  const delivery = { workspaceId: "w", agentId: "a", epoch: 3, text: "SYNTHETIC_PRIVATE_LOG" };
  assert.deepEqual(factorySteerDelivery.input.parse({ ...delivery, ...claimed }), delivery);
  const staged = { workspaceId: "w", agentId: "a", action: "composer", stageId: "stage", epoch: 3, claimId: "claim" };
  assert.deepEqual(factorySteerBrief.input.parse({ ...staged, ...claimed }), staged);
});

test("new steer menu settings default to continue and keep history while migrated hosts keep new automatic effects inactive", () => {
  assert.equal(factorySteerMenuSettings.id, "factory-steer-menu");
  assert.equal(factorySteerMenuSettings.scope, "host");
  assert.equal(factorySteerMenuSettings.version, 3);
  assert.deepEqual(factorySteerMenuSettings.schema.parse({}), {
    afterReset: "continue",
    keepChatHistory: true,
  });
  for (const [legacyInit, expectedAfterReset] of [
    ["send", "continue"],
    ["composer", "composer"],
    ["later", "wait"],
    [undefined, "composer"],
  ]) {
    for (const keepChatHistory of [undefined, false, true]) {
      const legacy = {
        ...(legacyInit === undefined ? {} : { initializeNewSteer: legacyInit }),
        ...(keepChatHistory === undefined ? {} : { keepChatHistory }),
      };
      const migratedV1 = factorySteerMenuSettings.migrate(legacy, 1);
      assert.deepEqual(factorySteerMenuSettings.schema.parse(migratedV1), {
        afterReset: expectedAfterReset,
        keepChatHistory: keepChatHistory ?? false,
      });
      const migratedV2 = factorySteerMenuSettings.migrate(legacy, 2);
      assert.deepEqual(factorySteerMenuSettings.schema.parse(migratedV2), {
        afterReset: expectedAfterReset,
        keepChatHistory: keepChatHistory ?? true,
      });
    }
  }
  const current = { afterReset: "wait", keepChatHistory: true };
  assert.strictEqual(factorySteerMenuSettings.migrate(current, 3), current);
});

// ---------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------

test("stage stores the packet for the steer", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world);
  const paseo = fakeClient(world);
  const identity = await briefs.stageSteerBrief(
    paseo,
    { workspaceId: ws.id, agentId: steer.id, packet: "PACKET", kind: "switch" },
    { lock: noLock, now: () => "2026-11-25T12:00:00.000Z" },
  );
  assert.deepEqual(stagedOf(world, ws.id, steer.id), {
    packet: "PACKET",
    at: "2026-11-25T12:00:00.000Z",
    kind: "switch",
  });
  assert.deepEqual(identity, { stageId: stageTarget(ws, steer).stageId, epoch: 1 });
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
  const target = stageTarget(ws, steer);
  const first = await briefs.deliverSteerBrief(
    paseo,
    { ...target, action: "send" },
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
    { ...target, action: "send" },
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
    { workspaceId: ws.id, agentId: steer.id, stageId: "missing", epoch: 1, action: "send" },
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
  const target = stageTarget(ws, steer);
  const dismissed = await briefs.deliverSteerBrief(
    paseo,
    { ...target, action: "dismiss" },
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
    { ...target, action: "send" },
    { lock: noLock },
  );
  assert.equal(after.delivered, false);
});

test("a lost acknowledgement keeps the attempted packet and message ID", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world);
  const paseo = fakeClient(world);
  const original = paseo.agents.ref;
  const receipts = new Map();
  const requests = [];
  paseo.agents.ref = (id) => ({ ...original(id), send: async (text, options) => {
    requests.push({ text, options });
    if (receipts.has(options.messageId)) return;
    receipts.set(options.messageId, text);
    throw new Error("acknowledgement lost");
  } });
  await briefs.stageSteerBrief(paseo, { workspaceId: ws.id, agentId: steer.id, packet: "PACKET", kind: "fresh" }, { lock: noLock });
  const result = await briefs.deliverSteerBrief(paseo, { ...stageTarget(ws, steer), action: "send" }, { lock: noLock });
  assert.equal(result.delivered, false);
  assert.match(result.detail, /uncertain/i);
  assert.equal(ws.metadata[AGENTS_KEY][steer.id].action.phase, "uncertain");
  const { finishSteerDelivery } = await import("../server/steer-delivery.ts");
  assert.equal((await finishSteerDelivery(paseo, { workspaceId: ws.id, agentId: steer.id }, { lock: noLock })).status, "sent");
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(receipts.size, 1);
});

test("a pending delivery prevents a different staged packet from replacing it", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world);
  const paseo = fakeClient(world);
  await briefs.stageSteerBrief(paseo, { workspaceId: ws.id, agentId: steer.id, packet: "OLDER", kind: "switch" }, { lock: noLock });
  world.sendFails = true;
  await briefs.deliverSteerBrief(paseo, { ...stageTarget(ws, steer), action: "send" }, { lock: noLock });
  await assert.rejects(briefs.stageSteerBrief(paseo, { workspaceId: ws.id, agentId: steer.id, packet: "NEWER", kind: "switch" }, { lock: noLock }), /pending/);
  assert.equal(ws.metadata[AGENTS_KEY][steer.id].action.packet, "OLDER");
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
    briefs.deliverSteerBrief(paseo, { workspaceId: ws.id, agentId: "agt_nope", action: "inspect" }, { lock: noLock }),
    /Unknown agent/,
  );
  await assert.rejects(
    briefs.deliverSteerBrief(paseo, { workspaceId: ws.id, agentId: worker.id, action: "inspect" }, { lock: noLock }),
    /only for steers/,
  );
});

test("a busy steer retains the requested staged action for recovery", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world);
  const paseo = fakeClient(world);
  await briefs.stageSteerBrief(paseo, { workspaceId: ws.id, agentId: steer.id, packet: "STAGED", kind: "fresh" }, { lock: noLock });
  steer.status = "running";
  const result = await briefs.deliverSteerBrief(paseo, { ...stageTarget(ws, steer), action: "send" }, { lock: noLock });
  assert.equal(result.delivered, false);
  assert.equal(ws.metadata[AGENTS_KEY][steer.id].action.phase, "reserved");
  assert.equal(ws.metadata[AGENTS_KEY][steer.id].action.packet, "STAGED");
  steer.status = "idle";
  const { finishSteerDelivery } = await import("../server/steer-delivery.ts");
  assert.equal((await finishSteerDelivery(paseo, { workspaceId: ws.id, agentId: steer.id }, { lock: noLock })).status, "sent");
  assert.deepEqual(sendsTo(world, steer.id), ["STAGED"]);
});

test("staged packet delivery and composer access use the current advisor role and provider", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world);
  const paseo = fakeClient(world);
  const deps = { lock: noLock, getScopePublic: async () => true };
  const packet = "SYNTHETIC_PRIVATE_CHECKPOINT\nSYNTHETIC_PRIVATE_LOG\nSYNTHETIC_ACCOUNT_ID";
  const input = { workspaceId: ws.id, agentId: steer.id };
  await briefs.stageSteerBrief(paseo, { ...input, packet, kind: "fresh" }, deps);
  const target = stageTarget(ws, steer);
  const claim = { ...target, claimId: "privacy-test" };
  const initial = await briefs.deliverSteerBrief(paseo, { ...claim, action: "composer" }, deps);
  assert.equal(initial.packet, packet);
  await briefs.deliverSteerBrief(paseo, { ...claim, action: "composer-release" }, deps);
  const action = ws.metadata[AGENTS_KEY][steer.id].action;

  for (const provider of ["codex", "claude", "muse"]) {
    steer.provider = provider;
    steer.metadata = { [LABEL.steerRole]: "advisor" };
    for (const request of [{ ...claim, action: "composer" }, { ...target, action: "send" }]) {
      const result = await briefs.deliverSteerBrief(paseo, request, deps);
      assert.equal(result.delivered, false);
      assert.match(result.detail, /verified sanitized/);
      assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_/);
    }
    assert.deepEqual(ws.metadata[AGENTS_KEY][steer.id].action, action);
    assert.deepEqual(sendsTo(world, steer.id), []);
  }

  steer.provider = "claude";
  steer.metadata = { [LABEL.steerRole]: "coordinator" };
  assert.equal((await briefs.deliverSteerBrief(paseo, { ...stageTarget(ws, steer), action: "send" }, deps)).delivered, true);
  assert.deepEqual(sendsTo(world, steer.id), [packet]);
});

test("a route change after the attempt write keeps the packet and receipt for safe retry", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world);
  const paseo = fakeClient(world);
  const ref = paseo.workspaces.ref;
  let changeRoute = true;
  paseo.workspaces.ref = (id) => {
    const workspace = ref(id);
    return { ...workspace, setMetadata: async (patch) => {
      await workspace.setMetadata(patch);
      if (changeRoute && patch[AGENTS_KEY]?.[steer.id]?.action?.phase === "uncertain") {
        steer.labels[LABEL.steerRole] = "advisor";
        steer.provider = "claude";
        changeRoute = false;
      }
    } };
  };
  const deps = { lock: noLock };
  const input = { workspaceId: ws.id, agentId: steer.id };
  const packet = "SYNTHETIC_PRIVATE_LOG";
  await briefs.stageSteerBrief(paseo, { ...input, packet, kind: "switch" }, deps);
  const id = ws.metadata[AGENTS_KEY][steer.id].action.wakeId;
  const held = await briefs.deliverSteerBrief(paseo, { ...stageTarget(ws, steer), action: "send" }, deps);
  assert.match(held.detail, /advisor brief requires verified/);
  assert.deepEqual(sendsTo(world, steer.id), []);
  const pending = ws.metadata[AGENTS_KEY][steer.id].action;
  assert.equal(pending.wakeId, id);
  assert.equal(pending.packet, packet);
  assert.equal(pending.phase, "uncertain");

  steer.labels[LABEL.steerRole] = "coordinator";
  const requests = [];
  const agentRef = paseo.agents.ref;
  paseo.agents.ref = (agentId) => ({ ...agentRef(agentId), send: async (text, opts) => requests.push([text, opts.messageId]) });
  assert.equal((await finishSteerDelivery(paseo, input, deps)).status, "sent");
  assert.equal(await finishSteerDelivery(paseo, input, deps), null);
  assert.deepEqual(requests, [[packet, id]]);
});

test("send and composer reject both stale epochs and replacement stages", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world);
  const paseo = fakeClient(world);
  const deps = { lock: noLock };
  const agent = { workspaceId: ws.id, agentId: steer.id };
  const old = await briefs.stageSteerBrief(paseo, { ...agent, packet: "old", kind: "settings" }, deps);
  const actions = [{ action: "send" }, { action: "composer", claimId: "old-claim" }];

  ws.metadata[METADATA_KEY].epoch += 1;
  for (const action of actions) {
    const result = await briefs.deliverSteerBrief(paseo, { ...agent, ...old, ...action }, deps);
    assert.match(result.detail, /scope authority changed/i);
    assert.equal(result.packet, undefined);
  }
  await assert.rejects(briefs.stageSteerBrief(paseo, { ...agent, packet: "old", kind: "fresh", epoch: old.epoch }, deps), /scope authority changed/i);
  assert.equal(stagedOf(world, ws.id, steer.id).packet, "old");
  const current = await briefs.stageSteerBrief(paseo, { ...agent, packet: "new", kind: "settings" }, deps);
  for (const action of [...actions, { action: "dismiss" }, { action: "composer-complete", claimId: "old-claim" }]) {
    const result = await briefs.deliverSteerBrief(paseo, { ...agent, ...old, epoch: current.epoch, ...action }, deps);
    assert.match(result.detail, /staged brief changed/i);
    assert.equal(result.packet, undefined);
  }
  assert.equal(stagedOf(world, ws.id, steer.id).packet, "new");
  assert.deepEqual(sendsTo(world, steer.id), []);
});

for (const first of ["composer", "send"]) {
  test(`concurrent delivery claims allow only ${first} when it takes the lock first`, async () => {
    const world = makeWorld();
    const { ws, steer } = provisioned(world);
    const paseo = fakeClient(world);
    let tail = Promise.resolve();
    const deps = { lock: (_name, fn) => {
      const next = tail.then(() => noLock(_name, fn));
      tail = next.catch(() => {});
      return next;
    } };
    const agent = { workspaceId: ws.id, agentId: steer.id };
    const stage = await briefs.stageSteerBrief(paseo, { ...agent, packet: "brief", kind: "fresh" }, deps);
    const call = (request) => briefs.deliverSteerBrief(paseo, { ...agent, ...stage, ...request }, deps);
    const requests = [{ action: "composer", claimId: "one" }, { action: "send" }];
    if (first === "send") requests.reverse();
    requests.push({ action: "composer", claimId: "two" });
    const [winner, ...losers] = await Promise.all(requests.map(call));
    for (const loser of losers) {
      assert.equal(loser.packet, undefined);
      assert.equal(loser.delivered, false);
    }
    if (first === "send") {
      assert.equal(winner.delivered, true);
      assert.deepEqual(sendsTo(world, steer.id), ["brief"]);
    } else {
      assert.equal(winner.packet, "brief");
      assert.equal((await call({ action: "composer", claimId: "one" })).packet, "brief", "lost claim reply can be replayed");
      assert.equal((await call({ action: "composer-complete", claimId: "two" })).transferred, undefined);
      assert.equal((await call({ action: "dismiss" })).dismissed, false);
      await assert.rejects(briefs.stageSteerBrief(paseo, { ...agent, packet: "replacement", kind: "fresh" }, deps), /pending/i);
      const complete = { action: "composer-complete", claimId: "one" };
      assert.equal((await call(complete)).transferred, true);
      assert.equal((await call(complete)).transferred, true, "lost completion reply can be replayed");
      assert.equal(stagedOf(world, ws.id, steer.id), null);
      assert.deepEqual(sendsTo(world, steer.id), []);
    }
  });
}

test("a missing composer leaves the brief staged and a lost composer releases its claim", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world);
  const paseo = fakeClient(world);
  const deps = { lock: noLock };
  const agent = { workspaceId: ws.id, agentId: steer.id };
  const staged = await briefs.stageSteerBrief(paseo, { ...agent, packet: "brief", kind: "fresh" }, deps);
  const actions = [];
  let composer;
  const call = async (input) => {
    actions.push(input.action);
    const result = await briefs.deliverSteerBrief(paseo, input, deps);
    if (input.action === "composer") composer = undefined;
    return result;
  };
  const target = { ...agent, ...staged };
  const attempt = { claimId: "test", placed: false };
  await assert.rejects(transferStagedBrief(call, target, () => composer, attempt), /composer is unavailable/);
  assert.deepEqual(actions, []);
  assert.equal(stagedOf(world, ws.id, steer.id).packet, "brief");

  composer = { prompt: "", setPrompt: assert.fail, insertText: assert.fail };
  await assert.rejects(transferStagedBrief(call, target, () => composer, attempt), /composer is unavailable/);
  assert.deepEqual(actions, ["composer", "composer-release"]);
  assert.deepEqual(sendsTo(world, steer.id), []);
  assert.equal(stagedOf(world, ws.id, steer.id).packet, "brief");
  assert.equal((await call({ ...target, action: "send" })).delivered, true);
});

test("the client retries a lost completion reply without inserting the packet again", async () => {
  const world = makeWorld();
  const { ws, steer } = provisioned(world);
  const paseo = fakeClient(world);
  const deps = { lock: noLock };
  const agent = { workspaceId: ws.id, agentId: steer.id };
  const staged = await briefs.stageSteerBrief(paseo, { ...agent, packet: "brief", kind: "fresh" }, deps);
  const calls = [];
  const destination = { prompt: "draft", insertText: (text) => calls.push(text), setPrompt: assert.fail };
  let first = true;
  const call = async (input) => {
    const result = await briefs.deliverSteerBrief(paseo, input, deps);
    if (input.action === "composer-complete" && first) {
      first = false;
      throw new Error("Lost completion reply");
    }
    return result;
  };
  const attempt = { claimId: "test", placed: false };
  await assert.rejects(transferStagedBrief(call, { ...agent, ...staged }, () => destination, attempt), /Lost completion reply/);
  await transferStagedBrief(call, { ...agent, ...staged }, () => destination, attempt);
  assert.deepEqual(calls, ["\n\nbrief"]);
  assert.deepEqual(sendsTo(world, steer.id), []);
});

for (const resolution of ["placed", "retry"]) {
  test(`a new client can resolve an ambiguous composer transfer as ${resolution}`, async () => {
    const world = makeWorld();
    const { ws, steer } = provisioned(world);
    const deps = { lock: noLock };
    const agent = { workspaceId: ws.id, agentId: steer.id };
    const original = fakeClient(world);
    const identity = await briefs.stageSteerBrief(original, { ...agent, packet: "brief", kind: "fresh" }, deps);
    const target = { ...agent, ...identity };
    const initialCall = (input) => briefs.deliverSteerBrief(original, input, deps);
    const attempt = { claimId: "old-client", placed: false };
    const composer = { prompt: "", setPrompt: () => { throw new Error("Update outcome unknown"); }, insertText: assert.fail };
    await assert.rejects(transferStagedBrief(initialCall, target, () => composer, attempt), /outcome unknown/);
    await assert.rejects(transferStagedBrief(initialCall, target, () => composer, attempt), /open Review brief in Factory/i);

    const reopened = fakeClient(world);
    const call = (request) => briefs.deliverSteerBrief(reopened, { ...target, ...request }, deps);
    const { recoveryId, packet } = await call({ action: "inspect" });
    assert.ok(recoveryId);
    assert.equal(packet, undefined);
    assert.equal((await call({ action: "send" })).delivered, false);
    assert.equal((await call({ action: "composer", claimId: "new-client" })).packet, undefined);

    const recover = { action: "composer-resolve", recoveryId, resolution };
    assert.equal((await call({ ...recover, epoch: identity.epoch + 1 })).resolved, undefined);
    assert.equal((await call({ ...recover, recoveryId: "different-claim" })).resolved, undefined);
    assert.equal((await call(recover)).resolved, true);
    assert.deepEqual(sendsTo(world, steer.id), []);
    if (resolution === "placed") {
      assert.equal(stagedOf(world, ws.id, steer.id), null);
    } else {
      assert.equal(stagedOf(world, ws.id, steer.id).packet, "brief");
      assert.equal((await call({ action: "composer-complete", claimId: "old-client" })).transferred, undefined);
      assert.equal((await call({ action: "composer", claimId: "new-client", automatic: true })).packet, undefined);
      assert.equal((await call({ action: "composer", claimId: "new-client" })).packet, "brief");
      assert.equal((await call(recover)).resolved, undefined, "an old recovery action cannot resolve a new claim");
    }
  });
}
