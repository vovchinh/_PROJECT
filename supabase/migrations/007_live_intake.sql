-- Phase C intake only: comments are observations, never sales or stock holds.
-- Apply once after 001..006. No external credentials or provider API calls.
begin;

do $$begin
 if to_regprocedure('public.reserve_inventory(uuid,jsonb,uuid)') is null
   or to_regprocedure('public.get_customer_foundation(uuid)') is null
   or to_regprocedure('public.resolve_product_alias(uuid,text)') is null then
  raise exception 'LIVE_PREREQUISITE: Complete migrations 004, 005 and 006 before 007.';
 end if;
end $$;

create table public.live_integration_accounts (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id),
 name text not null check(length(name) between 1 and 200),
 username text not null check(username ~ '^[a-z0-9_][a-z0-9_.]{0,23}$' and username !~ '\.$'),
 provider text not null default 'tiktok_live' check(provider='tiktok_live'),
 enabled boolean not null default true,
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(workspace_id,id),unique(workspace_id,username)
);
create table public.live_campaigns (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id),
 code text not null check(length(code) between 1 and 80),name text not null check(length(name) between 1 and 200),
 warehouse_id uuid not null,status text not null default 'draft' check(status in('draft','active','closed')),
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(workspace_id,id),unique(workspace_id,code),
 foreign key(workspace_id,warehouse_id) references public.warehouses(workspace_id,id)
);
create table public.live_sessions (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id),campaign_id uuid not null,
 code text not null check(length(code) between 1 and 80),title text not null check(length(title) between 1 and 200),
 provider text not null check(provider in('manual','simulator','tiktok_live')),
 room_id text not null default '' check(length(room_id)<=200),integration_account_id uuid,
 status text not null default 'draft' check(status in('draft','live','ended')),
 connection_status text not null default 'disconnected' check(connection_status in('disconnected','connecting','connected','error')),
 heartbeat_at timestamptz,connection_message text not null default '' check(length(connection_message)<=200),
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(workspace_id,id),unique(workspace_id,code),unique(workspace_id,campaign_id,id),
 foreign key(workspace_id,campaign_id) references public.live_campaigns(workspace_id,id),
 foreign key(workspace_id,integration_account_id) references public.live_integration_accounts(workspace_id,id),
 check((provider='tiktok_live' and integration_account_id is not null and room_id<>'')
    or(provider in('manual','simulator') and integration_account_id is null))
);
create table public.live_comments (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id),campaign_id uuid not null,session_id uuid not null,
 provider_message_id text not null check(length(provider_message_id) between 1 and 200),
 author_external_id text not null check(length(author_external_id) between 1 and 200),
 author_display_name text not null check(length(author_display_name) between 1 and 200),
 raw_text text not null check(length(raw_text) between 1 and 2000),
 occurred_at timestamptz not null check(isfinite(occurred_at)),received_at timestamptz not null default clock_timestamp(),
 payload_hash text not null,state text not null default 'new' check(state in('new','committed','voided')),
 unique(workspace_id,id),unique(workspace_id,session_id,provider_message_id),
 foreign key(workspace_id,campaign_id,session_id) references public.live_sessions(workspace_id,campaign_id,id)
);
create table public.live_comment_claims (
 workspace_id uuid not null references public.workspaces(id),comment_id uuid not null,
 claimed_by uuid not null references auth.users(id),claim_token uuid not null default gen_random_uuid(),
 expires_at timestamptz not null,created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),primary key(workspace_id,comment_id),
 foreign key(workspace_id,comment_id) references public.live_comments(workspace_id,id),
 check(isfinite(expires_at))
);
create index live_comments_keyset on public.live_comments(workspace_id,received_at desc,id desc);
create index live_comments_session_keyset on public.live_comments(workspace_id,session_id,received_at desc,id desc);
create index live_sessions_campaign on public.live_sessions(workspace_id,campaign_id,status);
create index live_sessions_account on public.live_sessions(workspace_id,integration_account_id);
create index live_claims_expiry on public.live_comment_claims(workspace_id,expires_at);

