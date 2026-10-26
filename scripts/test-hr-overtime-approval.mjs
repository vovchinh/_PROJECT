// Disposable PGlite integration checks; synthetic HR records only.
import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const db = new PGlite();
const users = {
  owner: randomUUID(),
  manager: randomUUID(),
  staff: randomUUID(),
  outsider: randomUUID(),
};
let actor = null;
let passed = 0;
async function check(label, run) {
  await run();
  passed++;
  console.log('PASS', label);
}
async function rows(sql, values = []) {
  return (await db.query(sql, values)).rows;
}
async function asUser(id) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.exec('set role authenticated');
  actor = id;
}
async function admin(sql, values = []) {
  const resume = actor;
  await db.exec('reset role');
  try {
    return (await db.query(sql, values)).rows;
  } finally {
    if (resume) await asUser(resume);
  }
}
async function rpc(name, args) {
  const entries = Object.entries(args);
  const result = await rows(
    `select public.${name}(${entries.map(([key], i) => `${key}=>$${i + 1}`).join(',')}) result`,
    entries.map(([, value]) =>
      value !== null && typeof value === 'object' ? JSON.stringify(value) : value,
    ),
  );
  return result[0].result;
}

try {
  await db.exec(`create role anon;create role authenticated;create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    grant usage on schema auth to authenticated,anon;
    grant execute on function auth.uid() to authenticated,anon;`);
  for (const [name, id] of Object.entries(users))
    await db.query('insert into auth.users values($1,$2,now())', [
      id,
      `${name}@overtime.example.test`,
    ]);
  const names = (await readdir(new URL('../supabase/migrations/', import.meta.url)))
    .filter((name) => /^\d{3}_.*\.sql$/.test(name) && Number(name.slice(0, 3)) <= 25)
    .sort();
  for (const name of names)
    await db.exec(
      await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'),
    );
  await check('001–025 migrations apply in order', async () => {
    assert.equal(
      (await rows("select to_regclass('public.hr_overtime_decisions') value"))[0].value,
      'hr_overtime_decisions',
    );
  });

  await asUser(users.owner);
  const workspace = (await rpc('bootstrap_workspace', { p_name: 'Overtime test workspace' })).id;
  await admin(
    'insert into public.workspace_members(workspace_id,user_id,role) values($1,$2,$3),($1,$4,$5)',
    [workspace, users.manager, 'manager', users.staff, 'staff'],
  );
  const employee = await rpc('save_hr_employee', {
    p_workspace_id: workspace,
    p_payload: { code: 'OT-1', full_name: 'Synthetic Overtime Worker', hire_date: '2026-01-01' },
  });
  await rpc('save_payroll_contract', {
    p_payload: {
      workspace_id: workspace,
      employee_id: employee.id,
      effective_from: '2026-08-01',
      pay_basis: 'hourly',
      rate_vnd: 120000,
      standard_day_minutes: 480,
      overtime_multiplier: 1.5,
    },
  });
  const schedule = await rpc('save_hr_work_schedule', {
    p_workspace_id: workspace,
    p_payload: {
      employee_id: employee.id,
      work_date: '2026-08-10',
      planned_start_at: '2026-08-10T09:00:00Z',
      planned_end_at: '2026-08-10T17:00:00Z',
      break_minutes: 0,
    },
  });
  const attendance = await rpc('save_hr_attendance', {
    p_workspace_id: workspace,
    p_payload: {
      schedule_id: schedule.id,
      clock_in_at: '2026-08-10T09:00:00Z',
      clock_out_at: '2026-08-10T18:00:00Z',
    },
    p_request_id: randomUUID(),
  });
  await rpc('confirm_hr_attendance', {
    p_workspace_id: workspace,
    p_id: attendance.id,
    p_request_id: randomUUID(),
  });
  const period = await rpc('save_payroll_period', {
    p_payload: { workspace_id: workspace, period_start: '2026-08-01', period_end: '2026-08-31' },
  });
  await check('unreviewed observed overtime cannot enter payroll', async () => {
    await assert.rejects(
      () => rpc('calculate_payroll', { p_workspace_id: workspace, p_period_id: period.id }),
      /HR_OT_REVIEW_REQUIRED/,
    );
    assert.equal(
      (
        await admin('select count(*) n from public.hr_payroll_lines where workspace_id=$1', [
          workspace,
        ])
      )[0].n,
      0,
    );
  });

  const args = {
    p_workspace_id: workspace,
    p_attendance_id: attendance.id,
    p_approved_minutes: 30,
    p_reason: 'Manager approved only thirty minutes',
    p_request_id: randomUUID(),
  };
  const decision = await rpc('review_hr_overtime', args);
  await check('decision is idempotent and request content is locked', async () => {
    assert.equal((await rpc('review_hr_overtime', args)).id, decision.id);
    await assert.rejects(
      () => rpc('review_hr_overtime', { ...args, p_approved_minutes: 60 }),
      /HR_OT_REQUEST_REUSED/,
    );
    assert.equal(
      Number(
        (
          await admin('select count(*) n from public.hr_overtime_decisions where workspace_id=$1', [
            workspace,
          ])
        )[0].n,
      ),
      1,
    );
  });
  await check('only approved overtime minutes affect gross/net and snapshot', async () => {
    const calculated = await rpc('calculate_payroll', {
      p_workspace_id: workspace,
      p_period_id: period.id,
    });
    assert.equal(calculated.status, 'CALCULATED');
    const [line] = await admin(
      'select * from public.hr_payroll_lines where workspace_id=$1 and period_id=$2',
      [workspace, period.id],
    );
    assert.equal(Number(line.regular_minutes), 480);
    assert.equal(Number(line.overtime_minutes), 30);
    assert.equal(Number(line.overtime_pay), 90000);
    assert.equal(Number(line.gross_pay), 1050000);
    assert.equal(line.source_snapshot.overtime_review.raw_minutes, 60);
    assert.equal(line.source_snapshot.overtime_review.decisions[0].decision_id, decision.id);
    assert.equal(line.source_snapshot.schedule_sources[0].id, schedule.id);
  });

  await check(
    'new overtime decision reopens unapproved payroll and rejection pays zero OT',
    async () => {
      await asUser(users.manager);
      await rpc('review_hr_overtime', {
        p_workspace_id: workspace,
        p_attendance_id: attendance.id,
        p_approved_minutes: 0,
        p_reason: 'Observed time was not authorized overtime',
        p_request_id: randomUUID(),
      });
      await asUser(users.owner);
      assert.equal(
        (await admin('select status from public.hr_payroll_periods where id=$1', [period.id]))[0]
          .status,
        'DRAFT',
      );
      await rpc('calculate_payroll', { p_workspace_id: workspace, p_period_id: period.id });
      const [line] = await admin(
        'select overtime_minutes,overtime_pay,gross_pay from public.hr_payroll_lines where period_id=$1',
        [period.id],
      );
      assert.equal(Number(line.overtime_minutes), 0);
      assert.equal(Number(line.overtime_pay), 0);
      assert.equal(Number(line.gross_pay), 960000);
    },
  );

  await check('manager list is paged; staff has no access to decisions or RPC', async () => {
    const listed = await rpc('list_hr_overtime_reviews', {
      p_workspace_id: workspace,
      p_month: '2026-08-01',
      p_status: 'rejected',
      p_page: 1,
      p_page_size: 10,
    });
    assert.equal(Number(listed.total), 1);
    assert.equal(listed.items[0].attendance_id, attendance.id);
    await asUser(users.staff);
    assert.equal(
      Number(
        (
          await rows('select count(*) n from public.hr_overtime_decisions where workspace_id=$1', [
            workspace,
          ])
        )[0].n,
      ),
      0,
    );
    await assert.rejects(
      () => rpc('list_hr_overtime_reviews', { p_workspace_id: workspace, p_month: '2026-08-01' }),
      /permission|role|quyền/i,
    );
    await assert.rejects(
      () =>
        rpc('review_hr_overtime', {
          p_workspace_id: workspace,
          p_attendance_id: attendance.id,
          p_approved_minutes: 10,
          p_reason: 'This staff cannot decide overtime',
          p_request_id: randomUUID(),
        }),
      /permission|role|quyền/i,
    );
    await asUser(users.owner);
  });

  await check(
    'approved payroll locks decisions and creates one expense, no cash effect',
    async () => {
      await rpc('review_payroll', { p_workspace_id: workspace, p_period_id: period.id });
      const request = randomUUID();
      await rpc('approve_payroll', {
        p_workspace_id: workspace,
        p_period_id: period.id,
        p_request_id: request,
      });
      await rpc('approve_payroll', {
        p_workspace_id: workspace,
        p_period_id: period.id,
        p_request_id: request,
      });
      const [totals] = await admin(
        'select count(*) n,sum(amount) amount from public.hr_payroll_expenses where workspace_id=$1',
        [workspace],
      );
      assert.equal(Number(totals.n), 1);
      assert.equal(Number(totals.amount), 960000);
      assert.equal(
        Number(
          (
            await admin('select count(*) n from public.cash_movements where workspace_id=$1', [
              workspace,
            ])
          )[0].n,
        ),
        0,
      );
      await assert.rejects(
        () =>
          rpc('review_hr_overtime', {
            p_workspace_id: workspace,
            p_attendance_id: attendance.id,
            p_approved_minutes: 60,
            p_reason: 'Attempt to change locked overtime',
            p_request_id: randomUUID(),
          }),
        /HR_OT_PAYROLL_LOCKED/,
      );
    },
  );
  await check('valid QR scan materializes a missing recurring shift just in time', async () => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Ho_Chi_Minh',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(new Date())
        .map(({ type, value }) => [type, value]),
    );
    const today = `${parts.year}-${parts.month}-${parts.day}`;
    const hour = Number(parts.hour);
    const startTime = `${String(hour).padStart(2, '0')}:00`;
    const endTime = `${String((hour + 1) % 24).padStart(2, '0')}:00`;
    const qrEmployee = await rpc('save_hr_employee', {
      p_workspace_id: workspace,
      p_payload: {
        code: 'QR-OT-1',
        full_name: 'Synthetic QR Recurring Worker',
        auth_user_id: users.staff,
        hire_date: '2026-01-01',
      },
    });
    const site = await rpc('save_hr_attendance_site', {
      p_workspace_id: workspace,
      p_payload: { code: 'QR-OT-SITE', name: 'Synthetic QR Site' },
    });
    await rpc('save_hr_site_assignment', {
      p_workspace_id: workspace,
      p_payload: { employee_id: qrEmployee.id, site_id: site.id, valid_from: today },
    });
    const template = await rpc('save_hr_shift_template', {
      p_workspace_id: workspace,
      p_payload: {
        code: 'QR-JIT',
        name: 'QR just-in-time fixture',
        start_time: startTime,
        end_time: endTime,
        end_day_offset: hour === 23 ? 1 : 0,
        break_minutes: 0,
        late_grace_minutes: 0,
        early_grace_minutes: 0,
      },
    });
    const rule = await rpc('save_hr_weekly_schedule_rule', {
      p_workspace_id: workspace,
      p_payload: {
        name: 'Everyday QR fixture',
        template_id: template.id,
        weekday_mask: 127,
        effective_from: today,
      },
    });
    // A privileged fixture simulates a long-lived assignment after its initial
    // 45-day materialization horizon has elapsed; no daily shift exists yet.
    await admin(
      `insert into public.hr_recurring_assignments
      (workspace_id,employee_id,rule_id,site_id,valid_from,created_request_id,created_by)
      values($1,$2,$3,$4,$5,$6,$7)`,
      [workspace, qrEmployee.id, rule.id, site.id, today, randomUUID(), users.owner],
    );
    const kiosk = await rpc('start_hr_qr_kiosk', {
      p_workspace_id: workspace,
      p_site_id: site.id,
      p_request_id: randomUUID(),
    });
    const challenge = await rpc('issue_hr_qr_challenge', {
      p_workspace_id: workspace,
      p_kiosk_id: kiosk.id,
    });
    await asUser(users.staff);
    const rejected = await rpc('scan_hr_qr', {
      p_workspace_id: workspace,
      p_token: randomUUID(),
      p_action: 'check_in',
      p_request_id: randomUUID(),
    });
    assert.equal(rejected.ok, false);
    assert.equal(
      Number(
        (
          await admin('select count(*) n from public.hr_work_schedules where employee_id=$1', [
            qrEmployee.id,
          ])
        )[0].n,
      ),
      0,
    );
    const request = randomUUID();
    const scanArgs = {
      p_workspace_id: workspace,
      p_token: challenge.token,
      p_action: 'check_in',
      p_request_id: request,
    };
    const scan = await rpc('scan_hr_qr', scanArgs);
    assert.ok(scan.event_id);
    assert.equal((await rpc('scan_hr_qr', scanArgs)).event_id, scan.event_id);
    const [generated] = await admin(
      'select source_kind,site_id,work_date from public.hr_work_schedules where id=$1',
      [scan.schedule_id],
    );
    assert.equal(generated.source_kind, 'recurring');
    assert.equal(generated.site_id, site.id);
    assert.equal(new Date(generated.work_date).toISOString().slice(0, 10), today);
    await asUser(users.owner);
  });
  await check('cross-workspace reviewer cannot access another attendance', async () => {
    await asUser(users.outsider);
    const otherWorkspace = (
      await rpc('bootstrap_workspace', { p_name: 'Separate overtime workspace' })
    ).id;
    await assert.rejects(
      () =>
        rpc('review_hr_overtime', {
          p_workspace_id: otherWorkspace,
          p_attendance_id: attendance.id,
          p_approved_minutes: 10,
          p_reason: 'Cross workspace should be rejected',
          p_request_id: randomUUID(),
        }),
      /HR_OT_ATTENDANCE/,
    );
  });
  console.log(`HR overtime approval checks passed: ${passed}`);
} finally {
  await db.close();
}
