// Argument parsing for the /factory slash command. Pure module: no imports,
// so both the plugin bundles and plain node:test can use it.

interface CommandHelp {
  usage: string;
  summary: string;
  details: string[];
  examples: string[];
}

// One entry per subcommand: the single source for usage lines, /factory help
// and the "what to try next" part of every parse error.
export const FACTORY_COMMANDS: Record<string, CommandHelp> = {
  status: {
    usage: "/factory status [scope]",
    summary: "Who is in charge, the current task, steers and workers.",
    details: [
      "Read-only. Without a scope it shows the project of this workspace.",
      "A scope is a project: owner/repo, a scope id, a workspace id (wks_…) or a folder path.",
    ],
    examples: ["/factory status", "/factory status me/my-repo"],
  },
  scopes: {
    usage: "/factory scopes [--candidates]",
    summary: "One line per project the factory manages.",
    details: [
      "Read-only. --candidates lists Paseo workspaces the factory does not manage yet, with a plan suggestion.",
    ],
    examples: ["/factory scopes", "/factory scopes --candidates"],
  },
  cleanup: {
    usage: "/factory cleanup",
    summary: "Report leftovers (test scopes, missing folders, empty projects).",
    details: [
      "Read-only. Shows what would be lost for each candidate and the native Paseo command that archives it; nothing is deleted.",
    ],
    examples: ["/factory cleanup"],
  },
  fresh: {
    usage: "/factory fresh [scope] [--slot E | --worker <id>] [--model <provider/model>] [--keep-chat-history]",
    summary: "Preview a same-tab refresh or a replacement agent.",
    details: [
      "Confirm the preview in the Factory panel. Replacing an agent archives the previous one.",
      "Use --model to select a different provider/model and --keep-chat-history to request a new agent.",
    ],
    examples: ["/factory fresh", "/factory fresh me/my-repo"],
  },
  assign: {
    usage: "/factory assign [scope] --task <text> [--test <text>]… [--blocker <text>]… [--next <text>]",
    summary: "Send a task to a project's active steer (for hubs and domains).",
    details: [
      "Shows a preview; confirm it in the Factory panel.",
      "Replaces the recorded checkpoint and delivers it to the active steer.",
      "Put text with spaces in quotes.",
    ],
    examples: ['/factory assign --task "Ship 2.0" --next "Announce it"'],
  },
  workers: {
    usage: "/factory workers [scope]",
    summary: "Show the helper agents of a project.",
    details: ["Read-only. Without a scope it shows the project of this workspace."],
    examples: ["/factory workers", "/factory workers me/my-repo"],
  },
  models: {
    usage: "/factory models",
    summary: "List the providers and models Paseo offers right now.",
    details: ["Read-only. This is the catalog every availability check runs against."],
    examples: ["/factory models"],
  },
  drain: {
    usage: "/factory drain [--timeout 10m]",
    summary: "Wait until no factory agent runs, then it is safe to restart.",
    details: [
      "Agents still running after the timeout are marked planned-restart.",
      "A duration like 30s, 10m or 1h; default 10m.",
    ],
    examples: ["/factory drain", "/factory drain --timeout 5m"],
  },
  quota: {
    usage: "/factory quota",
    summary: "Show provider quota pools and which steer or worker uses each.",
    details: [
      "Read-only. Warn and exhausted states use the quota thresholds from the Factory settings.",
    ],
    examples: ["/factory quota"],
  },
  plan: {
    usage: "/factory plan [scope] [--slots B] [--adopt B=<agent-id>] [--local <path>] [--hub <path|workspace:id>] [--name <id>] [--main workspace:<id>] [--domain <id>] [--adopt-worker <agent-id>[@A]] [--detach]",
    summary: "Preview enrolling one existing workspace, or repairing it. Writes nothing.",
    details: [
      "Ends with a 16-character plan hash; run it with /factory apply <hash>.",
      "Plans exactly one workspace: open it natively first, then plan it by scope, workspace id or --local <path>.",
      "--slots B selects the initial coordinator from live holders in the workspace.",
      "--adopt B=<agent-id> takes over an existing tab titled Steer B in that workspace (repeatable, comma-separated).",
      "--local plans an existing folder without GitHub. --hub plans a hub-kind scope from a folder or worktree workspace.",
      "--name sets the scope id of a folder or workspace entry.",
      "--main adopts a worktree workspace as the main workspace of a github scope. --domain sets the domain pointer (--domain \"\" clears it).",
      "--adopt-worker <agent-id>[@A] labels an agent as a worker of a live coordinator (defaults to the active steer). --detach plans a native detach for parented steer candidates.",
    ],
    examples: ["/factory plan", "/factory plan me/my-repo", "/factory plan me/my-repo --slots B", "/factory plan --adopt B=01234567-89ab-cdef-0123-456789abcdef", "/factory plan me/my-repo --domain my-domain", "/factory plan --hub /data/hub"],
  },
  apply: {
    usage: "/factory apply <plan-hash>",
    summary: "Run exactly the plan you previewed.",
    details: [
      "The hash is the 16-character code at the end of /factory plan.",
      "Safe to repeat after a failure: finished steps are skipped.",
    ],
    examples: ["/factory apply 0123456789abcdef"],
  },
  checkpoint: {
    usage:
      "/factory checkpoint [scope] (--task <text> | --from-steer <slot> | --from-agent <id>) [--test <text>]… [--blocker <text>]… [--next <text>]",
    summary: "Save where the work stands (task, tests, blockers, next step).",
    details: [
      "Shows a preview; confirm it in the Factory panel.",
      "--from-steer <slot> (or --from-agent <id>) takes the CHECKPOINT block from that steer's last answer.",
      "Put text with spaces in quotes.",
    ],
    examples: [
      '/factory checkpoint --task "Add login form" --next "Write tests"',
      "/factory checkpoint --from-steer D",
    ],
  },
  switch: {
    usage: "/factory switch [scope] --to <slot> [--apply]",
    summary: "Hand the work to another steer (slot letter A–Z).",
    details: [
      "Shows the handover message first; confirm it in the Factory panel.",
      "Save a checkpoint before switching so the new steer knows the task.",
    ],
    examples: ["/factory switch --to B"],
  },
  resume: {
    usage: "/factory resume [scope] [--brief] [--agent <id>]",
    summary: "Restart this steer after a break, restart or limit (--brief only reads).",
    details: [
      "Without --brief it saves a checkpoint, clears this steer's context and sends the resume brief into the fresh timeline.",
      "When this steer is not the active one, resume also makes it the active one.",
      "--brief is read-only: it shows task, next step, git state and workers instead of the old chat.",
      "--agent <id> targets another agent and asks for confirmation in the Factory panel.",
    ],
    examples: ["/factory resume", "/factory resume --brief"],
  },
  worker: {
    usage:
      "/factory worker list | pick [scope] | set <n> <profile|provider/model> [--thinking X] [--mode Y] [--profile name] [--dry-run] | rm <n> [--dry-run]",
    summary: "Show or edit the prioritized list of worker models.",
    details: [
      "Position 1 is tried first; if its provider or model is unavailable, the next entry is used.",
      "pick shows which profile a worker would start with now, plus the matching paseo run flags.",
      "set inserts at position n and moves the rest down; a model that is already listed moves instead of repeating.",
      "A model that is unavailable right now is saved with a warning. Advisor profiles cannot be workers.",
      "The change is saved at once in the plugin settings (--dry-run only shows it).",
    ],
    examples: [
      "/factory worker list",
      "/factory worker pick",
      "/factory worker set 1 claude/claude-sonnet-5-5",
      "/factory worker rm 3",
    ],
  },
  steer: {
    usage:
      "/factory steer list | add [slot] [profile|provider/model] [--thinking X] [--mode Y] [--profile name] [--dry-run]",
    summary: "Show model priorities or add a steer to this scope.",
    details: [
      "list shows steer and advisor model priorities. Edit them in Factory settings.",
      "add suggests the next free letter when omitted. Confirm the preview in the Factory panel.",
    ],
    examples: ["/factory steer list", "/factory steer add", "/factory steer add C codex/gpt-6.2-sol --thinking high"],
  },
  model: {
    usage: "/factory model advisor|sensitive <profile|provider/model> on|off [--dry-run]",
    summary: "Tag a profile as advisor (second opinion only) or sensitive (sanitized tasks only).",
    details: [
      "advisor: never a coordinating steer or worker. sensitive: workers on it get only sanitized technical tasks.",
      "Saved at once in the plugin settings (--dry-run only shows it).",
    ],
    examples: ["/factory model advisor claude-opus on", "/factory model sensitive muse-contributor off"],
  },
};

