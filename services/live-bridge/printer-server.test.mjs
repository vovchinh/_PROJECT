import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DEFAULT_PRINT_OPTIONS, probeLanBridge } from '../../src/lib/print-bridge.js';
import {
  PrintSpool,
  printerConfig,
  privatePrinterIp,
  startPrinterServer,
} from './printer-server.mjs';
import { pixelsToEscPos, renderReceiptRaster } from './raster.mjs';

const snapshot = {
  ticket_no: 'LIVE-001',
  customer_no: '027',
  customer_name: 'Nguyễn Thị Diệu',
  campaign_name: 'ChiDi thử nghiệm',
  session_code: 'LIVE-1',
  committed_at: '2026-09-17T09:00:00Z',
  lines: [
    {
      product_id: 'p1',
      sku: 'JEAN-XANH-M',
      name: 'Quần xanh đậm',
      color: 'Xanh đậm',
      size: 'M',
      qty: 2,
      unit_price: '120000',
      line_total: '240000',
    },
  ],
  total_amount: '240000',
};
async function temporary(t) {
  const prefix = join(tmpdir(), 'chidi-printer-');
  const dir = await mkdtemp(prefix);
  t.after(async () => {
    assert.ok(resolve(dir).startsWith(resolve(prefix)));
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}
async function config(t, dryRun = true) {
  return {
    ...printerConfig({
      BRIDGE_PORT: '0',
      PRINTER_DRY_RUN: dryRun ? 'true' : 'false',
      PRINTER_LAN_IP: '192.168.1.25',
      BRIDGE_PAIR_TOKEN: 'a'.repeat(43),
    }),
    stateDir: await temporary(t),
  };
}
const body = (attempt_id = 'attempt-one') => ({ attempt_id, snapshot, paper_width: 80 });

test('Printer destination is fixed private IPv4 and origin configuration is exact', () => {
  for (const value of ['10.1.2.3', '172.16.5.6', '192.168.1.25'])
    assert.equal(privatePrinterIp(value), true);
  for (const value of [
    '127.0.0.1',
    '8.8.8.8',
    'printer.local',
    '192.168.1.255',
    '169.254.1.2',
    '::1',
  ])
    assert.equal(privatePrinterIp(value), false);
  assert.throws(() => printerConfig({ PRINTER_DRY_RUN: 'false', PRINTER_LAN_IP: '8.8.8.8' }));
  assert.throws(() => printerConfig({ BRIDGE_ALLOWED_ORIGINS: '*' }));
  assert.throws(() => printerConfig({ BRIDGE_ALLOWED_ORIGINS: 'https://chidi.example/path' }));
});
test('Dry run persists status, sends no bytes, survives restart and rejects changed attempt payload', async (t) => {
  const settings = await config(t);
  let sends = 0;
  const spool = await new PrintSpool(settings, {
    send: async () => {
      sends++;
    },
  }).init();
  assert.equal((await spool.submit(body())).status, 'dry_run');
  assert.equal((await spool.submit(body())).replayed, true);
  const restarted = await new PrintSpool(settings).init();
  assert.equal((await restarted.submit(body())).status, 'dry_run');
  await assert.rejects(
    () => restarted.submit({ ...body(), paper_width: 58 }),
    /PRINT_ATTEMPT_CONFLICT/,
  );
  await assert.rejects(
    () => restarted.submit({ ...body('different'), host: '8.8.8.8' }),
    /PRINT_REQUEST_FIELDS/,
  );
  assert.equal(sends, 0);
});
test('Legacy spool hashes survive default options and null usernames without another transmission', async (t) => {
  const settings = await config(t, false);
  const oldHash = createHash('sha256')
    .update(JSON.stringify({ snapshot, paper_width: 80 }))
    .digest('hex');
  await writeFile(
    join(settings.stateDir, 'legacy.json'),
    JSON.stringify({
      attempt_id: 'legacy',
      hash: oldHash,
      status: 'sent',
      snapshot,
      paper_width: 80,
    }),
  );
  const spool = await new PrintSpool(settings, {
    render: async () => assert.fail('Legacy receipt may not render again'),
    send: async () => assert.fail('Legacy receipt may not send again'),
  }).init();
  for (const print_options of [undefined, null, {}, DEFAULT_PRINT_OPTIONS]) {
    const result = await spool.submit({
      ...body('legacy'),
      snapshot: { ...snapshot, customer_username: null },
      print_options,
    });
    assert.equal(result.status, 'sent');
    assert.equal(result.replayed, true);
  }
  await assert.rejects(
    () => spool.submit({ ...body('legacy'), print_options: { show_price: false } }),
    /PRINT_ATTEMPT_CONFLICT/,
  );
});
test('Configured options reach raster and remain immutable across persisted attempt retries', async (t) => {
  const settings = await config(t, false);
  let renders = 0;
  let sends = 0;
  const spool = await new PrintSpool(settings, {
    render: async (receipt, width, options) => {
      renders++;
      assert.equal(receipt.customer_username, '@dieu2004');
      assert.equal(width, 58);
      assert.equal(options.printOptions.auto_cut, false);
      assert.equal(options.printOptions.font_scale_customer, 3);
      assert.equal(options.printOptions.copies, 1);
      return Buffer.from('rendered with selected template');
    },
    send: async () => {
      sends++;
    },
  }).init();
  const request = {
    ...body('configured'),
    paper_width: 58,
    snapshot: { ...snapshot, customer_username: '@dieu2004' },
    print_options: { show_price: false, font_scale_customer: 3, auto_cut: false },
  };
  assert.equal((await spool.submit(request)).status, 'sent');
  const restarted = await new PrintSpool(settings, {
    render: async () => assert.fail('Persisted configured attempt must not render'),
  }).init();
  assert.equal(
    (
      await restarted.submit({
        ...request,
        print_options: { ...DEFAULT_PRINT_OPTIONS, ...request.print_options },
      })
    ).replayed,
    true,
  );
  assert.equal(restarted.jobs.get('configured').print_options.auto_cut, false);
  await assert.rejects(
    () =>
      restarted.submit({ ...request, print_options: { ...request.print_options, auto_cut: true } }),
    /PRINT_ATTEMPT_CONFLICT/,
  );
  await assert.rejects(
    () =>
      restarted.submit({
        ...request,
        snapshot: { ...request.snapshot, customer_username: '@someone_else' },
      }),
    /PRINT_ATTEMPT_CONFLICT/,
  );
  assert.equal(renders, 1);
  assert.equal(sends, 1);
});
test('Unsupported copy counts, driver/raw template injection and invalid fonts fail before spool writes', async (t) => {
  const spool = await new PrintSpool(await config(t)).init();
  for (const print_options of [
    { copies: 2 },
    { font_scale_product: 99 },
    { font_scale_customer: '2' },
    { driver: 'TSPL' },
    { raw: 'ESC/POS' },
    { html: '<script>alert(1)</script>' },
    { show_price: 'false' },
    { auto_cut: null },
    [],
  ]) {
    await assert.rejects(() => spool.submit({ ...body(), print_options }), /PRINT_INVALID_OPTIONS/);
  }
  assert.equal(spool.jobs.size, 0);
});
test('Concurrent identical attempts produce one transport call and sent never means paper confirmed', async (t) => {
  const settings = await config(t, false);
  let sends = 0;
  const spool = await new PrintSpool(settings, {
    render: async () => Buffer.from('raster'),
    send: async () => {
      sends++;
    },
  }).init();
  const results = await Promise.all([spool.submit(body()), spool.submit(body())]);
  assert.equal(sends, 1);
  assert.ok(results.every((result) => result.paper_confirmed === false));
  assert.equal(spool.status('attempt-one').status, 'sent');
});
test('Two independently initialized spools cannot resend a completed attempt', async (t) => {
  const settings = await config(t, false);
  let sends = 0;
  const dependencies = {
    render: async () => Buffer.from('raster'),
    send: async () => {
      sends++;
    },
  };
  const first = await new PrintSpool(settings, dependencies).init();
  const second = await new PrintSpool(settings, dependencies).init();
  await first.submit(body());
  assert.equal((await second.submit(body())).replayed, true);
  assert.equal(sends, 1);
});
test('Different tickets use one transport at a time to avoid mixed paper output', async (t) => {
  const settings = await config(t, false);
  let active = 0;
  let maximum = 0;
  let sends = 0;
  const spool = await new PrintSpool(settings, {
    render: async () => Buffer.from('raster'),
    send: async () => {
      active++;
      maximum = Math.max(maximum, active);
      sends++;
      await new Promise((done) => setTimeout(done, 10));
      active--;
    },
  }).init();
  await Promise.all([spool.submit(body('first')), spool.submit(body('second'))]);
  assert.equal(sends, 2);
  assert.equal(maximum, 1);
});
test('Slow renderer cannot send after the accepted attempt deadline, even if it ignores cancellation', async (t) => {
  const settings = { ...(await config(t, false)), sendDeadlineMs: 30 };
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  let sends = 0;
  let observedSignal;
  let markStarted;
  let finishRender;
  const started = new Promise((done) => {
    markStarted = done;
  });
  const rendered = new Promise((done) => {
    finishRender = done;
  });
  const spool = await new PrintSpool(settings, {
    render: async (_snapshot, _width, options) => {
      observedSignal = options.signal;
      markStarted();
      return rendered;
    },
    send: async () => {
      sends++;
    },
  }).init();
  const submission = spool.submit(body('slow'));
  await started;
  t.mock.timers.tick(31);
  assert.equal((await submission).status, 'failed');
  finishRender(Buffer.from('late raster'));
  await new Promise((done) => setImmediate(done));
  assert.equal(observedSignal.aborted, true);
  assert.equal((await spool.submit(body('slow'))).replayed, true);
  assert.equal(sends, 0);
});
test('Expired queued ticket is never dispatched after the preceding slow render', async (t) => {
  const settings = { ...(await config(t, false)), sendDeadlineMs: 30 };
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  let sends = 0;
  let renders = 0;
  let markStarted;
  let finishRender;
  const started = new Promise((done) => {
    markStarted = done;
  });
  const rendered = new Promise((done) => {
    finishRender = done;
  });
  const spool = await new PrintSpool(settings, {
    render: async () => {
      renders++;
      markStarted();
      return rendered;
    },
    send: async () => {
      sends++;
    },
  }).init();
  const first = spool.submit(body('queued-first'));
  await started;
  const second = spool.submit(body('queued-second'));
  await spool.serialize(() => {}); // The second durable reservation is queued behind rendering.
  assert.equal(spool.jobs.size, 2);
  t.mock.timers.tick(31);
  const results = await Promise.all([first, second]);
  assert.ok(results.every((result) => result.status === 'failed'));
  assert.equal(renders, 1, 'An already expired queued ticket must not start rendering');
  finishRender(Buffer.from('late'));
  await new Promise((done) => setImmediate(done));
  const restarted = await new PrintSpool(settings, {
    render: async () => assert.fail('Expired attempts must not render on replay'),
    send: async () => {
      sends++;
    },
  }).init();
  assert.equal((await restarted.submit(body('queued-first'))).status, 'failed');
  assert.equal((await restarted.submit(body('queued-second'))).status, 'failed');
  assert.equal(sends, 0);
});
test('Uncertain transport outcome and interrupted spool never automatically resend', async (t) => {
  const settings = await config(t, false);
  let sends = 0;
  const spool = await new PrintSpool(settings, {
    render: async () => Buffer.from('raster'),
    send: async () => {
      sends++;
      throw new Error('socket timeout');
    },
  }).init();
  assert.equal((await spool.submit(body())).status, 'unknown');
  assert.equal((await spool.submit(body())).status, 'unknown');
  assert.equal(sends, 1);
  const entry = spool.jobs.get('attempt-one');
  await writeFile(
    join(settings.stateDir, 'attempt-one.json'),
    JSON.stringify({ ...entry, status: 'sending' }),
  );
  const restarted = await new PrintSpool(settings, {
    send: async () => {
      sends++;
    },
  }).init();
  assert.equal((await restarted.submit(body())).status, 'unknown');
  assert.equal(sends, 1);
});
test('Raster failure is definite before transport; corrupt spool blocks startup', async (t) => {
  const settings = await config(t, false);
  const spool = await new PrintSpool(settings, {
    render: async () => {
      throw Error('browser unavailable');
    },
    send: async () => assert.fail('must not send'),
  }).init();
  assert.equal((await spool.submit(body())).status, 'failed');
  await writeFile(join(settings.stateDir, 'bad.json'), '{');
  await assert.rejects(() => new PrintSpool(settings).init());
});
test('HTTP requires origin and pairing token for health, print and status; rejects raw payload/oversize', async (t) => {
  const settings = await config(t);
  const running = await startPrinterServer(settings);
  t.after(() => running.close());
  const base = `http://127.0.0.1:${running.port}`;
  const headers = { Origin: 'http://localhost:2000', Authorization: `Bearer ${settings.token}` };
  assert.equal((await fetch(`${base}/health`)).status, 403);
  assert.equal(
    (await fetch(`${base}/health`, { headers: { Origin: headers.Origin } })).status,
    401,
  );
  assert.equal(
    (await fetch(`${base}/health`, { headers: { ...headers, Origin: 'https://attacker.invalid' } }))
      .status,
    403,
  );
  const preflight = await fetch(`${base}/print`, {
    method: 'OPTIONS',
    headers: { Origin: headers.Origin, 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(preflight.status, 204);
  assert.equal((await (await fetch(`${base}/health`, { headers })).json()).mode, 'dry_run');
  const print = await fetch(`${base}/print`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body()),
  });
  assert.equal((await print.json()).status, 'dry_run');
  assert.equal(
    (await (await fetch(`${base}/status?attempt_id=attempt-one`, { headers })).json()).status,
    'dry_run',
  );
  assert.equal(
    (
      await fetch(`${base}/print`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body('raw'), raw: 'ESC/POS' }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(`${base}/print`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: 'x'.repeat(65537),
      })
    ).status,
    413,
  );
});
test('Health client authenticates through HTTP origin guard without rendering, sending or creating attempts', async (t) => {
  const settings = await config(t, false);
  const running = await startPrinterServer(settings, {
    render: async () => assert.fail('Health must not render a test receipt'),
    send: async () => assert.fail('Health must not contact the printer'),
  });
  t.after(() => running.close());
  const fetchWithOrigin = (url, options) =>
    fetch(url, { ...options, headers: { ...options.headers, Origin: 'http://localhost:2000' } });
  const result = await probeLanBridge({
    baseUrl: `http://127.0.0.1:${running.port}`,
    token: settings.token,
    fetchImpl: fetchWithOrigin,
  });
  assert.deepEqual(result, { status: 'ready', mode: 'lan', paper_confirmed: false });
  assert.equal(running.spool.jobs.size, 0);
  await assert.rejects(
    () =>
      probeLanBridge({
        baseUrl: `http://127.0.0.1:${running.port}`,
        token: 'x'.repeat(43),
        fetchImpl: fetchWithOrigin,
      }),
    /PRINT_BRIDGE_UNAVAILABLE/,
  );
});
test('ESC/POS raster preserves pixel positions and blends transparency onto white', () => {
  const data = Uint8Array.from([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 0]);
  const bytes = pixelsToEscPos({ width: 3, height: 1, data });
  assert.deepEqual([...bytes.subarray(5, 13)], [29, 118, 48, 0, 1, 0, 1, 0]);
  assert.equal(bytes[13], 128);
  assert.throws(() => pixelsToEscPos({ width: 577, height: 1, data }));
});
test('Disabling auto-cut retains identical raster and feed bytes without a cut command', () => {
  const image = { width: 1, height: 1, data: Uint8Array.from([0, 0, 0, 255]) };
  const cut = pixelsToEscPos(image);
  const noCut = pixelsToEscPos(image, { autoCut: false });
  assert.deepEqual(cut.subarray(-3), Buffer.from([29, 86, 0]));
  assert.deepEqual(noCut, cut.subarray(0, -3));
  assert.deepEqual(noCut.subarray(-3), Buffer.from([10, 10, 10]));
  assert.throws(() => pixelsToEscPos(image, { autoCut: 'false' }), /PRINTER_CUT_OPTION/);
});
test('Installed browser renders Vietnamese receipt into bounded ESC/POS raster without network', async () => {
  const bytes = await renderReceiptRaster(snapshot, 80);
  assert.ok(bytes.length > 1000 && bytes.length < 400000);
  assert.equal(bytes[9] + bytes[10] * 256, 72); // 576 dots / 8
  assert.ok(bytes.subarray(13, -6).some((value) => value !== 0));
});
test('Installed browser renders configured 58mm Vietnamese username, scaled fonts and no cut', async () => {
  const bytes = await renderReceiptRaster({ ...snapshot, customer_username: '@diệu2004' }, 58, {
    printOptions: {
      auto_cut: false,
      show_price: false,
      font_scale_customer: 3,
      font_scale_product: 2,
    },
  });
  assert.ok(bytes.length > 1000 && bytes.length < 400000);
  assert.equal(bytes[9] + bytes[10] * 256, 48); // 384 dots / 8
  assert.deepEqual(bytes.subarray(-3), Buffer.from([10, 10, 10]));
  assert.ok(bytes.subarray(13, -3).some((value) => value !== 0));
});
