-- Phase B: explicit customer identities, reusable addresses, immutable order
-- contact snapshots and PAYMENT PLANS ONLY. Apply once after 001..004.
-- No automatic identity linking, customer merge, payment posting, COD or ledger writes.
begin;

create table public.customer_identities (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id),
 customer_id uuid not null,
 channel text not null check(channel in ('TIKTOK_LIVE_USER','TIKTOK_SHOP_BUYER','ZALO_UID','PHONE','EMAIL')),
 external_id text not null check(length(external_id) between 1 and 320),
 normalized_external_id text not null check(length(normalized_external_id) between 1 and 320),
 verified boolean not null default false,
 verification_note text not null default '' check(length(verification_note)<=4000),
 verified_by uuid references auth.users(id), verified_at timestamptz,
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(workspace_id,id), unique(workspace_id,channel,normalized_external_id),
 foreign key(workspace_id,customer_id) references public.customers(workspace_id,id),
 check((verified and length(btrim(verification_note))>=10 and verified_by is not null and verified_at is not null)
    or (not verified and verified_by is null and verified_at is null))
);

create table public.customer_addresses (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id), customer_id uuid not null,
 recipient_name text not null check(length(recipient_name) between 1 and 200),
 phone text not null check(length(phone) between 1 and 80),
 address_line text not null check(length(address_line) between 1 and 1000),
 city text not null default '' check(length(city)<=200),
 region text not null default '' check(length(region)<=200),
 postal_code text not null default '' check(length(postal_code)<=40),
 country text not null default 'VN' check(country ~ '^[A-Z]{2}$'),
 is_default boolean not null default false,
 verified boolean not null default false,
 verification_note text not null default '' check(length(verification_note)<=4000),
 verified_by uuid references auth.users(id), verified_at timestamptz,
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(workspace_id,id), unique(workspace_id,customer_id,id),
 foreign key(workspace_id,customer_id) references public.customers(workspace_id,id),
 check((verified and length(btrim(verification_note))>=10 and verified_by is not null and verified_at is not null)
    or (not verified and verified_by is null and verified_at is null))
);
create unique index customer_addresses_one_default on public.customer_addresses(workspace_id,customer_id) where is_default;

alter table public.sales_orders
 add column shipping_address_id uuid,
 add column customer_snapshot jsonb,
 add column snapshot_source text not null default 'pending'
  check(snapshot_source in ('pending','address_selected','legacy_contact_unverified','legacy_unavailable')),
 add constraint sales_order_address_same_customer foreign key(workspace_id,customer_id,shipping_address_id)
  references public.customer_addresses(workspace_id,customer_id,id),
 add constraint sales_order_snapshot_shape check(customer_snapshot is null or jsonb_typeof(customer_snapshot)='object');

-- Do not manufacture historical customer/address facts from today's master data.
update public.sales_orders set snapshot_source='legacy_unavailable' where status<>'draft';

create table public.payment_intents (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id), order_id uuid not null,
 kind text not null check(kind in ('deposit','balance','refund')),
 amount bigint not null check(amount between 1 and 9000000000000),
 method text not null check(method in ('cash','bank','cod','other')),
 status text not null default 'planned' check(status in ('planned','void')),
 notes text not null default '' check(length(notes)<=4000),
 void_reason text not null default '' check(length(void_reason)<=4000),
 voided_by uuid references auth.users(id), voided_at timestamptz,
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(workspace_id,id),
 foreign key(workspace_id,order_id) references public.sales_orders(workspace_id,id),
 check((status='planned' and voided_by is null and voided_at is null and void_reason='')
    or (status='void' and voided_by is not null and voided_at is not null and length(btrim(void_reason))>=10))
);
comment on table public.payment_intents is 'Plans only. Neither planned nor void means money received/refunded; no cash/GL/COD effect.';

