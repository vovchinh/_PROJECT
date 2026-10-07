-- ERP bank-statement intake. The file and its rows are staged without touching
-- cash_transactions/cash_movements. Only confirm_bank_statement_rows posts cash.
-- Apply once after 014 (and 015 when present). Historical migrations stay fixed.
begin;

do $$begin
 if to_regclass('public.expense_categories') is null
    or to_regprocedure('public.post_cash(uuid,uuid)') is null then
  raise exception 'BANK_PREREQUISITE: Apply expense categories (014) before 016.';
 end if;
 if to_regclass('public.bank_statement_batches') is not null then
  raise exception 'BANK_ALREADY_INSTALLED: Migration 016 is applied once.';
 end if;
end $$;

create table public.bank_statement_batches (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id),
 source_sha256 text not null check(source_sha256 ~ '^[a-f0-9]{64}$'),
 source_name text not null check(length(btrim(source_name)) between 1 and 255),
 payload_hash text not null check(payload_hash ~ '^[a-f0-9]{32}$'),
 row_count integer not null check(row_count between 1 and 5000),
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 unique(workspace_id,id),unique(workspace_id,source_sha256)
);
create index bank_statement_batches_recent on public.bank_statement_batches(workspace_id,created_at desc,id desc);

create table public.bank_statement_rows (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id),
 batch_id uuid not null,
 row_number integer not null check(row_number between 1 and 1000000),
 raw_row jsonb not null default '[]'::jsonb,
 transaction_date date not null check(isfinite(transaction_date)),
 direction text not null check(direction in ('in','out')),
 amount bigint not null check(amount between 1 and 9000000000000),
 description text not null check(length(btrim(description)) between 1 and 2000),
 external_reference text not null default '' check(length(external_reference)<=200),
 row_fingerprint text not null check(row_fingerprint ~ '^[a-f0-9]{32}$'),
 account_id uuid,category_id uuid,
 duplicate_override_reason text check(duplicate_override_reason is null or length(btrim(duplicate_override_reason)) between 10 and 4000),
 status text not null default 'pending' check(status in ('pending','confirmed')),
 cash_id uuid,confirmed_by uuid references auth.users(id),confirmed_at timestamptz,
 created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp(),
 unique(workspace_id,id),unique(workspace_id,batch_id,row_number),unique(workspace_id,cash_id),
 foreign key(workspace_id,batch_id) references public.bank_statement_batches(workspace_id,id),
 foreign key(workspace_id,account_id) references public.cash_accounts(workspace_id,id),
 foreign key(workspace_id,category_id) references public.expense_categories(workspace_id,id),
 foreign key(workspace_id,cash_id) references public.cash_transactions(workspace_id,id),
 check((status='pending' and cash_id is null and confirmed_by is null and confirmed_at is null)
    or(status='confirmed' and cash_id is not null and confirmed_by is not null and confirmed_at is not null))
);
create index bank_statement_rows_page on public.bank_statement_rows(workspace_id,batch_id,row_number);
create index bank_statement_rows_fingerprint on public.bank_statement_rows(workspace_id,row_fingerprint,account_id);
create index bank_statement_rows_status on public.bank_statement_rows(workspace_id,batch_id,status);
create index bank_cash_duplicate_probe on public.cash_transactions(workspace_id,account_id,transaction_date,direction,amount);

-- A pending row must be reclassified before its category can be removed. For
-- confirmed rows, the existing cash document/snapshot already blocks deletion.
create function app_private.protect_bank_category_delete() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.bank_statement_rows
   where workspace_id=old.workspace_id and category_id=old.id and status='pending') then
  raise exception 'EXPENSE_IN_USE: Nhóm đang được chọn trong sao kê chờ xác nhận; đổi nhóm các dòng đó trước khi xóa.';
 end if;
 return old;
end $$;
create trigger protect_bank_category_delete before delete on public.expense_categories
 for each row execute function app_private.protect_bank_category_delete();

