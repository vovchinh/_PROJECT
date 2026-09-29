-- READ ONLY: administrator check after 011. Returns metadata and counts only.
-- No usernames, customer data, comments, room IDs or lease values are returned.
-- Provider STREAM_END and physical printing still require separate acceptance.
begin transaction isolation level repeatable read read only;
set local search_path = pg_catalog;
with expected_routines(signature,private) as (values
 ('public.finish_tiktok_live(uuid,uuid,bigint,uuid,uuid)',false),
 ('public.save_tiktok_channel(uuid,jsonb,uuid)',false),
 ('app_private.protect_tiktok_channel()',true),
 ('app_private.clear_ended_tiktok_connection()',true)
), routine_metadata as (
 select e.signature,e.private,p.oid,p.oid is not null as present,p.prosecdef as definer,
  coalesce(p.proconfig@>array['search_path=""'],false) as empty_search_path,
  has_function_privilege('authenticated',p.oid,'EXECUTE') as member_execute,
  has_function_privilege('anon',p.oid,'EXECUTE') as anonymous_execute,
  exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   where a.grantee=0 and a.privilege_type='EXECUTE') as public_execute
 from expected_routines e left join pg_proc p on p.oid=to_regprocedure(e.signature)
), security_checks as (
 select 'administrator_visibility_required' name,
  case when exists(select 1 from pg_roles where rolname=current_user and(rolsuper or rolbypassrls)) then 0 else 1 end::bigint issues
 union all select 'routine_grants_or_configuration_mismatch',count(*) from routine_metadata
  where present is not true or definer is not true or empty_search_path is not true
   or member_execute is distinct from(not private) or anonymous_execute is not false or public_execute is not false
 union all select 'unexpected_finish_overloads',count(*) from pg_proc
  where pronamespace='public'::regnamespace and proname='finish_tiktok_live'
   and oid is distinct from to_regprocedure('public.finish_tiktok_live(uuid,uuid,bigint,uuid,uuid)')
 union all select 'message_code_constraint_mismatch',case when exists(
  select 1 from pg_constraint c where c.conrelid='public.live_channel_connections'::regclass
   and c.conname='live_channel_connections_message_code_check' and c.contype='c' and c.convalidated
   and regexp_replace(lower(pg_get_expr(c.conbin,c.conrelid)),'[[:space:]()]','','g')=
    'message_code=anyarray[''waiting_for_listener''::text,''room_not_live''::text,''connected''::text,''disconnected''::text,''connection_failed''::text,''retrying''::text,''live_ended''::text]'
 ) then 0 else 1 end
 union all select 'session_clock_missing_or_disabled',case when exists(
  select 1 from pg_trigger t where t.tgrelid='public.live_sessions'::regclass
   and t.tgname='live_session_clock' and not t.tgisinternal and t.tgenabled in('O','A')
   and t.tgtype=23 and t.tgqual is null and t.tgfoid=to_regprocedure('app_private.live_session_clock()')
 ) then 0 else 1 end
 union all select 'ended_connection_guard_missing_or_disabled',case when exists(
  select 1 from pg_trigger t where t.tgrelid='public.live_channel_connections'::regclass
   and t.tgname='clear_ended_tiktok_connection' and not t.tgisinternal and t.tgenabled in('O','A')
   and t.tgtype=19 and t.tgfoid=to_regprocedure('app_private.clear_ended_tiktok_connection()')
 ) then 0 else 1 end
), reconciliation as (
 select 'terminal_connection_mismatch' name,count(*) issues
 from public.live_channel_connections c left join public.live_sessions s
  on s.workspace_id=c.workspace_id and s.id=c.current_session_id
 where c.message_code='live_ended' and(
  c.desired_state<>'disconnected' or c.connection_status<>'OFFLINE' or c.connected_since is not null
  or c.lease_token is not null or c.lease_actor is not null or c.lease_expires_at is not null
  or s.id is null or s.status is distinct from 'ended' or s.connection_status is distinct from 'disconnected'
  or s.ended_at is null or not isfinite(s.ended_at) or s.integration_account_id is distinct from c.channel_id
  or not exists(select 1 from public.live_channel_sessions m where m.workspace_id=c.workspace_id
   and m.channel_id=c.channel_id and m.session_id=c.current_session_id and m.provider_room_id=c.provider_room_id)
  or (select count(*) from public.live_channel_commands e where e.workspace_id=c.workspace_id
    and e.channel_id=c.channel_id and e.revision=c.revision and e.desired_state='disconnected' and e.actor_id=c.requested_by)<>1
  or (select count(*) from public.audit_events a where a.workspace_id=c.workspace_id
    and a.entity_id=c.channel_id and a.action='tiktok.live_ended' and a.details->>'revision'=c.revision::text
    and a.details->>'session_id'=c.current_session_id::text and a.actor_id=c.requested_by)<>1
 )
 union all select 'terminal_audit_mapping_mismatch',count(*)
 from public.audit_events a left join public.live_sessions s
  on s.workspace_id=a.workspace_id and s.id::text=a.details->>'session_id'
 where a.action='tiktok.live_ended' and(
  s.id is null or s.status is distinct from 'ended' or s.ended_at is null or not isfinite(s.ended_at)
  or s.connection_status is distinct from 'disconnected' or a.details->>'reason' is distinct from 'provider_stream_end'
  or s.integration_account_id is distinct from a.entity_id
  or not exists(select 1 from public.live_channel_sessions m where m.workspace_id=a.workspace_id
   and m.channel_id=a.entity_id and m.session_id=s.id)
  or not exists(select 1 from public.live_channel_commands e where e.workspace_id=a.workspace_id
   and e.channel_id=a.entity_id and e.revision::text=a.details->>'revision'
   and e.desired_state='disconnected' and e.actor_id=a.actor_id)
 )
 union all select 'duplicate_terminal_audit',count(*) from(
  select workspace_id,entity_id,details->>'session_id' session_id,details->>'revision' revision
  from public.audit_events where action='tiktok.live_ended'
  group by workspace_id,entity_id,details->>'session_id',details->>'revision' having count(*)>1
 ) x
), failures as(select * from security_checks union all select * from reconciliation)
select jsonb_build_object(
 'checked_at',current_timestamp,'migration','011_tiktok_live_end.sql',
 'scope','Read-only administrator lifecycle metadata and aggregate reconciliation; no provider or printer acceptance.',
 'status',case when exists(select 1 from failures where issues<>0) then 'FAIL' else 'PASS' end,
 'failed_checks',(select count(*) from failures where issues<>0),
 'security_checks',(select jsonb_object_agg(name,issues order by name) from security_checks),
 'reconciliation',(select jsonb_object_agg(name,issues order by name) from reconciliation),
 'metadata',jsonb_build_object('expected_routines',4,'present_routines',(select count(*) from routine_metadata where present)),
 'counts',jsonb_build_object('terminal_connections',(select count(*) from public.live_channel_connections where message_code='live_ended'),
  'terminal_audits',(select count(*) from public.audit_events where action='tiktok.live_ended'))
) as tiktok_lifecycle_verification;
commit;
