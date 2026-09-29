import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  CommentQueue,
  normalizeComment,
  normalizeTikTokComment,
  createOperatorClient,
  flushQueue,
  sessionConfiguration,
  acquireWorkerSlot,
} from './intake-core.mjs';
import { runNdjson, runWorker } from './intake-worker.mjs';
import { loginOperator } from './login-worker.mjs';

const comment = {
  message_id: '90071992547409931234',
  author_external_id: '90071992547409934567',
  author_display_name: 'Khách Nguyễn',
  text: '49 xanh m 2c',
  occurred_at: '2026-09-17T09:00:00Z',
};
async function queue(t, maxPending = 2000) {
  const prefix = join(tmpdir(), 'chidi-intake-');
  const dir = await mkdtemp(prefix);
  t.after(async () => {
    assert.ok(resolve(dir).startsWith(resolve(prefix)));
    await rm(dir, { recursive: true, force: true });
  });
  return new CommentQueue({
    file: join(dir, 'queue.json'),
    workspaceId: 'workspace-a',
    sessionId: 'session-a',
    maxPending,
  }).init();
}

test('Normalizer keeps exact large string IDs and never uses username as stable author identity', () => {
  const row = normalizeTikTokComment(
    {
      msgId: comment.message_id,
      user: {
        userId: comment.author_external_id,
        nickname: comment.author_display_name,
        uniqueId: 'display_handle',
      },
      comment: comment.text,
      common: { createTime: '1789635600' },
    },
    Date.parse('2026-09-18T00:00:00Z'),
  );
  assert.equal(row.author_external_id, comment.author_external_id);
  assert.equal(row.message_id, comment.message_id);
  assert.throws(
    () => normalizeTikTokComment({ msgId: '1', user: { uniqueId: 'handle' }, comment: '49' }),
    /INVALID_AUTHOR_ID/,
  );
  assert.throws(
    () => normalizeComment({ ...comment, message_id: Number.MAX_SAFE_INTEGER + 1 }),
    /INVALID_MESSAGE_ID/,
  );
});
test('Normalizer rejects control characters, oversized text, timezone-less/future timestamps', () => {
  assert.throws(() => normalizeComment({ ...comment, text: 'bad\u0000text' }));
  assert.throws(() => normalizeComment({ ...comment, text: 'x'.repeat(2001) }));
  assert.throws(() => normalizeComment({ ...comment, occurred_at: '2026-09-17T09:00:00' }));
  assert.throws(() => normalizeComment({ ...comment, occurred_at: '2099-01-01T00:00:00Z' }));
});
test('Durable queue survives restart, deduplicates exact events and rejects changed data without overwriting', async (t) => {
  const q = await queue(t);
  await q.enqueue(comment);
  assert.equal((await q.enqueue(comment)).duplicate, true);
  await assert.rejects(
    () => q.enqueue({ ...comment, text: 'different' }),
    /QUEUE_MESSAGE_CONFLICT/,
  );
  const restored = await new CommentQueue({
    file: q.file,
    workspaceId: q.workspaceId,
    sessionId: q.sessionId,
  }).init();
  assert.deepEqual(restored.peek(), [normalizeComment(comment)]);
  await assert.rejects(
    () => new CommentQueue({ file: q.file, workspaceId: 'other', sessionId: q.sessionId }).init(),
    /QUEUE_SCOPE_MISMATCH/,
  );
});
test('Concurrent enqueue is serialized; full queue retains all accepted comments', async (t) => {
  const q = await queue(t, 2);
  await Promise.all([q.enqueue(comment), q.enqueue({ ...comment, message_id: 'other' })]);
  await assert.rejects(() => q.enqueue({ ...comment, message_id: 'third' }), /QUEUE_FULL/);
  assert.equal(q.pending, 2);
  assert.equal(JSON.parse(await readFile(q.file, 'utf8')).items.length, 2);
});
test('Transient/rejected/invalid acknowledgement never drops queued comments; success/duplicate ack clears once', async (t) => {
  const q = await queue(t);
  await q.enqueue(comment);
  await assert.rejects(() =>
    flushQueue(q, {
      rpc: async () => {
        throw Error('offline');
      },
    }),
  );
  assert.equal(q.pending, 1);
  await assert.rejects(
    () => flushQueue(q, { rpc: async () => ({ inserted: 0, duplicates: 0 }) }),
    /INGEST_ACK_INVALID/,
  );
  assert.equal(q.pending, 1);
  await flushQueue(q, {
    rpc: async (name, args) => {
      assert.equal(name, 'ingest_live_comments');
      assert.deepEqual(args.p_comments, [normalizeComment(comment)]);
      return { inserted: 0, duplicates: 1, ids: ['persisted-id'] };
    },
  });
  assert.equal(q.pending, 0);
});
test('Operator HTTP client uses authenticated RPC only, refreshes once, and rejects service keys', async () => {
  const calls = [];
  const client = createOperatorClient({
    url: 'https://chidi-test.supabase.co',
    publishableKey: 'sb_publishable_test',
    accessToken: 'short-lived-test',
    refreshToken: 'refresh-test',
    fetchImpl: async (url, request) => {
      calls.push({ url, request });
      if (calls.length === 1) return { status: 401, ok: false };
      if (url.includes('/auth/'))
        return {
          ok: true,
          json: async () => ({
            access_token: 'rotated-test',
            refresh_token: 'rotated-refresh-test',
          }),
        };
      return { ok: true, json: async () => ({ inserted: 1, duplicates: 0 }) };
    },
  });
  await client.rpc('ingest_live_comments', { p_comments: [comment] });
  assert.equal(calls.length, 3);
  assert.equal(calls[2].request.headers.Authorization, 'Bearer rotated-test');
  assert.equal(calls[0].request.redirect, 'error');
  await assert.rejects(() => client.rpc('commit_live_sale_ticket', {}), /WORKER_RPC_NOT_ALLOWED/);
  assert.throws(
    () =>
      createOperatorClient({
        url: 'https://chidi-test.supabase.co',
        publishableKey: 'sb_secret_invalid',
        accessToken: 'x',
      }),
    /PUBLISHABLE_KEY_REQUIRED/,
  );
  const serviceJwt = `x.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.x`;
  assert.throws(
    () =>
      createOperatorClient({
        url: 'https://chidi-test.supabase.co',
        publishableKey: 'sb_publishable_test',
        accessToken: serviceJwt,
      }),
    /OPERATOR_SESSION_REQUIRED/,
  );
});
test('Session discovery enforces enabled canonical TikTok profile or explicit manual simulator session', async () => {
  const state = {
    campaigns: [{ id: 'c1', status: 'active' }],
    sessions: [
      {
        id: 's1',
        campaign_id: 'c1',
        provider: 'tiktok_live',
        status: 'live',
        integration_account_id: 'a1',
        room_id: 'chidi.shop',
      },
    ],
    integration_accounts: [{ id: 'a1', enabled: true, username: 'chidi.shop' }],
  };
  const client = { rpc: async () => state };
  assert.equal((await sessionConfiguration(client, 'w', 's1', 'tiktok')).username, 'chidi.shop');
  await assert.rejects(
    () => sessionConfiguration(client, 'w', 's1', 'ndjson'),
    /SIMULATOR_REQUIRES_NON_TIKTOK_SESSION/,
  );
  state.integration_accounts[0].enabled = false;
  await assert.rejects(
    () => sessionConfiguration(client, 'w', 's1', 'tiktok'),
    /TIKTOK_PROFILE_MISMATCH/,
  );
  state.sessions[0].provider = 'manual';
  assert.equal((await sessionConfiguration(client, 'w', 's1', 'ndjson')).session.id, 's1');
  state.sessions[0].provider = 'simulator';
  assert.equal((await sessionConfiguration(client, 'w', 's1', 'ndjson')).session.id, 's1');
});
test('A second local worker cannot open the same queue scope until the first releases its slot', async () => {
  const scope = `worker-test-${process.pid}-${Date.now()}`;
  const slot = await acquireWorkerSlot(scope, 'session');
  try {
    await assert.rejects(
      () => acquireWorkerSlot(scope.toUpperCase(), 'SESSION'),
      /WORKER_SLOT_BUSY/,
    );
  } finally {
    await slot.close();
  }
  const reopened = await acquireWorkerSlot(scope, 'session');
  await reopened.close();
});
test('Worker shutdown holds its process guard until in-flight ingest acknowledgement is persisted', async (t) => {
  const q = await queue(t);
  const workspace = randomUUID();
  const session = randomUUID();
  let emitter;
  let acknowledge;
  let markStarted;
  const started = new Promise((done) => {
    markStarted = done;
  });
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
  const client = {
    rpc: async (name, args) => {
      if (name === 'get_live_intake')
        return {
          campaigns: [{ id: 'campaign', status: 'active' }],
          sessions: [
            {
              id: session,
              campaign_id: 'campaign',
              status: 'live',
              provider: 'tiktok_live',
              integration_account_id: 'account',
              room_id: 'chidi.shop',
            },
          ],
          integration_accounts: [{ id: 'account', enabled: true, username: 'chidi.shop' }],
        };
      if (name === 'report_live_connection') {
        reports.push(args.p_status);
        return {};
      }
      if (name === 'ingest_live_comments') {
        markStarted();
        return new Promise((done) => {
          acknowledge = done;
        });
      }
      assert.fail('unexpected RPC');
    },
  };
  const controller = await runWorker(
    {
      LIVE_SOURCE: 'tiktok',
      LIVE_WORKSPACE_ID: workspace.toUpperCase(),
      LIVE_SESSION_ID: session.toUpperCase(),
    },
    {
      client,
      stateDir: resolve(q.file, '..'),
      connectorModule: {
        TikTokLiveConnection: FakeConnection,
        WebcastEvent: { CHAT: 'chat' },
        ControlEvent: { ERROR: 'error', DISCONNECTED: 'disconnected' },
      },
    },
  );
  t.after(async () => {
    acknowledge?.({ inserted: 1, duplicates: 0 });
    await controller.stop();
  });
  emitter.emit('chat', {
    msgId: comment.message_id,
    user: { userId: comment.author_external_id, nickname: comment.author_display_name },
    comment: comment.text,
  });
  await controller.settled();
  assert.equal(controller.pending(), 1);
  const flushing = controller.flushNow();
  await started;
  const stopping = controller.stop();
  const stoppingAgain = controller.stop();
  assert.strictEqual(stoppingAgain, stopping, 'All stop callers share the complete drain');
  let finished = false;
  void stoppingAgain.then(() => {
    finished = true;
  });
  await new Promise((done) => setImmediate(done));
  assert.equal(finished, false, 'A repeated stop cannot finish while acknowledgement is pending');
  emitter.emit('chat', {
    msgId: 'late-comment',
    user: { userId: comment.author_external_id, nickname: comment.author_display_name },
    comment: comment.text,
  });
  assert.equal(
    JSON.parse(await readFile(resolve(q.file, '..', `${workspace}-${session}.json`), 'utf8')).items
      .length,
    1,
  );
  await assert.rejects(() => acquireWorkerSlot(workspace, session), /WORKER_SLOT_BUSY/);
  acknowledge({ inserted: 1, duplicates: 0 });
  await flushing;
  await stopping;
  assert.equal(controller.pending(), 0);
  assert.equal(
    JSON.parse(await readFile(resolve(q.file, '..', `${workspace}-${session}.json`), 'utf8')).items
      .length,
    0,
  );
  await controller.flushNow();
  assert.strictEqual(controller.stop(), stopping);
  assert.equal(reports.at(-1), 'disconnected');
  assert.equal(reports.filter((value) => value === 'connected').length, 1);
  const replacement = await acquireWorkerSlot(workspace, session);
  await replacement.close();
});
test('NDJSON simulator feeds normalized comments through the same queue/RPC without TikTok or cloud', async (t) => {
  const q = await queue(t);
  const batches = [];
  await runNdjson(new URL('./fixtures/comments.ndjson', import.meta.url), q, {
    rpc: async (name, args) => {
      assert.equal(name, 'ingest_live_comments');
      batches.push(args.p_comments);
      return { inserted: args.p_comments.length, duplicates: 0 };
    },
  });
  assert.equal(batches.flat().length, 2);
  assert.equal(q.pending, 0);
  assert.ok(batches.flat().every((row) => typeof row.author_external_id === 'string'));
});
test('Interactive-login backend obtains a normal operator session without storing password or printing tokens', async () => {
  let calls = 0;
  const session = await loginOperator({
    url: 'https://chidi-test.supabase.co',
    publishableKey: 'sb_publishable_test',
    email: 'owner@example.test',
    password: 'test-only-password',
    fetchImpl: async (url, request) => {
      calls++;
      assert.ok(url.endsWith('/auth/v1/token?grant_type=password'));
      assert.equal(request.redirect, 'error');
      return {
        ok: true,
        json: async () => ({ access_token: 'test-access', refresh_token: 'test-refresh' }),
      };
    },
  });
  assert.deepEqual(session, { accessToken: 'test-access', refreshToken: 'test-refresh' });
  assert.equal(calls, 1);
});