export const FACTORY_USAGE = Object.values(FACTORY_COMMANDS)
  .map((entry) => entry.usage)
  .join("\n");

/** Overview shown by /factory and /factory help. */
export function factoryHelp(topic?: string): string {
  if (topic) {
    const entry = FACTORY_COMMANDS[topic];
    return [
      entry.usage,
      "",
      entry.summary,
      ...entry.details,
      "",
      "Examples:",
      ...entry.examples.map((example) => `  ${example}`),
    ].join("\n");
  }
  const width = Math.max(...Object.keys(FACTORY_COMMANDS).map((name) => name.length));
  return [
    "Workspace Factory keeps several coordinating agents (steers A, B, C …) per project.",
    "One steer is in charge; a short checkpoint lets another steer take over without",
    "re-reading the chat. Changes always show a preview first.",
    "",
    "Commands (without a scope they use this workspace's project):",
    ...Object.entries(FACTORY_COMMANDS).map(
      ([name, entry]) => `  ${name.padEnd(width)}  ${entry.summary}`,
    ),
    "",
    "Common tasks:",
    "  See the current task           /factory status",
    "  Set up a project               /factory plan me/my-repo, then /factory apply <hash>",
    "  Hand over to Steer B           /factory switch --to B",
    "  Continue after a break         /factory resume",
    "",
    "Details for one command: /factory help <command>",
    "Full guide: docs/getting-started.md",
  ].join("\n");
}

