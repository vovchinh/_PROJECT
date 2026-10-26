-- Compact fixed-weekly HR schedules. 023 remains the QR/attendance source of truth:
-- only bounded, persisted hr_work_schedules are consumed by QR and payroll.
begin;

do $$begin
 if to_regclass('public.hr_work_schedules') is null
    or to_regclass('public.hr_site_assignments') is null
    or to_regclass('public.hr_payroll_periods') is null then
  raise exception 'HR_RECURRING_PREREQUISITE: Apply HR migrations 017-020 and 023 first.';
 end if;
 if to_regclass('public.hr_shift_templates') is not null then
  raise exception 'HR_RECURRING_ALREADY_INSTALLED: 024 runs once.';
 end if;
end $$;

create table public.hr_shift_templates (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id),
 code text not null check(length(btrim(code)) between 1 and 80),
 name text not null check(length(btrim(name)) between 1 and 120),
 start_time time(0) not null,end_time time(0) not null,
 end_day_offset smallint not null default 0 check(end_day_offset in (0,1)),
 break_minutes integer not null check(break_minutes between 0 and 600),
 late_grace_minutes integer not null default 0 check(late_grace_minutes between 0 and 120),
 early_grace_minutes integer not null default 0 check(early_grace_minutes between 0 and 120),
 is_active boolean not null default true,
 revision integer not null default 1 check(revision between 1 and 1000000),
 created_by uuid not null references auth.users(id),updated_by uuid references auth.users(id),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(workspace_id,id),unique(workspace_id,code),
 check((extract(epoch from end_time)-extract(epoch from start_time))/60
       +1440*end_day_offset between 1 and 1440),
 check((extract(epoch from end_time)-extract(epoch from start_time))/60
       +1440*end_day_offset>break_minutes)
);
create unique index hr_shift_templates_code_normalized
 on public.hr_shift_templates(workspace_id,app_private.catalog_normalize(code));
create index hr_shift_templates_active on public.hr_shift_templates(workspace_id,is_active,name,id);

create table public.hr_weekly_schedule_rules (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id),
 name text not null check(length(btrim(name)) between 1 and 200),
 template_id uuid not null,
 template_revision integer not null check(template_revision between 1 and 1000000),
 weekday_mask integer not null check(weekday_mask between 1 and 127),
 coverage_mode text not null default 'COMPLETE_WEEK' check(coverage_mode='COMPLETE_WEEK'),
 business_timezone text not null default 'Asia/Ho_Chi_Minh' check(business_timezone='Asia/Ho_Chi_Minh'),
 effective_from date not null,effective_until date,
 is_active boolean not null default true,
 revision integer not null default 1 check(revision between 1 and 1000000),
 created_by uuid not null references auth.users(id),updated_by uuid references auth.users(id),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(workspace_id,id),
 foreign key(workspace_id,template_id) references public.hr_shift_templates(workspace_id,id),
 check(isfinite(effective_from) and (effective_until is null or
  (isfinite(effective_until) and effective_until>=effective_from)))
);
create index hr_weekly_rules_dates on public.hr_weekly_schedule_rules
 (workspace_id,is_active,effective_from,effective_until,id);

create table public.hr_recurring_assignments (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id),
 employee_id uuid not null,rule_id uuid not null,site_id uuid not null,
 valid_from date not null,valid_to date,
 created_request_id uuid not null,
 created_by uuid not null references auth.users(id),updated_by uuid references auth.users(id),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(workspace_id,id),
 foreign key(workspace_id,employee_id) references public.hr_employees(workspace_id,id),
 foreign key(workspace_id,rule_id) references public.hr_weekly_schedule_rules(workspace_id,id),
 foreign key(workspace_id,site_id) references public.hr_attendance_sites(workspace_id,id),
 check(isfinite(valid_from) and (valid_to is null or
  (isfinite(valid_to) and valid_to>=valid_from)))
);
create index hr_recurring_assignments_employee_dates on public.hr_recurring_assignments
 (workspace_id,employee_id,valid_from,valid_to);
create index hr_recurring_assignments_rule_site on public.hr_recurring_assignments
 (workspace_id,rule_id,site_id,valid_from,valid_to);

-- RPCs alone cannot protect concurrent privileged writers. This guard also
-- prevents any two complete-week rules from owning one employee/date.
create function app_private.hr_recurring_assignment_guard() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtext(new.workspace_id::text||':hr_recurring:'||new.employee_id::text));
 if tg_op='UPDATE' and (new.workspace_id,new.employee_id,new.rule_id,new.site_id,new.valid_from)
   is distinct from (old.workspace_id,old.employee_id,old.rule_id,old.site_id,old.valid_from) then
  raise exception 'HR_RECURRING_IDENTITY: Close and create a new assignment.';
 end if;
 if exists(select 1 from public.hr_recurring_assignments a
  where a.workspace_id=new.workspace_id and a.employee_id=new.employee_id and a.id<>new.id
    and a.valid_from<=coalesce(new.valid_to,'infinity'::date)
    and new.valid_from<=coalesce(a.valid_to,'infinity'::date)) then
  raise exception 'HR_RECURRING_CONFLICT: Employee schedule dates overlap.';
 end if;
 return new;
end $$;
create trigger hr_recurring_assignment_guard_before before insert or update
 on public.hr_recurring_assignments for each row
 execute function app_private.hr_recurring_assignment_guard();

-- This is provenance, not a replacement for the existing daily shift.
alter table public.hr_work_schedules
 add column source_kind text not null default 'manual'
  check(source_kind in ('manual','recurring')),
 add column recurring_assignment_id uuid,
 add column recurring_rule_id uuid,
 add column recurring_template_id uuid,
 add column recurring_rule_revision integer,
 add column recurring_template_revision integer;
alter table public.hr_work_schedules add constraint hr_schedule_recurring_provenance check(
 (source_kind='manual' and recurring_assignment_id is null and recurring_rule_id is null
  and recurring_template_id is null and recurring_rule_revision is null
  and recurring_template_revision is null)
 or
 (source_kind='recurring' and recurring_assignment_id is not null and recurring_rule_id is not null
  and recurring_template_id is not null and recurring_rule_revision is not null
  and recurring_template_revision is not null));
alter table public.hr_work_schedules add constraint hr_schedule_recurring_assignment_fk
 foreign key(workspace_id,recurring_assignment_id)
 references public.hr_recurring_assignments(workspace_id,id);
alter table public.hr_work_schedules add constraint hr_schedule_recurring_rule_fk
 foreign key(workspace_id,recurring_rule_id)
 references public.hr_weekly_schedule_rules(workspace_id,id);
