// Disposable PGlite integration checks. Synthetic HR data only; no cloud or customer data.
import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const db = new PGlite();
const users = {
  owner: '11111111-1111-4111-8111-111111111111',
  manager: '22222222-2222-4222-8222-222222222222',
  staff: '33333333-3333-4333-8333-333333333333',
  outsider: '44444444-4444-4444-8444-444444444444',
};
function addDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
function isoDay(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}
const todayInVietnam = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Ho_Chi_Minh',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());
const firstMonday = addDays(
  todayInVietnam,
  (8 - new Date(`${todayInVietnam}T00:00:00Z`).getUTCDay()) % 7,
);
const firstSunday = addDays(firstMonday, 6);
const lockedMonday = addDays(firstMonday, 14);
let passed = 0;
let activeUser = null;

async function check(label, verify) {
  await verify();
  passed += 1;
  console.log('PASS', label);
}

async function asUser(id) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.exec('set role authenticated');
  activeUser = id;
}

async function admin(sql, params = []) {
  const resume = activeUser;
  await db.exec('reset role');
  try {
    return await db.query(sql, params);
  } finally {
    if (resume) await asUser(resume);
  }
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

async function count(sql, params = []) {
  return Number((await admin(sql, params)).rows[0].n);
}

const templatePayload = {
  code: 'ADMIN-08-17',
  name: 'Hành chính 08:00–17:00',
  start_time: '08:00',
  end_time: '17:00',
  end_day_offset: 0,
  break_minutes: 45,
  late_grace_minutes: 5,
  early_grace_minutes: 5,
};
const rulePayload = (templateId) => ({
  name: 'Lịch hành chính T2–T7',
  template_id: templateId,
  weekday_mask: 63, // ISO Monday..Saturday; Sunday bit is 64.
  effective_from: firstMonday,
});
const assignPayload = (ruleId, siteId, employeeIds, from = firstMonday) => ({
  rule_id: ruleId,
  site_id: siteId,
  employee_ids: employeeIds,
  valid_from: from,
});
const materialize = (workspaceId, from, to, requestId = randomUUID()) =>
  rpc('materialize_hr_recurring_schedules', {
    p_workspace_id: workspaceId,
    p_from: from,
    p_to: to,
    p_request_id: requestId,
  });

try {
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    grant usage on schema auth to authenticated,anon;
    grant execute on function auth.uid() to authenticated,anon;`);
  for (const [name, id] of Object.entries(users)) {
    await db.query('insert into auth.users values($1,$2,now())', [
      id,
      `${name}@recurring.example.test`,
    ]);
  }
  const files = await readdir(new URL('../supabase/migrations/', import.meta.url));
  for (let n = 1; n <= 24; n += 1) {
    const file = files.find((entry) => entry.startsWith(`${String(n).padStart(3, '0')}_`));
    assert.ok(file, `migration ${n} exists`);
    try {
      await db.exec(
        await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'),
      );
    } catch (error) {
      throw new Error(`Migration ${file}: ${error.message}`, { cause: error });
    }
  }
  await check('clean migrations through 024 create recurring HR tables', async () => {
    const { rows } = await db.query(
      "select to_regclass('public.hr_shift_templates') template," +
        "to_regclass('public.hr_weekly_schedule_rules') rule," +
        "to_regclass('public.hr_recurring_assignments') assignment",
    );
    assert.equal(rows[0].template, 'hr_shift_templates');
    assert.equal(rows[0].rule, 'hr_weekly_schedule_rules');
    assert.equal(rows[0].assignment, 'hr_recurring_assignments');
  });

  await asUser(users.owner);
  const workspace = (await rpc('bootstrap_workspace', { p_name: 'Recurring HR A' })).id;
  await asUser(users.outsider);
  const otherWorkspace = (await rpc('bootstrap_workspace', { p_name: 'Recurring HR B' })).id;
  await asUser(users.owner);
  await rpc('add_workspace_member', {
    p_workspace_id: workspace,
    p_email: 'manager@recurring.example.test',
    p_role: 'manager',
  });
  await rpc('add_workspace_member', {
    p_workspace_id: workspace,
    p_email: 'staff@recurring.example.test',
    p_role: 'staff',
  });
  const site = await rpc('save_hr_attendance_site', {
    p_workspace_id: workspace,
    p_payload: { code: 'STORE-A', name: 'Synthetic Store A' },
  });
  const employee = await rpc('save_hr_employee', {
    p_workspace_id: workspace,
    p_payload: {
      code: 'REC-001',
      full_name: 'Synthetic recurring employee',
      employee_type: 'full_time',
      hire_date: '2026-01-01',
    },
  });
  const manualEmployee = await rpc('save_hr_employee', {
    p_workspace_id: workspace,
    p_payload: {
      code: 'REC-002',
      full_name: 'Synthetic manual employee',
      employee_type: 'part_time',
      hire_date: '2026-01-01',
    },
  });
  const noSiteEmployee = await rpc('save_hr_employee', {
    p_workspace_id: workspace,
    p_payload: { code: 'REC-003', full_name: 'Synthetic no-site employee' },
  });
  for (const person of [employee, manualEmployee]) {
    await rpc('save_hr_site_assignment', {
      p_workspace_id: workspace,
      p_payload: { employee_id: person.id, site_id: site.id, valid_from: firstMonday },
    });
  }

  await check('a shift template requires explicit break minutes', async () => {
    const { break_minutes: _ignored, ...withoutBreak } = templatePayload;
    await assert.rejects(
      () =>
        rpc('save_hr_shift_template', {
          p_workspace_id: workspace,
          p_payload: withoutBreak,
        }),
      /HR_RECURRING_INPUT|break/i,
    );
  });
  const template = await rpc('save_hr_shift_template', {
    p_workspace_id: workspace,
    p_payload: templatePayload,
  });
  const rule = await rpc('save_hr_weekly_schedule_rule', {
    p_workspace_id: workspace,
    p_payload: rulePayload(template.id),
  });
  await check('employee picker checks site membership on the planned start date', async () => {
    const eligible = await rpc('list_hr_schedule_employees', {
      p_workspace_id: workspace,
      p_query: employee.code,
      p_site_id: site.id,
      p_effective_date: firstMonday,
      p_page: 1,
      p_page_size: 25,
    });
    assert.ok(eligible.items.some((item) => item.id === employee.id));
    if (firstMonday !== todayInVietnam) {
      const beforeAssignment = await rpc('list_hr_schedule_employees', {
        p_workspace_id: workspace,
        p_query: employee.code,
        p_site_id: site.id,
        p_effective_date: todayInVietnam,
        p_page: 1,
        p_page_size: 25,
      });
      assert.ok(!beforeAssignment.items.some((item) => item.id === employee.id));
    }
  });
  await check('template and weekly rule retain explicit VND business-time policy', async () => {
    assert.equal(template.break_minutes, 45);
    assert.equal(Number(rule.weekday_mask), 63);
    assert.equal(String(rule.effective_from).slice(0, 10), firstMonday);
    assert.equal(
      await count('select count(*) n from public.hr_work_schedules where workspace_id=$1', [
        workspace,
      ]),
      0,
    );
  });
  await check(
    'calendar preview resolves Monday–Saturday and Sunday OFF without writing shifts',
    async () => {
      const preview = await rpc('preview_hr_recurring_schedule', {
        p_workspace_id: workspace,
        p_payload: {
          ...assignPayload(rule.id, site.id, [employee.id]),
          preview_from: firstMonday,
          preview_to: firstSunday,
        },
      });
      assert.equal(preview.summary.create, 6);
      assert.equal(preview.summary.off, 1);
      assert.equal(preview.summary.conflict, 0);
      assert.equal(preview.items.find((item) => item.work_date === firstMonday)?.status, 'CREATE');
      assert.equal(preview.items.find((item) => item.work_date === firstSunday)?.status, 'OFF');
      assert.equal(
        await count('select count(*) n from public.hr_work_schedules where workspace_id=$1', [
          workspace,
        ]),
        0,
      );
    },
  );
  await check('site assignment is required for every generated shift', async () => {
    const preview = await rpc('preview_hr_recurring_schedule', {
      p_workspace_id: workspace,
      p_payload: {
        ...assignPayload(rule.id, site.id, [noSiteEmployee.id]),
        preview_from: firstMonday,
        preview_to: firstSunday,
      },
    });
    assert.ok(preview.summary.conflict > 0);
    await assert.rejects(
      () =>
        rpc('assign_hr_recurring_schedule', {
          p_workspace_id: workspace,
          p_payload: assignPayload(rule.id, site.id, [noSiteEmployee.id]),
          p_request_id: randomUUID(),
        }),
      /HR_RECURRING_SITE|HR_RECURRING_CONFLICT/,
    );
  });

  const assignRequest = randomUUID();
  const assigned = await rpc('assign_hr_recurring_schedule', {
    p_workspace_id: workspace,
    p_payload: assignPayload(rule.id, site.id, [employee.id]),
    p_request_id: assignRequest,
  });
  await check(
    'assignment materializes only a bounded horizon with correct paid minutes',
    async () => {
      assert.equal(assigned.created_count, 1);
      const { rows } = await admin(
        `select id,work_date,planned_start_at,planned_end_at,break_minutes,planned_minutes,site_id
       from public.hr_work_schedules where workspace_id=$1 and employee_id=$2
       order by work_date`,
        [workspace, employee.id],
      );
      assert.ok(rows.length >= 6);
      assert.ok(rows.length <= 60);
      assert.equal(isoDay(rows[0].work_date), firstMonday);
      assert.equal(
        new Date(rows[0].planned_start_at).toISOString(),
        `${firstMonday}T01:00:00.000Z`,
      );
      assert.equal(new Date(rows[0].planned_end_at).toISOString(), `${firstMonday}T10:00:00.000Z`);
      assert.equal(rows[0].break_minutes, 45);
      assert.equal(rows[0].planned_minutes, 495);
      assert.equal(rows[0].site_id, site.id);
      assert.equal(
        rows.some((row) => isoDay(row.work_date) === firstSunday),
        false,
      );
      await asUser(users.owner);
    },
  );
  await check(
    'template, rule and assignment mutations record the authenticated actor',
    async () => {
      const { rows } = await admin(
        `select action,actor_id from public.audit_events
       where workspace_id=$1 and action in
        ('hr.shift_template_saved','hr.weekly_rule_saved','hr.recurring_assignment_created')
       order by created_at,id`,
        [workspace],
      );
      assert.equal(rows.filter((row) => row.action === 'hr.shift_template_saved').length, 1);
      assert.equal(rows.filter((row) => row.action === 'hr.weekly_rule_saved').length, 1);
      assert.equal(
        rows.filter((row) => row.action === 'hr.recurring_assignment_created').length,
        1,
      );
      assert.ok(rows.every((row) => row.actor_id === users.owner));
    },
  );
  await check('closing an assignment cannot erase a past expected-work period', async () => {
    const yesterday = addDays(todayInVietnam, -1);
    const { rows } = await admin(
      `insert into public.hr_recurring_assignments
       (workspace_id,employee_id,rule_id,site_id,valid_from,created_request_id,created_by)
       values($1,$2,$3,$4,$5,$6,$7) returning id`,
      [workspace, noSiteEmployee.id, rule.id, site.id, yesterday, randomUUID(), users.owner],
    );
    await assert.rejects(
      () =>
        rpc('close_hr_recurring_assignment', {
          p_workspace_id: workspace,
          p_assignment_id: rows[0].id,
          p_valid_to: yesterday,
          p_reason: 'Attempted retroactive schedule closure',
          p_request_id: randomUUID(),
        }),
      /HR_RECURRING_HISTORY/,
    );
    const saved = await admin('select valid_to from public.hr_recurring_assignments where id=$1', [
      rows[0].id,
    ]);
    assert.equal(saved.rows[0].valid_to, null);
    await admin('delete from public.hr_recurring_assignments where id=$1', [rows[0].id]);
  });
  await check(
    'lost response retry is idempotent; same request with different payload is rejected',
    async () => {
      const before = await count(
        'select count(*) n from public.hr_work_schedules where workspace_id=$1 and employee_id=$2',
        [workspace, employee.id],
      );
      await asUser(users.owner);
      const retry = await rpc('assign_hr_recurring_schedule', {
        p_workspace_id: workspace,
        p_payload: assignPayload(rule.id, site.id, [employee.id]),
        p_request_id: assignRequest,
      });
      assert.deepEqual(retry, assigned);
      await assert.rejects(
        () =>
          rpc('assign_hr_recurring_schedule', {
            p_workspace_id: workspace,
            p_payload: assignPayload(rule.id, site.id, [manualEmployee.id]),
            p_request_id: assignRequest,
          }),
        /HR_RECURRING_REQUEST_CONFLICT|HR_RECURRING_IDEMPOTENCY/,
      );
      assert.equal(
        await count(
          'select count(*) n from public.hr_work_schedules where workspace_id=$1 and employee_id=$2',
          [workspace, employee.id],
        ),
        before,
      );
      await asUser(users.owner);
    },
  );
  await check(
    'materialization retry creates no duplicate shifts and rejects unbounded ranges',
    async () => {
      const first = await materialize(workspace, firstMonday, firstSunday);
      const second = await materialize(workspace, firstMonday, firstSunday);
      assert.equal(first.created, 0);
      assert.equal(second.created, 0);
      assert.ok(second.keep_generated >= 6);
      await assert.rejects(
        () => materialize(workspace, firstMonday, addDays(firstMonday, 365)),
        /HR_RECURRING_INPUT|range|limit/i,
      );
    },
  );

  await check(
    'manual shift survives recurring assignment and remains the attendance source',
    async () => {
      const manual = await rpc('save_hr_work_schedule', {
        p_workspace_id: workspace,
        p_payload: {
          employee_id: manualEmployee.id,
          work_date: firstMonday,
          planned_start_at: `${firstMonday}T08:30:00+07:00`,
          planned_end_at: `${firstMonday}T16:30:00+07:00`,
          break_minutes: 30,
          shift_name: 'Manual exception',
        },
      });
      await rpc('bind_hr_work_schedule_site', {
        p_workspace_id: workspace,
        p_schedule_id: manual.id,
        p_site_id: site.id,
      });
      const preview = await rpc('preview_hr_recurring_schedule', {
        p_workspace_id: workspace,
        p_payload: {
          ...assignPayload(rule.id, site.id, [manualEmployee.id]),
          preview_from: firstMonday,
          preview_to: firstSunday,
        },
      });
      assert.equal(
        preview.items.find((item) => item.work_date === firstMonday)?.status,
        'KEEP_MANUAL',
      );
      await rpc('assign_hr_recurring_schedule', {
        p_workspace_id: workspace,
        p_payload: assignPayload(rule.id, site.id, [manualEmployee.id]),
        p_request_id: randomUUID(),
      });
      const { rows } = await admin(
        'select id,planned_minutes from public.hr_work_schedules where workspace_id=$1 and employee_id=$2 and work_date=$3',
        [workspace, manualEmployee.id, firstMonday],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, manual.id);
      assert.equal(rows[0].planned_minutes, 450);
      await asUser(users.owner);
    },
  );
  await check(
    'attendance on a generated shift is retained across repeated synchronization',
    async () => {
      const { rows } = await admin(
        'select id,planned_start_at,planned_end_at from public.hr_work_schedules where workspace_id=$1 and employee_id=$2 and work_date=$3',
        [workspace, employee.id, firstMonday],
      );
      await asUser(users.owner);
      const shift = rows[0];
      const attendance = await rpc('save_hr_attendance', {
        p_workspace_id: workspace,
        p_payload: {
          schedule_id: shift.id,
          clock_in_at: shift.planned_start_at,
          clock_out_at: shift.planned_end_at,
        },
        p_request_id: randomUUID(),
      });
      assert.equal(attendance.schedule_id, shift.id);
      await materialize(workspace, firstMonday, firstSunday);
      const after = await admin(
        'select id,planned_start_at,planned_end_at from public.hr_work_schedules where workspace_id=$1 and employee_id=$2 and work_date=$3',
        [workspace, employee.id, firstMonday],
      );
      assert.equal(after.rows.length, 1);
      assert.equal(after.rows[0].id, shift.id);
      assert.equal(
        new Date(after.rows[0].planned_start_at).toISOString(),
        new Date(shift.planned_start_at).toISOString(),
      );
      await asUser(users.owner);
    },
  );

  await check('one-day override preserves before/after audit and idempotency', async () => {
    const day = addDays(firstMonday, 8);
    const [generated] = (
      await admin(
        'select id from public.hr_work_schedules where workspace_id=$1 and employee_id=$2 and work_date=$3',
        [workspace, employee.id, day],
      )
    ).rows;
    const args = {
      p_workspace_id: workspace,
      p_schedule_id: generated.id,
      p_payload: {
        planned_start_at: `${day}T09:00:00+07:00`,
        planned_end_at: `${day}T18:00:00+07:00`,
        break_minutes: 30,
        shift_name: 'Approved one-day change',
        site_id: site.id,
      },
      p_reason: 'Manager approved a one-day schedule change',
      p_request_id: randomUUID(),
    };
    const [attended] = (
      await admin('select id from public.hr_work_schedules where employee_id=$1 and work_date=$2', [
        employee.id,
        firstMonday,
      ])
    ).rows;
    await assert.rejects(
      () => rpc('override_hr_recurring_shift', { ...args, p_schedule_id: attended.id }),
      /HR_RECURRING_LOCKED/,
    );
    const changed = await rpc('override_hr_recurring_shift', args);
    assert.equal((await rpc('override_hr_recurring_shift', args)).schedule.id, changed.schedule.id);
    const [current] = (
      await admin(
        'select id,source_kind,planned_minutes from public.hr_work_schedules where workspace_id=$1 and employee_id=$2 and work_date=$3',
        [workspace, employee.id, day],
      )
    ).rows;
    assert.equal(current.id, changed.schedule.id);
    assert.equal(current.source_kind, 'manual');
    assert.equal(current.planned_minutes, 510);
    const [audit] = (
      await admin(
        "select details from public.audit_events where workspace_id=$1 and action='hr.recurring_manual_override' order by created_at desc limit 1",
        [workspace],
      )
    ).rows;
    assert.equal(audit.details.before.id, generated.id);
    assert.equal(audit.details.after.id, current.id);
  });

  await check(
    'manager can schedule; staff and outsider cannot read or mutate HR scheduling data',
    async () => {
      await asUser(users.manager);
      const managed = await rpc('list_hr_recurring_setup', {
        p_workspace_id: workspace,
        p_kind: 'templates',
        p_page: 1,
        p_page_size: 10,
      });
      assert.ok(managed.total >= 1);
      await asUser(users.staff);
      await assert.rejects(
        () =>
          rpc('save_hr_shift_template', {
            p_workspace_id: workspace,
            p_payload: { ...templatePayload, code: 'UNAUTHORIZED' },
          }),
        /quyền|permission|role/i,
      );
      const { rows } = await db.query(
        'select count(*)::integer n from public.hr_shift_templates where workspace_id=$1',
        [workspace],
      );
      assert.equal(rows[0].n, 0);
      await assert.rejects(
        () =>
          db.query(
            "insert into public.hr_shift_templates(workspace_id,code,name,start_time,end_time,end_day_offset,break_minutes,created_by) values($1,'BAD','Bad','08:00','17:00',0,45,$2)",
            [workspace, users.staff],
          ),
        /permission denied/,
      );
      await asUser(users.owner);
      await assert.rejects(
        () =>
          rpc('list_hr_recurring_setup', {
            p_workspace_id: otherWorkspace,
            p_kind: 'templates',
            p_page: 1,
            p_page_size: 10,
          }),
        /quyền|permission|role/i,
      );
    },
  );

  let nightRule;
  await check('overnight template resolves work date and next-day end correctly', async () => {
    const nightTemplate = await rpc('save_hr_shift_template', {
      p_workspace_id: workspace,
      p_payload: {
        code: 'NIGHT-22-06',
        name: 'Night 22–06',
        start_time: '22:00',
        end_time: '06:00',
        end_day_offset: 1,
        break_minutes: 30,
        late_grace_minutes: 0,
        early_grace_minutes: 0,
      },
    });
    nightRule = await rpc('save_hr_weekly_schedule_rule', {
      p_workspace_id: workspace,
      p_payload: {
        name: 'Monday night',
        template_id: nightTemplate.id,
        weekday_mask: 1,
        effective_from: firstMonday,
      },
    });
    await rpc('save_hr_site_assignment', {
      p_workspace_id: workspace,
      p_payload: { employee_id: noSiteEmployee.id, site_id: site.id, valid_from: firstMonday },
    });
    const preview = await rpc('preview_hr_recurring_schedule', {
      p_workspace_id: workspace,
      p_payload: {
        ...assignPayload(nightRule.id, site.id, [noSiteEmployee.id]),
        preview_from: firstMonday,
        preview_to: firstMonday,
      },
    });
    const monday = preview.items.find((item) => item.work_date === firstMonday);
    assert.equal(monday.status, 'CREATE');
    assert.equal(new Date(monday.planned_start_at).toISOString(), `${firstMonday}T15:00:00.000Z`);
    assert.equal(new Date(monday.planned_end_at).toISOString(), `${firstMonday}T23:00:00.000Z`);
  });

  await check(
    'bulk preview resolves 50 and 200 employees without precreating daily rows',
    async () => {
      // Fixtures are inserted by the local test superuser only. Application writes still use RPCs.
      await admin(
        `insert into public.hr_employees(workspace_id,code,full_name,employee_type,created_by)
       select $1,'BULK-'||lpad(n::text,3,'0'),'Synthetic bulk '||n,
        case when n%2=0 then 'part_time' else 'full_time' end,$2
       from generate_series(1,200) n`,
        [workspace, users.owner],
      );
      await admin(
        `insert into public.hr_site_assignments(workspace_id,employee_id,site_id,valid_from,created_by)
       select e.workspace_id,e.id,$2,$3,$4 from public.hr_employees e
       where e.workspace_id=$1 and e.code like 'BULK-%'`,
        [workspace, site.id, firstMonday, users.owner],
      );
      const ids = (
        await admin(
          "select id from public.hr_employees where workspace_id=$1 and code like 'BULK-%' order by code",
          [workspace],
        )
      ).rows.map((row) => row.id);
      assert.equal(ids.length, 200);
      const paged = await rpc('list_hr_schedule_employees', {
        p_workspace_id: workspace,
        p_query: 'BULK-',
        p_department_id: null,
        p_employee_type: 'part_time',
        p_site_id: null,
        p_page: 2,
        p_page_size: 25,
      });
      assert.equal(paged.total, 100);
      assert.equal(paged.items.length, 25);
      assert.ok(paged.items.every((item) => item.employee_type === 'part_time'));
      for (const size of [50, 200]) {
        const preview = await rpc('preview_hr_recurring_schedule', {
          p_workspace_id: workspace,
          p_payload: {
            ...assignPayload(rule.id, site.id, ids.slice(0, size)),
            preview_from: firstMonday,
            preview_to: firstMonday,
          },
        });
        assert.equal(preview.summary.employees, size);
        assert.equal(preview.summary.create, size);
        assert.equal(preview.items.length, size);
      }
      await assert.rejects(
        () =>
          rpc('preview_hr_recurring_schedule', {
            p_workspace_id: workspace,
            p_payload: {
              ...assignPayload(rule.id, site.id, [...ids, employee.id]),
              preview_from: firstMonday,
              preview_to: firstMonday,
            },
          }),
        /HR_RECURRING_INPUT|200|limit/i,
      );
      assert.equal(
        await count(
          "select count(*) n from public.hr_work_schedules s join public.hr_employees e on e.id=s.employee_id where s.workspace_id=$1 and e.code like 'BULK-%'",
          [workspace],
        ),
        0,
      );
    },
  );

  await check(
    'approved payroll period blocks new generated shifts without partial writes',
    async () => {
      const period = await admin(
        `insert into public.hr_payroll_periods(workspace_id,period_start,period_end,status,
       approved_at,approved_by,created_by)
       values($1,$2,$2,'APPROVED',clock_timestamp(),$3,$3) returning id`,
        [workspace, lockedMonday, users.owner],
      );
      assert.ok(period.rows[0].id);
      await asUser(users.owner);
      await assert.rejects(
        () =>
          rpc('assign_hr_recurring_schedule', {
            p_workspace_id: workspace,
            p_payload: assignPayload(nightRule.id, site.id, [noSiteEmployee.id], lockedMonday),
            p_request_id: randomUUID(),
          }),
        /HR_RECURRING_LOCKED|HR_PERIOD_LOCKED|HR_RECURRING_CONFLICT:.*PAYROLL_LOCKED/,
      );
      assert.equal(
        await count(
          'select count(*) n from public.hr_recurring_assignments where workspace_id=$1 and employee_id=$2',
          [workspace, noSiteEmployee.id],
        ),
        0,
      );
      await asUser(users.owner);
    },
  );

  console.log(`${passed} recurring HR PGlite checks passed`);
} finally {
  await db.close();
}
