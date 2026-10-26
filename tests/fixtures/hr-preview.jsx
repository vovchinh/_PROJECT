// Browser-only visual fixture. It never runs in production and never writes data.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import HrDashboard from '../../src/features/hr/HrDashboard.jsx';
import HrEmployees from '../../src/features/hr/HrEmployees.jsx';
import '../../src/features/hr/hr.css';

const employees = [
  { id: '1', code: 'NV-001', full_name: 'Nguyễn Thảo', department_name: 'Bán hàng',
    position_name: 'Tư vấn bán hàng', department_id: 'sales', phone: '09xx xxx 001',
    email: 'thao@example.test', status: 'active', is_active: true },
  { id: '2', code: 'NV-002', full_name: 'Trần Minh', department_name: 'Kho vận',
    position_name: 'Nhân viên kho', department_id: 'warehouse', phone: '09xx xxx 002',
    email: 'minh@example.test', status: 'active', is_active: true },
  { id: '3', code: 'NV-003', full_name: 'Lê Phương', department_name: 'Bán hàng',
    position_name: 'Tư vấn bán hàng', department_id: 'sales', phone: '09xx xxx 003',
    email: 'phuong@example.test', status: 'on_leave', is_active: true },
];
const catalogs = { departments: [
  { id: 'sales', code: 'BH', name: 'Bán hàng', is_active: true },
  { id: 'warehouse', code: 'KHO', name: 'Kho vận', is_active: true },
], positions: [
  { id: 'advisor', name: 'Tư vấn bán hàng', department_id: 'sales', is_active: true },
  { id: 'stock', name: 'Nhân viên kho', department_id: 'warehouse', is_active: true },
] };
const api = {
  getDashboard: async () => ({ employee_total: 3, working_count: 2, left_count: 0,
    department_counts: [{ department_id: 'sales', department_name: 'Bán hàng', employee_count: 2 },
      { department_id: 'warehouse', department_name: 'Kho vận', employee_count: 1 }] }),
  getAttendanceSummary: async () => ({ present_count: 2, absent_count: 1,
    unrecorded_count: 0, incomplete_count: 0, unconfirmed_count: 0 }),
  getPayrollState: async () => ({ recognized_months: [
    { month: '2026-05-01', gross_expense: '47000000' }, { month: '2026-06-01', gross_expense: '51000000' },
    { month: '2026-07-01', gross_expense: '49000000' }, { month: '2026-08-01', gross_expense: '56000000' },
    { month: '2026-09-01', gross_expense: '53000000' }, { month: '2026-10-01', gross_expense: '55000000' },
  ] }),
  listEmployees: async ({ query = '', departmentId = null, status = null, sort = 'code', desc = false,
    limit = 25, offset = 0 } = {}) => {
    let rows = employees.filter((row) => (!departmentId || row.department_id === departmentId)
      && (!status || row.status === status)
      && (!query || `${row.code} ${row.full_name} ${row.phone}`.toLowerCase().includes(query.toLowerCase())));
    rows = rows.sort((a, b) => String(a[sort] || '').localeCompare(String(b[sort] || '')) * (desc ? -1 : 1));
    return { rows: rows.slice(offset, offset + limit), total: rows.length };
  },
  getEmployee: async (id) => employees.find((row) => row.id === id),
  employeeAudit: async () => [],
};

function Preview() {
  const [view, setView] = useState('dashboard');
  return <div className="hr-preview">
    <nav className="hr-tabs" aria-label="Phân hệ nhân sự xem thử">
      {[['dashboard', 'Tổng quan'], ['employees', 'Nhân viên']].map(([id, label]) =>
        <button key={id} className={view === id ? 'active' : ''} onClick={() => setView(id)}>{label}</button>)}
    </nav>
    {view === 'dashboard'
      ? <HrDashboard api={api} onView={(next) => setView(next === 'employees' ? next : 'dashboard')} />
      : <HrEmployees api={api} catalogs={catalogs} onChanged={() => {}}
          onViewPayroll={() => setView('dashboard')} />}
  </div>;
}

export function mountHrPreview() {
  const container = document.querySelector('.hr-workspace');
  if (!container) throw new Error('Open the HR route before mounting visual fixture.');
  container.classList.remove('hr-gate');
  container.replaceChildren();
  createRoot(container).render(<Preview />);
}
