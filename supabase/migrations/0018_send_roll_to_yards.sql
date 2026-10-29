-- =====================================================================
-- Send to Yards: open ONE whole roll from main stock into Yards Stock.
--
-- One call, one transaction:
--   1. inventory_transactions: TO_YARDS, -1, for the item (main stock -1 roll)
--   2. yards_rolls: a new roll (Core No., width) linked to that ledger row
--   3. yards_transactions: RECEIVED +<yards> on the new roll
--
-- Stocks: TO_YARDS counts in the Withdrawn column (the roll did leave main
-- stock), so Beginning + Received - Withdrawn still equals On Hand — same
-- reasoning as 0012 for split movements. The item history still shows it as
-- TO_YARDS, so it's distinguishable from a customer withdrawal.
--
-- Void (ADMIN): puts the roll back (+1 REVERSAL), zeroes and deactivates the
-- yards roll. Refused once any yards have been withdrawn from it.
--
-- Safe to run more than once.
-- =====================================================================

-- Allow the new ledger type.
alter table public.inventory_transactions drop constraint if exists inventory_transactions_transaction_type_check;
alter table public.inventory_transactions add constraint inventory_transactions_transaction_type_check
  check (transaction_type in (
    'BEGINNING', 'RECEIVED', 'WITHDRAWAL',
    'SPLIT_PARENT', 'SPLIT_CHILD', 'TO_YARDS',
    'ADJUSTMENT', 'DISPOSAL', 'RETURN', 'REVERSAL'));

-- Which main-stock movement a yards roll came from (null = received directly as yards).
-- "on delete set null" so Clear history on the item still works.
alter table public.yards_rolls add column if not exists source_transaction_id uuid
  references public.inventory_transactions (id) on delete set null;

-- drop + create (not "create or replace"): an earlier draft of 0013 added an
-- include_in_sales_orders column to this view, and Postgres can't drop a view
-- column via "or replace".
drop view if exists public.current_stock;
create view public.current_stock
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
  coalesce(sum(t.quantity) filter (where t.transaction_type = 'BEGINNING' or t.reference_type = 'beginning_adjustments'), 0) as beginning,
  coalesce(sum(t.quantity) filter (where t.transaction_type in ('RECEIVED', 'SPLIT_CHILD')), 0) as received,
  coalesce(-sum(t.quantity) filter (where t.transaction_type in ('WITHDRAWAL', 'SPLIT_PARENT', 'TO_YARDS')), 0) as withdrawn,
  max(t.created_at) as last_movement_at
from public.items i
left join public.inventory_transactions t on t.item_id = i.id
group by i.id;

create or replace function public.send_roll_to_yards(
  p_item_id uuid, p_yards numeric, p_roll_no text default null, p_width numeric default null,
  p_entry_date date default current_date, p_remarks text default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_roll_id uuid := gen_random_uuid();
  v_txn_id uuid;
  v_on_hand numeric;
  v_no text := nullif(trim(p_roll_no), '');
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
          coalesce(nullif(trim(p_remarks), ''), 'Sent to Yards' || coalesce(' — Core No. ' || v_no, '')), auth.uid())
  returning id into v_txn_id;

  insert into yards_rolls (id, item_id, roll_no, width, source_transaction_id, created_by)
  values (v_roll_id, p_item_id, v_no, p_width, v_txn_id, auth.uid());

  insert into yards_transactions (roll_id, transaction_date, transaction_type, quantity, remarks, created_by)
  values (v_roll_id, p_entry_date, 'RECEIVED', p_yards, 'Opened from main stock', auth.uid());

  insert into audit_logs (user_id, action, entity_type, entity_id, new_data)
  values (auth.uid(), 'SEND_TO_YARDS', 'yards_rolls', v_roll_id,
          jsonb_build_object('item_id', p_item_id, 'roll_no', v_no, 'yards', p_yards, 'width', p_width));

  return v_roll_id;
exception
  when unique_violation then
    raise exception 'Core No. % is already used by another roll.', v_no;
end;
$$;

create or replace function public.void_send_to_yards(p_roll_id uuid, p_reason text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_roll yards_rolls%rowtype;
  v_txn inventory_transactions%rowtype;
  v_received yards_transactions%rowtype;
begin
  if not public.is_admin() then raise exception 'Only ADMIN can void records'; end if;

  select * into v_roll from yards_rolls where id = p_roll_id for update;
  if not found then raise exception 'Yards roll not found'; end if;
  if v_roll.source_transaction_id is null then raise exception 'This yards roll was not sent from main stock'; end if;

  select * into v_txn from inventory_transactions where id = v_roll.source_transaction_id;
  if not found then raise exception 'Original Send to Yards entry not found'; end if;
  if exists (select 1 from inventory_transactions where reversal_of = v_txn.id) then raise exception 'Already voided'; end if;

  if exists (select 1 from yards_transactions where roll_id = p_roll_id and transaction_type <> 'RECEIVED') then
    raise exception 'Yards have already been withdrawn from this roll — it can''t be put back into main stock';
  end if;

  insert into inventory_transactions (transaction_type, item_id, quantity, reference_type, reference_id, reversal_of, remarks, created_by)
  values ('REVERSAL', v_txn.item_id, -v_txn.quantity, 'yards_rolls', p_roll_id, v_txn.id, p_reason, auth.uid());

  for v_received in select * from yards_transactions where roll_id = p_roll_id and transaction_type = 'RECEIVED' loop
    insert into yards_transactions (roll_id, transaction_type, quantity, reversal_of, remarks, created_by)
    values (p_roll_id, 'REVERSAL', -v_received.quantity, v_received.id, p_reason, auth.uid());
  end loop;

  update yards_rolls set active = false where id = p_roll_id;

  insert into audit_logs (user_id, action, entity_type, entity_id, new_data)
  values (auth.uid(), 'VOID', 'yards_rolls', p_roll_id, jsonb_build_object('reason', p_reason));
end;
$$;

revoke execute on function public.send_roll_to_yards, public.void_send_to_yards from anon, public;
grant execute on function public.send_roll_to_yards, public.void_send_to_yards to authenticated;
