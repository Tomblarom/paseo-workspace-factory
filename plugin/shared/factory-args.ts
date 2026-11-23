// Argument parsing for the /factory slash command. Pure module: no imports,
// so both the plugin bundles and plain node:test can use it.

export const FACTORY_USAGE = [
  "/factory status [scope]",
  "/factory scopes [--candidates]",
  "/factory cleanup",
  "/factory plan [scope…] [--allow-fork] [--slots A,B]",
  "/factory apply <16-hex-hash>",
  "/factory checkpoint [scope] (--task <text> | --from-agent <id>) [--test <text>]… [--blocker <text>]… [--next <text>]",
  "/factory switch [scope] --to <slot> [--apply]",
  "/factory resume [scope] [--agent <id>]",
].join("\n");

export type FactoryCommand =
  | { command: "status"; repo?: string }
  | { command: "scopes"; candidates: boolean }
  | { command: "cleanup" }
  | { command: "plan"; repos: string[]; allowFork: boolean; slots?: string[] }
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
  | { command: "resume"; repo?: string; agentId?: string }
  | { command: "help" };

function fail(message: string): never {
  throw new Error(`${message}\n${FACTORY_USAGE}`);
}

function tokenize(args: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  let escaped = false;
  const push = () => {
    if (current !== "" || quote !== null) tokens.push(current);
    current = "";
  };
  for (const char of args.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote !== null && char === quote) {
      quote = null;
    } else if (quote === null && (char === '"' || char === "'")) {
      quote = char;
    } else if (quote === null && /\s/.test(char)) {
      push();
    } else {
      current += char;
    }
  }
  if (quote !== null) fail("Unterminated quote.");
  push();
  return tokens.filter((t) => t !== "");
}

interface ParsedFlags {
  positionals: string[];
  bools: Set<string>;
  singles: Map<string, string>;
  multis: Map<string, string[]>;
}

const REPEATABLE = new Set(["test", "blocker"]);
const VALUE_FLAGS = new Set(["slots", "to", "task", "from-agent", "next", "test", "blocker", "agent"]);
const BOOL_FLAGS = new Set(["allow-fork", "apply", "candidates"]);

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
        value = tokens[i] ?? "";
      }
      if (!value) fail(`--${name} needs a value.`);
      if (REPEATABLE.has(name)) {
        const list = multis.get(name) ?? [];
        list.push(value);
        multis.set(name, list);
      } else if (singles.has(name)) {
        fail(`--${name} is given twice.`);
      } else {
        singles.set(name, value);
      }
      i += 1;
    } else {
      fail(`Unknown flag --${name}.`);
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
    if (!ok.has(name)) fail(`Unknown flag --${name} for ${sub}.`);
  }
}

function checkSlot(slot: string, flag: string): string {
  const upper = slot.toUpperCase();
  if (!/^[A-Z]$/.test(upper)) fail(`${flag} expects a single slot letter A-Z, got ${JSON.stringify(slot)}.`);
  return upper;
}

export function parseFactoryArgs(args: string): FactoryCommand {
  const tokens = tokenize(args);
  if (tokens.length === 0 || tokens[0] === "help") {
    if (tokens.length > 1) fail("help takes no arguments.");
    return { command: "help" };
  }
  const [sub, ...rest] = tokens;
  const flags = parseFlags(rest);

  if (sub === "status") {
    checkNoFlags(flags, "status");
    if (flags.positionals.length > 1) fail("status takes at most one scope address.");
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
    checkAllowed(flags, "plan", ["allow-fork", "slots"]);
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
    return {
      command: "plan",
      repos: flags.positionals,
      allowFork: flags.bools.has("allow-fork"),
      ...(slots ? { slots } : {}),
    };
  }
  if (sub === "apply") {
    checkNoFlags(flags, "apply");
    if (flags.positionals.length !== 1) fail("apply needs exactly one plan hash.");
    const hash = flags.positionals[0].toLowerCase();
    if (!/^[0-9a-f]{16}$/.test(hash)) fail("apply needs a 16-hex plan hash from a stored dry-run.");
    return { command: "apply", hash };
  }
  if (sub === "checkpoint") {
    checkAllowed(flags, "checkpoint", ["task", "from-agent", "test", "blocker", "next"]);
    if (flags.positionals.length > 1) fail("checkpoint takes at most one scope address.");
    const task = flags.singles.get("task");
    const fromAgent = flags.singles.get("from-agent");
    if ((task ? 1 : 0) + (fromAgent ? 1 : 0) !== 1) fail("checkpoint needs either --task or --from-agent.");
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
    if (!toRaw) fail("switch needs --to <slot>.");
    return {
      command: "switch",
      ...(flags.positionals.length === 1 ? { repo: flags.positionals[0] } : {}),
      to: checkSlot(toRaw, "--to"),
      apply: flags.bools.has("apply"),
    };
  }
  if (sub === "resume") {
    checkAllowed(flags, "resume", ["agent"]);
    if (flags.positionals.length > 1) fail("resume takes at most one scope address.");
    const agentId = flags.singles.get("agent");
    return {
      command: "resume",
      ...(flags.positionals.length === 1 ? { repo: flags.positionals[0] } : {}),
      ...(agentId ? { agentId } : {}),
    };
  }
  return fail(`Unknown subcommand ${JSON.stringify(sub)}.`);
}
