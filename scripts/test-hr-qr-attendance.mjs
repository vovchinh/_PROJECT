// Disposable local PGlite verification; no cloud or customer data.
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const db = new PGlite();
const users = {
  owner: '11111111-1111-4111-8111-111111111111',
  manager: '22222222-2222-4222-8222-222222222222',
  staff: '33333333-3333-4333-8333-333333333333',
  outsider: '44444444-4444-4444-8444-444444444444',
};
let count = 0;
async function check(label, fn) {
  await fn();
  count++;
  console.log('PASS', label);
}
async function asUser(id) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.exec('set role authenticated');
}
async function admin(sql, params = []) {
  await db.exec('reset role');
  return db.query(sql, params);
}
async function rpc(name, args) {
  const entries = Object.entries(args);
  const { rows } = await db.query(
    `select public.${name}(${entries.map(([key], i) => `${key}=>$${i + 1}`).join(',')}) result`,
    entries.map(([, value]) =>
      value !== null && typeof value === 'object' ? JSON.stringify(value) : value,
    ),
  );
  return rows[0].result;
}
async function scanError(args, expected) {
  const result = await rpc('scan_hr_qr', args);
  assert.equal(result.ok, false);
  assert.equal(result.error, expected);
}
function vnDate(date) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

try {
  await db.exec(`create role anon;create role authenticated;create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    grant usage on schema auth to authenticated,anon;
    grant execute on function auth.uid() to authenticated,anon;`);
  for (const [name, id] of Object.entries(users)) {
    await db.query('insert into auth.users values($1,$2,now())', [id, `${name}@qr.test`]);
  }
  for (let n = 1; n <= 23; n++) {
    const name = (await import('node:fs/promises')).readdir;
    const entries = await name(new URL('../supabase/migrations/', import.meta.url));
    const file = entries.find((entry) => entry.startsWith(`${String(n).padStart(3, '0')}_`));
    assert.ok(file, `migration ${n} exists`);
    try {
      await db.exec(
        await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'),
      );
    } catch (error) {
      console.error(`Migration ${file}: ${error.message}`);
      process.exitCode = 1;
      await db.close();
      process.exit();
    }
  }
  await check('clean migrations through 023 create QR tables', async () => {
    const { rows } = await db.query("select to_regclass('public.hr_qr_attendance_events') events");
    assert.equal(rows[0].events, 'hr_qr_attendance_events');
  });

  await asUser(users.owner);
  const workspace = (await rpc('bootstrap_workspace', { p_name: 'QR Test A' })).id;
  await asUser(users.outsider);
  const otherWorkspace = (await rpc('bootstrap_workspace', { p_name: 'QR Test B' })).id;
  await asUser(users.owner);
  await rpc('add_workspace_member', {
    p_workspace_id: workspace,
    p_email: 'manager@qr.test',
    p_role: 'manager',
  });
  await rpc('add_workspace_member', {
    p_workspace_id: workspace,
    p_email: 'staff@qr.test',
    p_role: 'staff',
  });
  const employee = await rpc('save_hr_employee', {
    p_workspace_id: workspace,
    p_payload: { code: 'QR01', full_name: 'QR Employee', auth_user_id: users.staff },
  });
  const siteA = await rpc('save_hr_attendance_site', {
    p_workspace_id: workspace,
    p_payload: { code: 'STORE-A', name: 'Store A' },
  });
  const siteB = await rpc('save_hr_attendance_site', {
    p_workspace_id: workspace,
    p_payload: { code: 'STORE-B', name: 'Store B' },
  });
  const yesterday = vnDate(new Date(Date.now() - 86400000));
  const today = vnDate(new Date());
  const assignment = await rpc('save_hr_site_assignment', {
    p_workspace_id: workspace,
    p_payload: { employee_id: employee.id, site_id: siteA.id, valid_from: yesterday },
  });
  await check('same employee may have two sites but same-pair dates cannot overlap', async () => {
    await rpc('save_hr_site_assignment', {
      p_workspace_id: workspace,
      p_payload: { employee_id: employee.id, site_id: siteB.id, valid_from: yesterday },
    });
    await assert.rejects(
      () =>
        rpc('save_hr_site_assignment', {
          p_workspace_id: workspace,
          p_payload: { employee_id: employee.id, site_id: siteA.id, valid_from: today },
        }),
      /HR_SITE_ASSIGNMENT_OVERLAP/,
    );
    const setup = await rpc('list_hr_qr_setup', { p_workspace_id: workspace });
    assert.equal(setup.sites.length, 2);
    assert.equal(setup.assignments.length, 2);
  });
  const schedule = await rpc('save_hr_work_schedule', {
    p_workspace_id: workspace,
    p_payload: {
      employee_id: employee.id,
      work_date: yesterday,
      planned_start_at: `${yesterday}T23:00:00+07:00`,
      planned_end_at: `${today}T23:00:00+07:00`,
      shift_name: 'Overnight QR',
    },
  });
  await check('site binding uses the work date and preserves overnight schedule', async () => {
    const bound = await rpc('bind_hr_work_schedule_site', {
      p_workspace_id: workspace,
      p_schedule_id: schedule.id,
      p_site_id: siteA.id,
    });
    assert.equal(bound.site_id, siteA.id);
    assert.equal(bound.work_date, yesterday);
  });
  const kioskA = await rpc('start_hr_qr_kiosk', {
    p_workspace_id: workspace,
    p_site_id: siteA.id,
    p_request_id: randomUUID(),
  });
  const kioskB = await rpc('start_hr_qr_kiosk', {
    p_workspace_id: workspace,
    p_site_id: siteB.id,
    p_request_id: randomUUID(),
  });
  const challengeA = await rpc('issue_hr_qr_challenge', {
    p_workspace_id: workspace,
    p_kiosk_id: kioskA.id,
  });
  const challengeB = await rpc('issue_hr_qr_challenge', {
    p_workspace_id: workspace,
    p_kiosk_id: kioskB.id,
  });
  await asUser(users.staff);
  await check('staff cannot manage sites or read HR tables directly', async () => {
    await assert.rejects(
      () =>
        rpc('save_hr_attendance_site', {
          p_workspace_id: workspace,
          p_payload: { code: 'BAD', name: 'Bad' },
        }),
      /quyền|permission/i,
    );
    const { rows } = await db.query('select count(*)::integer n from public.hr_attendance_sites');
    assert.equal(rows[0].n, 0);
    await assert.rejects(
      () => db.query('select * from public.hr_qr_challenges'),
      /permission denied/,
    );
  });
  await check('wrong site and wrong workspace reject staff scan', async () => {
    await scanError(
      {
        p_workspace_id: workspace,
        p_token: challengeB.token,
        p_action: 'check_in',
        p_request_id: randomUUID(),
      },
      'HR_QR_SITE_MISMATCH',
    );
    await assert.rejects(
      () =>
        rpc('scan_hr_qr', {
          p_workspace_id: otherWorkspace,
          p_token: challengeA.token,
          p_action: 'check_in',
          p_request_id: randomUUID(),
        }),
      /quyền|permission/i,
    );
  });
  const checkInRequest = randomUUID();
  const checkIn = await rpc('scan_hr_qr', {
    p_workspace_id: workspace,
    p_token: challengeA.token,
    p_action: 'check_in',
    p_request_id: checkInRequest,
  });
  await check(
    'check-in writes an immutable event and draft at server time; retry is stable',
    async () => {
      const retry = await rpc('scan_hr_qr', {
        p_workspace_id: workspace,
        p_token: challengeA.token,
        p_action: 'check_in',
        p_request_id: checkInRequest,
      });
      assert.deepEqual(retry, checkIn);
      const mine = await rpc('get_my_hr_attendance', {
        p_workspace_id: workspace,
        p_month: yesterday.slice(0, 7) + '-01',
      });
      assert.equal(mine.items[0].status, 'draft');
      assert.equal(mine.items[0].work_date, yesterday);
      assert.equal(mine.items[0].qr_events[0].action, 'check_in');
      await scanError(
        {
          p_workspace_id: workspace,
          p_token: challengeA.token,
          p_action: 'check_in',
          p_request_id: randomUUID(),
        },
        'HR_QR_ALREADY_CHECKED_IN',
      );
      await scanError(
        {
          p_workspace_id: workspace,
          p_token: challengeB.token,
          p_action: 'check_in',
          p_request_id: checkInRequest,
        },
        'HR_QR_IDEMPOTENCY',
      );
    },
  );
  await check('expired challenge rejects before changing attendance', async () => {
    const expired = await rpc('scan_hr_qr', {
      p_workspace_id: workspace,
      p_token: challengeA.token,
      p_action: 'check_in',
      p_request_id: checkInRequest,
    });
    assert.equal(expired.event_id, checkIn.event_id);
    await admin(
      `update public.hr_qr_challenges set
      issued_at=clock_timestamp()-interval '40 seconds',
      expires_at=clock_timestamp()-interval '10 seconds'
      where token_hash=md5($1)`,
      [challengeA.token],
    );
    await asUser(users.staff);
    await scanError(
      {
        p_workspace_id: workspace,
        p_token: challengeA.token,
        p_action: 'check_out',
        p_request_id: randomUUID(),
      },
      'HR_QR_CHALLENGE_EXPIRED',
    );
  });
  await check('checkout writes second event and remains draft', async () => {
    await admin(
      `update public.hr_attendance set clock_in_at=clock_timestamp()-interval '2 minutes'
      where workspace_id=$1 and id=$2`,
      [workspace, checkIn.attendance_id],
    );
    await asUser(users.owner);
    const fresh = await rpc('issue_hr_qr_challenge', {
      p_workspace_id: workspace,
      p_kiosk_id: kioskA.id,
    });
    await asUser(users.staff);
    const out = await rpc('scan_hr_qr', {
      p_workspace_id: workspace,
      p_token: fresh.token,
      p_action: 'check_out',
      p_request_id: randomUUID(),
    });
    assert.equal(out.work_date, yesterday);
    const { rows } = await admin(
      `select status,clock_out_at from public.hr_attendance
      where workspace_id=$1 and id=$2`,
      [workspace, checkIn.attendance_id],
    );
    assert.equal(rows[0].status, 'draft');
    assert.ok(rows[0].clock_out_at);
    await asUser(users.staff);
    await scanError(
      {
        p_workspace_id: workspace,
        p_token: fresh.token,
        p_action: 'check_out',
        p_request_id: randomUUID(),
      },
      'HR_QR_ALREADY_CHECKED_OUT',
    );
  });
  await check('QR draft reaches payroll only after manager confirmation', async () => {
    await asUser(users.owner);
    const periodStart = `${yesterday.slice(0, 7)}-01`;
    const [year, month] = yesterday.slice(0, 7).split('-').map(Number);
    const periodEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    await rpc('save_payroll_contract', {
      p_payload: {
        workspace_id: workspace,
        employee_id: employee.id,
        effective_from: periodStart,
        pay_basis: 'hourly',
        rate_vnd: 120000,
        standard_day_minutes: 480,
        overtime_multiplier: 1.5,
      },
    });
    const period = await rpc('save_payroll_period', {
      p_payload: {
        workspace_id: workspace,
        period_start: periodStart,
        period_end: periodEnd,
      },
    });
    await assert.rejects(
      () => rpc('calculate_payroll', { p_workspace_id: workspace, p_period_id: period.id }),
      /HR_ATTENDANCE_DRAFT/,
    );
    await rpc('confirm_hr_attendance', {
      p_workspace_id: workspace,
      p_id: checkIn.attendance_id,
      p_request_id: randomUUID(),
    });
    const calculated = await rpc('calculate_payroll', {
      p_workspace_id: workspace,
      p_period_id: period.id,
    });
    assert.equal(calculated.status, 'CALCULATED');
    const { rows: lines } = await admin(
      `select regular_minutes, gross_pay from public.hr_payroll_lines
       where workspace_id=$1 and period_id=$2 and employee_id=$3`,
      [workspace, period.id, employee.id],
    );
    assert.equal(lines.length, 1);
    assert.ok(Number(lines[0].regular_minutes) > 0);
    assert.ok(Number(lines[0].gross_pay) > 0);
    const { rows: cash } = await admin(
      `select count(*)::integer n from public.cash_transactions where workspace_id=$1`,
      [workspace],
    );
    assert.equal(cash[0].n, 0);
  });
  await check('manual check-in cannot be laundered through QR checkout', async () => {
    await asUser(users.owner);
    const managerEmployee = await rpc('save_hr_employee', {
      p_workspace_id: workspace,
      p_payload: { code: 'QR02', full_name: 'Manager Employee', auth_user_id: users.manager },
    });
    await rpc('save_hr_site_assignment', {
      p_workspace_id: workspace,
      p_payload: { employee_id: managerEmployee.id, site_id: siteA.id, valid_from: today },
    });
    const tomorrow = vnDate(new Date(Date.now() + 86400000));
    const manualShift = await rpc('save_hr_work_schedule', {
      p_workspace_id: workspace,
      p_payload: {
        employee_id: managerEmployee.id,
        work_date: today,
        planned_start_at: `${today}T00:00:00+07:00`,
        planned_end_at: `${tomorrow}T00:00:00+07:00`,
      },
    });
    await rpc('bind_hr_work_schedule_site', {
      p_workspace_id: workspace,
      p_schedule_id: manualShift.id,
      p_site_id: siteA.id,
    });
    await rpc('save_hr_attendance', {
      p_workspace_id: workspace,
      p_payload: {
        schedule_id: manualShift.id,
        clock_in_at: new Date(Date.now() - 120000).toISOString(),
      },
      p_request_id: randomUUID(),
    });
    const manualToken = await rpc('issue_hr_qr_challenge', {
      p_workspace_id: workspace,
      p_kiosk_id: kioskA.id,
    });
    await asUser(users.manager);
    await scanError(
      {
        p_workspace_id: workspace,
        p_token: manualToken.token,
        p_action: 'check_out',
        p_request_id: randomUUID(),
      },
      'HR_QR_CHECK_IN_REQUIRED',
    );
    await asUser(users.owner);
    const wrongDateShift = await rpc('save_hr_work_schedule', {
      p_workspace_id: workspace,
      p_payload: {
        employee_id: managerEmployee.id,
        work_date: tomorrow,
        planned_start_at: `${today}T12:00:00+07:00`,
        planned_end_at: `${today}T14:00:00+07:00`,
      },
    });
    await assert.rejects(
      () =>
        rpc('bind_hr_work_schedule_site', {
          p_workspace_id: workspace,
          p_schedule_id: wrongDateShift.id,
          p_site_id: siteA.id,
        }),
      /HR_SITE_WORK_DATE/,
    );
  });
  await check('overlapping scan windows across sites are rejected', async () => {
    await asUser(users.owner);
    const tomorrow = vnDate(new Date(Date.now() + 86400000));
    const overlapping = await rpc('save_hr_work_schedule', {
      p_workspace_id: workspace,
      p_payload: {
        employee_id: employee.id,
        work_date: today,
        planned_start_at: `${today}T00:00:00+07:00`,
        planned_end_at: `${tomorrow}T00:00:00+07:00`,
      },
    });
    await rpc('bind_hr_work_schedule_site', {
      p_workspace_id: workspace,
      p_schedule_id: overlapping.id,
      p_site_id: siteB.id,
    });
    const token = await rpc('issue_hr_qr_challenge', {
      p_workspace_id: workspace,
      p_kiosk_id: kioskA.id,
    });
    await asUser(users.staff);
    await scanError(
      {
        p_workspace_id: workspace,
        p_token: token.token,
        p_action: 'check_in',
        p_request_id: randomUUID(),
      },
      'HR_QR_SHIFT',
    );
  });
  await check(
    'archived site permits closing historical assignment but rejects reopening',
    async () => {
      await asUser(users.owner);
      const retired = await rpc('save_hr_attendance_site', {
        p_workspace_id: workspace,
        p_payload: { code: 'RETIRED', name: 'Retired Store' },
      });
      const retiredAssignment = await rpc('save_hr_site_assignment', {
        p_workspace_id: workspace,
        p_payload: { employee_id: employee.id, site_id: retired.id, valid_from: yesterday },
      });
      await rpc('save_hr_attendance_site', {
        p_workspace_id: workspace,
        p_payload: {
          id: retired.id,
          code: 'RETIRED',
          name: 'Retired Store',
          is_active: false,
          archive_reason: 'Store closed permanently',
        },
      });
      const closed = await rpc('save_hr_site_assignment', {
        p_workspace_id: workspace,
        p_payload: { id: retiredAssignment.id, valid_to: today },
      });
      assert.equal(closed.valid_to, today);
      await assert.rejects(
        () =>
          rpc('save_hr_site_assignment', {
            p_workspace_id: workspace,
            p_payload: { id: retiredAssignment.id, valid_to: null },
          }),
        /HR_SITE_INACTIVE/,
      );
    },
  );
  await check('event history cannot be edited and site cannot move after attendance', async () => {
    await assert.rejects(
      () =>
        admin(
          `delete from public.hr_qr_attendance_events
      where workspace_id=$1 and id=$2`,
          [workspace, checkIn.event_id],
        ),
      /HR_HISTORY_IMMUTABLE/,
    );
    await asUser(users.owner);
    await assert.rejects(
      () =>
        rpc('bind_hr_work_schedule_site', {
          p_workspace_id: workspace,
          p_schedule_id: schedule.id,
          p_site_id: siteB.id,
        }),
      /HR_SITE_SCHEDULE_LOCKED/,
    );
  });
  await check('legacy site-null schedule is retained for manual flow', async () => {
    await asUser(users.owner);
    const legacy = await rpc('save_hr_work_schedule', {
      p_workspace_id: workspace,
      p_payload: {
        employee_id: employee.id,
        work_date: vnDate(new Date(Date.now() + 86400000)),
        planned_start_at: new Date(Date.now() + 86400000).toISOString(),
        planned_end_at: new Date(Date.now() + 90000000).toISOString(),
      },
    });
    assert.equal(legacy.site_id, null);
  });
  await check('stopped kiosk invalidates issued QR tokens', async () => {
    const token = await rpc('issue_hr_qr_challenge', {
      p_workspace_id: workspace,
      p_kiosk_id: kioskA.id,
    });
    const stopped = await rpc('stop_hr_qr_kiosk', {
      p_workspace_id: workspace,
      p_kiosk_id: kioskA.id,
    });
    assert.ok(stopped.stopped_at);
    await asUser(users.staff);
    await scanError(
      {
        p_workspace_id: workspace,
        p_token: token.token,
        p_action: 'check_in',
        p_request_id: randomUUID(),
      },
      'HR_QR_KIOSK_EXPIRED',
    );
  });
  await check(
    'failed scans commit per-account rate limit while exact successful retry stays stable',
    async () => {
      await admin(
        `update public.hr_qr_scan_limits set failed_count=0,window_start=clock_timestamp()
      where workspace_id=$1 and actor_id=$2`,
        [workspace, users.staff],
      );
      await asUser(users.staff);
      for (let i = 0; i < 10; i++) {
        await scanError(
          {
            p_workspace_id: workspace,
            p_token: randomUUID(),
            p_action: 'check_in',
            p_request_id: randomUUID(),
          },
          'HR_QR_CHALLENGE_EXPIRED',
        );
      }
      await scanError(
        {
          p_workspace_id: workspace,
          p_token: randomUUID(),
          p_action: 'check_in',
          p_request_id: randomUUID(),
        },
        'HR_QR_RATE_LIMIT',
      );
      const retry = await rpc('scan_hr_qr', {
        p_workspace_id: workspace,
        p_token: challengeA.token,
        p_action: 'check_in',
        p_request_id: checkInRequest,
      });
      assert.equal(retry.event_id, checkIn.event_id);
    },
  );
  console.log(`PASS ${count} QR database checks`);
} finally {
  await db.close();
}
