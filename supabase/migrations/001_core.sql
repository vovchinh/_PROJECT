-- ChiDi ERP V1. Run once in a NEW Supabase project SQL Editor.
-- Only authenticated workspace members can read. Mutations use checked RPCs.
begin;
create schema if not exists app_private;
revoke all on schema app_private from public;
grant usage on schema app_private to authenticated;

create table public.workspaces (
 id uuid primary key default gen_random_uuid(), name text not null check(length(name) between 1 and 200),
 created_by uuid not null references auth.users(id), created_at timestamptz not null default now()
);
create table public.workspace_members (
 workspace_id uuid not null references public.workspaces(id), user_id uuid not null references auth.users(id),
 role text not null check(role in ('owner','manager','staff','viewer')), primary key(workspace_id,user_id)
);
create table public.suppliers (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id),
 code text not null, name text not null, note text not null default '', created_at timestamptz not null default now(),
 unique(workspace_id,code),unique(workspace_id,id)
);
create table public.products (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id),
 code text not null, name text not null, supplier_id uuid, unit_cost bigint not null default 0 check(unit_cost between 0 and 9000000000000),
 provisional boolean not null default true, note text not null default '', created_at timestamptz not null default now(),
 unique(workspace_id,code),unique(workspace_id,id), foreign key(workspace_id,supplier_id) references public.suppliers(workspace_id,id)
);
create table public.warehouses (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id),
 code text not null,name text not null,note text not null default '',created_at timestamptz not null default now(),
 unique(workspace_id,code),unique(workspace_id,id)
);
create table public.cash_accounts (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id),
 code text not null,name text not null,opening_balance bigint not null default 0 check(abs(opening_balance)<=9000000000000),
 opening_date date,opening_confirmed boolean not null default false,note text not null default '',created_at timestamptz not null default now(),
 check(not opening_confirmed or opening_date is not null),unique(workspace_id,code),unique(workspace_id,id)
);
create table public.purchase_receipts (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),
 supplier_id uuid,product_id uuid,warehouse_id uuid,received_date date,date_estimated boolean not null default false,
 qty integer not null check(qty between 1 and 1000000),unit_cost bigint not null check(unit_cost between 0 and 9000000000000),
 additional_cost bigint not null default 0 check(additional_cost between 0 and 9000000000000),
 total_amount bigint generated always as (qty::bigint*unit_cost+additional_cost) stored check(total_amount between 1 and 9000000000000),
 status text not null default 'draft' check(status in ('draft','posted','reversed')),
 notes text not null default '',legacy_id text,source_id text,import_row_hash text,provenance jsonb not null default '{}',
 created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(workspace_id,id),unique(workspace_id,legacy_id),
 foreign key(workspace_id,supplier_id) references public.suppliers(workspace_id,id),
 foreign key(workspace_id,product_id) references public.products(workspace_id,id),
 foreign key(workspace_id,warehouse_id) references public.warehouses(workspace_id,id)
);
create table public.cash_transactions (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),account_id uuid,
 direction text not null check(direction in ('in','out')),transaction_date date,date_estimated boolean not null default false,
 category text,amount bigint not null check(amount between 1 and 9000000000000),description text not null default '',notes text not null default '',
 status text not null default 'draft' check(status in ('draft','posted','reversed')),
 legacy_id text,source_id text,import_row_hash text,provenance jsonb not null default '{}',
 created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(workspace_id,id),unique(workspace_id,legacy_id),foreign key(workspace_id,account_id) references public.cash_accounts(workspace_id,id)
);
create table public.stock_movements (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),
 purchase_id uuid not null,product_id uuid not null,warehouse_id uuid not null,received_date date not null,
 movement_kind text not null check(movement_kind in ('post','reversal')),qty integer not null check(qty<>0),unit_cost bigint not null,
 amount bigint not null,created_at timestamptz not null default now(),unique(workspace_id,purchase_id,movement_kind),
 foreign key(workspace_id,purchase_id) references public.purchase_receipts(workspace_id,id),
 foreign key(workspace_id,product_id) references public.products(workspace_id,id),
 foreign key(workspace_id,warehouse_id) references public.warehouses(workspace_id,id)
);
create table public.cash_movements (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),cash_id uuid not null,account_id uuid not null,
 transaction_date date not null,movement_kind text not null check(movement_kind in ('post','reversal')),
 direction text not null check(direction in ('in','out')),amount bigint not null check(amount>0),
 signed_amount bigint generated always as (case when direction='in' then amount else -amount end) stored,
 category text not null,created_at timestamptz not null default now(),unique(workspace_id,cash_id,movement_kind),
 foreign key(workspace_id,cash_id) references public.cash_transactions(workspace_id,id),
 foreign key(workspace_id,account_id) references public.cash_accounts(workspace_id,id)
);
create table public.audit_events (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),actor_id uuid not null references auth.users(id),
 action text not null,entity_id uuid,details jsonb not null default '{}',created_at timestamptz not null default now()
);
create table public.import_batches (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),
 source_id text not null check(source_id~'^[a-f0-9]{64}$'),source_name text not null,stats jsonb not null default '{}',
 created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),unique(workspace_id,source_id)
);
create table app_private.posting_requests (
 workspace_id uuid not null references public.workspaces(id),request_id uuid not null,action text not null,entity_id uuid not null,
 primary key(workspace_id,request_id)
);

