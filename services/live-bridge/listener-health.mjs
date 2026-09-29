import { randomUUID } from 'node:crypto';
// DB-backed readiness is separate from the loopback printer HTTP health.
export function createListenerHealth({
  client,
  workspaceId,
  readState,
  now = Date.now,
  setTimeout: schedule = globalThis.setTimeout,
  clearTimeout: cancel = globalThis.clearTimeout,
  enabled = true,
}) {
  const instanceId = randomUUID(),
    started = now();
  let timer,
    pending = null,
    stopped = false,
    stopping,
    lastHeartbeat = null,
    available = null;
  const inspect = () => ({
    ...readState(),
    ready: !stopped && readState().ready,
    stopped,
    instance_id: instanceId,
    health_api_available: available,
    last_heartbeat_at: lastHeartbeat,
    uptime_ms: Math.max(0, now() - started),
  });
  const send = async (final = false) => {
    const state = readState();
    try {
      const response = await client.rpc('report_live_listener_health', {
        p_workspace_id: workspaceId,
        p_instance_id: instanceId,
        p_payload: {
          ready: !final && state.ready,
          provider_version: '2.5.0',
          active_listener_count: final ? 0 : state.active_listener_count,
          last_error_code: state.last_error_code || null,
        },
      });
      if (response?.instance_id !== instanceId || typeof response.heartbeat_at !== 'string')
        throw Error('HEALTH_ACK_INVALID');
      available = true;
      lastHeartbeat = response.heartbeat_at;
    } catch {
      available = false; /* Missing012/health failure must never stop intake. */
    }
  };
  const refresh = () => {
    if (!enabled || stopped) return Promise.resolve(inspect());
    if (pending) return pending;
    cancel(timer);
    pending = send()
      .finally(() => {
        pending = null;
        if (!stopped)
          timer = schedule(() => {
            void refresh();
          }, 10000);
      })
      .then(inspect);
    return pending;
  };
  const stop = () => {
    if (stopping) return stopping;
    stopped = true;
    cancel(timer);
    stopping = Promise.resolve().then(async () => {
      await pending;
      if (enabled) await send(true);
    });
    return stopping;
  };
  return { refresh, stop, inspect };
}
