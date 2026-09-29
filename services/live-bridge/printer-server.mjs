import { createServer } from 'node:http';
import { createConnection, isIP } from 'node:net';
import { mkdir, open, readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import {
  DEFAULT_PRINT_OPTIONS,
  normalizePrintOptions,
  normalizeReceiptSnapshot,
} from '../../src/lib/print-bridge.js';
import { atomicJson, serialized } from './storage.mjs';
import { renderReceiptRaster } from './raster.mjs';

const attemptPattern = /^[a-zA-Z0-9_-]{1,100}$/u;
const defaults = ['http://localhost:2000', 'http://127.0.0.1:2000'];
const fail = (code, status = 400) => Object.assign(new Error(code), { code, status });
export function privatePrinterIp(value) {
  if (isIP(value) !== 4) return false;
  const [a, b, c, d] = value.split('.').map(Number);
  return (
    d !== 0 &&
    d !== 255 &&
    (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))
  );
}
export function printerConfig(env = process.env) {
  const port = Number(env.BRIDGE_PORT || 47831);
  const printerPort = Number(env.PRINTER_LAN_PORT || 9100);
  const dryRun = env.PRINTER_DRY_RUN !== 'false';
  const origins = (env.BRIDGE_ALLOWED_ORIGINS || defaults.join(','))
    .split(',')
    .map((value) => value.trim());
  for (const value of origins) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw fail('BRIDGE_ORIGIN_CONFIG');
    }
    if (url.origin !== value || (url.protocol !== 'https:' && !defaults.includes(value)))
      throw fail('BRIDGE_ORIGIN_CONFIG');
  }
  const token = env.BRIDGE_PAIR_TOKEN || randomBytes(32).toString('base64url');
  if (!/^[A-Za-z0-9_-]{32,128}$/u.test(token)) throw fail('BRIDGE_PAIR_TOKEN_CONFIG');
  if (
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535 ||
    !Number.isInteger(printerPort) ||
    printerPort < 1 ||
    printerPort > 65535
  )
    throw fail('BRIDGE_PORT_CONFIG');
  if (!dryRun && !privatePrinterIp(env.PRINTER_LAN_IP || ''))
    throw fail('PRINTER_PRIVATE_IPV4_REQUIRED');
  return {
    port,
    printerPort,
    printerIp: env.PRINTER_LAN_IP || '',
    dryRun,
    origins,
    token,
    stateDir: resolve(fileURLToPath(new URL('./state/printer', import.meta.url))),
    executablePath: env.BRIDGE_BROWSER_EXECUTABLE || undefined,
  };
}
export async function sendPrinterBytes(bytes, { printerIp, printerPort, deadlineAt, signal }) {
  if (!privatePrinterIp(printerIp) || !Buffer.isBuffer(bytes) || bytes.length > 400000)
    throw fail('PRINTER_DESTINATION_OR_DATA');
  const remaining = (deadlineAt || Date.now() + 8000) - Date.now();
  if (signal?.aborted || remaining <= 0) throw fail('PRINTER_DEADLINE', 504);
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection({ host: printerIp, port: printerPort, signal });
    socket.setTimeout(Math.min(8000, remaining));
    socket.once('error', () => reject(fail('PRINTER_TRANSPORT_UNKNOWN', 502)));
    socket.once('timeout', () => {
      socket.destroy();
      reject(fail('PRINTER_TRANSPORT_UNKNOWN', 504));
    });
    socket.once('connect', () => {
      if (signal?.aborted || (deadlineAt && Date.now() >= deadlineAt)) {
        socket.destroy();
        reject(fail('PRINTER_DEADLINE', 504));
        return;
      }
      socket.end(bytes, () => resolvePromise());
    });
  });
}
const publicJob = (job, replayed = false) => ({
  attempt_id: job.attempt_id,
  status: job.status,
  replayed,
  paper_confirmed: false,
});

