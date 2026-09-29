import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { atomicJson, serialized } from './storage.mjs';
import { normalizeTikTokUsername } from '../../src/lib/tiktok-username.js';

const error = (code) => Object.assign(new Error(code), { code });
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// One local worker per workspace/session prevents two processes overwriting the
// same durable queue. The loopback-only guard releases automatically on crash.
export async function acquireWorkerSlot(workspaceId, sessionId) {
  const digest = createHash('sha256')
    .update(`${workspaceId.toLowerCase()}:${sessionId.toLowerCase()}`)
    .digest();
  const port = 49152 + (digest.readUInt16BE(0) % 16384);
  const server = createServer((socket) => socket.destroy());
  await new Promise((done, reject) => {
    server.once('error', () => reject(error('WORKER_SLOT_BUSY')));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, done);
  });
  let closed = false;
  return {
    port,
    close: () => {
      if (closed) return Promise.resolve();
      closed = true;
      return new Promise((done) => server.close(done));
    },
  };
}
function string(value, max, field) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u001F\u007F]/u.test(value)
  )
    throw error(`INVALID_${field}`);
  return value;
}
export function normalizeComment(value, now = Date.now()) {
  if (!value || typeof value !== 'object') throw error('INVALID_COMMENT');
  const time = string(value.occurred_at, 80, 'TIME');
  if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(time)) throw error('INVALID_TIME');
  const milliseconds = new Date(time).getTime();
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds < Date.UTC(1900, 0, 1) ||
    milliseconds > now + 300000
  )
    throw error('INVALID_TIME');
  return {
    message_id: string(value.message_id, 200, 'MESSAGE_ID'),
    author_external_id: string(value.author_external_id, 200, 'AUTHOR_ID'),
    author_display_name: string(value.author_display_name, 200, 'DISPLAY_NAME'),
    text: string(value.text, 2000, 'TEXT'),
    occurred_at: new Date(milliseconds).toISOString(),
  };
}
export function providerAlias(primary, legacy, field) {
  if (primary != null && legacy != null && primary !== legacy)
    throw error(`PROVIDER_${field}_CONFLICT`);
  return primary ?? legacy;
}
export function providerTime(data, now = Date.now()) {
  const rawTime = providerAlias(data?.common?.createTime, data?.createTime, 'TIME');
  let milliseconds = now;
  if (rawTime != null) {
    if (
      (typeof rawTime === 'number' && !Number.isSafeInteger(rawTime)) ||
      !['number', 'string'].includes(typeof rawTime) ||
      !/^\d{1,20}$/u.test(String(rawTime))
    )
      throw error('INVALID_PROVIDER_TIME');
    const value = BigInt(rawTime);
    milliseconds = Number(value < 1000000000000n ? value * 1000n : value);
    if (!Number.isSafeInteger(milliseconds) || !Number.isFinite(new Date(milliseconds).getTime()))
      throw error('INVALID_PROVIDER_TIME');
  }
  return new Date(milliseconds).toISOString();
}
export function normalizeTikTokComment(data, now = Date.now()) {
  return normalizeComment(
    {
      message_id: providerAlias(data?.common?.msgId, data?.msgId, 'MESSAGE_ID'),
      author_external_id: providerAlias(data?.user?.id, data?.user?.userId, 'AUTHOR_ID'),
      author_display_name: data?.user?.nickname || data?.user?.displayId || data?.user?.uniqueId,
      text: providerAlias(data?.content, data?.comment, 'TEXT'),
      occurred_at: providerTime(data, now),
    },
    now,
  );
}

export class CommentQueue {
  constructor({
    file,
    workspaceId,
    sessionId,
    maxPending = 2000,
    normalize = normalizeComment,
    key = 'message_id',
    kind = null,
  }) {
    this.file = file;
    this.workspaceId = workspaceId;
    this.sessionId = sessionId;
    this.maxPending = maxPending;
    this.items = new Map();
    this.serialize = serialized();
    this.normalize = normalize;
    this.keyOf = typeof key === 'function' ? key : (row) => row[key];
    this.kind = kind;
  }
  async init() {
    let raw;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (failure) {
      if (failure.code !== 'ENOENT') throw failure;
      return this;
    }
    if (raw.length > 12000000) throw error('QUEUE_FILE_LIMIT');
    const saved = JSON.parse(raw);
    if (
      saved.version !== 1 ||
      saved.workspace_id !== this.workspaceId ||
      saved.session_id !== this.sessionId ||
      !Array.isArray(saved.items)
    )
      throw error('QUEUE_SCOPE_MISMATCH');
    if ((saved.kind || null) !== this.kind) throw error('QUEUE_SCOPE_MISMATCH');
    for (const value of saved.items) {
      const comment = this.normalize(value);
      if (this.items.has(this.keyOf(comment))) throw error('QUEUE_DUPLICATE_RECORD');
      this.items.set(this.keyOf(comment), comment);
    }
    if (this.items.size > this.maxPending) throw error('QUEUE_FULL');
    return this;
  }
  persist(items) {
    return atomicJson(this.file, {
      version: 1,
      workspace_id: this.workspaceId,
      session_id: this.sessionId,
      ...(this.kind ? { kind: this.kind } : {}),
      items: [...items.values()],
    });
  }
  enqueue(value) {
    const comment = this.normalize(value);
    return this.serialize(async () => {
      const old = this.items.get(this.keyOf(comment));
      if (old) {
        if (hash(old) !== hash(comment)) throw error('QUEUE_MESSAGE_CONFLICT');
        return { duplicate: true };
      }
      if (this.items.size >= this.maxPending) throw error('QUEUE_FULL');
      const next = new Map(this.items);
      next.set(this.keyOf(comment), comment);
      await this.persist(next);
      this.items = next;
      return { duplicate: false };
    });
  }
  peek(limit = 100) {
    return [...this.items.values()].slice(0, Math.min(100, limit)).map((value) => ({ ...value }));
  }
  ack(batch) {
    return this.serialize(async () => {
      const next = new Map(this.items);
      for (const comment of batch) {
        const old = next.get(this.keyOf(comment));
        if (!old || hash(old) !== hash(comment)) throw error('QUEUE_ACK_MISMATCH');
        next.delete(this.keyOf(comment));
      }
      await this.persist(next);
      this.items = next;
    });
  }
  get pending() {
    return this.items.size;
  }
}

