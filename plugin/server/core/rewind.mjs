// Same-tab refresh via Paseo rewind (fresh --slot/--worker, auto-cleanup).
// Rewinds the agent's conversation at a usable user message instead of
// creating a new agent: DaemonClient.rewindAgent(agentId, messageId,
// 'conversation'), using bounded canonical timeline pages. Agents driven only via `send` have
// no user_message with a messageId and therefore no rewind point: callers fall
// back to a new parent-free agent. Only a missing rewind method proves the
// provider lacks rewind before dispatch; any error after dispatch is an
// uncertain outcome (the provider may have forked), never a fallback.
// Only real user_message entries are rewind points: a brief sent via
// `paseo send` from inside an agent (PASEO_AGENT_ID set) arrives as a tool_call
// (paseo-agent-message) and rewinding to it fails ("could not find user
// message"). The resume brief after a rewind is therefore delivered through
// DaemonClient.sendMessage WITHOUT a caller agent id, so it arrives as
// user_message and the next refresh rewinds to exactly that brief.
// All reads fail soft (a status object, never a throw for daemon failures) so
// callers transparently fall back to the new-agent path. `createClient` is
// injectable for tests ({ url, cliPath } -> { fetchAgentTimeline, rewindAgent,
// sendMessage?, close? }); production callers pass defaultCreateRewindClient.
// Never call this from unit tests without an injected factory.
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { daemonPassword, paseoBinary } from './paseo.mjs';
import { runtime } from './runtime.mjs';

/**
 * First user_message messageId of a timeline payload, or null. Tolerant:
 * rows live under entries/rows/items, each row wraps its item, and only
 * user_message rows with a non-empty string messageId count. Agents driven
 * only via `send` have none.
 */
export function firstRewindPoint(timelinePayload) {
  return rewindPoints(timelinePayload).next().value?.messageId ?? null;
}

function* rewindPoints(timelinePayload) {
  const rows = timelinePayload?.entries ?? timelinePayload?.rows ?? timelinePayload?.items ?? [];
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    const item = row?.item ?? row;
    if (item?.type === 'user_message' && typeof item.messageId === 'string' && item.messageId) {
      yield { messageId: item.messageId, clientMessageId: item.clientMessageId, turnId: row.turnId };
    }
  }
}

const REWIND_PAGE_SIZE = 32;

async function findRewindPoint(client, agentId, previousBriefId = null, { keepBrief = false } = {}) {
  const options = { limit: REWIND_PAGE_SIZE, projection: 'canonical' };
  if (previousBriefId) {
    let page = await client.fetchAgentTimeline(agentId, { ...options, direction: 'tail' });
    let earliest = null;
    let nextTurn = null;
    while (true) {
      for (const point of [...rewindPoints(page)].reverse()) {
        // Codex removes the target turn itself. Keep the saved brief by
        // rewinding at the first usable prompt from a later turn.
        const sameTurn = point.turnId && point.turnId === earliest?.turnId;
        if (point.messageId === previousBriefId || point.clientMessageId === previousBriefId) {
          if (!keepBrief) return point;
          return { messageId: (sameTurn ? nextTurn : earliest)?.messageId ?? null, briefMessageId: previousBriefId };
        }
        if (!sameTurn) nextTurn = earliest;
        earliest = point;
      }
      if (!page?.hasOlder) return earliest;
      const cursor = page.startCursor;
      if (!cursor) throw new Error('Missing rewind timeline cursor');
      page = await client.fetchAgentTimeline(agentId, { ...options, direction: 'before', cursor });
      if (page?.staleCursor || page?.startCursor?.seq >= cursor.seq) throw new Error('Rewind timeline changed while paging');
    }
  }
  let cursor;
  while (true) {
    const page = await client.fetchAgentTimeline(agentId, { ...options, direction: 'after', ...(cursor ? { cursor } : {}) });
    if (page?.staleCursor) throw new Error('Rewind timeline changed while paging');
    const point = firstRewindPoint(page);
    if (point || !page?.hasNewer) return point ? { messageId: point } : null;
    if (!page.endCursor || (cursor && page.endCursor.seq <= cursor.seq)) throw new Error('Missing or unchanged rewind timeline cursor');
    cursor = page.endCursor;
  }
}

