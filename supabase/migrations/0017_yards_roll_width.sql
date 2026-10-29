-- =====================================================================
-- Yards rolls get their own Width (a roll can be a different width from
-- the item's catalog width). When left blank, the item's width is used.
--
--   - yards_rolls.width (numeric, unit still comes from the item's W-UM)
--   - create_yards_roll / update_yards_roll take p_width
--   - yards_stock_summary shows coalesce(roll width, item width)
--
-- The old function signatures are dropped first so PostgREST doesn't see
-- two overloads of the same name. Run 0016 first (or not — this file also
-- creates update_yards_roll). Safe to run more than once.
-- =====================================================================
alter table public.yards_rolls add column if not exists width numeric;

drop function if exists public.create_yards_roll(uuid, numeric, text, date, text);
drop function if exists public.update_yards_roll(uuid, text, uuid, numeric);

create or replace function public.create_yards_roll(
  p_item_id uuid, p_received_yards numeric, p_roll_no text default null,
  p_entry_date date default current_date, p_remarks text default null,
  p_width numeric default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  if not public.is_active_user() then raise exception 'Not authorized'; end if;
  if p_received_yards <= 0 then raise exception 'Received yards must be greater than 0'; end if;
  if p_width is not null and p_width <= 0 then raise exception 'Width must be greater than 0'; end if;

  insert into yards_rolls (item_id, roll_no, width, created_by)
  values (p_item_id, nullif(trim(p_roll_no), ''), p_width, auth.uid())
  returning id into v_id;

  insert into yards_transactions (roll_id, transaction_date, transaction_type, quantity, remarks, created_by)
  values (v_id, p_entry_date, 'RECEIVED', p_received_yards, p_remarks, auth.uid());

  insert into audit_logs (user_id, action, entity_type, entity_id, new_data)
  values (auth.uid(), 'CREATE', 'yards_rolls', v_id,
          jsonb_build_object('item_id', p_item_id, 'roll_no', p_roll_no, 'received_yards', p_received_yards, 'width', p_width));

  return v_id;
exception
  when unique_violation then
    raise exception 'Core No. % is already used by another roll.', nullif(trim(p_roll_no), '');
end;
$$;

create or replace function public.update_yards_roll(
  p_roll_id uuid, p_roll_no text, p_item_id uuid, p_received_yards numeric,
  p_width numeric default null
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
  if p_width is not null and p_width <= 0 then raise exception 'Width must be greater than 0'; end if;

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

  update yards_rolls set roll_no = v_new_no, item_id = p_item_id, width = p_width where id = p_roll_id;
  update yards_transactions set quantity = p_received_yards where id = v_received_id;

  insert into audit_logs (user_id, action, entity_type, entity_id, old_data, new_data)
  values (auth.uid(), 'UPDATE', 'yards_rolls', p_roll_id,
          jsonb_build_object('roll_no', v_roll.roll_no, 'item_id', v_roll.item_id, 'received_yards', v_old_received, 'width', v_roll.width),
          jsonb_build_object('roll_no', v_new_no, 'item_id', p_item_id, 'received_yards', p_received_yards, 'width', p_width));
exception
  when unique_violation then
    raise exception 'Core No. % is already used by another roll.', v_new_no;
end;
$$;

revoke execute on function public.create_yards_roll, public.update_yards_roll from anon, public;
grant execute on function public.create_yards_roll, public.update_yards_roll to authenticated;

create or replace view public.yards_stock_summary
with (security_invoker = true)
as
select
  r.id as roll_id,
  r.roll_no as core_no,
  i.item_code,
  i.description,
  coalesce(r.width, i.width) as width,
  i.width_unit,
  r.active,
  coalesce(sum(t.quantity) filter (where coalesce(o.transaction_type, t.transaction_type) = 'RECEIVED'), 0) as total_received,
  coalesce(-sum(t.quantity) filter (where coalesce(o.transaction_type, t.transaction_type) = 'WITHDRAWAL'), 0) as total_withdrawn,
  coalesce(sum(t.quantity), 0) as available_balance
from public.yards_rolls r
join public.items i on i.id = r.item_id
left join public.yards_transactions t on t.roll_id = r.id
left join public.yards_transactions o on o.id = t.reversal_of
group by r.id, i.id;
