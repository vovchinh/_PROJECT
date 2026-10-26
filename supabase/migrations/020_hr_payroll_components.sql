-- Explicit manual payroll components. 019 remains the contract/attendance/cash authority.
-- Commission is a manager-confirmed amount with a source reference, not an inferred sale.
begin;

do $$begin
 if to_regprocedure('public.calculate_payroll(uuid,uuid)') is null
  or to_regprocedure('app_private.hr_reset_unapproved_periods(uuid,uuid,date,date,text)') is null then
  raise exception 'HR_COMPONENT_PREREQUISITE: Apply migration 019 first.';
 end if;
end $$;

create table public.hr_payroll_components (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id),
 period_id uuid not null,
 employee_id uuid not null,
 kind text not null check(kind in ('allowance','bonus','commission','deduction')),
 label text not null check(length(trim(label)) between 1 and 120),
 amount bigint not null check(amount between 1 and 9000000000000),
 reason text not null check(length(trim(reason)) between 10 and 4000),
 source_reference text not null default '' check(length(source_reference)<=200),
 status text not null default 'active' check(status in ('active','voided')),
 confirmed_by uuid not null references auth.users(id),
 confirmed_at timestamptz not null default clock_timestamp(),
 void_reason text,
 voided_by uuid references auth.users(id),
 voided_at timestamptz,
 created_by uuid not null references auth.users(id),
 updated_by uuid references auth.users(id),
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 unique(workspace_id,id),
 foreign key(workspace_id,period_id) references public.hr_payroll_periods(workspace_id,id),
 foreign key(workspace_id,employee_id) references public.hr_employees(workspace_id,id),
 check(kind<>'commission' or length(trim(source_reference)) between 3 and 200),
 check((status='active' and void_reason is null and voided_by is null and voided_at is null)
    or (status='voided' and length(trim(void_reason)) between 10 and 4000
      and voided_by is not null and voided_at is not null))
);
create index hr_payroll_components_period on public.hr_payroll_components(workspace_id,period_id,employee_id,status);
create unique index hr_payroll_commission_source_unique on public.hr_payroll_components
 (workspace_id,period_id,employee_id,lower(source_reference)) where kind='commission' and status='active';
alter table public.hr_payroll_components enable row level security;
create policy hr_manager_read on public.hr_payroll_components for select to authenticated
 using(app_private.member_role(workspace_id) in ('owner','manager'));
revoke all on public.hr_payroll_components from public,anon,authenticated;
grant select on public.hr_payroll_components to authenticated;

create table app_private.hr_payroll_component_requests (
 workspace_id uuid not null references public.workspaces(id),
 request_id uuid not null,
 action text not null check(action in ('save','void')),
 payload_hash text not null,
 result jsonb not null,
 actor_id uuid not null references auth.users(id),
 created_at timestamptz not null default clock_timestamp(),
 primary key(workspace_id,request_id)
);
alter table app_private.hr_payroll_component_requests enable row level security;
revoke all on app_private.hr_payroll_component_requests from public,anon,authenticated;

-- The existing snapshot formula has two terms. Extend it without changing a posted line.
alter table public.hr_payroll_lines
 add column allowance_pay bigint not null default 0 check(allowance_pay between 0 and 9000000000000),
 add column bonus_pay bigint not null default 0 check(bonus_pay between 0 and 9000000000000),
 add column commission_pay bigint not null default 0 check(commission_pay between 0 and 9000000000000),
 add column other_deduction bigint not null default 0 check(other_deduction between 0 and 9000000000000);
do $$declare constraint_name text;begin
 select c.conname into constraint_name from pg_constraint c
 where c.conrelid='public.hr_payroll_lines'::regclass and c.contype='c'
  and pg_get_constraintdef(c.oid) like '%gross_pay%'
  and pg_get_constraintdef(c.oid) like '%advance_deduction%'
 order by c.conname limit 1;
 if constraint_name is null then raise exception 'HR_COMPONENT_FORMULA: Existing payroll formula constraint not found.';end if;
 execute format('alter table public.hr_payroll_lines drop constraint %I',constraint_name);
end $$;
alter table public.hr_payroll_lines add constraint hr_payroll_lines_component_formula
 check(gross_pay=base_pay+overtime_pay+allowance_pay+bonus_pay+commission_pay
   and net_pay=gross_pay-advance_deduction-other_deduction);