function tokenRole(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString()).role;
  } catch {
    return '';
  }
}
export function createOperatorClient({
  url,
  publishableKey,
  accessToken,
  refreshToken = '',
  fetchImpl = fetch,
}) {
  const base = new URL(url);
  if (
    base.protocol !== 'https:' ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !['', '/'].includes(base.pathname)
  )
    throw error('SUPABASE_URL_INVALID');
  if (
    !(
      publishableKey?.startsWith('sb_publishable_') || tokenRole(publishableKey || '') === 'anon'
    ) ||
    publishableKey.startsWith('sb_secret_')
  )
    throw error('PUBLISHABLE_KEY_REQUIRED');
  if (
    !accessToken ||
    tokenRole(accessToken) === 'service_role' ||
    accessToken.startsWith('sb_secret_')
  )
    throw error('OPERATOR_SESSION_REQUIRED');
  let currentAccess = accessToken;
  let currentRefresh = refreshToken;
  let refreshing;
  async function refresh() {
    if (!currentRefresh) throw error('OPERATOR_REAUTH_REQUIRED');
    if (!refreshing)
      refreshing = (async () => {
        const response = await fetchImpl(`${base.origin}/auth/v1/token?grant_type=refresh_token`, {
          method: 'POST',
          headers: { apikey: publishableKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: currentRefresh }),
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw error('OPERATOR_REAUTH_REQUIRED');
        const result = await response.json();
        if (!result.access_token || !result.refresh_token) throw error('OPERATOR_REAUTH_REQUIRED');
        currentAccess = result.access_token;
        currentRefresh = result.refresh_token;
      })().finally(() => {
        refreshing = undefined;
      });
    return refreshing;
  }
  return {
    async rpc(name, args) {
      if (
        ![
          'get_live_intake',
          'get_live_operations',
          'ingest_live_comments',
          'report_live_connection',
          'get_tiktok_channels',
          'claim_tiktok_connection',
          'report_tiktok_connection',
          'ingest_tiktok_comments',
          'finish_tiktok_live',
          'ingest_live_events',
          'ingest_tiktok_events',
          'report_live_listener_health',
        ].includes(name)
      )
        throw error('WORKER_RPC_NOT_ALLOWED');
      for (let attempt = 0; attempt < 2; attempt++) {
        let response;
        try {
          response = await fetchImpl(`${base.origin}/rest/v1/rpc/${name}`, {
            method: 'POST',
            headers: {
              apikey: publishableKey,
              Authorization: `Bearer ${currentAccess}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(args),
            redirect: 'error',
            signal: AbortSignal.timeout(15000),
          });
        } catch {
          throw error('RPC_TRANSPORT_UNKNOWN');
        }
        if (response.status === 401 && attempt === 0 && currentRefresh) {
          await refresh();
          continue;
        }
        if (!response.ok)
          throw error(
            response.status === 401
              ? 'OPERATOR_REAUTH_REQUIRED'
              : `RPC_REJECTED_${response.status}`,
          );
        return response.json();
      }
      throw error('OPERATOR_REAUTH_REQUIRED');
    },
  };
}

export async function flushQueue(queue, client) {
  const batch = queue.peek(100);
  if (!batch.length) return { inserted: 0, duplicates: 0 };
  const result = await client.rpc('ingest_live_comments', {
    p_workspace_id: queue.workspaceId,
    p_session_id: queue.sessionId,
    p_comments: batch,
  });
  if (
    !Number.isInteger(result?.inserted) ||
    !Number.isInteger(result?.duplicates) ||
    result.inserted < 0 ||
    result.duplicates < 0 ||
    result.inserted + result.duplicates !== batch.length
  )
    throw error('INGEST_ACK_INVALID');
  await queue.ack(batch);
  return result;
}

export async function sessionConfiguration(client, workspaceId, sessionId, source) {
  const state = await client.rpc('get_live_intake', {
    p_workspace_id: workspaceId,
    p_session_id: sessionId,
  });
  const session = state.sessions?.find((row) => row.id === sessionId);
  const campaign = state.campaigns?.find((row) => row.id === session?.campaign_id);
  if (!session || session.status !== 'live' || campaign?.status !== 'active')
    throw error('SESSION_NOT_LIVE');
  if (source === 'ndjson') {
    if (!['manual', 'simulator'].includes(session.provider))
      throw error('SIMULATOR_REQUIRES_NON_TIKTOK_SESSION');
    return { session, campaign };
  }
  const account = state.integration_accounts?.find(
    (row) => row.id === session.integration_account_id,
  );
  let username;
  try {
    username = normalizeTikTokUsername(account?.username);
  } catch {
    throw error('TIKTOK_PROFILE_MISMATCH');
  }
  if (
    source !== 'tiktok' ||
    session.provider !== 'tiktok_live' ||
    account?.enabled !== true ||
    username !== account.username ||
    session.room_id !== username
  )
    throw error('TIKTOK_PROFILE_MISMATCH');
  return { session, campaign, username };
}
