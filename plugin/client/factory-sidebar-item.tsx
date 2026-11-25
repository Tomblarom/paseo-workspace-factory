import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Text } from "react-native";
import { factoryQuota } from "../shared/factory.js";

const QUOTA_POLL_MS = 60_000;

function quotaWarningText(quota: {
  warnPct: number;
  pools: { pool: string; sessionPct: number | null; state: string }[];
  steers: { pool: string; advisor: boolean }[];
}): string | null {
  const byPool = new Map(quota.pools.map((pool) => [pool.pool, pool]));
  let worst: { pool: string; pct: number } | null = null;
  for (const steer of quota.steers) {
    if (steer.advisor) continue;
    const entry = byPool.get(steer.pool);
    const pct = typeof entry?.sessionPct === "number" ? entry.sessionPct : null;
    if (pct === null || pct < quota.warnPct) continue;
    if (!worst || pct > worst.pct) worst = { pool: steer.pool, pct };
  }
  return worst ? `Quota ${worst.pool} ${worst.pct}%` : null;
}

export function FactorySidebarItem({
  openSettings,
  theme,
}: PluginSidebarItemProps & { openSettings: () => void }) {
  const callQuota = useRpc(factoryQuota);
  const [quotaWarn, setQuotaWarn] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const quota = await callQuota({});
        if (!cancelled) setQuotaWarn(quotaWarningText(quota));
      } catch {
        if (!cancelled) setQuotaWarn(null);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), QUOTA_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [callQuota]);
  const trailing = quotaWarn;
  return (
    <SidebarRow
      icon="Factory"
      label="Workspace Factory"
      onPress={openSettings}
      trailing={
        trailing ? (
          <Text style={{ color: theme.colors.statusWarning, fontSize: 13 }}>{trailing}</Text>
        ) : undefined
      }
    />
  );
}
