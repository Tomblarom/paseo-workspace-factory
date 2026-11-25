// @ts-nocheck
// GENERATED from src/rewind.mjs by npm run plugin:sync. Do not edit.
// Same-tab refresh via Paseo rewind (fresh --slot/--worker, auto-cleanup).
// Rewinds the agent's conversation to its first user message instead of
// creating a new agent: DaemonClient.rewindAgent(agentId, firstUserMessageId,
// 'conversation'), where the message id comes from fetchAgentTimeline(id,
// { limit: 0, projection: 'canonical' }). Agents driven only via `send` have
// no user_message with a messageId and therefore no rewind point: callers fall
// back to a new parent-free agent. Providers without rewind support answer the
// rewind call with an unsupported error: callers fall back as well.
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
import { daemonPassword, paseoBinary } from './paseo.js';
import { runtime } from './runtime.js';

/**
 * First user_message messageId of a timeline payload, or null. Tolerant:
 * rows live under entries/rows/items, each row wraps its item, and only
 * user_message rows with a non-empty string messageId count. Agents driven
 * only via `send` have none.
 */
export function firstRewindPoint(timelinePayload) {
  return selectRewindPoint(timelinePayload, null);
}

function selectRewindPoint(timelinePayload, previousBriefId) {
  const rows = timelinePayload?.entries ?? timelinePayload?.rows ?? timelinePayload?.items ?? [];
  if (!Array.isArray(rows)) return null;
  let first = null;
  for (const row of rows) {
    const item = row?.item ?? row;
    if (!item || typeof item !== 'object') continue;
    if (item.type !== 'user_message') continue;
    const id = item.messageId;
    if (typeof id !== 'string' || !id) continue;
    if (id === previousBriefId) return id;
    first ??= id;
    if (!previousBriefId) break;
  }
  return first;
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

/** True when a rewind error means "this provider has no rewind": fall back to a new agent. */
export function isRewindUnsupportedError(error) {
  const text = String(error?.message ?? error ?? '');
  return /not supported|unsupported|unknown method|not implemented|no rewind/i.test(text);
}

/**
 * Best-effort read of the first rewind point. Returns the messageId string, or
 * null on any failure (no daemon, no timeline, no user message). Never throws
 * for daemon failures; production callers treat null as "new agent".
 */
export async function readRewindPoint(agentId, { url = null, cliPath = null, createClient = defaultCreateRewindClient, previousBriefId = null } = {}) {
  if (typeof agentId !== 'string' || !agentId) return null;
  let client = null;
  try {
    const target = url ?? runtime().paseo.url;
    const bin = cliPath ?? paseoBinary();
    client = await createClient({ url: target, cliPath: bin });
    const timeline = await client.fetchAgentTimeline(agentId, { limit: 0, projection: 'canonical' });
    return selectRewindPoint(timeline, previousBriefId);
  } catch {
    return null;
  } finally {
    await client?.close?.().catch(() => {});
  }
}

/**
 * Rewinds one agent's conversation to its first user message (same tab, same
 * id, same labels). Fail-soft status, never a throw for daemon failures:
 * - { status: 'rewound', messageId }: the context is empty, send the brief next.
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
export async function rewindSameTab(agentId, { url = null, cliPath = null, createClient = defaultCreateRewindClient } = {}) {
  if (typeof agentId !== 'string' || !agentId) return { status: 'failed', error: 'missing agent id' };
  let client = null;
  try {
    const target = url ?? runtime().paseo.url;
    const bin = cliPath ?? paseoBinary();
    try {
      client = await createClient({ url: target, cliPath: bin });
    } catch (error) {
      return { status: 'unavailable', error: error?.message ?? String(error) };
    }
    let timeline;
    try {
      timeline = await client.fetchAgentTimeline(agentId, { limit: 0, projection: 'canonical' });
    } catch (error) {
      return { status: 'unavailable', error: error?.message ?? String(error) };
    }
    const messageId = firstRewindPoint(timeline);
    if (!messageId) return { status: 'no-point' };
    if (typeof client.rewindAgent !== 'function') return { status: 'unsupported', error: 'daemon has no rewindAgent' };
    try {
      await client.rewindAgent(agentId, messageId, 'conversation');
    } catch (error) {
      if (isRewindUnsupportedError(error)) return { status: 'unsupported', error: error?.message ?? String(error) };
      return { status: 'failed', error: error?.message ?? String(error) };
    }
    return { status: 'rewound', messageId };
  } finally {
    await client?.close?.().catch(() => {});
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
 * - { status: 'no-point' | 'unsupported' | 'unavailable', error? }: nothing
 *   was sent; the caller falls back to a new parent-free agent.
 * - { status: 'failed', error }: the rewind point exists but the rewind call
 *   failed; nothing was sent, and the caller must abort without side effects
 *   (no record, no new agent).
 */
export async function rewindAndBrief(agentId, briefText, { url = null, cliPath = null, createClient = defaultCreateRewindClient, messageId: briefId = null, previousBriefId = null } = {}) {
  if (typeof agentId !== 'string' || !agentId) return { status: 'failed', error: 'missing agent id' };
  if (typeof briefText !== 'string' || !briefText.trim()) return { status: 'failed', error: 'missing brief text' };
  let client = null;
  try {
    const target = url ?? runtime().paseo.url;
    const bin = cliPath ?? paseoBinary();
    try {
      client = await createClient({ url: target, cliPath: bin });
    } catch (error) {
      return { status: 'unavailable', error: error?.message ?? String(error) };
    }
    let timeline;
    try {
      timeline = await client.fetchAgentTimeline(agentId, { limit: 0, projection: 'canonical' });
    } catch (error) {
      return { status: 'unavailable', error: error?.message ?? String(error) };
    }
    const messageId = selectRewindPoint(timeline, previousBriefId);
    if (!messageId) return { status: 'no-point' };
    if (typeof client.rewindAgent !== 'function') return { status: 'unsupported', error: 'daemon has no rewindAgent' };
    try {
      await client.rewindAgent(agentId, messageId, 'conversation');
    } catch (error) {
      if (isRewindUnsupportedError(error)) return { status: 'unsupported', error: error?.message ?? String(error) };
      return { status: 'failed', error: error?.message ?? String(error) };
    }
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
  } finally {
    await client?.close?.().catch(() => {});
  }
}
