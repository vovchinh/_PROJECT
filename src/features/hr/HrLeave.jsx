import { useEffect, useRef, useState } from 'react';
import { Badge, ErrorMessage, Field, Modal, Panel, Select, Table } from '../../components.jsx';
import { EmployeePicker, HrPager, isoToday } from './HrShared.jsx';

const PAGE_SIZE = 25;
const LEAVE_TYPES = [
  { value: 'annual', label: 'Nghỉ phép năm' },
  { value: 'sick', label: 'Nghỉ ốm' },
  { value: 'unpaid', label: 'Nghỉ không lương' },
  { value: 'other', label: 'Nghỉ khác' },
];
const LEAVE_STATUS = [
  { value: 'draft', label: 'Nháp' },
  { value: 'pending', label: 'Chờ duyệt' },
  { value: 'approved', label: 'Đã duyệt' },
  { value: 'rejected', label: 'Từ chối' },
  { value: 'cancelled', label: 'Đã hủy' },
];

const statusLabel = (value) => LEAVE_STATUS.find((item) => item.value === value)?.label || value;
const typeLabel = (value) => LEAVE_TYPES.find((item) => item.value === value)?.label || value;
const dateLabel = (value) => value ? new Intl.DateTimeFormat('vi-VN', { timeZone: 'UTC' })
  .format(new Date(`${value.slice(0, 10)}T00:00:00Z`)) : '—';
const dateSpan = (start, end) => {
  const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000 + 1;
  return Number.isInteger(days) && days > 0 ? days : 0;
};
const hourSpan = (start, end) => {
  if (!start || !end) return 0;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  return Math.round(((eh * 60 + em) - (sh * 60 + sm)) / 60 * 100) / 100;
};

function emptyForm() {
  const today = isoToday();
  return { id: null, employee_id: null, leave_type: 'annual', start_date: today,
    end_date: today, duration_unit: 'day', start_time: '', end_time: '', quantity: '1', reason: '' };
}

function editForm(row) {
  return { id: row.id, employee_id: row.employee_id, leave_type: row.leave_type,
    start_date: row.start_date, end_date: row.end_date, duration_unit: row.duration_unit,
    start_time: row.start_time?.slice(0, 5) || '', end_time: row.end_time?.slice(0, 5) || '',
    quantity: String(row.quantity), reason: row.reason || '' };
}

