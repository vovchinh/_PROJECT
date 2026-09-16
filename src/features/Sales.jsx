import { useEffect, useRef, useState } from 'react';
import { Plus, RefreshCw, ShoppingBag, Truck, PackageCheck, Undo2, Trash2 } from 'lucide-react';
import { Panel, Table, Modal, Field, Select, ErrorMessage, SearchBox, ExportButton } from '../components.jsx';
import { today, dateLabel, integer } from '../lib/domain.js';

const labels = { draft: 'Nháp', confirmed: 'Đã giữ hàng', shipped: 'Đang giao', delivered: 'Đã giao', cancelled: 'Đã hủy / giao thất bại' };
const actions = { confirm: 'Xác nhận giữ hàng', ship: 'Bàn giao vận chuyển', deliver: 'Giao thành công', cancel: 'Hủy đơn', return: 'Nhận hàng hoàn' };
const money = (v = 0) => new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 }).format(BigInt(v));
const qty = (v = 0) => new Intl.NumberFormat('vi-VN').format(BigInt(v));
const nameOf = (rows, id) => rows.find((r) => r.id === id)?.name || '—';
const codeOf = (rows, id) => rows.find((r) => r.id === id)?.code || '—';
const emptyLine = () => ({ product_id: '', qty: '1', unit_price: '0', discount: '0' });
const totalLine = (r) => {
  try { return BigInt(integer(r.qty, 'Số lượng', { min: 1, max: 1000000 })) * BigInt(integer(r.unit_price, 'Giá bán')) - BigInt(integer(r.discount, 'Giảm giá')); }
  catch { return 0n; }
};

function FormShell({ title, children, busy, error, submit, onClose, submitLabel = 'Lưu nháp' }) {
  return <Modal title={title} onClose={() => !busy && onClose()}>
    <form onSubmit={submit}>
      <fieldset className="sales-fieldset" disabled={busy}><div className="form-body">{children}<ErrorMessage error={error} /></div></fieldset>
      <footer className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>Đóng</button><button className="button primary" disabled={busy}>{busy ? 'Đang xử lý…' : submitLabel}</button></footer>
    </form>
  </Modal>;
}

