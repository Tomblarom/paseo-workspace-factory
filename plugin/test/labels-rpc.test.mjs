// `/factory labels` server path: the preview reuses the core label audit
// read-only, and the apply re-checks the preview fingerprint against fresh
// state before writing through `labels.set`. Fakes only; no daemon, no live
// apply. Server modules load through the ts-resolve-hooks remap.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-resolve-hooks.mjs", import.meta.url);

const { previewLabels, applyLabels } = await import("../server/handlers.ts");
import { LABEL, METADATA_KEY, PARENT_LABEL } from "../../src/paseo.mjs";

// ---------------------------------------------------------------- fixtures

function makeWorld() {
  return { projects: [], workspaces: [], agents: [], providers: [], calls: [], seq: 0 };
}

function addScope(world, { id, path }) {
  const ws = {
    id: `wks_${String(++world.seq).padStart(4, "0")}`,
    projectId: "prj_1",
    workspaceDirectory: path,
    workspaceKind: "local_checkout",
    title: "Main",
    name: "Main",
    metadata: {
      [METADATA_KEY]: { main: true, activeSteer: "A", epoch: 1, scope: { id, kind: "dir", locator: path } },
    },
    createdAt: "2026-11-24T00:00:00.000Z",
  };
  world.workspaces.push(ws);
  if (!world.projects.some((p) => p.projectId === ws.projectId)) {
    world.projects.push({ projectId: ws.projectId, projectRootPath: path, projectDisplayName: id });
  }
  return ws;
}

function addAgent(world, fields) {
  const agent = { id: `agent-${++world.seq}`, status: "idle", archivedAt: null, labels: {}, ...fields };
  world.agents.push(agent);
  return agent;
}

function provisioned(world) {
  const ws = addScope(world, { id: "web", path: "/p/web" });
  const steerA = addAgent(world, {
    provider: "codex", model: "m", title: "Steer A", workspaceId: ws.id,
    labels: { [LABEL.repo]: "web", [LABEL.role]: "steer", [LABEL.slot]: "A", [LABEL.scope]: "web" },
  });
  const oldSteer = addAgent(world, {
    provider: "codex", model: "m", title: "Steer B", workspaceId: ws.id,
    labels: { [LABEL.repo]: "web" },
  });
  const workerNoOwner = addAgent(world, {
    provider: "codex", model: "m", title: "Worker 1", workspaceId: ws.id,
    labels: { [PARENT_LABEL]: steerA.id, [LABEL.scope]: "web", [LABEL.role]: "worker" },
  });
  const ambiguous = addAgent(world, {
    provider: "codex", model: "m", title: "Notes", workspaceId: ws.id,
    labels: { [LABEL.repo]: "web" },
  });
  return { ws, steerA, oldSteer, workerNoOwner, ambiguous };
}

function fakePaseo(world) {
  const page = (entries) => async () => ({ entries, pageInfo: { hasMore: false } });
  return {
    projects: { list: async () => ({ projects: world.projects }) },
    workspaces: { list: page(world.workspaces) },
    agents: {
      list: page(world.agents.map((agent) => ({ agent }))),
      ref: (id) => ({
        refresh: async () => ({ agent: structuredClone(world.agents.find((a) => a.id === id) ?? null) }),
      }),
    },
    providers: { snapshot: async () => ({ entries: world.providers }) },
  };
}

function fakePaseoCli(world) {
  return (args) => {
    world.calls.push(["paseo", ...args]);
    if (args[0] === "agent" && args[1] === "update") {
      const agent = world.agents.find((a) => a.id === args[2]);
      assert.ok(agent, `fake agent update knows ${args[2]}`);
      for (const pair of args[4].split(",")) {
        const [k, v] = pair.split("=");
        agent.labels[k] = v; // add/set only: old labels cannot be removed
      }
      return { id: agent.id };
    }
    throw new Error(`unexpected paseo ${args.join(" ")}`);
  };
}

const loader = { loadEffectiveConfig: async () => ({}) };
const byId = (rows, id) => rows.find((r) => r.agentId === id);

// ---------------------------------------------------------------- preview