export default function HrLeave({ api, onChanged }) {
  const [status, setStatus] = useState('');
  const [employeeId, setEmployeeId] = useState(null);
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [actionError, setActionError] = useState('');
  const [formError, setFormError] = useState('');
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState(null);
  const [viewRow, setViewRow] = useState(null);
  const [transition, setTransition] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const attempt = useRef(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setListError('');
    api.listLeave({ status: status || null, employeeId, page, pageSize: PAGE_SIZE })
      .then((data) => { if (active) setResult(data); })
      .catch((cause) => { if (active) setListError(cause.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, status, employeeId, page, revision]);

  function openForm(row = null) {
    attempt.current = null;
    setFormError('');
    setActionError('');
    setForm(row ? editForm(row) : emptyForm());
  }

  function openTransition(row, target) {
    attempt.current = null;
    setActionError('');
    setFormError('');
    setReason('');
    setTransition({ row, target });
  }

  async function changed(message) {
    setNotice(message);
    setRevision((value) => value + 1);
    await onChanged?.(message);
  }

  async function save(event) {
    event.preventDefault();
    if (busy || !form) return;
    setFormError('');
    if (!form.employee_id) { setFormError('Chọn nhân viên.'); return; }
    const dayCount = dateSpan(form.start_date, form.end_date);
    if (!dayCount || dayCount > 366) { setFormError('Khoảng ngày nghỉ phải hợp lệ và không quá 366 ngày.'); return; }
    if (form.duration_unit === 'hour' && (form.start_date !== form.end_date || hourSpan(form.start_time, form.end_time) <= 0)) {
      setFormError('Nghỉ theo giờ cần cùng một ngày và giờ kết thúc sau giờ bắt đầu.');
      return;
    }
    const qty = form.duration_unit === 'hour' ? hourSpan(form.start_time, form.end_time) : Number(form.quantity);
    if (!Number.isFinite(qty) || qty <= 0 || (form.duration_unit === 'day' && qty > dayCount)) {
      setFormError('Số ngày nghỉ phải lớn hơn 0 và không vượt quá khoảng ngày đã chọn.');
      return;
    }
    const payload = { id: form.id || undefined, employee_id: form.employee_id, leave_type: form.leave_type,
      start_date: form.start_date, end_date: form.duration_unit === 'hour' ? form.start_date : form.end_date,
      duration_unit: form.duration_unit, start_time: form.duration_unit === 'hour' ? form.start_time : null,
      end_time: form.duration_unit === 'hour' ? form.end_time : null, quantity: qty, reason: form.reason.trim() };
    const signature = JSON.stringify(payload);
    if (attempt.current?.signature !== signature) attempt.current = { signature, id: crypto.randomUUID() };
    setBusy(true);
    try {
      await api.saveLeave(payload, attempt.current.id);
      setForm(null);
      attempt.current = null;
      await changed(form.id ? 'Đã cập nhật đơn nghỉ nháp.' : 'Đã tạo đơn nghỉ nháp.');
    } catch (cause) { setFormError(cause.message); }
    finally { setBusy(false); }
  }

  async function applyTransition(event) {
    event.preventDefault();
    if (busy || !transition) return;
    setFormError('');
    const trimmed = reason.trim();
    if (['rejected', 'cancelled'].includes(transition.target) && trimmed.length < 5) {
      setFormError('Cần lý do ít nhất 5 ký tự để từ chối hoặc hủy đơn.');
      return;
    }
    const signature = JSON.stringify([transition.row.id, transition.target, trimmed]);
    if (attempt.current?.signature !== signature) attempt.current = { signature, id: crypto.randomUUID() };
    setBusy(true);
    try {
      await api.transitionLeave(transition.row.id, transition.target, trimmed, attempt.current.id);
      const label = statusLabel(transition.target).toLowerCase();
      setTransition(null);
      attempt.current = null;
      await changed(`Đơn nghỉ đã chuyển sang ${label}.`);
    } catch (cause) { setFormError(cause.message); }
    finally { setBusy(false); }
  }

  function clearFilters() {
    setStatus('');
    setEmployeeId(null);
    setPage(1);
  }

  return <div className="hr-records hr-leave">
    <Panel title="Nghỉ phép" note="Đơn nghỉ được duyệt riêng; không tự động thay đổi lương."
      action={<button className="button primary" onClick={() => openForm()}>+ Tạo đơn nghỉ</button>}>
      <div className="hr-records-toolbar">
        <EmployeePicker api={api} label="Lọc nhân viên" value={employeeId}
          onChange={(value) => { setEmployeeId(value); setPage(1); }} />
        <Field label="Trạng thái"><Select items={LEAVE_STATUS} placeholder="Tất cả trạng thái" value={status}
          onChange={(event) => { setStatus(event.target.value); setPage(1); }} /></Field>
        {(status || employeeId) && <button className="button secondary" onClick={clearFilters}>Xóa bộ lọc</button>}
      </div>
      <p className="hr-records-state" aria-live="polite">{loading ? 'Đang tải đơn nghỉ…' : `${result.total || 0} đơn nghỉ`}</p>
      {notice && <p className="hr-records-notice" role="status">{notice}</p>}
      <ErrorMessage error={listError || actionError} />
      {!loading && !listError && <>
        <Table headers={['Ngày tạo', 'Nhân viên', 'Loại nghỉ', 'Thời gian', 'Số lượng', 'Trạng thái', 'Thao tác']}
          empty={!result.items?.length}>
          {(result.items || []).map((row) => <tr key={row.id}>
            <td>{dateLabel(row.created_at)}</td>
            <td><strong>{row.employee_name}</strong><small>{row.employee_code} · {row.department_name || 'Chưa có phòng ban'}</small></td>
            <td>{typeLabel(row.leave_type)}</td>
            <td>{dateLabel(row.start_date)} → {dateLabel(row.end_date)}
              {row.duration_unit === 'hour' && <small>{row.start_time?.slice(0, 5)}–{row.end_time?.slice(0, 5)}</small>}</td>
            <td>{Number(row.quantity).toLocaleString('vi-VN')} {row.duration_unit === 'hour' ? 'giờ' : 'ngày'}</td>
            <td><Badge status={row.status === 'approved' ? 'posted' : row.status === 'cancelled' || row.status === 'rejected' ? 'reversed' : 'draft'}>{statusLabel(row.status)}</Badge></td>
            <td><div className="hr-record-actions">
              <button className="button secondary" onClick={() => setViewRow(row)}>Xem</button>
              {row.status === 'draft' && <>
                <button className="button secondary" onClick={() => openForm(row)}>Sửa</button>
                <button className="button primary" onClick={() => openTransition(row, 'pending')}>Gửi duyệt</button>
                <button className="button secondary" onClick={() => openTransition(row, 'cancelled')}>Hủy</button>
              </>}
              {row.status === 'pending' && <>
                <button className="button primary" onClick={() => openTransition(row, 'approved')}>Duyệt</button>
                <button className="button secondary" onClick={() => openTransition(row, 'rejected')}>Từ chối</button>
                <button className="button secondary" onClick={() => openTransition(row, 'cancelled')}>Hủy</button>
              </>}
            </div></td>
          </tr>)}
        </Table>
        <HrPager total={result.total} page={page} pageSize={PAGE_SIZE} onPage={setPage} />
      </>}
    </Panel>

    {viewRow && <Modal title="Chi tiết đơn nghỉ" description={`${viewRow.employee_code} · ${viewRow.employee_name}`}
      onClose={() => setViewRow(null)}>
      <dl className="hr-detail-grid">
        <div><dt>Trạng thái</dt><dd>{statusLabel(viewRow.status)}</dd></div>
        <div><dt>Loại nghỉ</dt><dd>{typeLabel(viewRow.leave_type)}</dd></div>
        <div><dt>Từ ngày</dt><dd>{dateLabel(viewRow.start_date)}</dd></div>
        <div><dt>Đến ngày</dt><dd>{dateLabel(viewRow.end_date)}</dd></div>
        {viewRow.duration_unit === 'hour' && <div><dt>Giờ nghỉ</dt><dd>{viewRow.start_time?.slice(0, 5)}–{viewRow.end_time?.slice(0, 5)}</dd></div>}
        <div><dt>Thời lượng</dt><dd>{Number(viewRow.quantity).toLocaleString('vi-VN')} {viewRow.duration_unit === 'hour' ? 'giờ' : 'ngày'}</dd></div>
        <div><dt>Lý do</dt><dd>{viewRow.reason || 'Chưa ghi'}</dd></div>
        <div><dt>Ngày gửi duyệt</dt><dd>{viewRow.submitted_at ? new Date(viewRow.submitted_at).toLocaleString('vi-VN') : '—'}</dd></div>
        <div><dt>Ngày quyết định</dt><dd>{viewRow.decided_at ? new Date(viewRow.decided_at).toLocaleString('vi-VN') : '—'}</dd></div>
      </dl>
      <footer className="modal-actions"><button className="button secondary" onClick={() => setViewRow(null)}>Đóng</button></footer>
    </Modal>}

    {form && <Modal title={form.id ? 'Sửa đơn nghỉ nháp' : 'Tạo đơn nghỉ'}
      description="Sau khi gửi duyệt, đơn chỉ thay đổi theo quy trình phê duyệt."
      onClose={() => { if (!busy) setForm(null); }}>
      <form onSubmit={save}><fieldset disabled={busy} className="hr-record-fieldset"><div className="form-grid">
        <EmployeePicker api={api} value={form.employee_id} onChange={(value) => setForm({ ...form, employee_id: value })} />
        <Field label="Loại nghỉ"><Select required items={LEAVE_TYPES} value={form.leave_type}
          onChange={(event) => setForm({ ...form, leave_type: event.target.value })} /></Field>
        <Field label="Đơn vị"><Select required items={[{ value: 'day', label: 'Ngày' }, { value: 'hour', label: 'Giờ' }]}
          value={form.duration_unit} onChange={(event) => setForm({ ...form, duration_unit: event.target.value,
            end_date: event.target.value === 'hour' ? form.start_date : form.end_date,
            quantity: event.target.value === 'hour' ? '0' : '1' })} /></Field>
        <Field label="Từ ngày"><input type="date" required value={form.start_date}
          onChange={(event) => setForm({ ...form, start_date: event.target.value,
            end_date: form.duration_unit === 'hour' ? event.target.value : form.end_date })} /></Field>
        {form.duration_unit === 'day' && <Field label="Đến ngày"><input type="date" required min={form.start_date}
          value={form.end_date} onChange={(event) => setForm({ ...form, end_date: event.target.value })} /></Field>}
        {form.duration_unit === 'hour' ? <>
          <Field label="Bắt đầu lúc"><input type="time" required value={form.start_time}
            onChange={(event) => setForm({ ...form, start_time: event.target.value })} /></Field>
          <Field label="Kết thúc lúc"><input type="time" required value={form.end_time}
            onChange={(event) => setForm({ ...form, end_time: event.target.value })} /></Field>
          <div className="hr-record-form-note">Số giờ nghỉ: {Math.max(0, hourSpan(form.start_time, form.end_time)).toLocaleString('vi-VN')} giờ</div>
        </> : <Field label="Số ngày nghỉ" hint="Có thể nhập nửa ngày; không vượt số ngày trong khoảng.">
          <input type="number" required min="0.01" max="366" step="0.01" value={form.quantity}
            onChange={(event) => setForm({ ...form, quantity: event.target.value })} />
        </Field>}
        <Field label="Lý do" span><textarea rows="3" maxLength="4000" value={form.reason}
          onChange={(event) => setForm({ ...form, reason: event.target.value })} /></Field>
        <div className="span-2"><ErrorMessage error={formError} /></div>
      </div></fieldset><footer className="modal-actions">
        <button type="button" className="button secondary" disabled={busy} onClick={() => setForm(null)}>Đóng</button>
        <button className="button primary" disabled={busy || !form.employee_id}>{busy ? 'Đang lưu…' : 'Lưu nháp'}</button>
      </footer></form>
    </Modal>}

    {transition && <Modal title={`${statusLabel(transition.target)} đơn nghỉ`}
      description={`${transition.row.employee_code} · ${transition.row.employee_name} · ${dateLabel(transition.row.start_date)} → ${dateLabel(transition.row.end_date)}`}
      onClose={() => { if (!busy) setTransition(null); }}>
      <form onSubmit={applyTransition}><div className="confirm-body">
        <p>{transition.target === 'approved'
          ? 'Duyệt đơn sẽ ghi nhận quyết định, nhưng không tự động tính khấu trừ lương.'
          : transition.target === 'pending'
            ? 'Sau khi gửi duyệt, chỉ có thể duyệt, từ chối hoặc hủy đơn.'
            : 'Quyết định và lý do được lưu trong lịch sử nhân sự.'}</p>
        {['rejected', 'cancelled'].includes(transition.target) && <Field label="Lý do">
          <textarea required minLength="5" maxLength="4000" rows="3" value={reason}
            onChange={(event) => setReason(event.target.value)} />
        </Field>}
        <ErrorMessage error={formError} />
      </div><footer className="modal-actions">
        <button type="button" className="button secondary" disabled={busy} onClick={() => setTransition(null)}>Quay lại</button>
        <button className="button primary" disabled={busy}>{busy ? 'Đang xử lý…' : `Xác nhận ${statusLabel(transition.target).toLowerCase()}`}</button>
      </footer></form>
    </Modal>}
  </div>;
}
