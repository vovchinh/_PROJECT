import { useEffect, useRef, useState } from 'react';
import { Panel, Table, Modal, Field, Select, ErrorMessage } from '../components.jsx';
import { today, dateLabel } from '../lib/domain.js';

const money = (v = 0) =>
  new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND',
    maximumFractionDigits: 0,
  }).format(BigInt(v));
const named = (rows, id) => rows.find((r) => r.id === id);
const label = (rows, id) => {
  const r = named(rows, id);
  return r ? `${r.code ? r.code + ' · ' : ''}${r.name}` : '—';
};
const options = (...values) => values.map(([id, name]) => ({ id, name }));
const text = (key, name, extra = {}) => ({
  key,
  label: name,
  required: true,
  maxLength: 200,
  ...extra,
});
const select = (key, name, items, extra = {}) => ({
  key,
  label: name,
  type: 'select',
  items,
  required: true,
  ...extra,
});
const memo = (key, name, extra = {}) =>
  text(key, name, { type: 'textarea', required: false, maxLength: 4000, ...extra });
const check = (key, name) => ({ key, label: name, type: 'checkbox' });
const operationDate = () => text('date', 'Ngày thực hiện', { type: 'date', max: today() });
const reason = () => memo('reason', 'Lý do', { required: true, minLength: 10 });
const tabs = [
  ['variants', 'SKU & biến thể'],
  ['aliases', 'Alias'],
  ['customers', 'Hồ sơ khách'],
  ['inventory', 'Giữ hàng'],
  ['payments', 'Kế hoạch thanh toán'],
];

