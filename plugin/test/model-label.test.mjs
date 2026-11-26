import assert from "node:assert/strict";
import test from "node:test";
import { modelDisplayName } from "../shared/model-label.ts";

test("model display name prefers a distinct catalog label", () => {
  assert.equal(modelDisplayName("gpt-6.1-terra", "GPT-6.1 Terra"), "GPT-6.1 Terra");
  assert.equal(modelDisplayName("claude-opus-5-5", "Opus 5.5"), "Opus 5.5");
});

test("model display name formats a label that only repeats the ID", () => {
  assert.equal(modelDisplayName("gpt-6.2-sol", "gpt-6.2-sol"), "GPT-6.2 Sol");
  assert.equal(modelDisplayName("gpt-6.2-astra"), "GPT-6.2 Astra");
  assert.equal(modelDisplayName("muse-spark-1.3-contributor", null), "Muse Spark 1.3 Contributor");
});

test("model display name keeps non-slug IDs and handles missing values", () => {
  assert.equal(modelDisplayName("anthropic/claude-opus-5-5"), "anthropic/claude-opus-5-5");
  assert.equal(modelDisplayName("us.anthropic.claude:1"), "us.anthropic.claude:1");
  assert.equal(modelDisplayName(null, null), null);
  assert.equal(modelDisplayName("", "  "), null);
});
