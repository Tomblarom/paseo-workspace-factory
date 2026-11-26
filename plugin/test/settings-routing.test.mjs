import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { applySettingsEdit } from "../client/settings-edit.ts";
import { editPriority, editProfile, usedProfileNames } from "../client/settings-routing.ts";

register("./ts-resolve-hooks.mjs", import.meta.url);
const { validateFactorySettings } = await import("../shared/settings-validate.ts");

function settings() {
  const profile = { provider: "codex", model: "gpt-6.2-sol", thinking: null, mode: null, advisor: false, sensitive: false };
  return {
    profiles: {
      first: profile,
      second: { ...profile, sensitive: true },
      advisor: { ...profile, advisor: true },
      legacy: profile,
    },
    steerPriority: ["first"],
    advisorPriority: ["advisor"],
    workerPriority: ["first", "second"],
    slots: { A: "first", B: "legacy" },
    prepare: ["A"],
    initialActive: "A",
    legacySnapshot: { version: 2, values: {} },
    routingStrategy: "efficiency",
    quota: { warnPct: 75, exhaustedPct: 90 },
    githubOwner: "octocat",
    checkoutRoot: "/projects",
  };
}

test("adding a route appends it to one role and validates the latest classification", () => {
  const current = settings();
  assert.deepEqual(editPriority("steerPriority", "second", "add")(current), {
    ...current, steerPriority: ["first", "second"],
  });
  assert.equal(editPriority("workerPriority", "first", "add")(current), current);
  assert.match(editPriority("steerPriority", "advisor", "add")(current), /no longer eligible/);
  assert.match(editPriority("advisorPriority", "first", "add")(current), /no longer eligible/);
  assert.match(editPriority("workerPriority", "missing", "add")(current), /was removed/);
  const withComma = { ...current, profiles: { ...current.profiles, "first, second": current.profiles.first } };
  assert.deepEqual(editPriority("steerPriority", "first, second", "add")(withComma).steerPriority, ["first", "first, second"]);
});

test("steer and advisor priorities may be empty and removal preserves legacy profile references", () => {
  const current = settings();
  const withoutSteer = editPriority("steerPriority", "first", "remove")(current);
  const withoutAdvisor = editPriority("advisorPriority", "advisor", "remove")(withoutSteer);
  assert.deepEqual(withoutAdvisor, { ...current, steerPriority: [], advisorPriority: [] });
  assert.deepEqual(new Set(usedProfileNames(withoutAdvisor)), new Set(["first", "second", "legacy"]));
});

test("queued removals always retain a worker profile", () => {
  const current = settings();
  const afterRemoval = editPriority("workerPriority", "first", "remove")(current);
  assert.deepEqual(afterRemoval, { ...current, workerPriority: ["second"] });
  assert.equal(editPriority("workerPriority", "first", "remove")(afterRemoval), afterRemoval);
  assert.match(editPriority("workerPriority", "second", "remove")(afterRemoval), /at least one worker/);
});

test("changing the Advisor flag moves an assigned profile between priorities and retains routing guards", () => {
  const current = { ...settings(), steerPriority: ["first", "second"], workerPriority: ["first"] };
  const toggleAdvisor = (name, advisor) => editProfile(name, (profile) => ({ ...profile, advisor }));
  const asAdvisor = toggleAdvisor("second", true)(current);
  assert.deepEqual(asAdvisor, {
    ...current,
    profiles: { ...current.profiles, second: { ...current.profiles.second, advisor: true } },
    steerPriority: ["first"],
    advisorPriority: ["advisor", "second"],
  });
  assert.deepEqual(validateFactorySettings(asAdvisor), []);
  assert.deepEqual(toggleAdvisor("second", false)(asAdvisor), current);

  const unassigned = toggleAdvisor("legacy", true)(current);
  assert.deepEqual(unassigned.steerPriority, current.steerPriority);
  assert.deepEqual(unassigned.advisorPriority, current.advisorPriority);

  const invalid = validateFactorySettings(toggleAdvisor("first", true)(current));
  assert.ok(invalid.some((message) => message.includes('workerPriority profile "first" is tagged as advisor')));
  assert.ok(invalid.some((message) => message.includes("initialActive A is an advisor slot")));
});

test("reorder moves the named profile one position relative to a newer revision", async () => {
  const current = { ...settings(), advisorPriority: ["first-advisor", "advisor"] };
  const newer = { ...current, advisorPriority: ["first-advisor", "new-advisor", "advisor"] };
  const reads = [{ values: current, revision: "r1" }, { values: newer, revision: "r2" }];
  const writes = [];
  const move = editPriority("advisorPriority", "advisor", "up");
  const result = await applySettingsEdit(
    async () => reads.shift(),
    async (values, revision) => { writes.push(values); return revision === "r2"; },
    move,
    () => true,
  );
  assert.deepEqual(writes, [
    { ...current, advisorPriority: ["advisor", "first-advisor"] },
    { ...newer, advisorPriority: ["first-advisor", "advisor", "new-advisor"] },
  ]);
  assert.deepEqual(result, { status: "saved", values: writes[1] });
  assert.match(move({ ...newer, advisorPriority: ["new-advisor"] }), /removed from the priority list/);
  const first = { ...newer, advisorPriority: ["advisor", "new-advisor"] };
  assert.equal(move(first), first);
});
