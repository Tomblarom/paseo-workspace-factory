import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { AGENTS_KEY } from "../server/core/agent-state.mjs";
import { LABEL, METADATA_KEY } from "../server/core/paseo.mjs";
import { configureRuntime } from "../server/core/runtime.mjs";

register("./ts-resolve-hooks.mjs", import.meta.url);
const { observeEfficiencyTurn } = await import("../server/efficiency-ledger.ts");
const { handleTurnAfter } = await import("../server/turn-hook.ts");
const { resetQuotaForTests, sampleQuotaAsync } = await import("../server/quota.ts");
const { factoryMetricsSettings } = await import("../shared/settings.ts");

const ENV = "PASEO_FACTORY_EFFICIENCY_LEDGER";
const DAY = 86_400_000;
const CAP = 512 * 1024;
const REPO = "private-owner/private-repo";
const ACCOUNT = "private-account";
const AGENT = "private-agent";
const SESSION = "private-session";
const TURN = "private-turn";
const PROMPT = "private prompt";
const CHAT = "private response";
const SECRET = "secret-credential";
const stamp = (ms) => new Date(ms).toISOString();
const enabled = async () => true;

function ledgerPath(t) {
  const dir = mkdtempSync(join(tmpdir(), "factory-ledger-"));
  const saved = { [ENV]: process.env[ENV], PASEO_FACTORY_STATE_DIR: process.env.PASEO_FACTORY_STATE_DIR };
  delete process.env[ENV];
  process.env.PASEO_FACTORY_STATE_DIR = dir;
  configureRuntime();
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    configureRuntime();
    rmSync(dir, { recursive: true, force: true });
  });
  return join(dir, "efficiency-ledger.jsonl");
}

function observation(overrides = {}) {
  const now = Date.now();
  return {
    agentId: AGENT, sessionId: SESSION, accountId: ACCOUNT, scopeId: REPO, turnId: TURN,
    provider: "codex", usage: { inputTokens: 120, cachedInputTokens: 100, outputTokens: 0 },
    route: "normal", outcome: "completed", preTurnContextTokens: 80_000,
    previousTurnEndedAt: stamp(now - 32_000), startedAt: stamp(now - 2_000), endedAt: stamp(now),
    ...overrides,
  };
}

