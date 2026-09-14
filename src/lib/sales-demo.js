// Demo-only sales engine. Repository persistence owns the transaction boundary;
// staging here also prevents a failed transition from partially changing its input.
import { validDate } from './domain.js';

const KEYS = ['customers', 'sales_orders', 'sales_order_lines', 'sales_events', 'sales_lots', 'sales_allocations'];
const MAX_MONEY = 9_000_000_000_000n;
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const clone = value => structuredClone(value);
const key = (product, warehouse) => `${product}|${warehouse}`;
const fifo = (a, b) => a.available_date.localeCompare(b.available_date)
  || (a.created_at || '').localeCompare(b.created_at || '') || a.id.localeCompare(b.id);

export function emptySalesData() {
  return Object.fromEntries(KEYS.map(name => [name, []]));
}

function ensure(data) {
  for (const name of KEYS) {
    if (data[name] === undefined) data[name] = [];
    if (!Array.isArray(data[name])) throw new Error(`Dữ liệu ${name} không đọc được; giữ bản sao để kiểm tra.`);
  }
  if (!data.workspace?.id) throw new Error('Thiếu workspace của dữ liệu bán hàng.');
}

function amount(value, label = 'Số tiền', min = 0n, max = MAX_MONEY) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error(`${label}: cần số nguyên chính xác.`);
  if (!['number', 'string', 'bigint'].includes(typeof value) || !/^-?\d+$/.test(String(value)))
    throw new Error(`${label}: cần số nguyên VND.`);
  const result = BigInt(value);
  if (result < min || (max !== null && result > max)) throw new Error(`${label}: ngoài giới hạn cho phép.`);
  return result;
}

function qty(value, label = 'Số lượng', min = 1) {
  return Number(amount(value, label, BigInt(min), 1_000_000n));
}

function text(value, label, max, required = false) {
  const result = String(value ?? '').trim();
  if ((required && !result) || result.length > max) throw new Error(`${label}: thiếu hoặc quá dài.`);
  return result;
}

