// HR RPCs use the authenticated Supabase client; RLS and server-side role checks
// remain the authority. No salary calculation or personnel mutation runs here.
export function createHrApi(supabase, workspaceId) {
  const rpc = async (name, args = {}) => {
    const { data, error } = await supabase.rpc(name, { p_workspace_id: workspaceId, ...args });
    if (error) {
      if (error.code === 'PGRST202')
        throw new Error(
          'Chức năng Nhân sự chưa có trong database. Áp dụng các migration HR theo thứ tự rồi tải lại.',
        );
      const readable = {
        HR_OT_REVIEW_REQUIRED:
          'Còn tăng ca chưa được duyệt. Mở mục Duyệt tăng ca trước khi tính lương.',
        HR_OT_PAYROLL_STALE: 'Quyết định tăng ca đã đổi. Vui lòng tính lại kỳ lương.',
        HR_RECURRING_COVERAGE:
          'Lịch lặp trong kỳ chưa được đồng bộ đủ ngày làm. Mở Ca làm việc để kiểm tra.',
        HR_RECURRING_HISTORY:
          'Không thể lùi ngày kết thúc về quá khứ vì sẽ xóa dấu vết ca dự kiến. Chọn ngày hiện tại trở đi.',
        HR_RECURRING_LOCKED:
          'Ca đã có chấm công hoặc kỳ lương đã tính/duyệt. Kiểm tra chứng từ liên quan trước khi điều chỉnh.',
        HR_RECURRING_SITE: 'Nhân viên chưa được gán hợp lệ vào cửa hàng cho toàn bộ ngày phân ca.',
      };
      const code = Object.keys(readable).find((item) => error.message?.startsWith(item));
      const failure = new Error(code ? readable[code] : error.message);
      failure.code = error.code;
      throw failure;
    }
    return data;
  };
  const payloadRpc = async (name, payload) => {
    const { data, error } = await supabase.rpc(name, {
      p_payload: { ...payload, workspace_id: workspaceId },
    });
    if (error)
      throw new Error(
        error.code === 'PGRST202'
          ? 'Chưa có phân hệ tiền lương trong database. Áp dụng migration 019 rồi tải lại.'
          : error.message,
      );
    return data;
  };
  const read = async (
    table,
    columns,
    { filters = [], order = 'created_at', ascending = false, limit = 100 } = {},
  ) => {
    let query = supabase
      .from(table)
      .select(columns)
      .eq('workspace_id', workspaceId)
      .order(order, { ascending })
      .limit(limit);
    for (const [column, value] of filters) query = query.eq(column, value);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return data;
  };
  return {
    getDashboard: () => rpc('get_hr_dashboard'),
    getCatalogs: () => rpc('get_hr_catalogs'),
    listEmployees: ({
      query = '',
      departmentId = null,
      status = null,
      sort = 'code',
      desc = false,
      limit = 25,
      offset = 0,
    } = {}) =>
      rpc('list_hr_employees', {
        p_query: query,
        p_department_id: departmentId,
        p_status: status,
        p_sort: sort,
        p_desc: desc,
        p_limit: limit,
        p_offset: offset,
      }),
    getEmployee: (id) => rpc('get_hr_employee', { p_id: id }),
    saveEmployee: (payload) => rpc('save_hr_employee', { p_payload: payload }),
    setEmployeeArchived: (id, archived, reason) =>
      rpc('set_hr_employee_archived', {
        p_id: id,
        p_archived: archived,
        p_reason: reason,
      }),
    saveDepartment: (payload) => rpc('save_hr_department', { p_payload: payload }),
    setDepartmentArchived: (id, archived, reason) =>
      rpc('set_hr_department_archived', {
        p_id: id,
        p_archived: archived,
        p_reason: reason,
      }),
    deleteDepartment: (id, reason) => rpc('delete_hr_department', { p_id: id, p_reason: reason }),
    savePosition: (payload) => rpc('save_hr_position', { p_payload: payload }),
    setPositionArchived: (id, archived, reason) =>
      rpc('set_hr_position_archived', {
        p_id: id,
        p_archived: archived,
        p_reason: reason,
      }),
    deletePosition: (id, reason) => rpc('delete_hr_position', { p_id: id, p_reason: reason }),
    employeeAudit: (id) =>
      read('audit_events', 'id,action,actor_id,details,created_at', {
        filters: [['entity_id', id]],
        limit: 30,
      }),
    saveSchedule: (payload) => rpc('save_hr_work_schedule', { p_payload: payload }),
    overrideRecurringShift: (scheduleId, payload, reason, requestId = crypto.randomUUID()) =>
      rpc('override_hr_recurring_shift', {
        p_schedule_id: scheduleId,
        p_payload: payload,
        p_reason: reason,
        p_request_id: requestId,
      }),
    listSchedules: ({ month, employeeId = null, page = 1, pageSize = 25 }) =>
      rpc('list_hr_work_schedules', {
        p_month: month,
        p_employee_id: employeeId,
        p_page: page,
        p_page_size: pageSize,
      }),
    saveShiftTemplate: (payload) => rpc('save_hr_shift_template', { p_payload: payload }),
    saveWeeklyScheduleRule: (payload) =>
      rpc('save_hr_weekly_schedule_rule', { p_payload: payload }),
    listRecurringSetup: ({ kind, page = 1, pageSize = 25 }) =>
      rpc('list_hr_recurring_setup', {
        p_kind: kind,
        p_page: page,
        p_page_size: pageSize,
      }),
    listScheduleEmployees: ({
      query = '',
      departmentId = null,
      employeeType = null,
      siteId = null,
      effectiveDate = null,
      page = 1,
      pageSize = 25,
    } = {}) =>
      rpc('list_hr_schedule_employees', {
        p_query: query,
        p_department_id: departmentId,
        p_employee_type: employeeType,
        p_site_id: siteId,
        p_effective_date: effectiveDate,
        p_page: page,
        p_page_size: pageSize,
      }),
    previewRecurringSchedule: (payload) =>
      rpc('preview_hr_recurring_schedule', { p_payload: payload }),
    assignRecurringSchedule: (payload, requestId) =>
      rpc('assign_hr_recurring_schedule', {
        p_payload: payload,
        p_request_id: requestId,
      }),
    closeRecurringAssignment: (assignmentId, validTo, reason, requestId) =>
      rpc('close_hr_recurring_assignment', {
        p_assignment_id: assignmentId,
        p_valid_to: validTo,
        p_reason: reason,
        p_request_id: requestId,
      }),
    materializeRecurringSchedules: (from, to, requestId) =>
      rpc('materialize_hr_recurring_schedules', {
        p_from: from,
        p_to: to,
        p_request_id: requestId,
      }),
    listQrSetup: () => rpc('list_hr_qr_setup'),
    saveAttendanceSite: (payload) => rpc('save_hr_attendance_site', { p_payload: payload }),
    saveSiteAssignment: (payload) => rpc('save_hr_site_assignment', { p_payload: payload }),
    bindScheduleSite: (scheduleId, siteId) =>
      rpc('bind_hr_work_schedule_site', {
        p_schedule_id: scheduleId,
        p_site_id: siteId,
      }),
    startQrKiosk: (siteId, requestId = crypto.randomUUID()) =>
      rpc('start_hr_qr_kiosk', {
        p_site_id: siteId,
        p_request_id: requestId,
      }),
    issueQrChallenge: (kioskId) => rpc('issue_hr_qr_challenge', { p_kiosk_id: kioskId }),
    stopQrKiosk: (kioskId) => rpc('stop_hr_qr_kiosk', { p_kiosk_id: kioskId }),
    scanQr: async (token, action, requestId = crypto.randomUUID()) => {
      const result = await rpc('scan_hr_qr', {
        p_token: token,
        p_action: action,
        p_request_id: requestId,
      });
      if (result?.ok === false) {
        const failure = new Error(
          `Máy chủ từ chối lượt quét (${result.error || 'HR_QR_REJECTED'}).`,
        );
        failure.code = result.error;
        throw failure;
      }
      return result;
    },
    getMyAttendance: (month) => rpc('get_my_hr_attendance', { p_month: month }),
    getMyPayslips: () => rpc('get_my_hr_payslips', { p_limit: 12 }),
    saveAttendance: (payload, requestId = crypto.randomUUID()) =>
      rpc('save_hr_attendance', {
        p_payload: payload,
        p_request_id: requestId,
      }),
    confirmAttendance: (id, requestId = crypto.randomUUID()) =>
      rpc('confirm_hr_attendance', {
        p_id: id,
        p_request_id: requestId,
      }),
    adjustAttendance: (id, payload, reason, requestId = crypto.randomUUID()) =>
      rpc('adjust_hr_attendance', {
        p_id: id,
        p_payload: payload,
        p_reason: reason,
        p_request_id: requestId,
      }),
    listAttendance: ({
      month,
      employeeId = null,
      departmentId = null,
      status = null,
      page = 1,
      pageSize = 25,
    }) =>
      rpc('list_hr_attendance', {
        p_month: month,
        p_employee_id: employeeId,
        p_department_id: departmentId,
        p_status: status,
        p_page: page,
        p_page_size: pageSize,
      }),
    getAttendanceSummary: (date) => rpc('get_hr_attendance_summary', { p_date: date }),
    listOvertimeReviews: ({ month, status = null, page = 1, pageSize = 25 }) =>
      rpc('list_hr_overtime_reviews', {
        p_month: month,
        p_status: status,
        p_page: page,
        p_page_size: pageSize,
      }),
    reviewOvertime: (attendanceId, approvedMinutes, reason, requestId = crypto.randomUUID()) =>
      rpc('review_hr_overtime', {
        p_attendance_id: attendanceId,
        p_approved_minutes: approvedMinutes,
        p_reason: reason,
        p_request_id: requestId,
      }),
    saveLeave: (payload, requestId = crypto.randomUUID()) =>
      rpc('save_hr_leave_request', {
        p_payload: payload,
        p_request_id: requestId,
      }),
    transitionLeave: (id, target, reason, requestId = crypto.randomUUID()) =>
      rpc('transition_hr_leave_request', {
        p_id: id,
        p_target: target,
        p_reason: reason,
        p_request_id: requestId,
      }),
    listLeave: ({ status = null, employeeId = null, page = 1, pageSize = 25 } = {}) =>
      rpc('list_hr_leave_requests', {
        p_status: status,
        p_employee_id: employeeId,
        p_page: page,
        p_page_size: pageSize,
      }),
    saveContract: (payload) => payloadRpc('save_payroll_contract', payload),
    savePayrollPeriod: (payload) => payloadRpc('save_payroll_period', payload),
    getPayrollState: (periodId = null) => rpc('get_hr_payroll_state', { p_period_id: periodId }),
    calculatePayroll: (id) => rpc('calculate_payroll', { p_period_id: id }),
    reviewPayroll: (id) => rpc('review_payroll', { p_period_id: id }),
    approvePayroll: (id, requestId = crypto.randomUUID()) =>
      rpc('approve_payroll', {
        p_period_id: id,
        p_request_id: requestId,
      }),
    payPayroll: (id, accountId, paymentDate, requestId = crypto.randomUUID()) =>
      rpc('pay_payroll', {
        p_period_id: id,
        p_account_id: accountId,
        p_payment_date: paymentDate,
        p_request_id: requestId,
      }),
    createSalaryAdvance: (
      employeeId,
      periodId,
      accountId,
      amount,
      date,
      requestId = crypto.randomUUID(),
    ) =>
      rpc('create_salary_advance', {
        p_employee_id: employeeId,
        p_period_id: periodId,
        p_account_id: accountId,
        p_amount: amount,
        p_transaction_date: date,
        p_request_id: requestId,
      }),
    savePayrollComponent: (payload, requestId = crypto.randomUUID()) =>
      rpc('save_hr_payroll_component', { p_payload: payload, p_request_id: requestId }),
    voidPayrollComponent: (id, reason, requestId = crypto.randomUUID()) =>
      rpc('void_hr_payroll_component', {
        p_component_id: id,
        p_reason: reason,
        p_request_id: requestId,
      }),
    read,
  };
}
