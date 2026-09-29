-- READ ONLY. Run in SQL Editor as the database administrator AFTER 007 and 008
-- have both committed. Missing prerequisite tables cause a clear SQL error; do
-- not treat an incomplete installation or an RLS-filtered client run as a pass.
-- Returns one JSON cell: schema/security metadata and aggregate counts only.
-- No customer data, comments, IDs, receipt contents, keys or token values leave
-- the database. PASS is metadata/reconciliation, not live-provider, concurrent
-- session, Realtime transport or physical-printer acceptance.
begin transaction isolation level repeatable read read only;
set local search_path = pg_catalog;
with expected_tables(name, masked_column) as (values
 ('live_integration_accounts',null),('live_campaigns',null),('live_sessions',null),
 ('live_comments',null),('live_comment_claims','claim_token'),
 ('live_campaign_customers',null),('customer_carts',null),('live_sale_tickets',null),
 ('customer_cart_items',null),('live_print_jobs','lease_token'),
 ('live_print_attempts',null),('live_outbox_events',null)
), expected_routines(signature, private, definer) as (values
 ('public.save_live_integration_account(uuid,jsonb)',false,true),
 ('public.save_live_campaign(uuid,jsonb)',false,true),
 ('public.save_live_session(uuid,jsonb)',false,true),
 ('public.report_live_connection(uuid,uuid,text,text)',false,true),
 ('public.ingest_live_comments(uuid,uuid,jsonb)',false,true),
 ('public.claim_live_comment(uuid,uuid)',false,true),
 ('public.release_live_comment_claim(uuid,uuid,uuid)',false,true),
 ('public.get_live_intake(uuid,uuid,timestamptz,uuid,integer)',false,true),
 ('public.commit_live_sale_ticket(uuid,jsonb,uuid)',false,true),
 ('public.void_live_sale_ticket(uuid,uuid,date,text,uuid)',false,true),
 ('public.claim_live_print_job(uuid,uuid,uuid)',false,true),
 ('public.finish_live_print_job(uuid,uuid,uuid,text,text,uuid)',false,true),
 ('public.requeue_live_print_job(uuid,uuid,text,uuid)',false,true),
 ('public.get_live_commerce(uuid,uuid)',false,true),
 ('app_private.live_text(jsonb,text,integer,boolean)',true,false),
 ('app_private.live_replay(uuid,uuid,text,text)',true,true),
 ('app_private.live_remember(uuid,uuid,text,uuid,text,jsonb)',true,true),
 ('app_private.reserve_live_inventory(uuid,uuid,uuid,integer,date,text,text)',true,true),
 ('app_private.protect_live_hold()',true,true),
 ('app_private.protect_live_snapshot()',true,true)
), expected_links(child, parent, columns, referenced_columns) as (values
 ('live_campaigns','warehouses',array['workspace_id','warehouse_id'],array['workspace_id','id']),
 ('live_sessions','live_campaigns',array['workspace_id','campaign_id'],array['workspace_id','id']),
 ('live_sessions','live_integration_accounts',array['workspace_id','integration_account_id'],array['workspace_id','id']),
 ('live_comments','live_sessions',array['workspace_id','campaign_id','session_id'],array['workspace_id','campaign_id','id']),
 ('live_comment_claims','live_comments',array['workspace_id','comment_id'],array['workspace_id','id']),
 ('live_campaign_customers','live_campaigns',array['workspace_id','campaign_id'],array['workspace_id','id']),
 ('live_campaign_customers','customers',array['workspace_id','customer_id'],array['workspace_id','id']),
 ('customer_carts','live_campaign_customers',array['workspace_id','campaign_id','campaign_customer_id'],array['workspace_id','campaign_id','id']),
 ('live_sale_tickets','live_campaigns',array['workspace_id','campaign_id'],array['workspace_id','id']),
 ('live_sale_tickets','live_sessions',array['workspace_id','session_id'],array['workspace_id','id']),
 ('live_sale_tickets','live_comments',array['workspace_id','comment_id'],array['workspace_id','id']),
 ('live_sale_tickets','customer_carts',array['workspace_id','campaign_id','campaign_customer_id','cart_id'],array['workspace_id','campaign_id','campaign_customer_id','id']),
 ('live_sale_tickets','customers',array['workspace_id','customer_id'],array['workspace_id','id']),
 ('live_sale_tickets','products',array['workspace_id','product_id'],array['workspace_id','id']),
 ('live_sale_tickets','product_variants',array['workspace_id','variant_id'],array['workspace_id','id']),
 ('live_sale_tickets','inventory_reservations',array['workspace_id','reservation_id'],array['workspace_id','id']),
 ('inventory_reservations','live_sale_tickets',array['workspace_id','live_ticket_id'],array['workspace_id','id']),
 ('customer_cart_items','customer_carts',array['workspace_id','cart_id'],array['workspace_id','id']),
 ('customer_cart_items','live_sale_tickets',array['workspace_id','ticket_id'],array['workspace_id','id']),
 ('live_print_jobs','live_sale_tickets',array['workspace_id','ticket_id'],array['workspace_id','id']),
 ('live_print_attempts','live_print_jobs',array['workspace_id','job_id'],array['workspace_id','id']),
 ('live_outbox_events','live_sale_tickets',array['workspace_id','ticket_id'],array['workspace_id','id'])
), table_metadata as (
 select e.name,c.oid is not null as exists,c.relrowsecurity as rls,
  has_any_column_privilege('authenticated',c.oid,'SELECT') as authenticated_read,
  has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
   or has_any_column_privilege('authenticated',c.oid,'INSERT,UPDATE,REFERENCES') as authenticated_write,
  has_any_column_privilege('anon',c.oid,'SELECT') as anonymous_read,
  has_table_privilege('anon',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
   or has_any_column_privilege('anon',c.oid,'INSERT,UPDATE,REFERENCES') as anonymous_write,
  e.masked_column,
  case when e.masked_column is not null then has_column_privilege('authenticated',c.oid,e.masked_column,'SELECT') else false end as masked_column_readable,
  exists(select 1 from pg_constraint f where f.conrelid=c.oid and f.contype='f' and f.convalidated
   and f.confrelid='public.workspaces'::regclass
   and f.conkey=array[(select attnum from pg_attribute where attrelid=c.oid and attname='workspace_id')]::smallint[]) as workspace_fk,
  (select count(*) from pg_policies p where p.schemaname='public' and p.tablename=e.name
    and p.cmd='SELECT' and p.roles=array['authenticated']::name[] and p.permissive='PERMISSIVE'
    and regexp_replace(lower(p.qual),'[[:space:]]','','g')='(app_private.member_role(workspace_id)isnotnull)') as member_read_policies,
  (select count(*) from pg_policies p where p.schemaname='public' and p.tablename=e.name) as policy_count
 from expected_tables e left join pg_class c on c.relname=e.name and c.relnamespace='public'::regnamespace
), routine_metadata as (
 select e.signature,e.private,p.oid is not null as exists,p.prosecdef as security_definer,
  p.proconfig as config,e.definer as expected_definer,
  has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute,
  has_function_privilege('anon',p.oid,'EXECUTE') as anonymous_execute,
  exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') as public_execute
 from expected_routines e left join pg_proc p on p.oid=to_regprocedure(e.signature)
), foreign_keys as (
 select c.relname::text child,pr.relname::text parent,f.conname::text name,f.convalidated as validated,
  array(select a.attname::text from unnest(f.conkey) with ordinality k(num,ord)
   join pg_attribute a on a.attrelid=f.conrelid and a.attnum=k.num order by k.ord) as columns,
  array(select a.attname::text from unnest(f.confkey) with ordinality k(num,ord)
   join pg_attribute a on a.attrelid=f.confrelid and a.attnum=k.num order by k.ord) as referenced_columns
 from pg_constraint f join pg_class c on c.oid=f.conrelid join pg_class pr on pr.oid=f.confrelid
 where f.contype='f' and c.relnamespace='public'::regnamespace and pr.relnamespace='public'::regnamespace
  and (c.relname in(select name from expected_tables) or(c.relname='inventory_reservations' and pr.relname='live_sale_tickets'))
), link_metadata as (
 select e.*,exists(select 1 from foreign_keys f where f.child=e.child and f.parent=e.parent
  and f.columns=e.columns and f.referenced_columns=e.referenced_columns and f.validated) as validated
 from expected_links e
), expected_unique(table_name, columns) as (values
 ('public.live_comments',array['workspace_id','session_id','provider_message_id']),
 ('public.live_campaign_customers',array['workspace_id','campaign_id','provider','author_external_id']),
 ('public.live_campaign_customers',array['workspace_id','campaign_id','customer_no']),
 ('public.customer_carts',array['workspace_id','campaign_customer_id']),
 ('public.live_sale_tickets',array['workspace_id','comment_id']),
 ('public.live_sale_tickets',array['workspace_id','reservation_id']),
 ('public.customer_cart_items',array['workspace_id','ticket_id']),
 ('public.live_print_jobs',array['workspace_id','ticket_id']),
 ('public.live_print_attempts',array['workspace_id','job_id','attempt_no']),
 ('public.live_outbox_events',array['workspace_id','ticket_id','event_type']),
 ('public.inventory_reservations',array['workspace_id','live_ticket_id']),
 ('app_private.live_requests',array['workspace_id','request_id'])
), unique_metadata as (
 select e.*,exists(select 1 from pg_constraint c join pg_index i on i.indexrelid=c.conindid
  where c.conrelid=to_regclass(e.table_name) and c.contype in('p','u') and c.convalidated and i.indisvalid
  and e.columns=array(select a.attname::text from unnest(c.conkey) with ordinality k(num,ord)
   join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.num order by k.ord)) as enforced
 from expected_unique e
), expected_triggers(table_name, name, routine) as (values
 ('inventory_reservations','protect_live_hold','app_private.protect_live_hold()'),
 ('live_sale_tickets','protect_live_ticket_snapshot','app_private.protect_live_snapshot()'),
 ('live_print_jobs','protect_live_print_snapshot','app_private.protect_live_snapshot()')
), trigger_metadata as (
 select e.*,exists(select 1 from pg_trigger t where t.tgrelid=to_regclass('public.'||e.table_name)
  and t.tgname=e.name and t.tgenabled in('O','A') and t.tgfoid=to_regprocedure(e.routine)
  and t.tgtype=19 and not t.tgisinternal and t.tgqual is null) as enforced from expected_triggers e
), publication_metadata as (
 select p.pubname as name,p.puballtables as all_tables,
  coalesce((select jsonb_agg(jsonb_build_object('table',t.schemaname||'.'||t.tablename,'columns',to_jsonb(t)->'attnames') order by t.schemaname,t.tablename)
   from pg_publication_tables t where t.pubname=p.pubname and(t.tablename in(select name from expected_tables) or t.schemaname='app_private')),'[]') as live_tables,
  (select count(*) from pg_publication_tables t where t.pubname=p.pubname and t.schemaname='public'
   and ((t.tablename='live_comment_claims' and (current_setting('server_version_num')::int<150000 or coalesce(to_jsonb(t)->'attnames','[]')?'claim_token'))
     or(t.tablename='live_print_jobs' and (current_setting('server_version_num')::int<150000 or coalesce(to_jsonb(t)->'attnames','[]')?'lease_token')))) as exposed_token_tables,
  (select count(*) from pg_publication_tables t where t.pubname=p.pubname and t.schemaname='app_private' and t.tablename='live_requests') as exposed_request_registry
 from pg_publication p
), lot_holds as (
 select workspace_id,lot_id,sum(qty) qty from (
  select workspace_id,lot_id,qty from public.sales_allocations where status='reserved'
  union all select a.workspace_id,a.lot_id,a.qty from public.reservation_lots a
   join public.inventory_reservations r on r.workspace_id=a.workspace_id and r.id=a.reservation_id where r.status='active'
 ) held group by workspace_id,lot_id
), reconciliation as (
 select 'comment_ticket_state_mismatch' name,count(*) issues from public.live_comments c left join public.live_sale_tickets t on t.workspace_id=c.workspace_id and t.comment_id=c.id
  where(c.state='new' and t.id is not null) or(c.state<>'new' and(t.id is null or c.state<>t.status))
 union all select 'ticket_context_mismatch',count(*) from public.live_sale_tickets t
  left join public.live_comments m on m.workspace_id=t.workspace_id and m.id=t.comment_id
  left join public.live_sessions s on s.workspace_id=t.workspace_id and s.id=t.session_id
  left join public.customer_carts c on c.workspace_id=t.workspace_id and c.id=t.cart_id
  left join public.live_campaign_customers cc on cc.workspace_id=t.workspace_id and cc.id=t.campaign_customer_id
  where m.id is null or s.id is null or c.id is null or cc.id is null or m.campaign_id<>t.campaign_id or m.session_id<>t.session_id
   or s.campaign_id<>t.campaign_id or c.campaign_id<>t.campaign_id or c.campaign_customer_id<>t.campaign_customer_id
   or cc.campaign_id<>t.campaign_id or cc.provider<>s.provider or cc.author_external_id<>m.author_external_id
 union all select 'ticket_item_mismatch',count(*) from public.live_sale_tickets t
  where(select count(*) from public.customer_cart_items i where i.workspace_id=t.workspace_id and i.ticket_id=t.id and i.cart_id=t.cart_id
   and i.qty=t.qty and i.unit_price=t.unit_price and i.line_total=t.line_total and i.status=case when t.status='committed' then 'active' else 'voided' end)<>1
 union all select 'ticket_hold_mismatch',count(*) from public.live_sale_tickets t
  left join public.inventory_reservations r on r.workspace_id=t.workspace_id and r.id=t.reservation_id
  left join public.live_campaigns c on c.workspace_id=t.workspace_id and c.id=t.campaign_id
  where r.id is null or r.live_ticket_id is distinct from t.id or r.product_id<>t.product_id or r.qty<>t.qty or r.warehouse_id<>c.warehouse_id
   or r.status<>case when t.status='committed' then 'active' else 'released' end or r.order_id is not null
 union all select 'live_hold_ticket_mismatch',count(*) from public.inventory_reservations r
  left join public.live_sale_tickets t on t.workspace_id=r.workspace_id and t.id=r.live_ticket_id
  where r.live_ticket_id is not null and(t.id is null or t.reservation_id<>r.id)
 union all select 'ticket_print_job_mismatch',count(*) from public.live_sale_tickets t
  where(select count(*) from public.live_print_jobs j where j.workspace_id=t.workspace_id and j.ticket_id=t.id
   and((t.status='voided' and j.status='cancelled') or(t.status='committed' and j.status<>'cancelled')))<>1
 union all select 'print_snapshot_mismatch',count(*) from public.live_print_jobs j
  join public.live_sale_tickets t on t.workspace_id=j.workspace_id and t.id=j.ticket_id
  where j.snapshot->>'ticket_no' is distinct from t.ticket_no
   or j.snapshot->'customer_no' is distinct from t.customer_snapshot->'customer_no'
   or j.snapshot->>'customer_name' is distinct from t.customer_snapshot->>'name'
   or j.snapshot->'total_amount' is distinct from to_jsonb(t.line_total::text)
   or (j.snapshot->>'committed_at')::timestamptz is distinct from t.committed_at
   or j.snapshot->'lines' is distinct from jsonb_build_array(t.product_snapshot||jsonb_build_object('qty',t.qty,'unit_price',t.unit_price::text,'line_total',t.line_total::text))
 union all select 'print_attempt_state_mismatch',count(*) from public.live_print_jobs j
  where(select count(*) from public.live_print_attempts a where a.workspace_id=j.workspace_id and a.job_id=j.id and a.status='started')<>case when j.status='printing' then 1 else 0 end
   or(j.status='printed' and(select a.status from public.live_print_attempts a where a.workspace_id=j.workspace_id and a.job_id=j.id order by attempt_no desc limit 1) is distinct from 'printed')
   or(j.status='failed' and coalesce((select a.status from public.live_print_attempts a where a.workspace_id=j.workspace_id and a.job_id=j.id order by attempt_no desc limit 1),'') not in('failed','unknown'))
   or(j.status='printing' and not exists(select 1 from public.live_print_attempts a where a.workspace_id=j.workspace_id and a.job_id=j.id and a.status='started' and a.actor_id=j.lease_actor))
 union all select 'ticket_outbox_mismatch',count(*) from public.live_sale_tickets t
  where(select count(*) from public.live_outbox_events e where e.workspace_id=t.workspace_id and e.ticket_id=t.id and e.event_type='committed')<>1
   or(select count(*) from public.live_outbox_events e where e.workspace_id=t.workspace_id and e.ticket_id=t.id and e.event_type='voided')<>case when t.status='voided' then 1 else 0 end
 union all select 'cart_quantity_or_amount_mismatch',count(*) from public.customer_carts c
  where(select coalesce(sum(qty),0) from public.customer_cart_items i where i.workspace_id=c.workspace_id and i.cart_id=c.id and i.status='active')
    <>(select coalesce(sum(qty),0) from public.live_sale_tickets t where t.workspace_id=c.workspace_id and t.cart_id=c.id and t.status='committed')
   or(select coalesce(sum(line_total),0) from public.customer_cart_items i where i.workspace_id=c.workspace_id and i.cart_id=c.id and i.status='active')
    <>(select coalesce(sum(line_total),0) from public.live_sale_tickets t where t.workspace_id=c.workspace_id and t.cart_id=c.id and t.status='committed')
 union all select 'hold_allocation_quantity_mismatch',count(*) from public.inventory_reservations r
  where r.qty<>(select coalesce(sum(a.qty),0) from public.reservation_lots a where a.workspace_id=r.workspace_id and a.reservation_id=r.id)
 union all select 'hold_allocation_product_or_warehouse_mismatch',count(*) from public.reservation_lots a
  join public.inventory_reservations r on r.workspace_id=a.workspace_id and r.id=a.reservation_id
  join public.inventory_lots l on l.workspace_id=a.workspace_id and l.id=a.lot_id where r.product_id<>l.product_id or r.warehouse_id<>l.warehouse_id
 union all select 'negative_available_lots',count(*) from public.inventory_lots l join lot_holds h on h.workspace_id=l.workspace_id and h.lot_id=l.id where l.remaining_qty<h.qty
 union all select 'orphan_items_jobs_attempts_or_outbox',
  (select count(*) from public.customer_cart_items i where not exists(select 1 from public.live_sale_tickets t where t.workspace_id=i.workspace_id and t.id=i.ticket_id))+
  (select count(*) from public.live_print_jobs j where not exists(select 1 from public.live_sale_tickets t where t.workspace_id=j.workspace_id and t.id=j.ticket_id))+
  (select count(*) from public.live_print_attempts a where not exists(select 1 from public.live_print_jobs j where j.workspace_id=a.workspace_id and j.id=a.job_id))+
  (select count(*) from public.live_outbox_events e where not exists(select 1 from public.live_sale_tickets t where t.workspace_id=e.workspace_id and t.id=e.ticket_id))
), security_checks as (
 select 'administrator_visibility_required' name,case when exists(select 1 from pg_roles where rolname=current_user and(rolsuper or rolbypassrls)) then 0 else 1 end::bigint issues
 union all select 'table_rls_grants_or_policy_mismatch',count(*) from table_metadata where exists is not true or rls is not true or authenticated_read is not true
  or authenticated_write is not false or anonymous_read is not false or anonymous_write is not false or masked_column_readable is not false
  or workspace_fk is not true or member_read_policies<>1 or policy_count<>1
 union all select 'routine_grants_or_configuration_mismatch',count(*) from routine_metadata where exists is not true or security_definer is distinct from expected_definer
  or authenticated_execute is distinct from(not private) or anonymous_execute is not false or public_execute is not false or not coalesce(config@>array['search_path=""'],false)
 union all select 'unexpected_live_rpc_overloads',count(*) from pg_proc p where p.pronamespace='public'::regnamespace
  and p.proname in(select split_part(split_part(signature,'.',2),'(',1) from expected_routines where not private)
  and not exists(select 1 from expected_routines e where to_regprocedure(e.signature)=p.oid)
 union all select 'missing_or_unvalidated_workspace_links',count(*) from link_metadata where not validated
 union all select 'non_composite_workspace_links',count(*) from foreign_keys where parent<>'workspaces'
  and not('workspace_id'=any(columns) and 'workspace_id'=any(referenced_columns)
   and array_position(columns,'workspace_id')=array_position(referenced_columns,'workspace_id'))
 union all select 'missing_duplicate_protection',count(*) from unique_metadata where not enforced
 union all select 'missing_immutable_or_hold_trigger',count(*) from trigger_metadata where not enforced
 union all select 'private_request_registry_exposed',case when to_regclass('app_private.live_requests') is null
  or has_any_column_privilege('authenticated','app_private.live_requests','SELECT,INSERT,UPDATE,REFERENCES')
  or has_any_column_privilege('anon','app_private.live_requests','SELECT,INSERT,UPDATE,REFERENCES')
  or has_table_privilege('authenticated','app_private.live_requests','DELETE,TRUNCATE,TRIGGER')
  or has_table_privilege('anon','app_private.live_requests','DELETE,TRUNCATE,TRIGGER') then 1 else 0 end
 union all select 'publication_exposes_private_tokens_or_requests',coalesce(sum(exposed_token_tables+exposed_request_registry),0)::bigint from publication_metadata
), expected_realtime(name) as (values('live_integration_accounts'),('live_campaigns'),('live_sessions'),('live_comments'),('live_sale_tickets'),('customer_cart_items')),
warnings as (
 select 'realtime_not_configured_polling_required' name,case when exists(select 1 from pg_publication where pubname='supabase_realtime') then 0 else 1 end::bigint count
 union all select 'realtime_expected_tables_missing_polling_required',count(*) from expected_realtime e where exists(select 1 from pg_publication where pubname='supabase_realtime')
  and not exists(select 1 from pg_publication_tables p where p.pubname='supabase_realtime' and p.schemaname='public' and p.tablename=e.name)
 union all select 'claims_or_print_jobs_unpublished_polling_required',count(*) from(values('live_comment_claims'),('live_print_jobs')) e(name)
  where not exists(select 1 from pg_publication_tables p where p.pubname='supabase_realtime' and p.schemaname='public' and p.tablename=e.name)
 union all select 'expired_print_leases_need_operator_reconciliation',count(*) from public.live_print_jobs where status='printing' and lease_expires_at<=current_timestamp
 union all select 'failed_or_unknown_print_jobs_need_operator_review',count(*) from public.live_print_jobs where status='failed'
), failures as (select * from security_checks union all select * from reconciliation)
select jsonb_build_object(
 'checked_at',current_timestamp,
 'scope','Read-only administrator metadata and aggregate reconciliation; no external provider, multi-session concurrency, Realtime delivery or physical printer acceptance.',
 'status',case when exists(select 1 from failures where issues<>0) then 'FAIL' else 'PASS' end,
 'failed_checks',(select count(*) from failures where issues<>0),
 'security_checks',(select jsonb_object_agg(name,issues order by name) from security_checks),
 'reconciliation',(select jsonb_object_agg(name,issues order by name) from reconciliation),
 'warnings',(select jsonb_object_agg(name,count order by name) from warnings),
 'tables',(select jsonb_agg(to_jsonb(t) order by name) from table_metadata t),
 'routines',(select jsonb_agg(to_jsonb(r) order by signature) from routine_metadata r),
 'workspace_links',(select jsonb_agg(to_jsonb(l) order by child,parent) from link_metadata l),
 'duplicate_protection',(select jsonb_agg(to_jsonb(u) order by table_name,columns) from unique_metadata u),
 'immutable_triggers',(select jsonb_agg(to_jsonb(t) order by table_name,name) from trigger_metadata t),
 'publications',(select coalesce(jsonb_agg(to_jsonb(p) order by name),'[]') from publication_metadata p),
 'counts',jsonb_build_object(
  'comments',(select count(*) from public.live_comments),
  'committed_tickets',(select count(*) from public.live_sale_tickets where status='committed'),
  'voided_tickets',(select count(*) from public.live_sale_tickets where status='voided'),
  'carts',(select count(*) from public.customer_carts),
  'committed_ticket_qty',(select coalesce(sum(qty),0) from public.live_sale_tickets where status='committed'),
  'active_cart_item_qty',(select coalesce(sum(qty),0) from public.customer_cart_items where status='active'),
  'active_live_hold_qty',(select coalesce(sum(qty),0) from public.inventory_reservations where live_ticket_id is not null and status='active'),
  'print_jobs',(select count(*) from public.live_print_jobs),
  'print_attempts',(select count(*) from public.live_print_attempts),
  'outbox_events',(select count(*) from public.live_outbox_events)
 )
) as phase_c_verification;
commit;