/**
 * Default client factory: the internal DaemonClient that ships with the
 * installed CLI (the high-level client has no rewind RPC). Mirrors the load
 * path of readZerosubState in zerosub.mjs; any failure throws and the caller
 * below turns it into a fail-soft status. Production callers (CLI, plugin
 * handlers) pass this as `rewindClient` to freshSteer; unit tests inject a
 * fake instead.
 */
export async function defaultCreateRewindClient({ url, cliPath }) {
  const require = createRequire(realpathSync(cliPath));
  const { DaemonClient } = await import(pathToFileURL(require.resolve('@getpaseo/client/internal/daemon-client')).href);
  const daemon = new DaemonClient({
    url,
    password: daemonPassword(),
    clientId: 'paseo-workspace-factory-rewind',
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    reconnect: { enabled: false },
  });
  await daemon.connect();
  return daemon;
}

/**
 * One rewind transport: connects a DaemonClient, runs `fn(client)`, always
 * closes. Throws on connect failure (callers map it to fail-soft statuses);
 * `fn` decides its own error mapping. This is the only client lifecycle in
 * this module — every export below funnels through it.
 */
async function useRewindClient({ url = null, cliPath = null, createClient = defaultCreateRewindClient } = {}, fn) {
  const target = url ?? runtime().paseo.url;
  const bin = cliPath ?? paseoBinary();
  let client = null;
  try {
    client = await createClient({ url: target, cliPath: bin });
    return await fn(client);
  } finally {
    await client?.close?.().catch(() => {});
  }
}

/**
 * Anchor lookup plus the rewind RPC on an open client. Returns the fail-soft
 * outcome ({ status: 'rewound' | 'no-point' | 'no-op' | 'unsupported' |
 * 'failed' | 'deferred' }); throws only for timeline/paging failures, which
 * the caller reports as 'unavailable'. Anchor semantics are unchanged:
 * without keepBrief the previous brief itself is the target, with keepBrief
 * the first usable prompt of a later turn is (Codex deletes the target turn).
 */
async function rewindOnClient(client, agentId, { previousBriefId = null, keepBrief = false, beforeRewind = null } = {}) {
  const point = await findRewindPoint(client, agentId, previousBriefId, { keepBrief });
  if (!point) return { status: 'no-point' };
  const { messageId, briefMessageId } = point;
  if (!messageId) return { status: 'no-op' };
  if (typeof client.rewindAgent !== 'function') return { status: 'unsupported', error: 'daemon has no rewindAgent' };
  try {
    if (beforeRewind && !await beforeRewind()) return { status: 'deferred' };
    await client.rewindAgent(agentId, messageId, 'conversation');
  } catch (error) {
    // The provider can commit a fork before returning an error, including an
    // error whose text says unsupported. Only the missing-method check above
    // establishes unsupported before dispatch.
    return { status: 'failed', error: error?.message ?? String(error) };
  }
  return { status: 'rewound', messageId, ...(briefMessageId ? { briefMessageId } : {}) };
}

/**
 * Best-effort read of the first rewind point. Returns the messageId string, or
 * null on any failure (no daemon, no timeline, no user message). Never throws
 * for daemon failures; production callers treat null as "new agent".
 */
export async function readRewindPoint(agentId, { url = null, cliPath = null, createClient = defaultCreateRewindClient, previousBriefId = null } = {}) {
  if (typeof agentId !== 'string' || !agentId) return null;
  try {
    return (await useRewindClient({ url, cliPath, createClient },
      (client) => findRewindPoint(client, agentId, previousBriefId)))?.messageId ?? null;
  } catch {
    return null;
  }
}

/**
 * Rewinds one agent's conversation, keeping an existing brief and its turn
 * when possible. Fail-soft status, never a throw for daemon failures:
 * - { status: 'rewound', messageId, briefMessageId? }: the rewind happened.
 * - { status: 'no-op' }: the saved brief has no later usable rewind point.
 * - { status: 'no-point' }: no user_message with a messageId (send-only
 *   agents); the caller falls back to a new parent-free agent.
 * - { status: 'unsupported', error }: the provider has no rewind; the caller
 *   falls back to a new parent-free agent.
 * - { status: 'unavailable', error }: the daemon could not be reached for the
 *   rewind check (connect or timeline fetch failed); the caller falls back to
 *   a new parent-free agent, preserving the pre-rewind behavior.
 * - { status: 'failed', error }: the rewind point exists but the rewind call
 *   failed; the caller must abort without side effects (no send, no record,
 *   no new agent).
 */
