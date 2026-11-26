import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Prompt options for factory-generated briefs. `factoryRoot` is the git
 * checkout the plugin was installed from, or null for any other install;
 * the findings passage is only added when it is set. `pluginDir` is the
 * installed plugin directory on this host, or null when unknown; the role
 * texts name the CLI as `node <pluginDir>/cli.mjs`.
 */
export const factoryPromptSettings = defineRpc({
  name: "factory.prompt-settings",
  input: z.object({}),
  output: z.object({ findingsInPrompts: z.boolean(), factoryRoot: z.string().nullable(), pluginDir: z.string().nullable(), steerDelivery: z.literal(true) }),
});
