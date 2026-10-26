// Visual-only data for real HR components; production uses the authenticated RPC API.
import React from 'react';
import { createRoot } from 'react-dom/client';
import HrRecurringSchedules from '../../src/features/hr/HrRecurringSchedules.jsx';
import HrOvertime from '../../src/features/hr/HrOvertime.jsx';
import { isoToday } from '../../src/features/hr/HrShared.jsx';
import '../../src/features/hr/hr.css';

const today = isoToday();
const site = {
  id: '33333333-3333-4333-8333-333333333333',
  code: 'CH-01',
  name: 'Cửa hàng trung tâm',
  is_active: true,
};
const rule = {
  id: '44444444-4444-4444-8444-444444444444',
  name: 'Lịch T2–T7',
  template_id: '55555555-5555-4555-8555-555555555555',
  template_name: 'Ca hành chính',
  weekday_mask: 63,
  effective_from: today,
  effective_until: null,
  is_active: true,
};
const employee = {
  id: '66666666-6666-4666-8666-666666666666',
  code: 'NV-001',
  full_name: 'Nhân viên thử',
  department_name: 'Vận hành',
  employee_type: 'full_time',
};
const api = {
  listQrSetup: async () => ({ sites: [site] }),
  listRecurringSetup: async ({ kind }) => ({
    items:
      kind === 'templates'
        ? [
            {
              id: rule.template_id,
              code: 'HC-01',
              name: 'Ca hành chính',
              start_time: '08:00:00',
              end_time: '17:00:00',
              end_day_offset: 0,
              break_minutes: 45,
              is_active: true,
              is_used: true,
            },
          ]
        : kind === 'rules'
          ? [rule]
          : [],
    total: kind === 'assignments' ? 0 : 1,
  }),
  listScheduleEmployees: async () => ({ items: [employee], total: 1 }),
  previewRecurringSchedule: async () => ({
    summary: { create: 6, off: 1, conflict: 0, keep_manual: 0, keep_generated: 0 },
    items: [
      {
        employee_id: employee.id,
        work_date: today,
        status: 'CREATE',
        planned_start_at: `${today}T01:00:00Z`,
        planned_end_at: `${today}T10:00:00Z`,
        break_minutes: 45,
      },
    ],
  }),
  listOvertimeReviews: async () => ({
    items: [
      {
        attendance_id: '77777777-7777-4777-8777-777777777777',
        employee_name: employee.full_name,
        employee_code: employee.code,
        work_date: today,
        shift_name: 'Ca hành chính',
        clock_in_at: `${today}T01:00:00Z`,
        clock_out_at: `${today}T11:00:00Z`,
        raw_minutes: 60,
        approved_minutes: null,
        review_status: 'pending',
      },
    ],
    total: 1,
  }),
  reviewOvertime: async () => ({ id: 'decision-1' }),
};

let previewRoot;
function render(element) {
  const container = document.querySelector('.hr-workspace');
  if (!container) throw new Error('Open the HR route before mounting the visual preview.');
  if (previewRoot) previewRoot.unmount();
  container.classList.remove('hr-gate');
  container.replaceChildren();
  previewRoot = createRoot(container);
  previewRoot.render(element);
}

export function mountRecurringPreview() {
  render(
    <HrRecurringSchedules
      api={api}
      catalogs={{ departments: [] }}
      onChanged={() => {}}
      onNavigate={() => {}}
    />,
  );
}

export function mountOvertimePreview() {
  render(<HrOvertime api={api} onChanged={() => {}} />);
}