create function app_private.member_role(w uuid) returns text language sql stable security definer set search_path='' as $$
 select role from public.workspace_members where workspace_id=w and user_id=auth.uid()
$$;
create function app_private.require_role(w uuid,roles text[]) returns void language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not coalesce(app_private.member_role(w)=any(roles),false) then
  raise exception 'Bạn không có quyền thực hiện thao tác trong workspace này.' using errcode='42501';
 end if;
end $$;
create function app_private.amount(v text,minimum bigint default 0) returns bigint language plpgsql immutable set search_path='' as $$
declare n numeric;
begin
 n:=v::numeric;
 if n is null or n<>trunc(n) or n<minimum or n>9000000000000 then raise exception 'Số tiền phải là số nguyên VND hợp lệ.';end if;
 return n::bigint;
end $$;
create function app_private.audit(w uuid,a text,e uuid,d jsonb default '{}') returns void language sql security definer set search_path='' as $$
 insert into public.audit_events(workspace_id,actor_id,action,entity_id,details) values(w,auth.uid(),a,e,d)
$$;
create function app_private.remember(w uuid,r uuid,a text,e uuid) returns void language plpgsql security definer set search_path='' as $$
declare found_request app_private.posting_requests;
begin
 if r is null then raise exception 'Cần request_id để chống ghi trùng.';end if;
 insert into app_private.posting_requests values(w,r,a,e) on conflict do nothing;
 select * into found_request from app_private.posting_requests where workspace_id=w and request_id=r;
 if found_request.action<>a or found_request.entity_id<>e then raise exception 'request_id đã được dùng cho thao tác khác.';end if;
end $$;

