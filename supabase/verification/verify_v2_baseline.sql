-- A1: one JSON cell to copy/export from the existing project's SQL Editor.
-- Metadata only: no migration, DDL, business rows, impersonation or credentials.
begin transaction read only;
set local search_path = pg_catalog;

with expected_tables(schema_name, table_name) as (values
 ('public','customers'),('public','sales_orders'),
 ('public','sales_order_lines'),('public','sales_events'),
 ('public','inventory_lots'),('public','sales_allocations'),
 ('app_private','inventory_timeline'),('app_private','sales_requests')
), tables as (
select e.schema_name,e.table_name,c.oid is not null as present,c.relkind::text as relation_kind,
 c.relrowsecurity as rls,c.relforcerowsecurity as force_rls,
 has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as anon_any,
 has_table_privilege('authenticated',c.oid,'SELECT') as authenticated_select,
 has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as authenticated_write,
 has_any_column_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,REFERENCES') as anon_column_any,
 has_any_column_privilege('authenticated',c.oid,'INSERT,UPDATE,REFERENCES') as authenticated_column_write
from expected_tables e left join pg_class c on c.oid=to_regclass(format('%I.%I',e.schema_name,e.table_name))
),

expected_routines(signature, public_rpc) as (values
 ('public.post_purchase(uuid,uuid)',true),
 ('public.reverse_document(text,uuid,uuid,date,text)',true),
 ('public.save_customer(uuid,jsonb)',true),
 ('public.save_sales_order(uuid,jsonb)',true),
 ('public.transition_sales_order(uuid,uuid,text,jsonb,uuid)',true),
 ('public.get_sales_state(uuid)',true),
 ('app_private.post_purchase_v1(uuid,uuid)',false),
 ('app_private.reverse_document_v1(text,uuid,uuid,date,text)',false),
 ('app_private.lock_inventory(uuid,text[])',false),
 ('app_private.stock_date(uuid,uuid,uuid,date)',false)
), routines as (
select e.signature,e.public_rpc,p.oid is not null as present,p.prosecdef as security_definer,
 pg_get_function_arguments(p.oid) as arguments,pg_get_function_result(p.oid) as result_type,
 p.provolatile::text as volatility,l.lanname as language,p.proisstrict as strict,p.proleakproof as leakproof,
 p.proconfig as settings,has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
 has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute,
 md5(replace(p.prosrc,E'\r\n',E'\n')) as function_body_md5
from expected_routines e left join pg_proc p on p.oid=to_regprocedure(e.signature)
left join pg_language l on l.oid=p.prolang
),

policies as (
select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check
from pg_policies where schemaname='public' and tablename in
 ('customers','sales_orders','sales_order_lines','sales_events','inventory_lots','sales_allocations')
),

columns as (
select n.nspname as schema_name,c.relname as table_name,a.attname as column_name,
 format_type(a.atttypid,a.atttypmod) as data_type,a.attnotnull as not_null,
 a.attidentity::text as identity_kind,a.attgenerated::text as generated_kind,
 pg_get_expr(d.adbin,d.adrelid) as default_expression
from pg_class c join pg_namespace n on n.oid=c.relnamespace
join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
where (n.nspname='public' and c.relname in
 ('customers','sales_orders','sales_order_lines','sales_events','inventory_lots','sales_allocations'))
 or (n.nspname='app_private' and c.relname in ('inventory_timeline','sales_requests'))
),

constraints as (
select n.nspname as schema_name,c.relname as table_name,k.conname,
 k.contype,k.condeferrable,k.condeferred,k.convalidated,pg_get_constraintdef(k.oid) as definition
from pg_constraint k join pg_class c on c.oid=k.conrelid
join pg_namespace n on n.oid=c.relnamespace
where (n.nspname='public' and c.relname in
 ('customers','sales_orders','sales_order_lines','sales_events','inventory_lots','sales_allocations'))
 or (n.nspname='app_private' and c.relname in ('inventory_timeline','sales_requests'))
)
select jsonb_build_object(
 'format_version',1,
 'checked_at',current_timestamp,
 'server_version_num',current_setting('server_version_num'),
 'scope','v2_catalog_only',
 'tables',(select coalesce(jsonb_agg(to_jsonb(t) order by schema_name,table_name),'[]'::jsonb) from tables t),
 'routines',(select coalesce(jsonb_agg(to_jsonb(r) order by signature),'[]'::jsonb) from routines r),
 'policies',(select coalesce(jsonb_agg(to_jsonb(p) order by schemaname,tablename,policyname),'[]'::jsonb) from policies p),
 'columns',(select coalesce(jsonb_agg(to_jsonb(c) order by schema_name,table_name,column_name),'[]'::jsonb) from columns c),
 'constraints',(select coalesce(jsonb_agg(to_jsonb(c) order by schema_name,table_name,conname),'[]'::jsonb) from constraints c)
) as v2_baseline;
commit;