export type FactoryCommand =
  | { command: "status"; repo?: string }
  | { command: "scopes"; candidates: boolean }
  | { command: "cleanup" }
  | { command: "plan"; repos: string[]; slots?: string[]; adopt?: Record<string, string>; local?: string[]; hub?: string[]; name?: string; main?: string; domain?: string; adoptWorker?: Record<string, string | null>; detach?: boolean }
  | { command: "apply"; hash: string }
  | {
      command: "checkpoint";
      repo?: string;
      task?: string;
      fromAgent?: string;
      fromSteer?: string;
      tests: string[];
      blockers: string[];
      next?: string;
    }
  | { command: "switch"; repo?: string; to: string; apply: boolean }
  | { command: "resume"; repo?: string; agentId?: string; brief: boolean }
  | { command: "fresh"; repo?: string; slot?: string; workerId?: string; provider?: string; model?: string; keepChatHistory?: boolean }
  | { command: "assign"; repo?: string; task: string; tests: string[]; blockers: string[]; next?: string }
  | { command: "workers"; repo?: string }
  | { command: "models" }
  | { command: "drain"; timeout?: string }
  | { command: "quota" }
  | ModelsCommand
  | { command: "steerAdd"; slot?: string; spec?: string; thinking?: string; mode?: string; profile?: string; dryRun: boolean }
  | { command: "help"; topic?: string };

interface ModelEdit {
  spec: string;
  thinking?: string;
  mode?: string;
  profile?: string;
  dryRun: boolean;
}

/** Model priorities and profile tags live in Factory settings. */
export type ModelsCommand =
  | { command: "worker" | "steer"; action: "list" }
  | { command: "worker"; action: "pick"; repo?: string }
  | ({ command: "worker"; action: "set"; n: string } & ModelEdit)
  | { command: "worker"; action: "rm"; n: string; dryRun: boolean }
  | { command: "model"; flag: "advisor" | "sensitive"; spec: string; on: boolean; dryRun: boolean };

// Subcommand being parsed, so errors can point at its usage and examples.
let current: string | null = null;

function fail(message: string): never {
  const entry = current ? FACTORY_COMMANDS[current] : undefined;
  const next = entry
    ? [`Usage: ${entry.usage}`, `Example: ${entry.examples[0]}`, `More: /factory help ${current}`]
    : ["Commands:", ...Object.values(FACTORY_COMMANDS).map((e) => `  ${e.usage}`), "More: /factory help"];
  throw new Error([message, "", ...next].join("\n"));
}

function tokenize(args: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  let escaped = false;
  // An explicitly quoted empty string ("") is a real token: --domain "" clears
  // the domain pointer. Unquoted empties never occur (whitespace only splits).
  let quoted = false;
  const push = () => {
    if (current !== "" || quoted) tokens.push(current);
    current = "";
    quoted = false;
  };
  for (const char of args.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote !== null && char === quote) {
      quote = null;
      quoted = true;
    } else if (quote === null && (char === '"' || char === "'")) {
      quote = char;
      quoted = true;
    } else if (quote === null && /\s/.test(char)) {
      push();
    } else {
      current += char;
    }
  }
  if (quote !== null) fail("A quote is not closed. Put text with spaces in matching quotes, e.g. --task \"Fix login\".");
  push();
  return tokens;
}

interface ParsedFlags {
  positionals: string[];
  bools: Set<string>;
  singles: Map<string, string>;
  multis: Map<string, string[]>;
}

const REPEATABLE = new Set(["test", "blocker", "adopt", "adopt-worker", "local", "hub"]);
const VALUE_FLAGS = new Set(["slots", "slot", "worker", "model", "to", "task", "from-agent", "from-steer", "next", "test", "blocker", "agent", "thinking", "mode", "profile", "timeout", "adopt", "adopt-worker", "local", "hub", "name", "main", "domain"]);
const BOOL_FLAGS = new Set(["apply", "candidates", "brief", "dry-run", "detach", "keep-chat-history"]);

