import { useEffect, useRef } from 'react';
import { X, Search, ChevronDown, PackageOpen, ArrowDownToLine } from 'lucide-react';
import { csv, download } from './lib/domain.js';
export function Badge({ status, children }) {
  return (
    <span className={`badge ${status || ''}`}>
      {children ||
        { draft: 'Chờ xác nhận', posted: 'Đã ghi sổ', reversed: 'Đã đảo' }[status] ||
        status}
    </span>
  );
}
export function Panel({ title, note, action, children, className = '' }) {
  return (
    <section className={`panel ${className}`}>
      {(title || action) && (
        <div className="panel-head">
          <div>
            <h2>{title}</h2>
            {note && <p>{note}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
export function Empty({ title = 'Chưa có dữ liệu', children, action }) {
  return (
    <div className="empty">
      <PackageOpen size={34} />
      <h3>{title}</h3>
      <p>{children || 'Tạo chứng từ đầu tiên hoặc nhập file dữ liệu để bắt đầu.'}</p>
      {action}
    </div>
  );
}
export function SearchBox({ value, onChange, placeholder = 'Tìm mã, tên hoặc nội dung...' }) {
  return (
    <label className="search">
      <Search size={17} />
      <input
        aria-label="Tìm kiếm dữ liệu"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </label>
  );
}
export function Field({ label, children, hint, span = false }) {
  return (
    <label className={`field ${span ? 'span-2' : ''}`}>
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Select({ items = [], placeholder = 'Chọn...', ...props }) {
  return (
    <span className="select-wrap">
      <select {...props}>
        <option value="">{placeholder}</option>
        {items.map((i) => (
          <option key={i.id ?? i.value} value={i.id ?? i.value}>
            {i.label ?? `${i.code ? i.code + ' · ' : ''}${i.name}`}
          </option>
        ))}
      </select>
      <ChevronDown size={15} />
    </span>
  );
}
export function ErrorMessage({ error }) {
  return error ? (
    <div className="inline-error" role="alert">
      {error}
    </div>
  ) : null;
}
export function Modal({ title, description, onClose, children }) {
  const ref = useRef(null),
    closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.querySelector('input,select,textarea,button')?.focus();
    const handler = (e) => {
      if (e.key === 'Escape') closeRef.current();
      if (e.key === 'Tab') {
        const items = [
          ...ref.current.querySelectorAll(
            'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href]',
          ),
        ];
        const first = items[0],
          last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className="modal"
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
      >
        <header>
          <div>
            <h2 id="dialog-title">{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button className="icon-button" aria-label="Đóng hộp thoại" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
export function ExportButton({ name, rows }) {
  return (
    <button
      className="button secondary"
      onClick={() => download(name, csv(rows), 'text/csv;charset=utf-8')}
    >
      <ArrowDownToLine size={16} /> Xuất CSV
    </button>
  );
}
export function Table({ headers, children, empty, columns }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th key={`${h}-${i}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {empty ? (
            <tr>
              <td colSpan={columns || headers.length}>
                <Empty />
              </td>
            </tr>
          ) : (
            children
          )}
        </tbody>
      </table>
    </div>
  );
}
