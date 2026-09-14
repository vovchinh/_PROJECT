import { useState } from 'react';
import { Check, LoaderCircle } from 'lucide-react';
import { CATEGORIES, money, purchaseTotal, today } from './lib/domain.js';
import { Modal, Field, Select, ErrorMessage } from './components.jsx';

export function DocumentForm({ kind, row, data, repo, onDone, onClose }) {
  const isPurchase = kind === 'purchase';
  const [form, setForm] = useState(
    row
      ? { ...row }
      : {
          qty: 1,
          unit_cost: '',
          additional_cost: 0,
          received_date: today(),
          transaction_date: today(),
          date_estimated: false,
          warehouse_id: data.warehouses[0]?.id || '',
          direction: 'out',
          amount: '',
          description: '',
          category: 'packaging',
          notes: '',
        },
  );
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const input = (key, type = 'text', extra = {}) => (
    <input
      type={type}
      value={form[key] ?? ''}
      onChange={(e) => set(key, e.target.value)}
      {...extra}
    />
  );
  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await (isPurchase ? repo.createPurchase(form) : repo.createCash(form));
      await onDone('Đã lưu chứng từ chờ xác nhận.');
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  let total = 0;
  try {
    if (isPurchase) total = purchaseTotal(form);
  } catch {
    /* incomplete form */
  }
  return (
    <Modal
      title={`${row ? 'Chỉnh sửa' : 'Tạo'} ${isPurchase ? 'phiếu nhập hàng' : 'phiếu thu chi'}`}
      description="Lưu nháp trước; xác nhận ghi sổ là một thao tác riêng."
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <div className="form-grid">
          {isPurchase ? (
            <>
              <Field label="Nhà cung cấp">
                <Select
                  value={form.supplier_id || ''}
                  onChange={(e) => set('supplier_id', e.target.value)}
                  items={data.suppliers}
                />
              </Field>
              <Field label="Sản phẩm / SKU">
                <Select
                  value={form.product_id || ''}
                  onChange={(e) => {
                    const p = data.products.find((p) => p.id === e.target.value);
                    setForm((f) => ({
                      ...f,
                      product_id: p?.id || '',
                      unit_cost: p?.unit_cost ?? f.unit_cost,
                      supplier_id: p?.supplier_id || f.supplier_id,
                    }));
                  }}
                  items={data.products}
                />
              </Field>
              <Field label="Ngày nhận">{input('received_date', 'date')}</Field>
              <Field label="Kho nhận">
                <Select
                  value={form.warehouse_id || ''}
                  onChange={(e) => set('warehouse_id', e.target.value)}
                  items={data.warehouses}
                />
              </Field>
              <Field label="Số lượng">
                {input('qty', 'number', { min: 1, max: 1000000, step: 1, required: true })}
              </Field>
              <Field label="Đơn giá mua (đ)">
                {input('unit_cost', 'number', {
                  min: 0,
                  max: 9000000000000,
                  step: 1,
                  required: true,
                })}
              </Field>
              <Field
                label="Chi phí nhập thêm (đ)"
                hint="Chỉ nhập phí có chứng từ; không cộng tiền trả nhà cung cấp lần hai."
              >
                {input('additional_cost', 'number', { min: 0, step: 1 })}
              </Field>
              <div className="calculated">
                <small>Tổng tiền hàng và phí nhập</small>
                <strong>{money(total)}</strong>
              </div>
            </>
          ) : (
            <>
              <Field label="Loại giao dịch">
                <Select
                  value={form.direction}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      direction: e.target.value,
                      category: e.target.value === 'in' ? 'customer_receipt' : 'packaging',
                    }))
                  }
                  items={[
                    { value: 'out', label: 'Chi tiền' },
                    { value: 'in', label: 'Thu tiền' },
                  ]}
                />
              </Field>
              <Field label="Ngày thực tế">{input('transaction_date', 'date')}</Field>
              <Field label="Nội dung" span>
                {input('description', 'text', { maxLength: 500, required: true })}
              </Field>
              <Field label="Tài khoản tiền">
                <Select
                  value={form.account_id || ''}
                  onChange={(e) => set('account_id', e.target.value)}
                  items={data.cash_accounts}
                  placeholder="Chưa xác định"
                />
              </Field>
              <Field label="Nhóm thu chi">
                <Select
                  value={form.category || ''}
                  onChange={(e) => set('category', e.target.value)}
                  items={CATEGORIES.filter((c) => c[2] === form.direction).map((c) => ({
                    value: c[0],
                    label: c[1],
                  }))}
                />
              </Field>
              <Field label="Số tiền (đ)">
                {input('amount', 'number', { min: 1, max: 9000000000000, step: 1, required: true })}
              </Field>
            </>
          )}
          <label className="checkbox span-2">
            <input
              type="checkbox"
              checked={Boolean(form.date_estimated)}
              onChange={(e) => set('date_estimated', e.target.checked)}
            />
            <span>Ngày đang ước tính — chưa dùng để ghi sổ chính thức</span>
          </label>
          <Field label="Ghi chú / căn cứ chứng từ" span>
            <textarea
              rows={3}
              value={form.notes || ''}
              onChange={(e) => set('notes', e.target.value)}
              maxLength={4000}
            />
          </Field>
          {row?.legacy_id && (
            <div className="source-note span-2">
              Mã nguồn: <strong>{row.legacy_id}</strong>. Chỉnh sửa bản nháp vẫn giữ dấu vết nhập dữ
              liệu gốc.
            </div>
          )}
        </div>
        <ErrorMessage error={error} />
        <footer className="modal-actions">
          <button className="button secondary" type="button" onClick={onClose}>
            Hủy
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}Lưu chờ xác
            nhận
          </button>
        </footer>
      </form>
    </Modal>
  );
}
export function MasterForm({ kind, row, data, repo, onDone, onClose }) {
  const labels = {
    suppliers: 'nhà cung cấp',
    products: 'sản phẩm',
    cash_accounts: 'tài khoản tiền',
    warehouses: 'kho hàng',
  };
  const [form, setForm] = useState(
    row
      ? { ...row }
      : {
          code: '',
          name: '',
          provisional: false,
          unit_cost: 0,
          opening_balance: 0,
          opening_date: '',
          opening_confirmed: false,
          note: '',
        },
  );
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const input = (k, type = 'text', props = {}) => (
    <input type={type} value={form[k] ?? ''} onChange={(e) => set(k, e.target.value)} {...props} />
  );
  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await repo.saveMaster(kind, form);
      await onDone('Đã lưu danh mục.');
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={`${row ? 'Sửa' : 'Thêm'} ${labels[kind]}`} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label="Mã" hint="Mã duy nhất, giữ cố định sau khi tạo.">
            {input('code', 'text', { required: true, disabled: Boolean(row), maxLength: 80 })}
          </Field>
          <Field label="Tên">{input('name', 'text', { required: true, maxLength: 200 })}</Field>
          {kind === 'products' && (
            <>
              <Field label="Nhà cung cấp mặc định">
                <Select
                  value={form.supplier_id || ''}
                  onChange={(e) => set('supplier_id', e.target.value)}
                  items={data.suppliers}
                />
              </Field>
              <Field label="Giá mua tham khảo (đ)">
                {input('unit_cost', 'number', { min: 0, max: 9000000000000, step: 1 })}
              </Field>
              <label className="checkbox span-2">
                <input
                  type="checkbox"
                  checked={Boolean(form.provisional)}
                  onChange={(e) => set('provisional', e.target.checked)}
                />
                <span>SKU tạm, chưa xác nhận mẫu / màu / size</span>
              </label>
            </>
          )}
          {kind === 'cash_accounts' && (
            <>
              <Field label="Số dư đầu (đ)">
                {input('opening_balance', 'number', {
                  min: -9000000000000,
                  max: 9000000000000,
                  step: 1,
                })}
              </Field>
              <Field label="Ngày mở sổ">{input('opening_date', 'date')}</Field>
              <label className="checkbox span-2">
                <input
                  type="checkbox"
                  checked={Boolean(form.opening_confirmed)}
                  onChange={(e) => set('opening_confirmed', e.target.checked)}
                />
                <span>Tôi đã đối chiếu và xác nhận số dư đầu, ngày mở sổ</span>
              </label>
              <div className="source-note span-2">
                Không mặc định số dư đầu bằng 0 khi chưa biết. Sau khi có giao dịch ghi sổ, số dư
                đầu và ngày mở sổ được khóa.
              </div>
            </>
          )}
          <Field label="Ghi chú" span>
            <textarea
              rows={3}
              value={form.note || ''}
              onChange={(e) => set('note', e.target.value)}
              maxLength={4000}
            />
          </Field>
        </div>
        <ErrorMessage error={error} />
        <footer className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Hủy
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}Lưu danh mục
          </button>
        </footer>
      </form>
    </Modal>
  );
}