create function app_private.foundation_text(j jsonb,k text,max_length integer,required boolean default false)
returns text language plpgsql immutable set search_path='' as $$
declare v text;
begin
 if jsonb_typeof(j) is distinct from 'object' then raise exception 'Nội dung phải là đối tượng dữ liệu.';end if;
 if j ? k and jsonb_typeof(j->k) not in ('string','null') then raise exception 'Trường % phải là chuỗi ký tự.',k;end if;
 -- Trim Unicode edge whitespace only. Preserve internal characters and case
 -- of external identifiers; aliases and customer identities have different rules.
 v:=regexp_replace(coalesce(j->>k,''),
  U&'^[\0009-\000D\0020\0085\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+|[\0009-\000D\0020\0085\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+$', '', 'g');
 if length(v)>max_length or (required and v='') then raise exception 'Trường % thiếu hoặc vượt độ dài cho phép.',k;end if;
 return v;
end $$;
create function app_private.foundation_boolean(j jsonb,k text,default_value boolean default false)
returns boolean language plpgsql immutable set search_path='' as $$
begin
 if jsonb_typeof(j) is distinct from 'object' then raise exception 'Nội dung phải là đối tượng dữ liệu.';end if;
 if not (j ? k) then return default_value;end if;
 if jsonb_typeof(j->k) is distinct from 'boolean' then raise exception 'Trường % phải là true hoặc false.',k;end if;
 return (j->>k)::boolean;
end $$;

