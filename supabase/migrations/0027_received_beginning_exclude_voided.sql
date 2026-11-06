-- =====================================================================
-- Stocks: Received and Beginning no longer count voided entries, the same
-- as Withdrawn in 0025, so Beginning + Received - Withdrawn = On Hand.
--
-- A voided entry and its REVERSAL are both left out. Adjusting Beginning
-- works out the current balance the same way, so it stays in step.
--
-- Requires 0024. Safe to run more than once.
-- =====================================================================

create or replace view public.current_stock
with (security_invoker = true)
as
select
  i.id as item_id,
  i.item_code,
  i.description,
  i.width,
  i.width_unit,
  i.length,
  i.length_unit,
  i.uom,
  i.category,
  i.active,
  coalesce(sum(t.quantity), 0) as on_hand,
  coalesce(sum(t.quantity) filter (where t.counted and (t.transaction_type = 'BEGINNING' or t.reference_type = 'beginning_adjustments')), 0) as beginning,
  coalesce(sum(t.quantity) filter (where t.counted and t.transaction_type in ('RECEIVED', 'SPLIT_CHILD')), 0) as received,
  coalesce(-sum(t.quantity) filter (where t.counted and t.transaction_type in ('WITHDRAWAL', 'SPLIT_PARENT', 'TO_YARDS')), 0) as withdrawn,
  max(t.created_at) as last_movement_at
from public.items i
left join (
  select
    tx.*,
    (y.start_date is null or tx.transaction_date >= y.start_date or tx.created_at > y.closed_at)
      and tx.transaction_type <> 'REVERSAL'
      and not exists (select 1 from public.inventory_transactions r where r.reversal_of = tx.id) as counted
  from public.inventory_transactions tx
  left join (select start_date, closed_at from public.stock_years order by start_date desc limit 1) y on true
) t on t.item_id = i.id
group by i.id;

-- Same as 0024, except voided entries are left out of the current balance.
create or replace function public.post_beginning_adjustment(
  p_item_id uuid, p_new_quantity numeric, p_reason text, p_entry_date date default current_date
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_current_beginning numeric;
  v_delta numeric;
begin
  if not public.is_admin() then raise exception 'Only ADMIN can adjust Beginning Inventory'; end if;
  if p_new_quantity < 0 then raise exception 'Beginning quantity cannot be negative'; end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'A reason is required to adjust Beginning Inventory'; end if;

  perform 1 from items where id = p_item_id for update;
  if not found then raise exception 'Item not found'; end if;

  select coalesce(sum(t.quantity), 0) into v_current_beginning
  from inventory_transactions t
  where t.item_id = p_item_id and (t.transaction_type = 'BEGINNING' or t.reference_type = 'beginning_adjustments')
    and public.in_stock_year(t.transaction_date, t.created_at)
    and t.transaction_type <> 'REVERSAL'
    and not exists (select 1 from inventory_transactions r where r.reversal_of = t.id);

  v_delta := p_new_quantity - v_current_beginning;
  if v_delta = 0 then raise exception 'New quantity is the same as the current Beginning balance (%).', v_current_beginning; end if;

  insert into beginning_adjustments (item_id, previous_quantity, new_quantity, difference, reason, created_by)
  values (p_item_id, v_current_beginning, p_new_quantity, v_delta, p_reason, auth.uid())
  returning id into v_id;

  insert into inventory_transactions (transaction_date, transaction_type, item_id, quantity, reference_type, reference_id, remarks, created_by)
  values (p_entry_date, 'ADJUSTMENT', p_item_id, v_delta, 'beginning_adjustments', v_id, p_reason, auth.uid());

  insert into audit_logs (user_id, action, entity_type, entity_id, old_data, new_data)
  values (
    auth.uid(), 'ADJUST', 'beginning_adjustments', v_id,
    jsonb_build_object('quantity', v_current_beginning),
    jsonb_build_object('quantity', p_new_quantity, 'difference', v_delta, 'reason', p_reason)
  );

  return v_id;
end;
$$;
