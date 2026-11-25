import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * factory-config v1 -> v2: workerDefault becomes workerPriority=[workerDefault];
 * every profile gets advisor=false and sensitive (muse without an explicit
 * flag is sensitive, everything else is not). Already-v2 values pass through.
 */
export function migrateFactoryConfig(values: unknown, fromVersion: number): unknown {
  if (fromVersion >= 2 || !values || typeof values !== "object") return values;
  const old = values as Record<string, any>;
  const profiles: Record<string, any> = {};
  for (const [name, raw] of Object.entries(old.profiles ?? {})) {
    const profile = (raw ?? {}) as Record<string, any>;
    profiles[name] = {
      ...profile,
      advisor: typeof profile.advisor === "boolean" ? profile.advisor : false,
      sensitive: typeof profile.sensitive === "boolean" ? profile.sensitive : profile.provider === "muse",
    };
  }
  const { workerDefault, ...rest } = old;
  const next: Record<string, any> = { ...rest, profiles };
  if (!Array.isArray(rest.workerPriority) && typeof workerDefault === "string" && workerDefault) {
    next.workerPriority = [workerDefault];
  }
  return next;
}

const profileSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  thinking: z.string().nullable().default(null),
  mode: z.string().nullable().default(null),
  // v2: advisor profiles are second-opinion steers, never coordinators or workers.
  advisor: z.boolean().default(false),
  // v2: sensitive profiles only get sanitized technical tasks.
  sensitive: z.boolean().default(false),
});

const defaultProfile = {
  provider: "codex",
  model: "gpt-6.2-sol",
  thinking: "high",
  mode: "full-access",
  advisor: false,
  sensitive: false,
};

// Factory configuration subset owned by the plugin: steer slots (slot order =
// priority), prepare list, start steer, prioritized worker list, the profiles
// they reference, and the optional host setup (GitHub owner, checkout root).
// v1 -> v2: workerDefault becomes workerPriority, profiles gain
// advisor/sensitive (see migrateFactoryConfig above).
// Defaults mirror the single-steer example config; {} parses into this
// document. Host fields default to null, which means "from the config file":
// a saved value replaces the matching file value, and without a file both
// are required to form the complete configuration.
export const factoryConfigSettings = defineSettings({
  id: "factory-config",
  scope: "host",
  version: 2,
  migrate: (values, fromVersion) => migrateFactoryConfig(values, fromVersion),
  schema: z.object({
    profiles: z.record(z.string(), profileSchema).default({ "factory-default": defaultProfile }),
    slots: z.record(z.string(), z.string()).default({ A: "factory-default" }),
    prepare: z.array(z.string()).default(["A"]),
    initialActive: z.string().default("A"),
    workerPriority: z.array(z.string()).min(1).default(["factory-default"]),
    quota: z.object({
      exhaustedPct: z.number().min(0).max(100).default(90),
      warnPct: z.number().min(0).max(100).default(75),
    }).default({ exhaustedPct: 90, warnPct: 75 }),
    quotaSampleMinutes: z.number().int().min(10).default(10),
    githubOwner: z.string().nullable().default(null),
    checkoutRoot: z.string().nullable().default(null),
  }),
});

// Removed: factory-sidebar (device). The sidebar entry is registered
// unconditionally and shown/hidden in Paseo's own sidebar settings; any
// stored factory-sidebar value is ignored.

// Preferences for chat display and the findings passage in agent prompts.
// The client entry reads this host setting before any settings screen opens.
export const factoryDisplaySettings = defineSettings({
  id: "factory-display",
  scope: "host",
  version: 1,
  schema: z.object({
    checkpointInChat: z.boolean().default(true),
    findingsInPrompts: z.boolean().default(true),
  }),
});

/**
 * factory-cleanup v1 -> v2: the cost profile replaces the global
 * compactAtMinutes (per-group thresholds now come from
 * shared/cache-profiles.ts); stored compactAtMinutes values are dropped and
 * the profile defaults to balanced.
 */
