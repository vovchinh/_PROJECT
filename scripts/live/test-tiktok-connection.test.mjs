import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { normalizeTikTokUsername } from '../../src/lib/tiktok-username.js';
import {
  runTikTokSmoke,
  inspectV3Event,
  classifyProviderError,
} from './test-tiktok-connection.mjs';
import { TikTokLiveConnection } from '../../services/live-bridge/node_modules/tiktok-live-connector/dist/index.js';
import {
  WebcastChatMessage,
  WebcastRoomUserSeqMessage,
  User,
  CommonMessageData,
} from '../../services/live-bridge/node_modules/tiktok-live-proto/dist/node/v3.js';

const turn = () => new Promise((done) => setImmediate(done));
function fixtures() {
  const empty = new Uint8Array();
  const chat = WebcastChatMessage.decode(empty);
  chat.common = Object.assign(CommonMessageData.decode(empty), {
    msgId: '9007199254740993111',
    createTime: String(Math.floor(Date.now() / 1000)),
  });
  chat.user = Object.assign(User.decode(empty), {
    id: '9007199254740993222',
    nickname: 'Khách fixture',
    displayId: 'private.fixture',
  });
  chat.content = 'Bình luận fixture tuyệt đối không đưa vào log';
  const viewers = Object.assign(WebcastRoomUserSeqMessage.decode(empty), {
    total: '128',
    totalUser: '999',
  });
  return {
    chat: WebcastChatMessage.decode(WebcastChatMessage.encode(chat).finish()),
    viewers: WebcastRoomUserSeqMessage.decode(WebcastRoomUserSeqMessage.encode(viewers).finish()),
  };
}
function fake(options = {}) {
  const calls = [],
    instances = [];
  class Connection extends EventEmitter {
    constructor(username) {
      super();
      this.username = username;
      instances.push(this);
    }
    async fetchIsLive() {
      calls.push('is_live');
      return options.isLive ? options.isLive(this) : true;
    }
    async fetchRoomId() {
      calls.push('room');
      return options.room ? options.room(this) : 'fixture-room';
    }
    async connect(roomId) {
      calls.push('connect');
      this.requestedRoom = roomId;
      return options.connect ? options.connect(this) : { roomId: 'fixture-room' };
    }
    async disconnect() {
      calls.push('disconnect');
      return options.disconnect?.(this);
    }
  }
  const module = {
    TikTokLiveConnection: Connection,
    WebcastEvent: {
      CHAT: 'chat',
      ROOM_USER: 'roomUser',
      MEMBER: 'member',
      STREAM_END: 'streamEnd',
    },
    ControlEvent: { ERROR: 'error', DISCONNECTED: 'disconnected' },
  };
  return {
    calls,
    instances,
    module,
    dependencies: { loadProvider: async () => ({ version: '2.5.0', module }) },
  };
}
const input = { username: ' @hoamocyb ', overallMs: 3000, stageMs: 100, observeMs: 10 };

test('Canonical helper accepts trimmed handle/@ form, keeps numeric usernames and rejects URL/blank/control inputs', () => {
  for (const value of ['@hoamocyb', 'hoamocyb', '  @hoamocyb  ', '@HOAMOCYB'])
    assert.equal(normalizeTikTokUsername(value), 'hoamocyb');
  assert.equal(normalizeTikTokUsername('@0912345678'), '0912345678');
  for (const value of [
    '',
    '   ',
    '@',
    '@@a',
    'a b',
    'a.',
    '.a',
    'https://tiktok.com/@a',
    'a\nb',
    'a'.repeat(25),
    null,
  ])
    assert.throws(() => normalizeTikTokUsername(value), /TIKTOK_USER_INVALID/);
});

test('Actual installed v3 encode/decode and postprocessor use user.id/content and total concurrent viewers', async () => {
  const { chat, viewers } = fixtures();
  assert.equal(chat.user.userId, undefined);
  assert.equal(chat.comment, undefined);
  assert.equal(viewers.viewerCount, undefined);
  assert.equal(chat.user.id, '9007199254740993222');
  const emitter = new EventEmitter();
  let received;
  emitter.on('chat', (value) => {
    received = value;
  });
  await TikTokLiveConnection.prototype.processDecodedData.call(emitter, {
    type: 'WebcastChatMessage',
    data: chat,
  });
  assert.strictEqual(received, chat);
  assert.deepEqual(inspectV3Event('chat', received), { valid: true });
  assert.deepEqual(inspectV3Event('viewer', viewers), { valid: true, count: 128 });
  assert.deepEqual(inspectV3Event('viewer', { viewerCount: 123, totalUser: '999' }), {
    valid: false,
  });
  assert.deepEqual(inspectV3Event('viewer', { total: '0' }), { valid: true, count: 0 });
  for (const total of [-1, '1.5', '9007199254740992', undefined])
    assert.equal(inspectV3Event('viewer', { total }).valid, false);
});

test('Successful isolated smoke observes real-v3-shaped events but outputs only counts/booleans and no payload/IDs', async () => {
  const { chat, viewers } = fixtures();
  const f = fake({
    connect: async (connection) => {
      connection.emit('chat', chat);
      connection.emit('roomUser', viewers);
      connection.emit('member', { user: chat.user });
      return { roomId: 'fixture-room' };
    },
  });
  const result = await runTikTokSmoke(input, f.dependencies);
  assert.equal(result.status, 'PASS');
  assert.equal(result.provider_version, '2.5.0');
  assert.equal(result.first_comment_observed, true);
  assert.equal(result.current_viewer_count, 128);
  assert.equal(result.valid_member_event_count, 1);
  assert.equal(result.disconnect_complete, true);
  assert.deepEqual(f.calls, ['is_live', 'room', 'connect', 'disconnect']);
  for (const sensitive of [chat.content, chat.user.id, chat.user.displayId, 'fixture-room'])
    assert.ok(!JSON.stringify(result).includes(sensitive));
});

