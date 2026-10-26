-- ChiDi HR attendance and leave. Apply after 017_hr_core.sql.
-- Calendar assignments and clocks use absolute instants so overnight shifts are unambiguous.
-- Leave quantity is informational until a workspace pay/leave policy is configured.
begin;

do $$begin
 if to_regclass('public.hr_employees') is null then
  raise exception 'HR_CORE_REQUIRED: Apply 017_hr_core.sql before 018.';
 end if;
 if to_regclass('public.hr_work_schedules') is not null then
  raise exception 'HR_ATTENDANCE_ALREADY_INSTALLED: 018 runs once.';
 end if;
end $$;

create table public.hr_work_schedules (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id),
 employee_id uuid not null,
 work_date date not null,
 planned_start_at timestamptz not null,
 planned_end_at timestamptz not null,
 break_minutes integer not null default 0 check(break_minutes between 0 and 600),
 late_grace_minutes integer not null default 0 check(late_grace_minutes between 0 and 120),
 early_grace_minutes integer not null default 0 check(early_grace_minutes between 0 and 120),
 planned_minutes integer generated always as
  ((extract(epoch from (planned_end_at-planned_start_at))/60)::integer-break_minutes) stored,
 shift_name text not null default '' check(length(shift_name)<=120),
 created_by uuid not null references auth.users(id),
 updated_by uuid references auth.users(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(workspace_id,id),
 unique(workspace_id,id,employee_id,work_date),
 unique(workspace_id,employee_id,work_date),
 foreign key(workspace_id,employee_id) references public.hr_employees(workspace_id,id),
 check(isfinite(work_date) and isfinite(planned_start_at) and isfinite(planned_end_at)),
 check(planned_end_at>planned_start_at and planned_end_at<=planned_start_at+interval '24 hours'),
 check(planned_minutes>0)
);
create index hr_work_schedules_month_idx on public.hr_work_schedules(workspace_id,work_date,employee_id);

create table public.hr_leave_requests (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id),
 employee_id uuid not null,
 leave_type text not null check(leave_type in ('annual','sick','unpaid','other')),
 start_date date not null,
 end_date date not null,
 duration_unit text not null check(duration_unit in ('day','hour')),
 start_time time,
 end_time time,
 quantity numeric(7,2) not null check(quantity>0 and quantity<=366),
 reason text not null default '' check(length(reason)<=4000),
 status text not null default 'draft' check(status in ('draft','pending','approved','rejected','cancelled')),
 submitted_at timestamptz, decided_at timestamptz, decided_by uuid references auth.users(id),
 created_request_id uuid not null,
 create_hash text not null,
 created_by uuid not null references auth.users(id),
 updated_by uuid references auth.users(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(workspace_id,id),
 unique(workspace_id,created_request_id),
 foreign key(workspace_id,employee_id) references public.hr_employees(workspace_id,id),
 check(isfinite(start_date) and isfinite(end_date) and end_date>=start_date and end_date<=start_date+365),
 check((duration_unit='day' and start_time is null and end_time is null and quantity<=end_date-start_date+1)
  or (duration_unit='hour' and start_date=end_date and start_time is not null and end_time is not null
    and end_time>start_time and quantity=(extract(epoch from (end_time-start_time))/3600)::numeric(7,2)))
);
create index hr_leave_requests_employee_dates_idx
 on public.hr_leave_requests(workspace_id,employee_id,start_date,end_date)
 where status in ('draft','pending','approved');
create index hr_leave_requests_list_idx on public.hr_leave_requests(workspace_id,status,created_at desc,id);

create table public.hr_attendance (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id),
 employee_id uuid not null,
 work_date date not null,
 schedule_id uuid not null,
 clock_in_at timestamptz,
 clock_out_at timestamptz,
 break_minutes integer not null default 0 check(break_minutes between 0 and 600),
 kind text not null default 'work' check(kind in ('work','absent','leave')),
 status text not null default 'draft' check(status in ('draft','confirmed')),
 work_minutes integer,
 late_minutes integer not null default 0 check(late_minutes>=0),
 early_leave_minutes integer not null default 0 check(early_leave_minutes>=0),
 overtime_minutes integer not null default 0 check(overtime_minutes>=0),
 confirmed_at timestamptz, confirmed_by uuid references auth.users(id),
 created_request_id uuid not null,create_hash text not null,
 created_by uuid not null references auth.users(id),
 updated_by uuid references auth.users(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(workspace_id,id),
 unique(workspace_id,employee_id,work_date),
 unique(workspace_id,created_request_id),
 foreign key(workspace_id,schedule_id,employee_id,work_date)
  references public.hr_work_schedules(workspace_id,id,employee_id,work_date),
 check((status='draft' and confirmed_at is null and confirmed_by is null)
  or (status='confirmed' and confirmed_at is not null and confirmed_by is not null)),
 check((kind='work') or (clock_in_at is null and clock_out_at is null and break_minutes=0))
);
create index hr_attendance_month_idx on public.hr_attendance(workspace_id,work_date,employee_id);
create index hr_attendance_status_idx on public.hr_attendance(workspace_id,status,work_date);

