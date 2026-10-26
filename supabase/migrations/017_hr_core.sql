-- HR core. Employee records do not create auth accounts and carry no salary data.
begin;

do $$begin
 if to_regclass('public.bank_statement_batches') is null then
  raise exception 'HR_PREREQUISITE: Apply complete migrations 001--016 before 017.';
 end if;
 if to_regclass('public.hr_employees') is not null then
  raise exception 'HR_ALREADY_INSTALLED: 017 runs once; inspect migration history.';
 end if;
end $$;

create table public.hr_departments (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id),
 code text not null check(length(code) between 1 and 80),
 name text not null check(length(btrim(name)) between 1 and 200),
 manager_employee_id uuid,
 is_active boolean not null default true,
 archived_at timestamptz,archived_by uuid references auth.users(id),archive_reason text,
 created_by uuid not null references auth.users(id),updated_by uuid references auth.users(id),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(workspace_id,id),unique(workspace_id,code),
 check(is_active=(archived_at is null)),
 check((archived_at is null and archived_by is null and archive_reason is null)
   or (archived_at is not null and archived_by is not null and length(btrim(archive_reason)) between 10 and 4000))
);
create unique index hr_departments_code_normalized on public.hr_departments(workspace_id,app_private.catalog_normalize(code));
create index hr_departments_workspace_active on public.hr_departments(workspace_id,is_active,name);

create table public.hr_positions (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id),
 code text not null check(length(code) between 1 and 80),
 name text not null check(length(btrim(name)) between 1 and 200),
 department_id uuid,
 is_active boolean not null default true,
 archived_at timestamptz,archived_by uuid references auth.users(id),archive_reason text,
 created_by uuid not null references auth.users(id),updated_by uuid references auth.users(id),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(workspace_id,id),unique(workspace_id,code),
 foreign key(workspace_id,department_id) references public.hr_departments(workspace_id,id),
 check(is_active=(archived_at is null)),
 check((archived_at is null and archived_by is null and archive_reason is null)
   or (archived_at is not null and archived_by is not null and length(btrim(archive_reason)) between 10 and 4000))
);
create unique index hr_positions_code_normalized on public.hr_positions(workspace_id,app_private.catalog_normalize(code));
create index hr_positions_department_active on public.hr_positions(workspace_id,department_id,is_active);

create table public.hr_employees (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id),
 code text not null check(length(code) between 1 and 80),
 full_name text not null check(length(btrim(full_name)) between 1 and 200),
 phone text not null default '' check(length(phone)<=30),
 email text not null default '' check(length(email)<=254),
 birth_date date,address text not null default '' check(length(address)<=1000),
 department_id uuid,position_id uuid,manager_employee_id uuid,
 work_location text not null default '' check(length(work_location)<=200),
 hire_date date,employee_type text not null default 'full_time'
   check(employee_type in ('full_time','part_time','contractor','seasonal')),
 status text not null default 'active' check(status in ('active','on_leave','terminated')),
 auth_user_id uuid,
 notes text not null default '' check(length(notes)<=4000),
 is_active boolean not null default true,
 archived_at timestamptz,archived_by uuid references auth.users(id),archive_reason text,
 created_by uuid not null references auth.users(id),updated_by uuid references auth.users(id),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(workspace_id,id),unique(workspace_id,code),unique(workspace_id,auth_user_id),
 foreign key(workspace_id,department_id) references public.hr_departments(workspace_id,id),
 foreign key(workspace_id,position_id) references public.hr_positions(workspace_id,id),
 foreign key(workspace_id,manager_employee_id) references public.hr_employees(workspace_id,id),
 foreign key(workspace_id,auth_user_id) references public.workspace_members(workspace_id,user_id),
 check(manager_employee_id is distinct from id),
 check(email='' or email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
 check(phone='' or phone ~ '^\+?[0-9 .()\-]{7,30}$'),
 check(is_active=(archived_at is null)),
 check((archived_at is null and archived_by is null and archive_reason is null)
   or (archived_at is not null and archived_by is not null and length(btrim(archive_reason)) between 10 and 4000))
);
create unique index hr_employees_code_normalized on public.hr_employees(workspace_id,app_private.catalog_normalize(code));
create index hr_employees_workspace_status on public.hr_employees(workspace_id,is_active,status,code);
create index hr_employees_department on public.hr_employees(workspace_id,department_id,is_active);
create index hr_employees_manager on public.hr_employees(workspace_id,manager_employee_id);
alter table public.hr_departments add constraint hr_departments_manager_fk
 foreign key(workspace_id,manager_employee_id) references public.hr_employees(workspace_id,id);