function CustomerForm({ row, save, onClose }) {
  const [value, setValue] = useState(row || { code: '', name: '', phone: '', address: '', notes: '' });
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const change = (key) => (e) => setValue({ ...value, [key]: e.target.value });
  async function submit(e) { e.preventDefault(); setBusy(true); setError(''); try { await save(value); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  return <FormShell title={row ? 'Sửa khách hàng' : 'Thêm khách hàng'} busy={busy} error={error} submit={submit} onClose={onClose} submitLabel="Lưu khách hàng">
    <div className="form-grid"><Field label="Mã khách hàng"><input required maxLength={80} value={value.code} disabled={Boolean(row)} onChange={change('code')} placeholder="KH-0001" /></Field><Field label="Tên khách hàng"><input required maxLength={200} value={value.name} onChange={change('name')} /></Field><Field label="Điện thoại"><input type="tel" maxLength={40} value={value.phone || ''} onChange={change('phone')} /></Field><Field label="Địa chỉ" span><textarea rows={2} maxLength={1000} value={value.address || ''} onChange={change('address')} /></Field><Field label="Ghi chú khách hàng" span><textarea rows={2} maxLength={2000} value={value.notes || ''} onChange={change('notes')} /></Field></div>
  </FormShell>;
}

function OrderForm({ row, state, data, save, onClose }) {
  const [value, setValue] = useState(() => row ? { ...row, lines: state.sales_order_lines.filter((l) => l.order_id === row.id).map((l) => ({ product_id: l.product_id, qty: String(l.qty), unit_price: String(l.unit_price), discount: String(l.discount) })) } : { code: `DH-${today().replaceAll('-', '')}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`, customer_id: '', warehouse_id: data.warehouses[0]?.id || '', order_date: today(), channel: 'Livestream', notes: '', lines: [emptyLine()] });
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const change = (key) => (e) => setValue({ ...value, [key]: e.target.value });
  const changeLine = (i, key, v) => setValue({ ...value, lines: value.lines.map((r, j) => j === i ? { ...r, [key]: v } : r) });
  async function submit(e) { e.preventDefault(); setBusy(true); setError(''); try { await save(value); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  return <FormShell title={row ? 'Sửa đơn nháp' : 'Tạo đơn bán hàng'} busy={busy} error={error} submit={submit} onClose={onClose}>
    <p className="sales-note">Đơn nháp chưa giữ tồn. Xác nhận đơn sau khi kiểm tra khách hàng, SKU và giá bán.</p>
    <div className="form-grid"><Field label="Mã đơn hàng"><input required maxLength={80} value={value.code} disabled={Boolean(row)} onChange={change('code')} /></Field><Field label="Ngày đặt hàng"><input type="date" required value={value.order_date} onChange={change('order_date')} /></Field><Field label="Khách hàng"><Select required items={state.customers} value={value.customer_id} onChange={change('customer_id')} /></Field><Field label="Kho xuất"><Select required items={data.warehouses} value={value.warehouse_id} onChange={change('warehouse_id')} /></Field><Field label="Kênh bán"><input required maxLength={80} value={value.channel} onChange={change('channel')} list="sales-channels" /><datalist id="sales-channels"><option>Livestream</option><option>FLive</option><option>Zalo</option><option>Cửa hàng</option></datalist></Field></div>
    <div className="sales-lines">{value.lines.map((line, i) => <div className="sales-line" key={i}>
      <div className="sales-line-heading"><strong>Sản phẩm {i + 1}</strong><button type="button" className="icon-button" aria-label={`Xóa dòng ${i + 1}`} disabled={value.lines.length === 1} onClick={() => setValue({ ...value, lines: value.lines.filter((_, j) => i !== j) })}><Trash2 size={16} /></button></div>
      <Field label={`SKU dòng ${i + 1}`}><Select required items={data.products.filter((p) => !p.provisional)} value={line.product_id} onChange={(e) => changeLine(i, 'product_id', e.target.value)} /></Field>
      <div className="sales-line-numbers"><Field label={`Số lượng dòng ${i + 1}`}><input type="number" required min="1" max="1000000" step="1" value={line.qty} onChange={(e) => changeLine(i, 'qty', e.target.value)} /></Field><Field label={`Giá bán dòng ${i + 1}`}><input type="number" required min="0" max="9000000000000" step="1" value={line.unit_price} onChange={(e) => changeLine(i, 'unit_price', e.target.value)} /></Field><Field label={`Giảm giá dòng ${i + 1}`} hint="Tổng giảm của cả dòng, VND"><input type="number" required min="0" max="9000000000000" step="1" value={line.discount} onChange={(e) => changeLine(i, 'discount', e.target.value)} /></Field></div>
      <p className="sales-line-total">Thành tiền: <strong>{money(totalLine(line))}</strong></p>
    </div>)}</div>
    <button type="button" className="button secondary" disabled={value.lines.length >= 100} onClick={() => setValue({ ...value, lines: [...value.lines, emptyLine()] })}><Plus size={16} />Thêm sản phẩm</button><p className="sales-total">Tổng đơn: {money(value.lines.reduce((s, l) => s + totalLine(l), 0n))}</p>
    <Field label="Ghi chú đơn hàng"><textarea rows={2} maxLength={2000} value={value.notes || ''} onChange={change('notes')} /></Field>
  </FormShell>;
}

function ActionForm({ order, action, state, data, run, onClose }) {
  const lines = state.sales_order_lines.filter((l) => l.order_id === order.id);
  const [value, setValue] = useState({ date: today(), reason: '', carrier: order.carrier || 'SPX', tracking_number: order.tracking_number || '', lines: lines.map((l) => ({ line_id: l.id, qty: order.status === 'shipped' ? String(l.qty - l.returned_qty) : '0' })) });
  const [checked, setChecked] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const request = useRef(null);
  const change = (key) => (e) => setValue({ ...value, [key]: e.target.value });
  async function submit(e) {
    e.preventDefault(); if (!checked) return; setBusy(true); setError('');
    const payload = { date: value.date };
    if (action === 'ship') Object.assign(payload, { carrier: value.carrier, tracking_number: value.tracking_number });
    if (action === 'cancel' || action === 'return') payload.reason = value.reason;
    if (action === 'return') payload.lines = value.lines.filter((l) => Number(l.qty) > 0).map((l) => ({ ...l, qty: Number(l.qty) }));
    const signature = JSON.stringify(payload);
    if (request.current?.signature !== signature) request.current = { signature, id: crypto.randomUUID() };
    try { await run(order.id, action, payload, request.current.id); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const help = { confirm: 'Giữ đủ hàng cho toàn bộ đơn. Hàng trong kho chưa giảm; các đơn khác không được dùng phần đã giữ.', ship: 'Xuất toàn bộ đơn và ghi giá vốn FIFO vào hàng đang giao. V2 dùng một vận đơn cho mỗi đơn.', deliver: 'Xác nhận khách đã nhận hàng. Báo cáo quản trị ghi nhận doanh số và giá vốn; tiền COD còn chờ đối soát.', cancel: 'Đơn nháp hoặc đã giữ hàng được hủy. Hàng đã giữ được giải phóng để bán cho đơn khác.', return: order.status === 'shipped' ? 'Giao thất bại: nhận lại toàn bộ hàng của vận đơn. Chỉ xác nhận sau khi kiểm đếm hàng thực tế và hàng đủ điều kiện bán lại.' : 'Chọn số lượng khách trả đã nhận và kiểm tra đủ điều kiện bán lại. Giá vốn hoàn theo phân bổ gốc; hoàn tiền xử lý riêng.' }[action];
  return <FormShell title={`${actions[action]} · ${order.code}`} busy={busy} error={error} submit={submit} onClose={onClose} submitLabel="Xác nhận thao tác">
    <p className="sales-note">{help}</p><Field label="Ngày thực hiện"><input type="date" required min={order.order_date} value={value.date} onChange={change('date')} /></Field>
    {action === 'ship' && <div className="form-grid"><Field label="Đơn vị vận chuyển"><input required maxLength={80} value={value.carrier} onChange={change('carrier')} list="carriers" /><datalist id="carriers"><option>SPX</option><option>GHN</option><option>J&amp;T</option><option>Tự giao</option></datalist></Field><Field label="Mã vận đơn"><input required maxLength={120} value={value.tracking_number} onChange={change('tracking_number')} /></Field></div>}
    {action === 'return' && <div className="sales-lines">{lines.map((line, i) => <Field key={line.id} label={`Hoàn ${codeOf(data.products, line.product_id)}`} hint={`Đã giao đi ${line.qty}; đã hoàn ${line.returned_qty}.`}><input type="number" required min="0" max={line.qty - line.returned_qty} step="1" value={value.lines[i].qty} disabled={order.status === 'shipped'} onChange={(e) => setValue({ ...value, lines: value.lines.map((l, j) => j === i ? { ...l, qty: e.target.value } : l) })} /></Field>)}</div>}
    {(action === 'return' || action === 'cancel') && <Field label="Lý do" hint="Ít nhất 10 ký tự, lưu trong lịch sử đơn."><textarea required minLength={10} maxLength={2000} rows={3} value={value.reason} onChange={change('reason')} /></Field>}
    <label className="checkbox"><input type="checkbox" required checked={checked} onChange={(e) => setChecked(e.target.checked)} /><span>{action === 'return' ? 'Tôi đã nhận đủ hàng đã chọn, kiểm tra và xác nhận có thể bán lại.' : 'Tôi đã kiểm tra ngày, chứng từ và nội dung thao tác.'}</span></label>
  </FormShell>;
}

function Detail({ order, state, data, canDraft, canPost, onEdit, onAction, onClose }) {
  const lines = state.sales_order_lines.filter((l) => l.order_id === order.id);
  const events = state.sales_events.filter((e) => e.order_id === order.id);
  const snapshot = order.customer_snapshot;
  const address = snapshot?.shipping_address;
  return <Modal title={order.code} description={`${snapshot?.customer?.name || nameOf(state.customers, order.customer_id)} · ${labels[order.status]}`} onClose={onClose}>
    <div className="form-body"><div className="sales-detail-meta"><span>Ngày đặt: {dateLabel(order.order_date)}</span><span>Kho: {nameOf(data.warehouses, order.warehouse_id)}</span><span>Kênh: {order.channel}</span><span>Vận đơn: {order.carrier || '—'} / {order.tracking_number || '—'}</span></div>
      {address ? <section className="sales-note" aria-label="Thông tin nhận hàng lúc xác nhận"><strong>Thông tin nhận hàng lúc xác nhận đơn</strong><p>{address.recipient_name} · {address.phone}</p><p>{[address.address_line, address.region, address.city, address.country].filter(Boolean).join(', ')}</p><small>{snapshot.source === 'legacy_contact_unverified' ? 'Liên hệ cũ — chưa xác minh địa chỉ.' : address.verified ? 'Địa chỉ đã xác minh thủ công.' : 'Địa chỉ được chọn — chưa xác minh.'}</small></section> : <p className="sales-note">{order.status === 'draft' ? 'Chọn địa chỉ trong Nền tảng thương mại → Hồ sơ khách trước khi xác nhận đơn.' : 'Đơn này chưa có bản chụp thông tin nhận hàng lịch sử.'}</p>}
      <Table headers={['Sản phẩm', 'SL', 'Đã hoàn', 'Thành tiền', 'Giá vốn xuất']} empty={!lines.length}>{lines.map((l) => <tr key={l.id}><td><strong>{codeOf(data.products, l.product_id)}</strong><small>{nameOf(data.products, l.product_id)}</small></td><td>{qty(l.qty)}</td><td>{qty(l.returned_qty)}</td><td>{money(l.line_total)}</td><td>{order.shipped_date ? money(l.cost_amount) : 'Chưa xuất'}</td></tr>)}</Table>
      <p className="sales-total">Tổng đơn gốc: {money(order.total_amount)}</p>{order.notes && <p className="sales-note">{order.notes}</p>}
      <h3>Lịch sử đơn</h3><div className="sales-timeline">{events.length ? events.map((e) => <div key={e.id}><span>{dateLabel(e.event_date)}</span><strong>{actions[e.action] || e.action}</strong>{e.reason && <p>{e.reason}</p>}</div>) : <p>Đơn đang ở bước nháp.</p>}</div>
      <p className="sales-note">Giá vốn xuất bao gồm hàng đang giao. Doanh số và giá vốn bán được ghi nhận trong báo cáo quản trị khi giao thành công. Khoản thu COD, phí vận chuyển và hoàn tiền chưa được đối soát tại đây.</p>
    </div><footer className="modal-actions sales-actions">
      {order.status === 'draft' && canDraft && <button className="button secondary" onClick={onEdit}>Sửa đơn nháp</button>}
      {canPost && <>{order.status === 'draft' && <button className="button primary" onClick={() => onAction('confirm')}><ShoppingBag size={16} />{actions.confirm}</button>}{order.status === 'confirmed' && <button className="button primary" onClick={() => onAction('ship')}><Truck size={16} />{actions.ship}</button>}{order.status === 'shipped' && <button className="button primary" onClick={() => onAction('deliver')}><PackageCheck size={16} />{actions.deliver}</button>}{['draft', 'confirmed'].includes(order.status) && <button className="button secondary" onClick={() => onAction('cancel')}>{actions.cancel}</button>}{['shipped', 'delivered'].includes(order.status) && lines.some((l) => l.returned_qty < l.qty) && <button className="button secondary" onClick={() => onAction('return')}><Undo2 size={16} />{actions.return}</button>}</>}
    </footer>
  </Modal>;
}

export default function SalesWorkspace({ repo, data, view = 'sales', onModalChange }) {
  const [state, setState] = useState(null), [error, setError] = useState(''), [loading, setLoading] = useState(true), [revision, setRevision] = useState(0), [modal, setModal] = useState(null), [notice, setNotice] = useState(''), [search, setSearch] = useState(''), [status, setStatus] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { onModalChange?.(Boolean(modal)); return () => onModalChange?.(false); }, [modal, onModalChange]);
  useEffect(() => {
    let active = true; setLoading(true); setError(''); setState(null);
    repo.salesState().then((result) => { if (active) setState(result); }).catch((e) => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [repo, revision, data]);
  async function execute(fn) {
    await fn();
    if (!mounted.current) return;
    setModal(null); setNotice('Đã lưu thao tác. Dữ liệu đang được cập nhật.'); setRevision((r) => r + 1);
  }
  const canDraft = ['owner', 'manager', 'staff'].includes(data.role), canPost = ['owner', 'manager'].includes(data.role);
  const filter = (text) => String(text).toLocaleLowerCase('vi').includes(search.trim().toLocaleLowerCase('vi'));
  if (loading) return <Panel title="Đang đọc bán hàng và tồn kho…"><p className="operations-padding">Tổng hợp dữ liệu cùng một lần đọc.</p></Panel>;
  if (error) return <Panel title="Chưa tải được phân hệ V2"><div className="operations-padding"><ErrorMessage error={error} /><p>Nếu chưa nâng cấp, mở docs/THIET_LAP_V2.md và chạy 003_sales_inventory.sql trong SQL Editor. Nhập hàng, thu chi V1.1 vẫn dùng được.</p><button className="button secondary" onClick={() => setRevision((r) => r + 1)}><RefreshCw size={16} />Thử lại V2</button></div></Panel>;
  if (!state) return null;
  const order = modal?.id ? state.sales_orders.find((o) => o.id === modal.id) : null;
  const customers = state.customers.filter((c) => filter(`${c.code} ${c.name} ${c.phone || ''}`));
  const orders = state.sales_orders.filter((o) => (!status || o.status === status) && filter(`${o.code} ${nameOf(state.customers, o.customer_id)} ${o.tracking_number || ''}`));
  const inventory = state.inventory.filter((r) => filter(`${codeOf(data.products, r.product_id)} ${nameOf(data.products, r.product_id)} ${nameOf(data.warehouses, r.warehouse_id)}`));
  const s = state.summary;
  return <>
    {notice && <div className="sales-notice" role="status">{notice}</div>}
    <div className="sales-banner"><div><span className="eyebrow">VẬN HÀNH BÁN HÀNG / V2</span><p>{view === 'inventory' ? 'Tồn hiện tại = hàng trong kho; có thể bán = trong kho − đã giữ. Hàng đang giao theo dõi riêng.' : view === 'customers' ? 'Danh bạ khách dùng chung cho đơn bán. Tìm theo mã, tên hoặc số điện thoại.' : 'Nháp → giữ hàng → bàn giao → giao thành công. Hoàn hàng luôn gắn với đơn gốc.'}</p><small>Dữ liệu hiện tại, toàn bộ thời gian. Báo cáo quản trị chưa bao gồm đối soát COD và chi phí vận hành.</small></div><button className="icon-button" aria-label="Tải lại phân hệ bán hàng" onClick={() => setRevision((r) => r + 1)}><RefreshCw size={18} /></button></div>
    {view === 'sales' && <div className="kpi-grid sales-kpis">{[['Doanh số thuần đã giao', s.net_sales, 'Sau hàng khách trả'], ['Giá vốn đã bán', s.cost_of_goods, 'Theo FIFO, sau hàng trả'], ['Lãi gộp quản trị', s.gross_profit, 'Chưa trừ phí và chi phí khác'], ['Giá vốn đang giao', s.in_transit_cost, 'Chưa ghi vào giá vốn đã bán']].map(([label, value, hint]) => <div className="kpi" key={label}><span>{label}</span><strong>{money(value)}</strong><small>{hint} · lũy kế</small></div>)}</div>}
    <Panel title={view === 'sales' ? 'Danh sách đơn hàng' : view === 'customers' ? 'Khách hàng' : 'Tồn kho theo SKU và kho'} note={view === 'inventory' ? 'Giá trị trong kho gồm chi phí nhập phân bổ; hàng hoàn dùng giá vốn gốc.' : undefined} action={canDraft && view !== 'inventory' && <button className="button primary" onClick={() => setModal({ type: view === 'customers' ? 'customer' : 'order' })}><Plus size={16} />{view === 'customers' ? 'Thêm khách hàng' : 'Tạo đơn bán'}</button>}>
      <div className="sales-toolbar"><SearchBox value={search} onChange={setSearch} />{view === 'sales' && <select aria-label="Lọc trạng thái đơn" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Mọi trạng thái</option>{Object.entries(labels).map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select>}
        <ExportButton name={`chidi-${view}-${today()}.csv`} rows={view === 'sales' ? [['Mã đơn', 'Ngày đặt', 'Khách hàng', 'Trạng thái', 'Tổng đơn gốc', 'Vận đơn'], ...orders.map((o) => [o.code, o.order_date, nameOf(state.customers, o.customer_id), labels[o.status], o.total_amount, o.tracking_number])] : view === 'customers' ? [['Mã khách', 'Tên', 'Điện thoại', 'Địa chỉ'], ...customers.map((c) => [c.code, c.name, c.phone, c.address])] : [['SKU', 'Kho', 'Trong kho', 'Đã giữ', 'Có thể bán', 'Đang giao', 'Giá trị trong kho'], ...inventory.map((r) => [codeOf(data.products, r.product_id), nameOf(data.warehouses, r.warehouse_id), r.on_hand, r.reserved, r.available, r.in_transit, r.stock_value])]} />
      </div>
      {view === 'sales' ? <Table headers={['Đơn hàng', 'Khách hàng', 'Trạng thái', 'Tổng đơn gốc', 'Thao tác']} empty={!orders.length}>{orders.map((o) => <tr key={o.id}><td><strong>{o.code}</strong><small>{dateLabel(o.order_date)} · {o.channel}</small></td><td>{nameOf(state.customers, o.customer_id)}<small>{o.tracking_number || 'Chưa có vận đơn'}</small></td><td><span className={`badge sale-${o.status}`}>{labels[o.status]}</span></td><td>{money(o.total_amount)}</td><td><button className="button secondary" aria-label={`Xem đơn ${o.code}`} onClick={() => setModal({ type: 'detail', id: o.id })}>Xem đơn</button></td></tr>)}</Table> : view === 'customers' ? <Table headers={['Mã khách', 'Tên / điện thoại', 'Địa chỉ', 'Thao tác']} empty={!customers.length}>{customers.map((c) => <tr key={c.id}><td>{c.code}</td><td><strong>{c.name}</strong><small>{c.phone || 'Chưa có điện thoại'}</small></td><td className="sales-address">{c.address || '—'}</td><td>{canDraft && <button className="button secondary" aria-label={`Sửa khách ${c.code}`} onClick={() => setModal({ type: 'customer', row: c })}>Sửa</button>}</td></tr>)}</Table> : <Table headers={['Sản phẩm', 'Kho', 'Trong kho', 'Đã giữ', 'Có thể bán', 'Đang giao', 'Giá trị trong kho']} empty={!inventory.length}>{inventory.map((r) => <tr key={`${r.product_id}:${r.warehouse_id}`}><td><strong>{codeOf(data.products, r.product_id)}</strong><small>{nameOf(data.products, r.product_id)}</small></td><td>{nameOf(data.warehouses, r.warehouse_id)}</td><td>{qty(r.on_hand)}</td><td>{qty(r.reserved)}</td><td><strong>{qty(r.available)}</strong></td><td>{qty(r.in_transit)}</td><td>{money(r.stock_value)}</td></tr>)}</Table>}
    </Panel>
    {view === 'sales' && <p className="page-footnote">Tổng đơn gốc giữ nguyên sau hoàn. Doanh số thuần phía trên đã trừ phần trả lại của đơn giao thành công. V2 giao cả đơn bằng một vận đơn; chưa có chia kiện, đổi hàng, hoàn tiền tự động hoặc tích hợp hãng vận chuyển.</p>}
    {modal?.type === 'customer' && <CustomerForm row={modal.row} onClose={() => setModal(null)} save={(p) => execute(() => repo.saveCustomer(p))} />}
    {modal?.type === 'order' && <OrderForm row={order} state={state} data={data} onClose={() => setModal(null)} save={(p) => execute(() => repo.saveSalesOrder(p))} />}
    {modal?.type === 'detail' && order && <Detail order={order} state={state} data={data} canDraft={canDraft} canPost={canPost} onClose={() => setModal(null)} onEdit={() => setModal({ type: 'order', id: order.id })} onAction={(action) => setModal({ type: 'action', id: order.id, action })} />}
    {modal?.type === 'action' && order && <ActionForm order={order} action={modal.action} state={state} data={data} onClose={() => setModal(null)} run={(id, action, payload, requestId) => execute(() => repo.transitionSalesOrder(id, action, payload, requestId))} />}
  </>;
}