function Editor({ config, onClose, onSave }) {
  const [value, setValue] = useState(config.value);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const request = useRef(null),
    saving = useRef(false);
  async function submit(e) {
    e.preventDefault();
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError('');
    const signature = JSON.stringify(value);
    if (request.current?.signature !== signature)
      request.current = { signature, id: crypto.randomUUID() };
    try {
      await config.save(value, request.current.id);
      onSave();
    } catch (e) {
      setError(e.message);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      title={config.title}
      description={config.note}
      onClose={() => !saving.current && onClose()}
    >
      <form onSubmit={submit}>
        <fieldset className="sales-fieldset" disabled={busy}>
          <div className="form-body form-grid">
            {config.fields.map((field) => {
              if (field.when && !field.when(value)) return null;
              const { key, label: title, type = 'text', items, when, ...attributes } = field;
              const change = (e) =>
                setValue({
                  ...value,
                  [key]: type === 'checkbox' ? e.target.checked : e.target.value,
                });
              if (type === 'checkbox')
                return (
                  <label key={key} className="checkbox span-2">
                    <input type="checkbox" checked={Boolean(value[key])} onChange={change} />
                    <span>{title}</span>
                  </label>
                );
              if (type === 'multi')
                return (
                  <fieldset className="foundation-choices span-2" key={key}>
                    <legend>{title}</legend>
                    {items.map((r) => (
                      <label className="checkbox" key={r.id}>
                        <input
                          type="checkbox"
                          checked={(value[key] || []).includes(r.id)}
                          onChange={(e) =>
                            setValue({
                              ...value,
                              [key]: e.target.checked
                                ? [...(value[key] || []), r.id]
                                : value[key].filter((id) => id !== r.id),
                            })
                          }
                        />
                        <span>{r.name}</span>
                      </label>
                    ))}
                  </fieldset>
                );
              return (
                <Field key={key} label={title} span={type === 'textarea'}>
                  {type === 'select' ? (
                      <Select
                        {...attributes}
                        aria-label={title}
                      items={typeof items === 'function' ? items(value) : items}
                      value={value[key] || ''}
                      onChange={change}
                    />
                  ) : type === 'textarea' ? (
                    <textarea {...attributes} rows={3} value={value[key] || ''} onChange={change} />
                  ) : (
                    <input {...attributes} type={type} value={value[key] ?? ''} onChange={change} />
                  )}
                </Field>
              );
            })}
            <div className="span-2">
              <ErrorMessage error={error} />
            </div>
          </div>
        </fieldset>
        <footer className="modal-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
            Đóng
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? 'Đang lưu…' : config.submit || 'Lưu thay đổi'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function AliasLookup({ repo }) {
  const [query, setQuery] = useState(''),
    [result, setResult] = useState(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const version = useRef(0);
  useEffect(
    () => () => {
      version.current++;
    },
    [repo],
  );
  async function lookup(e) {
    e.preventDefault();
    const current = ++version.current;
    setBusy(true);
    setResult(null);
    setError('');
    try {
      const next = await repo.resolveProductAlias(query);
      if (current === version.current) setResult(next);
    } catch (e) {
      if (current === version.current) setError(e.message);
    } finally {
      if (current === version.current) setBusy(false);
    }
  }
  return (
    <div className="operations-padding">
      <form className="foundation-lookup" onSubmit={lookup}>
        <Field label="Tra cứu SKU hoặc alias">
          <input
            required
            maxLength={200}
            value={query}
            onChange={(e) => {
              version.current++;
              setQuery(e.target.value);
              setResult(null);
              setError('');
              setBusy(false);
            }}
          />
        </Field>
        <button className="button secondary" disabled={busy}>
          {busy ? 'Đang tra…' : 'Tra cứu'}
        </button>
      </form>
      <ErrorMessage error={error} />
      {result && (
        <div role="status">
          <p>
            <strong>
              {
                {
                  unique: 'Khớp một SKU đã đối chiếu',
                  ambiguous: 'Mơ hồ: khớp nhiều SKU — cần chọn lại thông tin',
                  needs_review: 'SKU cần đối chiếu trước khi sử dụng',
                  not_found: 'Không tìm thấy SKU hoặc alias',
                }[result.status]
              }
            </strong>
          </p>
          {result.candidates?.map((p) => (
            <p key={p.product_id}>
              {p.code} · {p.name} · {p.size || 'Chưa rõ cỡ'} / {p.color || 'Chưa rõ màu'}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

export default function CommerceFoundation({ repo, data, onModalChange }) {
  const [state, setState] = useState(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [revision, setRevision] = useState(0);
  const [tab, setTab] = useState('variants'),
    [modal, setModal] = useState(null),
    [notice, setNotice] = useState('');
  useEffect(() => {
    onModalChange?.(Boolean(modal));
    return () => onModalChange?.(false);
  }, [modal, onModalChange]);
  useEffect(() => {
    let active = true;
    if (repo.mode !== 'cloud') {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    setState(null);
    repo
      .foundationState()
      .then((r) => {
        if (active) setState(r);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [repo, revision, data]);
  const reload = () => setRevision((v) => v + 1);
  if (repo.mode !== 'cloud')
    return (
      <Panel title="Nền tảng thương mại">
        <p className="operations-padding">
          Phase B sử dụng workspace Supabase để lưu biến thể, định danh, địa chỉ và giữ tồn. Đăng
          nhập chế độ cloud sau khi hoàn tất hướng dẫn trong docs/PHASE_B_COMMERCE_FOUNDATION.md. Dữ
          liệu demo hiện tại tiếp tục dùng ở các phân hệ cũ.
        </p>
      </Panel>
    );
  if (loading) return <Panel title="Đang tải nền tảng thương mại…" />;
  if (error || !state)
    return (
      <Panel title="Chưa tải được nền tảng thương mại">
        <div className="operations-padding">
          <ErrorMessage error={error || 'Không có dữ liệu trả về.'} />
          <button className="button secondary" onClick={reload}>
            Thử lại Phase B
          </button>
        </div>
      </Panel>
    );
  const { catalog, customer, stock, sales } = state;
  const products = data.products,
    warehouses = data.warehouses,
    customers = sales.customers;
  const orders = customer.orders,
    drafts = orders.filter((o) => o.status === 'draft');
  const canManage = ['owner', 'manager'].includes(data.role),
    canDraft = canManage || data.role === 'staff';
  const editButton = (click, name = 'Sửa') =>
    canManage && (
      <button className="button secondary small" onClick={click}>
        {name}
      </button>
    );
  const addButton = (click, name) =>
    canManage && (
      <button className="button primary" onClick={click}>
        {name}
      </button>
    );
  const open = (title, value, fields, save, note = '', submit) =>
    setModal({ title, value, fields, save, note, submit });
  const styleForm = (row) =>
    open(
      row ? 'Sửa kiểu dáng' : 'Thêm kiểu dáng',
      row || { code: '', name: '', notes: '' },
      [
        text('code', 'Mã kiểu dáng', { maxLength: 80, disabled: Boolean(row) }),
        text('name', 'Tên kiểu dáng'),
        memo('notes', 'Ghi chú'),
      ],
      repo.saveProductStyle,
    );
  const variantForm = (row) =>
    open(
      'Đối chiếu biến thể',
      {
        product_id: row.product_id,
        style_id: row.style_id || '',
        size: row.size || '',
        color: row.color || '',
        mapping_status: row.mapping_status,
        review_note: row.review_note || '',
      },
      [
        select('product_id', 'SKU gốc', products, { disabled: true }),
        select('style_id', 'Kiểu dáng', catalog.styles, { required: false }),
        text('size', 'Kích cỡ', { required: false, maxLength: 100 }),
        text('color', 'Màu sắc', { required: false, maxLength: 100 }),
        select(
          'mapping_status',
          'Trạng thái đối chiếu',
          options(['needs_review', 'Cần đối chiếu'], ['confirmed', 'Đã xác nhận']),
        ),
        memo('review_note', 'Căn cứ đối chiếu', { required: true, minLength: 10 }),
      ],
      (v) =>
        repo.saveProductVariant({
          ...v,
          style_id: v.style_id || null,
          size: v.size || null,
          color: v.color || null,
        }),
      'Giữ nguyên SKU và lịch sử nhập/bán. Để trống thuộc tính chưa rõ; chỉ xác nhận khi có căn cứ và đã chọn kiểu dáng.',
    );
  const aliasForm = (row) =>
    open(
      row ? 'Sửa alias' : 'Thêm alias',
      row
        ? { id: row.id, product_id: row.product_id, alias_text: row.alias_text, active: row.active }
        : { product_id: '', alias_text: '', active: true },
      [
        select('product_id', 'SKU', products, { disabled: Boolean(row) }),
        text('alias_text', 'Alias'),
        check('active', 'Đang sử dụng'),
      ],
      repo.saveProductAlias,
      'Một alias dùng cho nhiều SKU sẽ được báo mơ hồ khi tra cứu. Không tự chọn SKU thay bạn.',
    );
  const identityForm = (row) =>
    open(
      row ? 'Sửa định danh' : 'Thêm định danh',
      row || {
        customer_id: '',
        channel: 'PHONE',
        external_id: '',
        verified: false,
        verification_note: '',
      },
      [
        select('customer_id', 'Khách hàng', customers, { disabled: Boolean(row) }),
        select(
          'channel',
          'Loại định danh',
          options(
            ['PHONE', 'Điện thoại (E.164)'],
            ['EMAIL', 'Email'],
            ['TIKTOK_LIVE_USER', 'TikTok LIVE user ID'],
            ['TIKTOK_SHOP_BUYER', 'TikTok Shop buyer ID'],
            ['ZALO_UID', 'Zalo UID'],
          ),
          { disabled: Boolean(row) },
        ),
        text('external_id', 'Định danh chính xác', { maxLength: 320 }),
        check('verified', 'Đã kiểm tra và xác minh thủ công'),
        memo('verification_note', 'Căn cứ xác minh', {
          when: (v) => v.verified,
          required: true,
          minLength: 10,
        }),
      ],
      repo.saveCustomerIdentity,
      'Nhập ID ổn định, không dùng tên hiển thị để gộp khách. Số điện thoại cần mã quốc gia, ví dụ +84901234567.',
    );
  const addressForm = (row) =>
    open(
      row ? 'Sửa địa chỉ' : 'Thêm địa chỉ',
      row || {
        customer_id: '',
        recipient_name: '',
        phone: '',
        address_line: '',
        city: '',
        region: '',
        postal_code: '',
        country: 'VN',
        is_default: false,
        verified: false,
        verification_note: '',
      },
      [
        select('customer_id', 'Khách hàng', customers, { disabled: Boolean(row) }),
        text('recipient_name', 'Người nhận'),
        text('phone', 'Điện thoại nhận hàng', { type: 'tel', maxLength: 80 }),
        memo('address_line', 'Địa chỉ nhận hàng', { required: true, maxLength: 1000 }),
        text('city', 'Tỉnh / thành phố', { required: false }),
        text('region', 'Khu vực / quận huyện', { required: false }),
        text('postal_code', 'Mã bưu chính', { required: false, maxLength: 40 }),
        text('country', 'Mã quốc gia', { minLength: 2, maxLength: 2, pattern: '[A-Z]{2}' }),
        check('is_default', 'Địa chỉ mặc định'),
        check('verified', 'Đã xác minh địa chỉ'),
        memo('verification_note', 'Căn cứ xác minh', {
          when: (v) => v.verified,
          required: true,
          minLength: 10,
        }),
      ],
      repo.saveCustomerAddress,
      'Địa chỉ sửa sau này không thay đổi bản chụp của đơn đã xác nhận.',
    );
  const orderAddressForm = (row) =>
    open(
      'Chọn địa chỉ đơn nháp',
      { order_id: row.id, address_id: row.shipping_address_id || '' },
      [
        select(
          'order_id',
          'Đơn hàng',
          [row].map((o) => ({ ...o, name: label(customers, o.customer_id) })),
          { disabled: true },
        ),
        select(
          'address_id',
          'Địa chỉ nhận hàng',
          customer.addresses
            .filter((a) => a.customer_id === row.customer_id)
            .map((a) => ({ id: a.id, name: `${a.recipient_name} · ${a.address_line}` })),
          { required: false },
        ),
      ],
      (v) => repo.setOrderAddress(v.order_id, v.address_id),
      'Để trống sẽ dùng liên hệ cũ và đánh dấu chưa xác minh khi xác nhận đơn. Chỉ địa chỉ của đúng khách hàng được chấp nhận.',
    );
  const reserveForm = () =>
    open(
      'Tạo lượt giữ hàng',
      {
        product_id: '',
        warehouse_id: warehouses[0]?.id || '',
        qty: '1',
        date: today(),
        reference: '',
        reason: '',
      },
      [
        select(
          'product_id',
          'SKU cần giữ',
          products.filter((p) => !p.provisional),
        ),
        select('warehouse_id', 'Kho', warehouses),
        text('qty', 'Số lượng', { type: 'number', min: 1, max: 1000000, step: 1 }),
        operationDate(),
        text('reference', 'Mã tham chiếu', { required: false, maxLength: 120 }),
        reason(),
      ],
      repo.reserveInventory,
      'Giữ hàng làm giảm số có thể bán; không xuất kho và không ghi doanh thu. Lượt giữ không tự hết hạn.',
    );
  const releaseForm = (r) =>
    open(
      'Giải phóng hàng giữ',
      { id: r.id, date: today(), reason: '' },
      [operationDate(), reason()],
      (v, id) => repo.releaseInventoryReservation(v.id, v.date, v.reason, id),
      `Giải phóng toàn bộ ${r.qty} sản phẩm ${label(products, r.product_id)}.`,
      'Giải phóng',
    );
  const transferForm = () =>
    open(
      'Chuyển hàng giữ sang đơn',
      { order_id: '', reservation_ids: [], date: today() },
      [
        select(
          'order_id',
          'Đơn nháp',
          drafts.map((o) => ({ ...o, name: label(customers, o.customer_id) })),
        ),
        operationDate(),
        {
          key: 'reservation_ids',
          label: 'Chọn lượt giữ đang hoạt động',
          type: 'multi',
          items: stock.reservations
            .filter((r) => r.status === 'active')
            .map((r) => ({
              id: r.id,
              name: `${label(products, r.product_id)} × ${r.qty} · ${label(warehouses, r.warehouse_id)} · ${r.reference || r.id.slice(0, 8)}`,
            })),
        },
      ],
      (v, id) => repo.transferInventoryReservations(v.order_id, v.reservation_ids, v.date, id),
      'Các lượt giữ phải khớp đủ SKU, số lượng và kho của toàn bộ đơn. Thành công sẽ xác nhận đơn và chuyển phần giữ trong cùng một giao dịch.',
      'Chuyển và xác nhận đơn',
    );
  const paymentForm = (row) =>
    open(
      row ? 'Sửa kế hoạch thanh toán' : 'Thêm kế hoạch thanh toán',
      row || { order_id: '', kind: 'balance', amount: '1', method: 'bank', notes: '' },
      [
        select(
          'order_id',
          'Đơn hàng',
          orders.filter((o) => o.status !== 'cancelled' || o.id === row?.order_id).map((o) => ({ ...o, name: label(customers, o.customer_id) })),
          { disabled: Boolean(row) },
        ),
        select(
          'kind',
          'Loại kế hoạch',
          options(['deposit', 'Đặt cọc'], ['balance', 'Thanh toán'], ['refund', 'Hoàn tiền']),
          { disabled: Boolean(row) },
        ),
        text('amount', 'Số tiền dự kiến (VND)', {
          type: 'number',
          min: 1,
          max: 9000000000000,
          step: 1,
        }),
        select(
          'method',
          'Phương thức dự kiến',
          options(
            ['cash', 'Tiền mặt'],
            ['bank', 'Chuyển khoản'],
            ['cod', 'COD'],
            ['other', 'Khác'],
          ),
        ),
        memo('notes', 'Ghi chú'),
      ],
      repo.saveOrderPaymentIntent,
      'Đây là kế hoạch, chưa chứng minh đã thu hoặc hoàn tiền. Không thay đổi sổ thu chi hoặc doanh thu.',
    );
  const voidPayment = (r) =>
    open(
      'Hủy kế hoạch thanh toán',
      { id: r.id, reason: '' },
      [reason()],
      (v) => repo.voidOrderPaymentIntent(v.id, v.reason),
      'Giữ lịch sử kế hoạch; không tạo bút toán thu chi.',
      'Hủy kế hoạch',
    );
  return (
    <div className="foundation-page">
      <div className="foundation-toolbar">
        <div className="foundation-tabs" role="group" aria-label="Phân hệ nền tảng thương mại">
          {tabs.map(([id, name]) => (
            <button
              key={id}
              className={`button ${tab === id ? 'primary' : 'secondary'}`}
              aria-pressed={tab === id}
              onClick={() => setTab(id)}
            >
              {name}
            </button>
          ))}
        </div>
        <button className="button secondary" onClick={reload}>
          Tải lại
        </button>
      </div>
      {notice && (
        <p className="sales-note" role="status">
          {notice}
        </p>
      )}
      {!canManage && (
        <p className="sales-note">
          Bạn có quyền xem. Chủ shop hoặc quản lý thực hiện thay đổi danh mục và giữ hàng.
          {canDraft && ' Nhân viên có thể chọn địa chỉ cho đơn nháp.'}
        </p>
      )}
      {tab === 'variants' && (
        <>
          <Panel
            title="Kiểu dáng"
            note="Nhóm cha của các SKU đã được đối chiếu."
            action={addButton(() => styleForm(), 'Thêm kiểu dáng')}
          >
            <Table headers={['Mã', 'Tên', 'Ghi chú', 'Thao tác']} empty={!catalog.styles.length}>
              {catalog.styles.map((r) => (
                <tr key={r.id}>
                  <td>{r.code}</td>
                  <td>{r.name}</td>
                  <td>{r.notes}</td>
                  <td>{editButton(() => styleForm(r))}</td>
                </tr>
              ))}
            </Table>
          </Panel>
          <Panel
            title="Tương thích SKU và biến thể"
            note={`${catalog.reconciliation.product_count} SKU · ${catalog.reconciliation.variant_count} biến thể · ${catalog.reconciliation.review_count} cần đối chiếu · ${catalog.reconciliation.unmapped_count} chưa ánh xạ`}
          >
            <Table
              headers={['SKU gốc', 'Kiểu dáng', 'Kích cỡ / màu', 'Đối chiếu', 'Thao tác']}
              empty={!catalog.variants.length}
            >
              {catalog.variants.map((r) => (
                <tr key={r.id}>
                  <td>{label(products, r.product_id)}</td>
                  <td>{label(catalog.styles, r.style_id)}</td>
                  <td>
                    {r.size || 'Chưa rõ'} / {r.color || 'Chưa rõ'}
                  </td>
                  <td>
                    {r.mapping_status === 'confirmed' ? 'Đã xác nhận' : 'Cần đối chiếu'}
                    {named(products, r.product_id)?.provisional && ' · SKU tạm'}
                    <small>{r.review_note}</small>
                  </td>
                  <td>{editButton(() => variantForm(r), 'Đối chiếu')}</td>
                </tr>
              ))}
            </Table>
          </Panel>
        </>
      )}
      {tab === 'aliases' && (
        <>
          <Panel
            title="Tra cứu alias"
            note="Khớp chính xác sau chuẩn hóa chữ hoa/thường và khoảng trắng; không phân tích bình luận."
          >
            <AliasLookup key={revision} repo={repo} />
          </Panel>
          <Panel title="Tên gọi thay thế" action={addButton(() => aliasForm(), 'Thêm alias')}>
            <Table
              headers={['Alias', 'SKU', 'Trạng thái', 'Thao tác']}
              empty={!catalog.aliases.length}
            >
              {catalog.aliases.map((r) => (
                <tr key={r.id}>
                  <td>{r.alias_text}</td>
                  <td>{label(products, r.product_id)}</td>
                  <td>{r.active ? 'Đang dùng' : 'Ngừng dùng'}</td>
                  <td>{editButton(() => aliasForm(r))}</td>
                </tr>
              ))}
            </Table>
          </Panel>
        </>
      )}
      {tab === 'customers' && (
        <>
          <Panel
            title="Định danh khách hàng"
            note="Tạo khách tại mục Khách hàng trước; chỉ liên kết định danh sau khi kiểm tra đúng người."
            action={addButton(() => identityForm(), 'Thêm định danh')}
          >
            <Table
              headers={['Khách hàng', 'Loại', 'Định danh', 'Xác minh', 'Thao tác']}
              empty={!customer.identities.length}
            >
              {customer.identities.map((r) => (
                <tr key={r.id}>
                  <td>{label(customers, r.customer_id)}</td>
                  <td>{r.channel}</td>
                  <td>{r.external_id}</td>
                  <td>{r.verified ? 'Đã xác minh thủ công' : 'Chưa xác minh'}</td>
                  <td>{editButton(() => identityForm(r))}</td>
                </tr>
              ))}
            </Table>
          </Panel>
          <Panel title="Địa chỉ nhận hàng" action={addButton(() => addressForm(), 'Thêm địa chỉ')}>
            <Table
              headers={['Khách hàng', 'Người nhận', 'Địa chỉ', 'Trạng thái', 'Thao tác']}
              empty={!customer.addresses.length}
            >
              {customer.addresses.map((r) => (
                <tr key={r.id}>
                  <td>{label(customers, r.customer_id)}</td>
                  <td>
                    {r.recipient_name}
                    <small>{r.phone}</small>
                  </td>
                  <td>
                    {r.address_line}
                    <small>{[r.region, r.city, r.country].filter(Boolean).join(', ')}</small>
                  </td>
                  <td>
                    {r.is_default && 'Mặc định · '}
                    {r.verified ? 'Đã xác minh' : 'Chưa xác minh'}
                  </td>
                  <td>{editButton(() => addressForm(r))}</td>
                </tr>
              ))}
            </Table>
          </Panel>
          <Panel
            title="Địa chỉ đơn nháp"
            note="Địa chỉ sẽ được chụp lại khi xác nhận đơn; đơn cũ không được suy diễn địa chỉ lịch sử."
          >
            <Table
              headers={['Đơn', 'Khách hàng', 'Địa chỉ được chọn', 'Thao tác']}
              empty={!drafts.length}
            >
              {drafts.map((r) => (
                <tr key={r.id}>
                  <td>{r.code}</td>
                  <td>{label(customers, r.customer_id)}</td>
                  <td>
                    {named(customer.addresses, r.shipping_address_id)?.address_line ||
                      'Liên hệ cũ, chưa xác minh'}
                  </td>
                  <td>
                    {canDraft && (
                      <button
                        className="button secondary small"
                        onClick={() => orderAddressForm(r)}
                      >
                        Chọn địa chỉ
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </Table>
          </Panel>
        </>
      )}
      {tab === 'inventory' && (
        <>
          <Panel
            title="Tồn kho khả dụng"
            note="Đã giữ bao gồm đơn bán và lượt giữ thủ công. Chuyển sang đơn không tính giữ hai lần."
          >
            <Table
              headers={['SKU', 'Kho', 'Tồn vật lý', 'Đã giữ', 'Có thể bán']}
              empty={!stock.inventory.length}
            >
              {stock.inventory.map((r) => (
                <tr key={`${r.product_id}-${r.warehouse_id}`}>
                  <td>{label(products, r.product_id)}</td>
                  <td>{label(warehouses, r.warehouse_id)}</td>
                  <td>{r.on_hand}</td>
                  <td>{r.reserved}</td>
                  <td>{r.available}</td>
                </tr>
              ))}
            </Table>
          </Panel>
          <Panel
            title="Lượt giữ hàng thủ công"
            note="Hàng giữ không tự hết hạn. Giải phóng khi không còn nhu cầu."
            action={
              <div className="foundation-actions">
                {addButton(reserveForm, 'Tạo lượt giữ')}
                {canManage && (
                  <button className="button secondary" onClick={transferForm}>
                    Chuyển sang đơn
                  </button>
                )}
              </div>
            }
          >
            <Table
              headers={['SKU / Kho', 'Số lượng', 'Ngày / Tham chiếu', 'Trạng thái', 'Thao tác']}
              empty={!stock.reservations.length}
            >
              {stock.reservations.map((r) => (
                <tr key={r.id}>
                  <td>
                    {label(products, r.product_id)}
                    <small>{label(warehouses, r.warehouse_id)}</small>
                  </td>
                  <td>{r.qty}</td>
                  <td>
                    {dateLabel(r.reserved_date)}
                    <small>{r.reference || r.id.slice(0, 8)}</small>
                  </td>
                  <td>
                    {
                      {
                        active: 'Đang giữ',
                        released: 'Đã giải phóng',
                        consumed: 'Đã chuyển sang đơn',
                      }[r.status]
                    }
                    <small>{named(orders, r.order_id)?.code}</small>
                  </td>
                  <td>{r.status === 'active' && editButton(() => releaseForm(r), 'Giải phóng')}</td>
                </tr>
              ))}
            </Table>
          </Panel>
        </>
      )}
      {tab === 'payments' && (
        <Panel
          title="Kế hoạch thanh toán"
          note="Dự kiến / chưa ghi nhận thu chi. Giao thành công không có nghĩa đã nhận COD."
          action={addButton(() => paymentForm(), 'Thêm kế hoạch')}
        >
          <Table
            headers={['Đơn', 'Loại', 'Số tiền dự kiến', 'Phương thức', 'Trạng thái', 'Thao tác']}
            empty={!customer.payment_intents.length}
          >
            {customer.payment_intents.map((r) => (
              <tr key={r.id}>
                <td>{named(orders, r.order_id)?.code}</td>
                <td>
                  {{ deposit: 'Đặt cọc', balance: 'Thanh toán', refund: 'Hoàn tiền' }[r.kind]}
                </td>
                <td>{money(r.amount)}</td>
                <td>
                  {{ cash: 'Tiền mặt', bank: 'Chuyển khoản', cod: 'COD', other: 'Khác' }[r.method]}
                </td>
                <td>
                  {r.status === 'planned' ? 'Dự kiến' : 'Đã hủy'}
                  <small>{r.notes}</small>
                </td>
                <td>
                  <div className="foundation-actions">
                    {r.status === 'planned' && (
                      <>
                        {editButton(() => paymentForm(r))}
                        {editButton(() => voidPayment(r), 'Hủy')}
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        </Panel>
      )}
      {modal && (
        <Editor
          config={modal}
          onClose={() => setModal(null)}
          onSave={() => {
            setModal(null);
            setNotice('Đã lưu thao tác. Dữ liệu được đọc lại từ workspace.');
            reload();
          }}
        />
      )}
    </div>
  );
}