test("labels preview audits read-only and reuses the core rows", async () => {
  const world = makeWorld();
  const { steerA, oldSteer, workerNoOwner, ambiguous } = provisioned(world);
  const before = structuredClone(world.agents.map((a) => a.labels));
  const preview = await previewLabels({}, { paseo: fakePaseo(world) });

  assert.equal(preview.address, null);
  assert.deepEqual(byId(preview.rows, oldSteer.id).labels, {
    [LABEL.scope]: "web",
    [LABEL.role]: "steer",
    [LABEL.slot]: "B",
  });
  assert.deepEqual(byId(preview.rows, workerNoOwner.id).labels, { [LABEL.owner]: "A" });
  assert.equal(byId(preview.rows, steerA.id), undefined);
  // Reported without a fix: counts as a row but not as fixable.
  assert.deepEqual(byId(preview.rows, ambiguous.id).labels, {});
  assert.equal(preview.fixable, preview.rows.length - 1);
  assert.match(preview.text, /set wsf\.scope/);
  assert.match(preview.fingerprint, /^[0-9a-f]{16}$/);
  // Read-only: no CLI call, no label touched.
  assert.deepEqual(world.calls, []);
  assert.deepEqual(world.agents.map((a) => a.labels), before);
});

test("labels preview filters by scope or agent address", async () => {
  const world = makeWorld();
  const { ws, steerA, oldSteer, workerNoOwner } = provisioned(world);
  const paseo = fakePaseo(world);

  const byScope = await previewLabels({ address: "web" }, { paseo });
  assert.equal(byScope.address, "web");
  assert.ok(byScope.rows.length >= 2);

  const byWorkspace = await previewLabels({ address: ws.id }, { paseo });
  assert.deepEqual(
    byWorkspace.rows.map((r) => r.agentId).sort(),
    byScope.rows.map((r) => r.agentId).sort(),
  );

  const byAgent = await previewLabels({ address: workerNoOwner.id }, { paseo });
  assert.deepEqual(byAgent.rows.map((r) => r.agentId), [workerNoOwner.id]);

  const clean = await previewLabels({ address: steerA.id }, { paseo });
  assert.deepEqual(clean.rows, []);
  assert.equal(clean.text, "(no label fixes needed)");

  await assert.rejects(() => previewLabels({ address: "no-such-scope" }, { paseo }), /Unknown scope or agent/);
  void oldSteer;
});

// ---------------------------------------------------------------- apply

test("labels apply refuses a stale fingerprint and writes nothing", async () => {
  const world = makeWorld();
  provisioned(world);
  const paseo = fakePaseo(world);
  const before = structuredClone(world.agents.map((a) => a.labels));

  await assert.rejects(
    () => applyLabels({ fingerprint: "0".repeat(16) }, { paseo }, loader, { paseoCli: fakePaseoCli(world) }),
    /Something changed since the labels preview/,
  );
  assert.deepEqual(world.calls, []);
  assert.deepEqual(world.agents.map((a) => a.labels), before);
});

test("labels apply re-checks the preview against current state", async () => {
  const world = makeWorld();
  const { workerNoOwner } = provisioned(world);
  const paseo = fakePaseo(world);
  const preview = await previewLabels({}, { paseo });

  // Someone else fixes an agent after the preview: the write must refuse.
  workerNoOwner.labels[LABEL.owner] = "A";
  await assert.rejects(
    () => applyLabels({ fingerprint: preview.fingerprint }, { paseo }, loader, { paseoCli: fakePaseoCli(world) }),
    /Something changed since the labels preview/,
  );
  assert.deepEqual(world.calls, []);
});

test("labels apply with a fresh preview sets each fixable agent", async () => {
  const world = makeWorld();
  const { oldSteer, workerNoOwner, ambiguous } = provisioned(world);
  const paseo = fakePaseo(world);
  const preview = await previewLabels({}, { paseo });

  const result = await applyLabels({ fingerprint: preview.fingerprint }, { paseo }, loader, {
    paseoCli: fakePaseoCli(world),
  });
  const ok = result.applied.filter((r) => r.ok).map((r) => r.agentId).sort();
  assert.deepEqual(ok, [oldSteer.id, workerNoOwner.id].sort());
  assert.equal(result.applied.filter((r) => !r.ok).length, 0);
  assert.match(result.text, /2 agent\(s\) fixed, 1 reported without a fix/);
  // One `agent update` per fixable agent, nothing for the note-only row.
  assert.equal(world.calls.length, 2);
  assert.ok(world.calls.every((c) => c[0] === "paseo" && c[1] === "agent" && c[2] === "update"));
  assert.ok(!world.calls.some((c) => c.includes(ambiguous.id)));
  assert.equal(oldSteer.labels[LABEL.slot], "B");
  assert.equal(workerNoOwner.labels[LABEL.owner], "A");

  // Fixed agents audit clean afterwards.
  const again = await previewLabels({}, { paseo });
  assert.equal(byId(again.rows, oldSteer.id), undefined);
  assert.equal(byId(again.rows, workerNoOwner.id), undefined);
});
