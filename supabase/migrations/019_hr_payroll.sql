-- HR payroll: explicit contract rules, reviewed calculation snapshots, and cash settlement.
begin;

create table public.hr_payroll_contracts (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id),
 employee_id uuid not null,
 effective_from date not null,
 effective_to date,
 pay_basis text not null check(pay_basis in ('monthly','hourly')),
 rate_vnd bigint not null check(rate_vnd between 1 and 9000000000000),
 standard_day_minutes integer not null check(standard_day_minutes between 1 and 1440),
 standard_month_minutes integer check(standard_month_minutes between 1 and 44640),
 overtime_multiplier numeric(6,3) not null check(overtime_multiplier between 0 and 10),
 paid_leave_types text[] not null default '{}',
 note text not null default '' check(length(note)<=4000),
 created_by uuid not null references auth.users(id),
 updated_by uuid references auth.users(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(workspace_id,id),
 foreign key(workspace_id,employee_id) references public.hr_employees(workspace_id,id),
 check(isfinite(effective_from) and (effective_to is null or (isfinite(effective_to) and effective_to>=effective_from))),
 check((pay_basis='monthly' and standard_month_minutes is not null) or (pay_basis='hourly' and standard_month_minutes is null)),
 check(cardinality(paid_leave_types)<=30)
);
create index hr_payroll_contracts_employee_dates on public.hr_payroll_contracts(workspace_id,employee_id,effective_from,effective_to);

create table public.hr_payroll_periods (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id),
 period_start date not null,
 period_end date not null,
 standard_minutes_override integer check(standard_minutes_override between 1 and 44640),
 overtime_multiplier_override numeric(6,3) check(overtime_multiplier_override between 0 and 10),
 status text not null default 'DRAFT' check(status in ('DRAFT','CALCULATED','REVIEWED','APPROVED','PAID')),
 employee_count integer not null default 0 check(employee_count>=0),
 gross_total bigint not null default 0 check(gross_total between 0 and 9000000000000),
 advance_total bigint not null default 0 check(advance_total between 0 and 9000000000000),
 net_total bigint not null default 0 check(net_total between 0 and 9000000000000),
 calculated_at timestamptz,
 reviewed_at timestamptz,
 reviewed_by uuid references auth.users(id),
 approved_at timestamptz,
 approved_by uuid references auth.users(id),
 paid_at timestamptz,
 paid_by uuid references auth.users(id),
 payment_account_id uuid,
 payment_date date,
 payment_request_id uuid,
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(workspace_id,id),
 unique(workspace_id,period_start,period_end),
 foreign key(workspace_id,payment_account_id) references public.cash_accounts(workspace_id,id),
 check(isfinite(period_start) and isfinite(period_end) and period_end>=period_start and period_end-period_start<=366),
 check((status='PAID')=(paid_at is not null))
);
create index hr_payroll_periods_workspace_dates on public.hr_payroll_periods(workspace_id,period_start,period_end);

create table public.hr_payroll_lines (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null,
 period_id uuid not null,
 employee_id uuid not null,
 contract_id uuid not null,
 pay_basis text not null check(pay_basis in ('monthly','hourly')),
 rate_vnd bigint not null check(rate_vnd between 1 and 9000000000000),
 standard_minutes integer,
 overtime_multiplier numeric(6,3) not null check(overtime_multiplier between 0 and 10),
 regular_minutes bigint not null check(regular_minutes>=0),
 paid_leave_minutes bigint not null check(paid_leave_minutes>=0),
 overtime_minutes bigint not null check(overtime_minutes>=0),
 base_pay bigint not null check(base_pay between 0 and 9000000000000),
 overtime_pay bigint not null check(overtime_pay between 0 and 9000000000000),
 gross_pay bigint not null check(gross_pay between 0 and 9000000000000),
 advance_deduction bigint not null check(advance_deduction between 0 and 9000000000000),
 net_pay bigint not null check(net_pay between 0 and 9000000000000),
 source_snapshot jsonb not null,
 paid_cash_id uuid,
 created_at timestamptz not null default now(),
 unique(workspace_id,id),
 unique(workspace_id,period_id,employee_id),
 unique(workspace_id,paid_cash_id),
 foreign key(workspace_id,period_id) references public.hr_payroll_periods(workspace_id,id),
 foreign key(workspace_id,employee_id) references public.hr_employees(workspace_id,id),
 foreign key(workspace_id,contract_id) references public.hr_payroll_contracts(workspace_id,id),
 foreign key(workspace_id,paid_cash_id) references public.cash_transactions(workspace_id,id),
 check(gross_pay=base_pay+overtime_pay and net_pay=gross_pay-advance_deduction),
 check((pay_basis='monthly' and standard_minutes is not null) or pay_basis='hourly')
);
create index hr_payroll_lines_period on public.hr_payroll_lines(workspace_id,period_id);

-- Recognition is independent of cash: advance and salary payment vouchers never add a second expense.
create table public.hr_payroll_expenses (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null,
 period_id uuid not null,
 line_id uuid not null,
 employee_id uuid not null,
 recognition_date date not null,
 amount bigint not null check(amount between 1 and 9000000000000),
 approved_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 unique(workspace_id,id),
 unique(workspace_id,line_id),
 foreign key(workspace_id,period_id) references public.hr_payroll_periods(workspace_id,id),
 foreign key(workspace_id,line_id) references public.hr_payroll_lines(workspace_id,id),
 foreign key(workspace_id,employee_id) references public.hr_employees(workspace_id,id)
);
create index hr_payroll_expenses_date on public.hr_payroll_expenses(workspace_id,recognition_date);

create table public.hr_salary_advances (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null,
 employee_id uuid not null,
 period_id uuid not null,
 account_id uuid not null,
 cash_id uuid not null,
 amount bigint not null check(amount between 1 and 9000000000000),
 transaction_date date not null check(isfinite(transaction_date)),
 request_id uuid not null,
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 unique(workspace_id,id),
 unique(workspace_id,cash_id),
 unique(workspace_id,request_id),
 foreign key(workspace_id,employee_id) references public.hr_employees(workspace_id,id),
 foreign key(workspace_id,period_id) references public.hr_payroll_periods(workspace_id,id),
 foreign key(workspace_id,account_id) references public.cash_accounts(workspace_id,id),
 foreign key(workspace_id,cash_id) references public.cash_transactions(workspace_id,id)
);
create index hr_salary_advances_period_employee on public.hr_salary_advances(workspace_id,period_id,employee_id);

