import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CommentQueue, normalizeTikTokComment, providerTime } from './intake-core.mjs';
import {
  LiveEventQueue,
  normalizeLiveEvent,
  normalizeTikTokEvent,
  flushLiveEvents,
} from './live-events.mjs';
import { runNdjson, runWorker } from './intake-worker.mjs';
import { probeTikTokChannel } from './tiktok-channel-provider.mjs';
import { boundedProvider, closeProvider, providerErrorCode } from './provider-safety.mjs';
import { createListenerHealth } from './listener-health.mjs';
import { runChannelSupervisor } from './channel-supervisor.mjs';
import {
  WebcastChatMessage,
  WebcastRoomUserSeqMessage,
  WebcastMemberMessage,
  User,
  CommonMessageData,
} from './node_modules/tiktok-live-proto/dist/node/v3.js';
import { TikTokLiveConnection } from './node_modules/tiktok-live-connector/dist/index.js';

const occurredAt = '2026-09-25T00:00:00.000Z';
const now = Date.parse('2026-09-26T00:00:00Z');
const turn = () => new Promise((done) => setImmediate(done));
const deferred = () => {
  let resolvePromise, reject;
  const promise = new Promise((done, fail) => {
    resolvePromise = done;
    reject = fail;
  });
  return { promise, resolve: resolvePromise, reject };
};
const common = (id = '9007199254740993123') =>
  Object.assign(CommonMessageData.decode(new Uint8Array()), {
    msgId: id,
    createTime: String(Date.parse(occurredAt) / 1000),
  });
const user = () =>
  Object.assign(User.decode(new Uint8Array()), {
    id: '9007199254740993987',
    nickname: 'Khách Nguyễn',
    displayId: 'fixture.private',
  });
function packets() {
  const empty = new Uint8Array();
  const chat = Object.assign(WebcastChatMessage.decode(empty), {
    common: common(),
    user: user(),
    content: '49 xanh M 2 chiếc',
  });
  const viewer = Object.assign(WebcastRoomUserSeqMessage.decode(empty), {
    common: common('viewer-1'),
    total: '0',
    totalUser: '999',
  });
  // Protobuf message IDs are uint64 strings; keep the round-trip fixture numeric.
  viewer.common.msgId = '9007199254740993124';
  const member = Object.assign(WebcastMemberMessage.decode(empty), {
    common: common('9007199254740993125'),
    user: user(),
  });
  return {
    chat: WebcastChatMessage.decode(WebcastChatMessage.encode(chat).finish()),
    viewer: WebcastRoomUserSeqMessage.decode(WebcastRoomUserSeqMessage.encode(viewer).finish()),
    member: WebcastMemberMessage.decode(WebcastMemberMessage.encode(member).finish()),
  };
}
const viewerEvent = (id = 'shared', count = 0) => ({
  type: 'VIEWER_COUNT',
  event_id: id,
  occurred_at: occurredAt,
  viewer_count: count,
});
const memberEvent = (id = 'shared') => ({
  type: 'MEMBER_JOIN',
  event_id: id,
  occurred_at: occurredAt,
});
async function temporary(t) {
  const prefix = join(tmpdir(), 'chidi-live-runtime-');
  const directory = await mkdtemp(prefix);
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(prefix)));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
async function queues(t, options = {}) {
  const directory = await temporary(t),
    workspaceId = randomUUID(),
    sessionId = randomUUID();
  const config = { file: join(directory, 'events.json'), workspaceId, sessionId, ...options };
  return {
    directory,
    config,
    events: await new LiveEventQueue(config).init(),
    comments: await new CommentQueue({ ...config, file: join(directory, 'comments.json') }).init(),
  };
}

test('Installed v3 protobuf chat round trip normalizes exact string IDs and Vietnamese content through the actual postprocessor', async () => {
  const { chat } = packets();
  const emitter = new EventEmitter();
  let received;
  emitter.on('chat', (value) => {
    received = value;
  });
  await TikTokLiveConnection.prototype.processDecodedData.call(emitter, {
    type: 'WebcastChatMessage',
    data: chat,
  });
  assert.equal(received.comment, undefined);
  assert.equal(received.user.userId, undefined);
  assert.deepEqual(normalizeTikTokComment(received, now), {
    message_id: '9007199254740993123',
    author_external_id: '9007199254740993987',
    author_display_name: 'Khách Nguyễn',
    text: '49 xanh M 2 chiếc',
    occurred_at: occurredAt,
  });
});

