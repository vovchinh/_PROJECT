import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runSupervisor } from './intake-supervisor.mjs';
import { runWorker } from './intake-worker.mjs';
import { acquireWorkerSlot, createOperatorClient } from './intake-core.mjs';

const deferred = () => {
  let resolvePromise;
  let reject;
  const promise = new Promise((done, fail) => {
    resolvePromise = done;
    reject = fail;
  });
  return { promise, resolve: resolvePromise, reject };
};
const turn = () => new Promise((done) => setImmediate(done));
function child(gate) {
  let stopped = false;
  let stopping;
  return {
    stops: 0,
    isStopped: () => stopped,
    fail: () => {
      stopped = true;
    },
    stop() {
      if (stopping) return stopping;
      stopped = true;
      this.stops++;
      stopping = gate?.promise || Promise.resolve();
      return stopping;
    },
  };
}
async function fixture(t, options = {}) {
  const w = randomUUID(),
    s = randomUUID();
  const timers = new Map(),
    calls = [],
    starts = [],
    children = [],
    logs = [];
  const listeners = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  const exitCode = process.exitCode;
  let time = 100000,
    nextTimer = 0,
    controller;
  const state = {
    operations: {
      session_controls: [
        { session_id: s, desired_state: options.desired || 'disconnected', revision: 1 },
      ],
    },
    intake: {
      campaigns: [{ id: 'campaign', status: 'active' }],
      sessions: [
        {
          id: s,
          campaign_id: 'campaign',
          provider: 'tiktok_live',
          status: 'live',
          integration_account_id: 'account',
          room_id: 'chidi.shop',
        },
      ],
      integration_accounts: [{ id: 'account', username: 'chidi.shop', enabled: true }],
    },
    readError: null,
    readGate: null,
    cleanup: [],
  };
  const env = { LIVE_SOURCE: 'tiktok', LIVE_WORKSPACE_ID: w, LIVE_SESSION_ID: s };
  const client = {
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === 'get_live_operations') {
        if (state.readError) throw state.readError;
        if (state.readGate) return state.readGate.promise;
        return structuredClone(state.operations);
      }
      if (name === 'get_live_intake') return structuredClone(state.intake);
      if (options.rpc) return options.rpc(name, args);
      assert.fail(`Supervisor may not write RPC ${name}`);
    },
  };
  const dependencies = {
    client,
    now: () => time,
    log: (message) => logs.push(message),
    setTimeout: (fn, ms) => {
      const id = ++nextTimer;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    runWorker: async (workerEnv, workerDependencies) => {
      starts.push({ env: workerEnv, dependencies: workerDependencies });
      if (options.start) return options.start(workerEnv, workerDependencies);
      const created = child();
      children.push(created);
      return created;
    },
    workerDependencies: options.workerDependencies,
  };
  t.after(async () => {
    state.cleanup.forEach((fn) => fn());
    await controller?.stop();
    process.exitCode = exitCode;
    assert.equal(process.listenerCount('SIGINT'), listeners[0]);
    assert.equal(process.listenerCount('SIGTERM'), listeners[1]);
  });
  return {
    w,
    s,
    env,
    dependencies,
    state,
    calls,
    starts,
    children,
    timers,
    logs,
    async run() {
      controller = await runSupervisor(env, dependencies);
      return controller;
    },
    request(desired, nextRevision) {
      state.operations.session_controls = [
        { session_id: s, desired_state: desired, revision: nextRevision },
      ];
    },
    advance(ms) {
      time += ms;
    },
    async busy() {
      await assert.rejects(() => acquireWorkerSlot(`supervisor:${w}`, s), /WORKER_SLOT_BUSY/);
    },
    async released() {
      const slot = await acquireWorkerSlot(`supervisor:${w}`, s);
      await slot.close();
    },
  };
}

test('Missing/disconnected desired state waits without starting or synthesizing connected status', async (t) => {
  const f = await fixture(t);
  const supervisor = await f.run();
  assert.equal(supervisor.inspect().status, 'waiting');
  f.state.operations.session_controls = [];
  await supervisor.refresh();
  assert.equal(f.starts.length, 0);
  assert.ok(f.calls.every(({ name }) => ['get_live_operations', 'get_live_intake'].includes(name)));
  assert.equal([...f.timers.values()][0].ms, 3000);
  await f.busy();
});