function parseFlags(tokens: string[]): ParsedFlags {
  const positionals: string[] = [];
  const bools = new Set<string>();
  const singles = new Map<string, string>();
  const multis = new Map<string, string[]>();
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (!token.startsWith("--") || token === "--") {
      positionals.push(token);
      i += 1;
      continue;
    }
    const bare = token.slice(2);
    const eq = bare.indexOf("=");
    const name = eq < 0 ? bare : bare.slice(0, eq);
    const inline = eq < 0 ? null : bare.slice(eq + 1);
    if (BOOL_FLAGS.has(name)) {
      if (inline !== null) fail(`--${name} takes no value.`);
      bools.add(name);
      i += 1;
    } else if (VALUE_FLAGS.has(name)) {
      let value = inline;
      if (value === null) {
        i += 1;
        // A missing token is never a value, even for --domain (only an explicit
        // empty string clears the pointer).
        if (i >= tokens.length) fail(`--${name} needs a value right after it; put text with spaces in quotes.`);
        value = tokens[i];
      }
      if (!value && name !== "domain") fail(`--${name} needs a value right after it; put text with spaces in quotes.`);
      if (REPEATABLE.has(name)) {
        const list = multis.get(name) ?? [];
        list.push(value);
        multis.set(name, list);
      } else if (singles.has(name)) {
        fail(`--${name} is given twice; keep one.`);
      } else {
        singles.set(name, value);
      }
      i += 1;
    } else {
      fail(`Unknown flag --${name}; check the spelling.`);
    }
  }
  return { positionals, bools, singles, multis };
}

function checkNoFlags(flags: ParsedFlags, what: string): void {
  if (flags.bools.size || flags.singles.size || flags.multis.size) fail(`${what} takes no flags.`);
}

function checkAllowed(flags: ParsedFlags, sub: string, allowed: string[]): void {
  const ok = new Set(allowed);
  const names = [
    ...flags.bools,
    ...flags.singles.keys(),
    ...flags.multis.keys(),
  ];
  for (const name of names) {
    if (!ok.has(name)) fail(`Unknown flag --${name} for ${sub}; it accepts only the flags shown below.`);
  }
}

function checkSlot(slot: string, flag: string): string {
  const upper = slot.toUpperCase();
  if (!/^[A-Z]$/.test(upper)) fail(`${flag} expects a single slot letter A-Z (one letter per steer), got ${JSON.stringify(slot)}.`);
  return upper;
}

function checkWorkerPosition(value: string): string {
  if (/^\d+$/.test(value) && Number(value) >= 1) return value;
  return fail(`worker expects a position 1, 2, …, got ${JSON.stringify(value)}.`);
}

/** Split --adopt input: SLOT=<id> pairs (single entry). Slots are uppercase. */
export interface PlanAdoptInput {
  adopt: Record<string, string>;
}

function parseAdoptPair(pair: string, into: PlanAdoptInput): void {
  const match = pair.match(/^([A-Z])=([0-9a-f-]{8,})$/i);
  if (match) {
    const [, rawSlot, id] = match;
    const slot = rawSlot.toUpperCase();
    if (into.adopt[slot]) throw new Error(`--adopt names Steer ${slot} more than once`);
    if (Object.values(into.adopt).includes(id)) throw new Error(`--adopt names agent ${id} more than once`);
    into.adopt[slot] = id;
    return;
  }
  if (/:/.test(pair)) {
    throw new Error(`--adopt <scope-id>:SLOT=<agent-id> was retired with multi-repo plans; plan one workspace with --adopt SLOT=<agent-id>, got ${pair}`);
  }
  throw new Error(`--adopt expects SLOT=<agent-id>, got ${pair}`);
}

/**
 * Splits raw --adopt values (repeatable, each comma-separated) into the
 * single-entry adoption map, exactly like the CLI. Throws plain Errors with
 * the CLI message; the parser re-raises them with usage via fail().
 */
export function splitAdoptPairs(values: string[]): PlanAdoptInput {
  const into: PlanAdoptInput = { adopt: {} };
  for (const pair of values.flatMap((v) => v.split(",")).filter(Boolean)) {
    parseAdoptPair(pair, into);
  }
  return into;
}

/**
 * Validates structured --adopt input pair by pair, so direct RPC callers get
 * the same normalization as the slash command. Returns the runner form
 * (`'*'` is the single-entry fallback), exactly like the CLI.
 */
export function normalizePlanAdopt(
  adopt: Record<string, string>,
  entryCount: number,
): Record<string, Record<string, string>> {
  const pairs = Object.entries(adopt ?? {}).map(([slot, id]) => `${slot}=${id}`);
  const split: PlanAdoptInput = { adopt: {} };
  for (const pair of pairs) {
    parseAdoptPair(pair, split);
  }
  if (Object.keys(split.adopt).length && entryCount !== 1) {
    throw new Error("--adopt SLOT=<agent-id> needs exactly one workspace entry");
  }
  return { ...(Object.keys(split.adopt).length ? { "*": split.adopt } : {}) };
}

