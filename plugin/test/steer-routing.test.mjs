import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
register("./ts-resolve-hooks.mjs", import.meta.url);
const { readRoutingSnapshot, steerRouteCandidate, planSteerRoutes } = await import("../server/steer-routing.ts");
const { quotaAdmission, steerQuotaAdmission, readPrivacyAdmission } = await import("../server/steer-admission.ts");
const { AGENTS_KEY } = await import("../server/core/agent-state.mjs");
const { LABEL, METADATA_KEY } = await import("../server/core/paseo.mjs");
const { CONTINUED_FROM_LABEL } = await import("../server/core/zerosub.mjs");
const { hasActiveAgentWork } = await import("../server/agent-context.ts");

const NOW = Date.parse("2026-11-26T17:00:00Z");
const agent = { id: "a", provider: "claude", model: "m" };
const account = (id, usedPct) => ({ id, family: "claude", sampledAt: new Date(NOW).toISOString(),
  windows: [{ id: "5h", usedPct, resetsAt: new Date(NOW + 3600_000).toISOString() }] });

test("one live observation supplies config, account quota and preparation to all candidates", async () => {
  const calls = { config: 0, zerosub: 0, cleanup: 0, resume: 0, history: 0 };
  const config = { quota: { exhaustedPct: 90 } };
  const zerosub = { accounts: [account("source", 95), account("other", 20)], agentAccount: { a: "source", b: "other" }, pending: {} };
  const read = await readRoutingSnapshot({
    getConfig: async () => { calls.config++; return config; },
    getZerosub: async () => { calls.zerosub++; return zerosub; },
    getCleanupSettings: async () => { calls.cleanup++; return null; },
    getResumeSettings: async () => { calls.resume++; return null; },
    keepChatHistory: async () => { calls.history++; return false; },
    now: () => new Date(NOW).toISOString(),
  }, []);
  // Later mutable supplier values cannot alter an existing decision snapshot.
  config.quota.exhaustedPct = 100;
  zerosub.accounts[0].windows[0].usedPct = 0;
  const candidates = [
    steerRouteCandidate({ agent, entry: {}, snapshot: read, row: { warmth: "warm" } }),
    steerRouteCandidate({ agent: { ...agent, id: "b" }, entry: {}, snapshot: read, kind: "handover", row: { warmth: "cold" } }),
  ];
  const plan = planSteerRoutes(read, candidates);
  assert.equal(plan.selected.agentId, "b");
  assert.equal(plan.selected.preparation, "clear");
  assert.equal(plan.excluded[0].reason, "quota exhausted");
  assert.deepEqual(calls, { config: 1, zerosub: 1, cleanup: 1, resume: 1, history: 1 });
});

test("a hard limit recorded in another workspace is shared by every candidate on that account/model", async () => {
  const workspaces = [{ metadata: { [AGENTS_KEY]: { old: {
    quotaLimit: { provider: "claude", model: "m", accountId: "source", at: new Date(NOW).toISOString() },
  } } } }];
  const snapshot = await readRoutingSnapshot({
    zerosub: { accounts: [account("source", 10)], agentAccount: { a: "source" }, pending: {} },
    now: () => new Date(NOW).toISOString(),
  }, workspaces);
  assert.equal(quotaAdmission(agent, {}, snapshot).reason, "provider limit");
  assert.equal(quotaAdmission({ ...agent, model: "different" }, {}, snapshot).allowed, true);
});

test("a bound account without usable telemetry never inherits or clears a limit from the provider pool", async () => {
  const snapshot = await readRoutingSnapshot({
    zerosub: { accounts: [], agentAccount: { a: "api" }, pending: {} },
    now: () => new Date(NOW).toISOString(),
  }, []);
  snapshot.quota = { claude: { sessionPct: 10, weeklyPct: 100 } };
  snapshot.quotaSampledAt = NOW;
  const prior = { quotaLimit: { provider: "claude", model: "m", at: new Date(NOW - 60000).toISOString() } };
  for (const accounts of [[], [{ id: "api", family: "claude", auth: "api", status: "ready", windows: [] }],
    [{ ...account("api", 99), sampledAt: new Date(NOW - 3600000).toISOString() }]]) {
    snapshot.zerosub.accounts = accounts;
    const admission = quotaAdmission(agent, {}, snapshot);
    assert.equal(admission.allowed, true);
    assert.equal(admission.accountId, "api");
    assert.equal(quotaAdmission({ ...agent, id: "unbound" }, {}, snapshot).reason, "quota exhausted");
    assert.equal(quotaAdmission(agent, { quotaLimit: { ...prior.quotaLimit, accountId: "sibling" } }, snapshot).allowed, true);
  }
  snapshot.quota.claude.weeklyPct = 10;
  assert.equal(quotaAdmission(agent, prior, snapshot).reason, "provider limit");
  snapshot.zerosub.accounts = [account("api", 99)];
  assert.equal(quotaAdmission(agent, {}, snapshot).reason, "quota exhausted");
});

