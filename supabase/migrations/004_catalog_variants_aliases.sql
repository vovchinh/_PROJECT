-- ChiDi Phase B1: catalog compatibility, explicit variant review, exact aliases.
-- Apply ONCE after a successful 003. Never replay 001/002/003 to install this file.
-- Existing product UUIDs and financial/stock ledgers are not changed.
begin;

-- Fail before creating objects if the actual V2 dependency is incomplete.
do $$
declare object_name text;
begin
  foreach object_name in array array[
    'public.products', 'public.customers', 'public.sales_orders',
    'public.sales_order_lines', 'public.sales_events', 'public.inventory_lots',
    'public.sales_allocations', 'app_private.inventory_timeline',
    'app_private.sales_requests'
  ] loop
    if to_regclass(object_name) is null then
      raise exception '004 requires completed V2 migration 003; missing %. Stop and reconcile the existing database, do not replay earlier migrations.', object_name;
    end if;
  end loop;
  foreach object_name in array array[
    'public.get_sales_state(uuid)', 'public.save_customer(uuid,jsonb)',
    'public.save_sales_order(uuid,jsonb)',
    'public.transition_sales_order(uuid,uuid,text,jsonb,uuid)',
    'app_private.post_purchase_v1(uuid,uuid)',
    'app_private.reverse_document_v1(text,uuid,uuid,date,text)'
  ] loop
    if to_regprocedure(object_name) is null then
      raise exception '004 requires completed V2 migration 003; missing function %.', object_name;
    end if;
  end loop;
  if to_regclass('public.product_styles') is not null
    or to_regclass('public.product_variants') is not null
    or to_regclass('public.product_aliases') is not null then
    raise exception '004 catalog objects already exist. This migration runs once; inspect migration history instead of replaying it.';
  end if;
end $$;

-- Prevent a new SKU appearing between compatibility backfill and trigger install.
lock table public.products in share row exclusive mode;

create function app_private.catalog_clean_text(p_value text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select pg_catalog.btrim(pg_catalog.regexp_replace(
    pg_catalog.normalize(coalesce(p_value, ''), 'NFC'),
    U&'[\0009-\000D\0020\0085\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+',
    ' ', 'g'))
$$;

create function app_private.catalog_normalize(p_value text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select pg_catalog.lower(app_private.catalog_clean_text(p_value))
$$;

create table public.product_styles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  code text not null check (length(code) between 1 and 80),
  name text not null check (length(name) between 1 and 200),
  notes text not null default '' check (length(notes) <= 4000),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, code)
);
create unique index product_styles_normalized_code_key
  on public.product_styles(workspace_id, app_private.catalog_normalize(code));

create table public.product_variants (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id),
  product_id uuid not null,
  style_id uuid,
  size text check (size is null or length(size) between 1 and 100),
  color text check (color is null or length(color) between 1 and 100),
  mapping_status text not null default 'needs_review'
    check (mapping_status in ('needs_review', 'confirmed')),
  review_note text not null default '' check (length(review_note) <= 4000),
  origin text not null check (origin in ('legacy_backfill', 'sku_created')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, product_id),
  check (id = product_id),
  foreign key (workspace_id, product_id) references public.products(workspace_id, id),
  foreign key (workspace_id, style_id) references public.product_styles(workspace_id, id),
  check (
    (mapping_status = 'needs_review' and reviewed_by is null and reviewed_at is null)
    or (mapping_status = 'confirmed' and style_id is not null
      and reviewed_by is not null and reviewed_at is not null
      and length(btrim(review_note)) >= 10)
  )
);
-- Unknown attributes remain NULL. Even NULL/NULL can identify only one confirmed
-- SKU in a style; staff must resolve missing dimensions before confirming a twin.
create unique index product_variants_confirmed_combination_key
  on public.product_variants(workspace_id, style_id,
    app_private.catalog_normalize(size), app_private.catalog_normalize(color))
  where mapping_status = 'confirmed';
create index product_variants_style_lookup
  on public.product_variants(workspace_id, style_id, mapping_status);

