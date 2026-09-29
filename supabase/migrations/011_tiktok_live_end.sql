-- A confirmed provider STREAM_END ends only the current leased channel session.
-- Apply once after 010. A network disconnect is not evidence that a LIVE ended.
begin;

do $$begin
 if to_regprocedure('public.ingest_tiktok_comments(uuid,uuid,bigint,uuid,uuid,jsonb)') is null then
  raise exception 'TIKTOK_PREREQUISITE: Apply 010 before 011.';
 end if;
end $$;

alter table public.live_channel_connections drop constraint live_channel_connections_message_code_check;
alter table public.live_channel_connections add constraint live_channel_connections_message_code_check
 check(message_code in('waiting_for_listener','room_not_live','connected','disconnected','connection_failed','retrying','live_ended'));

-- A failed/pending CONNECT has no observed LIVE history. Allow correcting that
-- username, but cancel and fence the previous listener before changing it.
create or replace function app_private.protect_tiktok_channel() returns trigger
language plpgsql security definer set search_path='' as $$
declare c public.live_channel_connections;
begin
 if new.username<>old.username then
  if exists(select 1 from public.live_sessions where workspace_id=old.workspace_id and integration_account_id=old.id) then
   raise exception 'TIKTOK_CHANNEL_USED: TikTok ID đã có lịch sử LIVE. Lưu thành ID mới để giữ nguyên bình luận và phiếu cũ.';
  end if;
  select * into c from public.live_channel_connections where workspace_id=old.workspace_id and channel_id=old.id for update;
  if found then
   update public.live_channel_connections set desired_state='disconnected',connection_status='OFFLINE',message_code='disconnected',
    revision=c.revision+1,lease_token=null,lease_actor=null,lease_expires_at=null,connected_since=null,
    requested_by=auth.uid(),requested_at=clock_timestamp()
    where workspace_id=old.workspace_id and channel_id=old.id;
   insert into public.live_channel_commands(workspace_id,channel_id,revision,desired_state,actor_id)
    values(old.workspace_id,old.id,c.revision+1,'disconnected',auth.uid());
  end if;
  perform app_private.audit(old.workspace_id,'tiktok.channel_username_corrected',old.id,
   jsonb_build_object('previous_username',old.username,'username',new.username,'pending_connection_cancelled',c.channel_id is not null));
 end if;
 if old.enabled and not new.enabled then
  new.is_default:=false;
  if new.username=old.username then
   update public.live_channel_connections set desired_state='disconnected',connection_status='OFFLINE',message_code='disconnected',revision=revision+1,
    lease_token=null,lease_actor=null,lease_expires_at=null,connected_since=null,requested_by=auth.uid(),requested_at=clock_timestamp()
    where workspace_id=old.workspace_id and channel_id=old.id;
  end if;
 end if;
 return new;
end $$;

