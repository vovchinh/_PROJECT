-- Phase B: manual inventory holds compatible with V2 FIFO/order allocations.
-- Apply once after 005. Historical 001/002/003 remain immutable.
-- No inventory movement, revenue, cash or order allocation is backfilled here.
begin;

do $$begin
 if to_regclass('public.customer_addresses') is null
    or to_regclass('public.product_variants') is null
    or not exists(select 1 from pg_trigger where tgrelid='public.sales_orders'::regclass
      and tgname='sales_order_customer_snapshot' and not tgisinternal and tgenabled in ('O','A')) then
  raise exception 'INVENTORY_PREREQUISITE: Chạy migration 004 và 005 đầy đủ trước migration 006.';
 end if;
end $$;

create table public.inventory_reservations (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id),
 product_id uuid not null,warehouse_id uuid not null,
 qty integer not null check(qty between 1 and 1000000),
 status text not null default 'active' check(status in ('active','released','consumed')),
 reserved_date date not null,reference text not null default '',reason text not null,
 order_id uuid,released_date date,release_reason text,consumed_date date,
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(workspace_id,id),
 foreign key(workspace_id,product_id) references public.products(workspace_id,id),
 foreign key(workspace_id,warehouse_id) references public.warehouses(workspace_id,id),
 foreign key(workspace_id,order_id) references public.sales_orders(workspace_id,id),
 check(isfinite(reserved_date)),check(length(reference)<=120),check(length(trim(reason)) between 10 and 4000),
 check((status='active' and order_id is null and released_date is null and release_reason is null and consumed_date is null)
    or (status='released' and order_id is null and released_date is not null and released_date>=reserved_date and isfinite(released_date)
        and release_reason is not null and length(trim(release_reason)) between 10 and 4000 and consumed_date is null)
    or (status='consumed' and order_id is not null and consumed_date is not null and consumed_date>=reserved_date and isfinite(consumed_date)
        and released_date is null and release_reason is null))
);
create table public.reservation_lots (
 workspace_id uuid not null references public.workspaces(id),reservation_id uuid not null,lot_id uuid not null,
 qty integer not null check(qty between 1 and 1000000),
 primary key(workspace_id,reservation_id,lot_id),
 foreign key(workspace_id,reservation_id) references public.inventory_reservations(workspace_id,id),
 foreign key(workspace_id,lot_id) references public.inventory_lots(workspace_id,id)
);
create table app_private.inventory_reservation_requests (
 workspace_id uuid not null references public.workspaces(id),request_id uuid not null,
 action text not null check(action in ('reserve','release','transfer')),entity_id uuid not null,payload_hash text not null,
 created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),
 primary key(workspace_id,request_id)
);

create function app_private.inventory_reservation_date(d date) returns void
language plpgsql security definer set search_path='' as $$
begin
 if d is null or not isfinite(d) then raise exception 'Cần ngày giữ hàng thực tế hợp lệ.' using errcode='22007';end if;
 if d>(now() at time zone 'Asia/Ho_Chi_Minh')::date then
  raise exception 'INVENTORY_FUTURE_DATE: Ngày nghiệp vụ giữ hàng không được sau hôm nay tại Việt Nam.' using errcode='22007';
 end if;
end $$;

-- This guard also protects the unchanged V2 purchase-reversal RPC. A held lot
-- cannot be reversed or reduced by a legacy path that ignores manual holds.
create function app_private.protect_inventory_reservation_lot() returns trigger
language plpgsql security definer set search_path='' as $$
declare held bigint;
begin
 if new.remaining_qty<old.remaining_qty then
  select coalesce(sum(a.qty),0) into held from public.reservation_lots a
   join public.inventory_reservations r on r.workspace_id=a.workspace_id and r.id=a.reservation_id
   where a.workspace_id=old.workspace_id and a.lot_id=old.id and r.status='active';
  if new.remaining_qty<held then
   raise exception 'INVENTORY_HELD: Lô đang có hàng giữ; không thể giảm tồn hoặc đảo phiếu nhập gốc.';
  end if;
 end if;
 return new;
end $$;
create trigger protect_inventory_reservation_lot before update of remaining_qty on public.inventory_lots
for each row execute function app_private.protect_inventory_reservation_lot();