test('Connected intent starts exactly one worker; repeated and concurrent refreshes cannot duplicate it', async (t) => {
  const f = await fixture(t, { desired: 'connected' });
  const supervisor = await f.run();
  await supervisor.settled();
  assert.equal(supervisor.inspect().worker_running, true);
  const first = supervisor.refresh();
  assert.strictEqual(supervisor.refresh(), first);
  await first;
  await supervisor.refresh();
  f.request('connected', 2);
  await supervisor.refresh();
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].env.LIVE_WORKSPACE_ID, f.w);
  assert.equal(f.starts[0].dependencies.client, f.dependencies.client);
  assert.equal(supervisor.inspect().revision, '2');
});

test('Requested disconnect awaits child drain and keeps the supervisor available for a later revision', async (t) => {
  const drainGate = deferred();
  const created = child(drainGate);
  const f = await fixture(t, { desired: 'connected', start: async () => created });
  f.state.cleanup.push(() => drainGate.resolve());
  const supervisor = await f.run();
  await supervisor.settled();
  f.request('disconnected', 2);
  let done = false;
  const refresh = supervisor.refresh().then(() => {
    done = true;
  });
  await turn();
  assert.equal(created.stops, 1);
  assert.equal(done, false);
  await f.busy();
  drainGate.resolve();
  await refresh;
  assert.equal(supervisor.inspect().worker_running, false);
  assert.equal(supervisor.inspect().status, 'waiting');
  await supervisor.refresh();
  assert.equal(f.starts.length, 1);
});

test('Ended session or disabled profile stops intake even when an older control still asks to connect', async (t) => {
  const f = await fixture(t, { desired: 'connected' });
  const supervisor = await f.run();
  await supervisor.settled();
  f.state.intake.integration_accounts[0].enabled = false;
  await supervisor.refresh();
  assert.equal(f.children[0].stops, 1);
  assert.equal(supervisor.inspect().issue, 'SESSION_NOT_ELIGIBLE');
  f.state.intake.integration_accounts[0].enabled = true;
  f.state.intake.sessions[0].status = 'ended';
  await supervisor.refresh();
  assert.equal(f.starts.length, 1);
  f.state.intake.sessions[0].status = 'live';
  f.state.intake.campaigns[0].status = 'closed';
  await supervisor.refresh();
  assert.equal(f.starts.length, 1);
});

test('Old revisions cannot reconnect after newer disconnect, including bigint revisions beyond Number precision', async (t) => {
  const f = await fixture(t);
  f.request('connected', '9007199254740993');
  const supervisor = await f.run();
  await supervisor.settled();
  f.request('disconnected', '9007199254740994');
  await supervisor.refresh();
  f.request('connected', '9007199254740993');
  await supervisor.refresh();
  assert.equal(supervisor.inspect().desired_state, 'disconnected');
  assert.equal(supervisor.inspect().revision, '9007199254740994');
  assert.equal(f.starts.length, 1);
});

test('Provider startup retries use bounded backoff and require a new revision after five failures', async (t) => {
  let failing = true;
  const f = await fixture(t, {
    desired: 'connected',
    start: async () => {
      if (failing) throw Error('provider unavailable secret');
      return child();
    },
  });
  const supervisor = await f.run();
  await supervisor.settled();
  assert.equal(supervisor.inspect().retry_count, 1);
  await supervisor.refresh();
  assert.equal(f.starts.length, 1);
  for (let failure = 2; failure <= 5; failure++) {
    f.advance(30000);
    await supervisor.refresh();
    await supervisor.settled();
    assert.equal(supervisor.inspect().retry_count, failure);
  }
  assert.equal(supervisor.inspect().status, 'blocked');
  f.advance(60000);
  await supervisor.refresh();
  assert.equal(f.starts.length, 5);
  assert.ok(!f.logs.join(' ').includes('secret'));
  failing = false;
  f.request('connected', 2);
  await supervisor.refresh();
  await supervisor.settled();
  assert.equal(f.starts.length, 6);
  assert.equal(supervisor.inspect().worker_running, true);
  assert.equal(supervisor.inspect().retry_count, 0);
});

test('Unexpected provider disconnect drains before retry, and a newer disconnect cancels the retry', async (t) => {
  const f = await fixture(t, { desired: 'connected' });
  const supervisor = await f.run();
  await supervisor.settled();
  f.children[0].fail();
  await supervisor.refresh();
  assert.equal(f.children[0].stops, 1);
  assert.equal(supervisor.inspect().status, 'backoff');
  f.advance(1000);
  await supervisor.refresh();
  await supervisor.settled();
  assert.equal(f.starts.length, 2);
  f.children[1].fail();
  await supervisor.refresh();
  f.request('disconnected', 2);
  f.advance(30000);
  await supervisor.refresh();
  assert.equal(f.starts.length, 2);
  assert.equal(supervisor.inspect().status, 'waiting');
});

