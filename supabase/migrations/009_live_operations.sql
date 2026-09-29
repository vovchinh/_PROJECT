-- Additive Phase C operator controls. Apply once after 008.
-- Old tickets, SKU IDs, holds, ledger and public commit/VOID RPCs remain intact.
begin;
do $$begin
 if to_regprocedure('public.commit_live_sale_ticket(uuid,jsonb,uuid)') is null then
  raise exception 'LIVE_PREREQUISITE: Complete 008 before 009.';
 end if;
end $$;

alter table public.live_sessions add column started_at timestamptz,add column ended_at timestamptz,
 add check(started_at is null or isfinite(started_at)),add check(ended_at is null or isfinite(ended_at)),
 add check(ended_at is null or started_at is null or ended_at>=started_at);
-- No timestamp is inferred for sessions created before this migration.
create function app_private.live_session_clock() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op='INSERT' then
  new.started_at:=case when new.status='live' then clock_timestamp() end;
  new.ended_at:=case when new.status='ended' then clock_timestamp() end;
 else
  new.started_at:=old.started_at;new.ended_at:=old.ended_at;
  if old.status='draft' and new.status='live' then new.started_at:=clock_timestamp();end if;
  if old.status<>'ended' and new.status='ended' then new.ended_at:=clock_timestamp();end if;
 end if;
 return new;
end $$;
create trigger live_session_clock before insert or update on public.live_sessions
for each row execute function app_private.live_session_clock();

create table public.live_session_controls (
 workspace_id uuid not null references public.workspaces(id),session_id uuid not null,
 desired_state text not null check(desired_state in('connected','disconnected')),
 revision bigint not null check(revision>0),requested_by uuid not null references auth.users(id),
 requested_at timestamptz not null default clock_timestamp(),primary key(workspace_id,session_id),
 foreign key(workspace_id,session_id) references public.live_sessions(workspace_id,id)
);
create table public.live_control_events (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),
 session_id uuid not null,revision bigint not null,desired_state text not null check(desired_state in('connected','disconnected')),
 actor_id uuid not null references auth.users(id),created_at timestamptz not null default clock_timestamp(),
 unique(workspace_id,id),unique(workspace_id,session_id,revision),
 foreign key(workspace_id,session_id) references public.live_sessions(workspace_id,id)
);
comment on table public.live_control_events is 'Durable control outbox; local supervisor reconciles latest desired revision. No provider calls inside RPC.';
create table public.live_comment_reviews (
 workspace_id uuid not null references public.workspaces(id),comment_id uuid not null,
 status text not null check(status in('new','ignored')),reason text not null check(length(btrim(reason)) between 3 and 2000),
 actor_id uuid not null references auth.users(id),updated_at timestamptz not null default clock_timestamp(),
 primary key(workspace_id,comment_id),foreign key(workspace_id,comment_id) references public.live_comments(workspace_id,id)
);
create index on public.live_comment_reviews(workspace_id,status);

alter table public.live_comments add column author_username text,add column avatar_url text,add column raw_payload jsonb,
 add check(author_username is null or(length(author_username) between 1 and 100 and author_username !~ U&'[\0001-\001F\007F-\009F]')),
 add check(avatar_url is null or(length(avatar_url)<=1000 and avatar_url ~ '^https://[^/@]+/')),
 add check(raw_payload is null or(jsonb_typeof(raw_payload)='object' and octet_length(raw_payload::text)<=12000));
create table public.live_provider_message_keys (
 workspace_id uuid not null references public.workspaces(id),provider text not null check(provider='tiktok_live'),
 external_comment_id text not null,comment_id uuid,needs_review boolean not null default false,
 primary key(workspace_id,provider,external_comment_id),
 foreign key(workspace_id,comment_id) references public.live_comments(workspace_id,id),
 check((needs_review and comment_id is null) or(not needs_review and comment_id is not null))
);
-- A known unique legacy source may be indexed. Conflicting legacy rows stay
-- intact and are flagged, never selected using min/max or deleted.
insert into public.live_provider_message_keys
 select c.workspace_id,'tiktok_live',c.provider_message_id,
 case when count(*)=1 then (array_agg(c.id))[1] end,count(*)>1
 from public.live_comments c join public.live_sessions s on s.workspace_id=c.workspace_id and s.id=c.session_id
 where s.provider='tiktok_live' group by c.workspace_id,c.provider_message_id;
