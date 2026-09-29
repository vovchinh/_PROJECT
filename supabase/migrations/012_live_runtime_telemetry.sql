-- Runtime observations only. Apply once after 011; no historical business rows
-- or routines are rewritten. Viewer/member events never create a sale or hold.
begin;

do $$begin
 if to_regprocedure('public.finish_tiktok_live(uuid,uuid,bigint,uuid,uuid)') is null
   or to_regprocedure('public.ingest_tiktok_comments(uuid,uuid,bigint,uuid,uuid,jsonb)') is null then
  raise exception 'LIVE_RUNTIME_PREREQUISITE: Apply 010 and 011 before 012.';
 end if;
end $$;

create table public.live_listener_health (
 workspace_id uuid not null references public.workspaces(id),instance_id uuid not null,
 reported_by uuid not null references auth.users(id),ready boolean not null,
 provider_version text not null check(provider_version='2.5.0'),
 active_listener_count integer not null check(active_listener_count between 0 and 1000),
 last_error_code text check(last_error_code in(
  'TIKTOK_USER_INVALID','TIKTOK_NOT_LIVE','TIKTOK_ROOM_LOOKUP_FAILED','TIKTOK_CONNECT_TIMEOUT',
  'TIKTOK_WEBSOCKET_FAILED','TIKTOK_PROVIDER_RATE_LIMITED','TIKTOK_SIGNING_REQUIRED',
  'TIKTOK_PROVIDER_ACCESS_DENIED','TIKTOK_PROVIDER_UNAVAILABLE','TIKTOK_PROVIDER_PROTOCOL_CHANGED',
  'TIKTOK_PROVIDER_VERSION_MISMATCH','TIKTOK_PROVIDER_PACKAGE_MISSING','TIKTOK_ROOM_CHANGED',
  'TIKTOK_LISTENER_OFFLINE','TIKTOK_SESSION_CONFLICT','TIKTOK_SUPABASE_UNAVAILABLE',
  'TIKTOK_INGEST_FAILED','SUPABASE_INGEST_FAILED','CHANNEL_CONTROL_UNAVAILABLE',
  'CHANNEL_RETRY_LIMIT','CHANNEL_END_REPORT_PENDING')),
 started_at timestamptz not null default clock_timestamp(),heartbeat_at timestamptz not null default clock_timestamp(),
 primary key(workspace_id,instance_id),check(isfinite(started_at) and isfinite(heartbeat_at) and heartbeat_at>=started_at)
);
create index live_listener_health_latest on public.live_listener_health(workspace_id,heartbeat_at desc);

create table public.live_session_telemetry (
 workspace_id uuid not null references public.workspaces(id),session_id uuid not null,
 current_viewer_count integer check(current_viewer_count>=0),peak_viewer_count integer check(peak_viewer_count>=0),
 last_viewer_update_at timestamptz,last_provider_event_at timestamptz,last_member_at timestamptz,
 member_event_count bigint not null default 0 check(member_event_count between 0 and 9007199254740991),
 updated_at timestamptz not null default clock_timestamp(),primary key(workspace_id,session_id),
 foreign key(workspace_id,session_id) references public.live_sessions(workspace_id,id),
 check((current_viewer_count is null and peak_viewer_count is null and last_viewer_update_at is null)
    or(current_viewer_count is not null and peak_viewer_count is not null and last_viewer_update_at is not null
       and peak_viewer_count>=current_viewer_count)),
 check(isfinite(last_viewer_update_at) and isfinite(last_provider_event_at) and isfinite(last_member_at))
);
-- Compact immutable receipts preserve deduplication without storing raw packets,
-- usernames or member identities. No silent expiry that would recount a retry.
create table app_private.live_runtime_event_keys (
 workspace_id uuid not null references public.workspaces(id),session_id uuid not null,
 event_type text not null check(event_type in('VIEWER_COUNT','MEMBER_JOIN')),
 event_id text not null check(length(event_id) between 1 and 200),occurred_at timestamptz not null check(isfinite(occurred_at)),
 viewer_count integer,received_at timestamptz not null default clock_timestamp(),
 primary key(workspace_id,session_id,event_type,event_id),
 foreign key(workspace_id,session_id) references public.live_sessions(workspace_id,id),
 check((event_type='VIEWER_COUNT' and viewer_count is not null and viewer_count>=0)
    or(event_type='MEMBER_JOIN' and viewer_count is null))
);
create index live_runtime_latest_viewer on app_private.live_runtime_event_keys
 (workspace_id,session_id,event_type,occurred_at desc,event_id collate "C" desc);
