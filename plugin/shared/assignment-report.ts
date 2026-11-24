// Report of an assigned steer back to the agent that asked (assign --report-to,
// default the calling agent). Pure: the turn hook reads the scope metadata,
// calls decideAssignmentReport, stamps reportedAt under the workspace lock and
// sends the text. One report per assignment (epoch + reportedAt).

export interface AssignmentRecord {
  by: string;
  epoch: number | null;
  at: string | null;
  reportedAt: string | null;
}

export interface ReportInput {
  assignment: unknown;
  agentId: string;
  slot: string | null;
  role: string;
  activeSteer: unknown;
  epoch: unknown;
  outcome: string;
  scopeId: string;
  /** Parsed CHECKPOINT of the last answer (null when none parsed). */
  block: { task: string; tests: string[]; blockers: string[]; next: string | null; status?: string } | null;
  lastAnswer: string | null;
}

export interface ReportDecision {
  report: boolean;
  reason: string;
  to?: string;
  status?: string;
  text?: string;
}

const MAX_EXCERPT = 1200;

export function readAssignment(value: unknown): AssignmentRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.by !== "string" || !record.by.trim()) return null;
  return {
    by: record.by.trim(),
    epoch: typeof record.epoch === "number" ? record.epoch : null,
    at: typeof record.at === "string" ? record.at : null,
    reportedAt: typeof record.reportedAt === "string" && record.reportedAt ? record.reportedAt : null,
  };
}

function links(text: string | null): string[] {
  if (!text) return [];
  const found = text.match(/https:\/\/github\.com\/[^\s)>\]]+/g) ?? [];
  return [...new Set(found)].slice(0, 5);
}

/**
 * Reports when the ACTIVE steer of the scope ends a completed turn with a
 * CHECKPOINT whose status is done or blocked. Safety net: a completed answer
 * that mentions CHECKPOINT but does not parse (heading or prose instead of
 * the block) is reported as "unparsed" with an excerpt, so a malformed block
 * can never silence the report again.
 */
export function decideAssignmentReport(input: ReportInput): ReportDecision {
  const assignment = readAssignment(input.assignment);
  if (!assignment) return { report: false, reason: "no-assignment" };
  if (assignment.reportedAt) return { report: false, reason: "already-reported" };
  if (input.role !== "steer") return { report: false, reason: "not-steer" };
  if (!input.slot || input.slot !== input.activeSteer) return { report: false, reason: "not-active" };
  if (assignment.by === input.agentId) return { report: false, reason: "self" };
  if (assignment.epoch !== null && typeof input.epoch === "number" && assignment.epoch !== input.epoch) {
    return { report: false, reason: "stale-epoch" };
  }
  if (input.outcome !== "completed") return { report: false, reason: "not-completed" };
  let status: string;
  let body: string;
  if (input.block) {
    if (input.block.status !== "done" && input.block.status !== "blocked") {
      return { report: false, reason: "in-progress" };
    }
    status = input.block.status;
    const list = (values: string[]) => (values.length ? values.join("; ") : "none");
    body = [
      "```text",
      "CHECKPOINT",
      `- task: ${input.block.task}`,
      `- tests: ${list(input.block.tests)}`,
      `- status: ${status}`,
      `- blockers: ${list(input.block.blockers)}`,
      `- next: ${input.block.next ?? "none"}`,
      "```",
    ].join("\n");
  } else if (input.lastAnswer && /checkpoint/i.test(input.lastAnswer)) {
    status = "unparsed";
    const text = input.lastAnswer.trim();
    body = `The answer has no parseable CHECKPOINT block; excerpt:\n${text.length > MAX_EXCERPT ? `${text.slice(0, MAX_EXCERPT)}…` : text}`;
  } else {
    return { report: false, reason: "no-checkpoint" };
  }
  const urls = links(input.lastAnswer);
  const text = [
    `[Factory report] ${input.scopeId} · Steer ${input.slot} (${input.agentId}) · status ${status}`,
    body,
    ...(urls.length ? [`Links: ${urls.join(" ")}`] : []),
  ].join("\n");
  return { report: true, reason: status, to: assignment.by, status, text };
}
