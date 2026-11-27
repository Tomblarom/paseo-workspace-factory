// Fresh renews the holder's observed route first. Presets are replacement
// choices, so a runtime model change never rewrites a host preference.
import { workerPriority, isAdvisorProfile, providerIsSensitive } from './config.mjs';
import { liveAgentPool, readProfileHealth } from './quota.mjs';
import { resolveProfile, steerFallbackList, usedProfilesByLiveSteers } from './models.mjs';
import { routeMatchesIntent } from './routing.mjs';

export function freshLiveRoute(agent) {
  const features = Object.fromEntries((agent.features ?? [])
    .filter((feature) => typeof feature.id === 'string' && feature.value !== undefined)
    .map((feature) => [feature.id, feature.value]));
  const optionEntries = Object.entries({ ...features, ...(agent.options ?? agent.providerOptions) });
  optionEntries.sort(([a], [b]) => a.localeCompare(b));
  const options = Object.fromEntries(optionEntries);
  return {
    provider: agent.provider ?? null,
    model: agent.model ?? null,
    thinking: agent.effectiveThinkingOptionId ?? agent.runtimeInfo?.thinkingOptionId ?? agent.thinkingOptionId ?? null,
    mode: agent.currentModeId ?? agent.runtimeInfo?.modeId ?? agent.modeId ?? null,
    ...(Object.keys(options).length ? { options } : {}),
  };
}

export function freshCreationRoute({ config, providers, from, role, slot, steers, repoPublic, quotaSnapshot, quotaExhaustedPct, zerosub, metadata, now, intent, allowDepletedReset = false }) {
  const live = freshLiveRoute(from);
  const profiles = config?.profiles ?? {};
  const worker = role === 'worker';
  const advisor = role === 'advisor';
  const rolePriorities = advisor ? config?.advisors?.priority : config?.steers?.priority;
  const priorities = worker ? workerPriority(config) : rolePriorities ?? steerFallbackList(config, slot);
  const used = new Set(usedProfilesByLiveSteers(config, steers.filter((s) => s.slot !== slot && !s.superseded && !s.retired)));
  const catalog = { role: worker ? 'worker' : 'steer', advisorSlot: advisor, repoPublic, quotaSnapshot,
    quotaExhaustedPct, zerosub, profileHealth: readProfileHealth(metadata), now };
  // resolveProfile uses string keys, including for unprofiled native routes.
  const key = '';
  const check = (name, profile, rank, source) => {
    const pair = { provider: profile.provider, model: profile.model };
    const base = { ...pair, profile: name === key ? null : name, source, rank };
    if (!pair.provider || !pair.model) return { ...base, reason: 'runtime provider/model is unknown' };
    const sensitive = providerIsSensitive(config, pair.provider);
    if (sensitive && repoPublic !== true) {
      return { ...base, reason: 'sensitive runtime is private or unknown; public scope required' };
    }
    const model = providers?.find((entry) => entry.provider === pair.provider)?.models?.find((entry) => entry.id === pair.model);
    if (model?.isSelectable === false) return { ...base, reason: 'model is unavailable for new agents' };
    const candidateConfig = name === key ? { ...config, profiles: { ...profiles, [key]: { ...profile, sensitive } } } : config;
    const result = resolveProfile(candidateConfig, providers, [name], { ...catalog,
      ignoreQuotaExhaustion: allowDepletedReset && source === "live" });
    return result.profile ? { ...base, route: result.profile, account: result.zerosubAccount } :
      { ...base, reason: result.skipped[0]?.reason ?? 'not startable' };
  };

  const nameOfLive = [...new Set([...priorities, ...Object.keys(profiles)])].find((name) => {
    const preset = profiles[name];
    return preset && preset.provider === live.provider && preset.model === live.model && isAdvisorProfile(config, name) === advisor &&
      (preset.thinking ?? null) === live.thinking && (preset.mode ?? null) === live.mode;
  }) ?? null;
  const candidates = [check(key, { ...live, advisor, pool: liveAgentPool(live, config) }, 0, 'live')];
  candidates[0].profile = nameOfLive;
  const names = intent.mode === 'explicit' ? [...new Set([...priorities, ...Object.keys(profiles)])] : [...new Set(priorities)];
  for (const [index, name] of names.entries()) {
    const preset = profiles[name];
    if (!preset) continue;
    if (!worker && intent.mode !== 'explicit' && !rolePriorities && index > 0 && used.has(name)) continue;
    candidates.push(check(name, preset, index + 1, 'preference'));
  }
  if (intent.mode === 'explicit' && !advisor && !Object.values(profiles).some((profile) =>
    profile.provider === intent.provider && profile.model === intent.model)) {
    candidates.push(check(key, { provider: intent.provider, model: intent.model, pool: liveAgentPool(intent, config) }, names.length + 1, 'explicit'));
  }
  const selected = candidates.find((candidate) => candidate.route && routeMatchesIntent(candidate, intent));
  const evidence = candidates.map(({ route, account, ...candidate }) => ({
    ...candidate, eligible: !!route, requested: routeMatchesIntent(candidate, intent), account: account ?? null,
  }));
  if (!selected) {
    const requested = evidence.filter((candidate) => candidate.requested);
    const reason = requested.find((candidate) => candidate.reason)?.reason ?? 'no matching eligible profile';
    const alternatives = [...new Set(evidence.filter((candidate) => candidate.eligible && !candidate.requested)
      .map((candidate) => `${candidate.provider}/${candidate.model}`))];
    const target = intent.mode === 'explicit' ? `Requested route ${intent.provider}/${intent.model}` : `Live route ${live.provider ?? '?'}/${live.model ?? '?'}`;
    return { error: `${target} is not startable: ${reason}${alternatives.length ? `; eligible alternatives: ${alternatives.join(', ')}` : ' (no fallback available)'}` };
  }
  const { route, source, account, profile } = selected;
  return { route, live, profile, source, account, evidence };
}