create function public.save_customer_identity(p_workspace_id uuid,p_payload jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare rid uuid;cid uuid;ch text;raw_id text;norm_id text;v boolean;note text;old public.customer_identities;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 rid:=nullif(app_private.foundation_text(p_payload,'id',36),'')::uuid;
 cid:=app_private.foundation_text(p_payload,'customer_id',36,true)::uuid;
 ch:=app_private.foundation_text(p_payload,'channel',40,true);
 raw_id:=app_private.foundation_text(p_payload,'external_id',320,true);
 v:=app_private.foundation_boolean(p_payload,'verified');
 note:=app_private.foundation_text(p_payload,'verification_note',4000);
 if ch not in ('TIKTOK_LIVE_USER','TIKTOK_SHOP_BUYER','ZALO_UID','PHONE','EMAIL') then raise exception 'Loại định danh không được hỗ trợ.';end if;
 if not exists(select 1 from public.customers where workspace_id=p_workspace_id and id=cid) then raise exception 'Khách hàng không thuộc workspace.';end if;
 -- Do not infer a country code, remove characters or match names/avatars.
 if ch='PHONE' and raw_id !~ '^\+[1-9][0-9]{6,14}$' then raise exception 'Số định danh PHONE phải nhập rõ dạng + và 7–15 chữ số, không suy đoán mã quốc gia.';end if;
 if ch='EMAIL' and raw_id !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Email định danh không hợp lệ.';end if;
 norm_id:=case when ch='EMAIL' then lower(raw_id) else raw_id end;
 if v and length(note)<10 then raise exception 'Xác minh thủ công cần căn cứ ít nhất 10 ký tự.';end if;
 if rid is not null then
  select * into old from public.customer_identities where workspace_id=p_workspace_id and id=rid for update;
  if not found then raise exception 'Không tìm thấy định danh trong workspace.';end if;
  if old.customer_id<>cid or old.channel<>ch then raise exception 'Không đổi khách hàng hoặc kênh của định danh đã lưu; cần quy trình đối chiếu riêng.';end if;
 else rid:=gen_random_uuid();end if;
 if exists(select 1 from public.customer_identities where workspace_id=p_workspace_id and channel=ch and normalized_external_id=norm_id and id<>rid) then
  raise exception 'Định danh đã được gắn trong workspace; không tự gộp khách hàng.';
 end if;
 insert into public.customer_identities(id,workspace_id,customer_id,channel,external_id,normalized_external_id,verified,verification_note,verified_by,verified_at,created_by)
 values(rid,p_workspace_id,cid,ch,raw_id,norm_id,v,note,case when v then auth.uid() end,case when v then clock_timestamp() end,auth.uid())
 on conflict(id) do update set external_id=excluded.external_id,normalized_external_id=excluded.normalized_external_id,
  verified=excluded.verified,verification_note=excluded.verification_note,verified_by=excluded.verified_by,verified_at=excluded.verified_at,updated_at=clock_timestamp();
 perform app_private.audit(p_workspace_id,'customer_identity.saved',rid,jsonb_build_object('customer_id',cid,'channel',ch,
  'external_id',raw_id,'previous_external_id',old.external_id,'verified',v,'previous_verified',old.verified,'verification_note',note));
 return rid;
end $$;

create function public.save_customer_address(p_workspace_id uuid,p_payload jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare rid uuid;cid uuid;n text;ph text;line_value text;city_value text;region_value text;postal text;country_value text;
 v boolean;is_def boolean;note text;old public.customer_addresses;previous_default uuid;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 rid:=nullif(app_private.foundation_text(p_payload,'id',36),'')::uuid;
 cid:=app_private.foundation_text(p_payload,'customer_id',36,true)::uuid;
 n:=app_private.foundation_text(p_payload,'recipient_name',200,true);
 ph:=app_private.foundation_text(p_payload,'phone',80,true);
 line_value:=app_private.foundation_text(p_payload,'address_line',1000,true);
 city_value:=app_private.foundation_text(p_payload,'city',200);
 region_value:=app_private.foundation_text(p_payload,'region',200);
 postal:=app_private.foundation_text(p_payload,'postal_code',40);
 country_value:=upper(case when p_payload ? 'country' then app_private.foundation_text(p_payload,'country',2,true) else 'VN' end);
 if country_value !~ '^[A-Z]{2}$' then raise exception 'Mã quốc gia phải có hai chữ cái.';end if;
 v:=app_private.foundation_boolean(p_payload,'verified');is_def:=app_private.foundation_boolean(p_payload,'is_default');
 note:=app_private.foundation_text(p_payload,'verification_note',4000);
 if v and length(note)<10 then raise exception 'Xác minh địa chỉ cần căn cứ ít nhất 10 ký tự.';end if;
 if not exists(select 1 from public.customers where workspace_id=p_workspace_id and id=cid) then raise exception 'Khách hàng không thuộc workspace.';end if;
 if rid is not null then
  select * into old from public.customer_addresses where workspace_id=p_workspace_id and id=rid for update;
  if not found then raise exception 'Không tìm thấy địa chỉ trong workspace.';end if;
  if old.customer_id<>cid then raise exception 'Không chuyển địa chỉ đã lưu sang khách hàng khác.';end if;
 else rid:=gen_random_uuid();end if;
 if is_def then
  select id into previous_default from public.customer_addresses where workspace_id=p_workspace_id and customer_id=cid and is_default and id<>rid;
  update public.customer_addresses set is_default=false,updated_at=clock_timestamp() where workspace_id=p_workspace_id and customer_id=cid and is_default and id<>rid;
 end if;
 insert into public.customer_addresses(id,workspace_id,customer_id,recipient_name,phone,address_line,city,region,postal_code,country,is_default,verified,verification_note,verified_by,verified_at,created_by)
 values(rid,p_workspace_id,cid,n,ph,line_value,city_value,region_value,postal,country_value,is_def,v,note,
  case when v then auth.uid() end,case when v then clock_timestamp() end,auth.uid())
 on conflict(id) do update set recipient_name=excluded.recipient_name,phone=excluded.phone,address_line=excluded.address_line,
  city=excluded.city,region=excluded.region,postal_code=excluded.postal_code,country=excluded.country,is_default=excluded.is_default,
  verified=excluded.verified,verification_note=excluded.verification_note,verified_by=excluded.verified_by,verified_at=excluded.verified_at,updated_at=clock_timestamp();
 perform app_private.audit(p_workspace_id,'customer_address.saved',rid,jsonb_build_object('customer_id',cid,'verified',v,'is_default',is_def,'previous_default_id',previous_default));
 return rid;
end $$;

create function app_private.capture_order_customer_snapshot()
returns trigger language plpgsql security definer set search_path='' as $$
declare c public.customers;a public.customer_addresses;address_snapshot jsonb;
begin
 if tg_op='INSERT' then
  if new.customer_snapshot is not null or new.snapshot_source<>'pending' or new.status<>'draft' then raise exception 'Đơn mới phải bắt đầu từ nháp, chưa có bản chụp xác nhận.';end if;
 else
  if old.status<>'draft' then
   if new.customer_snapshot is distinct from old.customer_snapshot or new.snapshot_source is distinct from old.snapshot_source
    or new.shipping_address_id is distinct from old.shipping_address_id or new.customer_id is distinct from old.customer_id
    or new.workspace_id is distinct from old.workspace_id then raise exception 'Thông tin khách/địa chỉ đã xác nhận được giữ nguyên theo lịch sử đơn.';end if;
   return new;
  end if;
  if new.customer_snapshot is distinct from old.customer_snapshot or new.snapshot_source is distinct from old.snapshot_source then
   raise exception 'Không tự sửa bản chụp khách hàng; hệ thống tạo khi xác nhận đơn.';
  end if;
  -- The existing draft RPC can change customer without knowing this new field.
  -- Clear its old address instead of accidentally keeping another customer's address.
  if new.customer_id is distinct from old.customer_id and new.shipping_address_id is not distinct from old.shipping_address_id then new.shipping_address_id:=null;end if;
 end if;
 if new.shipping_address_id is not null then
  select * into a from public.customer_addresses where workspace_id=new.workspace_id and customer_id=new.customer_id and id=new.shipping_address_id;
  if not found then raise exception 'Địa chỉ không thuộc khách hàng và workspace của đơn.';end if;
 end if;
 if tg_op='UPDATE' and old.status='draft' and new.status='confirmed' then
  select * into c from public.customers where workspace_id=new.workspace_id and id=new.customer_id;
  if not found then raise exception 'Không tìm thấy khách hàng của đơn.';end if;
  if new.shipping_address_id is not null then
   new.snapshot_source:='address_selected';
   address_snapshot:=jsonb_build_object('id',a.id,'recipient_name',a.recipient_name,'phone',a.phone,'address_line',a.address_line,
    'city',a.city,'region',a.region,'postal_code',a.postal_code,'country',a.country,'verified',a.verified,
    'verification_note',a.verification_note,'verified_by',a.verified_by,'verified_at',a.verified_at);
  else
   new.snapshot_source:='legacy_contact_unverified';
   address_snapshot:=jsonb_build_object('id',null,'recipient_name',c.name,'phone',c.phone,'address_line',c.address,
    'city',null,'region',null,'postal_code',null,'country',null,'verified',false);
  end if;
  new.customer_snapshot:=jsonb_build_object('source',new.snapshot_source,'captured_at',clock_timestamp(),'captured_by',auth.uid(),
   'customer',jsonb_build_object('id',c.id,'code',c.code,'name',c.name,'phone',c.phone,'email',c.email),'shipping_address',address_snapshot);
  perform app_private.audit(new.workspace_id,'sales_order.customer_snapshot_captured',new.id,jsonb_build_object('source',new.snapshot_source,'shipping_address_id',new.shipping_address_id));
 end if;
 return new;
end $$;
create trigger sales_order_customer_snapshot before insert or update on public.sales_orders
 for each row execute function app_private.capture_order_customer_snapshot();

create function public.set_order_address(p_workspace_id uuid,p_order_id uuid,p_address_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare o public.sales_orders;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager','staff']);
 select * into o from public.sales_orders where workspace_id=p_workspace_id and id=p_order_id for update;
 if not found or o.status<>'draft' then raise exception 'Chỉ chọn địa chỉ cho đơn nháp trong workspace.';end if;
 if p_address_id is not null and not exists(select 1 from public.customer_addresses where workspace_id=p_workspace_id and customer_id=o.customer_id and id=p_address_id) then
  raise exception 'Địa chỉ không thuộc khách hàng của đơn trong workspace.';
 end if;
 if o.shipping_address_id is not distinct from p_address_id then return o.id;end if;
 update public.sales_orders set shipping_address_id=p_address_id,updated_at=clock_timestamp() where id=o.id;
 perform app_private.audit(p_workspace_id,'sales_order.address_selected',o.id,jsonb_build_object('address_id',p_address_id,'previous_address_id',o.shipping_address_id));
 return o.id;
end $$;

create function public.save_order_payment_intent(p_workspace_id uuid,p_payload jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare rid uuid;oid uuid;k text;m text;note text;v bigint;old public.payment_intents;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 rid:=nullif(app_private.foundation_text(p_payload,'id',36),'')::uuid;
 oid:=app_private.foundation_text(p_payload,'order_id',36,true)::uuid;
 k:=app_private.foundation_text(p_payload,'kind',20,true);m:=app_private.foundation_text(p_payload,'method',20,true);
 note:=app_private.foundation_text(p_payload,'notes',4000);
 if k not in ('deposit','balance','refund') or m not in ('cash','bank','cod','other') then raise exception 'Loại hoặc phương thức kế hoạch thanh toán không hợp lệ.';end if;
 if jsonb_typeof(p_payload->'amount') not in ('number','string') or coalesce(p_payload->>'amount','') !~ '^[0-9]+$' then raise exception 'Số tiền kế hoạch phải là số nguyên VND dương.';end if;
 v:=app_private.amount(p_payload->>'amount',1);
 if p_payload ? 'status' and p_payload->>'status' is distinct from 'planned' then raise exception 'Đây chỉ là kế hoạch; không ghi đã thu, đã trả hoặc đối soát COD.';end if;
 if not exists(select 1 from public.sales_orders where workspace_id=p_workspace_id and id=oid and status<>'cancelled') then raise exception 'Đơn không thuộc workspace hoặc đã hủy.';end if;
 if rid is not null then
  select * into old from public.payment_intents where workspace_id=p_workspace_id and id=rid for update;
  if not found or old.status<>'planned' then raise exception 'Chỉ sửa kế hoạch đang chờ trong workspace.';end if;
  if old.order_id<>oid or old.kind<>k then raise exception 'Không đổi đơn hoặc loại của kế hoạch đã tạo.';end if;
 else rid:=gen_random_uuid();end if;
 insert into public.payment_intents(id,workspace_id,order_id,kind,amount,method,notes,created_by)
 values(rid,p_workspace_id,oid,k,v,m,note,auth.uid())
 on conflict(id) do update set amount=excluded.amount,method=excluded.method,notes=excluded.notes,updated_at=clock_timestamp();
 perform app_private.audit(p_workspace_id,'payment_intent.planned',rid,jsonb_build_object('order_id',oid,'kind',k,'amount',v::text,'method',m,'cash_effect',false));
 return rid;
end $$;

create function public.void_order_payment_intent(p_workspace_id uuid,p_id uuid,p_reason text)
returns uuid language plpgsql security definer set search_path='' as $$
declare old public.payment_intents;reason_value text;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 reason_value:=app_private.foundation_text(jsonb_build_object('reason',p_reason),'reason',4000,true);
 select * into old from public.payment_intents where workspace_id=p_workspace_id and id=p_id for update;
 if not found then raise exception 'Không tìm thấy kế hoạch trong workspace.';end if;
 if length(reason_value) not between 10 and 4000 then raise exception 'Hủy kế hoạch cần lý do từ 10 đến 4000 ký tự.';end if;
 if old.status='void' then return p_id;end if;
 update public.payment_intents set status='void',void_reason=reason_value,voided_by=auth.uid(),voided_at=clock_timestamp(),updated_at=clock_timestamp() where id=p_id;
 perform app_private.audit(p_workspace_id,'payment_intent.voided',p_id,jsonb_build_object('order_id',old.order_id,'reason',reason_value,'cash_effect',false));
 return p_id;
end $$;

create function public.get_customer_foundation(p_workspace_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 perform app_private.require_role(p_workspace_id,array['owner','manager','staff','viewer']);
 if exists(select 1 from public.customer_identities where workspace_id=p_workspace_id offset 50000)
  or exists(select 1 from public.customer_addresses where workspace_id=p_workspace_id offset 50000)
  or exists(select 1 from public.payment_intents where workspace_id=p_workspace_id offset 50000)
  or exists(select 1 from public.sales_orders where workspace_id=p_workspace_id offset 50000) then
  raise exception 'Phân hệ vượt 50.000 dòng mỗi nhóm; cần đọc phân trang, không trả báo cáo thiếu dòng.';
 end if;
 select jsonb_build_object(
  'identities',(select coalesce(jsonb_agg(to_jsonb(i) order by i.created_at,i.id),'[]'::jsonb) from public.customer_identities i where i.workspace_id=p_workspace_id),
  'addresses',(select coalesce(jsonb_agg(to_jsonb(a) order by a.customer_id,a.is_default desc,a.created_at,a.id),'[]'::jsonb) from public.customer_addresses a where a.workspace_id=p_workspace_id),
  'payment_intents',(select coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object('amount',p.amount::text) order by p.created_at,p.id),'[]'::jsonb) from public.payment_intents p where p.workspace_id=p_workspace_id),
  'orders',(select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'code',o.code,'customer_id',o.customer_id,'status',o.status,'total_amount',o.total_amount::text,
   'shipping_address_id',o.shipping_address_id,'customer_snapshot',o.customer_snapshot,'snapshot_source',o.snapshot_source) order by o.order_date desc,o.created_at desc,o.id),'[]'::jsonb)
   from public.sales_orders o where o.workspace_id=p_workspace_id)
 ) into result;
 return result;