test('Legacy aliases and long exact IDs remain compatible; conflicting IDs or text are rejected before ingestion', () => {
  const id = '9'.repeat(80);
  const legacy = {
    msgId: id,
    user: { userId: id, nickname: 'Khách cũ' },
    comment: 'Áo xanh',
    createTime: Date.parse(occurredAt) / 1000,
  };
  assert.equal(normalizeTikTokComment(legacy, now).message_id, id);
  const both = {
    ...legacy,
    common: { msgId: id, createTime: legacy.createTime },
    user: { ...legacy.user, id },
    content: legacy.comment,
  };
  assert.equal(normalizeTikTokComment(both, now).author_external_id, id);
  assert.throws(
    () => normalizeTikTokComment({ ...both, common: { ...both.common, msgId: 'different' } }, now),
    /MESSAGE_ID_CONFLICT/,
  );
  assert.throws(
    () => normalizeTikTokComment({ ...both, user: { ...both.user, id: 'different' } }, now),
    /AUTHOR_ID_CONFLICT/,
  );
  assert.throws(
    () => normalizeTikTokComment({ ...both, content: 'different' }, now),
    /TEXT_CONFLICT/,
  );
  assert.throws(
    () => normalizeTikTokComment({ ...legacy, msgId: 9007199254740992 }, now),
    /INVALID_MESSAGE_ID/,
  );
  assert.throws(
    () => normalizeTikTokComment({ ...legacy, user: { userId: 123, nickname: 'Khách' } }, now),
    /INVALID_AUTHOR_ID/,
  );
});

test('Provider timestamps reject unsafe numbers, overflow, conflicting aliases and dates outside the accepted event window', () => {
  assert.equal(providerTime({ common: { createTime: '1790294400' } }, now), occurredAt);
  assert.equal(providerTime({}, now), new Date(now).toISOString());
  for (const createTime of [Number.MAX_SAFE_INTEGER + 1, '99999999999999999999', '1.2', Infinity])
    assert.throws(() => providerTime({ createTime }, now), /INVALID_PROVIDER_TIME/);
  assert.throws(
    () => providerTime({ common: { createTime: '1000' }, createTime: '2000' }, now),
    /TIME_CONFLICT/,
  );
  const { chat } = packets();
  assert.throws(
    () =>
      normalizeTikTokComment(
        { ...chat, common: { ...chat.common, createTime: '999999999999' } },
        now,
      ),
    /INVALID_TIME/,
  );
});

test('Actual v3 viewer zero is known; cumulative totalUser never substitutes for missing concurrent total', () => {
  const { viewer } = packets();
  assert.deepEqual(
    normalizeTikTokEvent('VIEWER_COUNT', viewer, now),
    viewerEvent(viewer.common.msgId, 0),
  );
  assert.equal(
    normalizeTikTokEvent('VIEWER_COUNT', { ...viewer, total: '128' }, now).viewer_count,
    128,
  );
  assert.throws(
    () => normalizeTikTokEvent('VIEWER_COUNT', { common: viewer.common, totalUser: '999' }, now),
    /INVALID_VIEWER_COUNT/,
  );
  for (const total of ['2147483648', '-1', '1.2', 0, '9007199254740992'])
    assert.throws(
      () => normalizeTikTokEvent('VIEWER_COUNT', { ...viewer, total }, now),
      /INVALID_VIEWER_COUNT/,
    );
  assert.throws(
    () => normalizeTikTokEvent('VIEWER_COUNT', { ...viewer, viewerCount: 1 }, now),
    /VIEWER_COUNT_CONFLICT/,
  );
});

test('Actual v3 member events have stable IDs/time and exclude personal provider fields from the database payload', () => {
  const { member } = packets();
  assert.deepEqual(
    normalizeTikTokEvent('MEMBER_JOIN', member, now),
    memberEvent(member.common.msgId),
  );
  assert.throws(
    () =>
      normalizeTikTokEvent('MEMBER_JOIN', { ...member, user: { ...member.user, id: 123 } }, now),
    /INVALID_AUTHOR_ID/,
  );
  assert.throws(
    () => normalizeLiveEvent({ ...memberEvent(), viewer_count: 0 }, now),
    /INVALID_LIVE_EVENT_FIELD/,
  );
  assert.throws(
    () => normalizeLiveEvent({ ...memberEvent(), username: 'private' }, now),
    /INVALID_LIVE_EVENT_FIELD/,
  );
  assert.throws(
    () => normalizeLiveEvent({ ...viewerEvent(), viewer_count: '0' }, now),
    /INVALID_VIEWER_COUNT/,
  );
});

