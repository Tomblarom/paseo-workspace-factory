import test from "node:test";
import assert from "node:assert/strict";
import { parseFactoryArgs, FACTORY_USAGE } from "../shared/factory-args.ts";

test("empty args and help show usage", () => {
  assert.deepEqual(parseFactoryArgs(""), { command: "help" });
  assert.deepEqual(parseFactoryArgs("  "), { command: "help" });
  assert.deepEqual(parseFactoryArgs("help"), { command: "help" });
  assert.match(FACTORY_USAGE, /\/factory status/);
});

test("status takes an optional scope and no flags", () => {
  assert.deepEqual(parseFactoryArgs("status owner/repo"), { command: "status", repo: "owner/repo" });
  assert.deepEqual(parseFactoryArgs("status local/folder"), { command: "status", repo: "local/folder" });
  assert.deepEqual(parseFactoryArgs("status"), { command: "status" });
  assert.throws(() => parseFactoryArgs("status a b"), /at most one scope address/);
  assert.throws(() => parseFactoryArgs("status a --apply"), /takes no flags/);
});

test("scopes and cleanup take no address", () => {
  assert.deepEqual(parseFactoryArgs("scopes"), { command: "scopes", candidates: false });
  assert.deepEqual(parseFactoryArgs("scopes --candidates"), { command: "scopes", candidates: true });
  assert.deepEqual(parseFactoryArgs("cleanup"), { command: "cleanup", plan: false, allowDestructive: false, allowIgnored: false });
  assert.throws(() => parseFactoryArgs("scopes a/b"), /takes no scope address/);
  assert.throws(() => parseFactoryArgs("scopes --slots A"), /Unknown flag/);
  assert.throws(() => parseFactoryArgs("cleanup a/b"), /whole instance/);
  assert.throws(() => parseFactoryArgs("cleanup --candidates"), /Unknown flag/);
});

test("cleanup --plan previews deletion with filters", () => {
  assert.deepEqual(parseFactoryArgs("cleanup --plan"), {
    command: "cleanup",
    plan: true,
    allowDestructive: false,
    allowIgnored: false,
  });
  assert.deepEqual(parseFactoryArgs("cleanup --plan --allow-destructive --allow-ignored --only a,b"), {
    command: "cleanup",
    plan: true,
    allowDestructive: true,
    allowIgnored: true,
    only: ["a", "b"],
  });
  assert.throws(() => parseFactoryArgs("cleanup --allow-destructive"), /need --plan/);
  assert.throws(() => parseFactoryArgs("cleanup --only a"), /need --plan/);
  assert.throws(() => parseFactoryArgs("cleanup --plan --only"), /needs a value/);
});

test("plan takes repos, allow-fork and slots", () => {
  assert.deepEqual(parseFactoryArgs("plan a/b c/d"), {
    command: "plan",
    repos: ["a/b", "c/d"],
    allowFork: false,
  });
  assert.deepEqual(parseFactoryArgs("plan a/b --allow-fork --slots A,B"), {
    command: "plan",
    repos: ["a/b"],
    allowFork: true,
    slots: ["A", "B"],
  });
  assert.deepEqual(parseFactoryArgs("plan a/b --slots=c,d"), {
    command: "plan",
    repos: ["a/b"],
    allowFork: false,
    slots: ["C", "D"],
  });
  assert.deepEqual(parseFactoryArgs("plan"), { command: "plan", repos: [], allowFork: false });
  assert.deepEqual(parseFactoryArgs("plan --allow-fork"), {
    command: "plan",
    repos: [],
    allowFork: true,
  });
  assert.throws(() => parseFactoryArgs("plan a/b --slots A,A"), /duplicates/);
  assert.throws(() => parseFactoryArgs("plan a/b --slots AB"), /single slot letter/);
  assert.throws(() => parseFactoryArgs("plan a/b --to A"), /Unknown flag/);
});

test("apply needs a 16-hex hash", () => {
  assert.deepEqual(parseFactoryArgs("apply 0123456789abcdef"), {
    command: "apply",
    hash: "0123456789abcdef",
  });
  assert.deepEqual(parseFactoryArgs("apply 0123456789ABCDEF").hash, "0123456789abcdef");
  assert.throws(() => parseFactoryArgs("apply 123"), /16-character plan hash/);
  assert.throws(() => parseFactoryArgs("apply"), /exactly one plan hash/);
  assert.throws(() => parseFactoryArgs("apply 0123456789abcdef --apply"), /takes no flags/);
});

