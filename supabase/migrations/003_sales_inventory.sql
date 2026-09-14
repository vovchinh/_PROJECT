-- ChiDi V2: sales, reservations, FIFO dispatch and resellable returns.
-- Apply once AFTER 001_core.sql and 002_operations.sql. No cash/GL is created.
begin;

create table public.customers (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),
 code text not null,name text not null,phone text not null default '',email text not null default '',
 address text not null default '',notes text not null default '',created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(workspace_id,id),unique(workspace_id,code)
);
create table public.sales_orders (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),code text not null,
 customer_id uuid not null,warehouse_id uuid not null,order_date date not null,
 status text not null default 'draft' check(status in ('draft','confirmed','shipped','delivered','cancelled')),
 channel text not null default '',notes text not null default '',total_amount bigint not null default 0 check(total_amount between 0 and 9000000000000),
 confirmed_date date,shipped_date date,delivered_date date,carrier text not null default '',tracking_number text not null default '',
 created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(workspace_id,id),unique(workspace_id,code),
 foreign key(workspace_id,customer_id) references public.customers(workspace_id,id),
 foreign key(workspace_id,warehouse_id) references public.warehouses(workspace_id,id)
);
create table public.sales_order_lines (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),order_id uuid not null,product_id uuid not null,
 qty integer not null check(qty between 1 and 1000000),unit_price bigint not null check(unit_price between 1 and 9000000000000),
 discount bigint not null default 0 check(discount>=0),line_total bigint not null check(line_total between 0 and 9000000000000),
 returned_qty integer not null default 0 check(returned_qty between 0 and qty),cost_amount bigint not null default 0 check(cost_amount>=0),
 created_at timestamptz not null default now(),unique(workspace_id,id),unique(workspace_id,order_id,product_id),
 foreign key(workspace_id,order_id) references public.sales_orders(workspace_id,id),
 foreign key(workspace_id,product_id) references public.products(workspace_id,id),
 check(qty::numeric*unit_price-discount=line_total)
);
create table public.sales_events (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),order_id uuid not null,
 action text not null check(action in ('confirm','ship','deliver','cancel','return')),event_date date not null,
 amount bigint not null default 0,cost_amount bigint not null default 0,qty bigint not null default 0,
 revenue_effect bigint not null default 0,cogs_effect bigint not null default 0,transit_cost_effect bigint not null default 0,
 reason text not null default '',details jsonb not null default '{}',actor_id uuid not null references auth.users(id),
 created_at timestamptz not null default now(),unique(workspace_id,id),
 foreign key(workspace_id,order_id) references public.sales_orders(workspace_id,id)
);
create table public.inventory_lots (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),product_id uuid not null,warehouse_id uuid not null,
 available_date date not null,source_kind text not null check(source_kind in ('purchase','return')),
 source_purchase_id uuid,source_event_id uuid,source_allocation_id uuid,
 initial_qty integer not null check(initial_qty>0),remaining_qty integer not null check(remaining_qty between 0 and initial_qty),
 initial_cost bigint not null check(initial_cost>=0),remaining_cost bigint not null check(remaining_cost between 0 and initial_cost),
 created_at timestamptz not null default now(),unique(workspace_id,id),unique(workspace_id,source_purchase_id),
 unique(workspace_id,source_event_id,source_allocation_id),
 foreign key(workspace_id,product_id) references public.products(workspace_id,id),
 foreign key(workspace_id,warehouse_id) references public.warehouses(workspace_id,id),
 foreign key(workspace_id,source_purchase_id) references public.purchase_receipts(workspace_id,id),
 foreign key(workspace_id,source_event_id) references public.sales_events(workspace_id,id) deferrable initially deferred,
 check((source_kind='purchase' and source_purchase_id is not null and source_event_id is null)
    or (source_kind='return' and source_purchase_id is null and source_event_id is not null and source_allocation_id is not null))
);
create table public.sales_allocations (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),order_id uuid not null,line_id uuid not null,lot_id uuid not null,
 qty integer not null check(qty>0),status text not null check(status in ('reserved','shipped','released')),
 cost_amount bigint not null default 0 check(cost_amount>=0),returned_qty integer not null default 0 check(returned_qty between 0 and qty),
 returned_cost bigint not null default 0 check(returned_cost between 0 and cost_amount),created_at timestamptz not null default now(),
 unique(workspace_id,id),unique(workspace_id,line_id,lot_id),
 foreign key(workspace_id,order_id) references public.sales_orders(workspace_id,id),
 foreign key(workspace_id,line_id) references public.sales_order_lines(workspace_id,id),
 foreign key(workspace_id,lot_id) references public.inventory_lots(workspace_id,id)
);
alter table public.inventory_lots add foreign key(workspace_id,source_allocation_id) references public.sales_allocations(workspace_id,id);
create table app_private.inventory_timeline (
 workspace_id uuid not null,product_id uuid not null,warehouse_id uuid not null,last_event_date date not null,
 primary key(workspace_id,product_id,warehouse_id),
 foreign key(workspace_id,product_id) references public.products(workspace_id,id),
 foreign key(workspace_id,warehouse_id) references public.warehouses(workspace_id,id)
);
create table app_private.sales_requests (
 workspace_id uuid not null references public.workspaces(id),request_id uuid not null,order_id uuid not null,action text not null,payload_hash text not null,
 primary key(workspace_id,request_id),foreign key(workspace_id,order_id) references public.sales_orders(workspace_id,id)
);

