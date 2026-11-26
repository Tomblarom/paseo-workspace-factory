// K11 consolidation, plugin side: each RPC reads the full daemon state once
// (counted on a fake client), and the steer feed agrees with the shared
// holder selector on continuations and same-slot pairs.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

register("./ts-resolve-hooks.mjs", import.meta.url);

const { getStatus, getResume } = await import("../server/handlers.ts");
const { collectSteerStates } = await import("../server/steer-feed.ts");
const { CLEANUP_DEFAULTS } = await import("../shared/idle-cleanup.ts");
const { resolveSteerHolders } = await import("../server/core/discovery.mjs");
const { scopeHolder } = await import("../server/core/scope-guard.mjs");
const { resolveWakeTarget } = await import("../server/core/supervision.mjs");
import { LABEL, METADATA_KEY } from "../server/core/paseo.mjs";
import { CONTINUED_FROM_LABEL } from "../server/core/zerosub.mjs";

// ---------------------------------------------------------------- fixtures

const ROOT = mkdtempSync(join(tmpdir(), "k11-rpc-"));
const SCOPE = "web";
const MAIN = "wks_main";

function makeWorld() {
  return { projects: [], workspaces: [], agents: [], providers: [], reads: { projects: 0, workspaces: 0, agents: 0, providers: 0 } };
}

function addScope(world) {
  const dir = join(ROOT, SCOPE);
  const ws = {
    id: MAIN, projectId: "prj_1", workspaceDirectory: dir, workspaceKind: "local_checkout",
    title: "Main", name: "Main",
    metadata: { [METADATA_KEY]: { main: true, activeSteer: "A", epoch: 1, scope: { id: SCOPE, kind: "dir", locator: dir } } },
  };
  world.workspaces.push(ws);
  world.projects.push({ projectId: "prj_1", projectRootPath: dir, projectDisplayName: SCOPE });
  return ws;
}

function addAgent(world, fields) {
  const agent = { id: `agent-${world.agents.length + 1}`, status: "idle", archivedAt: null, labels: {}, ...fields };
  world.agents.push(agent);
  return agent;
}

function countingPaseo(world) {
  const page = (entries) => ({ entries: structuredClone(entries), pageInfo: { hasMore: false } });
  return {
    projects: { list: async () => { world.reads.projects += 1; return { projects: world.projects }; } },
    workspaces: { list: async () => { world.reads.workspaces += 1; return page(world.workspaces); } },
    agents: {
      list: async () => { world.reads.agents += 1; return page(world.agents.map((agent) => ({ agent }))); },
      ref: (id) => ({ refresh: async () => ({ agent: structuredClone(world.agents.find((a) => a.id === id) ?? null) }) }),
    },
    providers: { snapshot: async () => { world.reads.providers += 1; return { entries: world.providers }; } },
  };
}

const CONFIG = {
  version: 1,
  github: { owner: "example-owner", cloneProtocol: "https", upstreamRemote: "upstream" },
  checkoutRoot: ROOT,
  workspaceTitle: "Main",
  profiles: { standard: { provider: "codex", model: "m", thinking: null, mode: "x" } },
  steers: { slots: { A: "standard", B: "standard" }, prepare: ["A"], initialActive: "A" },
  workers: { defaultProfile: "standard" },
};
const loader = { loadEffectiveConfig: async () => structuredClone(CONFIG), loadPromptOptions: async () => ({}) };

const steerLabels = (slot) => ({ [LABEL.scope]: SCOPE, [LABEL.role]: "steer", [LABEL.slot]: slot });

// ------------------------------------------------------- one snapshot

test("getStatus reads the daemon state exactly once", async () => {
  const world = makeWorld();
  addScope(world);
  addAgent(world, { provider: "codex", model: "m", title: "Steer A", workspaceId: MAIN, labels: steerLabels("A") });
  const status = await getStatus({ workspaceId: MAIN }, { paseo: countingPaseo(world) }, loader);
  assert.equal(status.state.activeSteer, "A");
  assert.deepEqual(world.reads, { projects: 1, workspaces: 1, agents: 1, providers: 1 });
});

test("getResume with an agent id reads the daemon state exactly once", async () => {
  const world = makeWorld();
  addScope(world);
  const steer = addAgent(world, { provider: "codex", model: "m", title: "Steer A", workspaceId: MAIN, labels: steerLabels("A") });
  const resume = await getResume({ workspaceId: MAIN, agentId: steer.id }, { paseo: countingPaseo(world) }, loader);
  assert.equal(resume.agentId, steer.id);
  assert.deepEqual(world.reads, { projects: 1, workspaces: 1, agents: 1, providers: 1 });
});

// ------------------------------------------------------- feed agreement

test("feed rows agree with scopeHolder and resolveWakeTarget on continuation and same-slot pairs", async () => {
  const world = makeWorld();
  addScope(world);
  addAgent(world, { id: "origin-a", title: "Steer A", workspaceId: MAIN, labels: steerLabels("A") });
  addAgent(world, { id: "live-a", title: "Steer A (continued)", workspaceId: MAIN, labels: { [CONTINUED_FROM_LABEL]: "origin-a" } });
  addAgent(world, { id: "old-b", title: "Steer B", workspaceId: MAIN, labels: steerLabels("B"), createdAt: "2026-11-24T09:00:00.000Z" });
  addAgent(world, { id: "new-b", title: "Steer B", workspaceId: MAIN, labels: steerLabels("B"), createdAt: "2026-11-24T10:00:00.000Z" });
  const state = { agents: world.agents, workspaces: world.workspaces, projects: world.projects, providers: [] };
  const rows = collectSteerStates(state, { settings: CLEANUP_DEFAULTS, nowMs: Date.parse("2026-11-25T12:00:00.000Z") });
  const byId = new Map(rows.map((r) => [r.agentId, r]));
  assert.equal(byId.has("origin-a"), false);
  assert.equal(byId.get("live-a").successor, null);
  assert.equal(byId.get("old-b").successor, null);
  assert.equal(byId.get("new-b").successor, null);
  const resolved = resolveSteerHolders(
    world.agents.filter((a) => a.labels?.[LABEL.role] === "steer"),
    world.agents,
    [],
  );
  const statusRows = resolved.map((a) => ({ slot: a.labels?.[LABEL.slot] ?? null, id: a.id, archivedAt: a.archivedAt ?? null, retired: false, superseded: a.superseded === true }));
  assert.equal(scopeHolder({ agents: world.agents, workspaceId: MAIN, scopeId: SCOPE, slot: "A" }).id, "live-a");
  assert.equal(resolveWakeTarget({ activeSteer: "A" }, statusRows), "live-a");
  assert.throws(() => scopeHolder({ agents: world.agents, workspaceId: MAIN, scopeId: SCOPE, slot: "B" }), /found 2/);
  assert.equal(resolveWakeTarget({ activeSteer: "B" }, statusRows), null);
});
