export const providerCodes = new Set([
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
  'TIKTOK_SESSION_CONFLICT',
  'TIKTOK_INGEST_FAILED',
  'TIKTOK_SUPABASE_UNAVAILABLE',
]);
export function providerErrorCode(value, stage = 'provider') {
  if (providerCodes.has(value?.code)) return value.code;
  const failure = value?.exception || value;
  if (providerCodes.has(failure?.code)) return failure.code;
  const name = `${failure?.name || ''} ${failure?.constructor?.name || ''}`;
  const status = failure?.statusCode ?? failure?.response?.statusCode ?? failure?.response?.status;
  if (/UserOffline/u.test(name)) return 'TIKTOK_NOT_LIVE';
  if (/InvalidUniqueId/u.test(name)) return 'TIKTOK_USER_INVALID';
  if (status === 429 || /SignatureRateLimit/u.test(name)) return 'TIKTOK_PROVIDER_RATE_LIMITED';
  if (/PremiumFeature|SignatureMissingTokens|AuthenticatedWebSocketConnection/u.test(name))
    return 'TIKTOK_SIGNING_REQUIRED';
  if ([401, 402, 403].includes(status)) return 'TIKTOK_PROVIDER_ACCESS_DENIED';
  if (
    /Timeout|AbortError/u.test(name) ||
    ['ETIMEDOUT', 'ABORT_ERR', 'UND_ERR_CONNECT_TIMEOUT'].includes(failure?.code)
  )
    return 'TIKTOK_CONNECT_TIMEOUT';
  if (/SchemaDecode|InvalidSchemaName/u.test(name)) return 'TIKTOK_PROVIDER_PROTOCOL_CHANGED';
  if (['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'].includes(failure?.code))
    return 'TIKTOK_PROVIDER_PACKAGE_MISSING';
  return stage === 'websocket_connect'
    ? 'TIKTOK_WEBSOCKET_FAILED'
    : ['is_live_lookup', 'room_lookup'].includes(stage)
      ? 'TIKTOK_ROOM_LOOKUP_FAILED'
      : 'TIKTOK_PROVIDER_UNAVAILABLE';
}
export function safeProviderError(value, stage, message) {
  const code = providerErrorCode(value, stage);
  return Object.assign(Error(message || code), { code, stage });
}
export function boundedProvider(operation, { timeoutMs = 30000, signal, onLateResolve } = {}) {
  let timer,
    aborted,
    finished = false,
    cancelled = false;
  const pending = Promise.resolve().then(() => {
    if (signal?.aborted) throw Object.assign(Error('PROVIDER_CANCELLED'), { code: 'ABORT_ERR' });
    return operation();
  });
  pending.then(
    (value) => {
      if (cancelled)
        Promise.resolve()
          .then(() => onLateResolve?.(value))
          .catch(() => {});
    },
    () => {},
  );
  return Promise.race([
    pending,
    new Promise((_, reject) => {
      const rejectTimeout = () => {
        cancelled = true;
        reject(Object.assign(Error('TIKTOK_CONNECT_TIMEOUT'), { code: 'TIKTOK_CONNECT_TIMEOUT' }));
      };
      timer = setTimeout(rejectTimeout, Math.max(1, timeoutMs));
      aborted = () => {
        if (!finished) {
          cancelled = true;
          reject(Object.assign(Error('PROVIDER_CANCELLED'), { code: 'ABORT_ERR' }));
        }
      };
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted();
    }),
  ]).finally(() => {
    finished = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', aborted);
  });
}
export async function closeProvider(connection, timeoutMs = 2000) {
  try {
    await boundedProvider(() => connection.disconnect(), { timeoutMs });
  } catch {
    /* A timed-out transport still must be terminated. */
  }
  try {
    connection.wsClient?.terminate?.();
  } catch {
    /* Already closed. */
  }
}
