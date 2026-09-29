-- Phase C: atomic seller commit, ticket-derived carts, shared stock holds,
-- durable business print jobs and explicit print attempts. Apply once after 007.
-- No final order, delivery, revenue, cash or external provider call is created.
begin;

create table public.live_campaign_customers (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),campaign_id uuid not null,
 provider text not null,author_external_id text not null,display_name_snapshot text not null default '',customer_id uuid,
 customer_no integer not null check(customer_no>0),created_at timestamptz not null default now(),
 unique(workspace_id,id),unique(workspace_id,campaign_id,id),unique(workspace_id,campaign_id,customer_no),
 unique(workspace_id,campaign_id,provider,author_external_id),
 foreign key(workspace_id,campaign_id) references public.live_campaigns(workspace_id,id),
 foreign key(workspace_id,customer_id) references public.customers(workspace_id,id)
);
create table public.customer_carts (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),campaign_id uuid not null,campaign_customer_id uuid not null,
 status text not null default 'open' check(status='open'),created_at timestamptz not null default now(),
 unique(workspace_id,id),unique(workspace_id,campaign_customer_id),unique(workspace_id,campaign_id,campaign_customer_id,id),
 foreign key(workspace_id,campaign_id,campaign_customer_id) references public.live_campaign_customers(workspace_id,campaign_id,id)
);
create table public.live_sale_tickets (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),campaign_id uuid not null,session_id uuid not null,comment_id uuid not null,
 cart_id uuid not null,campaign_customer_id uuid not null,customer_id uuid,product_id uuid not null,variant_id uuid not null,
 qty integer not null check(qty between 1 and 1000000),unit_price bigint not null check(unit_price between 1 and 9000000000000),
 line_total bigint not null check(line_total between 1 and 9000000000000),business_date date not null check(isfinite(business_date)),
 product_snapshot jsonb not null,customer_snapshot jsonb not null,review_note text not null check(length(btrim(review_note)) between 10 and 4000),
 ticket_seq bigint generated always as identity,ticket_no text generated always as ('LS-'||ticket_seq::text) stored,
 status text not null default 'committed' check(status in ('committed','voided')),reservation_id uuid not null,
 committed_by uuid not null references auth.users(id),committed_at timestamptz not null default now(),
 voided_by uuid references auth.users(id),voided_at timestamptz,void_date date,void_reason text,
 unique(workspace_id,id),unique(workspace_id,comment_id),unique(workspace_id,reservation_id),unique(workspace_id,ticket_no),
 foreign key(workspace_id,campaign_id) references public.live_campaigns(workspace_id,id),
 foreign key(workspace_id,session_id) references public.live_sessions(workspace_id,id),
 foreign key(workspace_id,comment_id) references public.live_comments(workspace_id,id),
 foreign key(workspace_id,campaign_id,campaign_customer_id,cart_id) references public.customer_carts(workspace_id,campaign_id,campaign_customer_id,id),
 foreign key(workspace_id,customer_id) references public.customers(workspace_id,id),
 foreign key(workspace_id,product_id) references public.products(workspace_id,id),
 foreign key(workspace_id,variant_id) references public.product_variants(workspace_id,id),
 foreign key(workspace_id,reservation_id) references public.inventory_reservations(workspace_id,id),
 check(variant_id=product_id),check(line_total::numeric=qty::numeric*unit_price),
 check(jsonb_typeof(product_snapshot)='object' and jsonb_typeof(customer_snapshot)='object'),
 check((status='committed' and voided_by is null and voided_at is null and void_date is null and void_reason is null)
  or(status='voided' and voided_by is not null and voided_at is not null and void_date>=business_date and isfinite(void_date) and length(btrim(void_reason)) between 10 and 4000))
);
alter table public.inventory_reservations add column live_ticket_id uuid,
 add constraint inventory_reservation_live_ticket foreign key(workspace_id,live_ticket_id) references public.live_sale_tickets(workspace_id,id),
 add constraint inventory_reservation_one_ticket unique(workspace_id,live_ticket_id);