function date(value) {
  if (!validDate(value)) throw new Error('Ngày nghiệp vụ không hợp lệ; dùng YYYY-MM-DD.');
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .filter(k => value[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}

const own = (data, row) => row && (!row.workspace_id || row.workspace_id === data.workspace.id);
function master(data, table, id, label) {
  const found = (data[table] || []).find(row => row.id === id && own(data, row));
  if (!found) throw new Error(`${label} không tồn tại trong workspace.`);
  return found;
}
const linesOf = (data, orderId) => data.sales_order_lines.filter(row => row.order_id === orderId);
const reservations = (data, lotId) => data.sales_allocations.filter(a => a.lot_id === lotId && a.status === 'reserved')
  .reduce((total, a) => total + a.qty, 0);

function syncLots(data) {
  const movements = (data.stock_movements || []).filter(m => m.purchase_id && own(data, m));
  const posts = movements.filter(m => m.movement_kind === 'post');
  const reversed = new Set(movements.filter(m => m.movement_kind === 'reversal').map(m => m.purchase_id));
  for (const m of posts) {
    date(m.received_date);
    const count = qty(m.qty), cost = amount(m.amount, 'Giá vốn phiếu nhập');
    let lot = data.sales_lots.find(l => l.source_movement_id === m.id);
    if (!lot) {
      lot = { id: m.id, workspace_id: data.workspace.id, source_kind: 'purchase', source_movement_id: m.id,
        purchase_id: m.purchase_id, product_id: m.product_id, warehouse_id: m.warehouse_id,
        available_date: m.received_date, initial_qty: count, remaining_qty: count,
        initial_cost: cost.toString(), remaining_cost: cost.toString(), created_at: m.created_at || '' };
      data.sales_lots.push(lot);
    } else if (lot.initial_qty !== count || BigInt(lot.initial_cost) !== cost
      || lot.product_id !== m.product_id || lot.warehouse_id !== m.warehouse_id || lot.available_date !== m.received_date) {
      throw new Error('Lô nhập nguồn đã thay đổi sau khi dùng cho bán hàng; cần đối chiếu.');
    }
    if (reversed.has(m.purchase_id) && !lot.voided) {
      if (lot.remaining_qty !== lot.initial_qty || reservations(data, lot.id))
        throw new Error('Phiếu nhập đã đảo nhưng lô còn liên quan bán hàng; cần đối chiếu nguồn.');
      lot.remaining_qty = 0; lot.remaining_cost = '0'; lot.voided = true;
    }
  }
}

function staged(data, operation) {
  const next = clone(data);
  ensure(next); syncLots(next);
  const result = operation(next);
  for (const name of KEYS) data[name] = next[name];
  return clone(result);
}

function lastStockDate(data, stockKey) {
  let last = '';
  for (const movement of data.stock_movements || []) {
    if (movement.purchase_id && own(data, movement)
      && key(movement.product_id, movement.warehouse_id) === stockKey && movement.received_date > last)
      last = movement.received_date;
  }
  for (const event of data.sales_events) {
    if ((event.stock_keys || []).includes(stockKey) && event.date > last) last = event.date;
  }
  return last;
}

function stockDate(data, stockKeys, when) {
  for (const stockKey of stockKeys)
    if (when < lastStockDate(data, stockKey))
      throw new Error('Ngày nghiệp vụ trước phát sinh kho gần nhất của SKU / kho; không ghi lùi lịch sử.');
}

export function assertPurchaseStockChange(data, purchase, when, reversal = false) {
  date(when);
  const view = clone(data); ensure(view); syncLots(view);
  master(view, 'products', purchase.product_id, 'SKU');
  master(view, 'warehouses', purchase.warehouse_id, 'Kho');
  stockDate(view, [key(purchase.product_id, purchase.warehouse_id)], when);
  if (reversal) {
    for (const lot of view.sales_lots.filter(l => l.purchase_id === purchase.id && !l.voided))
      if (lot.remaining_qty !== lot.initial_qty || reservations(view, lot.id) > 0)
        throw new Error('Không thể đảo phiếu nhập: lô đã được giữ hoặc xuất bán, kể cả hàng đã hoàn.');
  }
  return true;
}

export function saveCustomer(data, payload) {
  return staged(data, next => {
    const code = text(payload.code, 'Mã khách', 80, true).toUpperCase();
    const name = text(payload.name, 'Tên khách', 200, true);
    const old = payload.id ? master(next, 'customers', payload.id, 'Khách hàng') : null;
    if (old && old.code !== code) throw new Error('Mã khách hàng không được đổi.');
    if (next.customers.some(c => c.code === code && c.id !== old?.id)) throw new Error('Mã khách hàng đã tồn tại.');
    const row = { id: old?.id || uid(), workspace_id: next.workspace.id, code, name,
      phone: text(payload.phone, 'Điện thoại', 50), email: text(payload.email, 'Email', 320),
      address: text(payload.address, 'Địa chỉ', 1000), notes: text(payload.notes, 'Ghi chú', 4000),
      created_at: old?.created_at || now(), updated_at: now() };
    if (old) Object.assign(old, row); else next.customers.push(row);
    return row;
  });
}

export function saveSalesOrder(data, payload) {
  return staged(data, next => {
    const old = payload.id ? master(next, 'sales_orders', payload.id, 'Đơn hàng') : null;
    if (old && old.status !== 'draft') throw new Error('Chỉ được sửa đơn hàng nháp.');
    const code = text(payload.code, 'Mã đơn', 80, true).toUpperCase();
    if (old && old.code !== code) throw new Error('Mã đơn hàng không được đổi.');
    if (next.sales_orders.some(o => o.code === code && o.id !== old?.id)) throw new Error('Mã đơn hàng đã tồn tại.');
    master(next, 'customers', payload.customer_id, 'Khách hàng');
    master(next, 'warehouses', payload.warehouse_id, 'Kho');
    date(payload.order_date);
    if (!Array.isArray(payload.lines) || !payload.lines.length || payload.lines.length > 100)
      throw new Error('Đơn hàng cần từ 1 đến 100 dòng.');
    const seen = new Set(), orderId = old?.id || uid();
    const previousLines = old ? linesOf(next, old.id) : [];
    let total = 0n;
    const lines = payload.lines.map(input => {
      master(next, 'products', input.product_id, 'SKU');
      if (seen.has(input.product_id)) throw new Error('Mỗi SKU chỉ được có một dòng trong đơn.');
      seen.add(input.product_id);
      const count = qty(input.qty), price = amount(input.unit_price, 'Giá bán', 1n);
      const gross = BigInt(count) * price, discount = amount(input.discount ?? 0, 'Giảm giá dòng');
      if (discount > gross) throw new Error('Giảm giá vượt tiền hàng của dòng.');
      const lineTotal = amount(gross - discount, 'Tiền hàng dòng'); total += lineTotal;
      const previous = previousLines.find(l => l.product_id === input.product_id);
      return { id: previous?.id || uid(), workspace_id: next.workspace.id, order_id: orderId,
        product_id: input.product_id, qty: count, unit_price: price.toString(), discount: discount.toString(),
        line_total: lineTotal.toString(), returned_qty: 0, cost_amount: '0', created_at: previous?.created_at || now() };
    });
    amount(total, 'Tổng đơn', 1n);
    const order = { id: orderId, workspace_id: next.workspace.id, code, customer_id: payload.customer_id,
      warehouse_id: payload.warehouse_id, order_date: payload.order_date, channel: text(payload.channel, 'Kênh', 80),
      notes: text(payload.notes, 'Ghi chú', 4000), status: 'draft', total_amount: total.toString(),
      confirmed_date: null, shipped_date: null, delivered_date: null, carrier: '', tracking_number: '',
      created_at: old?.created_at || now(), updated_at: now() };
    if (old) Object.assign(old, order); else next.sales_orders.push(order);
    next.sales_order_lines = next.sales_order_lines.filter(l => l.order_id !== orderId).concat(lines);
    return { ...order, lines };
  });
}

function reserve(data, order, lines, when) {
  for (const line of lines) {
    if (master(data, 'products', line.product_id, 'SKU').provisional)
      throw new Error('SKU còn tạm thời; xác nhận sản phẩm trước khi giữ hàng.');
    let needed = line.qty;
    const lots = data.sales_lots.filter(l => !l.voided && l.product_id === line.product_id
      && l.warehouse_id === order.warehouse_id && l.available_date <= when).sort(fifo);
    for (const lot of lots) {
      const take = Math.min(needed, lot.remaining_qty - reservations(data, lot.id));
      if (take <= 0) continue;
      data.sales_allocations.push({ id: uid(), workspace_id: data.workspace.id, order_id: order.id,
        line_id: line.id, lot_id: lot.id, qty: take, status: 'reserved', cost_amount: '0',
        returned_qty: 0, returned_cost: '0', created_at: now() });
      needed -= take; if (!needed) break;
    }
    if (needed) throw new Error('Không đủ tồn khả dụng đúng ngày và kho; hàng đang giữ không được bán trùng.');
  }
}

function shipmentCost(data, order, lines) {
  let total = 0n;
  for (const line of lines) {
    const allocations = data.sales_allocations.filter(a => a.line_id === line.id && a.status === 'reserved');
    if (allocations.reduce((n, a) => n + a.qty, 0) !== line.qty) throw new Error('Phân bổ giữ hàng không khớp đơn.');
    let cost = 0n;
    for (const allocation of allocations) {
      const lot = data.sales_lots.find(l => l.id === allocation.lot_id);
      if (!lot || lot.voided || lot.available_date > order.shipped_date || lot.remaining_qty < allocation.qty)
        throw new Error('Lô đã giữ không còn đủ hàng đúng ngày xuất.');
      const issued = lot.initial_qty - lot.remaining_qty;
      const initialCost = BigInt(lot.initial_cost), initialQty = BigInt(lot.initial_qty);
      const used = initialCost * BigInt(issued + allocation.qty) / initialQty - initialCost * BigInt(issued) / initialQty;
      lot.remaining_qty -= allocation.qty;
      lot.remaining_cost = (BigInt(lot.remaining_cost) - used).toString();
      allocation.cost_amount = used.toString(); allocation.status = 'shipped'; cost += used;
    }
    line.cost_amount = cost.toString(); total += cost;
  }
  return total;
}

function returnLines(data, order, lines, payload, event) {
  if (!Array.isArray(payload.lines) || !payload.lines.length) throw new Error('Chọn các dòng và số lượng hoàn.');
  const chosen = new Map();
  for (const input of payload.lines) {
    const line = lines.find(l => l.id === input.line_id);
    if (!line || chosen.has(input.line_id)) throw new Error('Dòng hoàn không thuộc đơn hoặc bị trùng.');
    const count = qty(input.qty);
    if (count > line.qty - line.returned_qty) throw new Error('Số lượng hoàn vượt số đã xuất còn lại.');
    chosen.set(line.id, count);
  }
  const failed = order.status === 'shipped';
  if (failed && lines.some(line => (chosen.get(line.id) || 0) !== line.qty - line.returned_qty))
    throw new Error('Giao thất bại phải hoàn toàn bộ số hàng còn đang vận chuyển.');
  let totalCost = 0n, totalRefund = 0n;
  for (const line of lines) {
    const count = chosen.get(line.id); if (!count) continue;
    const previousQty = line.returned_qty;
    const refund = BigInt(line.line_total) * BigInt(previousQty + count) / BigInt(line.qty)
      - BigInt(line.line_total) * BigInt(previousQty) / BigInt(line.qty);
    let needed = count;
    const allocations = data.sales_allocations.filter(a => a.line_id === line.id && a.status === 'shipped')
      .sort((a, b) => fifo(data.sales_lots.find(l => l.id === a.lot_id), data.sales_lots.find(l => l.id === b.lot_id))
        || a.id.localeCompare(b.id));
    for (const allocation of allocations) {
      const take = Math.min(needed, allocation.qty - allocation.returned_qty); if (!take) continue;
      const cost = BigInt(allocation.cost_amount) * BigInt(allocation.returned_qty + take) / BigInt(allocation.qty)
        - BigInt(allocation.cost_amount) * BigInt(allocation.returned_qty) / BigInt(allocation.qty);
      allocation.returned_qty += take; allocation.returned_cost = (BigInt(allocation.returned_cost) + cost).toString();
      data.sales_lots.push({ id: uid(), workspace_id: data.workspace.id, source_kind: 'sales_return',
        return_event_id: event.id, parent_allocation_id: allocation.id, purchase_id: null,
        product_id: line.product_id, warehouse_id: order.warehouse_id, available_date: event.date,
        initial_qty: take, remaining_qty: take, initial_cost: cost.toString(), remaining_cost: cost.toString(), created_at: now() });
      totalCost += cost; needed -= take; if (!needed) break;
    }
    if (needed) throw new Error('Không tìm thấy đủ giá vốn gốc để nhận hàng hoàn.');
    line.returned_qty += count;
    if (!failed) totalRefund += refund;
  }
  event.revenue_effect = (-totalRefund).toString();
  if (failed) {
    event.transit_cost_effect = (-totalCost).toString(); order.status = 'cancelled';
  } else event.cogs_effect = (-totalCost).toString();
}

export function transitionSalesOrder(data, orderId, action, payload = {}, requestId) {
  if (!['confirm', 'ship', 'deliver', 'cancel', 'return'].includes(action)) throw new Error('Thao tác đơn hàng không hợp lệ.');
  if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 120) throw new Error('Cần mã yêu cầu ổn định để tránh ghi trùng.');
  const signature = canonical({ orderId, action, payload });
  return staged(data, next => {
    const prior = next.sales_events.find(event => event.request_id === requestId);
    if (prior) {
      if (prior.request_signature !== signature) throw new Error('Mã yêu cầu đã dùng cho nội dung khác.');
      return prior.response;
    }
    const order = master(next, 'sales_orders', orderId, 'Đơn hàng'), lines = linesOf(next, orderId);
    const when = date(payload.date);
    const last = next.sales_events.filter(e => e.order_id === orderId).reduce((d, e) => e.date > d ? e.date : d, order.order_date);
    if (when < last) throw new Error('Ngày nghiệp vụ trước ngày đơn hoặc thao tác gần nhất của đơn.');
    const affected = [...new Set(lines.map(l => key(l.product_id, order.warehouse_id)))];
    const touchesStock = ['confirm', 'ship', 'return'].includes(action) || (action === 'cancel' && order.status === 'confirmed');
    if (touchesStock) stockDate(next, affected, when);
    const event = { id: uid(), workspace_id: next.workspace.id, order_id: orderId, action, date: when,
      request_id: requestId, request_signature: signature, payload: clone(payload), created_at: now(),
      revenue_effect: '0', cogs_effect: '0', transit_cost_effect: '0', stock_keys: touchesStock ? affected : [] };
    if (action === 'confirm') {
      if (order.status !== 'draft') throw new Error('Chỉ xác nhận đơn hàng nháp.');
      reserve(next, order, lines, when); order.status = 'confirmed'; order.confirmed_date = when;
    } else if (action === 'ship') {
      if (order.status !== 'confirmed') throw new Error('Chỉ xuất đơn đã xác nhận và giữ hàng.');
      order.carrier = text(payload.carrier, 'Hãng vận chuyển', 120, true);
      order.tracking_number = text(payload.tracking_number, 'Mã vận đơn', 160, true);
      order.shipped_date = when;
      event.transit_cost_effect = shipmentCost(next, order, lines).toString(); order.status = 'shipped';
    } else if (action === 'deliver') {
      if (order.status !== 'shipped') throw new Error('Chỉ giao thành công đơn đang vận chuyển.');
      const cost = lines.reduce((n, line) => n + BigInt(line.cost_amount), 0n);
      event.revenue_effect = order.total_amount; event.cogs_effect = cost.toString(); event.transit_cost_effect = (-cost).toString();
      order.status = 'delivered'; order.delivered_date = when;
    } else if (action === 'cancel') {
      if (!['draft', 'confirmed'].includes(order.status)) throw new Error('Chỉ hủy đơn nháp hoặc đơn đã giữ hàng; đơn đã xuất cần hoàn.');
      if (order.status === 'confirmed' && text(payload.reason, 'Lý do hủy', 4000).length < 10) throw new Error('Lý do hủy cần ít nhất 10 ký tự.');
      for (const allocation of next.sales_allocations.filter(a => a.order_id === orderId && a.status === 'reserved')) allocation.status = 'released';
      order.status = 'cancelled';
    } else {
      if (!['shipped', 'delivered'].includes(order.status)) throw new Error('Chỉ hoàn đơn đã xuất hoặc giao thành công.');
      if (text(payload.reason, 'Lý do hoàn', 4000).length < 10) throw new Error('Lý do hoàn cần ít nhất 10 ký tự.');
      returnLines(next, order, lines, payload, event);
    }
    order.updated_at = now();
    event.response = clone({ ...order, lines }); next.sales_events.push(event);
    return event.response;
  });
}

export function salesState(data) {
  const view = clone(data); ensure(view); syncLots(view);
  const inventory = new Map();
  function entry(product, warehouse) {
    const stockKey = key(product, warehouse);
    if (!inventory.has(stockKey)) inventory.set(stockKey, { product_id: product, warehouse_id: warehouse,
      on_hand: 0, reserved: 0, available: 0, in_transit: 0, stock_value: 0n });
    return inventory.get(stockKey);
  }
  for (const lot of view.sales_lots) {
    if (lot.voided) continue;
    const row = entry(lot.product_id, lot.warehouse_id);
    row.on_hand += lot.remaining_qty; row.stock_value += BigInt(lot.remaining_cost);
    row.reserved += reservations(view, lot.id);
  }
  for (const order of view.sales_orders.filter(o => o.status === 'shipped'))
    for (const line of linesOf(view, order.id)) entry(line.product_id, order.warehouse_id).in_transit += line.qty - line.returned_qty;
  const total = field => view.sales_events.reduce((n, event) => n + BigInt(event[field] || '0'), 0n);
  const delivered = view.sales_events.filter(e => e.action === 'deliver').reduce((n, e) => n + BigInt(e.revenue_effect), 0n);
  const returned = -view.sales_events.filter(e => e.action === 'return').reduce((n, e) => n + BigInt(e.revenue_effect), 0n);
  const net = total('revenue_effect'), cogs = total('cogs_effect');
  return { customers: view.customers, sales_orders: view.sales_orders, sales_order_lines: view.sales_order_lines,
    sales_events: view.sales_events, inventory: [...inventory.values()].map(row => ({ ...row,
      available: row.on_hand - row.reserved, stock_value: row.stock_value.toString() })),
    summary: { delivered_amount: delivered.toString(), returned_amount: returned.toString(), net_sales: net.toString(),
      cost_of_goods: cogs.toString(), gross_profit: (net - cogs).toString(), in_transit_cost: total('transit_cost_effect').toString() } };
}
