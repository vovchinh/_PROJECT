import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runWorker } from './intake-worker.mjs';
import { acquireWorkerSlot } from './intake-core.mjs';

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
const event = {
  msgId: '90071992547409931234',
  user: { userId: '90071992547409934567', nickname: 'Khách thử' },
  comment: 'Áo xanh M 2',
};

test('Legacy direct worker handles verified STREAM_END automatically with007-compatible stopped message', async (t) => {
  const received = [];
  const f = await fixture(t, {
    ingest: async (args) => {
      received.push(...args.p_comments);
      return { inserted: args.p_comments.length, duplicates: 0 };
    },
  });
  const controller = await f.run();
  f.connection.emit('chat', event);
  f.connection.emit('streamEnd', { action: 'provider-ended' });
  await controller.stop();
  assert.equal(controller.stopReason(), 'live_ended');
  assert.equal(received[0].message_id, event.msgId);
  assert.equal(controller.pending(), 0);
  assert.equal(f.reportArgs.at(-1).p_status, 'disconnected');
  assert.equal(f.reportArgs.at(-1).p_message, 'stopped');
  assert.ok(f.calls.every((name) => name !== 'finish_tiktok_live'));
  await f.assertReleased();
});

async function fixture(t, hooks = {}) {
  const prefix = join(tmpdir(), 'chidi-worker-lifecycle-');
  const stateDir = await mkdtemp(prefix);
  const workspace = randomUUID();
  const session = randomUUID();
  const listeners = {
    SIGINT: process.listenerCount('SIGINT'),
    SIGTERM: process.listenerCount('SIGTERM'),
  };
  const originalExitCode = process.exitCode;
  const started = deferred();
  const reports = [];
  const reportArgs = [];
  const calls = [];
  let connection;
  let controller;
  class FakeConnection extends EventEmitter {
    constructor() {
      super();
      connection = this;
      this.disconnects = 0;
    }
    async connect() {
      started.resolve();
      return hooks.connect?.(this);
    }
    async disconnect() {
      this.disconnects++;
      this.emit('disconnected');
      return hooks.disconnect?.(this);
    }
  }
  const client = {
    rpc: async (name, args) => {
      calls.push(name);
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
        reportArgs.push(args);
        await hooks.report?.(args.p_status);
        reports.push(args.p_status);
        return {};
      }
      if (name === 'ingest_live_comments' && hooks.ingest) return hooks.ingest(args);
      assert.fail(`Unexpected RPC ${name}`);
    },
  };
  t.after(async () => {
    await controller?.stop();
    process.exitCode = originalExitCode;
    assert.equal(process.listenerCount('SIGINT'), listeners.SIGINT);
    assert.equal(process.listenerCount('SIGTERM'), listeners.SIGTERM);
    assert.ok(resolve(stateDir).startsWith(resolve(prefix)));
    await rm(stateDir, { recursive: true, force: true });
  });
  return {
    workspace,
    session,
    stateDir,
    reports,
    reportArgs,
    calls,
    started,
    get connection() {
      return connection;
    },
    async run() {
      controller = await runWorker(
        { LIVE_SOURCE: 'tiktok', LIVE_WORKSPACE_ID: workspace, LIVE_SESSION_ID: session },
        {
          client,
          stateDir,
          connectorModule: {
            TikTokLiveConnection: FakeConnection,
            WebcastEvent: { CHAT: 'chat', STREAM_END: 'streamEnd' },
            ControlEvent: { ERROR: 'error', DISCONNECTED: 'disconnected' },
          },
        },
      );
      return controller;
    },
    async assertReleased() {
      const replacement = await acquireWorkerSlot(workspace, session);
      await replacement.close();
    },
    async assertBusy() {
      await assert.rejects(() => acquireWorkerSlot(workspace, session), /WORKER_SLOT_BUSY/);
    },
  };
}

test('Startup disconnect waits for the original shutdown and never resumes connected reporting or retries', async (t) => {
  const connectGate = deferred();
  const reportGate = deferred();
  const finalReport = deferred();
  const f = await fixture(t, {
    connect: (connection) => {
      connection.emit('disconnected');
      return connectGate.promise;
    },
    report: (status) => {
      if (status === 'disconnected') {
        finalReport.resolve();
        return reportGate.promise;
      }
    },
  });
  let settled = false;
  const run = f.run();
  const rejected = assert.rejects(run, /PROVIDER_CONNECTION_FAILED/).then(() => {
    settled = true;
  });
  await finalReport.promise;
  connectGate.resolve({});
  await turn();
  assert.equal(
    settled,
    false,
    'Startup catch must wait for the original shutdown, not close its slot early',
  );
  await f.assertBusy();
  assert.ok(f.connection.disconnects >= 2, 'Late connection success is disconnected again');
  reportGate.resolve();
  await rejected;
  await f.assertReleased();
  // A stale 1-second flush timer would produce a connected heartbeat here.
  await new Promise((done) => setTimeout(done, 1050));
  assert.deepEqual(f.reports, ['connecting', 'disconnected']);
  assert.equal(f.calls.filter((name) => name === 'ingest_live_comments').length, 0);
});

test('Disconnect during a pending startup report drains it before publishing the final disconnected state', async (t) => {
  const connectedReport = deferred();
  const reportGate = deferred();
  const f = await fixture(t, {
    report: (status) => {
      if (status === 'connected') {
        connectedReport.resolve();
        return reportGate.promise;
      }
    },
  });
  const run = f.run();
  const rejected = assert.rejects(run, /PROVIDER_CONNECTION_FAILED/);
  await connectedReport.promise;
  f.connection.emit('disconnected');
  await turn();
  await f.assertBusy();
  assert.deepEqual(f.reports, ['connecting']);
  reportGate.resolve();
  await rejected;
  assert.deepEqual(f.reports, ['connecting', 'connected', 'disconnected']);
  await f.assertReleased();
});

test('Startup report failure removes signal listeners and releases the worker slot without connecting', async (t) => {
  let connects = 0;
  const f = await fixture(t, {
    connect: () => {
      connects++;
    },
    report: (status) => {
      if (status === 'connecting') throw Error('simulated RPC rejection');
    },
  });
  await assert.rejects(() => f.run(), /PROVIDER_CONNECTION_FAILED/);
  assert.equal(connects, 0);
  assert.deepEqual(f.reports, ['error']);
  await f.assertReleased();
});

test('Shutdown with failed pending ingest retains durable comments and stops every retry after draining', async (t) => {
  const ingestGate = deferred();
  const ingestStarted = deferred();
  const f = await fixture(t, {
    ingest: () => {
      ingestStarted.resolve();
      return ingestGate.promise;
    },
  });
  const controller = await f.run();
  f.connection.emit('chat', event);
  await controller.settled();
  const flush = controller.flushNow();
  await ingestStarted.promise;
  const stop = controller.stop();
  assert.strictEqual(controller.stop(), stop);
  await f.assertBusy();
  ingestGate.reject(Error('transport unknown'));
  await Promise.all([flush, stop]);
  assert.equal(controller.pending(), 1);
  const saved = JSON.parse(
    await readFile(join(f.stateDir, `${f.workspace}-${f.session}.json`), 'utf8'),
  );
  assert.equal(saved.items[0].message_id, event.msgId);
  await controller.flushNow();
  assert.equal(f.calls.filter((name) => name === 'ingest_live_comments').length, 1);
  assert.equal(f.reports.at(-1), 'disconnected');
  await f.assertReleased();
});