test("checkpoint needs task or from-agent, plus repeatable lists", () => {
  assert.deepEqual(parseFactoryArgs('checkpoint a/b --task "do the thing"'), {
    command: "checkpoint",
    repo: "a/b",
    task: "do the thing",
    tests: [],
    blockers: [],
  });
  assert.deepEqual(
    parseFactoryArgs("checkpoint a/b --from-agent abc123 --test t1 --test t2 --blocker b --next n").command,
    "checkpoint",
  );
  const parsed = parseFactoryArgs("checkpoint a/b --from-agent abc123 --test t1 --test t2 --next n");
  assert.deepEqual(parsed, {
    command: "checkpoint",
    repo: "a/b",
    fromAgent: "abc123",
    tests: ["t1", "t2"],
    blockers: [],
    next: "n",
  });
  assert.throws(() => parseFactoryArgs("checkpoint a/b"), /either --task or --from-agent/);
  assert.throws(() => parseFactoryArgs("checkpoint a/b --task x --from-agent y"), /either --task or --from-agent/);
  assert.throws(() => parseFactoryArgs("checkpoint a/b --task"), /needs a value/);
  assert.throws(() => parseFactoryArgs("checkpoint a/b --task x --allow-fork"), /Unknown flag/);
  assert.deepEqual(parseFactoryArgs('checkpoint --task "do it"'), {
    command: "checkpoint",
    task: "do it",
    tests: [],
    blockers: [],
  });
  assert.throws(() => parseFactoryArgs("checkpoint a b --task x"), /at most one scope address/);
  assert.throws(() => parseFactoryArgs("checkpoint"), /either --task or --from-agent/);
});

test("switch needs a target slot", () => {
  assert.deepEqual(parseFactoryArgs("switch a/b --to B"), {
    command: "switch",
    repo: "a/b",
    to: "B",
    apply: false,
  });
  assert.deepEqual(parseFactoryArgs("switch a/b --to b --apply").to, "B");
  assert.equal(parseFactoryArgs("switch a/b --to b --apply").apply, true);
  assert.throws(() => parseFactoryArgs("switch a/b"), /needs --to/);
  assert.throws(() => parseFactoryArgs("switch a/b --to BB"), /single slot letter/);
  assert.throws(() => parseFactoryArgs("switch a/b --to B --slots A"), /Unknown flag/);
  assert.deepEqual(parseFactoryArgs("switch --to B"), {
    command: "switch",
    to: "B",
    apply: false,
  });
  assert.throws(() => parseFactoryArgs("switch a b --to B"), /at most one scope address/);
  assert.throws(() => parseFactoryArgs("switch"), /needs --to/);
});

test("resume takes an optional scope and agent", () => {
  assert.deepEqual(parseFactoryArgs("resume"), { command: "resume", brief: false });
  assert.deepEqual(parseFactoryArgs("resume a/b"), { command: "resume", repo: "a/b", brief: false });
  assert.deepEqual(parseFactoryArgs("resume --agent agent-9"), {
    command: "resume",
    agentId: "agent-9",
    brief: false,
  });
  assert.deepEqual(parseFactoryArgs("resume a/b --agent agent-9"), {
    command: "resume",
    repo: "a/b",
    agentId: "agent-9",
    brief: false,
  });
  assert.match(FACTORY_USAGE, /\/factory resume/);
  assert.throws(() => parseFactoryArgs("resume a b"), /at most one scope address/);
  assert.throws(() => parseFactoryArgs("resume --to B"), /Unknown flag/);
  assert.throws(() => parseFactoryArgs("resume --agent"), /needs a value/);
});

test("resume --brief keeps the read-only path", () => {
  assert.deepEqual(parseFactoryArgs("resume --brief"), { command: "resume", brief: true });
  assert.deepEqual(parseFactoryArgs("resume a/b --brief"), {
    command: "resume",
    repo: "a/b",
    brief: true,
  });
  assert.deepEqual(parseFactoryArgs("resume --agent agent-9 --brief"), {
    command: "resume",
    agentId: "agent-9",
    brief: true,
  });
  assert.match(FACTORY_USAGE, /--brief/);
  assert.throws(() => parseFactoryArgs("resume --brief=x"), /takes no value/);
  assert.throws(() => parseFactoryArgs("resume --brief --apply"), /Unknown flag/);
});

test("unknown subcommands, flags and quotes fail with usage", () => {
  assert.throws(() => parseFactoryArgs("frobnicate a/b"), /Unknown subcommand/);
  assert.throws(() => parseFactoryArgs("status a/b --bogus"), /Unknown flag/);
  assert.throws(() => parseFactoryArgs("plan a/b --slots A --slots B"), /given twice/);
  assert.throws(() => parseFactoryArgs('status "a/b'), /quote is not closed/);
  assert.throws(() => parseFactoryArgs("help extra"), /no command "extra"/);
  assert.throws(() => parseFactoryArgs("help switch extra"), /at most one command name/);
  try {
    parseFactoryArgs("bogus");
    assert.fail("must throw");
  } catch (error) {
    assert.match(String(error), /\/factory switch/);
  }
});

