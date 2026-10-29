-- =====================================================================
-- Clear an item's history (ADMIN only) — for wiping test/junk data.
--
-- This is a HARD DELETE, unlike Void (which keeps the row and posts a
-- REVERSAL). It removes, for ONE item:
--   - every inventory_transactions row (so on-hand returns to 0)
--   - its beginning_inventory / receipts / withdrawals / beginning_adjustments
--     source documents
-- It does NOT touch other items. Split & Withdraw operation headers are kept
-- (they span two items); only this item's ledger rows and withdrawal
-- documents are removed, so the *other* item in a split keeps its stock.
-- The action itself is recorded in audit_logs with the row counts.
--
-- Safe to run more than once.
-- =====================================================================

create or replace function public.clear_item_history(p_item_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_code text;
  v_ledger int;
  v_beginning int;
  v_receipts int;
  v_withdrawals int;
  v_adjustments int;
begin
  if not public.is_admin() then raise exception 'Only ADMIN can clear item history'; end if;

  select item_code into v_code from items where id = p_item_id for update;
  if not found then raise exception 'Item not found'; end if;

  delete from inventory_transactions where item_id = p_item_id;
  get diagnostics v_ledger = row_count;
  delete from beginning_inventory where item_id = p_item_id;
  get diagnostics v_beginning = row_count;
  delete from receipts where item_id = p_item_id;
  get diagnostics v_receipts = row_count;
  delete from withdrawals where item_id = p_item_id;
  get diagnostics v_withdrawals = row_count;
  delete from beginning_adjustments where item_id = p_item_id;
  get diagnostics v_adjustments = row_count;

  insert into audit_logs (user_id, action, entity_type, entity_id, old_data)
  values (auth.uid(), 'CLEAR_HISTORY', 'items', p_item_id, jsonb_build_object(
    'item_code', v_code, 'ledger_rows', v_ledger, 'beginning_inventory', v_beginning,
    'receipts', v_receipts, 'withdrawals', v_withdrawals, 'beginning_adjustments', v_adjustments));
end;
$$;

revoke execute on function public.clear_item_history from anon, public;
grant execute on function public.clear_item_history to authenticated;
