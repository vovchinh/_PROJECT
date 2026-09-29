import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runChannelSupervisor } from './channel-supervisor.mjs';
import { probeTikTokChannel } from './tiktok-channel-provider.mjs';
import { runWorker } from './intake-worker.mjs';
import { acquireWorkerSlot, createOperatorClient } from './intake-core.mjs';

const turn = () => new Promise((done) => setImmediate(done));
const deferred = () => {
  let resolvePromise, reject;
  const promise = new Promise((done, fail) => {
    resolvePromise = done;
    reject = fail;
  });
  return { promise, resolve: resolvePromise, reject };
};
function child(gate) {
  let stopped = false,
    stopping;
  return {
    stops: 0,
    isStopped: () => stopped,
    fail: () => {
      stopped = true;
    },
    stop() {
      if (!stopping) {
        stopped = true;
        this.stops++;
        stopping = gate?.promise || Promise.resolve();
      }
      return stopping;
    },
  };
}
async function fixture(t, options = {}) {
  const wid = randomUUID(),
    cid = randomUUID(),
    sid = randomUUID(),
    token = randomUUID();
  const calls = [],
    probes = [],
    starts = [],
    children = [],
    logs = [],
    timers = new Map();
  const listeners = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  const exitCode = process.exitCode;
  let controller,
    now = 100000,
    timerId = 0;
  const state = {
    channels: [{ id: cid, username: 'chidi.shop', workspace_id: wid, is_active: true }],
    connections: [{ channel_id: cid, revision: 1, desired_state: options.desired || 'connected' }],
    readError: null,
    readGate: null,
    cleanup: [],
  };
  const client = {
    rpc: async (name, args) => {
      calls.push({ name, args });
      assert.equal(args.p_workspace_id, wid);
      if (name === 'get_tiktok_channels') {
        if (state.readError) throw state.readError;
        if (state.readGate) return state.readGate.promise;
        return structuredClone({ channels: state.channels, connections: state.connections });
      }
      const custom = await options.rpc?.(name, args);
      if (custom !== undefined) return custom;
      if (name === 'claim_tiktok_connection')
        return { lease_token: token, revision: args.p_revision };
      if (name === 'report_tiktok_connection')
        return {
          session_id: args.p_status === 'live' ? sid : null,
          status: args.p_status === 'live' ? 'LIVE' : 'OFFLINE',
        };
      if (name === 'ingest_tiktok_comments')
        return { inserted: args.p_comments.length, duplicates: 0 };
      if (name === 'finish_tiktok_live') {
        const next = (BigInt(args.p_revision) + 1n).toString();
        state.connections = state.connections.map((row) =>
          row.channel_id === args.p_channel_id
            ? { ...row, revision: next, desired_state: 'disconnected' }
            : row,
        );
        return { status: 'OFFLINE', revision: next, session_id: sid, message_code: 'live_ended' };
      }
      if (name === 'get_live_intake')
        return {
          campaigns: [{ id: 'campaign', status: 'active' }],
          sessions: [
            {
              id: sid,
              campaign_id: 'campaign',
              provider: 'tiktok_live',
              status: 'live',
              integration_account_id: cid,
              room_id: 'chidi.shop',
            },
          ],
          integration_accounts: [{ id: cid, username: 'chidi.shop', enabled: true }],
        };
      assert.fail(`Unexpected mutation ${name}`);
    },
  };
  const env = { LIVE_WORKSPACE_ID: wid }; // No session ID or TikTok handle in operator environment.
  const dependencies = {
    client,
    now: () => now,
    log: (message) => logs.push(message),
    setTimeout: (fn, ms) => {
      const id = ++timerId;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    probe: async (username, probeOptions) => {
      probes.push({ username, options: probeOptions });
      return options.probe
        ? options.probe(username, probeOptions)
        : { status: 'live', roomId: '90071992547409939999' };
    },
    runWorker: async (workerEnv, workerDependencies) => {
      starts.push({ env: workerEnv, dependencies: workerDependencies });
      if (options.start) return options.start(workerEnv, workerDependencies);
      const value = child();
      children.push(value);
      return value;
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
    wid,
    cid,
    sid,
    token,
    env,
    dependencies,
    state,
    calls,
    probes,
    starts,
    children,
    logs,
    timers,
    async run() {
      controller = await runChannelSupervisor(env, dependencies);
      return controller;
    },
    advance(ms) {
      now += ms;
    },
    request(desired, rev) {
      state.connections[0] = { channel_id: cid, revision: rev, desired_state: desired };
    },
    count(name) {
      return calls.filter((call) => call.name === name).length;
    },
  };
}

test('Workspace-only listener waits for seller intent without creating campaign/session or probing', async (t) => {
  const f = await fixture(t, { desired: 'disconnected' });
  const supervisor = await f.run();
  await supervisor.settled();
  assert.equal(f.probes.length, 0);
  assert.equal(f.starts.length, 0);
  assert.ok(
    f.calls.every(({ name }) =>
      ['get_tiktok_channels', 'report_live_listener_health'].includes(name),
    ),
  );
  assert.equal([...f.timers.values()][0].ms, 3000);
  await assert.rejects(
    () => acquireWorkerSlot(`channels:${f.wid}`, 'workspace'),
    /WORKER_SLOT_BUSY/,
  );
});

test('Offline provider creates no session/worker and does not endlessly reprobe the same request', async (t) => {
  const f = await fixture(t, { probe: async () => ({ status: 'offline', roomId: null }) });
  const supervisor = await f.run();
  await supervisor.settled();
  assert.equal(supervisor.inspect().channels[0].status, 'offline');
  assert.equal(f.starts.length, 0);
  assert.deepEqual(
    f.calls
      .filter(({ name }) => name === 'report_tiktok_connection')
      .map(({ args }) => args.p_status),
    ['offline'],
  );
  f.advance(120000);
  await supervisor.refresh();
  await supervisor.settled();
  assert.equal(f.probes.length, 1);
  f.request('connected', 2);
  await supervisor.refresh();
  await supervisor.settled();
  assert.equal(f.probes.length, 2);
});

test('Actual provider room precedes server session selection; repeat/concurrent refresh starts exactly one pinned worker', async (t) => {
  const gate = deferred();
  const f = await fixture(t, { probe: () => gate.promise });
  f.state.cleanup.push(() => gate.resolve({ status: 'live', roomId: '90071992547409939999' }));
  const supervisor = await f.run();
  await turn();
  assert.equal(f.count('claim_tiktok_connection'), 1);
  assert.equal(f.count('report_tiktok_connection'), 0);
  assert.equal(f.starts.length, 0);
  gate.resolve({ status: 'live', roomId: '90071992547409939999' });
  await supervisor.settled();
  const first = supervisor.refresh();
  assert.strictEqual(supervisor.refresh(), first);
  await first;
  await supervisor.refresh();
  assert.equal(f.starts.length, 1);
  assert.equal(f.probes.length, 1);
  assert.equal(f.starts[0].env.LIVE_SESSION_ID, f.sid);
  assert.equal(f.starts[0].dependencies.expectedProviderRoomId, '90071992547409939999');
  assert.equal(supervisor.inspect().channels[0].worker_running, true);
  assert.equal(JSON.stringify(supervisor.inspect()).includes(f.token), false);
});

test('Lease claim rejection never probes or starts worker and waits90s before retrying', async (t) => {
  const f = await fixture(t, {
    rpc: async (name) => {
      if (name === 'claim_tiktok_connection') throw Error('secret-provider-error');
    },
  });
  const supervisor = await f.run();
  await supervisor.settled();
  assert.equal(f.probes.length, 0);
  f.advance(89999);
  await supervisor.refresh();
  assert.equal(f.count('claim_tiktok_connection'), 1);
  f.advance(1);
  await supervisor.refresh();
  await supervisor.settled();
  assert.equal(f.count('claim_tiktok_connection'), 2);
  assert.ok(f.logs.every((line) => !line.includes('secret-provider-error')));
});

test('Fenced worker translates ingestion/status RPCs with exact channel revision token and session', async (t) => {
  const f = await fixture(t);
  const supervisor = await f.run();
  await supervisor.settled();
  const client = f.starts[0].dependencies.client;
  const args = { p_workspace_id: f.wid, p_session_id: f.sid };
  const input = [{ message_id: 'exact-id' }];
  await client.rpc('ingest_live_comments', { ...args, p_comments: input });
  await client.rpc('report_live_connection', {
    ...args,
    p_status: 'connected',
    p_message: 'connected',
  });
  const ingested = f.calls.find(({ name }) => name === 'ingest_tiktok_comments').args;
  assert.deepEqual(ingested, {
    ...args,
    p_comments: input,
    p_channel_id: f.cid,
    p_revision: '1',
    p_lease_token: f.token,
  });
  assert.equal(f.count('ingest_live_comments'), 0);
  assert.equal(f.count('report_live_connection'), 0);
  await assert.rejects(
    () =>
      client.rpc('ingest_live_comments', {
        ...args,
        p_session_id: randomUUID(),
        p_comments: input,
      }),
    /SCOPE_INVALID/,
  );
});

test('Superseded revision drains old worker and invalidates its writes; old control snapshots cannot reconnect', async (t) => {
  const f = await fixture(t);
  const supervisor = await f.run();
  await supervisor.settled();
  const oldClient = f.starts[0].dependencies.client;
  f.request('connected', '90071992547409931234');
  await supervisor.refresh();
  await supervisor.settled();
  assert.equal(f.children[0].stops, 1);
  assert.equal(f.starts.length, 2);
  await assert.rejects(
    () =>
      oldClient.rpc('ingest_live_comments', {
        p_workspace_id: f.wid,
        p_session_id: f.sid,
        p_comments: [],
      }),
    /SUPERSEDED/,
  );
  await f.starts[1].dependencies.client.rpc('ingest_live_comments', {
    p_workspace_id: f.wid,
    p_session_id: f.sid,
    p_comments: [],
  });
  assert.equal(
    f.calls.filter(({ name }) => name === 'ingest_tiktok_comments').at(-1).args.p_lease_token,
    f.token,
  );
  f.request('disconnected', 2);
  await supervisor.refresh();
  assert.equal(supervisor.inspect().channels[0].revision, '90071992547409931234');
  assert.equal(f.children[1].stops, 0);
});

test('New revision during a pending probe cannot report LIVE or attach the superseded worker', async (t) => {
  const gate = deferred();
  let probes = 0;
  const f = await fixture(t, {
    probe: () => (++probes === 1 ? gate.promise : { status: 'live', roomId: 'freshroom' }),
  });
  f.state.cleanup.push(() => gate.resolve({ status: 'live', roomId: 'oldroom' }));
  const supervisor = await f.run();
  await turn();
  f.request('connected', 2);
  const refresh = supervisor.refresh();
  await turn();
  assert.equal(f.probes[0].options.signal.aborted, true);
  gate.resolve({ status: 'live', roomId: 'oldroom' });
  await refresh;
  await supervisor.settled();
  const live = f.calls.filter(
    ({ name, args }) => name === 'report_tiktok_connection' && args.p_status === 'live',
  );
  assert.equal(live.length, 1);
  assert.equal(live[0].args.p_revision, '2');
  assert.equal(live[0].args.p_provider_room_id, 'freshroom');
  assert.equal(f.starts.length, 1);
});

test('Disconnect and disable drain pending work; repeated stop waits for the same drain and releases workspace slot', async (t) => {
  const gate = deferred(),
    created = child(gate);
  const f = await fixture(t, { start: async () => created });
  f.state.cleanup.push(() => gate.resolve());
  const supervisor = await f.run();
  await supervisor.settled();
  f.state.channels[0].is_active = false;
  const refresh = supervisor.refresh();
  await turn();
  assert.equal(created.stops, 1);
  const first = supervisor.stop();
  assert.strictEqual(supervisor.stop(), first);
  let stopped = false;
  first.then(() => {
    stopped = true;
  });
  await turn();
  assert.equal(stopped, false);
  gate.resolve();
  await refresh;
  await first;
  assert.equal(f.starts.length, 1);
  assert.equal(f.timers.size, 0);
  const slot = await acquireWorkerSlot(`channels:${f.wid}`, 'workspace');
  await slot.close();
});

test('Shutdown during a late probe waits cleanup and never sends LIVE or starts child', async (t) => {
  const gate = deferred();
  const f = await fixture(t, { probe: () => gate.promise });
  f.state.cleanup.push(() => gate.resolve({ status: 'live', roomId: 'late' }));
  const supervisor = await f.run();
  await turn();
  const stopping = supervisor.stop();
  assert.strictEqual(supervisor.stop(), stopping);
  gate.resolve({ status: 'live', roomId: 'late' });
  await stopping;
  assert.equal(f.probes[0].options.signal.aborted, true);
  assert.equal(f.count('report_tiktok_connection'), 0);
  assert.equal(f.starts.length, 0);
});

test('Provider failures back off and stop after five attempts until a new seller revision', async (t) => {
  const f = await fixture(t, {
    probe: async () => {
      throw Error('provider-with-secret');
    },
  });
  const supervisor = await f.run();
  await supervisor.settled();
  for (let n = 0; n < 4; n++) {
    f.advance(30000);
    await supervisor.refresh();
    await supervisor.settled();
  }
  assert.equal(f.probes.length, 5);
  assert.equal(supervisor.inspect().channels[0].status, 'blocked');
  f.advance(300000);
  await supervisor.refresh();
  assert.equal(f.probes.length, 5);
  f.request('connected', 2);
  await supervisor.refresh();
  await supervisor.settled();
  assert.equal(f.probes.length, 6);
  assert.ok(!f.logs.join('').includes('provider-with-secret'));
});

test('Stopped provider restarts once after backoff; unavailable control and cross-workspace state fail closed', async (t) => {
  const f = await fixture(t);
  const supervisor = await f.run();
  await supervisor.settled();
  f.children[0].fail();
  await supervisor.refresh();
  assert.equal(f.starts.length, 1);
  f.advance(1000);
  await supervisor.refresh();
  await supervisor.settled();
  assert.equal(f.starts.length, 2);
  f.state.channels[0].workspace_id = randomUUID();
  await supervisor.refresh();
  assert.equal(supervisor.inspect().issue, 'CHANNEL_CONTROL_UNAVAILABLE');
  assert.equal(f.children[1].stops, 1);
  assert.equal(f.starts.length, 2);
});

test('Lease rejection during ingestion aborts worker instead of continuing unfenced legacy writes', async (t) => {
  const f = await fixture(t, {
    rpc: async (name) => {
      if (name === 'ingest_tiktok_comments') throw Error('RPC_REJECTED_400');
    },
  });
  const supervisor = await f.run();
  await supervisor.settled();
  const { client, signal } = f.starts[0].dependencies;
  await assert.rejects(
    () =>
      client.rpc('ingest_live_comments', {
        p_workspace_id: f.wid,
        p_session_id: f.sid,
        p_comments: [],
      }),
    /REJECTED/,
  );
  assert.equal(signal.aborted, true);
  assert.equal(f.count('ingest_live_comments'), 0);
});

function fakeProvider(options = {}) {
  const instances = [];
  class UserOfflineError extends Error {}
  class TikTokLiveConnection extends EventEmitter {
    constructor(username, settings) {
      super();
      this.username = username;
      this.settings = settings;
      this.disconnects = 0;
      instances.push(this);
    }
    async fetchIsLive() {
      return options.isLive === undefined ? true : options.isLive;
    }
    async connect(roomId) {
      this.requestedRoom = roomId;
      options.onConnect?.(this);
      if (options.failure) throw options.failure;
      return options.connect
        ? options.connect(this)
        : { roomId: options.roomId === undefined ? '90071992547409935555' : options.roomId };
    }
    async disconnect() {
      this.disconnects++;
    }
  }
  return {
    instances,
    TikTokLiveConnection,
    UserOfflineError,
    WebcastEvent: { CHAT: 'chat', STREAM_END: 'streamEnd' },
    ControlEvent: { ERROR: 'error', DISCONNECTED: 'disconnected' },
  };
}

test('Provider adapter requires actual connection evidence, preserves string room IDs, and disconnects probe', async () => {
  const module = fakeProvider();
  const evidence = await probeTikTokChannel('chidi.shop', { connectorModule: module });
  assert.deepEqual(evidence, { status: 'live', roomId: '90071992547409935555' });
  assert.equal(module.instances[0].disconnects, 1);
  assert.equal(module.instances[0].settings.processInitialData, false);
  const offline = fakeProvider({ isLive: false });
  assert.deepEqual(await probeTikTokChannel('chidi.shop', { connectorModule: offline }), {
    status: 'offline',
    roomId: null,
  });
  assert.equal(offline.instances[0].requestedRoom, undefined);
  for (const roomId of [90071992547409935555, '', 'https://bad/room'])
    await assert.rejects(
      () => probeTikTokChannel('chidi.shop', { connectorModule: fakeProvider({ roomId }) }),
      /CHECK_FAILED/,
    );
});

test('Probe cancellation drains a late connection; unknown provider errors never become friendly offline', async () => {
  const gate = deferred(),
    abort = new AbortController();
  const module = fakeProvider({ connect: () => gate.promise });
  const promise = probeTikTokChannel('chidi.shop', {
    connectorModule: module,
    signal: abort.signal,
  });
  await turn();
  abort.abort();
  gate.resolve({ roomId: 'late' });
  await assert.rejects(() => promise, /CHECK_FAILED/);
  assert.ok(module.instances[0].disconnects >= 2);
  await assert.rejects(
    () =>
      probeTikTokChannel('chidi.shop', {
        connectorModule: fakeProvider({ failure: Error('secret') }),
      }),
    /CHECK_FAILED/,
  );
});

async function temporaryState(t) {
  const prefix = join(tmpdir(), 'chidi-channel-'),
    directory = await mkdtemp(prefix);
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(prefix)));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
const chat = {
  msgId: '90071992547409931234',
  user: { userId: '90071992547409939999', nickname: 'Khách Nguyễn' },
  comment: '49 xanh M 2',
};

test('Real durable worker buffers initial chat until exact room validation; wrong room never persists or ingests', async (t) => {
  const stateDir = await temporaryState(t);
  const module = fakeProvider({
    roomId: 'wrong-room',
    onConnect: (connection) => connection.emit('chat', chat),
  });
  const f = await fixture(t, {
    start: runWorker,
    workerDependencies: { connectorModule: module, stateDir },
  });
  const supervisor = await f.run();
  await supervisor.settled();
  assert.equal(supervisor.inspect().channels[0].status, 'backoff');
  assert.equal(f.count('ingest_tiktok_comments'), 0);
  await assert.rejects(() => readFile(join(stateDir, `${f.wid}-${f.sid}.json`), 'utf8'), {
    code: 'ENOENT',
  });
  assert.equal(module.instances[0].requestedRoom, '90071992547409939999');
});

test('Real durable worker sends exact normalized IDs through fenced RPC and awaits pending acknowledgement on shutdown', async (t) => {
  const stateDir = await temporaryState(t),
    ack = deferred();
  const module = fakeProvider({
    roomId: '90071992547409939999',
    onConnect: (connection) => connection.emit('chat', chat),
  });
  let childController;
  const f = await fixture(t, {
    workerDependencies: { connectorModule: module, stateDir },
    start: async (env, deps) => {
      childController = await runWorker(env, deps);
      return childController;
    },
    rpc: async (name) => {
      if (name === 'ingest_tiktok_comments') return ack.promise;
    },
  });
  f.state.cleanup.push(() => ack.resolve({ inserted: 1, duplicates: 0 }));
  const supervisor = await f.run();
  await supervisor.settled();
  await childController.settled();
  const flushing = childController.flushNow();
  await turn();
  const sent = f.calls.find(({ name }) => name === 'ingest_tiktok_comments').args.p_comments[0];
  assert.equal(sent.message_id, chat.msgId);
  assert.equal(sent.author_external_id, chat.user.userId);
  let stopped = false;
  const stopping = supervisor.stop().then(() => {
    stopped = true;
  });
  await turn();
  assert.equal(stopped, false);
  ack.resolve({ inserted: 1, duplicates: 0 });
  await flushing;
  await stopping;
  const persisted = JSON.parse(await readFile(join(stateDir, `${f.wid}-${f.sid}.json`), 'utf8'));
  assert.equal(persisted.items.length, 0);
  assert.equal(childController.pending(), 0);
});

test('Operator HTTP allowlist admits only channel read/claim/fenced reports/ingest and preserves narrow mutation boundary', async () => {
  const requests = [];
  const client = createOperatorClient({
    url: 'https://project.supabase.co',
    publishableKey: 'sb_publishable_fixture',
    accessToken: 'operator-fixture',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  for (const name of [
    'get_tiktok_channels',
    'claim_tiktok_connection',
    'report_tiktok_connection',
    'ingest_tiktok_comments',
  ])
    await client.rpc(name, {});
  assert.equal(requests.length, 4);
  for (const name of [
    'commit_live_sale_ticket',
    'save_tiktok_channel',
    'request_tiktok_connection',
  ])
    await assert.rejects(() => client.rpc(name, {}), /NOT_ALLOWED/);
});

test('Independent saved channels get one lifecycle each; deleting one control drains only its worker', async (t) => {
  const f = await fixture(t);
  const second = randomUUID();
  f.state.channels.push({ id: second, username: 'b', is_active: true, workspace_id: f.wid });
  f.state.connections.push({ channel_id: second, revision: 1, desired_state: 'connected' });
  const supervisor = await f.run();
  await supervisor.settled();
  assert.equal(f.starts.length, 2);
  assert.equal(f.count('claim_tiktok_connection'), 2);
  f.state.connections.shift();
  await supervisor.refresh();
  assert.equal(f.children[0].stops, 1);
  assert.equal(f.children[1].stops, 0);
  assert.equal(supervisor.inspect().channels.filter((entry) => entry.worker_running).length, 1);
});

test('Duplicate controls and unsafe numeric revisions fail closed before claims or provider calls', async (t) => {
  const f = await fixture(t, { desired: 'disconnected' });
  const supervisor = await f.run();
  f.state.connections.push({ ...f.state.connections[0] });
  await supervisor.refresh();
  assert.equal(supervisor.inspect().issue, 'CHANNEL_CONTROL_UNAVAILABLE');
  f.state.connections.pop();
  f.state.connections[0].revision = 9007199254740992;
  await supervisor.refresh();
  assert.equal(f.count('claim_tiktok_connection'), 0);
  assert.equal(f.probes.length, 0);
});

test('Shutdown during pending lease acquisition drains the request and cannot start provider after late reply', async (t) => {
  const claim = deferred();
  const f = await fixture(t, {
    rpc: async (name) => (name === 'claim_tiktok_connection' ? claim.promise : undefined),
  });
  f.state.cleanup.push(() => claim.resolve({ lease_token: f.token, revision: '1' }));
  const supervisor = await f.run();
  await turn();
  let done = false;
  const stopping = supervisor.stop().then(() => {
    done = true;
  });
  await turn();
  assert.equal(done, false);
  claim.resolve({ lease_token: f.token, revision: '1' });
  await stopping;
  assert.equal(f.probes.length, 0);
  assert.equal(f.count('report_tiktok_connection'), 0);
});

async function liveEndFixture(t, options = {}) {
  const stateDir = await temporaryState(t);
  const module = fakeProvider({ roomId: '90071992547409939999' });
  let worker;
  const f = await fixture(t, {
    workerDependencies: { connectorModule: module, stateDir },
    start: async (env, deps) => {
      worker = await runWorker(env, deps);
      return worker;
    },
    rpc: options.rpc,
  });
  const supervisor = await f.run();
  await supervisor.settled();
  return {
    ...f,
    stateDir,
    module,
    supervisor,
    get worker() {
      return worker;
    },
  };
}

test('Connected channel ingests incoming chat on its timer without a second operator approval', async (t) => {
  const ingested = deferred();
  const f = await liveEndFixture(t, {
    rpc: async (name, args) => {
      if (name === 'ingest_tiktok_comments') {
        ingested.resolve(args);
        return { inserted: 1, duplicates: 0 };
      }
    },
  });
  f.module.instances[0].emit('chat', chat);
  let timer;
  const received = await Promise.race([
    ingested.promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('AUTOMATIC_INGEST_TIMEOUT')), 3000);
    }),
  ]).finally(() => clearTimeout(timer));
  assert.equal(received.p_comments[0].message_id, chat.msgId);
  assert.equal(received.p_comments[0].author_external_id, chat.user.userId);
  assert.equal(f.starts.length, 1);
  assert.equal(f.count('finish_tiktok_live'), 0);
  await f.supervisor.stop();
});