test('Stop during startup aborts the worker and all stop callers wait for late connection drain', async (t) => {
  const gate = deferred(),
    drainGate = deferred(),
    created = child(drainGate);
  const f = await fixture(t, { desired: 'connected', start: () => gate.promise });
  f.state.cleanup.push(() => {
    gate.resolve(created);
    drainGate.resolve();
  });
  const supervisor = await f.run();
  const stop = supervisor.stop();
  assert.strictEqual(supervisor.stop(), stop);
  assert.equal(f.starts[0].dependencies.signal.aborted, true);
  let done = false;
  void stop.then(() => {
    done = true;
  });
  gate.resolve(created);
  await turn();
  assert.equal(created.stops, 1);
  assert.equal(done, false);
  await f.busy();
  drainGate.resolve();
  await stop;
  assert.equal(f.timers.size, 0);
  assert.equal(supervisor.inspect().status, 'stopped');
  await supervisor.refresh();
  assert.equal(f.starts.length, 1);
  await f.released();
});

test('Disconnect while startup is pending prevents attaching that old worker after it resolves', async (t) => {
  const gate = deferred(),
    created = child();
  const f = await fixture(t, { desired: 'connected', start: () => gate.promise });
  f.state.cleanup.push(() => gate.resolve(created));
  const supervisor = await f.run();
  f.request('disconnected', 2);
  const refresh = supervisor.refresh();
  await turn();
  assert.equal(f.starts[0].dependencies.signal.aborted, true);
  gate.resolve(created);
  await refresh;
  assert.equal(created.stops, 1);
  assert.equal(supervisor.inspect().worker_running, false);
  assert.equal(supervisor.inspect().revision, '2');
});

test('A late control read after supervisor stop cannot start a new worker or release its guard early', async (t) => {
  const f = await fixture(t);
  const supervisor = await f.run();
  const gate = deferred();
  f.state.readGate = gate;
  f.state.cleanup.push(() => gate.resolve({ session_controls: [] }));
  const refreshing = supervisor.refresh();
  await turn();
  const stop = supervisor.stop();
  await f.busy();
  gate.resolve({
    session_controls: [{ session_id: f.s, desired_state: 'connected', revision: 2 }],
  });
  await Promise.all([refreshing, stop]);
  assert.equal(f.starts.length, 0);
  assert.equal(f.timers.size, 0);
});

test('Unreadable or malformed controls stop intake without exposing errors or inventing observed status', async (t) => {
  const f = await fixture(t, { desired: 'connected' });
  const supervisor = await f.run();
  await supervisor.settled();
  f.state.readError = Error('private access token must never log');
  await supervisor.refresh();
  assert.equal(f.children[0].stops, 1);
  assert.equal(supervisor.inspect().status, 'unavailable');
  assert.ok(!f.logs.join(' ').includes('private access token'));
  f.state.readError = null;
  f.request('connected', Number.MAX_SAFE_INTEGER + 1);
  await supervisor.refresh();
  assert.equal(supervisor.inspect().status, 'unavailable');
  assert.equal(f.starts.length, 1);
  assert.ok(f.calls.every(({ name }) => name.startsWith('get_')));
});

test('Operator allowlist permits control reads but rejects desired-state writes and business commands', async () => {
  const names = [];
  const client = createOperatorClient({
    url: 'https://fixture.supabase.co',
    publishableKey: 'sb_publishable_fixture',
    accessToken: 'test-operator',
    fetchImpl: async (url) => {
      names.push(url);
      return { ok: true, json: async () => ({ session_controls: [] }) };
    },
  });
  await client.rpc('get_live_operations', { p_workspace_id: randomUUID() });
  assert.equal(names.length, 1);
  for (const name of [
    'request_live_connection',
    'commit_live_sale_ticket',
    'reserve_inventory',
    'claim_live_print_job',
  ])
    await assert.rejects(() => client.rpc(name, {}), /WORKER_RPC_NOT_ALLOWED/);
});