create table public.product_aliases (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  product_id uuid not null,
  alias_text text not null check (length(alias_text) between 1 and 200),
  alias_key text generated always as (app_private.catalog_normalize(alias_text)) stored,
  active boolean not null default true,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, alias_key, product_id),
  check (length(alias_key) between 1 and 200),
  foreign key (workspace_id, product_id) references public.products(workspace_id, id),
  foreign key (workspace_id, product_id)
    references public.product_variants(workspace_id, product_id)
);
create index product_aliases_active_lookup
  on public.product_aliases(workspace_id, alias_key) where active;
create index product_aliases_product_lookup
  on public.product_aliases(workspace_id, product_id);
create index products_catalog_normalized_code_lookup
  on public.products(workspace_id, app_private.catalog_normalize(code));

-- RLS and grants are installed BEFORE backfill; all foreign keys are immediate.
do $$
declare table_name text;
begin
  foreach table_name in array array['product_styles', 'product_variants', 'product_aliases'] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format(
      'create policy member_read on public.%I for select to authenticated using (app_private.member_role(workspace_id) is not null)',
      table_name);
    execute format('revoke all on public.%I from public, anon, authenticated', table_name);
    execute format('grant select on public.%I to authenticated', table_name);
  end loop;
end $$;

insert into public.product_variants(id, workspace_id, product_id, mapping_status, origin)
select id, workspace_id, id, 'needs_review', 'legacy_backfill' from public.products;

create function app_private.catalog_variant_after_product_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.product_variants(id, workspace_id, product_id, mapping_status, origin, created_by)
  values (new.id, new.workspace_id, new.id, 'needs_review', 'sku_created', auth.uid());
  if auth.uid() is not null then
    perform app_private.audit(new.workspace_id, 'product_variant.compatibility_created', new.id,
      jsonb_build_object('product_id', new.id, 'origin', 'sku_created'));
  end if;
  return new;
end $$;
create trigger catalog_variant_after_product_insert
after insert on public.products for each row
execute function app_private.catalog_variant_after_product_insert();

