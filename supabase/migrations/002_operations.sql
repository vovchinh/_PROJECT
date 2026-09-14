-- ChiDi ERP V1.1: owner-managed membership and consistent ledger reporting.
-- Apply AFTER 001_core.sql. This migration can be applied again safely.
-- No emails are sent. No existing source documents or balances are rewritten.
begin;

create or replace function app_private.email_hint(p_email text)
returns text language sql immutable set search_path = '' as $$
 select case when p_email is null or position('@' in p_email) < 2
   then 'Tài khoản đã đăng ký'
   else left(split_part(lower(p_email),'@',1),1) || '***@' || split_part(lower(p_email),'@',2)
 end
$$;

-- Serialize changes on the workspace, then recheck authority after waiting.
-- This prevents two owners from concurrently leaving a workspace with no owner.
create or replace function app_private.lock_membership_owner(p_workspace_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
 perform app_private.require_role(p_workspace_id,array['owner']);
 perform 1 from public.workspaces where id=p_workspace_id for update;
 if not found then raise exception 'Không tìm thấy workspace.'; end if;
 perform app_private.require_role(p_workspace_id,array['owner']);
end $$;

create or replace function public.list_workspace_members(p_workspace_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
 perform app_private.require_role(p_workspace_id,array['owner']);
 select coalesce(jsonb_agg(jsonb_build_object(
   'user_id',m.user_id,'role',m.role,
   'email_hint',app_private.email_hint(u.email),'is_self',m.user_id=auth.uid()
 ) order by case m.role when 'owner' then 0 when 'manager' then 1 when 'staff' then 2 else 3 end,m.user_id),'[]'::jsonb)
 into result
 from public.workspace_members m join auth.users u on u.id=m.user_id
 where m.workspace_id=p_workspace_id;
 return result;
end $$;

create or replace function public.add_workspace_member(
 p_workspace_id uuid,p_email text,p_role text default 'viewer'
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare target_id uuid;target_email text;email_value text:=lower(trim(p_email));
 old_role text;matches integer;changed boolean:=false;
begin
 perform app_private.lock_membership_owner(p_workspace_id);
 if p_role is null or p_role not in ('owner','manager','staff','viewer') then
  raise exception 'Vai trò không hợp lệ.';
 end if;
 if email_value is null or length(email_value) not between 3 and 320
    or email_value !~ '^[^[:space:]@]+@[^[:space:]@]+$' then
  raise exception 'Cần địa chỉ email đăng ký chính xác.';
 end if;
 -- Exact normalized email only; never LIKE, global listing, or an invitation.
 select count(*)::integer into matches from auth.users
 where lower(email)=email_value and email_confirmed_at is not null;
 if matches<>1 then
  raise exception 'Không tìm thấy tài khoản có email đã xác nhận; người dùng cần đăng ký và xác nhận email trước.';
 end if;
 select id,email into target_id,target_email from auth.users
 where lower(email)=email_value and email_confirmed_at is not null;
 select role into old_role from public.workspace_members
 where workspace_id=p_workspace_id and user_id=target_id;
 if found then
  if old_role<>p_role then
   raise exception 'Người dùng đã là thành viên; dùng thao tác đổi vai trò để cập nhật.';
  end if;
 else
  insert into public.workspace_members(workspace_id,user_id,role)
   values(p_workspace_id,target_id,p_role);
  changed:=true;
  perform app_private.audit(p_workspace_id,'member.added',target_id,
   jsonb_build_object('role',p_role,'email_hint',app_private.email_hint(target_email)));
 end if;
 return jsonb_build_object('user_id',target_id,'role',p_role,
  'email_hint',app_private.email_hint(target_email),'is_self',target_id=auth.uid(),'changed',changed);
end $$;

create or replace function public.set_workspace_member_role(
 p_workspace_id uuid,p_user_id uuid,p_role text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare old_role text;target_email text;changed boolean:=false;
begin
 perform app_private.lock_membership_owner(p_workspace_id);
 if p_role is null or p_role not in ('owner','manager','staff','viewer') then
  raise exception 'Vai trò không hợp lệ.';
 end if;
 select m.role,u.email into old_role,target_email
 from public.workspace_members m join auth.users u on u.id=m.user_id
 where m.workspace_id=p_workspace_id and m.user_id=p_user_id;
 if not found then raise exception 'Không tìm thấy thành viên trong workspace này.'; end if;
 if old_role='owner' and p_role<>'owner'
    and (select count(*) from public.workspace_members where workspace_id=p_workspace_id and role='owner')<=1 then
  raise exception 'Không thể hạ quyền owner cuối cùng; hãy cấp owner cho một thành viên khác trước.';
 end if;
 if old_role<>p_role then
  update public.workspace_members set role=p_role
   where workspace_id=p_workspace_id and user_id=p_user_id;
  changed:=true;
  perform app_private.audit(p_workspace_id,'member.role_changed',p_user_id,
   jsonb_build_object('old_role',old_role,'new_role',p_role));
 end if;
 return jsonb_build_object('user_id',p_user_id,'role',p_role,
  'email_hint',app_private.email_hint(target_email),'is_self',p_user_id=auth.uid(),'changed',changed);
end $$;

create or replace function public.remove_workspace_member(p_workspace_id uuid,p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare old_role text;
begin
 perform app_private.lock_membership_owner(p_workspace_id);
 if p_user_id=auth.uid() then
  raise exception 'Không thể tự xóa quyền truy cập của chính mình; nhờ owner khác thực hiện.';
 end if;
 select role into old_role from public.workspace_members
  where workspace_id=p_workspace_id and user_id=p_user_id;
 if not found then raise exception 'Không tìm thấy thành viên trong workspace này.'; end if;
 if old_role='owner'
    and (select count(*) from public.workspace_members where workspace_id=p_workspace_id and role='owner')<=1 then
  raise exception 'Không thể xóa owner cuối cùng.';
 end if;
 delete from public.workspace_members where workspace_id=p_workspace_id and user_id=p_user_id;
 perform app_private.audit(p_workspace_id,'member.removed',p_user_id,jsonb_build_object('old_role',old_role));
 return jsonb_build_object('user_id',p_user_id,'removed',true);
end $$;

-- STABLE makes every query in this function use the calling statement's snapshot.
-- The aggregate below is one SQL statement; it never filters ledger by current
-- document status, which would erase a posting from periods before its reversal.
-- Monetary sums use numeric, then text, to remain exact beyond JS Number limits.
create or replace function public.get_workspace_report(p_workspace_id uuid,p_from date,p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
 perform app_private.require_role(p_workspace_id,array['owner','manager','staff','viewer']);
 if p_from is null or p_to is null or not isfinite(p_from) or not isfinite(p_to) or p_from>p_to then
  raise exception 'Kỳ báo cáo phải có ngày bắt đầu và kết thúc hợp lệ; ngày bắt đầu không sau ngày kết thúc.';
 end if;
 with
 accounts as materialized (
  select a.*,case when not a.opening_confirmed or a.opening_date is null then 'unconfirmed'
   when a.opening_date>p_to then 'opens_after_period' else 'included' end as state
  from public.cash_accounts a where a.workspace_id=p_workspace_id
 ),
 eligible_cash as materialized (
  select m.* from public.cash_movements m join accounts a on a.id=m.account_id
  where m.workspace_id=p_workspace_id and a.state='included'
   and m.transaction_date>=a.opening_date and m.transaction_date<=p_to
 ),
 cash_by_account as (
  select a.id,a.code,a.name,a.opening_date,a.opening_confirmed,a.state,
   case when a.state='included' then
    case when a.opening_date<=p_from then a.opening_balance::numeric else 0::numeric end
    +coalesce(sum(m.signed_amount) filter(where m.transaction_date<p_from),0) end as opening_cash,
   case when a.state='included' then
    case when a.opening_date>p_from then a.opening_balance::numeric else 0::numeric end end as openings_in_period,
   coalesce(sum(m.amount) filter(where m.transaction_date>=p_from and m.direction='in'),0) as cash_in,
   coalesce(sum(m.amount) filter(where m.transaction_date>=p_from and m.direction='out'),0) as cash_out,
   coalesce(sum(m.signed_amount) filter(where m.transaction_date>=p_from),0) as net_cash_flow,
   case when a.state='included' then a.opening_balance::numeric+coalesce(sum(m.signed_amount),0) end as closing_cash
  from accounts a left join eligible_cash m on m.account_id=a.id
  group by a.id,a.code,a.name,a.opening_date,a.opening_confirmed,a.state,a.opening_balance
 ),
 cash_totals as (
  select coalesce(sum(opening_cash),0) as opening_cash,coalesce(sum(openings_in_period),0) as openings_in_period,
   coalesce(sum(cash_in),0) as cash_in,coalesce(sum(cash_out),0) as cash_out,
   coalesce(sum(net_cash_flow),0) as net_cash_flow,coalesce(sum(closing_cash),0) as closing_cash,
   count(*) filter(where state='included')::integer as confirmed_account_count,
   count(*) filter(where state='unconfirmed')::integer as unconfirmed_account_count,
   count(*) filter(where state='opens_after_period')::integer as not_yet_open_account_count
  from cash_by_account
 ),
 categories as (
  select category,coalesce(sum(amount) filter(where direction='in'),0) as cash_in,
   coalesce(sum(amount) filter(where direction='out'),0) as cash_out,sum(signed_amount) as net_cash_flow,
   count(*) filter(where movement_kind='post')::integer as post_count,
   count(*) filter(where movement_kind='reversal')::integer as reversal_count
  from eligible_cash where transaction_date>=p_from group by category
 ),
 stock as materialized (
  select m.* from public.stock_movements m
  where m.workspace_id=p_workspace_id and m.received_date<=p_to
 ),
 stock_by_sku as (
  select p.id as product_id,p.code,p.name,
   coalesce(sum(m.qty) filter(where m.received_date>=p_from),0) as qty_in_period,
   coalesce(sum(m.amount) filter(where m.received_date>=p_from),0) as amount_in_period,
   coalesce(sum(m.qty),0) as qty_as_of,coalesce(sum(m.amount),0) as amount_as_of
  from public.products p left join stock m on m.product_id=p.id
  where p.workspace_id=p_workspace_id group by p.id,p.code,p.name
 ),
 stock_totals as (
  select coalesce(sum(qty_in_period),0) as purchase_qty,coalesce(sum(amount_in_period),0) as purchase_amount,
   coalesce(sum(qty_as_of),0) as stock_qty_as_of,coalesce(sum(amount_as_of),0) as stock_value_as_of from stock_by_sku
 ),
 pending as (
  select
   (select count(*)::integer from public.purchase_receipts where workspace_id=p_workspace_id and status='draft') as pending_purchase_count,
   (select count(*)::integer from public.cash_transactions where workspace_id=p_workspace_id and status='draft') as pending_cash_count,
   (select count(*)::integer from public.cash_movements m join accounts a on a.id=m.account_id
    where m.workspace_id=p_workspace_id and m.transaction_date<=p_to
     and (a.state<>'included' or m.transaction_date<a.opening_date)) as excluded_cash_movement_count
 )
 select jsonb_build_object(
  'workspace_id',p_workspace_id,'from',p_from,'to',p_to,'generated_at',statement_timestamp(),
  'currency','VND','basis','posted_ledgers_only',
  'overview',jsonb_build_object(
   'cash_in',c.cash_in::text,'cash_out',c.cash_out::text,'net_cash_flow',c.net_cash_flow::text,
   'opening_cash',c.opening_cash::text,'openings_in_period',c.openings_in_period::text,'closing_cash',c.closing_cash::text,
   'reconciliation_difference',(c.closing_cash-c.opening_cash-c.openings_in_period-c.net_cash_flow)::text,
   'purchase_qty',s.purchase_qty::text,'purchase_amount',s.purchase_amount::text,
   'stock_qty_as_of',s.stock_qty_as_of::text,'stock_value_as_of',s.stock_value_as_of::text,
   'pending_purchase_count',d.pending_purchase_count,'pending_cash_count',d.pending_cash_count,
   'confirmed_account_count',c.confirmed_account_count,'unconfirmed_account_count',c.unconfirmed_account_count,
   'not_yet_open_account_count',c.not_yet_open_account_count),
  'cash_accounts',(select coalesce(jsonb_agg(jsonb_build_object(
   'id',a.id,'code',a.code,'name',a.name,'opening_date',a.opening_date,'opening_confirmed',a.opening_confirmed,'state',a.state,
   'opening_cash',a.opening_cash::text,'openings_in_period',a.openings_in_period::text,
   'cash_in',a.cash_in::text,'cash_out',a.cash_out::text,'net_cash_flow',a.net_cash_flow::text,'closing_cash',a.closing_cash::text
  ) order by a.code),'[]'::jsonb) from cash_by_account a),
  'cash_categories',(select coalesce(jsonb_agg(jsonb_build_object(
   'category',k.category,'cash_in',k.cash_in::text,'cash_out',k.cash_out::text,'net_cash_flow',k.net_cash_flow::text,
   'post_count',k.post_count,'reversal_count',k.reversal_count
  ) order by k.category),'[]'::jsonb) from categories k),
  'stock_by_sku',(select coalesce(jsonb_agg(jsonb_build_object(
   'product_id',p.product_id,'code',p.code,'name',p.name,'qty_in_period',p.qty_in_period::text,
   'amount_in_period',p.amount_in_period::text,'qty_as_of',p.qty_as_of::text,'amount_as_of',p.amount_as_of::text
  ) order by p.code),'[]'::jsonb) from stock_by_sku p),
  'warnings',jsonb_build_array(
   jsonb_build_object('code','RECEIPT_LEDGER_ONLY','message','Số lượng và giá trị kho chỉ từ phiếu nhập và phiếu đảo đã ghi; chưa có đầy đủ bán hàng, xuất kho hoặc kiểm kê.'),
   jsonb_build_object('code','CASH_IS_NOT_PROFIT','message','Thu chi là phát sinh tiền theo sổ; tiền COD, vốn và trả tiền mua hàng không tự trở thành doanh thu hoặc lợi nhuận.')
  )
  ||case when c.unconfirmed_account_count>0 then jsonb_build_array(jsonb_build_object(
   'code','UNCONFIRMED_OPENINGS','message','Tài khoản chưa xác nhận số dư đầu bị loại khỏi tổng số dư; tổng chưa đại diện đầy đủ tiền của shop.')) else '[]'::jsonb end
  ||case when c.not_yet_open_account_count>0 then jsonb_build_array(jsonb_build_object(
   'code','FUTURE_OPENINGS','message','Tài khoản có ngày mở sổ sau kỳ báo cáo chưa được tính vào số dư.')) else '[]'::jsonb end
  ||case when d.pending_purchase_count+d.pending_cash_count>0 then jsonb_build_array(jsonb_build_object(
   'code','DRAFTS_EXCLUDED','message','Chứng từ nháp không vào báo cáo. Số đếm chờ xử lý bao gồm mọi ngày, kể cả chưa có ngày.')) else '[]'::jsonb end
  ||case when d.excluded_cash_movement_count>0 then jsonb_build_array(jsonb_build_object(
   'code','INVALID_LEDGER_OPENING','message','Có phát sinh tiền không khớp trạng thái/ngày mở sổ đã bị loại; cần quản trị viên kiểm tra toàn vẹn dữ liệu.')) else '[]'::jsonb end
 ) into result from cash_totals c cross join stock_totals s cross join pending d;
 return result;
end $$;

-- No change to the V1 table SELECT/RLS grants. All writes remain checked RPCs.
revoke all on function app_private.email_hint(text),app_private.lock_membership_owner(uuid) from public,anon,authenticated;
revoke all on function public.list_workspace_members(uuid),public.add_workspace_member(uuid,text,text),
 public.set_workspace_member_role(uuid,uuid,text),public.remove_workspace_member(uuid,uuid),
 public.get_workspace_report(uuid,date,date) from public,anon;
grant execute on function public.list_workspace_members(uuid),public.add_workspace_member(uuid,text,text),
 public.set_workspace_member_role(uuid,uuid,text),public.remove_workspace_member(uuid,uuid),
 public.get_workspace_report(uuid,date,date) to authenticated;

create index if not exists workspace_members_user_workspace_idx on public.workspace_members(user_id,workspace_id);
create index if not exists cash_movements_workspace_date_idx on public.cash_movements(workspace_id,transaction_date);
create index if not exists stock_movements_workspace_date_idx on public.stock_movements(workspace_id,received_date);
commit;
