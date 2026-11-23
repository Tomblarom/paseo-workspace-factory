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
  assert.deepEqual(parseFactoryArgs("cleanup"), { command: "cleanup" });
  assert.throws(() => parseFactoryArgs("scopes a/b"), /takes no scope address/);
  assert.throws(() => parseFactoryArgs("scopes --slots A"), /Unknown flag/);
  assert.throws(() => parseFactoryArgs("cleanup a/b"), /whole instance/);
  assert.throws(() => parseFactoryArgs("cleanup --candidates"), /takes no flags/);
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
  assert.throws(() => parseFactoryArgs("apply 123"), /16-hex plan hash/);
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
  assert.deepEqual(parseFactoryArgs("resume"), { command: "resume" });
  assert.deepEqual(parseFactoryArgs("resume a/b"), { command: "resume", repo: "a/b" });
  assert.deepEqual(parseFactoryArgs("resume --agent agent-9"), { command: "resume", agentId: "agent-9" });
  assert.deepEqual(parseFactoryArgs("resume a/b --agent agent-9"), {
    command: "resume",
    repo: "a/b",
    agentId: "agent-9",
  });
  assert.match(FACTORY_USAGE, /\/factory resume/);
  assert.throws(() => parseFactoryArgs("resume a b"), /at most one scope address/);
  assert.throws(() => parseFactoryArgs("resume --to B"), /Unknown flag/);
  assert.throws(() => parseFactoryArgs("resume --agent"), /needs a value/);
});

test("unknown subcommands, flags and quotes fail with usage", () => {
  assert.throws(() => parseFactoryArgs("frobnicate a/b"), /Unknown subcommand/);
  assert.throws(() => parseFactoryArgs("status a/b --bogus"), /Unknown flag/);
  assert.throws(() => parseFactoryArgs("plan a/b --slots A --slots B"), /given twice/);
  assert.throws(() => parseFactoryArgs('status "a/b'), /Unterminated quote/);
  assert.throws(() => parseFactoryArgs("help extra"), /takes no arguments/);
  try {
    parseFactoryArgs("bogus");
    assert.fail("must throw");
  } catch (error) {
    assert.match(String(error), /\/factory switch/);
  }
});