test('Verified STREAM_END automatically finalizes once, stops late comments and never reconnects that revision', async (t) => {
  const f = await liveEndFixture(t),
    connection = f.module.instances[0];
  connection.emit('chat', chat);
  connection.emit('streamEnd', { action: 'provider-ended' });
  connection.emit('streamEnd', { action: 'provider-ended' });
  connection.emit('disconnected');
  connection.emit('chat', { ...chat, msgId: 'late-event' });
  await f.worker.stop();
  assert.equal(f.worker.stopReason(), 'live_ended');
  assert.equal(f.worker.pending(), 0);
  assert.equal(f.count('finish_tiktok_live'), 1);
  const finishing = f.calls.find(({ name }) => name === 'finish_tiktok_live').args;
  assert.equal(finishing.p_revision, '1');
  assert.equal(finishing.p_lease_token, f.token);
  assert.match(finishing.p_request_id, /^[a-f0-9-]{36}$/u);
  assert.equal(
    f.calls.find(({ name }) => name === 'ingest_tiktok_comments').args.p_comments.length,
    1,
  );
  const terminalIndex = f.calls.findIndex(({ name }) => name === 'finish_tiktok_live');
  assert.ok(
    f.calls.slice(terminalIndex + 1).every(({ name }) => name !== 'report_tiktok_connection'),
  );
  f.advance(120000);
  await f.supervisor.refresh();
  await f.supervisor.settled();
  await f.supervisor.refresh();
  assert.equal(f.probes.length, 1);
  assert.equal(f.starts.length, 1);
  assert.equal(f.supervisor.inspect().channels[0].desired_state, 'disconnected');
  f.request('connected', '3');
  await f.supervisor.refresh();
  await f.supervisor.settled();
  assert.equal(f.starts.length, 2, 'Only a new seller request may start another lifecycle');
  await f.supervisor.stop();
});