create function public.reserve_inventory(p_workspace_id uuid,p_payload jsonb,p_request_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare rid uuid:=gen_random_uuid();pid uuid;hid uuid;d date;q numeric;needed integer;take_qty integer;free_qty bigint;
 reference_value text;reason_value text;hash_value text:=md5(coalesce(p_payload,'null'::jsonb)::text);
 prior app_private.inventory_reservation_requests;lot public.inventory_lots;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 if p_request_id is null then raise exception 'Cần request_id để chống ghi trùng.';end if;
 select * into prior from app_private.inventory_reservation_requests where workspace_id=p_workspace_id and request_id=p_request_id;
 if found then
  if prior.action<>'reserve' or prior.payload_hash<>hash_value then raise exception 'request_id đã dùng với nội dung khác.';end if;
  perform app_private.remember(p_workspace_id,p_request_id,'inventory.reserve',prior.entity_id);
  return prior.entity_id;
 end if;
 if jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'Dữ liệu giữ hàng không hợp lệ.';end if;
 pid:=(p_payload->>'product_id')::uuid;hid:=(p_payload->>'warehouse_id')::uuid;
 d:=nullif(p_payload->>'date','')::date;q:=(p_payload->>'qty')::numeric;
 reference_value:=trim(coalesce(p_payload->>'reference',''));reason_value:=trim(coalesce(p_payload->>'reason',''));
 perform app_private.inventory_reservation_date(d);
 if q is null or q<>trunc(q) or q not between 1 and 1000000 then raise exception 'Số lượng giữ phải là số nguyên từ 1 đến 1.000.000.';end if;
 if length(reference_value)>120 or length(reason_value) not between 10 and 4000 then raise exception 'Cần lý do giữ từ 10 đến 4.000 ký tự; tham chiếu tối đa 120 ký tự.';end if;
 if not exists(select 1 from public.products where workspace_id=p_workspace_id and id=pid and not provisional) then
  raise exception 'SKU không thuộc workspace hoặc chưa được xác nhận.';
 end if;
 if not exists(select 1 from public.warehouses where workspace_id=p_workspace_id and id=hid) then raise exception 'Kho không thuộc workspace.';end if;
 perform app_private.remember(p_workspace_id,p_request_id,'inventory.reserve',rid);
 perform app_private.stock_date(p_workspace_id,pid,hid,d);
 insert into public.inventory_reservations(id,workspace_id,product_id,warehouse_id,qty,reserved_date,reference,reason,created_by)
  values(rid,p_workspace_id,pid,hid,q::integer,d,reference_value,reason_value,auth.uid());
 needed:=q::integer;
 for lot in select * from public.inventory_lots where workspace_id=p_workspace_id and product_id=pid and warehouse_id=hid
  and available_date<=d and remaining_qty>0 order by available_date,created_at,id for update loop
  select lot.remaining_qty
   -coalesce((select sum(a.qty) from public.sales_allocations a where a.workspace_id=p_workspace_id and a.lot_id=lot.id and a.status='reserved'),0)
   -coalesce((select sum(a.qty) from public.reservation_lots a join public.inventory_reservations r on r.workspace_id=a.workspace_id and r.id=a.reservation_id
     where a.workspace_id=p_workspace_id and a.lot_id=lot.id and r.status='active'),0) into free_qty;
  take_qty:=least(needed,greatest(free_qty,0))::integer;
  if take_qty>0 then
   insert into public.reservation_lots(workspace_id,reservation_id,lot_id,qty) values(p_workspace_id,rid,lot.id,take_qty);
   needed:=needed-take_qty;
  end if;
  exit when needed=0;
 end loop;
 if needed>0 then raise exception 'INVENTORY_INSUFFICIENT: Không đủ hàng khả dụng đúng ngày tại kho.';end if;
 insert into app_private.inventory_reservation_requests(workspace_id,request_id,action,entity_id,payload_hash,created_by)
  values(p_workspace_id,p_request_id,'reserve',rid,hash_value,auth.uid());
 perform app_private.audit(p_workspace_id,'inventory.reserved',rid,jsonb_build_object('product_id',pid,'warehouse_id',hid,'qty',q,'date',d,'request_id',p_request_id));
 return rid;
end $$;

create function public.release_inventory_reservation(p_workspace_id uuid,p_reservation_id uuid,p_date date,p_reason text,p_request_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare r public.inventory_reservations;prior app_private.inventory_reservation_requests;
 hash_value text:=md5(jsonb_build_object('reservation_id',p_reservation_id,'date',p_date,'reason',p_reason)::text);
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 if p_request_id is null then raise exception 'Cần request_id để chống ghi trùng.';end if;
 select * into prior from app_private.inventory_reservation_requests where workspace_id=p_workspace_id and request_id=p_request_id;
 if found then
  if prior.action<>'release' or prior.entity_id<>p_reservation_id or prior.payload_hash<>hash_value then raise exception 'request_id đã dùng với nội dung khác.';end if;
  perform app_private.remember(p_workspace_id,p_request_id,'inventory.release',p_reservation_id);return p_reservation_id;
 end if;
 perform app_private.inventory_reservation_date(p_date);
 if length(trim(coalesce(p_reason,''))) not between 10 and 4000 then raise exception 'Cần lý do giải phóng từ 10 đến 4.000 ký tự.';end if;
 select * into r from public.inventory_reservations where workspace_id=p_workspace_id and id=p_reservation_id for update;
 if not found or r.status<>'active' then raise exception 'Không tìm thấy phiếu giữ đang hoạt động trong workspace.';end if;
 if p_date<r.reserved_date then raise exception 'Ngày giải phóng không được trước ngày giữ.';end if;
 perform app_private.remember(p_workspace_id,p_request_id,'inventory.release',p_reservation_id);
 perform app_private.stock_date(p_workspace_id,r.product_id,r.warehouse_id,p_date);
 update public.inventory_reservations set status='released',released_date=p_date,release_reason=trim(p_reason),updated_at=now() where id=r.id;
 insert into app_private.inventory_reservation_requests(workspace_id,request_id,action,entity_id,payload_hash,created_by)
  values(p_workspace_id,p_request_id,'release',r.id,hash_value,auth.uid());
 perform app_private.audit(p_workspace_id,'inventory.released',r.id,jsonb_build_object('qty',r.qty,'date',p_date,'reason',trim(p_reason),'request_id',p_request_id));
 return r.id;
end $$;

create function public.transfer_inventory_reservations(p_workspace_id uuid,p_order_id uuid,p_reservation_ids uuid[],p_date date,p_request_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare o public.sales_orders;prior app_private.inventory_reservation_requests;ids uuid[];hash_value text;
 confirm_request uuid:=gen_random_uuid();selected_count integer;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 if p_request_id is null then raise exception 'Cần request_id để chống ghi trùng.';end if;
 if coalesce(cardinality(p_reservation_ids),0) not between 1 and 1000
    or array_position(p_reservation_ids,null) is not null then raise exception 'Cần từ 1 đến 1.000 phiếu giữ hợp lệ.';end if;
 select array_agg(x order by x),count(distinct x)::integer into ids,selected_count from unnest(p_reservation_ids) x;
 if selected_count<>cardinality(p_reservation_ids) then raise exception 'Danh sách phiếu giữ bị trùng.';end if;
 hash_value:=md5(jsonb_build_object('order_id',p_order_id,'reservation_ids',ids,'date',p_date)::text);
 select * into prior from app_private.inventory_reservation_requests where workspace_id=p_workspace_id and request_id=p_request_id;
 if found then
  if prior.action<>'transfer' or prior.entity_id<>p_order_id or prior.payload_hash<>hash_value then raise exception 'request_id đã dùng với nội dung khác.';end if;
  perform app_private.remember(p_workspace_id,p_request_id,'inventory.transfer',p_order_id);return p_order_id;
 end if;
 perform app_private.inventory_reservation_date(p_date);
 select * into o from public.sales_orders where workspace_id=p_workspace_id and id=p_order_id for update;
 if not found or o.status<>'draft' then raise exception 'Chỉ chuyển giữ hàng vào đơn nháp trong workspace.';end if;
 if p_date<o.order_date then raise exception 'Ngày chuyển giữ không được trước ngày đơn.';end if;
 perform 1 from public.inventory_reservations where workspace_id=p_workspace_id and id=any(ids) order by id for update;
 if (select count(*) from public.inventory_reservations where workspace_id=p_workspace_id and id=any(ids)
     and status='active' and warehouse_id=o.warehouse_id and reserved_date<=p_date)<>selected_count then
  raise exception 'Phiếu giữ không thuộc workspace/kho/ngày hoặc không còn hoạt động.';
 end if;
 if not exists(select 1 from public.sales_order_lines where workspace_id=p_workspace_id and order_id=o.id) then raise exception 'Đơn không có dòng hàng.';end if;
 if exists(
  with held as (select product_id,sum(qty) qty from public.inventory_reservations where workspace_id=p_workspace_id and id=any(ids) group by product_id),
  lines as (select product_id,qty from public.sales_order_lines where workspace_id=p_workspace_id and order_id=o.id)
  select 1 from held h full join lines l using(product_id) where h.qty is distinct from l.qty
 ) then raise exception 'Lượng giữ phải khớp toàn bộ SKU và số lượng của đơn; không chuyển một phần.';end if;
 perform app_private.remember(p_workspace_id,p_request_id,'inventory.transfer',p_order_id);
 update public.inventory_reservations set status='consumed',order_id=o.id,consumed_date=p_date,updated_at=now()
  where workspace_id=p_workspace_id and id=any(ids);
 -- Consuming the holds and confirming the old order are one transaction under
 -- the same workspace lock. Any validation failure rolls back both operations.
 perform public.transition_sales_order(p_workspace_id,o.id,'confirm',jsonb_build_object('date',p_date),confirm_request);
 insert into app_private.inventory_reservation_requests(workspace_id,request_id,action,entity_id,payload_hash,created_by)
  values(p_workspace_id,p_request_id,'transfer',o.id,hash_value,auth.uid());
 perform app_private.audit(p_workspace_id,'inventory.transferred',o.id,jsonb_build_object('reservation_ids',ids,'date',p_date,'request_id',p_request_id,'confirm_request_id',confirm_request));
 return o.id;
end $$;

create function public.get_inventory_foundation(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 perform app_private.require_role(p_workspace_id,array['owner','manager','staff','viewer']);
 if (select count(*) from public.inventory_reservations where workspace_id=p_workspace_id)>50000
    or (select count(*) from public.reservation_lots where workspace_id=p_workspace_id)>50000
    or (select count(*) from public.sales_allocations where workspace_id=p_workspace_id and status='reserved')>50000
    or (select count(*) from public.inventory_lots where workspace_id=p_workspace_id)>50000 then
  raise exception 'INVENTORY_RESULT_LIMIT: Dữ liệu kho vượt 50.000 dòng; cần phân trang trước khi mở rộng. Không trả snapshot bị cắt.';
 end if;
 select jsonb_build_object(
  'reservations',(select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at,r.id),'[]'::jsonb) from public.inventory_reservations r where r.workspace_id=p_workspace_id),
  'allocations',(select coalesce(jsonb_agg(to_jsonb(a) order by a.reservation_id,a.lot_id),'[]'::jsonb) from public.reservation_lots a where a.workspace_id=p_workspace_id),
  'order_reservations',(select coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('product_id',l.product_id,'warehouse_id',l.warehouse_id) order by a.created_at,a.id),'[]'::jsonb)
    from public.sales_allocations a join public.inventory_lots l on l.workspace_id=a.workspace_id and l.id=a.lot_id where a.workspace_id=p_workspace_id and a.status='reserved'),
  'inventory',public.get_sales_state(p_workspace_id)->'inventory'
 ) into result;
 return result;
