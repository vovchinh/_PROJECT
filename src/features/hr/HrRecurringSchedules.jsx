import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, Clock3, Layers3, RefreshCw, Users } from 'lucide-react';
import { Empty, ErrorMessage, Field, Modal, Panel, SearchBox, Table } from '../../components.jsx';
import { HrPager, isoToday } from './HrShared.jsx';
import './hr-recurring.css';

const PAGE_SIZE = 25;
const PREVIEW_PAGE_SIZE = 30;
const WEEKDAYS = [
  ['T2', 'Thứ Hai', 1],
  ['T3', 'Thứ Ba', 2],
  ['T4', 'Thứ Tư', 4],
  ['T5', 'Thứ Năm', 8],
  ['T6', 'Thứ Sáu', 16],
  ['T7', 'Thứ Bảy', 32],
  ['CN', 'Chủ Nhật', 64],
];
const EMPLOYEE_TYPES = [
  ['full_time', 'Toàn thời gian'],
  ['part_time', 'Bán thời gian'],
  ['contractor', 'Cộng tác viên'],
  ['seasonal', 'Thời vụ'],
];
const PREVIEW_STATUS = {
  CREATE: 'Tạo ca',
  OFF: 'Ngày nghỉ',
  KEEP_MANUAL: 'Giữ ca thủ công',
  KEEP_GENERATED: 'Ca đã đồng bộ',
  CONFLICT: 'Xung đột',
};
const emptyTemplate = () => ({
  code: '',
  name: '',
  start_time: '08:00',
  end_time: '17:00',
  end_day_offset: 0,
  break_minutes: '',
  late_grace_minutes: 0,
  early_grace_minutes: 0,
  is_active: true,
});
const emptyRule = () => ({
  name: '',
  template_id: '',
  weekday_mask: 63,
  effective_from: isoToday(),
  effective_until: '',
  is_active: true,
});
const templateFormFrom = (row) => ({
  id: row.id,
  code: row.code,
  name: row.name,
  start_time: String(row.start_time).slice(0, 5),
  end_time: String(row.end_time).slice(0, 5),
  end_day_offset: row.end_day_offset,
  break_minutes: row.break_minutes,
  late_grace_minutes: row.late_grace_minutes,
  early_grace_minutes: row.early_grace_minutes,
  is_active: row.is_active,
});
const ruleFormFrom = (row) => ({
  id: row.id,
  name: row.name,
  template_id: row.template_id,
  template_name: row.template_name,
  weekday_mask: row.weekday_mask,
  effective_from: row.effective_from,
  effective_until: row.effective_until || '',
  is_active: row.is_active,
});
const addDays = (day, count) => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
};
const timeVn = (value) =>
  value
    ? new Date(value).toLocaleTimeString('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';
const weekdayLabel = (mask) =>
  WEEKDAYS.filter(([, , bit]) => Number(mask) & bit)
    .map(([short]) => short)
    .join(', ');

export default function HrRecurringSchedules({ api, catalogs, onChanged, onNavigate }) {
  const [view, setView] = useState('assign');
  const [revision, setRevision] = useState(0);
  const [sites, setSites] = useState([]);
  const [sitesError, setSitesError] = useState('');
  const [templates, setTemplates] = useState({ items: [], total: 0 });
  const [templatePage, setTemplatePage] = useState(1);
  const [rules, setRules] = useState({ items: [], total: 0 });
  const [rulePage, setRulePage] = useState(1);
  const [assignments, setAssignments] = useState({ items: [], total: 0 });
  const [assignmentPage, setAssignmentPage] = useState(1);
  const [listError, setListError] = useState('');
  const [loading, setLoading] = useState(true);
  const [formError, setFormError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [templateForm, setTemplateForm] = useState(null);
  const [ruleForm, setRuleForm] = useState(null);
  const [selectedRule, setSelectedRule] = useState(null);
  const [siteId, setSiteId] = useState('');
  const [validFrom, setValidFrom] = useState(isoToday());
  const [validTo, setValidTo] = useState('');
  const [query, setQuery] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [employeeType, setEmployeeType] = useState('');
  const [employeePage, setEmployeePage] = useState(1);
  const [employees, setEmployees] = useState({ items: [], total: 0 });
  const [employeeError, setEmployeeError] = useState('');
  const [employeesLoading, setEmployeesLoading] = useState(false);
  const [selectedEmployees, setSelectedEmployees] = useState({});
  const [preview, setPreview] = useState(null);
  const [previewPage, setPreviewPage] = useState(1);
  const [assignRequest, setAssignRequest] = useState(null);
  const [closeRow, setCloseRow] = useState(null);
  const [closeDate, setCloseDate] = useState(isoToday());
  const [closeReason, setCloseReason] = useState('');
  const [closeRequest, setCloseRequest] = useState(null);
  const [syncFrom, setSyncFrom] = useState(isoToday());
  const [syncTo, setSyncTo] = useState(addDays(isoToday(), 29));
  const [syncRequest, setSyncRequest] = useState(null);

  useEffect(() => {
    let active = true;
    api
      .listQrSetup()
      .then((result) => {
        if (active) {
          setSites(result?.sites || []);
          setSitesError('');
        }
      })
      .catch((cause) => {
        if (active) setSitesError(cause.message);
      });
    return () => {
      active = false;
    };
  }, [api, revision]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([
      api.listRecurringSetup({ kind: 'templates', page: templatePage, pageSize: PAGE_SIZE }),
      api.listRecurringSetup({ kind: 'rules', page: rulePage, pageSize: PAGE_SIZE }),
      api.listRecurringSetup({ kind: 'assignments', page: assignmentPage, pageSize: PAGE_SIZE }),
    ])
      .then(([templateResult, ruleResult, assignmentResult]) => {
        if (!active) return;
        setTemplates(templateResult || { items: [], total: 0 });
        setRules(ruleResult || { items: [], total: 0 });
        setAssignments(assignmentResult || { items: [], total: 0 });
        setListError('');
      })
      .catch((cause) => {
        if (active) setListError(cause.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, revision, templatePage, rulePage, assignmentPage]);

  useEffect(() => {
    if (view !== 'assign' || !siteId) return undefined;
    let active = true;
    const timer = window.setTimeout(() => {
      setEmployeesLoading(true);
      api
        .listScheduleEmployees({
          query: query.trim(),
          departmentId: departmentId || null,
          employeeType: employeeType || null,
          siteId,
          effectiveDate: validFrom,
          page: employeePage,
          pageSize: PAGE_SIZE,
        })
        .then((result) => {
          if (active) {
            setEmployees(result || { items: [], total: 0 });
            setEmployeeError('');
          }
        })
        .catch((cause) => {
          if (active) setEmployeeError(cause.message);
        })
        .finally(() => {
          if (active) setEmployeesLoading(false);
        });
    }, 200);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [api, view, siteId, validFrom, query, departmentId, employeeType, employeePage, revision]);

  const employeeIds = useMemo(() => Object.keys(selectedEmployees).sort(), [selectedEmployees]);
  const assignmentPayload = useMemo(
    () => ({
      rule_id: selectedRule?.id || '',
      site_id: siteId,
      employee_ids: employeeIds,
      valid_from: validFrom,
      valid_to: validTo || null,
    }),
    [selectedRule?.id, siteId, employeeIds, validFrom, validTo],
  );
  const assignmentSignature = JSON.stringify(assignmentPayload);
  const currentPreview = preview?.signature === assignmentSignature ? preview.result : null;
  const visiblePreview = (currentPreview?.items || []).slice(
    (previewPage - 1) * PREVIEW_PAGE_SIZE,
    previewPage * PREVIEW_PAGE_SIZE,
  );
  const activeSites = sites.filter((site) => site.is_active);
  const canPreview =
    selectedRule?.is_active &&
    siteId &&
    employeeIds.length > 0 &&
    employeeIds.length <= 200 &&
    validFrom &&
    validFrom >= isoToday() &&
    validFrom >= selectedRule.effective_from &&
    (!selectedRule.effective_until || (validTo && validTo <= selectedRule.effective_until)) &&
    (!validTo || validTo >= validFrom);

  function refresh(message) {
    setRevision((value) => value + 1);
    if (message) {
      setNotice(message);
      onChanged?.(message);
    }
  }

  function updateSelected(rows, checked) {
    setSelectedEmployees((previous) => {
      const next = { ...previous };
      rows.forEach((row) => {
        if (checked && Object.keys(next).length < 200) next[row.id] = row;
        if (!checked) delete next[row.id];
      });
      return next;
    });
    setAssignRequest(null);
  }

  function chooseRule(row) {
    setSelectedRule(row);
    setPreview(null);
    if (row) {
      const start = row.effective_from > isoToday() ? row.effective_from : isoToday();
      if (validFrom < start) setValidFrom(start);
      if (row.effective_until && (!validTo || validTo > row.effective_until))
        setValidTo(row.effective_until);
    }
    setAssignRequest(null);
  }

  async function saveTemplate(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFormError('');
    try {
      if (templateForm.break_minutes === '' || Number(templateForm.break_minutes) < 0)
        throw new Error('Nhập số phút nghỉ rõ ràng; 0 chỉ dùng nếu ca thực sự không nghỉ.');
      const saved = await api.saveShiftTemplate({
        ...(templateForm.id ? { id: templateForm.id } : {}),
        code: templateForm.code,
        name: templateForm.name,
        start_time: templateForm.start_time,
        end_time: templateForm.end_time,
        end_day_offset: Number(templateForm.end_day_offset),
        break_minutes: Number(templateForm.break_minutes),
        late_grace_minutes: Number(templateForm.late_grace_minutes),
        early_grace_minutes: Number(templateForm.early_grace_minutes),
        is_active: templateForm.is_active,
      });
      setTemplateForm(null);
      refresh(`Đã lưu mẫu ca ${saved?.name || ''}.`);
    } catch (cause) {
      setFormError(cause.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveRule(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFormError('');
    try {
      if (!ruleForm.weekday_mask) throw new Error('Chọn ít nhất một ngày làm việc.');
      const saved = await api.saveWeeklyScheduleRule({
        ...(ruleForm.id ? { id: ruleForm.id } : {}),
        name: ruleForm.name,
        template_id: ruleForm.template_id,
        weekday_mask: Number(ruleForm.weekday_mask),
        effective_from: ruleForm.effective_from,
        effective_until: ruleForm.effective_until || null,
        is_active: ruleForm.is_active,
      });
      setRuleForm(null);
      chooseRule(saved);
      setView('assign');
      refresh(`Đã lưu quy tắc ${saved?.name || ''}.`);
    } catch (cause) {
      setFormError(cause.message);
    } finally {
      setBusy(false);
    }
  }

  async function runPreview() {
    if (!canPreview || busy) return;
    setBusy(true);
    setFormError('');
    setPreview(null);
    try {
      const result = await api.previewRecurringSchedule({
        ...assignmentPayload,
        preview_from: validFrom,
        preview_to: addDays(validFrom, 6),
      });
      setPreview({ signature: assignmentSignature, result });
      setPreviewPage(1);
      setAssignRequest(null);
    } catch (cause) {
      setFormError(cause.message);
    } finally {
      setBusy(false);
    }
  }

  async function assign(event) {
    event.preventDefault();
    if (busy || !currentPreview || Number(currentPreview.summary?.conflict || 0) > 0) return;
    setBusy(true);
    setFormError('');
    const request =
      assignRequest?.signature === assignmentSignature
        ? assignRequest
        : { signature: assignmentSignature, id: crypto.randomUUID() };
    setAssignRequest(request);
    try {
      const result = await api.assignRecurringSchedule(assignmentPayload, request.id);
      setSelectedEmployees({});
      setPreview(null);
      setAssignRequest(null);
      setAssignmentPage(1);
      refresh(
        `Đã phân ca cho ${result?.created_count ?? employeeIds.length} nhân viên và đồng bộ ca ban đầu.`,
      );
      setView('assignments');
    } catch (cause) {
      setFormError(cause.message);
    } finally {
      setBusy(false);
    }
  }

  async function closeAssignment(event) {
    event.preventDefault();
    if (busy || !closeRow) return;
    setBusy(true);
    setFormError('');
    const key = `${closeRow.id}|${closeDate}|${closeReason}`;
    const request = closeRequest?.key === key ? closeRequest : { key, id: crypto.randomUUID() };
    setCloseRequest(request);
    try {
      await api.closeRecurringAssignment(closeRow.id, closeDate, closeReason.trim(), request.id);
      setCloseRow(null);
      setCloseRequest(null);
      setCloseReason('');
      refresh('Đã kết thúc phân công. Các ca đã chấm công và kỳ lương đã khóa được giữ nguyên.');
    } catch (cause) {
      setFormError(cause.message);
    } finally {
      setBusy(false);
    }
  }

  async function synchronize(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFormError('');
    const key = `${syncFrom}|${syncTo}`;
    const request = syncRequest?.key === key ? syncRequest : { key, id: crypto.randomUUID() };
    setSyncRequest(request);
    try {
      const result = await api.materializeRecurringSchedules(syncFrom, syncTo, request.id);
      setSyncRequest(null);
      refresh(`Đã đồng bộ ${result?.created ?? 0} ca; giữ ${result?.kept ?? 0} ca đã có.`);
    } catch (cause) {
      setFormError(cause.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="hr-recurring">
      <div className="hr-recurring-intro">
        <div>
          <h2>Ca làm việc lặp</h2>
          <p>
            Gán lịch tuần một lần cho nhiều nhân viên. Ca ngày được tạo trong khoảng hữu hạn để chấm
            công QR và tính lương.
          </p>
        </div>
        <span>Giờ Việt Nam · Asia/Ho_Chi_Minh</span>
      </div>
      <div className="hr-recurring-tabs" role="tablist" aria-label="Quản lý ca làm việc lặp">
        {[
          ['assign', 'Phân ca', Users],
          ['rules', 'Lịch tuần', CalendarDays],
          ['templates', 'Mẫu ca', Clock3],
          ['assignments', 'Đã phân công', Layers3],
        ].map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={view === id}
            className={view === id ? 'active' : ''}
            onClick={() => {
              setView(id);
              setFormError('');
            }}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </div>
      {notice && (
        <div className="hr-notice" role="status">
          {notice}
          <button type="button" aria-label="Đóng thông báo" onClick={() => setNotice('')}>
            ×
          </button>
        </div>
      )}
      <ErrorMessage error={listError || sitesError} />
      <ErrorMessage error={formError} />

      {view === 'templates' && (
        <Panel
          title="Mẫu ca"
          note="Phút nghỉ phải được nhập rõ, kể cả khi bằng 0. Sửa mẫu ca không được thay lịch sử đã chấm công."
          action={
            <button
              type="button"
              className="button primary"
              onClick={() => {
                setTemplateForm(emptyTemplate());
                setFormError('');
              }}
            >
              + Tạo mẫu ca
            </button>
          }
        >
          {loading ? (
            <p className="hr-muted">Đang tải mẫu ca…</p>
          ) : (
            <Table
              headers={['Mã', 'Tên ca', 'Giờ làm', 'Nghỉ', 'Trạng thái', 'Thao tác']}
              empty={!templates.items?.length}
            >
              {(templates.items || []).map((row) => (
                <tr key={row.id}>
                  <td className="mono">{row.code}</td>
                  <td>
                    <strong>{row.name}</strong>
                  </td>
                  <td>
                    {String(row.start_time).slice(0, 5)}–{String(row.end_time).slice(0, 5)}
                    {row.end_day_offset ? ' (+1 ngày)' : ''}
                  </td>
                  <td>{row.break_minutes} phút</td>
                  <td>{row.is_active ? 'Đang dùng' : 'Đã lưu trữ'}</td>
                  <td>
                    <div className="hr-record-actions">
                      {!row.is_used && (
                        <button
                          type="button"
                          className="button secondary"
                          onClick={() => {
                            setTemplateForm(templateFormFrom(row));
                            setFormError('');
                          }}
                        >
                          Sửa
                        </button>
                      )}
                      {row.is_used && <span className="hr-muted">Đã dùng · nhân bản để sửa</span>}
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() => {
                          setTemplateForm({
                            ...templateFormFrom(row),
                            id: undefined,
                            code: '',
                            name: `${row.name} (mới)`,
                          });
                          setFormError('');
                        }}
                      >
                        Nhân bản
                      </button>
                      {row.is_active && (
                        <button
                          type="button"
                          className="button primary"
                          onClick={() => {
                            setRuleForm({ ...emptyRule(), template_id: row.id });
                            setView('rules');
                            setFormError('');
                          }}
                        >
                          Tạo lịch
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </Table>
          )}
          <HrPager
            total={templates.total}
            page={templatePage}
            pageSize={PAGE_SIZE}
            onPage={setTemplatePage}
          />
        </Panel>
      )}

      {view === 'rules' && (
        <Panel
          title="Lịch tuần"
          note="Ngày không chọn là ngày nghỉ của quy tắc; nhân viên chưa được phân công không bị tự đánh vắng."
          action={
            <button
              type="button"
              className="button primary"
              onClick={() => {
                setRuleForm(emptyRule());
                setFormError('');
              }}
            >
              + Tạo lịch tuần
            </button>
          }
        >
          {loading ? (
            <p className="hr-muted">Đang tải lịch tuần…</p>
          ) : (
            <Table
              headers={['Tên lịch', 'Mẫu ca', 'Ngày làm', 'Hiệu lực', 'Trạng thái', 'Thao tác']}
              empty={!rules.items?.length}
            >
              {(rules.items || []).map((row) => (
                <tr key={row.id}>
                  <td>
                    <strong>{row.name}</strong>
                  </td>
                  <td>{row.template_name || row.template_code || '—'}</td>
                  <td>{weekdayLabel(row.weekday_mask)}</td>
                  <td>
                    {row.effective_from} → {row.effective_until || 'không thời hạn'}
                  </td>
                  <td>{row.is_active ? 'Đang dùng' : 'Đã lưu trữ'}</td>
                  <td>
                    <div className="hr-record-actions">
                      {row.is_active && (
                        <button
                          type="button"
                          className="button primary"
                          onClick={() => {
                            chooseRule(row);
                            setView('assign');
                          }}
                        >
                          Phân ca
                        </button>
                      )}
                      {!row.is_used && (
                        <button
                          type="button"
                          className="button secondary"
                          onClick={() => {
                            setRuleForm(ruleFormFrom(row));
                            setFormError('');
                          }}
                        >
                          Sửa
                        </button>
                      )}
                      {row.is_used && <span className="hr-muted">Đã gán · nhân bản để sửa</span>}
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() => {
                          setRuleForm({
                            ...ruleFormFrom(row),
                            id: undefined,
                            name: `${row.name} (mới)`,
                          });
                          setFormError('');
                        }}
                      >
                        Nhân bản
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </Table>
          )}
          <HrPager total={rules.total} page={rulePage} pageSize={PAGE_SIZE} onPage={setRulePage} />
        </Panel>
      )}

      {view === 'assign' && (
        <div className="hr-recurring-assign">
          <Panel
            title="1. Chọn lịch và cửa hàng"
            note="Chỉ nhân viên được phân công tại cửa hàng hợp lệ mới xuất hiện để chọn."
          >
            <div className="form-grid">
              <Field label="Lịch tuần đã tạo">
                <select
                  required
                  value={selectedRule?.id || ''}
                  onChange={(event) =>
                    chooseRule(
                      (rules.items || []).find((row) => row.id === event.target.value) || null,
                    )
                  }
                >
                  <option value="">Chọn lịch tuần</option>
                  {selectedRule &&
                    !(rules.items || []).some((row) => row.id === selectedRule.id) && (
                      <option value={selectedRule.id}>{selectedRule.name}</option>
                    )}
                  {(rules.items || [])
                    .filter((row) => row.is_active)
                    .map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.name} · {weekdayLabel(row.weekday_mask)}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Cửa hàng chấm công">
                <select
                  required
                  value={siteId}
                  onChange={(event) => {
                    setSiteId(event.target.value);
                    setEmployeePage(1);
                    setSelectedEmployees({});
                    setAssignRequest(null);
                  }}
                >
                  <option value="">Chọn cửa hàng</option>
                  {activeSites.map((site) => (
                    <option key={site.id} value={site.id}>
                      {site.code} · {site.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Bắt đầu phân công">
                <input
                  type="date"
                  required
                  min={
                    selectedRule?.effective_from > isoToday()
                      ? selectedRule.effective_from
                      : isoToday()
                  }
                  value={validFrom}
                  onChange={(event) => {
                    setValidFrom(event.target.value);
                    setAssignRequest(null);
                  }}
                />
              </Field>
              <Field label="Đến hết ngày (tùy chọn)">
                <input
                  type="date"
                  min={validFrom}
                  value={validTo}
                  onChange={(event) => {
                    setValidTo(event.target.value);
                    setAssignRequest(null);
                  }}
                />
              </Field>
            </div>
            {!activeSites.length && (
              <div className="hr-recurring-help">
                <p>
                  Chưa có cửa hàng chấm công hoạt động. Tạo cửa hàng và gán nhân viên trước khi phân
                  ca.
                </p>
                <button type="button" className="button secondary" onClick={() => onNavigate('qr')}>
                  Mở Cửa hàng & QR
                </button>
              </div>
            )}
            <p className="hr-muted">
              Quy tắc lưu lâu dài; lần xác nhận đầu sẽ tạo ca ngày cho 45 ngày tới trong cùng giao
              dịch.
            </p>
          </Panel>
          <Panel
            title="2. Chọn nhân viên"
            note="Chọn chính xác từng người hoặc từng trang; bộ lọc không tự động gán cả phòng ban."
          >
            <div className="hr-recurring-filters">
              <SearchBox
                value={query}
                onChange={(value) => {
                  setQuery(value);
                  setEmployeePage(1);
                }}
                placeholder="Tìm mã hoặc tên nhân viên…"
              />
              <select
                aria-label="Lọc phòng ban"
                value={departmentId}
                onChange={(event) => {
                  setDepartmentId(event.target.value);
                  setEmployeePage(1);
                }}
              >
                <option value="">Mọi phòng ban</option>
                {(catalogs?.departments || [])
                  .filter((row) => row.is_active)
                  .map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name}
                    </option>
                  ))}
              </select>
              <select
                aria-label="Lọc loại nhân viên"
                value={employeeType}
                onChange={(event) => {
                  setEmployeeType(event.target.value);
                  setEmployeePage(1);
                }}
              >
                <option value="">Mọi loại nhân viên</option>
                {EMPLOYEE_TYPES.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="hr-recurring-select-bar">
              <strong>Đã chọn {employeeIds.length}/200 nhân viên</strong>
              <div>
                <button
                  type="button"
                  className="button secondary"
                  disabled={!siteId || !employees.items?.length || employeeIds.length >= 200}
                  onClick={() => updateSelected(employees.items, true)}
                >
                  Chọn trang này
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={!siteId || !employees.items?.length}
                  onClick={() => updateSelected(employees.items, false)}
                >
                  Bỏ chọn trang này
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={!employeeIds.length}
                  onClick={() => {
                    setSelectedEmployees({});
                    setAssignRequest(null);
                  }}
                >
                  Bỏ chọn tất cả
                </button>
              </div>
            </div>
            {!siteId ? (
              <Empty title="Chọn cửa hàng trước">
                Danh sách chỉ gồm nhân viên được gán tại cửa hàng đó.
              </Empty>
            ) : (
              <>
                <ErrorMessage error={employeeError} />
                {employeesLoading ? (
                  <p className="hr-muted">Đang tìm nhân viên…</p>
                ) : (
                  <div className="hr-recurring-employee-list">
                    {(employees.items || []).length ? (
                      employees.items.map((row) => (
                        <label key={row.id} className="hr-recurring-employee">
                          <input
                            type="checkbox"
                            checked={Boolean(selectedEmployees[row.id])}
                            disabled={!selectedEmployees[row.id] && employeeIds.length >= 200}
                            onChange={(event) => updateSelected([row], event.target.checked)}
                          />
                          <span>
                            <strong>
                              {row.code} · {row.full_name}
                            </strong>
                            <small>
                              {row.department_name || 'Chưa có phòng ban'} ·{' '}
                              {EMPLOYEE_TYPES.find(([id]) => id === row.employee_type)?.[1] ||
                                row.employee_type}
                            </small>
                          </span>
                        </label>
                      ))
                    ) : (
                      <Empty title="Không có nhân viên phù hợp">
                        Kiểm tra cửa hàng, loại nhân viên hoặc từ khóa lọc.
                      </Empty>
                    )}
                  </div>
                )}
                <HrPager
                  total={employees.total}
                  page={employeePage}
                  pageSize={PAGE_SIZE}
                  onPage={setEmployeePage}
                />
              </>
            )}
            {employeeIds.length > 0 && (
              <details className="hr-recurring-selected">
                <summary>Xem {employeeIds.length} nhân viên đã chọn</summary>
                <div>
                  {employeeIds.map((id) => (
                    <button
                      key={id}
                      type="button"
                      className="hr-recurring-chip"
                      aria-label={`Bỏ chọn ${selectedEmployees[id].full_name}`}
                      onClick={() => updateSelected([selectedEmployees[id]], false)}
                    >
                      {selectedEmployees[id].code} · {selectedEmployees[id].full_name} ×
                    </button>
                  ))}
                </div>
              </details>
            )}
          </Panel>
          <Panel
            title="3. Xem trước và xác nhận"
            note="Kiểm tra bảy ngày đầu. Server sẽ kiểm tra lại toàn bộ hiệu lực và đồng bộ 45 ngày đầu khi xác nhận."
          >
            <div className="hr-recurring-confirm-actions">
              <button
                type="button"
                className="button secondary"
                disabled={!canPreview || busy}
                onClick={runPreview}
              >
                {busy ? 'Đang xử lý…' : 'Xem trước 7 ngày'}
              </button>
              <button
                type="button"
                className="button primary"
                disabled={
                  !currentPreview || Number(currentPreview.summary?.conflict || 0) > 0 || busy
                }
                onClick={assign}
              >
                Xác nhận phân ca cho {employeeIds.length} nhân viên
              </button>
            </div>
            {currentPreview && (
              <>
                <div className="hr-recurring-summary">
                  <span>
                    <strong>{currentPreview.summary?.create ?? 0}</strong> ca sẽ tạo
                  </span>
                  <span>
                    <strong>{currentPreview.summary?.off ?? 0}</strong> ngày nghỉ
                  </span>
                  <span>
                    <strong>
                      {(currentPreview.summary?.keep_manual ?? 0) +
                        (currentPreview.summary?.keep_generated ?? 0)}
                    </strong>{' '}
                    ca giữ nguyên
                  </span>
                  <span className={currentPreview.summary?.conflict ? 'danger' : ''}>
                    <strong>{currentPreview.summary?.conflict ?? 0}</strong> xung đột
                  </span>
                </div>
                {currentPreview.summary?.conflict > 0 && (
                  <p className="hr-recurring-warning" role="alert">
                    Có xung đột. Sửa phân công, cửa hàng hoặc ngày hiệu lực trước khi xác nhận.
                  </p>
                )}
                <Table
                  headers={['Nhân viên', 'Ngày', 'Dự kiến', 'Trạng thái', 'Lý do']}
                  empty={!currentPreview.items?.length}
                >
                  {visiblePreview.map((row, index) => (
                    <tr key={`${row.employee_id}-${row.work_date}-${index}`}>
                      <td>{selectedEmployees[row.employee_id]?.code || row.employee_id}</td>
                      <td>{row.work_date}</td>
                      <td>
                        {row.planned_start_at
                          ? `${timeVn(row.planned_start_at)}–${timeVn(row.planned_end_at)} · nghỉ ${row.break_minutes} phút`
                          : '—'}
                      </td>
                      <td>
                        <span
                          className={`hr-recurring-state ${String(row.status || '').toLowerCase()}`}
                        >
                          {PREVIEW_STATUS[row.status] || row.status}
                        </span>
                      </td>
                      <td>{row.reason || '—'}</td>
                    </tr>
                  ))}
                </Table>
                <HrPager
                  total={currentPreview.items?.length || 0}
                  page={previewPage}
                  pageSize={PREVIEW_PAGE_SIZE}
                  onPage={setPreviewPage}
                />
              </>
            )}
          </Panel>
        </div>
      )}

      {view === 'assignments' && (
        <div className="hr-recurring-assignments">
          <Panel
            title="Phân công đã lưu"
            note="Kết thúc phân công không xóa ca có chấm công hoặc kỳ lương đã khóa."
          >
            {loading ? (
              <p className="hr-muted">Đang tải phân công…</p>
            ) : (
              <Table
                headers={['Nhân viên', 'Lịch tuần', 'Cửa hàng', 'Hiệu lực', 'Thao tác']}
                empty={!assignments.items?.length}
              >
                {(assignments.items || []).map((row) => (
                  <tr key={row.id}>
                    <td>
                      <strong>
                        {row.employee_code} · {row.employee_name}
                      </strong>
                    </td>
                    <td>{row.rule_name || '—'}</td>
                    <td>{row.site_name || '—'}</td>
                    <td>
                      {row.valid_from} → {row.valid_to || 'không thời hạn'}
                    </td>
                    <td>
                      {!row.valid_to || row.valid_to >= isoToday() ? (
                        <button
                          type="button"
                          className="button secondary"
                          onClick={() => {
                            setCloseRow(row);
                            setCloseDate(row.valid_from > isoToday() ? row.valid_from : isoToday());
                            setCloseReason('');
                            setFormError('');
                          }}
                        >
                          Kết thúc
                        </button>
                      ) : (
                        'Đã kết thúc'
                      )}
                    </td>
                  </tr>
                ))}
              </Table>
            )}
            <HrPager
              total={assignments.total}
              page={assignmentPage}
              pageSize={PAGE_SIZE}
              onPage={setAssignmentPage}
            />
          </Panel>
          <Panel
            title="Đồng bộ ca ngày"
            note="Dùng khi cần tạo ca cho kỳ tới. Khoảng ngày tối đa 60 ngày; ca đã có công hoặc kỳ lương khóa sẽ không bị ghi đè."
          >
            <form className="hr-recurring-sync" onSubmit={synchronize}>
              <Field label="Từ ngày">
                <input
                  type="date"
                  required
                  value={syncFrom}
                  onChange={(event) => setSyncFrom(event.target.value)}
                />
              </Field>
              <Field label="Đến hết ngày">
                <input
                  type="date"
                  required
                  min={syncFrom}
                  max={addDays(syncFrom, 59)}
                  value={syncTo}
                  onChange={(event) => setSyncTo(event.target.value)}
                />
              </Field>
              <button
                className="button primary"
                disabled={
                  busy ||
                  !syncFrom ||
                  !syncTo ||
                  syncTo < syncFrom ||
                  syncTo > addDays(syncFrom, 59)
                }
              >
                <RefreshCw size={16} /> {busy ? 'Đang đồng bộ…' : 'Đồng bộ ca'}
              </button>
            </form>
          </Panel>
        </div>
      )}

      {templateForm && (
        <Modal
          title={templateForm.id ? 'Sửa mẫu ca' : 'Tạo mẫu ca'}
          onClose={() => {
            if (!busy) setTemplateForm(null);
          }}
        >
          <form onSubmit={saveTemplate} className="hr-recurring-modal">
            <div className="form-grid">
              <Field label="Mã mẫu ca">
                <input
                  required
                  maxLength={80}
                  value={templateForm.code}
                  disabled={Boolean(templateForm.id)}
                  onChange={(event) =>
                    setTemplateForm({ ...templateForm, code: event.target.value })
                  }
                />
              </Field>
              <Field label="Tên ca">
                <input
                  required
                  maxLength={120}
                  value={templateForm.name}
                  onChange={(event) =>
                    setTemplateForm({ ...templateForm, name: event.target.value })
                  }
                />
              </Field>
              <Field label="Bắt đầu">
                <input
                  type="time"
                  required
                  value={String(templateForm.start_time).slice(0, 5)}
                  onChange={(event) =>
                    setTemplateForm({ ...templateForm, start_time: event.target.value })
                  }
                />
              </Field>
              <Field label="Kết thúc">
                <input
                  type="time"
                  required
                  value={String(templateForm.end_time).slice(0, 5)}
                  onChange={(event) =>
                    setTemplateForm({ ...templateForm, end_time: event.target.value })
                  }
                />
              </Field>
              <Field label="Ngày kết thúc">
                <select
                  value={templateForm.end_day_offset}
                  onChange={(event) =>
                    setTemplateForm({ ...templateForm, end_day_offset: event.target.value })
                  }
                >
                  <option value={0}>Cùng ngày</option>
                  <option value={1}>Ngày hôm sau (qua đêm)</option>
                </select>
              </Field>
              <Field
                label="Phút nghỉ không tính công"
                hint="Bắt buộc nhập rõ; 0 nếu không có giờ nghỉ."
              >
                <input
                  type="number"
                  required
                  min={0}
                  max={600}
                  step={1}
                  value={templateForm.break_minutes}
                  onChange={(event) =>
                    setTemplateForm({ ...templateForm, break_minutes: event.target.value })
                  }
                />
              </Field>
              <Field label="Dung sai đi muộn (phút)">
                <input
                  type="number"
                  min={0}
                  max={120}
                  step={1}
                  value={templateForm.late_grace_minutes}
                  onChange={(event) =>
                    setTemplateForm({ ...templateForm, late_grace_minutes: event.target.value })
                  }
                />
              </Field>
              <Field label="Dung sai về sớm (phút)">
                <input
                  type="number"
                  min={0}
                  max={120}
                  step={1}
                  value={templateForm.early_grace_minutes}
                  onChange={(event) =>
                    setTemplateForm({ ...templateForm, early_grace_minutes: event.target.value })
                  }
                />
              </Field>
              <label className="hr-recurring-check">
                <input
                  type="checkbox"
                  checked={Boolean(templateForm.is_active)}
                  onChange={(event) =>
                    setTemplateForm({ ...templateForm, is_active: event.target.checked })
                  }
                />{' '}
                Đang sử dụng
              </label>
            </div>
            <ErrorMessage error={formError} />
            <div className="modal-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setTemplateForm(null)}
              >
                Hủy
              </button>
              <button className="button primary" disabled={busy}>
                {busy ? 'Đang lưu…' : 'Lưu mẫu ca'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {ruleForm && (
        <Modal
          title={ruleForm.id ? 'Sửa lịch tuần' : 'Tạo lịch tuần'}
          onClose={() => {
            if (!busy) setRuleForm(null);
          }}
        >
          <form onSubmit={saveRule} className="hr-recurring-modal">
            <div className="form-grid">
              <Field label="Tên lịch" span>
                <input
                  required
                  maxLength={200}
                  value={ruleForm.name}
                  onChange={(event) => setRuleForm({ ...ruleForm, name: event.target.value })}
                />
              </Field>
              <Field label="Mẫu ca">
                <select
                  required
                  value={ruleForm.template_id}
                  onChange={(event) =>
                    setRuleForm({ ...ruleForm, template_id: event.target.value })
                  }
                >
                  <option value="">Chọn mẫu ca</option>
                  {ruleForm.template_id &&
                    !(templates.items || []).some((row) => row.id === ruleForm.template_id) && (
                      <option value={ruleForm.template_id}>
                        {ruleForm.template_name || 'Mẫu ca đã chọn'}
                      </option>
                    )}
                  {(templates.items || [])
                    .filter((row) => row.is_active)
                    .map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.code} · {row.name} · nghỉ {row.break_minutes} phút
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Hiệu lực từ ngày">
                <input
                  type="date"
                  required
                  value={ruleForm.effective_from}
                  onChange={(event) =>
                    setRuleForm({ ...ruleForm, effective_from: event.target.value })
                  }
                />
              </Field>
              <Field label="Đến hết ngày (tùy chọn)">
                <input
                  type="date"
                  min={ruleForm.effective_from}
                  value={ruleForm.effective_until || ''}
                  onChange={(event) =>
                    setRuleForm({ ...ruleForm, effective_until: event.target.value })
                  }
                />
              </Field>
              <fieldset className="hr-recurring-weekdays">
                <legend>Ngày làm việc hằng tuần</legend>
                {WEEKDAYS.map(([short, label, bit]) => (
                  <label key={bit}>
                    <input
                      type="checkbox"
                      checked={Boolean(Number(ruleForm.weekday_mask) & bit)}
                      onChange={(event) =>
                        setRuleForm({
                          ...ruleForm,
                          weekday_mask: event.target.checked
                            ? Number(ruleForm.weekday_mask) | bit
                            : Number(ruleForm.weekday_mask) & ~bit,
                        })
                      }
                    />
                    <span title={label}>{short}</span>
                  </label>
                ))}
              </fieldset>
              <label className="hr-recurring-check">
                <input
                  type="checkbox"
                  checked={Boolean(ruleForm.is_active)}
                  onChange={(event) =>
                    setRuleForm({ ...ruleForm, is_active: event.target.checked })
                  }
                />{' '}
                Đang sử dụng
              </label>
            </div>
            <p className="hr-muted">
              Ngày không chọn là ngày nghỉ. Quy tắc không tự động áp dụng cho nhân viên nào cho đến
              khi được phân công.
            </p>
            <ErrorMessage error={formError} />
            <div className="modal-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setRuleForm(null)}
              >
                Hủy
              </button>
              <button className="button primary" disabled={busy}>
                {busy ? 'Đang lưu…' : 'Lưu lịch tuần'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {closeRow && (
        <Modal
          title={`Kết thúc phân công ${closeRow.employee_code || ''}`}
          onClose={() => {
            if (!busy) setCloseRow(null);
          }}
        >
          <form onSubmit={closeAssignment} className="hr-recurring-modal">
            <p>
              Quy tắc sẽ ngừng áp dụng sau ngày kết thúc. Ca đã chấm công, ca trong kỳ lương khóa và
              lịch sử phân công vẫn được giữ.
            </p>
            <Field label="Ngày làm việc cuối">
              <input
                type="date"
                required
                min={closeRow.valid_from}
                value={closeDate}
                onChange={(event) => setCloseDate(event.target.value)}
              />
            </Field>
            <Field label="Lý do">
              <textarea
                required
                minLength={10}
                maxLength={4000}
                rows={3}
                value={closeReason}
                onChange={(event) => setCloseReason(event.target.value)}
              />
            </Field>
            <ErrorMessage error={formError} />
            <div className="modal-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setCloseRow(null)}
              >
                Hủy
              </button>
              <button className="button primary" disabled={busy}>
                {busy ? 'Đang lưu…' : 'Xác nhận kết thúc'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
