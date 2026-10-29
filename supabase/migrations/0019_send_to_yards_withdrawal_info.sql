-- =====================================================================
-- Send to Yards also records the Withdrawal No. (job order) and Customer
-- the roll was opened for. Stored on the yards roll, and shown in the
-- TO_YARDS ledger row's remarks so it's visible in the item's history.
--
-- Requires 0018. Safe to run more than once.
-- =====================================================================
alter table public.yards_rolls add column if not exists withdrawal_no text;
alter table public.yards_rolls add column if not exists customer text;

drop function if exists public.send_roll_to_yards(uuid, numeric, text, numeric, date, text);

create or replace function public.send_roll_to_yards(
  p_item_id uuid, p_yards numeric, p_roll_no text default null, p_width numeric default null,
  p_entry_date date default current_date, p_remarks text default null,
  p_withdrawal_no text default null, p_customer text default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_roll_id uuid := gen_random_uuid();
  v_txn_id uuid;
  v_on_hand numeric;
  v_no text := nullif(trim(p_roll_no), '');
  v_wd text := nullif(trim(p_withdrawal_no), '');
  v_customer text := nullif(trim(p_customer), '');
begin
  if not public.is_active_user() then raise exception 'Not authorized'; end if;
  if p_yards is null or p_yards <= 0 then raise exception 'Yards must be greater than 0'; end if;
  if p_width is not null and p_width <= 0 then raise exception 'Width must be greater than 0'; end if;

  perform 1 from items where id = p_item_id for update;
  if not found then raise exception 'Item not found'; end if;

  select coalesce(sum(quantity), 0) into v_on_hand from inventory_transactions where item_id = p_item_id;
  if v_on_hand < 1 then raise exception 'No roll in stock to send to Yards (% on hand)', v_on_hand; end if;

  insert into inventory_transactions (transaction_date, transaction_type, item_id, quantity, reference_type, reference_id, remarks, created_by)
  values (p_entry_date, 'TO_YARDS', p_item_id, -1, 'yards_rolls', v_roll_id,
          concat_ws(' — ',
            'Sent to Yards' || coalesce(' (Core No. ' || v_no || ')', ''),
            v_wd, v_customer, nullif(trim(p_remarks), '')),
          auth.uid())
  returning id into v_txn_id;

  insert into yards_rolls (id, item_id, roll_no, width, source_transaction_id, withdrawal_no, customer, created_by)
  values (v_roll_id, p_item_id, v_no, p_width, v_txn_id, v_wd, v_customer, auth.uid());

  insert into yards_transactions (roll_id, transaction_date, transaction_type, quantity, customer, remarks, created_by)
  values (v_roll_id, p_entry_date, 'RECEIVED', p_yards, v_customer, 'Opened from main stock', auth.uid());

  insert into audit_logs (user_id, action, entity_type, entity_id, new_data)
  values (auth.uid(), 'SEND_TO_YARDS', 'yards_rolls', v_roll_id,
          jsonb_build_object('item_id', p_item_id, 'roll_no', v_no, 'yards', p_yards, 'width', p_width,
                             'withdrawal_no', v_wd, 'customer', v_customer));

  return v_roll_id;
exception
  when unique_violation then
    raise exception 'Core No. % is already used by another roll.', v_no;
end;
$$;

revoke execute on function public.send_roll_to_yards from anon, public;
grant execute on function public.send_roll_to_yards to authenticated;
