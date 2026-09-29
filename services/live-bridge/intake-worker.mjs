import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { atomicJson } from './storage.mjs';
import {
  LiveEventQueue,
  normalizeLiveEvent,
  normalizeTikTokEvent,
  flushLiveEvents,
} from './live-events.mjs';
import {
  boundedProvider,
  closeProvider,
  safeProviderError,
  providerErrorCode,
} from './provider-safety.mjs';
import {
  CommentQueue,
  normalizeComment,
  normalizeTikTokComment,
  createOperatorClient,
  flushQueue,
  sessionConfiguration,
  acquireWorkerSlot,
} from './intake-core.mjs';

function required(env, name) {
  if (typeof env[name] !== 'string' || !env[name].trim()) throw Error(`CONFIG_${name}_REQUIRED`);
  return env[name].trim();
}
export async function runNdjson(file, queue, client, events) {
  const lines = createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    if (line.length > 10000) throw Error('FIXTURE_LINE_LIMIT');
    const value = JSON.parse(line);
    if (['VIEWER_COUNT', 'MEMBER_JOIN'].includes(value.type)) {
      if (!events) throw Error('EVENT_QUEUE_REQUIRED');
      await events.enqueue(normalizeLiveEvent(value));
      if (events.pending >= 100) await flushLiveEvents(events, client);
    } else {
      if (value.type && value.type !== 'COMMENT') throw Error('INVALID_LIVE_EVENT');
      await queue.enqueue(normalizeComment(value));
    }
    if (queue.pending >= 100) await flushQueue(queue, client);
  }
  while (queue.pending) await flushQueue(queue, client);
  while (events?.pending) await flushLiveEvents(events, client);
}

