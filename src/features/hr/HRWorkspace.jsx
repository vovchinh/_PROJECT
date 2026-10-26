import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Users,
  Clock3,
  CalendarDays,
  WalletCards,
  ChartNoAxesColumn,
  LayoutDashboard,
  Building2,
  QrCode,
  CalendarRange,
} from 'lucide-react';
import { ErrorMessage } from '../../components.jsx';
import { supabase } from '../../lib/repository.js';
import { createHrApi } from '../../lib/hr-api.js';
import HrDashboard from './HrDashboard.jsx';
import HrEmployees from './HrEmployees.jsx';
import HrCatalogs from './HrCatalogs.jsx';
import HrAttendance from './HrAttendance.jsx';
import HrLeave from './HrLeave.jsx';
import HrPayroll from './HrPayroll.jsx';
import HrReports from './HrReports.jsx';
import HrQrSetup from './HrQrSetup.jsx';
import HrRecurringSchedules from './HrRecurringSchedules.jsx';
import HrOvertime from './HrOvertime.jsx';
import './hr.css';

const tabs = [
  ['dashboard', 'Tổng quan', LayoutDashboard],
  ['employees', 'Nhân viên', Users],
  ['catalogs', 'Phòng ban & chức vụ', Building2],
  ['attendance', 'Chấm công', Clock3],
  ['schedule', 'Ca làm việc', CalendarRange],
  ['overtime', 'Duyệt tăng ca', Clock3],
  ['qr', 'Cửa hàng & QR', QrCode],
  ['leave', 'Nghỉ phép', CalendarDays],
  ['payroll', 'Tiền lương', WalletCards],
  ['reports', 'Báo cáo', ChartNoAxesColumn],
];

export default function HRWorkspace({
  workspaceId,
  role,
  mode,
  section = 'dashboard',
  onNavigate,
}) {
  const [catalogs, setCatalogs] = useState({ departments: [], positions: [] });
  const [catalogError, setCatalogError] = useState('');
  const [revision, setRevision] = useState(0);
  const [employeeForPayroll, setEmployeeForPayroll] = useState(null);
  const [notice, setNotice] = useState('');
  const api = useMemo(
    () => (workspaceId ? createHrApi(supabase, workspaceId) : null),
    [workspaceId],
  );
  const refreshCatalogs = useCallback(async () => {
    if (!api) return;
    try {
      setCatalogs(await api.getCatalogs());
      setCatalogError('');
    } catch (error) {
      setCatalogError(error.message);
    }
  }, [api]);
  useEffect(() => {
    refreshCatalogs();
  }, [refreshCatalogs, revision]);
  const onChanged = useCallback((message) => {
    setRevision((value) => value + 1);
    if (message) setNotice(message);
  }, []);
  const view = tabs.some(([id]) => id === section) ? section : 'dashboard';

  if (mode !== 'cloud' || !workspaceId)
    return (
      <div className="hr-workspace hr-gate">
        <h2>Nhân sự cần Supabase</h2>
        <p>
          Đăng nhập workspace online đã cài migration 017–019 để quản lý dữ liệu nhân sự thật. Bản
          chạy thử trên máy không ghi hồ sơ/lương.
        </p>
      </div>
    );
  if (!['owner', 'manager'].includes(role))
    return (
      <div className="hr-workspace hr-gate">
        <h2>Không có quyền xem nhân sự & lương</h2>
        <p>Dữ liệu nhân sự và tiền lương chỉ dành cho owner/manager của workspace.</p>
      </div>
    );

  return (
    <div className="hr-workspace">
      <nav className="hr-tabs" aria-label="Phân hệ nhân sự">
        {tabs.map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            className={view === id ? 'active' : ''}
            aria-current={view === id ? 'page' : undefined}
            onClick={() => onNavigate(id)}
          >
            <Icon size={17} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      {notice && (
        <div className="hr-notice" role="status">
          {notice}
          <button aria-label="Đóng thông báo" onClick={() => setNotice('')}>
            ×
          </button>
        </div>
      )}
      <ErrorMessage error={catalogError} />
      {view === 'dashboard' && <HrDashboard api={api} revision={revision} onView={onNavigate} />}
      {view === 'employees' && (
        <HrEmployees
          api={api}
          catalogs={catalogs}
          onChanged={onChanged}
          onViewPayroll={(id) => {
            setEmployeeForPayroll(id);
            onNavigate('payroll');
          }}
        />
      )}
      {view === 'catalogs' && <HrCatalogs api={api} catalogs={catalogs} onChanged={onChanged} />}
      {view === 'attendance' && (
        <HrAttendance api={api} catalogs={catalogs} onChanged={onChanged} />
      )}
      {view === 'schedule' && (
        <HrRecurringSchedules
          api={api}
          catalogs={catalogs}
          onChanged={onChanged}
          onNavigate={onNavigate}
        />
      )}
      {view === 'overtime' && <HrOvertime api={api} onChanged={onChanged} />}
      {view === 'qr' && <HrQrSetup api={api} onChanged={onChanged} />}
      {view === 'leave' && <HrLeave api={api} onChanged={onChanged} />}
      {view === 'payroll' && (
        <HrPayroll api={api} onChanged={onChanged} initialEmployeeId={employeeForPayroll} />
      )}
      {view === 'reports' && <HrReports api={api} onView={onNavigate} />}
    </div>
  );
}