test('Durable event keys include type so equal provider IDs can hold both viewer and member events without ACK collision', async (t) => {
  const f = await queues(t);
  await f.events.enqueue(viewerEvent());
  await f.events.enqueue(memberEvent());
  assert.equal(f.events.pending, 2);
  assert.deepEqual(await f.events.enqueue(viewerEvent()), { duplicate: true });
  await assert.rejects(() => f.events.enqueue(viewerEvent('shared', 1)), /QUEUE_MESSAGE_CONFLICT/);
  const restored = await new LiveEventQueue(f.config).init();
  assert.equal(restored.pending, 2);
  await restored.ack([viewerEvent()]);
  assert.deepEqual(restored.peek(), [memberEvent()]);
  assert.equal(f.comments.pending, 0);
  await assert.rejects(() => new CommentQueue(f.config).init(), /QUEUE_SCOPE_MISMATCH/);
});

test('Unknown or malformed event ACK retains durable records, and acknowledged retry clears them without a new member', async (t) => {
  const f = await queues(t);
  await f.events.enqueue(memberEvent('member-ack'));
  let serverCount = 0;
  const receipts = new Set();
  let calls = 0;
  const client = {
    rpc: async (name, args) => {
      assert.equal(name, 'ingest_live_events');
      assert.equal(args.p_workspace_id, f.config.workspaceId);
      calls++;
      let inserted = 0;
      for (const event of args.p_events)
        if (!receipts.has(event.event_id)) {
          receipts.add(event.event_id);
          serverCount++;
          inserted++;
        }
      if (calls === 1) throw Error('ACK transport lost after server commit');
      return { inserted, duplicates: args.p_events.length - inserted };
    },
  };
  await assert.rejects(() => flushLiveEvents(f.events, client), /ACK transport lost/);
  assert.equal(f.events.pending, 1);
  const restored = await new LiveEventQueue(f.config).init();
  await assert.rejects(
    () => flushLiveEvents(restored, { rpc: async () => ({ inserted: 0, duplicates: 0 }) }),
    /INGEST_ACK_INVALID/,
  );
  assert.equal(restored.pending, 1);
  assert.deepEqual(await flushLiveEvents(restored, client), { inserted: 0, duplicates: 1 });
  assert.equal(serverCount, 1);
  assert.equal(restored.pending, 0);
});

test('Separate telemetry queue has an enforced capacity and scope without losing an existing pending record', async (t) => {
  const f = await queues(t, { maxPending: 1 });
  await f.events.enqueue(viewerEvent());
  await assert.rejects(() => f.events.enqueue(memberEvent('next')), /QUEUE_FULL/);
  assert.deepEqual(f.events.peek(), [viewerEvent()]);
  await assert.rejects(
    () => new LiveEventQueue({ ...f.config, sessionId: randomUUID() }).init(),
    /QUEUE_SCOPE_MISMATCH/,
  );
});

test('Simulator NDJSON accepts legacy/wrapped comments plus typed telemetry and automatically uses separate authorized RPCs', async (t) => {
  const f = await queues(t),
    file = join(f.directory, 'fixture.ndjson');
  const comment = normalizeTikTokComment(packets().chat, now);
  await writeFile(
    file,
    [comment, { type: 'COMMENT', ...comment, message_id: 'wrapped' }, viewerEvent(), memberEvent()]
      .map(JSON.stringify)
      .join('\n'),
  );
  const calls = [];
  await runNdjson(
    file,
    f.comments,
    {
      rpc: async (name, args) => {
        calls.push({ name, args });
        return { inserted: (args.p_comments || args.p_events).length, duplicates: 0 };
      },
    },
    f.events,
  );
  assert.deepEqual(
    calls.map((call) => call.name),
    ['ingest_live_comments', 'ingest_live_events'],
  );
  assert.equal(calls[0].args.p_comments.length, 2);
  assert.equal(calls[0].args.p_comments[1].type, undefined);
  assert.deepEqual(calls[1].args.p_events, [viewerEvent(), memberEvent()]);
  assert.equal(f.comments.pending + f.events.pending, 0);
});

