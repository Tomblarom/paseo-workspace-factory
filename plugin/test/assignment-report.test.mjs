import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
register("./ts-resolve-hooks.mjs", import.meta.url);
const { decideAssignmentReport, readAssignment } = await import("../shared/assignment-report.ts");
const { parseCheckpointBlock } = await import("../server/core/steer.mjs");

const base = {
  assignment: { by: "requester", epoch: 1, at: "2026-11-24T16:00:00Z", reportedAt: null },
  agentId: "steer-a",
  slot: "A",
  role: "steer",
  activeSteer: "A",
  epoch: 1,
  outcome: "completed",
  scopeId: "owner/repo@feat",
};
const block = (status) => ({ task: "Ship", tests: ["npm test ok"], blockers: [], next: null, ...(status ? { status } : {}) });

test("done and blocked checkpoints of the active steer are reported once", () => {
  for (const status of ["done", "blocked"]) {
    const d = decideAssignmentReport({ ...base, block: block(status), lastAnswer: "PR https://github.com/o/r/pull/7 is up" });
    assert.equal(d.report, true, status);
    assert.equal(d.to, "requester");
    assert.match(d.text, /^\[Factory report\] owner\/repo@feat · Steer A \(steer-a\) · status /);
    assert.match(d.text, new RegExp(`- status: ${status}`));
    assert.match(d.text, /Links: https:\/\/github\.com\/o\/r\/pull\/7/);
    // The report's own block parses back, so the requester can use it as a checkpoint.
    assert.equal(parseCheckpointBlock(d.text).status, status);
  }
  const again = decideAssignmentReport({ ...base, assignment: { ...base.assignment, reportedAt: "x" }, block: block("done"), lastAnswer: "" });
  assert.deepEqual([again.report, again.reason], [false, "already-reported"]);
});

test("no report while in progress, for others, stale epochs or failed turns", () => {
  const cases = [
    [{ block: block("partial") }, "in-progress"],
    [{ block: block(null) }, "in-progress"],
    [{ block: block("done"), activeSteer: "B" }, "not-active"],
    [{ block: block("done"), role: "worker" }, "not-steer"],
    [{ block: block("done"), agentId: "requester" }, "self"],
    [{ block: block("done"), epoch: 2 }, "stale-epoch"],
    [{ block: block("done"), outcome: "failed" }, "not-completed"],
    [{ block: null, lastAnswer: "still working" }, "no-checkpoint"],
    [{ assignment: null, block: block("done") }, "no-assignment"],
  ];
  for (const [over, reason] of cases) {
    const d = decideAssignmentReport({ ...base, lastAnswer: null, ...over });
    assert.deepEqual([d.report, d.reason], [false, reason], reason);
  }
});

test("a malformed CHECKPOINT (heading plus prose) is reported as unparsed", () => {
  const answer = "## CHECKPOINT\n\nPR #121 is open as draft. Tests are green.";
  assert.equal(parseCheckpointBlock(answer), null);
  const d = decideAssignmentReport({ ...base, block: null, lastAnswer: answer });
  assert.equal(d.report, true);
  assert.equal(d.status, "unparsed");
  assert.match(d.text, /no parseable CHECKPOINT block; excerpt:\n## CHECKPOINT/);
});

test("headings around a proper field list parse", () => {
  for (const head of ["## CHECKPOINT", "**CHECKPOINT**", "### Checkpoint"]) {
    const parsed = parseCheckpointBlock(`${head}\n- task: Ship\n- tests: none\n- status: done\n- blockers: none\n- next: none`);
    assert.equal(parsed?.status, "done", head);
  }
});

test("readAssignment rejects records without a requester", () => {
  assert.equal(readAssignment(null), null);
  assert.equal(readAssignment({ by: "  " }), null);
  assert.deepEqual(readAssignment({ by: "x" }), { by: "x", epoch: null, at: null, reportedAt: null });
});
