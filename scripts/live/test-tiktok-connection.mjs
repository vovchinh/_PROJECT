import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizeTikTokUsername } from '../../src/lib/tiktok-username.js';

const providerRequire = createRequire(
  new URL('../../services/live-bridge/package.json', import.meta.url),
);
const codes = new Set([
  'TIKTOK_USER_INVALID',
  'TIKTOK_NOT_LIVE',
  'TIKTOK_ROOM_LOOKUP_FAILED',
  'TIKTOK_CONNECT_TIMEOUT',
  'TIKTOK_WEBSOCKET_FAILED',
  'TIKTOK_PROVIDER_RATE_LIMITED',
  'TIKTOK_SIGNING_REQUIRED',
  'TIKTOK_PROVIDER_ACCESS_DENIED',
  'TIKTOK_PROVIDER_UNAVAILABLE',
  'TIKTOK_PROVIDER_PROTOCOL_CHANGED',
  'TIKTOK_PROVIDER_VERSION_MISMATCH',
  'TIKTOK_PROVIDER_PACKAGE_MISSING',
  'TIKTOK_ROOM_CHANGED',
]);
const error = (code) => Object.assign(Error(code), { code });

// Return only allowlisted codes. Provider errors can contain response bodies,
// cookies or signing URLs, so messages/stacks are never returned to the caller.
export function classifyProviderError(failure, stage = 'provider') {
  if (codes.has(failure?.code)) return failure.code;
  const nested = failure?.config?.requestErrs;
  if (Array.isArray(nested)) {
    const classified = nested.slice(0, 10).map((entry) =>
      classifyProviderError(
        {
          name: entry?.name,
          constructor: { name: entry?.constructor?.name },
          code: entry?.code,
          reason: entry?.reason,
          statusCode: entry?.statusCode,
          status: entry?.status,
          response: { statusCode: entry?.response?.statusCode, status: entry?.response?.status },
        },
        stage,
      ),
    );
    for (const preferred of [
      'TIKTOK_PROVIDER_RATE_LIMITED',
      'TIKTOK_SIGNING_REQUIRED',
      'TIKTOK_CONNECT_TIMEOUT',
    ])
      if (classified.includes(preferred)) return preferred;
  }
  const name = `${failure?.name || ''} ${failure?.constructor?.name || ''}`;
  const status =
    failure?.statusCode ??
    failure?.response?.statusCode ??
    failure?.response?.status ??
    failure?.status;
  if (/UserOfflineError/u.test(name)) return 'TIKTOK_NOT_LIVE';
  if (/InvalidUniqueIdError/u.test(name)) return 'TIKTOK_USER_INVALID';
  if (status === 429 || /SignatureRateLimitError/u.test(name) || failure?.reason === 'Rate Limited')
    return 'TIKTOK_PROVIDER_RATE_LIMITED';
  if (
    /PremiumFeatureError|SignatureMissingTokensError|AuthenticatedWebSocketConnectionError/u.test(
      name,
    )
  )
    return 'TIKTOK_SIGNING_REQUIRED';
  if ([401, 402, 403].includes(status)) return 'TIKTOK_PROVIDER_ACCESS_DENIED';
  if (
    /Timeout|AbortError/u.test(name) ||
    ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'ABORT_ERR'].includes(failure?.code)
  )
    return 'TIKTOK_CONNECT_TIMEOUT';
  if (/SchemaDecodeError|InvalidSchemaNameError/u.test(name))
    return 'TIKTOK_PROVIDER_PROTOCOL_CHANGED';
  if (['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'].includes(failure?.code))
    return 'TIKTOK_PROVIDER_PACKAGE_MISSING';
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET'].includes(failure?.code))
    return 'TIKTOK_PROVIDER_UNAVAILABLE';
  return stage === 'websocket_connect'
    ? 'TIKTOK_WEBSOCKET_FAILED'
    : ['is_live_lookup', 'room_lookup'].includes(stage)
      ? 'TIKTOK_ROOM_LOOKUP_FAILED'
      : 'TIKTOK_PROVIDER_UNAVAILABLE';
}

export function inspectV3Event(type, data) {
  const exactId = (value) => typeof value === 'string' && /^[1-9][0-9]{0,19}$/u.test(value);
  if (type === 'chat')
    return {
      valid:
        exactId(data?.common?.msgId) &&
        exactId(data?.user?.id) &&
        typeof data?.content === 'string' &&
        Boolean(data.content.trim()),
    };
  if (type === 'member') return { valid: exactId(data?.user?.id) };
  if (type === 'viewer') {
    // Installed v3 uses total for concurrent viewers. totalUser is a different
    // cumulative metric; do not substitute it or the legacy viewerCount key.
    if (typeof data?.total !== 'string' || !/^(0|[1-9][0-9]{0,15})$/u.test(data.total))
      return { valid: false };
    const count = BigInt(data.total);
    if (count > BigInt(Number.MAX_SAFE_INTEGER)) return { valid: false };
    return { valid: true, count: Number(count) };
  }
  return { valid: false };
}