test('STREAM_END waits pending RPC acknowledgement then drains remaining accepted chat before terminal RPC', async (t) => {
  const ack = deferred();
  let batches = 0;
  const f = await liveEndFixture(t, {
    rpc: async (name) => {
      if (name === 'ingest_tiktok_comments' && ++batches === 1) return ack.promise;
    },
  });
  f.state.cleanup.push(() => ack.resolve({ inserted: 1, duplicates: 0 }));
  const connection = f.module.instances[0];
  connection.emit('chat', chat);
  await f.worker.settled();
  const flushing = f.worker.flushNow();
  await turn();
  connection.emit('chat', { ...chat, msgId: 'second-accepted' });
  connection.emit('streamEnd', { action: 'provider-ended' });
  let done = false;
  const stopping = f.worker.stop().then(() => {
    done = true;
  });
  await turn();
  const refresh = f.supervisor.refresh();
  await turn();
  assert.equal(done, false);
  assert.equal(f.count('finish_tiktok_live'), 0);
  assert.equal(
    f.starts[0].dependencies.signal.aborted,
    false,
    'Supervisor must not abort the final drain',
  );
  ack.resolve({ inserted: 1, duplicates: 0 });
  await flushing;
  await stopping;
  await refresh;
  assert.equal(f.count('ingest_tiktok_comments'), 2);
  assert.equal(f.count('finish_tiktok_live'), 1);
  assert.equal(f.worker.pending(), 0);
  assert.equal(
    f.calls.findLast(({ name }) => name !== 'get_tiktok_channels').name,
    'finish_tiktok_live',
  );
});