-- Full before/after details are restricted; the shared audit stream receives only entity IDs.
create table public.hr_payroll_audit (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id),
 actor_id uuid not null references auth.users(id),
 action text not null,
 entity_id uuid not null,
 details jsonb not null default '{}',
 created_at timestamptz not null default now()
);
create index hr_payroll_audit_workspace_time on public.hr_payroll_audit(workspace_id,created_at desc);

do $$ declare t text; begin
 foreach t in array array['hr_payroll_contracts','hr_payroll_periods','hr_payroll_lines','hr_payroll_expenses','hr_salary_advances','hr_payroll_audit'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('create policy hr_manager_read on public.%I for select to authenticated using(app_private.member_role(workspace_id) in (''owner'',''manager''))',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
 end loop;
end $$;

create function app_private.hr_payroll_audit(p_workspace_id uuid,p_action text,p_entity_id uuid,p_details jsonb default '{}')
returns void language sql security definer set search_path='' as $$
 insert into public.hr_payroll_audit(workspace_id,actor_id,action,entity_id,details)
 values(p_workspace_id,auth.uid(),p_action,p_entity_id,coalesce(p_details,'{}'::jsonb))
$$;

-- Keep fixed HR settlement categories outside profit. Approval recognizes gross payroll separately.
update public.expense_categories set profit_eligible=false,is_active=true,archived_at=null,archived_by=null,archive_reason=null,
 updated_at=now() where code='payroll';
insert into public.expense_categories(workspace_id,code,name,direction,category_kind,profit_eligible,is_system,is_active,sort_order,created_by)
 select id,'salary_advance','Ứng lương','out','loan',false,true,true,71,created_by from public.workspaces
on conflict(workspace_id,code) do update set direction='out',category_kind='loan',profit_eligible=false,
 is_system=true,is_active=true,archived_at=null,archived_by=null,archive_reason=null,updated_at=now();
alter table public.expense_categories add constraint hr_payroll_cash_not_profit
 check(code not in ('payroll','salary_advance') or (direction='out' and not profit_eligible and is_active));

create function app_private.seed_hr_salary_advance_category() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 insert into public.expense_categories(workspace_id,code,name,direction,category_kind,profit_eligible,is_system,sort_order,created_by)
 values(new.id,'salary_advance','Ứng lương','out','loan',false,true,71,new.created_by);
 return new;
end $$;
create trigger seed_hr_salary_advance_category after insert on public.workspaces
 for each row execute function app_private.seed_hr_salary_advance_category();

-- HR voucher details must not leak through the otherwise workspace-wide cash tables.
create function app_private.hr_cash_visible(p_workspace_id uuid,p_cash_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select app_private.member_role(p_workspace_id) in ('owner','manager') or not (
  exists(select 1 from public.hr_salary_advances a where a.workspace_id=p_workspace_id and a.cash_id=p_cash_id)
  or exists(select 1 from public.hr_payroll_lines l where l.workspace_id=p_workspace_id and l.paid_cash_id=p_cash_id)
 )
$$;
drop policy member_read on public.cash_transactions;
create policy member_read on public.cash_transactions for select to authenticated
 using(app_private.member_role(workspace_id) is not null and app_private.hr_cash_visible(workspace_id,id));
drop policy member_read on public.cash_movements;
create policy member_read on public.cash_movements for select to authenticated
 using(app_private.member_role(workspace_id) is not null and app_private.hr_cash_visible(workspace_id,cash_id));
drop policy member_read on public.cash_category_snapshots;
create policy member_read on public.cash_category_snapshots for select to authenticated
 using(app_private.member_role(workspace_id) is not null and app_private.hr_cash_visible(workspace_id,cash_id));
drop policy member_read on public.audit_events;
create policy member_read on public.audit_events for select to authenticated
 using(app_private.member_role(workspace_id) is not null
  and (app_private.member_role(workspace_id) in ('owner','manager')
    or (action not like 'hr.%'
      and (entity_id is null or app_private.hr_cash_visible(workspace_id,entity_id)))));

-- The legacy workspace report is SECURITY DEFINER and therefore bypasses the
-- cash RLS above. Keep its existing implementation for periods without HR cash,
-- but do not disclose payroll/advance totals to staff or viewers indirectly.
alter function public.get_workspace_report(uuid,date,date) rename to get_workspace_report_v2_internal;
revoke all on function public.get_workspace_report_v2_internal(uuid,date,date) from public,anon,authenticated;
create function public.get_workspace_report(p_workspace_id uuid,p_from date,p_to date)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare report jsonb;old_overview jsonb;
begin
 perform app_private.require_role(p_workspace_id,array['owner','manager','staff','viewer']);
 report:=public.get_workspace_report_v2_internal(p_workspace_id,p_from,p_to);
 if app_private.member_role(p_workspace_id) not in ('owner','manager')
  and p_to is not null and exists(
   select 1 from public.hr_salary_advances a where a.workspace_id=p_workspace_id
    and a.transaction_date<=p_to
   union all
   select 1 from public.hr_payroll_lines l join public.cash_transactions c
    on c.workspace_id=l.workspace_id and c.id=l.paid_cash_id
    where l.workspace_id=p_workspace_id and c.transaction_date<=p_to
  ) then
  old_overview:=report->'overview';
  report:=jsonb_set(report,'{overview}',jsonb_build_object(
    'purchase_qty',old_overview->'purchase_qty',
    'purchase_amount',old_overview->'purchase_amount',
    'stock_qty_as_of',old_overview->'stock_qty_as_of',
    'stock_value_as_of',old_overview->'stock_value_as_of',
    'pending_purchase_count',old_overview->'pending_purchase_count'));
  report:=report||jsonb_build_object('cash_restricted',true,'cash_accounts','[]'::jsonb,
   'cash_categories','[]'::jsonb,'warnings',jsonb_build_array(jsonb_build_object(
    'code','HR_CASH_PRIVATE','message','Số liệu tiền trong kỳ có phiếu lương hoặc ứng lương; chỉ owner/manager được xem. Các số liệu kho vẫn có thể xem.')));
 end if;
 return report;
end $$;
revoke all on function public.get_workspace_report(uuid,date,date) from public,anon;
grant execute on function public.get_workspace_report(uuid,date,date) to authenticated;

-- Generic cash reversal/correction must not detach a posted HR voucher from its payroll snapshot.
create function app_private.protect_hr_cash_reversal() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.movement_kind='reversal' and (
  exists(select 1 from public.hr_salary_advances a where a.workspace_id=new.workspace_id and a.cash_id=new.cash_id)
  or exists(select 1 from public.hr_payroll_lines l where l.workspace_id=new.workspace_id and l.paid_cash_id=new.cash_id)
 ) then raise exception 'HR_CASH_LOCKED: HR cash voucher is linked to an approved payroll or salary advance.'; end if;
 return new;
end $$;
create trigger protect_hr_cash_reversal before insert on public.cash_movements
 for each row execute function app_private.protect_hr_cash_reversal();

-- Source corrections reopen only unapproved calculations. Approved payslips remain immutable snapshots.
create function app_private.hr_reset_unapproved_periods(p_workspace_id uuid,p_employee_id uuid,
 p_from date,p_to date,p_reason text) returns void
language plpgsql security definer set search_path='' as $$
declare period_id_value uuid;
begin
 if p_from is null or p_to is null then return;end if;
 for period_id_value in select p.id from public.hr_payroll_periods p
  where p.workspace_id=p_workspace_id and p.status in ('CALCULATED','REVIEWED')
   and p.period_start<=p_to and p.period_end>=p_from
   and (p_employee_id is null or exists(select 1 from public.hr_payroll_lines l
    where l.workspace_id=p_workspace_id and l.period_id=p.id and l.employee_id=p_employee_id))
  order by p.period_start,p.id for update loop
  update public.hr_payroll_periods set status='DRAFT',employee_count=0,gross_total=0,
   advance_total=0,net_total=0,calculated_at=null,reviewed_at=null,reviewed_by=null,
   updated_at=clock_timestamp() where workspace_id=p_workspace_id and id=period_id_value;
  delete from public.hr_payroll_lines where workspace_id=p_workspace_id and period_id=period_id_value;
  perform app_private.hr_payroll_audit(p_workspace_id,'period.reopened',period_id_value,
   jsonb_build_object('reason',p_reason,'employee_id',p_employee_id));
  perform app_private.audit(p_workspace_id,'hr.payroll_period.reopened',period_id_value,
   jsonb_build_object('reason',p_reason));
 end loop;
end $$;

create function app_private.hr_reopen_after_attendance() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op in ('UPDATE','DELETE') then
  perform app_private.hr_reset_unapproved_periods(old.workspace_id,old.employee_id,
   old.work_date,old.work_date,'attendance_changed');
 end if;
 if tg_op in ('INSERT','UPDATE') then
  perform app_private.hr_reset_unapproved_periods(new.workspace_id,new.employee_id,
   new.work_date,new.work_date,'attendance_changed');
 end if;
 return coalesce(new,old);
end $$;
create trigger hr_reopen_after_attendance after insert or update or delete on public.hr_attendance
 for each row execute function app_private.hr_reopen_after_attendance();

create function app_private.hr_reopen_after_leave() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op in ('UPDATE','DELETE') and old.status='approved' then
  perform app_private.hr_reset_unapproved_periods(old.workspace_id,old.employee_id,
   old.start_date,old.end_date,'paid_leave_changed');
 end if;
 if tg_op in ('INSERT','UPDATE') and new.status='approved' then
  perform app_private.hr_reset_unapproved_periods(new.workspace_id,new.employee_id,
   new.start_date,new.end_date,'paid_leave_changed');
 end if;
 return coalesce(new,old);
end $$;
create trigger hr_reopen_after_leave after insert or update or delete on public.hr_leave_requests
 for each row execute function app_private.hr_reopen_after_leave();

create function public.save_payroll_contract(p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare w uuid:=(p_payload->>'workspace_id')::uuid;
 rid uuid:=nullif(p_payload->>'id','')::uuid;
 old_row public.hr_payroll_contracts;
 result public.hr_payroll_contracts;
 employee_value uuid;
 from_value date;
 to_value date;
 basis_value text;
 rate_value bigint;
 day_value integer;
 month_value integer;
 multiplier_value numeric;
 leave_types text[];
 note_value text;
begin
 perform app_private.lock_inventory(w,array['owner','manager']);
 if rid is not null then
  select * into old_row from public.hr_payroll_contracts where workspace_id=w and id=rid for update;
  if not found then raise exception 'HR_CONTRACT_NOT_FOUND: Contract is outside this workspace.';end if;
 else rid:=gen_random_uuid();end if;
 employee_value:=coalesce(nullif(p_payload->>'employee_id','')::uuid,old_row.employee_id);
 from_value:=coalesce(nullif(p_payload->>'effective_from','')::date,old_row.effective_from);
 to_value:=case when p_payload ? 'effective_to' then nullif(p_payload->>'effective_to','')::date else old_row.effective_to end;
 basis_value:=coalesce(nullif(p_payload->>'pay_basis',''),old_row.pay_basis);
 rate_value:=app_private.amount(coalesce(p_payload->>'rate_vnd',old_row.rate_vnd::text),1);
 day_value:=coalesce(nullif(p_payload->>'standard_day_minutes','')::integer,old_row.standard_day_minutes);
 month_value:=case when p_payload ? 'standard_month_minutes' then nullif(p_payload->>'standard_month_minutes','')::integer else old_row.standard_month_minutes end;
 multiplier_value:=coalesce(nullif(p_payload->>'overtime_multiplier','')::numeric,old_row.overtime_multiplier);
 note_value:=coalesce(p_payload->>'note',old_row.note,'');
 if p_payload ? 'paid_leave_types' then
  if jsonb_typeof(p_payload->'paid_leave_types')<>'array' then raise exception 'HR_LEAVE_TYPES: Expected an array of leave types.';end if;
  select coalesce(array_agg(v),array[]::text[]) into leave_types
   from jsonb_array_elements_text(p_payload->'paid_leave_types') v;
 else leave_types:=coalesce(old_row.paid_leave_types,array[]::text[]);end if;
 if employee_value is null or not exists(select 1 from public.hr_employees e where e.workspace_id=w and e.id=employee_value) then
  raise exception 'HR_EMPLOYEE: Employee does not belong to this workspace.';
 end if;
 if from_value is null or not isfinite(from_value) or to_value is not null and (not isfinite(to_value) or to_value<from_value) then
  raise exception 'HR_CONTRACT_DATES: Valid effective dates are required.';
 end if;
 if basis_value is null or basis_value not in ('monthly','hourly') or day_value is null or day_value not between 1 and 1440
  or (basis_value='monthly' and (month_value is null or month_value not between 1 and 44640))
  or (basis_value='hourly' and month_value is not null)
  or multiplier_value is null or multiplier_value not between 0 and 10
  or length(note_value)>4000 or cardinality(leave_types)>30
  or exists(select 1 from unnest(leave_types) x where x is null or length(btrim(x)) not between 1 and 80) then
  raise exception 'HR_CONTRACT_RULES: Explicit pay basis, standard time and overtime multiplier are required.';
 end if;
 if exists(select 1 from public.hr_payroll_lines l join public.hr_payroll_periods p
   on p.workspace_id=l.workspace_id and p.id=l.period_id
   where l.workspace_id=w and l.contract_id=rid and p.status in ('APPROVED','PAID')) then
  if employee_value is distinct from old_row.employee_id or from_value is distinct from old_row.effective_from
   or basis_value is distinct from old_row.pay_basis or rate_value is distinct from old_row.rate_vnd
   or day_value is distinct from old_row.standard_day_minutes
   or month_value is distinct from old_row.standard_month_minutes
   or multiplier_value is distinct from old_row.overtime_multiplier
   or leave_types is distinct from old_row.paid_leave_types
   or exists(select 1 from public.hr_payroll_lines l join public.hr_payroll_periods p
    on p.workspace_id=l.workspace_id and p.id=l.period_id
    where l.workspace_id=w and l.contract_id=rid and p.status in ('APPROVED','PAID')
     and to_value is not null and p.period_end>to_value) then
   raise exception 'HR_CONTRACT_APPROVED: Preserve approved pay rules; only close the contract after its last approved period.';
  end if;
 end if;
 if exists(select 1 from public.hr_payroll_contracts c where c.workspace_id=w and c.employee_id=employee_value
  and c.id<>rid and c.effective_from<=coalesce(to_value,'infinity'::date)
  and coalesce(c.effective_to,'infinity'::date)>=from_value) then
  raise exception 'HR_CONTRACT_OVERLAP: Employee contracts cannot overlap.';
 end if;
 insert into public.hr_payroll_contracts(id,workspace_id,employee_id,effective_from,effective_to,
   pay_basis,rate_vnd,standard_day_minutes,standard_month_minutes,overtime_multiplier,paid_leave_types,note,created_by,updated_by)
 values(rid,w,employee_value,from_value,to_value,basis_value,rate_value,day_value,month_value,
   multiplier_value,leave_types,note_value,auth.uid(),auth.uid())
 on conflict(id) do update set employee_id=excluded.employee_id,effective_from=excluded.effective_from,
  effective_to=excluded.effective_to,pay_basis=excluded.pay_basis,rate_vnd=excluded.rate_vnd,
  standard_day_minutes=excluded.standard_day_minutes,standard_month_minutes=excluded.standard_month_minutes,
  overtime_multiplier=excluded.overtime_multiplier,paid_leave_types=excluded.paid_leave_types,
  note=excluded.note,updated_by=auth.uid(),updated_at=clock_timestamp()
 returning * into result;
 if old_row.id is not null then
  perform app_private.hr_reset_unapproved_periods(w,null,old_row.effective_from,
   coalesce(old_row.effective_to,'infinity'::date),'contract_changed');
 end if;
 perform app_private.hr_reset_unapproved_periods(w,null,from_value,
  coalesce(to_value,'infinity'::date),'contract_changed');
 perform app_private.hr_payroll_audit(w,'contract.saved',rid,jsonb_build_object('before',to_jsonb(old_row),'after',to_jsonb(result)));
 perform app_private.audit(w,'hr.payroll_contract.saved',rid);
 return to_jsonb(result);
end $$;

create function public.save_payroll_period(p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare w uuid:=(p_payload->>'workspace_id')::uuid;
 rid uuid:=nullif(p_payload->>'id','')::uuid;
 old_row public.hr_payroll_periods;
 result public.hr_payroll_periods;
 start_value date;
 end_value date;
 minutes_value integer;
 multiplier_value numeric;
begin
 perform app_private.lock_inventory(w,array['owner','manager']);
 if rid is not null then
  select * into old_row from public.hr_payroll_periods where workspace_id=w and id=rid for update;
  if not found then raise exception 'HR_PERIOD_NOT_FOUND: Payroll period is outside this workspace.';end if;
  if old_row.status in ('APPROVED','PAID') then raise exception 'HR_PERIOD_LOCKED: Approved payroll is immutable.';end if;
 else rid:=gen_random_uuid();end if;
 start_value:=coalesce(nullif(p_payload->>'period_start','')::date,old_row.period_start);
 end_value:=coalesce(nullif(p_payload->>'period_end','')::date,old_row.period_end);
 minutes_value:=case when p_payload ? 'standard_minutes_override' then nullif(p_payload->>'standard_minutes_override','')::integer else old_row.standard_minutes_override end;
 multiplier_value:=case when p_payload ? 'overtime_multiplier_override' then nullif(p_payload->>'overtime_multiplier_override','')::numeric else old_row.overtime_multiplier_override end;
 if start_value is null or end_value is null or not isfinite(start_value) or not isfinite(end_value)
  or end_value<start_value or end_value-start_value>366
  or minutes_value is not null and minutes_value not between 1 and 44640
  or multiplier_value is not null and multiplier_value not between 0 and 10 then
  raise exception 'HR_PERIOD_RULES: Valid dates and explicit overrides are required.';
 end if;
 if old_row.id is not null and (start_value<>old_row.period_start or end_value<>old_row.period_end) then
  raise exception 'HR_PERIOD_DATES: Create a new period to change dates.';
 end if;
 if exists(select 1 from public.hr_payroll_periods p where p.workspace_id=w and p.id<>rid
   and p.period_start<=end_value and p.period_end>=start_value) then
  raise exception 'HR_PERIOD_OVERLAP: Payroll periods cannot overlap.';
 end if;
 if old_row.id is not null and old_row.standard_minutes_override is not distinct from minutes_value
  and old_row.overtime_multiplier_override is not distinct from multiplier_value then return to_jsonb(old_row);end if;
 if old_row.id is not null then
  delete from public.hr_payroll_lines where workspace_id=w and period_id=rid;
 end if;
 insert into public.hr_payroll_periods(id,workspace_id,period_start,period_end,
   standard_minutes_override,overtime_multiplier_override,status,created_by)
 values(rid,w,start_value,end_value,minutes_value,multiplier_value,'DRAFT',auth.uid())
 on conflict(id) do update set standard_minutes_override=excluded.standard_minutes_override,
  overtime_multiplier_override=excluded.overtime_multiplier_override,status='DRAFT',
  employee_count=0,gross_total=0,advance_total=0,net_total=0,calculated_at=null,
  reviewed_at=null,reviewed_by=null,updated_at=clock_timestamp()
 returning * into result;
 perform app_private.hr_payroll_audit(w,'period.saved',rid,jsonb_build_object('before',to_jsonb(old_row),'after',to_jsonb(result)));
 perform app_private.audit(w,'hr.payroll_period.saved',rid);
 return to_jsonb(result);
end $$;

create function public.calculate_payroll(p_workspace_id uuid,p_period_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p public.hr_payroll_periods;
 c public.hr_payroll_contracts;
 employee_total integer:=0;
 regular_value bigint;
 overtime_value bigint;
 leave_value bigint;
 advance_value bigint;
 standard_value integer;
 multiplier_value numeric;
 base_value bigint;
 overtime_pay_value bigint;
 gross_value bigint;
 net_value bigint;
 gross_total_value numeric:=0;
 advance_total_value numeric:=0;
 net_total_value numeric:=0;
 snapshot_value jsonb;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 select * into p from public.hr_payroll_periods where workspace_id=p_workspace_id and id=p_period_id for update;
 if not found then raise exception 'HR_PERIOD_NOT_FOUND: Payroll period is outside this workspace.';end if;
 if p.status in ('APPROVED','PAID') then raise exception 'HR_PERIOD_LOCKED: Approved payroll is immutable.';end if;
 if exists(select 1 from public.hr_payroll_contracts c0 where c0.workspace_id=p_workspace_id
   and c0.effective_from<=p.period_end and coalesce(c0.effective_to,'infinity'::date)>=p.period_start
   and (c0.effective_from>p.period_start or c0.effective_to<p.period_end)) then
  raise exception 'HR_CONTRACT_SPLIT_PERIOD: A contract changes inside this payroll period. Split the period at that date.';
 end if;
 delete from public.hr_payroll_lines where workspace_id=p_workspace_id and period_id=p_period_id;
 for c in select * from public.hr_payroll_contracts c0 where c0.workspace_id=p_workspace_id
  and c0.effective_from<=p.period_start and (c0.effective_to is null or c0.effective_to>=p.period_end)
  order by c0.employee_id loop
  if exists(select 1 from public.hr_attendance a where a.workspace_id=p_workspace_id and a.employee_id=c.employee_id
    and a.work_date between p.period_start and p.period_end and a.status='draft') then
   raise exception 'HR_ATTENDANCE_DRAFT: Confirm or remove draft attendance before payroll calculation.';
  end if;
  if exists(select 1 from public.hr_work_schedules s where s.workspace_id=p_workspace_id
    and s.employee_id=c.employee_id and s.work_date between p.period_start and p.period_end
    and not exists(select 1 from public.hr_attendance a where a.workspace_id=s.workspace_id
      and a.schedule_id=s.id and a.status='confirmed')) then
   raise exception 'HR_ATTENDANCE_MISSING: Every scheduled shift needs confirmed attendance before payroll calculation.';
  end if;
  if exists(select 1 from public.hr_attendance a where a.workspace_id=p_workspace_id and a.employee_id=c.employee_id
    and a.work_date between p.period_start and p.period_end and a.status='confirmed' and a.kind='work'
    and (a.work_minutes is null or a.overtime_minutes>a.work_minutes)) then
   raise exception 'HR_ATTENDANCE_MINUTES: Confirmed work needs valid minutes and overtime.';
  end if;
  if exists(select 1 from public.hr_leave_requests l where l.workspace_id=p_workspace_id and l.employee_id=c.employee_id
    and l.status='approved' and l.leave_type=any(c.paid_leave_types)
    and l.start_date<=p.period_end and l.end_date>=p.period_start
    and (l.start_date<p.period_start or l.end_date>p.period_end)) then
   raise exception 'HR_LEAVE_SPLIT_PERIOD: Paid leave crossing payroll periods must be split before calculation.';
  end if;
  select coalesce(sum(greatest(a.work_minutes-a.overtime_minutes,0)),0)::bigint,
   coalesce(sum(a.overtime_minutes),0)::bigint into regular_value,overtime_value
   from public.hr_attendance a where a.workspace_id=p_workspace_id and a.employee_id=c.employee_id
    and a.work_date between p.period_start and p.period_end and a.status='confirmed' and a.kind='work';
  select coalesce(round(sum(case when l.duration_unit='day' then l.quantity*c.standard_day_minutes
    else l.quantity*60 end)),0)::bigint into leave_value
   from public.hr_leave_requests l where l.workspace_id=p_workspace_id and l.employee_id=c.employee_id
    and l.status='approved' and l.leave_type=any(c.paid_leave_types)
    and l.start_date>=p.period_start and l.end_date<=p.period_end;
  select coalesce(sum(a.amount),0)::bigint into advance_value from public.hr_salary_advances a
   where a.workspace_id=p_workspace_id and a.period_id=p_period_id and a.employee_id=c.employee_id;
  standard_value:=case when c.pay_basis='monthly' then coalesce(p.standard_minutes_override,c.standard_month_minutes) end;
  multiplier_value:=coalesce(p.overtime_multiplier_override,c.overtime_multiplier);
  if c.pay_basis='monthly' then
   base_value:=round(c.rate_vnd::numeric*least(regular_value+leave_value,standard_value)/standard_value)::bigint;
   overtime_pay_value:=round(c.rate_vnd::numeric*overtime_value*multiplier_value/standard_value)::bigint;
  else
   base_value:=round(c.rate_vnd::numeric*(regular_value+leave_value)/60)::bigint;
   overtime_pay_value:=round(c.rate_vnd::numeric*overtime_value*multiplier_value/60)::bigint;
  end if;
  gross_value:=base_value+overtime_pay_value;
  if gross_value>9000000000000 or advance_value>gross_value then
   raise exception 'HR_PAYROLL_AMOUNT: Gross pay exceeds limit or salary advances exceed earned pay for employee %.',c.employee_id;
  end if;
  net_value:=gross_value-advance_value;
  snapshot_value:=jsonb_build_object(
   'contract',to_jsonb(c),
   'employee',(select jsonb_build_object('id',e.id,'code',e.code,'full_name',e.full_name,
      'department_id',e.department_id,'department_name',d.name,'position_id',e.position_id,
      'position_name',pos.name)
     from public.hr_employees e
     left join public.hr_departments d on d.workspace_id=e.workspace_id and d.id=e.department_id
     left join public.hr_positions pos on pos.workspace_id=e.workspace_id and pos.id=e.position_id
     where e.workspace_id=p_workspace_id and e.id=c.employee_id),
   'attendance',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'work_date',a.work_date,
     'work_minutes',a.work_minutes,'overtime_minutes',a.overtime_minutes) order by a.work_date,a.id)
    from public.hr_attendance a where a.workspace_id=p_workspace_id and a.employee_id=c.employee_id
     and a.work_date between p.period_start and p.period_end and a.status='confirmed' and a.kind='work'),'[]'::jsonb),
   'paid_leave',coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'type',l.leave_type,
     'start_date',l.start_date,'end_date',l.end_date,'quantity',l.quantity,'duration_unit',l.duration_unit) order by l.start_date,l.id)
    from public.hr_leave_requests l where l.workspace_id=p_workspace_id and l.employee_id=c.employee_id
     and l.status='approved' and l.leave_type=any(c.paid_leave_types)
     and l.start_date>=p.period_start and l.end_date<=p.period_end),'[]'::jsonb),
   'advances',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'cash_id',a.cash_id,
     'date',a.transaction_date,'amount',a.amount) order by a.transaction_date,a.id)
    from public.hr_salary_advances a where a.workspace_id=p_workspace_id and a.period_id=p_period_id
     and a.employee_id=c.employee_id),'[]'::jsonb),
   'standard_minutes',standard_value,'overtime_multiplier',multiplier_value);
  insert into public.hr_payroll_lines(workspace_id,period_id,employee_id,contract_id,pay_basis,rate_vnd,
   standard_minutes,overtime_multiplier,regular_minutes,paid_leave_minutes,overtime_minutes,
   base_pay,overtime_pay,gross_pay,advance_deduction,net_pay,source_snapshot)
   values(p_workspace_id,p_period_id,c.employee_id,c.id,c.pay_basis,c.rate_vnd,standard_value,multiplier_value,
    regular_value,leave_value,overtime_value,base_value,overtime_pay_value,gross_value,advance_value,net_value,snapshot_value);
  employee_total:=employee_total+1;
  gross_total_value:=gross_total_value+gross_value;
  advance_total_value:=advance_total_value+advance_value;
  net_total_value:=net_total_value+net_value;
 end loop;
 if exists(select 1 from public.hr_salary_advances a
  where a.workspace_id=p_workspace_id and a.period_id=p_period_id
   and not exists(select 1 from public.hr_payroll_lines l
    where l.workspace_id=a.workspace_id and l.period_id=a.period_id and l.employee_id=a.employee_id)) then
  raise exception 'HR_ADVANCE_UNMATCHED: A posted salary advance has no payslip in the selected period.';
 end if;
 if employee_total=0 then raise exception 'HR_NO_CONTRACTS: No employee contract covers this payroll period.';end if;
 if gross_total_value>9000000000000 or advance_total_value>9000000000000 or net_total_value>9000000000000 then
  raise exception 'HR_PAYROLL_TOTAL: Payroll total exceeds allowed VND amount.';
 end if;
 update public.hr_payroll_periods set status='CALCULATED',employee_count=employee_total,
  gross_total=gross_total_value::bigint,advance_total=advance_total_value::bigint,net_total=net_total_value::bigint,
  calculated_at=clock_timestamp(),reviewed_at=null,reviewed_by=null,updated_at=clock_timestamp()
  where workspace_id=p_workspace_id and id=p_period_id returning * into p;
 perform app_private.hr_payroll_audit(p_workspace_id,'period.calculated',p_period_id,
  jsonb_build_object('period',to_jsonb(p),'employee_count',employee_total));
 perform app_private.audit(p_workspace_id,'hr.payroll_period.calculated',p_period_id,
  jsonb_build_object('employee_count',employee_total));
 return to_jsonb(p);
