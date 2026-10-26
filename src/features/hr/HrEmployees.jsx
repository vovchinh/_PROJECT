import { useEffect, useState } from 'react';
import { Panel, Table, Badge, Empty, ErrorMessage, Field, Select, Modal, SearchBox } from '../../components.jsx';
import { EmployeePicker, HrPager, employeeStatus } from './HrShared.jsx';

const PAGE_SIZE = 25;
const tabs = [['basic', 'Thông tin cơ bản'], ['work', 'Công việc'], ['contract', 'Hợp đồng'],
  ['account', 'Tài khoản'], ['history', 'Lịch sử']];
const initialForm = () => ({ code: '', full_name: '', phone: '', email: '', birth_date: '', address: '',
  department_id: '', position_id: '', manager_employee_id: '', work_location: '', hire_date: '',
  employee_type: 'full_time', status: 'active', auth_user_id: '', notes: '' });
const activeCatalog = (rows, currentId) => rows.filter((row) => row.is_active || row.id === currentId);
const initials = (name) => String(name || '?').trim().split(/\s+/).slice(-2).map((word) => word[0]).join('').toUpperCase();

export default function HrEmployees({ api, catalogs, onChanged, onViewPayroll }) {
  const [query, setQuery] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState('code');
  const [desc, setDesc] = useState(false);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState({ rows: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState(null);
  const [tab, setTab] = useState('basic');
  const [formError, setFormError] = useState('');
  const [audit, setAudit] = useState([]);
  const [action, setAction] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);setError('');
    api.listEmployees({ query, departmentId: departmentId || null, status: status || null,
      sort, desc, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE })
      .then((value) => { if (alive) setResult(value); })
      .catch((cause) => { if (alive) setError(cause.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [api, query, departmentId, status, sort, desc, page, revision]);

  function open(row = null) {
    setForm(row ? { ...row } : initialForm());setTab('basic');setFormError('');setAudit([]);
  }
  function change(key, value) {
    setForm((previous) => ({ ...previous, [key]: value,
      ...(key === 'department_id' ? { position_id: '' } : {}) }));
  }
  useEffect(() => {
    if (tab !== 'history' || !form?.id) return;
    let alive = true;
    api.employeeAudit(form.id).then((rows) => { if (alive) setAudit(rows); })
      .catch((cause) => { if (alive) setFormError(cause.message); });
    return () => { alive = false; };
  }, [api, tab, form?.id]);

  async function save(event) {
    event.preventDefault();setBusy(true);setFormError('');
    try {
      const payload = Object.fromEntries(['id', 'code', 'full_name', 'phone', 'email', 'birth_date', 'address',
        'department_id', 'position_id', 'manager_employee_id', 'work_location', 'hire_date',
        'employee_type', 'status', 'auth_user_id', 'notes']
        .filter((key) => key !== 'id' || form.id).map((key) => [key, form[key] ?? '']));
      const saved = await api.saveEmployee(payload);
      setForm(saved);setRevision((value) => value + 1);
      await onChanged?.('Đã lưu hồ sơ nhân viên.');
    } catch (cause) { setFormError(cause.message); }
    finally { setBusy(false); }
  }
  async function applyArchive(event) {
    event.preventDefault();setBusy(true);setFormError('');
    try {
      await api.setEmployeeArchived(action.id, action.is_active, reason);
      setAction(null);setReason('');setForm(null);setRevision((value) => value + 1);
      await onChanged?.('Đã cập nhật trạng thái lưu trữ nhân viên.');
    } catch (cause) { setFormError(cause.message); }
    finally { setBusy(false); }
  }
  const departments = catalogs?.departments || [];
  const positions = (catalogs?.positions || []).filter((position) =>
    (!position.department_id || position.department_id === form?.department_id));

  return <div className={`hr-employee-layout ${form ? 'has-form' : ''}`}>
    <Panel title="Danh sách nhân viên" note="Mã nhân viên duy nhất trong workspace; hồ sơ không tự tạo tài khoản đăng nhập."
      action={<button className="button primary" onClick={() => open()}>+ Thêm nhân viên</button>}>
      <div className="hr-list-toolbar">
        <SearchBox value={query} onChange={(value) => { setQuery(value);setPage(1); }} placeholder="Tìm mã, tên, SĐT, email…" />
        <select aria-label="Lọc phòng ban" value={departmentId} onChange={(event) => { setDepartmentId(event.target.value);setPage(1); }}>
          <option value="">Tất cả phòng ban</option>
          {departments.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
        </select>
        <select aria-label="Lọc trạng thái nhân viên" value={status} onChange={(event) => { setStatus(event.target.value);setPage(1); }}>
          <option value="">Đang lưu trong hệ thống</option>
          {Object.entries(employeeStatus).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <select aria-label="Sắp xếp nhân viên" value={sort} onChange={(event) => { setSort(event.target.value);setPage(1); }}>
          {[['code','Mã nhân viên'], ['full_name','Họ tên'], ['department','Phòng ban'],
            ['position','Chức vụ'], ['hire_date','Ngày vào làm'], ['created_at','Ngày tạo']]
            .map(([value,label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <button className="button secondary" onClick={() => { setDesc((value) => !value);setPage(1); }}>
          {desc ? 'Giảm dần ↓' : 'Tăng dần ↑'}</button>
      </div>
      <ErrorMessage error={error} />
      {loading ? <p className="hr-muted">Đang tải nhân viên…</p> : !error &&
        <Table headers={['Mã NV', 'Họ tên', 'Phòng ban', 'Chức vụ', 'SĐT', 'Trạng thái', 'Thao tác']}
          empty={!result.rows?.length}>
          {(result.rows || []).map((row) => <tr key={row.id}>
            <td className="mono">{row.code}</td>
            <td><div className="hr-person"><span className="hr-avatar">{initials(row.full_name)}</span>
              <div><strong>{row.full_name}</strong><small>{row.email || 'Chưa có email'}</small></div></div></td>
            <td>{row.department_name || '—'}</td><td>{row.position_name || '—'}</td><td>{row.phone || '—'}</td>
            <td><Badge status={row.is_active ? row.status : 'reversed'}>{row.is_active ? employeeStatus[row.status] : 'Đã lưu trữ'}</Badge></td>
            <td><details className="entity-actions"><summary aria-label={`Thao tác nhân viên ${row.code}`}>⋯</summary>
              <div className="entity-actions-list">
                <button onClick={() => open(row)}>Xem / sửa</button>
                <button onClick={() => { setAction(row);setReason('');setFormError(''); }}>{row.is_active ? 'Lưu trữ' : 'Khôi phục'}</button>
              </div></details></td>
          </tr>)}
        </Table>}
      <HrPager total={result.total} page={page} pageSize={PAGE_SIZE} onPage={setPage} />
    </Panel>

    {form ? <Panel title={form.id ? `Hồ sơ · ${form.code}` : 'Thêm nhân viên'}
      action={<button className="button secondary" onClick={() => setForm(null)}>Đóng</button>}>
      <div className="hr-form-tabs">{tabs.map(([id,label]) => <button key={id}
        className={tab === id ? 'active' : ''} onClick={() => { setTab(id);setFormError(''); }}>{label}</button>)}</div>
      {tab === 'contract' ? <div className="hr-form-content">
        {form.id ? <><p>Hợp đồng và mức lương theo hiệu lực được quản lý trong khu vực Tiền lương.</p>
          <button className="button primary" onClick={() => onViewPayroll(form.id)}>Mở hợp đồng & tiền lương</button></>
          : <p>Lưu hồ sơ nhân viên trước khi tạo hợp đồng.</p>}
      </div> : tab === 'history' ? <div className="hr-form-content">
        {!form.id ? <Empty title="Chưa có lịch sử">Lưu hồ sơ trước khi xem nhật ký.</Empty>
          : !audit.length ? <Empty title="Chưa có thao tác nhân sự" />
          : <ul className="hr-history">{audit.map((row) => <li key={row.id}>
              <strong>{row.action}</strong><small>{new Date(row.created_at).toLocaleString('vi-VN')}</small></li>)}</ul>}
      </div> : <form onSubmit={save} className="hr-employee-form">
        {tab === 'basic' && <div className="form-grid">
          <Field label="Mã nhân viên"><input required maxLength={80} disabled={Boolean(form.id)} value={form.code || ''} onChange={(event) => change('code', event.target.value)} /></Field>
          <Field label="Họ và tên"><input required maxLength={200} value={form.full_name || ''} onChange={(event) => change('full_name', event.target.value)} /></Field>
          <Field label="Số điện thoại"><input maxLength={30} value={form.phone || ''} onChange={(event) => change('phone', event.target.value)} /></Field>
          <Field label="Email"><input type="email" maxLength={254} value={form.email || ''} onChange={(event) => change('email', event.target.value)} /></Field>
          <Field label="Ngày sinh"><input type="date" value={form.birth_date || ''} onChange={(event) => change('birth_date', event.target.value)} /></Field>
          <Field label="Địa chỉ"><input maxLength={1000} value={form.address || ''} onChange={(event) => change('address', event.target.value)} /></Field>
          <Field label="Ghi chú" span><textarea rows={3} maxLength={4000} value={form.notes || ''} onChange={(event) => change('notes', event.target.value)} /></Field>
        </div>}
        {tab === 'work' && <div className="form-grid">
          <Field label="Phòng ban"><Select value={form.department_id || ''}
            items={activeCatalog(departments, form.department_id)} onChange={(event) => change('department_id', event.target.value)} /></Field>
          <Field label="Chức vụ"><Select value={form.position_id || ''} items={activeCatalog(positions, form.position_id)}
            onChange={(event) => change('position_id', event.target.value)} /></Field>
          <EmployeePicker api={api} value={form.manager_employee_id} excludeId={form.id}
            label="Quản lý trực tiếp" onChange={(value) => change('manager_employee_id', value || '')} />
          <Field label="Cửa hàng / nơi làm"><input maxLength={200} value={form.work_location || ''} onChange={(event) => change('work_location', event.target.value)} /></Field>
          <Field label="Ngày vào làm"><input type="date" value={form.hire_date || ''} onChange={(event) => change('hire_date', event.target.value)} /></Field>
          <Field label="Loại nhân viên"><Select value={form.employee_type || 'full_time'}
            items={[{value:'full_time',label:'Toàn thời gian'}, {value:'part_time',label:'Bán thời gian'}, {value:'contractor',label:'Cộng tác viên'}, {value:'seasonal',label:'Thời vụ'}]}
            onChange={(event) => change('employee_type', event.target.value)} /></Field>
          <Field label="Trạng thái"><Select value={form.status || 'active'}
            items={Object.entries(employeeStatus).filter(([value]) => value !== 'archived').map(([value,label]) => ({value,label}))}
            onChange={(event) => change('status', event.target.value)} /></Field>
        </div>}
        {tab === 'account' && <div className="form-grid">
          <p className="hr-form-note span-2">Hồ sơ nhân viên độc lập với tài khoản đăng nhập. Chỉ liên kết UUID của thành viên đã thuộc workspace; thao tác này không tạo tài khoản Auth.</p>
          <Field label="Auth user ID (tùy chọn)" span><input value={form.auth_user_id || ''} placeholder="Để trống nếu nhân viên không đăng nhập"
            onChange={(event) => change('auth_user_id', event.target.value)} /></Field>
        </div>}
        <ErrorMessage error={formError} />
        <div className="modal-actions"><button className="button secondary" type="button" onClick={() => setForm(null)}>Hủy</button>
          <button className="button primary" disabled={busy}>{busy ? 'Đang lưu…' : 'Lưu hồ sơ'}</button></div>
      </form>}
      {(tab === 'contract' || tab === 'history') && <ErrorMessage error={formError} />}
    </Panel> : <Panel title="Hồ sơ nhân viên" note="Chọn một nhân viên trong danh sách hoặc thêm hồ sơ mới.">
      <Empty title="Chưa chọn nhân viên">Thông tin nhạy cảm chỉ hiển thị với owner và manager.</Empty>
    </Panel>}

    {action && <Modal title={`${action.is_active ? 'Lưu trữ' : 'Khôi phục'} ${action.code}`}
      onClose={() => { if (!busy) setAction(null); }}>
      <form onSubmit={applyArchive}><div className="confirm-body">
        <p>Hồ sơ và lịch sử chấm công/lương vẫn được giữ nguyên. {action.is_active
          ? 'Nhân viên ngừng xuất hiện trong danh sách làm việc.' : 'Nhân viên được đưa lại vào danh sách hoạt động.'}</p>
        <Field label="Lý do"><textarea required minLength={10} maxLength={4000} value={reason}
          onChange={(event) => setReason(event.target.value)} /></Field><ErrorMessage error={formError} />
      </div><footer className="modal-actions"><button type="button" className="button secondary" onClick={() => setAction(null)}>Hủy</button>
        <button className="button primary" disabled={busy}>Xác nhận</button></footer></form>
    </Modal>}
  </div>;
}
