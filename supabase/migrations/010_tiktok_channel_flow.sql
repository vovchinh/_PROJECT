-- Seller flow: save username -> request connection -> listener verifies LIVE
-- -> server selects daily campaign/session. Never infer LIVE from a button click.
begin;
do $$begin
 if to_regprocedure('public.get_live_operations(uuid)') is null then raise exception 'TIKTOK_PREREQUISITE: Apply 009 before 010.';end if;
end $$;
alter table public.live_integration_accounts add column is_default boolean not null default false,
 add column last_connected_at timestamptz,add column last_live_at timestamptz;
create unique index live_channel_one_default on public.live_integration_accounts(workspace_id) where is_default;
-- Only a single enabled legacy channel has an unambiguous default.
update public.live_integration_accounts a set is_default=true where a.enabled
 and (select count(*) from public.live_integration_accounts b where b.workspace_id=a.workspace_id and b.enabled)=1;

create table public.live_channel_connections (
 workspace_id uuid not null references public.workspaces(id),channel_id uuid not null,
 desired_state text not null check(desired_state in('connected','disconnected')),
 connection_status text not null check(connection_status in('OFFLINE','CONNECTING','LIVE','RECONNECTING','ERROR')),
 revision bigint not null check(revision>0),requested_by uuid not null references auth.users(id),requested_at timestamptz not null default clock_timestamp(),
 current_session_id uuid,provider_room_id text,heartbeat_at timestamptz,connected_since timestamptz,
 message_code text not null default 'waiting_for_listener' check(message_code in('waiting_for_listener','room_not_live','connected','disconnected','connection_failed','retrying')),
 lease_token uuid,lease_actor uuid references auth.users(id),lease_expires_at timestamptz,
 primary key(workspace_id,channel_id),foreign key(workspace_id,channel_id) references public.live_integration_accounts(workspace_id,id),
 foreign key(workspace_id,current_session_id) references public.live_sessions(workspace_id,id),
 check((lease_token is null and lease_actor is null and lease_expires_at is null) or(lease_token is not null and lease_actor is not null and lease_expires_at is not null))
);
create table public.live_channel_commands (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),channel_id uuid not null,
 revision bigint not null,desired_state text not null check(desired_state in('connected','disconnected')),
 actor_id uuid not null references auth.users(id),created_at timestamptz not null default clock_timestamp(),
 unique(workspace_id,id),unique(workspace_id,channel_id,revision),
 foreign key(workspace_id,channel_id) references public.live_integration_accounts(workspace_id,id)
);
comment on table public.live_channel_commands is 'Durable outbox of seller intent. Listener reconciles current revision; never calls provider in SQL transaction.';
create table public.live_channel_campaigns (
 workspace_id uuid not null references public.workspaces(id),channel_id uuid not null,business_date date not null check(isfinite(business_date)),campaign_id uuid not null,
 primary key(workspace_id,channel_id,business_date),unique(workspace_id,campaign_id),
 foreign key(workspace_id,channel_id) references public.live_integration_accounts(workspace_id,id),
 foreign key(workspace_id,campaign_id) references public.live_campaigns(workspace_id,id)
);
create table public.live_channel_sessions (
 workspace_id uuid not null references public.workspaces(id),channel_id uuid not null,business_date date not null,provider_room_id text not null check(length(provider_room_id) between 1 and 200),session_id uuid not null,
 primary key(workspace_id,channel_id,business_date,provider_room_id),unique(workspace_id,session_id),
 foreign key(workspace_id,channel_id,business_date) references public.live_channel_campaigns(workspace_id,channel_id,business_date),
 foreign key(workspace_id,session_id) references public.live_sessions(workspace_id,id)
);

create function app_private.protect_tiktok_channel() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.username<>old.username and exists(select 1 from public.live_channel_connections where workspace_id=old.workspace_id and channel_id=old.id) then
  raise exception 'TIKTOK_CHANNEL_USED: TikTok ID đã có yêu cầu kết nối; thêm ID mới để giữ đúng lịch sử nguồn.';
 end if;
 if old.enabled and not new.enabled then
  new.is_default:=false;
  update public.live_channel_connections set desired_state='disconnected',connection_status='OFFLINE',message_code='disconnected',revision=revision+1,
   lease_token=null,lease_actor=null,lease_expires_at=null,connected_since=null,requested_by=auth.uid(),requested_at=clock_timestamp()
   where workspace_id=old.workspace_id and channel_id=old.id;
 end if;
 return new;
