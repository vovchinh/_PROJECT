import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireWorkerSlot, createOperatorClient, sessionConfiguration } from './intake-core.mjs';
import { runWorker } from './intake-worker.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
function required(env, name) {
  if (typeof env[name] !== 'string' || !env[name].trim()) throw Error(`CONFIG_${name}_REQUIRED`);
  return env[name].trim();
}
function revision(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  if (typeof value === 'string' && /^[1-9][0-9]*$/u.test(value)) return BigInt(value);
  throw Error('SUPERVISOR_CONTROL_REVISION_INVALID');
}

// One supervisor per fixed workspace/session. Desired connection state comes
// only from the authenticated database read; observed status remains runWorker's
// responsibility. No connect/commit/print mutation is dispatched by this layer.
export async function runSupervisor(env = process.env, dependencies = {}) {
  const workspaceId = required(env, 'LIVE_WORKSPACE_ID').toLowerCase();
  const sessionId = required(env, 'LIVE_SESSION_ID').toLowerCase();
  if (![workspaceId, sessionId].every((value) => uuid.test(value)))
    throw Error('CONFIG_SCOPE_INVALID');
  const source = env.LIVE_SOURCE || 'tiktok';
  if (source !== 'tiktok') throw Error('SUPERVISOR_REQUIRES_TIKTOK_SOURCE');
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
  const now = dependencies.now || Date.now;
  const schedule = dependencies.setTimeout || setTimeout;
  const cancel = dependencies.clearTimeout || clearTimeout;
  const log = dependencies.log || ((message) => console.error(message));
  const slot = await acquireWorkerSlot(`supervisor:${workspaceId}`, sessionId);
  let stopped = false,
    stoppingPromise,
    timer,
    polling = null,
    startup = null,
    draining = null;
  let worker = null,
    startupAbort = null,
    latestRevision = null,
    desired = 'disconnected';
  let failures = 0,
    retryAt = 0,
    startedAt = 0,
    status = 'waiting',
    issue = null;

  const inspect = () => ({
    status,
    desired_state: desired,
    revision: latestRevision?.toString() || null,
    retry_count: failures,
    retry_at: retryAt || null,
    issue,
    worker_running: Boolean(worker && !worker.isStopped()),
    stopped,
  });
  function failed() {
    failures++;
    retryAt = now() + Math.min(30000, 1000 * 2 ** (failures - 1));
    status = failures >= 5 ? 'blocked' : 'backoff';
    issue = failures >= 5 ? 'RECONNECT_LIMIT_REQUEST_NEW_REVISION' : 'PROVIDER_RETRY_PENDING';
    log(
      failures >= 5
        ? 'SUPERVISOR_RETRY_LIMIT: request a new connection after checking the provider.'
        : 'SUPERVISOR_RETRY_PENDING: local queue retained; retry waits for current database intent.',
    );
  }
  function drain() {
    if (draining) return draining;
    startupAbort?.abort();
    const current = worker;
    worker = null;
    draining = Promise.resolve()
      .then(async () => {
        if (current) await current.stop();
        await startup?.catch(() => {});
      })
      .finally(() => {
        draining = null;
      });
    return draining;
  }
  function launch() {
    const requestedRevision = latestRevision;
    const abort = new AbortController();
    startupAbort = abort;
    status = 'starting';
    issue = null;
    startup = Promise.resolve()
      .then(() =>
        startWorker(
          {
            ...env,
            LIVE_SOURCE: source,
            LIVE_WORKSPACE_ID: workspaceId,
            LIVE_SESSION_ID: sessionId,
          },
          {
            ...dependencies.workerDependencies,
            client,
            signal: abort.signal,
          },
        ),
      )
      .then(async (created) => {
        if (
          !created ||
          typeof created.stop !== 'function' ||
          typeof created.isStopped !== 'function'
        ) {
          await created?.stop?.();
          throw Error('SUPERVISOR_WORKER_CONTRACT_INVALID');
        }
        if (
          stopped ||
          abort.signal.aborted ||
          desired !== 'connected' ||
          requestedRevision !== latestRevision
        ) {
          await created.stop();
          return;
        }
        worker = created;
        startedAt = now();
        status = 'running';
        issue = null;
      })
      .catch(() => {
        if (
          !stopped &&
          !abort.signal.aborted &&
          desired === 'connected' &&
          requestedRevision === latestRevision
        )
          failed();
      })
      .finally(() => {
        startup = null;
        if (startupAbort === abort) startupAbort = null;
      });
  }
  async function reconcile() {
    const [operations, intake] = await Promise.all([
      client.rpc('get_live_operations', { p_workspace_id: workspaceId }),
      client.rpc('get_live_intake', { p_workspace_id: workspaceId, p_session_id: sessionId }),
    ]);
    if (stopped) return;
    if (!Array.isArray(operations?.session_controls)) throw Error('SUPERVISOR_CONTROLS_INVALID');
    const rows = operations.session_controls.filter((row) => row.session_id === sessionId);
    if (rows.length > 1) throw Error('SUPERVISOR_CONTROLS_DUPLICATE');
    const control = rows[0];
    let eligible = false;
    try {
      await sessionConfiguration({ rpc: async () => intake }, workspaceId, sessionId, source);
      eligible = true;
    } catch {
      /* Ended, closed, disabled and incompatible sources cannot run. */
    }
    let changedRevision = false;
    if (!control) desired = 'disconnected';
    else {
      if (
        !['connected', 'disconnected'].includes(control.desired_state) ||
        (control.workspace_id && control.workspace_id !== workspaceId)
      )
        throw Error('SUPERVISOR_CONTROL_INVALID');
      const incomingRevision = revision(control.revision);
      if (latestRevision === null || incomingRevision >= latestRevision) {
        changedRevision = incomingRevision !== latestRevision;
        latestRevision = incomingRevision;
        desired = control.desired_state;
        if (changedRevision) {
          failures = 0;
          retryAt = 0;
          issue = null;
        }
      }
    }
    if (!eligible || desired !== 'connected') {
      status = 'waiting';
      issue = eligible ? null : 'SESSION_NOT_ELIGIBLE';
      await drain();
      return;
    }
    if (changedRevision && startup) await drain(); // A superseded startup cannot attach later.
    if (stopped) return;
    if (worker) {
      if (worker.isStopped()) {
        if (now() - startedAt >= 60000) failures = 0;
        await drain();
        failed();
      } else {
        if (now() - startedAt >= 60000) failures = 0;
        status = 'running';
        issue = null;
      }
      return;
    }
    if (startup || draining) return;
    if (failures >= 5) {
      status = 'blocked';
      return;
    }
    if (now() < retryAt) {
      status = 'backoff';
      return;
    }
    launch();
  }
  function refresh() {
    if (stopped) return Promise.resolve(inspect());
    if (polling) return polling;
    cancel(timer);
    polling = Promise.resolve()
      .then(reconcile)
      .catch(async () => {
        if (!stopped) {
          status = 'unavailable';
          issue = 'CONTROL_READ_FAILED';
          await drain();
          log('SUPERVISOR_CONTROL_UNAVAILABLE: intake stopped; verify login and migration 009.');
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
    status = 'stopping';
    cancel(timer);
    const drained = drain();
    stoppingPromise = Promise.resolve().then(async () => {
      await Promise.all([drained, polling?.catch(() => {})]);
      await slot.close();
      for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, signalStop);
      status = 'stopped';
    });
    return stoppingPromise;
  }
  const signalStop = () => {
    void stop();
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, signalStop);
  try {
    await refresh();
    return {
      refresh,
      stop,
      inspect,
      settled: async () => {
        await polling;
        await startup;
        await draining;
        return inspect();
      },
    };
  } catch (failure) {
    await stop();
    throw failure;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSupervisor().catch(() => {
    console.error(
      'SUPERVISOR_STOPPED: check configuration and operator access; credentials are not logged.',
    );
    process.exitCode = 1;
  });
}