function fakeProvider(hooks = {}) {
  const instances = [];
  class Connection extends EventEmitter {
    constructor(username) {
      super();
      this.username = username;
      this.disconnects = 0;
      this.terminations = 0;
      this.wsClient = {
        terminate: () => {
          this.terminations++;
        },
      };
      instances.push(this);
    }
    async fetchIsLive() {
      return hooks.isLive ? hooks.isLive(this) : true;
    }
    async connect() {
      return hooks.connect ? hooks.connect(this) : { roomId: 'room-stable' };
    }
    async disconnect() {
      this.disconnects++;
      return hooks.disconnect?.(this);
    }
  }
  return {
    instances,
    module: {
      TikTokLiveConnection: Connection,
      ControlEvent: {
        ERROR: 'error',
        DISCONNECTED: 'disconnected',
        WEBSOCKET_DATA: 'websocketData',
      },
      WebcastEvent: {
        CHAT: 'chat',
        ROOM_USER: 'roomUser',
        MEMBER: 'member',
        STREAM_END: 'streamEnd',
      },
    },
  };
}

test('Product probe has a bounded deadline for the actual installed close-before-open promise hang', async () => {
  let originalSettled = false;
  const f = fakeProvider({
    connect: (connection) => {
      const socket = new EventEmitter();
      socket.switchRooms = () => {};
      connection.options = { authenticateWs: false };
      connection.webClient = { cookieJar: { getAnonymousCookieString: async () => '' } };
      connection._wsClientProvider = () => socket;
      connection.processProtoMessageFetchResult = () => {};
      connection.handleError = () => {};
      const pending = TikTokLiveConnection.prototype.setupWebsocket.call(
        connection,
        'wss://no-network.invalid',
        {},
        'room-stable',
      );
      pending.then(
        () => {
          originalSettled = true;
        },
        () => {
          originalSettled = true;
        },
      );
      setImmediate(() => socket.emit('close'));
      return pending.then(() => ({ roomId: 'room-stable' }));
    },
  });
  const stages = [],
    started = Date.now();
  await assert.rejects(
    () =>
      probeTikTokChannel(' @NUMERIC123 ', {
        connectorModule: f.module,
        timeoutMs: 35,
        disconnectTimeoutMs: 20,
        onDiagnostic: (value) => stages.push(value),
      }),
    (error) => error.code === 'TIKTOK_CONNECT_TIMEOUT',
  );
  assert.ok(Date.now() - started < 1000);
  assert.equal(originalSettled, false);
  assert.equal(f.instances[0].username, 'numeric123');
  assert.equal(stages.at(-1).stage, 'websocket_connect');
  assert.equal(stages.at(-1).error_code, 'TIKTOK_CONNECT_TIMEOUT');
  assert.ok(f.instances[0].disconnects >= 1);
});

test('Probe offline skips WebSocket and timeout/abort late success is disconnected without a false LIVE result', async () => {
  let connects = 0;
  const offline = fakeProvider({
    isLive: async () => false,
    connect: async () => {
      connects++;
    },
  });
  assert.deepEqual(await probeTikTokChannel('0912345678', { connectorModule: offline.module }), {
    status: 'offline',
    roomId: null,
  });
  assert.equal(connects, 0);
  const gate = deferred(),
    started = deferred(),
    controller = new AbortController();
  const f = fakeProvider({
    connect: () => {
      started.resolve();
      return gate.promise;
    },
  });
  const pending = probeTikTokChannel('chidi', {
    connectorModule: f.module,
    timeoutMs: 1000,
    signal: controller.signal,
  });
  const rejected = assert.rejects(pending, (error) => error.code === 'TIKTOK_CONNECT_TIMEOUT');
  await started.promise;
  controller.abort();
  await rejected;
  const count = f.instances[0].disconnects;
  gate.resolve({ roomId: 'room-stable' });
  await turn();
  await turn();
  assert.ok(f.instances[0].disconnects > count);
});

test('Provider cleanup bounds hanging disconnects and classifiers never confuse access denial with proven signing requirements', async () => {
  let terminated = 0;
  const started = Date.now();
  await closeProvider(
    {
      disconnect: () => new Promise(() => {}),
      wsClient: {
        terminate: () => {
          terminated++;
        },
      },
    },
    20,
  );
  assert.equal(terminated, 1);
  assert.ok(Date.now() - started < 500);
  assert.equal(providerErrorCode({ response: { status: 403 } }), 'TIKTOK_PROVIDER_ACCESS_DENIED');
  assert.equal(
    providerErrorCode({ name: 'SignatureMissingTokensError' }),
    'TIKTOK_SIGNING_REQUIRED',
  );
  assert.equal(
    providerErrorCode({ exception: { name: 'SchemaDecodeError' } }),
    'TIKTOK_PROVIDER_PROTOCOL_CHANGED',
  );
  await assert.rejects(
    () => boundedProvider(() => new Promise(() => {}), { timeoutMs: 10 }),
    (error) => error.code === 'TIKTOK_CONNECT_TIMEOUT',
  );
});

