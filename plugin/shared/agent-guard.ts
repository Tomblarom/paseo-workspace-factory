// Worker guard for /factory and its Command Center entries. The plugin API has
// no visibility predicate for slash commands, so agent-context callbacks
// reject workers at runtime. Pure module: no imports.

export interface GuardAgent {
  readonly parentAgent?: unknown;
  readonly labels?: Readonly<Record<string, string>> | null;
}

export function isWorkerAgent(agent: GuardAgent | null | undefined): boolean {
  if (!agent) return false;
  if (agent.parentAgent !== null && agent.parentAgent !== undefined) return true;
  return agent.labels?.["wsf.role"] === "worker";
}

/** Throws when the command runs in a worker; Paseo shows the message as a toast. */
export function assertSteerContext(agent: GuardAgent | null | undefined, what = "/factory"): void {
  if (isWorkerAgent(agent)) {
    throw new Error(
      `${what} is not available in workers (helper agents). Open a steer tab (Steer A, B, …) or the main workspace and run it there.`,
    );
  }
}