end $$;

create function public.review_payroll(p_workspace_id uuid,p_period_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p public.hr_payroll_periods;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 select * into p from public.hr_payroll_periods where workspace_id=p_workspace_id and id=p_period_id for update;
 if not found then raise exception 'HR_PERIOD_NOT_FOUND: Payroll period is outside this workspace.';end if;
 if p.status='REVIEWED' then return to_jsonb(p);end if;
 if p.status<>'CALCULATED' then raise exception 'HR_REVIEW_STATE: Calculate payroll before review.';end if;
 update public.hr_payroll_periods set status='REVIEWED',reviewed_by=auth.uid(),
  reviewed_at=clock_timestamp(),updated_at=clock_timestamp()
  where workspace_id=p_workspace_id and id=p_period_id returning * into p;
 perform app_private.hr_payroll_audit(p_workspace_id,'period.reviewed',p_period_id,to_jsonb(p));
 perform app_private.audit(p_workspace_id,'hr.payroll_period.reviewed',p_period_id);
 return to_jsonb(p);
end $$;

create function public.approve_payroll(p_workspace_id uuid,p_period_id uuid,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p public.hr_payroll_periods;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 if p_request_id is null then raise exception 'HR_REQUEST: request_id is required.';end if;
 select * into p from public.hr_payroll_periods where workspace_id=p_workspace_id and id=p_period_id for update;
 if not found then raise exception 'HR_PERIOD_NOT_FOUND: Payroll period is outside this workspace.';end if;
 perform app_private.remember(p_workspace_id,p_request_id,'hr.payroll.approve',p_period_id);
 if p.status in ('APPROVED','PAID') then return to_jsonb(p);end if;
 if p.status<>'REVIEWED' then raise exception 'HR_APPROVAL_STATE: Review the calculated payroll before approval.';end if;
 if p.employee_count<>(select count(*) from public.hr_payroll_lines where workspace_id=p_workspace_id and period_id=p_period_id)
  or p.gross_total<>(select coalesce(sum(gross_pay),0) from public.hr_payroll_lines where workspace_id=p_workspace_id and period_id=p_period_id)
  or p.advance_total<>(select coalesce(sum(advance_deduction),0) from public.hr_payroll_lines where workspace_id=p_workspace_id and period_id=p_period_id) then
  raise exception 'HR_APPROVAL_TOTALS: Payroll detail no longer matches the period totals.';
 end if;
 insert into public.hr_payroll_expenses(workspace_id,period_id,line_id,employee_id,recognition_date,amount,approved_by)
  select l.workspace_id,l.period_id,l.id,l.employee_id,p.period_end,l.gross_pay,auth.uid()
  from public.hr_payroll_lines l where l.workspace_id=p_workspace_id and l.period_id=p_period_id and l.gross_pay>0;
 update public.hr_payroll_periods set status='APPROVED',approved_at=clock_timestamp(),approved_by=auth.uid(),
  updated_at=clock_timestamp() where workspace_id=p_workspace_id and id=p_period_id returning * into p;
 perform app_private.hr_payroll_audit(p_workspace_id,'period.approved',p_period_id,
  jsonb_build_object('period',to_jsonb(p),'request_id',p_request_id));
 perform app_private.audit(p_workspace_id,'hr.payroll_period.approved',p_period_id,
  jsonb_build_object('request_id',p_request_id));
 return to_jsonb(p);
end $$;

create function public.pay_payroll(p_workspace_id uuid,p_period_id uuid,p_account_id uuid,
 p_payment_date date,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p public.hr_payroll_periods;
 l public.hr_payroll_lines;
 cash_id_value uuid;
 payment_count integer:=0;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 if p_request_id is null then raise exception 'HR_REQUEST: request_id is required.';end if;
 select * into p from public.hr_payroll_periods where workspace_id=p_workspace_id and id=p_period_id for update;
 if not found then raise exception 'HR_PERIOD_NOT_FOUND: Payroll period is outside this workspace.';end if;
 perform app_private.remember(p_workspace_id,p_request_id,'hr.payroll.pay',p_period_id);
 if p.status='PAID' then
  if p.payment_account_id is distinct from p_account_id or p.payment_date is distinct from p_payment_date then
   raise exception 'HR_PAYMENT_ALREADY_POSTED: Paid period has different account or payment date.';
  end if;
  return to_jsonb(p);
 end if;
 if p.status<>'APPROVED' then raise exception 'HR_PAYMENT_STATE: Approve payroll before payment.';end if;
 if p_payment_date is null or not isfinite(p_payment_date) or p_payment_date<p.period_end
  or p_payment_date>(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date then
  raise exception 'HR_PAYMENT_DATE: Actual payment date must be from period end through today in Viet Nam.';
 end if;
 if p_account_id is null or not exists(select 1 from public.cash_accounts a where a.workspace_id=p_workspace_id and a.id=p_account_id) then
  raise exception 'HR_PAYMENT_ACCOUNT: Cash account is outside this workspace.';
 end if;
 for l in select * from public.hr_payroll_lines where workspace_id=p_workspace_id and period_id=p_period_id order by employee_id loop
  if l.net_pay=0 then continue;end if;
  if l.paid_cash_id is not null then raise exception 'HR_PAYMENT_ALREADY_POSTED: Payroll line already has a cash voucher.';end if;
  insert into public.cash_transactions(workspace_id,account_id,direction,transaction_date,date_estimated,
   category,amount,description,notes,provenance,created_by)
   values(p_workspace_id,p_account_id,'out',p_payment_date,false,'payroll',l.net_pay,
    'Thanh toán lương '||coalesce(l.source_snapshot->'employee'->>'full_name','')||' · '||p.period_start::text||' đến '||p.period_end::text,'',
    jsonb_build_object('kind','hr_payroll','period_id',p_period_id,'line_id',l.id,'employee_id',l.employee_id),auth.uid())
   returning id into cash_id_value;
  update public.hr_payroll_lines set paid_cash_id=cash_id_value where workspace_id=p_workspace_id and id=l.id;
  perform public.post_cash(cash_id_value,gen_random_uuid());
  payment_count:=payment_count+1;
 end loop;
 update public.hr_payroll_periods set status='PAID',paid_at=clock_timestamp(),paid_by=auth.uid(),
  payment_account_id=p_account_id,payment_date=p_payment_date,payment_request_id=p_request_id,
  updated_at=clock_timestamp() where workspace_id=p_workspace_id and id=p_period_id returning * into p;
 perform app_private.hr_payroll_audit(p_workspace_id,'period.paid',p_period_id,
  jsonb_build_object('period',to_jsonb(p),'cash_count',payment_count,'request_id',p_request_id));
 perform app_private.audit(p_workspace_id,'hr.payroll_period.paid',p_period_id,
  jsonb_build_object('cash_count',payment_count,'request_id',p_request_id));
 return to_jsonb(p);
end $$;

create function public.create_salary_advance(p_workspace_id uuid,p_employee_id uuid,p_period_id uuid,
 p_account_id uuid,p_amount bigint,p_transaction_date date,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p public.hr_payroll_periods;
 prior public.hr_salary_advances;
 result public.hr_salary_advances;
 cash_id_value uuid;
 amount_value bigint;
 employee_name text;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 if p_request_id is null then raise exception 'HR_REQUEST: request_id is required.';end if;
 select * into prior from public.hr_salary_advances where workspace_id=p_workspace_id and request_id=p_request_id;
 if found then
  if prior.employee_id is distinct from p_employee_id or prior.period_id is distinct from p_period_id
   or prior.account_id is distinct from p_account_id or prior.amount is distinct from p_amount
   or prior.transaction_date is distinct from p_transaction_date then
   raise exception 'HR_REQUEST_REUSED: request_id already belongs to a different advance.';
  end if;
  perform app_private.remember(p_workspace_id,p_request_id,'hr.payroll.advance',prior.id);
  return to_jsonb(prior);
 end if;
 amount_value:=app_private.amount(p_amount::text,1);
 select * into p from public.hr_payroll_periods where workspace_id=p_workspace_id and id=p_period_id for update;
 if not found then raise exception 'HR_PERIOD_NOT_FOUND: Payroll period is outside this workspace.';end if;
 if p.status in ('APPROVED','PAID') then raise exception 'HR_PERIOD_LOCKED: Advance target period is already approved.';end if;
 if p_transaction_date is null or not isfinite(p_transaction_date) or p_transaction_date>p.period_end
  or p_transaction_date>(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date then
  raise exception 'HR_ADVANCE_DATE: Actual advance date must be on or before period end and today in Viet Nam.';
 end if;
 select e.full_name into employee_name from public.hr_employees e
  where e.workspace_id=p_workspace_id and e.id=p_employee_id;
 if employee_name is null then
  raise exception 'HR_EMPLOYEE: Employee is outside this workspace.';
 end if;
 if not exists(select 1 from public.hr_payroll_contracts c
   where c.workspace_id=p_workspace_id and c.employee_id=p_employee_id
    and c.effective_from<=p.period_start
    and (c.effective_to is null or c.effective_to>=p.period_end)) then
  raise exception 'HR_ADVANCE_CONTRACT: Selected employee needs a contract covering the whole target payroll period.';
 end if;
 if p_account_id is null or not exists(select 1 from public.cash_accounts a where a.workspace_id=p_workspace_id and a.id=p_account_id) then
  raise exception 'HR_PAYMENT_ACCOUNT: Cash account is outside this workspace.';
 end if;
 insert into public.cash_transactions(workspace_id,account_id,direction,transaction_date,date_estimated,
  category,amount,description,notes,provenance,created_by)
  values(p_workspace_id,p_account_id,'out',p_transaction_date,false,'salary_advance',amount_value,
   'Ứng lương '||employee_name||' · kỳ '||p.period_start::text||' đến '||p.period_end::text,'',
   jsonb_build_object('kind','hr_salary_advance','period_id',p_period_id,'employee_id',p_employee_id),auth.uid())
  returning id into cash_id_value;
 insert into public.hr_salary_advances(workspace_id,employee_id,period_id,account_id,cash_id,amount,
  transaction_date,request_id,created_by)
  values(p_workspace_id,p_employee_id,p_period_id,p_account_id,cash_id_value,amount_value,
   p_transaction_date,p_request_id,auth.uid()) returning * into result;
 perform public.post_cash(cash_id_value,gen_random_uuid());
 if p.status in ('CALCULATED','REVIEWED') then
  delete from public.hr_payroll_lines where workspace_id=p_workspace_id and period_id=p_period_id;
  update public.hr_payroll_periods set status='DRAFT',employee_count=0,gross_total=0,advance_total=0,
   net_total=0,calculated_at=null,reviewed_at=null,reviewed_by=null,updated_at=clock_timestamp()
   where workspace_id=p_workspace_id and id=p_period_id;
 end if;
 perform app_private.remember(p_workspace_id,p_request_id,'hr.payroll.advance',result.id);
 perform app_private.hr_payroll_audit(p_workspace_id,'advance.posted',result.id,
  jsonb_build_object('advance',to_jsonb(result),'cash_id',cash_id_value));
 perform app_private.audit(p_workspace_id,'hr.salary_advance.posted',result.id,
  jsonb_build_object('period_id',p_period_id));
 return to_jsonb(result);
end $$;

-- Bounded owner/manager read model for payroll setup, payslips and the six-month chart.
create function public.get_hr_payroll_state(p_workspace_id uuid,p_period_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare selected_id uuid;
 result jsonb;
begin
 perform app_private.require_role(p_workspace_id,array['owner','manager']);
 if (select count(*) from public.hr_payroll_contracts where workspace_id=p_workspace_id)>500 then
  raise exception 'HR_CONTRACT_RESULT_LIMIT: More than 500 contracts; narrow the workspace before loading payroll.';
 end if;
 selected_id:=coalesce(p_period_id,(select id from public.hr_payroll_periods
  where workspace_id=p_workspace_id order by period_start desc,id desc limit 1));
 if p_period_id is not null and not exists(select 1 from public.hr_payroll_periods
  where workspace_id=p_workspace_id and id=p_period_id) then
  raise exception 'HR_PERIOD_NOT_FOUND: Payroll period is outside this workspace.';
 end if;
 select jsonb_build_object(
  'periods',coalesce((select jsonb_agg(to_jsonb(p) order by p.period_start desc,p.id desc)
   from (select * from public.hr_payroll_periods where workspace_id=p_workspace_id
     order by period_start desc,id desc limit 24) p),'[]'::jsonb),
  'selected_period',(select to_jsonb(p) from public.hr_payroll_periods p
   where p.workspace_id=p_workspace_id and p.id=selected_id),
  'contracts',coalesce((select jsonb_agg(to_jsonb(c) order by c.employee_id,c.effective_from desc)
   from public.hr_payroll_contracts c where c.workspace_id=p_workspace_id),'[]'::jsonb),
  'lines',coalesce((select jsonb_agg(to_jsonb(l) order by l.employee_id)
   from public.hr_payroll_lines l where l.workspace_id=p_workspace_id and l.period_id=selected_id),'[]'::jsonb),
  'advances',coalesce((select jsonb_agg(to_jsonb(a) order by a.transaction_date,a.id)
   from public.hr_salary_advances a where a.workspace_id=p_workspace_id and a.period_id=selected_id),'[]'::jsonb),
  'expenses',coalesce((select jsonb_agg(to_jsonb(e) order by e.employee_id)
   from public.hr_payroll_expenses e where e.workspace_id=p_workspace_id and e.period_id=selected_id),'[]'::jsonb),
  'payments',coalesce((select jsonb_agg(jsonb_build_object('line_id',l.id,'cash_id',c.id,
    'employee_id',l.employee_id,'account_id',c.account_id,'date',c.transaction_date,
    'amount',c.amount,'status',c.status) order by l.employee_id)
   from public.hr_payroll_lines l join public.cash_transactions c
    on c.workspace_id=l.workspace_id and c.id=l.paid_cash_id
   where l.workspace_id=p_workspace_id and l.period_id=selected_id),'[]'::jsonb),
  'recognized_months',(select coalesce(jsonb_agg(jsonb_build_object('month',m.month_start::date,
    'gross_expense',coalesce((select sum(e.amount) from public.hr_payroll_expenses e
      where e.workspace_id=p_workspace_id and e.recognition_date>=m.month_start
       and e.recognition_date<(m.month_start+interval '1 month')),'0')::text)
    order by m.month_start),'[]'::jsonb)
   from generate_series(date_trunc('month',(statement_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date)-interval '5 months',
      date_trunc('month',(statement_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date),interval '1 month') m(month_start))
 ) into result;
 return result;
end $$;

revoke all on function app_private.hr_payroll_audit(uuid,text,uuid,jsonb),
 app_private.seed_hr_salary_advance_category(),app_private.hr_cash_visible(uuid,uuid),
 app_private.protect_hr_cash_reversal() from public,anon,authenticated;
grant execute on function app_private.hr_cash_visible(uuid,uuid) to authenticated;
revoke all on function public.save_payroll_contract(jsonb),public.save_payroll_period(jsonb),
 public.calculate_payroll(uuid,uuid),public.review_payroll(uuid,uuid),
 public.approve_payroll(uuid,uuid,uuid),public.pay_payroll(uuid,uuid,uuid,date,uuid),
 public.create_salary_advance(uuid,uuid,uuid,uuid,bigint,date,uuid),
 public.get_hr_payroll_state(uuid,uuid) from public,anon;
grant execute on function public.save_payroll_contract(jsonb),public.save_payroll_period(jsonb),
 public.calculate_payroll(uuid,uuid),public.review_payroll(uuid,uuid),
 public.approve_payroll(uuid,uuid,uuid),public.pay_payroll(uuid,uuid,uuid,date,uuid),
 public.create_salary_advance(uuid,uuid,uuid,uuid,bigint,date,uuid),
 public.get_hr_payroll_state(uuid,uuid) to authenticated;

commit;
