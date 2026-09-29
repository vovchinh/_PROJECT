// Provider boundary: only an actual successful room connection can establish
// LIVE. A handle, saved profile or button click is never evidence of a room.
import { normalizeTikTokUsername } from '../../src/lib/tiktok-username.js';
import { boundedProvider, closeProvider, safeProviderError } from './provider-safety.mjs';
export function validTikTokUsername(value) {
  try {
    return normalizeTikTokUsername(value) === value;
  } catch {
    return false;
  }
}
export async function probeTikTokChannel(username, options = {}) {
  username = normalizeTikTokUsername(username);
  const deadline = Date.now() + (options.timeoutMs || 30000);
  let stage = 'provider_init';
  const run = async (name, operation, onLateResolve) => {
    stage = name;
    const started = Date.now();
    try {
      const result = await boundedProvider(operation, {
        timeoutMs: Math.max(1, deadline - Date.now()),
        signal: options.signal,
        onLateResolve,
      });
      options.onDiagnostic?.({ stage: name, status: 'ok', duration_ms: Date.now() - started });
      return result;
    } catch (failure) {
      const safe = safeProviderError(failure, name, 'CHANNEL_PROVIDER_CHECK_FAILED');
      options.onDiagnostic?.({
        stage: name,
        status: 'error',
        duration_ms: Date.now() - started,
        error_code: safe.code,
      });
      throw safe;
    }
  };
  const module =
    options.connectorModule || (await run('provider_init', () => import('tiktok-live-connector')));
  const connection = new module.TikTokLiveConnection(username, {
    signApiKey: options.signApiKey || undefined,
    processInitialData: false,
    authenticateWs: false,
    enableExtendedGiftInfo: false,
    webClientOptions: { retry: { limit: 0 } },
  });
  let invalid = false;
  let ended = false;
  let providerFailure = null;
  const invalidate = (value) => {
    invalid = true;
    if (value?.exception) providerFailure = value.exception;
  };
  const disconnect = () => closeProvider(connection, options.disconnectTimeoutMs || 2000);
  const abort = () => {
    invalid = true;
    void disconnect();
  };
  connection.on(module.ControlEvent.ERROR, invalidate);
  connection.on(module.ControlEvent.DISCONNECTED, invalidate);
  const streamEnd = () => {
    ended = true;
    invalid = true;
  };
  if (module.WebcastEvent?.STREAM_END) connection.on(module.WebcastEvent.STREAM_END, streamEnd);
  options.signal?.addEventListener('abort', abort, { once: true });
  const check = () => {
    if (invalid || options.signal?.aborted) throw providerFailure || Error('CHANNEL_PROBE_STOPPED');
  };
  try {
    check();
    const isLive = await run('is_live_lookup', () => connection.fetchIsLive());
    check();
    if (isLive === false) return { status: 'offline', roomId: null };
    if (isLive !== true)
      throw Object.assign(Error('CHANNEL_PROVIDER_RESULT_INVALID'), {
        code: 'TIKTOK_PROVIDER_PROTOCOL_CHANGED',
      });
    const roomId =
      typeof connection.fetchRoomId === 'function'
        ? await run('room_lookup', () => connection.fetchRoomId())
        : undefined;
    if (
      roomId !== undefined &&
      (typeof roomId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/u.test(roomId))
    )
      throw Object.assign(Error('CHANNEL_PROVIDER_ROOM_INVALID'), {
        code: 'TIKTOK_PROVIDER_PROTOCOL_CHANGED',
      });
    check();
    const state = await run('websocket_connect', () => connection.connect(roomId), disconnect);
    check();
    // Do not coerce numeric room IDs: large provider IDs lose precision in JS.
    if (typeof state?.roomId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/u.test(state.roomId))
      throw Object.assign(Error('CHANNEL_PROVIDER_ROOM_INVALID'), {
        code: 'TIKTOK_PROVIDER_PROTOCOL_CHANGED',
      });
    if (roomId !== undefined && state.roomId !== roomId)
      throw Object.assign(Error('CHANNEL_PROVIDER_ROOM_CHANGED'), { code: 'TIKTOK_ROOM_CHANGED' });
    return { status: 'live', roomId: state.roomId };
  } catch (failure) {
    if (!options.signal?.aborted && ended) return { status: 'offline', roomId: null };
    if (!options.signal?.aborted && failure.code === 'TIKTOK_NOT_LIVE')
      return { status: 'offline', roomId: null };
    if (
      !options.signal?.aborted &&
      module.UserOfflineError &&
      failure instanceof module.UserOfflineError
    )
      return { status: 'offline', roomId: null };
    throw safeProviderError(failure, stage, 'CHANNEL_PROVIDER_CHECK_FAILED');
  } finally {
    options.signal?.removeEventListener('abort', abort);
    // Also disconnect after a late connect resolves following cancellation.
    await disconnect();
    connection.removeListener(module.ControlEvent.ERROR, invalidate);
    connection.removeListener(module.ControlEvent.DISCONNECTED, invalidate);
    if (module.WebcastEvent?.STREAM_END)
      connection.removeListener(module.WebcastEvent.STREAM_END, streamEnd);
  }
}