alter table public.hr_work_schedules add constraint hr_schedule_recurring_template_fk
 foreign key(workspace_id,recurring_template_id)
 references public.hr_shift_templates(workspace_id,id);
create unique index hr_work_schedules_recurring_source
 on public.hr_work_schedules(workspace_id,recurring_assignment_id,work_date)
 where source_kind='recurring';

-- Prevent all new/changed historical shifts inside a calculated or locked
-- payroll period. A generated shift is immutable: edits need an explicit
-- one-day manual override with audit, and attendance always blocks replacement.
create function app_private.hr_recurring_schedule_guard() returns trigger
language plpgsql security definer set search_path='' as $$
declare row_work public.hr_work_schedules;
begin
 if tg_op='DELETE' then row_work:=old; else row_work:=new;end if;
 if tg_op='UPDATE' and old.source_kind='recurring' then
  raise exception 'HR_RECURRING_GENERATED_LOCKED: Use an approved one-day override.';
 end if;
 if tg_op='UPDATE' and old.source_kind<>new.source_kind then
  raise exception 'HR_RECURRING_SOURCE_LOCKED: Shift origin cannot be changed.';
 end if;
 if exists(select 1 from public.hr_payroll_periods p
   where p.workspace_id=row_work.workspace_id and row_work.work_date between p.period_start and p.period_end
    and p.status in ('CALCULATED','REVIEWED','APPROVED','PAID'))
   or (tg_op in ('UPDATE','DELETE') and exists(select 1 from public.hr_payroll_periods p
    where p.workspace_id=old.workspace_id and old.work_date between p.period_start and p.period_end
      and p.status in ('CALCULATED','REVIEWED','APPROVED','PAID'))) then
  raise exception 'HR_RECURRING_LOCKED: Payroll period already calculated or approved.';
 end if;
 if tg_op='DELETE' then return old;end if;
 return new;
end $$;
create trigger hr_recurring_schedule_guard_before before insert or update or delete
 on public.hr_work_schedules for each row
 execute function app_private.hr_recurring_schedule_guard();

-- An idempotency receipt stores one exact result, including selected employees.
create table app_private.hr_recurring_requests (
 workspace_id uuid not null references public.workspaces(id),request_id uuid not null,
 action text not null,payload_hash text not null,result jsonb not null,
 created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),
 primary key(workspace_id,request_id)
);
alter table app_private.hr_recurring_requests enable row level security;
revoke all on app_private.hr_recurring_requests from public,anon,authenticated;

