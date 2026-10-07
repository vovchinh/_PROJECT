-- ERP E2: additive catalog management over the complete 001--012 schema.
-- Existing product UUIDs, variants, FIFO lots and historical documents stay intact.
begin;

do $$begin
 if to_regclass('public.live_session_telemetry') is null
   or to_regclass('public.live_sale_tickets') is null
   or to_regprocedure('public.save_master(text,jsonb)') is null then
  raise exception 'CATALOG_PREREQUISITE: Apply complete migrations 001--012 before 013.';
 end if;
 if to_regclass('public.product_categories') is not null then
  raise exception 'CATALOG_ALREADY_INSTALLED: 013 runs once; inspect migration history.';
 end if;
end $$;

create table public.product_categories (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id),
 code text check(code is null or length(code) between 1 and 80),
 name text not null check(length(name) between 1 and 200),
 description text not null default '' check(length(description)<=4000),
 parent_id uuid,sort_order integer not null default 0 check(sort_order between 0 and 1000000),
 is_active boolean not null default true,
 archived_at timestamptz, archived_by uuid references auth.users(id), archive_reason text,
 created_by uuid not null references auth.users(id),
 updated_by uuid references auth.users(id),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(workspace_id,id), unique(workspace_id,code),
 foreign key(workspace_id,parent_id) references public.product_categories(workspace_id,id),
 check(parent_id is distinct from id),
 check(is_active=(archived_at is null)),
 check((archived_at is null and archived_by is null and archive_reason is null)
   or (archived_at is not null and archived_by is not null and length(btrim(archive_reason)) between 10 and 4000))
);
create unique index product_categories_normalized_code_key
 on public.product_categories(workspace_id,app_private.catalog_normalize(code)) where code is not null;
create index product_categories_parent_order on public.product_categories(workspace_id,parent_id,sort_order,name);
alter table public.product_categories enable row level security;
create policy member_read on public.product_categories for select to authenticated
 using(app_private.member_role(workspace_id) is not null);
revoke all on public.product_categories from public,anon,authenticated;
grant select on public.product_categories to authenticated;

alter table public.products
 add column category_id uuid,
 add column barcode text check(barcode is null or length(barcode) between 1 and 120),
 add column sale_price bigint check(sale_price between 0 and 9000000000000),
 add column image_url text check(image_url is null or (length(image_url)<=2048 and image_url ~ '^https://[^/@[:space:]]+(/[^[:space:]]*)?$')),
 add column archived_at timestamptz,
 add column archived_by uuid references auth.users(id),
 add column archive_reason text,
 add column updated_at timestamptz not null default now(),
 add constraint products_category_workspace_fk foreign key(workspace_id,category_id)
   references public.product_categories(workspace_id,id),
 add constraint products_archive_consistency check(
   (archived_at is null and archived_by is null and archive_reason is null)
   or (archived_at is not null and archived_by is not null and length(btrim(archive_reason)) between 10 and 4000));
-- Keep archived barcodes reserved so restore never reassigns a physical identity.
create unique index products_workspace_barcode_key on public.products(workspace_id,barcode) where barcode is not null;
create index products_category_lookup on public.products(workspace_id,category_id);
create index products_active_catalog_lookup on public.products(workspace_id,code) where archived_at is null;

