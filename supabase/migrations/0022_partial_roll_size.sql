-- =====================================================================
-- Partial rolls get their own Width and Length (units come from the
-- item's W-UM / L-UM). Width defaults to the item's width in the app.
--
--   - partial_rolls.width, partial_rolls.length
--   - create_partial_roll / update_partial_roll take p_width, p_length
--   - partial_stock_summary shows width and length
--
-- Run after 0021. Old function signatures are dropped first so PostgREST
-- doesn't see two overloads. Safe to run more than once.
-- =====================================================================
alter table public.partial_rolls add column if not exists width numeric;
alter table public.partial_rolls add column if not exists length numeric;

drop function if exists public.create_partial_roll(uuid, numeric, text, date, text);
drop function if exists public.update_partial_roll(uuid, text, uuid, numeric);

create or replace function public.create_partial_roll(
  p_item_id uuid, p_quantity numeric, p_roll_no text default null,
  p_entry_date date default current_date, p_remarks text default null,
  p_width numeric default null, p_length numeric default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  if not public.is_active_user() then raise exception 'Not authorized'; end if;
  if p_quantity <= 0 then raise exception 'Quantity must be greater than 0'; end if;
  if p_width is not null and p_width <= 0 then raise exception 'Width must be greater than 0'; end if;
  if p_length is not null and p_length <= 0 then raise exception 'Length must be greater than 0'; end if;

  insert into partial_rolls (item_id, roll_no, width, length, created_by)
  values (p_item_id, nullif(trim(p_roll_no), ''), p_width, p_length, auth.uid())
  returning id into v_id;

  insert into partial_roll_transactions (partial_roll_id, transaction_date, transaction_type, quantity, remarks, created_by)
  values (v_id, p_entry_date, 'CREATED', p_quantity, p_remarks, auth.uid());

  insert into audit_logs (user_id, action, entity_type, entity_id, new_data)
  values (auth.uid(), 'CREATE', 'partial_rolls', v_id,
          jsonb_build_object('item_id', p_item_id, 'roll_no', p_roll_no, 'quantity', p_quantity, 'width', p_width, 'length', p_length));

  return v_id;
exception
  when unique_violation then
    raise exception 'Roll No. % is already used by another partial roll.', nullif(trim(p_roll_no), '');
end;
$$;

create or replace function public.update_partial_roll(
  p_roll_id uuid, p_roll_no text, p_item_id uuid, p_quantity numeric,
  p_width numeric default null, p_length numeric default null
) returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_roll partial_rolls%rowtype;
  v_created_id uuid;
  v_old_qty numeric;
  v_balance numeric;
  v_new_no text := nullif(trim(p_roll_no), '');
begin
  if not public.is_admin() then raise exception 'Only ADMIN can edit a partial roll'; end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'Quantity must be greater than 0'; end if;
  if p_width is not null and p_width <= 0 then raise exception 'Width must be greater than 0'; end if;
  if p_length is not null and p_length <= 0 then raise exception 'Length must be greater than 0'; end if;

  select * into v_roll from partial_rolls where id = p_roll_id for update;
  if not found then raise exception 'Partial roll not found'; end if;
  if not exists (select 1 from items where id = p_item_id) then raise exception 'Item not found'; end if;

  select id, quantity into v_created_id, v_old_qty
  from partial_roll_transactions
  where partial_roll_id = p_roll_id and transaction_type = 'CREATED' and reversal_of is null
  order by created_at limit 1;
  if v_created_id is null then raise exception 'This partial roll has no starting entry to edit'; end if;

  select coalesce(sum(quantity), 0) into v_balance from partial_roll_transactions where partial_roll_id = p_roll_id;
  if v_balance - v_old_qty + p_quantity < 0 then
    raise exception 'Quantity cannot be lower than what was already withdrawn (balance would be %)',
      v_balance - v_old_qty + p_quantity;
  end if;

  update partial_rolls set roll_no = v_new_no, item_id = p_item_id, width = p_width, length = p_length where id = p_roll_id;
  update partial_roll_transactions set quantity = p_quantity where id = v_created_id;

  insert into audit_logs (user_id, action, entity_type, entity_id, old_data, new_data)
  values (auth.uid(), 'UPDATE', 'partial_rolls', p_roll_id,
          jsonb_build_object('roll_no', v_roll.roll_no, 'item_id', v_roll.item_id, 'quantity', v_old_qty, 'width', v_roll.width, 'length', v_roll.length),
          jsonb_build_object('roll_no', v_new_no, 'item_id', p_item_id, 'quantity', p_quantity, 'width', p_width, 'length', p_length));
exception
  when unique_violation then
    raise exception 'Roll No. % is already used by another partial roll.', v_new_no;
end;
$$;

revoke execute on function public.create_partial_roll, public.update_partial_roll from anon, public;
grant execute on function public.create_partial_roll, public.update_partial_roll to authenticated;

-- New columns go at the end (create or replace view can only add columns there).
create or replace view public.partial_stock_summary
with (security_invoker = true)
as
select
  r.id as roll_id,
  r.roll_no,
  i.item_code,
  i.description,
  i.uom,
  r.active,
  coalesce(sum(t.quantity) filter (where coalesce(o.transaction_type, t.transaction_type) = 'CREATED'), 0) as total_received,
  coalesce(-sum(t.quantity) filter (where coalesce(o.transaction_type, t.transaction_type) = 'WITHDRAWAL'), 0) as total_withdrawn,
  coalesce(sum(t.quantity), 0) as available_balance,
  r.width,
  i.width_unit,
  r.length,
  i.length_unit
from public.partial_rolls r
join public.items i on i.id = r.item_id
left join public.partial_roll_transactions t on t.partial_roll_id = r.id
left join public.partial_roll_transactions o on o.id = t.reversal_of
group by r.id, i.id;
