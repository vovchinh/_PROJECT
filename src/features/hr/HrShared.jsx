import { useEffect, useState } from 'react';
import { Field } from '../../components.jsx';

export const employeeStatus = {
  active: 'Đang làm việc',
  on_leave: 'Tạm nghỉ',
  terminated: 'Nghỉ việc',
  archived: 'Đã lưu trữ',
};
export const moneyVnd = (value) =>
  value == null
    ? '—'
    : new Intl.NumberFormat('vi-VN', {
        style: 'currency',
        currency: 'VND',
        maximumFractionDigits: 0,
      }).format(Number(value));
const businessDateParts = () =>
  Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date())
      .map(({ type, value }) => [type, value]),
  );
export const isoMonth = () => {
  const { year, month } = businessDateParts();
  return `${year}-${month}`;
};
export const isoToday = () => {
  const { year, month, day } = businessDateParts();
  return `${year}-${month}-${day}`;
};

export function HrKpi({ icon: Icon, label, value, tone = 'blue', detail }) {
  return (
    <article className={`hr-kpi hr-tone-${tone}`}>
      <span className="hr-kpi-icon">
        <Icon size={22} />
      </span>
      <div>
        <small>{label}</small>
        <strong>{value ?? '—'}</strong>
        {detail && <span>{detail}</span>}
      </div>
    </article>
  );
}

export function HrPager({ total = 0, page = 1, pageSize = 25, onPage }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="hr-pager">
      <span>
        {total} kết quả · trang {page}/{pages}
      </span>
      <div>
        <button className="button secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Trước
        </button>
        <button
          className="button secondary"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
        >
          Sau
        </button>
      </div>
    </div>
  );
}

export function EmployeePicker({
  api,
  value,
  onChange,
  label = 'Nhân viên',
  excludeId = null,
  disabled = false,
}) {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState([]);
  const [selected, setSelected] = useState(null);
  useEffect(() => {
    let alive = true;
    if (!value) {
      setSelected(null);
      return;
    }
    api
      .getEmployee(value)
      .then((row) => {
        if (alive) setSelected(row);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [api, value]);
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      api
        .listEmployees({ query, limit: 25 })
        .then((result) => {
          if (alive) setRows(result.rows || []);
        })
        .catch(() => {
          if (alive) setRows([]);
        });
    }, 200);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [api, query]);
  const candidates =
    selected && !rows.some((row) => row.id === selected.id) ? [selected, ...rows] : rows;
  return (
    <Field label={label}>
      <div className="hr-picker">
        <input
          aria-label={`Tìm ${label.toLowerCase()}`}
          placeholder="Tìm mã hoặc họ tên…"
          value={query}
          disabled={disabled}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          aria-label={label}
          value={value || ''}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value || null)}
        >
          <option value="">Chưa chọn</option>
          {candidates
            .filter((row) => row.id !== excludeId)
            .map((row) => (
              <option key={row.id} value={row.id}>
                {row.code} · {row.full_name}
              </option>
            ))}
        </select>
      </div>
    </Field>
  );
}