create table public.hr_attendance_adjustments (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id),
 attendance_id uuid not null,
 request_id uuid not null,
 request_hash text not null,
 reason text not null check(length(btrim(reason)) between 10 and 4000),
 before_snapshot jsonb not null,
 after_snapshot jsonb not null,
 adjusted_by uuid not null references auth.users(id),
 adjusted_at timestamptz not null default now(),
 unique(workspace_id,request_id),
 foreign key(workspace_id,attendance_id) references public.hr_attendance(workspace_id,id)
);
create index hr_attendance_adjustments_history_idx
 on public.hr_attendance_adjustments(workspace_id,attendance_id,adjusted_at);

create table public.hr_leave_transitions (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id),
 leave_request_id uuid not null,
 request_id uuid not null,
 request_hash text not null,
 from_status text not null,
 to_status text not null,
 reason text not null default '',
 actor_id uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 unique(workspace_id,request_id),
 foreign key(workspace_id,leave_request_id) references public.hr_leave_requests(workspace_id,id)
);
create index hr_leave_transitions_history_idx
 on public.hr_leave_transitions(workspace_id,leave_request_id,created_at);

create function app_private.hr_protect_history() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 raise exception 'HR_HISTORY_IMMUTABLE: Recorded HR history cannot be changed.';
end $$;
create trigger hr_attendance_adjustments_immutable before update or delete on public.hr_attendance_adjustments
 for each row execute function app_private.hr_protect_history();
create trigger hr_leave_transitions_immutable before update or delete on public.hr_leave_transitions
 for each row execute function app_private.hr_protect_history();

