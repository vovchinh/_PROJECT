import { useEffect, useRef, useState } from 'react';
import { Badge, ErrorMessage, Field, Modal, Panel, Select, Table } from '../../components.jsx';
import { EmployeePicker, HrPager, isoMonth, isoToday } from './HrShared.jsx';
import { fromVnDateTimeInput, toVnDateTimeInput } from './hr-datetime.js';
import './hr-attendance.css';

const PAGE_SIZE = 25;
const KINDS = [
  { value: 'work', label: 'Đi làm' },
  { value: 'absent', label: 'Vắng mặt' },
  { value: 'leave', label: 'Nghỉ phép đã duyệt' },
];
const STATUS_FILTERS = [
  { value: 'draft', label: 'Chưa xác nhận' },
  { value: 'confirmed', label: 'Đã xác nhận' },
  { value: 'incomplete', label: 'Thiếu giờ vào/ra' },
  { value: 'late', label: 'Đi muộn' },
  { value: 'early', label: 'Về sớm' },
  { value: 'overtime', label: 'Tăng ca' },
  { value: 'absent', label: 'Vắng mặt' },
  { value: 'leave', label: 'Nghỉ phép' },
];

function dateLabel(value) {
  if (!value) return '—';
  const [year, month, day] = value.slice(0, 10).split('-');
  return `${day}/${month}/${year}`;
}

function timeLabel(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh',
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(date);
}

function minutesLabel(value) {
  if (value == null) return '—';
  const minutes = Number(value);
  return `${Math.floor(minutes / 60)}g${String(minutes % 60).padStart(2, '0')}`;
}

function formForSchedule(row, month) {
  return row
    ? {
        id: row.id,
        employee_id: row.employee_id,
        work_date: row.work_date,
        planned_start_at: toVnDateTimeInput(row.planned_start_at),
        planned_end_at: toVnDateTimeInput(row.planned_end_at),
        break_minutes: row.break_minutes,
        late_grace_minutes: row.late_grace_minutes,
        early_grace_minutes: row.early_grace_minutes,
        shift_name: row.shift_name || '',
        site_id: row.site_id || '',
        source_kind: row.source_kind || 'manual',
        reason: '',
      }
    : {
        employee_id: null,
        work_date: month === isoMonth() ? isoToday() : `${month}-01`,
        planned_start_at: '',
        planned_end_at: '',
        break_minutes: 0,
        late_grace_minutes: 0,
        early_grace_minutes: 0,
        shift_name: '',
        site_id: '',
        source_kind: 'manual',
        reason: '',
      };
}

export function formForAttendance(row, schedule) {
  return {
    id: row?.id || null,
    schedule_id: row?.schedule_id || schedule.id,
    employee_name: row?.employee_name || schedule.employee_name,
    work_date: row?.work_date || schedule.work_date,
    kind: row?.kind || 'work',
    clock_in_at: toVnDateTimeInput(row?.clock_in_at),
    clock_out_at: toVnDateTimeInput(row?.clock_out_at),
    break_minutes: row?.break_minutes ?? schedule.break_minutes ?? 0,
    status: row?.status || 'draft',
    reason: '',
  };
}

function AttendanceFlags({ row }) {
  const flags = [];
  if (row.kind === 'work' && (row.clock_in_at == null || row.clock_out_at == null))
    flags.push('Thiếu giờ');
  if (Number(row.late_minutes) > 0) flags.push(`Muộn ${row.late_minutes}′`);
  if (Number(row.early_leave_minutes) > 0) flags.push(`Sớm ${row.early_leave_minutes}′`);
  if (Number(row.overtime_minutes) > 0) flags.push(`Ngoài giờ ghi nhận ${row.overtime_minutes}′`);
  return flags.length ? (
    <span className="hr-record-flags">
      {flags.map((flag) => (
        <span key={flag}>{flag}</span>
      ))}
    </span>
  ) : (
    <span className="muted-text">—</span>
  );
}

