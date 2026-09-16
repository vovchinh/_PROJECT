-- READ ONLY, after successful 004 -> 005 -> 006. One JSON cell; no customer
-- names, addresses, aliases, transaction rows, keys or tokens are exported.
begin transaction read only;
set local search_path = pg_catalog;
with expected_tables(name) as (values
 ('product_styles'),('product_variants'),('product_aliases'),
 ('customer_identities'),('customer_addresses'),('payment_intents'),
 ('inventory_reservations'),('reservation_lots')
), expected_routines(name) as (values
 ('get_catalog_state'),('save_product_style'),('save_product_variant'),('save_product_alias'),('resolve_product_alias'),
 ('get_customer_foundation'),('save_customer_identity'),('save_customer_address'),('set_order_address'),
 ('save_order_payment_intent'),('void_order_payment_intent'),
 ('get_inventory_foundation'),('reserve_inventory'),('release_inventory_reservation'),('transfer_inventory_reservations')
), lot_holds as (
 select workspace_id,lot_id,sum(qty) qty from (
  select workspace_id,lot_id,qty from public.sales_allocations where status='reserved'
  union all
  select a.workspace_id,a.lot_id,a.qty from public.reservation_lots a
  join public.inventory_reservations r on r.workspace_id=a.workspace_id and r.id=a.reservation_id
  where r.status='active'
 ) held group by workspace_id,lot_id
)
select jsonb_build_object(
 'checked_at',current_timestamp,
 'scope','Metadata + aggregate reconciliation only; not authenticated runtime acceptance',
 'tables',(select jsonb_agg(jsonb_build_object('name',e.name,'exists',c.oid is not null,'rls',c.relrowsecurity,
   'authenticated_select',case when c.oid is not null then has_table_privilege('authenticated',c.oid,'SELECT') else false end,
   'authenticated_write',case when c.oid is not null then has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE') or has_any_column_privilege('authenticated',c.oid,'INSERT,UPDATE') else false end,
   'anonymous_select',case when c.oid is not null then has_table_privilege('anon',c.oid,'SELECT') else false end) order by e.name)
   from expected_tables e left join pg_class c on c.relname=e.name and c.relnamespace='public'::regnamespace),
 'routines',(select jsonb_agg(jsonb_build_object('name',e.name,'signature',p.oid::regprocedure::text,
   'security_definer',p.prosecdef,'config',p.proconfig,
   'authenticated_execute',case when p.oid is not null then has_function_privilege('authenticated',p.oid,'EXECUTE') else false end,
   'anonymous_execute',case when p.oid is not null then has_function_privilege('anon',p.oid,'EXECUTE') else false end) order by e.name)
   from expected_routines e left join pg_proc p on p.proname=e.name and p.pronamespace='public'::regnamespace),
 'policies',(select jsonb_agg(to_jsonb(p)) from pg_policies p where p.schemaname='public' and p.tablename in (select name from expected_tables)),
 'reconciliation',jsonb_build_object(
   'products',(select count(*) from public.products),
   'variants',(select count(*) from public.product_variants),
   'products_without_compatible_variant',(select count(*) from public.products p where not exists(select 1 from public.product_variants v where v.workspace_id=p.workspace_id and v.product_id=p.id and v.id=p.id)),
   'variant_rows_requiring_review',(select count(*) from public.product_variants where mapping_status='needs_review'),
   'negative_available_lots',(select count(*) from public.inventory_lots l join lot_holds h on h.workspace_id=l.workspace_id and h.lot_id=l.id where l.remaining_qty<h.qty),
   'manual_hold_allocation_mismatch',(select count(*) from public.inventory_reservations r where r.qty<>(select coalesce(sum(a.qty),0) from public.reservation_lots a where a.workspace_id=r.workspace_id and a.reservation_id=r.id)),
   'legacy_orders_without_snapshot',(select count(*) from public.sales_orders where snapshot_source='legacy_unavailable' and customer_snapshot is null)
 )
) as phase_b_verification;
commit;