create function public.save_product_category(p_workspace_id uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare rid uuid;old_row public.product_categories;result public.product_categories;
 code_value text;name_value text;description_value text;parent_value uuid;sort_value integer;
begin
 perform app_private.catalog_lock(p_workspace_id);
 if jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'CATALOG_INPUT: Cần thông tin nhóm sản phẩm.';end if;
 rid:=nullif(p_payload->>'id','')::uuid;
 code_value:=nullif(upper(app_private.catalog_clean_text(p_payload->>'code')),'');
 name_value:=app_private.catalog_clean_text(p_payload->>'name');
 description_value:=coalesce(p_payload->>'description',p_payload->>'note','');
 parent_value:=nullif(p_payload->>'parent_id','')::uuid;
 sort_value:=coalesce((p_payload->>'sort_order')::integer,0);
 if length(code_value)>80 or length(name_value) not between 1 and 200 or length(description_value)>4000
    or sort_value not between 0 and 1000000 then
  raise exception 'CATALOG_INPUT: Mã tối đa 80, tên 1–200, mô tả tối đa 4.000 ký tự và thứ tự từ 0 đến 1.000.000.';
 end if;
 if rid is not null then
  select * into old_row from public.product_categories where workspace_id=p_workspace_id and id=rid for update;
  if not found then raise exception 'CATALOG_NOT_FOUND: Nhóm không thuộc workspace.';end if;
  if old_row.code is distinct from code_value then raise exception 'CATALOG_CODE_IMMUTABLE: Không đổi mã đã tạo.';end if;
 else rid:=gen_random_uuid();end if;
 if parent_value is not null then
  if parent_value=rid or not exists(select 1 from public.product_categories
    where workspace_id=p_workspace_id and id=parent_value and archived_at is null) then
   raise exception 'CATALOG_PARENT: Nhóm cha phải đang hoạt động trong workspace.';
  end if;
  if exists(with recursive ancestors as (
     select id,parent_id from public.product_categories where workspace_id=p_workspace_id and id=parent_value
     union all
     select c.id,c.parent_id from public.product_categories c join ancestors a on c.id=a.parent_id
       where c.workspace_id=p_workspace_id
   ) select 1 from ancestors where id=rid) then
   raise exception 'CATALOG_PARENT: Nhóm cha tạo vòng lặp.';
  end if;
 end if;
 insert into public.product_categories(id,workspace_id,code,name,description,parent_id,sort_order,created_by,updated_by)
 values(rid,p_workspace_id,code_value,name_value,description_value,parent_value,sort_value,auth.uid(),auth.uid())
 on conflict(id) do update set name=excluded.name,description=excluded.description,parent_id=excluded.parent_id,
   sort_order=excluded.sort_order,updated_by=auth.uid(),updated_at=now()
 returning * into result;
 perform app_private.audit(p_workspace_id,'product_category.saved',rid,
   jsonb_build_object('before',to_jsonb(old_row),'after',to_jsonb(result)));
 return to_jsonb(result);
end $$;

-- Keep the existing save_master signature and all nonproduct behavior. Old clients
-- and import_legacy still work; omitted new fields preserve existing metadata.
alter function public.save_master(text,jsonb) set schema app_private;
alter function app_private.save_master(text,jsonb) rename to save_master_before_catalog;
revoke all on function app_private.save_master_before_catalog(text,jsonb) from public,anon,authenticated;

create function public.save_master(p_kind text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid;rid uuid;old_row public.products;result public.products;
 category_value uuid;barcode_value text;image_value text;price_value bigint;legacy_result jsonb;
begin
 if p_kind is distinct from 'products' then return app_private.save_master_before_catalog(p_kind,p_payload);end if;
 if jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'CATALOG_INPUT: Cần thông tin sản phẩm.';end if;
 w:=(p_payload->>'workspace_id')::uuid;
 perform app_private.catalog_lock(w);
 rid:=nullif(p_payload->>'id','')::uuid;
 if rid is not null then
  select * into old_row from public.products where workspace_id=w and id=rid for update;
  if not found then raise exception 'CATALOG_NOT_FOUND: Sản phẩm không thuộc workspace.';end if;
 end if;
 if p_payload ? 'category_id' and jsonb_typeof(p_payload->'category_id') not in ('string','null') then raise exception 'CATALOG_INPUT: Nhóm sản phẩm không hợp lệ.';end if;
 category_value:=case when p_payload ? 'category_id' then nullif(p_payload->>'category_id','')::uuid else old_row.category_id end;
 if category_value is not null and not exists(select 1 from public.product_categories
   where workspace_id=w and id=category_value and (archived_at is null or id=old_row.category_id)) then
  raise exception 'CATALOG_CATEGORY: Chọn nhóm đang sử dụng trong workspace.';
 end if;
 if p_payload ? 'barcode' and jsonb_typeof(p_payload->'barcode') not in ('string','null') then raise exception 'CATALOG_INPUT: Barcode phải là chuỗi ký tự.';end if;
 barcode_value:=case when p_payload ? 'barcode' then nullif(app_private.catalog_clean_text(p_payload->>'barcode'),'') else old_row.barcode end;
 if length(barcode_value)>120 then raise exception 'CATALOG_INPUT: Barcode tối đa 120 ký tự.';end if;
 if p_payload ? 'image_url' and jsonb_typeof(p_payload->'image_url') not in ('string','null') then raise exception 'CATALOG_INPUT: Địa chỉ ảnh không hợp lệ.';end if;
 image_value:=case when p_payload ? 'image_url' then nullif(btrim(p_payload->>'image_url'),'') else old_row.image_url end;
 if image_value is not null and (length(image_value)>2048 or image_value !~ '^https://[^/@[:space:]]+(/[^[:space:]]*)?$') then
  raise exception 'CATALOG_IMAGE: Ảnh cần địa chỉ HTTPS hợp lệ, tối đa 2.048 ký tự.';
 end if;
 price_value:=old_row.sale_price;
 if p_payload ? 'sale_price' then
  if p_payload->>'sale_price' is null or p_payload->>'sale_price'='' then price_value:=null;
  else
   if jsonb_typeof(p_payload->'sale_price') not in ('number','string') then raise exception 'CATALOG_PRICE: Giá bán phải là số nguyên VND.';end if;
   price_value:=app_private.amount(p_payload->>'sale_price');
  end if;
 end if;
 legacy_result:=app_private.save_master_before_catalog(p_kind,p_payload);
 rid:=(legacy_result->>'id')::uuid;
 update public.products set category_id=category_value,barcode=barcode_value,sale_price=price_value,image_url=image_value,updated_at=now()
 where workspace_id=w and id=rid returning * into result;
 perform app_private.audit(w,'product.saved',rid,jsonb_build_object('before',to_jsonb(old_row),'after',to_jsonb(result)));
 return to_jsonb(result);
end $$;

create function public.save_catalog_product(p_workspace_id uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'CATALOG_INPUT: Cần thông tin sản phẩm.';end if;
 return public.save_master('products',p_payload||jsonb_build_object('workspace_id',p_workspace_id));
end $$;

create function app_private.catalog_reason(p_reason text) returns text
language plpgsql immutable set search_path='' as $$
declare result text:=app_private.catalog_clean_text(p_reason);
begin
 if length(result) not between 10 and 4000 then raise exception 'CATALOG_REASON: Cần lý do từ 10 đến 4.000 ký tự.';end if;
 return result;
end $$;

create function public.set_product_category_archived(p_workspace_id uuid,p_id uuid,p_archived boolean,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare old_row public.product_categories;result public.product_categories;reason_value text;
begin
 perform app_private.catalog_lock(p_workspace_id);
 reason_value:=app_private.catalog_reason(p_reason);
 if p_archived is null then raise exception 'CATALOG_INPUT: Cần trạng thái lưu trữ.';end if;
 select * into old_row from public.product_categories where workspace_id=p_workspace_id and id=p_id for update;
 if not found then raise exception 'CATALOG_NOT_FOUND: Nhóm không thuộc workspace.';end if;
 if (old_row.archived_at is not null)=p_archived then return to_jsonb(old_row);end if;
 if p_archived and exists(select 1 from public.product_categories where workspace_id=p_workspace_id and parent_id=p_id and archived_at is null) then
  raise exception 'CATALOG_CHILD_ACTIVE: Lưu trữ nhóm con trước khi lưu trữ nhóm cha.';
 end if;
 if not p_archived and old_row.parent_id is not null and not exists(select 1 from public.product_categories
   where workspace_id=p_workspace_id and id=old_row.parent_id and archived_at is null) then
  raise exception 'CATALOG_PARENT: Khôi phục nhóm cha trước khi khôi phục nhóm con.';
 end if;
 update public.product_categories set archived_at=case when p_archived then now() end,
   archived_by=case when p_archived then auth.uid() end,archive_reason=case when p_archived then reason_value end,
   is_active=not p_archived,updated_by=auth.uid(),updated_at=now()
 where workspace_id=p_workspace_id and id=p_id returning * into result;
 perform app_private.audit(p_workspace_id,case when p_archived then 'product_category.archived' else 'product_category.restored' end,p_id,
   jsonb_build_object('before',to_jsonb(old_row),'after',to_jsonb(result),'reason',reason_value));
 return to_jsonb(result);
end $$;

create function public.delete_product_category(p_workspace_id uuid,p_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare old_row public.product_categories;reason_value text;used_count bigint;
begin
 perform app_private.catalog_lock(p_workspace_id);
 perform app_private.require_role(p_workspace_id,array['owner']);
 reason_value:=app_private.catalog_reason(p_reason);
 select * into old_row from public.product_categories where workspace_id=p_workspace_id and id=p_id for update;
 if not found then raise exception 'CATALOG_NOT_FOUND: Nhóm không thuộc workspace.';end if;
 select count(*) into used_count from public.products where workspace_id=p_workspace_id and category_id=p_id;
 if used_count>0 then raise exception 'CATALOG_IN_USE: Nhóm còn % sản phẩm (kể cả đã lưu trữ); hãy lưu trữ nhóm.',used_count;end if;
 if exists(select 1 from public.product_categories where workspace_id=p_workspace_id and parent_id=p_id) then
  raise exception 'CATALOG_IN_USE: Nhóm còn nhóm con; hãy chuyển nhóm con trước khi xóa.';
 end if;
 delete from public.product_categories where workspace_id=p_workspace_id and id=p_id;
 perform app_private.audit(p_workspace_id,'product_category.deleted',p_id,jsonb_build_object('before',to_jsonb(old_row),'reason',reason_value));
 return jsonb_build_object('deleted_id',p_id,'code',old_row.code);
end $$;

create function public.set_catalog_product_archived(p_workspace_id uuid,p_id uuid,p_archived boolean,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare old_row public.products;result public.products;reason_value text;
begin
 perform app_private.catalog_lock(p_workspace_id);
 reason_value:=app_private.catalog_reason(p_reason);
 if p_archived is null then raise exception 'CATALOG_INPUT: Cần trạng thái lưu trữ.';end if;
 select * into old_row from public.products where workspace_id=p_workspace_id and id=p_id for update;
 if not found then raise exception 'CATALOG_NOT_FOUND: Sản phẩm không thuộc workspace.';end if;
 if (old_row.archived_at is not null)=p_archived then return to_jsonb(old_row);end if;
 if p_archived and (exists(select 1 from public.inventory_reservations
   where workspace_id=p_workspace_id and product_id=p_id and status='active')
   or exists(select 1 from public.sales_allocations a join public.inventory_lots l
      on l.workspace_id=a.workspace_id and l.id=a.lot_id
      where a.workspace_id=p_workspace_id and l.product_id=p_id and a.status='reserved')) then
  raise exception 'PRODUCT_HAS_ACTIVE_RESERVATION: Giải quyết giữ hàng/đơn xác nhận trước khi lưu trữ SKU.';
 end if;
 update public.products set archived_at=case when p_archived then now() end,
   archived_by=case when p_archived then auth.uid() end,archive_reason=case when p_archived then reason_value end,updated_at=now()
 where workspace_id=p_workspace_id and id=p_id returning * into result;
 perform app_private.audit(p_workspace_id,case when p_archived then 'product.archived' else 'product.restored' end,p_id,
   jsonb_build_object('before',to_jsonb(old_row),'after',to_jsonb(result),'reason',reason_value));
 return to_jsonb(result);
end $$;

create function public.get_catalog_product_usage(p_workspace_id uuid,p_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare refs jsonb;metadata jsonb;used boolean;held boolean;stocked boolean;reasons jsonb:='[]'::jsonb;
begin
 perform app_private.require_role(p_workspace_id,array['owner','manager','staff','viewer']);
 if not exists(select 1 from public.products where workspace_id=p_workspace_id and id=p_id) then raise exception 'CATALOG_NOT_FOUND: Sản phẩm không thuộc workspace.';end if;
 -- Every business status blocks deletion, including draft/reversed receipts,
 -- exhausted lots, released holds, cancelled orders and VOID live tickets.
 select jsonb_build_object(
  'purchase_receipts',(select count(*) from public.purchase_receipts where workspace_id=p_workspace_id and product_id=p_id),
  'stock_movements',(select count(*) from public.stock_movements where workspace_id=p_workspace_id and product_id=p_id),
  'sales_order_lines',(select count(*) from public.sales_order_lines where workspace_id=p_workspace_id and product_id=p_id),
  'inventory_lots',(select count(*) from public.inventory_lots where workspace_id=p_workspace_id and product_id=p_id),
  'inventory_timeline',(select count(*) from app_private.inventory_timeline where workspace_id=p_workspace_id and product_id=p_id),
  'inventory_reservations',(select count(*) from public.inventory_reservations where workspace_id=p_workspace_id and product_id=p_id),
  'live_sale_tickets',(select count(*) from public.live_sale_tickets where workspace_id=p_workspace_id and (product_id=p_id or variant_id=p_id)),
  'sales_allocations',(select count(*) from public.sales_allocations a join public.sales_order_lines l on l.workspace_id=a.workspace_id and l.id=a.line_id where a.workspace_id=p_workspace_id and l.product_id=p_id),
  'reservation_lots',(select count(*) from public.reservation_lots a join public.inventory_lots l on l.workspace_id=a.workspace_id and l.id=a.lot_id where a.workspace_id=p_workspace_id and l.product_id=p_id),
  'customer_cart_items',(select count(*) from public.customer_cart_items a join public.live_sale_tickets t on t.workspace_id=a.workspace_id and t.id=a.ticket_id where a.workspace_id=p_workspace_id and t.product_id=p_id),
  'live_print_jobs',(select count(*) from public.live_print_jobs a join public.live_sale_tickets t on t.workspace_id=a.workspace_id and t.id=a.ticket_id where a.workspace_id=p_workspace_id and t.product_id=p_id),
  'live_outbox_events',(select count(*) from public.live_outbox_events a join public.live_sale_tickets t on t.workspace_id=a.workspace_id and t.id=a.ticket_id where a.workspace_id=p_workspace_id and t.product_id=p_id)
 ) into refs;
 select exists(select 1 from jsonb_each_text(refs) where value::bigint>0) into used;
 select exists(select 1 from public.inventory_reservations where workspace_id=p_workspace_id and product_id=p_id and status='active')
  or exists(select 1 from public.sales_allocations a join public.inventory_lots l on l.workspace_id=a.workspace_id and l.id=a.lot_id
    where a.workspace_id=p_workspace_id and l.product_id=p_id and a.status='reserved') into held;
 select exists(select 1 from public.inventory_lots where workspace_id=p_workspace_id and product_id=p_id and remaining_qty>0) into stocked;
 if held then reasons:=reasons||'"PRODUCT_HAS_ACTIVE_RESERVATION"'::jsonb;end if;
 if stocked then reasons:=reasons||'"PRODUCT_HAS_STOCK"'::jsonb;end if;
 if used then reasons:=reasons||'"PRODUCT_HAS_HISTORY"'::jsonb;end if;
 select jsonb_build_object(
   'variants',(select count(*) from public.product_variants where workspace_id=p_workspace_id and product_id=p_id),
   'aliases',(select count(*) from public.product_aliases where workspace_id=p_workspace_id and product_id=p_id)
 ) into metadata;
 return jsonb_build_object('product_id',p_id,'can_delete',not used,'reasons',reasons,
   'references',refs,'catalog_metadata',metadata);
end $$;

create function public.delete_catalog_product(p_workspace_id uuid,p_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare old_row public.products;reason_value text;usage_value jsonb;variant_value jsonb;alias_value jsonb;
begin
 perform app_private.catalog_lock(p_workspace_id);
 perform app_private.require_role(p_workspace_id,array['owner']);
 reason_value:=app_private.catalog_reason(p_reason);
 select * into old_row from public.products where workspace_id=p_workspace_id and id=p_id for update;
 if not found then raise exception 'CATALOG_NOT_FOUND: Sản phẩm không thuộc workspace.';end if;
 usage_value:=public.get_catalog_product_usage(p_workspace_id,p_id);
 if not (usage_value->>'can_delete')::boolean then
  raise exception 'PRODUCT_HAS_HISTORY: Sản phẩm có chứng từ hoặc lịch sử kho/bán; hãy lưu trữ.' using detail=usage_value::text;
 end if;
 select to_jsonb(v) into variant_value from public.product_variants v where workspace_id=p_workspace_id and product_id=p_id;
 select coalesce(jsonb_agg(to_jsonb(a)),'[]') into alias_value from public.product_aliases a where workspace_id=p_workspace_id and product_id=p_id;
 -- Only dependent catalog metadata is removed, in FK order. No business cascade.
 delete from public.product_aliases where workspace_id=p_workspace_id and product_id=p_id;
 delete from public.product_variants where workspace_id=p_workspace_id and product_id=p_id;
 delete from public.products where workspace_id=p_workspace_id and id=p_id;
 perform app_private.audit(p_workspace_id,'product.deleted',p_id,jsonb_build_object('before',to_jsonb(old_row),
   'variant',variant_value,'aliases',alias_value,'reason',reason_value));
 return jsonb_build_object('deleted_id',p_id,'code',old_row.code);
end $$;

-- Guards sit at mutation boundaries, so historical reads, valid request replays,
-- shipment of existing allocations, returns, reversals, releases and VOID remain
-- usable. A blanket guard on inventory_lots would incorrectly prevent returns.
create function app_private.catalog_require_active(w uuid,p uuid) returns void
language plpgsql security definer set search_path='' as $$
declare row_value public.products;
begin
 select * into row_value from public.products where workspace_id=w and id=p for share;
 if not found then raise exception 'CATALOG_NOT_FOUND: Sản phẩm không thuộc workspace.';end if;
 if row_value.archived_at is not null then raise exception 'CATALOG_ARCHIVED: Sản phẩm đã lưu trữ; khôi phục trước khi tạo nghiệp vụ mới.';end if;
end $$;

create function app_private.catalog_guard_product_use() returns trigger
language plpgsql security definer set search_path='' as $$
declare pid uuid;should_check boolean:=true;
begin
 if tg_table_name='purchase_receipts' then
  pid:=new.product_id;
  if tg_op='UPDATE' then
   should_check:=new.product_id is distinct from old.product_id or (new.status='posted' and old.status is distinct from 'posted');
  end if;
 elsif tg_table_name='stock_movements' then
  pid:=new.product_id;should_check:=new.movement_kind='post';
 elsif tg_table_name='sales_allocations' then
  should_check:=new.status='reserved';
  select product_id into pid from public.sales_order_lines where workspace_id=new.workspace_id and id=new.line_id;
 else
  pid:=new.product_id;
  if tg_op='UPDATE' then should_check:=new.product_id is distinct from old.product_id;end if;
 end if;
 if should_check and pid is not null then perform app_private.catalog_require_active(new.workspace_id,pid);end if;
 return new;
end $$;
create trigger catalog_guard_purchase before insert or update of product_id,status on public.purchase_receipts for each row execute function app_private.catalog_guard_product_use();
create trigger catalog_guard_post before insert on public.stock_movements for each row execute function app_private.catalog_guard_product_use();
create trigger catalog_guard_sales_line before insert or update of product_id on public.sales_order_lines for each row execute function app_private.catalog_guard_product_use();
create trigger catalog_guard_order_reservation before insert on public.sales_allocations for each row execute function app_private.catalog_guard_product_use();
create trigger catalog_guard_reservation before insert on public.inventory_reservations for each row execute function app_private.catalog_guard_product_use();
create trigger catalog_guard_live_ticket before insert on public.live_sale_tickets for each row execute function app_private.catalog_guard_product_use();

create or replace function public.resolve_product_alias(p_workspace_id uuid,p_query text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare query_key text;candidates jsonb;candidate_count integer;status_value text;matched_product uuid;
begin
 perform app_private.require_role(p_workspace_id,array['owner','manager','staff','viewer']);
 query_key:=app_private.catalog_normalize(p_query);
 if length(query_key)>200 then raise exception 'Mã tra cứu tối đa 200 ký tự.';end if;
 if query_key='' then return jsonb_build_object('normalized',query_key,'status','not_found','product_id',null,'candidates','[]'::jsonb);end if;
 with matches as (
  select id as product_id from public.products where workspace_id=p_workspace_id and archived_at is null and app_private.catalog_normalize(code)=query_key
  union
  select a.product_id from public.product_aliases a join public.products p on p.workspace_id=a.workspace_id and p.id=a.product_id
   where a.workspace_id=p_workspace_id and a.active and a.alias_key=query_key and p.archived_at is null
 ), resolved as (
  select p.id as product_id,v.id as variant_id,p.code,p.name,p.provisional,v.style_id,v.size,v.color,v.mapping_status
  from matches m join public.products p on p.workspace_id=p_workspace_id and p.id=m.product_id
  left join public.product_variants v on v.workspace_id=p.workspace_id and v.product_id=p.id
 ) select coalesce(jsonb_agg(to_jsonb(r) order by r.code,r.product_id),'[]') into candidates from resolved r;
 candidate_count:=jsonb_array_length(candidates);
 if candidate_count=0 then status_value:='not_found';
 elsif candidate_count>1 then status_value:='ambiguous';
 elsif coalesce((candidates->0->>'provisional')::boolean,true) or candidates->0->>'mapping_status' is distinct from 'confirmed' then status_value:='needs_review';
 else status_value:='unique';matched_product:=(candidates->0->>'product_id')::uuid;end if;
 return jsonb_build_object('normalized',query_key,'status',status_value,'product_id',matched_product,'candidates',candidates);
end $$;

revoke all on function app_private.catalog_reason(text),app_private.catalog_require_active(uuid,uuid),
 app_private.catalog_guard_product_use() from public,anon,authenticated;
revoke all on function public.save_master(text,jsonb),public.save_catalog_product(uuid,jsonb),public.save_product_category(uuid,jsonb),
 public.set_product_category_archived(uuid,uuid,boolean,text),public.delete_product_category(uuid,uuid,text),
 public.set_catalog_product_archived(uuid,uuid,boolean,text),public.get_catalog_product_usage(uuid,uuid),public.delete_catalog_product(uuid,uuid,text) from public,anon;
grant execute on function public.save_master(text,jsonb),public.save_catalog_product(uuid,jsonb),public.save_product_category(uuid,jsonb),
 public.set_product_category_archived(uuid,uuid,boolean,text),public.delete_product_category(uuid,uuid,text),
 public.set_catalog_product_archived(uuid,uuid,boolean,text),public.get_catalog_product_usage(uuid,uuid),public.delete_catalog_product(uuid,uuid,text) to authenticated;

commit;