export function migrateFactoryCleanup(values: unknown, fromVersion: number): unknown {
  if (fromVersion >= 2 || !values || typeof values !== "object") return values;
  const next = { ...(values as Record<string, unknown>) };
  delete next.compactAtMinutes;
  return next;
}

// Idle cleanup (C5): how the plugin server shrinks cold factory agents.
// Defaults mirror CLEANUP_DEFAULTS in shared/idle-cleanup.ts; {} parses into
// a complete document. `fresh` is deliberately not a mode: creating agents
// stays behind plan → confirm and manual C6 only. `rewindFresh` (default
// off) needs no migration: stored v2 documents parse with the default.
export const factoryCleanupSettings = defineSettings({
  id: "factory-cleanup",
  scope: "host",
  version: 2,
  migrate: (values, fromVersion) => migrateFactoryCleanup(values, fromVersion),
  schema: z.object({
    mode: z.enum(["off", "clear", "compact-warm"]).default("clear"),
    profile: z.enum(["efficiency", "balanced", "comfort"]).default("balanced"),
    idleMinutes: z.number().int().min(5).default(60),
    minContextTokens: z.number().int().min(1000).default(60000),
    providers: z.array(z.string().min(1)).min(1).default(["claude"]),
    roles: z.array(z.enum(["steer", "worker"])).min(1).default(["steer", "worker"]),
    seedAfterClear: z.boolean().default(false),
    clearAcknowledged: z.boolean().default(false),
    dailyCap: z.number().int().min(1).default(20),
    rewindFresh: z.boolean().default(false),
  }),
});

// Manual resume (R-A): which providers accept /clear during /factory resume.
// Defaults mirror RESUME_CLEAR_DEFAULTS in shared/idle-cleanup.ts; {} parses
// into a complete document. Providers outside the list get the brief only.
export const factoryResumeSettings = defineSettings({
  id: "factory-resume",
  scope: "host",
  version: 1,
  schema: z.object({
    providers: z.array(z.string().min(1)).min(1).default(["claude"]),
    recentHours: z.number().int().min(1).default(24),
  }),
});

// Steer menu (step 3): how a new or replaced steer's brief is delivered, and
// whether Refresh keeps the chat history (rewind) or clears it in place.
// Defaults: the brief goes into the Paseo composer, refresh clears.
export const factorySteerMenuSettings = defineSettings({
  id: "factory-steer-menu",
  scope: "host",
  version: 1,
  schema: z.object({
    initializeNewSteer: z.enum(["send", "composer", "later"]).default("composer"),
    keepChatHistory: z.boolean().default(false),
  }),
});

// Worker supervision (S-B): wake cadence, watchdog, and failover.
// Defaults mirror SUPERVISION_SETTINGS_DEFAULTS in shared/supervise.ts; {}
// parses into a complete document. `enabled` off silences the whole
// supervision side (registration, wakes, watchdog); the register keeps
// whatever the CLI wrote.
export const factorySupervisionSettings = defineSettings({
  id: "factory-supervision",
  scope: "host",
  version: 1,
  schema: z.object({
    enabled: z.boolean().default(true),
    // Kept for config compatibility; immediate wakes use wakeDebounceSeconds.
    batchMinutes: z.number().int().min(0).default(0),
    wakeDebounceSeconds: z.number().int().min(0).default(20),
    watchdogMinutes: z.number().int().min(1).default(15),
    staleMinutes: z.number().int().min(1).default(60),
    answerMinutes: z.number().int().min(1).default(10),
    maxAutoResumes: z.number().int().min(0).default(2),
    quota: z.object({
      exhaustedPct: z.number().min(0).max(100).default(90),
      warnPct: z.number().min(0).max(100).default(75),
    }).default({ exhaustedPct: 90, warnPct: 75 }),
    quotaSampleMinutes: z.number().int().min(10).default(10),
  }),
});