test("execution takes a fresh observation, so a newly pending move prevents sending", async () => {
  let zerosub = { accounts: [account("source", 10)], agentAccount: { a: "source" }, pending: {} };
  const deps = { getZerosub: async () => zerosub, now: () => new Date(NOW).toISOString() };
  const observed = await readRoutingSnapshot(deps, []);
  assert.equal(quotaAdmission(agent, {}, observed).allowed, true);
  zerosub = { ...zerosub, agentAccount: { a: "other" }, pending: { a: "source" } };
  const current = await steerQuotaAdmission(agent, {}, deps);
  assert.equal(current.allowed, false);
  assert.equal(current.pendingMove, true);
  assert.equal(current.accountId, "source");
});

test("a durable unresolved move blocks admission even when native pending state disappeared", async () => {
  const snapshot = await readRoutingSnapshot({
    zerosub: { accounts: [account("target", 10)], agentAccount: { a: "target" }, pending: {} },
    now: () => new Date(NOW).toISOString(),
  }, []);
  const entry = { action: { accountMove: { phase: "uncertain", fromAccountId: "source", accountId: "target" } } };
  assert.equal(quotaAdmission(agent, entry, snapshot).allowed, false);
  assert.equal(quotaAdmission(agent, entry, snapshot).pendingMove, true);
  assert.equal(quotaAdmission(agent, entry, snapshot).accountId, "source");
  assert.equal(hasActiveAgentWork({ ...agent, status: "idle" }, entry), true);
  entry.action.accountMove.phase = "settled";
  assert.equal(quotaAdmission(agent, entry, snapshot).allowed, true);
  assert.equal(hasActiveAgentWork({ ...agent, status: "idle" }, entry), false);
});

test("explicit activation selects preparation on the requested steer, even when another is ready", async () => {
  const snapshot = await readRoutingSnapshot({ now: () => new Date(NOW).toISOString() }, []);
  const candidates = [
    steerRouteCandidate({ agent, entry: {}, snapshot, row: { warmth: "cold" } }),
    steerRouteCandidate({ agent: { ...agent, id: "b" }, entry: {}, snapshot, row: { warmth: "warm" } }),
  ];
  assert.equal(planSteerRoutes(snapshot, candidates).selected.agentId, "b");
  const explicit = planSteerRoutes(snapshot, candidates, { intent: { mode: "explicit", agentId: "a" } });
  assert.equal(explicit.selected.agentId, "a");
  assert.equal(explicit.selected.preparation, "clear");
  assert.equal(explicit.alternatives[0].agentId, "b");
});

test("preference routing ranks actual live tuples from host priorities rather than letters", async () => {
  const config = { profiles: { preferred: { provider: "claude", model: "preferred", thinking: "high", mode: "full" },
    fast: { provider: "claude", model: "fast" } }, steers: { priority: ["preferred", "fast"] }, routing: { strategy: "preference" } };
  const snapshot = await readRoutingSnapshot({ getConfig: async () => config, now: () => new Date(NOW).toISOString() }, []);
  const candidates = [
    steerRouteCandidate({ agent: { ...agent, id: "a", model: "fast" }, entry: {}, snapshot, preferenceRank: 0, row: { warmth: "warm" } }),
    steerRouteCandidate({ agent: { ...agent, id: "z", model: "preferred", effectiveThinkingOptionId: "high", modeId: "full" },
      entry: {}, snapshot, preferenceRank: 25, row: { warmth: "cold" } }),
  ];
  assert.equal(planSteerRoutes(snapshot, candidates).selected.agentId, "z");
  const changed = steerRouteCandidate({ agent: { ...agent, id: "z", model: "preferred", effectiveThinkingOptionId: "low", modeId: "full" },
    entry: {}, snapshot, row: { warmth: "cold" } });
  assert.equal(changed.evidence.preferenceRank, null, "native tuple changes are observed, never aligned to a preset");
  assert.equal(planSteerRoutes(snapshot, [candidates[0], changed]).selected.agentId, "a");
  const explicit = planSteerRoutes(snapshot, candidates, { intent: { mode: "explicit", agentId: "a" } });
  assert.equal(explicit.selected.agentId, "a");
});

