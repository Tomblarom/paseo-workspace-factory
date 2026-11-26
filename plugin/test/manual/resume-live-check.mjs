#!/usr/bin/env node
// R-A live check on a scratch agent. NOT part of the normal suite
// (plugin/test/manual/ is outside the `test/*.mjs` glob) and NEVER run
// without explicit approval: it creates a scratch workspace + agent and
// sends real turns through the daemon.
//
//   WSF_RESUME_LIVE=approved node plugin/test/manual/resume-live-check.mjs --step=clear
//   WSF_RESUME_LIVE=approved node plugin/test/manual/resume-live-check.mjs --step=reopen --agent <id>
//
// Preconditions: daemon running, factory plugin installed, a claude provider
// configured. What each step proves (E1/E2 open points):
//   clear:  `/clear` sent through the SDK without options yields a NEW
//           persistence.sessionId on the same agent id (same tab).
//   reopen: `send` to a closed agent reopens it (status closed -> live turn).
//           The operator closes the scratch tab in the Paseo UI when asked;
//           there is no SDK call for closing.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { connect } from "../../server/core/paseo.mjs";
import { configureRuntime } from "../../server/core/runtime.mjs";

const step = process.argv.find((a) => a.startsWith("--step="))?.slice(7) ?? null;
const agentArg = process.argv.find((a) => a.startsWith("--agent="))?.slice(8) ?? null;

function usage(exit = 1) {
  console.error(
    [
      "R-A live check (scratch agent, approval-gated). Steps:",
      "  --step=clear                 create scratch agent, /clear it, assert a new session id",
      "  --step=reopen --agent <id>   after YOU close that tab in the UI, send + assert reopen",
      "Gate: WSF_RESUME_LIVE=approved. Without a step this script only prints this help.",
    ].join("\n"),
  );
  process.exit(exit);
}

if (!step) usage(0);
if (process.env.WSF_RESUME_LIVE !== "approved") {
  console.error("Refusing: this live check needs WSF_RESUME_LIVE=approved (explicit approval).");
  process.exit(2);
}
if (!["clear", "reopen"].includes(step)) usage();
if (step === "reopen" && !agentArg) usage();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForIdle(client, agentId, timeoutMs = 180_000) {
  const started = Date.now();
  for (;;) {
    const snap = await client.agents.ref(agentId).refresh().catch(() => null);
    const agent = snap?.agent ?? null;
    if (!agent) throw new Error(`agent ${agentId} is gone`);
    if (agent.status === "idle") return agent;
    if (agent.status !== "running" && agent.status !== "initializing") {
      throw new Error(`agent ${agentId} stuck in status ${JSON.stringify(agent.status)}`);
    }
    if (Date.now() - started > timeoutMs) throw new Error(`agent ${agentId} did not go idle in time`);
    await sleep(2000);
  }
}

async function run() {
  const { scratchDir } = configureRuntime({});
  const client = await connect({ clientId: "wsf-resume-live-check" });
  try {
    if (step === "clear") {
      mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
      const dir = mkdtempSync(join(scratchDir, "resume-live-"));
      if (readdirSync(dir).length) throw new Error(`scratch ${dir} is not empty`);
      execFileSync("git", ["init", "-q", dir]);
      writeFileSync(join(dir, "README.md"), "resume live-check scratch\n");
      const id = randomUUID().slice(0, 8);
      const ws = await client.workspaces.create({
        source: { kind: "directory", path: dir },
        title: `WSF resume live ${id}`,
        idempotencyKey: `wsf-resume-live:${id}:workspace`,
      });
      console.log(`workspace: ${ws.id} (${dir})`);
      // Agent create shape follows the daemon SDK; adjust field names to the
      // pinned @getpaseo/client version if this call rejects.
      const created = await client.agents.create({
        workspaceId: ws.id,
        provider: "claude",
        title: `WSF resume live ${id}`,
        idempotencyKey: `wsf-resume-live:${id}:agent`,
      });
      const agentId = created.id ?? created.agent?.id;
      console.log(`agent: ${agentId}`);
      const before = (await client.agents.ref(agentId).refresh())?.agent ?? null;
      const sessionBefore = before?.persistence?.sessionId ?? null;
      console.log(`session before: ${sessionBefore}`);
      assert.ok(sessionBefore, "scratch agent has a session id before /clear");
      // Mirror sendCleanupCommand: SDK send with NO options (any sourceAgentId
      // would void the command).
      await client.agents.ref(agentId).send("/clear");
      const after = await waitForIdle(client, agentId);
      const sessionAfter = after?.persistence?.sessionId ?? null;
      console.log(`session after:  ${sessionAfter}`);
      assert.ok(sessionAfter, "scratch agent has a session id after /clear");
      assert.notEqual(sessionAfter, sessionBefore, "/clear must yield a new session id");
      assert.equal(after.id, agentId, "same agent id (same tab)");
      console.log(`PASS clear: ${sessionBefore} -> ${sessionAfter} (agent kept for --step=reopen)`);
      return 0;
    }
    // step === "reopen": the operator closes the tab first (no SDK for that).
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await new Promise((resolve) =>
      rl.question(`Close the tab of ${agentArg} in the Paseo UI, then press Enter here.`, () => {
        rl.close();
        resolve(null);
      }),
    );
    const closed = (await client.agents.ref(agentArg).refresh())?.agent ?? null;
    console.log(`status after close: ${closed?.status ?? "(gone)"}`);
    await client.agents.ref(agentArg).send("live-check ping: reply with pong");
    const live = await waitForIdle(client, agentArg);
    console.log(`status after send: ${live.status}`);
    assert.notEqual(live.status, "closed", "send reopens a closed agent");
    console.log("PASS reopen: send to a closed agent produced a live turn");
    return 0;
  } finally {
    await client.close?.().catch(() => {});
  }
}

run().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
