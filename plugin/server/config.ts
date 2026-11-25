import { loadConfig, validateConfig } from "./factory/config.js";
import { configureRuntime } from "./factory/runtime.js";
import type { PromptOptionsReader } from "./prompt-settings.js";
import {
  mergeFactoryConfig,
  minimalFileConfigBase,
  missingHostSettings,
  validateFactorySettings,
  type FactorySettingsValues,
} from "../shared/settings-validate.js";

export interface HostSettingsReader {
  read(): Promise<{ status: string; revision?: string; values?: unknown; error?: string }>;
}

export async function loadFileConfig(configPath?: string): Promise<any> {
  const config = await loadConfig(configPath ?? undefined);
  configureRuntime(config);
  return config;
}

/**
 * Only the "file not found" failure of loadConfig; malformed files (JSON
 * syntax, invalid content) and IO errors propagate unchanged.
 */
export function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("No factory config at ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hostFieldLabel(field: string): string {
  return field === "githubOwner" ? "GitHub owner" : "checkout root";
}

/**
 * Effective config: the file on the daemon host plus the host-scope settings
 * document layered on top. Without settings the file stands alone; an
 * unreadable or invalid document fails loudly instead. Without a file, valid
 * host settings with an explicit GitHub owner and checkout root provide a
 * complete minimal config using the native defaults; anything less fails
 * with the missing piece named.
 */
export function createConfigLoader(
  hostSettings: HostSettingsReader | null,
  loadPromptOptions: PromptOptionsReader = async () => ({ findingsInPrompts: true, factoryRoot: null }),
) {
  async function loadEffectiveConfig(): Promise<any> {
    let fileConfig: any = null;
    let fileError: unknown = null;
    try {
      fileConfig = await loadFileConfig();
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      fileError = error;
    }
    if (!hostSettings) {
      if (fileError) throw fileError;
      return fileConfig;
    }
    const state = await hostSettings.read();
    if (fileError) return loadSettingsOnlyConfig(state, fileError);
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

  async function loadSettingsOnlyConfig(
    state: { status: string; revision?: string; values?: unknown; error?: string },
    fileError: unknown,
  ): Promise<any> {
    if (state.status !== "ready") {
      throw new Error(
        `${errorMessage(fileError)}; factory settings are ${state.status} (${state.error ?? "unreadable"}): open Factory settings, set the GitHub owner and checkout root, and save again`,
      );
    }
    const values = state.values as FactorySettingsValues;
    const errors = validateFactorySettings(values);
    if (errors.length) {
      throw new Error(`No factory config file; factory settings are invalid:\n- ${errors.join("\n- ")}`);
    }
    const missing = missingHostSettings(values);
    if (missing.length) {
      const labels = missing.map(hostFieldLabel).join(" and ");
      throw new Error(
        `${errorMessage(fileError)}; set the ${labels} in Factory settings to run without a config file`,
      );
    }
    const merged = mergeFactoryConfig(minimalFileConfigBase(values), values);
    const configErrors = validateConfig(merged);
    if (configErrors.length) {
      throw new Error(`Factory settings do not provide a complete config:\n- ${configErrors.join("\n- ")}`);
    }
    configureRuntime(merged);
    return merged;
  }

  return { loadFileConfig, loadEffectiveConfig, loadPromptOptions };
}

export type ConfigLoader = ReturnType<typeof createConfigLoader>;
