-- Extend the 021 PDF intake with an explicit ERP cash account and a count of
-- CCTG rows deliberately excluded from Thu Chi. No CCTG row data is stored.
-- Existing Excel staging and the 016 confirmation/ledger path are unchanged.
begin;

do $$begin
 if to_regprocedure('public.stage_pdf_bank_statement(uuid,jsonb,uuid)') is null
    or to_regclass('public.bank_statement_batches') is null
    or to_regclass('public.bank_statement_rows') is null then
  raise exception 'PDF_BANK_PREREQUISITE: Apply migrations 016 and 021 before 022.';
 end if;
end $$;

alter table public.bank_statement_batches add column account_id uuid;
alter table public.bank_statement_batches add column excluded_cctg_count integer not null default 0
 check(excluded_cctg_count between 0 and 5000);
alter table public.bank_statement_batches add column excluded_cctg_confirmed boolean not null default false;
alter table public.bank_statement_batches add constraint pdf_bank_batch_account_workspace
 foreign key(workspace_id,account_id) references public.cash_accounts(workspace_id,id);
alter table public.bank_statement_batches add constraint pdf_bank_exclusion_state
 check((source_format='excel' and account_id is null and excluded_cctg_count=0
          and not excluded_cctg_confirmed)
    or (source_format='pdf' and excluded_cctg_confirmed=(excluded_cctg_count>0)));

-- The old PDF RPC remains private so this wrapper can reuse its strict row
-- validation and its transaction-safe SHA/request idempotency. Browser callers
-- must provide the verified account and exclusion metadata to this RPC.
create function public.stage_pdf_bank_statement_verified(
 p_workspace_id uuid,p_payload jsonb,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare account_value uuid;excluded_count integer;excluded_confirmed boolean;
 base_payload jsonb;stage_result jsonb;batch_value public.bank_statement_batches;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 if p_request_id is null then
  raise exception 'PDF_BANK_REQUEST: request_id is required.';
 end if;
 if jsonb_typeof(p_payload) is distinct from 'object' or exists(
  select 1 from jsonb_object_keys(p_payload) k where k not in
   ('source_sha256','currency_confirmed_vnd','rows','account_id',
    'excluded_cctg_count','excluded_cctg_confirmed')) then
  raise exception 'PDF_BANK_ALLOWLIST: Unsupported PDF staging field.';
 end if;
 if jsonb_typeof(p_payload->'account_id') is distinct from 'string' or
    (p_payload->>'account_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
  raise exception 'PDF_BANK_ACCOUNT: Select an existing ERP payment account.';
 end if;
 account_value:=(p_payload->>'account_id')::uuid;
 if not exists(select 1 from public.cash_accounts a
    where a.workspace_id=p_workspace_id and a.id=account_value) then
  raise exception 'PDF_BANK_ACCOUNT: Account is outside this workspace.';
 end if;
 if jsonb_typeof(p_payload->'excluded_cctg_count') is distinct from 'number' or
    (p_payload->>'excluded_cctg_count') !~ '^(0|[1-9][0-9]{0,9})$' then
  raise exception 'PDF_BANK_CCTG: Excluded CCTG count must be a nonnegative integer.';
 end if;
 if (p_payload->>'excluded_cctg_count')::bigint > 5000 then
  raise exception 'PDF_BANK_CCTG: Excluded CCTG count exceeds the supported statement limit.';
 end if;
 excluded_count:=(p_payload->>'excluded_cctg_count')::integer;
 if jsonb_typeof(p_payload->'excluded_cctg_confirmed') is distinct from 'boolean' then
  raise exception 'PDF_BANK_CCTG: Exclusion confirmation must be boolean.';
 end if;
 excluded_confirmed:=(p_payload->>'excluded_cctg_confirmed')::boolean;
 if excluded_confirmed is distinct from (excluded_count>0) then
  raise exception 'PDF_BANK_CCTG: Confirm exclusion whenever CCTG rows are present.';
 end if;
 base_payload:=p_payload-'account_id'-'excluded_cctg_count'-'excluded_cctg_confirmed';
 stage_result:=public.stage_pdf_bank_statement(p_workspace_id,base_payload,p_request_id);
 select * into batch_value from public.bank_statement_batches
  where workspace_id=p_workspace_id and id=(stage_result->>'batch_id')::uuid for update;
 if not found or batch_value.source_format<>'pdf' then
  raise exception 'PDF_BANK_BATCH: Expected a PDF staging batch.';
 end if;
 if batch_value.account_id is null then
  -- A batch created before 022 can be adopted only when every pending row's
  -- account is empty or already agrees. A posted legacy batch cannot acquire
  -- a new CCTG exclusion count after the financial event occurred.
  if exists(select 1 from public.bank_statement_rows r
      where r.workspace_id=p_workspace_id and r.batch_id=batch_value.id
       and r.account_id is not null and r.account_id<>account_value)
     or (excluded_count>0 and exists(select 1 from public.bank_statement_rows r
       where r.workspace_id=p_workspace_id and r.batch_id=batch_value.id and r.status='confirmed')) then
   raise exception 'PDF_BANK_LEGACY_BATCH: Existing PDF rows conflict with account or exclusion mapping.';
  end if;
  update public.bank_statement_rows set account_id=account_value,updated_at=clock_timestamp()
   where workspace_id=p_workspace_id and batch_id=batch_value.id and account_id is null;
  update public.bank_statement_batches set account_id=account_value,
   excluded_cctg_count=excluded_count,excluded_cctg_confirmed=excluded_confirmed,
   updated_at=clock_timestamp()
   where workspace_id=p_workspace_id and id=batch_value.id;
  perform app_private.audit(p_workspace_id,'bank_statement.pdf_source_verified',batch_value.id,
   jsonb_build_object('account_id',account_value,
    'excluded_cctg_count',excluded_count,'excluded_cctg_confirmed',excluded_confirmed,
    'request_id',p_request_id));
 elsif batch_value.account_id<>account_value or
       batch_value.excluded_cctg_count<>excluded_count or
       batch_value.excluded_cctg_confirmed<>excluded_confirmed then
  raise exception 'PDF_BANK_FILE_CHANGED: Account or CCTG exclusion changed for this file.';
 end if;
 return stage_result||jsonb_build_object('account_id',account_value,
  'excluded_cctg_count',excluded_count,'excluded_cctg_confirmed',excluded_confirmed);
end $$;

revoke all on function public.stage_pdf_bank_statement(uuid,jsonb,uuid)
 from public,anon,authenticated;
revoke all on function public.stage_pdf_bank_statement_verified(uuid,jsonb,uuid)
 from public,anon;
grant execute on function public.stage_pdf_bank_statement_verified(uuid,jsonb,uuid)
 to authenticated;

commit;