async function workerFixture(t, hooks = {}) {
  const directory = await temporary(t),
    workspaceId = randomUUID(),
    sessionId = randomUUID();
  const originalExitCode = process.exitCode,
    signalCounts = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  const provider = fakeProvider(hooks),
    calls = [],
    controllers = [];
  const client = {
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === 'get_live_intake')
        return {
          campaigns: [{ id: 'campaign', status: 'active' }],
          sessions: [
            {
              id: sessionId,
              campaign_id: 'campaign',
              status: 'live',
              provider: 'tiktok_live',
              room_id: '12345',
              integration_account_id: 'account',
            },
          ],
          integration_accounts: [{ id: 'account', enabled: true, username: '12345' }],
        };
      if (name === 'report_live_connection') return {};
      if (name === 'ingest_live_comments')
        return hooks.comments
          ? hooks.comments(args)
          : { inserted: args.p_comments.length, duplicates: 0 };
      if (name === 'ingest_live_events')
        return hooks.events
          ? hooks.events(args)
          : { inserted: args.p_events.length, duplicates: 0 };
      assert.fail(`Unexpected RPC ${name}`);
    },
  };
  t.after(async () => {
    for (const controller of controllers) await controller.stop();
    process.exitCode = originalExitCode;
    assert.deepEqual(
      [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')],
      signalCounts,
    );
  });
  return {
    directory,
    workspaceId,
    sessionId,
    provider,
    calls,
    async run(extra = {}) {
      const controller = await runWorker(
        { LIVE_SOURCE: 'tiktok', LIVE_WORKSPACE_ID: workspaceId, LIVE_SESSION_ID: sessionId },
        {
          client,
          stateDir: directory,
          connectorModule: provider.module,
          expectedProviderRoomId: 'room-stable',
          connectTimeoutMs: 50,
          disconnectTimeoutMs: 20,
          ...extra,
        },
      );
      controllers.push(controller);
      return controller;
    },
  };
}

test('Worker automatically ingests v3 comments/viewers/members after room verification, without operator approval or empty-batch telemetry', async (t) => {
  const f = await workerFixture(t),
    worker = await f.run(),
    connection = f.provider.instances[0];
  await worker.flushNow();
  assert.equal(worker.inspect().last_db_ingest_at, null);
  const p = packets();
  connection.emit('chat', p.chat);
  connection.emit('roomUser', p.viewer);
  connection.emit('member', p.member);
  await worker.settled();
  assert.equal(worker.pending(), 3);
  await worker.flushNow();
  assert.equal(worker.pending(), 0);
  const eventCall = f.calls.find((call) => call.name === 'ingest_live_events');
  assert.deepEqual(eventCall.args.p_events, [
    viewerEvent(p.viewer.common.msgId),
    memberEvent(p.member.common.msgId),
  ]);
  assert.equal(
    f.calls.find((call) => call.name === 'ingest_live_comments').args.p_comments[0].text,
    p.chat.content,
  );
  assert.ok(worker.inspect().last_db_ingest_at);
  assert.ok(f.calls.every((call) => !/ticket|payment|inventory|sale/.test(call.name)));
});

test('Worker rejects a wrong provider room before persisting or ingesting buffered telemetry', async (t) => {
  const f = await workerFixture(t, {
    connect: async (connection) => {
      connection.emit('roomUser', packets().viewer);
      return { roomId: 'wrong-room' };
    },
  });
  await assert.rejects(() => f.run(), /PROVIDER_CONNECTION_FAILED/);
  assert.equal(f.calls.filter((call) => call.name.startsWith('ingest_')).length, 0);
  await assert.rejects(
    () => readFile(join(f.directory, `${f.workspaceId}-${f.sessionId}-events.json`)),
    (error) => error.code === 'ENOENT',
  );
});

