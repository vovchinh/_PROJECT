import { expect, it } from 'vitest';
import { formForAttendance } from './HrAttendance.jsx';

it('inherits the scheduled break for a new manual attendance draft', () => {
  const form = formForAttendance(null, {
    id: 'shift-1',
    employee_name: 'Test employee',
    work_date: '2026-10-19',
    break_minutes: 60,
  });
  expect(form.break_minutes).toBe(60);
  expect(form.schedule_id).toBe('shift-1');
});

it('retains an explicitly corrected break on an existing attendance record', () => {
  const form = formForAttendance(
    { id: 'attendance-1', break_minutes: 30 },
    {
      id: 'shift-1',
      break_minutes: 60,
    },
  );
  expect(form.break_minutes).toBe(30);
});
