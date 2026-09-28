-- =====================================================================
-- Fix: Void didn't support Beginning Adjustment entries ("Unsupported
-- reference type beginning_adjustments"). Extend it, mirroring how
-- Beginning itself was made fully flexible in 0009 — voiding a Beginning
-- entry or Adjustment never checks the "would take stock negative" guard
-- (Receipts/Withdrawals still do; those govern real physical movement).
--
-- Safe to run more than once.
-- =====================================================================

alter table public.beginning_adjustments add column if not exists voided_at timestamptz;
alter table public.beginning_adjustments add column if not exists voided_by uuid references public.profiles (id);

create or replace function public.void_entry(p_reference_type text, p_reference_id uuid, p_reason text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_txn inventory_transactions%rowtype;
  v_on_hand numeric;
begin
  if not public.is_admin() then raise exception 'Only ADMIN can void records'; end if;
  if p_reference_type not in ('beginning_inventory', 'beginning_adjustments', 'receipts', 'withdrawals') then
    raise exception 'Unsupported reference type %', p_reference_type;
  end if;

  select * into v_txn from inventory_transactions
  where reference_type = p_reference_type and reference_id = p_reference_id and reversal_of is null;
  if not found then raise exception 'Ledger entry not found'; end if;

  perform 1 from items where id = v_txn.item_id for update;

  -- Receipts/Withdrawals still can't be voided into negative stock — that governs
  -- real physical movement. Beginning Inventory and its Adjustments are a
  -- correction tool and are deliberately unrestricted (see 0009).
  if v_txn.quantity > 0 and p_reference_type in ('receipts', 'withdrawals') then
    select coalesce(sum(quantity), 0) into v_on_hand from inventory_transactions where item_id = v_txn.item_id;
    if v_on_hand - v_txn.quantity < 0 then
      raise exception 'Cannot void: stock would go negative (% on hand)', v_on_hand;
    end if;
  end if;

  insert into inventory_transactions (transaction_type, item_id, quantity, reference_type, reference_id, reversal_of, remarks, created_by)
  values ('REVERSAL', v_txn.item_id, -v_txn.quantity, p_reference_type, p_reference_id, v_txn.id, p_reason, auth.uid());

  execute format('update %I set voided_at = now(), voided_by = $1 where id = $2', p_reference_type)
  using auth.uid(), p_reference_id;

  insert into audit_logs (user_id, action, entity_type, entity_id, new_data)
  values (auth.uid(), 'VOID', p_reference_type, p_reference_id, jsonb_build_object('reason', p_reason));
end;
$$;