test("help explains the commands and gives examples per command", async () => {
  const { factoryHelp, FACTORY_COMMANDS } = await import("../shared/factory-args.ts");
  assert.deepEqual(parseFactoryArgs("help switch"), { command: "help", topic: "switch" });
  const overview = factoryHelp();
  for (const name of Object.keys(FACTORY_COMMANDS)) assert.match(overview, new RegExp(`\\b${name}\\b`));
  assert.match(overview, /\/factory help <command>/);
  assert.match(overview, /getting-started/);
  for (const [name, entry] of Object.entries(FACTORY_COMMANDS)) {
    const detail = factoryHelp(name);
    assert.ok(detail.startsWith(entry.usage), name);
    assert.ok(entry.examples.length > 0, name);
    for (const example of entry.examples) {
      assert.ok(example.startsWith(`/factory ${name}`), `${name}: ${example}`);
      if (!example.includes("<")) parseFactoryArgs(example.replace(/^\/factory /, ""));
    }
  }
});

test("parse errors name the next step for the command", () => {
  try {
    parseFactoryArgs("switch");
    assert.fail("must throw");
  } catch (error) {
    const message = String(error);
    assert.match(message, /Usage: \/factory switch/);
    assert.match(message, /Example: \/factory switch --to B/);
    assert.match(message, /More: \/factory help switch/);
  }
});

test("worker and steer lists parse list, set and rm", () => {
  assert.deepEqual(parseFactoryArgs("worker list"), { command: "worker", action: "list" });
  assert.deepEqual(parseFactoryArgs("steer list"), { command: "steer", action: "list" });
  assert.deepEqual(parseFactoryArgs("worker set 2 claude/claude-sonnet-5-5 --thinking high --mode auto --profile cs --dry-run"), {
    command: "worker",
    action: "set",
    n: "2",
    spec: "claude/claude-sonnet-5-5",
    thinking: "high",
    mode: "auto",
    profile: "cs",
    dryRun: true,
  });
  assert.deepEqual(parseFactoryArgs("worker set 1 my-profile"), {
    command: "worker",
    action: "set",
    n: "1",
    spec: "my-profile",
    dryRun: false,
  });
  assert.deepEqual(parseFactoryArgs("steer set b codex/gpt-6.2-sol"), {
    command: "steer",
    action: "set",
    n: "B",
    spec: "codex/gpt-6.2-sol",
    dryRun: false,
  });
  assert.deepEqual(parseFactoryArgs("steer rm 2 --dry-run"), { command: "steer", action: "rm", n: "2", dryRun: true });
  assert.deepEqual(parseFactoryArgs("worker rm 3"), { command: "worker", action: "rm", n: "3", dryRun: false });
});

test("worker and steer reject bad input with usage", () => {
  assert.throws(() => parseFactoryArgs("worker"), /list, pick, set or rm/);
  assert.throws(() => parseFactoryArgs("steer"), /list, set or rm/);
  assert.throws(() => parseFactoryArgs("worker set 1"), /needs a position and a profile/);
  assert.throws(() => parseFactoryArgs("worker set B x/y"), /expects a position/);
  assert.throws(() => parseFactoryArgs("worker set 0 x/y"), /expects a position/);
  assert.throws(() => parseFactoryArgs("steer set 1 profile --thinking high"), /only go with provider\/model/);
  assert.throws(() => parseFactoryArgs("worker list --dry-run"), /takes no flags/);
  assert.throws(() => parseFactoryArgs("worker rm"), /exactly one position/);
  assert.throws(() => parseFactoryArgs("steer rm AB"), /slot letter/);
  assert.throws(() => parseFactoryArgs("worker set 1 a/b --to A"), /Unknown flag/);
  assert.throws(() => parseFactoryArgs("status --dry-run"), /takes no flags/);
});