create function app_private.live_source_key() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.live_sessions where workspace_id=new.workspace_id and id=new.session_id and provider='tiktok_live') then
  if exists(select 1 from public.live_provider_message_keys where workspace_id=new.workspace_id and provider='tiktok_live' and external_comment_id=new.provider_message_id) then
   raise exception 'LIVE_SOURCE_DUPLICATE: ID TikTok đã xuất hiện ở phiên khác hoặc đang chờ đối chiếu.';
  end if;
  insert into public.live_provider_message_keys(workspace_id,provider,external_comment_id,comment_id)
   values(new.workspace_id,'tiktok_live',new.provider_message_id,new.id);
 end if;
 return new;
end $$;
create trigger live_source_key after insert on public.live_comments for each row execute function app_private.live_source_key();

create function public.request_live_connection(p_workspace_id uuid,p_session_id uuid,p_desired_state text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.live_sessions;r bigint;result_value jsonb;h text:=md5(jsonb_build_object('session',p_session_id,'state',p_desired_state)::text);
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 result_value:=app_private.live_replay(p_workspace_id,p_request_id,'connection',h);if result_value is not null then return result_value;end if;
 if p_desired_state is null or p_desired_state not in('connected','disconnected') then raise exception 'LIVE_CONTROL: Trạng thái yêu cầu không hợp lệ.';end if;
 select * into s from public.live_sessions where workspace_id=p_workspace_id and id=p_session_id for update;
 if not found or s.provider<>'tiktok_live' then raise exception 'LIVE_CONTROL: Chọn phiên TikTok trong workspace.';end if;
 if p_desired_state='connected' and (s.status<>'live'
  or not exists(select 1 from public.live_campaigns where workspace_id=p_workspace_id and id=s.campaign_id and status='active')
  or not exists(select 1 from public.live_integration_accounts where workspace_id=p_workspace_id and id=s.integration_account_id and enabled)) then
  raise exception 'LIVE_CONTROL: Bắt đầu phiên và bật tài khoản trước khi yêu cầu kết nối.';
 end if;
 insert into public.live_session_controls(workspace_id,session_id,desired_state,revision,requested_by)
 values(p_workspace_id,s.id,p_desired_state,1,auth.uid()) on conflict(workspace_id,session_id)
 do update set desired_state=excluded.desired_state,revision=live_session_controls.revision+1,requested_by=auth.uid(),requested_at=clock_timestamp()
 returning revision into r;
 insert into public.live_control_events(workspace_id,session_id,revision,desired_state,actor_id) values(p_workspace_id,s.id,r,p_desired_state,auth.uid());
 result_value:=jsonb_build_object('session_id',s.id,'desired_state',p_desired_state,'revision',r);
 perform app_private.live_remember(p_workspace_id,p_request_id,'connection',s.id,h,result_value);
 perform app_private.audit(p_workspace_id,'live.connection_requested',s.id,result_value);return result_value;
end $$;

create function public.set_live_comment_review(p_workspace_id uuid,p_comment_id uuid,p_status text,p_reason text,p_request_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare c public.live_comments;h text:=md5(jsonb_build_object('id',p_comment_id,'status',p_status,'reason',p_reason)::text);prior jsonb;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager','staff']);
 prior:=app_private.live_replay(p_workspace_id,p_request_id,'review',h);if prior is not null then return p_comment_id;end if;
 if p_status is null or p_status not in('new','ignored') or length(btrim(coalesce(p_reason,''))) not between 3 and 2000 then
  raise exception 'LIVE_REVIEW: Chọn bỏ qua/khôi phục và ghi lý do ít nhất 3 ký tự.';
 end if;
 select * into c from public.live_comments where workspace_id=p_workspace_id and id=p_comment_id for update;
 if not found or c.state<>'new' then raise exception 'LIVE_REVIEW: Chỉ xử lý bình luận chưa chốt.';end if;
 if exists(select 1 from public.live_comment_claims where workspace_id=p_workspace_id and comment_id=c.id and claimed_by<>auth.uid() and expires_at>clock_timestamp()) then
  raise exception 'LIVE_CLAIM_BUSY: Nhân viên khác đang xử lý.';
 end if;
 delete from public.live_comment_claims where workspace_id=p_workspace_id and comment_id=c.id;
 insert into public.live_comment_reviews values(p_workspace_id,c.id,p_status,btrim(p_reason),auth.uid(),clock_timestamp())
 on conflict(workspace_id,comment_id) do update set status=excluded.status,reason=excluded.reason,actor_id=auth.uid(),updated_at=clock_timestamp();
 perform app_private.live_remember(p_workspace_id,p_request_id,'review',c.id,h,jsonb_build_object('id',c.id));
 perform app_private.audit(p_workspace_id,'live.comment_reviewed',c.id,jsonb_build_object('status',p_status,'reason',btrim(p_reason)));return c.id;
end $$;
create function app_private.guard_ignored_live_comment() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.live_comment_reviews where workspace_id=new.workspace_id and comment_id=new.comment_id and status='ignored') then
  raise exception 'LIVE_IGNORED: Khôi phục bình luận đã bỏ qua trước khi nhận/chốt.';
 end if;
 return new;
end $$;
create trigger guard_ignored_live_claim before insert or update on public.live_comment_claims for each row execute function app_private.guard_ignored_live_comment();
create trigger guard_ignored_live_ticket before insert on public.live_sale_tickets for each row execute function app_private.guard_ignored_live_comment();

create function public.ingest_live_comments_v2(p_workspace_id uuid,p_session_id uuid,p_comments jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result_value jsonb;r jsonb;u text;a text;c public.live_comments;meta jsonb;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager','staff']);
 result_value:=public.ingest_live_comments(p_workspace_id,p_session_id,p_comments);
 for r in select value from jsonb_array_elements(p_comments) loop
  u:=nullif(app_private.live_text(r,'username',100,false),'');a:=nullif(app_private.live_text(r,'avatar_url',1000,false),'');
  if a is not null and (a !~ '^https://[A-Za-z0-9.-]+(:443)?/' or a ~ '[@\\]' or a ~ '[?#]') then
   raise exception 'LIVE_AVATAR: Chỉ dùng URL HTTPS ảnh công khai không token hoặc credentials.';
  end if;
  select * into c from public.live_comments where workspace_id=p_workspace_id and session_id=p_session_id and provider_message_id=btrim(r->>'message_id');
  if (c.author_username is not null and u is not null and c.author_username<>u) or(c.avatar_url is not null and a is not null and c.avatar_url<>a) then
   raise exception 'LIVE_METADATA_CONFLICT: Metadata nguồn đã lưu khác bản gửi lại.';
  end if;
  -- Allowlist only; raw cookies/tokens and unrelated provider data are never persisted.
  meta:=jsonb_strip_nulls(jsonb_build_object('message_id',c.provider_message_id,'author_external_id',c.author_external_id,
   'author_display_name',c.author_display_name,'text',c.raw_text,'occurred_at',c.occurred_at,'username',u,'avatar_url',a));
  update public.live_comments set author_username=coalesce(author_username,u),avatar_url=coalesce(avatar_url,a),raw_payload=coalesce(raw_payload,meta)
   where workspace_id=p_workspace_id and id=c.id;
 end loop;
 return result_value;
end $$;

create table public.print_templates (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),name text not null,
 document_type text not null default 'LIVE_SALE_TICKET' check(document_type='LIVE_SALE_TICKET'),settings jsonb not null,
 updated_at timestamptz not null default clock_timestamp(),unique(workspace_id,id),check(length(name) between 1 and 200)
);
create table public.printer_devices (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),name text not null,
 driver text not null check(driver in('SYSTEM_PRINT','ESC_POS','MOCK')),ip_address inet,port integer not null default 9100 check(port between 1 and 65535),
 paper_width integer not null default 80 check(paper_width in(58,80)),copies integer not null default 1 check(copies=1),
 encoding text not null default 'raster' check(encoding in('raster','system')),enabled boolean not null default true,
 updated_at timestamptz not null default clock_timestamp(),unique(workspace_id,id),check(length(name) between 1 and 200),
 check((driver='ESC_POS' and ip_address is not null and family(ip_address)=4
  and (ip_address << inet '10.0.0.0/8' or ip_address << inet '172.16.0.0/12' or ip_address << inet '192.168.0.0/16'))
  or(driver<>'ESC_POS' and ip_address is null)),check(masklen(ip_address)=32 or ip_address is null)
);
create table public.printer_profiles (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),device_id uuid not null,template_id uuid not null,
 is_default boolean not null default false,updated_by uuid not null references auth.users(id),updated_at timestamptz not null default clock_timestamp(),
 unique(workspace_id,id),unique(workspace_id,device_id),
 foreign key(workspace_id,device_id) references public.printer_devices(workspace_id,id),
 foreign key(workspace_id,template_id) references public.print_templates(workspace_id,id)
);
create unique index one_default_live_printer on public.printer_profiles(workspace_id) where is_default;
create function app_private.live_print_options(p jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare k text;v jsonb;result_value jsonb:='{}';
begin
 if p is null or jsonb_typeof(p)<>'object' then raise exception 'PRINT_OPTIONS: Cần cấu hình mẫu in.';end if;
 for k,v in select key,value from jsonb_each(p) loop
  if k=any(array['show_customer_number','show_username','show_product_code','show_product_name','show_variant','show_qty','show_price','show_ticket_no','show_timestamp','auto_cut']) then
   if jsonb_typeof(v)<>'boolean' then raise exception 'PRINT_OPTIONS: Trường % phải là boolean.',k;end if;
  elsif k in('font_scale_customer','font_scale_product') then
   if jsonb_typeof(v)<>'number' or v::text !~ '^[123]$' then raise exception 'PRINT_OPTIONS: Cỡ chữ từ 1 đến 3.';end if;
  elsif k='copies' then
   if v<>'1'::jsonb then raise exception 'PRINT_OPTIONS: Mỗi attempt một bản; in lại dùng hàng đợi.';end if;
  else raise exception 'PRINT_OPTIONS: Trường không hỗ trợ %.',k;end if;
  result_value:=result_value||jsonb_build_object(k,v);
 end loop;
 return result_value;
end $$;
alter table public.print_templates add constraint valid_live_print_options check(settings=app_private.live_print_options(settings));
create function public.save_live_printer(p_workspace_id uuid,p_payload jsonb,p_request_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare rid uuid;h text:=md5(coalesce(p_payload,'null'::jsonb)::text);prior jsonb;n text;d text;ip inet;pw integer;pt integer;opts jsonb;def boolean;en boolean;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 prior:=app_private.live_replay(p_workspace_id,p_request_id,'printer',h);if prior is not null then return (prior->>'id')::uuid;end if;
 rid:=nullif(p_payload->>'id','')::uuid;n:=app_private.live_text(p_payload,'name',200);d:=app_private.live_text(p_payload,'driver',30);
 pw:=coalesce((p_payload->>'paper_width')::integer,80);pt:=coalesce((p_payload->>'port')::integer,9100);
 ip:=nullif(p_payload->>'ip_address','')::inet;opts:=app_private.live_print_options(coalesce(p_payload->'settings','{}'::jsonb));
 def:=app_private.foundation_boolean(p_payload,'is_default',false);en:=app_private.foundation_boolean(p_payload,'enabled',true);
 if rid is not null and not exists(select 1 from public.printer_profiles where workspace_id=p_workspace_id and id=rid) then raise exception 'PRINT_PROFILE: Không tìm thấy cấu hình trong workspace.';end if;
 rid:=coalesce(rid,gen_random_uuid());
 insert into public.printer_devices(id,workspace_id,name,driver,ip_address,port,paper_width,encoding,enabled)
 values(rid,p_workspace_id,n,d,ip,pt,pw,case when d='SYSTEM_PRINT' then 'system' else 'raster' end,en)
 on conflict(id) do update set name=excluded.name,driver=excluded.driver,ip_address=excluded.ip_address,port=excluded.port,paper_width=excluded.paper_width,encoding=excluded.encoding,enabled=excluded.enabled,updated_at=clock_timestamp();
 insert into public.print_templates(id,workspace_id,name,settings) values(rid,p_workspace_id,n,opts)
 on conflict(id) do update set name=excluded.name,settings=excluded.settings,updated_at=clock_timestamp();
 if def then update public.printer_profiles set is_default=false,updated_at=clock_timestamp() where workspace_id=p_workspace_id and is_default;end if;
 insert into public.printer_profiles(id,workspace_id,device_id,template_id,is_default,updated_by) values(rid,p_workspace_id,rid,rid,def,auth.uid())
 on conflict(id) do update set is_default=excluded.is_default,updated_by=auth.uid(),updated_at=clock_timestamp();
 perform app_private.live_remember(p_workspace_id,p_request_id,'printer',rid,h,jsonb_build_object('id',rid));
 perform app_private.audit(p_workspace_id,'live.printer_saved',rid,jsonb_build_object('driver',d,'is_default',def));return rid;
end $$;

alter table public.live_print_jobs add column printer_profile_id uuid,add column print_options jsonb,add column paper_width integer,
 add foreign key(workspace_id,printer_profile_id) references public.printer_profiles(workspace_id,id),add check(paper_width in(58,80));
create function app_private.live_job_profile() returns trigger
language plpgsql security definer set search_path='' as $$
declare p record;u text;
begin
 if tg_op='UPDATE' then
  if new.printer_profile_id is distinct from old.printer_profile_id or new.print_options is distinct from old.print_options or new.paper_width is distinct from old.paper_width then
   raise exception 'PRINT_IMMUTABLE: Giữ cấu hình mẫu tại thời điểm chốt.';
  end if;return new;
 end if;
 select pr.id,t.settings,d.paper_width into p from public.printer_profiles pr
  join public.printer_devices d on d.workspace_id=pr.workspace_id and d.id=pr.device_id
  join public.print_templates t on t.workspace_id=pr.workspace_id and t.id=pr.template_id
  where pr.workspace_id=new.workspace_id and pr.is_default and d.enabled;
 if found then new.printer_profile_id:=p.id;new.print_options:=p.settings;new.paper_width:=p.paper_width;end if;
 select c.author_username into u from public.live_sale_tickets t join public.live_comments c on c.workspace_id=t.workspace_id and c.id=t.comment_id
  where t.workspace_id=new.workspace_id and t.id=new.ticket_id;
 if u is not null then new.snapshot:=new.snapshot||jsonb_build_object('customer_username',u);end if;
 return new;
end $$;
create trigger live_job_profile before insert or update on public.live_print_jobs for each row execute function app_private.live_job_profile();
create function public.claim_live_print_job_configured(p_workspace_id uuid,p_job_id uuid,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r jsonb;j public.live_print_jobs;
begin
 r:=public.claim_live_print_job(p_workspace_id,p_job_id,p_request_id);
 select * into j from public.live_print_jobs where workspace_id=p_workspace_id and id=p_job_id;
 return r||jsonb_build_object('print_options',j.print_options,'paper_width',coalesce(j.paper_width,80),'printer_profile_id',j.printer_profile_id);
end $$;

create function public.reset_live_campaign_counter(p_workspace_id uuid,p_campaign_id uuid,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r jsonb;h text:=md5(coalesce(p_campaign_id::text,''));
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 r:=app_private.live_replay(p_workspace_id,p_request_id,'counter',h);if r is not null then return r;end if;
 if not exists(select 1 from public.live_campaigns where workspace_id=p_workspace_id and id=p_campaign_id and status='draft')
  or exists(select 1 from public.live_campaign_customers where workspace_id=p_workspace_id and campaign_id=p_campaign_id)
  or exists(select 1 from public.live_sessions where workspace_id=p_workspace_id and campaign_id=p_campaign_id and(status<>'draft' or started_at is not null)) then
  raise exception 'LIVE_COUNTER_LOCKED: Chỉ khởi đầu STT khi chiến dịch nháp chưa bắt đầu và chưa cấp số.';
 end if;
 -- Existing numbering is max(customer_no)+1: an unused campaign already starts at 1.
 r:=jsonb_build_object('campaign_id',p_campaign_id,'next_customer_no',1);
 perform app_private.live_remember(p_workspace_id,p_request_id,'counter',p_campaign_id,h,r);
 perform app_private.audit(p_workspace_id,'live.counter_initialized',p_campaign_id,r);return r;
end $$;

create function public.get_live_stock_preview(p_workspace_id uuid,p_session_id uuid,p_product_id uuid,p_date date)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare hid uuid;onhand bigint;held bigint;
begin
 perform app_private.require_role(p_workspace_id,array['owner','manager','staff','viewer']);
 perform app_private.inventory_reservation_date(p_date);
 select c.warehouse_id into hid from public.live_sessions s join public.live_campaigns c on c.workspace_id=s.workspace_id and c.id=s.campaign_id
  where s.workspace_id=p_workspace_id and s.id=p_session_id;
 if hid is null or not exists(select 1 from public.products where workspace_id=p_workspace_id and id=p_product_id) then raise exception 'LIVE_STOCK: SKU/phiên không thuộc workspace.';end if;
 select coalesce(sum(l.remaining_qty),0),coalesce(sum(
  coalesce((select sum(a.qty) from public.sales_allocations a where a.workspace_id=l.workspace_id and a.lot_id=l.id and a.status='reserved'),0)
  +coalesce((select sum(a.qty) from public.reservation_lots a join public.inventory_reservations r on r.workspace_id=a.workspace_id and r.id=a.reservation_id
    where a.workspace_id=l.workspace_id and a.lot_id=l.id and r.status='active'),0)),0)
 into onhand,held from public.inventory_lots l where l.workspace_id=p_workspace_id and l.product_id=p_product_id and l.warehouse_id=hid and l.available_date<=p_date;
 return jsonb_build_object('product_id',p_product_id,'warehouse_id',hid,'date',p_date,'on_hand',onhand,'reserved',held,'available',onhand-held,'preview_only',true);
end $$;

create function public.get_live_operations(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare r jsonb;
begin
 perform app_private.require_role(p_workspace_id,array['owner','manager','staff','viewer']);
 if (select count(*) from public.live_sessions where workspace_id=p_workspace_id)>1000
  or(select count(*) from public.live_comment_reviews where workspace_id=p_workspace_id)>20000
  or(select count(*) from public.printer_profiles where workspace_id=p_workspace_id)>100 then
  raise exception 'LIVE_OPERATIONS_LIMIT: Vượt giới hạn snapshot vận hành; cần phân trang, không trả dữ liệu bị cắt.';
 end if;
 select jsonb_build_object('version',9,
  'session_controls',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from (
   select ct.session_id,ct.revision,ct.requested_at,case when s.status='live' and c.status='active' and a.enabled then ct.desired_state else 'disconnected' end desired_state
   from public.live_session_controls ct join public.live_sessions s on s.workspace_id=ct.workspace_id and s.id=ct.session_id
   join public.live_campaigns c on c.workspace_id=s.workspace_id and c.id=s.campaign_id
   left join public.live_integration_accounts a on a.workspace_id=s.workspace_id and a.id=s.integration_account_id where ct.workspace_id=p_workspace_id) x),
  'comment_reviews',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from public.live_comment_reviews x where workspace_id=p_workspace_id),
  'printers',(select coalesce(jsonb_agg(to_jsonb(d)||jsonb_build_object('profile_id',pr.id,'is_default',pr.is_default,'settings',t.settings)),'[]')
   from public.printer_profiles pr join public.printer_devices d on d.workspace_id=pr.workspace_id and d.id=pr.device_id
   join public.print_templates t on t.workspace_id=pr.workspace_id and t.id=pr.template_id where pr.workspace_id=p_workspace_id),
  'source_conflicts',(select count(*) from public.live_provider_message_keys where workspace_id=p_workspace_id and needs_review),
  'session_metrics',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from (
   select s.id session_id,s.campaign_id,s.started_at,s.ended_at,
    (select count(*) from public.live_comments c where c.workspace_id=p_workspace_id and c.session_id=s.id) comment_count,
    (select count(*) from public.live_sale_tickets t where t.workspace_id=p_workspace_id and t.session_id=s.id and t.status='committed') ticket_count,
    (select count(distinct t.campaign_customer_id) from public.live_sale_tickets t where t.workspace_id=p_workspace_id and t.session_id=s.id and t.status='committed') customer_count,
    (select coalesce(sum(t.qty),0) from public.live_sale_tickets t where t.workspace_id=p_workspace_id and t.session_id=s.id and t.status='committed') qty,
    (select coalesce(sum(t.line_total),0)::text from public.live_sale_tickets t where t.workspace_id=p_workspace_id and t.session_id=s.id and t.status='committed') total_amount
    from public.live_sessions s where s.workspace_id=p_workspace_id) x)) into r;
 return r;
end $$;

do $$declare t text;begin
 foreach t in array array['live_session_controls','live_control_events','live_comment_reviews','live_provider_message_keys','print_templates','printer_devices','printer_profiles'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('create policy member_read on public.%I for select to authenticated using(app_private.member_role(workspace_id) is not null)',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
 end loop;
end $$;
revoke all on function app_private.live_session_clock(),app_private.live_source_key(),app_private.guard_ignored_live_comment(),
 app_private.live_print_options(jsonb),app_private.live_job_profile() from public,anon,authenticated;
revoke all on function public.request_live_connection(uuid,uuid,text,uuid),public.set_live_comment_review(uuid,uuid,text,text,uuid),
 public.ingest_live_comments_v2(uuid,uuid,jsonb),public.save_live_printer(uuid,jsonb,uuid),public.claim_live_print_job_configured(uuid,uuid,uuid),
 public.reset_live_campaign_counter(uuid,uuid,uuid),public.get_live_stock_preview(uuid,uuid,uuid,date),public.get_live_operations(uuid) from public,anon;
grant execute on function public.request_live_connection(uuid,uuid,text,uuid),public.set_live_comment_review(uuid,uuid,text,text,uuid),
 public.ingest_live_comments_v2(uuid,uuid,jsonb),public.save_live_printer(uuid,jsonb,uuid),public.claim_live_print_job_configured(uuid,uuid,uuid),
 public.reset_live_campaign_counter(uuid,uuid,uuid),public.get_live_stock_preview(uuid,uuid,uuid,date),public.get_live_operations(uuid) to authenticated;
-- Existing publication remains unchanged; 007/008 events and polling refresh new state.
commit;