create table public.customer_cart_items (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),cart_id uuid not null,ticket_id uuid not null,
 qty integer not null check(qty>0),unit_price bigint not null check(unit_price>0),line_total bigint not null check(line_total>0),
 status text not null default 'active' check(status in ('active','voided')),created_at timestamptz not null default now(),
 unique(workspace_id,id),unique(workspace_id,ticket_id),check(line_total::numeric=qty::numeric*unit_price),
 foreign key(workspace_id,cart_id) references public.customer_carts(workspace_id,id),
 foreign key(workspace_id,ticket_id) references public.live_sale_tickets(workspace_id,id)
);
create table public.live_print_jobs (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),ticket_id uuid not null,
 status text not null default 'queued' check(status in ('queued','printing','printed','failed','cancelled')),
 snapshot jsonb not null check(jsonb_typeof(snapshot)='object'),reprint_count integer not null default 0 check(reprint_count>=0),
 lease_token uuid,lease_actor uuid references auth.users(id),lease_expires_at timestamptz,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(workspace_id,id),unique(workspace_id,ticket_id),
 foreign key(workspace_id,ticket_id) references public.live_sale_tickets(workspace_id,id),
 check((status='printing' and lease_token is not null and lease_actor is not null and lease_expires_at is not null)
  or(status<>'printing' and lease_token is null and lease_actor is null and lease_expires_at is null))
);
create table public.live_print_attempts (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),job_id uuid not null,
 attempt_no integer not null check(attempt_no>0),status text not null default 'started' check(status in ('started','printed','failed','unknown')),
 reason text not null default '' check(length(reason)<=4000),actor_id uuid not null references auth.users(id),
 started_at timestamptz not null default now(),finished_at timestamptz,
 unique(workspace_id,id),unique(workspace_id,job_id,attempt_no),foreign key(workspace_id,job_id) references public.live_print_jobs(workspace_id,id),
 check((status='started' and finished_at is null) or(status<>'started' and finished_at is not null))
);
create table public.live_outbox_events (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),ticket_id uuid not null,
 event_type text not null check(event_type in ('committed','voided')),payload jsonb not null,
 created_at timestamptz not null default now(),unique(workspace_id,id),unique(workspace_id,ticket_id,event_type),
 foreign key(workspace_id,ticket_id) references public.live_sale_tickets(workspace_id,id)
);
comment on table public.live_outbox_events is 'Durable transaction events only; no external delivery worker is enabled in Phase C.';
create table app_private.live_requests (
 workspace_id uuid not null references public.workspaces(id),request_id uuid not null,action text not null,entity_id uuid not null,
 payload_hash text not null,result jsonb not null,actor_id uuid not null references auth.users(id),created_at timestamptz not null default now(),
 primary key(workspace_id,request_id)
);

