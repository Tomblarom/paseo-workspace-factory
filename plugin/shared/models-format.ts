// Text rendering of the worker/steer lists and of a planned model change, for
// the slash command result. Pure module: no imports.

interface ListRow {
  position: number;
  profile: string;
  provider: string;
  model: string;
  thinking: string | null;
  mode: string | null;
  advisor: boolean;
  sensitive: boolean;
  available: boolean;
  reasons: string[];
  selected?: boolean;
  slot?: string;
  fallback?: string | null;
}

/** Badges after a profile: [advisor] and [sensitive: sanitized tasks only]. */
export function profileBadges(row: { advisor: boolean; sensitive: boolean }): string {
  return `${row.advisor ? " [advisor]" : ""}${row.sensitive ? " [sensitive: sanitized tasks only]" : ""}`;
}

function describe(row: ListRow): string {
  const extra = [row.thinking ? `thinking ${row.thinking}` : null, row.mode ? `mode ${row.mode}` : null].filter(Boolean);
  return `${row.profile} (${row.provider}/${row.model}${extra.length ? `, ${extra.join(", ")}` : ""})${profileBadges(row)}`;
}

function mark(row: ListRow): string {
  return row.available ? "✓" : "✗";
}

export function formatModelList(kind: "worker" | "steer", list: { workers: ListRow[]; steers: ListRow[]; selectedWorker: string | null; catalogError: string | null }): string {
  const rows = kind === "worker" ? list.workers : list.steers;
  const lines = [kind === "worker" ? "Worker models (priority, highest first):" : "Steer slots (slot order = priority):"];
  if (!rows.length) lines.push("  (none)");
  for (const row of rows) {
    const head = kind === "steer" ? `${row.position}. Steer ${row.slot}` : `${row.position}.`;
    const flags = [row.selected ? "→ selected" : null, row.fallback ? `fallback: ${row.fallback}` : null].filter(Boolean);
    lines.push(`  ${head}  ${mark(row)} ${describe(row)}${flags.length ? `  ${flags.join(", ")}` : ""}`);
    if (!row.available) for (const reason of row.reasons) lines.push(`        ${reason}`);
  }
  if (list.catalogError) lines.push("", `Availability unknown: ${list.catalogError}`);
  lines.push("", "✓ available, ✗ not available now (kept in the list, skipped when starting).");
  return lines.join("\n");
}

export function formatModelChange(change: { summary: string; notes: string[]; warnings: string[] }, saved: boolean): string {
  return [
    saved ? "Saved." : "Preview only (--dry-run); nothing saved.",
    change.summary,
    ...change.notes.map((note) => `Note: ${note}`),
    ...change.warnings.map((warning) => `Warning: ${warning}`),
  ].join("\n");
}
