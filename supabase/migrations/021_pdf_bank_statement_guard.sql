-- PDF bank statements use the 016 staging/Thu Chi ledger, with a server-owned
-- source marker and a strict transaction-only payload. Apply after 020.
-- No original PDF, account-holder data, filename, page text or balances are stored.
begin;

do $$begin
 if to_regclass('public.bank_statement_rows') is null
    or to_regprocedure('public.get_workspace_report(uuid,date,date)') is null
    or to_regprocedure('app_private.hr_cash_visible(uuid,uuid)') is null then
  raise exception 'PDF_BANK_PREREQUISITE: Apply migrations 016 and 019 before 021.';
 end if;
end $$;

alter table public.bank_statement_batches add column source_format text not null default 'excel'
 check(source_format in ('excel','pdf'));
alter table public.bank_statement_batches add column currency_confirmed_vnd boolean not null default false;
alter table public.bank_statement_batches add constraint pdf_bank_currency_confirmed
 check(source_format<>'pdf' or currency_confirmed_vnd);
create index bank_statement_batches_format on public.bank_statement_batches(workspace_id,source_format,id);

-- The recursive branch keeps a corrected/replacement voucher private as long
-- as its source chain ultimately contains a PDF voucher. UNION terminates cycles.
create function app_private.pdf_cash_visible(p_workspace_id uuid,p_cash_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
 with recursive source_cash(id) as (
  select p_cash_id
  union
  select case when t.provenance->>'correction_of' ~
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
   then (t.provenance->>'correction_of')::uuid end
  from source_cash s join public.cash_transactions t
   on t.workspace_id=p_workspace_id and t.id=s.id
  where t.provenance ? 'correction_of'
 )
 select app_private.member_role(p_workspace_id) in ('owner','manager')
   or not exists(select 1 from source_cash s
    join public.bank_statement_rows r on r.workspace_id=p_workspace_id and r.cash_id=s.id
    join public.bank_statement_batches b on b.workspace_id=r.workspace_id and b.id=r.batch_id
    where b.source_format='pdf')
$$;

create function app_private.pdf_bank_row_visible(p_workspace_id uuid,p_batch_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select app_private.member_role(p_workspace_id) in ('owner','manager')
   or not exists(select 1 from public.bank_statement_batches b
      where b.workspace_id=p_workspace_id and b.id=p_batch_id and b.source_format='pdf')
$$;

create function app_private.pdf_audit_visible(p_workspace_id uuid,p_action text,p_entity_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select app_private.member_role(p_workspace_id) in ('owner','manager')
  or (case
   when p_action like 'bank_statement.%' then
    not exists(select 1 from public.bank_statement_batches b
      where b.workspace_id=p_workspace_id and b.id=p_entity_id and b.source_format='pdf')
    and not exists(select 1 from public.bank_statement_rows r
      join public.bank_statement_batches b on b.workspace_id=r.workspace_id and b.id=r.batch_id
      where r.workspace_id=p_workspace_id and r.id=p_entity_id and b.source_format='pdf')
   when p_action like 'cash.%' then app_private.pdf_cash_visible(p_workspace_id,p_entity_id)
   else true end)
$$;

drop policy member_read on public.bank_statement_batches;
create policy member_read on public.bank_statement_batches for select to authenticated
 using(app_private.member_role(workspace_id) is not null
   and (source_format='excel' or app_private.member_role(workspace_id) in ('owner','manager')));
drop policy member_read on public.bank_statement_rows;
create policy member_read on public.bank_statement_rows for select to authenticated
 using(app_private.member_role(workspace_id) is not null
   and app_private.pdf_bank_row_visible(workspace_id,batch_id));
drop policy member_read on public.cash_transactions;
create policy member_read on public.cash_transactions for select to authenticated
 using(app_private.member_role(workspace_id) is not null
   and app_private.hr_cash_visible(workspace_id,id)
   and app_private.pdf_cash_visible(workspace_id,id));
drop policy member_read on public.cash_movements;
create policy member_read on public.cash_movements for select to authenticated
 using(app_private.member_role(workspace_id) is not null
   and app_private.hr_cash_visible(workspace_id,cash_id)
   and app_private.pdf_cash_visible(workspace_id,cash_id));
drop policy member_read on public.cash_category_snapshots;
create policy member_read on public.cash_category_snapshots for select to authenticated
 using(app_private.member_role(workspace_id) is not null
   and app_private.hr_cash_visible(workspace_id,cash_id)
   and app_private.pdf_cash_visible(workspace_id,cash_id));
drop policy member_read on public.document_corrections;
create policy member_read on public.document_corrections for select to authenticated
 using(app_private.member_role(workspace_id) is not null and
   (kind<>'cash' or (app_private.pdf_cash_visible(workspace_id,cash_original_id)
     and app_private.pdf_cash_visible(workspace_id,cash_replacement_id))));
drop policy member_read on public.audit_events;
create policy member_read on public.audit_events for select to authenticated
 using(app_private.member_role(workspace_id) is not null
   and (app_private.member_role(workspace_id) in ('owner','manager')
    or (action not like 'hr.%'
      and (entity_id is null or app_private.hr_cash_visible(workspace_id,entity_id))
      and app_private.pdf_audit_visible(workspace_id,action,entity_id))));

-- 016's SECURITY DEFINER preview bypasses table RLS. Keep its output and
-- pagination contract, but check the server-owned source marker first.
create or replace function public.get_bank_statement_import(p_workspace_id uuid,p_batch_id uuid,
 p_offset integer default 0,p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare b public.bank_statement_batches;result jsonb;
begin
 perform app_private.require_role(p_workspace_id,array['owner','manager','staff','viewer']);
 if p_offset is null or p_offset<0 or p_limit is null or p_limit not between 1 and 200 then
  raise exception 'BANK_PAGE: Offset must be >= 0 and page size 1-200.';
 end if;
 select * into b from public.bank_statement_batches where workspace_id=p_workspace_id and id=p_batch_id;
 if not found then raise exception 'BANK_BATCH_NOT_FOUND: Batch is outside this workspace.';end if;
 if b.source_format='pdf' then perform app_private.require_role(p_workspace_id,array['owner','manager']);end if;
 select jsonb_build_object(
  'batch',to_jsonb(b),
  'rows',coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('duplicate',app_private.bank_duplicate_counts(p_workspace_id,r.id)) order by r.row_number) filter(where r.id is not null),'[]'::jsonb),
  'total',(select count(*) from public.bank_statement_rows where workspace_id=p_workspace_id and batch_id=p_batch_id),
  'pending',(select count(*) from public.bank_statement_rows where workspace_id=p_workspace_id and batch_id=p_batch_id and status='pending'),
  'confirmed',(select count(*) from public.bank_statement_rows where workspace_id=p_workspace_id and batch_id=p_batch_id and status='confirmed')
 ) into result
 from (select * from public.bank_statement_rows where workspace_id=p_workspace_id and batch_id=p_batch_id order by row_number offset p_offset limit p_limit) r;
 return result;
end $$;

-- Existing 016 classifier permits staff for Excel. Its PDF UPDATE is rejected
-- server-side even if called by name, while Excel semantics remain unchanged.
create function app_private.guard_pdf_bank_row_update() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.bank_statement_batches b
   where b.workspace_id=old.workspace_id and b.id=old.batch_id and b.source_format='pdf') then
  perform app_private.require_role(old.workspace_id,array['owner','manager']);
 end if;
 return new;
end $$;
create trigger guard_pdf_bank_row_update before update on public.bank_statement_rows
 for each row execute function app_private.guard_pdf_bank_row_update();

-- Check before the 016 classifier reads or validates private row content.
alter function public.classify_bank_statement_row(uuid,uuid,uuid,text,text)
 rename to classify_bank_statement_row_internal;
revoke all on function public.classify_bank_statement_row_internal(uuid,uuid,uuid,text,text)
 from public,anon,authenticated;
create function public.classify_bank_statement_row(p_workspace_id uuid,p_row_id uuid,p_account_id uuid,
 p_category_code text,p_duplicate_reason text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare batch_value uuid;
begin
 perform app_private.require_role(p_workspace_id,array['owner','manager','staff']);
 select r.batch_id into batch_value from public.bank_statement_rows r
  where r.workspace_id=p_workspace_id and r.id=p_row_id;
 if batch_value is null then raise exception 'BANK_ROW_NOT_FOUND: Row is outside this workspace.';end if;
 if not app_private.pdf_bank_row_visible(p_workspace_id,batch_value) then
  raise exception 'BANK_ROW_NOT_FOUND: Row is outside this workspace.';
 end if;
 return public.classify_bank_statement_row_internal(p_workspace_id,p_row_id,p_account_id,
   p_category_code,p_duplicate_reason);
end $$;
revoke all on function public.classify_bank_statement_row(uuid,uuid,uuid,text,text) from public,anon;
grant execute on function public.classify_bank_statement_row(uuid,uuid,uuid,text,text) to authenticated;

-- Excel preview is visible to staff/viewers. Its duplicate signal must not
-- become an oracle for PDF-private rows/cash through SECURITY DEFINER.
create or replace function app_private.bank_duplicate_counts(p_workspace_id uuid,p_row_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare r public.bank_statement_rows;cash_count bigint;row_count bigint;
begin
 select * into r from public.bank_statement_rows where workspace_id=p_workspace_id and id=p_row_id;
 if not found or not app_private.pdf_bank_row_visible(p_workspace_id,r.batch_id) then
  return jsonb_build_object('cash_count',0,'row_count',0,'possible_duplicate',false);
 end if;
 select count(*) into cash_count from public.cash_transactions c
  where c.workspace_id=p_workspace_id and c.id is distinct from r.cash_id
   and app_private.pdf_cash_visible(p_workspace_id,c.id)
   and (r.account_id is null or c.account_id=r.account_id)
   and c.transaction_date=r.transaction_date and c.direction=r.direction and c.amount=r.amount
   and (app_private.bank_description_key(c.description)=app_private.bank_description_key(r.description)
     or (r.external_reference<>'' and c.provenance->>'external_reference'=r.external_reference));
 select count(*) into row_count from public.bank_statement_rows other
  where other.workspace_id=p_workspace_id and other.id<>r.id and other.status='pending'
   and app_private.pdf_bank_row_visible(p_workspace_id,other.batch_id)
   and other.transaction_date=r.transaction_date and other.direction=r.direction and other.amount=r.amount
   and (app_private.bank_description_key(other.description)=app_private.bank_description_key(r.description)
     or (r.external_reference<>'' and other.external_reference=r.external_reference))
   and (r.account_id is null or other.account_id is null or other.account_id=r.account_id);
 return jsonb_build_object('cash_count',cash_count,'row_count',row_count,
   'possible_duplicate',(cash_count+row_count)>0);
end $$;

-- The PDF-specific RPC never accepts source_name or raw_row from the browser.
-- Its raw_row is server-generated source coordinates only, and it has no cash
-- effect; 016's existing classify/confirm path remains the only posting path.
create function public.stage_pdf_bank_statement(p_workspace_id uuid,p_payload jsonb,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare prior app_private.bank_statement_requests;existing public.bank_statement_batches;
 batch_id uuid;result jsonb;hash_value text:=md5(coalesce(p_payload,'null'::jsonb)::text);
 source_hash text;entries jsonb;entry jsonb;row_no numeric;page_no numeric;source_row_no numeric;
 amount_value bigint;date_value date;direction_value text;description_value text;reference_value text;
 fingerprint text;source_count integer;inserted_count integer:=0;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 if p_request_id is null then raise exception 'PDF_BANK_REQUEST: request_id is required.';end if;
 if jsonb_typeof(p_payload) is distinct from 'object' or
    exists(select 1 from jsonb_object_keys(p_payload) k where k not in
      ('source_sha256','currency_confirmed_vnd','rows')) then
  raise exception 'PDF_BANK_ALLOWLIST: Only source_sha256, VND confirmation and normalized rows are accepted.';
 end if;
 if jsonb_typeof(p_payload->'currency_confirmed_vnd') is distinct from 'boolean'
    or p_payload->>'currency_confirmed_vnd'<>'true' then
  raise exception 'PDF_BANK_CURRENCY: Confirm VND before server staging.';
 end if;
 source_hash:=p_payload->>'source_sha256';entries:=p_payload->'rows';
 if source_hash is null or source_hash !~ '^[a-f0-9]{64}$' then raise exception 'PDF_BANK_SOURCE: Invalid SHA-256.';end if;
 if jsonb_typeof(entries) is distinct from 'array' then raise exception 'PDF_BANK_ROWS: Expected normalized rows.';end if;
 source_count:=jsonb_array_length(entries);
 if source_count not between 1 and 5000 then raise exception 'PDF_BANK_ROWS: Expected 1-5000 rows.';end if;
 select * into prior from app_private.bank_statement_requests where workspace_id=p_workspace_id and request_id=p_request_id;
 if found then
  if prior.action<>'stage' or prior.payload_hash<>hash_value or not exists(
    select 1 from public.bank_statement_batches b where b.workspace_id=p_workspace_id
      and b.id=prior.batch_id and b.source_format='pdf') then
   raise exception 'PDF_BANK_REQUEST_REUSED: request_id already used for different data.';
  end if;
  perform app_private.remember(p_workspace_id,p_request_id,'bank.stage_pdf',prior.batch_id);
  return prior.result;
 end if;
 select * into existing from public.bank_statement_batches
  where workspace_id=p_workspace_id and source_sha256=source_hash;
 if found then
  if existing.source_format<>'pdf' or existing.payload_hash<>hash_value then
   raise exception 'PDF_BANK_FILE_CHANGED: Source hash already exists with different data or format.';
  end if;
  batch_id:=existing.id;
  result:=jsonb_build_object('batch_id',batch_id,'row_count',existing.row_count,'reused',true);
 else
  insert into public.bank_statement_batches(workspace_id,source_sha256,source_name,payload_hash,row_count,
    source_format,currency_confirmed_vnd,created_by)
   values(p_workspace_id,source_hash,'Techcombank PDF '||left(source_hash,12),hash_value,source_count,
    'pdf',true,auth.uid())
   returning id into batch_id;
  for entry in select value from jsonb_array_elements(entries) loop
   if jsonb_typeof(entry) is distinct from 'object' or exists(
    select 1 from jsonb_object_keys(entry) k where k not in
     ('row_number','source_page','source_row','transaction_date','direction','amount','description','external_reference')) then
    raise exception 'PDF_BANK_ALLOWLIST: Unsupported transaction field.';
   end if;
   if jsonb_typeof(entry->'row_number') is null or jsonb_typeof(entry->'row_number') not in ('number','string') or
      jsonb_typeof(entry->'source_page') is null or jsonb_typeof(entry->'source_page') not in ('number','string') or
      jsonb_typeof(entry->'source_row') is null or jsonb_typeof(entry->'source_row') not in ('number','string') then
    raise exception 'PDF_BANK_SOURCE_ROW: Missing source coordinates.';
   end if;
   row_no:=(entry->>'row_number')::numeric;
   page_no:=(entry->>'source_page')::numeric;
   source_row_no:=(entry->>'source_row')::numeric;
   if row_no<>trunc(row_no) or row_no not between 1 and 1000000 or
      page_no<>trunc(page_no) or page_no not between 1 and 10000 or
      source_row_no<>trunc(source_row_no) or source_row_no not between 1 and 1000000 then
    raise exception 'PDF_BANK_SOURCE_ROW: Invalid source coordinates.';
   end if;
   if jsonb_typeof(entry->'transaction_date') is distinct from 'string' or
      (entry->>'transaction_date') !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'PDF_BANK_DATE: Expected YYYY-MM-DD.';
   end if;
   date_value:=(entry->>'transaction_date')::date;
   if not isfinite(date_value) then raise exception 'PDF_BANK_DATE: Invalid date.';end if;
   direction_value:=entry->>'direction';
   if jsonb_typeof(entry->'direction') is distinct from 'string' or
      direction_value not in ('in','out') then raise exception 'PDF_BANK_DIRECTION: Expected in/out.';end if;
   if jsonb_typeof(entry->'amount') is distinct from 'string' or
      (entry->>'amount') !~ '^[1-9][0-9]{0,12}$' then
    raise exception 'PDF_BANK_AMOUNT: Expected exact positive integer VND string.';
   end if;
   amount_value:=app_private.amount(entry->>'amount',1);
   if jsonb_typeof(entry->'description') is distinct from 'string' then
    raise exception 'PDF_BANK_TEXT: Description is required.';
   end if;
   description_value:=btrim(entry->>'description');
   if entry ? 'external_reference' and jsonb_typeof(entry->'external_reference') is distinct from 'string' then
    raise exception 'PDF_BANK_TEXT: Reference must be text.';
   end if;
   reference_value:=coalesce(btrim(entry->>'external_reference'),'');
   -- This adapter cannot identify a bank reference, so an arbitrary caller may
   -- not use that optional field to store account numbers or unrelated PDF text.
   if length(description_value) not between 1 and 500 or
      description_value ~ '[[:cntrl:]]' or
      description_value ~ '([0-9][ .-]?){8,}[0-9]' or
      description_value ~* '[[:alnum:]_.+-]+@[[:alnum:].-]+[.][[:alpha:]]{2,}' or
      reference_value<>'' then
    raise exception 'PDF_BANK_TEXT: Description/reference invalid or may contain private data.';
   end if;
   fingerprint:=md5(jsonb_build_array(date_value,direction_value,amount_value,
     app_private.bank_description_key(description_value),lower(reference_value))::text);
   insert into public.bank_statement_rows(workspace_id,batch_id,row_number,raw_row,
     transaction_date,direction,amount,description,external_reference,row_fingerprint)
    values(p_workspace_id,batch_id,row_no::integer,
     jsonb_build_object('source_page',page_no::integer,'source_row',source_row_no::integer),
     date_value,direction_value,amount_value,description_value,reference_value,fingerprint);
   inserted_count:=inserted_count+1;
  end loop;
  result:=jsonb_build_object('batch_id',batch_id,'row_count',inserted_count,'reused',false);
  perform app_private.audit(p_workspace_id,'bank_statement.staged',batch_id,
   jsonb_build_object('source_format','pdf','source_sha256',source_hash,'row_count',inserted_count,'request_id',p_request_id));
 end if;
 perform app_private.remember(p_workspace_id,p_request_id,'bank.stage_pdf',batch_id);
 insert into app_private.bank_statement_requests(workspace_id,request_id,action,batch_id,payload_hash,result,created_by)
  values(p_workspace_id,p_request_id,'stage',batch_id,hash_value,result,auth.uid());
 return result;
end $$;

-- 019's report wrapper masks HR cash. Keep it and additionally mask all cash
-- aggregates whenever a PDF cash movement can contribute to the period.
alter function public.get_workspace_report(uuid,date,date) rename to get_workspace_report_hr_internal;
revoke all on function public.get_workspace_report_hr_internal(uuid,date,date) from public,anon,authenticated;
create function public.get_workspace_report(p_workspace_id uuid,p_from date,p_to date)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare report jsonb;old_overview jsonb;
begin
 perform app_private.require_role(p_workspace_id,array['owner','manager','staff','viewer']);
 report:=public.get_workspace_report_hr_internal(p_workspace_id,p_from,p_to);
 if app_private.member_role(p_workspace_id) not in ('owner','manager') and p_to is not null
  and exists(select 1 from public.bank_statement_rows r
    join public.bank_statement_batches b on b.workspace_id=r.workspace_id and b.id=r.batch_id
    join public.cash_movements m on m.workspace_id=r.workspace_id and m.cash_id=r.cash_id
    where r.workspace_id=p_workspace_id and b.source_format='pdf' and m.transaction_date<=p_to) then
  if coalesce((report->>'cash_restricted')::boolean,false)=false then
   old_overview:=report->'overview';
   report:=jsonb_set(report,'{overview}',jsonb_build_object(
    'purchase_qty',old_overview->'purchase_qty',
    'purchase_amount',old_overview->'purchase_amount',
    'stock_qty_as_of',old_overview->'stock_qty_as_of',
    'stock_value_as_of',old_overview->'stock_value_as_of',
    'pending_purchase_count',old_overview->'pending_purchase_count'));
  end if;
  report:=report||jsonb_build_object('cash_restricted',true,'cash_accounts','[]'::jsonb,
   'cash_categories','[]'::jsonb,'warnings',jsonb_build_array(jsonb_build_object(
    'code','PDF_BANK_PRIVATE','message','Cash report is restricted to owner/manager.')));
 end if;
 return report;
end $$;
revoke all on function public.get_workspace_report(uuid,date,date) from public,anon;
grant execute on function public.get_workspace_report(uuid,date,date) to authenticated;

-- The category endpoint exposes cash document counts under SECURITY DEFINER.
alter function public.get_expense_categories(uuid) rename to get_expense_categories_internal;
revoke all on function public.get_expense_categories_internal(uuid) from public,anon,authenticated;
create function public.get_expense_categories(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 perform app_private.require_role(p_workspace_id,array['owner','manager','staff','viewer']);
 result:=public.get_expense_categories_internal(p_workspace_id);
 if app_private.member_role(p_workspace_id) not in ('owner','manager') and exists(
  select 1 from public.bank_statement_rows r
   join public.bank_statement_batches b on b.workspace_id=r.workspace_id and b.id=r.batch_id
   where r.workspace_id=p_workspace_id and b.source_format='pdf' and r.cash_id is not null) then
  result:=(result-'reconciliation')||jsonb_build_object('cash_restricted',true);
 end if;
 return result;
end $$;
revoke all on function public.get_expense_categories(uuid) from public,anon;
grant execute on function public.get_expense_categories(uuid) to authenticated;

revoke all on function app_private.pdf_cash_visible(uuid,uuid),
 app_private.pdf_bank_row_visible(uuid,uuid),app_private.pdf_audit_visible(uuid,text,uuid),
 app_private.guard_pdf_bank_row_update() from public,anon,authenticated;
grant execute on function app_private.pdf_cash_visible(uuid,uuid),
 app_private.pdf_bank_row_visible(uuid,uuid),app_private.pdf_audit_visible(uuid,text,uuid)
 to authenticated;
revoke all on function public.stage_pdf_bank_statement(uuid,jsonb,uuid) from public,anon;
grant execute on function public.stage_pdf_bank_statement(uuid,jsonb,uuid) to authenticated;

commit;