test('Worker connect timeout releases its slot and a late provider resolution is cleaned up', async (t) => {
  const gate = deferred();
  const f = await workerFixture(t, { connect: () => gate.promise });
  await assert.rejects(
    () => f.run({ connectTimeoutMs: 20 }),
    (error) => error.code === 'TIKTOK_CONNECT_TIMEOUT',
  );
  const connection = f.provider.instances[0],
    count = connection.disconnects;
  gate.resolve({ roomId: 'room-stable' });
  await turn();
  await turn();
  assert.ok(connection.disconnects > count);
  assert.equal(
    f.calls.some(
      (call) => call.name === 'report_live_connection' && call.args.p_status === 'connected',
    ),
    false,
  );
});

test('STREAM_END drains accepted comment and telemetry ACKs before terminal callback and rejects events emitted after end', async (t) => {
  const ordered = [];
  const f = await workerFixture(t, {
    comments: async (args) => {
      ordered.push('comments');
      return { inserted: args.p_comments.length, duplicates: 0 };
    },
    events: async (args) => {
      ordered.push('events');
      return { inserted: args.p_events.length, duplicates: 0 };
    },
  });
  const worker = await f.run({
      onStreamEnd: async ({ pending }) => {
        assert.equal(pending, 0);
        ordered.push('end');
      },
    }),
    connection = f.provider.instances[0],
    p = packets();
  connection.emit('chat', p.chat);
  connection.emit('roomUser', p.viewer);
  connection.emit('member', p.member);
  connection.emit('streamEnd');
  connection.emit('member', { ...p.member, common: { ...p.member.common, msgId: 'too-late' } });
  await worker.stop();
  assert.deepEqual(ordered, ['comments', 'events', 'end']);
  assert.equal(worker.pending(), 0);
  assert.equal(worker.stopReason(), 'live_ended');
  assert.equal(f.calls.find((call) => call.name === 'ingest_live_events').args.p_events.length, 2);
});

function healthFixture(options = {}) {
  const calls = [],
    timers = new Map();
  let sequence = 0,
    clock = 1000;
  const state = { ready: true, active_listener_count: 0, last_error_code: null };
  const health = createListenerHealth({
    workspaceId: randomUUID(),
    readState: () => ({ ...state }),
    now: () => clock,
    setTimeout: (fn, delay) => {
      const id = ++sequence;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    client: {
      rpc: async (name, args) => {
        calls.push({ name, args });
        if (options.rpc) return options.rpc(name, args);
        return { instance_id: args.p_instance_id, heartbeat_at: new Date(clock).toISOString() };
      },
    },
  });
  return {
    health,
    calls,
    timers,
    state,
    async tick() {
      clock += 10000;
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      assert.equal(timer.delay, 10000);
      timer.fn();
      await health.refresh();
    },
  };
}

test('Listener readiness heartbeats while idle use a stable instance UUID, disclose no account data, and publish false on stop', async () => {
  const f = healthFixture();
  await f.health.refresh();
  await f.tick();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].args.p_instance_id, f.calls[1].args.p_instance_id);
  assert.deepEqual(f.calls[0].args.p_payload, {
    ready: true,
    provider_version: '2.5.0',
    active_listener_count: 0,
    last_error_code: null,
  });
  assert.equal(f.health.inspect().health_api_available, true);
  await f.health.stop();
  assert.equal(f.calls.at(-1).args.p_payload.ready, false);
  assert.equal(f.timers.size, 0);
  assert.equal(f.health.inspect().ready, false);
});

test('Missing telemetry migration or failed health ACK does not throw or stop ingestion readiness checks; shutdown waits for in-flight heartbeat', async () => {
  const missing = healthFixture({
    rpc: async () => {
      throw Error('RPC missing012');
    },
  });
  await missing.health.refresh();
  assert.equal(missing.health.inspect().health_api_available, false);
  assert.equal(missing.timers.size, 1);
  await missing.health.stop();
  const gate = deferred();
  let attempts = 0;
  const f = healthFixture({
    rpc: async (name, args) => {
      attempts++;
      if (attempts === 1) await gate.promise;
      return { instance_id: args.p_instance_id, heartbeat_at: occurredAt };
    },
  });
  const pending = f.health.refresh(),
    stop = f.health.stop();
  assert.strictEqual(f.health.stop(), stop);
  await turn();
  assert.equal(attempts, 1);
  gate.resolve();
  await Promise.all([pending, stop]);
  assert.equal(attempts, 2);
  assert.equal(f.calls.at(-1).args.p_payload.ready, false);
  assert.equal(f.timers.size, 0);
});