test("runtime privacy excludes sensitive coordinator and advisor routes for every visibility without substituting explicit intent", async () => {
  const config = { profiles: { restricted: { provider: "muse", model: "m", sensitive: true } } };
  for (const repoPublic of [false, null, true]) {
    const workspaces = [{ id: "ws" }];
    const sensitive = { id: "restricted", provider: "muse", model: "other", workspaceId: "ws",
      labels: { "wsf.steerRole": "advisor" } };
    const open = { ...agent, workspaceId: "ws" };
    const snapshot = await readRoutingSnapshot({ getConfig: async () => config, getScopePublic: async () => repoPublic }, workspaces, [sensitive, open]);
    const candidates = [sensitive, open].map((target) => steerRouteCandidate({ agent: target, entry: {}, snapshot }));
    assert.equal(candidates[0].eligible, false);
    assert.match(candidates[0].reason, repoPublic ? /verified sanitized brief/ : /private or unknown/);
    assert.equal(planSteerRoutes(snapshot, candidates).selected.agentId, open.id);
    const explicit = planSteerRoutes(snapshot, candidates, { intent: { mode: "explicit", agentId: sensitive.id } });
    assert.equal(explicit.selected, null);
    assert.equal(candidates[1].eligible, true);
  }
});

test("privacy uses native repository visibility only for the exact recorded GitHub scope", async () => {
  const workspace = { metadata: { [METADATA_KEY]: { scope: { id: "owner/repo", kind: "github", locator: "owner/repo" } } } };
  const paseo = { workspaces: { ref: () => ({ refresh: async () => structuredClone(workspace) }) } };
  const target = { provider: "muse", model: "runtime", workspaceId: "ws" };
  for (const privateFlag of [true, false, undefined]) {
    const gh = () => JSON.stringify({ full_name: "owner/repo", private: privateFlag });
    const decision = await readPrivacyAdmission(target, { paseo, gh });
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, privateFlag === false ? /verified sanitized brief/ : /private or unknown/);
  }
  workspace.metadata[METADATA_KEY].scope.id = "different/repo";
  let called = false;
  const decision = await readPrivacyAdmission(target, { paseo, gh: () => { called = true; return "{}"; } });
  assert.match(decision.reason, /private or unknown/);
  assert.equal(called, false);
});

test("sensitivity follows the runtime provider rather than an unrelated slot preset", async () => {
  const config = { profiles: { open: { provider: "codex", model: "m", sensitive: false },
    restricted: { provider: "Muse", model: "configured" } }, steers: { slots: { A: "open" } } };
  const target = { provider: "muse", model: "changed", labels: { "wsf.slot": "A" } };
  const decision = await readPrivacyAdmission(target, { getConfig: async () => config, getScopePublic: async () => true });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /verified sanitized brief/);
});

test("an advisor continuation inherits the restriction across providers even with conflicting role metadata", async () => {
  const origin = { id: "origin", provider: "codex", workspaceId: "ws", archivedAt: "2026-11-26",
    labels: { [LABEL.role]: "steer", [LABEL.scope]: "owner/repo", [LABEL.steerRole]: "coordinator" },
    metadata: { [LABEL.steerRole]: "advisor" } };
  const target = { id: "target", provider: "claude", workspaceId: "ws", labels: { [CONTINUED_FROM_LABEL]: origin.id } };
  const paseo = { agents: { list: async () => ({ entries: [origin, target], pageInfo: { hasMore: false } }) } };
  assert.match((await readPrivacyAdmission(target, { paseo })).reason, /advisor brief requires verified/);
  const snapshot = await readRoutingSnapshot({}, [], [target], [origin, target]);
  assert.match(steerRouteCandidate({ agent: target, entry: {}, snapshot }).reason, /advisor brief requires verified/);
  delete origin.metadata;
  assert.equal((await readPrivacyAdmission(target, { paseo })).allowed, true);
  target.labels[CONTINUED_FROM_LABEL] = "missing";
  assert.match((await readPrivacyAdmission(target, { paseo })).reason, /continuation role is unknown/);
});
