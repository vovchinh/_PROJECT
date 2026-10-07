-- Operational document correction. Apply once after 014.
-- Posted documents and their ledger rows remain immutable; drafts are tombstoned.
begin;

do $$begin
 if to_regclass('public.expense_categories') is null
    or to_regclass('public.inventory_lots') is null
    or to_regprocedure('public.reverse_document(text,uuid,uuid,date,text)') is null then
  raise exception 'DOCUMENT_PREREQUISITE: Apply migrations 001 through 014 first.';
 end if;
end $$;

alter table public.purchase_receipts drop constraint purchase_receipts_status_check;
alter table public.purchase_receipts add constraint purchase_receipts_status_check
 check(status in ('draft','posted','reversed','deleted'));
alter table public.cash_transactions drop constraint cash_transactions_status_check;
alter table public.cash_transactions add constraint cash_transactions_status_check
 check(status in ('draft','posted','reversed','deleted'));

alter table public.purchase_receipts
 add column deleted_at timestamptz,
 add column deleted_by uuid references auth.users(id),
 add column delete_reason text,
 add column delete_request_id uuid,
 add column delete_request_hash text,
 add constraint purchase_draft_delete_state check(
  (status='deleted' and deleted_at is not null and deleted_by is not null
    and delete_reason is not null and length(trim(delete_reason)) between 10 and 4000
    and delete_request_id is not null and delete_request_hash is not null)
  or (status<>'deleted' and deleted_at is null and deleted_by is null
    and delete_reason is null and delete_request_id is null and delete_request_hash is null));
alter table public.cash_transactions
 add column deleted_at timestamptz,
 add column deleted_by uuid references auth.users(id),
 add column delete_reason text,
 add column delete_request_id uuid,
 add column delete_request_hash text,
 add constraint cash_draft_delete_state check(
  (status='deleted' and deleted_at is not null and deleted_by is not null
    and delete_reason is not null and length(trim(delete_reason)) between 10 and 4000
    and delete_request_id is not null and delete_request_hash is not null)
  or (status<>'deleted' and deleted_at is null and deleted_by is null
    and delete_reason is null and delete_request_id is null and delete_request_hash is null));
create unique index purchase_delete_request_unique on public.purchase_receipts(workspace_id,delete_request_id)
 where delete_request_id is not null;
create unique index cash_delete_request_unique on public.cash_transactions(workspace_id,delete_request_id)
 where delete_request_id is not null;

create table public.document_corrections (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id),
 kind text not null check(kind in ('purchase','cash')),
 purchase_original_id uuid,purchase_replacement_id uuid,
 cash_original_id uuid,cash_replacement_id uuid,
 reverse_date date not null check(isfinite(reverse_date)),
 reason text not null check(length(trim(reason)) between 10 and 4000),
 request_id uuid not null,request_hash text not null,
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 unique(workspace_id,id),unique(workspace_id,request_id),
 foreign key(workspace_id,purchase_original_id) references public.purchase_receipts(workspace_id,id),
 foreign key(workspace_id,purchase_replacement_id) references public.purchase_receipts(workspace_id,id),
 foreign key(workspace_id,cash_original_id) references public.cash_transactions(workspace_id,id),
 foreign key(workspace_id,cash_replacement_id) references public.cash_transactions(workspace_id,id),
 check((kind='purchase' and purchase_original_id is not null and purchase_replacement_id is not null
   and cash_original_id is null and cash_replacement_id is null and purchase_original_id<>purchase_replacement_id)
  or (kind='cash' and cash_original_id is not null and cash_replacement_id is not null
   and purchase_original_id is null and purchase_replacement_id is null and cash_original_id<>cash_replacement_id))
);
create unique index document_correction_purchase_original on public.document_corrections(workspace_id,purchase_original_id)
 where purchase_original_id is not null;
create unique index document_correction_cash_original on public.document_corrections(workspace_id,cash_original_id)
 where cash_original_id is not null;
create unique index document_correction_purchase_replacement on public.document_corrections(workspace_id,purchase_replacement_id)
 where purchase_replacement_id is not null;
create unique index document_correction_cash_replacement on public.document_corrections(workspace_id,cash_replacement_id)
 where cash_replacement_id is not null;
alter table public.document_corrections enable row level security;
create policy member_read on public.document_corrections for select to authenticated
 using(app_private.member_role(workspace_id) is not null);
revoke all on public.document_corrections from public,anon,authenticated;
grant select on public.document_corrections to authenticated;

