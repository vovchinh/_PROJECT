export const MAX_AMOUNT = 9_000_000_000_000;
export const CATEGORIES = [
  ['packaging', 'Bao bì', 'out', true],
  ['software', 'Phần mềm / FLive', 'out', true],
  ['rent', 'Thuê mặt bằng', 'out', true],
  ['utilities', 'Điện nước / Internet', 'out', true],
  ['shipping', 'Vận chuyển ngoài đối soát', 'out', true],
  ['marketing', 'Marketing', 'out', true],
  ['payroll', 'Thanh toán lương', 'out', false],
  ['other_expense', 'Chi phí khác', 'out', true],
  ['legacy_purchase_payment', 'Tiền mua hàng chờ gắn PO', 'out', false],
  ['owner_withdrawal', 'Chủ shop rút tiền', 'out', false],
  ['capital', 'Chủ shop góp tiền', 'in', false],
  ['legacy_cod', 'COD cũ chờ đối soát', 'in', false],
  ['customer_receipt', 'Thu tiền khách hàng', 'in', false],
  ['other_receipt', 'Khoản thu khác', 'in', false],
];
export const categoryLabel = (key) => CATEGORIES.find((c) => c[0] === key)?.[1] || 'Chưa phân loại';
export const money = (value) =>
  new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND',
    maximumFractionDigits: 0,
  }).format(Number(value) || 0);
export const number = (value) => new Intl.NumberFormat('vi-VN').format(Number(value) || 0);
export const dateLabel = (value) =>
  value
    ? new Date(`${String(value).slice(0, 10)}T12:00:00`).toLocaleDateString('vi-VN')
    : 'Chưa rõ ngày';
export const today = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
export const inPeriod = (date, from, to) =>
  Boolean(date && (!from || date.slice(0, 10) >= from) && (!to || date.slice(0, 10) <= to));
export function integer(value, label, { min = 0, max = MAX_AMOUNT } = {}) {
  if (value === '' || value === null || value === undefined)
    throw new Error(`${label}: cần nhập một số nguyên.`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new Error(`${label}: dùng số nguyên từ ${min} đến ${max}.`);
  return n;
}
export function validDate(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) &&
    new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value
  );
}
export function sum(rows, select = (value) => value) {
  let result = 0n;
  for (const row of rows) {
    const value = Number(select(row));
    if (!Number.isSafeInteger(value)) throw new Error('Dữ liệu báo cáo chứa số tiền không hợp lệ.');
    result += BigInt(value);
  }
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER))
    throw new Error(
      'Tổng vượt giới hạn số nguyên của V1. Cần báo cáo tổng hợp chính xác trên server.',
    );
  return Number(result);
}
export function purchaseTotal(row) {
  const qty = integer(row.qty, 'Số lượng', { min: 1, max: 1_000_000 });
  const cost = integer(row.unit_cost, 'Đơn giá');
  const extra = integer(row.additional_cost ?? 0, 'Chi phí nhập thêm');
  return integer(qty * cost + extra, 'Tổng tiền', { min: 1 });
}
export function assertPurchasePost(row, data) {
  if (!validDate(row.received_date) || row.date_estimated)
    throw new Error('Cần xác nhận ngày nhận thực tế trước khi ghi sổ.');
  if (!data.suppliers.some((r) => r.id === row.supplier_id))
    throw new Error('Chưa xác định nhà cung cấp.');
  const product = data.products.find((r) => r.id === row.product_id);
  if (!product || product.provisional)
    throw new Error('SKU còn tạm thời. Xác nhận sản phẩm trong Danh mục trước khi ghi sổ.');
  if (!data.warehouses.some((r) => r.id === row.warehouse_id))
    throw new Error('Chưa chọn kho nhận.');
  purchaseTotal(row);
}
export function assertCashPost(row, data) {
  if (!validDate(row.transaction_date) || row.date_estimated)
    throw new Error('Cần xác nhận ngày thu chi thực tế.');
  const account = data.cash_accounts.find((r) => r.id === row.account_id);
  if (!account) throw new Error('Chưa chọn tài khoản tiền.');
  if (!account.opening_confirmed || !validDate(account.opening_date))
    throw new Error('Tài khoản chưa xác nhận số dư và ngày mở sổ.');
  if (row.transaction_date < account.opening_date)
    throw new Error('Ngày thu chi trước ngày mở sổ tài khoản.');
  const validCategory = Array.isArray(data.expense_categories)
    ? data.expense_categories.some((c) => c.code === row.category && c.direction === row.direction && c.is_active)
    : CATEGORIES.some((c) => c[0] === row.category && c[2] === row.direction);
  if (!validCategory)
    throw new Error('Nhóm thu chi không khớp chiều tiền.');
  integer(row.amount, 'Số tiền', { min: 1 });
}
export function statistics(data, from = '', to = '') {
  const cash = data.cash_movements.filter((r) => inPeriod(r.transaction_date, from, to));
  const stock = data.stock_movements.filter((r) => !to || r.received_date <= to);
  return {
    units: sum(stock, (r) => r.qty),
    stockValue: sum(stock, (r) => r.amount),
    cashIn: sum(
      cash.filter((r) => r.direction === 'in'),
      (r) => r.amount,
    ),
    cashOut: sum(
      cash.filter((r) => r.direction === 'out'),
      (r) => r.amount,
    ),
    pendingPurchases: data.purchase_receipts.filter((r) => r.status === 'draft'),
    pendingCash: data.cash_transactions.filter((r) => r.status === 'draft'),
    expense: sum(
      cash.filter((r) => r.profit_eligible ?? CATEGORIES.some((c) => c[0] === r.category && c[3])),
      (r) => -Number(r.signed_amount),
    ),
  };
}
export function csv(rows) {
  return (
    '\uFEFF' +
    rows
      .map((row) =>
        row
          .map((value) => {
            let s = String(value ?? '');
            if (/^[\s]*[=+\-@\t\r]/.test(s)) s = "'" + s;
            return '"' + s.replaceAll('"', '""') + '"';
          })
          .join(','),
      )
      .join('\r\n')
  );
}
export function download(filename, contents, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function validateImport(payload) {
  if (!payload || typeof payload !== 'object' || !/^[a-f0-9]{64}$/.test(payload.source_id || ''))
    throw new Error('File cần source_id SHA-256 hợp lệ. Dùng file JSON chuyển đổi đã cung cấp.');
  for (const key of ['suppliers', 'products', 'purchases', 'cash']) {
    if (!Array.isArray(payload[key]) || payload[key].length > 5000)
      throw new Error(`${key}: cần danh sách tối đa 5.000 dòng.`);
    const field = key === 'suppliers' || key === 'products' ? 'code' : 'legacy_id';
    const keys = payload[key].map((r) => r?.[field]);
    if (keys.some((v) => typeof v !== 'string' || !v.trim()) || new Set(keys).size !== keys.length)
      throw new Error(`${key}: mã bị trùng hoặc thiếu.`);
  }
  for (const row of payload.purchases) purchaseTotal(row);
  for (const row of payload.cash) {
    integer(row.amount, 'Số tiền nhập', { min: 1 });
    if (!['in', 'out'].includes(row.direction)) throw new Error('Chiều tiền không hợp lệ.');
  }
  return payload;
}
