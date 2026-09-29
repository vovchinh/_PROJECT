import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { acquireWorkerSlot, createOperatorClient } from './intake-core.mjs';
import { runWorker } from './intake-worker.mjs';
import { probeTikTokChannel, validTikTokUsername } from './tiktok-channel-provider.mjs';
import { boundedProvider, providerErrorCode } from './provider-safety.mjs';
import { createListenerHealth } from './listener-health.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
function required(env, name) {
  if (typeof env[name] !== 'string' || !env[name].trim()) throw Error(`CONFIG_${name}_REQUIRED`);
  return env[name].trim();
}
function revision(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  if (typeof value === 'string' && /^[1-9][0-9]*$/u.test(value)) return BigInt(value);
  throw Error('CHANNEL_REVISION_INVALID');
}

// Workspace-scoped listener. Sellers choose a saved TikTok ID; the server alone
// creates the daily campaign/session after the provider proves the room is LIVE.
export async function runChannelSupervisor(env = process.env, dependencies = {}) {
  const workspaceId = required(env, 'LIVE_WORKSPACE_ID').toLowerCase();
  if (!uuid.test(workspaceId)) throw Error('CONFIG_SCOPE_INVALID');
  const pollMs = Number(env.LIVE_SUPERVISOR_POLL_MS || 3000);
  if (!Number.isInteger(pollMs) || pollMs < 1000 || pollMs > 30000)
    throw Error('CONFIG_SUPERVISOR_POLL_INVALID');
  const client =
    dependencies.client ||
    createOperatorClient({
      url: required(env, 'SUPABASE_URL'),
      publishableKey: required(env, 'SUPABASE_PUBLISHABLE_KEY'),
      accessToken: required(env, 'LIVE_OPERATOR_ACCESS_TOKEN'),
      refreshToken: env.LIVE_OPERATOR_REFRESH_TOKEN || '',
    });
  const startWorker = dependencies.runWorker || runWorker;
  const probe = dependencies.probe || probeTikTokChannel;
  const now = dependencies.now || Date.now;
  const schedule = dependencies.setTimeout || setTimeout;
  const cancel = dependencies.clearTimeout || clearTimeout;
  const log = dependencies.log || ((message) => console.error(message));
  const slot = await acquireWorkerSlot(`channels:${workspaceId}`, 'workspace');
  const entries = new Map();
  let stopped = false,
    stoppingPromise,
    polling = null,
    timer,
    issue = null;
  let providerInitialized = Boolean(
      dependencies.probe || dependencies.providerDependencies?.connectorModule,
    ),
    providerInitError = null,
    controlsReachable = false;
  const health = createListenerHealth({
    client,
    workspaceId,
    now,
    setTimeout: schedule,
    clearTimeout: cancel,
    enabled: dependencies.healthEnabled !== false,
    readState: () => ({
      ready: !stopped && providerInitialized && controlsReachable,
      provider_initialized: providerInitialized,
      supabase_reachable: controlsReachable,
      active_listener_count: [...entries.values()].filter(
        (entry) => entry.worker && !entry.worker.isStopped(),
      ).length,
      last_error_code:
        issue ||
        providerInitError ||
        [...entries.values()].find((entry) => entry.errorCode)?.errorCode ||
        null,
    }),
  });
  const inspect = () => ({
    stopped,
    issue,
    health: health.inspect(),
    channels: [...entries.values()].map((entry) => ({
      channel_id: entry.id,
      revision: entry.revision.toString(),
      desired_state: entry.desired,
      status: entry.status,
      session_id: entry.sessionId || null,
      retry_count: entry.failures,
      last_error_code: entry.errorCode || null,
      diagnostics: entry.diagnostics || [],
      worker: entry.worker?.inspect?.() || null,
      worker_running: Boolean(entry.worker && !entry.worker.isStopped()),
    })),
  });
  function failure(entry, claimFailed = false, cause) {
    entry.errorCode =
      entry.failures >= 4
        ? 'TIKTOK_PROVIDER_UNAVAILABLE'
        : claimFailed
          ? 'TIKTOK_SESSION_CONFLICT'
          : providerErrorCode(cause, 'websocket_connect');
    entry.failures++;
    entry.retryAt =
      now() + (claimFailed ? 90000 : Math.min(30000, 1000 * 2 ** (entry.failures - 1)));
    entry.status = entry.failures >= 5 ? 'blocked' : 'backoff';
    log(
      entry.failures >= 5
        ? 'CHANNEL_RETRY_LIMIT: check provider and request connection again.'
        : 'CHANNEL_RETRY_PENDING: durable comments retained; credentials are not logged.',
    );
  }
  function drain(entry) {
    if (entry.draining) return entry.draining;
    entry.abort?.abort();
    const worker = entry.worker;
    entry.worker = null;
    entry.draining = Promise.resolve()
      .then(async () => {
        await worker?.stop();
        await entry.startup?.catch(() => {});
      })
      .finally(() => {
        entry.draining = null;
      });
    return entry.draining;
  }
  function launch(entry) {
    const requestedRevision = entry.revision;
    const abort = new AbortController();
    entry.abort = abort;
    entry.status = 'checking';
    let claimFailed = false;
    let lease = entry.lease;
    let terminal = false;
    const diagnostic = (value) => {
      if (entry.revision !== requestedRevision) return;
      const allowedStage = [
        'provider_init',
        'is_live_lookup',
        'room_lookup',
        'websocket_connect',
        'websocket',
      ];
      if (!allowedStage.includes(value?.stage)) return;
      const safe = {
        stage: value.stage,
        status: value.status === 'ok' ? 'ok' : 'error',
        ...(Number.isFinite(value.duration_ms) ? { duration_ms: value.duration_ms } : {}),
      };
      if (value.error_code) {
        safe.error_code = providerErrorCode({ code: value.error_code });
        entry.errorCode = safe.error_code;
      }
      entry.diagnostics = [...(entry.diagnostics || []).slice(-19), safe];
      log(
        JSON.stringify({
          timestamp: new Date(now()).toISOString(),
          level: safe.status === 'error' ? 'error' : 'info',
          component: 'tiktok_listener',
          workspace_id: workspaceId,
          channel_id: entry.id,
          session_id: entry.sessionId || null,
          provider: 'tiktok-live-connector',
          attempt: entry.failures + 1,
          correlation_id: `${entry.id}:${requestedRevision}`,
          revision: requestedRevision.toString(),
          ...safe,
        }),
      );
    };
    const active = () =>
      !stopped &&
      !abort.signal.aborted &&
      entry.desired === 'connected' &&
      requestedRevision === entry.revision;
    const guard = () => {
      if (!active()) throw Error('CHANNEL_REQUEST_SUPERSEDED');
    };
    const report = async (status, roomId = null) => {
      // Stop is allowed to report its own revision; the DB fences stale results.
      return client.rpc('report_tiktok_connection', {
        p_workspace_id: workspaceId,
        p_channel_id: entry.id,
        p_revision: requestedRevision.toString(),
        p_lease_token: lease,
        p_status: status,
        p_provider_room_id: roomId,
      });
    };
    entry.startup = Promise.resolve()
      .then(async () => {
        if (!lease) {
          claimFailed = true;
          const result = await client.rpc('claim_tiktok_connection', {
            p_workspace_id: workspaceId,
            p_channel_id: entry.id,
            p_revision: requestedRevision.toString(),
          });
          guard();
          if (
            !uuid.test(result?.lease_token || '') ||
            revision(result.revision) !== requestedRevision
          )
            throw Error('CHANNEL_LEASE_INVALID');
          lease = result.lease_token;
          entry.lease = lease;
          claimFailed = false;
        }
        guard();
        const evidence = await probe(entry.username, {
          ...dependencies.providerDependencies,
          signal: abort.signal,
          signApiKey: env.TIKTOK_SIGN_API_KEY,
          onDiagnostic: diagnostic,
        });
        guard();
        providerInitialized = true;
        providerInitError = null;
        if (evidence?.status === 'offline') {
          await report('offline');
          guard();
          entry.status = 'offline';
          return; // A new seller request gets a new revision; do not endlessly probe offline rooms.
        }
        if (
          evidence?.status !== 'live' ||
          typeof evidence.roomId !== 'string' ||
          !/^[A-Za-z0-9_-]{1,200}$/u.test(evidence.roomId)
        )
          throw Error('CHANNEL_EVIDENCE_INVALID');
        const result = await report('live', evidence.roomId);
        guard();
        if (!uuid.test(result?.session_id || '') || result.status !== 'LIVE')
          throw Error('CHANNEL_SESSION_INVALID');
        const sessionId = result.session_id;
        entry.sessionId = sessionId;
        // Reuse all durable normalization/queue/ack behavior. Every channel write
        // carries its lease; legacy sessions continue using the original RPCs.
        const workerClient = {
          rpc: async (name, args) => {
            if (args.p_workspace_id !== workspaceId || args.p_session_id !== sessionId)
              throw Error('CHANNEL_WORKER_SCOPE_INVALID');
            if (name === 'get_live_intake') {
              guard();
              return client.rpc(name, args);
            }
            try {
              if (name === 'ingest_live_comments' || name === 'ingest_live_events') {
                guard();
                return await client.rpc(
                  name === 'ingest_live_comments'
                    ? 'ingest_tiktok_comments'
                    : 'ingest_tiktok_events',
                  {
                    ...args,
                    p_channel_id: entry.id,
                    p_revision: requestedRevision.toString(),
                    p_lease_token: lease,
                  },
                );
              }
              if (name !== 'report_live_connection') throw Error('CHANNEL_WORKER_RPC_NOT_ALLOWED');
              if (terminal) return {}; // Never overwrite a verified terminal result with stop/error.
              const status =
                args.p_status === 'connected'
                  ? 'live'
                  : args.p_status === 'connecting'
                    ? 'reconnecting'
                    : args.p_status === 'error'
                      ? 'error'
                      : 'disconnected';
              if (status !== 'disconnected' && status !== 'error') guard();
              const reported = await report(status, status === 'live' ? evidence.roomId : null);
              if (status === 'live' && reported?.session_id !== sessionId)
                throw Error('CHANNEL_SESSION_CHANGED');
              return reported;
            } catch (error) {
              // An unknown/fenced write cannot keep ingesting under the old lease.
              if (
                entry.revision === requestedRevision &&
                entry.abort === abort &&
                entry.lease === lease
              )
                entry.lease = null;
              abort.abort();
              throw error;
            }
          },
        };
        const onStreamEnd = async ({ pending }) => {
          // The callback is invoked only after the worker drained accepted
          // comments. It never asks an operator to approve stopping the LIVE.
          // A failed final ingest may abort the worker signal. The verified end
          // still owns its captured token/revision; the server decides whether
          // another request/claim has superseded it.
          if (
            stopped ||
            terminal ||
            entry.desired !== 'connected' ||
            requestedRevision !== entry.revision
          )
            return;
          terminal = true;
          entry.terminalRevision = requestedRevision;
          entry.status = 'ending';
          if (pending)
            log(`CHANNEL_END_QUEUE_PENDING: ${pending} comments retained for reconciliation.`);
          const ending = {
            revision: requestedRevision,
            requestId: randomUUID(),
            retries: 0,
            retryAt: 0,
            promise: null,
          };
          entry.ending = ending;
          ending.finish = () => {
            if (ending.promise) return ending.promise;
            if (entry.ending !== ending || entry.revision !== requestedRevision || stopped)
              return Promise.resolve();
            ending.promise = Promise.resolve()
              .then(async () => {
                const result = await client.rpc('finish_tiktok_live', {
                  p_workspace_id: workspaceId,
                  p_channel_id: entry.id,
                  p_revision: requestedRevision.toString(),
                  p_lease_token: lease,
                  p_request_id: ending.requestId,
                });
                const nextRevision = revision(result?.revision);
                if (
                  result?.status !== 'OFFLINE' ||
                  result?.session_id !== sessionId ||
                  nextRevision <= requestedRevision
                )
                  throw Error('CHANNEL_END_RESULT_INVALID');
                if (entry.ending !== ending || entry.revision !== requestedRevision) return;
                entry.revision = nextRevision;
                entry.desired = 'disconnected';
                entry.status = 'ended';
                entry.lease = null;
                entry.ending = null;
              })
              .catch(() => {
                if (entry.ending === ending && entry.revision === requestedRevision) {
                  ending.retries++;
                  ending.retryAt =
                    now() + Math.min(30000, 1000 * 2 ** Math.min(ending.retries - 1, 5));
                  entry.status = 'ending';
                  log(
                    'CHANNEL_END_REPORT_PENDING: retrying the same terminal request; no provider reconnect.',
                  );
                }
              })
              .finally(() => {
                ending.promise = null;
              });
            return ending.promise;
          };
          await ending.finish();
        };
        entry.status = 'starting';
        const created = await startWorker(
          {
            ...env,
            LIVE_SOURCE: 'tiktok',
            LIVE_WORKSPACE_ID: workspaceId,
            LIVE_SESSION_ID: sessionId,
          },
          {
            ...dependencies.workerDependencies,
            client: workerClient,
            signal: abort.signal,
            expectedProviderRoomId: evidence.roomId,
            onStreamEnd,
            onDiagnostic: diagnostic,
          },
        );
        if (
          !created ||
          typeof created.stop !== 'function' ||
          typeof created.isStopped !== 'function'
        ) {
          await created?.stop?.();
          throw Error('CHANNEL_WORKER_CONTRACT_INVALID');
        }
        if (!active()) {
          await created.stop();
          return;
        }
        entry.worker = created;
        entry.startedAt = now();
        entry.status = 'running';
        entry.errorCode = null;
      })
      .catch(async (cause) => {
        if (
          !terminal &&
          !stopped &&
          entry.desired === 'connected' &&
          requestedRevision === entry.revision
        ) {
          if (entry.lease)
            await report('error').catch(() => {
              entry.lease = null;
            });
          failure(entry, claimFailed, cause);
        }
      })
      .finally(() => {
        entry.startup = null;
      });
  }
  async function reconcile() {
    const result = await client.rpc('get_tiktok_channels', { p_workspace_id: workspaceId });
    controlsReachable = true;
    if (stopped) return;
    if (
      !Array.isArray(result?.channels) ||
      !Array.isArray(result?.connections) ||
      result.channels.length > 1000
    )
      throw Error('CHANNEL_STATE_INVALID');
    const channels = new Map(),
      controls = new Map();
    for (const row of result.channels) {
      if (
        !uuid.test(row.id || '') ||
        channels.has(row.id) ||
        typeof row.is_active !== 'boolean' ||
        !validTikTokUsername(row.username) ||
        (row.workspace_id && row.workspace_id !== workspaceId)
      )
        throw Error('CHANNEL_STATE_INVALID');
      channels.set(row.id, row);
    }
    for (const row of result.connections) {
      if (
        !channels.has(row.channel_id) ||
        controls.has(row.channel_id) ||
        !['connected', 'disconnected'].includes(row.desired_state) ||
        (row.workspace_id && row.workspace_id !== workspaceId)
      )
        throw Error('CHANNEL_CONTROL_INVALID');
      controls.set(row.channel_id, { ...row, revision: revision(row.revision) });
    }
    for (const [id, entry] of entries) {
      const row = channels.get(id),
        control = controls.get(id);
      if (!row?.is_active || !control) {
        entry.desired = 'disconnected';
        entry.status = 'waiting';
        entry.errorCode = null;
        await drain(entry);
      }
    }
    for (const [id, control] of controls) {
      const row = channels.get(id);
      let entry = entries.get(id);
      if (!entry) {
        entry = {
          id,
          username: row.username,
          revision: control.revision,
          desired: 'disconnected',
          status: 'waiting',
          failures: 0,
          retryAt: 0,
          lease: null,
          sessionId: null,
        };
        entries.set(id, entry);
      }
      if (control.revision < entry.revision) continue;
      if (control.revision > entry.revision || row.username !== entry.username) {
        // Change the revision before draining so a late probe can never report.
        entry.revision = control.revision;
        entry.desired = 'disconnected';
        await drain(entry);
        entry.username = row.username;
        entry.failures = 0;
        entry.retryAt = 0;
        entry.lease = null;
        entry.status = 'waiting';
        entry.terminalRevision = null;
        entry.ending = null;
      }
      entry.desired = row.is_active ? control.desired_state : 'disconnected';
      if (entry.desired !== 'connected') {
        await drain(entry);
        entry.status = 'waiting';
        continue;
      }
      if (stopped) return;
      if (entry.worker) {
        if (entry.worker.isStopped()) {
          if (entry.worker.stopReason?.() === 'live_ended') {
            // Do not abort the signal used by the final queue drain. A network
            // disconnect has no terminal reason and still follows normal retry.
            await entry.worker.stop();
            entry.worker = null;
            if (entry.revision !== control.revision || entry.desired !== 'connected') continue;
          } else {
            if (now() - entry.startedAt >= 60000) entry.failures = 0;
            await drain(entry);
            failure(entry);
          }
        } else if (now() - entry.startedAt >= 60000) entry.failures = 0;
      }
      if (entry.terminalRevision === entry.revision) {
        if (entry.ending && now() >= entry.ending.retryAt) await entry.ending.finish();
        continue;
      }
      if (
        entry.worker ||
        entry.startup ||
        entry.draining ||
        entry.status === 'offline' ||
        entry.failures >= 5 ||
        now() < entry.retryAt
      )
        continue;
      launch(entry);
    }
    issue = null;
  }
  function refresh() {
    if (stopped) return Promise.resolve(inspect());
    if (polling) return polling;
    cancel(timer);
    polling = Promise.resolve()
      .then(reconcile)
      .catch(async () => {
        if (!stopped) {
          issue = 'CHANNEL_CONTROL_UNAVAILABLE';
          controlsReachable = false;
          await Promise.all([...entries.values()].map(drain));
          log('CHANNEL_CONTROL_UNAVAILABLE: intake paused; verify login and migration 010.');
        }
      })
      .finally(() => {
        polling = null;
        if (!stopped)
          timer = schedule(() => {
            void refresh();
          }, pollMs);
      })
      .then(inspect);
    return polling;
  }
  function stop() {
    if (stoppingPromise) return stoppingPromise;
    stopped = true;
    cancel(timer);
    const drains = [...entries.values()].map(drain);
    stoppingPromise = Promise.resolve().then(async () => {
      await Promise.all([...drains, polling?.catch(() => {})]);
      await health.stop();
      await slot.close();
      for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, signalStop);
    });
    return stoppingPromise;
  }
  const signalStop = () => {
    void stop();
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, signalStop);
  try {
    if (!providerInitialized && dependencies.healthEnabled !== false) {
      try {
        const module = await boundedProvider(() => import('tiktok-live-connector'), {
          timeoutMs: 3000,
        });
        providerInitialized = typeof module.TikTokLiveConnection === 'function';
        if (!providerInitialized) providerInitError = 'TIKTOK_PROVIDER_PROTOCOL_CHANGED';
      } catch (failure) {
        providerInitError = providerErrorCode(failure);
      }
    }
    await refresh();
    await health.refresh();
    return {
      refresh,
      stop,
      inspect,
      readiness: health.inspect,
      settled: async () => {
        await polling;
        await Promise.all(
          [...entries.values()].map(async (entry) => {
            await entry.startup;
            await entry.draining;
          }),
        );
        return inspect();
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runChannelSupervisor().catch(() => {
    console.error(
      'CHANNEL_LISTENER_STOPPED: check workspace configuration and operator access; credentials are not logged.',
    );
    process.exitCode = 1;
  });
}
