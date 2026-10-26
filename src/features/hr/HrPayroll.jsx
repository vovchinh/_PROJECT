import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Empty, ErrorMessage, ExportButton, Field, Modal, Panel, Table } from '../../components.jsx';
import { EmployeePicker, isoMonth, isoToday, moneyVnd } from './HrShared.jsx';

const STATUS = {
  DRAFT: 'Nháp', CALCULATED: 'Đã tính', REVIEWED: 'Đã kiểm tra',
  APPROVED: 'Đã duyệt', PAID: 'Đã ghi sổ trả lương',
};
const LEAVE_TYPES = [
  ['annual', 'Nghỉ phép năm'], ['sick', 'Nghỉ ốm'],
  ['unpaid', 'Nghỉ không lương'], ['other', 'Nghỉ khác'],
];
const COMPONENT_TYPES = [
  ['allowance', 'Phụ cấp'], ['bonus', 'Thưởng'],
  ['commission', 'Hoa hồng đã xác nhận'], ['deduction', 'Khấu trừ khác'],
];
const componentLabel = (kind) => COMPONENT_TYPES.find(([value]) => value === kind)?.[1] || kind;
const number = (value) => Number(value || 0);
const periodLabel = (period) => `${period.period_start} → ${period.period_end}`;
const fmtMinutes = (value) => `${(number(value) / 60).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} giờ`;
const initialPeriod = () => {
  const month = isoMonth();
  const [year, part] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, part, 0)).getUTCDate();
  return { period_start: `${month}-01`, period_end: `${month}-${String(lastDay).padStart(2, '0')}`,
    standard_minutes_override: '', overtime_multiplier_override: '' };
};
const initialContract = (employeeId = '') => ({ employee_id: employeeId, effective_from: isoToday(), effective_to: '',
  pay_basis: 'monthly', rate_vnd: '', standard_day_minutes: '', standard_month_minutes: '',
  overtime_multiplier: '', paid_leave_types: [], note: '' });

function requestFor(ref, signature) {
  if (ref.current?.signature !== signature) ref.current = { signature, id: crypto.randomUUID() };
  return ref.current.id;
}

function ImpactDialog({ title, description, impact, busy, error, onConfirm, onClose, children }) {
  return <Modal title={title} description={description} onClose={onClose}>
    <form onSubmit={onConfirm}>
      <div className="hr-payroll-impact"><strong>Ảnh hưởng khi xác nhận</strong>
        <ul>{impact.map((line) => <li key={line}>{line}</li>)}</ul>
      </div>
      {children}
      <ErrorMessage error={error} />
      <div className="modal-actions">
        <button type="button" className="button secondary" onClick={onClose} disabled={busy}>Hủy</button>
        <button type="submit" className="button primary" disabled={busy}>{busy ? 'Đang xử lý…' : 'Xác nhận'}</button>
      </div>
    </form>
  </Modal>;
}