/**
 * Attaches --name to the single plan entry, like the CLI: a bare address
 * becomes { repo, name }, an object entry carries it alongside. Anything but
 * one entry is rejected, like the CLI. Content validation stays with discovery.
 */
export function applyPlanName(entries: unknown[], name: string): unknown[] {
  if (entries.length !== 1) {
    throw new Error("--name needs exactly one workspace entry");
  }
  const only = entries[0] as Record<string, unknown> | string;
  if (only && typeof only === "object" && !Array.isArray(only)) {
    if (only.name !== undefined) {
      throw new Error('--name conflicts with the entry "name"; use one of them');
    }
    return [{ ...only, name }];
  }
  return [{ repo: only, name }];
}

/**
 * Attaches --main to the single plan entry, like the CLI. A blank workspace
 * id and anything but one entry are rejected.
 */
export function applyPlanMain(entries: unknown[], main: string): unknown[] {
  if (entries.length !== 1) {
    throw new Error("--main needs exactly one workspace entry");
  }
  if (!main?.trim()) {
    throw new Error("--main needs a workspace id (workspace:<id>)");
  }
  const only = entries[0] as Record<string, unknown> | string;
  if (only && typeof only === "object" && !Array.isArray(only)) {
    if (only.main !== undefined) {
      throw new Error('--main conflicts with the entry "main"; use one of them');
    }
    return [{ ...only, main }];
  }
  return [{ repo: only, main }];
}

/**
 * Attaches --domain to the single plan entry, like the CLI. An explicit empty
 * string clears the pointer; anything but one entry is rejected. Content
 * validation stays with discovery.
 */
export function applyPlanDomain(entries: unknown[], domain: string): unknown[] {
  if (entries.length !== 1) {
    throw new Error("--domain needs exactly one workspace entry");
  }
  const only = entries[0] as Record<string, unknown> | string;
  if (only && typeof only === "object" && !Array.isArray(only)) {
    if (only.domain !== undefined) {
      throw new Error('--domain conflicts with the entry "domain"; use one of them');
    }
    return [{ ...only, domain }];
  }
  return [{ repo: only, domain }];
}

function parseAdoptWorkerPair(pair: string): [string, string | null] {
  // Same shape as the CLI: <agent-id>[@<slot>], slot uppercase, no owner.
  const match = pair.match(/^([0-9a-f-]{8,})(?:@([A-Za-z]))?$/);
  if (!match) {
    throw new Error(`--adopt-worker expects <agent-id>[@<slot>], got ${pair}`);
  }
  return [match[1], match[2] ? match[2].toUpperCase() : null];
}

/**
 * Splits raw --adopt-worker values (repeatable, each comma-separated) into the
 * planner form (agent id to owning slot or null), exactly like the CLI. Throws
 * plain Errors with the CLI message; the parser re-raises them with usage via
 * fail().
 */
export function splitAdoptWorkerPairs(values: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const pair of values.flatMap((v) => v.split(",")).map((s) => s.trim()).filter(Boolean)) {
    const [id, slot] = parseAdoptWorkerPair(pair);
    out[id] = slot;
  }
  return out;
}

/**
 * Re-validates structured --adopt-worker input pair by pair, so direct RPC
 * callers get the same normalization as the slash command (slots uppercase).
 * A non-empty worker map with anything but one entry is rejected, like the
 * CLI.
 */
export function normalizePlanAdoptWorker(
  adoptWorker: Record<string, string | null>,
  entryCount: number,
): Record<string, string | null> {
  const pairs = Object.entries(adoptWorker ?? {}).map(([id, slot]) =>
    slot === null || slot === undefined ? id : `${id}@${slot}`,
  );
  const out: Record<string, string | null> = {};
  for (const pair of pairs) {
    const [id, slot] = parseAdoptWorkerPair(pair);
    out[id] = slot;
  }
  if (Object.keys(out).length && entryCount !== 1) {
    throw new Error("--adopt-worker needs exactly one workspace entry; the worker is labelled for that scope");
  }
  return out;
}

