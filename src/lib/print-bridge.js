// Printing consumes a committed immutable snapshot. It never creates business data.
const MAX_MONEY = 9000000000000n;
const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/gu,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char],
  );

function text(value, max, allowEmpty = false) {
  const normalized = Number.isSafeInteger(value) ? String(value) : value;
  if (
    typeof normalized !== 'string' ||
    normalized.length > max ||
    (!allowEmpty && !normalized.trim()) ||
    /[\u0000-\u001F\u007F]/u.test(normalized)
  )
    throw new Error('PRINT_INVALID_SNAPSHOT: Nội dung phiếu không hợp lệ.');
  return normalized;
}
function money(value) {
  const raw = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof raw !== 'string' || !/^\d{1,13}$/u.test(raw) || BigInt(raw) > MAX_MONEY)
    throw new Error('PRINT_INVALID_SNAPSHOT: Số tiền phải là số nguyên VND hợp lệ.');
  return BigInt(raw).toString();
}
function width(value) {
  if (![58, 80].includes(value)) throw new Error('PRINT_INVALID_WIDTH: Chọn giấy 58 hoặc 80 mm.');
  return value;
}

export const DEFAULT_PRINT_OPTIONS = Object.freeze({
  show_customer_number: true,
  show_username: true,
  show_product_code: true,
  show_product_name: true,
  show_variant: true,
  show_qty: true,
  show_price: true,
  show_ticket_no: true,
  show_timestamp: true,
  font_scale_customer: 1,
  font_scale_product: 1,
  auto_cut: true,
  copies: 1,
});

// Device address/driver and paper width are separate trusted configuration.
// Only these finite layout options may reach the HTML/raster renderer.
export function normalizePrintOptions(options) {
  if (options == null) return { ...DEFAULT_PRINT_OPTIONS };
  if (
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => !Object.hasOwn(DEFAULT_PRINT_OPTIONS, key))
  )
    throw new Error('PRINT_INVALID_OPTIONS: Cấu hình mẫu in không được hỗ trợ.');
  const result = { ...DEFAULT_PRINT_OPTIONS };
  for (const key of Object.keys(DEFAULT_PRINT_OPTIONS)) {
    if (!Object.hasOwn(options, key)) continue;
    const value = options[key];
    const valid =
      key === 'copies'
        ? value === 1
        : key.startsWith('font_scale_')
          ? Number.isInteger(value) && value >= 1 && value <= 3
          : typeof value === 'boolean';
    if (!valid) throw new Error('PRINT_INVALID_OPTIONS: Cấu hình mẫu in không hợp lệ.');
    result[key] = value;
  }
  return result;
}

export function normalizeReceiptSnapshot(snapshot) {
  if (
    !snapshot ||
    typeof snapshot !== 'object' ||
    Array.isArray(snapshot) ||
    !Array.isArray(snapshot.lines) ||
    snapshot.lines.length < 1 ||
    snapshot.lines.length > 20
  )
    throw new Error('PRINT_INVALID_SNAPSHOT: Phiếu cần từ 1 đến 20 dòng.');
  const committed = text(snapshot.committed_at, 80);
  if (
    !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/u.test(committed) ||
    !Number.isFinite(new Date(committed).getTime())
  )
    throw new Error('PRINT_INVALID_SNAPSHOT: Thiếu thời điểm chốt hợp lệ.');
  const lines = snapshot.lines.map((line) => {
    if (!line || !Number.isSafeInteger(line.qty) || line.qty < 1 || line.qty > 1000)
      throw new Error('PRINT_INVALID_SNAPSHOT: Số lượng dòng không hợp lệ.');
    const unitPrice = money(line.unit_price);
    const lineTotal = money(line.line_total);
    if (BigInt(lineTotal) > BigInt(unitPrice) * BigInt(line.qty))
      throw new Error('PRINT_INVALID_SNAPSHOT: Tổng dòng không khớp giá và số lượng.');
    return {
      product_id: text(line.product_id, 80),
      sku: text(line.sku, 80),
      name: text(line.name, 200),
      color: line.color == null ? null : text(line.color, 100, true),
      size: line.size == null ? null : text(line.size, 100, true),
      qty: line.qty,
      unit_price: unitPrice,
      line_total: lineTotal,
    };
  });
  const total = money(snapshot.total_amount);
  if (lines.reduce((sum, line) => sum + BigInt(line.line_total), 0n) !== BigInt(total))
    throw new Error('PRINT_INVALID_SNAPSHOT: Tổng phiếu không khớp các dòng.');
  return {
    ticket_no: text(snapshot.ticket_no, 80),
    customer_no: text(snapshot.customer_no, 80),
    customer_name: text(snapshot.customer_name ?? '', 200, true),
    campaign_name: text(snapshot.campaign_name ?? '', 200, true),
    session_code: text(snapshot.session_code ?? '', 80, true),
    committed_at: committed,
    lines,
    total_amount: total,
    // Absent/null stays absent, preserving existing spool payload hashes.
    ...(snapshot.customer_username == null
      ? {}
      : {
          customer_username: text(snapshot.customer_username, 200, true),
        }),
  };
}