function Payslip({ line, period, employee, payment, expense, onClose }) {
  const snapshot = line.source_snapshot || {};
  const contract = snapshot.contract || {};
  const frozenEmployee = snapshot.employee || employee || {};
  const approved = ['APPROVED', 'PAID'].includes(period.status);
  return <Modal title={`Phiếu lương · ${frozenEmployee.full_name || frozenEmployee.code || line.employee_id}`}
    description={`${periodLabel(period)} · ${STATUS[period.status] || period.status}`} onClose={onClose}>
    <div className="hr-payroll-payslip">
      <div className="hr-payroll-payslip-meta">
        <span><strong>Mã nhân viên</strong>{frozenEmployee.code || '—'}</span>
        <span><strong>Phòng ban khi tính</strong>{frozenEmployee.department_name || '—'}</span>
        <span><strong>Căn cứ</strong>{line.pay_basis === 'monthly' ? 'Lương tháng' : 'Lương giờ'}</span>
        <span><strong>Mức hợp đồng</strong>{moneyVnd(line.rate_vnd)}</span>
        <span><strong>Ngày duyệt</strong>{period.approved_at ? new Date(period.approved_at).toLocaleString('vi-VN') : 'Chưa duyệt'}</span>
        <span><strong>Người duyệt</strong>{period.approved_by || '—'}</span>
        <span><strong>Chi trả</strong>{payment ? `${payment.date} · ${moneyVnd(payment.amount)}` : 'Chưa ghi sổ'}</span>
      </div>
      <div className="hr-payroll-breakdown">
        <section><h3>Thu nhập</h3>
          <p><span>Lương công thường ({fmtMinutes(line.regular_minutes)})</span><b>{moneyVnd(line.base_pay)}</b></p>
          <p><span>Nghỉ có lương ({fmtMinutes(line.paid_leave_minutes)})</span><b>Đã gồm trong lương công</b></p>
          <p><span>Tăng ca ({fmtMinutes(line.overtime_minutes)} × {line.overtime_multiplier})</span><b>{moneyVnd(line.overtime_pay)}</b></p>
          <p><span>Phụ cấp</span><b>{moneyVnd(line.allowance_pay || 0)}</b></p>
          <p><span>Thưởng</span><b>{moneyVnd(line.bonus_pay || 0)}</b></p>
          <p><span>Hoa hồng xác nhận</span><b>{moneyVnd(line.commission_pay || 0)}</b></p>
          <p className="hr-payroll-total"><span>Tổng thu nhập</span><b>{moneyVnd(line.gross_pay)}</b></p>
        </section>
        <section><h3>Khấu trừ</h3>
          <p><span>Thu hồi ứng lương kỳ này</span><b>{moneyVnd(line.advance_deduction)}</b></p>
          <p><span>Khấu trừ khác đã xác nhận</span><b>{moneyVnd(line.other_deduction || 0)}</b></p>
          <p className="hr-payroll-total"><span>Tổng khấu trừ</span><b>{moneyVnd(number(line.advance_deduction) + number(line.other_deduction))}</b></p>
        </section>
      </div>
      <div className="hr-payroll-net"><span>Thực nhận</span><strong>{moneyVnd(line.net_pay)}</strong></div>
      <p className="hr-muted">{approved
        ? 'Số liệu đã duyệt được giữ theo snapshot hợp đồng, chấm công, nghỉ phép và ứng lương tại thời điểm tính.'
        : 'Phiếu đang chờ duyệt; tính lại kỳ lương sẽ cập nhật số liệu này.'}</p>
      <details className="hr-payroll-sources"><summary>Căn cứ tính lương</summary>
        <p>Hợp đồng hiệu lực: {contract.effective_from || '—'}{contract.effective_to ? ` → ${contract.effective_to}` : ''}.
          Định mức kỳ: {line.standard_minutes ? fmtMinutes(line.standard_minutes) : 'Theo giờ thực tế'}.</p>
        <p>Chấm công xác nhận: {(snapshot.attendance || []).length} bản ghi · nghỉ có lương: {(snapshot.paid_leave || []).length} đơn · ứng lương: {(snapshot.advances || []).length} phiếu.</p>
        {snapshot.overtime_review && <p>Tăng ca ghi nhận: {fmtMinutes(snapshot.overtime_review.raw_minutes)};
          đã duyệt tính lương: {fmtMinutes(snapshot.overtime_review.approved_minutes)}.
          Căn cứ: {(snapshot.overtime_review.decisions || []).length} quyết định.</p>}
        {(snapshot.components || []).map((item) => <p key={item.id}>{componentLabel(item.kind)} · {item.label}: {moneyVnd(item.amount)}{item.source_reference ? ` · nguồn ${item.source_reference}` : ''}</p>)}
        {expense && <p>Chi phí lương được ghi nhận ngày {expense.recognition_date}: {moneyVnd(expense.amount)}.</p>}
        {payment && <p>Thu Chi nguồn: {payment.cash_id}.</p>}
      </details>
      <div className="modal-actions"><button className="button secondary" onClick={onClose}>Đóng</button></div>
    </div>
  </Modal>;
}