async function installedProvider() {
  const metadata = JSON.parse(
    await readFile(providerRequire.resolve('tiktok-live-connector/package.json'), 'utf8'),
  );
  if (metadata.version !== '2.5.0') throw error('TIKTOK_PROVIDER_VERSION_MISMATCH');
  return {
    version: metadata.version,
    module: await import(pathToFileURL(providerRequire.resolve('tiktok-live-connector')).href),
  };
}

// Developer-only read test. No Supabase client, comments/tokens in output,
// posts, gifts, business mutation or raw provider payload persistence.
export async function runTikTokSmoke(input, dependencies = {}) {
  const now = dependencies.now || Date.now;
  const overallMs = input.overallMs ?? 40000;
  const stageMs = input.stageMs ?? 12000;
  const observeMs = input.observeMs ?? 5000;
  if (
    ![overallMs, stageMs, observeMs].every((n) => Number.isInteger(n) && n > 0) ||
    overallMs > 40000 ||
    stageMs > 15000 ||
    observeMs > 10000
  )
    throw error('TIKTOK_CONNECT_TIMEOUT');
  const startedAt = now(),
    deadline = startedAt + overallMs;
  const result = {
    checked_at: new Date(startedAt).toISOString(),
    status: 'BLOCKED',
    provider: 'tiktok-live-connector',
    provider_version: null,
    process_initial_data: false,
    normalized_username: null,
    is_live: null,
    room_resolved: false,
    room_matches: null,
    connected: false,
    first_comment_observed: false,
    first_viewer_event_observed: false,
    valid_comment_count: 0,
    valid_viewer_event_count: 0,
    valid_member_event_count: 0,
    invalid_event_count: 0,
    current_viewer_count: null,
    peak_viewer_count: null,
    stream_ended: false,
    disconnected: false,
    disconnect_complete: false,
    error_code: null,
    stages: [],
    duration_ms: 0,
  };
  let connection,
    ended = false,
    closed = false,
    providerFailure = null,
    finished = false,
    interrupted;
  const interruption = new Promise((done) => {
    interrupted = done;
  });
  const activeTimers = new Set();
  const bounded = (operation, milliseconds) => {
    let timer;
    const running = Promise.resolve().then(operation);
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(error('TIKTOK_CONNECT_TIMEOUT')), Math.max(1, milliseconds));
      activeTimers.add(timer);
    });
    return Promise.race([running, timeout]).finally(() => {
      clearTimeout(timer);
      activeTimers.delete(timer);
    });
  };
  const stage = async (name, operation, maximum = stageMs) => {
    const started = now();
    try {
      if (now() >= deadline - 2000) throw error('TIKTOK_CONNECT_TIMEOUT');
      const value = await bounded(operation, Math.min(maximum, deadline - now() - 2000));
      result.stages.push({ stage: name, status: 'ok', duration_ms: Math.max(0, now() - started) });
      return value;
    } catch (failure) {
      const code = classifyProviderError(failure, name);
      result.stages.push({
        stage: name,
        status: code === 'TIKTOK_CONNECT_TIMEOUT' ? 'timeout' : 'error',
        error_code: code,
        duration_ms: Math.max(0, now() - started),
      });
      throw error(code);
    }
  };
  const cleanup = () =>
    connection
      ? bounded(() => connection.disconnect(), Math.min(2000, Math.max(1, deadline - now())))
      : Promise.resolve();
  try {
    result.normalized_username = normalizeTikTokUsername(input.username);
    const loaded = await stage('provider_init', dependencies.loadProvider || installedProvider);
    if (loaded.version !== '2.5.0') throw error('TIKTOK_PROVIDER_VERSION_MISMATCH');
    result.provider_version = loaded.version;
    const { TikTokLiveConnection, WebcastEvent, ControlEvent } = loaded.module;
    connection = new TikTokLiveConnection(result.normalized_username, {
      processInitialData: false,
      authenticateWs: false,
      enableExtendedGiftInfo: false,
      webClientOptions: { retry: { limit: 0 } },
    });
    connection.on(ControlEvent.ERROR, (value) => {
      providerFailure = value?.exception || value;
      interrupted();
    });
    connection.on(ControlEvent.DISCONNECTED, () => {
      closed = true;
      result.disconnected = true;
      interrupted();
    });
    connection.on(WebcastEvent.STREAM_END, () => {
      ended = true;
      result.stream_ended = true;
      interrupted();
    });
    const receive = (type) => (data) => {
      if (finished) return;
      const check = inspectV3Event(type, data);
      if (!check.valid) {
        result.invalid_event_count++;
        return;
      }
      if (type === 'chat') {
        result.valid_comment_count++;
        result.first_comment_observed = true;
      }
      if (type === 'member') result.valid_member_event_count++;
      if (type === 'viewer') {
        result.valid_viewer_event_count++;
        result.first_viewer_event_observed = true;
        result.current_viewer_count = check.count;
        result.peak_viewer_count =
          result.peak_viewer_count === null
            ? check.count
            : Math.max(result.peak_viewer_count, check.count);
      }
    };
    connection.on(WebcastEvent.CHAT, receive('chat'));
    connection.on(WebcastEvent.ROOM_USER, receive('viewer'));
    connection.on(WebcastEvent.MEMBER, receive('member'));
    const isLive = await stage('is_live_lookup', () => connection.fetchIsLive());
    if (typeof isLive !== 'boolean') throw error('TIKTOK_PROVIDER_PROTOCOL_CHANGED');
    result.is_live = isLive;
    if (!isLive) throw error('TIKTOK_NOT_LIVE');
    const roomId = await stage('room_lookup', () => connection.fetchRoomId());
    if (typeof roomId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/u.test(roomId))
      throw error('TIKTOK_PROVIDER_PROTOCOL_CHANGED');
    result.room_resolved = true;
    const state = await stage('websocket_connect', () => {
      const pending = Promise.resolve().then(() => connection.connect(roomId));
      pending.then(
        () => {
          if (finished) void cleanup().catch(() => {});
        },
        () => {},
      );
      return Promise.race([
        pending,
        interruption.then(() => {
          if (providerFailure) throw providerFailure;
          throw error(ended ? 'TIKTOK_NOT_LIVE' : 'TIKTOK_WEBSOCKET_FAILED');
        }),
      ]);
    });
    result.room_matches = state?.roomId === roomId;
    if (!result.room_matches) throw error('TIKTOK_ROOM_CHANGED');
    if (providerFailure) throw providerFailure;
    if (closed || ended) throw error(ended ? 'TIKTOK_NOT_LIVE' : 'TIKTOK_WEBSOCKET_FAILED');
    result.connected = true;
    const observing = now();
    let observationTimer;
    try {
      await Promise.race([
        interruption,
        new Promise((done) => {
          observationTimer = setTimeout(
            done,
            Math.max(1, Math.min(observeMs, deadline - now() - 2000)),
          );
          activeTimers.add(observationTimer);
        }),
      ]);
    } finally {
      clearTimeout(observationTimer);
      activeTimers.delete(observationTimer);
    }
    result.stages.push({
      stage: 'observe_events',
      status: 'ok',
      duration_ms: Math.max(0, now() - observing),
    });
    if (providerFailure) throw providerFailure;
    if (closed && !ended) throw error('TIKTOK_WEBSOCKET_FAILED');
    result.status = 'PASS';
  } catch (failure) {
    result.error_code = classifyProviderError(failure);
  } finally {
    finished = true;
    const disconnectStarted = now();
    try {
      await cleanup();
      result.disconnect_complete = true;
      result.stages.push({
        stage: 'disconnect',
        status: 'ok',
        duration_ms: Math.max(0, now() - disconnectStarted),
      });
    } catch {
      result.stages.push({
        stage: 'disconnect',
        status: 'timeout',
        error_code: 'TIKTOK_CONNECT_TIMEOUT',
        duration_ms: Math.max(0, now() - disconnectStarted),
      });
      result.status = 'BLOCKED';
      result.error_code ||= 'TIKTOK_CONNECT_TIMEOUT';
    }
    for (const timer of activeTimers) clearTimeout(timer);
    result.duration_ms = Math.max(0, now() - startedAt);
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  delete process.env.DEBUG_DESERIALIZE_XD;
  process.env.DISABLE_ACK_LOG_WARNING = '1';
  // Optional dependency debug paths can print raw packets. This one-off process
  // emits only its structured report, regardless of inherited debug variables.
  let suppressedLogs = 0;
  for (const name of ['log', 'warn', 'error'])
    console[name] = () => {
      suppressedLogs++;
    };
  const args = process.argv.slice(2);
  const numberArg = (name, fallback) =>
    args.includes(name) ? Number(args[args.indexOf(name) + 1]) : fallback;
  const username = args.includes('--username') ? args[args.indexOf('--username') + 1] : args[0];
  // A third-party promise may keep an internal socket alive after cancellation.
  // This standalone smoke process always exits; production listener is separate.
  const watchdog = setTimeout(() => {
    process.stdout.write(
      JSON.stringify({
        status: 'BLOCKED',
        error_code: 'TIKTOK_CONNECT_TIMEOUT',
        stage: 'process_deadline',
      }) + '\n',
      () => process.exit(2),
    );
  }, 40000);
  runTikTokSmoke({
    username,
    overallMs: numberArg('--overall-ms', 38000),
    observeMs: numberArg('--observe-ms', 5000),
  })
    .then((result) => {
      clearTimeout(watchdog);
      result.provider_logs_suppressed = suppressedLogs;
      process.stdout.write(JSON.stringify(result, null, 2) + '\n', () =>
        process.exit(result.status === 'PASS' ? 0 : 2),
      );
    })
    .catch(() => {
      clearTimeout(watchdog);
      process.stdout.write(
        JSON.stringify({ status: 'BLOCKED', error_code: 'TIKTOK_PROVIDER_UNAVAILABLE' }) + '\n',
        () => process.exit(2),
      );
    });
}
