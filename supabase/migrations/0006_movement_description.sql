-- =====================================================================
-- Per-entry Description for Beginning / Received / Withdraw — same treatment
-- as 0005's per-entry Width/Length: defaults from the item, but can be
-- overridden on a specific entry (matches the legacy sheet, which had its
-- own Description column per row, separate from the item master).
--
-- Safe to run more than once.
-- =====================================================================

alter table public.beginning_inventory add column if not exists description text;
alter table public.receipts add column if not exists description text;
alter table public.withdrawals add column if not exists description text;

-- Adding a parameter changes the signature, so drop the old ones explicitly
-- (must match 0005's exact parameter types) before recreating.
drop function if exists public.post_beginning(uuid, numeric, date, text, numeric, text, numeric, text);
drop function if exists public.post_receipt(uuid, numeric, date, text, text, text, text, numeric, text, numeric, text);
drop function if exists public.post_withdrawal(uuid, numeric, date, text, text, text, numeric, text, numeric, text);

create function public.post_beginning(
  p_item_id uuid, p_quantity numeric, p_entry_date date default current_date, p_notes text default null,
  p_width numeric default null, p_width_unit text default null, p_length numeric default null, p_length_unit text default null,
  p_description text default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  if not public.is_active_user() then raise exception 'Not authorized'; end if;

  insert into beginning_inventory (entry_date, item_id, quantity, notes, width, width_unit, length, length_unit, description, created_by)
  values (p_entry_date, p_item_id, p_quantity, p_notes, p_width, p_width_unit, p_length, p_length_unit, p_description, auth.uid())
  returning id into v_id;

  insert into inventory_transactions (transaction_date, transaction_type, item_id, quantity, reference_type, reference_id, remarks, created_by)
  values (p_entry_date, 'BEGINNING', p_item_id, p_quantity, 'beginning_inventory', v_id, p_notes, auth.uid());

  insert into audit_logs (user_id, action, entity_type, entity_id, new_data)
  select auth.uid(), 'CREATE', 'beginning_inventory', v_id, to_jsonb(b) from beginning_inventory b where b.id = v_id;

  return v_id;
end;
$$;

create function public.post_receipt(
  p_item_id uuid, p_quantity numeric, p_entry_date date default current_date,
  p_mrr_no text default null, p_supplier text default null, p_reference text default null, p_remarks text default null,
  p_width numeric default null, p_width_unit text default null, p_length numeric default null, p_length_unit text default null,
  p_description text default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  if not public.is_active_user() then raise exception 'Not authorized'; end if;

  insert into receipts (entry_date, item_id, quantity, mrr_no, supplier, reference, remarks, width, width_unit, length, length_unit, description, created_by)
  values (p_entry_date, p_item_id, p_quantity, p_mrr_no, p_supplier, p_reference, p_remarks, p_width, p_width_unit, p_length, p_length_unit, p_description, auth.uid())
  returning id into v_id;

  insert into inventory_transactions (transaction_date, transaction_type, item_id, quantity, reference_type, reference_id, remarks, created_by)
  values (p_entry_date, 'RECEIVED', p_item_id, p_quantity, 'receipts', v_id, p_remarks, auth.uid());

  insert into audit_logs (user_id, action, entity_type, entity_id, new_data)
  select auth.uid(), 'CREATE', 'receipts', v_id, to_jsonb(r) from receipts r where r.id = v_id;

  return v_id;
end;
$$;

create function public.post_withdrawal(
  p_item_id uuid, p_quantity numeric, p_entry_date date default current_date,
  p_withdrawal_no text default null, p_customer text default null, p_remarks text default null,
  p_width numeric default null, p_width_unit text default null, p_length numeric default null, p_length_unit text default null,
  p_description text default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_on_hand numeric;
begin
  if not public.is_active_user() then raise exception 'Not authorized'; end if;

  perform 1 from items where id = p_item_id for update;
  if not found then raise exception 'Item not found'; end if;

  select coalesce(sum(quantity), 0) into v_on_hand from inventory_transactions where item_id = p_item_id;

  if p_quantity > v_on_hand then
    raise exception 'Insufficient stock: % on hand, % requested', v_on_hand, p_quantity;
  end if;

  insert into withdrawals (entry_date, item_id, quantity, withdrawal_no, customer, remarks, width, width_unit, length, length_unit, description, created_by)
  values (p_entry_date, p_item_id, p_quantity, p_withdrawal_no, p_customer, p_remarks, p_width, p_width_unit, p_length, p_length_unit, p_description, auth.uid())
  returning id into v_id;

  insert into inventory_transactions (transaction_date, transaction_type, item_id, quantity, reference_type, reference_id, remarks, created_by)
  values (p_entry_date, 'WITHDRAWAL', p_item_id, -p_quantity, 'withdrawals', v_id, p_remarks, auth.uid());

  insert into audit_logs (user_id, action, entity_type, entity_id, new_data)
  select auth.uid(), 'CREATE', 'withdrawals', v_id, to_jsonb(w) from withdrawals w where w.id = v_id;

  return v_id;
end;
$$;

revoke execute on function public.post_beginning, public.post_receipt, public.post_withdrawal from anon, public;
grant execute on function public.post_beginning, public.post_receipt, public.post_withdrawal to authenticated;
