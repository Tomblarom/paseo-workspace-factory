import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { FACTORY_PLUGIN_ID, PROMPT_SETTINGS_RPC, findFactoryCheckout } from "./core/findings.mjs";
import { factoryPromptSettings } from "../shared/prompt-settings.js";
import type { HostSettingsReader } from "./config.js";

if (factoryPromptSettings.name !== PROMPT_SETTINGS_RPC) throw new Error("prompt settings RPC name drifted");

export type PromptOptionsReader = (paseo: PluginHandlerContext["paseo"]) => Promise<{
  factoryRoot: string | null;
  pluginDir: string | null;
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

  async function readInstallPaths(paseo: PluginHandlerContext["paseo"]): Promise<{ factoryRoot: string | null; pluginDir: string | null }> {
    try {
      // Paseo evaluates a CJS bundle in the daemon, so import.meta.url
      // does not identify the installed plugin. Use the daemon's plugin path
      // (the same install directory `paseo plugin ls --json` reports, never a
      // compile cache): the CLI ships inside it as cli.mjs, and only a
      // directory install inside a git checkout of the factory counts as one.
      const { config } = await paseo.config.get();
      const pluginDir: unknown = config.plugins?.[FACTORY_PLUGIN_ID]?.path;
      if (typeof pluginDir !== "string" || !pluginDir) return { factoryRoot: null, pluginDir: null };
      return { factoryRoot: findFactoryCheckout(dirname(realpathSync(pluginDir))), pluginDir };
    } catch {
      return { factoryRoot: null, pluginDir: null };
    }
  }

  async function readPromptOptions(paseo: PluginHandlerContext["paseo"]) {
    const settings = await readPromptSettings();
    const { factoryRoot, pluginDir } = await readInstallPaths(paseo);
    return { findingsInPrompts: settings.findingsInPrompts && factoryRoot !== null, factoryRoot, pluginDir };
  }

  server.handle(factoryPromptSettings, async (_input, { paseo }) => ({ ...await readPromptOptions(paseo), steerDelivery: true as const }));

  return readPromptOptions;
}