export default function HrAttendance({ api, catalogs, onChanged }) {
  const [month, setMonth] = useState(isoMonth);
  const [employeeId, setEmployeeId] = useState(null);
  const [departmentId, setDepartmentId] = useState(null);
  const [status, setStatus] = useState(null);
  const [schedulePage, setSchedulePage] = useState(1);
  const [attendancePage, setAttendancePage] = useState(1);
  const [schedules, setSchedules] = useState({ items: [], total: 0 });
  const [attendance, setAttendance] = useState({ items: [], total: 0 });
  const [schedulesLoading, setSchedulesLoading] = useState(true);
  const [attendanceLoading, setAttendanceLoading] = useState(true);
  const [scheduleError, setScheduleError] = useState('');
  const [attendanceError, setAttendanceError] = useState('');
  const [actionError, setActionError] = useState('');
  const [formError, setFormError] = useState('');
  const [scheduleForm, setScheduleForm] = useState(null);
  const [attendanceForm, setAttendanceForm] = useState(null);
  const [confirmRow, setConfirmRow] = useState(null);
  const [busy, setBusy] = useState(false);
  const [openingSchedule, setOpeningSchedule] = useState(null);
  const [revision, setRevision] = useState(0);
  const [sites, setSites] = useState([]);
  const [siteError, setSiteError] = useState('');
  const attempt = useRef(null);
  const scheduleAttempt = useRef(null);

  useEffect(() => {
    let active = true;
    api
      .listQrSetup()
      .then((value) => {
        if (active) {
          setSites(value?.sites || []);
          setSiteError('');
        }
      })
      .catch((cause) => {
        if (active) setSiteError(cause.message);
      });
    return () => {
      active = false;
    };
  }, [api, revision]);

  useEffect(() => {
    let active = true;
    setSchedulesLoading(true);
    setScheduleError('');
    api
      .listSchedules({ month: `${month}-01`, employeeId, page: schedulePage, pageSize: PAGE_SIZE })
      .then((result) => {
        if (active) setSchedules(result);
      })
      .catch((cause) => {
        if (active) setScheduleError(cause.message);
      })
      .finally(() => {
        if (active) setSchedulesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, month, employeeId, schedulePage, revision]);

  useEffect(() => {
    let active = true;
    setAttendanceLoading(true);
    setAttendanceError('');
    api
      .listAttendance({
        month: `${month}-01`,
        employeeId,
        departmentId,
        status,
        page: attendancePage,
        pageSize: PAGE_SIZE,
      })
      .then((result) => {
        if (active) setAttendance(result);
      })
      .catch((cause) => {
        if (active) setAttendanceError(cause.message);
      })
      .finally(() => {
        if (active) setAttendanceLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, month, employeeId, departmentId, status, attendancePage, revision]);

  function changeMonth(value) {
    if (!value) return;
    setMonth(value);
    setSchedulePage(1);
    setAttendancePage(1);
  }

  function changeEmployee(value) {
    setEmployeeId(value);
    setSchedulePage(1);
    setAttendancePage(1);
  }

  async function afterMutation(message) {
    setRevision((value) => value + 1);
    await onChanged?.(message);
  }

  function openSchedule(row = null) {
    setActionError('');
    setFormError('');
    setScheduleForm(formForSchedule(row, month));
    scheduleAttempt.current = null;
  }

  async function saveSchedule(event) {
    event.preventDefault();
    if (busy) return;
    setFormError('');
    let startIso;
    let endIso;
    try {
      startIso = fromVnDateTimeInput(scheduleForm.planned_start_at);
      endIso = fromVnDateTimeInput(scheduleForm.planned_end_at);
    } catch (cause) {
      setFormError(cause.message);
      return;
    }
    const start = new Date(startIso);
    const end = new Date(endIso);
    const plannedMinutes = (end - start) / 60000 - Number(scheduleForm.break_minutes);
    if (!(plannedMinutes > 0 && end - start <= 24 * 60 * 60000)) {
      setFormError(
        'Giờ kết thúc phải sau giờ bắt đầu, tối đa 24 giờ, và còn thời gian làm sau khi trừ nghỉ giữa ca.',
      );
      return;
    }
    if (scheduleForm.source_kind === 'recurring' && scheduleForm.reason.trim().length < 10) {
      setFormError('Điều chỉnh một ngày của lịch lặp cần lý do từ 10 ký tự.');
      return;
    }
    setBusy(true);
    try {
      const {
        site_id: desiredSite,
        source_kind: sourceKind,
        reason: scheduleReason,
        ...plainForm
      } = scheduleForm;
      const schedulePayload = {
        ...plainForm,
        planned_start_at: startIso,
        planned_end_at: endIso,
        break_minutes: Number(scheduleForm.break_minutes),
        late_grace_minutes: Number(scheduleForm.late_grace_minutes),
        early_grace_minutes: Number(scheduleForm.early_grace_minutes),
      };
      let saved;
      if (sourceKind === 'recurring') {
        const overridePayload = {
          planned_start_at: schedulePayload.planned_start_at,
          planned_end_at: schedulePayload.planned_end_at,
          break_minutes: schedulePayload.break_minutes,
          late_grace_minutes: schedulePayload.late_grace_minutes,
          early_grace_minutes: schedulePayload.early_grace_minutes,
          shift_name: schedulePayload.shift_name,
          site_id: desiredSite,
        };
        const signature = JSON.stringify([scheduleForm.id, overridePayload, scheduleReason.trim()]);
        if (scheduleAttempt.current?.signature !== signature)
          scheduleAttempt.current = { signature, id: crypto.randomUUID() };
        const result = await api.overrideRecurringShift(
          scheduleForm.id,
          overridePayload,
          scheduleReason.trim(),
          scheduleAttempt.current.id,
        );
        saved = result.schedule;
      } else {
        saved = await api.saveSchedule(schedulePayload);
      }
      if (sourceKind !== 'recurring' && desiredSite && saved.site_id !== desiredSite) {
        try {
          await api.bindScheduleSite(saved.id, desiredSite);
        } catch (cause) {
          setScheduleForm({ ...scheduleForm, id: saved.id });
          setRevision((value) => value + 1);
          throw new Error(
            `Ca đã lưu nhưng chưa gắn cửa hàng: ${cause.message} Kiểm tra phân công nhân viên rồi lưu lại.`,
          );
        }
      }
      setScheduleForm(null);
      await afterMutation(
        sourceKind === 'recurring'
          ? 'Đã điều chỉnh ca một ngày và giữ lịch sử nguồn lịch lặp.'
          : 'Đã lưu ca làm.',
      );
    } catch (cause) {
      setFormError(cause.message);
    } finally {
      setBusy(false);
    }
  }

  function openAttendance(row, schedule = null) {
    setActionError('');
    setFormError('');
    attempt.current = null;
    setAttendanceForm(formForAttendance(row, schedule || row));
  }

  async function openFromSchedule(schedule) {
    if (openingSchedule) return;
    setActionError('');
    setOpeningSchedule(schedule.id);
    try {
      const result = await api.listAttendance({
        month: `${schedule.work_date.slice(0, 7)}-01`,
        employeeId: schedule.employee_id,
        page: 1,
        pageSize: 100,
      });
      const existing = (result.items || []).find((row) => row.schedule_id === schedule.id);
      openAttendance(existing, schedule);
    } catch (cause) {
      setActionError(cause.message);
    } finally {
      setOpeningSchedule(null);
    }
  }

  async function saveAttendance(event) {
    event.preventDefault();
    if (busy) return;
    setFormError('');
    const isWork = attendanceForm.kind === 'work';
    const clockIn = isWork ? attendanceForm.clock_in_at : '';
    const clockOut = isWork ? attendanceForm.clock_out_at : '';
    const breakMinutes = isWork ? Number(attendanceForm.break_minutes) : 0;
    let clockInIso;
    let clockOutIso;
    try {
      clockInIso = fromVnDateTimeInput(clockIn);
      clockOutIso = fromVnDateTimeInput(clockOut);
    } catch (cause) {
      setFormError(cause.message);
      return;
    }
    if (
      isWork &&
      clockIn &&
      clockOut &&
      (new Date(clockOutIso) <= new Date(clockInIso) ||
        (new Date(clockOutIso) - new Date(clockInIso)) / 60000 <= breakMinutes)
    ) {
      setFormError('Giờ ra phải sau giờ vào và vượt quá thời gian nghỉ giữa ca.');
      return;
    }
    if (attendanceForm.status === 'confirmed' && isWork && (!clockIn || !clockOut)) {
      setFormError('Chấm công đã xác nhận cần đủ giờ vào và giờ ra.');
      return;
    }
    const payload =
      attendanceForm.status === 'confirmed'
        ? {
            kind: attendanceForm.kind,
            clock_in_at: clockInIso,
            clock_out_at: clockOutIso,
            break_minutes: breakMinutes,
          }
        : {
            id: attendanceForm.id || undefined,
            schedule_id: attendanceForm.schedule_id,
            kind: attendanceForm.kind,
            clock_in_at: clockInIso,
            clock_out_at: clockOutIso,
            break_minutes: breakMinutes,
          };
    const signature = JSON.stringify([attendanceForm.id, payload, attendanceForm.reason]);
    if (attempt.current?.signature !== signature)
      attempt.current = { signature, id: crypto.randomUUID() };
    setBusy(true);
    try {
      if (attendanceForm.status === 'confirmed') {
        await api.adjustAttendance(
          attendanceForm.id,
          payload,
          attendanceForm.reason.trim(),
          attempt.current.id,
        );
      } else {
        await api.saveAttendance(payload, attempt.current.id);
      }
      setAttendanceForm(null);
      await afterMutation(
        attendanceForm.status === 'confirmed'
          ? 'Đã điều chỉnh chấm công.'
          : 'Đã lưu chấm công nháp.',
      );
    } catch (cause) {
      setFormError(cause.message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmAttendance(event) {
    event.preventDefault();
    if (busy) return;
    setFormError('');
    if (!attempt.current) attempt.current = { id: crypto.randomUUID() };
    setBusy(true);
    try {
      await api.confirmAttendance(confirmRow.id, attempt.current.id);
      setConfirmRow(null);
      await afterMutation('Đã xác nhận chấm công.');
    } catch (cause) {
      setFormError(cause.message);
    } finally {
      setBusy(false);
    }
  }

  const departmentOptions = (catalogs?.departments || [])
    .filter((row) => row.archived_at == null)
    .map((row) => ({ id: row.id, label: row.name }));
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'giờ thiết bị';

  return (
    <div className="hr-records hr-attendance">
      <div className="hr-records-toolbar">
        <Field label="Tháng">
          <input type="month" value={month} onChange={(event) => changeMonth(event.target.value)} />
        </Field>
        <EmployeePicker
          api={api}
          value={employeeId}
          onChange={changeEmployee}
          label="Lọc nhân viên"
        />
        <Field label="Phòng ban">
          <Select
            placeholder="Tất cả phòng ban"
            value={departmentId || ''}
            items={departmentOptions}
            onChange={(event) => {
              setDepartmentId(event.target.value || null);
              setAttendancePage(1);
            }}
          />
        </Field>
        <Field label="Chấm công">
          <Select
            placeholder="Tất cả trạng thái"
            value={status || ''}
            items={STATUS_FILTERS}
            onChange={(event) => {
              setStatus(event.target.value || null);
              setAttendancePage(1);
            }}
          />
        </Field>
      </div>
      <ErrorMessage error={actionError} />
      <Panel
        title="Lịch làm việc"
        note="Mỗi nhân viên có một ca cho mỗi ngày công. Ca có thể kết thúc vào ngày hôm sau."
        action={
          <button className="button primary" onClick={() => openSchedule()}>
            + Tạo ca làm
          </button>
        }
      >
        <ErrorMessage error={scheduleError} />
        {schedulesLoading ? (
          <p className="hr-records-state">Đang tải ca làm…</p>
        ) : (
          !scheduleError && (
            <>
              <Table
                headers={[
                  'Ngày công',
                  'Nhân viên',
                  'Ca làm',
                  'Thời gian',
                  'Công kế hoạch',
                  'Thao tác',
                ]}
                empty={!schedules.items?.length}
              >
                {(schedules.items || []).map((row) => (
                  <tr key={row.id}>
                    <td>{dateLabel(row.work_date)}</td>
                    <td>
                      <strong>{row.employee_name}</strong>
                      <small>{row.employee_code}</small>
                    </td>
                    <td>
                      {row.shift_name || 'Ca làm'}
                      <small>
                        {row.site_id
                          ? sites.find((site) => site.id === row.site_id)?.name ||
                            'Cửa hàng đã lưu trữ'
                          : 'Ca thủ công'}{' '}
                        · Nghỉ {row.break_minutes}′ · Trễ cho phép {row.late_grace_minutes}′
                      </small>
                    </td>
                    <td>
                      {timeLabel(row.planned_start_at)} → {timeLabel(row.planned_end_at)}
                    </td>
                    <td>{minutesLabel(row.planned_minutes)}</td>
                    <td>
                      <div className="hr-record-actions">
                        <button className="button secondary" onClick={() => openSchedule(row)}>
                          {row.source_kind === 'recurring' ? 'Điều chỉnh ngày' : 'Sửa ca'}
                        </button>
                        <button
                          className="button primary"
                          disabled={openingSchedule === row.id}
                          onClick={() => openFromSchedule(row)}
                        >
                          {openingSchedule === row.id ? 'Đang mở…' : 'Chấm công'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </Table>
              <HrPager
                total={schedules.total}
                page={schedulePage}
                pageSize={PAGE_SIZE}
                onPage={setSchedulePage}
              />
            </>
          )
        )}
      </Panel>
      <Panel
        title="Bảng chấm công"
        note="Giờ thiếu được giữ ở bản nháp; số phút và các dấu hiệu do hệ thống tính khi lưu."
      >
        <ErrorMessage error={attendanceError} />
        {attendanceLoading ? (
          <p className="hr-records-state">Đang tải chấm công…</p>
        ) : (
          !attendanceError && (
            <>
              <Table
                headers={[
                  'Ngày công',
                  'Nhân viên',
                  'Loại',
                  'Giờ vào → ra',
                  'Công & dấu hiệu',
                  'Trạng thái',
                  'Thao tác',
                ]}
                empty={!attendance.items?.length}
              >
                {(attendance.items || []).map((row) => (
                  <tr key={row.id}>
                    <td>
                      {dateLabel(row.work_date)}
                      <small>{row.shift_name || 'Ca làm'}</small>
                    </td>
                    <td>
                      <strong>{row.employee_name}</strong>
                      <small>
                        {row.employee_code} · {row.department_name || 'Chưa có phòng ban'}
                      </small>
                    </td>
                    <td>{KINDS.find((kind) => kind.value === row.kind)?.label || row.kind}</td>
                    <td>
                      {row.kind === 'work'
                        ? `${timeLabel(row.clock_in_at)} → ${timeLabel(row.clock_out_at)}`
                        : '—'}
                    </td>
                    <td>
                      <strong>
                        {row.kind === 'work' ? minutesLabel(row.work_minutes) : '0g00'}
                      </strong>
                      <AttendanceFlags row={row} />
                    </td>
                    <td>
                      <Badge status={row.status === 'confirmed' ? 'posted' : 'draft'}>
                        {row.status === 'confirmed' ? 'Đã xác nhận' : 'Bản nháp'}
                      </Badge>
                    </td>
                    <td>
                      <div className="hr-record-actions">
                        <button className="button secondary" onClick={() => openAttendance(row)}>
                          {row.status === 'confirmed' ? 'Điều chỉnh' : 'Sửa'}
                        </button>
                        {row.status === 'draft' && (
                          <button
                            className="button primary"
                            onClick={() => {
                              attempt.current = null;
                              setFormError('');
                              setConfirmRow(row);
                            }}
                          >
                            Xác nhận
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </Table>
              <HrPager
                total={attendance.total}
                page={attendancePage}
                pageSize={PAGE_SIZE}
                onPage={setAttendancePage}
              />
            </>
          )
        )}
      </Panel>

      {scheduleForm && (
        <Modal
          title={
            scheduleForm.source_kind === 'recurring'
              ? 'Điều chỉnh một ngày của lịch lặp'
              : scheduleForm.id
                ? 'Sửa ca làm'
                : 'Tạo ca làm'
          }
          description={`Nhập giờ theo ${zone}. Ca qua nửa đêm cần chọn ngày kết thúc kế tiếp.`}
          onClose={() => {
            if (!busy) setScheduleForm(null);
          }}
        >
          <form onSubmit={saveSchedule}>
            <fieldset disabled={busy} className="hr-record-fieldset">
              <div className="form-grid">
                <EmployeePicker
                  api={api}
                  value={scheduleForm.employee_id}
                  disabled={scheduleForm.source_kind === 'recurring'}
                  onChange={(value) => setScheduleForm({ ...scheduleForm, employee_id: value })}
                />
                <Field label="Ngày công">
                  <input
                    type="date"
                    required
                    disabled={scheduleForm.source_kind === 'recurring'}
                    value={scheduleForm.work_date}
                    onChange={(event) =>
                      setScheduleForm({ ...scheduleForm, work_date: event.target.value })
                    }
                  />
                </Field>
                <Field label="Bắt đầu ca">
                  <input
                    type="datetime-local"
                    required
                    value={scheduleForm.planned_start_at}
                    onChange={(event) =>
                      setScheduleForm({ ...scheduleForm, planned_start_at: event.target.value })
                    }
                  />
                </Field>
                <Field label="Kết thúc ca">
                  <input
                    type="datetime-local"
                    required
                    value={scheduleForm.planned_end_at}
                    onChange={(event) =>
                      setScheduleForm({ ...scheduleForm, planned_end_at: event.target.value })
                    }
                  />
                </Field>
                <Field label="Nghỉ giữa ca (phút)">
                  <input
                    type="number"
                    min="0"
                    max="600"
                    step="1"
                    required
                    value={scheduleForm.break_minutes}
                    onChange={(event) =>
                      setScheduleForm({ ...scheduleForm, break_minutes: event.target.value })
                    }
                  />
                </Field>
                <Field label="Tên ca">
                  <input
                    maxLength="120"
                    value={scheduleForm.shift_name}
                    onChange={(event) =>
                      setScheduleForm({ ...scheduleForm, shift_name: event.target.value })
                    }
                  />
                </Field>
                <Field label="Cửa hàng chấm công QR">
                  <select
                    disabled={scheduleForm.source_kind === 'recurring'}
                    value={scheduleForm.site_id}
                    onChange={(event) =>
                      setScheduleForm({ ...scheduleForm, site_id: event.target.value })
                    }
                  >
                    <option value="" disabled={Boolean(scheduleForm.site_id && scheduleForm.id)}>
                      Ca thủ công (không dùng QR)
                    </option>
                    {sites
                      .filter((site) => site.is_active || site.id === scheduleForm.site_id)
                      .map((site) => (
                        <option key={site.id} value={site.id}>
                          {site.code} · {site.name}
                        </option>
                      ))}
                  </select>
                </Field>
                {scheduleForm.source_kind === 'recurring' && (
                  <Field label="Lý do điều chỉnh một ngày" span>
                    <textarea
                      required
                      minLength={10}
                      maxLength={4000}
                      value={scheduleForm.reason}
                      onChange={(event) =>
                        setScheduleForm({ ...scheduleForm, reason: event.target.value })
                      }
                      placeholder="Giải thích vì sao ca ngày này khác lịch lặp…"
                    />
                  </Field>
                )}
                <Field label="Trễ cho phép (phút)">
                  <input
                    type="number"
                    min="0"
                    max="120"
                    step="1"
                    required
                    value={scheduleForm.late_grace_minutes}
                    onChange={(event) =>
                      setScheduleForm({ ...scheduleForm, late_grace_minutes: event.target.value })
                    }
                  />
                </Field>
                <Field label="Về sớm cho phép (phút)">
                  <input
                    type="number"
                    min="0"
                    max="120"
                    step="1"
                    required
                    value={scheduleForm.early_grace_minutes}
                    onChange={(event) =>
                      setScheduleForm({ ...scheduleForm, early_grace_minutes: event.target.value })
                    }
                  />
                </Field>
                <div className="span-2">
                  <ErrorMessage error={formError} />
                </div>
                {siteError && (
                  <div className="span-2 hr-record-form-note">
                    Chưa tải được danh sách cửa hàng QR: {siteError}. Ca thủ công vẫn có thể lưu.
                  </div>
                )}
                <div className="span-2 hr-record-form-note">
                  Ca dùng QR cần nhân viên được phân công tại cửa hàng trong ngày công.{' '}
                  <a href="#/hr/qr">Cấu hình cửa hàng và phân công</a>.
                </div>
              </div>
            </fieldset>
            <footer className="modal-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setScheduleForm(null)}
              >
                Hủy
              </button>
              <button className="button primary" disabled={busy || !scheduleForm.employee_id}>
                {busy ? 'Đang lưu…' : 'Lưu ca làm'}
              </button>
            </footer>
          </form>
        </Modal>
      )}

      {attendanceForm && (
        <Modal
          title={
            attendanceForm.status === 'confirmed'
              ? 'Điều chỉnh chấm công đã xác nhận'
              : 'Ghi nhận chấm công'
          }
          description={`${attendanceForm.employee_name} · ${dateLabel(attendanceForm.work_date)}. Giờ nhập theo ${zone}.`}
          onClose={() => {
            if (!busy) setAttendanceForm(null);
          }}
        >
          <form onSubmit={saveAttendance}>
            <fieldset disabled={busy} className="hr-record-fieldset">
              <div className="form-grid">
                <Field label="Loại chấm công">
                  <Select
                    placeholder="Chọn loại"
                    required
                    items={KINDS}
                    value={attendanceForm.kind}
                    onChange={(event) =>
                      setAttendanceForm({
                        ...attendanceForm,
                        kind: event.target.value,
                        ...(event.target.value === 'work'
                          ? {}
                          : { clock_in_at: '', clock_out_at: '', break_minutes: 0 }),
                      })
                    }
                  />
                </Field>
                <div className="hr-record-form-note">
                  Nghỉ phép chỉ được ghi khi đơn cùng ngày đã duyệt.
                </div>
                {attendanceForm.kind === 'work' && (
                  <>
                    <Field label="Giờ vào">
                      <input
                        type="datetime-local"
                        required={attendanceForm.status === 'confirmed'}
                        value={attendanceForm.clock_in_at}
                        onChange={(event) =>
                          setAttendanceForm({ ...attendanceForm, clock_in_at: event.target.value })
                        }
                      />
                    </Field>
                    <Field label="Giờ ra">
                      <input
                        type="datetime-local"
                        required={attendanceForm.status === 'confirmed'}
                        value={attendanceForm.clock_out_at}
                        onChange={(event) =>
                          setAttendanceForm({ ...attendanceForm, clock_out_at: event.target.value })
                        }
                      />
                    </Field>
                    <Field label="Nghỉ giữa ca (phút)">
                      <input
                        type="number"
                        min="0"
                        max="600"
                        step="1"
                        required
                        value={attendanceForm.break_minutes}
                        onChange={(event) =>
                          setAttendanceForm({
                            ...attendanceForm,
                            break_minutes: event.target.value,
                          })
                        }
                      />
                    </Field>
                    <div className="hr-record-form-note">
                      Có thể lưu nháp khi thiếu giờ vào hoặc giờ ra. Xác nhận cần đủ cả hai.
                    </div>
                  </>
                )}
                {attendanceForm.status === 'confirmed' && (
                  <Field label="Lý do điều chỉnh" span>
                    <textarea
                      required
                      minLength="10"
                      maxLength="4000"
                      rows="3"
                      value={attendanceForm.reason}
                      onChange={(event) =>
                        setAttendanceForm({ ...attendanceForm, reason: event.target.value })
                      }
                    />
                  </Field>
                )}
                <div className="span-2">
                  <ErrorMessage error={formError} />
                </div>
              </div>
            </fieldset>
            <footer className="modal-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setAttendanceForm(null)}
              >
                Hủy
              </button>
              <button className="button primary" disabled={busy}>
                {busy
                  ? 'Đang lưu…'
                  : attendanceForm.status === 'confirmed'
                    ? 'Lưu điều chỉnh'
                    : 'Lưu bản nháp'}
              </button>
            </footer>
          </form>
        </Modal>
      )}

      {confirmRow && (
        <Modal
          title="Xác nhận chấm công"
          description={`${confirmRow.employee_name} · ${dateLabel(confirmRow.work_date)}`}
          onClose={() => {
            if (!busy) setConfirmRow(null);
          }}
        >
          <form onSubmit={confirmAttendance}>
            <div className="confirm-body">
              <p>Sau khi xác nhận, mọi thay đổi cần ghi rõ lý do điều chỉnh.</p>
              {confirmRow.kind === 'work' &&
                (!confirmRow.clock_in_at || !confirmRow.clock_out_at) && (
                  <p className="hr-record-form-note">
                    Bản nháp này thiếu giờ vào hoặc giờ ra. Hãy sửa trước khi xác nhận.
                  </p>
                )}
              <ErrorMessage error={formError} />
            </div>
            <footer className="modal-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setConfirmRow(null)}
              >
                Hủy
              </button>
              <button
                className="button primary"
                disabled={
                  busy ||
                  (confirmRow.kind === 'work' &&
                    (!confirmRow.clock_in_at || !confirmRow.clock_out_at))
                }
              >
                {busy ? 'Đang xác nhận…' : 'Xác nhận'}
              </button>
            </footer>
          </form>
        </Modal>
      )}
    </div>
  );
}
