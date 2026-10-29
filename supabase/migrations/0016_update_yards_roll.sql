-- =====================================================================
-- Edit a Yards roll (ADMIN only): Core No. (roll_no), item, and the
-- Total Received quantity. Correcting the received quantity edits the
-- roll's original RECEIVED entry in place (it's a data-entry fix, not a
-- stock movement) and is refused if it would drop the balance below what
-- has already been withdrawn. Old/new values go to audit_logs.
--
-- Safe to run more than once.
-- =====================================================================
create or replace function public.update_yards_roll(
  p_roll_id uuid, p_roll_no text, p_item_id uuid, p_received_yards numeric
) returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_roll yards_rolls%rowtype;
  v_received_id uuid;
  v_old_received numeric;
  v_balance numeric;
  v_new_no text := nullif(trim(p_roll_no), '');
begin
  if not public.is_admin() then raise exception 'Only ADMIN can edit a roll'; end if;
  if p_received_yards is null or p_received_yards <= 0 then raise exception 'Received yards must be greater than 0'; end if;

  select * into v_roll from yards_rolls where id = p_roll_id for update;
  if not found then raise exception 'Roll not found'; end if;
  if not exists (select 1 from items where id = p_item_id) then raise exception 'Item not found'; end if;

  select id, quantity into v_received_id, v_old_received
  from yards_transactions
  where roll_id = p_roll_id and transaction_type = 'RECEIVED' and reversal_of is null
  order by created_at limit 1;
  if v_received_id is null then raise exception 'This roll has no received entry to edit'; end if;

  select coalesce(sum(quantity), 0) into v_balance from yards_transactions where roll_id = p_roll_id;
  if v_balance - v_old_received + p_received_yards < 0 then
    raise exception 'Received yards cannot be lower than what was already withdrawn (balance would be %)',
      v_balance - v_old_received + p_received_yards;
  end if;

  update yards_rolls set roll_no = v_new_no, item_id = p_item_id where id = p_roll_id;
  update yards_transactions set quantity = p_received_yards where id = v_received_id;

  insert into audit_logs (user_id, action, entity_type, entity_id, old_data, new_data)
  values (auth.uid(), 'UPDATE', 'yards_rolls', p_roll_id,
          jsonb_build_object('roll_no', v_roll.roll_no, 'item_id', v_roll.item_id, 'received_yards', v_old_received),
          jsonb_build_object('roll_no', v_new_no, 'item_id', p_item_id, 'received_yards', p_received_yards));
exception
  when unique_violation then
    raise exception 'Core No. % is already used by another roll.', v_new_no;
end;
$$;

revoke execute on function public.update_yards_roll from anon, public;
grant execute on function public.update_yards_roll to authenticated;