test('Offline account stops before room/WebSocket; missing viewer packets remain unknown, never synthetic zero', async () => {
  const offline = fake({ isLive: async () => false });
  const result = await runTikTokSmoke(input, offline.dependencies);
  assert.equal(result.error_code, 'TIKTOK_NOT_LIVE');
  assert.deepEqual(offline.calls, ['is_live', 'disconnect']);
  assert.equal(result.current_viewer_count, null);
  assert.equal(result.first_viewer_event_observed, false);
  const noViewers = await runTikTokSmoke(input, fake().dependencies);
  assert.equal(noViewers.status, 'PASS');
  assert.equal(noViewers.current_viewer_count, null);
});

test('Stage timeout settles hanging is-live lookup and reports its exact stage with bounded cleanup', async () => {
  const f = fake({ isLive: () => new Promise(() => {}) });
  const result = await runTikTokSmoke({ ...input, stageMs: 25 }, f.dependencies);
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.error_code, 'TIKTOK_CONNECT_TIMEOUT');
  assert.equal(result.stages.find((stage) => stage.status === 'timeout').stage, 'is_live_lookup');
  assert.ok(result.duration_ms < 600);
  assert.deepEqual(f.calls, ['is_live', 'disconnect']);
});

test('Installed provider close-before-open bug cannot hang smoke beyond the external stage deadline', async () => {
  let providerSettled = false;
  const f = fake({
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
        'wss://not-contacted.invalid',
        {},
        'fixture-room',
      );
      pending.then(
        () => {
          providerSettled = true;
        },
        () => {
          providerSettled = true;
        },
      );
      setImmediate(() => socket.emit('close'));
      return pending.then(() => ({ roomId: 'fixture-room' }));
    },
  });
  const result = await runTikTokSmoke({ ...input, stageMs: 30 }, f.dependencies);
  assert.equal(
    providerSettled,
    false,
    'Installed2.5.0 removes timeout without settling on early close',
  );
  assert.equal(result.error_code, 'TIKTOK_CONNECT_TIMEOUT');
  assert.equal(
    result.stages.find((stage) => stage.status === 'timeout').stage,
    'websocket_connect',
  );
  assert.equal(result.disconnect_complete, true);
});

test('Safe error classifier separates rate/signing/network/protocol errors and never exposes remote messages', async () => {
  assert.equal(classifyProviderError({ statusCode: 429 }), 'TIKTOK_PROVIDER_RATE_LIMITED');
  assert.equal(classifyProviderError({ statusCode: 403 }), 'TIKTOK_PROVIDER_ACCESS_DENIED');
  assert.equal(
    classifyProviderError({ name: 'SignatureMissingTokensError' }),
    'TIKTOK_SIGNING_REQUIRED',
  );
  assert.equal(classifyProviderError({ code: 'ENOTFOUND' }), 'TIKTOK_PROVIDER_UNAVAILABLE');
  assert.equal(
    classifyProviderError({ name: 'SchemaDecodeError' }),
    'TIKTOK_PROVIDER_PROTOCOL_CHANGED',
  );
  const f = fake({
    room: async () => {
      throw Object.assign(Error('token=private-secret cookie=private-cookie'), { statusCode: 429 });
    },
  });
  const result = await runTikTokSmoke(input, f.dependencies);
  assert.equal(result.error_code, 'TIKTOK_PROVIDER_RATE_LIMITED');
  assert.ok(!JSON.stringify(result).includes('private-secret'));
  assert.ok(!JSON.stringify(result).includes('private-cookie'));
});

test('Malformed provider result never leaks response object; wrong room and version remain blocked', async () => {
  const f = fake({ isLive: async () => ({ raw: 'private-secret' }) });
  const result = await runTikTokSmoke(input, f.dependencies);
  assert.equal(result.error_code, 'TIKTOK_PROVIDER_PROTOCOL_CHANGED');
  assert.equal(result.is_live, null);
  assert.ok(!JSON.stringify(result).includes('private-secret'));
  const wrong = await runTikTokSmoke(
    input,
    fake({ connect: async () => ({ roomId: 'wrong' }) }).dependencies,
  );
  assert.equal(wrong.error_code, 'TIKTOK_ROOM_CHANGED');
  const version = await runTikTokSmoke(input, { loadProvider: async () => ({ version: '1.0.0' }) });
  assert.equal(version.error_code, 'TIKTOK_PROVIDER_VERSION_MISMATCH');
});

test('Late provider success after stage timeout triggers cleanup and cannot manufacture successful evidence', async () => {
  let resolveConnect;
  const f = fake({
    connect: () =>
      new Promise((done) => {
        resolveConnect = done;
      }),
  });
  const result = await runTikTokSmoke({ ...input, stageMs: 25 }, f.dependencies);
  resolveConnect({ roomId: 'fixture-room' });
  await turn();
  assert.equal(result.connected, false);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(f.calls.filter((name) => name === 'disconnect').length >= 2);
});