test("fresh, workers, models and drain parse", () => {
  assert.deepEqual(parseFactoryArgs("fresh"), { command: "fresh" });
  assert.deepEqual(parseFactoryArgs("fresh a/b"), { command: "fresh", repo: "a/b" });
  assert.deepEqual(parseFactoryArgs("workers"), { command: "workers" });
  assert.deepEqual(parseFactoryArgs("workers a/b"), { command: "workers", repo: "a/b" });
  assert.deepEqual(parseFactoryArgs("models"), { command: "models" });
  assert.deepEqual(parseFactoryArgs("drain"), { command: "drain" });
  assert.deepEqual(parseFactoryArgs("drain --timeout 5m"), { command: "drain", timeout: "5m" });
  assert.throws(() => parseFactoryArgs("fresh a b"), /at most one scope address/);
  assert.throws(() => parseFactoryArgs("fresh --to B"), /takes no flags/);
  assert.throws(() => parseFactoryArgs("workers a b"), /at most one scope address/);
  assert.throws(() => parseFactoryArgs("models x"), /takes no arguments/);
  assert.throws(() => parseFactoryArgs("drain a/b"), /whole instance/);
  assert.throws(() => parseFactoryArgs("drain --timeout"), /needs a value/);
  assert.throws(() => parseFactoryArgs("retire"), /exactly one agent id/);
  assert.deepEqual(parseFactoryArgs("retire agent-9"), { command: "retire", agentId: "agent-9" });
  assert.throws(() => parseFactoryArgs("retire a b"), /exactly one agent id/);
});

test("relocate needs a target, assign needs a task", () => {
  assert.deepEqual(parseFactoryArgs("relocate --to /data/new"), { command: "relocate", to: "/data/new" });
  assert.deepEqual(parseFactoryArgs("relocate a/b --to other-project"), {
    command: "relocate",
    repo: "a/b",
    to: "other-project",
  });
  assert.throws(() => parseFactoryArgs("relocate"), /needs --to/);
  assert.throws(() => parseFactoryArgs("relocate a b --to x"), /at most one scope address/);
  assert.deepEqual(parseFactoryArgs('assign --task "ship it"'), {
    command: "assign",
    task: "ship it",
    tests: [],
    blockers: [],
  });
  assert.deepEqual(parseFactoryArgs("assign a/b --task t --test x --blocker y --next n"), {
    command: "assign",
    repo: "a/b",
    task: "t",
    tests: ["x"],
    blockers: ["y"],
    next: "n",
  });
  assert.throws(() => parseFactoryArgs("assign"), /needs --task/);
  assert.throws(() => parseFactoryArgs("assign a b --task t"), /at most one scope address/);
});

test("worker pick takes an optional scope", () => {
  assert.deepEqual(parseFactoryArgs("worker pick"), { command: "worker", action: "pick" });
  assert.deepEqual(parseFactoryArgs("worker pick a/b"), { command: "worker", action: "pick", repo: "a/b" });
  assert.throws(() => parseFactoryArgs("worker pick a b"), /at most one scope address/);
  assert.throws(() => parseFactoryArgs("worker pick --dry-run"), /takes no flags/);
  assert.throws(() => parseFactoryArgs("steer pick"), /no pick/);
});

test("slot and worker-default are deprecated aliases of steer and worker set 1", () => {
  assert.deepEqual(parseFactoryArgs("slot set B codex/gpt-6.2-sol"), {
    command: "steer",
    action: "set",
    n: "B",
    spec: "codex/gpt-6.2-sol",
    dryRun: false,
    note: 'Note: "slot" is deprecated, use "steer" instead.',
  });
  assert.deepEqual(parseFactoryArgs("slot rm B"), {
    command: "steer",
    action: "rm",
    n: "B",
    dryRun: false,
    note: 'Note: "slot" is deprecated, use "steer" instead.',
  });
  assert.deepEqual(parseFactoryArgs("worker-default codex/gpt-6.2-sol"), {
    command: "worker",
    action: "set",
    n: "1",
    spec: "codex/gpt-6.2-sol",
    dryRun: false,
    note: 'Note: "worker-default" is deprecated, use "worker set 1" instead.',
  });
  assert.throws(() => parseFactoryArgs("slot set B my-profile"), /provider\/model/);
  assert.throws(() => parseFactoryArgs("slot"), /set or rm/);
  assert.throws(() => parseFactoryArgs("worker-default"), /needs a profile/);
});

test("model advisor and sensitive take a profile and on|off", () => {
  assert.deepEqual(parseFactoryArgs("model advisor claude-opus on"), {
    command: "model",
    flag: "advisor",
    spec: "claude-opus",
    on: true,
    dryRun: false,
  });
  assert.deepEqual(parseFactoryArgs("model sensitive muse-contributor off --dry-run"), {
    command: "model",
    flag: "sensitive",
    spec: "muse-contributor",
    on: false,
    dryRun: true,
  });
  assert.throws(() => parseFactoryArgs("model advisor x maybe"), /on or off/);
  assert.throws(() => parseFactoryArgs("model advisor x"), /needs a profile/);
  assert.throws(() => parseFactoryArgs("model colour x on"), /advisor or sensitive/);
  assert.match(FACTORY_USAGE, /\/factory worker/);
  assert.match(FACTORY_USAGE, /\/factory model advisor\|sensitive/);
});