do $$declare t text;begin
 foreach t in array array['hr_shift_templates','hr_weekly_schedule_rules','hr_recurring_assignments'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('create policy hr_manager_read on public.%I for select to authenticated using (app_private.member_role(workspace_id) in (''owner'',''manager''))',t);
  execute format('grant select on public.%I to authenticated',t);
 end loop;
end $$;

-- Helper used by preview, initial assignment materialization and QR's future
-- just-in-time wrapper. It never mutates an existing manual/attended shift.
create function app_private.hr_recurring_shift_status(
 p_workspace_id uuid,p_employee_id uuid,p_day date,p_rule_id uuid,p_site_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare r public.hr_weekly_schedule_rules;t public.hr_shift_templates;
 a public.hr_recurring_assignments;s public.hr_work_schedules;
 start_value timestamptz;end_value timestamptz;state_value text;reason_value text:='';
begin
 select * into r from public.hr_weekly_schedule_rules
  where workspace_id=p_workspace_id and id=p_rule_id;
 if not found or not r.is_active or p_day<r.effective_from
   or (r.effective_until is not null and p_day>r.effective_until) then
  return jsonb_build_object('employee_id',p_employee_id,'work_date',p_day,'status','CONFLICT',
    'site_id',p_site_id,'reason','RULE_OUTSIDE_EFFECTIVE_DATES');
 end if;
 select * into t from public.hr_shift_templates
  where workspace_id=p_workspace_id and id=r.template_id;
 if not found or not t.is_active or t.revision<>r.template_revision then
  return jsonb_build_object('employee_id',p_employee_id,'work_date',p_day,'status','CONFLICT',
    'site_id',p_site_id,'reason','TEMPLATE_NOT_CURRENT');
 end if;
 if (r.weekday_mask & (1 << (extract(isodow from p_day)::integer-1)))=0 then
  return jsonb_build_object('employee_id',p_employee_id,'work_date',p_day,'status','OFF',
    'site_id',p_site_id,'reason','WEEKLY_DAY_OFF');
 end if;
 start_value:=(p_day+t.start_time) at time zone 'Asia/Ho_Chi_Minh';
 end_value:=((p_day+t.end_day_offset)+t.end_time) at time zone 'Asia/Ho_Chi_Minh';
 select * into s from public.hr_work_schedules
  where workspace_id=p_workspace_id and employee_id=p_employee_id and work_date=p_day;
 if found then
  if s.source_kind='manual' then state_value:='KEEP_MANUAL';reason_value:='MANUAL_DATE_OVERRIDE';
  elsif s.recurring_rule_id=r.id and s.site_id=p_site_id
    and s.planned_start_at=start_value and s.planned_end_at=end_value
    and s.break_minutes=t.break_minutes and s.late_grace_minutes=t.late_grace_minutes
    and s.early_grace_minutes=t.early_grace_minutes then
   state_value:='KEEP_GENERATED';reason_value:='ALREADY_MATERIALIZED';
  else state_value:='CONFLICT';reason_value:='EXISTING_GENERATED_SHIFT_DIFFERS';end if;
 elsif exists(select 1 from public.hr_payroll_periods p
   where p.workspace_id=p_workspace_id and p_day between p.period_start and p.period_end
     and p.status in ('CALCULATED','REVIEWED','APPROVED','PAID')) then
  state_value:='CONFLICT';reason_value:='PAYROLL_LOCKED';
 elsif not exists(select 1 from public.hr_site_assignments sa
   where sa.workspace_id=p_workspace_id and sa.employee_id=p_employee_id and sa.site_id=p_site_id
    and p_day>=sa.valid_from and (sa.valid_to is null or p_day<=sa.valid_to)) then
  state_value:='CONFLICT';reason_value:='SITE_ASSIGNMENT_MISSING';
 else state_value:='CREATE';end if;
 return jsonb_build_object('employee_id',p_employee_id,'work_date',p_day,'status',state_value,
  'site_id',p_site_id,'planned_start_at',start_value,'planned_end_at',end_value,
  'break_minutes',t.break_minutes,'reason',reason_value);
end $$;

-- No grant to browser roles. Caller must either be a checked manager RPC or
-- an independently authenticated QR wrapper resolving its own employee.
create function app_private.hr_recurring_materialize_employee(
 p_workspace_id uuid,p_employee_id uuid,p_from date,p_to date)
returns jsonb language plpgsql security definer set search_path='' as $$
declare day_value date;assignment_row public.hr_recurring_assignments;
 rule_row public.hr_weekly_schedule_rules;template_row public.hr_shift_templates;
 outcome jsonb;status_value text;created_count integer:=0;off_count integer:=0;
 manual_count integer:=0;existing_count integer:=0;
begin
 if p_from is null or p_to is null or not isfinite(p_from) or not isfinite(p_to)
   or p_to<p_from or p_to-p_from>59 then
  raise exception 'HR_RECURRING_INPUT: Materialization range must be 1-60 days.';
 end if;
 perform pg_advisory_xact_lock(hashtext(p_workspace_id::text||':hr_recurring:'||p_employee_id::text));
 for day_value in select d::date from generate_series(p_from,p_to,interval '1 day') d loop
  select * into assignment_row from public.hr_recurring_assignments a
   where a.workspace_id=p_workspace_id and a.employee_id=p_employee_id
    and day_value>=a.valid_from and (a.valid_to is null or day_value<=a.valid_to);
  if not found then continue;end if;
  outcome:=app_private.hr_recurring_shift_status(p_workspace_id,p_employee_id,day_value,
   assignment_row.rule_id,assignment_row.site_id);
  status_value:=outcome->>'status';
  if status_value='OFF' then off_count:=off_count+1;continue;end if;
  if status_value='KEEP_MANUAL' then manual_count:=manual_count+1;continue;end if;
  if status_value='KEEP_GENERATED' then existing_count:=existing_count+1;continue;end if;
  if status_value<>'CREATE' then
   raise exception 'HR_RECURRING_CONFLICT: Employee % on %: %',p_employee_id,day_value,outcome->>'reason';
  end if;
  select * into rule_row from public.hr_weekly_schedule_rules where workspace_id=p_workspace_id and id=assignment_row.rule_id;
  select * into template_row from public.hr_shift_templates where workspace_id=p_workspace_id and id=rule_row.template_id;
  insert into public.hr_work_schedules(workspace_id,employee_id,site_id,work_date,
   planned_start_at,planned_end_at,break_minutes,late_grace_minutes,early_grace_minutes,
   shift_name,source_kind,recurring_assignment_id,recurring_rule_id,recurring_template_id,
   recurring_rule_revision,recurring_template_revision,created_by)
   values(p_workspace_id,p_employee_id,assignment_row.site_id,day_value,
    (outcome->>'planned_start_at')::timestamptz,(outcome->>'planned_end_at')::timestamptz,
    template_row.break_minutes,template_row.late_grace_minutes,template_row.early_grace_minutes,
    template_row.name,'recurring',assignment_row.id,rule_row.id,template_row.id,
    rule_row.revision,template_row.revision,auth.uid());
  created_count:=created_count+1;
 end loop;
 return jsonb_build_object('created',created_count,'off',off_count,
  'keep_manual',manual_count,'keep_generated',existing_count,
  'kept',manual_count+existing_count);
end $$;

-- QR wrapper may ensure only yesterday/today/tomorrow in Vietnam to catch
-- overnight and early arrivals. It cannot be used for a broad staff backfill.
create function app_private.hr_ensure_recurring_for_employee(
 p_workspace_id uuid,p_employee_id uuid,p_from date,p_to date)
returns jsonb language plpgsql security definer set search_path='' as $$
declare today_vn date:=(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
begin
 if p_from is null or p_to is null or p_from<today_vn-1 or p_to>today_vn+1
   or p_to<p_from or p_to-p_from>2 then
  raise exception 'HR_RECURRING_INPUT: QR ensure is limited to adjacent Vietnam dates.';
 end if;
 return app_private.hr_recurring_materialize_employee(p_workspace_id,p_employee_id,p_from,p_to);
end $$;

create function app_private.hr_assert_recurring_period_coverage(
 p_workspace_id uuid,p_period_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare period_row public.hr_payroll_periods;gap_employee uuid;gap_day date;
begin
 select * into period_row from public.hr_payroll_periods
  where workspace_id=p_workspace_id and id=p_period_id;
 if not found then raise exception 'HR_PERIOD_NOT_FOUND';end if;
 select a.employee_id,d.day_value into gap_employee,gap_day
 from public.hr_recurring_assignments a
 join public.hr_weekly_schedule_rules r on r.workspace_id=a.workspace_id and r.id=a.rule_id
 cross join lateral (select g::date day_value from generate_series(
   greatest(a.valid_from,r.effective_from,period_row.period_start),
   least(coalesce(a.valid_to,period_row.period_end),coalesce(r.effective_until,period_row.period_end),period_row.period_end),
   interval '1 day') g) d
 where a.workspace_id=p_workspace_id
  and (r.weekday_mask & (1 << (extract(isodow from d.day_value)::integer-1)))<>0
  and not exists(select 1 from public.hr_work_schedules s
   where s.workspace_id=a.workspace_id and s.employee_id=a.employee_id and s.work_date=d.day_value)
 order by a.employee_id,d.day_value limit 1;
 if gap_employee is not null then
  raise exception 'HR_RECURRING_COVERAGE: Missing shift for employee % on %.',gap_employee,gap_day;
 end if;
end $$;

revoke all on function app_private.hr_recurring_assignment_guard(),
 app_private.hr_recurring_schedule_guard(),
 app_private.hr_recurring_shift_status(uuid,uuid,date,uuid,uuid),
 app_private.hr_recurring_materialize_employee(uuid,uuid,date,date),
 app_private.hr_ensure_recurring_for_employee(uuid,uuid,date,date),
 app_private.hr_assert_recurring_period_coverage(uuid,uuid)
 from public,anon,authenticated;

create function public.save_hr_shift_template(p_workspace_id uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare rid uuid;old_row public.hr_shift_templates;result public.hr_shift_templates;
 code_value text;name_value text;start_value time(0);end_value time(0);
 offset_value smallint;break_value integer;late_value integer;early_value integer;active_value boolean;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 if jsonb_typeof(p_payload) is distinct from 'object' or exists(
  select 1 from jsonb_object_keys(p_payload) k where k not in
   ('id','code','name','start_time','end_time','end_day_offset','break_minutes',
    'late_grace_minutes','early_grace_minutes','is_active')) then
  raise exception 'HR_RECURRING_INPUT: Unsupported shift template field.';
 end if;
 if jsonb_typeof(p_payload->'break_minutes') is distinct from 'number' then
  raise exception 'HR_RECURRING_BREAK_REQUIRED: Choose explicit unpaid break minutes, including zero.';
 end if;
 rid:=nullif(p_payload->>'id','')::uuid;
 code_value:=upper(btrim(p_payload->>'code'));name_value:=btrim(p_payload->>'name');
 start_value:=(p_payload->>'start_time')::time(0);
 end_value:=(p_payload->>'end_time')::time(0);
 offset_value:=(p_payload->>'end_day_offset')::smallint;
 break_value:=(p_payload->>'break_minutes')::integer;
 late_value:=coalesce((p_payload->>'late_grace_minutes')::integer,0);
 early_value:=coalesce((p_payload->>'early_grace_minutes')::integer,0);
 active_value:=coalesce((p_payload->>'is_active')::boolean,true);
 if code_value is null or length(code_value) not between 1 and 80
  or name_value is null or length(name_value) not between 1 and 120
  or start_value is null or end_value is null or offset_value not in (0,1)
  or break_value not between 0 and 600 or late_value not between 0 and 120
  or early_value not between 0 and 120
  or (extract(epoch from end_value)-extract(epoch from start_value))/60
       +1440*offset_value not between break_value+1 and 1440 then
  raise exception 'HR_RECURRING_INPUT: Invalid template time or explicit break.';
 end if;
 if rid is null then
  insert into public.hr_shift_templates(workspace_id,code,name,start_time,end_time,
    end_day_offset,break_minutes,late_grace_minutes,early_grace_minutes,is_active,created_by)
   values(p_workspace_id,code_value,name_value,start_value,end_value,offset_value,
    break_value,late_value,early_value,active_value,auth.uid()) returning * into result;
 else
  select * into old_row from public.hr_shift_templates
   where workspace_id=p_workspace_id and id=rid for update;
  if not found then raise exception 'HR_RECURRING_NOT_FOUND: Shift template is outside this workspace.';end if;
  if exists(select 1 from public.hr_weekly_schedule_rules r
    where r.workspace_id=p_workspace_id and r.template_id=rid) then
   raise exception 'HR_RECURRING_TEMPLATE_USED: Duplicate a template to change a referenced version.';
  end if;
  update public.hr_shift_templates set code=code_value,name=name_value,
    start_time=start_value,end_time=end_value,end_day_offset=offset_value,
    break_minutes=break_value,late_grace_minutes=late_value,early_grace_minutes=early_value,
    is_active=active_value,revision=revision+1,updated_by=auth.uid(),updated_at=clock_timestamp()
   where workspace_id=p_workspace_id and id=rid returning * into result;
 end if;
 perform app_private.audit(p_workspace_id,'hr.shift_template_saved',result.id,
  jsonb_build_object('revision',result.revision,'active',result.is_active));
 return to_jsonb(result);
end $$;

create function public.save_hr_weekly_schedule_rule(p_workspace_id uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare rid uuid;template_row public.hr_shift_templates;old_row public.hr_weekly_schedule_rules;
 result public.hr_weekly_schedule_rules;name_value text;template_value uuid;
 mask_value integer;from_value date;until_value date;active_value boolean;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 if jsonb_typeof(p_payload) is distinct from 'object' or exists(
  select 1 from jsonb_object_keys(p_payload) k where k not in
   ('id','name','template_id','weekday_mask','effective_from','effective_until','is_active')) then
  raise exception 'HR_RECURRING_INPUT: Unsupported weekly rule field.';
 end if;
 rid:=nullif(p_payload->>'id','')::uuid;
 name_value:=btrim(p_payload->>'name');template_value:=(p_payload->>'template_id')::uuid;
 mask_value:=(p_payload->>'weekday_mask')::integer;
 from_value:=(p_payload->>'effective_from')::date;
 until_value:=nullif(p_payload->>'effective_until','')::date;
 active_value:=coalesce((p_payload->>'is_active')::boolean,true);
 if name_value is null or length(name_value) not between 1 and 200 or
   mask_value not between 1 and 127 or from_value is null or not isfinite(from_value) or
   (until_value is not null and (not isfinite(until_value) or until_value<from_value)) then
  raise exception 'HR_RECURRING_INPUT: Invalid weekly rule.';
 end if;
 select * into template_row from public.hr_shift_templates
  where workspace_id=p_workspace_id and id=template_value and is_active for share;
 if not found then raise exception 'HR_RECURRING_TEMPLATE: Choose an active template in this workspace.';end if;
 if rid is null then
  insert into public.hr_weekly_schedule_rules(workspace_id,name,template_id,template_revision,
   weekday_mask,effective_from,effective_until,is_active,created_by)
  values(p_workspace_id,name_value,template_row.id,template_row.revision,mask_value,
   from_value,until_value,active_value,auth.uid()) returning * into result;
 else
  select * into old_row from public.hr_weekly_schedule_rules
   where workspace_id=p_workspace_id and id=rid for update;
  if not found then raise exception 'HR_RECURRING_NOT_FOUND: Rule is outside this workspace.';end if;
  if exists(select 1 from public.hr_recurring_assignments a
     where a.workspace_id=p_workspace_id and a.rule_id=rid) then
   raise exception 'HR_RECURRING_RULE_USED: Close assignments and create a new rule version.';
  end if;
  update public.hr_weekly_schedule_rules set name=name_value,template_id=template_row.id,
   template_revision=template_row.revision,weekday_mask=mask_value,
   effective_from=from_value,effective_until=until_value,is_active=active_value,
   revision=revision+1,updated_by=auth.uid(),updated_at=clock_timestamp()
   where workspace_id=p_workspace_id and id=rid returning * into result;
 end if;
 perform app_private.audit(p_workspace_id,'hr.weekly_rule_saved',result.id,
  jsonb_build_object('revision',result.revision,'weekday_mask',result.weekday_mask));
 return to_jsonb(result);
end $$;

create function public.list_hr_recurring_setup(p_workspace_id uuid,p_kind text,
 p_page integer default 1,p_page_size integer default 100)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare items jsonb:='[]'::jsonb;total_value bigint:=0;
begin
 perform app_private.require_role(p_workspace_id,array['owner','manager']);
 if p_kind not in ('templates','rules','assignments') or p_page is null
  or p_page_size is null or p_page not between 1 and 100000
  or p_page_size not between 1 and 200 then
  raise exception 'HR_RECURRING_INPUT: Invalid catalog page.';
 end if;
 if p_kind='templates' then
  select count(*) into total_value from public.hr_shift_templates where workspace_id=p_workspace_id;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.name,x.id),'[]'::jsonb) into items
   from (select t.*,exists(select 1 from public.hr_weekly_schedule_rules r
      where r.workspace_id=t.workspace_id and r.template_id=t.id) is_used
     from public.hr_shift_templates t where t.workspace_id=p_workspace_id
    order by t.name,t.id limit p_page_size offset (p_page-1)*p_page_size) x;
 elsif p_kind='rules' then
  select count(*) into total_value from public.hr_weekly_schedule_rules where workspace_id=p_workspace_id;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc,x.id desc),'[]'::jsonb) into items
   from (select r.*,t.code template_code,t.name template_name,t.break_minutes template_break_minutes,
      exists(select 1 from public.hr_recurring_assignments a
       where a.workspace_id=r.workspace_id and a.rule_id=r.id) is_used
     from public.hr_weekly_schedule_rules r
     join public.hr_shift_templates t on t.workspace_id=r.workspace_id and t.id=r.template_id
     where r.workspace_id=p_workspace_id order by r.created_at desc,r.id desc
     limit p_page_size offset (p_page-1)*p_page_size) x;
 else
  select count(*) into total_value from public.hr_recurring_assignments where workspace_id=p_workspace_id;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc,x.id desc),'[]'::jsonb) into items
   from (select a.*,e.code employee_code,e.full_name employee_name,
      r.name rule_name,s.name site_name
     from public.hr_recurring_assignments a
     join public.hr_employees e on e.workspace_id=a.workspace_id and e.id=a.employee_id
     join public.hr_weekly_schedule_rules r on r.workspace_id=a.workspace_id and r.id=a.rule_id
     join public.hr_attendance_sites s on s.workspace_id=a.workspace_id and s.id=a.site_id
     where a.workspace_id=p_workspace_id order by a.created_at desc,a.id desc
     limit p_page_size offset (p_page-1)*p_page_size) x;
 end if;
 return jsonb_build_object('items',items,'total',total_value,'page',p_page,'page_size',p_page_size);
