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
    usage: "/factory cleanup [--plan [--allow-destructive] [--allow-ignored] [--only <id,…>]]",
    summary: "Report leftovers (test scopes, missing folders, empty projects).",
    details: [
      "Read-only. Shows what would be lost for each candidate; nothing is deleted.",
      "--plan previews deleting them and ends with a plan hash; run it with /factory apply <hash>.",
    ],
    examples: ["/factory cleanup", "/factory cleanup --plan"],
  },
  fresh: {
    usage: "/factory fresh [scope]",
    summary: "Replace the active steer with a new agent of the same slot.",
    details: [
      "Shows a preview; confirm it in the Factory panel.",
      "The old agent keeps its tab; archive it in Paseo when done.",
    ],
    examples: ["/factory fresh", "/factory fresh me/my-repo"],
  },
  relocate: {
    usage: "/factory relocate [scope] --to <path|project>",
    summary: "Move a project to another checkout directory or project.",
    details: [
      "Shows a preview; confirm it in the Factory panel.",
      "The old scope is retired and keeps its agents; archive it via /factory cleanup --plan.",
    ],
    examples: ["/factory relocate --to /data/new-checkout", "/factory relocate me/my-repo --to other-project"],
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
  retire: {
    usage: "/factory retire <agent-id>",
    summary: "Check whether an agent could be archived (preview only).",
    details: ["Read-only. Archiving itself stays disabled; this only reports blockers."],
    examples: ["/factory retire agent-12345678"],
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
    usage: "/factory plan [scope…] [--allow-fork] [--slots A,B] [--adopt B=<agent-id>] [--local <path>] [--hub <path|workspace:id>] [--checkout <path>] [--name <id>] [--subject <text>] [--main workspace:<id>] [--domain <id>] [--adopt-worker <agent-id>[@A]] [--detach] [--retitle] [--rename-project <name>]",
    summary: "Preview setting up or updating a project. Writes nothing.",
    details: [
      "Ends with a 16-character plan hash; run it with /factory apply <hash>.",
      "--allow-fork lets the plan create your GitHub fork. --slots limits the plan to some steers.",
      "--adopt B=<agent-id> takes over an existing tab as Steer B (repeatable, comma-separated); with several scopes use --adopt <scope>:B=<agent-id> per scope.",
      "--local plans an existing folder without GitHub (repeatable). --hub plans a hub-kind scope from a folder or worktree workspace (repeatable).",
      "--checkout, --name, --subject, --main, --domain and --rename-project each need exactly one entry.",
      "--name sets the scope id of a folder or workspace entry. --subject fills the {subject} title placeholder.",
      "--main adopts a worktree workspace as the main workspace of a github scope. --domain sets the domain pointer (--domain \"\" clears it).",
      "--adopt-worker <agent-id>[@A] labels an agent as scope worker (repeatable, comma-separated). --detach plans a native detach for parented steer candidates.",
      "--retitle plans renaming the main workspace to the title template. --rename-project renames the Paseo project.",
    ],
    examples: ["/factory plan", "/factory plan me/my-repo", "/factory plan me/my-repo --slots A,B", "/factory plan --adopt B=01234567-89ab-cdef-0123-456789abcdef", "/factory plan me/my-repo --domain my-domain --retitle", "/factory plan --hub /data/hub"],
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
      "/factory checkpoint [scope] (--task <text> | --from-agent <id>) [--test <text>]… [--blocker <text>]… [--next <text>]",
    summary: "Save where the work stands (task, tests, blockers, next step).",
    details: [
      "Shows a preview; confirm it in the Factory panel.",
      "--from-agent takes the CHECKPOINT block from that steer's last answer.",
      "Put text with spaces in quotes.",
    ],
    examples: [
      '/factory checkpoint --task "Add login form" --next "Write tests"',
      "/factory checkpoint --from-agent <steer-agent-id>",
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
      "/factory steer list | add [slot] [profile|provider/model] [--thinking X] [--mode Y] [--profile name] [--dry-run] | set <n|slot> <profile|provider/model> [--thinking X] [--mode Y] [--profile name] [--dry-run] | rm <n|slot> [--dry-run]",
    summary: "Show or edit the steer slots; slot order is the priority (1 = A, 2 = B …).",
    details: [
      "add creates a new steer in this workspace's project; without a slot it suggests the next free letter.",
      "set replaces the model of that slot; letters never shift. A new letter must be the next free one.",
      "Running steers keep their model; /factory plan shows the difference.",
      "set and rm save at once in the plugin settings (--dry-run only shows it); add shows a preview and confirms in the Factory panel.",
    ],
    examples: ["/factory steer list", "/factory steer add", "/factory steer add C codex/gpt-6.2-sol --thinking high", "/factory steer set B codex/gpt-6.2-sol --thinking high", "/factory steer rm C"],
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
  labels: {
    usage: "/factory labels [scope|agent-id] [--apply]",
    summary: "Show agents with missing or wrong factory labels, and fix them.",
    details: [
      "Read-only. Without an address it audits every project; with one it audits that project or agent.",
      "Shows a preview; confirm it in the Factory panel. --apply only marks the intent, it still needs the panel button.",
    ],
    examples: ["/factory labels", "/factory labels me/my-repo --apply"],
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
  | { command: "cleanup"; plan: boolean; allowDestructive: boolean; allowIgnored: boolean; only?: string[] }
  | { command: "plan"; repos: string[]; allowFork: boolean; slots?: string[]; adopt?: Record<string, string>; adoptScoped?: Record<string, Record<string, string>>; local?: string[]; hub?: string[]; checkout?: string; name?: string; subject?: string; main?: string; domain?: string; adoptWorker?: Record<string, string | null>; detach?: boolean; retitle?: boolean; renameProject?: string }
  | { command: "apply"; hash: string }
  | {
      command: "checkpoint";
      repo?: string;
      task?: string;
      fromAgent?: string;
      tests: string[];
      blockers: string[];
      next?: string;
    }
  | { command: "switch"; repo?: string; to: string; apply: boolean }
  | { command: "resume"; repo?: string; agentId?: string; brief: boolean }
  | { command: "fresh"; repo?: string; slot?: string }
  | { command: "relocate"; repo?: string; to: string }
  | { command: "assign"; repo?: string; task: string; tests: string[]; blockers: string[]; next?: string }
  | { command: "workers"; repo?: string }
  | { command: "retire"; agentId: string }
  | { command: "models" }
  | { command: "drain"; timeout?: string }
  | { command: "quota" }
  | { command: "labels"; address?: string; apply: boolean }
  | ModelsCommand
  | { command: "steerAdd"; slot?: string; spec?: string; thinking?: string; mode?: string; profile?: string; dryRun: boolean }
  | { command: "help"; topic?: string };

interface ModelEdit {
  spec: string;
  thinking?: string;
  mode?: string;
  profile?: string;
  dryRun: boolean;
  /** Deprecation note for the slot/worker-default aliases. */
  note?: string;
}

/** worker/steer list, set, rm and model advisor|sensitive: the lists live in the plugin settings. */
export type ModelsCommand =
  | { command: "worker" | "steer"; action: "list" }
  | { command: "worker"; action: "pick"; repo?: string }
  | ({ command: "worker" | "steer"; action: "set"; n: string } & ModelEdit)
  | { command: "worker" | "steer"; action: "rm"; n: string; dryRun: boolean; note?: string }
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
const VALUE_FLAGS = new Set(["slots", "slot", "to", "task", "from-agent", "next", "test", "blocker", "agent", "thinking", "mode", "profile", "only", "timeout", "adopt", "adopt-worker", "local", "hub", "checkout", "name", "subject", "main", "domain", "rename-project"]);
const BOOL_FLAGS = new Set(["allow-fork", "apply", "candidates", "brief", "dry-run", "plan", "allow-destructive", "allow-ignored", "detach", "retitle"]);

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

function checkTarget(value: string, sub: string): string {
  if (/^\d+$/.test(value) && Number(value) >= 1) return value;
  if (sub === "steer" && /^[A-Za-z]$/.test(value)) return value.toUpperCase();
  return fail(`${sub} expects ${sub === "steer" ? "a slot letter A-Z or a position 1, 2, …" : "a position 1, 2, …"}, got ${JSON.stringify(value)}.`);
}

/** Split --adopt input: legacy SLOT=<id> pairs and scoped <scope>:SLOT=<id> pairs. Slots are uppercase, scopes lowercase. */
export interface PlanAdoptInput {
  adopt: Record<string, string>;
  adoptScoped: Record<string, Record<string, string>>;
}

function parseAdoptPair(pair: string, into: PlanAdoptInput): void {
  const legacy = pair.match(/^([A-Z])=([0-9a-f-]{8,})$/i);
  if (legacy) {
    into.adopt[legacy[1].toUpperCase()] = legacy[2];
    return;
  }
  const scoped = pair.match(/^(.+):([A-Z])=([0-9a-f-]{8,})$/i);
  if (!scoped || !scoped[1].trim()) {
    throw new Error(`--adopt expects SLOT=<agent-id> or <scope-id>:SLOT=<agent-id>, got ${pair}`);
  }
  const scope = scoped[1].trim().toLowerCase();
  (into.adoptScoped[scope] ??= {})[scoped[2].toUpperCase()] = scoped[3];
}

/**
 * Splits raw --adopt values (repeatable, each comma-separated) into legacy and
 * scoped adoption, exactly like the CLI. Throws plain Errors with the CLI
 * message; the parser re-raises them with usage via fail().
 */
export function splitAdoptPairs(values: string[]): PlanAdoptInput {
  const into: PlanAdoptInput = { adopt: {}, adoptScoped: {} };
  for (const pair of values.flatMap((v) => v.split(",")).filter(Boolean)) {
    parseAdoptPair(pair, into);
  }
  return into;
}

/**
 * Merges legacy and scoped adoption into the runner form (`'*'` is the
 * single-entry fallback, one lowercase key per scope), exactly like the CLI.
 * Structured input is re-validated pair by pair, so direct RPC callers get the
 * same normalization as the slash command. Legacy adoption with anything but
 * one entry is rejected, like the CLI.
 */
export function normalizePlanAdopt(
  adopt: Record<string, string>,
  adoptScoped: Record<string, Record<string, string>>,
  entryCount: number,
): Record<string, Record<string, string>> {
  const pairs = [
    ...Object.entries(adopt ?? {}).map(([slot, id]) => `${slot}=${id}`),
    ...Object.entries(adoptScoped ?? {}).flatMap(([scope, map]) =>
      Object.entries(map ?? {}).map(([slot, id]) => `${scope}:${slot}=${id}`),
    ),
  ];
  const split: PlanAdoptInput = { adopt: {}, adoptScoped: {} };
  for (const pair of pairs) {
    parseAdoptPair(pair, split);
  }
  if (Object.keys(split.adopt).length && entryCount !== 1) {
    throw new Error("--adopt SLOT=<agent-id> needs exactly one repository; use --adopt <scope-id>:SLOT=<agent-id> with several entries");
  }
  return { ...(Object.keys(split.adopt).length ? { "*": split.adopt } : {}), ...split.adoptScoped };
}

/**
 * Attaches --checkout to the single plan entry, like the CLI: a bare address
 * becomes { repo, checkout }, an object entry carries it alongside. Anything
 * but one entry is rejected, like the CLI (without the --repos-file clause,
 * which the plugin has no equivalent of).
 */
export function applyPlanCheckout(entries: unknown[], checkout: string): unknown[] {
  if (entries.length !== 1) {
    throw new Error("--checkout needs exactly one repository entry");
  }
  if (!checkout?.trim()) {
    throw new Error("--checkout needs a checkout path");
  }
  const only = entries[0] as Record<string, unknown> | string;
  if (only && typeof only === "object" && !Array.isArray(only)) {
    if (only.checkout !== undefined) {
      throw new Error('--checkout conflicts with the entry "checkout"; use one of them');
    }
    if (only.main !== undefined) {
      throw new Error('--checkout conflicts with the entry "main"; use one of them');
    }
    return [{ ...only, checkout }];
  }
  return [{ repo: only, checkout }];
}

/**
 * Attaches --name to the single plan entry, like the CLI: a bare address
 * becomes { repo, name }, an object entry carries it alongside. Anything but
 * one entry is rejected, like the CLI (without the --repos-file clause, which
 * the plugin has no equivalent of). Content validation stays with discovery.
 */
export function applyPlanName(entries: unknown[], name: string): unknown[] {
  if (entries.length !== 1) {
    throw new Error("--name needs exactly one repository entry");
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
 * Attaches --subject to the single plan entry, like the CLI. Content
 * validation stays with discovery.
 */
export function applyPlanSubject(entries: unknown[], subject: string): unknown[] {
  if (entries.length !== 1) {
    throw new Error("--subject needs exactly one repository entry");
  }
  const only = entries[0] as Record<string, unknown> | string;
  if (only && typeof only === "object" && !Array.isArray(only)) {
    if (only.subject !== undefined) {
      throw new Error('--subject conflicts with the entry "subject"; use one of them');
    }
    return [{ ...only, subject }];
  }
  return [{ repo: only, subject }];
}

/**
 * Attaches --main to the single plan entry, like the CLI. A blank workspace
 * id and anything but one entry are rejected; --main and --checkout exclude
 * each other, like the CLI.
 */
export function applyPlanMain(entries: unknown[], main: string): unknown[] {
  if (entries.length !== 1) {
    throw new Error("--main needs exactly one repository entry");
  }
  if (!main?.trim()) {
    throw new Error("--main needs a workspace id (workspace:<id>)");
  }
  const only = entries[0] as Record<string, unknown> | string;
  if (only && typeof only === "object" && !Array.isArray(only)) {
    if (only.main !== undefined) {
      throw new Error('--main conflicts with the entry "main"; use one of them');
    }
    if (only.checkout !== undefined) {
      throw new Error('--main conflicts with the entry "checkout"; use one of them');
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
    throw new Error("--domain needs exactly one repository entry");
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
    throw new Error("--adopt-worker needs exactly one repository entry; the worker is labelled for that scope");
  }
  return out;
}

/**
 * Validates --rename-project, like the CLI: only with exactly one entry, and
 * never blank. Returns the trimmed project name, or null when unset.
 */
export function checkedRenameProject(value: string | undefined, entryCount: number): string | null {
  if (value === undefined) return null;
  if (entryCount !== 1) {
    throw new Error("--rename-project needs exactly one repository entry");
  }
  const name = value.trim();
  if (!name) {
    throw new Error("--rename-project needs a project name");
  }
  return name;
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
    checkAllowed(flags, "cleanup", ["plan", "allow-destructive", "allow-ignored", "only"]);
    if (flags.positionals.length) fail("cleanup takes no scope address; it reports on the whole instance.");
    const plan = flags.bools.has("plan");
    const onlyRaw = flags.singles.get("only");
    if (!plan && (flags.bools.has("allow-destructive") || flags.bools.has("allow-ignored") || onlyRaw !== undefined)) {
      fail("--allow-destructive, --allow-ignored and --only need --plan.");
    }
    const only = onlyRaw === undefined ? undefined : onlyRaw.split(",").map((s) => s.trim()).filter(Boolean);
    if (only !== undefined && !only.length) fail("--only needs at least one candidate id.");
    return {
      command: "cleanup",
      plan,
      allowDestructive: flags.bools.has("allow-destructive"),
      allowIgnored: flags.bools.has("allow-ignored"),
      ...(only ? { only } : {}),
    };
  }
  if (sub === "plan") {
    checkAllowed(flags, "plan", ["allow-fork", "slots", "adopt", "adopt-worker", "local", "hub", "checkout", "name", "subject", "main", "domain", "detach", "retitle", "rename-project"]);
    // No address: the caller plans the scope of the current workspace.
    const slotsRaw = flags.singles.get("slots");
    let slots: string[] | undefined;
    if (slotsRaw !== undefined) {
      slots = slotsRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => checkSlot(s, "--slots"));
      if (new Set(slots).size !== slots.length) fail("--slots contains duplicates.");
    }
    const local = flags.multis.get("local");
    const hub = flags.multis.get("hub");
    const checkout = flags.singles.get("checkout");
    const name = flags.singles.get("name");
    const subject = flags.singles.get("subject");
    const main = flags.singles.get("main");
    const domain = flags.singles.get("domain");
    const renameRaw = flags.singles.get("rename-project");
    const entryCount = flags.positionals.length + (local?.length ?? 0) + (hub?.length ?? 0) || 1;
    let split: PlanAdoptInput = { adopt: {}, adoptScoped: {} };
    try {
      split = splitAdoptPairs(flags.multis.get("adopt") ?? []);
      normalizePlanAdopt(split.adopt, split.adoptScoped, entryCount);
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
      [checkout, applyPlanCheckout],
      [name, applyPlanName],
      [subject, applyPlanSubject],
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
    let renameProject: string | null = null;
    try {
      renameProject = checkedRenameProject(renameRaw, entryCount);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    return {
      command: "plan",
      repos: flags.positionals,
      allowFork: flags.bools.has("allow-fork"),
      ...(slots ? { slots } : {}),
      ...(Object.keys(split.adopt).length ? { adopt: split.adopt } : {}),
      ...(Object.keys(split.adoptScoped).length ? { adoptScoped: split.adoptScoped } : {}),
      ...(local?.length ? { local: [...local] } : {}),
      ...(hub?.length ? { hub: [...hub] } : {}),
      ...(checkout !== undefined ? { checkout } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(subject !== undefined ? { subject } : {}),
      ...(main !== undefined ? { main } : {}),
      ...(domain !== undefined ? { domain } : {}),
      ...(Object.keys(adoptWorker).length ? { adoptWorker } : {}),
      ...(flags.bools.has("detach") ? { detach: true as const } : {}),
      ...(flags.bools.has("retitle") ? { retitle: true as const } : {}),
      ...(renameProject ? { renameProject } : {}),
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
    checkAllowed(flags, "checkpoint", ["task", "from-agent", "test", "blocker", "next"]);
    if (flags.positionals.length > 1) fail("checkpoint takes at most one scope address.");
    const task = flags.singles.get("task");
    const fromAgent = flags.singles.get("from-agent");
    if ((task ? 1 : 0) + (fromAgent ? 1 : 0) !== 1) fail('checkpoint needs either --task or --from-agent: write the task yourself with --task "…", or take it from a steer\'s last answer with --from-agent <agent-id>.');
    return {
      command: "checkpoint",
      ...(flags.positionals.length === 1 ? { repo: flags.positionals[0] } : {}),
      ...(task ? { task } : {}),
      ...(fromAgent ? { fromAgent } : {}),
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
    checkAllowed(flags, "fresh", ["slot"]);
    if (flags.positionals.length > 1) fail("fresh takes at most one scope address (project); leave it out for this workspace.");
    const slot = flags.singles.get("slot");
    if (slot !== undefined && !/^[A-Za-z]$/.test(slot)) fail("fresh --slot needs one steer letter, e.g. --slot E.");
    return {
      command: "fresh",
      ...(flags.positionals.length === 1 ? { repo: flags.positionals[0] } : {}),
      ...(slot ? { slot: slot.toUpperCase() } : {}),
    };
  }
  if (sub === "relocate") {
    checkAllowed(flags, "relocate", ["to"]);
    if (flags.positionals.length > 1) fail("relocate takes at most one scope address.");
    const to = flags.singles.get("to");
    if (!to) fail("relocate needs --to <path|project>: the checkout directory or project that takes over, e.g. --to /data/new.");
    return {
      command: "relocate",
      ...(flags.positionals.length === 1 ? { repo: flags.positionals[0] } : {}),
      to,
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
  if (sub === "retire") {
    checkNoFlags(flags, "retire");
    if (flags.positionals.length !== 1) fail("retire needs exactly one agent id.");
    return { command: "retire", agentId: flags.positionals[0] };
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
    const what = sub === "worker" ? "position" : "position or slot";
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
      checkAllowed(flags, `${sub} rm`, ["dry-run"]);
      if (args.length !== 1) fail(`${sub} rm needs exactly one ${what}.`);
      return { command: sub, action: "rm", n: checkTarget(args[0], sub), dryRun };
    }
    if (action === "set") {
      checkAllowed(flags, `${sub} set`, ["thinking", "mode", "profile", "dry-run"]);
      if (args.length !== 2) fail(`${sub} set needs a ${what} and a profile or provider/model.`);
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
        n: checkTarget(args[0], sub),
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
    return fail(sub === "worker" ? `${sub} needs list, pick, set or rm.` : `${sub} needs list, add, set or rm.`);
  }
  if (sub === "slot") {
    // Deprecated alias of `steer set|rm` (letters only, like the CLI).
    const [action, ...args] = flags.positionals;
    const dryRun = flags.bools.has("dry-run");
    const note = 'Note: "slot" is deprecated, use "steer" instead.';
    if (action === "set") {
      checkAllowed(flags, "slot set", ["thinking", "mode", "profile", "dry-run"]);
      if (args.length !== 2) fail("slot set needs a slot letter A-Z and a provider/model.");
      if (!args[1].includes("/")) fail("slot set needs a provider/model, e.g. codex/gpt-6.2-sol.");
      return {
        command: "steer",
        action: "set",
        n: checkSlot(args[0], "slot set"),
        spec: args[1],
        ...(flags.singles.get("thinking") !== undefined ? { thinking: flags.singles.get("thinking") as string } : {}),
        ...(flags.singles.get("mode") !== undefined ? { mode: flags.singles.get("mode") as string } : {}),
        ...(flags.singles.get("profile") !== undefined ? { profile: flags.singles.get("profile") as string } : {}),
        dryRun,
        note,
      };
    }
    if (action === "rm") {
      checkAllowed(flags, "slot rm", ["dry-run"]);
      if (args.length !== 1) fail("slot rm needs exactly one slot letter A-Z.");
      return { command: "steer", action: "rm", n: checkSlot(args[0], "slot rm"), dryRun, note };
    }
    return fail('slot needs set or rm; "slot" itself is deprecated, use "steer" instead.');
  }
  if (sub === "worker-default") {
    // Deprecated alias of `worker set 1`.
    checkAllowed(flags, "worker-default", ["thinking", "mode", "profile", "dry-run"]);
    const [spec, ...rest] = flags.positionals;
    if (!spec || rest.length) fail("worker-default needs a profile or provider/model.");
    if (!spec.includes("/") && (flags.singles.get("thinking") !== undefined || flags.singles.get("mode") !== undefined || flags.singles.get("profile") !== undefined)) {
      fail("--thinking, --mode and --profile only go with provider/model; a profile name is used as it is.");
    }
    return {
      command: "worker",
      action: "set",
      n: "1",
      spec,
      ...(flags.singles.get("thinking") !== undefined ? { thinking: flags.singles.get("thinking") as string } : {}),
      ...(flags.singles.get("mode") !== undefined ? { mode: flags.singles.get("mode") as string } : {}),
      ...(flags.singles.get("profile") !== undefined ? { profile: flags.singles.get("profile") as string } : {}),
      dryRun: flags.bools.has("dry-run"),
      note: 'Note: "worker-default" is deprecated, use "worker set 1" instead.',
    };
  }
  if (sub === "model") {
    checkAllowed(flags, "model", ["dry-run"]);
    const [flag, spec, state] = flags.positionals;
    if (flag !== "advisor" && flag !== "sensitive") fail("model needs advisor or sensitive.");
    if (flags.positionals.length !== 3 || !spec) fail(`model ${flag} needs a profile or provider/model and on|off.`);
    if (state !== "on" && state !== "off") fail(`model ${flag} ends with on or off, got ${JSON.stringify(state)}.`);
    return { command: "model", flag, spec, on: state === "on", dryRun: flags.bools.has("dry-run") };
  }
  if (sub === "labels") {
    checkAllowed(flags, "labels", ["apply"]);
    if (flags.positionals.length > 1) fail("labels takes at most one scope or agent address; leave it out to audit every project.");
    return {
      command: "labels",
      ...(flags.positionals.length === 1 ? { address: flags.positionals[0] } : {}),
      apply: flags.bools.has("apply"),
    };
  }
  return fail(`Unknown subcommand ${JSON.stringify(sub)}. Try one of the commands below.`);
}
