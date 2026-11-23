import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

const profileSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  thinking: z.string().nullable().default(null),
  mode: z.string().nullable().default(null),
});

const defaultProfile = {
  provider: "codex",
  model: "gpt-6.2-sol",
  thinking: "high",
  mode: "full-access",
};

// Factory configuration subset owned by the plugin: steer slots, prepare list,
// start steer, worker default profile, and the profiles they reference.
// Defaults mirror the single-steer example config; {} parses into this document.
export const factoryConfigSettings = defineSettings({
  id: "factory-config",
  scope: "host",
  version: 1,
  schema: z.object({
    profiles: z.record(z.string(), profileSchema).default({ "factory-default": defaultProfile }),
    slots: z.record(z.string(), z.string()).default({ A: "factory-default" }),
    prepare: z.array(z.string()).default(["A"]),
    initialActive: z.string().default("A"),
    workerDefault: z.string().default("factory-default"),
  }),
});

// Layout preference: the sidebar entry stays hidden until the user opts in.
export const factorySidebarSettings = defineSettings({
  id: "factory-sidebar",
  scope: "device",
  version: 1,
  schema: z.object({
    visible: z.boolean().default(false),
  }),
});

// Idle cleanup (C5): how the plugin server shrinks cold factory agents.
// Defaults mirror CLEANUP_DEFAULTS in shared/idle-cleanup.ts; {} parses into
// a complete document. `fresh` is deliberately not a mode: creating agents
// stays behind plan → confirm and manual C6 only.
export const factoryCleanupSettings = defineSettings({
  id: "factory-cleanup",
  scope: "host",
  version: 1,
  schema: z.object({
    mode: z.enum(["off", "clear", "compact-warm"]).default("off"),
    idleMinutes: z.number().int().min(5).default(60),
    compactAtMinutes: z.number().int().min(5).default(50),
    minContextTokens: z.number().int().min(1000).default(60000),
    providers: z.array(z.string().min(1)).min(1).default(["claude"]),
    roles: z.array(z.enum(["steer", "worker"])).min(1).default(["steer", "worker"]),
    seedAfterClear: z.boolean().default(false),
    clearAcknowledged: z.boolean().default(false),
    dailyCap: z.number().int().min(1).default(20),
  }),
});
