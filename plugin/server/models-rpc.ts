// factory.models.list / factory.models.set: effective worker and steer lists
// with availability, and planned edits as a new settings document.
// Reuses the synced core (resolveProfile, plan*), so the CLI and the plugin
// agree. The 60-second catalog cache keeps repeated slash calls cheap.
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { factoryModelsList, factoryModelsSet } from "../shared/factory.js";
import { settingsFromConfig, validateFactorySettings, type FactorySettingsValues } from "../shared/settings-validate.js";
import type { ConfigLoader, HostSettingsReader } from "./config.js";
import { isAdvisorProfile, isSensitiveProfile, slotOrder, validateProfilesAgainstCatalog, workerPriority } from "./core/config.mjs";
import {
  planAdvisorTag,
  planSensitiveTag,
  planSteerRemove,
  planSteerSet,
  planWorkerRemove,
  planWorkerSet,
  resolveProfile,
  steerFallbackList,
} from "./core/models.mjs";
import { readZerosubStateSafe } from "./zerosub-runtime.js";

export const CATALOG_TTL_MS = 60_000;

let cache: { at: number; entries: any[] } | null = null;

/** Test hook: forget the cached catalog. */
export function resetCatalogCache(): void {
  cache = null;
}

export async function loadCatalog(paseo: any, now: () => number = Date.now): Promise<any[]> {
  if (cache && now() - cache.at < CATALOG_TTL_MS) return cache.entries;
  const result = await paseo.providers.snapshot();
  const entries = Array.isArray(result?.entries) ? result.entries : [];
  cache = { at: now(), entries };
  return entries;
}

function row(config: any, entries: any[], name: string, position: number) {
  const p: any = config.profiles?.[name] ?? {};
  const problems = config.profiles?.[name] ? ((validateProfilesAgainstCatalog(config, entries, [name]) as any)[name] ?? []) : [`unknown profile ${JSON.stringify(name)}`];
  return {
    position,
    profile: name,
    provider: String(p.provider ?? "?"),
    model: String(p.model ?? "?"),
    thinking: (p.thinking ?? null) as string | null,
    mode: (p.mode ?? null) as string | null,
    advisor: isAdvisorProfile(config, name),
    sensitive: isSensitiveProfile(config, name),
    available: problems.length === 0,
    reasons: problems as string[],
  };
}

export async function listModels(
  _input: RpcInput<typeof factoryModelsList>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
  hostSettings: HostSettingsReader | null,
  now: () => number = Date.now,
  readZerosub: () => Promise<any> = readZerosubStateSafe,
) {
  const state = hostSettings ? structuredClone(await hostSettings.read()) : undefined;
  const config = await loader.loadEffectiveConfig(state);
  let entries: any[] = [];
  let catalogError: string | null = null;
  try {
    entries = await loadCatalog(paseo, now);
  } catch (error) {
    catalogError = error instanceof Error ? error.message : String(error);
  }
  // Sensitivity does not block "selected" here: the list assumes a public repo.
  // Quota uses the same ZeroSub snapshot as worker pick, so an exhausted
  // profile is never marked selected.
  const zerosub = catalogError ? null : await readZerosub().catch(() => null);
  const picked: any = catalogError
    ? { profile: null, skipped: [] }
    : resolveProfile(config, entries, workerPriority(config), { role: "worker", repoPublic: true, zerosub } as any);
  const selectedName: string | null = picked.profile?.name ?? null;
  const skipReasons = new Map<string, string>((picked.skipped ?? []).map((s: any) => [s?.name, s?.reason]));
  const workers = workerPriority(config).map((name: string, index: number) => ({
    ...row(config, entries, name, index + 1),
    selected: name === selectedName,
    skipReason: skipReasons.get(name) ?? null,
  }));
  const steers = slotOrder(config).map((slot: string, index: number) => {
    const name = config.steers.slots[slot] as string;
    const own = row(config, entries, name, index + 1);
    let fallback: string | null = null;
    if (!own.available && !catalogError) {
      const alt = resolveProfile(config, entries, steerFallbackList(config, slot), {
        role: "steer",
        advisorSlot: own.advisor,
        repoPublic: true,
      });
      fallback = alt.profile && alt.profile.name !== name ? alt.profile.name : null;
    }
    return { ...own, slot, fallback };
  });
  const roleRows = (priority: string[] | undefined) => priority?.map((name, index) => row(config, entries, name, index + 1));
  return {
    revision: state && state?.status === "ready" ? (state.revision ?? null) : null,
    workers,
    steers,
    steerPreferences: roleRows(config.steers?.priority),
    advisorPreferences: roleRows(config.advisors?.priority),
    selectedWorker: selectedName,
    catalogError,
  };
}

export async function setModels(
  input: RpcInput<typeof factoryModelsSet>,
  { paseo }: PluginHandlerContext,
  loader: ConfigLoader,
  hostSettings: HostSettingsReader | null,
  now: () => number = Date.now,
) {
  if (!hostSettings) throw new Error("Factory settings are not available; open Factory settings and save them again");
  const state = structuredClone(await hostSettings.read());
  if (state.status !== "ready") {
    throw new Error(`Factory settings are ${state.status}: ${(state as any).error ?? "unreadable"}; open the settings page and save them again`);
  }
  const config = await loader.loadEffectiveConfig(state);
  // An unreadable catalog only skips the availability warnings.
  const entries = await loadCatalog(paseo, now).catch(() => []);
  const need = (value: string | undefined, what: string): string => {
    if (value === undefined) throw new Error(`${input.action} needs ${what}`);
    return value;
  };
  const opts = () => ({
    spec: need(input.spec, "<profile|provider/model>"),
    thinking: input.thinking,
    mode: input.mode,
    profile: input.profile,
  });
  let plan: any;
  switch (input.action) {
    case "worker-set":
      plan = planWorkerSet(config, entries, { n: need(input.n, "a position"), ...opts() });
      break;
    case "worker-rm":
      plan = planWorkerRemove(config, need(input.n, "a position"));
      break;
    case "steer-set":
      plan = planSteerSet(config, entries, { target: need(input.n, "a position or slot"), ...opts() });
      break;
    case "steer-rm":
      plan = planSteerRemove(config, need(input.n, "a position or slot"));
      break;
    case "advisor":
      plan = planAdvisorTag(config, entries, { spec: need(input.spec, "a profile"), on: input.on === true });
      break;
    default:
      plan = planSensitiveTag(config, entries, { spec: need(input.spec, "a profile"), on: input.on === true });
  }
  const values = settingsFromConfig(plan.config, state.values as FactorySettingsValues);
  const errors = validateFactorySettings(values);
  if (errors.length) throw new Error(`The change does not fit the settings:\n- ${errors.join("\n- ")}`);
  return {
    summary: String(plan.summary),
    notes: (plan.notes ?? []) as string[],
    warnings: (plan.warnings ?? []) as string[],
    revision: state.revision ?? "",
    values,
  };
}
