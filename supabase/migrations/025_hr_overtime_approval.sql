-- A manager's overtime decision is separate from confirmed attendance.
-- Payroll still uses the existing contract, component, expense and cash paths.
begin;

do $$begin
 if to_regprocedure('public.calculate_payroll(uuid,uuid)') is null
    or to_regprocedure('app_private.hr_assert_recurring_period_coverage(uuid,uuid)') is null
    or to_regclass('public.hr_attendance') is null then
  raise exception 'HR_OVERTIME_PREREQUISITE: Apply 018-020 and 024 first.';
 end if;
end $$;

create table public.hr_overtime_decisions (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id),
 attendance_id uuid not null,
 employee_id uuid not null,
 work_date date not null check(isfinite(work_date)),
 raw_minutes integer not null check(raw_minutes between 1 and 2160),
 approved_minutes integer not null check(approved_minutes between 0 and raw_minutes),
 reason text not null check(length(btrim(reason)) between 10 and 4000),
 request_id uuid not null,
 decided_by uuid not null references auth.users(id),
 decided_at timestamptz not null default clock_timestamp(),
 unique(workspace_id,id),unique(workspace_id,request_id),
 foreign key(workspace_id,attendance_id) references public.hr_attendance(workspace_id,id),
 foreign key(workspace_id,employee_id) references public.hr_employees(workspace_id,id)
);
create index hr_overtime_decisions_attendance_latest
 on public.hr_overtime_decisions(workspace_id,attendance_id,decided_at desc,id desc);
create index hr_overtime_decisions_employee_date
 on public.hr_overtime_decisions(workspace_id,employee_id,work_date);
alter table public.hr_overtime_decisions enable row level security;
create policy hr_overtime_manager_read on public.hr_overtime_decisions for select to authenticated
 using(app_private.member_role(workspace_id) in ('owner','manager'));
revoke all on public.hr_overtime_decisions from public,anon,authenticated;
grant select on public.hr_overtime_decisions to authenticated;
create trigger hr_overtime_decisions_immutable before update or delete on public.hr_overtime_decisions
 for each row execute function app_private.hr_protect_history();

