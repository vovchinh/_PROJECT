-- QR attendance site, assignment, kiosk and immutable scan events.
-- 017-020 and historical manual attendance stay authoritative.
begin;

do $$begin
 if to_regclass('public.hr_work_schedules') is null
    or to_regclass('public.hr_attendance') is null then
  raise exception 'HR_QR_PREREQUISITE: Apply 017-020 before 023.';
 end if;
 if to_regclass('public.hr_attendance_sites') is not null then
  raise exception 'HR_QR_ALREADY_INSTALLED: 023 runs once.';
 end if;
end $$;

create table public.hr_attendance_sites (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id),
 code text not null check(length(btrim(code)) between 1 and 80),
 name text not null check(length(btrim(name)) between 1 and 200),
 is_active boolean not null default true,
 archived_at timestamptz, archived_by uuid references auth.users(id),
 archive_reason text,
 created_by uuid not null references auth.users(id),
 updated_by uuid references auth.users(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(workspace_id,id),
 check(is_active=(archived_at is null)),
 check((is_active and archived_by is null and archive_reason is null)
   or (not is_active and archived_by is not null
    and length(btrim(archive_reason)) between 10 and 4000))
);
create unique index hr_attendance_sites_code_norm
 on public.hr_attendance_sites(workspace_id,app_private.catalog_normalize(code));

create table public.hr_site_assignments (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id),
 employee_id uuid not null,
 site_id uuid not null,
 valid_from date not null,
 valid_to date,
 created_by uuid not null references auth.users(id),
 updated_by uuid references auth.users(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(workspace_id,id),
 foreign key(workspace_id,employee_id) references public.hr_employees(workspace_id,id),
 foreign key(workspace_id,site_id) references public.hr_attendance_sites(workspace_id,id),
 check(isfinite(valid_from) and (valid_to is null or (isfinite(valid_to) and valid_to>=valid_from)))
);
create index hr_site_assignments_employee_dates
 on public.hr_site_assignments(workspace_id,employee_id,valid_from,valid_to);
create index hr_site_assignments_site_dates
 on public.hr_site_assignments(workspace_id,site_id,valid_from,valid_to);

-- A trigger protects overlap even from privileged direct writes. The advisory
-- lock serializes concurrent inserts for the same employee/site pair.
create function app_private.hr_site_assignment_guard() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtext(new.workspace_id::text||':hr_site:'||
  new.employee_id::text||':'||new.site_id::text));
 if tg_op='UPDATE' and (new.workspace_id,new.employee_id,new.site_id,new.valid_from)
    is distinct from (old.workspace_id,old.employee_id,old.site_id,old.valid_from) then
  raise exception 'HR_SITE_ASSIGNMENT_IDENTITY: Close and create an assignment instead.';
 end if;
 if exists(select 1 from public.hr_site_assignments a
  where a.workspace_id=new.workspace_id and a.employee_id=new.employee_id
   and a.site_id=new.site_id and a.id<>new.id
   and a.valid_from<=coalesce(new.valid_to,'infinity'::date)
   and new.valid_from<=coalesce(a.valid_to,'infinity'::date)) then
  raise exception 'HR_SITE_ASSIGNMENT_OVERLAP: Assignment dates overlap.';
 end if;
 return new;
end $$;
create trigger hr_site_assignment_guard_before before insert or update on public.hr_site_assignments
 for each row execute function app_private.hr_site_assignment_guard();

alter table public.hr_work_schedules add column site_id uuid;
alter table public.hr_work_schedules add constraint hr_work_schedules_site_fk
 foreign key(workspace_id,site_id) references public.hr_attendance_sites(workspace_id,id);
alter table public.hr_work_schedules add constraint hr_work_schedules_site_identity
 unique(workspace_id,id,employee_id,work_date,site_id);
create index hr_work_schedules_site_date on public.hr_work_schedules(workspace_id,site_id,work_date)
 where site_id is not null;

