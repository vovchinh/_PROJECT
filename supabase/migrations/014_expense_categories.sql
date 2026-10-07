-- ERP E3: one category catalog for existing cash documents, not a second ledger.
-- Legacy cash rows and movements are never rewritten. Classification is frozen
-- per original posting; later category changes cannot change historical profit.
begin;

do $$begin
 if to_regclass('public.product_categories') is null or to_regclass('public.live_session_telemetry') is null then
  raise exception 'EXPENSE_PREREQUISITE: Apply complete migrations 001--013 before 014.';
 end if;
 if to_regclass('public.expense_categories') is not null then
  raise exception 'EXPENSE_ALREADY_INSTALLED: 014 runs once; inspect migration history.';
 end if;
end $$;

create table public.expense_categories (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),
 code text not null check(code ~ '^[a-z][a-z0-9_]{0,79}$'),
 name text not null check(length(btrim(name)) between 1 and 200),
 description text not null default '' check(length(description)<=4000),
 direction text not null check(direction in ('in','out')),
 category_kind text not null check(category_kind in ('operating_expense','owner_capital','owner_withdrawal','transfer','loan','cod_settlement','inventory_purchase','customer_receipt','other_receipt')),
 profit_eligible boolean not null default false,
 is_system boolean not null default false,is_active boolean not null default true,
 sort_order integer not null default 0 check(sort_order between 0 and 1000000),
 archived_at timestamptz,archived_by uuid references auth.users(id),archive_reason text,
 created_by uuid not null references auth.users(id),updated_by uuid references auth.users(id),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(workspace_id,id),unique(workspace_id,code),
 check(not profit_eligible or (direction='out' and category_kind='operating_expense')),
 check(is_active=(archived_at is null)),
 check((archived_at is null and archived_by is null and archive_reason is null)
   or (archived_at is not null and archived_by is not null and length(btrim(archive_reason)) between 10 and 4000))
);
create index expense_categories_workspace_order on public.expense_categories(workspace_id,sort_order,code);

-- Add only a reference key/index: no historical movement value is changed.
alter table public.cash_movements add constraint cash_movements_workspace_id_cash_key unique(workspace_id,id,cash_id);

create table public.cash_category_snapshots (
 workspace_id uuid not null references public.workspaces(id),cash_id uuid not null,
 original_post_id uuid not null unique,category_id uuid,
 code text not null,name text,direction text not null check(direction in ('in','out')),
 category_kind text not null,profit_eligible boolean not null,
 classification_source text not null check(classification_source in ('legacy_v1','legacy_unknown','posted')),
 created_at timestamptz not null default now(),
 primary key(workspace_id,cash_id),
 foreign key(workspace_id,cash_id) references public.cash_transactions(workspace_id,id),
 foreign key(workspace_id,original_post_id,cash_id) references public.cash_movements(workspace_id,id,cash_id),
 foreign key(workspace_id,category_id) references public.expense_categories(workspace_id,id),
 check(not profit_eligible or (direction='out' and category_kind='operating_expense')),
 check((classification_source='legacy_unknown' and category_id is null and name is null and category_kind='unknown' and not profit_eligible)
   or (classification_source<>'legacy_unknown' and category_id is not null and name is not null
     and category_kind in ('operating_expense','owner_capital','owner_withdrawal','transfer','loan','cod_settlement','inventory_purchase','customer_receipt','other_receipt')))
);
create index cash_category_snapshots_category on public.cash_category_snapshots(workspace_id,category_id);