-- A workspace member can be removed without deleting the employee profile.
-- Clear the optional login link before the membership FK is checked.
create function app_private.unlink_hr_employee_auth() returns trigger
language plpgsql security definer set search_path='' as $$
declare employee_id uuid;
begin
 for employee_id in
  update public.hr_employees set auth_user_id=null,updated_by=auth.uid(),updated_at=now()
   where workspace_id=old.workspace_id and auth_user_id=old.user_id returning id
 loop
  perform app_private.audit(old.workspace_id,'hr_employee.auth_unlinked',employee_id);
 end loop;
 return old;
end $$;
create trigger unlink_hr_employee_auth_before_member_delete before delete on public.workspace_members
 for each row execute function app_private.unlink_hr_employee_auth();
revoke all on function app_private.unlink_hr_employee_auth() from public,anon,authenticated;

do $$declare t text;begin
 foreach t in array array['hr_departments','hr_positions','hr_employees'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('create policy hr_management_read on public.%I for select to authenticated using (app_private.member_role(workspace_id) in (''owner'',''manager''))',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
 end loop;
end $$;

-- All HR mutations serialize with membership changes and run through checked RPCs.
create function public.save_hr_department(p_workspace_id uuid,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare rid uuid;old_row public.hr_departments;result public.hr_departments;
 code_value text;name_value text;manager_value uuid;
begin
 perform app_private.catalog_lock(p_workspace_id);
 if jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'HR_INPUT: Department object required.';end if;
 rid:=nullif(app_private.foundation_text(p_payload,'id',36),'')::uuid;
 if rid is not null then
  select * into old_row from public.hr_departments where workspace_id=p_workspace_id and id=rid for update;
  if not found then raise exception 'HR_NOT_FOUND: Department is outside this workspace.';end if;
 else rid:=gen_random_uuid();end if;
 code_value:=case when p_payload ? 'code' then upper(app_private.foundation_text(p_payload,'code',80,true)) else old_row.code end;
 name_value:=case when p_payload ? 'name' then app_private.foundation_text(p_payload,'name',200,true) else old_row.name end;
 manager_value:=case when p_payload ? 'manager_employee_id' then nullif(app_private.foundation_text(p_payload,'manager_employee_id',36),'')::uuid else old_row.manager_employee_id end;
 if code_value is null or length(code_value) not between 1 and 80 or name_value is null or length(name_value) not between 1 and 200 then raise exception 'HR_INPUT: Department code and name are required.';end if;
 if old_row.id is not null and old_row.code<>code_value then raise exception 'HR_CODE_IMMUTABLE: Department code cannot change.';end if;
 if manager_value is not null and not exists(select 1 from public.hr_employees where workspace_id=p_workspace_id and id=manager_value and is_active and status='active') then
  raise exception 'HR_MANAGER: Manager must be an active employee of this workspace.';
 end if;
 insert into public.hr_departments(id,workspace_id,code,name,manager_employee_id,created_by,updated_by)
 values(rid,p_workspace_id,code_value,name_value,manager_value,auth.uid(),auth.uid())
 on conflict(id) do update set name=excluded.name,manager_employee_id=excluded.manager_employee_id,updated_by=auth.uid(),updated_at=now()
 returning * into result;
 perform app_private.audit(p_workspace_id,'hr_department.saved',rid,jsonb_build_object('code',code_value));
 return to_jsonb(result);
end $$;

create function public.save_hr_position(p_workspace_id uuid,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare rid uuid;old_row public.hr_positions;result public.hr_positions;
 code_value text;name_value text;department_value uuid;
begin
 perform app_private.catalog_lock(p_workspace_id);
 if jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'HR_INPUT: Position object required.';end if;
 rid:=nullif(app_private.foundation_text(p_payload,'id',36),'')::uuid;
 if rid is not null then
  select * into old_row from public.hr_positions where workspace_id=p_workspace_id and id=rid for update;
  if not found then raise exception 'HR_NOT_FOUND: Position is outside this workspace.';end if;
 else rid:=gen_random_uuid();end if;
 code_value:=case when p_payload ? 'code' then upper(app_private.foundation_text(p_payload,'code',80,true)) else old_row.code end;
 name_value:=case when p_payload ? 'name' then app_private.foundation_text(p_payload,'name',200,true) else old_row.name end;
 department_value:=case when p_payload ? 'department_id' then nullif(app_private.foundation_text(p_payload,'department_id',36),'')::uuid else old_row.department_id end;
 if code_value is null or name_value is null then raise exception 'HR_INPUT: Position code and name are required.';end if;
 if old_row.id is not null and old_row.code<>code_value then raise exception 'HR_CODE_IMMUTABLE: Position code cannot change.';end if;
 if department_value is not null and not exists(select 1 from public.hr_departments where workspace_id=p_workspace_id and id=department_value and is_active) then
  raise exception 'HR_DEPARTMENT: Position department must be active in this workspace.';
 end if;
 if old_row.id is not null and department_value is distinct from old_row.department_id
   and exists(select 1 from public.hr_employees where workspace_id=p_workspace_id and position_id=rid) then
  raise exception 'HR_POSITION_IN_USE: Position department cannot change after assignment.';
 end if;
 insert into public.hr_positions(id,workspace_id,code,name,department_id,created_by,updated_by)
 values(rid,p_workspace_id,code_value,name_value,department_value,auth.uid(),auth.uid())
 on conflict(id) do update set name=excluded.name,department_id=excluded.department_id,updated_by=auth.uid(),updated_at=now()
 returning * into result;
 perform app_private.audit(p_workspace_id,'hr_position.saved',rid,jsonb_build_object('code',code_value));
 return to_jsonb(result);
end $$;

create function public.save_hr_employee(p_workspace_id uuid,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare rid uuid;old_row public.hr_employees;result public.hr_employees;position_department uuid;
 code_value text;name_value text;phone_value text;email_value text;address_value text;
 birth_value date;department_value uuid;position_value uuid;manager_value uuid;location_value text;
 hire_value date;type_value text;status_value text;auth_value uuid;notes_value text;
begin
 perform app_private.catalog_lock(p_workspace_id);
 if jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'HR_INPUT: Employee object required.';end if;
 rid:=nullif(app_private.foundation_text(p_payload,'id',36),'')::uuid;
 if rid is not null then
  select * into old_row from public.hr_employees where workspace_id=p_workspace_id and id=rid for update;
  if not found then raise exception 'HR_NOT_FOUND: Employee is outside this workspace.';end if;
 else rid:=gen_random_uuid();end if;
 code_value:=case when p_payload ? 'code' then upper(app_private.foundation_text(p_payload,'code',80,true)) else old_row.code end;
 name_value:=case when p_payload ? 'full_name' then app_private.foundation_text(p_payload,'full_name',200,true) else old_row.full_name end;
 phone_value:=case when p_payload ? 'phone' then app_private.foundation_text(p_payload,'phone',30) else coalesce(old_row.phone,'') end;
 email_value:=case when p_payload ? 'email' then lower(app_private.foundation_text(p_payload,'email',254)) else coalesce(old_row.email,'') end;
 address_value:=case when p_payload ? 'address' then app_private.foundation_text(p_payload,'address',1000) else coalesce(old_row.address,'') end;
 birth_value:=case when p_payload ? 'birth_date' then nullif(app_private.foundation_text(p_payload,'birth_date',10),'')::date else old_row.birth_date end;
 department_value:=case when p_payload ? 'department_id' then nullif(app_private.foundation_text(p_payload,'department_id',36),'')::uuid else old_row.department_id end;
 position_value:=case when p_payload ? 'position_id' then nullif(app_private.foundation_text(p_payload,'position_id',36),'')::uuid else old_row.position_id end;
 manager_value:=case when p_payload ? 'manager_employee_id' then nullif(app_private.foundation_text(p_payload,'manager_employee_id',36),'')::uuid else old_row.manager_employee_id end;
 location_value:=case when p_payload ? 'work_location' then app_private.foundation_text(p_payload,'work_location',200) else coalesce(old_row.work_location,'') end;
 hire_value:=case when p_payload ? 'hire_date' then nullif(app_private.foundation_text(p_payload,'hire_date',10),'')::date else old_row.hire_date end;
 type_value:=case when p_payload ? 'employee_type' then app_private.foundation_text(p_payload,'employee_type',20,true) else coalesce(old_row.employee_type,'full_time') end;
 status_value:=case when p_payload ? 'status' then app_private.foundation_text(p_payload,'status',20,true) else coalesce(old_row.status,'active') end;
 auth_value:=case when p_payload ? 'auth_user_id' then nullif(app_private.foundation_text(p_payload,'auth_user_id',36),'')::uuid else old_row.auth_user_id end;
 notes_value:=case when p_payload ? 'notes' then app_private.foundation_text(p_payload,'notes',4000) else coalesce(old_row.notes,'') end;
 if code_value is null or name_value is null then raise exception 'HR_INPUT: Employee code and full name are required.';end if;
 if old_row.id is not null and old_row.code<>code_value then raise exception 'HR_CODE_IMMUTABLE: Employee code cannot change.';end if;
 if birth_value is not null and birth_value>current_date then raise exception 'HR_BIRTH_DATE: Birth date cannot be in the future.';end if;
 if hire_value is not null and birth_value is not null and hire_value<birth_value then raise exception 'HR_HIRE_DATE: Hire date precedes birth date.';end if;
 if department_value is not null and not exists(select 1 from public.hr_departments where workspace_id=p_workspace_id and id=department_value and is_active) then
  raise exception 'HR_DEPARTMENT: Employee department must be active in this workspace.';
 end if;
 if position_value is not null then
  select department_id into position_department from public.hr_positions where workspace_id=p_workspace_id and id=position_value and is_active;
  if not found then raise exception 'HR_POSITION: Employee position must be active in this workspace.';end if;
  if position_department is not null and position_department is distinct from department_value then
   raise exception 'HR_POSITION_DEPARTMENT: Position belongs to another department.';
  end if;
 end if;
 if manager_value=rid or (manager_value is not null and not exists(select 1 from public.hr_employees where workspace_id=p_workspace_id and id=manager_value and is_active and status='active')) then
  raise exception 'HR_MANAGER: Direct manager must be a different active employee in this workspace.';
 end if;
 if status_value='terminated' and (exists(select 1 from public.hr_employees where workspace_id=p_workspace_id and manager_employee_id=rid and is_active)
   or exists(select 1 from public.hr_departments where workspace_id=p_workspace_id and manager_employee_id=rid and is_active)) then
  raise exception 'HR_MANAGER_IN_USE: Reassign reports and departments before termination.';
 end if;
 if manager_value is not null and exists(with recursive chain as (
   select id,manager_employee_id from public.hr_employees where workspace_id=p_workspace_id and id=manager_value
   union all select e.id,e.manager_employee_id from public.hr_employees e join chain c on e.id=c.manager_employee_id
    where e.workspace_id=p_workspace_id
  ) select 1 from chain where id=rid) then
  raise exception 'HR_MANAGER_CYCLE: Manager chain cannot contain the employee.';
 end if;
 if auth_value is not null and not exists(select 1 from public.workspace_members where workspace_id=p_workspace_id and user_id=auth_value) then
  raise exception 'HR_AUTH_MEMBER: Linked auth user must belong to this workspace.';
 end if;
 insert into public.hr_employees(id,workspace_id,code,full_name,phone,email,birth_date,address,department_id,position_id,
  manager_employee_id,work_location,hire_date,employee_type,status,auth_user_id,notes,created_by,updated_by)
 values(rid,p_workspace_id,code_value,name_value,phone_value,email_value,birth_value,address_value,department_value,position_value,
  manager_value,location_value,hire_value,type_value,status_value,auth_value,notes_value,auth.uid(),auth.uid())
 on conflict(id) do update set full_name=excluded.full_name,phone=excluded.phone,email=excluded.email,birth_date=excluded.birth_date,
  address=excluded.address,department_id=excluded.department_id,position_id=excluded.position_id,
  manager_employee_id=excluded.manager_employee_id,work_location=excluded.work_location,hire_date=excluded.hire_date,
  employee_type=excluded.employee_type,status=excluded.status,auth_user_id=excluded.auth_user_id,notes=excluded.notes,
  updated_by=auth.uid(),updated_at=now() returning * into result;
 perform app_private.audit(p_workspace_id,'hr_employee.saved',rid,jsonb_build_object('code',code_value));
 return to_jsonb(result);
end $$;

create function public.set_hr_department_archived(p_workspace_id uuid,p_id uuid,p_archived boolean,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare old_row public.hr_departments;result public.hr_departments;reason_value text;
begin
 perform app_private.catalog_lock(p_workspace_id);reason_value:=app_private.catalog_reason(p_reason);
 if p_archived is null then raise exception 'HR_INPUT: Archive flag required.';end if;
 select * into old_row from public.hr_departments where workspace_id=p_workspace_id and id=p_id for update;
 if not found then raise exception 'HR_NOT_FOUND: Department is outside this workspace.';end if;
 if old_row.is_active=not p_archived then return to_jsonb(old_row);end if;
 if p_archived and exists(select 1 from public.hr_positions where workspace_id=p_workspace_id and department_id=p_id and is_active) then
  raise exception 'HR_DEPARTMENT_IN_USE: Archive active positions first.';
 end if;
 if p_archived and exists(select 1 from public.hr_employees where workspace_id=p_workspace_id and department_id=p_id and is_active) then
  raise exception 'HR_DEPARTMENT_IN_USE: Reassign or archive active employees first.';
 end if;
 if not p_archived and old_row.manager_employee_id is not null and not exists(select 1 from public.hr_employees
   where workspace_id=p_workspace_id and id=old_row.manager_employee_id and is_active and status='active') then
  raise exception 'HR_MANAGER: Reassign the department manager before restoration.';
 end if;
 update public.hr_departments set is_active=not p_archived,archived_at=case when p_archived then now() end,
  archived_by=case when p_archived then auth.uid() end,archive_reason=case when p_archived then reason_value end,
  updated_by=auth.uid(),updated_at=now() where workspace_id=p_workspace_id and id=p_id returning * into result;
 perform app_private.audit(p_workspace_id,case when p_archived then 'hr_department.archived' else 'hr_department.restored' end,p_id);
 return to_jsonb(result);
end $$;

create function public.set_hr_position_archived(p_workspace_id uuid,p_id uuid,p_archived boolean,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare old_row public.hr_positions;result public.hr_positions;reason_value text;
begin
 perform app_private.catalog_lock(p_workspace_id);reason_value:=app_private.catalog_reason(p_reason);
 if p_archived is null then raise exception 'HR_INPUT: Archive flag required.';end if;
 select * into old_row from public.hr_positions where workspace_id=p_workspace_id and id=p_id for update;
 if not found then raise exception 'HR_NOT_FOUND: Position is outside this workspace.';end if;
 if old_row.is_active=not p_archived then return to_jsonb(old_row);end if;
 if p_archived and exists(select 1 from public.hr_employees where workspace_id=p_workspace_id and position_id=p_id and is_active) then
  raise exception 'HR_POSITION_IN_USE: Reassign or archive active employees first.';
 end if;
 if not p_archived and old_row.department_id is not null and not exists(select 1 from public.hr_departments where workspace_id=p_workspace_id and id=old_row.department_id and is_active) then
  raise exception 'HR_DEPARTMENT: Restore department first.';
 end if;
 update public.hr_positions set is_active=not p_archived,archived_at=case when p_archived then now() end,
  archived_by=case when p_archived then auth.uid() end,archive_reason=case when p_archived then reason_value end,
  updated_by=auth.uid(),updated_at=now() where workspace_id=p_workspace_id and id=p_id returning * into result;
 perform app_private.audit(p_workspace_id,case when p_archived then 'hr_position.archived' else 'hr_position.restored' end,p_id);
 return to_jsonb(result);
end $$;

create function public.set_hr_employee_archived(p_workspace_id uuid,p_id uuid,p_archived boolean,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare old_row public.hr_employees;result public.hr_employees;reason_value text;
begin
 perform app_private.catalog_lock(p_workspace_id);reason_value:=app_private.catalog_reason(p_reason);
 if p_archived is null then raise exception 'HR_INPUT: Archive flag required.';end if;
 select * into old_row from public.hr_employees where workspace_id=p_workspace_id and id=p_id for update;
 if not found then raise exception 'HR_NOT_FOUND: Employee is outside this workspace.';end if;
 if old_row.is_active=not p_archived then return to_jsonb(old_row);end if;
 if p_archived and exists(select 1 from public.hr_employees where workspace_id=p_workspace_id and manager_employee_id=p_id and is_active) then
  raise exception 'HR_MANAGER_IN_USE: Reassign direct reports first.';
 end if;
 if p_archived and exists(select 1 from public.hr_departments where workspace_id=p_workspace_id and manager_employee_id=p_id and is_active) then
  raise exception 'HR_MANAGER_IN_USE: Reassign managed departments first.';
 end if;
 if not p_archived then
  if old_row.department_id is not null and not exists(select 1 from public.hr_departments where workspace_id=p_workspace_id and id=old_row.department_id and is_active) then raise exception 'HR_DEPARTMENT: Restore department first.';end if;
  if old_row.position_id is not null and not exists(select 1 from public.hr_positions where workspace_id=p_workspace_id and id=old_row.position_id and is_active) then raise exception 'HR_POSITION: Restore position first.';end if;
  if old_row.manager_employee_id is not null and not exists(select 1 from public.hr_employees
   where workspace_id=p_workspace_id and id=old_row.manager_employee_id and is_active and status='active') then raise exception 'HR_MANAGER: Restore or reassign the direct manager first.';end if;
 end if;
 update public.hr_employees set is_active=not p_archived,archived_at=case when p_archived then now() end,
  archived_by=case when p_archived then auth.uid() end,archive_reason=case when p_archived then reason_value end,
  updated_by=auth.uid(),updated_at=now() where workspace_id=p_workspace_id and id=p_id returning * into result;
 perform app_private.audit(p_workspace_id,case when p_archived then 'hr_employee.archived' else 'hr_employee.restored' end,p_id);
 return to_jsonb(result);
end $$;

create function public.delete_hr_department(p_workspace_id uuid,p_id uuid,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare old_row public.hr_departments;reason_value text;
begin
 perform app_private.catalog_lock(p_workspace_id);reason_value:=app_private.catalog_reason(p_reason);
 select * into old_row from public.hr_departments where workspace_id=p_workspace_id and id=p_id for update;
 if not found then raise exception 'HR_NOT_FOUND: Department is outside this workspace.';end if;
 if exists(select 1 from public.hr_positions where workspace_id=p_workspace_id and department_id=p_id)
  or exists(select 1 from public.hr_employees where workspace_id=p_workspace_id and department_id=p_id) then
  raise exception 'HR_DEPARTMENT_IN_USE: Department has historical references; archive it.';
 end if;
 delete from public.hr_departments where workspace_id=p_workspace_id and id=p_id;
 perform app_private.audit(p_workspace_id,'hr_department.deleted',p_id,jsonb_build_object('code',old_row.code,'reason',reason_value));
 return jsonb_build_object('deleted_id',p_id);
end $$;

create function public.delete_hr_position(p_workspace_id uuid,p_id uuid,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare old_row public.hr_positions;reason_value text;
begin
 perform app_private.catalog_lock(p_workspace_id);reason_value:=app_private.catalog_reason(p_reason);
 select * into old_row from public.hr_positions where workspace_id=p_workspace_id and id=p_id for update;
 if not found then raise exception 'HR_NOT_FOUND: Position is outside this workspace.';end if;
 if exists(select 1 from public.hr_employees where workspace_id=p_workspace_id and position_id=p_id) then
  raise exception 'HR_POSITION_IN_USE: Position has historical references; archive it.';
 end if;
 delete from public.hr_positions where workspace_id=p_workspace_id and id=p_id;
 perform app_private.audit(p_workspace_id,'hr_position.deleted',p_id,jsonb_build_object('code',old_row.code,'reason',reason_value));
 return jsonb_build_object('deleted_id',p_id);
end $$;

create function public.get_hr_catalogs(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 perform app_private.require_role(p_workspace_id,array['owner','manager']);
 select jsonb_build_object(
  'departments',(select coalesce(jsonb_agg(to_jsonb(d)||jsonb_build_object('manager_name',e.full_name) order by d.name,d.code),'[]'::jsonb)
   from public.hr_departments d left join public.hr_employees e on e.workspace_id=d.workspace_id and e.id=d.manager_employee_id
   where d.workspace_id=p_workspace_id),
  'positions',(select coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object('department_name',d.name) order by p.name,p.code),'[]'::jsonb)
   from public.hr_positions p left join public.hr_departments d on d.workspace_id=p.workspace_id and d.id=p.department_id
   where p.workspace_id=p_workspace_id)) into result;
 return result;
end $$;

create function public.get_hr_employee(p_workspace_id uuid,p_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 perform app_private.require_role(p_workspace_id,array['owner','manager']);
 select to_jsonb(e)||jsonb_build_object('department_name',d.name,'position_name',p.name,'manager_name',m.full_name)
 into result from public.hr_employees e
 left join public.hr_departments d on d.workspace_id=e.workspace_id and d.id=e.department_id
 left join public.hr_positions p on p.workspace_id=e.workspace_id and p.id=e.position_id
 left join public.hr_employees m on m.workspace_id=e.workspace_id and m.id=e.manager_employee_id
 where e.workspace_id=p_workspace_id and e.id=p_id;
 if result is null then raise exception 'HR_NOT_FOUND: Employee is outside this workspace.';end if;
 return result;
end $$;

create function public.list_hr_employees(p_workspace_id uuid,p_query text default '',p_department_id uuid default null,
 p_status text default null,p_sort text default 'code',p_desc boolean default false,p_limit integer default 25,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare q text:=btrim(coalesce(p_query,''));sort_expr text;direction_value text;rows_value jsonb;total_value bigint;
begin
 perform app_private.require_role(p_workspace_id,array['owner','manager']);
 if length(q)>120 then raise exception 'HR_QUERY: Search text must be at most 120 characters.';end if;
 if p_status is not null and p_status not in ('active','on_leave','terminated','archived') then raise exception 'HR_FILTER: Invalid employee status.';end if;
 if p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset not between 0 and 1000000 then raise exception 'HR_PAGING: Invalid page size or offset.';end if;
 if p_desc is null then raise exception 'HR_SORT: Sort direction required.';end if;
 sort_expr:=case p_sort when 'code' then 'e.code' when 'full_name' then 'e.full_name'
  when 'department' then 'd.name' when 'position' then 'p.name' when 'status' then 'e.status'
  when 'hire_date' then 'e.hire_date' when 'created_at' then 'e.created_at' end;
 if sort_expr is null then raise exception 'HR_SORT: Invalid sort key.';end if;
 direction_value:=case when p_desc then 'desc' else 'asc' end;
 select count(*) into total_value from public.hr_employees e
 where e.workspace_id=p_workspace_id and (p_department_id is null or e.department_id=p_department_id)
  and (p_status='archived' and not e.is_active or p_status is distinct from 'archived' and e.is_active and (p_status is null or e.status=p_status))
  and (q='' or position(lower(q) in lower(e.code))>0 or position(lower(q) in lower(e.full_name))>0
   or position(lower(q) in lower(e.phone))>0 or position(lower(q) in lower(e.email))>0);
 execute format($sql$
  select coalesce(jsonb_agg(row_value order by sort_value %s nulls last,id),'[]'::jsonb) from (
   select to_jsonb(e)||jsonb_build_object('department_name',d.name,'position_name',p.name,'manager_name',m.full_name) as row_value,
    %s as sort_value,e.id
   from public.hr_employees e
   left join public.hr_departments d on d.workspace_id=e.workspace_id and d.id=e.department_id
   left join public.hr_positions p on p.workspace_id=e.workspace_id and p.id=e.position_id
   left join public.hr_employees m on m.workspace_id=e.workspace_id and m.id=e.manager_employee_id
   where e.workspace_id=$1 and ($2::uuid is null or e.department_id=$2)
    and ($3::text='archived' and not e.is_active or $3::text is distinct from 'archived' and e.is_active and ($3::text is null or e.status=$3))
    and ($4::text='' or position(lower($4) in lower(e.code))>0 or position(lower($4) in lower(e.full_name))>0
      or position(lower($4) in lower(e.phone))>0 or position(lower($4) in lower(e.email))>0)
   order by %s %s nulls last,e.id limit $5 offset $6
  ) page
 $sql$,direction_value,sort_expr,sort_expr,direction_value)
 into rows_value using p_workspace_id,p_department_id,p_status,q,p_limit,p_offset;
 return jsonb_build_object('rows',rows_value,'total',total_value,'limit',p_limit,'offset',p_offset);
end $$;

create function public.get_hr_dashboard(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 perform app_private.require_role(p_workspace_id,array['owner','manager']);
 select jsonb_build_object(
  'employee_total',count(*) filter(where e.is_active),
  'working_count',count(*) filter(where e.is_active and e.status='active'),
  'on_leave_count',count(*) filter(where e.is_active and e.status='on_leave'),
  'left_count',count(*) filter(where e.is_active and e.status='terminated'),
  'archived_count',count(*) filter(where not e.is_active),
  'department_counts',(select coalesce(jsonb_agg(jsonb_build_object('department_id',d.id,'department_name',d.name,
   'employee_count',(select count(*) from public.hr_employees a where a.workspace_id=d.workspace_id and a.department_id=d.id and a.is_active))
   order by d.name),'[]'::jsonb) from public.hr_departments d where d.workspace_id=p_workspace_id and d.is_active)
 ) into result from public.hr_employees e where e.workspace_id=p_workspace_id;
 return result;
end $$;

revoke all on function public.save_hr_department(uuid,jsonb),public.save_hr_position(uuid,jsonb),public.save_hr_employee(uuid,jsonb),
 public.set_hr_department_archived(uuid,uuid,boolean,text),public.set_hr_position_archived(uuid,uuid,boolean,text),
 public.set_hr_employee_archived(uuid,uuid,boolean,text),public.delete_hr_department(uuid,uuid,text),
 public.delete_hr_position(uuid,uuid,text),public.get_hr_catalogs(uuid),public.get_hr_employee(uuid,uuid),
 public.list_hr_employees(uuid,text,uuid,text,text,boolean,integer,integer),public.get_hr_dashboard(uuid) from public,anon;
grant execute on function public.save_hr_department(uuid,jsonb),public.save_hr_position(uuid,jsonb),public.save_hr_employee(uuid,jsonb),
 public.set_hr_department_archived(uuid,uuid,boolean,text),public.set_hr_position_archived(uuid,uuid,boolean,text),
 public.set_hr_employee_archived(uuid,uuid,boolean,text),public.delete_hr_department(uuid,uuid,text),
 public.delete_hr_position(uuid,uuid,text),public.get_hr_catalogs(uuid),public.get_hr_employee(uuid,uuid),
 public.list_hr_employees(uuid,text,uuid,text,text,boolean,integer,integer),public.get_hr_dashboard(uuid) to authenticated;

commit;
