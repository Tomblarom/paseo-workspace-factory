import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { register } from "node:module";
import { applySettingsEdit, percentage, wholeNumber } from "../client/settings-edit.ts";

register("./ts-resolve-hooks.mjs", import.meta.url);

// Shared modules import each other through `.js` specifiers, so
// they must load dynamically after the resolve hook is registered.
const { factoryDisplaySettings } = await import("../shared/settings.ts");

test("old display settings enable the findings passage by default", () => {
  assert.deepEqual(factoryDisplaySettings.schema.parse({ checkpointInChat: false }), {
    checkpointInChat: false,
    findingsInPrompts: true,
  });
  assert.equal(factoryDisplaySettings.schema.parse({ findingsInPrompts: false }).findingsInPrompts, false);
});

test("autosave reads the new revision and replays only the edit after a conflict", async () => {
  const reads = [
    { values: { warning: 75, exhausted: 90 }, revision: "r1" },
    { values: { warning: 75, exhausted: 95 }, revision: "r2" },
  ];
  const writes = [];
  const result = await applySettingsEdit(
    async () => reads.shift(),
    async (values, revision) => {
      writes.push({ values, revision });
      return revision === "r2";
    },
    (current) => ({ ...current, warning: 80 }),
    () => true,
  );
  assert.deepEqual(writes, [
    { values: { warning: 80, exhausted: 90 }, revision: "r1" },
    { values: { warning: 80, exhausted: 95 }, revision: "r2" },
  ]);
  assert.deepEqual(result, { status: "saved", values: { warning: 80, exhausted: 95 } });
});

test("autosave reports a failure after two conflicting writes", async () => {
  let attempts = 0;
  const result = await applySettingsEdit(
    async () => ({ values: { enabled: false }, revision: `r${attempts}` }),
    async () => {
      attempts += 1;
      return false;
    },
    () => ({ enabled: true }),
    () => true,
  );
  assert.equal(attempts, 2);
  assert.equal(result.status, "failed");
});

test("autosave reports a conflict when the renewed document makes the edit invalid", async () => {
  let attempts = 0;
  const result = await applySettingsEdit(
    async () => ({ values: { profileExists: attempts === 0, priority: 1 }, revision: `r${attempts}` }),
    async () => {
      attempts += 1;
      return false;
    },
    (current) => current.profileExists ? { ...current, priority: 2 } : "The profile was removed.",
    () => true,
  );
  assert.equal(attempts, 1);
  assert.deepEqual(result, { status: "failed", error: "Settings changed while saving. The profile was removed." });
});

test("autosave skips invalid and superseded edits", async () => {
  const read = async () => ({ values: { count: 1 }, revision: "r1" });
  const save = async () => assert.fail("An invalid or superseded edit should never be written");
  assert.deepEqual(await applySettingsEdit(read, save, () => "Enter a count.", () => true), {
    status: "invalid",
    error: "Enter a count.",
  });
  let isCurrent = true;
  const result = await applySettingsEdit(
    async () => {
      isCurrent = false;
      return read();
    },
    () => save(),
    () => ({ count: 2 }),
    () => isCurrent,
  );
  assert.deepEqual(result, { status: "superseded" });
});

test("numeric settings keep blank and partially numeric text invalid", () => {
  for (const invalid of ["", " ", "12x", "1e2", "0x10"]) {
    assert.ok(Number.isNaN(wholeNumber(invalid)));
    assert.ok(Number.isNaN(percentage(invalid)));
  }
  assert.ok(Number.isNaN(wholeNumber("12.5")));
  assert.equal(wholeNumber(" 10 "), 10);
  assert.equal(percentage(" 75.5 "), 75.5);
  assert.equal(percentage("0"), 0);
});

test("literal JSX attributes use real Unicode characters", () => {
  const plugin = new URL("../", import.meta.url);
  const client = new URL("client/", plugin);
  const files = [
    ...readdirSync(plugin).filter((file) => file.endsWith(".tsx")).map((file) => new URL(file, plugin)),
    ...readdirSync(client, { recursive: true })
      .filter((file) => file.endsWith(".tsx"))
      .map((file) => new URL(file, client)),
  ];
  const escapedAttributes = [];
  for (const file of files) {
    const source = ts.createSourceFile(file.pathname, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)
        && /\\u(?:[0-9a-f]{4}|\{[0-9a-f]+\})/i.test(node.initializer.text)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        escapedAttributes.push(`${file.pathname}:${line + 1} ${node.name.getText()}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.deepEqual(escapedAttributes, []);
});
