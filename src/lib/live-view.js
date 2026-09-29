// Read models over the rows already returned by the workspace RPCs.
// Ticket value means committed goods value, never revenue or cash collected.
const DAY = 86400000;
const vnDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Ho_Chi_Minh',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const text = (value) =>
  String(value ?? '')
    .normalize('NFC')
    .toLocaleLowerCase('vi-VN')
    .trim();
const contains = (values, query) => values.some((value) => text(value).includes(query));

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function bounds({ from = null, to = null } = {}) {
  from ||= null;
  to ||= null;
  if ((from && !validDate(from)) || (to && !validDate(to)) || (from && to && from > to))
    throw new Error('LIVE_DATE_RANGE_INVALID: Chọn khoảng ngày hợp lệ.');
  return { from, to };
}
function within(value, range) {
  if (!range.from && !range.to) return true;
  return (
    validDate(value) && (!range.from || value >= range.from) && (!range.to || value <= range.to)
  );
}
function shiftDate(value, offset) {
  return new Date(new Date(`${value}T00:00:00.000Z`).getTime() + offset * DAY)
    .toISOString()
    .slice(0, 10);
}

/** UTC/offset timestamp -> Vietnam calendar date. Missing/invalid dates stay unknown. */
export function toVietnamDate(value) {
  if (typeof value !== 'string') return null;
  if (validDate(value)) return value;
  if (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || !validDate(value.slice(0, 10))) return null;
  const parts = Object.fromEntries(
    vnDate.formatToParts(parsed).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Inclusive business-date range. The caller supplies today's Vietnam date explicitly. */
export function liveDateRange(preset = 'all', todayVN, custom = {}) {
  if (!validDate(todayVN)) throw new Error('LIVE_TODAY_INVALID: Cần ngày hiện tại tại Việt Nam.');
  if (preset === 'all') return { from: null, to: null, label: 'Tất cả ngày chốt' };
  if (preset === 'custom') {
    const range = bounds(custom);
    if (!range.from || !range.to)
      throw new Error('LIVE_DATE_RANGE_INVALID: Chọn đủ ngày bắt đầu và kết thúc.');
    return { ...range, label: `${range.from} – ${range.to}` };
  }
  const days = { today: 1, '7d': 7, '30d': 30, '180d': 180, '365d': 365 }[preset];
  if (!days) throw new Error('LIVE_DATE_PRESET_INVALID: Khoảng ngày chưa được hỗ trợ.');
  return {
    from: shiftDate(todayVN, 1 - days),
    to: todayVN,
    label: days === 1 ? 'Hôm nay' : `${days} ngày gần nhất`,
  };
}

function ticketMatches(row, query) {
  return contains(
    [
      row.ticket_no,
      row.product_snapshot?.sku,
      row.product_snapshot?.code,
      row.product_snapshot?.name,
      row.product_snapshot?.size,
      row.product_snapshot?.color,
      row.customer_snapshot?.name,
      row.customer_snapshot?.customer_no,
      row.customer_snapshot?.author_external_id,
    ],
    query,
  );
}

/** Filters use business_date, not committed_at or void_date. Input order is preserved. */
export function filterLiveTickets(tickets = [], filters = {}) {
  const range = bounds(filters);
  const query = text(filters.query);
  return tickets.filter(
    (row) =>
      (!filters.campaignId || row.campaign_id === filters.campaignId) &&
      (!filters.sessionId || row.session_id === filters.sessionId) &&
      (!filters.status || filters.status === 'all' || row.status === filters.status) &&
      within(row.business_date, range) &&
      (!query || ticketMatches(row, query)),
  );
}

function exactMoney(value) {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/u.test(value)) return BigInt(value);
  throw new Error('LIVE_AMOUNT_INVALID: Giá trị phiếu phải là số nguyên VND chính xác.');
}

/** Totals only committed tickets; all/VOID counts remain visible for reconciliation. */
export function summarizeLiveTickets(tickets = []) {
  const result = {
    ticket_count: tickets.length,
    committed_count: 0,
    voided_count: 0,
    qty: 0,
    total_amount: 0n,
    cart_count: 0,
    customer_count: 0,
  };
  const carts = new Set(),
    customers = new Set();
  for (const row of tickets) {
    if (row.status === 'voided') result.voided_count++;
    if (row.status !== 'committed') continue;
    if (
      !Number.isSafeInteger(row.qty) ||
      row.qty < 1 ||
      !Number.isSafeInteger(result.qty + row.qty)
    )
      throw new Error('LIVE_QUANTITY_INVALID: Số lượng phiếu không hợp lệ.');
    result.committed_count++;
    result.qty += row.qty;
    result.total_amount += exactMoney(row.line_total);
    if (row.cart_id) carts.add(row.cart_id);
    if (row.campaign_customer_id) customers.add(row.campaign_customer_id);
  }
  result.cart_count = carts.size;
  result.customer_count = customers.size;
  return result;
}

/** Series by original business date; VOID count is not a timeline of when VOID occurred. */
export function groupLiveTicketDays(tickets = [], options = {}) {
  const range = bounds(options);
  const groups = new Map();
  for (const row of filterLiveTickets(tickets, range)) {
    const date = validDate(row.business_date) ? row.business_date : null;
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(row);
  }
  if (options.fillMissing) {
    if (!range.from || !range.to)
      throw new Error(
        'LIVE_SERIES_RANGE_REQUIRED: Cần khoảng ngày để hiển thị ngày không có phiếu.',
      );
    const length =
      (new Date(`${range.to}T00:00:00Z`) - new Date(`${range.from}T00:00:00Z`)) / DAY + 1;
    if (length > 366)
      throw new Error('LIVE_SERIES_RANGE_LIMIT: Biểu đồ theo ngày hỗ trợ tối đa 366 ngày.');
    for (let index = 0; index < length; index++) {
      const date = shiftDate(range.from, index);
      if (!groups.has(date)) groups.set(date, []);
    }
  }
  return [...groups]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
    .map(([date, rows]) => ({ date, ...summarizeLiveTickets(rows) }));
}

/** One row per original cart. No renumbering, customer-name merge, or item/ticket double count. */
export function summarizeLiveCarts(commerce = {}, filters = {}) {
  const query = text(filters.query);
  const tickets = filterLiveTickets(commerce.tickets || [], { ...filters, query: '' });
  const customers = new Map((commerce.campaign_customers || []).map((row) => [row.id, row]));
  const byCart = new Map();
  for (const ticket of tickets) {
    if (!byCart.has(ticket.cart_id)) byCart.set(ticket.cart_id, []);
    byCart.get(ticket.cart_id).push(ticket);
  }
  const hasTicketScope = Boolean(
    filters.sessionId || filters.from || filters.to || (filters.status && filters.status !== 'all'),
  );
  return (commerce.carts || [])
    .filter((cart) => !filters.campaignId || cart.campaign_id === filters.campaignId)
    .map((cart) => {
      const campaign_customer = customers.get(cart.campaign_customer_id) || null;
      const rows = byCart.get(cart.id) || [];
      return {
        ...cart,
        campaign_customer,
        customer_no: campaign_customer?.customer_no ?? null,
        tickets: rows,
        ...summarizeLiveTickets(rows),
      };
    })
    .filter(
      (row) =>
        (!hasTicketScope || row.tickets.length > 0) &&
        (!query ||
          contains(
            [
              row.customer_no,
              row.customer_no == null ? '' : `#${String(row.customer_no).padStart(3, '0')}`,
              row.campaign_customer?.display_name_snapshot,
              row.campaign_customer?.author_external_id,
            ],
            query,
          ) ||
          row.tickets.some((ticket) => ticketMatches(ticket, query))),
    );
}

/** Session history grouped by creation date. created_at never implies live start/duration. */
export function groupLiveSessions(sessions = [], filters = {}) {
  const range = bounds(filters);
  const query = text(filters.query);
  const groups = new Map();
  for (const session of sessions) {
    const date = toVietnamDate(session.created_at);
    if (
      (filters.campaignId && session.campaign_id !== filters.campaignId) ||
      (filters.status && filters.status !== 'all' && session.status !== filters.status) ||
      !within(date, range) ||
      (query && !contains([session.code, session.title, session.provider, session.room_id], query))
    )
      continue;
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(session);
  }
  return [...groups]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : b.localeCompare(a)))
    .map(([created_date, rows]) => ({
      created_date,
      sessions: [...rows].sort(
        (a, b) =>
          (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0) ||
          String(a.id).localeCompare(String(b.id)),
      ),
    }));
}