-- Existing create/post RPCs already accept only draft; the trigger is a second
-- line of defence and records old/new values when the user edits a draft.
create function app_private.audit_draft_document_update() returns trigger
language plpgsql security definer set search_path='' as $$
declare before_fields jsonb;after_fields jsonb;
begin
 if old.status='deleted' then raise exception 'DOCUMENT_DELETED: Deleted drafts cannot be edited or posted.';end if;
 if new.status='deleted' and old.status<>'draft' then
  raise exception 'DOCUMENT_ALREADY_POSTED: Only a draft can be deleted.';
 end if;
 if old.status='draft' and new.status='draft' then
  if tg_table_name='purchase_receipts' then
   before_fields:=jsonb_build_object('supplier_id',old.supplier_id,'product_id',old.product_id,
     'warehouse_id',old.warehouse_id,'received_date',old.received_date,'date_estimated',old.date_estimated,
     'qty',old.qty,'unit_cost',old.unit_cost,'additional_cost',old.additional_cost,'notes',old.notes);
   after_fields:=jsonb_build_object('supplier_id',new.supplier_id,'product_id',new.product_id,
     'warehouse_id',new.warehouse_id,'received_date',new.received_date,'date_estimated',new.date_estimated,
     'qty',new.qty,'unit_cost',new.unit_cost,'additional_cost',new.additional_cost,'notes',new.notes);
  else
   before_fields:=jsonb_build_object('account_id',old.account_id,'direction',old.direction,
     'transaction_date',old.transaction_date,'date_estimated',old.date_estimated,'category',old.category,
     'amount',old.amount,'description',old.description,'notes',old.notes);
   after_fields:=jsonb_build_object('account_id',new.account_id,'direction',new.direction,
     'transaction_date',new.transaction_date,'date_estimated',new.date_estimated,'category',new.category,
     'amount',new.amount,'description',new.description,'notes',new.notes);
  end if;
  if before_fields is distinct from after_fields then
   perform app_private.audit(old.workspace_id,
     case when tg_table_name='purchase_receipts' then 'purchase.draft_updated' else 'cash.draft_updated' end,
     old.id,jsonb_build_object('before',before_fields,'after',after_fields));
  end if;
 end if;
 return new;
end $$;
create trigger audit_purchase_draft_update before update on public.purchase_receipts
 for each row execute function app_private.audit_draft_document_update();
create trigger audit_cash_draft_update before update on public.cash_transactions
 for each row execute function app_private.audit_draft_document_update();