create function public.save_hr_payroll_component(p_workspace_id uuid,p_payload jsonb,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare prior app_private.hr_payroll_component_requests;
 old_row public.hr_payroll_components;
 result public.hr_payroll_components;
 period_row public.hr_payroll_periods;
 rid uuid;employee_value uuid;kind_value text;label_value text;reason_value text;
 source_value text;amount_value numeric;hash_value text;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 if p_request_id is null then raise exception 'HR_COMPONENT_REQUEST: A request ID is required.';end if;
 if jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'HR_COMPONENT_PAYLOAD: Expected an object.';end if;
 hash_value:=md5(p_payload::text);
 select * into prior from app_private.hr_payroll_component_requests
  where workspace_id=p_workspace_id and request_id=p_request_id;
 if found then
  if prior.action<>'save' or prior.payload_hash<>hash_value then
   raise exception 'HR_COMPONENT_REQUEST_REUSED: Request ID has different contents.';
  end if;
  return prior.result;
 end if;
 rid:=nullif(p_payload->>'id','')::uuid;
 if rid is not null then
  select * into old_row from public.hr_payroll_components where workspace_id=p_workspace_id and id=rid for update;
  if not found then raise exception 'HR_COMPONENT_NOT_FOUND: Component is outside this workspace.';end if;
  if old_row.status<>'active' then raise exception 'HR_COMPONENT_VOIDED: Voided component cannot be edited.';end if;
 else rid:=gen_random_uuid();end if;
 employee_value:=coalesce(nullif(p_payload->>'employee_id','')::uuid,old_row.employee_id);
 kind_value:=coalesce(nullif(p_payload->>'kind',''),old_row.kind);
 label_value:=trim(coalesce(p_payload->>'label',old_row.label,''));
 reason_value:=trim(coalesce(p_payload->>'reason',old_row.reason,''));
 source_value:=trim(coalesce(p_payload->>'source_reference',old_row.source_reference,''));
 amount_value:=coalesce(nullif(p_payload->>'amount','')::numeric,old_row.amount);
 if kind_value not in ('allowance','bonus','commission','deduction') or kind_value is null
  or length(label_value) not between 1 and 120 or length(reason_value) not between 10 and 4000
  or length(source_value)>200 or (kind_value='commission' and length(source_value)<3)
  or amount_value is null or amount_value<>trunc(amount_value) or amount_value not between 1 and 9000000000000 then
  raise exception 'HR_COMPONENT_INVALID: Kind, label, VND amount, reason or commission source is invalid.';
 end if;
 if old_row.id is not null and (employee_value<>old_row.employee_id or kind_value<>old_row.kind) then
  raise exception 'HR_COMPONENT_IDENTITY: Employee and component kind cannot change; void and create instead.';
 end if;
 select * into period_row from public.hr_payroll_periods
  where workspace_id=p_workspace_id and id=coalesce(nullif(p_payload->>'period_id','')::uuid,old_row.period_id) for update;
 if not found then raise exception 'HR_PERIOD_NOT_FOUND: Period is outside this workspace.';end if;
 if old_row.id is not null and period_row.id<>old_row.period_id then
  raise exception 'HR_COMPONENT_IDENTITY: Period cannot change; void and create instead.';
 end if;
 if period_row.status in ('APPROVED','PAID') then
  raise exception 'HR_PERIOD_LOCKED: Approved payroll components are immutable.';
 end if;
 if not exists(select 1 from public.hr_payroll_contracts c where c.workspace_id=p_workspace_id
  and c.employee_id=employee_value and c.effective_from<=period_row.period_start
  and (c.effective_to is null or c.effective_to>=period_row.period_end)) then
  raise exception 'HR_COMPONENT_CONTRACT: Employee needs a contract covering this period.';
 end if;
 if old_row.id is null then
  insert into public.hr_payroll_components(id,workspace_id,period_id,employee_id,kind,label,amount,
   reason,source_reference,confirmed_by,created_by)
  values(rid,p_workspace_id,period_row.id,employee_value,kind_value,label_value,amount_value::bigint,
   reason_value,source_value,auth.uid(),auth.uid()) returning * into result;
 else
  update public.hr_payroll_components set label=label_value,amount=amount_value::bigint,
   reason=reason_value,source_reference=source_value,confirmed_by=auth.uid(),
   confirmed_at=clock_timestamp(),updated_by=auth.uid(),updated_at=clock_timestamp()
  where workspace_id=p_workspace_id and id=rid returning * into result;
 end if;
 perform app_private.hr_reset_unapproved_periods(p_workspace_id,null,period_row.period_start,
  period_row.period_end,'payroll_component_changed');
 perform app_private.hr_payroll_audit(p_workspace_id,'component.saved',rid,
  jsonb_build_object('before',to_jsonb(old_row),'after',to_jsonb(result),'request_id',p_request_id));
 perform app_private.audit(p_workspace_id,'hr.payroll_component.saved',rid,
  jsonb_build_object('period_id',period_row.id,'request_id',p_request_id));
 insert into app_private.hr_payroll_component_requests(workspace_id,request_id,action,payload_hash,result,actor_id)
  values(p_workspace_id,p_request_id,'save',hash_value,to_jsonb(result),auth.uid());
 return to_jsonb(result);
end $$;

create function public.void_hr_payroll_component(p_workspace_id uuid,p_component_id uuid,p_reason text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare prior app_private.hr_payroll_component_requests;
 old_row public.hr_payroll_components;result public.hr_payroll_components;
 period_row public.hr_payroll_periods;hash_value text;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 if p_request_id is null then raise exception 'HR_COMPONENT_REQUEST: A request ID is required.';end if;
 hash_value:=md5(jsonb_build_object('id',p_component_id,'reason',p_reason)::text);
 select * into prior from app_private.hr_payroll_component_requests
  where workspace_id=p_workspace_id and request_id=p_request_id;
 if found then
  if prior.action<>'void' or prior.payload_hash<>hash_value then
   raise exception 'HR_COMPONENT_REQUEST_REUSED: Request ID has different contents.';
  end if;
  return prior.result;
 end if;
 if length(trim(coalesce(p_reason,''))) not between 10 and 4000 then
  raise exception 'HR_COMPONENT_REASON: Voiding requires a reason of 10 to 4000 characters.';
 end if;
 select * into old_row from public.hr_payroll_components
  where workspace_id=p_workspace_id and id=p_component_id for update;
 if not found then raise exception 'HR_COMPONENT_NOT_FOUND: Component is outside this workspace.';end if;
 if old_row.status<>'active' then raise exception 'HR_COMPONENT_VOIDED: Component is already voided.';end if;
 select * into period_row from public.hr_payroll_periods
  where workspace_id=p_workspace_id and id=old_row.period_id for update;
 if period_row.status in ('APPROVED','PAID') then
  raise exception 'HR_PERIOD_LOCKED: Approved payroll components are immutable.';
 end if;
 update public.hr_payroll_components set status='voided',void_reason=trim(p_reason),
  voided_by=auth.uid(),voided_at=clock_timestamp(),updated_by=auth.uid(),updated_at=clock_timestamp()
 where workspace_id=p_workspace_id and id=p_component_id returning * into result;
 perform app_private.hr_reset_unapproved_periods(p_workspace_id,null,period_row.period_start,
  period_row.period_end,'payroll_component_voided');
 perform app_private.hr_payroll_audit(p_workspace_id,'component.voided',p_component_id,
  jsonb_build_object('before',to_jsonb(old_row),'after',to_jsonb(result),'request_id',p_request_id));
 perform app_private.audit(p_workspace_id,'hr.payroll_component.voided',p_component_id,
  jsonb_build_object('period_id',period_row.id,'request_id',p_request_id));
 insert into app_private.hr_payroll_component_requests(workspace_id,request_id,action,payload_hash,result,actor_id)
  values(p_workspace_id,p_request_id,'void',hash_value,to_jsonb(result),auth.uid());
 return to_jsonb(result);
end $$;

-- Preserve 019's audited contract/attendance computation, then append confirmed inputs.
alter function public.calculate_payroll(uuid,uuid) rename to calculate_payroll_v1_internal;
revoke all on function public.calculate_payroll_v1_internal(uuid,uuid) from public,anon,authenticated;
create function public.calculate_payroll(p_workspace_id uuid,p_period_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare period_row public.hr_payroll_periods;line_row public.hr_payroll_lines;
 allowance_value numeric;bonus_value numeric;commission_value numeric;deduction_value numeric;
 gross_value numeric;net_value numeric;gross_total_value numeric:=0;net_total_value numeric:=0;
 component_snapshot jsonb;
begin
 -- The base RPC holds the workspace lock through this transaction and rechecks all rules.
 perform public.calculate_payroll_v1_internal(p_workspace_id,p_period_id);
 select * into period_row from public.hr_payroll_periods
  where workspace_id=p_workspace_id and id=p_period_id for update;
 if exists(select 1 from public.hr_payroll_components c where c.workspace_id=p_workspace_id
  and c.period_id=p_period_id and c.status='active'
  and not exists(select 1 from public.hr_payroll_lines l where l.workspace_id=c.workspace_id
   and l.period_id=c.period_id and l.employee_id=c.employee_id)) then
  raise exception 'HR_COMPONENT_CONTRACT: Active component has no calculated payslip.';
 end if;
 for line_row in select * from public.hr_payroll_lines
  where workspace_id=p_workspace_id and period_id=p_period_id order by employee_id for update loop
  select coalesce(sum(amount) filter(where kind='allowance'),0),
   coalesce(sum(amount) filter(where kind='bonus'),0),
   coalesce(sum(amount) filter(where kind='commission'),0),
   coalesce(sum(amount) filter(where kind='deduction'),0),
   coalesce(jsonb_agg(jsonb_build_object('id',id,'kind',kind,'label',label,'amount',amount,
    'reason',reason,'source_reference',source_reference,'confirmed_by',confirmed_by,
    'confirmed_at',confirmed_at) order by created_at,id),'[]'::jsonb)
   into allowance_value,bonus_value,commission_value,deduction_value,component_snapshot
   from public.hr_payroll_components where workspace_id=p_workspace_id
    and period_id=p_period_id and employee_id=line_row.employee_id and status='active';
  gross_value:=line_row.base_pay+line_row.overtime_pay+allowance_value+bonus_value+commission_value;
  net_value:=gross_value-line_row.advance_deduction-deduction_value;
  if gross_value>9000000000000 or net_value<0 or net_value>9000000000000 then
   raise exception 'HR_COMPONENT_AMOUNT: Component amounts exceed gross or leave negative net pay for employee %.',line_row.employee_id;
  end if;
  update public.hr_payroll_lines set allowance_pay=allowance_value::bigint,bonus_pay=bonus_value::bigint,
   commission_pay=commission_value::bigint,other_deduction=deduction_value::bigint,
   gross_pay=gross_value::bigint,net_pay=net_value::bigint,
   source_snapshot=source_snapshot||jsonb_build_object('components',component_snapshot)
   where workspace_id=p_workspace_id and id=line_row.id;
  gross_total_value:=gross_total_value+gross_value;net_total_value:=net_total_value+net_value;
 end loop;
 if gross_total_value>9000000000000 or net_total_value>9000000000000 then
  raise exception 'HR_COMPONENT_TOTAL: Payroll total exceeds allowed VND amount.';
 end if;
 update public.hr_payroll_periods set gross_total=gross_total_value::bigint,
  net_total=net_total_value::bigint,updated_at=clock_timestamp()
  where workspace_id=p_workspace_id and id=p_period_id returning * into period_row;
 perform app_private.hr_payroll_audit(p_workspace_id,'period.components_calculated',p_period_id,
  jsonb_build_object('gross_total',gross_total_value,'net_total',net_total_value));
 return to_jsonb(period_row);
end $$;

alter function public.get_hr_payroll_state(uuid,uuid) rename to get_hr_payroll_state_v1_internal;
revoke all on function public.get_hr_payroll_state_v1_internal(uuid,uuid) from public,anon,authenticated;
create function public.get_hr_payroll_state(p_workspace_id uuid,p_period_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;selected_id uuid;
begin
 result:=public.get_hr_payroll_state_v1_internal(p_workspace_id,p_period_id);
 selected_id:=(result->'selected_period'->>'id')::uuid;
 if (select count(*) from public.hr_payroll_components where workspace_id=p_workspace_id
  and period_id=selected_id)>5000 then
  raise exception 'HR_COMPONENT_RESULT_LIMIT: More than 5000 components in one period.';
 end if;
 return result||jsonb_build_object('components',coalesce((select jsonb_agg(to_jsonb(c)
  order by c.created_at,c.id) from public.hr_payroll_components c
  where c.workspace_id=p_workspace_id and c.period_id=selected_id),'[]'::jsonb));
end $$;

revoke all on function public.save_hr_payroll_component(uuid,jsonb,uuid),
 public.void_hr_payroll_component(uuid,uuid,text,uuid),public.calculate_payroll(uuid,uuid),
 public.get_hr_payroll_state(uuid,uuid) from public,anon;
grant execute on function public.save_hr_payroll_component(uuid,jsonb,uuid),
 public.void_hr_payroll_component(uuid,uuid,text,uuid),public.calculate_payroll(uuid,uuid),
 public.get_hr_payroll_state(uuid,uuid) to authenticated;
commit;
