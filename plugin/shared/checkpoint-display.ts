// Display shortening for CHECKPOINT blocks in the chat (factory-display
// setting). No imports, so plain node:test can use it. The header/field
// matchers mirror parseCheckpointBlock in src/steer.mjs: whatever the
// factory parses as a checkpoint is what gets shortened.

const HEADER = /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?`*\s*CHECKPOINT\s*:?\s*`*(?:\*\*|__)?\s*$/i;
const FIELD = /^\s*[-*]?\s*(task|tests|blockers|next|status)\s*:\s*(.*)$/i;
const WORKERS = /^\s*[-*]?\s*workers\s*:/i;
const FENCE = /^\s*(`{3,})([^`]*)$/;
const NONE = /^(keine?|none|n\/a|-)\.?$/i;
const STATUS = /^(done|partial|blocked)$/i;

const SUMMARY_MAX = 60;

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max).trimEnd()}…` : value;
}

/**
 * Replaces the CHECKPOINT block (the last one the parser would read) with a
 * single summary line; returns the input unchanged when there is no valid
 * block. Only the block span is replaced, everything else stays identical.
 */
export function shortenCheckpoint(text: string): string {
  if (typeof text !== "string" || !/checkpoint/i.test(text)) return text;
  const lines = text.split("\n");
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (HEADER.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) return text;
  // Track fence pairs so a bare opener is accepted and the end of the
  // previous code sample cannot be mistaken for the checkpoint opener.
  let open = -1;
  let fenceLength = 0;
  let close = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (i >= start && open !== start - 1) break;
    const fence = lines[i].match(FENCE);
    if (!fence) continue;
    if (open === -1) {
      open = i;
      fenceLength = fence[1].length;
    } else if (fence[1].length >= fenceLength && !fence[2].trim()) {
      if (i > start) {
        close = i;
        break;
      }
      open = -1;
    }
  }
  const fenced = open === start - 1 && close > start;
  if (open >= 0 && !fenced) return text;

  const fields: Record<string, string> = {};
  let lastField = -1;
  const limit = fenced ? close : lines.length;
  for (let i = start + 1; i < limit; i += 1) {
    const line = lines[i];
    const match = line.match(FIELD);
    if (match) {
      fields[match[1].toLowerCase()] = match[2].trim();
      lastField = i;
      continue;
    }
    if (WORKERS.test(line)) {
      lastField = i;
      continue;
    }
    if (line.trim() === "") continue;
    if (!fenced) break;
  }
  if (!fields.task) return text;
  const next = fields.next && !NONE.test(fields.next) ? fields.next : null;
  const status =
    fields.status && STATUS.test(fields.status.trim()) ? fields.status.trim().toLowerCase() : null;
  const summary = clip(oneLine(next ?? status ?? fields.task), SUMMARY_MAX);
  return [
    ...lines.slice(0, fenced ? open : start),
    `✓ Checkpoint gespeichert · ${summary}`,
    ...lines.slice((fenced ? close : lastField) + 1),
  ].join("\n");
}