end $$;

create function public.list_hr_schedule_employees(p_workspace_id uuid,p_query text default '',
 p_department_id uuid default null,p_employee_type text default null,p_site_id uuid default null,
 p_page integer default 1,p_page_size integer default 50,p_effective_date date default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare items jsonb;total_value bigint;query_value text:=btrim(coalesce(p_query,''));
 effective_date_value date:=coalesce(p_effective_date,(now() at time zone 'Asia/Ho_Chi_Minh')::date);
begin
 perform app_private.require_role(p_workspace_id,array['owner','manager']);
 if length(query_value)>120 or p_page is null or p_page_size is null
  or p_page not between 1 and 100000 or p_page_size not between 1 and 200
  or not isfinite(effective_date_value)
  or (p_employee_type is not null and p_employee_type not in
    ('full_time','part_time','contractor','seasonal')) then
  raise exception 'HR_RECURRING_INPUT: Invalid employee filter or pagination.';
 end if;
 select count(*) into total_value from public.hr_employees e
 where e.workspace_id=p_workspace_id and e.is_active and e.status='active'
  and (query_value='' or e.code ilike '%'||query_value||'%'
    or e.full_name ilike '%'||query_value||'%')
  and (p_department_id is null or e.department_id=p_department_id)
  and (p_employee_type is null or e.employee_type=p_employee_type)
  and (p_site_id is null or exists(select 1 from public.hr_site_assignments sa
    where sa.workspace_id=e.workspace_id and sa.employee_id=e.id and sa.site_id=p_site_id
     and sa.valid_from<=effective_date_value
     and (sa.valid_to is null or sa.valid_to>=effective_date_value)));
 select coalesce(jsonb_agg(to_jsonb(x) order by x.code,x.id),'[]'::jsonb) into items
  from (select e.id,e.code,e.full_name,e.employee_type,e.department_id,
    d.name department_name,e.status,e.is_active
    from public.hr_employees e
    left join public.hr_departments d on d.workspace_id=e.workspace_id and d.id=e.department_id
    where e.workspace_id=p_workspace_id and e.is_active and e.status='active'
      and (query_value='' or e.code ilike '%'||query_value||'%'
       or e.full_name ilike '%'||query_value||'%')
      and (p_department_id is null or e.department_id=p_department_id)
      and (p_employee_type is null or e.employee_type=p_employee_type)
      and (p_site_id is null or exists(select 1 from public.hr_site_assignments sa
       where sa.workspace_id=e.workspace_id and sa.employee_id=e.id and sa.site_id=p_site_id
        and sa.valid_from<=effective_date_value
        and (sa.valid_to is null or sa.valid_to>=effective_date_value)))
    order by e.code,e.id limit p_page_size offset (p_page-1)*p_page_size) x;
 return jsonb_build_object('items',items,'total',total_value,'page',p_page,'page_size',p_page_size);
end $$;

create function public.preview_hr_recurring_schedule(p_workspace_id uuid,p_payload jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare rule_value uuid;site_value uuid;from_value date;to_value date;
 preview_from_value date;preview_to_value date;ids uuid[];employee_value uuid;day_value date;
 result_items jsonb:='[]'::jsonb;outcome jsonb;status_value text;
 created_count integer:=0;off_count integer:=0;manual_count integer:=0;
 existing_count integer:=0;conflict_count integer:=0;
begin
 perform app_private.require_role(p_workspace_id,array['owner','manager']);
 if jsonb_typeof(p_payload) is distinct from 'object' or exists(
  select 1 from jsonb_object_keys(p_payload) k where k not in
   ('rule_id','site_id','employee_ids','valid_from','valid_to','preview_from','preview_to'))
   or jsonb_typeof(p_payload->'employee_ids') is distinct from 'array' then
  raise exception 'HR_RECURRING_INPUT: Invalid preview payload.';
 end if;
 rule_value:=(p_payload->>'rule_id')::uuid;site_value:=(p_payload->>'site_id')::uuid;
 from_value:=(p_payload->>'valid_from')::date;
 to_value:=nullif(p_payload->>'valid_to','')::date;
 preview_from_value:=(p_payload->>'preview_from')::date;
 preview_to_value:=(p_payload->>'preview_to')::date;
 select array_agg(value::uuid order by value) into ids from jsonb_array_elements_text(p_payload->'employee_ids');
 if ids is null or array_length(ids,1)>200
   or (select count(distinct value) from unnest(ids) value)<>array_length(ids,1)
   or rule_value is null or site_value is null or from_value is null
   or preview_from_value is null or preview_to_value is null
   or not isfinite(from_value) or not isfinite(preview_from_value) or not isfinite(preview_to_value)
   or preview_to_value<preview_from_value or preview_to_value-preview_from_value>59
   or (to_value is not null and (not isfinite(to_value) or to_value<from_value)) then
  raise exception 'HR_RECURRING_INPUT: Preview needs 1-200 unique employees and at most 60 days.';
 end if;
 if not exists(select 1 from public.hr_weekly_schedule_rules
  where workspace_id=p_workspace_id and id=rule_value and is_active)
  or not exists(select 1 from public.hr_attendance_sites
   where workspace_id=p_workspace_id and id=site_value and is_active) then
  raise exception 'HR_RECURRING_INPUT: Choose an active rule and site.';
 end if;
 foreach employee_value in array ids loop
  for day_value in select d::date from generate_series(preview_from_value,preview_to_value,interval '1 day') d loop
   if day_value<from_value or (to_value is not null and day_value>to_value) then
    continue;
   end if;
   if not exists(select 1 from public.hr_employees e where e.workspace_id=p_workspace_id
     and e.id=employee_value and e.is_active and e.status='active') then
    outcome:=jsonb_build_object('employee_id',employee_value,'work_date',day_value,
     'status','CONFLICT','site_id',site_value,'reason','EMPLOYEE_INACTIVE');
   elsif exists(select 1 from public.hr_recurring_assignments a
     where a.workspace_id=p_workspace_id and a.employee_id=employee_value
      and day_value>=a.valid_from and (a.valid_to is null or day_value<=a.valid_to)) then
    outcome:=jsonb_build_object('employee_id',employee_value,'work_date',day_value,
     'status','CONFLICT','site_id',site_value,'reason','ASSIGNMENT_OVERLAP');
   else
    outcome:=app_private.hr_recurring_shift_status(p_workspace_id,employee_value,
     day_value,rule_value,site_value);
   end if;
   status_value:=outcome->>'status';
   case status_value
    when 'CREATE' then created_count:=created_count+1;
    when 'OFF' then off_count:=off_count+1;
    when 'KEEP_MANUAL' then manual_count:=manual_count+1;
    when 'KEEP_GENERATED' then existing_count:=existing_count+1;
    else conflict_count:=conflict_count+1;
   end case;
   result_items:=result_items||jsonb_build_array(outcome);
  end loop;
 end loop;
 return jsonb_build_object('items',result_items,'summary',jsonb_build_object(
  'create',created_count,'off',off_count,'keep_manual',manual_count,
  'keep_generated',existing_count,'conflict',conflict_count,
  'employees',array_length(ids,1),'days',preview_to_value-preview_from_value+1));
end $$;

create function public.assign_hr_recurring_schedule(p_workspace_id uuid,p_payload jsonb,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare receipt app_private.hr_recurring_requests;payload_hash_value text;
 rule_row public.hr_weekly_schedule_rules;employee_row public.hr_employees;
 site_value uuid;employee_ids uuid[];employee_value uuid;from_value date;to_value date;
 horizon_to date;result_ids jsonb:='[]'::jsonb;result_value jsonb;
 generated jsonb;new_id uuid;created_shift_count integer:=0;
 today_vn date:=(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 if p_request_id is null or jsonb_typeof(p_payload) is distinct from 'object' or exists(
  select 1 from jsonb_object_keys(p_payload) k where k not in
   ('rule_id','site_id','employee_ids','valid_from','valid_to'))
   or jsonb_typeof(p_payload->'employee_ids') is distinct from 'array' then
  raise exception 'HR_RECURRING_INPUT: Assignment needs a request ID and valid payload.';
 end if;
 payload_hash_value:=md5(p_payload::text);
 select * into receipt from app_private.hr_recurring_requests
  where workspace_id=p_workspace_id and request_id=p_request_id;
 if found then
  if receipt.action<>'assign' or receipt.payload_hash<>payload_hash_value then
   raise exception 'HR_RECURRING_REQUEST_CONFLICT: Request ID already has different content.';
  end if;
  return receipt.result;
 end if;
 site_value:=(p_payload->>'site_id')::uuid;
 from_value:=(p_payload->>'valid_from')::date;
 to_value:=nullif(p_payload->>'valid_to','')::date;
 select array_agg(value::uuid order by value) into employee_ids
  from jsonb_array_elements_text(p_payload->'employee_ids');
 if employee_ids is null or array_length(employee_ids,1)>200
   or (select count(distinct value) from unnest(employee_ids) value)<>array_length(employee_ids,1)
   or from_value is null or not isfinite(from_value) or from_value<today_vn
   or (to_value is not null and (not isfinite(to_value) or to_value<from_value)) then
  raise exception 'HR_RECURRING_INPUT: Choose 1-200 unique employees and a future-effective date range.';
 end if;
 select * into rule_row from public.hr_weekly_schedule_rules
  where workspace_id=p_workspace_id and id=(p_payload->>'rule_id')::uuid
    and is_active for share;
 if not found or from_value<rule_row.effective_from
   or (rule_row.effective_until is not null and
      (to_value is null or to_value>rule_row.effective_until)) then
  raise exception 'HR_RECURRING_INPUT: Assignment must fit an active rule date range.';
 end if;
 if not exists(select 1 from public.hr_shift_templates t
   where t.workspace_id=p_workspace_id and t.id=rule_row.template_id
    and t.is_active and t.revision=rule_row.template_revision) then
  raise exception 'HR_RECURRING_TEMPLATE: Rule template version is unavailable.';
 end if;
 if not exists(select 1 from public.hr_attendance_sites
   where workspace_id=p_workspace_id and id=site_value and is_active) then
  raise exception 'HR_RECURRING_SITE: Select an active workspace site.';
 end if;
 horizon_to:=least(from_value+44,coalesce(to_value,from_value+44));
 foreach employee_value in array employee_ids loop
  select * into employee_row from public.hr_employees e
   where e.workspace_id=p_workspace_id and e.id=employee_value and e.is_active
    and e.status='active' for share;
  if not found then raise exception 'HR_EMPLOYEE: Choose an active employee in this workspace.';end if;
  if not exists(select 1 from public.hr_site_assignments sa
   where sa.workspace_id=p_workspace_id and sa.employee_id=employee_value and sa.site_id=site_value
     and sa.valid_from<=from_value
     and (sa.valid_to is null or (to_value is not null and sa.valid_to>=to_value))) then
   raise exception 'HR_RECURRING_SITE: Site assignment must cover the entire recurring assignment.';
  end if;
  if exists(select 1 from public.hr_recurring_assignments a
    where a.workspace_id=p_workspace_id and a.employee_id=employee_value
     and a.valid_from<=coalesce(to_value,'infinity'::date)
     and from_value<=coalesce(a.valid_to,'infinity'::date)) then
   raise exception 'HR_RECURRING_CONFLICT: Employee already has a recurring schedule in this range.';
  end if;
  insert into public.hr_recurring_assignments(workspace_id,employee_id,rule_id,site_id,
   valid_from,valid_to,created_request_id,created_by)
   values(p_workspace_id,employee_value,rule_row.id,site_value,from_value,to_value,
    p_request_id,auth.uid()) returning id into new_id;
  generated:=app_private.hr_recurring_materialize_employee(p_workspace_id,
   employee_value,from_value,horizon_to);
  created_shift_count:=created_shift_count+(generated->>'created')::integer;
  result_ids:=result_ids||jsonb_build_array(new_id);
  perform app_private.audit(p_workspace_id,'hr.recurring_assignment_created',new_id,
   jsonb_build_object('employee_id',employee_value,'rule_id',rule_row.id,
    'site_id',site_value,'valid_from',from_value,'valid_to',to_value,
    'request_id',p_request_id));
 end loop;
 result_value:=jsonb_build_object('assignment_ids',result_ids,
   'created_count',array_length(employee_ids,1),'materialized_shifts',created_shift_count,
   'materialized_from',from_value,'materialized_to',horizon_to);
 insert into app_private.hr_recurring_requests(workspace_id,request_id,action,payload_hash,result,created_by)
  values(p_workspace_id,p_request_id,'assign',payload_hash_value,result_value,auth.uid());
 perform app_private.audit(p_workspace_id,'hr.recurring_schedule_materialized',rule_row.id,
  jsonb_build_object('request_id',p_request_id,'created',created_shift_count,
   'from',from_value,'to',horizon_to));
 return result_value;
end $$;

create function public.close_hr_recurring_assignment(p_workspace_id uuid,p_assignment_id uuid,
 p_valid_to date,p_reason text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare receipt app_private.hr_recurring_requests;payload_hash_value text;
 assignment_row public.hr_recurring_assignments;removed_count integer:=0;result_value jsonb;
 today_vn date:=(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 if p_request_id is null or p_assignment_id is null or p_valid_to is null
  or not isfinite(p_valid_to) or length(btrim(coalesce(p_reason,''))) not between 10 and 4000 then
  raise exception 'HR_RECURRING_INPUT: Closing an assignment requires date and reason.';
 end if;
 payload_hash_value:=md5(jsonb_build_object('assignment_id',p_assignment_id,
  'valid_to',p_valid_to,'reason',btrim(p_reason))::text);
 select * into receipt from app_private.hr_recurring_requests
  where workspace_id=p_workspace_id and request_id=p_request_id;
 if found then
  if receipt.action<>'close' or receipt.payload_hash<>payload_hash_value then
   raise exception 'HR_RECURRING_REQUEST_CONFLICT: Request ID already has different content.';
  end if;
  return receipt.result;
 end if;
 select * into assignment_row from public.hr_recurring_assignments
  where workspace_id=p_workspace_id and id=p_assignment_id for update;
 if not found then raise exception 'HR_RECURRING_NOT_FOUND: Assignment is outside this workspace.';end if;
 if p_valid_to<assignment_row.valid_from
  or (assignment_row.valid_to is not null and p_valid_to>assignment_row.valid_to) then
  raise exception 'HR_RECURRING_INPUT: Closing cannot extend or predate the assignment.';
 end if;
 if p_valid_to<today_vn then
  raise exception 'HR_RECURRING_HISTORY: Closing cannot remove past expected-work evidence.';
 end if;
 if exists(select 1 from public.hr_work_schedules s
   where s.workspace_id=p_workspace_id and s.recurring_assignment_id=p_assignment_id
    and s.work_date>p_valid_to
    and (exists(select 1 from public.hr_attendance a
      where a.workspace_id=s.workspace_id and a.schedule_id=s.id)
     or exists(select 1 from public.hr_qr_attendance_events q
      where q.workspace_id=s.workspace_id and q.schedule_id=s.id))) then
  raise exception 'HR_RECURRING_LOCKED: Cannot remove a shift with attendance or QR evidence.';
 end if;
 delete from public.hr_work_schedules s
  where s.workspace_id=p_workspace_id and s.recurring_assignment_id=p_assignment_id
    and s.work_date>p_valid_to;
 get diagnostics removed_count=row_count;
 update public.hr_recurring_assignments set valid_to=p_valid_to,
  updated_by=auth.uid(),updated_at=clock_timestamp()
  where workspace_id=p_workspace_id and id=p_assignment_id;
 result_value:=jsonb_build_object('id',p_assignment_id,'valid_to',p_valid_to,
  'removed_shifts',removed_count);
 insert into app_private.hr_recurring_requests(workspace_id,request_id,action,payload_hash,result,created_by)
  values(p_workspace_id,p_request_id,'close',payload_hash_value,result_value,auth.uid());
 perform app_private.audit(p_workspace_id,'hr.recurring_assignment_closed',p_assignment_id,
  jsonb_build_object('valid_to',p_valid_to,'removed_shifts',removed_count,
   'reason',btrim(p_reason),'request_id',p_request_id));
 return result_value;
end $$;

create function public.materialize_hr_recurring_schedules(p_workspace_id uuid,p_from date,
 p_to date,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare receipt app_private.hr_recurring_requests;payload_hash_value text;
 employee_value uuid;part jsonb;result_value jsonb;
 created_count integer:=0;off_count integer:=0;manual_count integer:=0;
 existing_count integer:=0;employee_count integer:=0;
 today_vn date:=(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 if p_request_id is null or p_from is null or p_to is null
   or not isfinite(p_from) or not isfinite(p_to) or p_to<p_from
   or p_to-p_from>59 or p_from<today_vn-1 then
  raise exception 'HR_RECURRING_INPUT: Materialize 1-60 current/future Vietnam dates.';
 end if;
 payload_hash_value:=md5(jsonb_build_object('from',p_from,'to',p_to)::text);
 select * into receipt from app_private.hr_recurring_requests
  where workspace_id=p_workspace_id and request_id=p_request_id;
 if found then
  if receipt.action<>'materialize' or receipt.payload_hash<>payload_hash_value then
   raise exception 'HR_RECURRING_REQUEST_CONFLICT: Request ID already has different content.';
  end if;
  return receipt.result;
 end if;
 for employee_value in select distinct a.employee_id from public.hr_recurring_assignments a
   where a.workspace_id=p_workspace_id and a.valid_from<=p_to
    and (a.valid_to is null or a.valid_to>=p_from) order by a.employee_id loop
  part:=app_private.hr_recurring_materialize_employee(p_workspace_id,employee_value,p_from,p_to);
  created_count:=created_count+(part->>'created')::integer;
  off_count:=off_count+(part->>'off')::integer;
  manual_count:=manual_count+(part->>'keep_manual')::integer;
  existing_count:=existing_count+(part->>'keep_generated')::integer;
  employee_count:=employee_count+1;
 end loop;
 result_value:=jsonb_build_object('created',created_count,'off',off_count,
  'keep_manual',manual_count,'keep_generated',existing_count,
  'kept',manual_count+existing_count,
  'employees',employee_count,'from',p_from,'to',p_to);
 insert into app_private.hr_recurring_requests(workspace_id,request_id,action,payload_hash,result,created_by)
  values(p_workspace_id,p_request_id,'materialize',payload_hash_value,result_value,auth.uid());
 perform app_private.audit(p_workspace_id,'hr.recurring_schedule_materialized',p_workspace_id,
  jsonb_build_object('request_id',p_request_id,'from',p_from,'to',p_to,
   'created',created_count,'employees',employee_count));
 return result_value;
end $$;

-- A single future generated date may become a deliberate manual exception.
-- Its former row is removed atomically; no attendance or locked payroll may
-- depend on it. Existing manual save/bind RPCs cannot mutate generated rows.
create function public.override_hr_recurring_shift(p_workspace_id uuid,p_schedule_id uuid,
 p_payload jsonb,p_reason text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare receipt app_private.hr_recurring_requests;payload_hash_value text;
 old_row public.hr_work_schedules;new_row public.hr_work_schedules;
 start_value timestamptz;end_value timestamptz;break_value integer;site_value uuid;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 if p_request_id is null or jsonb_typeof(p_payload) is distinct from 'object' or exists(
  select 1 from jsonb_object_keys(p_payload) k where k not in
   ('planned_start_at','planned_end_at','break_minutes','late_grace_minutes',
    'early_grace_minutes','shift_name','site_id'))
  or jsonb_typeof(p_payload->'break_minutes') is distinct from 'number'
  or length(btrim(coalesce(p_reason,''))) not between 10 and 4000 then
  raise exception 'HR_RECURRING_INPUT: A dated override needs times, break and reason.';
 end if;
 payload_hash_value:=md5(jsonb_build_object('schedule_id',p_schedule_id,
   'payload',p_payload,'reason',btrim(p_reason))::text);
 select * into receipt from app_private.hr_recurring_requests
  where workspace_id=p_workspace_id and request_id=p_request_id;
 if found then
  if receipt.action<>'override' or receipt.payload_hash<>payload_hash_value then
   raise exception 'HR_RECURRING_REQUEST_CONFLICT: Request ID already has different content.';
  end if;
  return receipt.result;
 end if;
 select * into old_row from public.hr_work_schedules
  where workspace_id=p_workspace_id and id=p_schedule_id for update;
 if not found or old_row.source_kind<>'recurring' then
  raise exception 'HR_RECURRING_NOT_FOUND: Choose a generated shift in this workspace.';
 end if;
 if old_row.work_date<(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date
  or exists(select 1 from public.hr_attendance a
    where a.workspace_id=p_workspace_id and a.schedule_id=p_schedule_id)
  or exists(select 1 from public.hr_qr_attendance_events q
    where q.workspace_id=p_workspace_id and q.schedule_id=p_schedule_id) then
  raise exception 'HR_RECURRING_LOCKED: Shift has attendance or is historical.';
 end if;
 start_value:=(p_payload->>'planned_start_at')::timestamptz;
 end_value:=(p_payload->>'planned_end_at')::timestamptz;
 break_value:=(p_payload->>'break_minutes')::integer;
 site_value:=coalesce(nullif(p_payload->>'site_id','')::uuid,old_row.site_id);
 if start_value is null or end_value is null or break_value not between 0 and 600
   or end_value<=start_value or end_value>start_value+interval '24 hours'
   or extract(epoch from end_value-start_value)/60<=break_value then
  raise exception 'HR_RECURRING_INPUT: Invalid manual override shift.';
 end if;
 delete from public.hr_work_schedules
  where workspace_id=p_workspace_id and id=p_schedule_id;
 insert into public.hr_work_schedules(workspace_id,employee_id,site_id,work_date,
   planned_start_at,planned_end_at,break_minutes,late_grace_minutes,early_grace_minutes,
   shift_name,created_by)
  values(p_workspace_id,old_row.employee_id,site_value,old_row.work_date,
   start_value,end_value,break_value,
   coalesce((p_payload->>'late_grace_minutes')::integer,old_row.late_grace_minutes),
   coalesce((p_payload->>'early_grace_minutes')::integer,old_row.early_grace_minutes),
   coalesce(btrim(p_payload->>'shift_name'),old_row.shift_name),auth.uid())
  returning * into new_row;
 insert into app_private.hr_recurring_requests(workspace_id,request_id,action,payload_hash,result,created_by)
  values(p_workspace_id,p_request_id,'override',payload_hash_value,
   jsonb_build_object('old_schedule_id',p_schedule_id,'schedule',to_jsonb(new_row)),auth.uid());
 perform app_private.audit(p_workspace_id,'hr.recurring_manual_override',new_row.id,
  jsonb_build_object('old_schedule_id',p_schedule_id,'employee_id',old_row.employee_id,
   'work_date',old_row.work_date,'reason',btrim(p_reason),'request_id',p_request_id,
   'before',to_jsonb(old_row),'after',to_jsonb(new_row)));
 return jsonb_build_object('old_schedule_id',p_schedule_id,'schedule',to_jsonb(new_row));
end $$;

revoke all on function public.save_hr_shift_template(uuid,jsonb),
 public.save_hr_weekly_schedule_rule(uuid,jsonb),
 public.list_hr_recurring_setup(uuid,text,integer,integer),
 public.list_hr_schedule_employees(uuid,text,uuid,text,uuid,integer,integer,date),
 public.preview_hr_recurring_schedule(uuid,jsonb),
 public.assign_hr_recurring_schedule(uuid,jsonb,uuid),
 public.close_hr_recurring_assignment(uuid,uuid,date,text,uuid),
 public.materialize_hr_recurring_schedules(uuid,date,date,uuid),
 public.override_hr_recurring_shift(uuid,uuid,jsonb,text,uuid)
 from public,anon,authenticated;
grant execute on function public.save_hr_shift_template(uuid,jsonb),
 public.save_hr_weekly_schedule_rule(uuid,jsonb),
 public.list_hr_recurring_setup(uuid,text,integer,integer),
 public.list_hr_schedule_employees(uuid,text,uuid,text,uuid,integer,integer,date),
 public.preview_hr_recurring_schedule(uuid,jsonb),
 public.assign_hr_recurring_schedule(uuid,jsonb,uuid),
 public.close_hr_recurring_assignment(uuid,uuid,date,text,uuid),
 public.materialize_hr_recurring_schedules(uuid,date,date,uuid),
 public.override_hr_recurring_shift(uuid,uuid,jsonb,text,uuid)
 to authenticated;

commit;