-- Existing posted V1 receipts become dated FIFO lots. Prior reversals remain zero.
insert into public.inventory_lots(workspace_id,product_id,warehouse_id,available_date,source_kind,source_purchase_id,
 initial_qty,remaining_qty,initial_cost,remaining_cost,created_at)
 select m.workspace_id,m.product_id,m.warehouse_id,m.received_date,'purchase',m.purchase_id,m.qty,
 case when exists(select 1 from public.stock_movements r where r.workspace_id=m.workspace_id and r.purchase_id=m.purchase_id and r.movement_kind='reversal') then 0 else m.qty end,
 m.amount,case when exists(select 1 from public.stock_movements r where r.workspace_id=m.workspace_id and r.purchase_id=m.purchase_id and r.movement_kind='reversal') then 0 else m.amount end,m.created_at
 from public.stock_movements m where m.movement_kind='post';
insert into app_private.inventory_timeline(workspace_id,product_id,warehouse_id,last_event_date)
 select workspace_id,product_id,warehouse_id,max(received_date) from public.stock_movements group by workspace_id,product_id,warehouse_id;

create function app_private.lock_inventory(w uuid,roles text[]) returns void language plpgsql security definer set search_path='' as $$
begin
 perform app_private.require_role(w,roles);
 perform 1 from public.workspaces where id=w for update;
 perform app_private.require_role(w,roles);
end $$;
create function app_private.stock_date(w uuid,p uuid,h uuid,d date) returns void language plpgsql security definer set search_path='' as $$
declare affected integer;
begin
 if d is null or not isfinite(d) then raise exception 'Cần ngày kho thực tế hợp lệ.';end if;
 insert into app_private.inventory_timeline values(w,p,h,d)
 on conflict(workspace_id,product_id,warehouse_id) do update set last_event_date=excluded.last_event_date
 where app_private.inventory_timeline.last_event_date<=excluded.last_event_date;
 get diagnostics affected=row_count;
 if affected=0 then raise exception 'Ngày kho trước nghiệp vụ gần nhất của SKU tại kho; không ghi lùi ngày sau khi đã giữ hoặc xuất hàng.';end if;
end $$;

-- Move V1 bodies to a non-exposed schema, preserving public RPC signatures.
alter function public.post_purchase(uuid,uuid) set schema app_private;
alter function app_private.post_purchase(uuid,uuid) rename to post_purchase_v1;
alter function public.reverse_document(text,uuid,uuid,date,text) set schema app_private;
alter function app_private.reverse_document(text,uuid,uuid,date,text) rename to reverse_document_v1;
revoke all on function app_private.post_purchase_v1(uuid,uuid),app_private.reverse_document_v1(text,uuid,uuid,date,text) from public,anon,authenticated;