export async function runWorker(env = process.env, dependencies = {}) {
  const source = env.LIVE_SOURCE || 'ndjson';
  if (!['ndjson', 'tiktok'].includes(source)) throw Error('CONFIG_SOURCE_INVALID');
  const workspaceId = required(env, 'LIVE_WORKSPACE_ID').toLowerCase();
  const sessionId = required(env, 'LIVE_SESSION_ID').toLowerCase();
  if (
    ![workspaceId, sessionId].every((value) =>
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value),
    )
  )
    throw Error('CONFIG_SCOPE_INVALID');
  const client =
    dependencies.client ||
    createOperatorClient({
      url: required(env, 'SUPABASE_URL'),
      publishableKey: required(env, 'SUPABASE_PUBLISHABLE_KEY'),
      accessToken: required(env, 'LIVE_OPERATOR_ACCESS_TOKEN'),
      refreshToken: env.LIVE_OPERATOR_REFRESH_TOKEN || '',
    });
  const profile = await sessionConfiguration(client, workspaceId, sessionId, source);
  const slot = await acquireWorkerSlot(workspaceId, sessionId);
  try {
    const stateDir =
      dependencies.stateDir || fileURLToPath(new URL('./state/intake/', import.meta.url));
    const queue = await new CommentQueue({
      file: resolve(stateDir, `${workspaceId}-${sessionId}.json`),
      workspaceId,
      sessionId,
    }).init();
    const events = await new LiveEventQueue({
      file: resolve(stateDir, `${workspaceId}-${sessionId}-events.json`),
      workspaceId,
      sessionId,
    }).init();
    const metrics = {
      last_provider_event_at: null,
      last_normalized_event_at: null,
      last_db_ingest_at: null,
      last_error_code: null,
    };
    const report = (status, message) =>
      client.rpc('report_live_connection', {
        p_workspace_id: workspaceId,
        p_session_id: sessionId,
        p_status: status,
        p_message: message,
      });
    if (source === 'ndjson') {
      try {
        await report('connected', 'provider_ready');
        await runNdjson(resolve(required(env, 'LIVE_FIXTURE_FILE')), queue, client, events);
        await report('disconnected', 'stopped');
        console.log(
          'NDJSON complete: all locally queued observations acknowledged through authorized RPC.',
        );
      } catch (failure) {
        await report('error', 'connection_failed').catch(() => {});
        console.error(
          `NDJSON stopped; ${queue.pending + events.pending} pending observations remain on disk.`,
        );
        throw failure;
      }
      await slot.close();
      return;
    }

    const { TikTokLiveConnection, WebcastEvent, ControlEvent } =
      dependencies.connectorModule || (await import('tiktok-live-connector'));
    const connection = new TikTokLiveConnection(profile.username, {
      signApiKey: env.TIKTOK_SIGN_API_KEY || undefined,
      processInitialData: true,
      authenticateWs: false,
      enableExtendedGiftInfo: false,
    });
    let stopped = false;
    const expectedRoomId = dependencies.expectedProviderRoomId;
    if (
      expectedRoomId !== undefined &&
      (typeof expectedRoomId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/u.test(expectedRoomId))
    )
      throw Error('PROVIDER_EXPECTED_ROOM_INVALID');
    let roomVerified = expectedRoomId === undefined;
    const initialEvents = [];
    let accepting = true;
    let rejecting = false;
    let pendingCallbacks = 0;
    let tail = Promise.resolve();
    let timer;
    let lastHeartbeat = 0;
    let inFlightFlush = null;
    let retryMs = 1000;
    let stoppingPromise;
    let inFlightStartupReport = null;
    let stoppedReason = null;
    const stop = (failed = false, reason = 'stopped') => {
      if (stoppingPromise) return stoppingPromise;
      stoppedReason = reason;
      stopped = true;
      accepting = false;
      clearTimeout(timer);
      // Install the promise before disconnect can synchronously emit another
      // DISCONNECTED event. Every caller must await the same queue/RPC drain.
      stoppingPromise = Promise.resolve().then(async () => {
        await closeProvider(connection, dependencies.disconnectTimeoutMs || 2000);
        await tail.catch(() => {});
        await inFlightFlush?.catch(() => {});
        await inFlightStartupReport?.catch(() => {});
        if (reason === 'live_ended') {
          // Comments accepted before STREAM_END are persisted first, then sent
          // while the current session/lease still permits ingestion. Stop on
          // the first failed batch; never discard or ingest after finalization.
          try {
            while (queue.pending) await flushQueue(queue, client);
            while (events.pending) await flushLiveEvents(events, client);
          } catch {
            console.error(
              `LIVE_END_DRAIN_PENDING: ${queue.pending + events.pending} events retained for reconciliation.`,
            );
          }
          if (typeof dependencies.onStreamEnd === 'function') {
            await Promise.resolve()
              .then(() => dependencies.onStreamEnd({ pending: queue.pending + events.pending }))
              .catch(() => {
                console.error(
                  'LIVE_END_REPORT_PENDING: terminal result not acknowledged; queue retained.',
                );
              });
          } else {
            // Migration007 only permits its existing message codes. Legacy
            // direct/session workers remain compatible without migration011.
            await report('disconnected', 'stopped').catch(() => {});
          }
        } else {
          await report(
            failed ? 'error' : 'disconnected',
            failed ? 'connection_failed' : 'stopped',
          ).catch(() => {});
        }
        await slot.close();
        for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, signalStop);
        dependencies.signal?.removeEventListener('abort', signalStop);
        console.log(
          `Worker stopped; ${queue.pending + events.pending} locally persisted events await acknowledgement.`,
        );
        if (failed) process.exitCode = 1;
      });
      return stoppingPromise;
    };
    const rejectEvent = async (data, code) => {
      if (rejecting) return;
      rejecting = true;
      accepting = false;
      // Preserve a bounded diagnostic instead of dumping provider objects/tokens.
      await atomicJson(resolve(stateDir, `rejected-${randomUUID()}.json`), {
        received_at: new Date().toISOString(),
        reason: code,
        message_id:
          typeof (data?.common?.msgId ?? data?.msgId) === 'string'
            ? (data?.common?.msgId ?? data.msgId).slice(0, 200)
            : null,
        author_external_id:
          typeof (data?.user?.id ?? data?.user?.userId) === 'string'
            ? (data.user.id ?? data.user.userId).slice(0, 200)
            : null,
        text_excerpt:
          typeof (data?.content ?? data?.comment) === 'string'
            ? (data.content ?? data.comment).slice(0, 2000)
            : null,
        excerpt_may_be_truncated:
          typeof (data?.content ?? data?.comment) === 'string' &&
          (data.content ?? data.comment).length > 2000,
      });
      console.error(
        `${code}: intake stopped for reconciliation; no automatic customer merge or sale.`,
      );
      void stop(true);
    };
    const receive = (type, data) => {
      if (stopped || !accepting) return;
      metrics.last_provider_event_at = new Date().toISOString();
      if (!roomVerified) {
        if (initialEvents.length >= 100) {
          void stop(true);
          return;
        }
        initialEvents.push({ type, data });
        return;
      }
      if (pendingCallbacks >= 100) {
        void rejectEvent(data, 'PROVIDER_BACKPRESSURE').catch(() => {
          void stop(true);
        });
        return;
      }
      pendingCallbacks++;
      tail = tail
        .then(async () => {
          try {
            if (type === 'COMMENT') await queue.enqueue(normalizeTikTokComment(data));
            else await events.enqueue(normalizeTikTokEvent(type, data));
            metrics.last_normalized_event_at = new Date().toISOString();
          } catch {
            await rejectEvent(data, 'PROVIDER_EVENT_OR_QUEUE_REJECTED');
          } finally {
            pendingCallbacks--;
          }
        })
        .catch(() => {
          console.error('QUEUE_PERSISTENCE_FAILED: intake stopping with existing queue retained.');
          void stop(true);
        });
    };
    connection.on(WebcastEvent.CHAT, (data) => receive('COMMENT', data));
    if (WebcastEvent.ROOM_USER)
      connection.on(WebcastEvent.ROOM_USER, (data) => receive('VIEWER_COUNT', data));
    if (WebcastEvent.MEMBER)
      connection.on(WebcastEvent.MEMBER, (data) => receive('MEMBER_JOIN', data));
    if (ControlEvent.WEBSOCKET_DATA)
      connection.on(ControlEvent.WEBSOCKET_DATA, () => {
        if (!stopped) metrics.last_provider_event_at = new Date().toISOString();
      });
    const flush = () => {
      if (stopped) return Promise.resolve();
      if (inFlightFlush) return inFlightFlush;
      clearTimeout(timer);
      inFlightFlush = (async () => {
        try {
          const queued = queue.pending + events.pending;
          await flushQueue(queue, client);
          await flushLiveEvents(events, client);
          if (queued > 0) metrics.last_db_ingest_at = new Date().toISOString();
          metrics.last_error_code = null;
          if (!stopped && Date.now() - lastHeartbeat >= 30000) {
            await report('connected', 'connected');
            lastHeartbeat = Date.now();
          }
          retryMs = 1000;
        } catch {
          metrics.last_error_code = 'TIKTOK_INGEST_FAILED';
          if (!stopped && Date.now() - lastHeartbeat >= 30000) {
            await report('error', 'retrying').catch(() => {});
            lastHeartbeat = Date.now();
          }
          retryMs = Math.min(30000, retryMs * 2);
          console.error(
            stopped
              ? `Ingest not acknowledged; ${queue.pending} persisted comments retained during shutdown.`
              : `Ingest retry pending (${queue.pending} persisted); next attempt in ${retryMs / 1000}s.`,
          );
        }
      })().finally(() => {
        inFlightFlush = null;
        if (!stopped) timer = setTimeout(flush, retryMs);
      });
      return inFlightFlush;
    };
    connection.on(ControlEvent.ERROR, (failure) => {
      metrics.last_error_code = providerErrorCode(failure, 'websocket_connect');
      dependencies.onDiagnostic?.({
        stage: 'websocket',
        status: 'error',
        error_code: metrics.last_error_code,
      });
      console.error(`${metrics.last_error_code}: persisted queue retained.`);
      void stop(true);
    });
    connection.on(ControlEvent.DISCONNECTED, () => {
      void stop(false);
    });
    if (WebcastEvent.STREAM_END)
      connection.on(WebcastEvent.STREAM_END, () => {
        // A provider event from an unverified/different room cannot terminate
        // the channel session selected from the earlier provider probe.
        if (!roomVerified && connection.roomId !== expectedRoomId) return;
        void stop(false, 'live_ended');
      });
    const signalStop = () => {
      void stop(false);
    };
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, signalStop);
    dependencies.signal?.addEventListener('abort', signalStop, { once: true });
    if (dependencies.signal?.aborted) signalStop();
    try {
      if (stopped) throw Error('PROVIDER_CONNECTION_STOPPED');
      inFlightStartupReport = report('connecting', 'connecting');
      await inFlightStartupReport;
      inFlightStartupReport = null;
      if (stopped) throw Error('PROVIDER_CONNECTION_STOPPED');
      const connectStarted = Date.now();
      const connected = await boundedProvider(() => connection.connect(expectedRoomId), {
        timeoutMs: dependencies.connectTimeoutMs || 30000,
        signal: dependencies.signal,
        onLateResolve: () => closeProvider(connection, dependencies.disconnectTimeoutMs || 2000),
      });
      dependencies.onDiagnostic?.({
        stage: 'websocket_connect',
        status: 'ok',
        duration_ms: Date.now() - connectStarted,
      });
      if (stopped) {
        // A provider may finish connecting after its first disconnect request.
        await closeProvider(connection, dependencies.disconnectTimeoutMs || 2000);
        throw Error('PROVIDER_CONNECTION_STOPPED');
      }
      if (expectedRoomId !== undefined && connected?.roomId !== expectedRoomId)
        throw Object.assign(Error('PROVIDER_ROOM_CHANGED'), { code: 'TIKTOK_ROOM_CHANGED' });
      inFlightStartupReport = report('connected', 'connected');
      await inFlightStartupReport;
      inFlightStartupReport = null;
      if (stopped) throw Error('PROVIDER_CONNECTION_STOPPED');
      roomVerified = true;
      for (const event of initialEvents.splice(0)) receive(event.type, event.data);
      console.log(
        'TikTok adapter connected. Comments are suggestions; only the seller commits sales.',
      );
      timer = setTimeout(flush, 1000);
      return {
        stop,
        flushNow: flush,
        settled: () => tail,
        pending: () => queue.pending + events.pending,
        pendingEvents: () => events.pending,
        inspect: () => ({
          ...metrics,
          pending_comments: queue.pending,
          pending_events: events.pending,
          stopped,
        }),
        isStopped: () => stopped,
        stopReason: () => stoppedReason,
      };
    } catch (failure) {
      const safe = safeProviderError(failure, 'websocket_connect', 'PROVIDER_CONNECTION_FAILED');
      metrics.last_error_code = safe.code;
      dependencies.onDiagnostic?.({
        stage: 'websocket_connect',
        status: 'error',
        error_code: safe.code,
      });
      await stop(true);
      throw safe;
    }
  } catch (failure) {
    await slot.close();
    throw failure;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWorker().catch(() => {
    console.error(
      'INTAKE_STOPPED: inspect configuration, provider state and local queue. Credentials are not logged.',
    );
    process.exitCode = 1;
  });
}