async function channelFixture(t) {
  const workspaceId = randomUUID(), channelId = randomUUID(), sessionId = randomUUID(), lease = randomUUID();
  const calls = [], workers = [], timers = new Map();
  let counter = 0, controller, controlsFail = false;
  const state = { channels: [{id:channelId,username:'12345',is_active:true}], connections:[{channel_id:channelId,revision:'1',desired_state:'connected'}] };
  const client = {rpc:async(name,args) => {
    calls.push({name,args});
    if(name==='get_tiktok_channels') {if(controlsFail) throw Error('private transport detail');return structuredClone(state);}
    if(name==='claim_tiktok_connection') return {lease_token:lease,revision:args.p_revision};
    if(name==='report_tiktok_connection') return {session_id:args.p_status==='live'?sessionId:null,status:args.p_status==='live'?'LIVE':'OFFLINE'};
    if(name==='ingest_tiktok_events') return {inserted:args.p_events.length,duplicates:0};
    if(name==='report_live_listener_health') return {instance_id:args.p_instance_id,heartbeat_at:occurredAt};
    assert.fail(`Unexpected RPC ${name}`);
  }};
  t.after(async() => {await controller?.stop();});
  return {calls,workers,state,workspaceId,channelId,sessionId,lease,failControls(){controlsFail=true;},async run(){controller=await runChannelSupervisor({LIVE_WORKSPACE_ID:workspaceId},{client,log:() => {},probe:async() => ({status:'live',roomId:'room-stable'}),setTimeout:(fn,ms) => {const id=++counter;timers.set(id,{fn,ms});return id;},clearTimeout:(id) => timers.delete(id),runWorker:async(env,dependencies) => {let stopped=false;const child={isStopped:() => stopped,stop:async() => {stopped=true;}};workers.push({env,dependencies,child});return child;}});await controller.settled();return controller;}};
}

test('Channel supervisor reroutes telemetry with the captured channel revision/lease/session and fences superseded workers locally', async (t) => {
  const f=await channelFixture(t), supervisor=await f.run();
  const args={p_workspace_id:f.workspaceId,p_session_id:f.sessionId,p_events:[memberEvent()]};
  await f.workers[0].dependencies.client.rpc('ingest_live_events',args);
  const ingested=f.calls.find((call) => call.name==='ingest_tiktok_events');
  assert.deepEqual(ingested.args,{...args,p_channel_id:f.channelId,p_revision:'1',p_lease_token:f.lease});
  assert.equal(f.calls.some((call) => call.name==='ingest_live_events'),false);
  await assert.rejects(() => f.workers[0].dependencies.client.rpc('ingest_live_events',{...args,p_session_id:randomUUID()}),/CHANNEL_WORKER_SCOPE_INVALID/);
  f.state.connections[0]={channel_id:f.channelId,revision:'2',desired_state:'disconnected'};
  await supervisor.refresh();await supervisor.settled();
  await assert.rejects(() => f.workers[0].dependencies.client.rpc('ingest_live_events',args),/CHANNEL_REQUEST_SUPERSEDED/);
  assert.equal(f.calls.filter((call) => call.name==='ingest_tiktok_events').length,1);
});

test('Supervisor readiness tracks provider plus Supabase control reachability and listener count independently of printer health', async (t) => {
  const f=await channelFixture(t),supervisor=await f.run();
  assert.equal(supervisor.readiness().ready,true);
  assert.equal(supervisor.readiness().provider_initialized,true);
  assert.equal(supervisor.readiness().supabase_reachable,true);
  assert.equal(supervisor.readiness().active_listener_count,1);
  assert.equal(supervisor.readiness().health_api_available,true);
  f.failControls();await supervisor.refresh();
  assert.equal(supervisor.readiness().ready,false);
  assert.equal(supervisor.readiness().supabase_reachable,false);
  assert.equal(supervisor.readiness().active_listener_count,0);
  assert.equal(supervisor.readiness().last_error_code,'CHANNEL_CONTROL_UNAVAILABLE');
  await supervisor.stop();assert.equal(supervisor.readiness().ready,false);
  const payload=f.calls.at(-1).args.p_payload;
  assert.equal(payload.ready,false);assert.equal(payload.active_listener_count,0);
  assert.equal(JSON.stringify(payload).includes('private transport detail'),false);
});
