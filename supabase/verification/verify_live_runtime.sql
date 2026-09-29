-- READ ONLY, administrator after 012: one JSON with metadata and counts only.
-- No workspace/session/instance IDs, comments, event IDs, credentials or tokens.
begin transaction isolation level repeatable read read only;
set local search_path = pg_catalog;
with expected_tables(schema_name,table_name,policy_name,expected_qual) as (values
 ('public','live_listener_health','manager_read','app_private.member_roleworkspace_id=anyarray[''owner''::text,''manager''::text]'),
 ('public','live_session_telemetry','member_read','app_private.member_roleworkspace_idisnotnull'),
 ('app_private','live_runtime_event_keys',null,null)
), table_metadata as (
 select e.*,c.oid,c.relrowsecurity,
  has_any_column_privilege('authenticated',c.oid,'SELECT') member_read,
  has_any_column_privilege('anon',c.oid,'SELECT') anon_read,
  has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    or has_any_column_privilege('authenticated',c.oid,'INSERT,UPDATE,REFERENCES') member_write,
  has_table_privilege('anon',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    or has_any_column_privilege('anon',c.oid,'INSERT,UPDATE,REFERENCES') anon_write,
  (select count(*) from pg_policies p where p.schemaname=e.schema_name and p.tablename=e.table_name) policy_count,
  (select count(*) from pg_policies p where p.schemaname=e.schema_name and p.tablename=e.table_name
   and p.policyname=e.policy_name and p.cmd='SELECT' and p.permissive='PERMISSIVE'
   and p.roles=array['authenticated']::name[] and p.with_check is null
   and regexp_replace(lower(p.qual),'[[:space:]()]','','g')=e.expected_qual) valid_policy_count,
  exists(select 1 from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where a.grantee=0) public_grants
 from expected_tables e left join pg_class c on c.oid=to_regclass(format('%I.%I',e.schema_name,e.table_name))
), expected_routines(signature,private) as (values
 ('public.report_live_listener_health(uuid,uuid,jsonb)',false),('public.get_live_runtime(uuid,uuid)',false),
 ('public.ingest_live_events(uuid,uuid,jsonb)',false),('public.ingest_tiktok_events(uuid,uuid,bigint,uuid,uuid,jsonb)',false),
 ('app_private.ingest_live_runtime_events(uuid,uuid,jsonb)',true)
), routine_metadata as (
 select e.*,p.oid,p.prosecdef,
  coalesce(p.proconfig@>array['search_path=""'],false) empty_search_path,
  has_function_privilege('authenticated',p.oid,'EXECUTE') member_execute,
  has_function_privilege('anon',p.oid,'EXECUTE') anon_execute,
  exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') public_execute
 from expected_routines e left join pg_proc p on p.oid=to_regprocedure(e.signature)
), expected_links(child,parent,columns,ref_columns) as (values
 ('public.live_listener_health','public.workspaces',array['workspace_id'],array['id']),
 ('public.live_listener_health','auth.users',array['reported_by'],array['id']),
 ('public.live_session_telemetry','public.workspaces',array['workspace_id'],array['id']),
 ('public.live_session_telemetry','public.live_sessions',array['workspace_id','session_id'],array['workspace_id','id']),
 ('app_private.live_runtime_event_keys','public.workspaces',array['workspace_id'],array['id']),
 ('app_private.live_runtime_event_keys','public.live_sessions',array['workspace_id','session_id'],array['workspace_id','id'])
), link_metadata as (
 select e.*,exists(select 1 from pg_constraint c where c.contype='f' and c.convalidated
  and c.conrelid=to_regclass(e.child) and c.confrelid=to_regclass(e.parent)
  and e.columns=array(select a.attname::text from unnest(c.conkey) with ordinality k(num,ord)
    join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.num order by k.ord)
  and e.ref_columns=array(select a.attname::text from unnest(c.confkey) with ordinality k(num,ord)
    join pg_attribute a on a.attrelid=c.confrelid and a.attnum=k.num order by k.ord)) valid
 from expected_links e
), expected_keys(table_name,columns) as (values
 ('public.live_listener_health',array['workspace_id','instance_id']),
 ('public.live_session_telemetry',array['workspace_id','session_id']),
 ('app_private.live_runtime_event_keys',array['workspace_id','session_id','event_type','event_id'])
), key_metadata as (
 select e.*,exists(select 1 from pg_constraint c where c.contype='p' and c.convalidated and c.conrelid=to_regclass(e.table_name)
  and e.columns=array(select a.attname::text from unnest(c.conkey) with ordinality k(num,ord)
    join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.num order by k.ord)) valid from expected_keys e
), security_checks as (
 select 'administrator_visibility_required' name,
  case when exists(select 1 from pg_roles where rolname=current_user and(rolsuper or rolbypassrls)) then 0 else 1 end::bigint issues
 union all select 'table_acl_rls_or_policy_mismatch',count(*) from table_metadata
  where oid is null or relrowsecurity is not true or member_read is distinct from(schema_name='public')
   or anon_read is not false or member_write is not false or anon_write is not false or public_grants
   or policy_count<>case when schema_name='public' then 1 else 0 end
   or valid_policy_count<>case when schema_name='public' then 1 else 0 end
 union all select 'routine_acl_or_configuration_mismatch',count(*) from routine_metadata
  where oid is null or prosecdef is not true or empty_search_path is not true
   or member_execute is distinct from(not private) or anon_execute is not false or public_execute is not false
 union all select 'unexpected_runtime_overloads',count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where(n.nspname='public' and p.proname in('report_live_listener_health','get_live_runtime','ingest_live_events','ingest_tiktok_events')
   or n.nspname='app_private' and p.proname='ingest_live_runtime_events')
   and not exists(select 1 from routine_metadata r where r.oid=p.oid)
 union all select 'missing_workspace_foreign_keys',count(*) from link_metadata where not valid
 union all select 'missing_unique_keys',count(*) from key_metadata where not valid
 union all select 'invalid_check_constraints',count(*) from pg_constraint c where c.contype='c'
  and c.conrelid in(select oid from table_metadata) and not c.convalidated
 union all select 'publication_for_all_tables',count(*) from pg_publication where puballtables
 union all select 'publication_exposes_runtime_private_metadata',count(*) from pg_publication_tables
  where(schemaname='public' and tablename='live_listener_health') or(schemaname='app_private' and tablename='live_runtime_event_keys')
 union all select 'telemetry_not_in_realtime_publication',case when exists(select 1 from pg_publication where pubname='supabase_realtime')
  and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='live_session_telemetry') then 1 else 0 end
), aggregates as (
 select workspace_id,session_id,max(viewer_count) peak,
  max(occurred_at) filter(where event_type='VIEWER_COUNT') viewer_at,
  max(occurred_at) provider_at,max(occurred_at) filter(where event_type='MEMBER_JOIN') member_at,
  count(*) filter(where event_type='MEMBER_JOIN') member_count,max(received_at) received_at
 from app_private.live_runtime_event_keys group by workspace_id,session_id
), reconciliation as (
 select 'telemetry_receipts_mismatch' name,count(*) issues from public.live_session_telemetry t
 full join aggregates a on a.workspace_id=t.workspace_id and a.session_id=t.session_id
 where t.session_id is null or a.session_id is null or t.peak_viewer_count is distinct from a.peak
  or t.last_viewer_update_at is distinct from a.viewer_at or t.last_provider_event_at is distinct from a.provider_at
  or t.last_member_at is distinct from a.member_at or t.member_event_count is distinct from a.member_count
  or t.updated_at<a.received_at or t.current_viewer_count is distinct from(
   select k.viewer_count from app_private.live_runtime_event_keys k
   where k.workspace_id=a.workspace_id and k.session_id=a.session_id and k.event_type='VIEWER_COUNT'
   order by k.occurred_at desc,k.event_id collate "C" desc limit 1)
 union all select 'invalid_listener_clock',count(*) from public.live_listener_health
  where started_at>heartbeat_at or heartbeat_at>clock_timestamp()+interval '5 seconds'
), all_checks as(select * from security_checks union all select * from reconciliation)
select jsonb_build_object(
 'version',12,'status',case when exists(select 1 from all_checks where issues>0) then 'FAIL' else 'PASS' end,
 'failed_checks',(select count(*) from all_checks where issues>0),
 'metadata',jsonb_build_object('expected_tables',3,'present_tables',(select count(*) from table_metadata where oid is not null),
  'expected_routines',5,'present_routines',(select count(*) from routine_metadata where oid is not null),
  'expected_foreign_keys',6,'validated_foreign_keys',(select count(*) from link_metadata where valid),
  'listener_instances',(select count(*) from public.live_listener_health),
  'telemetry_sessions',(select count(*) from public.live_session_telemetry),
  'dedupe_receipts',(select count(*) from app_private.live_runtime_event_keys)),
 'security',(select jsonb_object_agg(name,issues) from security_checks),
 'reconciliation',(select jsonb_object_agg(name,issues) from reconciliation),
 'warnings',jsonb_build_object('realtime_publication_missing',not exists(select 1 from pg_publication where pubname='supabase_realtime'),
  'real_provider_and_cloud_not_verified_by_this_query',true)
) as live_runtime_verification;
commit;