end $$;

do $$declare t text;begin
 foreach t in array array['inventory_reservations','reservation_lots'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('create policy member_read on public.%I for select to authenticated using (app_private.member_role(workspace_id) is not null)',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
 end loop;
end $$;
revoke all on app_private.inventory_reservation_requests from public,anon,authenticated;
revoke all on function app_private.inventory_reservation_date(date),app_private.protect_inventory_reservation_lot() from public,anon,authenticated;
revoke all on function public.reserve_inventory(uuid,jsonb,uuid),public.release_inventory_reservation(uuid,uuid,date,text,uuid),
 public.transfer_inventory_reservations(uuid,uuid,uuid[],date,uuid),public.get_inventory_foundation(uuid) from public,anon;
grant execute on function public.reserve_inventory(uuid,jsonb,uuid),public.release_inventory_reservation(uuid,uuid,date,text,uuid),
 public.transfer_inventory_reservations(uuid,uuid,uuid[],date,uuid),public.get_inventory_foundation(uuid) to authenticated;
create index on public.inventory_reservations(workspace_id,status,product_id,warehouse_id);
create index on public.inventory_reservations(workspace_id,order_id);
create index on public.reservation_lots(workspace_id,lot_id);

-- The two V2 replacements below retain their public signatures, ACLs, order
-- lifecycle, integer FIFO arithmetic, return behavior and audit/idempotency.
-- Only manual active holds are added to the availability calculation.

create or replace function public.transition_sales_order(p_workspace_id uuid,p_order_id uuid,p_action text,p_payload jsonb,p_request_id uuid)
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
    select lot.remaining_qty-coalesce(sum(qty),0)::integer
     -coalesce((select sum(rl.qty) from public.reservation_lots rl join public.inventory_reservations ir
       on ir.workspace_id=rl.workspace_id and ir.id=rl.reservation_id
       where rl.workspace_id=p_workspace_id and rl.lot_id=lot.id and ir.status='active'),0)::integer
     into free_qty from public.sales_allocations
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

create or replace function public.get_sales_state(p_workspace_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 perform app_private.require_role(p_workspace_id,array['owner','manager','staff','viewer']);
 with lots as (
  select product_id,warehouse_id,sum(remaining_qty) as on_hand,sum(remaining_cost) as stock_value from public.inventory_lots where workspace_id=p_workspace_id group by product_id,warehouse_id
 ), reservations as (
  select h.product_id,h.warehouse_id,sum(h.qty) as reserved from (
   select l.product_id,l.warehouse_id,a.qty from public.sales_allocations a join public.inventory_lots l on l.id=a.lot_id
    where a.workspace_id=p_workspace_id and a.status='reserved'
   union all
   select r.product_id,r.warehouse_id,r.qty from public.inventory_reservations r
    where r.workspace_id=p_workspace_id and r.status='active'
  ) h group by h.product_id,h.warehouse_id
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

commit;