-- Explicitly read-only REST surface; all writes go through RPC authorization.
alter table public.workspaces enable row level security;
create policy member_read on public.workspaces for select to authenticated using(app_private.member_role(id) is not null);
alter table public.workspace_members enable row level security;
create policy own_memberships on public.workspace_members for select to authenticated using(user_id=auth.uid());
do $$declare t text;begin
 foreach t in array array['suppliers','products','warehouses','cash_accounts','purchase_receipts','cash_transactions','stock_movements','cash_movements','audit_events','import_batches'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('create policy member_read on public.%I for select to authenticated using (app_private.member_role(workspace_id) is not null)',t);
 end loop;
end $$;
revoke all on public.workspaces,public.workspace_members,public.suppliers,public.products,public.warehouses,public.cash_accounts,
 public.purchase_receipts,public.cash_transactions,public.stock_movements,public.cash_movements,public.audit_events,public.import_batches from public,anon,authenticated;
grant select on public.workspaces,public.workspace_members,public.suppliers,public.products,public.warehouses,public.cash_accounts,
 public.purchase_receipts,public.cash_transactions,public.stock_movements,public.cash_movements,public.audit_events,public.import_batches to authenticated;

create function public.bootstrap_workspace(p_name text) returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid;entry text[];
begin
 if auth.uid() is null then raise exception 'Cần đăng nhập.' using errcode='42501';end if;
 -- One bootstrap workspace per owner, including simultaneous browser calls.
 perform pg_advisory_xact_lock(hashtext(auth.uid()::text));
 select workspace_id into w from public.workspace_members where user_id=auth.uid() and role='owner' limit 1;
 if w is not null then return jsonb_build_object('id',w);end if;
 if length(trim(p_name)) not between 1 and 200 then raise exception 'Tên workspace không hợp lệ.';end if;
 insert into public.workspaces(name,created_by) values(trim(p_name),auth.uid()) returning id into w;
 insert into public.workspace_members values(w,auth.uid(),'owner');
 insert into public.warehouses(workspace_id,code,name) values(w,'CHIDI-MAIN','Kho ChiDi');
 foreach entry slice 1 in array array[['CASH','Tiền mặt'],['BANK_CHINH','Tài khoản Chinh'],['BANK_DIEU','Tài khoản Diệu'],['COD_SPX','Ví COD SPX'],['COD_GHN','Ví COD GHN'],['WALLET','Ví điện tử'],['OTHER','Tài khoản khác']] loop
  insert into public.cash_accounts(workspace_id,code,name) values(w,entry[1],entry[2]);
 end loop;
 perform app_private.audit(w,'workspace.created',w);
 return jsonb_build_object('id',w);
end $$;

create function public.save_master(p_kind text,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid:=(p_payload->>'workspace_id')::uuid;rid uuid:=nullif(p_payload->>'id','')::uuid;
 code_value text:=upper(trim(p_payload->>'code'));name_value text:=trim(p_payload->>'name');result jsonb;old_record jsonb;
 amount_value bigint;balance_value numeric;
begin
 perform app_private.require_role(w,case when p_kind='cash_accounts' then array['owner'] else array['owner','manager'] end);
 if p_kind not in ('suppliers','products','warehouses','cash_accounts') then raise exception 'Danh mục không hợp lệ.';end if;
 if code_value is null or length(code_value) not between 1 and 80 or name_value is null or length(name_value) not between 1 and 200 then raise exception 'Cần mã và tên hợp lệ.';end if;
 if length(coalesce(p_payload->>'note',''))>4000 then raise exception 'Ghi chú quá dài.';end if;
 if rid is not null then
  execute format('select to_jsonb(t) from public.%I t where id=$1 and workspace_id=$2 for update',p_kind) into old_record using rid,w;
  if old_record is null then raise exception 'Không tìm thấy danh mục.';end if;
  if old_record->>'code'<>code_value then raise exception 'Mã danh mục đã tạo không được đổi; điều chỉnh tên hoặc tạo mã mới.';end if;
 else rid:=gen_random_uuid();end if;
 if p_kind='suppliers' then
  insert into public.suppliers(id,workspace_id,code,name,note) values(rid,w,code_value,name_value,coalesce(p_payload->>'note',''))
  on conflict(id) do update set name=excluded.name,note=excluded.note returning to_jsonb(suppliers.*) into result;
 elsif p_kind='warehouses' then
  insert into public.warehouses(id,workspace_id,code,name,note) values(rid,w,code_value,name_value,coalesce(p_payload->>'note',''))
  on conflict(id) do update set name=excluded.name,note=excluded.note returning to_jsonb(warehouses.*) into result;
 elsif p_kind='products' then
  amount_value:=app_private.amount(coalesce(p_payload->>'unit_cost','0'));
  insert into public.products(id,workspace_id,code,name,supplier_id,unit_cost,provisional,note)
   values(rid,w,code_value,name_value,nullif(p_payload->>'supplier_id','')::uuid,amount_value,coalesce((p_payload->>'provisional')::boolean,true),coalesce(p_payload->>'note',''))
  on conflict(id) do update set name=excluded.name,supplier_id=excluded.supplier_id,unit_cost=excluded.unit_cost,provisional=excluded.provisional,note=excluded.note
  returning to_jsonb(products.*) into result;
 else
  balance_value:=coalesce(p_payload->>'opening_balance','0')::numeric;
  if balance_value<>trunc(balance_value) or abs(balance_value)>9000000000000 then raise exception 'Số dư đầu không hợp lệ.';end if;
  if old_record is not null and exists(select 1 from public.cash_movements where account_id=rid) and (
    (old_record->>'opening_balance')::numeric<>balance_value or
    (old_record->>'opening_date') is distinct from nullif(p_payload->>'opening_date','') or
    (old_record->>'opening_confirmed')::boolean is distinct from coalesce((p_payload->>'opening_confirmed')::boolean,false)) then
   raise exception 'Tài khoản đã có giao dịch; không sửa số dư hoặc ngày mở sổ. Cần nghiệp vụ điều chỉnh riêng.';
  end if;
  insert into public.cash_accounts(id,workspace_id,code,name,opening_balance,opening_date,opening_confirmed,note)
   values(rid,w,code_value,name_value,balance_value::bigint,nullif(p_payload->>'opening_date','')::date,coalesce((p_payload->>'opening_confirmed')::boolean,false),coalesce(p_payload->>'note',''))
  on conflict(id) do update set name=excluded.name,opening_balance=excluded.opening_balance,opening_date=excluded.opening_date,opening_confirmed=excluded.opening_confirmed,note=excluded.note
  returning to_jsonb(cash_accounts.*) into result;
 end if;
 perform app_private.audit(w,p_kind||'.saved',rid,jsonb_build_object('code',code_value));return result;
end $$;

create function public.create_purchase(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid:=(p_payload->>'workspace_id')::uuid;rid uuid:=nullif(p_payload->>'id','')::uuid;
 old_row public.purchase_receipts;result jsonb;q numeric:=(p_payload->>'qty')::numeric;cost bigint;extra bigint;
begin
 perform app_private.require_role(w,array['owner','manager','staff']);
 if q is null or q<>trunc(q) or q not between 1 and 1000000 then raise exception 'Số lượng phải là số nguyên từ 1 đến 1.000.000.';end if;
 cost:=app_private.amount(p_payload->>'unit_cost');extra:=app_private.amount(coalesce(p_payload->>'additional_cost','0'));
 perform app_private.amount((q*cost+extra)::text,1);
 if rid is not null then
  select * into old_row from public.purchase_receipts where id=rid and workspace_id=w for update;
  if not found or old_row.status<>'draft' then raise exception 'Chỉ được sửa chứng từ nháp của workspace hiện tại.';end if;
 else rid:=gen_random_uuid();end if;
 insert into public.purchase_receipts(id,workspace_id,supplier_id,product_id,warehouse_id,received_date,date_estimated,qty,unit_cost,additional_cost,notes,legacy_id,source_id,import_row_hash,provenance,created_by)
 values(rid,w,nullif(p_payload->>'supplier_id','')::uuid,nullif(p_payload->>'product_id','')::uuid,nullif(p_payload->>'warehouse_id','')::uuid,
  nullif(p_payload->>'received_date','')::date,coalesce((p_payload->>'date_estimated')::boolean,false),q::integer,cost,extra,coalesce(p_payload->>'notes',''),
  nullif(p_payload->>'legacy_id',''),p_payload->>'source_id',p_payload->>'import_row_hash',coalesce(p_payload->'provenance','{}'),auth.uid())
 on conflict(id) do update set supplier_id=excluded.supplier_id,product_id=excluded.product_id,warehouse_id=excluded.warehouse_id,
  received_date=excluded.received_date,date_estimated=excluded.date_estimated,qty=excluded.qty,unit_cost=excluded.unit_cost,additional_cost=excluded.additional_cost,
  notes=excluded.notes,updated_at=now()
 returning to_jsonb(purchase_receipts.*) into result;
 perform app_private.audit(w,'purchase.draft_saved',rid);return result;
end $$;
create function public.create_cash(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid:=(p_payload->>'workspace_id')::uuid;rid uuid:=nullif(p_payload->>'id','')::uuid;old_row public.cash_transactions;result jsonb;a bigint;
begin
 perform app_private.require_role(w,array['owner','manager','staff']);a:=app_private.amount(p_payload->>'amount',1);
 if rid is not null then
  select * into old_row from public.cash_transactions where id=rid and workspace_id=w for update;
  if not found or old_row.status<>'draft' then raise exception 'Chỉ được sửa chứng từ nháp của workspace hiện tại.';end if;
 else rid:=gen_random_uuid();end if;
 insert into public.cash_transactions(id,workspace_id,account_id,direction,transaction_date,date_estimated,category,amount,description,notes,legacy_id,source_id,import_row_hash,provenance,created_by)
 values(rid,w,nullif(p_payload->>'account_id','')::uuid,p_payload->>'direction',nullif(p_payload->>'transaction_date','')::date,
  coalesce((p_payload->>'date_estimated')::boolean,false),nullif(p_payload->>'category',''),a,coalesce(p_payload->>'description',''),coalesce(p_payload->>'notes',''),
  nullif(p_payload->>'legacy_id',''),p_payload->>'source_id',p_payload->>'import_row_hash',coalesce(p_payload->'provenance','{}'),auth.uid())
 on conflict(id) do update set account_id=excluded.account_id,direction=excluded.direction,transaction_date=excluded.transaction_date,
  date_estimated=excluded.date_estimated,category=excluded.category,amount=excluded.amount,description=excluded.description,notes=excluded.notes,updated_at=now()
 returning to_jsonb(cash_transactions.*) into result;
 perform app_private.audit(w,'cash.draft_saved',rid);return result;
end $$;

create function public.post_purchase(p_id uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.purchase_receipts;p public.products;
begin
 select * into r from public.purchase_receipts where id=p_id for update;
 if not found then raise exception 'Không tìm thấy chứng từ.';end if;
 perform app_private.require_role(r.workspace_id,array['owner','manager']);perform app_private.remember(r.workspace_id,p_request_id,'purchase.post',p_id);
 if r.status='posted' then return to_jsonb(r);end if;
 if r.status<>'draft' then raise exception 'Chứng từ đã đảo, không ghi lại.';end if;
 if r.received_date is null or r.date_estimated then raise exception 'Cần xác nhận ngày nhận thực tế.';end if;
 select * into p from public.products where id=r.product_id and workspace_id=r.workspace_id for share;
 if not found or p.provisional then raise exception 'SKU chưa xác nhận.';end if;
 if r.supplier_id is null or r.warehouse_id is null then raise exception 'Cần chọn nhà cung cấp và kho.';end if;
 insert into public.stock_movements(workspace_id,purchase_id,product_id,warehouse_id,received_date,movement_kind,qty,unit_cost,amount)
 values(r.workspace_id,r.id,r.product_id,r.warehouse_id,r.received_date,'post',r.qty,r.unit_cost,r.total_amount);
 update public.purchase_receipts set status='posted',updated_at=now() where id=r.id returning * into r;
 perform app_private.audit(r.workspace_id,'purchase.posted',r.id,jsonb_build_object('amount',r.total_amount,'qty',r.qty));return to_jsonb(r);
end $$;
create function public.post_cash(p_id uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.cash_transactions;a public.cash_accounts;
begin
 select * into r from public.cash_transactions where id=p_id for update;
 if not found then raise exception 'Không tìm thấy chứng từ.';end if;
 perform app_private.require_role(r.workspace_id,array['owner','manager']);perform app_private.remember(r.workspace_id,p_request_id,'cash.post',p_id);
 if r.status='posted' then return to_jsonb(r);end if;
 if r.status<>'draft' then raise exception 'Chứng từ đã đảo, không ghi lại.';end if;
 if r.transaction_date is null or r.date_estimated then raise exception 'Cần xác nhận ngày thu chi thực tế.';end if;
 select * into a from public.cash_accounts where id=r.account_id and workspace_id=r.workspace_id for share;
 if not found or not a.opening_confirmed or a.opening_date is null then raise exception 'Tài khoản chưa xác nhận số dư và ngày mở sổ.';end if;
 if r.transaction_date<a.opening_date then raise exception 'Giao dịch trước ngày mở sổ.';end if;
 if not ((r.direction='out' and r.category in ('packaging','software','rent','utilities','shipping','marketing','payroll','other_expense','legacy_purchase_payment','owner_withdrawal'))
  or (r.direction='in' and r.category in ('capital','legacy_cod','customer_receipt','other_receipt'))) or r.category is null then raise exception 'Nhóm thu chi không khớp chiều tiền.';end if;
 insert into public.cash_movements(workspace_id,cash_id,account_id,transaction_date,movement_kind,direction,amount,category)
 values(r.workspace_id,r.id,r.account_id,r.transaction_date,'post',r.direction,r.amount,r.category);
 update public.cash_transactions set status='posted',updated_at=now() where id=r.id returning * into r;
 perform app_private.audit(r.workspace_id,'cash.posted',r.id,jsonb_build_object('amount',r.amount,'direction',r.direction));return to_jsonb(r);
end $$;

create function public.reverse_document(p_kind text,p_id uuid,p_request_id uuid,p_date date,p_reason text) returns jsonb language plpgsql security definer set search_path='' as $$
declare pr public.purchase_receipts;cr public.cash_transactions;w uuid;result jsonb;
begin
 if length(trim(p_reason))<10 or p_date is null then raise exception 'Cần ngày và lý do đảo ít nhất 10 ký tự.';end if;
 if p_kind='purchase' then
  select * into pr from public.purchase_receipts where id=p_id for update;
  if not found then raise exception 'Không tìm thấy chứng từ.';end if;
  w:=pr.workspace_id;perform app_private.require_role(w,array['owner']);perform app_private.remember(w,p_request_id,'purchase.reverse',p_id);
  if pr.status='reversed' then return to_jsonb(pr);end if;
  if pr.status<>'posted' or p_date<pr.received_date then raise exception 'Chỉ đảo chứng từ đã ghi, ngày đảo không trước ngày gốc.';end if;
  insert into public.stock_movements(workspace_id,purchase_id,product_id,warehouse_id,received_date,movement_kind,qty,unit_cost,amount)
   values(w,pr.id,pr.product_id,pr.warehouse_id,p_date,'reversal',-pr.qty,pr.unit_cost,-pr.total_amount);
  update public.purchase_receipts set status='reversed',updated_at=now() where id=p_id returning to_jsonb(purchase_receipts.*) into result;
 elsif p_kind='cash' then
  select * into cr from public.cash_transactions where id=p_id for update;
  if not found then raise exception 'Không tìm thấy chứng từ.';end if;
  w:=cr.workspace_id;perform app_private.require_role(w,array['owner']);perform app_private.remember(w,p_request_id,'cash.reverse',p_id);
  if cr.status='reversed' then return to_jsonb(cr);end if;
  if cr.status<>'posted' or p_date<cr.transaction_date then raise exception 'Chỉ đảo chứng từ đã ghi, ngày đảo không trước ngày gốc.';end if;
  insert into public.cash_movements(workspace_id,cash_id,account_id,transaction_date,movement_kind,direction,amount,category)
   values(w,cr.id,cr.account_id,p_date,'reversal',case when cr.direction='in' then 'out' else 'in' end,cr.amount,cr.category);
  update public.cash_transactions set status='reversed',updated_at=now() where id=p_id returning to_jsonb(cash_transactions.*) into result;
 else raise exception 'Loại chứng từ không hợp lệ.';end if;
 perform app_private.audit(w,p_kind||'.reversed',p_id,jsonb_build_object('reason',p_reason,'date',p_date));return result;
end $$;

create function public.import_legacy(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid:=(p_payload->>'workspace_id')::uuid;s text:=p_payload->>'source_id';r jsonb;batch public.import_batches;
 sid uuid;pid uuid;wid uuid;aid uuid;old_hash text;h text;prepared jsonb;counts jsonb;conflicts jsonb:='[]';
 added_p integer:=0;added_c integer:=0;skipped integer:=0;k text;
begin
 perform app_private.require_role(w,array['owner']);
 if s is null or s!~'^[a-f0-9]{64}$' then raise exception 'source_id phải là SHA-256 của file nguồn.';end if;
 perform pg_advisory_xact_lock(hashtext(w::text));
 select * into batch from public.import_batches where workspace_id=w and source_id=s;
 if found then return batch.stats||jsonb_build_object('already_imported',true);end if;
 foreach k in array array['suppliers','products','purchases','cash'] loop
  if jsonb_typeof(p_payload->k) is distinct from 'array' or jsonb_array_length(p_payload->k)>5000 then raise exception 'Mỗi danh sách tối đa 5.000 dòng.';end if;
 end loop;
 for r in select value from jsonb_array_elements(p_payload->'suppliers') loop
  if not exists(select 1 from public.suppliers where workspace_id=w and code=upper(r->>'code')) then
   perform public.save_master('suppliers',r||jsonb_build_object('workspace_id',w));
  end if;
 end loop;
 for r in select value from jsonb_array_elements(p_payload->'products') loop
  select id into sid from public.suppliers where workspace_id=w and code=upper(r->>'supplier_code');
  if not exists(select 1 from public.products where workspace_id=w and code=upper(r->>'code')) then
   perform public.save_master('products',r||jsonb_build_object('workspace_id',w,'supplier_id',sid,'provisional',true));
  end if;
 end loop;
 select id into wid from public.warehouses where workspace_id=w and code='CHIDI-MAIN';
 for r in select value from jsonb_array_elements(p_payload->'purchases') loop
  if length(coalesce(r->>'legacy_id','')) not between 1 and 120 then raise exception 'Thiếu legacy_id của dòng nhập.';end if;
  h:=md5((r-'provenance'-'source_status')::text); -- comparison only, never authentication/identity
  select import_row_hash into old_hash from public.purchase_receipts where workspace_id=w and legacy_id=r->>'legacy_id';
  if found then
   skipped:=skipped+1;
   if old_hash is distinct from h then conflicts:=conflicts||jsonb_build_array(jsonb_build_object('type','purchase','legacy_id',r->>'legacy_id','reason','Dòng nguồn thay đổi; giữ nguyên bản đã nhập.'));end if;
   continue;
  end if;
  select id into sid from public.suppliers where workspace_id=w and code=upper(r->>'supplier_code');
  select id into pid from public.products where workspace_id=w and code=upper(r->>'product_code');
  prepared:=r||jsonb_build_object('workspace_id',w,'supplier_id',sid,'product_id',pid,'warehouse_id',wid,'source_id',s,'import_row_hash',h,
   'provenance',coalesce(r->'provenance','{}')||jsonb_build_object('source_status',r->'source_status','source_id',s));
  perform public.create_purchase(prepared-'id');added_p:=added_p+1;
 end loop;
 for r in select value from jsonb_array_elements(p_payload->'cash') loop
  if length(coalesce(r->>'legacy_id','')) not between 1 and 120 then raise exception 'Thiếu legacy_id thu chi.';end if;
  h:=md5((r-'provenance'-'source_status')::text);
  select import_row_hash into old_hash from public.cash_transactions where workspace_id=w and legacy_id=r->>'legacy_id';
  if found then
   skipped:=skipped+1;
   if old_hash is distinct from h then conflicts:=conflicts||jsonb_build_array(jsonb_build_object('type','cash','legacy_id',r->>'legacy_id','reason','Dòng nguồn thay đổi; cần đối chiếu.'));end if;
   continue;
  end if;
  select id into aid from public.cash_accounts where workspace_id=w and code=upper(r->>'account_code');
  prepared:=r||jsonb_build_object('workspace_id',w,'account_id',aid,'source_id',s,'import_row_hash',h,
   'provenance',coalesce(r->'provenance','{}')||jsonb_build_object('source_status',r->'source_status','source_id',s));
  perform public.create_cash(prepared-'id');added_c:=added_c+1;
 end loop;
 counts:=jsonb_build_object('inserted_purchases',added_p,'inserted_cash',added_c,'skipped',skipped,'conflicts',conflicts);
 insert into public.import_batches(workspace_id,source_id,source_name,stats,created_by)
  values(w,s,left(coalesce(p_payload->>'source_name','Excel import'),255),counts,auth.uid());
 perform app_private.audit(w,'legacy.imported',null,counts);return counts;
end $$;

-- Do not expose helper RPCs; public execution is explicitly revoked.
revoke all on all functions in schema app_private from public,anon,authenticated;
grant execute on function app_private.member_role(uuid) to authenticated;
revoke execute on function public.bootstrap_workspace(text),public.save_master(text,jsonb),public.create_purchase(jsonb),public.create_cash(jsonb),
 public.post_purchase(uuid,uuid),public.post_cash(uuid,uuid),public.reverse_document(text,uuid,uuid,date,text),public.import_legacy(jsonb) from public,anon;
grant execute on function public.bootstrap_workspace(text),public.save_master(text,jsonb),public.create_purchase(jsonb),public.create_cash(jsonb),
 public.post_purchase(uuid,uuid),public.post_cash(uuid,uuid),public.reverse_document(text,uuid,uuid,date,text),public.import_legacy(jsonb) to authenticated;
create index on public.purchase_receipts(workspace_id,status,received_date);
create index on public.cash_transactions(workspace_id,status,transaction_date);
create index on public.stock_movements(workspace_id,product_id,received_date);
create index on public.cash_movements(workspace_id,account_id,transaction_date);
create index on public.audit_events(workspace_id,created_at desc);
commit;
