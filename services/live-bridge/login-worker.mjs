import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOperatorClient } from './intake-core.mjs';
import { runWorker } from './intake-worker.mjs';
import { runSupervisor } from './intake-supervisor.mjs';
import { runChannelSupervisor } from './channel-supervisor.mjs';

export async function loginOperator({ url, publishableKey, email, password, fetchImpl = fetch }) {
  // Reuse URL/key safeguards before accepting or forwarding a password.
  createOperatorClient({
    url,
    publishableKey,
    accessToken: 'configuration-validation-only',
    fetchImpl,
  });
  if (typeof email !== 'string' || !email.trim() || typeof password !== 'string' || !password)
    throw Error('AUTH_INPUT_REQUIRED');
  let response;
  try {
    response = await fetchImpl(`${new URL(url).origin}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: publishableKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), password }),
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw Error('AUTH_SIGNIN_UNAVAILABLE');
  }
  if (!response.ok) throw Error('AUTH_SIGNIN_FAILED');
  const result = await response.json();
  if (typeof result.access_token !== 'string' || typeof result.refresh_token !== 'string')
    throw Error('AUTH_SIGNIN_FAILED');
  return { accessToken: result.access_token, refreshToken: result.refresh_token };
}

async function main() {
  if (!process.stdin.isTTY) throw Error('INTERACTIVE_TERMINAL_REQUIRED');
  createOperatorClient({
    url: process.env.SUPABASE_URL,
    publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY,
    accessToken: 'configuration-validation-only',
  });
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, done) {
      if (!muted) process.stdout.write(chunk, encoding);
      done();
    },
  });
  const prompt = createInterface({ input: process.stdin, output, terminal: true });
  let password = '';
  let session;
  try {
    const email = await prompt.question('Email tài khoản ChiDi owner/manager: ');
    process.stdout.write('Mật khẩu (không hiển thị, không lưu): ');
    muted = true;
    password = await prompt.question('');
    muted = false;
    process.stdout.write('\n');
    session = await loginOperator({
      url: process.env.SUPABASE_URL,
      publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY,
      email,
      password,
    });
  } finally {
    password = '';
    muted = false;
    prompt.close();
  }
  console.log(
    'Đăng nhập thành công. Phiên worker chỉ giữ trong bộ nhớ; đang kiểm tra quyền workspace.',
  );
  const run = process.argv.includes('--channels')
    ? runChannelSupervisor
    : process.argv.includes('--supervise')
      ? runSupervisor
      : runWorker;
  await run({
    ...process.env,
    LIVE_OPERATOR_ACCESS_TOKEN: session.accessToken,
    LIVE_OPERATOR_REFRESH_TOKEN: session.refreshToken,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error(
      'WORKER_LOGIN_STOPPED: kiểm tra cấu hình, thông tin đăng nhập và quyền. Không có mật khẩu/token được ghi log.',
    );
    process.exitCode = 1;
  });
}
