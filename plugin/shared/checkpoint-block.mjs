// Shared by the server parser and the chat checkpoint renderer.
const HEADER = /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?`*\s*CHECKPOINT\s*:?\s*`*(?:\*\*|__)?\s*$/i;
const FIELD = /^\s*[-*]?\s*(task|tests|blockers|next|status)\s*:\s*(.*)$/i;
const WORKERS = /^\s*[-*]?\s*workers\s*:/i;
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const NONE = /^(keine?|none|n\/a|-)\.?$/i;

function readFields(lines, start, end, requireAll) {
  const fields = { task: '', tests: undefined, blockers: undefined, next: undefined, status: undefined };
  let lastField = start - 1;
  for (let i = start; i < end; i += 1) {
    const line = lines[i].trimEnd();
    const match = line.match(FIELD);
    if (match) {
      fields[match[1].toLowerCase()] = match[2].trim();
      lastField = i;
    } else if (WORKERS.test(line)) {
      lastField = i;
    } else if (line) {
      if (requireAll) return null;
      break;
    }
  }
  if (!fields.task || (requireAll && [fields.tests, fields.blockers, fields.next].includes(undefined))) return null;
  const list = (value) => (!value || NONE.test(value) ? [] : [value]);
  const status = /^(done|partial|blocked)$/i.test(fields.status ?? '') ? fields.status.toLowerCase() : null;
  return {
    lastField,
    checkpoint: {
      task: fields.task,
      tests: list(fields.tests),
      blockers: list(fields.blockers),
      next: fields.next && !NONE.test(fields.next) ? fields.next : null,
      ...(status ? { status } : {}),
    },
  };
}

/** Finds the last valid block and its inclusive line bounds. Unlabelled blocks need a complete fence and all four fields. */
export function findCheckpointBlock(lines) {
  let open = null;
  let block = null;
  for (let i = 0; i < lines.length; i += 1) {
    const fence = lines[i].trimEnd().match(FENCE);
    if (open) {
      if (!fence || fence[1][0] !== open.marker[0] || fence[1].length < open.marker.length || fence[2]) continue;
      let heading = i - 1;
      while (heading > open.line && !HEADER.test(lines[heading])) heading -= 1;
      const fields = readFields(lines, heading + 1, i, heading === open.line && !open.labelled);
      if (fields) block = { start: open.line, end: i, checkpoint: fields.checkpoint };
      open = null;
    } else if (fence && (fence[1][0] === '~' || !fence[2].includes('`'))) {
      open = { line: i, marker: fence[1], labelled: /(?:^|\s)checkpoint:?(?:\s|$)/i.test(fence[2]) };
    } else if (HEADER.test(lines[i])) {
      const fields = readFields(lines, i + 1, lines.length, false);
      if (fields) {
        block = { start: i, end: fields.lastField, checkpoint: fields.checkpoint };
        i = fields.lastField;
      }
    }
  }
  return block;
}

export function parseCheckpointBlock(text) {
  return typeof text === 'string' ? findCheckpointBlock(text.split('\n'))?.checkpoint ?? null : null;
}