create function public.delete_draft_document(
 p_workspace_id uuid,p_kind text,p_id uuid,p_request_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare pr public.purchase_receipts;cr public.cash_transactions;result jsonb;
 reason_value text:=trim(coalesce(p_reason,''));hash_value text;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager','staff']);
 if p_kind not in ('purchase','cash') or p_kind is null or p_id is null then
  raise exception 'DOCUMENT_KIND: Choose a purchase or cash draft.';
 end if;
 if length(reason_value) not between 10 and 4000 then
  raise exception 'DOCUMENT_REASON: Provide a reason between 10 and 4000 characters.';
 end if;
 hash_value:=md5(jsonb_build_object('kind',p_kind,'id',p_id,'reason',reason_value)::text);
 perform app_private.remember(p_workspace_id,p_request_id,'document.delete_draft.'||p_kind,p_id);
 if p_kind='purchase' then
  select * into pr from public.purchase_receipts where workspace_id=p_workspace_id and id=p_id for update;
  if not found then raise exception 'DOCUMENT_NOT_FOUND: Draft is not in this workspace.';end if;
  if pr.status='deleted' then
   if pr.delete_request_id=p_request_id and pr.delete_request_hash=hash_value then return to_jsonb(pr);end if;
   raise exception 'DOCUMENT_ALREADY_DELETED: Draft was deleted by another request.';
  end if;
  if pr.status<>'draft' or exists(select 1 from public.stock_movements where workspace_id=p_workspace_id and purchase_id=p_id)
    or exists(select 1 from public.inventory_lots where workspace_id=p_workspace_id and source_purchase_id=p_id) then
   raise exception 'DOCUMENT_ALREADY_POSTED: Posted purchase must be reversed.';
  end if;
  update public.purchase_receipts set status='deleted',deleted_at=clock_timestamp(),deleted_by=auth.uid(),
    delete_reason=reason_value,delete_request_id=p_request_id,delete_request_hash=hash_value,updated_at=clock_timestamp()
   where workspace_id=p_workspace_id and id=p_id returning to_jsonb(purchase_receipts.*) into result;
 else
  select * into cr from public.cash_transactions where workspace_id=p_workspace_id and id=p_id for update;
  if not found then raise exception 'DOCUMENT_NOT_FOUND: Draft is not in this workspace.';end if;
  if cr.status='deleted' then
   if cr.delete_request_id=p_request_id and cr.delete_request_hash=hash_value then return to_jsonb(cr);end if;
   raise exception 'DOCUMENT_ALREADY_DELETED: Draft was deleted by another request.';
  end if;
  if cr.status<>'draft' or exists(select 1 from public.cash_movements where workspace_id=p_workspace_id and cash_id=p_id) then
   raise exception 'DOCUMENT_ALREADY_POSTED: Posted cash transaction must be reversed.';
  end if;
  update public.cash_transactions set status='deleted',deleted_at=clock_timestamp(),deleted_by=auth.uid(),
    delete_reason=reason_value,delete_request_id=p_request_id,delete_request_hash=hash_value,updated_at=clock_timestamp()
   where workspace_id=p_workspace_id and id=p_id returning to_jsonb(cash_transactions.*) into result;
 end if;
 perform app_private.audit(p_workspace_id,p_kind||'.draft_deleted',p_id,
  jsonb_build_object('before',case when p_kind='purchase' then
      jsonb_build_object('status',pr.status,'qty',pr.qty,'total_amount',pr.total_amount,
        'received_date',pr.received_date,'source_id',pr.source_id,'legacy_id',pr.legacy_id)
    else jsonb_build_object('status',cr.status,'direction',cr.direction,'amount',cr.amount,
        'transaction_date',cr.transaction_date,'category',cr.category,
        'source_id',cr.source_id,'legacy_id',cr.legacy_id) end,
    'reason',reason_value,'request_id',p_request_id));
 return result;
end $$;

create function public.correct_posted_document(
 p_workspace_id uuid,p_kind text,p_id uuid,p_reverse_date date,p_reason text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare pr public.purchase_receipts;cr public.cash_transactions;replacement jsonb;
 link public.document_corrections;reverse_result jsonb;reverse_request uuid:=gen_random_uuid();
 actual_reverse_date date;reason_value text:=trim(coalesce(p_reason,''));hash_value text;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner']);
 if p_kind not in ('purchase','cash') or p_kind is null or p_id is null then
  raise exception 'DOCUMENT_KIND: Choose a posted purchase or cash transaction.';
 end if;
 if p_reverse_date is null or not isfinite(p_reverse_date) then
  raise exception 'INVALID_BUSINESS_DATE: Provide a finite reversal date.';
 end if;
 if length(reason_value) not between 10 and 4000 then
  raise exception 'DOCUMENT_REASON: Provide a reason between 10 and 4000 characters.';
 end if;
 hash_value:=md5(jsonb_build_object('kind',p_kind,'id',p_id,'date',p_reverse_date,'reason',reason_value)::text);
 perform app_private.remember(p_workspace_id,p_request_id,'document.correct.'||p_kind,p_id);
 select * into link from public.document_corrections
  where workspace_id=p_workspace_id and request_id=p_request_id;
 if found then
  if link.kind<>p_kind or link.request_hash<>hash_value
    or (p_kind='purchase' and link.purchase_original_id<>p_id)
    or (p_kind='cash' and link.cash_original_id<>p_id) then
   raise exception 'DOCUMENT_REQUEST_CONFLICT: Request ID was used with different correction details.';
  end if;
  return jsonb_build_object('correction_id',link.id,
    'original',case when p_kind='purchase' then
      (select to_jsonb(t) from public.purchase_receipts t where t.workspace_id=p_workspace_id and t.id=link.purchase_original_id)
      else (select to_jsonb(t) from public.cash_transactions t where t.workspace_id=p_workspace_id and t.id=link.cash_original_id) end,
    'replacement',case when p_kind='purchase' then
      (select to_jsonb(t) from public.purchase_receipts t where t.workspace_id=p_workspace_id and t.id=link.purchase_replacement_id)
      else (select to_jsonb(t) from public.cash_transactions t where t.workspace_id=p_workspace_id and t.id=link.cash_replacement_id) end);
 end if;
 if p_kind='purchase' then
  select * into pr from public.purchase_receipts where workspace_id=p_workspace_id and id=p_id for update;
  if not found then raise exception 'DOCUMENT_NOT_FOUND: Purchase is not in this workspace.';end if;
  if exists(select 1 from public.document_corrections where workspace_id=p_workspace_id and purchase_original_id=p_id) then
   raise exception 'DOCUMENT_ALREADY_CORRECTED: Purchase already has a replacement.';
  end if;
  if pr.status not in ('posted','reversed') then raise exception 'INVALID_DOCUMENT_STATE: Purchase must be posted or reversed.';end if;
  if pr.status='posted' then
   reverse_result:=public.reverse_document('purchase',p_id,reverse_request,p_reverse_date,reason_value);
  else
   select received_date into actual_reverse_date from public.stock_movements
    where workspace_id=p_workspace_id and purchase_id=p_id and movement_kind='reversal';
   if actual_reverse_date is distinct from p_reverse_date then
    raise exception 'INVALID_BUSINESS_DATE: Use the existing reversal date for the replacement.';
   end if;
   reverse_result:=to_jsonb(pr);
  end if;
  replacement:=public.create_purchase(jsonb_build_object('workspace_id',p_workspace_id,
    'supplier_id',pr.supplier_id,'product_id',pr.product_id,'warehouse_id',pr.warehouse_id,
    'received_date',p_reverse_date,'date_estimated',false,'qty',pr.qty,
    'unit_cost',pr.unit_cost,'additional_cost',pr.additional_cost,'notes',pr.notes,
    'provenance',jsonb_build_object('correction_of',p_id,'correction_kind','purchase')));
  insert into public.document_corrections(workspace_id,kind,purchase_original_id,purchase_replacement_id,
    reverse_date,reason,request_id,request_hash,created_by)
   values(p_workspace_id,p_kind,p_id,(replacement->>'id')::uuid,p_reverse_date,reason_value,p_request_id,hash_value,auth.uid())
   returning * into link;
 else
  select * into cr from public.cash_transactions where workspace_id=p_workspace_id and id=p_id for update;
  if not found then raise exception 'DOCUMENT_NOT_FOUND: Cash transaction is not in this workspace.';end if;
  if exists(select 1 from public.document_corrections where workspace_id=p_workspace_id and cash_original_id=p_id) then
   raise exception 'DOCUMENT_ALREADY_CORRECTED: Cash transaction already has a replacement.';
  end if;
  if cr.status not in ('posted','reversed') then raise exception 'INVALID_DOCUMENT_STATE: Cash transaction must be posted or reversed.';end if;
  if cr.status='posted' then
   reverse_result:=public.reverse_document('cash',p_id,reverse_request,p_reverse_date,reason_value);
  else
   select transaction_date into actual_reverse_date from public.cash_movements
    where workspace_id=p_workspace_id and cash_id=p_id and movement_kind='reversal';
   if actual_reverse_date is distinct from p_reverse_date then
    raise exception 'INVALID_BUSINESS_DATE: Use the existing reversal date for the replacement.';
   end if;
   reverse_result:=to_jsonb(cr);
  end if;
  replacement:=public.create_cash(jsonb_build_object('workspace_id',p_workspace_id,
    'account_id',cr.account_id,'direction',cr.direction,'transaction_date',p_reverse_date,
    'date_estimated',false,'category',cr.category,'amount',cr.amount,
    'description',cr.description,'notes',cr.notes,
    'provenance',jsonb_build_object('correction_of',p_id,'correction_kind','cash')));
  insert into public.document_corrections(workspace_id,kind,cash_original_id,cash_replacement_id,
    reverse_date,reason,request_id,request_hash,created_by)
   values(p_workspace_id,p_kind,p_id,(replacement->>'id')::uuid,p_reverse_date,reason_value,p_request_id,hash_value,auth.uid())
   returning * into link;
 end if;
 perform app_private.audit(p_workspace_id,p_kind||'.correction_created',p_id,
  jsonb_build_object('correction_id',link.id,'replacement_id',replacement->>'id',
    'reverse_date',p_reverse_date,'reason',reason_value,'request_id',p_request_id));
 return jsonb_build_object('correction_id',link.id,'original',reverse_result,'replacement',replacement);
end $$;

revoke all on function app_private.audit_draft_document_update() from public,anon,authenticated;
revoke all on function public.delete_draft_document(uuid,text,uuid,uuid,text),
 public.correct_posted_document(uuid,text,uuid,date,text,uuid) from public,anon;
grant execute on function public.delete_draft_document(uuid,text,uuid,uuid,text),
 public.correct_posted_document(uuid,text,uuid,date,text,uuid) to authenticated;
commit;