export class PrintSpool {
  constructor(config, { render = renderReceiptRaster, send = sendPrinterBytes } = {}) {
    this.config = config;
    this.render = render;
    this.send = send;
    this.jobs = new Map();
    this.serialize = serialized();
    this.transport = serialized();
  }
  async init() {
    await mkdir(this.config.stateDir, { recursive: true, mode: 0o700 });
    const files = (await readdir(this.config.stateDir)).filter((name) => name.endsWith('.json'));
    if (files.length > 5000) throw fail('PRINT_SPOOL_LIMIT', 507);
    for (const file of files) {
      const raw = await readFile(join(this.config.stateDir, file), 'utf8');
      if (raw.length > 100000) throw fail('PRINT_SPOOL_CORRUPT', 500);
      const job = JSON.parse(raw);
      if (
        !attemptPattern.test(job.attempt_id) ||
        file !== `${job.attempt_id}.json` ||
        !/^[a-f0-9]{64}$/u.test(job.hash) ||
        !['sending', 'sent', 'dry_run', 'failed', 'unknown'].includes(job.status)
      )
        throw fail('PRINT_SPOOL_CORRUPT', 500);
      if (job.status === 'sending') {
        job.status = 'unknown';
        await this.persist(job);
      }
      this.jobs.set(job.attempt_id, job);
    }
    return this;
  }
  persist(job) {
    return atomicJson(join(this.config.stateDir, `${job.attempt_id}.json`), job);
  }
  async submit(body) {
    // Includes waiting behind other jobs. Never begin TCP transmission after
    // this deadline; the browser's 20-second timeout is deliberately longer.
    const deadlineAt = Date.now() + Math.min(15000, this.config.sendDeadlineMs || 15000);
    if (
      !body ||
      !attemptPattern.test(body.attempt_id || '') ||
      ![58, 80].includes(body.paper_width)
    )
      throw fail('PRINT_REQUEST_INVALID');
    if (
      Object.keys(body).some(
        (key) => !['attempt_id', 'snapshot', 'paper_width', 'print_options'].includes(key),
      )
    )
      throw fail('PRINT_REQUEST_FIELDS');
    const snapshot = normalizeReceiptSnapshot(body.snapshot);
    const printOptions = normalizePrintOptions(body.print_options);
    const customized = Object.keys(DEFAULT_PRINT_OPTIONS).some(
      (key) => printOptions[key] !== DEFAULT_PRINT_OPTIONS[key],
    );
    // Preserve the pre-configuration hash for legacy/default jobs. Changed
    // effective settings on a non-default attempt still reject replays.
    const effectiveOptions = customized ? { print_options: printOptions } : {};
    const hash = createHash('sha256')
      .update(JSON.stringify({ snapshot, paper_width: body.paper_width, ...effectiveOptions }))
      .digest('hex');
    const reservation = await this.serialize(async () => {
      const existing = this.jobs.get(body.attempt_id);
      if (existing) {
        if (existing.hash !== hash) throw fail('PRINT_ATTEMPT_CONFLICT', 409);
        return { existing };
      }
      if (this.jobs.size >= 5000) throw fail('PRINT_SPOOL_LIMIT', 507);
      const job = {
        attempt_id: body.attempt_id,
        hash,
        status: 'sending',
        snapshot,
        paper_width: body.paper_width,
        ...effectiveOptions,
        created_at: new Date().toISOString(),
        deadline_at: new Date(deadlineAt).toISOString(),
      };
      // Persist before rendering/sending. Restart treats this state as unknown,
      // never as permission to automatically send the paper again.
      let file;
      try {
        file = await open(join(this.config.stateDir, `${job.attempt_id}.json`), 'wx', 0o600);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const prior = JSON.parse(
          await readFile(join(this.config.stateDir, `${job.attempt_id}.json`), 'utf8'),
        );
        if (prior.hash !== hash) throw fail('PRINT_ATTEMPT_CONFLICT', 409);
        this.jobs.set(prior.attempt_id, prior);
        return { existing: prior };
      }
      try {
        await file.writeFile(JSON.stringify(job) + '\n');
        await file.sync();
      } finally {
        await file.close();
      }
      this.jobs.set(job.attempt_id, job);
      return { job };
    });
    if (reservation.existing) return publicJob(reservation.existing, true);
    const { job } = reservation;
    return this.transport(async () => {
      const remaining = () => deadlineAt - Date.now();
      if (remaining() <= 0) job.status = 'failed';
      else if (this.config.dryRun) job.status = 'dry_run';
      else {
        let bytes;
        const controller = new AbortController();
        let timer;
        const expired = new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(fail('PRINTER_DEADLINE', 504));
          }, remaining());
        });
        try {
          try {
            bytes = await Promise.race([
              expired,
              this.render(snapshot, body.paper_width, {
                executablePath: this.config.executablePath,
                signal: controller.signal,
                deadlineAt,
                printOptions,
              }),
            ]);
          } catch {
            job.status = 'failed';
          }
          if (bytes && !controller.signal.aborted && remaining() > 0) {
            try {
              await Promise.race([
                expired,
                this.send(bytes, { ...this.config, deadlineAt, signal: controller.signal }),
              ]);
              job.status = 'sent';
            } catch {
              job.status = 'unknown';
            }
          } else if (bytes) job.status = 'failed';
        } finally {
          clearTimeout(timer);
          if (job.status !== 'sent') controller.abort();
        }
      }
      job.updated_at = new Date().toISOString();
      await this.persist(job);
      return publicJob(job);
    });
  }
  status(id) {
    if (!attemptPattern.test(id || '')) throw fail('PRINT_ATTEMPT_INVALID');
    const job = this.jobs.get(id);
    if (!job) throw fail('PRINT_ATTEMPT_NOT_FOUND', 404);
    return publicJob(job, true);
  }
}

