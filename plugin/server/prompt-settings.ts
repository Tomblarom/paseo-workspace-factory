import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { FACTORY_PLUGIN_ID, PROMPT_SETTINGS_RPC, findFactoryCheckout } from "./factory/findings.js";
import { factoryPromptSettings } from "../shared/prompt-settings.js";
import type { HostSettingsReader } from "./config.js";

if (factoryPromptSettings.name !== PROMPT_SETTINGS_RPC) throw new Error("prompt settings RPC name drifted");

export type PromptOptionsReader = (paseo: PluginHandlerContext["paseo"]) => Promise<{
  factoryRoot: string | null;
  findingsInPrompts: boolean;
}>;

export function registerPromptSettings(server: PluginServerContext, displaySettings: HostSettingsReader): PromptOptionsReader {
  async function readPromptSettings() {
    try {
      const state = await displaySettings.read();
      const values = state.status === "ready" ? state.values as { findingsInPrompts?: boolean } | undefined : undefined;
      return { findingsInPrompts: values?.findingsInPrompts !== false };
    } catch {
      return { findingsInPrompts: true };
    }
  }

  async function readFactoryRoot(paseo: PluginHandlerContext["paseo"]): Promise<string | null> {
    try {
      // Paseo evaluates a CJS bundle in the daemon, so import.meta.url
      // does not identify the installed plugin. Use the daemon's plugin path:
      // only a directory install inside a git checkout of the factory counts.
      const { config } = await paseo.config.get();
      const pluginDir = config.plugins?.[FACTORY_PLUGIN_ID]?.path;
      return pluginDir ? findFactoryCheckout(dirname(realpathSync(pluginDir))) : null;
    } catch {
      return null;
    }
  }

  async function readPromptOptions(paseo: PluginHandlerContext["paseo"]) {
    const settings = await readPromptSettings();
    const factoryRoot = await readFactoryRoot(paseo);
    return { findingsInPrompts: settings.findingsInPrompts && factoryRoot !== null, factoryRoot };
  }

  server.handle(factoryPromptSettings, (_input, { paseo }) => readPromptOptions(paseo));

  return readPromptOptions;
}