function rows(file) {
  return readFileSync(file, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
}

test("defaults off and bypasses the settings reader only for the explicit environment opt-in", async (t) => {
  const file = ledgerPath(t);
  assert.equal(factoryMetricsSettings.id, "factory-metrics");
  assert.equal(factoryMetricsSettings.scope, "host");
  assert.equal(factoryMetricsSettings.version, 1);
  assert.deepEqual(factoryMetricsSettings.schema.parse({}), { enabled: false });
  await observeEfficiencyTurn(undefined, assert.fail);
  process.env[ENV] = "true";
  await observeEfficiencyTurn(async () => false, assert.fail);
  assert.deepEqual(readdirSync(join(file, "..")), []);
  process.env[ENV] = "1";
  await observeEfficiencyTurn(assert.fail, observation);
  assert.equal(rows(file).length, 1);
});

test("writes only the allowlisted observation, with stable hashed identities and private file mode", async (t) => {
  const file = ledgerPath(t);
  const turn = observation({
    prompt: PROMPT, response: CHAT, repoName: REPO, token: SECRET,
    usage: { ...observation().usage, prompt: PROMPT, totalCostUsd: SECRET },
    quota: { sessionPct: 42.5, weeklyPct: 13, sampledAt: stamp(2), resetsAt: stamp(3), weeklyResetAt: SECRET, token: SECRET },
  });
  await observeEfficiencyTurn(enabled, () => turn);
  await observeEfficiencyTurn(enabled, () => turn);
  const raw = readFileSync(file, "utf8");
  for (const value of [PROMPT, CHAT, SECRET, REPO, ACCOUNT, AGENT, SESSION, TURN]) assert.ok(!raw.includes(value));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const [first, second] = rows(file);
  assert.deepEqual(first, second);
  const { agentAlias, sessionAlias, accountAlias, scopeAlias, providerTurnId, ...fields } = first;
  for (const value of [agentAlias, sessionAlias, accountAlias, scopeAlias, providerTurnId]) assert.match(value, /^[a-f0-9]{16}$/);
  assert.deepEqual(fields, {
    kind: "turn", provider: "codex", route: "normal", outcome: "completed",
    startedAt: Date.parse(turn.startedAt), endedAt: Date.parse(turn.endedAt), idleMs: 30_000,
    preTurnContextTokens: 80_000, incomplete: true,
    usage: { U: 20, R: 100, W5: 0, W60: 0, O: 0, W: 0, writeTtlUnknown: false, invalid: false },
    quota: { sessionPct: 42.5, weeklyPct: 13, sampledAt: 2, resetsAt: 3, weeklyResetAt: null },
  });
});

test("marks missing usage incomplete and preserves known zeros and unknown fields", async (t) => {
  const file = ledgerPath(t);
  await observeEfficiencyTurn(enabled, () => observation({
    provider: "claude", usage: { inputTokens: 0, cachedInputTokens: null, outputTokens: "0", cacheCreationInputTokens: 17 },
    startedAt: null, preTurnContextTokens: null,
  }));
  const [event] = rows(file);
  assert.equal(event.incomplete, true);
  assert.equal(event.startedAt, null);
  assert.equal(event.preTurnContextTokens, null);
  assert.equal(event.idleMs, null);
  assert.deepEqual(event.usage, { U: 0, R: null, W5: null, W60: null, O: null, W: 17, writeTtlUnknown: true, invalid: false });
});

test("bounds both files during concurrent appends and replaces the only backup on rotation", async (t) => {
  const file = ledgerPath(t);
  await observeEfficiencyTurn(enabled, observation);
  for (const turnId of ["first rotation", "second rotation"]) {
    const line = Buffer.from(`${JSON.stringify(rows(file)[0])}\n`);
    const fill = Buffer.concat(Array(Math.floor(CAP / line.length)).fill(line));
    writeFileSync(file, fill);
    await Promise.all(Array.from({ length: 2 }, () => observeEfficiencyTurn(enabled, () => observation({ turnId }))));
    assert.deepEqual(readFileSync(`${file}.1`), fill);
    assert.equal(rows(file).length, 2);
    assert.ok(statSync(file).size <= CAP && statSync(`${file}.1`).size <= CAP);
  }
  assert.deepEqual(readdirSync(join(file, "..")).filter((name) => name.startsWith(basename(file))).sort(),
    [basename(file), `${basename(file)}.1`]);
});

test("rotates week-old rows and removes files with expired rows on append", async (t) => {
  const file = ledgerPath(t);
  const backup = `${file}.1`;
  const now = Date.now();
  await observeEfficiencyTurn(enabled, observation);
  const [row] = rows(file);
  const oldRow = { ...row, endedAt: now - 8 * DAY };
  writeFileSync(file, `${JSON.stringify(oldRow)}\n`);
  await observeEfficiencyTurn(enabled, observation);
  assert.deepEqual(rows(backup), [oldRow]);

  const expired = `${JSON.stringify({ ...row, endedAt: now - 14 * DAY })}\n`;
  writeFileSync(file, expired);
  writeFileSync(backup, expired);
  await observeEfficiencyTurn(enabled, observation);
  assert.ok(!existsSync(backup));
  assert.ok(rows(file)[0].endedAt >= now);
});

function turnFixture({ action, receipt = action?.wakeId, cleanup = false } = {}) {
  const start = Date.now() - 2_000;
  const workspace = {
    id: "workspace", workspaceKind: "local_checkout", workspaceDirectory: "/example/private-repo",
    metadata: {
      [METADATA_KEY]: { main: true, activeSteer: "A", epoch: 1, scope: { id: REPO, kind: "github", locator: REPO } },
      [AGENTS_KEY]: { [AGENT]: {
        contextTokens: 80_000, lastTurnEndedAt: stamp(start - 30_000), openTurnId: TURN,
        turnStartedAt: stamp(start), action,
      } },
    },
  };
  const agent = {
    id: AGENT, workspaceId: workspace.id, provider: "claude", model: "sonnet",
    labels: { [LABEL.scope]: REPO, [LABEL.role]: "steer", [LABEL.slot]: "A" },
    persistence: { sessionId: SESSION },
    lastUsage: { inputTokens: 99, contextWindowUsedTokens: 120_000, contextWindowMaxTokens: 200_000 },
  };
  const page = (entries) => ({ entries, pageInfo: { hasMore: false } });
  const calls = [];
  const tracked = (label, result) => async () => { calls.push(label); return structuredClone(result); };
  const paseo = {
    projects: { list: tracked("projects.list", { projects: [] }) },
    providers: { snapshot: tracked("providers.snapshot", { entries: [] }) },
    agents: {
      list: tracked("agents.list", page([agent])),
      ref: () => ({
        refresh: tracked("agent.refresh", { agent }),
        send: tracked("agent.send", null),
        timeline: { refetch: tracked("agent.timeline", { entries: [
          { turnId: TURN, item: { type: "user_message", text: cleanup ? "/compact" : PROMPT, clientMessageId: receipt } },
          { turnId: TURN, item: cleanup ? { type: "compaction", status: "completed" } : { type: "assistant_message", text: CHAT } },
        ] }) },
      }),
    },
    workspaces: {
      list: tracked("workspaces.list", page([workspace])),
      ref: () => ({
        refresh: tracked("workspace.refresh", workspace),
        setMetadata: async (patch) => { calls.push("workspace.setMetadata"); Object.assign(workspace.metadata, patch); },
      }),
    },
  };
  return {
    start, calls, entry: () => workspace.metadata[AGENTS_KEY][AGENT],
    complete: (getMetricsEnabled) => handleTurnAfter({ agent: { id: AGENT }, turnId: TURN, outcome: { kind: "completed" } }, { paseo }, {
      lock: async (_name, fn) => fn({ verify() {} }),
      getZerosub: tracked("zerosub.state", { agentAccount: { [AGENT]: ACCOUNT }, pending: {} }),
      getMetricsEnabled,
    }),
  };
}

test("turn hook observes existing data and a cached quota sample without adding Paseo, provider or model calls", async (t) => {
  const file = ledgerPath(t);
  t.after(resetQuotaForTests);
  let sampled = 0;
  const sampledAt = stamp(Date.now() - 90_000);
  await sampleQuotaAsync(() => {
    sampled++;
    return JSON.stringify([{ sourceId: "claude", fetchedAt: sampledAt, report: { windows: [{ id: "5h", usedPct: 78 }] } }]);
  });
  const options = { action: { kind: "fresh-delivery", phase: "done", wakeId: "private-receipt", packet: SECRET } };
  const off = turnFixture(options);
  await off.complete(undefined);
  assert.ok(!existsSync(file));
  const on = turnFixture(options);
  await on.complete(enabled);
  assert.deepEqual(on.calls, off.calls);
  assert.equal(on.calls.filter((call) => call === "zerosub.state").length, 1);
  assert.ok(!on.calls.includes("agent.send"));
  assert.equal(sampled, 1);
  const [event] = rows(file);
  assert.equal(event.route, "fresh");
  assert.equal(event.outcome, "completed");
  assert.match(event.accountAlias, /^[a-f0-9]{16}$/);
  assert.equal(event.startedAt, on.start);
  assert.equal(event.endedAt, Date.parse(on.entry().lastTurnEndedAt));
  assert.equal(event.idleMs, 30_000);
  assert.equal(event.preTurnContextTokens, 80_000);
  assert.equal(on.entry().contextTokens, 120_000);
  assert.equal(event.usage.U, 99);
  assert.equal(event.usage.R, null);
  assert.equal(event.quota.sessionPct, 78);
  assert.equal(event.quota.sampledAt, Date.parse(sampledAt));
  for (const value of [PROMPT, CHAT, SECRET, REPO, "private-receipt"]) assert.ok(!readFileSync(file, "utf8").includes(value));
});

test("unrelated steer actions stay normal and verified cleanup is recorded without a quota lookup", async (t) => {
  const file = ledgerPath(t);
  await turnFixture({ action: { kind: "switch", wakeId: "old-receipt" }, receipt: "other-receipt" }).complete(enabled);
  const compact = turnFixture({
    action: { kind: "cleanup", phase: "renewing", cleanup: { kind: "compact", messageId: "compact-receipt" } },
    receipt: "compact-receipt", cleanup: true,
  });
  await compact.complete(enabled);
  assert.deepEqual(rows(file).map(({ route }) => route), ["normal", "cleanup"]);
  assert.ok(!compact.calls.includes("zerosub.state"));
});

test("ledger write failure is fail-soft and the turn still updates metadata", async (t) => {
  const file = ledgerPath(t);
  mkdirSync(file); // A directory at the target prevents writing, even under elevated privileges.
  const errors = t.mock.method(console, "error", () => {});
  const fixture = turnFixture();
  await fixture.complete(enabled);
  assert.equal(errors.mock.callCount(), 0);
  assert.equal(fixture.entry().lastTurnId, TURN);
  assert.equal(fixture.entry().openTurnId, null);
  assert.equal(fixture.entry().contextTokens, 120_000);
  assert.ok(statSync(file).isDirectory());
  assert.ok(!existsSync(`${file}.1`));
});