export async function rewindSameTab(agentId, { url = null, cliPath = null, createClient = defaultCreateRewindClient, previousBriefId = null, beforeRewind = null } = {}) {
  if (typeof agentId !== 'string' || !agentId) return { status: 'failed', error: 'missing agent id' };
  try {
    return await useRewindClient({ url, cliPath, createClient },
      (client) => rewindOnClient(client, agentId, { previousBriefId, keepBrief: true, beforeRewind }));
  } catch (error) {
    return { status: 'unavailable', error: error?.message ?? String(error) };
  }
}

/**
 * Rewinds one agent and delivers the resume brief into the fresh timeline in
 * a single DaemonClient session (same tab, same id, same labels). The brief
 * goes through sendMessage with an explicit messageId and WITHOUT a caller
 * agent id, so it arrives as user_message and the next refresh rewinds to
 * exactly that brief. Fail-soft status, never a throw for daemon failures:
 * - { status: 'rewound', messageId, briefMessageId }: rewind and brief both
 *   landed; the caller records both ids.
 * - { status: 'rewound', messageId, briefMessageId: null, sendError }: the
 *   rewind landed but the brief did not; the caller records the rewind and
 *   reports the delivery error (resend manually), like a failed fresh send.
 * - { status: 'rewound', messageId, briefMessageId: null }: with `skipBrief`
 *   the rewind landed and no brief was attempted (stage-only: the caller
 *   stages the packet itself, e.g. into the composer or for later delivery).
 * - { status: 'no-point' | 'unsupported' | 'unavailable', error? }: nothing
 *   was sent; the caller falls back to a new parent-free agent.
 * - { status: 'failed', error }: the rewind point exists but the rewind call
 *   failed; nothing was sent, and the caller must abort without side effects
 *   (no record, no new agent).
 */
export async function rewindAndBrief(agentId, briefText, { url = null, cliPath = null, createClient = defaultCreateRewindClient, messageId: briefId = null, previousBriefId = null, skipBrief = false, beforeRewind = null } = {}) {
  if (typeof agentId !== 'string' || !agentId) return { status: 'failed', error: 'missing agent id' };
  if (skipBrief !== true && (typeof briefText !== 'string' || !briefText.trim())) return { status: 'failed', error: 'missing brief text' };
  try {
    return await useRewindClient({ url, cliPath, createClient }, async (client) => {
      const outcome = await rewindOnClient(client, agentId, { previousBriefId, beforeRewind });
      if (outcome.status !== 'rewound') return outcome;
      const { messageId } = outcome;
      if (skipBrief === true) return { status: 'rewound', messageId, briefMessageId: null };
      const send = client.sendMessage ?? client.sendAgentMessage;
      const briefMessageId = typeof briefId === 'string' && briefId ? briefId : randomUUID();
      if (typeof send !== 'function') {
        return { status: 'rewound', messageId, briefMessageId: null, sendError: 'daemon has no sendMessage' };
      }
      try {
        // No sourceAgentId: with a caller id the brief would arrive as a
        // tool_call and the next refresh could not rewind to it.
        await send.call(client, agentId, briefText, { messageId: briefMessageId });
      } catch (error) {
        return { status: 'rewound', messageId, briefMessageId: null, sendError: error?.message ?? String(error) };
      }
      return { status: 'rewound', messageId, briefMessageId };
    });
  } catch (error) {
    return { status: 'unavailable', error: error?.message ?? String(error) };
  }
}

/**
 * Delivers one brief through the rewind transport so it arrives as a real
 * user_message (no caller agent id — a caller id would make it a tool_call
 * and the next refresh could not rewind to it). Returns true when the brief
 * was sent, false when the client has no send transport (the caller falls
 * back to the high-level send); connect and send failures throw, like a
 * direct send would.
 */
export async function sendUserBrief(agentId, briefText, { url = null, cliPath = null, createClient = defaultCreateRewindClient, messageId = null } = {}) {
  if (typeof agentId !== 'string' || !agentId) throw new Error('sendUserBrief needs an agent id');
  if (typeof briefText !== 'string' || !briefText.trim()) throw new Error('sendUserBrief needs brief text');
  return useRewindClient({ url, cliPath, createClient }, async (client) => {
    const send = client.sendMessage ?? client.sendAgentMessage;
    if (typeof send !== 'function') return false;
    const options = typeof messageId === 'string' && messageId ? { messageId } : {};
    await send.call(client, agentId, briefText, options);
    return true;
  });
}
