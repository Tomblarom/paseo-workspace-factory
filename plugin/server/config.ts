import { loadConfig, validateConfig } from "./factory/config.js";
import { configureRuntime } from "./factory/runtime.js";
import {
  mergeFactoryConfig,
  validateFactorySettings,
  type FactorySettingsValues,
} from "../shared/settings-validate.js";

export interface HostSettingsReader {
  read(): Promise<{ status: string; values?: unknown; error?: string }>;
}

export async function loadFileConfig(configPath?: string): Promise<any> {
  const config = await loadConfig(configPath ?? undefined);
  configureRuntime(config);
  return config;
}

/**
 * Effective config: the file on the daemon host plus the host-scope settings
 * document layered on top. Without settings (or with an unreadable document)
 * the file stands alone; an invalid document fails loudly instead.
 */
export function createConfigLoader(hostSettings: HostSettingsReader | null) {
  async function loadEffectiveConfig(): Promise<any> {
    const fileConfig = await loadFileConfig();
    if (!hostSettings) return fileConfig;
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
    const merged = mergeFactoryConfig(fileConfig, values);
    const configErrors = validateConfig(merged);
    if (configErrors.length) {
      throw new Error(`Factory settings do not fit the config file:\n- ${configErrors.join("\n- ")}`);
    }
    return merged;
  }
  return { loadFileConfig, loadEffectiveConfig };
}

export type ConfigLoader = ReturnType<typeof createConfigLoader>;
