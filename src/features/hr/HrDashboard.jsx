import { useEffect, useState } from 'react';
import { Users, UserRoundCheck, UserRoundX, CalendarCheck2, CalendarX2, WalletCards,
  BriefcaseBusiness, Clock3, CalendarDays, ChartNoAxesColumn, FileBarChart2 } from 'lucide-react';
import { Panel, Empty, ErrorMessage } from '../../components.jsx';
import { HrKpi, isoMonth, isoToday, moneyVnd } from './HrShared.jsx';

const shortcuts = [
  ['employees', 'Nhân viên', 'Hồ sơ và công việc', Users, 'blue'],
  ['attendance', 'Chấm công', 'Ca và giờ thực tế', Clock3, 'green'],
  ['leave', 'Nghỉ phép', 'Đơn và phê duyệt', CalendarDays, 'red'],
  ['payroll', 'Tiền lương', 'Tính, duyệt và trả', WalletCards, 'violet'],
  ['reports', 'Báo cáo nhân sự', 'Theo dõi và đối chiếu', FileBarChart2, 'amber'],
];
const chartColors = ['var(--hr-blue)', 'var(--hr-green)', 'var(--hr-violet)', 'var(--hr-amber)', 'var(--hr-red)', 'var(--hr-slate)'];
const pastMonths = () => {
  const [year, month] = isoMonth().split('-').map(Number);
  return Array.from({ length: 6 }, (_, i) => {
    const d = new Date(Date.UTC(year, month - 1 - (5 - i), 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  });
};

export default function HrDashboard({ api, onView, revision }) {
  const [core, setCore] = useState(null);
  const [attendance, setAttendance] = useState(null);
  const [payroll, setPayroll] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true);setWarnings([]);
    Promise.allSettled([api.getDashboard(), api.getAttendanceSummary(isoToday()), api.getPayrollState()])
      .then(([a, b, c]) => {
        if (!alive) return;
        setCore(a.status === 'fulfilled' ? a.value : null);
        setAttendance(b.status === 'fulfilled' ? b.value : null);
        setPayroll(c.status === 'fulfilled' ? c.value : null);
        setWarnings([a, b, c].filter((result) => result.status === 'rejected').map((result) => result.reason.message));
      }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [api, revision]);

  const months = pastMonths();
  const recognized = payroll?.recognized_months || [];
  const byMonth = new Map(recognized.map((row) => [String(row.month || row.period_month || '').slice(0, 7), Number(row.gross_expense ?? 0)]));
  const values = months.map((month) => byMonth.get(month) ?? null);
  const hasRecognizedExpense = values.some((value) => value > 0);
  const maxValue = Math.max(1, ...values.filter((value) => value != null));
  const departments = core?.department_counts || [];
  const total = departments.reduce((count, row) => count + Number(row.employee_count), 0);
  let cumulative = 0;
  const donut = total ? departments.filter((row) => Number(row.employee_count) > 0).map((row, index) => {
    const start = cumulative;
    cumulative += Number(row.employee_count) / total * 100;
    return `${chartColors[index % chartColors.length]} ${start}% ${cumulative}%`;
  }).join(',') : '';
  const currentPayroll = byMonth.get(isoMonth());

  return <div className="hr-dashboard">
    {warnings.length > 0 && <ErrorMessage error={warnings.join(' · ')} />}
    <div className="hr-kpi-grid">
      <HrKpi icon={Users} label="Tổng nhân viên" value={core?.employee_total} />
      <HrKpi icon={UserRoundCheck} label="Đang làm việc" value={core?.working_count} tone="green" />
      <HrKpi icon={UserRoundX} label="Nghỉ việc" value={core?.left_count} tone="red" />
      <HrKpi icon={CalendarCheck2} label="Có mặt hôm nay" value={attendance?.present_count} tone="green" />
      <HrKpi icon={CalendarX2} label="Vắng mặt đã xác nhận" value={attendance?.absent_count} tone="amber" />
      <HrKpi icon={WalletCards} label="Chi phí lương được duyệt tháng này" value={currentPayroll == null ? null : moneyVnd(currentPayroll)} tone="violet" />
    </div>
    {attendance && <p className="hr-muted">Hôm nay: {attendance.unrecorded_count} ca chưa có bản ghi · {attendance.incomplete_count} bản ghi thiếu giờ · {attendance.unconfirmed_count} chờ xác nhận. Chưa chấm không tự tính là vắng.</p>}
    <div className="hr-dashboard-middle">
      <Panel title="Điều hành nhân sự" note="Mở đúng khu vực để xử lý, thay vì xem tất cả bảng trên một trang.">
        <div className="hr-shortcuts">{shortcuts.map(([id, title, detail, Icon, tone]) =>
          <button key={id} className={`hr-shortcut hr-tone-${tone}`} onClick={() => onView(id)}>
            <span><Icon size={25} /></span><strong>{title}</strong><small>{detail}</small>
          </button>)}</div>
      </Panel>
      <Panel title="Chi phí lương 6 tháng gần đây" note="Chỉ lấy các kỳ đã duyệt; tiền đã trả không được cộng thêm lần nữa.">
        {!hasRecognizedExpense ? <Empty title={loading ? 'Đang tải số liệu' : 'Chưa có chi phí lương được duyệt trong 6 tháng'} /> :
          <div className="hr-bars" role="img" aria-label="Biểu đồ chi phí lương sáu tháng">
            {months.map((month, index) => <div key={month} className="hr-bar-item" title={`${month}: ${moneyVnd(values[index])}`}>
              <div className="hr-bar-plot"><span style={{ height: `${values[index] == null ? 0 : Math.max(3, values[index] / maxValue * 100)}%` }} /></div>
              <small>{month.slice(5)}/{month.slice(2, 4)}</small>
            </div>)}
          </div>}
      </Panel>
      <Panel title="Cơ cấu theo phòng ban" note="Nhân viên đang có hồ sơ hoạt động.">
        {!total ? <Empty title={loading ? 'Đang tải dữ liệu' : 'Chưa có nhân viên theo phòng ban'} /> :
          <div className="hr-department-chart"><div className="hr-donut" style={{ background: `conic-gradient(${donut})` }}>
            <span><strong>{total}</strong><small>nhân viên</small></span></div>
            <ul>{departments.filter((row) => Number(row.employee_count) > 0).map((row, index) =>
              <li key={row.department_id}><i style={{ background: chartColors[index % chartColors.length] }} />
                <span>{row.department_name}</span><strong>{row.employee_count}</strong></li>)}</ul>
          </div>}
      </Panel>
    </div>
  </div>;
}