export default function HrPayroll({ api, onChanged, initialEmployeeId = null }) {
  const [periodId, setPeriodId] = useState(null);
  const [state, setState] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [contractForm, setContractForm] = useState(null);
  const [periodForm, setPeriodForm] = useState(null);
  const [componentForm, setComponentForm] = useState(null);
  const [componentVoid, setComponentVoid] = useState(null);
  const [voidReason, setVoidReason] = useState('');
  const [dialog, setDialog] = useState(null);
  const [payslip, setPayslip] = useState(null);
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [employeeQuery, setEmployeeQuery] = useState('');
  const [payForm, setPayForm] = useState({ account_id: '', date: isoToday() });
  const [advanceForm, setAdvanceForm] = useState({ employee_id: '', account_id: '', amount: '', date: isoToday() });
  const mutationRequest = useRef(null);
  const componentRequest = useRef(null);

  useEffect(() => { if (initialEmployeeId) setContractForm(initialContract(initialEmployeeId)); }, [initialEmployeeId]);
  useEffect(() => {
    let alive = true;
    setLoading(true);setError('');
    Promise.all([
      api.getPayrollState(periodId),
      api.read('hr_employees', 'id,code,full_name,department_id,status', { limit: 500 }),
      api.read('cash_accounts', 'id,code,name', { limit: 100 }),
    ]).then(([payroll, personnel, cashAccounts]) => {
      if (!alive) return;
      setState(payroll);setEmployees(personnel || []);setAccounts(cashAccounts || []);
    }).catch((cause) => { if (alive) setError(cause.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [api, periodId, revision]);

  const selected = state?.selected_period;
  const lines = state?.lines || [];
  const employeeById = useMemo(() => Object.fromEntries(employees.map((item) => [item.id, item])), [employees]);
  const displayedLines = lines.filter((line) => {
    const employee = employeeById[line.employee_id];
    return `${employee?.code || ''} ${employee?.full_name || ''}`.toLocaleLowerCase('vi-VN')
      .includes(employeeQuery.trim().toLocaleLowerCase('vi-VN'));
  });
  const contracts = state?.contracts || [];
  const components = state?.components || [];
  const eligibleAdvanceEmployees = selected ? contracts.filter((contract) =>
    contract.effective_from <= selected.period_start &&
    (!contract.effective_to || contract.effective_to >= selected.period_end))
    .map((contract) => employeeById[contract.employee_id]).filter(Boolean) : [];

  async function refresh(message) {
    setRevision((value) => value + 1);
    if (message) await onChanged?.(message);
  }
  function openPeriod(period = null) {
    setPeriodForm(period ? { id: period.id, period_start: period.period_start, period_end: period.period_end,
      standard_minutes_override: period.standard_minutes_override ?? '',
      overtime_multiplier_override: period.overtime_multiplier_override ?? '' } : initialPeriod());
    setFormError('');
  }
  function openContract(contract = null) {
    setContractForm(contract ? { ...contract, effective_to: contract.effective_to || '',
      standard_month_minutes: contract.standard_month_minutes ?? '',
      paid_leave_types: contract.paid_leave_types || [] } : initialContract(initialEmployeeId || ''));
    setFormError('');
  }
  async function savePeriod(event) {
    event.preventDefault();setBusy(true);setFormError('');
    try {
      const saved = await api.savePayrollPeriod(periodForm);
      setPeriodForm(null);setPeriodId(saved.id);
      await refresh('Đã lưu kỳ lương và chính sách kỳ.');
    } catch (cause) { setFormError(cause.message); }
    finally { setBusy(false); }
  }
  async function saveContract(event) {
    event.preventDefault();setBusy(true);setFormError('');
    try {
      const payload = { ...contractForm,
        standard_month_minutes: contractForm.pay_basis === 'monthly' ? contractForm.standard_month_minutes : null };
      await api.saveContract(payload);
      setContractForm(null);
      await refresh('Đã lưu chính sách lương của nhân viên.');
    } catch (cause) { setFormError(cause.message); }
    finally { setBusy(false); }
  }
  function openComponent(row = null) {
    componentRequest.current = null;
    setFormError('');
    setComponentForm(row ? { id: row.id, employee_id: row.employee_id, kind: row.kind,
      label: row.label, amount: row.amount, reason: row.reason,
      source_reference: row.source_reference || '' } : {
      employee_id: '', kind: 'allowance', label: '', amount: '', reason: '', source_reference: '',
    });
  }
  async function saveComponent(event) {
    event.preventDefault();setBusy(true);setFormError('');
    try {
      const payload = { ...componentForm, period_id: selected.id };
      await api.savePayrollComponent(payload,
        requestFor(componentRequest, `save:${JSON.stringify(payload)}`));
      setComponentForm(null);componentRequest.current = null;
      await refresh('Đã lưu khoản lương. Kỳ chưa duyệt cần tính lại.');
    } catch (cause) { setFormError(cause.message); }
    finally { setBusy(false); }
  }
  async function voidComponent(event) {
    event.preventDefault();setBusy(true);setFormError('');
    try {
      await api.voidPayrollComponent(componentVoid.id, voidReason,
        requestFor(componentRequest, `void:${componentVoid.id}:${voidReason}`));
      setComponentVoid(null);setVoidReason('');componentRequest.current = null;
      await refresh('Đã hủy khoản lương trước duyệt và giữ lịch sử.');
    } catch (cause) { setFormError(cause.message); }
    finally { setBusy(false); }
  }
  async function runPeriod(action) {
    setBusy(true);setFormError('');
    try {
      if (action === 'calculate') await api.calculatePayroll(selected.id);
      if (action === 'review') await api.reviewPayroll(selected.id);
      if (action === 'approve') await api.approvePayroll(selected.id,
        requestFor(mutationRequest, `approve:${selected.id}`));
      if (action === 'pay') await api.payPayroll(selected.id, payForm.account_id, payForm.date,
        requestFor(mutationRequest, `pay:${selected.id}:${payForm.account_id}:${payForm.date}`));
      setDialog(null);mutationRequest.current = null;
      await refresh({ calculate: 'Đã tính lương từ dữ liệu được xác nhận.',
        review: 'Đã kiểm tra bảng lương.', approve: 'Đã duyệt và ghi nhận chi phí lương.',
        pay: 'Đã ghi sổ phiếu Thu Chi trả lương cho từng nhân viên.' }[action]);
    } catch (cause) { setFormError(cause.message); }
    finally { setBusy(false); }
  }
  async function submitAdvance(event) {
    event.preventDefault();setBusy(true);setFormError('');
    try {
      const signature = `advance:${selected.id}:${advanceForm.employee_id}:${advanceForm.account_id}:${advanceForm.amount}:${advanceForm.date}`;
      await api.createSalaryAdvance(advanceForm.employee_id, selected.id, advanceForm.account_id,
        Number(advanceForm.amount), advanceForm.date, requestFor(mutationRequest, signature));
      setDialog(null);mutationRequest.current = null;
      setAdvanceForm({ employee_id: '', account_id: '', amount: '', date: isoToday() });
      await refresh('Đã ghi sổ ứng lương và gắn với kỳ đã chọn.');
    } catch (cause) { setFormError(cause.message); }
    finally { setBusy(false); }
  }
  function chooseDialog(next) { setDialog(next);setFormError('');mutationRequest.current = null; }
  const canEdit = selected && !['APPROVED','PAID'].includes(selected.status);
  const payment = payslip && (state?.payments || []).find((item) => item.line_id === payslip.id);
  const expense = payslip && (state?.expenses || []).find((item) => item.line_id === payslip.id);
  const exportRows = [['Mã NV','Họ tên','Hình thức','Mức hợp đồng (VND)',
    'Phút công thường','Phút nghỉ có lương','Phút tăng ca','Lương cơ bản (VND)',
    'Tiền tăng ca (VND)','Phụ cấp (VND)','Thưởng (VND)','Hoa hồng (VND)',
    'Lương gộp (VND)','Ứng lương (VND)','Khấu trừ khác (VND)','Thực nhận (VND)','Trạng thái'],
  ...lines.map((line) => [line.source_snapshot?.employee?.code || employeeById[line.employee_id]?.code || line.employee_id,
    line.source_snapshot?.employee?.full_name || employeeById[line.employee_id]?.full_name || '',line.pay_basis,line.rate_vnd,
    line.regular_minutes,line.paid_leave_minutes,line.overtime_minutes,line.base_pay,
    line.overtime_pay,line.allowance_pay || 0,line.bonus_pay || 0,line.commission_pay || 0,
    line.gross_pay,line.advance_deduction,line.other_deduction || 0,line.net_pay,selected?.status])];

  return <div className="hr-payroll-page">
    <Panel title="Bảng lương" note="Tính trên server từ hợp đồng, công đã xác nhận, nghỉ có lương và ứng lương gắn kỳ."
      action={<button className="button primary" onClick={() => openPeriod()}>+ Tạo kỳ lương</button>}>
      {loading && <p className="hr-muted">Đang tải dữ liệu lương…</p>}
      <ErrorMessage error={error} />
      {!loading && !error && <>
        <div className="hr-payroll-toolbar">
          <Field label="Kỳ lương"><select value={selected?.id || ''} onChange={(event) => setPeriodId(event.target.value || null)}>
            {!state?.periods?.length && <option value="">Chưa có kỳ lương</option>}
            {(state?.periods || []).map((period) => <option key={period.id} value={period.id}>
              {periodLabel(period)} · {STATUS[period.status] || period.status}</option>)}
          </select></Field>
          {canEdit && <button className="button secondary" onClick={() => openPeriod(selected)}>Cấu hình kỳ</button>}
          {selected && <Badge status={selected.status.toLowerCase()}>{STATUS[selected.status]}</Badge>}
        </div>
        {selected ? <>
          <div className="hr-payroll-summary">
            <div><span>Nhân viên</span><strong>{selected.employee_count}</strong></div>
            <div><span>Chi phí lương gộp</span><strong>{moneyVnd(selected.gross_total)}</strong></div>
            <div><span>Đã ứng kỳ này</span><strong>{moneyVnd(selected.advance_total)}</strong></div>
            <div><span>Cần trả</span><strong>{moneyVnd(selected.net_total)}</strong></div>
          </div>
          <div className="hr-payroll-actions">
            {canEdit && <button className="button secondary" disabled={!eligibleAdvanceEmployees.length}
              title={!eligibleAdvanceEmployees.length ? 'Chưa có nhân viên với hợp đồng bao trùm kỳ này' : undefined}
              onClick={() => chooseDialog('advance')}>+ Ghi ứng lương</button>}
            {['DRAFT','CALCULATED','REVIEWED'].includes(selected.status) &&
              <button className="button secondary" onClick={() => chooseDialog('calculate')}>
                {selected.status === 'DRAFT' ? 'Tính lương' : 'Tính lại'}</button>}
            {selected.status === 'CALCULATED' && <button className="button primary" onClick={() => chooseDialog('review')}>Kiểm tra bảng lương</button>}
            {selected.status === 'REVIEWED' && <button className="button primary" onClick={() => chooseDialog('approve')}>Duyệt bảng lương</button>}
            {selected.status === 'APPROVED' && <button className="button primary" onClick={() => chooseDialog('pay')}>Ghi sổ trả lương</button>}
            {lines.length > 0 && <ExportButton name={`bang-luong-${selected.period_start}-${selected.period_end}.csv`} rows={exportRows} />}
          </div>
          {selected.status === 'DRAFT' && <p className="hr-muted">Nhập hợp đồng và xác nhận chấm công trước khi tính. Định mức và hệ số theo từng hợp đồng; chỉ điền ghi đè khi kỳ này cần chính sách khác.</p>}
          <div className="hr-payroll-table-head">
            <h3>Chi tiết nhân viên</h3>
            <input aria-label="Tìm nhân viên trong bảng lương" placeholder="Tìm mã hoặc họ tên…" value={employeeQuery}
              onChange={(event) => setEmployeeQuery(event.target.value)} />
          </div>
          {lines.length === 0 ? <Empty title="Kỳ này chưa được tính">Lưu hợp đồng, xác nhận dữ liệu công rồi chọn Tính lương.</Empty> : <>
            <Table headers={['Mã NV / Họ tên','Căn cứ','Công thường','Tăng ca','Lương gộp','Ứng lương','Thực nhận','Thao tác']}
              empty={!displayedLines.length}>
              {displayedLines.map((line) => <tr key={line.id}>
                <td><strong>{line.source_snapshot?.employee?.code || employeeById[line.employee_id]?.code || '—'}</strong><br />{line.source_snapshot?.employee?.full_name || employeeById[line.employee_id]?.full_name || line.employee_id}</td>
                <td>{line.pay_basis === 'monthly' ? 'Tháng' : 'Giờ'} · {moneyVnd(line.rate_vnd)}</td>
                <td>{fmtMinutes(line.regular_minutes)}<br /><small>Phép có lương {fmtMinutes(line.paid_leave_minutes)}</small></td>
                <td>{fmtMinutes(line.overtime_minutes)} · ×{line.overtime_multiplier}</td>
                <td>{moneyVnd(line.gross_pay)}</td><td>{moneyVnd(line.advance_deduction)}</td>
                <td><strong>{moneyVnd(line.net_pay)}</strong></td>
                <td><button className="button secondary small" onClick={() => setPayslip(line)}>Xem phiếu</button></td>
              </tr>)}
            </Table><p className="hr-muted">Hiển thị {displayedLines.length}/{lines.length} phiếu lương của kỳ.</p>
          </>}
          {(state?.advances || []).length > 0 && <details className="hr-payroll-sources"><summary>Phiếu ứng lương đã ghi sổ ({state.advances.length})</summary>
            <Table headers={['Ngày','Nhân viên','Số tiền','Tài khoản','Thu Chi nguồn']}>
              {state.advances.map((item) => <tr key={item.id}>
                <td>{item.transaction_date}</td><td>{employeeById[item.employee_id]?.full_name || item.employee_id}</td>
                <td>{moneyVnd(item.amount)}</td><td>{accounts.find((account) => account.id === item.account_id)?.name || item.account_id}</td>
                <td>{item.cash_id}</td>
              </tr>)}
            </Table>
          </details>}
          {selected.status === 'PAID' && <p className="hr-muted">Đã ghi sổ nội bộ ngày {selected.payment_date} vào tài khoản {accounts.find((account) => account.id === selected.payment_account_id)?.name || selected.payment_account_id}. Hãy xem từng phiếu để truy ngược chứng từ Thu Chi.</p>}
        </> : <Empty title="Chưa tạo kỳ lương">Tạo một kỳ, nhập hợp đồng áp dụng cho nhân viên rồi xác nhận chấm công trước khi tính.</Empty>}
      </>}
    </Panel>

    <Panel title="Chính sách lương theo hợp đồng" note="Mỗi nhân viên có một hợp đồng hiệu lực tại một thời điểm; quy tắc của kỳ đã duyệt được giữ trong snapshot."
      action={<button className="button secondary" onClick={() => openContract()}>+ Thêm hợp đồng</button>}>
      {contracts.length === 0 ? <Empty title="Chưa có hợp đồng">Cần chọn lương tháng hoặc lương giờ và nhập định mức công, hệ số tăng ca trước khi tính.</Empty>
        : <Table headers={['Nhân viên','Hiệu lực','Loại lương','Mức lương','Định mức','Tăng ca','Thao tác']}>
          {contracts.map((contract) => <tr key={contract.id}>
            <td>{employeeById[contract.employee_id]?.code || '—'} · {employeeById[contract.employee_id]?.full_name || contract.employee_id}</td>
            <td>{contract.effective_from} → {contract.effective_to || 'Hiện tại'}</td>
            <td>{contract.pay_basis === 'monthly' ? 'Theo tháng' : 'Theo giờ'}</td>
            <td>{moneyVnd(contract.rate_vnd)}</td>
            <td>{fmtMinutes(contract.standard_day_minutes)}/ngày{contract.standard_month_minutes ? ` · ${fmtMinutes(contract.standard_month_minutes)}/kỳ` : ''}</td>
            <td>×{contract.overtime_multiplier}</td>
            <td><button className="button secondary small" onClick={() => openContract(contract)}>Xem / Sửa</button></td>
          </tr>)}
        </Table>}
    </Panel>

    <Panel title="Phụ cấp, thưởng, hoa hồng & khấu trừ" note="Chỉ nhập khoản đã được xác nhận với lý do và nguồn. Hoa hồng phải có tham chiếu nguồn; các khoản chỉ vào phiếu lương khi tính trên server."
      action={canEdit && <button className="button secondary" onClick={() => openComponent()}>+ Thêm khoản lương</button>}>
      {!selected ? <Empty title="Chọn kỳ lương trước" /> : components.length === 0
        ? <Empty title="Chưa có khoản bổ sung">Lương cơ bản, tăng ca và ứng lương vẫn được tính theo dữ liệu hiện có.</Empty>
        : <Table headers={['Nhân viên','Loại','Nội dung / lý do','Số tiền','Nguồn','Trạng thái','Thao tác']}>
          {components.map((item) => <tr key={item.id}>
            <td>{employeeById[item.employee_id]?.code || '—'} · {employeeById[item.employee_id]?.full_name || item.employee_id}</td>
            <td>{componentLabel(item.kind)}</td>
            <td><strong>{item.label}</strong><small>{item.reason}</small></td>
            <td>{moneyVnd(item.amount)}</td>
            <td>{item.source_reference || '—'}</td>
            <td><Badge status={item.status === 'active' ? 'posted' : 'reversed'}>{item.status === 'active' ? 'Đã xác nhận' : 'Đã hủy'}</Badge></td>
            <td>{canEdit && item.status === 'active' ? <div className="hr-payroll-actions">
              <button className="button secondary small" onClick={() => openComponent(item)}>Sửa</button>
              <button className="button danger-outline small" onClick={() => {
                componentRequest.current = null;setFormError('');setVoidReason('');setComponentVoid(item);
              }}>Hủy khoản</button></div> : '—'}</td>
          </tr>)}
        </Table>}
    </Panel>

    {periodForm && <Modal title={periodForm.id ? 'Cấu hình kỳ lương' : 'Tạo kỳ lương'}
      description="Ngày kỳ đã tạo không đổi; tạo kỳ mới nếu cần tách thời gian." onClose={() => setPeriodForm(null)}>
      <form onSubmit={savePeriod}>
        <fieldset disabled={busy} className="form-grid">
          <Field label="Từ ngày"><input type="date" required value={periodForm.period_start}
            disabled={!!periodForm.id} onChange={(event) => setPeriodForm({ ...periodForm, period_start: event.target.value })} /></Field>
          <Field label="Đến ngày"><input type="date" required min={periodForm.period_start} value={periodForm.period_end}
            disabled={!!periodForm.id} onChange={(event) => setPeriodForm({ ...periodForm, period_end: event.target.value })} /></Field>
          <Field label="Định mức phút cho kỳ (ghi đè, tùy chọn)" hint="Để trống sẽ lấy định mức của từng hợp đồng.">
            <input type="number" min="1" max="44640" step="1" value={periodForm.standard_minutes_override}
              onChange={(event) => setPeriodForm({ ...periodForm, standard_minutes_override: event.target.value })} /></Field>
          <Field label="Hệ số tăng ca kỳ này (ghi đè, tùy chọn)" hint="Để trống sẽ lấy hệ số của từng hợp đồng.">
            <input type="number" min="0" max="10" step="0.001" value={periodForm.overtime_multiplier_override}
              onChange={(event) => setPeriodForm({ ...periodForm, overtime_multiplier_override: event.target.value })} /></Field>
        </fieldset>
        <ErrorMessage error={formError} />
        <div className="modal-actions"><button type="button" className="button secondary" onClick={() => setPeriodForm(null)}>Hủy</button>
          <button className="button primary" disabled={busy}>Lưu kỳ lương</button></div>
      </form>
    </Modal>}

    {componentForm && selected && <Modal title={componentForm.id ? 'Sửa khoản lương' : 'Thêm khoản lương'}
      description={`Kỳ ${periodLabel(selected)} · lưu trước khi duyệt; mọi thay đổi được kiểm toán.`}
      onClose={() => !busy && setComponentForm(null)}>
      <form onSubmit={saveComponent}><fieldset disabled={busy} className="form-grid">
        <Field label="Nhân viên có hợp đồng trong kỳ"><select required value={componentForm.employee_id}
          disabled={Boolean(componentForm.id)} onChange={(event) => setComponentForm({ ...componentForm, employee_id: event.target.value })}>
          <option value="">Chọn nhân viên</option>
          {eligibleAdvanceEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.code} · {employee.full_name}</option>)}
        </select></Field>
        <Field label="Loại khoản"><select required value={componentForm.kind} disabled={Boolean(componentForm.id)}
          onChange={(event) => setComponentForm({ ...componentForm, kind: event.target.value })}>
          {COMPONENT_TYPES.map(([value,label]) => <option key={value} value={value}>{label}</option>)}
        </select></Field>
        <Field label="Nội dung"><input required maxLength={120} value={componentForm.label}
          onChange={(event) => setComponentForm({ ...componentForm, label: event.target.value })} /></Field>
        <Field label="Số tiền (₫)"><input required type="number" min="1" max="9000000000000" step="1"
          value={componentForm.amount} onChange={(event) => setComponentForm({ ...componentForm, amount: event.target.value })} /></Field>
        <Field label="Tham chiếu nguồn" hint={componentForm.kind === 'commission' ? 'Bắt buộc với hoa hồng; ghi mã đơn/chứng từ đã đối chiếu.' : 'Tùy chọn, giúp truy nguyên chứng từ.'}>
          <input required={componentForm.kind === 'commission'} minLength={componentForm.kind === 'commission' ? 3 : undefined}
            maxLength={200} value={componentForm.source_reference}
            onChange={(event) => setComponentForm({ ...componentForm, source_reference: event.target.value })} /></Field>
        <Field label="Lý do / căn cứ phê duyệt" span><textarea required minLength={10} maxLength={4000} rows={3}
          value={componentForm.reason} onChange={(event) => setComponentForm({ ...componentForm, reason: event.target.value })} /></Field>
      </fieldset><ErrorMessage error={formError} /><div className="modal-actions">
        <button type="button" className="button secondary" disabled={busy} onClick={() => setComponentForm(null)}>Hủy</button>
        <button className="button primary" disabled={busy}>Lưu khoản lương</button>
      </div></form>
    </Modal>}

    {componentVoid && <ImpactDialog title={`Hủy ${componentLabel(componentVoid.kind).toLowerCase()}`}
      description={`${componentVoid.label} · ${moneyVnd(componentVoid.amount)}`}
      impact={['Khoản đã xác nhận sẽ giữ trong lịch sử với trạng thái Đã hủy.',
        'Nếu kỳ đã được tính, hệ thống đưa kỳ về Nháp và yêu cầu tính lại; không sửa bảng lương đã duyệt.']}
      busy={busy} error={formError} onConfirm={voidComponent}
      onClose={() => !busy && setComponentVoid(null)}>
      <Field label="Lý do hủy"><textarea required minLength={10} maxLength={4000} rows={3} value={voidReason}
        onChange={(event) => setVoidReason(event.target.value)} /></Field>
    </ImpactDialog>}

    {contractForm && <Modal title={contractForm.id ? 'Sửa hợp đồng lương' : 'Thêm hợp đồng lương'}
      description="Các thay đổi chưa duyệt sẽ yêu cầu tính lại. Quy tắc đã nằm trong kỳ được duyệt sẽ không bị viết lại."
      onClose={() => setContractForm(null)}>
      <form onSubmit={saveContract}>
        <fieldset disabled={busy} className="form-grid">
          <EmployeePicker api={api} value={contractForm.employee_id}
            onChange={(value) => setContractForm({ ...contractForm, employee_id: value || '' })} />
          <Field label="Hình thức lương"><select required value={contractForm.pay_basis}
            onChange={(event) => setContractForm({ ...contractForm, pay_basis: event.target.value,
              standard_month_minutes: event.target.value === 'hourly' ? '' : contractForm.standard_month_minutes })}>
            <option value="monthly">Theo tháng</option><option value="hourly">Theo giờ</option>
          </select></Field>
          <Field label="Hiệu lực từ ngày"><input type="date" required value={contractForm.effective_from}
            onChange={(event) => setContractForm({ ...contractForm, effective_from: event.target.value })} /></Field>
          <Field label="Hiệu lực đến ngày (tùy chọn)"><input type="date" min={contractForm.effective_from}
            value={contractForm.effective_to || ''}
            onChange={(event) => setContractForm({ ...contractForm, effective_to: event.target.value })} /></Field>
          <Field label={contractForm.pay_basis === 'monthly' ? 'Lương hợp đồng/tháng (₫)' : 'Lương hợp đồng/giờ (₫)'}>
            <input type="number" required min="1" max="9000000000000" step="1" value={contractForm.rate_vnd}
              onChange={(event) => setContractForm({ ...contractForm, rate_vnd: event.target.value })} /></Field>
          <Field label="Phút công chuẩn mỗi ngày" hint="Ví dụ: 480 phút = 8 giờ. Dùng để quy đổi ngày phép có lương.">
            <input type="number" required min="1" max="1440" step="1" value={contractForm.standard_day_minutes}
              onChange={(event) => setContractForm({ ...contractForm, standard_day_minutes: event.target.value })} /></Field>
          {contractForm.pay_basis === 'monthly' && <Field label="Phút công chuẩn cho kỳ" hint="Bắt buộc với lương tháng; mỗi hợp đồng có thể khác nhau.">
            <input type="number" required min="1" max="44640" step="1" value={contractForm.standard_month_minutes ?? ''}
              onChange={(event) => setContractForm({ ...contractForm, standard_month_minutes: event.target.value })} /></Field>}
          <Field label="Hệ số tăng ca" hint="Nhập chính sách được duyệt, ví dụ 1.5; không tự áp dụng mặc định.">
            <input type="number" required min="0" max="10" step="0.001" value={contractForm.overtime_multiplier}
              onChange={(event) => setContractForm({ ...contractForm, overtime_multiplier: event.target.value })} /></Field>
          <fieldset className="hr-payroll-leave-types span-2"><legend>Loại nghỉ được trả lương</legend><div className="hr-payroll-checkboxes">
            {LEAVE_TYPES.map(([key,label]) => <label key={key}><input type="checkbox"
              checked={(contractForm.paid_leave_types || []).includes(key)}
              onChange={(event) => setContractForm({ ...contractForm,
                paid_leave_types: event.target.checked
                  ? [...(contractForm.paid_leave_types || []), key]
                  : contractForm.paid_leave_types.filter((value) => value !== key) })} />{label}</label>)}
          </div></fieldset>
          <Field label="Ghi chú chính sách" span><textarea maxLength={4000} rows={3} value={contractForm.note || ''}
            onChange={(event) => setContractForm({ ...contractForm, note: event.target.value })} /></Field>
        </fieldset>
        <ErrorMessage error={formError} />
        <div className="modal-actions"><button type="button" className="button secondary" onClick={() => setContractForm(null)}>Hủy</button>
          <button className="button primary" disabled={busy}>Lưu hợp đồng</button></div>
      </form>
    </Modal>}

    {dialog === 'calculate' && <ImpactDialog title="Tính bảng lương" description={periodLabel(selected)}
      impact={['Tính trên server từ hợp đồng, chấm công đã xác nhận, nghỉ phép đã duyệt và ứng lương đã ghi sổ.',
        'Các phiếu lương chưa duyệt của kỳ này sẽ được thay bằng kết quả mới.',
        'Chưa ghi nhận chi phí hoặc Thu Chi khi chỉ tính lương.']}
      busy={busy} error={formError} onConfirm={(event) => { event.preventDefault();runPeriod('calculate'); }} onClose={() => setDialog(null)} />}
    {dialog === 'review' && <ImpactDialog title="Xác nhận đã kiểm tra bảng lương" description={periodLabel(selected)}
      impact={['Chuyển kỳ sang trạng thái Đã kiểm tra để chuẩn bị duyệt.',
        'Chưa ghi nhận chi phí hoặc Thu Chi ở bước này.']}
      busy={busy} error={formError} onConfirm={(event) => { event.preventDefault();runPeriod('review'); }} onClose={() => setDialog(null)} />}
    {dialog === 'approve' && <ImpactDialog title="Duyệt bảng lương" description={periodLabel(selected)}
      impact={[`Ghi nhận chi phí lương gộp ${moneyVnd(selected.gross_total)} cho kỳ này.`,
        'Khóa snapshot phiếu lương và hợp đồng đã sử dụng; không tự tạo phiếu chi tiền.',
        'Không thể sửa trực tiếp kỳ lương sau khi duyệt.']}
      busy={busy} error={formError} onConfirm={(event) => { event.preventDefault();runPeriod('approve'); }} onClose={() => setDialog(null)} />}
    {dialog === 'pay' && <ImpactDialog title="Ghi sổ trả lương" description={periodLabel(selected)}
      impact={[`Ghi phiếu Thu Chi đã post cho từng nhân viên với tổng thực nhận ${moneyVnd(selected.net_total)}.`,
        'Chi phí lương gộp đã được ghi nhận khi duyệt; tiền trả không được tính thành chi phí lần hai.',
        'Đây là xác nhận ghi sổ nội bộ, không chuyển khoản ngân hàng tự động.']}
      busy={busy} error={formError} onConfirm={(event) => { event.preventDefault();runPeriod('pay'); }} onClose={() => setDialog(null)}>
      <div className="form-grid"><Field label="Ngày ghi sổ trả lương"><input type="date" required min={selected.period_end}
        value={payForm.date} onChange={(event) => setPayForm({ ...payForm, date: event.target.value })} /></Field>
        <Field label="Tài khoản chi tiền"><select required value={payForm.account_id}
          onChange={(event) => setPayForm({ ...payForm, account_id: event.target.value })}>
          <option value="">Chọn tài khoản</option>
          {accounts.map((account) => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}
        </select></Field></div>
    </ImpactDialog>}
    {dialog === 'advance' && <ImpactDialog title="Ghi sổ ứng lương" description={`Khoản ứng sẽ khấu trừ vào kỳ ${periodLabel(selected)}.`}
      impact={['Lập và post một phiếu chi tiền vào tài khoản đã chọn ngay khi xác nhận.',
        'Liên kết khoản ứng với nhân viên và kỳ lương; kỳ đã tính sẽ trở về Nháp để tính lại.',
        'Phiếu ứng không được tính là chi phí vận hành lần thứ hai.']}
      busy={busy} error={formError} onConfirm={submitAdvance} onClose={() => setDialog(null)}>
      <div className="form-grid"><Field label="Nhân viên có hợp đồng trong kỳ"><select required value={advanceForm.employee_id}
        onChange={(event) => setAdvanceForm({ ...advanceForm, employee_id: event.target.value })}>
        <option value="">Chọn nhân viên</option>
        {eligibleAdvanceEmployees.map((employee) => <option key={employee.id} value={employee.id}>
          {employee.code} · {employee.full_name}</option>)}
      </select></Field>
        <Field label="Số tiền ứng (₫)"><input type="number" required min="1" max="9000000000000" step="1"
          value={advanceForm.amount} onChange={(event) => setAdvanceForm({ ...advanceForm, amount: event.target.value })} /></Field>
        <Field label="Ngày chi"><input type="date" required max={selected.period_end} value={advanceForm.date}
          onChange={(event) => setAdvanceForm({ ...advanceForm, date: event.target.value })} /></Field>
        <Field label="Tài khoản chi"><select required value={advanceForm.account_id}
          onChange={(event) => setAdvanceForm({ ...advanceForm, account_id: event.target.value })}>
          <option value="">Chọn tài khoản</option>
          {accounts.map((account) => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}
        </select></Field></div>
    </ImpactDialog>}

    {payslip && selected && <Payslip line={payslip} period={selected} employee={employeeById[payslip.employee_id]}
      payment={payment} expense={expense} onClose={() => setPayslip(null)} />}
  </div>;
}
