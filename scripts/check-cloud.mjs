import { loadEnv } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';

const env = loadEnv('development', process.cwd(), 'VITE_');
const url = env.VITE_SUPABASE_URL?.trim();
const key = env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
const result = {
  checked_at: new Date().toISOString(),
  mode: env.VITE_DEMO_MODE,
  checks: [],
  authenticated_tested: false,
  mutations_performed: false,
};
const record = (name, status, detail) => {
  result.checks.push({ name, status, detail });
  console.log(`${status.toUpperCase()} ${name}: ${detail}`);
};
try {
  if (!url || !key) throw new Error('Thiếu URL hoặc publishable key trong .env.local.');
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.supabase.co'))
    throw new Error('Cần Project URL Supabase HTTPS hợp lệ.');
  let role = '';
  try {
    role = JSON.parse(Buffer.from(key.split('.')[1] || '', 'base64url').toString()).role || '';
  } catch {
    /* modern publishable key */
  }
  if (key.startsWith('sb_secret_') || role === 'service_role')
    throw new Error('Dừng kiểm tra: đã cấu hình nhầm key đặc quyền. Thay bằng publishable key.');
  if (!key.startsWith('sb_publishable_') && role !== 'anon')
    throw new Error('Key chưa có định dạng publishable/anon được hỗ trợ.');
  record(
    'Cấu hình',
    'pass',
    `URL HTTPS hợp lệ, key ${key.startsWith('sb_publishable_') ? 'publishable' : 'legacy anon'}, không xuất giá trị key.`,
  );
  if (env.VITE_DEMO_MODE !== 'false')
    record('Chế độ', 'pending', 'VITE_DEMO_MODE chưa là false; website vẫn chạy thử.');
  else record('Chế độ', 'pass', 'Ứng dụng được cấu hình dùng cloud.');
  const headers = { apikey: key, ...(role === 'anon' ? { Authorization: `Bearer ${key}` } : {}) };
  async function get(path) {
    const response = await fetch(`${url.replace(/\/$/, '')}${path}`, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    let body = {};
    try {
      body = await response.json();
    } catch {
      /* record status only */
    }
    return { status: response.status, body };
  }
  const auth = await get('/auth/v1/settings');
  if (auth.status === 200)
    record(
      'Supabase Auth',
      'pass',
      `Dịch vụ phản hồi; đăng nhập email ${auth.body.external?.email ? 'bật' : 'chưa bật'}, signup ${auth.body.disable_signup ? 'tắt' : 'bật'}, xác nhận email ${auth.body.mailer_autoconfirm ? 'không bắt buộc' : 'bắt buộc'}. Chưa kiểm tra tài khoản người dùng.`,
    );
  else
    record('Supabase Auth', 'fail', `HTTP ${auth.status}; kiểm tra URL/key và trạng thái project.`);
  for (const table of ['workspaces', 'purchase_receipts', 'cash_transactions']) {
    const reply = await get(`/rest/v1/${table}?select=id&limit=0`);
    if ([401, 403].includes(reply.status) && reply.body.code === '42501')
      record(table, 'pass', 'Bảng tồn tại; người chưa đăng nhập không có quyền đọc.');
    else if (reply.status === 200)
      record(
        table,
        'review',
        'API chấp nhận SELECT không có phiên. Cần kiểm tra grants/RLS; yêu cầu limit=0 không đọc dòng dữ liệu.',
      );
    else
      record(
        table,
        'fail',
        `HTTP ${reply.status}, mã ${reply.body.code || 'không rõ'}; kiểm tra migration và schema cache.`,
      );
  }
  const operations = await get(
    '/rest/v1/rpc/get_workspace_report?p_workspace_id=00000000-0000-0000-0000-000000000000&p_from=2026-08-01&p_to=2026-08-31',
  );
  if (operations.body.code === 'PGRST202')
    record(
      'Migration 002',
      'pending',
      'Chưa tìm thấy RPC báo cáo trong schema cache. Chạy 002_operations.sql trong SQL Editor, rồi kiểm tra lại.',
    );
  else if ([401, 403].includes(operations.status) && operations.body.code === '42501')
    record(
      'Migration 002',
      'pass',
      'RPC báo cáo tồn tại và từ chối anonymous. Chưa kiểm tra báo cáo với phiên thật.',
    );
  else
    record(
      'Migration 002',
      'review',
      `HTTP ${operations.status}; cần đối chiếu cấu hình RPC. Kiểm tra này không ghi dữ liệu.`,
    );
} catch (error) {
  record(
    'Kết nối',
    'fail',
    error.cause?.code
      ? `Lỗi mạng ${error.cause.code}.`
      : error.message.replace(/sb_(?:publishable|secret)_[A-Za-z0-9_-]+/g, '[redacted]'),
  );
}
mkdirSync('test-results', { recursive: true });
writeFileSync('test-results/cloud-connectivity.json', JSON.stringify(result, null, 2));
if (result.checks.some((c) => c.status === 'fail')) process.exitCode = 1;