end $$;

do $$declare t text;begin
 foreach t in array array['customer_identities','customer_addresses','payment_intents'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('create policy member_read on public.%I for select to authenticated using (app_private.member_role(workspace_id) is not null)',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
 end loop;
end $$;
create index customer_identities_customer on public.customer_identities(workspace_id,customer_id);
create index customer_addresses_customer on public.customer_addresses(workspace_id,customer_id);
create index payment_intents_order on public.payment_intents(workspace_id,order_id,status);
create index sales_orders_shipping_address on public.sales_orders(workspace_id,customer_id,shipping_address_id) where shipping_address_id is not null;

revoke all on function app_private.foundation_text(jsonb,text,integer,boolean),app_private.foundation_boolean(jsonb,text,boolean),app_private.capture_order_customer_snapshot() from public,anon,authenticated;
revoke all on function public.save_customer_identity(uuid,jsonb),public.save_customer_address(uuid,jsonb),public.set_order_address(uuid,uuid,uuid),
 public.save_order_payment_intent(uuid,jsonb),public.void_order_payment_intent(uuid,uuid,text),public.get_customer_foundation(uuid) from public,anon;
grant execute on function public.save_customer_identity(uuid,jsonb),public.save_customer_address(uuid,jsonb),public.set_order_address(uuid,uuid,uuid),
 public.save_order_payment_intent(uuid,jsonb),public.void_order_payment_intent(uuid,uuid,text),public.get_customer_foundation(uuid) to authenticated;
commit;