export function renderReceiptHtml(snapshot, { paperWidth = 80, printOptions = null } = {}) {
  width(paperWidth);
  const options = normalizePrintOptions(printOptions);
  const receipt = normalizeReceiptSnapshot(snapshot);
  const amount = (value) => `${BigInt(value).toLocaleString('vi-VN')} đ`;
  const date = new Date(receipt.committed_at).toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
  });
  const customer = `Khách ${escapeHtml(receipt.customer_no)}`;
  const identity = [
    options.show_ticket_no ? `Phiếu ${escapeHtml(receipt.ticket_no)}` : '',
    options.show_customer_number
      ? options.font_scale_customer === 1
        ? customer
        : `<span style="font-size:${12 * options.font_scale_customer}px">${customer}</span>`
      : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Phiếu${options.show_ticket_no ? ` ${escapeHtml(receipt.ticket_no)}` : ''}</title>
<style>@page{size:auto;margin:0}*{box-sizing:border-box}html{background:white;color:#000;font-family:Arial,sans-serif}
body{margin:0;width:${paperWidth}mm;padding:3mm;font-size:12px;line-height:1.35;overflow-wrap:anywhere}
h1{font-size:19px;margin:0;text-align:center}h2{font-size:16px;margin:8px 0;text-align:center}.center{text-align:center}
p{margin:4px 0}.line{border-top:1px dashed #000;padding:7px 0;break-inside:avoid}.row{display:flex;justify-content:space-between;gap:8px}
.total{font-weight:bold;font-size:16px;border-top:2px solid #000;padding-top:6px}.note{font-size:10px;margin-top:12px}
@media print{body{print-color-adjust:exact;-webkit-print-color-adjust:exact}}</style></head><body>
<h1>CHIDI SHOP</h1><h2>PHIẾU CHỐT LIVE</h2>
${identity ? `<p class="center">${identity}</p>` : ''}
<p class="center">${escapeHtml(receipt.customer_name)}</p>${options.show_username && receipt.customer_username ? `\n<p class="center">${escapeHtml(receipt.customer_username)}</p>` : ''}
<p>${escapeHtml(receipt.campaign_name)} · ${escapeHtml(receipt.session_code)}</p>${options.show_timestamp ? `<p>${escapeHtml(date)}</p>` : ''}
${receipt.lines
  .map(
    (
      line,
    ) => `<section class="line">${options.show_product_code ? `<strong${options.font_scale_product === 1 ? '' : ` style="font-size:${12 * options.font_scale_product}px"`}>${escapeHtml(line.sku)}</strong>` : ''}${options.show_product_name ? `<p>${escapeHtml(line.name)}</p>` : ''}
${options.show_variant ? `<p>Màu: ${escapeHtml(line.color || '—')} · Cỡ: ${escapeHtml(line.size || '—')}</p>` : ''}
${options.show_qty || options.show_price ? `<div class="row"><span>${options.show_qty ? (options.show_price ? `${line.qty} × ` : `SL: ${line.qty}`) : ''}${options.show_price ? escapeHtml(amount(line.unit_price)) : ''}</span>${options.show_price ? `<strong>${escapeHtml(amount(line.line_total))}</strong>` : ''}</div>` : ''}</section>`,
  )
  .join('')}
${options.show_price ? `<div class="row total"><span>Tổng</span><span>${escapeHtml(amount(receipt.total_amount))}</span></div>` : ''}
<p class="note">Phiếu chốt hàng. Chưa phải xác nhận giao hàng, thu tiền hoặc hóa đơn.</p></body></html>`;
}

// Call synchronously in the click handler, before awaiting the commit/claim RPC.
export function prepareBrowserPrint({
  paperWidth = 80,
  printOptions = null,
  windowObject = globalThis.window,
} = {}) {
  width(paperWidth);
  normalizePrintOptions(printOptions);
  if (!windowObject?.open)
    throw new Error('PRINT_BROWSER_REQUIRED: Cần trình duyệt để mở cửa sổ in.');
  const popup = windowObject.open('', '_blank', 'popup,width=460,height=720');
  if (!popup)
    throw new Error('PRINT_POPUP_BLOCKED: Hãy cho phép cửa sổ in, rồi in lại phiếu đã chốt.');
  popup.opener = null;
  popup.document.write(
    '<!doctype html><html lang="vi"><meta charset="utf-8"><title>Chuẩn bị in</title><body>Đang chuẩn bị phiếu đã chốt…</body></html>',
  );
  popup.document.close();
  let used = false;
  return {
    async print(snapshot, options = {}) {
      if (used || popup.closed)
        throw new Error('PRINT_WINDOW_UNAVAILABLE: Mở một lần in mới cho phiếu đã có.');
      const html = renderReceiptHtml(snapshot, {
        paperWidth: options.paperWidth ?? paperWidth,
        printOptions: options.printOptions ?? printOptions,
      });
      used = true;
      popup.document.open();
      popup.document.write(html);
      popup.document.close();
      if (popup.document.fonts?.ready) await popup.document.fonts.ready;
      popup.focus();
      popup.print();
      // afterprint also fires when preview closes/cancels. It proves no paper outcome.
      return { status: 'dialog_opened', paper_confirmed: false };
    },
    close() {
      if (!popup.closed) popup.close();
    },
  };
}

function loopbackUrl(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('PRINT_INVALID_BRIDGE: Địa chỉ bridge không hợp lệ.');
  }
  if (
    url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['', '/'].includes(url.pathname)
  )
    throw new Error('PRINT_INVALID_BRIDGE: Bridge phải là HTTP localhost hoặc 127.0.0.1.');
  return url.origin;
}

function pairingToken(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/u.test(token))
    throw new Error('PRINT_PAIRING_REQUIRED: Nhập mã ghép bridge đang chạy trên máy in.');
}

export async function sendToLanBridge({
  baseUrl,
  token,
  attemptId,
  snapshot,
  paperWidth = 80,
  printOptions = null,
  fetchImpl = globalThis.fetch,
}) {
  const origin = loopbackUrl(baseUrl);
  width(paperWidth);
  pairingToken(token);
  const normalizedOptions = normalizePrintOptions(printOptions);
  if (typeof attemptId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/u.test(attemptId))
    throw new Error('PRINT_INVALID_ATTEMPT: Thiếu mã lần in hợp lệ.');
  const receipt = normalizeReceiptSnapshot(snapshot);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetchImpl(`${origin}/print`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        attempt_id: attemptId,
        snapshot: receipt,
        paper_width: paperWidth,
        ...(printOptions == null ? {} : { print_options: normalizedOptions }),
      }),
      signal: controller.signal,
      redirect: 'error',
      credentials: 'omit',
    });
    if (!response.ok) throw new Error('PRINT_BRIDGE_REJECTED');
    const result = await response.json();
    if (!['sent', 'dry_run', 'unknown', 'sending', 'failed'].includes(result.status))
      throw new Error('PRINT_BRIDGE_UNKNOWN_RESPONSE');
    return {
      status: result.status,
      attempt_id: attemptId,
      paper_confirmed: false,
      replayed: result.replayed === true,
    };
  } catch {
    throw new Error(
      'PRINT_BRIDGE_UNKNOWN: Chưa xác định máy in đã nhận phiếu. Kiểm tra giấy và trạng thái lần in trước khi in lại; không tự gửi lại.',
    );
  } finally {
    clearTimeout(timeout);
  }
}

// Health is bridge availability only. It neither contacts the printer nor prints.
export async function probeLanBridge({ baseUrl, token, fetchImpl = globalThis.fetch }) {
  const origin = loopbackUrl(baseUrl);
  pairingToken(token);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetchImpl(`${origin}/health`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('PRINT_BRIDGE_REJECTED');
    const result = await response.json();
    if (result.status !== 'ready' || !['lan', 'dry_run'].includes(result.mode))
      throw new Error('PRINT_BRIDGE_UNKNOWN_RESPONSE');
    return { status: 'ready', mode: result.mode, paper_confirmed: false };
  } catch {
    throw new Error(
      'PRINT_BRIDGE_UNAVAILABLE: Chưa kết nối được bridge. Kiểm tra ứng dụng bridge, địa chỉ và mã ghép trên máy tính.',
    );
  } finally {
    clearTimeout(timeout);
  }
}
