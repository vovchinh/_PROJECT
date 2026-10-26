// Local-only visual fixture for the real QR components. No Supabase call is made.
import React from 'react';
import { createRoot } from 'react-dom/client';
import HrQrSetup from '../../src/features/hr/HrQrSetup.jsx';
import { MyAttendanceView } from '../../src/features/hr/MyAttendancePage.jsx';
import '../../src/features/hr/hr.css';

const siteId = '33333333-3333-4333-8333-333333333333';
const kioskId = '44444444-4444-4444-8444-444444444444';
const token = '55555555-5555-4555-8555-555555555555';
const site = { id: siteId, code: 'CH-01', name: 'Cửa hàng trung tâm', is_active: true };
const qrApi = {
  listQrSetup: async () => ({
    sites: [site],
    assignments: [
      {
        id: 'assignment-1',
        employee_id: 'employee-1',
        employee_code: 'NV-001',
        employee_name: 'Nhân viên thử',
        site_id: siteId,
        valid_from: '2026-10-01',
        valid_to: null,
      },
    ],
  }),
  startQrKiosk: async () => ({
    id: kioskId,
    site_id: siteId,
    expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
  }),
  issueQrChallenge: async () => ({
    token,
    expires_at: new Date(Date.now() + 30_000).toISOString(),
  }),
  stopQrKiosk: async () => ({ id: kioskId, stopped_at: new Date().toISOString() }),
};
const selfApi = {
  getMyPayslips: async () => ({ items: [{
    line_id: 'slip-1', period_start: '2026-09-01', period_end: '2026-09-30',
    status: 'APPROVED', regular_minutes: 2400, overtime_minutes: 0,
    gross_pay: '500000', advance_deduction: '20000', net_pay: '480000',
  }] }),
  getMyAttendance: async () => ({
    employee_id: 'employee-1',
    items: [
      {
        id: 'attendance-1',
        schedule_id: 'schedule-1',
        work_date: '2026-10-13',
        shift_name: 'Ca sáng',
        site_name: site.name,
        kind: 'work',
        status: 'draft',
        clock_in_at: '2026-10-13T01:00:00Z',
        clock_out_at: null,
        qr_events: [{ action: 'check_in', occurred_at: '2026-10-13T01:00:00Z' }],
      },
    ],
  }),
  scanQr: async () => {
    throw new Error('Visual fixture does not submit attendance.');
  },
};

let previewRoot;
function render(element) {
  const container = document.querySelector('.hr-workspace');
  if (!container) throw new Error('Open the HR route before mounting QR preview.');
  if (previewRoot) previewRoot.unmount();
  container.classList.remove('hr-gate');
  container.replaceChildren();
  previewRoot = createRoot(container);
  previewRoot.render(element);
}

export function mountQrManagerPreview() {
  render(<HrQrSetup api={qrApi} onChanged={() => {}} />);
}

export function mountQrEmployeePreview() {
  if (previewRoot) previewRoot.unmount();
  document.querySelector('#root').style.display = 'none';
  const container = document.createElement('div');
  container.id = 'qr-employee-preview';
  document.body.append(container);
  previewRoot = createRoot(container);
  previewRoot.render(
    <MyAttendanceView
      api={selfApi}
      workspaceId="preview"
      workspaceName="ChiDi thử nghiệm"
      workspaces={[]}
      chooseWorkspace={() => {}}
      isManager={false}
    />,
  );
}
