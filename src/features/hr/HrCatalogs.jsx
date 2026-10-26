import { useState } from 'react';
import { Panel, Table, Modal, Field, Select, ErrorMessage, Badge } from '../../components.jsx';
import { EmployeePicker } from './HrShared.jsx';

const names = { department: 'phòng ban', position: 'chức vụ' };

export default function HrCatalogs({ api, catalogs, onChanged }) {
  const [form, setForm] = useState(null);
  const [action, setAction] = useState(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const departments = catalogs?.departments || [];
  const positions = catalogs?.positions || [];
  function open(kind, row = null) {
    setForm({ kind, data: row ? { ...row } : {
      code: '', name: '', ...(kind === 'department' ? { manager_employee_id: '' } : { department_id: '' }),
    } });setError('');
  }
  async function save(event) {
    event.preventDefault();setBusy(true);setError('');
    try {
      if (form.kind === 'department') await api.saveDepartment({
        ...(form.data.id ? { id: form.data.id } : {}), code: form.data.code,
        name: form.data.name, manager_employee_id: form.data.manager_employee_id || null,
      });
      else await api.savePosition({
        ...(form.data.id ? { id: form.data.id } : {}), code: form.data.code,
        name: form.data.name, department_id: form.data.department_id || null,
      });
      setForm(null);await onChanged?.('Đã lưu danh mục nhân sự.');
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  }
  async function applyAction(event) {
    event.preventDefault();setBusy(true);setError('');
    try {
      const { kind, row, type } = action;
      if (kind === 'department') {
        if (type === 'delete') await api.deleteDepartment(row.id, reason);
        else await api.setDepartmentArchived(row.id, type === 'archive', reason);
      } else if (type === 'delete') await api.deletePosition(row.id, reason);
      else await api.setPositionArchived(row.id, type === 'archive', reason);
      setAction(null);setReason('');await onChanged?.('Đã cập nhật danh mục nhân sự.');
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  }
  const actions = (kind, row) => <details className="entity-actions">
    <summary aria-label={`Thao tác ${names[kind]} ${row.code}`}>⋯</summary>
    <div className="entity-actions-list">
      <button onClick={() => open(kind, row)}>Sửa</button>
      <button onClick={() => { setAction({ kind, row, type: row.is_active ? 'archive' : 'restore' });setReason('');setError(''); }}>
        {row.is_active ? 'Lưu trữ' : 'Khôi phục'}</button>
      <button onClick={() => { setAction({ kind, row, type: 'delete' });setReason('');setError(''); }}>Xóa nếu chưa dùng</button>
    </div>
  </details>;

  return <div className="hr-catalog-grid">
    <Panel title="Danh mục phòng ban" note="Nhóm nhân viên theo công việc; nhóm đã dùng chỉ được lưu trữ."
      action={<button className="button primary" onClick={() => open('department')}>+ Thêm phòng ban</button>}>
      <Table headers={['Mã', 'Tên phòng ban', 'Quản lý', 'Trạng thái', 'Thao tác']} empty={!departments.length}>
        {departments.map((row) => <tr key={row.id}>
          <td className="mono">{row.code}</td><td><strong>{row.name}</strong></td>
          <td>{row.manager_name || '—'}</td>
          <td><Badge status={row.is_active ? 'posted' : 'reversed'}>{row.is_active ? 'Đang dùng' : 'Lưu trữ'}</Badge></td>
          <td>{actions('department', row)}</td>
        </tr>)}
      </Table>
    </Panel>
    <Panel title="Danh mục chức vụ" note="Mỗi chức vụ có thể gắn với một phòng ban cụ thể."
      action={<button className="button primary" onClick={() => open('position')}>+ Thêm chức vụ</button>}>
      <Table headers={['Mã', 'Tên chức vụ', 'Phòng ban', 'Trạng thái', 'Thao tác']} empty={!positions.length}>
        {positions.map((row) => <tr key={row.id}>
          <td className="mono">{row.code}</td><td><strong>{row.name}</strong></td>
          <td>{departments.find((department) => department.id === row.department_id)?.name || 'Dùng chung'}</td>
          <td><Badge status={row.is_active ? 'posted' : 'reversed'}>{row.is_active ? 'Đang dùng' : 'Lưu trữ'}</Badge></td>
          <td>{actions('position', row)}</td>
        </tr>)}
      </Table>
    </Panel>
    {form && <Modal title={`${form.data.id ? 'Sửa' : 'Thêm'} ${names[form.kind]}`} onClose={() => !busy && setForm(null)}>
      <form onSubmit={save}><div className="form-grid">
        <Field label="Mã"><input required maxLength={80} disabled={Boolean(form.data.id)} value={form.data.code || ''}
          onChange={(event) => setForm({ ...form, data: { ...form.data, code: event.target.value } })} /></Field>
        <Field label="Tên"><input required maxLength={200} value={form.data.name || ''}
          onChange={(event) => setForm({ ...form, data: { ...form.data, name: event.target.value } })} /></Field>
        {form.kind === 'department'
          ? <EmployeePicker api={api} label="Quản lý phòng ban" value={form.data.manager_employee_id}
              onChange={(value) => setForm({ ...form, data: { ...form.data, manager_employee_id: value || '' } })} />
          : <Field label="Phòng ban"><Select value={form.data.department_id || ''}
              items={departments.filter((row) => row.is_active || row.id === form.data.department_id)}
              onChange={(event) => setForm({ ...form, data: { ...form.data, department_id: event.target.value } })} /></Field>}
      </div><ErrorMessage error={error} /><footer className="modal-actions">
        <button type="button" className="button secondary" onClick={() => setForm(null)}>Hủy</button>
        <button className="button primary" disabled={busy}>{busy ? 'Đang lưu…' : 'Lưu danh mục'}</button>
      </footer></form>
    </Modal>}
    {action && <Modal title={`${action.type === 'delete' ? 'Xóa' : action.type === 'archive' ? 'Lưu trữ' : 'Khôi phục'} ${names[action.kind]}`}
      onClose={() => !busy && setAction(null)}>
      <form onSubmit={applyAction}><div className="confirm-body">
        <p>{action.type === 'delete' ? 'Chỉ xóa được khi chưa có nhân viên, chức vụ hoặc lịch sử tham chiếu.'
          : 'Nhân viên và lịch sử đang dùng vẫn được giữ nguyên.'}</p>
        <Field label="Lý do"><textarea required minLength={10} maxLength={4000} rows={3} value={reason}
          onChange={(event) => setReason(event.target.value)} /></Field><ErrorMessage error={error} />
      </div><footer className="modal-actions"><button type="button" className="button secondary" onClick={() => setAction(null)}>Hủy</button>
        <button className="button primary" disabled={busy}>Xác nhận</button></footer></form>
    </Modal>}
  </div>;
}
