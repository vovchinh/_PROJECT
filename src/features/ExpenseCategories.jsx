import { useState } from 'react';
import { Panel, Table, Empty, Modal, Field, Select, ErrorMessage, Badge } from '../components.jsx';

const KINDS = [
  ['operating_expense', 'Chi phí vận hành'],
  ['inventory_purchase', 'Thanh toán nhập hàng'],
  ['owner_withdrawal', 'Chủ rút tiền'],
  ['owner_capital', 'Vốn chủ góp'],
  ['transfer', 'Chuyển tiền nội bộ'],
  ['loan', 'Vay / trả gốc'],
  ['cod_settlement', 'Đối soát COD'],
  ['customer_receipt', 'Thu từ khách'],
  ['other_receipt', 'Khoản thu khác'],
];
const kindLabel = (kind) => KINDS.find(([code]) => code === kind)?.[1] || kind;

export default function ExpenseCategories({ data, repo, onChanged, canManage, isOwner }) {
  const categories = data.expense_categories || [];
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(null);
  const [action, setAction] = useState(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const counts = data.cash_transactions.reduce((result, row) => {
    result[row.category] = (result[row.category] || 0) + 1;
    return result;
  }, {});

  function openForm(row = null) {
    setEditing(row);
    setForm(row ? { ...row } : {
      code: '', name: '', direction: 'out', category_kind: 'operating_expense',
      profit_eligible: false, description: '', sort_order: 500,
    });
    setError('');
  }
  async function save(event) {
    event.preventDefault();setBusy(true);setError('');
    try {
      await repo.saveExpenseCategory(form);
      await onChanged('Đã lưu nhóm thu chi.');
      setForm(null);setEditing(null);
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  }
  function openAction(row, type, event) {
    const menu = event.currentTarget.closest('details');
    if (menu) menu.open = false;
    setAction({ row, type });setReason('');setError('');
  }
  async function applyAction(event) {
    event.preventDefault();setBusy(true);setError('');
    try {
      if (action.type === 'delete') await repo.deleteExpenseCategory(action.row.id, reason);
      else await repo.setExpenseCategoryArchived(action.row.id, action.type === 'archive', reason);
      await onChanged('Đã cập nhật nhóm thu chi.');
      setAction(null);
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  }

  return <>
    <Panel title="Danh mục chi" note="Nhóm chi được chọn trực tiếp trên phiếu Thu chi; cách tính lợi nhuận được khóa khi ghi sổ."
      action={canManage && <button className="button primary" onClick={() => openForm()}>+ Thêm nhóm</button>}>
      {data.expense_category_reconciliation?.unknown_posted_count > 0 &&
        <p className="source-note">Có {data.expense_category_reconciliation.unknown_posted_count} giao dịch cũ chưa khớp nhóm. Hệ thống giữ nguyên mã gốc và chưa tự tính chúng là chi phí.</p>}
      {!categories.length ? <Empty title="Chưa có danh mục chi">Nếu dùng Supabase, áp dụng migration 014 sau 013 để quản lý nhóm.</Empty> :
        <Table headers={['Mã', 'Nhóm / loại', 'Tính lợi nhuận', 'Chứng từ', 'Trạng thái', 'Thao tác']}>
          {[...categories].sort((a, b) => a.sort_order - b.sort_order || a.code.localeCompare(b.code)).map((row) =>
            <tr key={row.id}>
              <td className="mono">{row.code}</td>
              <td><strong>{row.name}</strong><small>{kindLabel(row.category_kind)} · {row.direction === 'out' ? 'Chi' : 'Thu'}</small></td>
              <td>{row.profit_eligible ? 'Chi phí vận hành' : 'Không tính'}</td>
              <td>{counts[row.code] || 0}</td>
              <td><Badge status={row.is_active ? 'posted' : 'reversed'}>{row.is_active ? 'Đang dùng' : 'Đã lưu trữ'}</Badge></td>
              <td>{canManage && <details className="entity-actions"><summary aria-label={`Thao tác nhóm ${row.code}`}>⋯</summary>
                <div className="entity-actions-list">
                  <button onClick={() => openForm(row)}>Sửa</button>
                  <button onClick={(event) => openAction(row, row.is_active ? 'archive' : 'restore', event)}>{row.is_active ? 'Lưu trữ' : 'Khôi phục'}</button>
                  {isOwner && !row.is_system && !counts[row.code] && <button onClick={(event) => openAction(row, 'delete', event)}>Xóa nhóm chưa dùng</button>}
                </div>
              </details>}</td>
            </tr>)}
        </Table>}
    </Panel>
    {form && <Modal title={`${editing ? 'Sửa' : 'Thêm'} nhóm thu chi`} onClose={() => setForm(null)}>
      <form onSubmit={save}><div className="form-grid">
        <Field label="Mã nhóm" hint="Chữ thường, số, dấu gạch dưới; không đổi sau khi tạo.">
          <input required maxLength={80} pattern="[a-z][a-z0-9_]*" value={form.code || ''} disabled={Boolean(editing)} onChange={(event) => setForm({ ...form, code: event.target.value })} />
        </Field>
        <Field label="Tên nhóm"><input required maxLength={200} value={form.name || ''} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
        <Field label="Chiều tiền"><Select value={form.direction} disabled={Boolean(editing)}
          items={[{ value: 'out', label: 'Chi tiền' }, { value: 'in', label: 'Thu tiền' }]}
          onChange={(event) => setForm({ ...form, direction: event.target.value,
            category_kind: event.target.value === 'out' ? 'operating_expense' : 'other_receipt', profit_eligible: false })} /></Field>
        <Field label="Loại nghiệp vụ"><Select value={form.category_kind} disabled={Boolean(editing)}
          items={KINDS.map(([value, label]) => ({ value, label }))}
          onChange={(event) => setForm({ ...form, category_kind: event.target.value, profit_eligible: false })} /></Field>
        <Field label="Thứ tự"><input type="number" min={0} max={1000000} step={1} value={form.sort_order ?? 0}
          onChange={(event) => setForm({ ...form, sort_order: event.target.value })} /></Field>
        <label className="checkbox"><input type="checkbox" checked={Boolean(form.profit_eligible)}
          disabled={form.direction !== 'out' || form.category_kind !== 'operating_expense'}
          onChange={(event) => setForm({ ...form, profit_eligible: event.target.checked })} />
          <span>Tính là chi phí vận hành khi ghi sổ</span></label>
        <Field label="Mô tả" span><textarea rows={3} maxLength={4000} value={form.description || ''}
          onChange={(event) => setForm({ ...form, description: event.target.value })} /></Field>
      </div><ErrorMessage error={error} />
        <footer className="modal-actions"><button type="button" className="button secondary" onClick={() => setForm(null)}>Hủy</button>
          <button className="button primary" disabled={busy}>{busy ? 'Đang lưu…' : 'Lưu nhóm'}</button></footer>
      </form>
    </Modal>}
    {action && <Modal title={`${action.type === 'delete' ? 'Xóa' : action.type === 'archive' ? 'Lưu trữ' : 'Khôi phục'} ${action.row.name}`} onClose={() => setAction(null)}>
      <form onSubmit={applyAction}><div className="confirm-body">
        <p>{action.type === 'delete' ? 'Chỉ nhóm chưa có chứng từ hoặc lịch sử mới xóa được.' : 'Giao dịch đã ghi vẫn giữ nguyên nhóm và cách tính tại thời điểm ghi sổ.'}</p>
        <Field label="Lý do"><textarea required minLength={10} maxLength={4000} rows={3} value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
        <ErrorMessage error={error} />
      </div><footer className="modal-actions"><button type="button" className="button secondary" onClick={() => setAction(null)}>Hủy</button>
        <button className={`button ${action.type === 'delete' ? 'danger' : 'primary'}`} disabled={busy}>{busy ? 'Đang thực hiện…' : 'Xác nhận'}</button></footer></form>
    </Modal>}
  </>;
}
