// Chat display shortening (factory-display): the pure shortener plus the
// client timeline transformer and its cached setting value. The client
// module loads through the ts-resolve-hooks remap; rpc calls use fakes.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-resolve-hooks.mjs", import.meta.url);

const { shortenCheckpoint } = await import("../shared/checkpoint-display.ts");
const display = await import("../client/checkpoint-display.ts");

const PREFIX = "✓ Checkpoint gespeichert · ";

const FULL = [
  "Done with the feature.",
  "",
  "```text",
  "CHECKPOINT",
  "task: Ship the feature",
  "tests: npm test green",
  "blockers: none",
  "next: Release tomorrow",
  "status: done",
  "```",
].join("\n");

test("shortenCheckpoint replaces a full fenced block with one line", () => {
  assert.equal(shortenCheckpoint(FULL), `Done with the feature.\n\n${PREFIX}Release tomorrow`);
});

test("shortenCheckpoint accepts the ## CHECKPOINT variant", () => {
  const text = ["# Update", "", "## CHECKPOINT", "task: Fix login", "next: Deploy"].join("\n");
  assert.equal(shortenCheckpoint(text), `# Update\n\n${PREFIX}Deploy`);
});

test("shortenCheckpoint accepts the **CHECKPOINT** variant", () => {
  const text = ["**CHECKPOINT**", "task: t", "status: blocked"].join("\n");
  assert.equal(shortenCheckpoint(text), `${PREFIX}blocked`);
});

test("shortenCheckpoint accepts a bare CHECKPOINT header", () => {
  const text = ["CHECKPOINT", "task: t", "next: n"].join("\n");
  assert.equal(shortenCheckpoint(text), `${PREFIX}n`);
});

test("shortenCheckpoint leaves messages without a block untouched", () => {
  const text = "Just a message\nwith `code` and no checkpoint.";
  assert.equal(shortenCheckpoint(text), text);
});

test("shortenCheckpoint leaves other fences untouched", () => {
  const text = [
    "Here is code:",
    "```js",
    "const x = 1;",
    "```",
    "",
    "```text",
    "CHECKPOINT",
    "task: Ship it",
    "next: Release",
    "```",
    "",
    "More code:",
    "```py",
    "print(1)",
    "```",
  ].join("\n");
  assert.equal(
    shortenCheckpoint(text),
    [
      "Here is code:",
      "```js",
      "const x = 1;",
      "```",
      "",
      `${PREFIX}Release`,
      "",
      "More code:",
      "```py",
      "print(1)",
      "```",
    ].join("\n"),
  );
});

test("shortenCheckpoint removes a bare fenced block with trailing metadata", () => {
  const text = [
    "```js", "const x = 1;", "```", "", "```", "CHECKPOINT",
    "task: Ship it", "next: Release", "workers: none", "git: clean", "```",
  ].join("\n");
  assert.equal(
    shortenCheckpoint(text),
    ["```js", "const x = 1;", "```", "", `${PREFIX}Release`].join("\n"),
  );
});

test("shortenCheckpoint leaves a malformed block untouched", () => {
  const fenced = ["```text", "CHECKPOINT", "next: Something", "```"].join("\n");
  assert.equal(shortenCheckpoint(fenced), fenced);
  const heading = ["## CHECKPOINT", "", "Some prose, not fields."].join("\n");
  assert.equal(shortenCheckpoint(heading), heading);
});

test("shortenCheckpoint keeps text after the block", () => {
  const text = ["```text", "CHECKPOINT", "task: t", "next: n", "```", "", "Trailing stays."].join(
    "\n",
  );
  assert.equal(shortenCheckpoint(text), `${PREFIX}n\n\nTrailing stays.`);
});

test("shortenCheckpoint falls back from next=none to status, then task", () => {
  assert.equal(
    shortenCheckpoint(["CHECKPOINT", "task: t", "next: none", "status: partial"].join("\n")),
    `${PREFIX}partial`,
  );
  assert.equal(shortenCheckpoint(["CHECKPOINT", "task: Only a task here"].join("\n")),
    `${PREFIX}Only a task here`);
});

test("shortenCheckpoint clips a long summary to about 60 chars", () => {
  const next = "Rewrite the entire authentication flow to support passkeys and hardware tokens";
  const result = shortenCheckpoint(["CHECKPOINT", "task: t", `next: ${next}`].join("\n"));
  assert.ok(result.startsWith(PREFIX));
  const summary = result.slice(PREFIX.length);
  assert.ok(!summary.includes("\n"));
  assert.ok(summary.length <= 61);
  assert.ok(summary.endsWith("…"));
});

beforeEach(() => {
  display.setCheckpointInChat(true);
});

function message(text) {
  return { item: { type: "assistant_message", text }, phase: "complete" };
}

test("transformer returns undefined while streaming", () => {
  display.setCheckpointInChat(false);
  assert.equal(
    display.transformCheckpointMessage({ item: { type: "assistant_message", text: FULL }, phase: "streaming" }),
    undefined,
  );
});

test("transformer returns undefined when checkpointInChat is on", () => {
  assert.equal(display.transformCheckpointMessage(message(FULL)), undefined);
});

test("transformer returns undefined without a block", () => {
  display.setCheckpointInChat(false);
  assert.equal(display.transformCheckpointMessage(message("no block here")), undefined);
});

test("transformer replaces a completed message holding a block", () => {
  display.setCheckpointInChat(false);
  assert.deepEqual(display.transformCheckpointMessage(message(FULL)), {
    items: [
      {
        type: "plugin",
        kind: "factory-checkpoint",
        version: 1,
        data: { text: `Done with the feature.\n\n${PREFIX}Release tomorrow` },
      },
    ],
  });
});

test("setting cache round-trips and sync reads the stored value", async () => {
  assert.equal(display.isCheckpointInChat(), true);
  display.setCheckpointInChat(false);
  assert.equal(display.isCheckpointInChat(), false);
  display.setCheckpointInChat(true);
  let registered = false;
  const stop = display.initCheckpointDisplay({
    rpc: async () => ({ status: "ready", revision: "r1", values: { checkpointInChat: false } }),
    addTimelineTransformer: () => {
      registered = true;
      return () => { registered = false; };
    },
  });
  await display.syncCheckpointDisplayFromSettings();
  assert.equal(display.isCheckpointInChat(), false);
  assert.equal(registered, true);
  stop();
  assert.equal(registered, false);
});

test("sync keeps the default when the read throws or is invalid", async () => {
  display.initCheckpointDisplay({
    rpc: async () => {
      throw new Error("store unavailable");
    },
  });
  await display.syncCheckpointDisplayFromSettings();
  assert.equal(display.isCheckpointInChat(), true);
  display.initCheckpointDisplay({
    rpc: async () => ({ status: "invalid", revision: "r1", error: "bad" }),
  });
  await display.syncCheckpointDisplayFromSettings();
  assert.equal(display.isCheckpointInChat(), true);
});