test('Final drain failure preserves disk queue, still reports verified end, and never retries ingestion after ending', async (t) => {
  const f = await liveEndFixture(t, {
    rpc: async (name) => {
      if (name === 'ingest_tiktok_comments') throw Error('RPC_TRANSPORT_UNKNOWN');
    },
  });
  f.module.instances[0].emit('chat', chat);
  f.module.instances[0].emit('streamEnd', { action: 'provider-ended' });
  await f.worker.stop();
  assert.equal(f.worker.pending(), 1);
  assert.equal(f.count('finish_tiktok_live'), 1);
  const queue = JSON.parse(await readFile(join(f.stateDir, `${f.wid}-${f.sid}.json`), 'utf8'));
  assert.equal(queue.items[0].message_id, chat.msgId);
  f.advance(300000);
  await f.supervisor.refresh();
  await f.supervisor.settled();
  assert.equal(f.count('ingest_tiktok_comments'), 1);
  assert.equal(f.starts.length, 1);
  assert.ok(f.logs.some((line) => line.includes('CHANNEL_END_QUEUE_PENDING')));
});

test('Unknown terminal acknowledgement retries the same request UUID without probing, generic error or restart', async (t) => {
  let finishes = 0;
  const f = await liveEndFixture(t, {
    rpc: async (name) => {
      if (name === 'finish_tiktok_live' && ++finishes === 1) throw Error('RPC_TRANSPORT_UNKNOWN');
    },
  });
  f.module.instances[0].emit('streamEnd', { action: 'provider-ended' });
  await f.worker.stop();
  assert.equal(f.supervisor.inspect().channels[0].status, 'ending');
  await f.supervisor.refresh();
  assert.equal(f.count('finish_tiktok_live'), 1);
  f.advance(1000);
  await f.supervisor.refresh();
  const requests = f.calls.filter(({ name }) => name === 'finish_tiktok_live');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].args, requests[0].args);
  assert.equal(f.starts.length, 1);
  assert.equal(f.probes.length, 1);
  assert.equal(f.supervisor.inspect().channels[0].desired_state, 'disconnected');
  assert.ok(
    f.calls
      .slice(f.calls.indexOf(requests[0]) + 1)
      .every(({ name }) => name !== 'report_tiktok_connection'),
  );
});

