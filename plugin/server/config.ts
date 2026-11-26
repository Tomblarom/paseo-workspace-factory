import { validateConfig } from "./core/config.mjs";
import { configureRuntime } from "./core/runtime.mjs";
import type { PromptOptionsReader } from "./prompt-settings.js";
import {
  configFromSettings,
  missingHostSettings,
  validateFactorySettings,
  type FactorySettingsValues,
} from "../shared/settings-validate.js";

export interface HostSettingsReader {
  read(): Promise<{ status: string; revision?: string; values?: unknown; error?: string }>;
}

function hostFieldLabel(field: string): string {
  return field === "githubOwner" ? "GitHub owner" : "checkout root";
}

/**
 * Effective config built from the plugin settings only; there is no config
 * file and a legacy file is ignored. Missing host fields fail with the piece
 * named so the user can set it in Factory settings.
 */
export function createConfigLoader(
  hostSettings: HostSettingsReader | null,
  loadPromptOptions: PromptOptionsReader = async () => ({ findingsInPrompts: true, factoryRoot: null, pluginDir: null }),
) {
  async function loadEffectiveConfig(): Promise<any> {
    if (!hostSettings) {
      throw new Error("Factory settings are not available; open Factory settings and save them again");
    }
    const state = await hostSettings.read();
    if (state.status !== "ready") {
      throw new Error(
        `Factory settings are ${state.status}: ${state.error ?? "unreadable"}; open the Factory settings and save them again`,
      );
    }
    const values = state.values as FactorySettingsValues;
    const errors = validateFactorySettings(values);
    if (errors.length) {
      throw new Error(`Factory settings are invalid:\n- ${errors.join("\n- ")}`);
    }
    const missing = missingHostSettings(values);
    if (missing.length) {
      const labels = missing.map(hostFieldLabel).join(" and ");
      throw new Error(`Set the ${labels} in Factory settings to run the factory`);
    }
    const config = configFromSettings(values);
    const configErrors = validateConfig(config);
    if (configErrors.length) {
      throw new Error(`Factory settings do not provide a complete config:\n- ${configErrors.join("\n- ")}`);
    }
    configureRuntime(config);
    return config;
  }

  return { loadEffectiveConfig, loadPromptOptions };
}

export type ConfigLoader = ReturnType<typeof createConfigLoader>;
