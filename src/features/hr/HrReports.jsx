import { useEffect, useState } from 'react';
import { Panel, Table, ErrorMessage, Empty } from '../../components.jsx';
import { HrKpi, moneyVnd } from './HrShared.jsx';
import { Users, WalletCards, Banknote, CalendarDays } from 'lucide-react';

export default function HrReports({ api, onView }) {
  const [state, setState] = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all([api.getPayrollState(), api.getDashboard()]).then(([payroll, hr]) => {
      if (alive) { setState(payroll);setDashboard(hr);setError(''); }
    }).catch((cause) => { if (alive) setError(cause.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [api]);
  const periods = state?.periods || [];
  const approved = periods.filter((p) => ['APPROVED', 'PAID'].includes(p.status));
  const months = state?.recognized_months || [];
  const totalRecognized = months.reduce((total, row) => total + Number(row.gross_expense || 0), 0);
  const totalPaid = approved.filter((p) => p.status === 'PAID').reduce((sum, p) => sum + Number(p.net_total || 0), 0);
  return <div className="hr-reports">
    <ErrorMessage error={error} />
    {loading ? <p className="hr-muted">Đang tải báo cáo nhân sự…</p> : !error && <>
      <div className="hr-kpi-grid hr-report-kpis">
        <HrKpi icon={Users} label="Nhân viên đang làm việc" value={dashboard?.working_count} />
        <HrKpi icon={CalendarDays} label="Kỳ lương đã duyệt (24 kỳ gần nhất)" value={approved.length} tone="green" />
        <HrKpi icon={WalletCards} label="Chi phí lương ghi nhận 6 tháng" value={moneyVnd(totalRecognized)} tone="violet" />
        <HrKpi icon={Banknote} label="Thực nhận đã xác nhận trả (24 kỳ)" value={moneyVnd(totalPaid)} tone="amber" />
      </div>
      <Panel title="Chi phí lương theo tháng" note="Từ hr_payroll_expenses sau khi duyệt. Chi trả và ứng lương trong Thu Chi không tạo thêm chi phí lương.">
        {!months.length ? <Empty title="Chưa có chi phí lương được duyệt" /> :
          <Table headers={['Tháng ghi nhận', 'Chi phí lương đã duyệt', 'Nguồn']}>
            {months.map((row) => <tr key={row.month}><td>{String(row.month).slice(0, 7)}</td>
              <td><strong>{moneyVnd(row.gross_expense)}</strong></td>
              <td><button className="button secondary" onClick={() => onView('payroll')}>Mở kỳ lương</button></td></tr>)}
          </Table>}
      </Panel>
      <Panel title="Kỳ lương gần đây" note="Báo cáo chỉ tải tối đa 24 kỳ. Phiếu đã duyệt và đã trả giữ snapshot lịch sử.">
        {!periods.length ? <Empty title="Chưa có kỳ lương" /> :
          <Table headers={['Kỳ', 'Trạng thái', 'Nhân viên', 'Tổng chi phí', 'Ứng lương khấu trừ', 'Thực nhận', 'Chi tiết']}>
            {periods.map((p) => <tr key={p.id}>
              <td>{p.period_start} → {p.period_end}</td><td>{p.status}</td><td>{p.employee_count}</td>
              <td>{moneyVnd(p.gross_total)}</td><td>{moneyVnd(p.advance_total)}</td><td>{moneyVnd(p.net_total)}</td>
              <td><button className="button secondary" onClick={() => onView('payroll')}>Xem chứng từ</button></td>
            </tr>)}
          </Table>}
      </Panel>
      <p className="hr-muted">Báo cáo quản trị nhân sự, không phải báo cáo quyết toán thuế/BHXH. Giờ thiếu và đơn nghỉ chưa có chính sách trả lương không tự suy diễn thành chi phí.</p>
    </>}
  </div>;
}