end $$;
create trigger protect_tiktok_channel before update on public.live_integration_accounts for each row execute function app_private.protect_tiktok_channel();

create function public.save_tiktok_channel(p_workspace_id uuid,p_payload jsonb,p_request_id uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare rid uuid;handle text;label text;active_value boolean;default_value boolean;prior jsonb;h text:=md5(coalesce(p_payload,'null'::jsonb)::text);
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 prior:=app_private.live_replay(p_workspace_id,p_request_id,'channel.save',h);if prior is not null then return(prior->>'id')::uuid;end if;
 handle:=lower(app_private.live_text(p_payload,'username',25));if left(handle,1)='@' then handle:=substr(handle,2);end if;
 label:=nullif(app_private.live_text(p_payload,'display_name',200,false),'');
 active_value:=app_private.foundation_boolean(p_payload,'is_active',true);
 default_value:=app_private.foundation_boolean(p_payload,'is_default',not exists(select 1 from public.live_integration_accounts where workspace_id=p_workspace_id and is_default));
 if exists(select 1 from public.live_integration_accounts a join public.live_channel_connections c on c.workspace_id=a.workspace_id and c.channel_id=a.id
  where a.workspace_id=p_workspace_id and a.id=nullif(p_payload->>'id','')::uuid and a.username<>handle) then
  raise exception 'TIKTOK_CHANNEL_USED: TikTok ID đã có yêu cầu kết nối; thêm ID mới để giữ đúng lịch sử nguồn.';
 end if;
 rid:=public.save_live_integration_account(p_workspace_id,jsonb_build_object('id',nullif(p_payload->>'id',''),'username',handle,'name',coalesce(label,handle),'enabled',active_value));
 if default_value and active_value then update public.live_integration_accounts set is_default=false where workspace_id=p_workspace_id and is_default and id<>rid;end if;
 update public.live_integration_accounts set is_default=default_value and active_value,updated_at=clock_timestamp() where workspace_id=p_workspace_id and id=rid;
 if not active_value then
  update public.live_channel_connections set desired_state='disconnected',connection_status='OFFLINE',message_code='disconnected',revision=revision+1,
   lease_token=null,lease_actor=null,lease_expires_at=null,connected_since=null,requested_by=auth.uid(),requested_at=clock_timestamp()
   where workspace_id=p_workspace_id and channel_id=rid and desired_state<>'disconnected';
 end if;
 perform app_private.live_remember(p_workspace_id,p_request_id,'channel.save',rid,h,jsonb_build_object('id',rid));return rid;
end $$;

create function public.request_tiktok_connection(p_workspace_id uuid,p_channel_id uuid,p_desired_state text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.live_channel_connections;r jsonb;rev bigint;h text:=md5(jsonb_build_object('channel',p_channel_id,'desired',p_desired_state)::text);
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager','staff']);
 r:=app_private.live_replay(p_workspace_id,p_request_id,'channel.connect',h);if r is not null then return r;end if;
 if p_desired_state is null or p_desired_state not in('connected','disconnected') then raise exception 'TIKTOK_CONNECT: Yêu cầu không hợp lệ.';end if;
 if not exists(select 1 from public.live_integration_accounts where workspace_id=p_workspace_id and id=p_channel_id and(enabled or p_desired_state='disconnected')) then
  raise exception 'TIKTOK_CHANNEL: Chọn TikTok ID đang hoạt động trong workspace.';
 end if;
 select * into c from public.live_channel_connections where workspace_id=p_workspace_id and channel_id=p_channel_id for update;
 if found and c.desired_state=p_desired_state and (p_desired_state='disconnected'
   or(c.connection_status in('CONNECTING','RECONNECTING') and c.requested_at>clock_timestamp()-interval '90 seconds')
   or(c.connection_status='LIVE' and c.heartbeat_at>clock_timestamp()-interval '90 seconds')) then
  r:=jsonb_build_object('channel_id',p_channel_id,'revision',c.revision,'connection_status',c.connection_status,'session_id',c.current_session_id);
 else
  rev:=coalesce(c.revision,0)+1;
  insert into public.live_channel_connections(workspace_id,channel_id,desired_state,connection_status,revision,requested_by,message_code)
   values(p_workspace_id,p_channel_id,p_desired_state,case when p_desired_state='connected' then 'CONNECTING' else 'OFFLINE' end,rev,auth.uid(),
    case when p_desired_state='connected' then 'waiting_for_listener' else 'disconnected' end)
  on conflict(workspace_id,channel_id) do update set desired_state=excluded.desired_state,connection_status=excluded.connection_status,revision=excluded.revision,
   requested_by=auth.uid(),requested_at=clock_timestamp(),message_code=excluded.message_code,lease_token=null,lease_actor=null,lease_expires_at=null,connected_since=null;
  insert into public.live_channel_commands(workspace_id,channel_id,revision,desired_state,actor_id) values(p_workspace_id,p_channel_id,rev,p_desired_state,auth.uid());
  if p_desired_state='disconnected' and c.current_session_id is not null then
   update public.live_sessions set connection_status='disconnected',connection_message='Đã yêu cầu ngắt kết nối.',updated_at=clock_timestamp()
    where workspace_id=p_workspace_id and id=c.current_session_id;
  end if;
  r:=jsonb_build_object('channel_id',p_channel_id,'revision',rev,'connection_status',case when p_desired_state='connected' then 'CONNECTING' else 'OFFLINE' end);
  perform app_private.audit(p_workspace_id,'tiktok.connection_requested',p_channel_id,jsonb_build_object('revision',rev,'desired_state',p_desired_state));
 end if;
 perform app_private.live_remember(p_workspace_id,p_request_id,'channel.connect',p_channel_id,h,r);return r;
end $$;

create function public.claim_tiktok_connection(p_workspace_id uuid,p_channel_id uuid,p_revision bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.live_channel_connections;token uuid;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 select * into c from public.live_channel_connections where workspace_id=p_workspace_id and channel_id=p_channel_id for update;
 if not found or c.revision<>p_revision or c.desired_state<>'connected' or not exists(select 1 from public.live_integration_accounts where workspace_id=p_workspace_id and id=p_channel_id and enabled) then
  raise exception 'TIKTOK_REQUEST_STALE: Yêu cầu kết nối đã đổi hoặc bị hủy.';
 end if;
 if c.lease_expires_at>clock_timestamp() then
  raise exception 'TIKTOK_LISTENER_BUSY: Một listener đang xử lý kết nối này.';
 end if;
 token:=gen_random_uuid();
 update public.live_channel_connections set lease_token=token,lease_actor=auth.uid(),lease_expires_at=clock_timestamp()+interval '90 seconds'
  where workspace_id=p_workspace_id and channel_id=p_channel_id;
 return jsonb_build_object('lease_token',token,'revision',c.revision);
end $$;

create function public.report_tiktok_connection(p_workspace_id uuid,p_channel_id uuid,p_revision bigint,p_lease_token uuid,p_status text,p_provider_room_id text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.live_channel_connections;a public.live_integration_accounts;cid uuid;sid uuid;hid uuid;
 d date:=(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;label text;newstatus text;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 select * into c from public.live_channel_connections where workspace_id=p_workspace_id and channel_id=p_channel_id for update;
 if not found or c.revision<>p_revision or c.lease_token is distinct from p_lease_token or p_lease_token is null or c.lease_actor<>auth.uid()
  or c.lease_expires_at<=clock_timestamp() or c.desired_state<>'connected' then raise exception 'TIKTOK_LISTENER_STALE: Kết quả listener đã hết quyền hoặc thuộc yêu cầu cũ.';end if;
 if p_status is null or p_status not in('live','offline','error','disconnected','reconnecting') then raise exception 'TIKTOK_REPORT: Trạng thái không hợp lệ.';end if;
 select * into a from public.live_integration_accounts where workspace_id=p_workspace_id and id=p_channel_id and enabled;
 if not found then raise exception 'TIKTOK_CHANNEL_DISABLED: TikTok ID đã tắt.';end if;
 if p_status='live' then
  if p_provider_room_id is null or p_provider_room_id !~ '^[A-Za-z0-9_-]{1,200}$' then raise exception 'TIKTOK_ROOM_REQUIRED: Cần ID phòng LIVE thực tế từ provider.';end if;
  select campaign_id into cid from public.live_channel_campaigns where workspace_id=p_workspace_id and channel_id=p_channel_id and business_date=d;
  if cid is null then
   select id into hid from public.warehouses where workspace_id=p_workspace_id and code='CHIDI-MAIN';
   if hid is null and(select count(*) from public.warehouses where workspace_id=p_workspace_id)=1 then select id into hid from public.warehouses where workspace_id=p_workspace_id;end if;
   if hid is null then raise exception 'TIKTOK_WAREHOUSE: Chủ shop cần cấu hình kho mặc định CHIDI-MAIN trước vận hành LIVE.';end if;
   cid:=public.save_live_campaign(p_workspace_id,jsonb_build_object('code','TK-'||p_channel_id::text||'-'||to_char(d,'YYYYMMDD'),
    'name','@'||a.username||' · '||to_char(d,'DD/MM/YYYY'),'warehouse_id',hid,'status','active'));
   insert into public.live_channel_campaigns values(p_workspace_id,p_channel_id,d,cid);
  elsif not exists(select 1 from public.live_campaigns where workspace_id=p_workspace_id and id=cid and status='active') then
   raise exception 'TIKTOK_CAMPAIGN_CLOSED: Chiến dịch trong ngày đã đóng; chủ shop cần đối chiếu trước khi mở phiên khác.';
  end if;
  select session_id into sid from public.live_channel_sessions where workspace_id=p_workspace_id and channel_id=p_channel_id and business_date=d and provider_room_id=p_provider_room_id;
  if sid is null then
   if c.current_session_id is not null then update public.live_sessions set status='ended',connection_status='disconnected' where workspace_id=p_workspace_id and id=c.current_session_id and status='live';end if;
   sid:=public.save_live_session(p_workspace_id,jsonb_build_object('campaign_id',cid,'code','TK-'||gen_random_uuid()::text,'title','LIVE @'||a.username,
    'provider','tiktok_live','room_id',a.username,'integration_account_id',a.id,'status','live'));
   insert into public.live_channel_sessions values(p_workspace_id,p_channel_id,d,p_provider_room_id,sid);
  elsif not exists(select 1 from public.live_sessions where workspace_id=p_workspace_id and id=sid and status='live') then
   raise exception 'TIKTOK_ROOM_ENDED: Phòng LIVE này đã kết thúc; không mở lại lịch sử.';
  end if;
  perform public.report_live_connection(p_workspace_id,sid,'connected','connected');
  update public.live_integration_accounts set last_connected_at=case when c.connection_status<>'LIVE' then clock_timestamp() else last_connected_at end,last_live_at=clock_timestamp() where workspace_id=p_workspace_id and id=a.id;
 end if;
 newstatus:=case p_status when 'live' then 'LIVE' when 'reconnecting' then 'RECONNECTING' when 'error' then 'ERROR' else 'OFFLINE' end;
 label:=case p_status when 'live' then 'connected' when 'offline' then 'room_not_live' when 'error' then 'connection_failed' when 'reconnecting' then 'retrying' else 'disconnected' end;
 update public.live_channel_connections set connection_status=newstatus,message_code=label,heartbeat_at=clock_timestamp(),
  connected_since=case when p_status='live' then coalesce(connected_since,clock_timestamp()) else null end,
  current_session_id=coalesce(sid,current_session_id),provider_room_id=case when p_status='live' then p_provider_room_id else provider_room_id end,
  lease_expires_at=clock_timestamp()+interval '90 seconds' where workspace_id=p_workspace_id and channel_id=p_channel_id;
 if p_status<>'live' and c.current_session_id is not null then
  update public.live_sessions set connection_status=case when p_status='error' then 'error' else 'disconnected' end,connection_message=case when p_status='offline' then 'Tài khoản chưa phát LIVE.' else 'Đang chờ kết nối.' end
   where workspace_id=p_workspace_id and id=c.current_session_id;
 end if;
 if c.connection_status<>newstatus or sid is distinct from c.current_session_id then perform app_private.audit(p_workspace_id,'tiktok.connection_reported',p_channel_id,jsonb_build_object('status',newstatus,'revision',p_revision));end if;
 return jsonb_build_object('session_id',coalesce(sid,c.current_session_id),'status',newstatus,'revision',p_revision);
end $$;

create function public.get_tiktok_channels(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare r jsonb;
begin
 perform app_private.require_role(p_workspace_id,array['owner','manager','staff','viewer']);
 if(select count(*) from public.live_integration_accounts where workspace_id=p_workspace_id)>1000 then raise exception 'TIKTOK_LIMIT: Cần phân trang danh sách kênh.';end if;
 select jsonb_build_object('channels',(select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'workspace_id',a.workspace_id,'username',a.username,'display_name',nullif(a.name,a.username),
  'is_default',a.is_default,'is_active',a.enabled,'last_connected_at',a.last_connected_at,'last_live_at',a.last_live_at,'created_at',a.created_at,'updated_at',a.updated_at) order by a.is_default desc,a.created_at,a.id),'[]') from public.live_integration_accounts a where a.workspace_id=p_workspace_id),
  'connections',(select coalesce(jsonb_agg(to_jsonb(c)-array['lease_token','lease_actor','lease_expires_at']),'[]') from public.live_channel_connections c where c.workspace_id=p_workspace_id)) into r;
 return r;
end $$;

-- A requested disconnect fences new ingestion even before the physical socket
-- has drained. Existing duplicates still no-op through 007's immutable lookup.
create function app_private.guard_channel_ingestion() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.live_channel_sessions s where s.workspace_id=new.workspace_id and s.session_id=new.session_id)
  and not exists(select 1 from public.live_channel_sessions s join public.live_channel_connections c on c.workspace_id=s.workspace_id and c.channel_id=s.channel_id
   where s.workspace_id=new.workspace_id and s.session_id=new.session_id and c.current_session_id=s.session_id and c.desired_state='connected' and c.connection_status='LIVE'
    and c.lease_actor=auth.uid() and c.lease_expires_at>clock_timestamp() and c.lease_token::text=nullif(current_setting('app_private.tiktok_ingest_token',true),'')) then
  raise exception 'TIKTOK_DISCONNECTED: Kết nối đã dừng; giữ bình luận chờ đối chiếu tại listener.';
 end if;return new;
end $$;
create trigger guard_channel_ingestion before insert on public.live_comments for each row execute function app_private.guard_channel_ingestion();

create function public.ingest_tiktok_comments(p_workspace_id uuid,p_channel_id uuid,p_revision bigint,p_lease_token uuid,p_session_id uuid,p_comments jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.live_channel_connections;r jsonb;previous text:=current_setting('app_private.tiktok_ingest_token',true);
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 select * into c from public.live_channel_connections where workspace_id=p_workspace_id and channel_id=p_channel_id;
 if not found or c.revision<>p_revision or c.lease_token is distinct from p_lease_token or p_lease_token is null or c.lease_actor<>auth.uid()
  or c.lease_expires_at<=clock_timestamp() or c.desired_state<>'connected' or c.connection_status<>'LIVE' or c.current_session_id is distinct from p_session_id then
  raise exception 'TIKTOK_INGEST_STALE: Listener không còn quyền nhận bình luận cho phiên này.';
 end if;
 perform set_config('app_private.tiktok_ingest_token',p_lease_token::text,true);
 r:=public.ingest_live_comments_v2(p_workspace_id,p_session_id,p_comments);
 perform set_config('app_private.tiktok_ingest_token',coalesce(previous,''),true);return r;
end $$;

do $$declare t text;begin
 foreach t in array array['live_channel_connections','live_channel_commands','live_channel_campaigns','live_channel_sessions'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('create policy member_read on public.%I for select to authenticated using(app_private.member_role(workspace_id) is not null)',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  if t<>'live_channel_connections' then execute format('grant select on public.%I to authenticated',t);end if;
 end loop;
end $$;
grant select(workspace_id,channel_id,desired_state,connection_status,revision,requested_by,requested_at,current_session_id,provider_room_id,heartbeat_at,connected_since,message_code)
 on public.live_channel_connections to authenticated;
revoke all on function app_private.guard_channel_ingestion(),app_private.protect_tiktok_channel() from public,anon,authenticated;
revoke all on function public.save_tiktok_channel(uuid,jsonb,uuid),public.request_tiktok_connection(uuid,uuid,text,uuid),
 public.claim_tiktok_connection(uuid,uuid,bigint),public.report_tiktok_connection(uuid,uuid,bigint,uuid,text,text),public.get_tiktok_channels(uuid),public.ingest_tiktok_comments(uuid,uuid,bigint,uuid,uuid,jsonb) from public,anon;
grant execute on function public.save_tiktok_channel(uuid,jsonb,uuid),public.request_tiktok_connection(uuid,uuid,text,uuid),
 public.claim_tiktok_connection(uuid,uuid,bigint),public.report_tiktok_connection(uuid,uuid,bigint,uuid,text,text),public.get_tiktok_channels(uuid),public.ingest_tiktok_comments(uuid,uuid,bigint,uuid,uuid,jsonb) to authenticated;
-- Do not publish lease tokens. Seller UI refreshes via checked read RPC/polling.
do $$begin
 if exists(select 1 from pg_publication where puballtables) then raise exception 'TIKTOK_PUBLICATION: Use explicit publication tables; listener lease tokens must remain private.';end if;
end $$;
commit;