test('Real worker under supervision drains pending acknowledgement before honoring database disconnect', async (t) => {
  const prefix = join(tmpdir(), 'chidi-supervised-worker-'),
    stateDir = await mkdtemp(prefix);
  const gate = deferred(),
    ingestStarted = deferred();
  let emitter, actualWorker;
  const reports = [];
  class FakeConnection extends EventEmitter {
    constructor() {
      super();
      emitter = this;
    }
    async connect() {
      return {};
    }
    async disconnect() {
      this.emit('disconnected');
    }
  }
  const f = await fixture(t, {
    desired: 'connected',
    workerDependencies: {
      stateDir,
      connectorModule: {
        TikTokLiveConnection: FakeConnection,
        WebcastEvent: { CHAT: 'chat' },
        ControlEvent: { ERROR: 'error', DISCONNECTED: 'disconnected' },
      },
    },
    start: async (env, deps) => {
      actualWorker = await runWorker(env, deps);
      return actualWorker;
    },
    rpc: async (name, args) => {
      if (name === 'report_live_connection') {
        reports.push(args.p_status);
        return {};
      }
      if (name === 'ingest_live_comments') {
        ingestStarted.resolve();
        return gate.promise;
      }
      assert.fail('Unexpected write');
    },
  });
  f.state.cleanup.push(() => gate.resolve({ inserted: 1, duplicates: 0 }));
  t.after(async () => {
    assert.ok(resolve(stateDir).startsWith(resolve(prefix)));
    await rm(stateDir, { recursive: true, force: true });
  });
  const supervisor = await f.run();
  await supervisor.settled();
  emitter.emit('chat', {
    msgId: '90071992547409931234',
    user: { userId: '90071992547409934567', nickname: 'Khách thử' },
    comment: 'áo xanh M 2c',
  });
  await actualWorker.settled();
  const flush = actualWorker.flushNow();
  await ingestStarted.promise;
  f.request('disconnected', 2);
  let finished = false;
  const refresh = supervisor.refresh().then(() => {
    finished = true;
  });
  await turn();
  assert.equal(finished, false);
  assert.equal(actualWorker.isStopped(), true);
  await assert.rejects(() => acquireWorkerSlot(f.w, f.s), /WORKER_SLOT_BUSY/);
  gate.resolve({ inserted: 1, duplicates: 0 });
  await flush;
  await refresh;
  const saved = JSON.parse(await readFile(join(stateDir, `${f.w}-${f.s}.json`), 'utf8'));
  assert.equal(saved.items.length, 0);
  assert.deepEqual(reports, ['connecting', 'connected', 'disconnected']);
  const replacement = await acquireWorkerSlot(f.w, f.s);
  await replacement.close();
});

test('SIGTERM shares graceful stop, clears polling and releases the supervisor slot', async (t) => {
  const f = await fixture(t, { desired: 'connected' });
  const supervisor = await f.run();
  await supervisor.settled();
  process.emit('SIGTERM');
  await supervisor.stop();
  assert.equal(f.children[0].stops, 1);
  assert.equal(f.timers.size, 0);
  assert.equal(supervisor.inspect().stopped, true);
  await f.released();
});

test('Real worker aborts a pending provider connection and never reports late connected status', async (t) => {
  const prefix = join(tmpdir(), 'chidi-supervisor-startup-'),
    stateDir = await mkdtemp(prefix);
  const connected = deferred(),
    connectStarted = deferred();
  let emitter;
  const reports = [];
  class FakeConnection extends EventEmitter {
    constructor() {
      super();
      emitter = this;
      this.disconnects = 0;
    }
    async connect() {
      connectStarted.resolve();
      return connected.promise;
    }
    async disconnect() {
      this.disconnects++;
      this.emit('disconnected');
    }
  }
  const f = await fixture(t, {
    desired: 'connected',
    workerDependencies: {
      stateDir,
      connectorModule: {
        TikTokLiveConnection: FakeConnection,
        WebcastEvent: { CHAT: 'chat' },
        ControlEvent: { ERROR: 'error', DISCONNECTED: 'disconnected' },
      },
    },
    start: runWorker,
    rpc: async (name, args) => {
      assert.equal(name, 'report_live_connection');
      reports.push(args.p_status);
      return {};
    },
  });
  f.state.cleanup.push(() => connected.resolve({}));
  t.after(async () => {
    assert.ok(resolve(stateDir).startsWith(resolve(prefix)));
    await rm(stateDir, { recursive: true, force: true });
  });
  const supervisor = await f.run();
  await connectStarted.promise;
  f.request('disconnected', 2);
  const refresh = supervisor.refresh();
  await turn();
  assert.equal(f.starts[0].dependencies.signal.aborted, true);
  connected.resolve({});
  await refresh;
  // Cancellation no longer waits indefinitely for the third-party promise.
  // A late resolution schedules its own disconnect in the following microtasks.
  await turn();
  assert.deepEqual(reports, ['connecting', 'disconnected']);
  assert.ok(emitter.disconnects >= 2);
  assert.equal(supervisor.inspect().worker_running, false);
  assert.equal(supervisor.inspect().status, 'waiting');
});
