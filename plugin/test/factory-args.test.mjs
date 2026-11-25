import test from "node:test";
import assert from "node:assert/strict";
import {
  applyPlanDomain,
  applyPlanMain,
  applyPlanName,
  normalizePlanAdopt,
  normalizePlanAdoptWorker,
  parseFactoryArgs,
  splitAdoptWorkerPairs,
  FACTORY_USAGE,
} from "../shared/factory-args.ts";

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
  assert.throws(() => parseFactoryArgs("cleanup --plan"), /Unknown flag/);
});

test("plan takes one repo and slots (K13: single-workspace enrollment)", () => {
  assert.deepEqual(parseFactoryArgs("plan a/b --slots A,B"), {
    command: "plan",
    repos: ["a/b"],
    slots: ["A", "B"],
  });
  assert.deepEqual(parseFactoryArgs("plan a/b --slots=c,d"), {
    command: "plan",
    repos: ["a/b"],
    slots: ["C", "D"],
  });
  assert.deepEqual(parseFactoryArgs("plan"), { command: "plan", repos: [] });
  assert.throws(() => parseFactoryArgs("plan a/b c/d"), /at most one workspace address/);
  assert.throws(() => parseFactoryArgs("plan a/b --slots A,A"), /duplicates/);
  assert.throws(() => parseFactoryArgs("plan a/b --slots AB"), /single slot letter/);
  assert.throws(() => parseFactoryArgs("plan a/b --to A"), /Unknown flag/);
});