create function public.review_hr_overtime(p_workspace_id uuid,p_attendance_id uuid,
 p_approved_minutes integer,p_reason text,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.hr_attendance; prior public.hr_overtime_decisions;
 result public.hr_overtime_decisions; clean_reason text:=btrim(p_reason);
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 if p_request_id is null then raise exception 'HR_OT_REQUEST: request ID is required.';end if;
 select * into prior from public.hr_overtime_decisions
  where workspace_id=p_workspace_id and request_id=p_request_id;
 if found then
  if prior.attendance_id is distinct from p_attendance_id
   or prior.approved_minutes is distinct from p_approved_minutes
   or prior.reason is distinct from clean_reason or prior.decided_by<>auth.uid() then
   raise exception 'HR_OT_REQUEST_REUSED: Request ID belongs to another decision.';
  end if;
  return to_jsonb(prior);
 end if;
 if clean_reason is null or length(clean_reason) not between 10 and 4000 then
  raise exception 'HR_OT_REASON: Enter a reason from 10 to 4000 characters.';
 end if;
 select * into a from public.hr_attendance
  where workspace_id=p_workspace_id and id=p_attendance_id for update;
 if not found or a.status<>'confirmed' or a.kind<>'work' or a.overtime_minutes<=0 then
  raise exception 'HR_OT_ATTENDANCE: Confirmed work with overtime is required.';
 end if;
 if p_approved_minutes is null or p_approved_minutes not between 0 and a.overtime_minutes then
  raise exception 'HR_OT_MINUTES: Approved minutes cannot exceed observed overtime.';
 end if;
 if exists(select 1 from public.hr_payroll_periods p
  where p.workspace_id=p_workspace_id and a.work_date between p.period_start and p.period_end
   and p.status in ('APPROVED','PAID')) then
  raise exception 'HR_OT_PAYROLL_LOCKED: Adjust overtime in a later period; approved payroll is immutable.';
 end if;
 insert into public.hr_overtime_decisions(workspace_id,attendance_id,employee_id,
  work_date,raw_minutes,approved_minutes,reason,request_id,decided_by)
 values(p_workspace_id,a.id,a.employee_id,a.work_date,a.overtime_minutes,
  p_approved_minutes,clean_reason,p_request_id,auth.uid()) returning * into result;
 perform app_private.hr_reset_unapproved_periods(p_workspace_id,a.employee_id,
  a.work_date,a.work_date,'overtime_decision_changed');
 perform app_private.audit(p_workspace_id,'hr.overtime.reviewed',result.id,
  jsonb_build_object('attendance_id',a.id,'employee_id',a.employee_id,
   'raw_minutes',a.overtime_minutes,'approved_minutes',p_approved_minutes,
   'reason',clean_reason,'request_id',p_request_id));
 return to_jsonb(result);
end $$;

create function public.list_hr_overtime_reviews(p_workspace_id uuid,p_month date,
 p_status text default null,p_page integer default 1,p_page_size integer default 25)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare first_day date;total_value integer;items_value jsonb;
begin
 perform app_private.require_role(p_workspace_id,array['owner','manager']);
 if p_month is null or not isfinite(p_month) then raise exception 'HR_OT_MONTH: Valid month is required.';end if;
 if p_status is not null and p_status not in ('pending','approved','rejected') then
  raise exception 'HR_OT_FILTER: Invalid review filter.';
 end if;
 if p_page is null or p_page not between 1 and 100000 or
  p_page_size is null or p_page_size not between 1 and 100 then
  raise exception 'HR_OT_PAGE: Invalid pagination.';
 end if;
 first_day:=date_trunc('month',p_month)::date;
 with rows as materialized (
  select a.id attendance_id,a.employee_id,a.work_date,a.overtime_minutes raw_minutes,
   a.clock_in_at,a.clock_out_at,e.code employee_code,e.full_name employee_name,
   s.shift_name,s.site_id,d.id decision_id,d.approved_minutes,d.reason,
   d.decided_at,d.decided_by,
   case when d.id is null or d.raw_minutes<>a.overtime_minutes then 'pending'
    when d.approved_minutes=0 then 'rejected' else 'approved' end review_status
  from public.hr_attendance a
  join public.hr_employees e on e.workspace_id=a.workspace_id and e.id=a.employee_id
  join public.hr_work_schedules s on s.workspace_id=a.workspace_id and s.id=a.schedule_id
  left join lateral (select * from public.hr_overtime_decisions x
   where x.workspace_id=a.workspace_id and x.attendance_id=a.id
   order by x.decided_at desc,x.id desc limit 1) d on true
  where a.workspace_id=p_workspace_id and a.work_date>=first_day
   and a.work_date<(first_day+interval '1 month')::date
   and a.status='confirmed' and a.kind='work' and a.overtime_minutes>0
 ), filtered as materialized (
  select * from rows where p_status is null or review_status=p_status
 )
 select (select count(*) from filtered),
  coalesce((select jsonb_agg(to_jsonb(x) order by x.work_date desc,x.attendance_id)
   from (select * from filtered order by work_date desc,attendance_id
    limit p_page_size offset (p_page-1)*p_page_size) x),'[]'::jsonb)
 into total_value,items_value;
 return jsonb_build_object('items',items_value,'total',total_value,
  'page',p_page,'page_size',p_page_size);
end $$;

-- Validate the actual approved minutes again at the payroll approval boundary.
create function app_private.hr_validate_overtime_period(p_workspace_id uuid,p_period_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare p public.hr_payroll_periods;line_row public.hr_payroll_lines;approved_total bigint;
begin
 select * into p from public.hr_payroll_periods
  where workspace_id=p_workspace_id and id=p_period_id;
 if not found then raise exception 'HR_PERIOD_NOT_FOUND: Payroll period is outside this workspace.';end if;
 if exists(
  select 1 from public.hr_attendance a
  join public.hr_payroll_lines l on l.workspace_id=a.workspace_id
   and l.period_id=p_period_id and l.employee_id=a.employee_id
  left join lateral (select d.id,d.raw_minutes from public.hr_overtime_decisions d
   where d.workspace_id=a.workspace_id and d.attendance_id=a.id
   order by d.decided_at desc,d.id desc limit 1) decision on true
  where a.workspace_id=p_workspace_id and a.work_date between p.period_start and p.period_end
   and a.status='confirmed' and a.kind='work' and a.overtime_minutes>0
   and (decision.id is null or decision.raw_minutes<>a.overtime_minutes)
 ) then raise exception 'HR_OT_REVIEW_REQUIRED: Review all confirmed overtime before payroll.';end if;
 for line_row in select * from public.hr_payroll_lines
  where workspace_id=p_workspace_id and period_id=p_period_id loop
  select coalesce(sum(decision.approved_minutes),0)::bigint into approved_total
   from public.hr_attendance a
   join lateral (select d.approved_minutes from public.hr_overtime_decisions d
    where d.workspace_id=a.workspace_id and d.attendance_id=a.id
    order by d.decided_at desc,d.id desc limit 1) decision on true
   where a.workspace_id=p_workspace_id and a.employee_id=line_row.employee_id
    and a.work_date between p.period_start and p.period_end
    and a.status='confirmed' and a.kind='work' and a.overtime_minutes>0;
  if line_row.overtime_minutes<>approved_total then
   raise exception 'HR_OT_PAYROLL_STALE: Recalculate payroll after overtime review.';
  end if;
 end loop;
end $$;

alter function public.calculate_payroll(uuid,uuid) rename to calculate_payroll_v2_internal;
revoke all on function public.calculate_payroll_v2_internal(uuid,uuid) from public,anon,authenticated;
create function public.calculate_payroll(p_workspace_id uuid,p_period_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare period_row public.hr_payroll_periods;line_row public.hr_payroll_lines;
 raw_value bigint;approved_value bigint;pay_value numeric;gross_value numeric;net_value numeric;
 snapshot_value jsonb;schedule_snapshot jsonb;gross_total_value numeric;net_total_value numeric;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 select * into period_row from public.hr_payroll_periods
  where workspace_id=p_workspace_id and id=p_period_id for update;
 if not found then raise exception 'HR_PERIOD_NOT_FOUND: Payroll period is outside this workspace.';end if;
 if period_row.status in ('APPROVED','PAID') then
  raise exception 'HR_PERIOD_LOCKED: Approved payroll is immutable.';
 end if;
 perform app_private.hr_assert_recurring_period_coverage(p_workspace_id,p_period_id);
 perform public.calculate_payroll_v2_internal(p_workspace_id,p_period_id);
 select * into period_row from public.hr_payroll_periods
  where workspace_id=p_workspace_id and id=p_period_id for update;
 for line_row in select * from public.hr_payroll_lines
  where workspace_id=p_workspace_id and period_id=p_period_id order by employee_id for update loop
  if exists(select 1 from public.hr_attendance a
   left join lateral (select d.id,d.raw_minutes from public.hr_overtime_decisions d
    where d.workspace_id=a.workspace_id and d.attendance_id=a.id
    order by d.decided_at desc,d.id desc limit 1) decision on true
   where a.workspace_id=p_workspace_id and a.employee_id=line_row.employee_id
    and a.work_date between period_row.period_start and period_row.period_end
    and a.status='confirmed' and a.kind='work' and a.overtime_minutes>0
    and (decision.id is null or decision.raw_minutes<>a.overtime_minutes)) then
   raise exception 'HR_OT_REVIEW_REQUIRED: Review all confirmed overtime before payroll.';
  end if;
  select coalesce(sum(a.overtime_minutes),0)::bigint,
   coalesce(sum(d.approved_minutes),0)::bigint,
   coalesce(jsonb_agg(jsonb_build_object('attendance_id',a.id,'raw_minutes',a.overtime_minutes,
    'approved_minutes',d.approved_minutes,'decision_id',d.id,'decided_at',d.decided_at)
    order by a.work_date,a.id),'[]'::jsonb)
   into raw_value,approved_value,snapshot_value
   from public.hr_attendance a
   join lateral (select * from public.hr_overtime_decisions x
    where x.workspace_id=a.workspace_id and x.attendance_id=a.id
    order by x.decided_at desc,x.id desc limit 1) d on true
   where a.workspace_id=p_workspace_id and a.employee_id=line_row.employee_id
    and a.work_date between period_row.period_start and period_row.period_end
    and a.status='confirmed' and a.kind='work' and a.overtime_minutes>0;
  pay_value:=case when line_row.pay_basis='monthly' then
    round(line_row.rate_vnd::numeric*approved_value*line_row.overtime_multiplier/line_row.standard_minutes)
   else round(line_row.rate_vnd::numeric*approved_value*line_row.overtime_multiplier/60) end;
  gross_value:=line_row.base_pay+pay_value+line_row.allowance_pay+line_row.bonus_pay+line_row.commission_pay;
  net_value:=gross_value-line_row.advance_deduction-line_row.other_deduction;
  if gross_value not between 0 and 9000000000000 or net_value not between 0 and 9000000000000 then
   raise exception 'HR_OT_PAYROLL_AMOUNT: Approved overtime leaves invalid payroll total.';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'work_date',s.work_date,
   'site_id',s.site_id,'planned_start_at',s.planned_start_at,
   'planned_end_at',s.planned_end_at,'break_minutes',s.break_minutes,
   'source_kind',s.source_kind,'recurring_assignment_id',s.recurring_assignment_id,
   'recurring_rule_id',s.recurring_rule_id,'recurring_rule_revision',s.recurring_rule_revision,
   'recurring_template_id',s.recurring_template_id,
   'recurring_template_revision',s.recurring_template_revision)
   order by s.work_date,s.id),'[]'::jsonb) into schedule_snapshot
  from public.hr_work_schedules s where s.workspace_id=p_workspace_id
   and s.employee_id=line_row.employee_id
   and s.work_date between period_row.period_start and period_row.period_end;
  update public.hr_payroll_lines set overtime_minutes=approved_value,
   overtime_pay=pay_value::bigint,gross_pay=gross_value::bigint,net_pay=net_value::bigint,
   source_snapshot=source_snapshot||jsonb_build_object('overtime_review',
    jsonb_build_object('raw_minutes',raw_value,'approved_minutes',approved_value,
     'decisions',snapshot_value),'schedule_sources',schedule_snapshot)
   where workspace_id=p_workspace_id and id=line_row.id;
 end loop;
 perform app_private.hr_validate_overtime_period(p_workspace_id,p_period_id);
 select coalesce(sum(gross_pay),0),coalesce(sum(net_pay),0)
  into gross_total_value,net_total_value from public.hr_payroll_lines
  where workspace_id=p_workspace_id and period_id=p_period_id;
 if gross_total_value>9000000000000 or net_total_value>9000000000000 then
  raise exception 'HR_OT_PAYROLL_AMOUNT: Payroll total exceeds allowed VND amount.';
 end if;
 update public.hr_payroll_periods set gross_total=gross_total_value::bigint,
  net_total=net_total_value::bigint,updated_at=clock_timestamp()
  where workspace_id=p_workspace_id and id=p_period_id returning * into period_row;
 perform app_private.hr_payroll_audit(p_workspace_id,'period.overtime_calculated',p_period_id,
  jsonb_build_object('gross_total',gross_total_value,'net_total',net_total_value));
 return to_jsonb(period_row);