-- Exact policy from src/lib/domain.js before E3, including payroll=false.
create function app_private.legacy_cash_categories()
returns table(code text,name text,direction text,category_kind text,profit_eligible boolean,sort_order integer)
language sql immutable set search_path='' as $$
 values
 ('packaging','Bao bì','out','operating_expense',true,10),
 ('software','Phần mềm / FLive','out','operating_expense',true,20),
 ('rent','Thuê mặt bằng','out','operating_expense',true,30),
 ('utilities','Điện nước / Internet','out','operating_expense',true,40),
 ('shipping','Vận chuyển ngoài đối soát','out','operating_expense',true,50),
 ('marketing','Marketing','out','operating_expense',true,60),
 ('payroll','Thanh toán lương','out','operating_expense',false,70),
 ('other_expense','Chi phí khác','out','operating_expense',true,80),
 ('legacy_purchase_payment','Tiền mua hàng chờ gắn PO','out','inventory_purchase',false,90),
 ('owner_withdrawal','Chủ shop rút tiền','out','owner_withdrawal',false,100),
 ('capital','Chủ shop góp tiền','in','owner_capital',false,110),
 ('legacy_cod','COD cũ chờ đối soát','in','cod_settlement',false,120),
 ('customer_receipt','Thu tiền khách hàng','in','customer_receipt',false,130),
 ('other_receipt','Khoản thu khác','in','other_receipt',false,140)
$$;

insert into public.expense_categories(workspace_id,code,name,direction,category_kind,profit_eligible,sort_order,is_system,created_by)
 select w.id,c.code,c.name,c.direction,c.category_kind,c.profit_eligible,c.sort_order,true,w.created_by
 from public.workspaces w cross join app_private.legacy_cash_categories() c;

-- Classification is based on the original movement, even when the cash document
-- is now reversed. Unknown codes/direction mismatches are retained explicitly.
insert into public.cash_category_snapshots(workspace_id,cash_id,original_post_id,category_id,code,name,direction,category_kind,profit_eligible,classification_source)
 select m.workspace_id,m.cash_id,m.id,c.id,m.category,c.name,m.direction,
   coalesce(c.category_kind,'unknown'),coalesce(c.profit_eligible,false),
   case when c.id is null then 'legacy_unknown' else 'legacy_v1' end
 from public.cash_movements m left join public.expense_categories c
   on c.workspace_id=m.workspace_id and c.code=m.category and c.direction=m.direction
 where m.movement_kind='post';

create function app_private.seed_workspace_expense_categories() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 insert into public.expense_categories(workspace_id,code,name,direction,category_kind,profit_eligible,sort_order,is_system,created_by)
  select new.id,c.code,c.name,c.direction,c.category_kind,c.profit_eligible,c.sort_order,true,new.created_by
  from app_private.legacy_cash_categories() c;
 return new;
end $$;
create trigger seed_workspace_expense_categories after insert on public.workspaces
 for each row execute function app_private.seed_workspace_expense_categories();

