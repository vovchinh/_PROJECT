const vietnamDateTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Ho_Chi_Minh',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

// datetime-local has no zone. HR business forms always mean Vietnam wall time,
// regardless of the manager's browser timezone.
export function toVnDateTimeInput(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = Object.fromEntries(
    vietnamDateTime.formatToParts(date).map(({ type, value: part }) => [type, part]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function fromVnDateTimeInput(value) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
    throw new Error('Giờ Việt Nam phải có ngày và giờ hợp lệ.');
  }
  const date = new Date(`${value}:00+07:00`);
  if (Number.isNaN(date.getTime()) || toVnDateTimeInput(date) !== value) {
    throw new Error('Ngày hoặc giờ Việt Nam không hợp lệ.');
  }
  return date.toISOString();
}