-- Direct writes stay closed. HR history is visible to managers only, not every
-- workspace member as general ERP audit_events are.
do $$declare t text;begin
 foreach t in array array['hr_work_schedules','hr_attendance','hr_attendance_adjustments',
   'hr_leave_requests','hr_leave_transitions'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('create policy hr_manager_read on public.%I for select to authenticated using (app_private.member_role(workspace_id) in (''owner'',''manager''))',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
 end loop;
end $$;

-- Membership updates take the workspace row FOR UPDATE. A shared lock here
-- permits concurrent HR work and rechecks authority after a pending role change.
create function app_private.hr_require_management(p_workspace_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform app_private.require_role(p_workspace_id,array['owner','manager']);
 perform 1 from public.workspaces where id=p_workspace_id for share;
 if not found then raise exception 'HR_WORKSPACE_NOT_FOUND';end if;
 perform app_private.require_role(p_workspace_id,array['owner','manager']);
end $$;

create function app_private.hr_attendance_facts() returns trigger
language plpgsql security definer set search_path='' as $$
declare s public.hr_work_schedules; elapsed integer;
begin
 select * into s from public.hr_work_schedules
 where workspace_id=new.workspace_id and id=new.schedule_id
   and employee_id=new.employee_id and work_date=new.work_date for share;
 if not found then raise exception 'HR_SCHEDULE_REQUIRED: Attendance needs a matching schedule.';end if;
 if new.kind<>'work' then
  new.work_minutes:=0;new.late_minutes:=0;new.early_leave_minutes:=0;new.overtime_minutes:=0;
  return new;
 end if;
 if new.clock_in_at is not null and not isfinite(new.clock_in_at) then raise exception 'HR_CLOCK: Invalid check-in.';end if;
 if new.clock_out_at is not null and not isfinite(new.clock_out_at) then raise exception 'HR_CLOCK: Invalid check-out.';end if;
 if new.clock_in_at is not null and (new.clock_in_at<s.planned_start_at-interval '12 hours'
   or new.clock_in_at>s.planned_end_at+interval '24 hours') then
  raise exception 'HR_CLOCK: Check-in is outside the shift window.';
 end if;
 if new.clock_out_at is not null and (new.clock_out_at<s.planned_start_at-interval '12 hours'
   or new.clock_out_at>s.planned_end_at+interval '24 hours') then
  raise exception 'HR_CLOCK: Check-out is outside the shift window.';
 end if;
 if new.clock_in_at is not null and new.clock_out_at is not null then
  elapsed:=(extract(epoch from (new.clock_out_at-new.clock_in_at))/60)::integer;
  if elapsed<=0 or elapsed>2160 or new.break_minutes>=elapsed then
   raise exception 'HR_CLOCK: Check-out must follow check-in and exceed the break.';
  end if;
  new.work_minutes:=elapsed-new.break_minutes;
 else
  new.work_minutes:=null;
 end if;
 new.late_minutes:=case when new.clock_in_at is null then 0 else
  greatest(0,(extract(epoch from (new.clock_in_at-s.planned_start_at))/60)::integer-s.late_grace_minutes) end;
 new.early_leave_minutes:=case when new.clock_out_at is null then 0 else
  greatest(0,(extract(epoch from (s.planned_end_at-new.clock_out_at))/60)::integer-s.early_grace_minutes) end;
 new.overtime_minutes:=case when new.clock_out_at is null or new.clock_in_at is null then 0 else
  greatest(0,(extract(epoch from (new.clock_out_at-s.planned_end_at))/60)::integer) end;
 return new;
end $$;
create trigger hr_attendance_facts_before before insert or update on public.hr_attendance
 for each row execute function app_private.hr_attendance_facts();

create function public.save_hr_work_schedule(p_workspace_id uuid,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare rid uuid; e public.hr_employees; old_row public.hr_work_schedules; result public.hr_work_schedules;
begin
 perform app_private.hr_require_management(p_workspace_id);
 if jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'HR_INPUT: Expected object.';end if;
 rid:=nullif(p_payload->>'id','')::uuid;
 select * into e from public.hr_employees where workspace_id=p_workspace_id and id=(p_payload->>'employee_id')::uuid for share;
 if not found or e.archived_at is not null or e.status='terminated' then
  raise exception 'HR_EMPLOYEE: Choose an active employee in this workspace.';
 end if;
 if rid is null then
  insert into public.hr_work_schedules(workspace_id,employee_id,work_date,planned_start_at,
   planned_end_at,break_minutes,late_grace_minutes,early_grace_minutes,shift_name,created_by)
  values(p_workspace_id,e.id,(p_payload->>'work_date')::date,(p_payload->>'planned_start_at')::timestamptz,
   (p_payload->>'planned_end_at')::timestamptz,coalesce((p_payload->>'break_minutes')::integer,0),
   coalesce((p_payload->>'late_grace_minutes')::integer,0),
   coalesce((p_payload->>'early_grace_minutes')::integer,0),coalesce(btrim(p_payload->>'shift_name'),''),auth.uid())
  returning * into result;
 else
  select * into old_row from public.hr_work_schedules where workspace_id=p_workspace_id and id=rid for update;
  if not found then raise exception 'HR_SCHEDULE_NOT_FOUND';end if;
  if exists(select 1 from public.hr_attendance where workspace_id=p_workspace_id and schedule_id=rid) then
   raise exception 'HR_SCHEDULE_IN_USE: Adjust the attendance instead.';
  end if;
  update public.hr_work_schedules set employee_id=e.id,work_date=(p_payload->>'work_date')::date,
   planned_start_at=(p_payload->>'planned_start_at')::timestamptz,
   planned_end_at=(p_payload->>'planned_end_at')::timestamptz,
   break_minutes=coalesce((p_payload->>'break_minutes')::integer,0),
   late_grace_minutes=coalesce((p_payload->>'late_grace_minutes')::integer,0),
   early_grace_minutes=coalesce((p_payload->>'early_grace_minutes')::integer,0),
   shift_name=coalesce(btrim(p_payload->>'shift_name'),''),updated_by=auth.uid(),updated_at=now()
  where workspace_id=p_workspace_id and id=rid returning * into result;
 end if;
 perform app_private.audit(p_workspace_id,'hr.schedule_saved',result.id);
 return to_jsonb(result);
end $$;

create function public.list_hr_work_schedules(p_workspace_id uuid,p_month date,
 p_employee_id uuid default null,p_page integer default 1,p_page_size integer default 25) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare from_date date; n bigint; items jsonb;
begin
 perform app_private.require_role(p_workspace_id,array['owner','manager']);
 if p_month is null or not isfinite(p_month) or p_page not between 1 and 100000
   or p_page_size not between 1 and 100 then raise exception 'HR_PAGE: Invalid month or pagination.';end if;
 from_date:=date_trunc('month',p_month)::date;
 select count(*) into n from public.hr_work_schedules s
  where s.workspace_id=p_workspace_id and s.work_date>=from_date and s.work_date<(from_date+interval '1 month')::date
  and (p_employee_id is null or s.employee_id=p_employee_id);
 select coalesce(jsonb_agg(to_jsonb(x) order by x.work_date,x.employee_code,x.id),'[]'::jsonb)
  into items from (
   select s.*,e.code employee_code,e.full_name employee_name from public.hr_work_schedules s
   join public.hr_employees e on e.workspace_id=s.workspace_id and e.id=s.employee_id
   where s.workspace_id=p_workspace_id and s.work_date>=from_date and s.work_date<(from_date+interval '1 month')::date
    and (p_employee_id is null or s.employee_id=p_employee_id)
   order by s.work_date,e.code,s.id limit p_page_size offset (p_page-1)*p_page_size
  ) x;
 return jsonb_build_object('items',items,'total',n,'page',p_page,'page_size',p_page_size);
end $$;

create function public.save_hr_attendance(p_workspace_id uuid,p_payload jsonb,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare rid uuid; s public.hr_work_schedules; old_row public.hr_attendance; result public.hr_attendance;
 h text:=md5(coalesce(p_payload::text,'')); k text;
begin
 perform app_private.hr_require_management(p_workspace_id);
 if p_request_id is null or jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'HR_INPUT: Payload and request_id required.';end if;
 perform pg_advisory_xact_lock(hashtext(p_workspace_id::text||':attendance_create:'||p_request_id::text));
 rid:=nullif(p_payload->>'id','')::uuid;
 if rid is null then
  select * into old_row from public.hr_attendance
   where workspace_id=p_workspace_id and created_request_id=p_request_id;
  if found then
   if old_row.create_hash<>h then raise exception 'HR_IDEMPOTENCY: request_id has different payload.';end if;
   return to_jsonb(old_row);
  end if;
 end if;
 select * into s from public.hr_work_schedules where workspace_id=p_workspace_id
  and id=(p_payload->>'schedule_id')::uuid for share;
 if not found then raise exception 'HR_SCHEDULE_NOT_FOUND';end if;
 k:=coalesce(p_payload->>'kind','work');
 if k='leave' and not exists(select 1 from public.hr_leave_requests l where l.workspace_id=p_workspace_id
   and l.employee_id=s.employee_id and l.status='approved' and s.work_date between l.start_date and l.end_date)
 then raise exception 'HR_LEAVE_NOT_APPROVED: Approve leave before marking attendance.';end if;
 if rid is null then
  insert into public.hr_attendance(workspace_id,employee_id,work_date,schedule_id,clock_in_at,clock_out_at,
   break_minutes,kind,created_request_id,create_hash,created_by)
  values(p_workspace_id,s.employee_id,s.work_date,s.id,
   nullif(p_payload->>'clock_in_at','')::timestamptz,nullif(p_payload->>'clock_out_at','')::timestamptz,
   case when k='work' then coalesce((p_payload->>'break_minutes')::integer,s.break_minutes) else 0 end,
   k,p_request_id,h,auth.uid())
  returning * into result;
 else
  select * into old_row from public.hr_attendance where workspace_id=p_workspace_id and id=rid for update;
  if not found then raise exception 'HR_ATTENDANCE_NOT_FOUND';end if;
  if old_row.status<>'draft' then raise exception 'HR_ATTENDANCE_LOCKED: Use adjustment with a reason.';end if;
  if old_row.schedule_id<>s.id then raise exception 'HR_ATTENDANCE_IDENTITY: Schedule cannot change.';end if;
  update public.hr_attendance set clock_in_at=nullif(p_payload->>'clock_in_at','')::timestamptz,
   clock_out_at=nullif(p_payload->>'clock_out_at','')::timestamptz,
   break_minutes=case when k='work' then coalesce((p_payload->>'break_minutes')::integer,s.break_minutes) else 0 end,
   kind=k,
   updated_by=auth.uid(),updated_at=now()
  where workspace_id=p_workspace_id and id=rid returning * into result;
 end if;
 perform app_private.audit(p_workspace_id,'hr.attendance_saved',result.id);
 return to_jsonb(result);
end $$;

create function public.confirm_hr_attendance(p_workspace_id uuid,p_id uuid,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.hr_attendance;
begin
 perform app_private.hr_require_management(p_workspace_id);
 select * into r from public.hr_attendance where workspace_id=p_workspace_id and id=p_id for update;
 if not found then raise exception 'HR_ATTENDANCE_NOT_FOUND';end if;
 perform app_private.remember(p_workspace_id,p_request_id,'hr.attendance_confirm',p_id);
 if r.status='confirmed' then return to_jsonb(r);end if;
 if r.kind='work' and (r.clock_in_at is null or r.clock_out_at is null) then
  raise exception 'HR_ATTENDANCE_INCOMPLETE: Resolve missing check-in/check-out before confirmation.';
 end if;
 update public.hr_attendance set status='confirmed',confirmed_at=now(),confirmed_by=auth.uid(),
  updated_by=auth.uid(),updated_at=now() where workspace_id=p_workspace_id and id=p_id returning * into r;
 perform app_private.audit(p_workspace_id,'hr.attendance_confirmed',p_id);
 return to_jsonb(r);
end $$;

create function public.adjust_hr_attendance(p_workspace_id uuid,p_id uuid,p_payload jsonb,
 p_reason text,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.hr_attendance;old_row public.hr_attendance; previous public.hr_attendance_adjustments;
 h text:=md5(coalesce(p_payload::text,'')||'|'||coalesce(p_reason,''));reason_value text:=btrim(p_reason);
 k text;
begin
 perform app_private.hr_require_management(p_workspace_id);
 if p_request_id is null or jsonb_typeof(p_payload) is distinct from 'object'
   or length(reason_value) not between 10 and 4000 then
  raise exception 'HR_ADJUSTMENT: Payload, request_id and a reason of at least 10 characters are required.';
 end if;
 perform pg_advisory_xact_lock(hashtext(p_workspace_id::text||':attendance_adjust:'||p_request_id::text));
 select * into previous from public.hr_attendance_adjustments
  where workspace_id=p_workspace_id and request_id=p_request_id;
 if found then
  if previous.attendance_id<>p_id or previous.request_hash<>h then
   raise exception 'HR_IDEMPOTENCY: request_id has different adjustment.';
  end if;
  return previous.after_snapshot;
 end if;
 select * into r from public.hr_attendance where workspace_id=p_workspace_id and id=p_id for update;
 if not found then raise exception 'HR_ATTENDANCE_NOT_FOUND';end if;
 if r.status<>'confirmed' then raise exception 'HR_ADJUSTMENT: Confirm attendance first.';end if;
 old_row:=r;
 k:=coalesce(p_payload->>'kind',r.kind);
 if k='leave' and not exists(select 1 from public.hr_leave_requests l where l.workspace_id=p_workspace_id
  and l.employee_id=r.employee_id and l.status='approved' and r.work_date between l.start_date and l.end_date)
 then raise exception 'HR_LEAVE_NOT_APPROVED';end if;
 update public.hr_attendance set
  clock_in_at=case when k<>'work' then null when p_payload ? 'clock_in_at'
   then nullif(p_payload->>'clock_in_at','')::timestamptz else r.clock_in_at end,
  clock_out_at=case when k<>'work' then null when p_payload ? 'clock_out_at'
   then nullif(p_payload->>'clock_out_at','')::timestamptz else r.clock_out_at end,
  break_minutes=case when k<>'work' then 0 when p_payload ? 'break_minutes'
   then (p_payload->>'break_minutes')::integer else r.break_minutes end,
  kind=k,updated_by=auth.uid(),updated_at=now()
 where workspace_id=p_workspace_id and id=p_id returning * into r;
 if r.kind='work' and (r.clock_in_at is null or r.clock_out_at is null) then
  raise exception 'HR_ADJUSTMENT_INCOMPLETE: Confirmed work needs both clocks.';
 end if;
 if r.clock_in_at is not distinct from old_row.clock_in_at
  and r.clock_out_at is not distinct from old_row.clock_out_at
  and r.break_minutes=old_row.break_minutes and r.kind=old_row.kind then
  raise exception 'HR_ADJUSTMENT_UNCHANGED';
 end if;
 insert into public.hr_attendance_adjustments(workspace_id,attendance_id,request_id,request_hash,
  reason,before_snapshot,after_snapshot,adjusted_by)
 values(p_workspace_id,p_id,p_request_id,h,reason_value,to_jsonb(old_row),to_jsonb(r),auth.uid());
 perform app_private.audit(p_workspace_id,'hr.attendance_adjusted',p_id,
  jsonb_build_object('request_id',p_request_id));
 return to_jsonb(r);
end $$;

create function public.list_hr_attendance(p_workspace_id uuid,p_month date,
 p_employee_id uuid default null,p_department_id uuid default null,p_status text default null,
 p_page integer default 1,p_page_size integer default 25) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare from_date date;n bigint;items jsonb;
begin
 perform app_private.require_role(p_workspace_id,array['owner','manager']);
 if p_month is null or not isfinite(p_month) or p_page not between 1 and 100000
  or p_page_size not between 1 and 100 or (p_status is not null and p_status not in
   ('draft','confirmed','incomplete','late','early','overtime','absent','leave')) then
  raise exception 'HR_PAGE: Invalid month, filter or pagination.';
 end if;
 from_date:=date_trunc('month',p_month)::date;
 select count(*) into n from public.hr_attendance a
 join public.hr_employees e on e.workspace_id=a.workspace_id and e.id=a.employee_id
 where a.workspace_id=p_workspace_id and a.work_date>=from_date
  and a.work_date<(from_date+interval '1 month')::date
  and (p_employee_id is null or a.employee_id=p_employee_id)
  and (p_department_id is null or e.department_id=p_department_id)
  and (p_status is null or case p_status
   when 'incomplete' then a.kind='work' and (a.clock_in_at is null or a.clock_out_at is null)
   when 'late' then a.late_minutes>0 when 'early' then a.early_leave_minutes>0
   when 'overtime' then a.overtime_minutes>0 when 'absent' then a.kind='absent'
   when 'leave' then a.kind='leave' else a.status=p_status end);
 select coalesce(jsonb_agg(to_jsonb(x) order by x.work_date desc,x.employee_code,x.id),'[]'::jsonb)
 into items from (
  select a.*,e.code employee_code,e.full_name employee_name,e.department_id,
   d.name department_name,s.planned_start_at,s.planned_end_at,s.planned_minutes,s.shift_name
  from public.hr_attendance a
  join public.hr_employees e on e.workspace_id=a.workspace_id and e.id=a.employee_id
  left join public.hr_departments d on d.workspace_id=e.workspace_id and d.id=e.department_id
  join public.hr_work_schedules s on s.workspace_id=a.workspace_id and s.id=a.schedule_id
  where a.workspace_id=p_workspace_id and a.work_date>=from_date
   and a.work_date<(from_date+interval '1 month')::date
   and (p_employee_id is null or a.employee_id=p_employee_id)
   and (p_department_id is null or e.department_id=p_department_id)
   and (p_status is null or case p_status
    when 'incomplete' then a.kind='work' and (a.clock_in_at is null or a.clock_out_at is null)
    when 'late' then a.late_minutes>0 when 'early' then a.early_leave_minutes>0
    when 'overtime' then a.overtime_minutes>0 when 'absent' then a.kind='absent'
    when 'leave' then a.kind='leave' else a.status=p_status end)
  order by a.work_date desc,e.code,a.id limit p_page_size offset (p_page-1)*p_page_size
 ) x;
 return jsonb_build_object('items',items,'total',n,'page',p_page,'page_size',p_page_size);
end $$;

create function public.get_hr_attendance_summary(p_workspace_id uuid,p_date date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 perform app_private.require_role(p_workspace_id,array['owner','manager']);
 if p_date is null or not isfinite(p_date) then raise exception 'HR_DATE: Invalid date.';end if;
 select jsonb_build_object(
  'scheduled_count',count(*),
  'present_count',count(*) filter(where a.status='confirmed' and a.kind='work'
   and a.clock_in_at is not null and a.clock_out_at is not null),
  'absent_count',count(*) filter(where a.status='confirmed' and a.kind in ('absent','leave')),
  'leave_count',count(*) filter(where a.status='confirmed' and a.kind='leave'),
  'incomplete_count',count(*) filter(where a.status='draft' and a.kind='work'
   and (a.clock_in_at is null or a.clock_out_at is null)),
  'unconfirmed_count',count(*) filter(where a.status='draft' and
   (a.kind<>'work' or (a.clock_in_at is not null and a.clock_out_at is not null))),
  'unrecorded_count',count(*) filter(where a.id is null)
 ) into result
 from public.hr_work_schedules s
 left join public.hr_attendance a on a.workspace_id=s.workspace_id and a.schedule_id=s.id
 where s.workspace_id=p_workspace_id and s.work_date=p_date;
 return result;
end $$;

-- Serialize leave changes by employee so concurrent overlapping requests cannot
-- both pass the overlap check.
create function app_private.hr_lock_employee(p_workspace_id uuid,p_employee_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtext(p_workspace_id::text||':'||p_employee_id::text));
end $$;

create function app_private.hr_check_leave_overlap(p_workspace_id uuid,p_employee_id uuid,
 p_id uuid,p_start_date date,p_end_date date,p_unit text,p_start_time time,p_end_time time) returns void
language plpgsql security definer set search_path='' as $$
begin
 if exists(
  select 1 from public.hr_leave_requests l
  where l.workspace_id=p_workspace_id and l.employee_id=p_employee_id
   and (p_id is null or l.id<>p_id) and l.status in ('draft','pending','approved')
   and l.start_date<=p_end_date and l.end_date>=p_start_date
   and (l.duration_unit='day' or p_unit='day'
    or (l.start_date=p_start_date and l.start_time<p_end_time and p_start_time<l.end_time))
 ) then raise exception 'HR_LEAVE_OVERLAP: Active leave requests overlap.';end if;
end $$;

create function public.save_hr_leave_request(p_workspace_id uuid,p_payload jsonb,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare rid uuid;e public.hr_employees;old_row public.hr_leave_requests;result public.hr_leave_requests;
 start_value date;end_value date;unit_value text;start_clock time;end_clock time;
 h text:=md5(coalesce(p_payload::text,''));
begin
 perform app_private.hr_require_management(p_workspace_id);
 if p_request_id is null or jsonb_typeof(p_payload) is distinct from 'object' then
  raise exception 'HR_INPUT: Payload and request_id required.';
 end if;
 perform pg_advisory_xact_lock(hashtext(p_workspace_id::text||':leave_create:'||p_request_id::text));
 rid:=nullif(p_payload->>'id','')::uuid;
 if rid is null then
  select * into old_row from public.hr_leave_requests where workspace_id=p_workspace_id
   and created_request_id=p_request_id;
  if found then
   if old_row.create_hash<>h then raise exception 'HR_IDEMPOTENCY: request_id has different payload.';end if;
   return to_jsonb(old_row);
  end if;
 end if;
 select * into e from public.hr_employees where workspace_id=p_workspace_id
  and id=(p_payload->>'employee_id')::uuid for share;
 if not found or e.archived_at is not null then raise exception 'HR_EMPLOYEE_NOT_FOUND';end if;
 perform app_private.hr_lock_employee(p_workspace_id,e.id);
 start_value:=(p_payload->>'start_date')::date;end_value:=(p_payload->>'end_date')::date;
 unit_value:=p_payload->>'duration_unit';
 start_clock:=nullif(p_payload->>'start_time','')::time;
 end_clock:=nullif(p_payload->>'end_time','')::time;
 if rid is not null then
  select * into old_row from public.hr_leave_requests where workspace_id=p_workspace_id and id=rid for update;
  if not found then raise exception 'HR_LEAVE_NOT_FOUND';end if;
  if old_row.status<>'draft' then raise exception 'HR_LEAVE_LOCKED: Only drafts can be edited.';end if;
  if old_row.employee_id<>e.id then raise exception 'HR_LEAVE_IDENTITY: Employee cannot change.';end if;
 end if;
 perform app_private.hr_check_leave_overlap(p_workspace_id,e.id,rid,start_value,end_value,
  unit_value,start_clock,end_clock);
 if rid is null then
  insert into public.hr_leave_requests(workspace_id,employee_id,leave_type,start_date,end_date,
   duration_unit,start_time,end_time,quantity,reason,created_request_id,create_hash,created_by)
  values(p_workspace_id,e.id,p_payload->>'leave_type',start_value,end_value,unit_value,
   start_clock,end_clock,(p_payload->>'quantity')::numeric,coalesce(btrim(p_payload->>'reason'),''),
   p_request_id,h,auth.uid()) returning * into result;
 else
  update public.hr_leave_requests set leave_type=p_payload->>'leave_type',start_date=start_value,
   end_date=end_value,duration_unit=unit_value,start_time=start_clock,end_time=end_clock,
   quantity=(p_payload->>'quantity')::numeric,reason=coalesce(btrim(p_payload->>'reason'),''),
   updated_by=auth.uid(),updated_at=now()
  where workspace_id=p_workspace_id and id=rid returning * into result;
 end if;
 perform app_private.audit(p_workspace_id,'hr.leave_saved',result.id);
 return to_jsonb(result);
end $$;

create function public.transition_hr_leave_request(p_workspace_id uuid,p_id uuid,p_target text,
 p_reason text,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.hr_leave_requests;prior public.hr_leave_transitions;
 reason_value text:=coalesce(btrim(p_reason),'');h text:=md5(coalesce(p_target,'')||'|'||coalesce(btrim(p_reason),''));
begin
 perform app_private.hr_require_management(p_workspace_id);
 if p_request_id is null or p_target is null then raise exception 'HR_LEAVE_TRANSITION: Target and request_id required.';end if;
 perform pg_advisory_xact_lock(hashtext(p_workspace_id::text||':leave_transition:'||p_request_id::text));
 select * into prior from public.hr_leave_transitions where workspace_id=p_workspace_id and request_id=p_request_id;
 if found then
  if prior.leave_request_id<>p_id or prior.request_hash<>h then raise exception 'HR_IDEMPOTENCY: request_id has different transition.';end if;
  select * into r from public.hr_leave_requests where workspace_id=p_workspace_id and id=p_id;
  return to_jsonb(r);
 end if;
 select * into r from public.hr_leave_requests where workspace_id=p_workspace_id and id=p_id;
 if not found then raise exception 'HR_LEAVE_NOT_FOUND';end if;
 perform app_private.hr_lock_employee(p_workspace_id,r.employee_id);
 select * into r from public.hr_leave_requests where workspace_id=p_workspace_id and id=p_id for update;
 if not ((r.status='draft' and p_target in ('pending','cancelled'))
  or (r.status='pending' and p_target in ('approved','rejected','cancelled'))) then
  raise exception 'HR_LEAVE_TRANSITION: Invalid status change.';
 end if;
 if p_target in ('rejected','cancelled') and length(reason_value) not between 5 and 4000 then
  raise exception 'HR_LEAVE_REASON: Explain the rejection or cancellation.';
 end if;
 if p_target in ('pending','approved') then
  perform app_private.hr_check_leave_overlap(p_workspace_id,r.employee_id,r.id,
   r.start_date,r.end_date,r.duration_unit,r.start_time,r.end_time);
 end if;
 insert into public.hr_leave_transitions(workspace_id,leave_request_id,request_id,request_hash,
  from_status,to_status,reason,actor_id)
 values(p_workspace_id,p_id,p_request_id,h,r.status,p_target,reason_value,auth.uid());
 update public.hr_leave_requests set status=p_target,
  submitted_at=case when p_target='pending' then now() else submitted_at end,
  decided_at=case when p_target in ('approved','rejected') then now() else decided_at end,
  decided_by=case when p_target in ('approved','rejected') then auth.uid() else decided_by end,
  updated_by=auth.uid(),updated_at=now()
 where workspace_id=p_workspace_id and id=p_id returning * into r;
 perform app_private.audit(p_workspace_id,'hr.leave_transitioned',p_id,
  jsonb_build_object('to_status',p_target,'request_id',p_request_id));
 return to_jsonb(r);
end $$;

create function public.list_hr_leave_requests(p_workspace_id uuid,p_status text default null,
 p_employee_id uuid default null,p_page integer default 1,p_page_size integer default 25) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare n bigint;items jsonb;
begin
 perform app_private.require_role(p_workspace_id,array['owner','manager']);
 if p_page not between 1 and 100000 or p_page_size not between 1 and 100
  or (p_status is not null and p_status not in ('draft','pending','approved','rejected','cancelled')) then
  raise exception 'HR_PAGE: Invalid status or pagination.';
 end if;
 select count(*) into n from public.hr_leave_requests l where l.workspace_id=p_workspace_id
  and (p_status is null or l.status=p_status) and (p_employee_id is null or l.employee_id=p_employee_id);
 select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc,x.id),'[]'::jsonb)
 into items from (
  select l.*,e.code employee_code,e.full_name employee_name,e.department_id,
   d.name department_name from public.hr_leave_requests l
  join public.hr_employees e on e.workspace_id=l.workspace_id and e.id=l.employee_id
  left join public.hr_departments d on d.workspace_id=e.workspace_id and d.id=e.department_id
  where l.workspace_id=p_workspace_id and (p_status is null or l.status=p_status)
   and (p_employee_id is null or l.employee_id=p_employee_id)
  order by l.created_at desc,l.id limit p_page_size offset (p_page-1)*p_page_size
 ) x;
 return jsonb_build_object('items',items,'total',n,'page',p_page,'page_size',p_page_size);
end $$;

revoke all on function app_private.hr_protect_history(),app_private.hr_require_management(uuid),
 app_private.hr_attendance_facts(),app_private.hr_lock_employee(uuid,uuid),
 app_private.hr_check_leave_overlap(uuid,uuid,uuid,date,date,text,time,time) from public,anon,authenticated;
revoke all on function public.save_hr_work_schedule(uuid,jsonb),public.list_hr_work_schedules(uuid,date,uuid,integer,integer),
 public.save_hr_attendance(uuid,jsonb,uuid),public.confirm_hr_attendance(uuid,uuid,uuid),
 public.adjust_hr_attendance(uuid,uuid,jsonb,text,uuid),
 public.list_hr_attendance(uuid,date,uuid,uuid,text,integer,integer),
 public.get_hr_attendance_summary(uuid,date),
 public.save_hr_leave_request(uuid,jsonb,uuid),
 public.transition_hr_leave_request(uuid,uuid,text,text,uuid),
 public.list_hr_leave_requests(uuid,text,uuid,integer,integer) from public,anon;
grant execute on function public.save_hr_work_schedule(uuid,jsonb),public.list_hr_work_schedules(uuid,date,uuid,integer,integer),
 public.save_hr_attendance(uuid,jsonb,uuid),public.confirm_hr_attendance(uuid,uuid,uuid),
 public.adjust_hr_attendance(uuid,uuid,jsonb,text,uuid),
 public.list_hr_attendance(uuid,date,uuid,uuid,text,integer,integer),
 public.get_hr_attendance_summary(uuid,date),
 public.save_hr_leave_request(uuid,jsonb,uuid),
 public.transition_hr_leave_request(uuid,uuid,text,text,uuid),
 public.list_hr_leave_requests(uuid,text,uuid,integer,integer) to authenticated;

commit;