create or replace function public.save_tiktok_channel(p_workspace_id uuid,p_payload jsonb,p_request_id uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare rid uuid;handle text;label text;active_value boolean;default_value boolean;prior jsonb;h text:=md5(coalesce(p_payload,'null'::jsonb)::text);
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 prior:=app_private.live_replay(p_workspace_id,p_request_id,'channel.save',h);if prior is not null then return(prior->>'id')::uuid;end if;
 handle:=lower(app_private.live_text(p_payload,'username',25));if left(handle,1)='@' then handle:=substr(handle,2);end if;
 label:=nullif(app_private.live_text(p_payload,'display_name',200,false),'');
 active_value:=app_private.foundation_boolean(p_payload,'is_active',true);
 default_value:=app_private.foundation_boolean(p_payload,'is_default',not exists(select 1 from public.live_integration_accounts where workspace_id=p_workspace_id and is_default));
 if exists(select 1 from public.live_integration_accounts a where a.workspace_id=p_workspace_id
  and a.id=nullif(p_payload->>'id','')::uuid and a.username<>handle
  and exists(select 1 from public.live_sessions s where s.workspace_id=a.workspace_id and s.integration_account_id=a.id)) then
  raise exception 'TIKTOK_CHANNEL_USED: TikTok ID đã có lịch sử LIVE. Lưu thành ID mới để giữ nguyên bình luận và phiếu cũ.';
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

create function public.finish_tiktok_live(p_workspace_id uuid,p_channel_id uuid,p_revision bigint,p_lease_token uuid,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.live_channel_connections;r jsonb;next_revision bigint;
 h text:=md5(jsonb_build_object('channel',p_channel_id,'revision',p_revision,'lease',p_lease_token)::text);
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 r:=app_private.live_replay(p_workspace_id,p_request_id,'channel.ended',h);
 if r is not null then return r;end if;
 select * into c from public.live_channel_connections
  where workspace_id=p_workspace_id and channel_id=p_channel_id for update;
 if not found or p_revision is null or c.revision<>p_revision or p_lease_token is null
  or c.lease_token is distinct from p_lease_token or c.lease_actor is distinct from auth.uid()
  or c.lease_expires_at is null or c.desired_state<>'connected'
  or c.current_session_id is null then
  raise exception 'TIKTOK_LISTENER_STALE: Phiên đã đổi hoặc listener không còn quyền kết thúc LIVE.';
 end if;
 -- Terminal evidence may arrive after a slow final queue drain. Expiry alone
 -- does not replace the token; a new claim or CONNECT/DISCONNECT rotates it and
 -- still fences this callback. This exception never permits expired ingestion.
 if not exists(select 1 from public.live_channel_sessions m join public.live_sessions s
  on s.workspace_id=m.workspace_id and s.id=m.session_id
  where m.workspace_id=p_workspace_id and m.channel_id=p_channel_id and m.session_id=c.current_session_id
   and m.provider_room_id=c.provider_room_id and s.status='live' and s.integration_account_id=p_channel_id) then
  raise exception 'TIKTOK_SESSION_STALE: Không tìm thấy phiên LIVE hiện hành của kênh.';
 end if;
 next_revision:=c.revision+1;
 update public.live_sessions set status='ended',connection_status='disconnected',
  connection_message='Phiên TikTok đã kết thúc. Đã tự động ngắt kết nối.',updated_at=clock_timestamp()
  where workspace_id=p_workspace_id and id=c.current_session_id;
 update public.live_channel_connections set desired_state='disconnected',connection_status='OFFLINE',
  revision=next_revision,requested_by=auth.uid(),requested_at=clock_timestamp(),heartbeat_at=clock_timestamp(),
  connected_since=null,message_code='live_ended',lease_token=null,lease_actor=null,lease_expires_at=null
  where workspace_id=p_workspace_id and channel_id=p_channel_id;
 insert into public.live_channel_commands(workspace_id,channel_id,revision,desired_state,actor_id)
  values(p_workspace_id,p_channel_id,next_revision,'disconnected',auth.uid());
 r:=jsonb_build_object('status','OFFLINE','revision',next_revision,'session_id',c.current_session_id,'message_code','live_ended');
 perform app_private.live_remember(p_workspace_id,p_request_id,'channel.ended',p_channel_id,h,r);
 perform app_private.audit(p_workspace_id,'tiktok.live_ended',p_channel_id,
  jsonb_build_object('session_id',c.current_session_id,'revision',next_revision,'reason','provider_stream_end'));
 return r;
end $$;

-- A new connection attempt has no current session when the previous broadcast
-- already ended. Keep that session's terminal history out of generic 010
-- offline/error reports; a verified room will populate the new current session.
create function app_private.clear_ended_tiktok_connection() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.revision>old.revision and new.desired_state='connected' and exists(
  select 1 from public.live_sessions where workspace_id=new.workspace_id and id=new.current_session_id and status='ended'
 ) then
  new.current_session_id:=null;
  new.provider_room_id:=null;
 end if;
 return new;
end $$;
create trigger clear_ended_tiktok_connection before update of revision on public.live_channel_connections
 for each row execute function app_private.clear_ended_tiktok_connection();
revoke all on function app_private.clear_ended_tiktok_connection() from public,anon,authenticated;

revoke all on function public.finish_tiktok_live(uuid,uuid,bigint,uuid,uuid) from public,anon;
grant execute on function public.finish_tiktok_live(uuid,uuid,bigint,uuid,uuid) to authenticated;

commit;