export async function startPrinterServer(config, dependencies = {}) {
  const spool = await new PrintSpool(config, dependencies).init();
  let rateStart = Date.now();
  let requests = 0;
  const server = createServer(async (req, res) => {
    const json = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    try {
      if (Date.now() - rateStart >= 60000) {
        rateStart = Date.now();
        requests = 0;
      }
      if (++requests > 120) throw fail('BRIDGE_RATE_LIMIT', 429);
      const origin = req.headers.origin;
      if (!config.origins.includes(origin)) throw fail('BRIDGE_ORIGIN_DENIED', 403);
      const host = req.headers.host;
      if (
        host !== `127.0.0.1:${server.address().port}` &&
        host !== `localhost:${server.address().port}`
      )
        throw fail('BRIDGE_HOST_DENIED', 403);
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
        res.writeHead(204);
        res.end();
        return;
      }
      const supplied = Buffer.from(req.headers.authorization || '');
      const expected = Buffer.from(`Bearer ${config.token}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
        throw fail('BRIDGE_UNAUTHORIZED', 401);
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/health') {
        json(200, {
          status: 'ready',
          mode: config.dryRun ? 'dry_run' : 'lan',
          paper_confirmed: false,
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/status') {
        json(200, spool.status(url.searchParams.get('attempt_id')));
        return;
      }
      if (req.method !== 'POST' || url.pathname !== '/print') throw fail('BRIDGE_NOT_FOUND', 404);
      if (!String(req.headers['content-type'] || '').startsWith('application/json'))
        throw fail('BRIDGE_JSON_REQUIRED', 415);
      if (Number(req.headers['content-length'] || 0) > 65536) throw fail('BRIDGE_BODY_LIMIT', 413);
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 65536) throw fail('BRIDGE_BODY_LIMIT', 413);
        chunks.push(chunk);
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw fail('BRIDGE_JSON_INVALID');
      }
      json(200, await spool.submit(body));
    } catch (error) {
      if (!res.headersSent)
        json(error.status || 400, {
          error: /^[A-Z_]+$/u.test(error.code || '') ? error.code : 'BRIDGE_REQUEST_FAILED',
        });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(config.port, '127.0.0.1', resolvePromise);
  });
  return {
    server,
    spool,
    port: server.address().port,
    close: () => new Promise((resolvePromise) => server.close(resolvePromise)),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = printerConfig();
    const running = await startPrinterServer(config);
    console.log(
      `ChiDi printer bridge http://127.0.0.1:${running.port} (${config.dryRun ? 'DRY RUN — no printer traffic' : 'LAN — sent does not prove paper'})`,
    );
    console.log(`Pairing token (keep local, enter in ChiDi UI): ${config.token}`);
    for (const signal of ['SIGINT', 'SIGTERM'])
      process.on(signal, () => {
        running.close().finally(() => process.exit(0));
      });
  } catch {
    console.error(
      'BRIDGE_START_FAILED: check local configuration and spool; no credentials are logged.',
    );
    process.exitCode = 1;
  }
}