end $$;

create function app_private.hr_guard_overtime_approval() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if old.status is distinct from new.status and new.status='APPROVED' then
  perform app_private.hr_assert_recurring_period_coverage(new.workspace_id,new.id);
  perform app_private.hr_validate_overtime_period(new.workspace_id,new.id);
 end if;
 return new;
end $$;
create trigger hr_guard_overtime_approval before update of status on public.hr_payroll_periods
 for each row execute function app_private.hr_guard_overtime_approval();

-- Materialize at most three business dates for an authenticated employee after
-- checking a live challenge. The existing QR core still validates the token,
-- site, unique shift, action, replay and rate limit. An invalid scan rolls the
-- generated rows back with the inner exception subtransaction.
create or replace function public.scan_hr_qr(p_workspace_id uuid,p_token uuid,p_action text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare limit_row public.hr_qr_scan_limits;result jsonb;now_value timestamptz;
 failure_code text;prior public.hr_qr_attendance_events;employee_value uuid;
 today_vn date;challenge_valid boolean;
begin
 perform app_private.require_role(p_workspace_id,array['owner','manager','staff']);
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
  if p_token is not null and p_request_id is not null
     and p_action is not null and lower(btrim(p_action)) in ('check_in','check_out') then
   select e.id into employee_value from public.hr_employees e
    where e.workspace_id=p_workspace_id and e.auth_user_id=auth.uid()
     and e.is_active and e.status='active';
   select exists(select 1 from public.hr_qr_challenges c
    join public.hr_qr_kiosks k on k.workspace_id=c.workspace_id and k.id=c.kiosk_id
    join public.hr_attendance_sites s on s.workspace_id=c.workspace_id and s.id=c.site_id
    where c.workspace_id=p_workspace_id and c.token_hash=md5(p_token::text)
     and c.issued_at<=now_value and c.expires_at>now_value
     and k.stopped_at is null and k.expires_at>now_value and s.is_active)
    into challenge_valid;
   if employee_value is not null and challenge_valid then
    today_vn:=(now_value at time zone 'Asia/Ho_Chi_Minh')::date;
    perform app_private.hr_ensure_recurring_for_employee(p_workspace_id,employee_value,
     today_vn-1,today_vn+1);
   end if;
  end if;
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

revoke all on function app_private.hr_validate_overtime_period(uuid,uuid),
 app_private.hr_guard_overtime_approval() from public,anon,authenticated;
revoke all on function public.review_hr_overtime(uuid,uuid,integer,text,uuid),
 public.list_hr_overtime_reviews(uuid,date,text,integer,integer),
 public.calculate_payroll(uuid,uuid) from public,anon;
grant execute on function public.review_hr_overtime(uuid,uuid,integer,text,uuid),
 public.list_hr_overtime_reviews(uuid,date,text,integer,integer),
 public.calculate_payroll(uuid,uuid) to authenticated;
commit;
