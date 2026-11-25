import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Prompt options for factory-generated briefs. `factoryRoot` is the git
 * checkout the plugin was installed from, or null for any other install;
 * the findings passage is only added when it is set.
 */
export const factoryPromptSettings = defineRpc({
  name: "factory.prompt-settings",
  input: z.object({}),
  output: z.object({ findingsInPrompts: z.boolean(), factoryRoot: z.string().nullable(), steerDelivery: z.literal(true) }),
});