test('Late STREAM_END and callback from an older revision cannot terminate the new connected worker', async (t) => {
  const f = await liveEndFixture(t),
    old = f.module.instances[0],
    oldEnd = f.starts[0].dependencies.onStreamEnd;
  f.request('connected', 2);
  await f.supervisor.refresh();
  await f.supervisor.settled();
  old.emit('streamEnd', { action: 'provider-ended' });
  await oldEnd({ pending: 0 });
  assert.equal(f.count('finish_tiktok_live'), 0);
  assert.equal(f.starts.length, 2);
  assert.equal(f.worker.isStopped(), false);
  assert.equal(f.supervisor.inspect().channels[0].revision, '2');
  await f.supervisor.stop();
});

test('Network DISCONNECTED retains reconnect behavior and never invokes LIVE-ended finalization', async (t) => {
  const f = await liveEndFixture(t);
  f.module.instances[0].emit('disconnected');
  await f.worker.stop();
  assert.equal(f.worker.stopReason(), 'stopped');
  await f.supervisor.refresh();
  f.advance(1000);
  await f.supervisor.refresh();
  await f.supervisor.settled();
  assert.equal(f.count('finish_tiktok_live'), 0);
  assert.equal(f.starts.length, 2);
  await f.supervisor.stop();
});

test('STREAM_END during provider probe returns offline evidence and cannot manufacture a LIVE session', async () => {
  const module = fakeProvider({
    onConnect: (connection) => connection.emit('streamEnd', { action: 'provider-ended' }),
  });
  assert.deepEqual(await probeTikTokChannel('chidi.shop', { connectorModule: module }), {
    status: 'offline',
    roomId: null,
  });
  assert.equal(module.instances[0].disconnects, 1);
});
