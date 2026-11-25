#!/usr/bin/env node
// Provider live-check kit. This is intentionally outside the normal test glob:
// it creates real agents and consumes provider quota.
//
//   WSF_PROVIDER_LIVE=approved node plugin/test/manual/provider-live-check.mjs --step=checkpoint
//   WSF_PROVIDER_LIVE=approved node plugin/test/manual/provider-live-check.mjs --step=all --model=gpt-6.2-sol
//
// The operator supplies the provider id when it is not the default. Every
// agent created here is labelled wsf.scratch=true and is archived in finally.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { connect } from "../../server/core/paseo.mjs";
import { configureRuntime } from "../../server/core/runtime.mjs";
import { loadConfig } from "../../server/core/config.mjs";

const STEPS = ["checkpoint", "interruption", "handoff", "compact", "clear", "wake", "advisor", "limits", "all"];
const step = process.argv.find((arg) => arg.startsWith("--step="))?.slice(7) ?? null;
const model = process.argv.find((arg) => arg.startsWith("--model="))?.slice(8) ?? "gpt-6.2-sol";
const provider = process.argv.find((arg) => arg.startsWith("--provider="))?.slice(11) ?? (model.startsWith("claude") ? "claude" : "codex");
const scopeName = `provider-live-${randomUUID().slice(0, 8)}`;
const createdAgents = [];

function usage(exit = 1) {
  console.error([
    "Provider live-check kit (scratch agents, approval-gated).",
    `  --step=${STEPS.slice(0, -1).join("|")}|all`,
    "  --model=gpt-6.2-sol|claude-sonnet-5-5|gpt-6.2-astra|claude-opus-5-5",
    "  --provider=<configured provider id> (default: codex for gpt, claude for claude)",
    "Gate: WSF_PROVIDER_LIVE=approved. Every run creates real provider turns and may cost money.",
  ].join("\n"));
  process.exit(exit);
}

if (!step) usage(0);
if (process.env.WSF_PROVIDER_LIVE !== "approved") {
  console.error("Refusing: set WSF_PROVIDER_LIVE=approved to authorize provider live checks.");
  process.exit(2);
}
if (!STEPS.includes(step)) usage();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const prompt = (question) => new Promise((resolve) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.question(question, (answer) => {
    rl.close();
    resolve(answer);
  });
});

async function waitForIdle(client, agentId, timeoutMs = 180_000) {
  const started = Date.now();
  for (;;) {
    const snapshot = await client.agents.ref(agentId).refresh().catch(() => null);
    const agent = snapshot?.agent ?? null;
    if (!agent) throw new Error(`agent ${agentId} is gone`);
    if (agent.status === "idle") return agent;
    if (!["running", "initializing"].includes(agent.status)) {
      throw new Error(`agent ${agentId} entered unexpected status ${JSON.stringify(agent.status)}`);
    }
    if (Date.now() - started > timeoutMs) throw new Error(`agent ${agentId} did not go idle in time`);
    await sleep(2000);
  }
}

async function latestAnswer(client, agentId) {
  const page = await client.agents.ref(agentId).timeline.refetch({
    direction: "tail",
    limit: 1,
    wholeTurns: true,
  });
  const item = page?.items?.at(-1) ?? page?.entries?.at(-1) ?? null;
  return JSON.stringify(item ?? "");
}

async function createScratch(client, scratchDir, instruction) {
  const id = randomUUID().slice(0, 8);
  const dir = mkdtempSync(join(scratchDir, "provider-live-"));
  if (readdirSync(dir).length) throw new Error(`scratch directory ${dir} is not empty`);
  execFileSync("git", ["init", "-q", dir]);
  writeFileSync(join(dir, "README.md"), "provider live-check scratch\n");
  const workspace = await client.workspaces.create({
    source: { kind: "directory", path: dir },
    title: `WSF provider live ${scopeName}`,
    idempotencyKey: `wsf-provider-live:${id}:workspace`,
  });
  const agent = await client.agents.create({
    workspaceId: workspace.id,
    provider: `${provider}/${model}`,
    title: `WSF provider live ${model} ${id}`,
    labels: { "wsf.scratch": "true", "wsf.scope": scopeName },
    idempotencyKey: `wsf-provider-live:${id}:agent`,
  });
  createdAgents.push(agent.id);
  console.log(`scratch scope: ${scopeName}; workspace: ${workspace.id}; agent: ${agent.id}`);
  if (instruction) {
    await agent.send(instruction);
    await waitForIdle(client, agent.id);
  }
  return { agent, workspace };
}