-- Existing manual schedule RPC may edit a site-linked row. Validate its final
-- state here, and freeze identity/site as soon as attendance has been recorded.
create function app_private.hr_schedule_site_guard() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op='UPDATE' and (new.site_id,new.employee_id,new.work_date)
    is distinct from (old.site_id,old.employee_id,old.work_date)
    and (exists(select 1 from public.hr_attendance a
      where a.workspace_id=old.workspace_id and a.schedule_id=old.id)
     or exists(select 1 from public.hr_qr_attendance_events e
      where e.workspace_id=old.workspace_id and e.schedule_id=old.id)) then
  raise exception 'HR_SITE_SCHEDULE_LOCKED: Attendance already exists.';
 end if;
 if new.site_id is not null then
  if new.work_date<>(new.planned_start_at at time zone 'Asia/Ho_Chi_Minh')::date then
   raise exception 'HR_SITE_WORK_DATE: QR shift work_date must be the Vietnam date of its start.';
  end if;
  perform 1 from public.hr_attendance_sites s
    where s.workspace_id=new.workspace_id and s.id=new.site_id and s.is_active for share;
  if not found then
   raise exception 'HR_SITE_INACTIVE: Schedule needs an active site.';
  end if;
  perform 1 from public.hr_site_assignments a
    where a.workspace_id=new.workspace_id and a.employee_id=new.employee_id
     and a.site_id=new.site_id and new.work_date>=a.valid_from
     and (a.valid_to is null or new.work_date<=a.valid_to) for share;
  if not found then
   raise exception 'HR_SITE_ASSIGNMENT_REQUIRED: Assign the employee at this site for the work date.';
  end if;
 end if;
 return new;
end $$;

create table public.hr_qr_kiosks (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id),
 site_id uuid not null,
 request_id uuid not null,
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null,
 stopped_at timestamptz,
 stopped_by uuid references auth.users(id),
 unique(workspace_id,id),unique(workspace_id,request_id),
 unique(workspace_id,id,site_id),
 foreign key(workspace_id,site_id) references public.hr_attendance_sites(workspace_id,id),
 check(expires_at>created_at and expires_at<=created_at+interval '2 hours 1 minute'),
 check((stopped_at is null)=(stopped_by is null))
);
create index hr_qr_kiosks_site_active on public.hr_qr_kiosks(workspace_id,site_id,expires_at)
 where stopped_at is null;

create table public.hr_qr_challenges (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id),
 kiosk_id uuid not null,
 site_id uuid not null,
 token_hash text not null unique check(token_hash ~ '^[a-f0-9]{32}$'),
 issued_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null,
 issued_by uuid not null references auth.users(id),
 unique(workspace_id,id),
 unique(workspace_id,id,site_id),
 foreign key(workspace_id,kiosk_id,site_id)
  references public.hr_qr_kiosks(workspace_id,id,site_id),
 check(expires_at>issued_at and expires_at<=issued_at+interval '31 seconds')
);
create index hr_qr_challenges_kiosk_expiry
 on public.hr_qr_challenges(workspace_id,kiosk_id,expires_at);

create table public.hr_qr_attendance_events (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id),
 employee_id uuid not null,
 schedule_id uuid not null,
 work_date date not null,
 site_id uuid not null,
 attendance_id uuid not null,
 challenge_id uuid not null,
 kiosk_id uuid not null,
 action text not null check(action in ('check_in','check_out')),
 occurred_at timestamptz not null,
 method text not null default 'dynamic_qr' check(method='dynamic_qr'),
 request_id uuid not null,
 request_hash text not null check(request_hash ~ '^[a-f0-9]{32}$'),
 actor_id uuid not null references auth.users(id),
 created_at timestamptz not null default clock_timestamp(),
 unique(workspace_id,id),
 unique(workspace_id,request_id),
 unique(workspace_id,schedule_id,action),
 unique(workspace_id,employee_id,challenge_id,action),
 foreign key(workspace_id,schedule_id,employee_id,work_date,site_id)
  references public.hr_work_schedules(workspace_id,id,employee_id,work_date,site_id),
 foreign key(workspace_id,attendance_id) references public.hr_attendance(workspace_id,id),
 foreign key(workspace_id,challenge_id,site_id)
  references public.hr_qr_challenges(workspace_id,id,site_id),
 foreign key(workspace_id,kiosk_id,site_id)
  references public.hr_qr_kiosks(workspace_id,id,site_id)
);
create index hr_qr_events_employee_date
 on public.hr_qr_attendance_events(workspace_id,employee_id,work_date,occurred_at);
create trigger hr_qr_events_immutable before update or delete on public.hr_qr_attendance_events
 for each row execute function app_private.hr_protect_history();

-- One small row per account/workspace survives rejected scans. Expected scan
-- failures return a structured result so this counter commits independently of
-- the rolled-back scan subtransaction.
create table public.hr_qr_scan_limits (
 workspace_id uuid not null references public.workspaces(id),
 actor_id uuid not null references auth.users(id),
 window_start timestamptz not null,
 failed_count integer not null default 0 check(failed_count>=0),
 last_failed_at timestamptz,
 primary key(workspace_id,actor_id)
);

create trigger hr_schedule_site_guard_before before insert or update on public.hr_work_schedules
 for each row execute function app_private.hr_schedule_site_guard();