do $$declare t text;begin
 foreach t in array array['live_integration_accounts','live_campaigns','live_sessions','live_comments','live_comment_claims'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('create policy member_read on public.%I for select to authenticated using(app_private.member_role(workspace_id) is not null)',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  if t<>'live_comment_claims' then execute format('grant select on public.%I to authenticated',t);end if;
 end loop;
end $$;
-- A claim token is returned only to its holder by checked RPCs. Other staff see
-- who holds the lease without reading its token through REST or Realtime.
grant select(workspace_id,comment_id,claimed_by,expires_at,created_at,updated_at)
 on public.live_comment_claims to authenticated;

create function app_private.live_text(p_payload jsonb,p_key text,p_max integer,p_required boolean default true)
returns text language plpgsql immutable set search_path='' as $$
declare value text;
begin
 if jsonb_typeof(p_payload) is distinct from 'object'
  or (p_payload?p_key and jsonb_typeof(p_payload->p_key) is distinct from 'string') then
  raise exception 'LIVE_TEXT: Trường % phải là chuỗi ký tự.',p_key;
 end if;
 value:=p_payload->>p_key;
 if length(value)>p_max then raise exception 'LIVE_TEXT: Trường % vượt độ dài cho phép.',p_key;end if;
 if value ~ U&'[\0001-\001F\007F-\009F\202A-\202E\2066-\2069]' then
  raise exception 'LIVE_TEXT: Trường % chứa ký tự điều khiển không hợp lệ.',p_key;
 end if;
 value:=app_private.foundation_text(p_payload,p_key,p_max,p_required);
 return value;
end $$;

create function public.save_live_integration_account(p_workspace_id uuid,p_payload jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare rid uuid;n text;handle text;enabled_value boolean;old public.live_integration_accounts;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 rid:=nullif(p_payload->>'id','')::uuid;
 n:=app_private.live_text(p_payload,'name',200);
 handle:=lower(app_private.live_text(p_payload,'username',25));
 if left(handle,1)='@' then handle:=substr(handle,2);end if;
 if handle !~ '^[a-z0-9_][a-z0-9_.]{0,23}$' or handle ~ '\.$' then
  raise exception 'LIVE_ACCOUNT: Nhập username TikTok gồm chữ, số, dấu chấm hoặc gạch dưới, tối đa 24 ký tự; không nhập URL hay mật khẩu.';
 end if;
 enabled_value:=app_private.foundation_boolean(p_payload,'enabled',true);
 if rid is not null then
  select * into old from public.live_integration_accounts where workspace_id=p_workspace_id and id=rid for update;
  if not found then raise exception 'LIVE_ACCOUNT: Không tìm thấy tài khoản trong workspace.';end if;
  if old.username<>handle and exists(select 1 from public.live_sessions where workspace_id=p_workspace_id and integration_account_id=rid) then
   raise exception 'LIVE_ACCOUNT: Tài khoản đã có phiên; không đổi username làm thay đổi lịch sử phòng live.';
  end if;
 else rid:=gen_random_uuid();end if;
 insert into public.live_integration_accounts(id,workspace_id,name,username,enabled,created_by)
 values(rid,p_workspace_id,n,handle,enabled_value,auth.uid())
 on conflict(id) do update set name=excluded.name,username=excluded.username,enabled=excluded.enabled,updated_at=clock_timestamp();
 if not enabled_value then
  update public.live_sessions set connection_status='disconnected',connection_message='Đã tắt tài khoản kết nối.',updated_at=clock_timestamp()
   where workspace_id=p_workspace_id and integration_account_id=rid;
 end if;
 perform app_private.audit(p_workspace_id,'live_account.saved',rid,jsonb_build_object('enabled',enabled_value));
 return rid;
end $$;

create function public.save_live_campaign(p_workspace_id uuid,p_payload jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare rid uuid;c text;n text;hid uuid;status_value text;old public.live_campaigns;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 rid:=nullif(p_payload->>'id','')::uuid;c:=upper(app_private.live_text(p_payload,'code',80));
 n:=app_private.live_text(p_payload,'name',200);hid:=(p_payload->>'warehouse_id')::uuid;
 status_value:=app_private.live_text(p_payload,'status',20);
 if status_value not in('draft','active','closed') then raise exception 'LIVE_CAMPAIGN: Trạng thái không hợp lệ.';end if;
 if not exists(select 1 from public.warehouses where workspace_id=p_workspace_id and id=hid) then raise exception 'LIVE_CAMPAIGN: Kho không thuộc workspace.';end if;
 if rid is not null then
  select * into old from public.live_campaigns where workspace_id=p_workspace_id and id=rid for update;
  if not found then raise exception 'LIVE_CAMPAIGN: Không tìm thấy chiến dịch.';end if;
  if c<>old.code then raise exception 'LIVE_CAMPAIGN: Không đổi mã chiến dịch đã tạo.';end if;
  if (old.status='closed' and status_value<>'closed') or(old.status='active' and status_value='draft') then raise exception 'LIVE_CAMPAIGN: Không quay lại trạng thái trước.';end if;
  if hid<>old.warehouse_id and exists(select 1 from public.live_sessions where workspace_id=p_workspace_id and campaign_id=rid) then raise exception 'LIVE_CAMPAIGN: Chiến dịch đã có phiên; không đổi kho.';end if;
 else rid:=gen_random_uuid();end if;
 if status_value='closed' and exists(select 1 from public.live_sessions where workspace_id=p_workspace_id and campaign_id=rid and status='live') then
  raise exception 'LIVE_CAMPAIGN: Kết thúc các phiên đang live trước khi đóng chiến dịch.';
 end if;
 insert into public.live_campaigns(id,workspace_id,code,name,warehouse_id,status,created_by)
 values(rid,p_workspace_id,c,n,hid,status_value,auth.uid())
 on conflict(id) do update set name=excluded.name,warehouse_id=excluded.warehouse_id,status=excluded.status,updated_at=clock_timestamp();
 perform app_private.audit(p_workspace_id,'live_campaign.saved',rid,jsonb_build_object('status',status_value,'warehouse_id',hid));return rid;
end $$;

create function public.save_live_session(p_workspace_id uuid,p_payload jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare rid uuid;cid uuid;account_id uuid;c text;t text;provider_value text;room_value text;status_value text;
 old public.live_sessions;campaign public.live_campaigns;account public.live_integration_accounts;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 rid:=nullif(p_payload->>'id','')::uuid;cid:=(p_payload->>'campaign_id')::uuid;
 account_id:=nullif(p_payload->>'integration_account_id','')::uuid;
 c:=upper(app_private.live_text(p_payload,'code',80));t:=app_private.live_text(p_payload,'title',200);
 provider_value:=app_private.live_text(p_payload,'provider',30);room_value:=app_private.live_text(p_payload,'room_id',200,false);
 status_value:=app_private.live_text(p_payload,'status',20);
 if provider_value not in('manual','simulator','tiktok_live') or status_value not in('draft','live','ended') then raise exception 'LIVE_SESSION: Provider hoặc trạng thái không hợp lệ.';end if;
 select * into campaign from public.live_campaigns where workspace_id=p_workspace_id and id=cid;
 if not found then raise exception 'LIVE_SESSION: Chiến dịch không thuộc workspace.';end if;
 if rid is not null then
  select * into old from public.live_sessions where workspace_id=p_workspace_id and id=rid for update;
  if not found then raise exception 'LIVE_SESSION: Không tìm thấy phiên live.';end if;
  if c<>old.code or cid<>old.campaign_id or provider_value<>old.provider
   or account_id is distinct from old.integration_account_id or room_value<>old.room_id then
   raise exception 'LIVE_SESSION: Không đổi mã, chiến dịch, provider, tài khoản hoặc phòng của phiên đã tạo.';
  end if;
  if(old.status='ended' and status_value<>'ended') or(old.status='live' and status_value='draft') then raise exception 'LIVE_SESSION: Không quay lại trạng thái trước.';end if;
 else
  if campaign.status='closed' then raise exception 'LIVE_SESSION: Chiến dịch đã đóng.';end if;
  rid:=gen_random_uuid();
 end if;
 if status_value='live' and campaign.status<>'active' then raise exception 'LIVE_SESSION: Chỉ bắt đầu live trong chiến dịch đang hoạt động.';end if;
 if provider_value='tiktok_live' then
  select * into account from public.live_integration_accounts where workspace_id=p_workspace_id and id=account_id;
  if not found or room_value<>account.username then raise exception 'LIVE_SESSION: Phòng phải khớp username của tài khoản TikTok trong workspace.';end if;
  if not account.enabled and status_value<>'ended' then raise exception 'LIVE_SESSION: Tài khoản TikTok đã tắt.';end if;
 elsif account_id is not null then raise exception 'LIVE_SESSION: Phiên thủ công/mô phỏng không dùng tài khoản TikTok.';end if;
 insert into public.live_sessions(id,workspace_id,campaign_id,code,title,provider,room_id,integration_account_id,status,created_by)
 values(rid,p_workspace_id,cid,c,t,provider_value,room_value,account_id,status_value,auth.uid())
 on conflict(id) do update set title=excluded.title,status=excluded.status,
  connection_status=case when excluded.status='ended' then 'disconnected' else live_sessions.connection_status end,
  connection_message=case when excluded.status='ended' then 'Phiên đã kết thúc.' else live_sessions.connection_message end,updated_at=clock_timestamp();
 perform app_private.audit(p_workspace_id,'live_session.saved',rid,jsonb_build_object('status',status_value,'provider',provider_value));return rid;
end $$;

create function public.report_live_connection(p_workspace_id uuid,p_session_id uuid,p_status text,p_message text default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare s public.live_sessions;message_code text;safe_message text;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 if p_status is null or p_status not in('disconnected','connecting','connected','error') then raise exception 'LIVE_CONNECTION: Trạng thái không hợp lệ.';end if;
 message_code:=coalesce(nullif(p_message,''),case when p_status='error' then 'connection_failed' else p_status end);
 safe_message:=case message_code
  when 'connecting' then 'Đang kết nối phòng live.' when 'connected' then 'Đã kết nối phòng live.'
  when 'disconnected' then 'Chưa kết nối phòng live.' when 'connection_failed' then 'Kết nối thất bại; kiểm tra worker.'
  when 'provider_ready' then 'Nguồn kết nối đã sẵn sàng.'
  when 'room_not_live' then 'Tài khoản chưa phát live.' when 'retrying' then 'Đang thử kết nối lại.'
  when 'stopped' then 'Đã dừng kết nối.' when 'waiting_for_live' then 'Đang chờ phiên live.'
  when 'provider_unavailable' then 'Nguồn bình luận hiện không khả dụng.' end;
 if safe_message is null then raise exception 'LIVE_CONNECTION: Chỉ gửi mã trạng thái cho phép; không gửi lỗi thô, cookie hoặc token của provider.';end if;
 select * into s from public.live_sessions where workspace_id=p_workspace_id and id=p_session_id for update;
 if not found then raise exception 'LIVE_CONNECTION: Không tìm thấy phiên live.';end if;
 if s.status='ended' and p_status<>'disconnected' then raise exception 'LIVE_CONNECTION: Phiên đã kết thúc; kết nối phải dừng.';end if;
 if p_status in('connecting','connected') then
  if s.status<>'live' or not exists(select 1 from public.live_campaigns where workspace_id=p_workspace_id and id=s.campaign_id and status='active') then
   raise exception 'LIVE_CONNECTION: Phiên hoặc chiến dịch chưa hoạt động.';
  end if;
  if s.provider='tiktok_live' and not exists(select 1 from public.live_integration_accounts where workspace_id=p_workspace_id and id=s.integration_account_id and enabled) then
   raise exception 'LIVE_CONNECTION: Tài khoản kết nối đã tắt.';
  end if;
 end if;
 update public.live_sessions set connection_status=p_status,connection_message=safe_message,heartbeat_at=clock_timestamp(),updated_at=clock_timestamp()
  where workspace_id=p_workspace_id and id=p_session_id;
 if s.connection_status<>p_status or s.connection_message<>safe_message then
  perform app_private.audit(p_workspace_id,'live_session.connection_changed',s.id,jsonb_build_object('status',p_status,'message_code',message_code));
 end if;
 return s.id;
end $$;

create function public.ingest_live_comments(p_workspace_id uuid,p_session_id uuid,p_comments jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.live_sessions;r jsonb;old public.live_comments;rid uuid;message_id text;author_id text;display_name text;
 comment_text text;time_text text;occurred timestamptz;fingerprint text;inserted_count integer:=0;duplicate_count integer:=0;ids jsonb:='[]'::jsonb;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager','staff']);
 if jsonb_typeof(p_comments) is distinct from 'array' or jsonb_array_length(p_comments) not between 1 and 100 then
  raise exception 'LIVE_BATCH: Mỗi lần nhận từ 1 đến 100 bình luận.';
 end if;
 select * into s from public.live_sessions where workspace_id=p_workspace_id and id=p_session_id for update;
 if not found then raise exception 'LIVE_SESSION: Phiên không thuộc workspace.';end if;
 for r in select value from jsonb_array_elements(p_comments) loop
  message_id:=app_private.live_text(r,'message_id',200);author_id:=app_private.live_text(r,'author_external_id',200);
  display_name:=app_private.live_text(r,'author_display_name',200);comment_text:=app_private.live_text(r,'text',2000);
  -- Preserve the observed text exactly; validation checks blank/control/length.
  if length(r->>'text')>2000 then raise exception 'LIVE_TEXT: Bình luận vượt 2.000 ký tự.';end if;
  comment_text:=r->>'text';time_text:=app_private.live_text(r,'occurred_at',50);
  if time_text !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$' then
   raise exception 'LIVE_TIME: Dùng ISO 8601 có múi giờ cho occurred_at.';
  end if;
  occurred:=time_text::timestamptz;
  if not isfinite(occurred) or occurred<'1900-01-01T00:00:00Z'::timestamptz or occurred>clock_timestamp()+interval '5 minutes' then
   raise exception 'LIVE_TIME: Thời điểm bình luận không hợp lệ hoặc quá 5 phút trong tương lai.';
  end if;
  fingerprint:=md5(jsonb_build_object('message_id',message_id,'author_external_id',author_id,'author_display_name',display_name,
    'text',comment_text,'occurred_at',to_char(occurred at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text);
  select * into old from public.live_comments where workspace_id=p_workspace_id and session_id=s.id and provider_message_id=message_id;
  if found then
   -- Exact fields, not hash alone, establish an immutable duplicate.
   if old.author_external_id<>author_id or old.author_display_name<>display_name or old.raw_text<>comment_text or old.occurred_at<>occurred then
    raise exception 'LIVE_DUPLICATE_CONFLICT: Mã bình luận đã tồn tại với nội dung khác; toàn bộ lô chưa được nhận.';
   end if;
   duplicate_count:=duplicate_count+1;rid:=old.id;
  else
   if s.status<>'live' or not exists(select 1 from public.live_campaigns where workspace_id=p_workspace_id and id=s.campaign_id and status='active') then
    raise exception 'LIVE_NOT_ACTIVE: Chỉ nhận bình luận mới khi chiến dịch và phiên đang hoạt động.';
   end if;
   if s.provider='tiktok_live' and not exists(select 1 from public.live_integration_accounts where workspace_id=p_workspace_id and id=s.integration_account_id and enabled) then
    raise exception 'LIVE_ACCOUNT: Tài khoản TikTok đã tắt.';
   end if;
   insert into public.live_comments(workspace_id,campaign_id,session_id,provider_message_id,author_external_id,author_display_name,raw_text,occurred_at,payload_hash)
   values(p_workspace_id,s.campaign_id,s.id,message_id,author_id,display_name,comment_text,occurred,fingerprint) returning id into rid;
   inserted_count:=inserted_count+1;
  end if;
  ids:=ids||jsonb_build_array(rid);
 end loop;
 if inserted_count>0 then
  perform app_private.audit(p_workspace_id,'live_comments.ingested',s.id,jsonb_build_object('inserted',inserted_count,'duplicates',duplicate_count,'provider',s.provider));
 end if;
 return jsonb_build_object('inserted',inserted_count,'duplicates',duplicate_count,'ids',ids);
end $$;

create function public.claim_live_comment(p_workspace_id uuid,p_comment_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare comment public.live_comments;claim public.live_comment_claims;token uuid;expires timestamptz;new_lease boolean;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager','staff']);
 select * into comment from public.live_comments where workspace_id=p_workspace_id and id=p_comment_id for update;
 if not found or comment.state<>'new' then raise exception 'LIVE_CLAIM: Chỉ giữ xử lý bình luận mới trong workspace.';end if;
 if not exists(select 1 from public.live_sessions where workspace_id=p_workspace_id and id=comment.session_id and status='live')
  or not exists(select 1 from public.live_campaigns where workspace_id=p_workspace_id and id=comment.campaign_id and status='active') then
  raise exception 'LIVE_CLAIM: Phiên hoặc chiến dịch đã dừng.';
 end if;
 select * into claim from public.live_comment_claims where workspace_id=p_workspace_id and comment_id=p_comment_id for update;
 new_lease:=not found or claim.expires_at<=clock_timestamp();
 if not new_lease and claim.claimed_by<>auth.uid() then raise exception 'LIVE_CLAIM_BUSY: Nhân viên khác đang xử lý bình luận này.';end if;
 token:=case when new_lease then gen_random_uuid() else claim.claim_token end;expires:=clock_timestamp()+interval '120 seconds';
 insert into public.live_comment_claims(workspace_id,comment_id,claimed_by,claim_token,expires_at)
 values(p_workspace_id,p_comment_id,auth.uid(),token,expires)
 on conflict(workspace_id,comment_id) do update set claimed_by=excluded.claimed_by,claim_token=excluded.claim_token,
  expires_at=excluded.expires_at,updated_at=clock_timestamp();
 if new_lease then perform app_private.audit(p_workspace_id,'live_comment.claimed',p_comment_id,jsonb_build_object('expires_at',expires));end if;
 return jsonb_build_object('comment_id',p_comment_id,'claim_token',token,'expires_at',expires,'claimed_by',auth.uid());
end $$;

create function public.release_live_comment_claim(p_workspace_id uuid,p_comment_id uuid,p_claim_token uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare claim public.live_comment_claims;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager','staff']);
 if p_claim_token is null then raise exception 'LIVE_CLAIM: Cần claim_token của người đang xử lý.';end if;
 if not exists(select 1 from public.live_comments where workspace_id=p_workspace_id and id=p_comment_id) then
  raise exception 'LIVE_CLAIM: Không tìm thấy bình luận trong workspace.';
 end if;
 select * into claim from public.live_comment_claims where workspace_id=p_workspace_id and comment_id=p_comment_id for update;
 if not found then return p_comment_id;end if;
 if claim.claimed_by<>auth.uid() or claim.claim_token<>p_claim_token then
  raise exception 'LIVE_CLAIM: Không được giải phóng lượt xử lý của người khác hoặc token đã cũ.' using errcode='42501';
 end if;
 delete from public.live_comment_claims where workspace_id=p_workspace_id and comment_id=p_comment_id;
 perform app_private.audit(p_workspace_id,'live_comment.claim_released',p_comment_id);return p_comment_id;
end $$;

create function public.get_live_intake(p_workspace_id uuid,p_session_id uuid default null,
 p_before timestamptz default null,p_before_id uuid default null,p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 perform app_private.require_role(p_workspace_id,array['owner','manager','staff','viewer']);
 if p_limit is null or p_limit not between 1 and 200 then raise exception 'LIVE_PAGE: Giới hạn trang từ 1 đến 200.';end if;
 if (p_before is null)<>(p_before_id is null) or(p_before is not null and not isfinite(p_before)) then
  raise exception 'LIVE_PAGE: Con trỏ cần cả received_at và id hợp lệ.';
 end if;
 if p_session_id is not null and not exists(select 1 from public.live_sessions where workspace_id=p_workspace_id and id=p_session_id) then
  raise exception 'LIVE_PAGE: Phiên không thuộc workspace.';
 end if;
 if (select count(*) from public.live_campaigns where workspace_id=p_workspace_id)>1000
  or(select count(*) from public.live_sessions where workspace_id=p_workspace_id)>1000
  or(select count(*) from public.live_integration_accounts where workspace_id=p_workspace_id)>1000 then
  raise exception 'LIVE_PAGE: Có hơn 1.000 chiến dịch, phiên hoặc tài khoản; cần API phân trang danh mục trước khi tải.';
 end if;
 with page as materialized (
  select * from public.live_comments where workspace_id=p_workspace_id and(p_session_id is null or session_id=p_session_id)
   and(p_before is null or(received_at,id)<(p_before,p_before_id)) order by received_at desc,id desc limit p_limit+1
 ), visible as materialized (select * from page order by received_at desc,id desc limit p_limit),
 last_row as(select received_at,id from visible order by received_at,id limit 1)
 select jsonb_build_object(
  'integration_accounts',(select coalesce(jsonb_agg(to_jsonb(a) order by a.name,a.id),'[]'::jsonb) from public.live_integration_accounts a where a.workspace_id=p_workspace_id),
  'campaigns',(select coalesce(jsonb_agg(to_jsonb(c) order by c.created_at desc,c.id desc),'[]'::jsonb) from public.live_campaigns c where c.workspace_id=p_workspace_id),
  'sessions',(select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at desc,s.id desc),'[]'::jsonb) from public.live_sessions s where s.workspace_id=p_workspace_id),
  'comments',(select coalesce(jsonb_agg(to_jsonb(c) order by c.received_at desc,c.id desc),'[]'::jsonb) from visible c),
  'claims',(select coalesce(jsonb_agg((to_jsonb(c)-'claim_token')||case when c.claimed_by=auth.uid() then jsonb_build_object('claim_token',c.claim_token) else '{}'::jsonb end order by c.comment_id),'[]'::jsonb)
   from public.live_comment_claims c where c.workspace_id=p_workspace_id and c.comment_id in(select id from visible) and c.expires_at>clock_timestamp()),
  'has_more',(select count(*)>p_limit from page),
  'next_before',case when(select count(*)>p_limit from page) then(select received_at from last_row) end,
  'next_before_id',case when(select count(*)>p_limit from page) then(select id from last_row) end
 ) into result;
 return result;
end $$;

revoke all on function app_private.live_text(jsonb,text,integer,boolean) from public,anon,authenticated;
revoke all on function public.save_live_integration_account(uuid,jsonb),public.save_live_campaign(uuid,jsonb),
 public.save_live_session(uuid,jsonb),public.report_live_connection(uuid,uuid,text,text),
 public.ingest_live_comments(uuid,uuid,jsonb),public.claim_live_comment(uuid,uuid),
 public.release_live_comment_claim(uuid,uuid,uuid),public.get_live_intake(uuid,uuid,timestamptz,uuid,integer) from public,anon;
grant execute on function public.save_live_integration_account(uuid,jsonb),public.save_live_campaign(uuid,jsonb),
 public.save_live_session(uuid,jsonb),public.report_live_connection(uuid,uuid,text,text),
 public.ingest_live_comments(uuid,uuid,jsonb),public.claim_live_comment(uuid,uuid),
 public.release_live_comment_claim(uuid,uuid,uuid),public.get_live_intake(uuid,uuid,timestamptz,uuid,integer) to authenticated;

-- Preserve existing publication configuration. PGlite/local databases may have
-- none. Claim tokens are excluded from publication columns on PostgreSQL 15+;
-- older servers use the RPC refresh path for claim visibility.
do $$declare t text;all_tables boolean;begin
 select puballtables into all_tables from pg_publication where pubname='supabase_realtime';
 if found then
  if all_tables then raise exception 'LIVE_PUBLICATION: supabase_realtime publishes every table; configure an explicit table list before installing private claim tokens.';end if;
  foreach t in array array['live_integration_accounts','live_campaigns','live_sessions','live_comments'] loop
   if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=t) then
    execute format('alter publication supabase_realtime add table public.%I',t);
   end if;
  end loop;
  if current_setting('server_version_num')::integer>=150000 then
   execute 'alter publication supabase_realtime add table public.live_comment_claims(workspace_id,comment_id,claimed_by,expires_at,created_at,updated_at)';
  end if;
 end if;
end $$;

commit;