async function runStep(client, scratchDir, name) {
  const instructions = {
    checkpoint: [
      "Reply with a valid fenced CHECKPOINT block exactly containing task, tests, blockers, and next.",
      "Use task: provider live checkpoint; tests: live prompt; blockers: none; next: continue.",
    ].join(" "),
    handoff: "This is a handoff test. Read the supplied resume brief and state the task and next step you would continue.",
    compact: "Reply briefly with the session id or context state you observe after this command.",
    clear: "Reply briefly with the session id or context state you observe after this command.",
    wake: "Wake/heartbeat live-check: acknowledge this prompt and state the action you would take next.",
    advisor: "You are being addressed as an advisor steer. Do not coordinate, take over, or supervise; explain that refusal.",
    limits: "Limit/capacity live-check: if the provider reports a limit or capacity failure, explain the expected interrupted/needsResume handling.",
  }[name] ?? null;
  const { agent } = await createScratch(client, scratchDir, instructions);
  const output = { step: name, agent: agent.id, pass: true, notes: "", tokenCost: null };
  try {
    if (name === "checkpoint") {
      const answer = await latestAnswer(client, agent.id);
      assert.match(answer, /CHECKPOINT/i, "provider did not return a CHECKPOINT block");
    } else if (name === "compact") {
      const before = (await client.agents.ref(agent.id).refresh())?.agent?.persistence?.sessionId;
      await agent.send("/compact Keep the provider live-check task and next step.");
      const afterAgent = await waitForIdle(client, agent.id);
      const after = afterAgent?.persistence?.sessionId;
      assert.ok(before && after && before === after, "compact did not preserve the session id");
    } else if (name === "clear") {
      const before = (await client.agents.ref(agent.id).refresh())?.agent?.persistence?.sessionId;
      await agent.send("/clear");
      const afterAgent = await waitForIdle(client, agent.id);
      const after = afterAgent?.persistence?.sessionId;
      assert.ok(before && after && before !== after, "clear did not produce a new session id");
    } else if (name === "handoff") {
      console.log("Review the response: it must identify the task and next step from the resume/switch/fresh brief.");
    } else if (name === "wake") {
      assert.match(await latestAnswer(client, agent.id), /wake|heartbeat|action/i);
    } else if (name === "advisor") {
      assert.match(await latestAnswer(client, agent.id), /advisor|not.*(coordinate|take over)|refus/i);
    } else if (name === "interruption") {
      await prompt(`Stop/restart the daemon while agent ${agent.id} is running, then press Enter. `);
      const interrupted = (await client.agents.ref(agent.id).refresh())?.agent ?? null;
      output.notes = `Observed status after operator interruption: ${interrupted?.status ?? "unknown"}. Verify scope needsResume and interrupted checkpoint.`;
      output.pass = false;
    } else if (name === "limits") {
      console.log("Trigger or wait for a provider limit/capacity failure manually; verify interrupted state, reason=limit, and needsResume.");
      output.pass = false;
    }
    const snapshot = (await client.agents.ref(agent.id).refresh())?.agent;
    output.tokenCost = snapshot?.lastUsage?.totalTokens ?? snapshot?.lastUsage?.inputTokens ?? null;
  } catch (error) {
    output.pass = false;
    output.notes = error instanceof Error ? error.message : String(error);
  }
  console.log(JSON.stringify(output));
  return output;
}

async function run() {
  console.warn("WARNING: provider live checks create real turns and may consume paid quota.");
  const config = await loadConfig();
  const { scratchDir } = configureRuntime(config);
  mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
  const client = await connect({ clientId: "wsf-provider-live-check" });
  const names = step === "all" ? STEPS.slice(0, -1) : [step];
  const results = [];
  try {
    for (const name of names) results.push(await runStep(client, scratchDir, name));
    console.log("Results table row:", JSON.stringify({ model, provider, results }));
  } finally {
    for (const id of createdAgents) {
      await client.agents.ref(id).archive().catch((error) => console.error(`Could not archive scratch agent ${id}: ${error.message}`));
    }
    await client.close?.().catch(() => {});
  }
}

run().catch((error) => {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