create table app_private.bank_statement_requests (
 workspace_id uuid not null references public.workspaces(id),request_id uuid not null,
 action text not null check(action in ('stage','confirm')),
 batch_id uuid not null,
 payload_hash text not null check(payload_hash ~ '^[a-f0-9]{32}$'),
 result jsonb not null,
 created_by uuid not null references auth.users(id),created_at timestamptz not null default clock_timestamp(),
 primary key(workspace_id,request_id),
 foreign key(workspace_id,batch_id) references public.bank_statement_batches(workspace_id,id)
);

do $$declare t text;begin
 foreach t in array array['bank_statement_batches','bank_statement_rows'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('create policy member_read on public.%I for select to authenticated using(app_private.member_role(workspace_id) is not null)',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
 end loop;
end $$;
revoke all on app_private.bank_statement_requests from public,anon,authenticated;

create function app_private.bank_description_key(p_text text) returns text
language sql immutable set search_path='' as $$
 select lower(btrim(regexp_replace(coalesce(p_text,''),'[[:space:]]+',' ','g')))
$$;

-- Stage only normalized, valid rows. Parsing and source file hashing happen in
-- the browser, but the server revalidates every business field and the full
-- payload before storing it. The original cell values remain in raw_row.
create function public.stage_bank_statement(p_workspace_id uuid,p_payload jsonb,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare prior app_private.bank_statement_requests;existing public.bank_statement_batches;
 batch_id uuid;result jsonb;hash_value text:=md5(coalesce(p_payload,'null'::jsonb)::text);
 source_hash text;source_name text;entries jsonb;entry jsonb;row_no numeric;amount_value bigint;
 date_value date;direction_value text;description_value text;reference_value text;raw_value jsonb;
 fingerprint text;source_count integer;inserted_count integer:=0;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager','staff']);
 if p_request_id is null then raise exception 'BANK_REQUEST: Cần request_id để chống ghi trùng.';end if;
 select * into prior from app_private.bank_statement_requests where workspace_id=p_workspace_id and request_id=p_request_id;
 if found then
  if prior.action<>'stage' or prior.payload_hash<>hash_value then raise exception 'BANK_REQUEST_REUSED: request_id đã dùng với nội dung khác.';end if;
  perform app_private.remember(p_workspace_id,p_request_id,'bank.stage',prior.batch_id);
  return prior.result;
 end if;
 if jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'BANK_INPUT: Cần bản xem trước hợp lệ.';end if;
 source_hash:=p_payload->>'source_sha256';source_name:=btrim(p_payload->>'source_name');entries:=p_payload->'rows';
 if source_hash is null or source_hash !~ '^[a-f0-9]{64}$' then raise exception 'BANK_SOURCE: Cần SHA-256 của file Excel.';end if;
 if source_name is null or length(source_name) not between 1 and 255
  or source_name ~ '[[:cntrl:]]' then raise exception 'BANK_SOURCE: Tên file không hợp lệ.';end if;
 if jsonb_typeof(entries) is distinct from 'array' then raise exception 'BANK_ROWS: Cần danh sách dòng sao kê.';end if;
 source_count:=jsonb_array_length(entries);
 if source_count not between 1 and 5000 then raise exception 'BANK_ROWS: Mỗi file cần từ 1 đến 5.000 dòng hợp lệ.';end if;
 select * into existing from public.bank_statement_batches where workspace_id=p_workspace_id and source_sha256=source_hash;
 if found then
  if existing.payload_hash<>hash_value then
   raise exception 'BANK_FILE_CHANGED: File cùng SHA-256 đã được nhập với nội dung phân tích khác.';
  end if;
  batch_id:=existing.id;
  result:=jsonb_build_object('batch_id',batch_id,'row_count',existing.row_count,'reused',true);
 else
  insert into public.bank_statement_batches(workspace_id,source_sha256,source_name,payload_hash,row_count,created_by)
   values(p_workspace_id,source_hash,source_name,hash_value,source_count,auth.uid()) returning id into batch_id;
  for entry in select value from jsonb_array_elements(entries) loop
   if jsonb_typeof(entry) is distinct from 'object' then raise exception 'BANK_ROW: Dòng sao kê phải là object.';end if;
   if jsonb_typeof(entry->'row_number') not in ('number','string') then raise exception 'BANK_ROW: Thiếu số dòng nguồn.';end if;
   row_no:=(entry->>'row_number')::numeric;
   if row_no is null or row_no<>trunc(row_no) or row_no not between 1 and 1000000 then raise exception 'BANK_ROW: Số dòng nguồn không hợp lệ.';end if;
   if (entry->>'transaction_date') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'BANK_DATE: Ngày phải là YYYY-MM-DD.';end if;
   date_value:=(entry->>'transaction_date')::date;
   if not isfinite(date_value) then raise exception 'BANK_DATE: Ngày sao kê không hợp lệ.';end if;
   direction_value:=entry->>'direction';
   if direction_value is null or direction_value not in ('in','out') then raise exception 'BANK_DIRECTION: Chiều tiền phải là in hoặc out.';end if;
   amount_value:=app_private.amount(entry->>'amount',1);
   description_value:=btrim(entry->>'description');reference_value:=coalesce(btrim(entry->>'external_reference'),'');
   if description_value is null or length(description_value) not between 1 and 2000 or description_value ~ '[[:cntrl:]]'
     or length(reference_value)>200 or reference_value ~ '[[:cntrl:]]' then
    raise exception 'BANK_TEXT: Nội dung hoặc tham chiếu không hợp lệ.';
   end if;
   raw_value:=coalesce(entry->'raw_row','[]'::jsonb);
   if jsonb_typeof(raw_value) not in ('array','object') or length(raw_value::text)>10000 then
    raise exception 'BANK_RAW: Dòng Excel gốc không hợp lệ hoặc quá dài.';
   end if;
   fingerprint:=md5(jsonb_build_array(date_value,direction_value,amount_value,
     app_private.bank_description_key(description_value),lower(reference_value))::text);
   insert into public.bank_statement_rows(workspace_id,batch_id,row_number,raw_row,transaction_date,direction,amount,description,external_reference,row_fingerprint)
    values(p_workspace_id,batch_id,row_no::integer,raw_value,date_value,direction_value,amount_value,description_value,reference_value,fingerprint);
   inserted_count:=inserted_count+1;
  end loop;
  result:=jsonb_build_object('batch_id',batch_id,'row_count',inserted_count,'reused',false);
  perform app_private.audit(p_workspace_id,'bank_statement.staged',batch_id,
    jsonb_build_object('source_sha256',source_hash,'source_name',source_name,'row_count',inserted_count,'request_id',p_request_id));
 end if;
 perform app_private.remember(p_workspace_id,p_request_id,'bank.stage',batch_id);
 insert into app_private.bank_statement_requests(workspace_id,request_id,action,batch_id,payload_hash,result,created_by)
  values(p_workspace_id,p_request_id,'stage',batch_id,hash_value,result,auth.uid());
 return result;
end $$;

-- These are conservative suggestions, not an automatic decision to discard a
-- row. Identical amounts from separate accounts may be legitimate.
create function app_private.bank_duplicate_counts(p_workspace_id uuid,p_row_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare r public.bank_statement_rows;cash_count bigint;row_count bigint;
begin
 select * into r from public.bank_statement_rows where workspace_id=p_workspace_id and id=p_row_id;
 if not found then return jsonb_build_object('cash_count',0,'row_count',0,'possible_duplicate',false);end if;
 select count(*) into cash_count from public.cash_transactions c
  where c.workspace_id=p_workspace_id and c.id is distinct from r.cash_id
   and (r.account_id is null or c.account_id=r.account_id)
   and c.transaction_date=r.transaction_date and c.direction=r.direction and c.amount=r.amount
   and (app_private.bank_description_key(c.description)=app_private.bank_description_key(r.description)
     or (r.external_reference<>'' and c.provenance->>'external_reference'=r.external_reference));
 select count(*) into row_count from public.bank_statement_rows other
  where other.workspace_id=p_workspace_id and other.batch_id=r.batch_id and other.id<>r.id
   and other.transaction_date=r.transaction_date and other.direction=r.direction and other.amount=r.amount
   and (app_private.bank_description_key(other.description)=app_private.bank_description_key(r.description)
     or (r.external_reference<>'' and other.external_reference=r.external_reference))
   and (r.account_id is null or other.account_id is null or other.account_id=r.account_id);
 return jsonb_build_object('cash_count',cash_count,'row_count',row_count,'possible_duplicate',(cash_count+row_count)>0);
end $$;

create function public.get_bank_statement_import(p_workspace_id uuid,p_batch_id uuid,
 p_offset integer default 0,p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare b public.bank_statement_batches;result jsonb;
begin
 perform app_private.require_role(p_workspace_id,array['owner','manager','staff','viewer']);
 if p_offset is null or p_offset<0 or p_limit is null or p_limit not between 1 and 200 then
  raise exception 'BANK_PAGE: Offset phải >=0 và mỗi trang từ 1 đến 200 dòng.';
 end if;
 select * into b from public.bank_statement_batches where workspace_id=p_workspace_id and id=p_batch_id;
 if not found then raise exception 'BANK_BATCH_NOT_FOUND: Không tìm thấy file sao kê trong workspace.';end if;
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

create function public.classify_bank_statement_row(p_workspace_id uuid,p_row_id uuid,p_account_id uuid,
 p_category_code text,p_duplicate_reason text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.bank_statement_rows;old_row public.bank_statement_rows;c public.expense_categories;reason_value text;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager','staff']);
 select * into r from public.bank_statement_rows where workspace_id=p_workspace_id and id=p_row_id for update;
 if not found then raise exception 'BANK_ROW_NOT_FOUND: Không tìm thấy dòng sao kê trong workspace.';end if;
 if r.status<>'pending' then raise exception 'BANK_ROW_CONFIRMED: Dòng đã ghi sổ; muốn sửa phải đảo giao dịch Thu Chi.';end if;
 old_row:=r;
 if p_account_id is not null and not exists(select 1 from public.cash_accounts where workspace_id=p_workspace_id and id=p_account_id) then
  raise exception 'BANK_ACCOUNT: Tài khoản không thuộc workspace.';
 end if;
 if p_category_code is not null then
  select * into c from public.expense_categories where workspace_id=p_workspace_id and code=p_category_code and direction=r.direction;
  if not found or not c.is_active then raise exception 'BANK_CATEGORY: Nhóm thu chi không hợp lệ hoặc đã lưu trữ.';end if;
 end if;
 reason_value:=nullif(btrim(p_duplicate_reason),'');
 if reason_value is not null and length(reason_value) not between 10 and 4000 then
  raise exception 'BANK_DUPLICATE_REASON: Lý do xác nhận giao dịch có thể trùng cần 10–4.000 ký tự.';
 end if;
 update public.bank_statement_rows set account_id=p_account_id,category_id=c.id,
  duplicate_override_reason=reason_value,updated_at=clock_timestamp()
  where workspace_id=p_workspace_id and id=p_row_id returning * into r;
 perform app_private.audit(p_workspace_id,'bank_statement.row_classified',p_row_id,
  jsonb_build_object('batch_id',r.batch_id,'row_number',r.row_number,'account_id',p_account_id,
   'category_id',c.id,'duplicate_override',reason_value is not null,
   'before',jsonb_build_object('account_id',old_row.account_id,'category_id',old_row.category_id,
     'duplicate_override_reason',old_row.duplicate_override_reason),
   'after',jsonb_build_object('account_id',r.account_id,'category_id',r.category_id,
     'duplicate_override_reason',r.duplicate_override_reason)));
 return to_jsonb(r)||jsonb_build_object('duplicate',app_private.bank_duplicate_counts(p_workspace_id,r.id));
end $$;

-- All selected rows post, or none do. A retry with the same request returns its
-- original result; a new request for already confirmed rows returns their cash
-- IDs and produces no additional movement. Every cash row is source-linked.
create function public.confirm_bank_statement_rows(p_workspace_id uuid,p_batch_id uuid,
 p_row_ids uuid[],p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare prior app_private.bank_statement_requests;ordered_ids uuid[];selected_count integer;
 hash_value text;r public.bank_statement_rows;c public.expense_categories;a public.cash_accounts;
 new_cash_id uuid;result_rows jsonb:='[]'::jsonb;result jsonb;posted_count integer:=0;
 dup jsonb;source public.bank_statement_batches;
begin
 perform app_private.lock_inventory(p_workspace_id,array['owner','manager']);
 if p_request_id is null then raise exception 'BANK_REQUEST: Cần request_id để chống ghi trùng.';end if;
 if coalesce(cardinality(p_row_ids),0) not between 1 and 100 or array_position(p_row_ids,null) is not null then
  raise exception 'BANK_CONFIRM_ROWS: Chọn từ 1 đến 100 dòng hợp lệ.';
 end if;
 select array_agg(x order by x),count(distinct x)::integer into ordered_ids,selected_count from unnest(p_row_ids) x;
 if selected_count<>cardinality(p_row_ids) then raise exception 'BANK_CONFIRM_ROWS: Danh sách dòng bị trùng.';end if;
 hash_value:=md5(jsonb_build_object('batch_id',p_batch_id,'row_ids',ordered_ids)::text);
 select * into prior from app_private.bank_statement_requests where workspace_id=p_workspace_id and request_id=p_request_id;
 if found then
  if prior.action<>'confirm' or prior.batch_id<>p_batch_id or prior.payload_hash<>hash_value then
   raise exception 'BANK_REQUEST_REUSED: request_id đã dùng với nội dung khác.';
  end if;
  perform app_private.remember(p_workspace_id,p_request_id,'bank.confirm',p_batch_id);
  return prior.result;
 end if;
 select * into source from public.bank_statement_batches where workspace_id=p_workspace_id and id=p_batch_id;
 if not found then raise exception 'BANK_BATCH_NOT_FOUND: Không tìm thấy file sao kê trong workspace.';end if;
 perform 1 from public.bank_statement_rows where workspace_id=p_workspace_id and batch_id=p_batch_id and id=any(ordered_ids) order by id for update;
 if (select count(*) from public.bank_statement_rows where workspace_id=p_workspace_id and batch_id=p_batch_id and id=any(ordered_ids))<>selected_count then
  raise exception 'BANK_ROW_NOT_FOUND: Danh sách có dòng không thuộc file/workspace.';
 end if;
 for r in select * from public.bank_statement_rows where workspace_id=p_workspace_id and batch_id=p_batch_id and id=any(ordered_ids) order by id loop
  if r.status='confirmed' then
   if r.cash_id is null then raise exception 'BANK_RECONCILIATION: Dòng đã xác nhận thiếu chứng từ.';end if;
   result_rows:=result_rows||jsonb_build_array(jsonb_build_object('row_id',r.id,'cash_id',r.cash_id,'already_confirmed',true));
   continue;
  end if;
  if r.account_id is null or r.category_id is null then raise exception 'BANK_UNCLASSIFIED: Chọn tài khoản và nhóm thu chi trước khi xác nhận.';end if;
  select * into a from public.cash_accounts where workspace_id=p_workspace_id and id=r.account_id for share;
  if not found or not a.opening_confirmed or a.opening_date is null or r.transaction_date<a.opening_date then
   raise exception 'BANK_ACCOUNT: Tài khoản chưa xác nhận ngày/số dư mở sổ hoặc ngày giao dịch trước ngày mở sổ.';
  end if;
  select * into c from public.expense_categories where workspace_id=p_workspace_id and id=r.category_id for share;
  if not found or not c.is_active or c.direction<>r.direction then raise exception 'BANK_CATEGORY: Nhóm thu chi đã lưu trữ hoặc sai chiều tiền.';end if;
  dup:=app_private.bank_duplicate_counts(p_workspace_id,r.id);
  if (dup->>'possible_duplicate')::boolean and r.duplicate_override_reason is null then
   raise exception 'BANK_POSSIBLE_DUPLICATE: Dòng % có giao dịch khả năng trùng; cần ghi lý do để xác nhận.',r.row_number;
  end if;
  insert into public.cash_transactions(workspace_id,account_id,direction,transaction_date,date_estimated,category,amount,
    description,notes,legacy_id,source_id,import_row_hash,provenance,created_by)
   values(p_workspace_id,r.account_id,r.direction,r.transaction_date,false,c.code,r.amount,r.description,
    case when r.duplicate_override_reason is null then '' else 'Đã kiểm tra giao dịch có khả năng trùng: '||r.duplicate_override_reason end,
    'BANK:'||source.source_sha256||':'||r.row_number,source.source_sha256,r.row_fingerprint,
    jsonb_build_object('kind','bank_statement','batch_id',p_batch_id,'row_id',r.id,'row_number',r.row_number,
      'source_name',source.source_name,'source_sha256',source.source_sha256,'external_reference',r.external_reference,
      'duplicate_override_reason',r.duplicate_override_reason),auth.uid()) returning id into new_cash_id;
  perform public.post_cash(new_cash_id,gen_random_uuid());
  update public.bank_statement_rows set status='confirmed',cash_id=new_cash_id,confirmed_by=auth.uid(),
    confirmed_at=clock_timestamp(),updated_at=clock_timestamp() where workspace_id=p_workspace_id and id=r.id;
  perform app_private.audit(p_workspace_id,'bank_statement.row_confirmed',r.id,
    jsonb_build_object('batch_id',p_batch_id,'row_number',r.row_number,'cash_id',new_cash_id,
      'duplicate_override_reason',r.duplicate_override_reason,'request_id',p_request_id));
  result_rows:=result_rows||jsonb_build_array(jsonb_build_object('row_id',r.id,'cash_id',new_cash_id,'already_confirmed',false));
  posted_count:=posted_count+1;
 end loop;
 result:=jsonb_build_object('batch_id',p_batch_id,'rows',result_rows,'posted_count',posted_count);
 perform app_private.remember(p_workspace_id,p_request_id,'bank.confirm',p_batch_id);
 insert into app_private.bank_statement_requests(workspace_id,request_id,action,batch_id,payload_hash,result,created_by)
  values(p_workspace_id,p_request_id,'confirm',p_batch_id,hash_value,result,auth.uid());
 if posted_count>0 then
  update public.bank_statement_batches set updated_at=clock_timestamp() where workspace_id=p_workspace_id and id=p_batch_id;
  perform app_private.audit(p_workspace_id,'bank_statement.confirmed',p_batch_id,
   jsonb_build_object('posted_count',posted_count,'request_id',p_request_id));
 end if;
 return result;
end $$;

revoke all on function app_private.bank_description_key(text),app_private.bank_duplicate_counts(uuid,uuid),
 app_private.protect_bank_category_delete() from public,anon,authenticated;
revoke all on function public.stage_bank_statement(uuid,jsonb,uuid),
 public.get_bank_statement_import(uuid,uuid,integer,integer),
 public.classify_bank_statement_row(uuid,uuid,uuid,text,text),
 public.confirm_bank_statement_rows(uuid,uuid,uuid[],uuid) from public,anon;
grant execute on function public.stage_bank_statement(uuid,jsonb,uuid),
 public.get_bank_statement_import(uuid,uuid,integer,integer),
 public.classify_bank_statement_row(uuid,uuid,uuid,text,text),
 public.confirm_bank_statement_rows(uuid,uuid,uuid[],uuid) to authenticated;

commit;
