import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { QUOTA_DEFAULTS } from "./defaults.mjs";
import { prioritiesFromSlots } from "./settings-validate.js";

/**
 * Preserve the original document before converting v1 via v2 to v3.
 */
export function migrateFactoryConfig(values: unknown, fromVersion: number): unknown {
  if (fromVersion >= 3 || !values || typeof values !== "object" || Array.isArray(values)) return values;
  const old = values as Record<string, any>;
  let next: Record<string, any> = { ...old };
  if (fromVersion < 2) {
    if (old.profiles && typeof old.profiles === "object" && !Array.isArray(old.profiles)) {
      const profiles: Record<string, any> = {};
      for (const [name, raw] of Object.entries(old.profiles)) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          profiles[name] = raw;
          continue;
        }
        const profile = raw as Record<string, any>;
        profiles[name] = {
          ...profile,
          advisor: profile.advisor === undefined ? false : profile.advisor,
          sensitive: profile.sensitive === undefined ? profile.provider === "muse" : profile.sensitive,
        };
      }
      next.profiles = profiles;
    }
    if (next.workerPriority === undefined && old.workerDefault !== undefined) {
      next.workerPriority = typeof old.workerDefault === "string" ? [old.workerDefault] : old.workerDefault;
    }
    delete next.workerDefault;
  }
  const slots = next.slots === undefined ? { A: "factory-default" } : next.slots;
  const rawProfiles = next.profiles === undefined ? { "factory-default": defaultProfile } : next.profiles;
  const profiles = rawProfiles && typeof rawProfiles === "object" && !Array.isArray(rawProfiles)
    ? Object.fromEntries(Object.entries(rawProfiles).map(([name, value]) => {
      const parsed = profileSchema.safeParse(value);
      return [name, parsed.success ? parsed.data : value];
    }))
    : rawProfiles;
  const priorities = prioritiesFromSlots(slots && typeof slots === "object" && !Array.isArray(slots) ? slots : {}, profiles);
  if (next.steerPriority === undefined) next.steerPriority = priorities.steerPriority;
  if (next.advisorPriority === undefined) next.advisorPriority = priorities.advisorPriority;
  if (next.routingStrategy === undefined) next.routingStrategy = "efficiency";
  if (next.legacySnapshot == null) {
    next.legacySnapshot = { version: fromVersion, values: JSON.parse(JSON.stringify(values)) };
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

const legacyProfileSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  thinking: z.string().nullable().optional(),
  mode: z.string().nullable().optional(),
  advisor: z.boolean().optional(),
  sensitive: z.boolean().optional(),
}).passthrough();

const legacySnapshotSchema = z.object({
  version: z.number().int().min(0).max(2),
  values: z.object({
    profiles: z.record(z.string(), legacyProfileSchema).optional(),
    slots: z.record(z.string(), z.string()).optional(),
    prepare: z.array(z.string()).optional(),
    initialActive: z.string().optional(),
    workerDefault: z.string().optional(),
    workerPriority: z.array(z.string()).optional(),
    quota: z.object({
      exhaustedPct: z.number().optional(),
      warnPct: z.number().optional(),
    }).passthrough().optional(),
    githubOwner: z.string().nullable().optional(),
    checkoutRoot: z.string().nullable().optional(),
  }).passthrough(),
});

// Slots and their activation fields remain authoritative until runtime callers migrate.
export const factoryConfigSettings = defineSettings({
  id: "factory-config",
  scope: "host",
  version: 3,
  migrate: (values, fromVersion) => migrateFactoryConfig(values, fromVersion),
  schema: z.object({
    profiles: z.record(z.string(), profileSchema).default({ "factory-default": defaultProfile }),
    slots: z.record(z.string(), z.string()).default({ A: "factory-default" }),
    prepare: z.array(z.string()).default(["A"]),
    initialActive: z.string().default("A"),
    workerPriority: z.array(z.string()).min(1).default(["factory-default"]),
    steerPriority: z.array(z.string().min(1)).optional(),
    advisorPriority: z.array(z.string().min(1)).optional(),
    routingStrategy: z.enum(["efficiency", "balanced", "preference"]).default("efficiency"),
    legacySnapshot: legacySnapshotSchema.nullable().default(null),
    quota: z.object({
      exhaustedPct: z.number().min(0).max(100).default(QUOTA_DEFAULTS.exhaustedPct),
      warnPct: z.number().min(0).max(100).default(QUOTA_DEFAULTS.warnPct),
    }).default({ exhaustedPct: QUOTA_DEFAULTS.exhaustedPct, warnPct: QUOTA_DEFAULTS.warnPct }),
    githubOwner: z.string().nullable().default(null),
    checkoutRoot: z.string().nullable().default(null),
  }).transform((values) => {
    const derived = prioritiesFromSlots(values.slots, values.profiles);
    return {
      ...values,
      steerPriority: values.steerPriority ?? derived.steerPriority,
      advisorPriority: values.advisorPriority ?? derived.advisorPriority,
    };
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
    minContextTokens: z.number().int().min(1000).default(100000),
    providers: z.array(z.string().min(1)).min(1).default(["claude"]),
    roles: z.array(z.enum(["steer", "worker"])).min(1).default(["steer", "worker"]),
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

// Brief delivery for a new steer and history preservation for automatic actions.
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
      exhaustedPct: z.number().min(0).max(100).default(QUOTA_DEFAULTS.exhaustedPct),
      warnPct: z.number().min(0).max(100).default(QUOTA_DEFAULTS.warnPct),
    }).default({ exhaustedPct: QUOTA_DEFAULTS.exhaustedPct, warnPct: QUOTA_DEFAULTS.warnPct }),
    quotaSampleMinutes: z.number().int().min(10).default(10),
  }),
});