test("retired bulk-provisioning flags fail as unknown flags (K13)", () => {
  for (const flag of ["--allow-fork", "--checkout /tmp/x", "--subject s", "--retitle", "--rename-project P"]) {
    assert.throws(() => parseFactoryArgs(`plan a/b ${flag}`), /Unknown flag/, flag);
  }
  assert.throws(() => parseFactoryArgs("plan a/b --adopt x:B=01234567"), /was retired with multi-repo plans/);
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
  assert.throws(() => parseFactoryArgs("checkpoint a/b"), /exactly one of --task, --from-steer or --from-agent/);
  assert.throws(() => parseFactoryArgs("checkpoint a/b --task x --from-agent y"), /exactly one of --task, --from-steer or --from-agent/);
  assert.throws(() => parseFactoryArgs("checkpoint a/b --task"), /needs a value/);
  assert.throws(() => parseFactoryArgs("checkpoint a/b --task x --allow-fork"), /Unknown flag/);
  assert.deepEqual(parseFactoryArgs('checkpoint --task "do it"'), {
    command: "checkpoint",
    task: "do it",
    tests: [],
    blockers: [],
  });
  assert.throws(() => parseFactoryArgs("checkpoint a b --task x"), /at most one scope address/);
  assert.throws(() => parseFactoryArgs("checkpoint"), /exactly one of --task, --from-steer or --from-agent/);
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
  assert.throws(() => parseFactoryArgs("steer"), /list, add, set or rm/);
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

test("checkpoint accepts --from-steer as a slot letter", () => {
  assert.deepEqual(parseFactoryArgs("checkpoint --from-steer d"), { command: "checkpoint", fromSteer: "D", tests: [], blockers: [] });
  assert.throws(() => parseFactoryArgs("checkpoint --from-steer dd"), /one steer letter/);
  assert.throws(() => parseFactoryArgs("checkpoint --from-steer D --task x"), /exactly one of/);
});

test("fresh, workers, models and drain parse", () => {
  assert.deepEqual(parseFactoryArgs("fresh"), { command: "fresh" });
  assert.deepEqual(parseFactoryArgs("fresh a/b"), { command: "fresh", repo: "a/b" });
  assert.deepEqual(parseFactoryArgs("fresh --slot e"), { command: "fresh", slot: "E" });
  assert.throws(() => parseFactoryArgs("fresh --slot EE"), /one steer letter/);
  assert.deepEqual(parseFactoryArgs("workers"), { command: "workers" });
  assert.deepEqual(parseFactoryArgs("workers a/b"), { command: "workers", repo: "a/b" });
  assert.deepEqual(parseFactoryArgs("models"), { command: "models" });
  assert.deepEqual(parseFactoryArgs("drain"), { command: "drain" });
  assert.deepEqual(parseFactoryArgs("drain --timeout 5m"), { command: "drain", timeout: "5m" });
  assert.throws(() => parseFactoryArgs("fresh a b"), /at most one scope address/);
  assert.throws(() => parseFactoryArgs("fresh --to B"), /Unknown flag --to/);
  assert.throws(() => parseFactoryArgs("workers a b"), /at most one scope address/);
  assert.throws(() => parseFactoryArgs("models x"), /takes no arguments/);
  assert.throws(() => parseFactoryArgs("drain a/b"), /whole instance/);
  assert.throws(() => parseFactoryArgs("drain --timeout"), /needs a value/);
  assert.throws(() => parseFactoryArgs("retire agent-9"), /Unknown subcommand/);
});

test("relocate is gone, assign needs a task", () => {
  assert.throws(() => parseFactoryArgs("relocate --to /data/new"), /Unknown subcommand/);
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

test("removed slot and worker-default aliases fail as unknown subcommands", () => {
  assert.throws(() => parseFactoryArgs("slot set B codex/gpt-6.2-sol"), /Unknown subcommand/);
  assert.throws(() => parseFactoryArgs("slot rm B"), /Unknown subcommand/);
  assert.throws(() => parseFactoryArgs("worker-default codex/gpt-6.2-sol"), /Unknown subcommand/);
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

test("labels takes an optional scope-or-agent address and --apply", () => {
  assert.deepEqual(parseFactoryArgs("labels"), { command: "labels", apply: false });
  assert.deepEqual(parseFactoryArgs("labels me/my-repo"), {
    command: "labels",
    address: "me/my-repo",
    apply: false,
  });
  assert.deepEqual(parseFactoryArgs("labels agent-12345678 --apply"), {
    command: "labels",
    address: "agent-12345678",
    apply: true,
  });
  assert.deepEqual(parseFactoryArgs("labels --apply"), { command: "labels", apply: true });
  assert.throws(() => parseFactoryArgs("labels a b"), /at most one scope or agent address/);
  assert.throws(() => parseFactoryArgs("labels a/b --dry-run"), /Unknown flag/);
  assert.match(FACTORY_USAGE, /\/factory labels \[scope\|agent-id\] \[--apply\]/);
});

test("plan --adopt takes legacy SLOT=<agent-id> pairs", () => {
  const id = "01234567-89ab-cdef-0123-456789abcdef";
  assert.deepEqual(parseFactoryArgs(`plan --adopt B=${id}`), {
    command: "plan",
    repos: [],
    adopt: { B: id },
  });
  // Lowercase slots normalize to uppercase; comma-separated and repeatable, like the CLI.
  assert.deepEqual(parseFactoryArgs(`plan a/b --adopt b=${id},C=abcdef12 --adopt D=00112233`).adopt, {
    B: id,
    C: "abcdef12",
    D: "00112233",
  });
  assert.deepEqual(parseFactoryArgs(`plan a/b --adopt=B=${id}`).adopt, { B: id });
  // Bad syntax and short ids fail with the CLI message.
  assert.throws(
    () => parseFactoryArgs("plan a/b --adopt BB=01234567"),
    /--adopt expects SLOT=<agent-id>, got BB=01234567/,
  );
  assert.throws(() => parseFactoryArgs("plan a/b --adopt B=xyz"), /got B=xyz/);
  assert.match(FACTORY_USAGE, /--adopt B=<agent-id>/);
});

test("plan --adopt rejects scoped pairs and several entries (K13)", () => {
  const one = "01234567-89ab-cdef-0123-456789abcdef";
  assert.throws(() => parseFactoryArgs(`plan a/b --adopt x:B=${one}`), /was retired with multi-repo plans/);
  assert.throws(() => parseFactoryArgs(`plan a/b --adopt :B=${one}`), /was retired with multi-repo plans/);
  assert.throws(() => parseFactoryArgs("plan a/b c/d --adopt B=01234567"), /at most one workspace address/);
  assert.throws(() => parseFactoryArgs("plan a/b --local /tmp --adopt B=01234567"), /at most one workspace address/);
  // A bare plan (current workspace) and a single --local are one entry, so legacy fits.
  assert.deepEqual(parseFactoryArgs("plan --adopt B=01234567").adopt, { B: "01234567" });
  assert.deepEqual(parseFactoryArgs("plan --local /tmp --adopt B=01234567").adopt, { B: "01234567" });
});

test("plan --local takes one path (K13: single entry)", () => {
  assert.deepEqual(parseFactoryArgs("plan --local /tmp/a"), {
    command: "plan",
    repos: [],
    local: ["/tmp/a"],
  });
  assert.throws(() => parseFactoryArgs("plan --local /tmp/a --local /tmp/b"), /at most one workspace address/);
  assert.throws(() => parseFactoryArgs("plan a/b --local /tmp"), /at most one workspace address/);
});

test("normalizePlanAdopt validates SLOT=<agent-id> pairs like the CLI", () => {
  assert.deepEqual(normalizePlanAdopt({ b: "01234567" }, 1), { "*": { B: "01234567" } });
  assert.deepEqual(normalizePlanAdopt({}, 3), {});
  // Direct RPC input gets the same validation as the slash command.
  assert.throws(() => normalizePlanAdopt({ BB: "01234567" }, 1), /got BB=01234567/);
  assert.throws(() => normalizePlanAdopt({ B: "xyz" }, 1), /got B=xyz/);
  assert.throws(() => normalizePlanAdopt({ B: "01234567" }, 2), /needs exactly one workspace entry/);
});

test("plan --name, --main and --domain attach to one entry", () => {
  assert.deepEqual(parseFactoryArgs("plan --local /tmp/a --name demo"), {
    command: "plan",
    repos: [],
    local: ["/tmp/a"],
    name: "demo",
  });
  assert.deepEqual(parseFactoryArgs("plan a/b --main workspace:wks_123").main, "workspace:wks_123");
  assert.deepEqual(parseFactoryArgs("plan a/b --domain my-domain").domain, "my-domain");
  // A bare plan (current workspace) is one entry, so single-entry flags fit.
  assert.deepEqual(parseFactoryArgs("plan --name demo --detach"), {
    command: "plan",
    repos: [],
    name: "demo",
    detach: true,
  });
  assert.throws(() => parseFactoryArgs("plan a/b c/d --name x"), /at most one workspace address/);
  assert.throws(() => parseFactoryArgs("plan a/b c/d --main workspace:wks_1"), /at most one workspace address/);
  assert.throws(() => parseFactoryArgs("plan a/b c/d --domain d"), /at most one workspace address/);
  assert.throws(() => parseFactoryArgs("plan a/b --local /tmp --domain d"), /at most one workspace address/);
  assert.throws(() => parseFactoryArgs("plan a/b --main"), /needs a value/);
  assert.throws(() => parseFactoryArgs('plan a/b --main "  "'), /--main needs a workspace id/);
  assert.throws(() => parseFactoryArgs("plan a/b --name x --name y"), /given twice/);
  assert.match(FACTORY_USAGE, /--name <id>/);
  assert.match(FACTORY_USAGE, /--main workspace:<id>/);
  assert.match(FACTORY_USAGE, /--domain <id>/);
});

test('plan --domain "" clears the pointer', () => {
  assert.deepEqual(parseFactoryArgs('plan a/b --domain ""').domain, "");
  assert.deepEqual(parseFactoryArgs("plan a/b --domain ''").domain, "");
  assert.deepEqual(parseFactoryArgs("plan a/b --domain=").domain, "");
  // A missing value is still an error, even for --domain.
  assert.throws(() => parseFactoryArgs("plan a/b --domain"), /needs a value/);
  // Other flags still reject an explicit empty string.
  assert.throws(() => parseFactoryArgs('plan a/b --name ""'), /needs a value/);
});

test("plan --hub plans one hub-kind scope (K13: single entry)", () => {
  assert.deepEqual(parseFactoryArgs("plan --hub /data/hub"), {
    command: "plan",
    repos: [],
    hub: ["/data/hub"],
  });
  assert.deepEqual(parseFactoryArgs("plan --hub /data/h --adopt B=01234567").adopt, { B: "01234567" });
  assert.throws(() => parseFactoryArgs("plan --hub /data/a --hub /data/b"), /at most one workspace address/);
  assert.throws(() => parseFactoryArgs("plan a/b --hub /data/h"), /at most one workspace address/);
  assert.throws(() => parseFactoryArgs("plan a/b --hub /data/h --adopt B=01234567"), /at most one workspace address/);
  assert.throws(() => parseFactoryArgs("plan --hub"), /needs a value/);
  assert.match(FACTORY_USAGE, /--hub <path\|workspace:id>/);
});

test("plan --adopt-worker takes agent ids with optional slots", () => {
  const one = "01234567-89ab-cdef-0123-456789abcdef";
  assert.deepEqual(parseFactoryArgs(`plan a/b --adopt-worker ${one}`).adoptWorker, { [one]: null });
  assert.deepEqual(parseFactoryArgs(`plan a/b --adopt-worker ${one}@b`).adoptWorker, { [one]: "B" });
  // Comma-separated and repeatable, like --adopt.
  assert.deepEqual(
    parseFactoryArgs(`plan a/b --adopt-worker ${one}@a,abcdef12 --adopt-worker 00112233@c`).adoptWorker,
    { [one]: "A", abcdef12: null, "00112233": "C" },
  );
  assert.deepEqual(parseFactoryArgs(`plan --adopt-worker ${one}`).adoptWorker, { [one]: null });
  assert.throws(() => parseFactoryArgs("plan a/b c/d --adopt-worker 01234567"), /at most one workspace address/);
  assert.throws(() => parseFactoryArgs("plan a/b --local /tmp --adopt-worker 01234567"), /at most one workspace address/);
  assert.throws(() => parseFactoryArgs("plan a/b --adopt-worker xyz"), /--adopt-worker expects <agent-id>\[@<slot>\], got xyz/);
  assert.throws(() => parseFactoryArgs("plan a/b --adopt-worker 01234567@BB"), /got 01234567@BB/);
  assert.throws(() => parseFactoryArgs("plan a/b --adopt-worker"), /needs a value/);
  assert.match(FACTORY_USAGE, /--adopt-worker <agent-id>\[@A\]/);
});

test("plan --detach", () => {
  assert.deepEqual(parseFactoryArgs("plan a/b --detach"), {
    command: "plan",
    repos: ["a/b"],
    detach: true,
  });
  assert.deepEqual(parseFactoryArgs("plan --detach").detach, true);
  assert.throws(() => parseFactoryArgs("plan a/b --detach=x"), /takes no value/);
  assert.match(FACTORY_USAGE, /--detach/);
});

test("applyPlanName, applyPlanMain and applyPlanDomain attach like the CLI", () => {
  assert.deepEqual(applyPlanName([{ local: "/p/demo" }], "demo"), [{ local: "/p/demo", name: "demo" }]);
  assert.deepEqual(applyPlanName(["a/b"], "demo"), [{ repo: "a/b", name: "demo" }]);
  assert.deepEqual(applyPlanMain(["a/b"], "workspace:wks_1"), [{ repo: "a/b", main: "workspace:wks_1" }]);
  assert.deepEqual(applyPlanDomain(["a/b"], "dom"), [{ repo: "a/b", domain: "dom" }]);
  assert.deepEqual(applyPlanDomain(["a/b"], ""), [{ repo: "a/b", domain: "" }]);
  assert.throws(() => applyPlanName(["a", "b"], "x"), /--name needs exactly one workspace entry/);
  assert.throws(() => applyPlanMain(["a", "b"], "workspace:wks_1"), /--main needs exactly one workspace entry/);
  assert.throws(() => applyPlanDomain(["a", "b"], "x"), /--domain needs exactly one workspace entry/);
  assert.throws(() => applyPlanMain(["a/b"], "  "), /--main needs a workspace id/);
  assert.throws(() => applyPlanName([{ repo: "a/b", name: "x" }], "y"), /conflicts with the entry "name"/);
  assert.throws(() => applyPlanMain([{ repo: "a/b", main: "workspace:wks_1" }], "workspace:wks_2"), /conflicts with the entry "main"/);
  assert.throws(() => applyPlanDomain([{ repo: "a/b", domain: "x" }], "y"), /conflicts with the entry "domain"/);
});

test("splitAdoptWorkerPairs and normalizePlanAdoptWorker validate like the CLI", () => {
  const one = "01234567-89ab-cdef-0123-456789abcdef";
  assert.deepEqual(splitAdoptWorkerPairs([`${one}@b,abcdef12`]), { [one]: "B", abcdef12: null });
  assert.deepEqual(splitAdoptWorkerPairs([]), {});
  assert.deepEqual(normalizePlanAdoptWorker({ [one]: "b", abcdef12: null }, 1), { [one]: "B", abcdef12: null });
  assert.deepEqual(normalizePlanAdoptWorker({}, 3), {});
  assert.throws(() => splitAdoptWorkerPairs(["xyz"]), /got xyz/);
  assert.throws(() => splitAdoptWorkerPairs([`${one}@BB`]), /got .*@BB/);
  assert.throws(() => normalizePlanAdoptWorker({ B: "01234567" }, 1), /got B@01234567/);
  assert.throws(() => normalizePlanAdoptWorker({ "01234567": "BB" }, 1), /got 01234567@BB/);
  assert.throws(() => normalizePlanAdoptWorker({ "01234567": null }, 2), /needs exactly one workspace entry/);
});