do $$declare t text;begin
 foreach t in array array['expense_categories','cash_category_snapshots'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('create policy member_read on public.%I for select to authenticated using(app_private.member_role(workspace_id) is not null)',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
 end loop;
end $$;

create function public.get_expense_categories(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 perform app_private.require_role(p_workspace_id,array['owner','manager','staff','viewer']);
 if (select count(*) from public.expense_categories where workspace_id=p_workspace_id)>5000 then
  raise exception 'EXPENSE_RESULT_LIMIT: Danh mục vượt 5.000 nhóm; cần phân trang, không trả dữ liệu bị cắt.';
 end if;
 select jsonb_build_object('categories',coalesce(jsonb_agg(to_jsonb(c) order by c.sort_order,c.code),'[]'::jsonb),
  'reconciliation',jsonb_build_object(
   'posted_document_count',(select count(*) from public.cash_movements where workspace_id=p_workspace_id and movement_kind='post'),
   'snapshot_count',(select count(*) from public.cash_category_snapshots where workspace_id=p_workspace_id),
   'unknown_posted_count',(select count(*) from public.cash_category_snapshots where workspace_id=p_workspace_id and classification_source='legacy_unknown'),
   'missing_snapshot_count',(select count(*) from public.cash_movements m where m.workspace_id=p_workspace_id and m.movement_kind='post'
     and not exists(select 1 from public.cash_category_snapshots s where s.workspace_id=m.workspace_id and s.cash_id=m.cash_id)),
   'unclassified_draft_count',(select count(*) from public.cash_transactions t where t.workspace_id=p_workspace_id and t.status='draft'
     and not exists(select 1 from public.expense_categories e where e.workspace_id=t.workspace_id and e.code=t.category and e.direction=t.direction)),
   'orphan_reversal_count',(select count(*) from public.cash_movements m where m.workspace_id=p_workspace_id and m.movement_kind='reversal'
     and not exists(select 1 from public.cash_category_snapshots s where s.workspace_id=m.workspace_id and s.cash_id=m.cash_id))))
 into result from public.expense_categories c where c.workspace_id=p_workspace_id;
 return result;
end $$;

create function public.save_expense_category(p_workspace_id uuid,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare rid uuid;old_row public.expense_categories;result public.expense_categories;
 code_value text;name_value text;description_value text;direction_value text;kind_value text;eligible_value boolean;sort_value numeric;
begin
 perform app_private.catalog_lock(p_workspace_id);
 rid:=nullif(app_private.foundation_text(p_payload,'id',36),'')::uuid;
 if rid is not null then
  select * into old_row from public.expense_categories where workspace_id=p_workspace_id and id=rid for update;
  if not found then raise exception 'EXPENSE_NOT_FOUND: Nhóm không thuộc workspace.';end if;
 else
  if (select count(*) from public.expense_categories where workspace_id=p_workspace_id)>=5000 then raise exception 'EXPENSE_RESULT_LIMIT: Tối đa 5.000 nhóm trong workspace.';end if;
  rid:=gen_random_uuid();
 end if;
 code_value:=case when p_payload ? 'code' then app_private.foundation_text(p_payload,'code',80,true) else old_row.code end;
 name_value:=app_private.foundation_text(p_payload,'name',200,true);
 description_value:=case when p_payload ? 'description' then app_private.foundation_text(p_payload,'description',4000) else coalesce(old_row.description,'') end;
 direction_value:=case when p_payload ? 'direction' then app_private.foundation_text(p_payload,'direction',3,true) else coalesce(old_row.direction,'out') end;
 kind_value:=case when p_payload ? 'category_kind' then app_private.foundation_text(p_payload,'category_kind',30,true) else coalesce(old_row.category_kind,case when direction_value='out' then 'operating_expense' else 'other_receipt' end) end;
 eligible_value:=app_private.foundation_boolean(p_payload,'profit_eligible',coalesce(old_row.profit_eligible,false));
 if code_value is null or code_value !~ '^[a-z][a-z0-9_]{0,79}$' then raise exception 'EXPENSE_CODE: Mã dùng chữ thường, số, gạch dưới; bắt đầu bằng chữ.';end if;
 if old_row.id is not null and old_row.code<>code_value then raise exception 'EXPENSE_CODE_IMMUTABLE: Không đổi mã đã tạo.';end if;
 if old_row.id is not null and (old_row.direction<>direction_value or old_row.category_kind<>kind_value) then
  raise exception 'EXPENSE_KIND_IMMUTABLE: Không đổi chiều tiền hoặc loại nghiệp vụ; tạo mã mới.';
 end if;
 if direction_value not in ('in','out') or kind_value not in ('operating_expense','owner_capital','owner_withdrawal','transfer','loan','cod_settlement','inventory_purchase','customer_receipt','other_receipt')
  or (eligible_value and (direction_value<>'out' or kind_value<>'operating_expense')) then
  raise exception 'EXPENSE_CLASSIFICATION: Chỉ khoản chi hoạt động được tính vào lợi nhuận.';
 end if;
 if p_payload ? 'sort_order' and jsonb_typeof(p_payload->'sort_order') not in ('number','string') then raise exception 'EXPENSE_SORT: Thứ tự phải là số nguyên.';end if;
 sort_value:=case when p_payload ? 'sort_order' then (p_payload->>'sort_order')::numeric else coalesce(old_row.sort_order,0) end;
 if sort_value is null or sort_value<>trunc(sort_value) or sort_value not between 0 and 1000000 then raise exception 'EXPENSE_SORT: Thứ tự từ 0 đến 1.000.000.';end if;
 insert into public.expense_categories(id,workspace_id,code,name,description,direction,category_kind,profit_eligible,sort_order,created_by,updated_by)
 values(rid,p_workspace_id,code_value,name_value,description_value,direction_value,kind_value,eligible_value,sort_value::integer,auth.uid(),auth.uid())
 on conflict(id) do update set name=excluded.name,description=excluded.description,profit_eligible=excluded.profit_eligible,
   sort_order=excluded.sort_order,updated_by=auth.uid(),updated_at=now()
 returning * into result;
 perform app_private.audit(p_workspace_id,'expense_category.saved',rid,jsonb_build_object('before',to_jsonb(old_row),'after',to_jsonb(result)));
 return to_jsonb(result);
end $$;

create function public.set_expense_category_archived(p_workspace_id uuid,p_id uuid,p_archived boolean,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare old_row public.expense_categories;result public.expense_categories;reason_value text;
begin
 perform app_private.catalog_lock(p_workspace_id);reason_value:=app_private.catalog_reason(p_reason);
 if p_archived is null then raise exception 'EXPENSE_INPUT: Cần trạng thái lưu trữ.';end if;
 select * into old_row from public.expense_categories where workspace_id=p_workspace_id and id=p_id for update;
 if not found then raise exception 'EXPENSE_NOT_FOUND: Nhóm không thuộc workspace.';end if;
 if old_row.is_active=not p_archived then return to_jsonb(old_row);end if;
 update public.expense_categories set is_active=not p_archived,archived_at=case when p_archived then now() end,
  archived_by=case when p_archived then auth.uid() end,archive_reason=case when p_archived then reason_value end,
  updated_by=auth.uid(),updated_at=now() where workspace_id=p_workspace_id and id=p_id returning * into result;
 perform app_private.audit(p_workspace_id,case when p_archived then 'expense_category.archived' else 'expense_category.restored' end,p_id,
  jsonb_build_object('before',to_jsonb(old_row),'after',to_jsonb(result),'reason',reason_value));
 return to_jsonb(result);
end $$;

create function public.delete_expense_category(p_workspace_id uuid,p_id uuid,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare old_row public.expense_categories;reason_value text;
begin
 perform app_private.catalog_lock(p_workspace_id);perform app_private.require_role(p_workspace_id,array['owner']);
 reason_value:=app_private.catalog_reason(p_reason);
 select * into old_row from public.expense_categories where workspace_id=p_workspace_id and id=p_id for update;
 if not found then raise exception 'EXPENSE_NOT_FOUND: Nhóm không thuộc workspace.';end if;
 if old_row.is_system then raise exception 'EXPENSE_SYSTEM: Nhóm mặc định được lưu trữ, không xóa mã tương thích.';end if;
 if exists(select 1 from public.cash_transactions where workspace_id=p_workspace_id and category=old_row.code)
  or exists(select 1 from public.cash_movements where workspace_id=p_workspace_id and category=old_row.code)
  or exists(select 1 from public.cash_category_snapshots where workspace_id=p_workspace_id and category_id=p_id) then
  raise exception 'EXPENSE_IN_USE: Nhóm có chứng từ hoặc lịch sử; hãy lưu trữ.';
 end if;
 delete from public.expense_categories where workspace_id=p_workspace_id and id=p_id;
 perform app_private.audit(p_workspace_id,'expense_category.deleted',p_id,jsonb_build_object('before',to_jsonb(old_row),'reason',reason_value));
 return jsonb_build_object('deleted_id',p_id,'code',old_row.code);
end $$;

-- Lock known draft references against concurrent category deletion. Unknown
-- legacy/import drafts remain legal and visible, but can never be posted.
create function app_private.lock_cash_category_reference() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 perform 1 from public.expense_categories where workspace_id=new.workspace_id and code=new.category for share;
 return new;
end $$;
create trigger lock_cash_category_reference before insert or update of category,direction on public.cash_transactions
 for each row execute function app_private.lock_cash_category_reference();

create function app_private.freeze_cash_category() returns trigger
language plpgsql security definer set search_path='' as $$
declare c public.expense_categories;
begin
 if new.movement_kind='post' then
  select * into c from public.expense_categories where workspace_id=new.workspace_id and code=new.category and direction=new.direction for share;
  if not found or not c.is_active then raise exception 'EXPENSE_CATEGORY: Chọn nhóm đang hoạt động, đúng chiều tiền trong workspace.';end if;
  insert into public.cash_category_snapshots(workspace_id,cash_id,original_post_id,category_id,code,name,direction,category_kind,profit_eligible,classification_source)
  values(new.workspace_id,new.cash_id,new.id,c.id,c.code,c.name,c.direction,c.category_kind,c.profit_eligible,'posted');
 end if;
 return new;
end $$;
create trigger freeze_cash_category after insert on public.cash_movements
 for each row execute function app_private.freeze_cash_category();

create function app_private.protect_cash_category_snapshot() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 raise exception 'EXPENSE_SNAPSHOT_IMMUTABLE: Phân loại lúc ghi sổ không được sửa hoặc xóa.';
end $$;
create trigger protect_cash_category_snapshot before update or delete on public.cash_category_snapshots
 for each row execute function app_private.protect_cash_category_snapshot();

-- Same public contract/permissions/idempotency; only replace the static allowlist
-- with the workspace catalog. The insert trigger freezes posting classification.
create or replace function public.post_cash(p_id uuid,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.cash_transactions;a public.cash_accounts;c public.expense_categories;
begin
 select * into r from public.cash_transactions where id=p_id for update;
 if not found then raise exception 'Không tìm thấy chứng từ.';end if;
 perform app_private.require_role(r.workspace_id,array['owner','manager']);perform app_private.remember(r.workspace_id,p_request_id,'cash.post',p_id);
 if r.status='posted' then return to_jsonb(r);end if;
 if r.status<>'draft' then raise exception 'Chứng từ đã đảo, không ghi lại.';end if;
 if r.transaction_date is null or not isfinite(r.transaction_date) or r.date_estimated then raise exception 'Cần xác nhận ngày thu chi thực tế.';end if;
 select * into a from public.cash_accounts where id=r.account_id and workspace_id=r.workspace_id for share;
 if not found or not a.opening_confirmed or a.opening_date is null then raise exception 'Tài khoản chưa xác nhận số dư và ngày mở sổ.';end if;
 if r.transaction_date<a.opening_date then raise exception 'Giao dịch trước ngày mở sổ.';end if;
 select * into c from public.expense_categories where workspace_id=r.workspace_id and code=r.category and direction=r.direction for share;
 if not found or not c.is_active then raise exception 'EXPENSE_CATEGORY: Chọn nhóm đang hoạt động, đúng chiều tiền trong workspace.';end if;
 insert into public.cash_movements(workspace_id,cash_id,account_id,transaction_date,movement_kind,direction,amount,category)
 values(r.workspace_id,r.id,r.account_id,r.transaction_date,'post',r.direction,r.amount,r.category);
 update public.cash_transactions set status='posted',updated_at=now() where id=r.id returning * into r;
 perform app_private.audit(r.workspace_id,'cash.posted',r.id,jsonb_build_object('amount',r.amount,'direction',r.direction,'category_id',c.id,'profit_eligible',c.profit_eligible));
 return to_jsonb(r);
end $$;

revoke all on function app_private.legacy_cash_categories(),app_private.seed_workspace_expense_categories(),
 app_private.lock_cash_category_reference(),app_private.freeze_cash_category(),app_private.protect_cash_category_snapshot() from public,anon,authenticated;
revoke all on function public.get_expense_categories(uuid),public.save_expense_category(uuid,jsonb),
 public.set_expense_category_archived(uuid,uuid,boolean,text),public.delete_expense_category(uuid,uuid,text),public.post_cash(uuid,uuid) from public,anon;
grant execute on function public.get_expense_categories(uuid),public.save_expense_category(uuid,jsonb),
 public.set_expense_category_archived(uuid,uuid,boolean,text),public.delete_expense_category(uuid,uuid,text),public.post_cash(uuid,uuid) to authenticated;

commit;