-- A request result is replayable by its original actor only. A workspace lock
-- serializes every live command before this registry or inventory is inspected.
create function app_private.live_replay(w uuid,r uuid,a text,h text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare previous app_private.live_requests;
begin
 if r is null then raise exception 'LIVE_REQUEST_REQUIRED: Cần mã yêu cầu chống ghi trùng.';end if;
 select * into previous from app_private.live_requests where workspace_id=w and request_id=r;
 if not found then return null;end if;
 if previous.action<>a or previous.payload_hash<>h or previous.actor_id<>auth.uid() then raise exception 'LIVE_REQUEST_REUSED: Mã yêu cầu đã dùng với nội dung hoặc người thao tác khác.';end if;
 perform app_private.remember(w,r,'live.'||a,previous.entity_id);
 return previous.result;
end $$;
create function app_private.live_remember(w uuid,r uuid,a text,e uuid,h text,result_value jsonb) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform app_private.remember(w,r,'live.'||a,e);
 insert into app_private.live_requests values(w,r,a,e,h,result_value,auth.uid(),now());
end $$;

-- Private hold writer deliberately does not widen the public Phase B RPC.
-- Only the atomic seller-commit command calls it after validating the claim.
create function app_private.reserve_live_inventory(w uuid,p uuid,h uuid,q integer,d date,ref text,reason_value text) returns uuid
language plpgsql security definer set search_path='' as $$
declare rid uuid:=gen_random_uuid();lot public.inventory_lots;needed integer:=q;take_qty integer;free_qty bigint;
begin
 perform app_private.require_role(w,array['owner','manager','staff']);
 perform app_private.inventory_reservation_date(d);perform app_private.stock_date(w,p,h,d);
 insert into public.inventory_reservations(id,workspace_id,product_id,warehouse_id,qty,reserved_date,reference,reason,created_by)
 values(rid,w,p,h,q,d,ref,reason_value,auth.uid());
 for lot in select * from public.inventory_lots where workspace_id=w and product_id=p and warehouse_id=h
  and available_date<=d and remaining_qty>0 order by available_date,created_at,id for update loop
  select lot.remaining_qty
   -coalesce((select sum(a.qty) from public.sales_allocations a where a.workspace_id=w and a.lot_id=lot.id and a.status='reserved'),0)
   -coalesce((select sum(a.qty) from public.reservation_lots a join public.inventory_reservations r on r.workspace_id=a.workspace_id and r.id=a.reservation_id
    where a.workspace_id=w and a.lot_id=lot.id and r.status='active'),0) into free_qty;
  take_qty:=least(needed,greatest(free_qty,0))::integer;
  if take_qty>0 then insert into public.reservation_lots values(w,rid,lot.id,take_qty);needed:=needed-take_qty;end if;
  exit when needed=0;
 end loop;
 if needed>0 then raise exception 'LIVE_INSUFFICIENT: Không đủ hàng khả dụng để chốt.';end if;
 perform app_private.audit(w,'live.inventory_reserved',rid,jsonb_build_object('product_id',p,'qty',q,'date',d));
 return rid;
end $$;

create function app_private.protect_live_hold() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.live_ticket_id is not null and
  (new.live_ticket_id is distinct from old.live_ticket_id or new.product_id<>old.product_id or new.warehouse_id<>old.warehouse_id
   or new.qty<>old.qty or new.workspace_id<>old.workspace_id or new.order_id is distinct from old.order_id
   or new.status<>old.status) then
  if new.live_ticket_id is distinct from old.live_ticket_id or new.product_id<>old.product_id or new.warehouse_id<>old.warehouse_id
    or new.qty<>old.qty or new.workspace_id<>old.workspace_id or new.order_id is distinct from old.order_id or new.status='consumed'
    or exists(select 1 from public.live_sale_tickets where workspace_id=old.workspace_id and id=old.live_ticket_id and status='committed') then
   raise exception 'LIVE_HOLD_PROTECTED: Phiếu giữ thuộc ticket đã chốt; dùng VOID ticket, không giải phóng hoặc chuyển thủ công.';
  end if;
 end if;
 return new;
end $$;
create trigger protect_live_hold before update on public.inventory_reservations for each row execute function app_private.protect_live_hold();

create function app_private.protect_live_snapshot() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_table_name='live_sale_tickets' then
  -- Generated ticket_no is computed after BEFORE triggers; compare its stable source ticket_seq.
  if (to_jsonb(new)-array['status','voided_by','voided_at','void_date','void_reason','ticket_no']) is distinct from
     (to_jsonb(old)-array['status','voided_by','voided_at','void_date','void_reason','ticket_no']) then raise exception 'LIVE_IMMUTABLE: Không sửa dữ liệu ticket đã chốt.';end if;
  if old.status='voided' and (to_jsonb(new)-'ticket_no') is distinct from (to_jsonb(old)-'ticket_no') then raise exception 'LIVE_IMMUTABLE: Ticket VOID không được sửa hoặc chốt lại.';end if;
 else
  if new.snapshot is distinct from old.snapshot or new.ticket_id<>old.ticket_id or new.workspace_id<>old.workspace_id then raise exception 'LIVE_PRINT_IMMUTABLE: Mẫu in được giữ nguyên theo ticket gốc.';end if;
 end if;
 return new;
end $$;
create trigger protect_live_ticket_snapshot before update on public.live_sale_tickets for each row execute function app_private.protect_live_snapshot();
create trigger protect_live_print_snapshot before update on public.live_print_jobs for each row execute function app_private.protect_live_snapshot();

create function public.commit_live_sale_ticket(p_workspace_id uuid,p_payload jsonb,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare comment_value public.live_comments;claim_value public.live_comment_claims;campaign public.live_campaigns;session_value public.live_sessions;
 p public.products;v public.product_variants;c public.customers;cc public.live_campaign_customers;
 cid uuid;pid uuid;comment_id_value uuid;token_value uuid;known_customer uuid;cart uuid;hold uuid;ticket uuid:=gen_random_uuid();job uuid:=gen_random_uuid();
 d date;q numeric;price bigint;total_value numeric;note text;customer_info jsonb;product_info jsonb;print_value jsonb;result_value jsonb;
 hash_value text:=md5(coalesce(p_payload,'null'::jsonb)::text);ticket_row public.live_sale_tickets;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager','staff']);
 result_value:=app_private.live_replay(p_workspace_id,p_request_id,'commit',hash_value);
 if result_value is not null then
  return result_value||jsonb_build_object('ticket_status',(select status from public.live_sale_tickets where workspace_id=p_workspace_id and id=(result_value->>'ticket_id')::uuid));
 end if;
 comment_id_value:=app_private.foundation_text(p_payload,'comment_id',36,true)::uuid;
 token_value:=app_private.foundation_text(p_payload,'claim_token',36,true)::uuid;
 pid:=app_private.foundation_text(p_payload,'product_id',36,true)::uuid;
 cid:=nullif(app_private.foundation_text(p_payload,'customer_id',36),'')::uuid;
 note:=app_private.foundation_text(p_payload,'review_note',4000,true);
 d:=app_private.foundation_text(p_payload,'date',10,true)::date;
 if length(note)<10 then raise exception 'LIVE_REVIEW_REQUIRED: Cần ghi căn cứ kiểm tra ít nhất 10 ký tự.';end if;
 if jsonb_typeof(p_payload->'qty') not in ('number','string') or coalesce(p_payload->>'qty','')!~'^[0-9]+$' then raise exception 'LIVE_QTY: Số lượng phải là số nguyên dương.';end if;
 q:=(p_payload->>'qty')::numeric;
 if q not between 1 and 1000000 then raise exception 'LIVE_QTY: Số lượng từ 1 đến 1.000.000.';end if;
 if jsonb_typeof(p_payload->'unit_price') not in ('number','string') or coalesce(p_payload->>'unit_price','')!~'^[0-9]+$' then raise exception 'LIVE_PRICE: Giá bán phải là số nguyên VND dương.';end if;
 price:=app_private.amount(p_payload->>'unit_price',1);total_value:=q*price;perform app_private.amount(total_value::text,1);
 perform app_private.inventory_reservation_date(d);
 select * into comment_value from public.live_comments where workspace_id=p_workspace_id and id=comment_id_value for update;
 if not found or comment_value.state<>'new' then raise exception 'LIVE_COMMENT_USED: Bình luận không thuộc workspace hoặc đã được xử lý; không chốt lại kể cả sau VOID.';end if;
 select * into claim_value from public.live_comment_claims where workspace_id=p_workspace_id and comment_id=comment_value.id for update;
 if not found or claim_value.claimed_by<>auth.uid() or claim_value.claim_token<>token_value or claim_value.expires_at<=clock_timestamp() then
  raise exception 'LIVE_CLAIM_INVALID: Cần nhận xử lý bình luận bằng đúng người, token và thời hạn.';
 end if;
 select * into campaign from public.live_campaigns where workspace_id=p_workspace_id and id=comment_value.campaign_id;
 select * into session_value from public.live_sessions where workspace_id=p_workspace_id and id=comment_value.session_id and campaign_id=campaign.id;
 if campaign.status is distinct from 'active' or session_value.status is distinct from 'live' then raise exception 'LIVE_NOT_ACTIVE: Chiến dịch và phiên cần đang hoạt động.';end if;
 select * into p from public.products where workspace_id=p_workspace_id and id=pid and not provisional;
 if not found then raise exception 'LIVE_SKU: SKU chưa xác nhận hoặc không thuộc workspace.';end if;
 select * into v from public.product_variants where workspace_id=p_workspace_id and product_id=pid and mapping_status='confirmed';
 if not found then raise exception 'LIVE_VARIANT: Biến thể cần đối chiếu trước khi chốt.';end if;
 if cid is not null then
  select * into c from public.customers where workspace_id=p_workspace_id and id=cid;
  if not found then raise exception 'LIVE_CUSTOMER: Khách hàng không thuộc workspace.';end if;
 end if;
 -- Exact channel identity can prohibit a wrong explicit association. No fuzzy
 -- name matching and no implicit creation/merging of customer master records.
 if session_value.provider='tiktok_live' then
  select customer_id into known_customer from public.customer_identities where workspace_id=p_workspace_id and channel='TIKTOK_LIVE_USER'
   and normalized_external_id=comment_value.author_external_id;
  if cid is not null and known_customer is not null and cid<>known_customer then raise exception 'LIVE_IDENTITY_CONFLICT: ID TikTok đã gắn với khách khác.';end if;
 end if;
 select * into cc from public.live_campaign_customers where workspace_id=p_workspace_id and campaign_id=campaign.id
  and provider=session_value.provider and author_external_id=comment_value.author_external_id for update;
 if not found then
  insert into public.live_campaign_customers(workspace_id,campaign_id,provider,author_external_id,display_name_snapshot,customer_id,customer_no)
   values(p_workspace_id,campaign.id,session_value.provider,comment_value.author_external_id,comment_value.author_display_name,cid,
    (select coalesce(max(customer_no),0)+1 from public.live_campaign_customers where workspace_id=p_workspace_id and campaign_id=campaign.id)) returning * into cc;
 else
  if cc.customer_id is not null and cid is not null and cc.customer_id<>cid then raise exception 'LIVE_IDENTITY_CONFLICT: Khách trong chiến dịch đã được gắn người khác.';end if;
  cid:=coalesce(cid,cc.customer_id);
  if cid is not null and known_customer is not null and cid<>known_customer then raise exception 'LIVE_IDENTITY_CONFLICT: Cần đối chiếu lại định danh khách hàng.';end if;
  if cc.customer_id is null and cid is not null then
   update public.live_campaign_customers set customer_id=cid where id=cc.id;
   perform app_private.audit(p_workspace_id,'live.campaign_customer_linked',cc.id,jsonb_build_object('customer_id',cid));
  end if;
 end if;
 if cid is not null then select * into c from public.customers where workspace_id=p_workspace_id and id=cid;end if;
 insert into public.customer_carts(workspace_id,campaign_id,campaign_customer_id) values(p_workspace_id,campaign.id,cc.id)
  on conflict(workspace_id,campaign_customer_id) do nothing;
 select id into cart from public.customer_carts where workspace_id=p_workspace_id and campaign_customer_id=cc.id;
 hold:=app_private.reserve_live_inventory(p_workspace_id,pid,campaign.warehouse_id,q::integer,d,'LIVE:'||ticket::text,note);
 product_info:=jsonb_build_object('product_id',p.id,'variant_id',v.id,'sku',p.code,'name',p.name,'size',v.size,'color',v.color);
 customer_info:=jsonb_build_object('customer_id',cid,'customer_no',cc.customer_no,'provider',session_value.provider,
  'author_external_id',comment_value.author_external_id,'display_name',comment_value.author_display_name,
  'name',case when cid is not null then c.name else comment_value.author_display_name end);
 insert into public.live_sale_tickets(id,workspace_id,campaign_id,session_id,comment_id,cart_id,campaign_customer_id,customer_id,product_id,variant_id,
  qty,unit_price,line_total,business_date,product_snapshot,customer_snapshot,review_note,reservation_id,committed_by)
 values(ticket,p_workspace_id,campaign.id,session_value.id,comment_value.id,cart,cc.id,cid,p.id,v.id,q::integer,price,total_value::bigint,d,product_info,customer_info,note,hold,auth.uid()) returning * into ticket_row;
 update public.inventory_reservations set live_ticket_id=ticket where id=hold;
 insert into public.customer_cart_items(workspace_id,cart_id,ticket_id,qty,unit_price,line_total) values(p_workspace_id,cart,ticket,q::integer,price,total_value::bigint);
 print_value:=jsonb_build_object('ticket_no',ticket_row.ticket_no,'customer_no',cc.customer_no,'customer_name',customer_info->>'name',
  'campaign_name',campaign.name,'session_code',session_value.code,'committed_at',ticket_row.committed_at,
  'lines',jsonb_build_array(product_info||jsonb_build_object('qty',q::integer,'unit_price',price::text,'line_total',total_value::bigint::text)),'total_amount',total_value::bigint::text);
 insert into public.live_print_jobs(id,workspace_id,ticket_id,snapshot) values(job,p_workspace_id,ticket,print_value);
 insert into public.live_outbox_events(workspace_id,ticket_id,event_type,payload) values(p_workspace_id,ticket,'committed',jsonb_build_object('ticket_id',ticket,'cart_id',cart,'print_job_id',job));
 update public.live_comments set state='committed' where id=comment_value.id and workspace_id=p_workspace_id;
 result_value:=jsonb_build_object('ticket_id',ticket,'cart_id',cart,'reservation_id',hold,'print_job_id',job,'customer_no',cc.customer_no,'ticket_no',ticket_row.ticket_no,'ticket_status','committed');
 perform app_private.live_remember(p_workspace_id,p_request_id,'commit',ticket,hash_value,result_value);
 perform app_private.audit(p_workspace_id,'live.ticket_committed',ticket,jsonb_build_object('comment_id',comment_value.id,'reservation_id',hold,'print_job_id',job,'qty',q,'line_total',total_value::text));
 return result_value;
end $$;

create function public.void_live_sale_ticket(p_workspace_id uuid,p_ticket_id uuid,p_date date,p_reason text,p_request_id uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare t public.live_sale_tickets;j public.live_print_jobs;result_value jsonb;reason_value text;
 hash_value text:=md5(jsonb_build_object('ticket_id',p_ticket_id,'date',p_date,'reason',p_reason)::text);
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 result_value:=app_private.live_replay(p_workspace_id,p_request_id,'void',hash_value);
 if result_value is not null then return (result_value->>'id')::uuid;end if;
 reason_value:=app_private.foundation_text(jsonb_build_object('reason',p_reason),'reason',4000,true);
 if length(reason_value)<10 then raise exception 'LIVE_REASON: VOID cần lý do ít nhất 10 ký tự.';end if;
 perform app_private.inventory_reservation_date(p_date);
 select * into t from public.live_sale_tickets where workspace_id=p_workspace_id and id=p_ticket_id for update;
 if not found then raise exception 'LIVE_TICKET: Không tìm thấy ticket trong workspace.';end if;
 if p_date<t.business_date then raise exception 'LIVE_DATE: Ngày VOID không trước ngày chốt.';end if;
 if t.status='committed' then
  select * into j from public.live_print_jobs where workspace_id=p_workspace_id and ticket_id=t.id for update;
  if j.status='printing' then raise exception 'LIVE_PRINT_IN_PROGRESS: Kết thúc hoặc đối chiếu lần in trước khi VOID, kể cả lease đã hết hạn.';end if;
  update public.live_sale_tickets set status='voided',voided_by=auth.uid(),voided_at=clock_timestamp(),void_date=p_date,void_reason=reason_value where id=t.id;
  perform public.release_inventory_reservation(p_workspace_id,t.reservation_id,p_date,reason_value,gen_random_uuid());
  update public.customer_cart_items set status='voided' where workspace_id=p_workspace_id and ticket_id=t.id;
  update public.live_print_jobs set status='cancelled',lease_token=null,lease_actor=null,lease_expires_at=null,updated_at=clock_timestamp() where id=j.id;
  update public.live_comments set state='voided' where workspace_id=p_workspace_id and id=t.comment_id;
  insert into public.live_outbox_events(workspace_id,ticket_id,event_type,payload) values(p_workspace_id,t.id,'voided',jsonb_build_object('ticket_id',t.id,'cart_id',t.cart_id));
  perform app_private.audit(p_workspace_id,'live.ticket_voided',t.id,jsonb_build_object('reason',reason_value,'date',p_date));
 end if;
 perform app_private.live_remember(p_workspace_id,p_request_id,'void',p_ticket_id,hash_value,jsonb_build_object('id',p_ticket_id));
 return p_ticket_id;
end $$;

create function public.claim_live_print_job(p_workspace_id uuid,p_job_id uuid,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j public.live_print_jobs;aid uuid:=gen_random_uuid();token uuid:=gen_random_uuid();expires timestamptz:=clock_timestamp()+interval '120 seconds';result_value jsonb;
 hash_value text:=md5(jsonb_build_object('job_id',p_job_id)::text);
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager','staff']);
 result_value:=app_private.live_replay(p_workspace_id,p_request_id,'print_claim',hash_value);
 if result_value is not null then
  if not exists(select 1 from public.live_print_jobs where workspace_id=p_workspace_id and id=p_job_id and status='printing'
   and lease_actor=auth.uid() and lease_token=(result_value->>'lease_token')::uuid) then
   raise exception 'LIVE_PRINT_REQUEST_STALE: Lần in của yêu cầu này đã kết thúc hoặc được thay thế; tải lại hàng đợi.';
  end if;
  return result_value;
 end if;
 select * into j from public.live_print_jobs where workspace_id=p_workspace_id and id=p_job_id for update;
 if not found then raise exception 'LIVE_PRINT_JOB: Không tìm thấy phiếu in.';end if;
 if j.status<>'queued' then raise exception 'LIVE_PRINT_STATE: Phiếu chưa ở hàng đợi. Lần in hết hạn cần đối chiếu và xếp lại rõ ràng.';end if;
 if not exists(select 1 from public.live_sale_tickets where workspace_id=p_workspace_id and id=j.ticket_id and status='committed') then raise exception 'LIVE_PRINT_VOID: Ticket đã VOID không được in.';end if;
 insert into public.live_print_attempts(id,workspace_id,job_id,attempt_no,actor_id)
 values(aid,p_workspace_id,j.id,(select coalesce(max(attempt_no),0)+1 from public.live_print_attempts where workspace_id=p_workspace_id and job_id=j.id),auth.uid());
 update public.live_print_jobs set status='printing',lease_token=token,lease_actor=auth.uid(),lease_expires_at=expires,updated_at=clock_timestamp() where id=j.id;
 result_value:=jsonb_build_object('job_id',j.id,'attempt_id',aid,'lease_token',token,'expires_at',expires,'snapshot',j.snapshot);
 perform app_private.live_remember(p_workspace_id,p_request_id,'print_claim',j.id,hash_value,result_value);
 perform app_private.audit(p_workspace_id,'live.print_started',j.id,jsonb_build_object('attempt_id',aid));return result_value;
end $$;

create function public.finish_live_print_job(p_workspace_id uuid,p_job_id uuid,p_lease_token uuid,p_outcome text,p_detail text,p_request_id uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare j public.live_print_jobs;aid uuid;detail_value text;result_value jsonb;
 hash_value text:=md5(jsonb_build_object('job_id',p_job_id,'token',p_lease_token,'outcome',p_outcome,'detail',p_detail)::text);
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager','staff']);
 result_value:=app_private.live_replay(p_workspace_id,p_request_id,'print_finish',hash_value);if result_value is not null then return (result_value->>'id')::uuid;end if;
 if p_outcome is null or p_outcome not in ('printed','failed','unknown') then raise exception 'LIVE_PRINT_OUTCOME: Chọn đã in, lỗi hoặc chưa rõ kết quả.';end if;
 detail_value:=app_private.foundation_text(jsonb_build_object('detail',p_detail),'detail',4000,true);
 if length(detail_value)<10 then raise exception 'LIVE_PRINT_EVIDENCE: Ghi xác nhận kết quả thực tế ít nhất 10 ký tự.';end if;
 select * into j from public.live_print_jobs where workspace_id=p_workspace_id and id=p_job_id for update;
 if not found or j.status<>'printing' or j.lease_token is distinct from p_lease_token or j.lease_actor is distinct from auth.uid() then
  raise exception 'LIVE_PRINT_LEASE: Người hoặc token in không còn hiệu lực.';
 end if;
 -- A long browser dialog may outlive 120s. The current fencing token can finish
 -- until explicit requeue replaces it; stale tokens can never finish a new job.
 select id into aid from public.live_print_attempts where workspace_id=p_workspace_id and job_id=j.id and status='started' order by attempt_no desc limit 1 for update;
 if not found then raise exception 'LIVE_PRINT_ATTEMPT: Không tìm thấy lần in đang xử lý.';end if;
 update public.live_print_attempts set status=p_outcome,reason=detail_value,finished_at=clock_timestamp() where id=aid;
 update public.live_print_jobs set status=case when p_outcome='printed' then 'printed' else 'failed' end,
  lease_token=null,lease_actor=null,lease_expires_at=null,updated_at=clock_timestamp() where id=j.id;
 perform app_private.live_remember(p_workspace_id,p_request_id,'print_finish',j.id,hash_value,jsonb_build_object('id',j.id));
 perform app_private.audit(p_workspace_id,'live.print_finished',j.id,jsonb_build_object('attempt_id',aid,'outcome',p_outcome,'detail',detail_value));return j.id;
end $$;

create function public.requeue_live_print_job(p_workspace_id uuid,p_job_id uuid,p_reason text,p_request_id uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare j public.live_print_jobs;reason_value text;result_value jsonb;
 hash_value text:=md5(jsonb_build_object('job_id',p_job_id,'reason',p_reason)::text);
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager','staff']);
 result_value:=app_private.live_replay(p_workspace_id,p_request_id,'print_requeue',hash_value);if result_value is not null then return (result_value->>'id')::uuid;end if;
 reason_value:=app_private.foundation_text(jsonb_build_object('reason',p_reason),'reason',4000,true);
 if length(reason_value)<10 then raise exception 'LIVE_PRINT_REASON: Xếp lại cần lý do ít nhất 10 ký tự.';end if;
 select * into j from public.live_print_jobs where workspace_id=p_workspace_id and id=p_job_id for update;
 if not found or j.status in ('queued','cancelled') then raise exception 'LIVE_PRINT_STATE: Phiếu không cần xếp lại hoặc đã hủy.';end if;
 if j.status='printing' and j.lease_expires_at>clock_timestamp() then raise exception 'LIVE_PRINT_BUSY: Thiết bị khác còn đang in trong thời hạn.';end if;
 if not exists(select 1 from public.live_sale_tickets where workspace_id=p_workspace_id and id=j.ticket_id and status='committed') then raise exception 'LIVE_PRINT_VOID: Ticket đã VOID.';end if;
 if j.status='printing' then
  update public.live_print_attempts set status='unknown',reason=reason_value,finished_at=clock_timestamp() where workspace_id=p_workspace_id and job_id=j.id and status='started';
 end if;
 update public.live_print_jobs set status='queued',reprint_count=reprint_count+1,lease_token=null,lease_actor=null,lease_expires_at=null,updated_at=clock_timestamp() where id=j.id;
 perform app_private.live_remember(p_workspace_id,p_request_id,'print_requeue',j.id,hash_value,jsonb_build_object('id',j.id));
 perform app_private.audit(p_workspace_id,'live.print_requeued',j.id,jsonb_build_object('reason',reason_value,'previous_status',j.status));return j.id;
end $$;

create function public.get_live_commerce(p_workspace_id uuid,p_campaign_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result_value jsonb;table_value text;count_value bigint;
begin
 perform app_private.require_role(p_workspace_id,array['owner','manager','staff','viewer']);
 if not exists(select 1 from public.live_campaigns where workspace_id=p_workspace_id and id=p_campaign_id) then raise exception 'LIVE_CAMPAIGN: Không tìm thấy chiến dịch trong workspace.';end if;
 foreach table_value in array array['live_campaign_customers','customer_carts','live_sale_tickets'] loop
  execute format('select count(*) from public.%I where workspace_id=$1 and campaign_id=$2',table_value) into count_value using p_workspace_id,p_campaign_id;
  if count_value>5000 then raise exception 'LIVE_RESULT_LIMIT: Chiến dịch vượt 5.000 dòng, cần phân trang; không cắt dữ liệu.';end if;
 end loop;
 if (select count(*) from public.live_print_attempts a join public.live_print_jobs j on j.workspace_id=a.workspace_id and j.id=a.job_id
   join public.live_sale_tickets t on t.workspace_id=j.workspace_id and t.id=j.ticket_id where t.workspace_id=p_workspace_id and t.campaign_id=p_campaign_id)>5000
  or(select count(*) from public.live_outbox_events e join public.live_sale_tickets t on t.workspace_id=e.workspace_id and t.id=e.ticket_id where t.workspace_id=p_workspace_id and t.campaign_id=p_campaign_id)>5000 then
  raise exception 'LIVE_RESULT_LIMIT: Lịch sử in/sự kiện vượt 5.000 dòng, cần phân trang.';
 end if;
 with selected as(select * from public.live_sale_tickets where workspace_id=p_workspace_id and campaign_id=p_campaign_id),
 carts as(select * from public.customer_carts where workspace_id=p_workspace_id and campaign_id=p_campaign_id)
 select jsonb_build_object(
  'campaign_customers',(select coalesce(jsonb_agg(to_jsonb(c) order by customer_no),'[]') from public.live_campaign_customers c where workspace_id=p_workspace_id and campaign_id=p_campaign_id),
  'carts',(select coalesce(jsonb_agg(to_jsonb(c)||jsonb_build_object('total_amount',coalesce((select sum(i.line_total)::text from public.customer_cart_items i where i.workspace_id=c.workspace_id and i.cart_id=c.id and i.status='active'),'0'),
   'active_qty',coalesce((select sum(i.qty) from public.customer_cart_items i where i.workspace_id=c.workspace_id and i.cart_id=c.id and i.status='active'),0)) order by c.created_at,c.id),'[]') from carts c),
  'items',(select coalesce(jsonb_agg(to_jsonb(i)||jsonb_build_object('unit_price',i.unit_price::text,'line_total',i.line_total::text) order by i.created_at,i.id),'[]') from public.customer_cart_items i join carts c on c.workspace_id=i.workspace_id and c.id=i.cart_id),
  'tickets',(select coalesce(jsonb_agg(to_jsonb(t)||jsonb_build_object('unit_price',t.unit_price::text,'line_total',t.line_total::text) order by t.committed_at,t.id),'[]') from selected t),
  -- Lease tokens are returned only by claim to the claimant, never on shared reads.
  'print_jobs',(select coalesce(jsonb_agg((to_jsonb(j)-'lease_token') order by j.created_at,j.id),'[]') from public.live_print_jobs j join selected t on t.workspace_id=j.workspace_id and t.id=j.ticket_id),
  'print_attempts',(select coalesce(jsonb_agg(to_jsonb(a) order by a.started_at,a.id),'[]') from public.live_print_attempts a join public.live_print_jobs j on j.workspace_id=a.workspace_id and j.id=a.job_id join selected t on t.workspace_id=j.workspace_id and t.id=j.ticket_id),
  'outbox',(select coalesce(jsonb_agg(to_jsonb(e) order by e.created_at,e.id),'[]') from public.live_outbox_events e join selected t on t.workspace_id=e.workspace_id and t.id=e.ticket_id)
 ) into result_value;
 return result_value;
end $$;

do $$declare t text;begin
 foreach t in array array['live_campaign_customers','customer_carts','live_sale_tickets','customer_cart_items','live_print_jobs','live_print_attempts','live_outbox_events'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('create policy member_read on public.%I for select to authenticated using(app_private.member_role(workspace_id) is not null)',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  if t<>'live_print_jobs' then execute format('grant select on public.%I to authenticated',t);end if;
 end loop;
end $$;
-- Do not leak another device's fencing token through the ordinary REST table.
grant select(id,workspace_id,ticket_id,status,snapshot,reprint_count,lease_actor,lease_expires_at,created_at,updated_at) on public.live_print_jobs to authenticated;
revoke all on app_private.live_requests from public,anon,authenticated;
revoke all on function app_private.live_replay(uuid,uuid,text,text),app_private.live_remember(uuid,uuid,text,uuid,text,jsonb),
 app_private.reserve_live_inventory(uuid,uuid,uuid,integer,date,text,text),app_private.protect_live_hold(),app_private.protect_live_snapshot() from public,anon,authenticated;
revoke all on function public.commit_live_sale_ticket(uuid,jsonb,uuid),public.void_live_sale_ticket(uuid,uuid,date,text,uuid),public.claim_live_print_job(uuid,uuid,uuid),
 public.finish_live_print_job(uuid,uuid,uuid,text,text,uuid),public.requeue_live_print_job(uuid,uuid,text,uuid),public.get_live_commerce(uuid,uuid) from public,anon;
grant execute on function public.commit_live_sale_ticket(uuid,jsonb,uuid),public.void_live_sale_ticket(uuid,uuid,date,text,uuid),public.claim_live_print_job(uuid,uuid,uuid),
 public.finish_live_print_job(uuid,uuid,uuid,text,text,uuid),public.requeue_live_print_job(uuid,uuid,text,uuid),public.get_live_commerce(uuid,uuid) to authenticated;
create index live_tickets_campaign on public.live_sale_tickets(workspace_id,campaign_id,committed_at,id);
create index live_cart_items_cart on public.customer_cart_items(workspace_id,cart_id,status);
create index live_print_jobs_queue on public.live_print_jobs(workspace_id,status,created_at,id);
create index live_print_attempts_job on public.live_print_attempts(workspace_id,job_id,attempt_no);
create index live_outbox_ticket on public.live_outbox_events(workspace_id,ticket_id,created_at);
create index inventory_live_ticket on public.inventory_reservations(workspace_id,live_ticket_id) where live_ticket_id is not null;
do $$declare t text;begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') then
  foreach t in array array['live_sale_tickets','live_print_jobs','customer_cart_items'] loop
   if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=t) then
    if t='live_print_jobs' then
     if current_setting('server_version_num')::integer>=150000 then
      execute 'alter publication supabase_realtime add table public.live_print_jobs (id,workspace_id,ticket_id,status,snapshot,reprint_count,lease_actor,lease_expires_at,created_at,updated_at)';
     end if; -- PostgreSQL 14 uses polling rather than publishing private lease tokens.
    else execute format('alter publication supabase_realtime add table public.%I',t);end if;
   end if;
  end loop;
 end if;
end $$;
commit;
