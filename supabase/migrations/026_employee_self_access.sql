-- Employee self-service isolation and explicit access-grant foundation.
-- Apply after 025. This migration does not assign broad ERP permissions to employees.
begin;

do $$begin
 if to_regprocedure('public.scan_hr_qr(uuid,uuid,text,uuid)') is null
    or to_regprocedure('public.get_my_hr_attendance(uuid,date)') is null
    or to_regprocedure('public.add_workspace_member(uuid,text,text)') is null
    or to_regclass('public.hr_payroll_lines') is null then
  raise exception 'ERP_ACCESS_PREREQUISITE: Apply migrations through 025 before 026.';
 end if;
end $$;

alter table public.workspace_members drop constraint workspace_members_role_check;
alter table public.workspace_members add constraint workspace_members_role_check
 check(role in ('owner','manager','staff','viewer','employee'));

-- Existing generic member checks are used by many ERP policies/RPCs. Returning
-- NULL for employee makes those older checks deny access, including direct REST.
create or replace function app_private.member_role(w uuid) returns text
language sql stable security definer set search_path='' as $$
 select role from public.workspace_members
 where workspace_id=w and user_id=auth.uid() and role<>'employee'
$$;

-- The membership chooser needs the workspace name, but no ERP business rows.
drop policy member_read on public.workspaces;
create policy member_read on public.workspaces for select to authenticated
 using(exists(select 1 from public.workspace_members m
  where m.workspace_id=id and m.user_id=auth.uid()));

create function app_private.hr_require_self_member(p_workspace_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not exists(select 1 from public.workspace_members m
  where m.workspace_id=p_workspace_id and m.user_id=auth.uid()
   and m.role in ('owner','manager','staff','employee')) then
  raise exception 'HR_SELF_FORBIDDEN: No attendance access in this workspace.' using errcode='42501';
 end if;
end $$;

-- Patch only the checked entry guards of the existing QR/self functions. The
-- exact-source assertion aborts the migration if a function was customized.
do $$declare signature regprocedure;definition text;old_guard text;
begin
 old_guard:='perform app_private.require_role(p_workspace_id,array[''owner'',''manager'',''staff'']);';
 foreach signature in array array[
  'app_private.hr_scan_qr_core(uuid,uuid,text,uuid)'::regprocedure,
  'public.scan_hr_qr(uuid,uuid,text,uuid)'::regprocedure,
  'public.get_my_hr_attendance(uuid,date)'::regprocedure
 ] loop
  definition:=pg_get_functiondef(signature);
  if position(old_guard in definition)=0 then
   raise exception 'ERP_ACCESS_QR_SOURCE: Unexpected function definition for %.',signature;
  end if;
  execute replace(definition,old_guard,'perform app_private.hr_require_self_member(p_workspace_id);');
 end loop;
end $$;

-- Owner membership RPCs were written before the employee role existed. Keep
-- their existing validation, locking, last-owner and audit behavior intact.
do $$declare signature regprocedure;definition text;old_roles text;
begin
 old_roles:='(''owner'',''manager'',''staff'',''viewer'')';
 foreach signature in array array[
  'public.add_workspace_member(uuid,text,text)'::regprocedure,
  'public.set_workspace_member_role(uuid,uuid,text)'::regprocedure
 ] loop
  definition:=pg_get_functiondef(signature);
  if position(old_roles in definition)=0 then
   raise exception 'ERP_ACCESS_MEMBER_SOURCE: Unexpected function definition for %.',signature;
  end if;
  execute replace(definition,old_roles,'(''owner'',''manager'',''staff'',''viewer'',''employee'')');
 end loop;
end $$;

-- Self-only payroll read model. No company-wide payroll SELECT is granted.
create function public.get_my_hr_payslips(p_workspace_id uuid,p_limit integer default 12)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare employee_value uuid;result jsonb;
begin
 perform app_private.hr_require_self_member(p_workspace_id);
 if p_limit is null or p_limit not between 1 and 24 then
  raise exception 'HR_SELF_PAGE: Limit must be 1..24.';
 end if;
 select e.id into employee_value from public.hr_employees e
  where e.workspace_id=p_workspace_id and e.auth_user_id=auth.uid()
   and e.is_active and e.status='active';
 if employee_value is null then raise exception 'HR_QR_EMPLOYEE: Link an employee to this login.';end if;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.period_end desc,x.line_id desc),'[]'::jsonb)
  into result from (
   select l.id line_id,p.period_start,p.period_end,p.status,p.approved_at,p.paid_at,
    l.pay_basis,l.rate_vnd::text,l.regular_minutes,l.overtime_minutes,
    l.base_pay::text,l.overtime_pay::text,l.allowance_pay::text,l.bonus_pay::text,
    l.commission_pay::text,l.advance_deduction::text,l.other_deduction::text,
    l.gross_pay::text,l.net_pay::text
   from public.hr_payroll_lines l join public.hr_payroll_periods p
    on p.workspace_id=l.workspace_id and p.id=l.period_id
   where l.workspace_id=p_workspace_id and l.employee_id=employee_value
    and p.status in ('APPROVED','PAID')
   order by p.period_end desc,l.id desc limit p_limit
  ) x;
 return jsonb_build_object('employee_id',employee_value,'items',result);
end $$;

revoke all on function app_private.hr_require_self_member(uuid)
 from public,anon,authenticated;
revoke all on function public.get_my_hr_payslips(uuid,integer) from public,anon;
grant execute on function public.get_my_hr_payslips(uuid,integer) to authenticated;

commit;