create function app_private.catalog_lock(p_workspace_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_role(p_workspace_id, array['owner', 'manager']);
  perform 1 from public.workspaces where id = p_workspace_id for update;
  perform app_private.require_role(p_workspace_id, array['owner', 'manager']);
end $$;

create function public.save_product_style(p_workspace_id uuid, p_payload jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  style_uuid uuid;
  code_value text;
  name_value text;
  notes_value text;
  old_row public.product_styles;
begin
  perform app_private.catalog_lock(p_workspace_id);
  if jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception 'Cần thông tin mẫu sản phẩm hợp lệ.';
  end if;
  style_uuid := nullif(p_payload->>'id', '')::uuid;
  code_value := upper(app_private.catalog_clean_text(p_payload->>'code'));
  name_value := app_private.catalog_clean_text(p_payload->>'name');
  notes_value := coalesce(p_payload->>'notes', '');
  if length(code_value) not between 1 and 80 or length(name_value) not between 1 and 200
    or length(notes_value) > 4000 then
    raise exception 'Mã mẫu cần 1–80 ký tự, tên 1–200 và ghi chú tối đa 4.000 ký tự.';
  end if;
  if style_uuid is not null then
    select * into old_row from public.product_styles
      where workspace_id = p_workspace_id and id = style_uuid for update;
    if not found then raise exception 'Không tìm thấy mẫu sản phẩm trong workspace.'; end if;
    if old_row.code <> code_value then raise exception 'Không đổi mã mẫu sản phẩm đã tạo.'; end if;
  else
    style_uuid := gen_random_uuid();
  end if;
  if exists(select 1 from public.product_styles
    where workspace_id = p_workspace_id and id <> style_uuid
      and app_private.catalog_normalize(code) = app_private.catalog_normalize(code_value)) then
    raise exception 'Mã mẫu sản phẩm đã tồn tại trong workspace.';
  end if;
  insert into public.product_styles(id, workspace_id, code, name, notes, created_by)
  values (style_uuid, p_workspace_id, code_value, name_value, notes_value, auth.uid())
  on conflict(id) do update set name = excluded.name, notes = excluded.notes, updated_at = now();
  perform app_private.audit(p_workspace_id, 'product_style.saved', style_uuid,
    jsonb_build_object('before', to_jsonb(old_row), 'code', code_value, 'name', name_value, 'notes', notes_value));
  return style_uuid;
end $$;

create function public.save_product_variant(p_workspace_id uuid, p_payload jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  product_uuid uuid;
  style_uuid uuid;
  size_value text;
  color_value text;
  status_value text;
  note_value text;
  old_row public.product_variants;
  sku public.products;
begin
  perform app_private.catalog_lock(p_workspace_id);
  if jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'Cần thông tin biến thể hợp lệ.'; end if;
  product_uuid := (p_payload->>'product_id')::uuid;
  style_uuid := nullif(p_payload->>'style_id', '')::uuid;
  size_value := nullif(app_private.catalog_clean_text(p_payload->>'size'), '');
  color_value := nullif(app_private.catalog_clean_text(p_payload->>'color'), '');
  status_value := p_payload->>'mapping_status';
  note_value := app_private.catalog_clean_text(p_payload->>'review_note');
  if status_value is null or status_value not in ('needs_review', 'confirmed')
    or length(size_value) > 100 or length(color_value) > 100 or length(note_value) > 4000 then
    raise exception 'Trạng thái rà soát, kích cỡ, màu hoặc ghi chú không hợp lệ.';
  end if;
  select * into sku from public.products
    where workspace_id = p_workspace_id and id = product_uuid for share;
  if not found then raise exception 'SKU không thuộc workspace hiện tại.'; end if;
  select * into old_row from public.product_variants
    where workspace_id = p_workspace_id and product_id = product_uuid for update;
  if not found then raise exception 'SKU chưa có bản đồ biến thể; cần đối chiếu migration, không tự tạo SKU thay thế.'; end if;
  if style_uuid is not null and not exists(select 1 from public.product_styles
    where workspace_id = p_workspace_id and id = style_uuid) then
    raise exception 'Mẫu sản phẩm không thuộc workspace hiện tại.';
  end if;
  if status_value = 'confirmed' then
    if style_uuid is null or sku.provisional or length(note_value) < 10 then
      raise exception 'Xác nhận biến thể cần mẫu sản phẩm, SKU đã xác nhận và ghi chú đối chiếu ít nhất 10 ký tự.';
    end if;
    if exists(select 1 from public.product_variants
      where workspace_id = p_workspace_id and style_id = style_uuid
        and mapping_status = 'confirmed' and product_id <> product_uuid
        and app_private.catalog_normalize(size) = app_private.catalog_normalize(size_value)
        and app_private.catalog_normalize(color) = app_private.catalog_normalize(color_value)) then
      raise exception 'Mẫu, kích cỡ và màu này đã có SKU được xác nhận; cần đối chiếu trước khi gộp.';
    end if;
  end if;
  update public.product_variants set style_id = style_uuid, size = size_value, color = color_value,
    mapping_status = status_value, review_note = note_value,
    reviewed_by = case when status_value = 'confirmed' then auth.uid() else null end,
    reviewed_at = case when status_value = 'confirmed' then now() else null end,
    updated_at = now()
  where workspace_id = p_workspace_id and product_id = product_uuid;
  perform app_private.audit(p_workspace_id, 'product_variant.reviewed', old_row.id,
    jsonb_build_object('before', to_jsonb(old_row), 'product_id', product_uuid,
      'style_id', style_uuid, 'size', size_value, 'color', color_value,
      'mapping_status', status_value, 'review_note', note_value));
  return old_row.id;
end $$;

create function public.save_product_alias(p_workspace_id uuid, p_payload jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  alias_uuid uuid;
  product_uuid uuid;
  alias_value text;
  key_value text;
  active_value boolean;
  old_row public.product_aliases;
begin
  perform app_private.catalog_lock(p_workspace_id);
  if jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'Cần thông tin alias hợp lệ.'; end if;
  alias_uuid := nullif(p_payload->>'id', '')::uuid;
  product_uuid := (p_payload->>'product_id')::uuid;
  alias_value := app_private.catalog_clean_text(p_payload->>'alias_text');
  key_value := app_private.catalog_normalize(alias_value);
  if length(alias_value) not between 1 and 200 then raise exception 'Alias cần 1–200 ký tự.'; end if;
  if p_payload ? 'active' and jsonb_typeof(p_payload->'active') is distinct from 'boolean' then
    raise exception 'Trạng thái alias phải là true hoặc false.';
  end if;
  active_value := coalesce((p_payload->>'active')::boolean, true);
  if not exists(select 1 from public.product_variants
    where workspace_id = p_workspace_id and product_id = product_uuid) then
    raise exception 'SKU không có biến thể trong workspace hiện tại.';
  end if;
  if alias_uuid is not null then
    select * into old_row from public.product_aliases
      where workspace_id = p_workspace_id and id = alias_uuid for update;
    if not found then raise exception 'Không tìm thấy alias trong workspace.'; end if;
    if old_row.product_id <> product_uuid then
      raise exception 'Không chuyển alias đã tạo sang SKU khác; tắt alias cũ rồi tạo ánh xạ mới.';
    end if;
  else
    alias_uuid := gen_random_uuid();
  end if;
  if exists(select 1 from public.product_aliases
    where workspace_id = p_workspace_id and product_id = product_uuid
      and alias_key = key_value and id <> alias_uuid) then
    raise exception 'Alias chuẩn hóa đã tồn tại cho SKU này, kể cả bản đang tắt; hãy sửa bản hiện có.';
  end if;
  insert into public.product_aliases(id, workspace_id, product_id, alias_text, active, created_by)
  values (alias_uuid, p_workspace_id, product_uuid, alias_value, active_value, auth.uid())
  on conflict(id) do update set alias_text = excluded.alias_text, active = excluded.active, updated_at = now();
  perform app_private.audit(p_workspace_id, 'product_alias.saved', alias_uuid,
    jsonb_build_object('before', to_jsonb(old_row), 'product_id', product_uuid,
      'alias_text', alias_value, 'alias_key', key_value, 'active', active_value));
  return alias_uuid;
end $$;

create function public.get_catalog_state(p_workspace_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  product_count bigint;
  variant_count bigint;
  style_count bigint;
  alias_count bigint;
  unmapped_count bigint;
  review_count bigint;
  result jsonb;
begin
  perform app_private.require_role(p_workspace_id, array['owner', 'manager', 'staff', 'viewer']);
  select count(*) into product_count from public.products where workspace_id = p_workspace_id;
  select count(*) into variant_count from public.product_variants where workspace_id = p_workspace_id;
  select count(*) into style_count from public.product_styles where workspace_id = p_workspace_id;
  select count(*) into alias_count from public.product_aliases where workspace_id = p_workspace_id;
  if greatest(product_count, variant_count, style_count, alias_count) > 50000 then
    raise exception 'Danh mục vượt 50.000 bản ghi mỗi bảng; cần API phân trang trước khi tải, không trả dữ liệu bị cắt.';
  end if;
  select count(*) filter(where v.id is null),
    count(*) filter(where v.id is not null and (v.mapping_status = 'needs_review' or p.provisional))
  into unmapped_count, review_count
  from public.products p left join public.product_variants v
    on v.workspace_id = p.workspace_id and v.product_id = p.id
  where p.workspace_id = p_workspace_id;
  select jsonb_build_object(
    'styles', (select coalesce(jsonb_agg(to_jsonb(s) order by s.code, s.id), '[]'::jsonb)
      from public.product_styles s where s.workspace_id = p_workspace_id),
    'variants', (select coalesce(jsonb_agg(to_jsonb(v) order by v.product_id), '[]'::jsonb)
      from public.product_variants v where v.workspace_id = p_workspace_id),
    'aliases', (select coalesce(jsonb_agg(to_jsonb(a) order by a.alias_key, a.product_id, a.id), '[]'::jsonb)
      from public.product_aliases a where a.workspace_id = p_workspace_id),
    'reconciliation', jsonb_build_object('product_count', product_count,
      'variant_count', variant_count, 'unmapped_count', unmapped_count, 'review_count', review_count)
  ) into result;
  return result;
end $$;

create function public.resolve_product_alias(p_workspace_id uuid, p_query text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  query_key text;
  candidates jsonb;
  candidate_count integer;
  status_value text;
  matched_product uuid;
begin
  perform app_private.require_role(p_workspace_id, array['owner', 'manager', 'staff', 'viewer']);
  query_key := app_private.catalog_normalize(p_query);
  if length(query_key) > 200 then raise exception 'Mã tra cứu tối đa 200 ký tự.'; end if;
  if query_key = '' then
    return jsonb_build_object('normalized', query_key, 'status', 'not_found',
      'product_id', null, 'candidates', '[]'::jsonb);
  end if;
  with matches as (
    select id as product_id from public.products
      where workspace_id = p_workspace_id and app_private.catalog_normalize(code) = query_key
    union
    select product_id from public.product_aliases
      where workspace_id = p_workspace_id and active and alias_key = query_key
  ), resolved as (
    select p.id as product_id, v.id as variant_id, p.code, p.name, p.provisional,
      v.style_id, v.size, v.color, v.mapping_status
    from matches m join public.products p
      on p.workspace_id = p_workspace_id and p.id = m.product_id
    left join public.product_variants v
      on v.workspace_id = p.workspace_id and v.product_id = p.id
  )
  select coalesce(jsonb_agg(to_jsonb(r) order by r.code, r.product_id), '[]'::jsonb)
  into candidates from resolved r;
  candidate_count := jsonb_array_length(candidates);
  if candidate_count = 0 then status_value := 'not_found';
  elsif candidate_count > 1 then status_value := 'ambiguous';
  elsif coalesce((candidates->0->>'provisional')::boolean, true)
    or candidates->0->>'mapping_status' is distinct from 'confirmed' then status_value := 'needs_review';
  else
    status_value := 'unique';
    matched_product := (candidates->0->>'product_id')::uuid;
  end if;
  return jsonb_build_object('normalized', query_key, 'status', status_value,
    'product_id', matched_product, 'candidates', candidates);
end $$;

revoke all on function app_private.catalog_clean_text(text),
  app_private.catalog_normalize(text), app_private.catalog_variant_after_product_insert(),
  app_private.catalog_lock(uuid) from public, anon, authenticated;
revoke all on function public.save_product_style(uuid, jsonb),
  public.save_product_variant(uuid, jsonb), public.save_product_alias(uuid, jsonb),
  public.get_catalog_state(uuid), public.resolve_product_alias(uuid, text) from public, anon;
grant execute on function public.save_product_style(uuid, jsonb),
  public.save_product_variant(uuid, jsonb), public.save_product_alias(uuid, jsonb),
  public.get_catalog_state(uuid), public.resolve_product_alias(uuid, text) to authenticated;

-- No fabricated user/audit actor for legacy rows. Reconciliation is migration evidence.
do $$
declare sku_count bigint; variant_count bigint; missing_count bigint; invalid_count bigint;
begin
  select count(*) into sku_count from public.products;
  select count(*) into variant_count from public.product_variants;
  select count(*) into missing_count from public.products p
    left join public.product_variants v on v.workspace_id = p.workspace_id and v.product_id = p.id
    where v.id is null;
  select count(*) into invalid_count from public.product_variants
    where id <> product_id or origin <> 'legacy_backfill' or mapping_status <> 'needs_review'
      or style_id is not null or size is not null or color is not null
      or reviewed_by is not null or reviewed_at is not null or created_by is not null;
  if sku_count <> variant_count or missing_count <> 0 or invalid_count <> 0 then
    raise exception '004 compatibility reconciliation failed: products %, variants %, missing %, invalid %.',
      sku_count, variant_count, missing_count, invalid_count;
  end if;
end $$;

commit;