create function public.post_purchase(p_id uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid;r public.purchase_receipts;result jsonb;
begin
 select workspace_id into w from public.purchase_receipts where id=p_id;
 perform app_private.lock_inventory(w,array['owner','manager']);
 select * into r from public.purchase_receipts where workspace_id=w and id=p_id for update;
 result:=app_private.post_purchase_v1(p_id,p_request_id);
 if r.status='draft' then
  perform app_private.stock_date(w,r.product_id,r.warehouse_id,r.received_date);
  insert into public.inventory_lots(workspace_id,product_id,warehouse_id,available_date,source_kind,source_purchase_id,initial_qty,remaining_qty,initial_cost,remaining_cost)
   values(w,r.product_id,r.warehouse_id,r.received_date,'purchase',r.id,r.qty,r.qty,r.total_amount,r.total_amount);
 end if;
 return result;
end $$;
create function public.reverse_document(p_kind text,p_id uuid,p_request_id uuid,p_date date,p_reason text) returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid;r public.purchase_receipts;l public.inventory_lots;result jsonb;
begin
 if p_kind='purchase' then select workspace_id into w from public.purchase_receipts where id=p_id;
 elsif p_kind='cash' then select workspace_id into w from public.cash_transactions where id=p_id;
 else raise exception 'Loại chứng từ không hợp lệ.';end if;
 perform app_private.lock_inventory(w,array['owner']);
 if p_date is null or not isfinite(p_date) or length(trim(coalesce(p_reason,'')))<10 then raise exception 'Cần ngày và lý do đảo ít nhất 10 ký tự.';end if;
 if p_kind='purchase' then
  select * into r from public.purchase_receipts where workspace_id=w and id=p_id for update;
  if r.status='posted' then
   select * into l from public.inventory_lots where workspace_id=w and source_purchase_id=p_id for update;
   if not found or l.remaining_qty<>l.initial_qty or exists(select 1 from public.sales_allocations where workspace_id=w and lot_id=l.id and status='reserved') then
    raise exception 'Lô nhập đã được giữ hoặc xuất; không thể đảo phiếu nhập gốc.';
   end if;
   perform app_private.stock_date(w,r.product_id,r.warehouse_id,p_date);
   update public.inventory_lots set remaining_qty=0,remaining_cost=0 where id=l.id;
  end if;
 end if;
 result:=app_private.reverse_document_v1(p_kind,p_id,p_request_id,p_date,p_reason);return result;
end $$;

create function public.save_customer(p_workspace_id uuid,p_payload jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare rid uuid:=nullif(p_payload->>'id','')::uuid;c text:=upper(trim(p_payload->>'code'));n text:=trim(p_payload->>'name');old public.customers;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager','staff']);
 if c is null or length(c) not between 1 and 80 or n is null or length(n) not between 1 and 200 then raise exception 'Cần mã và tên khách hàng hợp lệ.';end if;
 if length(coalesce(p_payload->>'phone',''))>80 or length(coalesce(p_payload->>'email',''))>320 or length(coalesce(p_payload->>'address',''))>1000 or length(coalesce(p_payload->>'notes',''))>4000 then raise exception 'Thông tin khách hàng quá dài.';end if;
 if rid is not null then
  select * into old from public.customers where workspace_id=p_workspace_id and id=rid for update;
  if not found then raise exception 'Không tìm thấy khách hàng trong workspace.';end if;
  if old.code<>c then raise exception 'Không đổi mã khách hàng đã tạo.';end if;
 else rid:=gen_random_uuid();end if;
 insert into public.customers(id,workspace_id,code,name,phone,email,address,notes,created_by)
 values(rid,p_workspace_id,c,n,coalesce(p_payload->>'phone',''),coalesce(p_payload->>'email',''),coalesce(p_payload->>'address',''),coalesce(p_payload->>'notes',''),auth.uid())
 on conflict(id) do update set name=excluded.name,phone=excluded.phone,email=excluded.email,address=excluded.address,notes=excluded.notes,updated_at=now();
 perform app_private.audit(p_workspace_id,'customer.saved',rid,jsonb_build_object('code',c));return rid;
end $$;

create function public.save_sales_order(p_workspace_id uuid,p_payload jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare rid uuid:=nullif(p_payload->>'id','')::uuid;old public.sales_orders;r jsonb;c text:=upper(trim(p_payload->>'code'));
 d date:=nullif(p_payload->>'order_date','')::date;q numeric;price bigint;discount_value bigint;line_value numeric;total_value numeric:=0;pid uuid;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager','staff']);
 if c is null or length(c) not between 1 and 80 or d is null or not isfinite(d) then raise exception 'Cần mã đơn và ngày đơn hợp lệ.';end if;
 if jsonb_typeof(p_payload->'lines') is distinct from 'array' or jsonb_array_length(p_payload->'lines') not between 1 and 100 then raise exception 'Đơn cần từ 1 đến 100 dòng hàng.';end if;
 if length(coalesce(p_payload->>'channel',''))>100 or length(coalesce(p_payload->>'notes',''))>4000 then raise exception 'Kênh hoặc ghi chú quá dài.';end if;
 if rid is not null then
  select * into old from public.sales_orders where workspace_id=p_workspace_id and id=rid for update;
  if not found or old.status<>'draft' then raise exception 'Chỉ sửa được đơn nháp trong workspace hiện tại.';end if;
  if old.code<>c then raise exception 'Không đổi mã đơn đã tạo.';end if;
 else rid:=gen_random_uuid();end if;
 insert into public.sales_orders(id,workspace_id,code,customer_id,warehouse_id,order_date,channel,notes,created_by)
 values(rid,p_workspace_id,c,(p_payload->>'customer_id')::uuid,(p_payload->>'warehouse_id')::uuid,d,coalesce(p_payload->>'channel',''),coalesce(p_payload->>'notes',''),auth.uid())
 on conflict(id) do update set customer_id=excluded.customer_id,warehouse_id=excluded.warehouse_id,order_date=excluded.order_date,channel=excluded.channel,notes=excluded.notes,updated_at=now();
 delete from public.sales_order_lines where workspace_id=p_workspace_id and order_id=rid;
 for r in select value from jsonb_array_elements(p_payload->'lines') loop
  q:=(r->>'qty')::numeric;
  if q is null or q<>trunc(q) or q not between 1 and 1000000 then raise exception 'Số lượng bán phải là số nguyên từ 1 đến 1.000.000.';end if;
  price:=app_private.amount(r->>'unit_price',1);discount_value:=app_private.amount(coalesce(r->>'discount','0'));
  line_value:=q*price-discount_value;
  if line_value<0 then raise exception 'Giảm giá không được vượt tiền của dòng hàng.';end if;
  perform app_private.amount(line_value::text);
  total_value:=total_value+line_value;perform app_private.amount(total_value::text);
  pid:=(r->>'product_id')::uuid;
  if exists(select 1 from public.sales_order_lines where workspace_id=p_workspace_id and order_id=rid and product_id=pid) then raise exception 'Mỗi SKU chỉ xuất hiện một dòng; hãy gộp số lượng.';end if;
  insert into public.sales_order_lines(workspace_id,order_id,product_id,qty,unit_price,discount,line_total)
   values(p_workspace_id,rid,pid,q::integer,price,discount_value,line_value::bigint);
 end loop;
 perform app_private.amount(total_value::text,1);
 update public.sales_orders set total_amount=total_value::bigint where id=rid;
 perform app_private.audit(p_workspace_id,'sales_order.draft_saved',rid);return rid;
end $$;

create function public.transition_sales_order(p_workspace_id uuid,p_order_id uuid,p_action text,p_payload jsonb,p_request_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare o public.sales_orders;ln public.sales_order_lines;lot public.inventory_lots;al public.sales_allocations;v record;r jsonb;
 prior app_private.sales_requests;hash_value text:=md5(coalesce(p_payload,'{}'::jsonb)::text);d date:=nullif(p_payload->>'date','')::date;
 reason_value text:=trim(coalesce(p_payload->>'reason',''));event_id uuid:=gen_random_uuid();last_date date;
 needed integer;take_qty integer;free_qty integer;return_qty numeric;cost_value bigint;amount_value bigint;
 total_cost numeric:=0;total_amount numeric:=0;total_qty bigint:=0;revenue_value bigint:=0;cogs_value bigint:=0;transit_value bigint:=0;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 if p_action is null or p_action not in ('confirm','ship','deliver','cancel','return') then raise exception 'Thao tác đơn hàng không hợp lệ.';end if;
 select * into o from public.sales_orders where workspace_id=p_workspace_id and id=p_order_id for update;
 if not found then raise exception 'Không tìm thấy đơn hàng trong workspace.';end if;
 perform app_private.remember(p_workspace_id,p_request_id,'sales.'||p_action,p_order_id);
 select * into prior from app_private.sales_requests where workspace_id=p_workspace_id and request_id=p_request_id;
 if found then
  if prior.order_id<>p_order_id or prior.action<>p_action or prior.payload_hash<>hash_value then raise exception 'request_id đã dùng với nội dung khác.';end if;
  return p_order_id;
 end if;
 select greatest(o.order_date,max(event_date)) into last_date from public.sales_events where workspace_id=p_workspace_id and order_id=p_order_id;
 if d is null or not isfinite(d) or d<last_date then raise exception 'Ngày thao tác phải hợp lệ, không trước ngày đơn hoặc thao tác gần nhất.';end if;
 if length(reason_value)>4000 then raise exception 'Lý do quá dài.';end if;

 if p_action='confirm' then
  if o.status<>'draft' then raise exception 'Chỉ xác nhận đơn nháp.';end if;
  for ln in select * from public.sales_order_lines where workspace_id=p_workspace_id and order_id=p_order_id order by product_id loop
   if not exists(select 1 from public.products where workspace_id=p_workspace_id and id=ln.product_id and not provisional) then raise exception 'SKU chưa được xác nhận.';end if;
   perform app_private.stock_date(p_workspace_id,ln.product_id,o.warehouse_id,d);needed:=ln.qty;
   for lot in select * from public.inventory_lots where workspace_id=p_workspace_id and product_id=ln.product_id and warehouse_id=o.warehouse_id
    and available_date<=d and remaining_qty>0 order by available_date,created_at,id for update loop
    select lot.remaining_qty-coalesce(sum(qty),0)::integer into free_qty from public.sales_allocations
     where workspace_id=p_workspace_id and lot_id=lot.id and status='reserved';
    take_qty:=least(needed,free_qty);
    if take_qty>0 then
     insert into public.sales_allocations(workspace_id,order_id,line_id,lot_id,qty,status) values(p_workspace_id,o.id,ln.id,lot.id,take_qty,'reserved');
     needed:=needed-take_qty;
    end if;
    exit when needed=0;
   end loop;
   if needed>0 then raise exception 'Không đủ hàng khả dụng đúng ngày tại kho cho SKU %.',(select code from public.products where id=ln.product_id);end if;
   total_qty:=total_qty+ln.qty;
  end loop;
  update public.sales_orders set status='confirmed',confirmed_date=d,updated_at=now() where id=o.id;

 elsif p_action='ship' then
  if o.status<>'confirmed' then raise exception 'Chỉ xuất giao đơn đã xác nhận.';end if;
  if length(trim(coalesce(p_payload->>'carrier',''))) not between 1 and 150 or length(trim(coalesce(p_payload->>'tracking_number',''))) not between 1 and 150 then raise exception 'Cần đơn vị vận chuyển và mã vận đơn.';end if;
  for ln in select * from public.sales_order_lines where workspace_id=p_workspace_id and order_id=p_order_id order by product_id loop
   perform app_private.stock_date(p_workspace_id,ln.product_id,o.warehouse_id,d);
   if (select coalesce(sum(qty),0) from public.sales_allocations where workspace_id=p_workspace_id and line_id=ln.id and status='reserved')<>ln.qty then raise exception 'Phân bổ giữ hàng không khớp dòng đơn.';end if;
   for al in select a.* from public.sales_allocations a join public.inventory_lots l on l.id=a.lot_id
    where a.workspace_id=p_workspace_id and a.line_id=ln.id and a.status='reserved' order by l.available_date,l.created_at,l.id loop
    select * into lot from public.inventory_lots where workspace_id=p_workspace_id and id=al.lot_id for update;
    if lot.available_date>d or lot.remaining_qty<al.qty then raise exception 'Lô hàng không đủ hoặc chưa đến ngày nhập.';end if;
    cost_value:=(floor(lot.initial_cost::numeric*(lot.initial_qty-lot.remaining_qty+al.qty)/lot.initial_qty)
      -floor(lot.initial_cost::numeric*(lot.initial_qty-lot.remaining_qty)/lot.initial_qty))::bigint;
    update public.inventory_lots set remaining_qty=remaining_qty-al.qty,remaining_cost=remaining_cost-cost_value where id=lot.id;
    update public.sales_allocations set status='shipped',cost_amount=cost_value where id=al.id;
    total_cost:=total_cost+cost_value;total_qty:=total_qty+al.qty;
   end loop;
   update public.sales_order_lines set cost_amount=(select coalesce(sum(cost_amount),0) from public.sales_allocations where workspace_id=p_workspace_id and line_id=ln.id and status='shipped') where id=ln.id;
  end loop;
  perform app_private.amount(total_cost::text);transit_value:=total_cost::bigint;total_amount:=o.total_amount;
  update public.sales_orders set status='shipped',shipped_date=d,carrier=trim(p_payload->>'carrier'),tracking_number=trim(p_payload->>'tracking_number'),updated_at=now() where id=o.id;

 elsif p_action='deliver' then
  if o.status<>'shipped' then raise exception 'Chỉ giao thành công đơn đã xuất giao.';end if;
  select coalesce(sum(cost_amount),0),coalesce(sum(qty),0) into total_cost,total_qty from public.sales_order_lines where workspace_id=p_workspace_id and order_id=p_order_id;
  total_amount:=o.total_amount;revenue_value:=o.total_amount;cogs_value:=total_cost::bigint;transit_value:=-total_cost::bigint;
  update public.sales_orders set status='delivered',delivered_date=d,updated_at=now() where id=o.id;

 elsif p_action='cancel' then
  if o.status not in ('draft','confirmed') then raise exception 'Chỉ hủy đơn nháp hoặc đã giữ hàng; hàng đã xuất cần nghiệp vụ trả hàng.';end if;
  if o.status='confirmed' then
   if length(reason_value)<10 then raise exception 'Cần lý do hủy ít nhất 10 ký tự.';end if;
   for ln in select * from public.sales_order_lines where workspace_id=p_workspace_id and order_id=p_order_id order by product_id loop
    perform app_private.stock_date(p_workspace_id,ln.product_id,o.warehouse_id,d);total_qty:=total_qty+ln.qty;
   end loop;
   update public.sales_allocations set status='released' where workspace_id=p_workspace_id and order_id=p_order_id and status='reserved';
  end if;
  update public.sales_orders set status='cancelled',updated_at=now() where id=o.id;

 else
  if o.status not in ('shipped','delivered') then raise exception 'Chỉ nhận trả hàng từ đơn đã xuất hoặc đã giao.';end if;
  if length(reason_value)<10 then raise exception 'Cần lý do trả hàng ít nhất 10 ký tự.';end if;
  if p_payload->>'disposition' is not null and p_payload->>'disposition'<>'resellable' then raise exception 'V2 chỉ nhận hàng trả đã kiểm tra còn bán được; hàng hỏng cần quy trình riêng.';end if;
  if jsonb_typeof(p_payload->'lines') is distinct from 'array' or jsonb_array_length(p_payload->'lines') not between 1 and 100 then raise exception 'Cần chọn dòng và số lượng trả.';end if;
  if (select count(*) from jsonb_array_elements(p_payload->'lines'))<>(select count(distinct value->>'line_id') from jsonb_array_elements(p_payload->'lines')) then raise exception 'Dòng trả bị trùng hoặc thiếu mã dòng.';end if;
  for r in select value from jsonb_array_elements(p_payload->'lines') order by value->>'line_id' loop
   select * into ln from public.sales_order_lines where workspace_id=p_workspace_id and order_id=p_order_id and id=(r->>'line_id')::uuid for update;
   if not found then raise exception 'Dòng trả không thuộc đơn hiện tại.';end if;
   return_qty:=(r->>'qty')::numeric;
   if return_qty is null or return_qty<>trunc(return_qty) or return_qty not between 1 and ln.qty-ln.returned_qty then raise exception 'Số lượng trả vượt số còn được trả.';end if;
   if o.status='shipped' and return_qty<>ln.qty-ln.returned_qty then raise exception 'Giao thất bại phải nhận lại toàn bộ hàng còn trên vận đơn.';end if;
   perform app_private.stock_date(p_workspace_id,ln.product_id,o.warehouse_id,d);
   amount_value:=(floor(ln.line_total::numeric*(ln.returned_qty+return_qty)/ln.qty)-floor(ln.line_total::numeric*ln.returned_qty/ln.qty))::bigint;
   total_amount:=total_amount+amount_value;total_qty:=total_qty+return_qty::bigint;needed:=return_qty::integer;
   for al in select a.* from public.sales_allocations a join public.inventory_lots l on l.id=a.lot_id
    where a.workspace_id=p_workspace_id and a.line_id=ln.id and a.status='shipped' and a.returned_qty<a.qty order by l.available_date,l.created_at,l.id loop
    take_qty:=least(needed,al.qty-al.returned_qty);
    cost_value:=(floor(al.cost_amount::numeric*(al.returned_qty+take_qty)/al.qty)-floor(al.cost_amount::numeric*al.returned_qty/al.qty))::bigint;
    update public.sales_allocations set returned_qty=returned_qty+take_qty,returned_cost=returned_cost+cost_value where id=al.id;
    insert into public.inventory_lots(workspace_id,product_id,warehouse_id,available_date,source_kind,source_event_id,source_allocation_id,initial_qty,remaining_qty,initial_cost,remaining_cost)
     values(p_workspace_id,ln.product_id,o.warehouse_id,d,'return',event_id,al.id,take_qty,take_qty,cost_value,cost_value);
    total_cost:=total_cost+cost_value;needed:=needed-take_qty;exit when needed=0;
   end loop;
   if needed<>0 then raise exception 'Phân bổ giá vốn gốc không đủ để nhận trả.';end if;
   update public.sales_order_lines set returned_qty=returned_qty+return_qty::integer where id=ln.id;
  end loop;
  if o.status='shipped' then
   if exists(select 1 from public.sales_order_lines where workspace_id=p_workspace_id and order_id=p_order_id and returned_qty<qty) then raise exception 'Giao thất bại phải nhận lại toàn bộ dòng hàng trên vận đơn.';end if;
   transit_value:=-total_cost::bigint;
   update public.sales_orders set status='cancelled',updated_at=now() where id=o.id;
  else
   revenue_value:=-total_amount::bigint;cogs_value:=-total_cost::bigint;
   update public.sales_orders set updated_at=now() where id=o.id;
  end if;
 end if;
 insert into public.sales_events(id,workspace_id,order_id,action,event_date,amount,cost_amount,qty,revenue_effect,cogs_effect,transit_cost_effect,reason,details,actor_id)
 values(event_id,p_workspace_id,o.id,p_action,d,total_amount::bigint,total_cost::bigint,total_qty,revenue_value,cogs_value,transit_value,reason_value,
  jsonb_build_object('previous_status',o.status,'lines',p_payload->'lines','carrier',p_payload->>'carrier','tracking_number',p_payload->>'tracking_number'),auth.uid());
 insert into app_private.sales_requests values(p_workspace_id,p_request_id,o.id,p_action,hash_value);
 perform app_private.audit(p_workspace_id,'sales_order.'||p_action,o.id,jsonb_build_object('event_id',event_id,'date',d,'qty',total_qty));
 return o.id;
end $$;

create function public.get_sales_state(p_workspace_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 perform app_private.require_role(p_workspace_id,array['owner','manager','staff','viewer']);
 with lots as (
  select product_id,warehouse_id,sum(remaining_qty) as on_hand,sum(remaining_cost) as stock_value from public.inventory_lots where workspace_id=p_workspace_id group by product_id,warehouse_id
 ), reservations as (
  select l.product_id,l.warehouse_id,sum(a.qty) as reserved from public.sales_allocations a join public.inventory_lots l on l.id=a.lot_id
   where a.workspace_id=p_workspace_id and a.status='reserved' group by l.product_id,l.warehouse_id
 ), transit as (
  select l.product_id,l.warehouse_id,sum(a.qty-a.returned_qty) as in_transit from public.sales_allocations a join public.inventory_lots l on l.id=a.lot_id
   join public.sales_orders o on o.id=a.order_id where a.workspace_id=p_workspace_id and a.status='shipped' and o.status='shipped' group by l.product_id,l.warehouse_id
 ), keys as (
  select product_id,warehouse_id from lots union select product_id,warehouse_id from reservations union select product_id,warehouse_id from transit
 ), inventory as (
  select k.product_id,k.warehouse_id,coalesce(l.on_hand,0) as on_hand,coalesce(r.reserved,0) as reserved,
   coalesce(l.on_hand,0)-coalesce(r.reserved,0) as available,coalesce(t.in_transit,0) as in_transit,coalesce(l.stock_value,0)::text as stock_value
  from keys k left join lots l using(product_id,warehouse_id) left join reservations r using(product_id,warehouse_id) left join transit t using(product_id,warehouse_id)
 ), totals as (
  select coalesce(sum(amount) filter(where action='deliver'),0) as delivered_amount,
   -coalesce(sum(revenue_effect) filter(where action='return'),0) as returned_amount,
   coalesce(sum(revenue_effect),0) as net_sales,coalesce(sum(cogs_effect),0) as cost_of_goods,
   coalesce(sum(transit_cost_effect),0) as in_transit_cost from public.sales_events where workspace_id=p_workspace_id
 )
 select jsonb_build_object(
  'customers',(select coalesce(jsonb_agg(to_jsonb(c) order by c.code),'[]'::jsonb) from public.customers c where c.workspace_id=p_workspace_id),
  'sales_orders',(select coalesce(jsonb_agg(to_jsonb(o)||jsonb_build_object('total_amount',o.total_amount::text) order by o.order_date desc,o.created_at desc,o.id),'[]'::jsonb) from public.sales_orders o where o.workspace_id=p_workspace_id),
  'sales_order_lines',(select coalesce(jsonb_agg(to_jsonb(l)||jsonb_build_object('unit_price',l.unit_price::text,'discount',l.discount::text,'line_total',l.line_total::text,'cost_amount',l.cost_amount::text) order by l.created_at,l.id),'[]'::jsonb) from public.sales_order_lines l where l.workspace_id=p_workspace_id),
  'sales_events',(select coalesce(jsonb_agg(to_jsonb(e)||jsonb_build_object('amount',e.amount::text,'cost_amount',e.cost_amount::text,'revenue_effect',e.revenue_effect::text,'cogs_effect',e.cogs_effect::text,'transit_cost_effect',e.transit_cost_effect::text) order by e.event_date,e.created_at,e.id),'[]'::jsonb) from public.sales_events e where e.workspace_id=p_workspace_id),
  'inventory',(select coalesce(jsonb_agg(to_jsonb(i) order by i.product_id,i.warehouse_id),'[]'::jsonb) from inventory i),
  'summary',jsonb_build_object('delivered_amount',t.delivered_amount::text,'returned_amount',t.returned_amount::text,'net_sales',t.net_sales::text,
   'cost_of_goods',t.cost_of_goods::text,'gross_profit',(t.net_sales-t.cost_of_goods)::text,'in_transit_cost',t.in_transit_cost::text)
 ) into result from totals t;
 return result;
end $$;

do $$declare t text;begin
 foreach t in array array['customers','sales_orders','sales_order_lines','sales_events','inventory_lots','sales_allocations'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('create policy member_read on public.%I for select to authenticated using (app_private.member_role(workspace_id) is not null)',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
 end loop;
end $$;
revoke all on function app_private.lock_inventory(uuid,text[]),app_private.stock_date(uuid,uuid,uuid,date) from public,anon,authenticated;
revoke all on app_private.inventory_timeline,app_private.sales_requests from public,anon,authenticated;
revoke all on function public.post_purchase(uuid,uuid),public.reverse_document(text,uuid,uuid,date,text),
 public.save_customer(uuid,jsonb),public.save_sales_order(uuid,jsonb),public.transition_sales_order(uuid,uuid,text,jsonb,uuid),public.get_sales_state(uuid) from public,anon;
grant execute on function public.post_purchase(uuid,uuid),public.reverse_document(text,uuid,uuid,date,text),
 public.save_customer(uuid,jsonb),public.save_sales_order(uuid,jsonb),public.transition_sales_order(uuid,uuid,text,jsonb,uuid),public.get_sales_state(uuid) to authenticated;
create index on public.inventory_lots(workspace_id,product_id,warehouse_id,available_date,created_at,id);
create index on public.sales_allocations(workspace_id,lot_id,status);
create index on public.sales_allocations(workspace_id,order_id,line_id);
create index on public.sales_orders(workspace_id,status,order_date);
create index on public.sales_events(workspace_id,order_id,event_date);
create index on public.sales_order_lines(workspace_id,order_id);
commit;