export function parseFactoryArgs(args: string): FactoryCommand {
  current = null;
  const tokens = tokenize(args);
  if (tokens.length === 0 || tokens[0] === "help") {
    if (tokens.length > 2) fail("help takes at most one command name, e.g. /factory help switch.");
    const topic = tokens[1];
    if (topic === undefined) return { command: "help" };
    if (!Object.hasOwn(FACTORY_COMMANDS, topic)) fail(`There is no command ${JSON.stringify(topic)}.`);
    return { command: "help", topic };
  }
  const [sub, ...rest] = tokens;
  if (Object.hasOwn(FACTORY_COMMANDS, sub)) current = sub;
  const flags = parseFlags(rest);

  if (sub === "status") {
    checkNoFlags(flags, "status");
    if (flags.positionals.length > 1) fail("status takes at most one scope address (project); leave it out for this workspace.");
    // No address: the caller resolves the scope of the current workspace.
    return flags.positionals.length === 1
      ? { command: "status", repo: flags.positionals[0] }
      : { command: "status" };
  }
  if (sub === "scopes") {
    checkAllowed(flags, "scopes", ["candidates"]);
    if (flags.positionals.length) fail("scopes takes no scope address.");
    return { command: "scopes", candidates: flags.bools.has("candidates") };
  }
  if (sub === "cleanup") {
    checkNoFlags(flags, "cleanup");
    if (flags.positionals.length) fail("cleanup takes no scope address; it reports on the whole instance.");
    return { command: "cleanup" };
  }
  if (sub === "plan") {
    checkAllowed(flags, "plan", ["slots", "adopt", "adopt-worker", "local", "hub", "name", "main", "domain", "detach"]);
    // No address: the caller plans the scope of the current workspace.
    // Exactly one entry: several addresses were retired with bulk provisioning.
    const addressCount = flags.positionals.length + (flags.multis.get("local")?.length ?? 0) + (flags.multis.get("hub")?.length ?? 0);
    if (addressCount > 1) fail("plan takes at most one workspace address; enroll one existing workspace at a time.");
    const slotsRaw = flags.singles.get("slots");
    let slots: string[] | undefined;
    if (slotsRaw !== undefined) {
      if (slotsRaw.includes(",")) fail("--slots expects one live coordinator letter A-Z for initial enrollment.");
      slots = [checkSlot(slotsRaw.trim(), "--slots")];
    }
    const local = flags.multis.get("local");
    const hub = flags.multis.get("hub");
    const name = flags.singles.get("name");
    const main = flags.singles.get("main");
    const domain = flags.singles.get("domain");
    const entryCount = addressCount || 1;
    let split: PlanAdoptInput = { adopt: {} };
    try {
      split = splitAdoptPairs(flags.multis.get("adopt") ?? []);
      normalizePlanAdopt(split.adopt, entryCount);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    let adoptWorker: Record<string, string | null> = {};
    try {
      adoptWorker = splitAdoptWorkerPairs(flags.multis.get("adopt-worker") ?? []);
      normalizePlanAdoptWorker(adoptWorker, entryCount);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    // Count and blank checks only, against dummy entries; the server attaches
    // each single-entry option to the resolved entry with the same helper.
    const singleEntryChecks: Array<[string | undefined, (entries: unknown[], value: string) => unknown[]]> = [
      [name, applyPlanName],
      [main, applyPlanMain],
      [domain, applyPlanDomain],
    ];
    for (const [value, apply] of singleEntryChecks) {
      if (value === undefined) continue;
      try {
        apply(new Array(entryCount).fill("scope"), value);
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    }
    return {
      command: "plan",
      repos: flags.positionals,
      ...(slots ? { slots } : {}),
      ...(Object.keys(split.adopt).length ? { adopt: split.adopt } : {}),
      ...(local?.length ? { local: [...local] } : {}),
      ...(hub?.length ? { hub: [...hub] } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(main !== undefined ? { main } : {}),
      ...(domain !== undefined ? { domain } : {}),
      ...(Object.keys(adoptWorker).length ? { adoptWorker } : {}),
      ...(flags.bools.has("detach") ? { detach: true as const } : {}),
    };
  }
  if (sub === "apply") {
    checkNoFlags(flags, "apply");
    if (flags.positionals.length !== 1) fail("apply needs exactly one plan hash: the 16-character code at the end of /factory plan.");
    const hash = flags.positionals[0].toLowerCase();
    if (!/^[0-9a-f]{16}$/.test(hash)) fail("apply needs the 16-character plan hash shown at the end of /factory plan (letters a-f and digits). Run /factory plan first if you have none.");
    return { command: "apply", hash };
  }
  if (sub === "checkpoint") {
    checkAllowed(flags, "checkpoint", ["task", "from-agent", "from-steer", "test", "blocker", "next"]);
    if (flags.positionals.length > 1) fail("checkpoint takes at most one scope address.");
    const task = flags.singles.get("task");
    const fromAgent = flags.singles.get("from-agent");
    const fromSteer = flags.singles.get("from-steer");
    if (fromSteer !== undefined && !/^[A-Za-z]$/.test(fromSteer)) fail("--from-steer needs one steer letter, e.g. --from-steer D.");
    if ((task ? 1 : 0) + (fromAgent ? 1 : 0) + (fromSteer ? 1 : 0) !== 1) fail('checkpoint needs exactly one of --task, --from-steer or --from-agent: write the task yourself with --task "…", or take it from a steer\'s last answer with --from-steer <slot> (or --from-agent <agent-id>).');
    return {
      command: "checkpoint",
      ...(flags.positionals.length === 1 ? { repo: flags.positionals[0] } : {}),
      ...(task ? { task } : {}),
      ...(fromAgent ? { fromAgent } : {}),
      ...(fromSteer ? { fromSteer: fromSteer.toUpperCase() } : {}),
      tests: flags.multis.get("test") ?? [],
      blockers: flags.multis.get("blocker") ?? [],
      ...(flags.singles.get("next") ? { next: flags.singles.get("next") as string } : {}),
    };
  }
  if (sub === "switch") {
    checkAllowed(flags, "switch", ["to", "apply"]);
    if (flags.positionals.length > 1) fail("switch takes at most one scope address.");
    const toRaw = flags.singles.get("to");
    if (!toRaw) fail("switch needs --to <slot>: the letter of the steer that takes over, e.g. --to B.");
    return {
      command: "switch",
      ...(flags.positionals.length === 1 ? { repo: flags.positionals[0] } : {}),
      to: checkSlot(toRaw, "--to"),
      apply: flags.bools.has("apply"),
    };
  }
  if (sub === "resume") {
    checkAllowed(flags, "resume", ["agent", "brief"]);
    if (flags.positionals.length > 1) fail("resume takes at most one scope address.");
    const agentId = flags.singles.get("agent");
    return {
      command: "resume",
      ...(flags.positionals.length === 1 ? { repo: flags.positionals[0] } : {}),
      ...(agentId ? { agentId } : {}),
      brief: flags.bools.has("brief"),
    };
  }
  if (sub === "fresh") {
    checkAllowed(flags, "fresh", ["slot", "worker", "model", "keep-chat-history"]);
    if (flags.positionals.length > 1) fail("fresh takes at most one scope address (project); leave it out for this workspace.");
    const slot = flags.singles.get("slot");
    if (slot !== undefined && !/^[A-Za-z]$/.test(slot)) fail("fresh --slot needs one steer letter, e.g. --slot E.");
    const workerId = flags.singles.get("worker");
    if (workerId && slot) fail("fresh takes either --slot or --worker.");
    const spec = flags.singles.get("model");
    const slash = spec?.indexOf("/") ?? -1;
    if (spec !== undefined && (slash <= 0 || slash === spec.length - 1)) fail("fresh --model needs provider/model.");
    return {
      command: "fresh",
      ...(flags.positionals.length === 1 ? { repo: flags.positionals[0] } : {}),
      ...(slot ? { slot: slot.toUpperCase() } : {}),
      ...(workerId ? { workerId } : {}),
      ...(spec ? { provider: spec.slice(0, slash), model: spec.slice(slash + 1) } : {}),
      ...(flags.bools.has("keep-chat-history") ? { keepChatHistory: true } : {}),
    };
  }
  if (sub === "assign") {
    checkAllowed(flags, "assign", ["task", "test", "blocker", "next"]);
    if (flags.positionals.length > 1) fail("assign takes at most one scope address.");
    const task = flags.singles.get("task");
    if (!task) fail('assign needs --task "…": the task the active steer records and delivers.');
    return {
      command: "assign",
      ...(flags.positionals.length === 1 ? { repo: flags.positionals[0] } : {}),
      task,
      tests: flags.multis.get("test") ?? [],
      blockers: flags.multis.get("blocker") ?? [],
      ...(flags.singles.get("next") ? { next: flags.singles.get("next") as string } : {}),
    };
  }
  if (sub === "workers") {
    checkNoFlags(flags, "workers");
    if (flags.positionals.length > 1) fail("workers takes at most one scope address (project); leave it out for this workspace.");
    return flags.positionals.length === 1
      ? { command: "workers", repo: flags.positionals[0] }
      : { command: "workers" };
  }
  if (sub === "models") {
    checkNoFlags(flags, "models");
    if (flags.positionals.length) fail("models takes no arguments.");
    return { command: "models" };
  }
  if (sub === "drain") {
    checkAllowed(flags, "drain", ["timeout"]);
    if (flags.positionals.length) fail("drain takes no scope address; it waits for the whole instance.");
    const timeout = flags.singles.get("timeout");
    return timeout === undefined ? { command: "drain" } : { command: "drain", timeout };
  }
  if (sub === "quota") {
    checkNoFlags(flags, "quota");
    if (flags.positionals.length) fail("quota takes no arguments.");
    return { command: "quota" };
  }
  if (sub === "worker" || sub === "steer") {
    const [action, ...args] = flags.positionals;
    const dryRun = flags.bools.has("dry-run");
    if (action === "list") {
      checkNoFlags(flags, `${sub} list`);
      if (args.length) fail(`${sub} list takes no arguments.`);
      return { command: sub, action: "list" };
    }
    if (action === "pick") {
      if (sub !== "worker") return fail("pick is a worker command; steers have no pick.");
      checkNoFlags(flags, "worker pick");
      if (args.length > 1) fail("worker pick takes at most one scope address.");
      return args.length === 1
        ? { command: "worker", action: "pick", repo: args[0] }
        : { command: "worker", action: "pick" };
    }
    if (action === "rm") {
      if (sub === "steer") return fail("Edit model priorities in Factory settings. To remove a steer from the scope, archive its tab in Paseo after handing over any active work.");
      checkAllowed(flags, "worker rm", ["dry-run"]);
      if (args.length !== 1) fail("worker rm needs exactly one position.");
      return { command: sub, action: "rm", n: checkWorkerPosition(args[0]), dryRun };
    }
    if (action === "set") {
      if (sub === "steer") return fail("Edit model priorities in Factory settings. To change a live steer's model, use that tab's Paseo model controls.");
      checkAllowed(flags, "worker set", ["thinking", "mode", "profile", "dry-run"]);
      if (args.length !== 2) fail("worker set needs a position and a profile or provider/model.");
      const spec = args[1];
      const thinking = flags.singles.get("thinking");
      const mode = flags.singles.get("mode");
      const profile = flags.singles.get("profile");
      if (!spec.includes("/") && (thinking !== undefined || mode !== undefined || profile !== undefined)) {
        fail("--thinking, --mode and --profile only go with provider/model; a profile name is used as it is.");
      }
      return {
        command: sub,
        action: "set",
        n: checkWorkerPosition(args[0]),
        spec,
        ...(thinking !== undefined ? { thinking } : {}),
        ...(mode !== undefined ? { mode } : {}),
        ...(profile !== undefined ? { profile } : {}),
        dryRun,
      };
    }
    if (action === "add") {
      if (sub !== "steer") return fail("add is a steer command; workers have no add.");
      checkAllowed(flags, "steer add", ["thinking", "mode", "profile", "dry-run"]);
      if (args.length > 2) fail("steer add takes at most a slot and a profile or provider/model.");
      let slot: string | undefined;
      let spec: string | undefined;
      if (args.length === 1) {
        if (/^[A-Za-z]$/.test(args[0])) slot = args[0].toUpperCase();
        else spec = args[0];
      } else if (args.length === 2) {
        if (!/^[A-Za-z]$/.test(args[0])) fail(`steer add expects a slot letter A-Z first, got ${JSON.stringify(args[0])}.`);
        slot = args[0].toUpperCase();
        spec = args[1];
      }
      const thinking = flags.singles.get("thinking");
      const mode = flags.singles.get("mode");
      const profile = flags.singles.get("profile");
      if (spec !== undefined && !spec.includes("/") && (thinking !== undefined || mode !== undefined || profile !== undefined)) {
        fail("--thinking, --mode and --profile only go with provider/model; a profile name is used as it is.");
      }
      if (spec === undefined && (thinking !== undefined || mode !== undefined || profile !== undefined)) {
        fail("--thinking, --mode and --profile need a provider/model; without one the profile is picked automatically.");
      }
      return {
        command: "steerAdd",
        ...(slot !== undefined ? { slot } : {}),
        ...(spec !== undefined ? { spec } : {}),
        ...(thinking !== undefined ? { thinking } : {}),
        ...(mode !== undefined ? { mode } : {}),
        ...(profile !== undefined ? { profile } : {}),
        dryRun,
      };
    }
    return fail(sub === "worker" ? "worker needs list, pick, set or rm." : "steer needs list or add.");
  }
  if (sub === "model") {
    checkAllowed(flags, "model", ["dry-run"]);
    const [flag, spec, state] = flags.positionals;
    if (flag !== "advisor" && flag !== "sensitive") fail("model needs advisor or sensitive.");
    if (flags.positionals.length !== 3 || !spec) fail(`model ${flag} needs a profile or provider/model and on|off.`);
    if (state !== "on" && state !== "off") fail(`model ${flag} ends with on or off, got ${JSON.stringify(state)}.`);
    return { command: "model", flag, spec, on: state === "on", dryRun: flags.bools.has("dry-run") };
  }
  return fail(`Unknown subcommand ${JSON.stringify(sub)}. Try one of the commands below.`);
}
