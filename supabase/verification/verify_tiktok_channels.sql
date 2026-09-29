-- READ ONLY: run as the database administrator after 010 has committed.
-- Missing prerequisites are an SQL error, never a successful empty result.
-- One JSON cell contains metadata/counts only, without channel/customer names,
-- identifiers, room IDs, comments or token values. This does not test TikTok I/O.
begin transaction isolation level repeatable read read only;
set local search_path = pg_catalog;
with expected_tables(name) as (values
 ('live_integration_accounts'),('live_channel_connections'),('live_channel_commands'),
 ('live_channel_campaigns'),('live_channel_sessions')
), expected_routines(signature,private) as (values
 ('public.save_tiktok_channel(uuid,jsonb,uuid)',false),
 ('public.request_tiktok_connection(uuid,uuid,text,uuid)',false),
 ('public.claim_tiktok_connection(uuid,uuid,bigint)',false),
 ('public.report_tiktok_connection(uuid,uuid,bigint,uuid,text,text)',false),
 ('public.get_tiktok_channels(uuid)',false),
 ('public.ingest_tiktok_comments(uuid,uuid,bigint,uuid,uuid,jsonb)',false),
 ('app_private.guard_channel_ingestion()',true),('app_private.protect_tiktok_channel()',true)
), table_metadata as (
 select e.name,c.oid,c.oid is not null as present,c.relrowsecurity as rls,
  has_any_column_privilege('authenticated',c.oid,'SELECT') as member_read,
  has_any_column_privilege('anon',c.oid,'SELECT') as anonymous_read,
  has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
   or has_any_column_privilege('authenticated',c.oid,'INSERT,UPDATE,REFERENCES') as member_write,
  has_table_privilege('anon',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
   or has_any_column_privilege('anon',c.oid,'INSERT,UPDATE,REFERENCES') as anonymous_write,
  (select count(*) from pg_policies p where p.schemaname='public' and p.tablename=e.name) as policy_count,
  (select count(*) from pg_policies p where p.schemaname='public' and p.tablename=e.name and p.cmd='SELECT'
   and p.roles=array['authenticated']::name[] and p.permissive='PERMISSIVE'
   and regexp_replace(lower(p.qual),'[[:space:]]','','g')='(app_private.member_role(workspace_id)isnotnull)') as member_policy_count
 from expected_tables e left join pg_class c on c.oid=to_regclass('public.'||e.name)
), routine_metadata as (
 select e.signature,e.private,p.oid,p.oid is not null as present,p.prosecdef as definer,
  coalesce(p.proconfig@>array['search_path=""'],false) as empty_search_path,
  has_function_privilege('authenticated',p.oid,'EXECUTE') as member_execute,
  has_function_privilege('anon',p.oid,'EXECUTE') as anonymous_execute,
  exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   where a.grantee=0 and a.privilege_type='EXECUTE') as public_execute
 from expected_routines e left join pg_proc p on p.oid=to_regprocedure(e.signature)
), expected_links(child,parent,columns,referenced_columns) as (values
 ('live_channel_connections','public.workspaces',array['workspace_id'],array['id']),
 ('live_channel_commands','public.workspaces',array['workspace_id'],array['id']),
 ('live_channel_campaigns','public.workspaces',array['workspace_id'],array['id']),
 ('live_channel_sessions','public.workspaces',array['workspace_id'],array['id']),
 ('live_channel_connections','public.live_integration_accounts',array['workspace_id','channel_id'],array['workspace_id','id']),
 ('live_channel_connections','public.live_sessions',array['workspace_id','current_session_id'],array['workspace_id','id']),
 ('live_channel_commands','public.live_integration_accounts',array['workspace_id','channel_id'],array['workspace_id','id']),
 ('live_channel_campaigns','public.live_integration_accounts',array['workspace_id','channel_id'],array['workspace_id','id']),
 ('live_channel_campaigns','public.live_campaigns',array['workspace_id','campaign_id'],array['workspace_id','id']),
 ('live_channel_sessions','public.live_channel_campaigns',array['workspace_id','channel_id','business_date'],array['workspace_id','channel_id','business_date']),
 ('live_channel_sessions','public.live_sessions',array['workspace_id','session_id'],array['workspace_id','id']),
 ('live_channel_connections','auth.users',array['requested_by'],array['id']),
 ('live_channel_connections','auth.users',array['lease_actor'],array['id']),
 ('live_channel_commands','auth.users',array['actor_id'],array['id'])
), link_metadata as (
 select e.*,exists(select 1 from pg_constraint f where f.contype='f' and f.convalidated
  and f.conrelid=to_regclass('public.'||e.child) and f.confrelid=to_regclass(e.parent)
  and e.columns=array(select a.attname::text from unnest(f.conkey) with ordinality k(num,ord)
   join pg_attribute a on a.attrelid=f.conrelid and a.attnum=k.num order by k.ord)
  and e.referenced_columns=array(select a.attname::text from unnest(f.confkey) with ordinality k(num,ord)
   join pg_attribute a on a.attrelid=f.confrelid and a.attnum=k.num order by k.ord)) as enforced
 from expected_links e
), expected_unique(table_name,columns) as (values
 ('live_integration_accounts',array['workspace_id','username']),
 ('live_channel_connections',array['workspace_id','channel_id']),
 ('live_channel_commands',array['workspace_id','channel_id','revision']),
 ('live_channel_campaigns',array['workspace_id','channel_id','business_date']),
 ('live_channel_campaigns',array['workspace_id','campaign_id']),
 ('live_channel_sessions',array['workspace_id','channel_id','business_date','provider_room_id']),
 ('live_channel_sessions',array['workspace_id','session_id'])
), unique_metadata as (
 select e.*,exists(select 1 from pg_constraint c join pg_index i on i.indexrelid=c.conindid
  where c.conrelid=to_regclass('public.'||e.table_name) and c.contype in('p','u') and c.convalidated and i.indisvalid
  and e.columns=array(select a.attname::text from unnest(c.conkey) with ordinality k(num,ord)
   join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.num order by k.ord)) as enforced
 from expected_unique e
), expected_triggers(table_name,name,routine,type_bits) as (values
 ('live_comments','guard_channel_ingestion','app_private.guard_channel_ingestion()',7),
 ('live_integration_accounts','protect_tiktok_channel','app_private.protect_tiktok_channel()',19)
), trigger_metadata as (
 select e.*,exists(select 1 from pg_trigger t where t.tgrelid=to_regclass('public.'||e.table_name)
  and t.tgname=e.name and not t.tgisinternal and t.tgenabled in('O','A') and t.tgtype=e.type_bits
  and t.tgfoid=to_regprocedure(e.routine) and t.tgqual is null) as enforced from expected_triggers e
), sensitive_publication_tables as (
 select p.pubname,t.schemaname,t.tablename from pg_publication p join pg_publication_tables t on t.pubname=p.pubname
 where (t.schemaname='app_private' and t.tablename='live_requests')
  or(t.schemaname='public' and(
   (t.tablename='live_channel_connections' and(p.puballtables or current_setting('server_version_num')::int<150000
     or coalesce(to_jsonb(t)->'attnames','[]') ?| array['lease_token','lease_actor','lease_expires_at']))
   or(t.tablename='live_comment_claims' and(p.puballtables or current_setting('server_version_num')::int<150000 or coalesce(to_jsonb(t)->'attnames','[]')?'claim_token'))
   or(t.tablename='live_print_jobs' and(p.puballtables or current_setting('server_version_num')::int<150000 or coalesce(to_jsonb(t)->'attnames','[]')?'lease_token'))))
), security_checks as (
 select 'administrator_visibility_required' name,case when exists(select 1 from pg_roles where rolname=current_user and(rolsuper or rolbypassrls)) then 0 else 1 end::bigint issues
 union all select 'table_rls_grants_or_policy_mismatch',count(*) from table_metadata where present is not true or rls is not true
  or member_read is not true or anonymous_read is not false or member_write is not false or anonymous_write is not false
  or policy_count<>1 or member_policy_count<>1
 union all select 'listener_columns_readable',count(*) from (values('lease_token'),('lease_actor'),('lease_expires_at')) col(name)
  where has_column_privilege('authenticated','public.live_channel_connections',col.name,'SELECT')
   or has_column_privilege('anon','public.live_channel_connections',col.name,'SELECT')
 union all select 'routine_grants_or_configuration_mismatch',count(*) from routine_metadata where present is not true or definer is not true
  or empty_search_path is not true or member_execute is distinct from(not private) or anonymous_execute is not false or public_execute is not false
 union all select 'unexpected_channel_rpc_overloads',count(*) from pg_proc p where p.pronamespace='public'::regnamespace
  and p.proname in(select split_part(split_part(signature,'.',2),'(',1) from expected_routines where not private)
  and not exists(select 1 from routine_metadata e where e.oid=p.oid)
 union all select 'missing_or_unvalidated_links',count(*) from link_metadata where not enforced
 union all select 'missing_duplicate_protection',count(*) from unique_metadata where not enforced
 union all select 'missing_default_unique_index',case when exists(select 1 from pg_index i
  where i.indrelid='public.live_integration_accounts'::regclass and i.indisunique and i.indisvalid and i.indexprs is null
   and regexp_replace(pg_get_expr(i.indpred,i.indrelid),'[[:space:]()]','','g')='is_default'
   and array['workspace_id']=array(select a.attname::text from unnest(i.indkey) with ordinality k(num,ord)
     join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.num where k.ord<=i.indnkeyatts order by k.ord)) then 0 else 1 end
 union all select 'missing_ingestion_or_account_guard',count(*) from trigger_metadata where not enforced
 union all select 'publication_exposes_private_tokens_or_requests',count(*) from sensitive_publication_tables
 union all select 'publication_for_all_tables',count(*) from pg_publication where puballtables
), reconciliation as (
 select 'duplicate_or_inactive_defaults' name,
  (select count(*) from(select workspace_id from public.live_integration_accounts where is_default group by workspace_id having count(*)>1) x)
  +(select count(*) from public.live_integration_accounts where is_default and not enabled) issues
 union all select 'campaign_mapping_mismatch',count(*) from public.live_channel_campaigns m
  left join public.live_integration_accounts a on a.workspace_id=m.workspace_id and a.id=m.channel_id
  left join public.live_campaigns c on c.workspace_id=m.workspace_id and c.id=m.campaign_id
  where a.id is null or c.id is null or not isfinite(m.business_date)
   or c.code is distinct from upper('TK-'||m.channel_id::text||'-'||to_char(m.business_date,'YYYYMMDD'))
 union all select 'session_mapping_mismatch',count(*) from public.live_channel_sessions m
  left join public.live_channel_campaigns cm on cm.workspace_id=m.workspace_id and cm.channel_id=m.channel_id and cm.business_date=m.business_date
  left join public.live_sessions s on s.workspace_id=m.workspace_id and s.id=m.session_id
  left join public.live_integration_accounts a on a.workspace_id=m.workspace_id and a.id=m.channel_id
  where cm.campaign_id is null or s.id is null or a.id is null or s.campaign_id is distinct from cm.campaign_id
   or s.integration_account_id is distinct from m.channel_id or s.provider is distinct from 'tiktok_live' or s.room_id is distinct from a.username
 union all select 'connection_session_mapping_mismatch',count(*) from public.live_channel_connections c
  where c.current_session_id is not null and not exists(select 1 from public.live_channel_sessions m
   where m.workspace_id=c.workspace_id and m.channel_id=c.channel_id and m.session_id=c.current_session_id and m.provider_room_id=c.provider_room_id)
 union all select 'live_connection_context_mismatch',count(*) from public.live_channel_connections c
  left join public.live_integration_accounts a on a.workspace_id=c.workspace_id and a.id=c.channel_id
  left join public.live_sessions s on s.workspace_id=c.workspace_id and s.id=c.current_session_id
  left join public.live_campaigns p on p.workspace_id=s.workspace_id and p.id=s.campaign_id
  where c.connection_status='LIVE' and(c.desired_state<>'connected' or a.enabled is not true or s.status is distinct from 'live'
   or s.connection_status is distinct from 'connected' or p.status is distinct from 'active' or c.heartbeat_at is null)
 union all select 'disconnected_connection_retains_listener_lease',count(*) from public.live_channel_connections
  where desired_state='disconnected' and(lease_token is not null or lease_actor is not null or lease_expires_at is not null)
 union all select 'command_revision_ahead_of_connection',count(*) from public.live_channel_commands e
  left join public.live_channel_connections c on c.workspace_id=e.workspace_id and c.channel_id=e.channel_id
  where c.channel_id is null or e.revision>c.revision
), warnings as (
 select 'live_heartbeat_stale' name,count(*) count from public.live_channel_connections
  where connection_status='LIVE' and heartbeat_at<current_timestamp-interval '90 seconds'
 union all select 'connected_intent_without_current_listener',count(*) from public.live_channel_connections
  where desired_state='connected' and(lease_expires_at is null or lease_expires_at<=current_timestamp)
), failures as(select * from security_checks union all select * from reconciliation)
select jsonb_build_object(
 'checked_at',current_timestamp,
 'scope','Read-only administrator schema, privilege and aggregate reconciliation; provider connectivity and physical devices require separate acceptance.',
 'status',case when exists(select 1 from failures where issues<>0) then 'FAIL' else 'PASS' end,
 'failed_checks',(select count(*) from failures where issues<>0),
 'security_checks',(select jsonb_object_agg(name,issues order by name) from security_checks),
 'reconciliation',(select jsonb_object_agg(name,issues order by name) from reconciliation),
 'warnings',(select jsonb_object_agg(name,count order by name) from warnings),
 'metadata',jsonb_build_object('expected_tables',(select count(*) from expected_tables),'present_tables',(select count(*) from table_metadata where present),
  'expected_public_rpcs',6,'present_public_rpcs',(select count(*) from routine_metadata where not private and present),
  'expected_private_helpers',2,'expected_foreign_keys',(select count(*) from expected_links),'validated_foreign_keys',(select count(*) from link_metadata where enforced),
  'expected_unique_constraints',(select count(*) from expected_unique),'enforced_unique_constraints',(select count(*) from unique_metadata where enforced),
  'expected_guards',2,'enforced_guards',(select count(*) from trigger_metadata where enforced),'publications',(select count(*) from pg_publication)),
 'counts',jsonb_build_object('channels',(select count(*) from public.live_integration_accounts),
  'connections',(select count(*) from public.live_channel_connections),'commands',(select count(*) from public.live_channel_commands),
  'daily_campaign_mappings',(select count(*) from public.live_channel_campaigns),'room_session_mappings',(select count(*) from public.live_channel_sessions))
) as tiktok_channels_verification;
commit;