do $$declare t text;begin
 foreach t in array array['hr_attendance_sites','hr_site_assignments',
   'hr_qr_kiosks','hr_qr_challenges','hr_qr_attendance_events','hr_qr_scan_limits'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
 end loop;
 foreach t in array array['hr_attendance_sites','hr_site_assignments',
   'hr_qr_kiosks','hr_qr_attendance_events','hr_qr_scan_limits'] loop
  execute format('create policy hr_manager_read on public.%I for select to authenticated using (app_private.member_role(workspace_id) in (''owner'',''manager''))',t);
  execute format('grant select on public.%I to authenticated',t);
 end loop;
end $$;

create function public.save_hr_attendance_site(p_workspace_id uuid,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare rid uuid; old_row public.hr_attendance_sites; result public.hr_attendance_sites;
 code_value text; name_value text; active_value boolean; reason_value text;
begin
 perform app_private.hr_require_management(p_workspace_id);
 if jsonb_typeof(p_payload) is distinct from 'object' or exists(
  select 1 from jsonb_object_keys(p_payload) k
   where k not in ('id','code','name','is_active','archive_reason')) then
  raise exception 'HR_SITE_INPUT: Unsupported site payload.';
 end if;
 rid:=nullif(p_payload->>'id','')::uuid;
 if rid is not null then
  select * into old_row from public.hr_attendance_sites
   where workspace_id=p_workspace_id and id=rid for update;
  if not found then raise exception 'HR_SITE_NOT_FOUND';end if;
 end if;
 code_value:=coalesce(nullif(upper(btrim(p_payload->>'code')),''),old_row.code);
 name_value:=coalesce(nullif(btrim(p_payload->>'name'),''),old_row.name);
 if code_value is null or name_value is null or length(code_value)>80 or length(name_value)>200 then
  raise exception 'HR_SITE_INPUT: Site code and name are required.';
 end if;
 if old_row.id is not null and old_row.code<>code_value then
  raise exception 'HR_SITE_CODE_IMMUTABLE: Create a new site for another code.';
 end if;
 if p_payload ? 'is_active' and jsonb_typeof(p_payload->'is_active') is distinct from 'boolean' then
  raise exception 'HR_SITE_INPUT: is_active must be boolean.';
 end if;
 active_value:=coalesce((p_payload->>'is_active')::boolean,old_row.is_active,true);
 reason_value:=btrim(p_payload->>'archive_reason');
 if not active_value and (old_row.id is null or old_row.is_active) then
  if length(reason_value) not between 10 and 4000 then
   raise exception 'HR_SITE_ARCHIVE_REASON: Explain site archival.';
  end if;
  if exists(select 1 from public.hr_work_schedules s
    where s.workspace_id=p_workspace_id and s.site_id=rid
     and s.planned_start_at>=clock_timestamp()) then
   raise exception 'HR_SITE_FUTURE_SHIFTS: Reassign future shifts before archiving.';
  end if;
 elsif not active_value then
  reason_value:=old_row.archive_reason;
 end if;
 if rid is null then
  if not active_value then raise exception 'HR_SITE_INPUT: New site must be active.';end if;
  insert into public.hr_attendance_sites(workspace_id,code,name,created_by)
   values(p_workspace_id,code_value,name_value,auth.uid()) returning * into result;
 else
  update public.hr_attendance_sites set name=name_value,is_active=active_value,
   archived_at=case when active_value then null when old_row.is_active then clock_timestamp() else old_row.archived_at end,
   archived_by=case when active_value then null when old_row.is_active then auth.uid() else old_row.archived_by end,
   archive_reason=case when active_value then null else reason_value end,
   updated_by=auth.uid(),updated_at=clock_timestamp()
   where workspace_id=p_workspace_id and id=rid returning * into result;
 end if;
 perform app_private.audit(p_workspace_id,'hr.attendance_site_saved',result.id,
  jsonb_build_object('is_active',result.is_active,'archive_reason',result.archive_reason));
 return to_jsonb(result);
end $$;

create function public.save_hr_site_assignment(p_workspace_id uuid,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare rid uuid; old_row public.hr_site_assignments; result public.hr_site_assignments;
 employee_value uuid; site_value uuid; from_value date; to_value date;
 is_closure boolean;
begin
 perform app_private.hr_require_management(p_workspace_id);
 if jsonb_typeof(p_payload) is distinct from 'object' or exists(
  select 1 from jsonb_object_keys(p_payload) k
   where k not in ('id','employee_id','site_id','valid_from','valid_to')) then
  raise exception 'HR_SITE_ASSIGNMENT_INPUT: Unsupported assignment payload.';
 end if;
 rid:=nullif(p_payload->>'id','')::uuid;
 if rid is not null then
  select * into old_row from public.hr_site_assignments
   where workspace_id=p_workspace_id and id=rid for update;
  if not found then raise exception 'HR_SITE_ASSIGNMENT_NOT_FOUND';end if;
 end if;
 employee_value:=coalesce(nullif(p_payload->>'employee_id','')::uuid,old_row.employee_id);
 site_value:=coalesce(nullif(p_payload->>'site_id','')::uuid,old_row.site_id);
 from_value:=coalesce(nullif(p_payload->>'valid_from','')::date,old_row.valid_from);
 to_value:=case when p_payload ? 'valid_to' then nullif(p_payload->>'valid_to','')::date else old_row.valid_to end;
 if employee_value is null or site_value is null or from_value is null
  or not isfinite(from_value) or (to_value is not null and (not isfinite(to_value) or to_value<from_value)) then
  raise exception 'HR_SITE_ASSIGNMENT_INPUT: Invalid assignment dates or identity.';
 end if;
 if old_row.id is not null and (employee_value,site_value,from_value)
    is distinct from (old_row.employee_id,old_row.site_id,old_row.valid_from) then
  raise exception 'HR_SITE_ASSIGNMENT_IDENTITY: Close and create an assignment instead.';
 end if;
 is_closure:=old_row.id is not null and to_value is not null
  and (old_row.valid_to is null or to_value<=old_row.valid_to);
 if not is_closure then
  perform 1 from public.hr_employees e
   where e.workspace_id=p_workspace_id and e.id=employee_value
    and e.is_active and e.status='active' for share;
  if not found then raise exception 'HR_EMPLOYEE: Choose an active employee.';end if;
  perform 1 from public.hr_attendance_sites s
   where s.workspace_id=p_workspace_id and s.id=site_value and s.is_active for share;
  if not found then raise exception 'HR_SITE_INACTIVE: Choose an active site.';end if;
 end if;
 if old_row.id is not null and exists(select 1 from public.hr_work_schedules s
  where s.workspace_id=p_workspace_id and s.employee_id=employee_value
   and s.site_id=site_value and s.work_date>=from_value
   and (old_row.valid_to is null or s.work_date<=old_row.valid_to)
   and (to_value is not null and s.work_date>to_value)) then
  raise exception 'HR_SITE_ASSIGNMENT_IN_USE: Shift would lose its site assignment.';
 end if;
 if rid is null then
  insert into public.hr_site_assignments(workspace_id,employee_id,site_id,valid_from,valid_to,created_by)
   values(p_workspace_id,employee_value,site_value,from_value,to_value,auth.uid())
   returning * into result;
 else
  update public.hr_site_assignments set valid_to=to_value,updated_by=auth.uid(),updated_at=clock_timestamp()
   where workspace_id=p_workspace_id and id=rid returning * into result;
 end if;
 perform app_private.audit(p_workspace_id,'hr.site_assignment_saved',result.id,
  jsonb_build_object('employee_id',employee_value,'site_id',site_value,
   'valid_from',from_value,'valid_to',to_value));
 return to_jsonb(result);
end $$;

create function public.bind_hr_work_schedule_site(p_workspace_id uuid,p_schedule_id uuid,p_site_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare schedule_row public.hr_work_schedules;
begin
 perform app_private.hr_require_management(p_workspace_id);
 if p_site_id is null then raise exception 'HR_SITE_REQUIRED';end if;
 select * into schedule_row from public.hr_work_schedules
  where workspace_id=p_workspace_id and id=p_schedule_id for update;
 if not found then raise exception 'HR_SCHEDULE_NOT_FOUND';end if;
 if schedule_row.site_id=p_site_id then return to_jsonb(schedule_row);end if;
 if exists(select 1 from public.hr_attendance a
    where a.workspace_id=p_workspace_id and a.schedule_id=p_schedule_id)
  or exists(select 1 from public.hr_qr_attendance_events e
    where e.workspace_id=p_workspace_id and e.schedule_id=p_schedule_id) then
  raise exception 'HR_SITE_SCHEDULE_LOCKED: Attendance already exists.';
 end if;
 update public.hr_work_schedules set site_id=p_site_id,updated_by=auth.uid(),updated_at=clock_timestamp()
  where workspace_id=p_workspace_id and id=p_schedule_id returning * into schedule_row;
 perform app_private.audit(p_workspace_id,'hr.schedule_site_bound',p_schedule_id,
  jsonb_build_object('site_id',p_site_id));
 return to_jsonb(schedule_row);
end $$;

create function public.list_hr_qr_setup(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare sites_value jsonb; assignments_value jsonb;
begin
 perform app_private.require_role(p_workspace_id,array['owner','manager']);
 select coalesce(jsonb_agg(to_jsonb(s) order by s.code,s.id),'[]'::jsonb)
  into sites_value from public.hr_attendance_sites s where s.workspace_id=p_workspace_id;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.valid_from desc,x.employee_code,x.site_code),'[]'::jsonb)
  into assignments_value from (
   select a.*,e.code employee_code,e.full_name employee_name,
    s.code site_code,s.name site_name
   from public.hr_site_assignments a
   join public.hr_employees e on e.workspace_id=a.workspace_id and e.id=a.employee_id
   join public.hr_attendance_sites s on s.workspace_id=a.workspace_id and s.id=a.site_id
   where a.workspace_id=p_workspace_id
  ) x;
 return jsonb_build_object('sites',sites_value,'assignments',assignments_value);
end $$;

create function public.start_hr_qr_kiosk(p_workspace_id uuid,p_site_id uuid,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare kiosk_row public.hr_qr_kiosks; now_value timestamptz;
begin
 perform app_private.hr_require_management(p_workspace_id);
 if p_request_id is null or p_site_id is null then
  raise exception 'HR_QR_KIOSK_INPUT: Site and request ID are required.';
 end if;
 perform pg_advisory_xact_lock(hashtext(p_workspace_id::text||':hr_kiosk:'||p_request_id::text));
 select * into kiosk_row from public.hr_qr_kiosks
  where workspace_id=p_workspace_id and request_id=p_request_id;
 if found then
  if kiosk_row.site_id<>p_site_id or kiosk_row.created_by<>auth.uid() then
   raise exception 'HR_QR_IDEMPOTENCY: Request ID was used for another kiosk.';
  end if;
  return to_jsonb(kiosk_row);
 end if;
 perform 1 from public.hr_attendance_sites
  where workspace_id=p_workspace_id and id=p_site_id and is_active for share;
 if not found then raise exception 'HR_SITE_INACTIVE: Start kiosk at an active site.';end if;
 now_value:=clock_timestamp();
 insert into public.hr_qr_kiosks(workspace_id,site_id,request_id,created_by,created_at,expires_at)
  values(p_workspace_id,p_site_id,p_request_id,auth.uid(),now_value,now_value+interval '2 hours')
  returning * into kiosk_row;
 perform app_private.audit(p_workspace_id,'hr.qr_kiosk_started',kiosk_row.id,
  jsonb_build_object('site_id',p_site_id,'expires_at',kiosk_row.expires_at));
 return to_jsonb(kiosk_row);
end $$;

create function public.issue_hr_qr_challenge(p_workspace_id uuid,p_kiosk_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare kiosk_row public.hr_qr_kiosks; token_value uuid; now_value timestamptz;
 challenge_row public.hr_qr_challenges;
begin
 perform app_private.hr_require_management(p_workspace_id);
 select * into kiosk_row from public.hr_qr_kiosks
  where workspace_id=p_workspace_id and id=p_kiosk_id for share;
 if not found or kiosk_row.created_by<>auth.uid() then
  raise exception 'HR_QR_KIOSK_NOT_FOUND: Kiosk belongs to another manager or workspace.';
 end if;
 now_value:=clock_timestamp();
 if kiosk_row.stopped_at is not null or kiosk_row.expires_at<=now_value then
  raise exception 'HR_QR_KIOSK_EXPIRED: Start a new kiosk session.';
 end if;
 perform 1 from public.hr_attendance_sites
  where workspace_id=p_workspace_id and id=kiosk_row.site_id and is_active for share;
 if not found then raise exception 'HR_SITE_INACTIVE: Kiosk site is archived.';end if;
 token_value:=gen_random_uuid();
 insert into public.hr_qr_challenges(workspace_id,kiosk_id,site_id,token_hash,
   issued_at,expires_at,issued_by)
  values(p_workspace_id,kiosk_row.id,kiosk_row.site_id,md5(token_value::text),
   now_value,least(now_value+interval '30 seconds',kiosk_row.expires_at),auth.uid())
  returning * into challenge_row;
 return jsonb_build_object('token',token_value,'expires_at',challenge_row.expires_at);
end $$;

create function public.stop_hr_qr_kiosk(p_workspace_id uuid,p_kiosk_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare kiosk_row public.hr_qr_kiosks;
begin
 perform app_private.hr_require_management(p_workspace_id);
 select * into kiosk_row from public.hr_qr_kiosks
  where workspace_id=p_workspace_id and id=p_kiosk_id for update;
 if not found then raise exception 'HR_QR_KIOSK_NOT_FOUND';end if;
 if kiosk_row.stopped_at is null then
  update public.hr_qr_kiosks set stopped_at=clock_timestamp(),stopped_by=auth.uid()
   where workspace_id=p_workspace_id and id=p_kiosk_id returning * into kiosk_row;
  perform app_private.audit(p_workspace_id,'hr.qr_kiosk_stopped',p_kiosk_id);
 end if;
 return jsonb_build_object('id',kiosk_row.id,'stopped_at',kiosk_row.stopped_at);
end $$;

create function app_private.hr_scan_qr_core(p_workspace_id uuid,p_token uuid,p_action text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare employee_row public.hr_employees; challenge_row public.hr_qr_challenges;
 kiosk_row public.hr_qr_kiosks; schedule_row public.hr_work_schedules;
 attendance_row public.hr_attendance; previous_row public.hr_qr_attendance_events;
 event_row public.hr_qr_attendance_events; now_value timestamptz;
 action_value text:=lower(btrim(p_action)); hash_value text; candidate_count integer;
begin
 perform app_private.require_role(p_workspace_id,array['owner','manager','staff']);
 if p_token is null or p_request_id is null or p_action is null
   or action_value not in ('check_in','check_out') then
  raise exception 'HR_QR_INPUT: Token, action and request ID are required.';
 end if;
 hash_value:=md5(p_token::text||':'||action_value);
 perform pg_advisory_xact_lock(hashtext(p_workspace_id::text||':hr_scan_request:'||p_request_id::text));
 select * into previous_row from public.hr_qr_attendance_events
  where workspace_id=p_workspace_id and request_id=p_request_id;
 if found then
  if previous_row.actor_id<>auth.uid() or previous_row.request_hash<>hash_value then
   raise exception 'HR_QR_IDEMPOTENCY: Request ID was used for another scan.';
  end if;
  return jsonb_build_object('event_id',previous_row.id,'attendance_id',previous_row.attendance_id,
   'action',previous_row.action,'occurred_at',previous_row.occurred_at,
   'work_date',previous_row.work_date,'site_id',previous_row.site_id,
   'schedule_id',previous_row.schedule_id);
 end if;
 select * into employee_row from public.hr_employees e
  where e.workspace_id=p_workspace_id and e.auth_user_id=auth.uid()
   and e.is_active and e.status='active' for share;
 if not found then raise exception 'HR_QR_EMPLOYEE: Link an active employee to this login.';end if;
 perform app_private.hr_lock_employee(p_workspace_id,employee_row.id);
 select * into challenge_row from public.hr_qr_challenges c
  where c.workspace_id=p_workspace_id and c.token_hash=md5(p_token::text) for share;
 now_value:=clock_timestamp();
 if not found or challenge_row.expires_at<=now_value or challenge_row.issued_at>now_value then
  raise exception 'HR_QR_CHALLENGE_EXPIRED: Scan the current QR again.';
 end if;
 select * into kiosk_row from public.hr_qr_kiosks k
  where k.workspace_id=p_workspace_id and k.id=challenge_row.kiosk_id for share;
 if not found or kiosk_row.stopped_at is not null or kiosk_row.expires_at<=now_value then
  raise exception 'HR_QR_KIOSK_EXPIRED: Kiosk is no longer active.';
 end if;
 perform 1 from public.hr_attendance_sites s
  where s.workspace_id=p_workspace_id and s.id=challenge_row.site_id and s.is_active for share;
 if not found then raise exception 'HR_SITE_INACTIVE: Kiosk site is archived.';end if;
 select count(*) into candidate_count from public.hr_work_schedules s
  where s.workspace_id=p_workspace_id and s.employee_id=employee_row.id
   and now_value>=s.planned_start_at-interval '2 hours'
   and now_value<=s.planned_end_at+interval '4 hours';
 if candidate_count<>1 then
  raise exception 'HR_QR_SHIFT: No unique scheduled shift at this time.';
 end if;
 select * into schedule_row from public.hr_work_schedules s
  where s.workspace_id=p_workspace_id and s.employee_id=employee_row.id
   and now_value>=s.planned_start_at-interval '2 hours'
   and now_value<=s.planned_end_at+interval '4 hours' for share;
 if schedule_row.site_id is distinct from challenge_row.site_id then
  raise exception 'HR_QR_SITE_MISMATCH: Kiosk is at another shift site.';
 end if;
 perform 1 from public.hr_site_assignments a
  where a.workspace_id=p_workspace_id and a.employee_id=employee_row.id
   and a.site_id=challenge_row.site_id and a.valid_from<=schedule_row.work_date
   and (a.valid_to is null or a.valid_to>=schedule_row.work_date) for share;
 if not found then
  raise exception 'HR_QR_SITE_ASSIGNMENT: Employee is not assigned at the shift site.';
 end if;
 select * into attendance_row from public.hr_attendance a
  where a.workspace_id=p_workspace_id and a.schedule_id=schedule_row.id for update;
 if found and (attendance_row.status<>'draft' or attendance_row.kind<>'work') then
  raise exception 'HR_QR_ATTENDANCE_LOCKED: Manager must resolve this attendance.';
 end if;
 if action_value='check_in' then
  if attendance_row.id is not null then
   raise exception 'HR_QR_ALREADY_CHECKED_IN: This shift already has attendance.';
  end if;
  insert into public.hr_attendance(workspace_id,employee_id,work_date,schedule_id,
    clock_in_at,break_minutes,kind,created_request_id,create_hash,created_by)
   values(p_workspace_id,employee_row.id,schedule_row.work_date,schedule_row.id,
    now_value,schedule_row.break_minutes,'work',p_request_id,
    md5('qr:'||challenge_row.id::text||':check_in'),auth.uid())
   returning * into attendance_row;
 else
  if attendance_row.id is null or attendance_row.clock_in_at is null then
   raise exception 'HR_QR_CHECK_IN_REQUIRED: Check in before checking out.';
  end if;
  if not exists(select 1 from public.hr_qr_attendance_events e
    where e.workspace_id=p_workspace_id and e.schedule_id=schedule_row.id
     and e.employee_id=employee_row.id and e.action='check_in'
     and e.attendance_id=attendance_row.id) then
   raise exception 'HR_QR_CHECK_IN_REQUIRED: QR checkout needs a QR check-in event.';
  end if;
  if attendance_row.clock_out_at is not null then
   raise exception 'HR_QR_ALREADY_CHECKED_OUT: This shift is already complete.';
  end if;
  if now_value<=attendance_row.clock_in_at then
   raise exception 'HR_QR_CLOCK: Check-out must follow check-in.';
  end if;
  update public.hr_attendance set clock_out_at=now_value,
   updated_by=auth.uid(),updated_at=now_value
   where workspace_id=p_workspace_id and id=attendance_row.id
   returning * into attendance_row;
 end if;
 insert into public.hr_qr_attendance_events(workspace_id,employee_id,schedule_id,work_date,
   site_id,attendance_id,challenge_id,kiosk_id,action,occurred_at,request_id,request_hash,actor_id)
  values(p_workspace_id,employee_row.id,schedule_row.id,schedule_row.work_date,
   challenge_row.site_id,attendance_row.id,challenge_row.id,kiosk_row.id,
   action_value,now_value,p_request_id,hash_value,auth.uid()) returning * into event_row;
 perform app_private.audit(p_workspace_id,'hr.qr_'||action_value,event_row.id,
  jsonb_build_object('employee_id',employee_row.id,'schedule_id',schedule_row.id,
   'site_id',challenge_row.site_id,'attendance_id',attendance_row.id));
 return jsonb_build_object('event_id',event_row.id,'attendance_id',attendance_row.id,
  'action',event_row.action,'occurred_at',event_row.occurred_at,
  'work_date',event_row.work_date,'site_id',event_row.site_id,
  'schedule_id',event_row.schedule_id);
end $$;

create function public.scan_hr_qr(p_workspace_id uuid,p_token uuid,p_action text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare limit_row public.hr_qr_scan_limits; result jsonb; now_value timestamptz;
 failure_code text; prior public.hr_qr_attendance_events;
begin
 perform app_private.require_role(p_workspace_id,array['owner','manager','staff']);
 -- Serialize attempts by account so concurrent bad tokens cannot outrun a limit.
 perform pg_advisory_xact_lock(hashtext(p_workspace_id::text||':hr_qr_limit:'||auth.uid()::text));
 select * into prior from public.hr_qr_attendance_events
  where workspace_id=p_workspace_id and request_id=p_request_id;
 if found and prior.actor_id=auth.uid()
  and prior.request_hash=md5(p_token::text||':'||lower(btrim(p_action))) then
  return app_private.hr_scan_qr_core(p_workspace_id,p_token,p_action,p_request_id);
 end if;
 now_value:=clock_timestamp();
 select * into limit_row from public.hr_qr_scan_limits
  where workspace_id=p_workspace_id and actor_id=auth.uid() for update;
 if found and limit_row.window_start>now_value-interval '5 minutes'
    and limit_row.failed_count>=10 then
  return jsonb_build_object('ok',false,'error','HR_QR_RATE_LIMIT');
 end if;
 begin
  result:=app_private.hr_scan_qr_core(p_workspace_id,p_token,p_action,p_request_id);
  return result;
 exception when others then
  failure_code:=case when SQLERRM like 'HR_%' then split_part(SQLERRM,':',1)
   else 'HR_QR_REJECTED' end;
 end;
 insert into public.hr_qr_scan_limits(workspace_id,actor_id,window_start,failed_count,last_failed_at)
  values(p_workspace_id,auth.uid(),now_value,1,now_value)
 on conflict(workspace_id,actor_id) do update set
  window_start=case when hr_qr_scan_limits.window_start<=now_value-interval '5 minutes'
   then now_value else hr_qr_scan_limits.window_start end,
  failed_count=case when hr_qr_scan_limits.window_start<=now_value-interval '5 minutes'
   then 1 else hr_qr_scan_limits.failed_count+1 end,
  last_failed_at=now_value;
 return jsonb_build_object('ok',false,'error',failure_code);
end $$;

create function public.get_my_hr_attendance(p_workspace_id uuid,p_month date)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare employee_value uuid; from_date date; items_value jsonb;
begin
 perform app_private.require_role(p_workspace_id,array['owner','manager','staff']);
 if p_month is null or not isfinite(p_month) then raise exception 'HR_QR_MONTH: Valid month required.';end if;
 select e.id into employee_value from public.hr_employees e
  where e.workspace_id=p_workspace_id and e.auth_user_id=auth.uid()
   and e.is_active and e.status='active';
 if not found then raise exception 'HR_QR_EMPLOYEE: Link an active employee to this login.';end if;
 from_date:=date_trunc('month',p_month)::date;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.work_date desc,x.schedule_id),'[]'::jsonb)
  into items_value from (
   select s.id schedule_id,s.work_date,s.shift_name,s.planned_start_at,s.planned_end_at,
    s.site_id,site.name site_name,a.id attendance_id,a.kind,a.status,
    a.clock_in_at,a.clock_out_at,a.work_minutes,a.late_minutes,
    a.early_leave_minutes,a.overtime_minutes,
    (select coalesce(jsonb_agg(jsonb_build_object('action',ev.action,
      'occurred_at',ev.occurred_at) order by ev.occurred_at),'[]'::jsonb)
     from public.hr_qr_attendance_events ev
     where ev.workspace_id=s.workspace_id and ev.schedule_id=s.id) qr_events
   from public.hr_work_schedules s
   left join public.hr_attendance a on a.workspace_id=s.workspace_id and a.schedule_id=s.id
   left join public.hr_attendance_sites site on site.workspace_id=s.workspace_id and site.id=s.site_id
   where s.workspace_id=p_workspace_id and s.employee_id=employee_value
    and s.work_date>=from_date and s.work_date<(from_date+interval '1 month')::date
  ) x;
 return jsonb_build_object('employee_id',employee_value,'items',items_value);
end $$;

revoke all on function app_private.hr_site_assignment_guard(),
 app_private.hr_schedule_site_guard(),
 app_private.hr_scan_qr_core(uuid,uuid,text,uuid) from public,anon,authenticated;
revoke all on function public.save_hr_attendance_site(uuid,jsonb),
 public.save_hr_site_assignment(uuid,jsonb),
 public.bind_hr_work_schedule_site(uuid,uuid,uuid),
 public.list_hr_qr_setup(uuid),
 public.start_hr_qr_kiosk(uuid,uuid,uuid),
 public.issue_hr_qr_challenge(uuid,uuid),
 public.stop_hr_qr_kiosk(uuid,uuid),
 public.scan_hr_qr(uuid,uuid,text,uuid),
 public.get_my_hr_attendance(uuid,date) from public,anon;
grant execute on function public.save_hr_attendance_site(uuid,jsonb),
 public.save_hr_site_assignment(uuid,jsonb),
 public.bind_hr_work_schedule_site(uuid,uuid,uuid),
 public.list_hr_qr_setup(uuid),
 public.start_hr_qr_kiosk(uuid,uuid,uuid),
 public.issue_hr_qr_challenge(uuid,uuid),
 public.stop_hr_qr_kiosk(uuid,uuid),
 public.scan_hr_qr(uuid,uuid,text,uuid),
 public.get_my_hr_attendance(uuid,date) to authenticated;

commit;