create index live_comments_runtime_event_time on public.live_comments(workspace_id,session_id,occurred_at desc);

alter table public.live_listener_health enable row level security;
alter table public.live_session_telemetry enable row level security;
alter table app_private.live_runtime_event_keys enable row level security;
create policy manager_read on public.live_listener_health for select to authenticated
 using(app_private.member_role(workspace_id) in('owner','manager'));
create policy member_read on public.live_session_telemetry for select to authenticated
 using(app_private.member_role(workspace_id) is not null);
revoke all on public.live_listener_health,public.live_session_telemetry,app_private.live_runtime_event_keys from public,anon,authenticated;
grant select on public.live_listener_health,public.live_session_telemetry to authenticated;

create function public.report_live_listener_health(p_workspace_id uuid,p_instance_id uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare error_code text;count_value numeric;stamp timestamptz;prior_actor uuid;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 if p_instance_id is null or jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>4096 then
  raise exception 'LIVE_HEALTH_INPUT: Cần instance UUID và payload hợp lệ.';
 end if;
 if exists(select 1 from jsonb_object_keys(p_payload) k where k not in('ready','provider_version','active_listener_count','last_error_code'))
   or jsonb_typeof(p_payload->'ready') is distinct from 'boolean'
   or jsonb_typeof(p_payload->'provider_version') is distinct from 'string' or p_payload->>'provider_version'<>'2.5.0'
   or jsonb_typeof(p_payload->'active_listener_count') is distinct from 'number'
   or(p_payload?'last_error_code' and jsonb_typeof(p_payload->'last_error_code') not in('string','null')) then
  raise exception 'LIVE_HEALTH_INPUT: Chỉ nhận trạng thái chuẩn hóa; không nhận credential hoặc lỗi thô.';
 end if;
 count_value:=(p_payload->>'active_listener_count')::numeric;
 if count_value<>trunc(count_value) or count_value<0 or count_value>1000 then
  raise exception 'LIVE_HEALTH_COUNT: Số listener phải là số nguyên từ 0 đến 1000.';
 end if;
 error_code:=p_payload->>'last_error_code';
 if error_code is not null and error_code not in(
  'TIKTOK_USER_INVALID','TIKTOK_NOT_LIVE','TIKTOK_ROOM_LOOKUP_FAILED','TIKTOK_CONNECT_TIMEOUT',
  'TIKTOK_WEBSOCKET_FAILED','TIKTOK_PROVIDER_RATE_LIMITED','TIKTOK_SIGNING_REQUIRED',
  'TIKTOK_PROVIDER_ACCESS_DENIED','TIKTOK_PROVIDER_UNAVAILABLE','TIKTOK_PROVIDER_PROTOCOL_CHANGED',
  'TIKTOK_PROVIDER_VERSION_MISMATCH','TIKTOK_PROVIDER_PACKAGE_MISSING','TIKTOK_ROOM_CHANGED',
  'TIKTOK_LISTENER_OFFLINE','TIKTOK_SESSION_CONFLICT','TIKTOK_SUPABASE_UNAVAILABLE',
  'TIKTOK_INGEST_FAILED','SUPABASE_INGEST_FAILED','CHANNEL_CONTROL_UNAVAILABLE',
  'CHANNEL_RETRY_LIMIT','CHANNEL_END_REPORT_PENDING') then
  raise exception 'LIVE_HEALTH_CODE: Mã chẩn đoán không nằm trong danh sách cho phép.';
 end if;
 select reported_by into prior_actor from public.live_listener_health
  where workspace_id=p_workspace_id and instance_id=p_instance_id;
 if found and prior_actor<>auth.uid() then raise exception 'LIVE_HEALTH_ACTOR: Instance thuộc người vận hành khác.';end if;
 if prior_actor is null and(select count(*) from public.live_listener_health where workspace_id=p_workspace_id)>=1000 then
  raise exception 'LIVE_HEALTH_LIMIT: Cần đối chiếu lịch sử instance trước khi tạo thêm.';
 end if;
 stamp:=clock_timestamp();
 insert into public.live_listener_health(workspace_id,instance_id,reported_by,ready,provider_version,active_listener_count,last_error_code,started_at,heartbeat_at)
 values(p_workspace_id,p_instance_id,auth.uid(),(p_payload->>'ready')::boolean,'2.5.0',count_value::integer,error_code,stamp,stamp)
 on conflict(workspace_id,instance_id) do update set ready=excluded.ready,active_listener_count=excluded.active_listener_count,
  last_error_code=excluded.last_error_code,heartbeat_at=excluded.heartbeat_at;
 return jsonb_build_object('instance_id',p_instance_id,'heartbeat_at',stamp);
end $$;

-- Callers own the workspace lock and verify actor/provider/fence before entering.
create function app_private.ingest_live_runtime_events(p_workspace_id uuid,p_session_id uuid,p_events jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare event jsonb;kind text;key text;time_text text;occurred timestamptz;count_value numeric;viewers integer;
 prior app_private.live_runtime_event_keys;inserted_count integer:=0;duplicate_count integer:=0;
begin
 if jsonb_typeof(p_events) is distinct from 'array' then raise exception 'LIVE_EVENT_BATCH: Cần mảng sự kiện.';end if;
 if jsonb_array_length(p_events) not between 1 and 100 or octet_length(p_events::text)>131072 then
  raise exception 'LIVE_EVENT_BATCH: Chỉ nhận 1–100 sự kiện chuẩn hóa trong một batch.';
 end if;
 if not exists(select 1 from public.live_sessions s join public.live_campaigns c on c.workspace_id=s.workspace_id and c.id=s.campaign_id
   where s.workspace_id=p_workspace_id and s.id=p_session_id and s.status='live' and c.status='active') then
  raise exception 'LIVE_EVENT_SESSION: Cần phiên LIVE thuộc chiến dịch đang mở trong workspace.';
 end if;
 for event in select value from jsonb_array_elements(p_events) loop
  if jsonb_typeof(event) is distinct from 'object' then raise exception 'LIVE_EVENT_INPUT: Sự kiện phải là object.';end if;
  if exists(select 1 from jsonb_object_keys(event) k where k not in('type','event_id','occurred_at','viewer_count')) then
   raise exception 'LIVE_EVENT_INPUT: Không nhận raw payload hoặc thông tin cá nhân.';
  end if;
  kind:=app_private.live_text(event,'type',20);
  if kind not in('VIEWER_COUNT','MEMBER_JOIN') then raise exception 'LIVE_EVENT_TYPE: Loại sự kiện không hỗ trợ.';end if;
  key:=app_private.live_text(event,'event_id',200);
  if key<>event->>'event_id' then raise exception 'LIVE_EVENT_ID: ID nguồn không được có khoảng trắng ngoài.';end if;
  time_text:=app_private.live_text(event,'occurred_at',40);
  if time_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$' then
   raise exception 'LIVE_EVENT_TIME: Cần thời điểm ISO 8601 có múi giờ.';
  end if;
  begin occurred:=time_text::timestamptz;
  exception when others then raise exception 'LIVE_EVENT_TIME: Thời điểm sự kiện không hợp lệ.';end;
  if not isfinite(occurred) or occurred<'1900-01-01T00:00:00Z'::timestamptz or occurred>clock_timestamp()+interval '5 minutes' then
   raise exception 'LIVE_EVENT_TIME: Thời điểm sự kiện vượt giới hạn cho phép.';
  end if;
  viewers:=null;
  if kind='VIEWER_COUNT' then
   if jsonb_typeof(event->'viewer_count') is distinct from 'number' then
    raise exception 'LIVE_EVENT_VIEWERS: Số người xem phải là số nguyên không âm.';
   end if;
   count_value:=(event->>'viewer_count')::numeric;
   if count_value<>trunc(count_value) or count_value<0 or count_value>2147483647 then
    raise exception 'LIVE_EVENT_VIEWERS: Số người xem nằm ngoài giới hạn số nguyên.';
   end if;
   viewers:=count_value::integer;
  elsif event?'viewer_count' then raise exception 'LIVE_EVENT_MEMBER: MEMBER_JOIN không có viewer_count.';
  end if;
  select * into prior from app_private.live_runtime_event_keys
   where workspace_id=p_workspace_id and session_id=p_session_id and event_type=kind and event_id=key;
  if found then
   if prior.occurred_at is distinct from occurred or prior.viewer_count is distinct from viewers then
    raise exception 'LIVE_EVENT_CONFLICT: ID sự kiện đã có nội dung khác; batch không được ghi.';
   end if;
   duplicate_count:=duplicate_count+1;continue;
  end if;
  insert into app_private.live_runtime_event_keys(workspace_id,session_id,event_type,event_id,occurred_at,viewer_count)
   values(p_workspace_id,p_session_id,kind,key,occurred,viewers);
  insert into public.live_session_telemetry(workspace_id,session_id) values(p_workspace_id,p_session_id)
   on conflict(workspace_id,session_id) do nothing;
  if kind='VIEWER_COUNT' then
   update public.live_session_telemetry t set
    -- Equal provider timestamps have no reliable real-world ordering. Break ties
    -- by event_id in C collation so retries/arrival order cannot change the result.
    current_viewer_count=(select e.viewer_count from app_private.live_runtime_event_keys e
     where e.workspace_id=p_workspace_id and e.session_id=p_session_id and e.event_type='VIEWER_COUNT'
     order by e.occurred_at desc,e.event_id collate "C" desc limit 1),
    peak_viewer_count=greatest(t.peak_viewer_count,viewers),last_viewer_update_at=greatest(t.last_viewer_update_at,occurred),
    last_provider_event_at=greatest(t.last_provider_event_at,occurred),updated_at=clock_timestamp()
    where t.workspace_id=p_workspace_id and t.session_id=p_session_id;
  else
   update public.live_session_telemetry set member_event_count=member_event_count+1,
    last_member_at=greatest(last_member_at,occurred),last_provider_event_at=greatest(last_provider_event_at,occurred),updated_at=clock_timestamp()
    where workspace_id=p_workspace_id and session_id=p_session_id;
  end if;
  inserted_count:=inserted_count+1;
 end loop;
 return jsonb_build_object('inserted',inserted_count,'duplicates',duplicate_count);
end $$;

create function public.ingest_live_events(p_workspace_id uuid,p_session_id uuid,p_events jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager','staff']);
 if not exists(select 1 from public.live_sessions where workspace_id=p_workspace_id and id=p_session_id and provider in('manual','simulator')) then
  raise exception 'LIVE_EVENT_PROVIDER: Đường này chỉ dành cho phiên thủ công/mô phỏng.';
 end if;
 return app_private.ingest_live_runtime_events(p_workspace_id,p_session_id,p_events);
end $$;

create function public.ingest_tiktok_events(p_workspace_id uuid,p_channel_id uuid,p_revision bigint,p_lease_token uuid,p_session_id uuid,p_events jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.live_channel_connections;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 select * into c from public.live_channel_connections where workspace_id=p_workspace_id and channel_id=p_channel_id;
 if not found or c.revision is distinct from p_revision or p_lease_token is null or c.lease_token is distinct from p_lease_token
  or c.lease_actor is distinct from auth.uid() or c.lease_expires_at is null or c.lease_expires_at<=clock_timestamp()
  or c.desired_state<>'connected' or c.connection_status<>'LIVE' or c.current_session_id is distinct from p_session_id then
  raise exception 'TIKTOK_EVENT_STALE: Listener không còn quyền nhận sự kiện cho phiên này.';
 end if;
 if not exists(select 1 from public.live_sessions s join public.live_integration_accounts a
   on a.workspace_id=s.workspace_id and a.id=s.integration_account_id
   where s.workspace_id=p_workspace_id and s.id=p_session_id and s.provider='tiktok_live' and a.id=p_channel_id and a.enabled) then
  raise exception 'TIKTOK_EVENT_SESSION: Phiên không thuộc kênh TikTok đang hoạt động.';
 end if;
 return app_private.ingest_live_runtime_events(p_workspace_id,p_session_id,p_events);
end $$;

create function public.get_live_runtime(p_workspace_id uuid,p_session_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare h public.live_listener_health;t public.live_session_telemetry;role_name text;stamp timestamptz:=clock_timestamp();
 online_value boolean;ready_value boolean;heartbeat timestamptz;comment_at timestamptz;comment_received_at timestamptz;telemetry jsonb;diagnostics jsonb;
begin
 perform app_private.require_role(p_workspace_id,array['owner','manager','staff','viewer']);
 role_name:=app_private.member_role(p_workspace_id);
 if p_session_id is not null and not exists(select 1 from public.live_sessions where workspace_id=p_workspace_id and id=p_session_id) then
  raise exception 'LIVE_RUNTIME_SESSION: Phiên không thuộc workspace.';
 end if;
 select coalesce(bool_or(heartbeat_at>=stamp-interval '45 seconds'),false),
  coalesce(bool_or(ready and heartbeat_at>=stamp-interval '45 seconds'),false),max(heartbeat_at)
  into online_value,ready_value,heartbeat from public.live_listener_health where workspace_id=p_workspace_id;
 if role_name in('owner','manager') then
  select * into h from public.live_listener_health where workspace_id=p_workspace_id
   order by (ready and heartbeat_at>=stamp-interval '45 seconds') desc,heartbeat_at desc,instance_id limit 1;
  if found then diagnostics:=jsonb_build_object('provider_version',h.provider_version,'last_error_code',h.last_error_code,
   'active_listener_count',h.active_listener_count,'started_at',h.started_at,'heartbeat_at',h.heartbeat_at);end if;
 end if;
 if p_session_id is not null then
  select * into t from public.live_session_telemetry where workspace_id=p_workspace_id and session_id=p_session_id;
  select occurred_at into comment_at from public.live_comments where workspace_id=p_workspace_id and session_id=p_session_id order by occurred_at desc limit 1;
  select received_at into comment_received_at from public.live_comments where workspace_id=p_workspace_id and session_id=p_session_id order by received_at desc,id desc limit 1;
  if t.session_id is not null or comment_at is not null then
   telemetry:=jsonb_build_object('session_id',p_session_id,'current_viewer_count',t.current_viewer_count,'peak_viewer_count',t.peak_viewer_count,
    'last_viewer_update_at',t.last_viewer_update_at,'last_provider_event_at',greatest(t.last_provider_event_at,comment_at),
    'last_member_at',t.last_member_at,'member_event_count',coalesce(t.member_event_count,0),
    'last_ingest_at',greatest(t.updated_at,comment_received_at));
  end if;
 end if;
 return jsonb_build_object('listener',jsonb_build_object('online',online_value,'ready',ready_value,'heartbeat_at',heartbeat),
  'telemetry',telemetry,'diagnostics',diagnostics);
end $$;

revoke all on function app_private.ingest_live_runtime_events(uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.report_live_listener_health(uuid,uuid,jsonb),public.get_live_runtime(uuid,uuid),
 public.ingest_live_events(uuid,uuid,jsonb),public.ingest_tiktok_events(uuid,uuid,bigint,uuid,uuid,jsonb) from public,anon;
grant execute on function public.report_live_listener_health(uuid,uuid,jsonb),public.get_live_runtime(uuid,uuid),
 public.ingest_live_events(uuid,uuid,jsonb),public.ingest_tiktok_events(uuid,uuid,bigint,uuid,uuid,jsonb) to authenticated;

-- Telemetry has no tokens, identities or raw packets. Health diagnostics remain
-- admin-only through RLS; do not publish that table or any private receipts.
do $$begin
 if exists(select 1 from pg_publication where puballtables) then
  raise exception 'LIVE_RUNTIME_PUBLICATION: Use explicit tables, never FOR ALL TABLES with private listener data.';
 end if;
 if exists(select 1 from pg_publication where pubname='supabase_realtime') and not exists(
  select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='live_session_telemetry') then
  execute 'alter publication supabase_realtime add table public.live_session_telemetry';
 end if;
end $$;

commit;
