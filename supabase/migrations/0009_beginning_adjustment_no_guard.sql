-- =====================================================================
-- Beginning Inventory adjustments: drop the "would take on-hand stock
-- negative" guard. ADMIN can now set Beginning to any value they want —
-- the point of this feature is a fully audited correction tool, not another
-- validation gate. Every change is still logged in `beginning_adjustments`
-- with previous/new/difference/reason/who/when, exactly as before.
--
-- Still required: ADMIN role, a reason, and a quantity >= 0 (a negative
-- Beginning count isn't a real physical quantity). Say the word if you want
-- that last one relaxed too.
--
-- Safe to run more than once.
-- =====================================================================

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

  select coalesce(sum(quantity), 0) into v_current_beginning
  from inventory_transactions
  where item_id = p_item_id and (transaction_type = 'BEGINNING' or reference_type = 'beginning_adjustments');

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
