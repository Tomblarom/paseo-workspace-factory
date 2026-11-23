// Static regression test: the server entry must never register a settings
// document with scope "device" (device settings belong to the client).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const serverEntry = readFileSync(new URL("../index.server.ts", import.meta.url), "utf8");
const settingsModule = readFileSync(new URL("../shared/settings.ts", import.meta.url), "utf8");

function definedScopes(source) {
  const scopes = new Map();
  const re = /export const (\w+) = defineSettings\(\{([\s\S]*?)\n\}\);/g;
  for (const match of source.matchAll(re)) {
    const scope = match[2].match(/scope:\s*"(host|device)"/)?.[1];
    if (scope) scopes.set(match[1], scope);
  }
  return scopes;
}

function registeredNames(source) {
  return [...source.matchAll(/registerSettings\((\w+)\)/g)].map((m) => m[1]);
}

test("server entry registers no device-scope settings", () => {
  const scopes = definedScopes(settingsModule);
  assert.ok(scopes.size > 0, "expected to parse at least one defineSettings block");
  const registered = registeredNames(serverEntry);
  assert.ok(registered.length > 0, "expected to parse at least one registerSettings call");
  for (const name of registered) {
    assert.equal(
      scopes.get(name),
      "host",
      `server entry registers ${name} with scope ${JSON.stringify(scopes.get(name))}, want "host"`,
    );
  }
});
