-- =====================================================================
-- The year-end clear now also clears Yards and Partial rolls.
--
-- Rolls stay active with their Core No. / Roll No., item and width; only
-- their data is cleared. Movements dated before the new date are marked
-- with stock_year_id and one closing row brings the balance to 0, so
-- every place that sums a roll keeps working. Totals and the latest
-- withdrawal only look at unmarked rows. Nothing is deleted, and Undo
-- removes the closing row and the marks.
--
-- The new count goes in through Edit: update_yards_roll and
-- update_partial_roll add a new starting entry for a cleared roll.
--
-- Replaces the functions in 0024, so if 0024 is ever run again, run this
-- after it. Requires 0024. Safe to run more than once, including after
-- the first version of this file, which made cleared rolls inactive.
-- =====================================================================

alter table public.stock_years add column if not exists rolls_closed integer not null default 0;

alter table public.yards_transactions add column if not exists stock_year_id uuid;
alter table public.partial_roll_transactions add column if not exists stock_year_id uuid;

-- The first version of this file hid cleared rolls: bring them back.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'yards_rolls' and column_name = 'closed_by_year') then
    update yards_transactions t set stock_year_id = r.closed_by_year
    from yards_rolls r
    where r.id = t.roll_id and r.closed_by_year is not null and t.stock_year_id is null;
    update yards_rolls r set active = true
    where r.closed_by_year is not null
      and not exists (select 1 from yards_rolls n where n.active and n.roll_no = r.roll_no);
    alter table yards_rolls drop column closed_by_year;

    update partial_roll_transactions t set stock_year_id = r.closed_by_year
    from partial_rolls r
    where r.id = t.partial_roll_id and r.closed_by_year is not null and t.stock_year_id is null;
    update partial_rolls r set active = true
    where r.closed_by_year is not null
      and not exists (select 1 from partial_rolls n where n.active and n.roll_no = r.roll_no);
    alter table partial_rolls drop column closed_by_year;
  end if;
end;
$$;

create or replace function public.start_stock_year(p_start date)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_year_id uuid := gen_random_uuid();
  v_items integer;
  v_rolls integer;
  v_partial_rolls integer;
  v_previous_start text;
begin
  if not public.is_admin() then raise exception 'Only ADMIN can clear the year'; end if;
  if p_start is null then raise exception 'Choose a start date'; end if;
  -- Clearing sets stock to 0, so don't allow it weeks ahead by mistake.
  if p_start > current_date + 1 then
    raise exception 'Too early: this can be done from % onward', p_start - 1;
  end if;
  if exists (select 1 from stock_years where start_date >= p_start) then
    raise exception 'The start date must be after the current year''s start date';
  end if;

  lock table inventory_transactions, yards_transactions, partial_roll_transactions in share row exclusive mode;

  -- A void is dated the day it was made, so it goes with the row it reversed.
  with closing as (
    select t.item_id, -sum(t.quantity) as quantity
    from inventory_transactions t
    left join inventory_transactions original on original.id = t.reversal_of
    where t.transaction_date < p_start or original.transaction_date < p_start
    group by t.item_id
    having sum(t.quantity) <> 0
  )
  insert into inventory_transactions (transaction_date, transaction_type, item_id, quantity, reference_type, reference_id, remarks, created_by)
  select p_start - 1, 'ADJUSTMENT', item_id, quantity, 'stock_years', v_year_id, 'Year-end clear', auth.uid()
  from closing;
  get diagnostics v_items = row_count;

  update yards_transactions t set stock_year_id = v_year_id
  from yards_rolls r
  where r.id = t.roll_id and r.active and t.stock_year_id is null and t.transaction_date < p_start;
  select count(distinct roll_id) into v_rolls from yards_transactions where stock_year_id = v_year_id;

  insert into yards_transactions (roll_id, transaction_date, transaction_type, quantity, remarks, created_by, stock_year_id)
  select roll_id, p_start - 1, 'ADJUSTMENT', -sum(quantity), 'Year-end clear', auth.uid(), v_year_id
  from yards_transactions
  where stock_year_id = v_year_id
  group by roll_id
  having sum(quantity) <> 0;

  update partial_roll_transactions t set stock_year_id = v_year_id
  from partial_rolls r
  where r.id = t.partial_roll_id and r.active and t.stock_year_id is null and t.transaction_date < p_start;
  select count(distinct partial_roll_id) into v_partial_rolls from partial_roll_transactions where stock_year_id = v_year_id;

  insert into partial_roll_transactions (partial_roll_id, transaction_date, transaction_type, quantity, remarks, created_by, stock_year_id)
  select partial_roll_id, p_start - 1, 'ADJUSTMENT', -sum(quantity), 'Year-end clear', auth.uid(), v_year_id
  from partial_roll_transactions
  where stock_year_id = v_year_id
  group by partial_roll_id
  having sum(quantity) <> 0;

  select value into v_previous_start from app_settings where key = 'auto_withdrawal_start';
  insert into stock_years (id, start_date, items_closed, rolls_closed, previous_auto_start)
  values (v_year_id, p_start, v_items, v_rolls + v_partial_rolls, v_previous_start);

  -- Automation follows the new year, so orders left over from the old one can't post into it.
  insert into app_settings (key, value, updated_at) values ('auto_withdrawal_start', p_start::text, now())
  on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at;

  insert into audit_logs (user_id, action, entity_type, entity_id, new_data)
  values (auth.uid(), 'START_YEAR', 'stock_years', v_year_id,
          jsonb_build_object('start_date', p_start, 'items_closed', v_items, 'rolls_closed', v_rolls + v_partial_rolls));

  return v_items;
end;
$$;

create or replace function public.undo_stock_year()
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_year stock_years%rowtype;
begin
  if not public.is_admin() then raise exception 'Only ADMIN can undo the year-end clear'; end if;

  select * into v_year from stock_years order by start_date desc limit 1 for update;
  if not found then raise exception 'There is no year-end clear to undo'; end if;

  delete from inventory_transactions where reference_type = 'stock_years' and reference_id = v_year.id;

  delete from yards_transactions where stock_year_id = v_year.id and transaction_type = 'ADJUSTMENT';
  update yards_transactions set stock_year_id = null where stock_year_id = v_year.id;
  delete from partial_roll_transactions where stock_year_id = v_year.id and transaction_type = 'ADJUSTMENT';
  update partial_roll_transactions set stock_year_id = null where stock_year_id = v_year.id;

  delete from stock_years where id = v_year.id;

  if v_year.previous_auto_start is null then
    delete from app_settings where key = 'auto_withdrawal_start';
  else
    update app_settings set value = v_year.previous_auto_start, updated_at = now() where key = 'auto_withdrawal_start';
  end if;

  insert into audit_logs (user_id, action, entity_type, entity_id, old_data)
  values (auth.uid(), 'UNDO_START_YEAR', 'stock_years', v_year.id, to_jsonb(v_year));
end;
$$;

-- Same as 0017, except a cleared roll gets a new RECEIVED entry for its new count.
create or replace function public.update_yards_roll(
  p_roll_id uuid, p_roll_no text, p_item_id uuid, p_received_yards numeric,
  p_width numeric default null
) returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_roll yards_rolls%rowtype;
  v_received_id uuid;
  v_old_received numeric := 0;
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
  where roll_id = p_roll_id and transaction_type = 'RECEIVED' and reversal_of is null and stock_year_id is null
  order by created_at limit 1;
  v_old_received := coalesce(v_old_received, 0);

  select coalesce(sum(quantity), 0) into v_balance from yards_transactions where roll_id = p_roll_id;
  if v_balance - v_old_received + p_received_yards < 0 then
    raise exception 'Received yards cannot be lower than what was already withdrawn (balance would be %)',
      v_balance - v_old_received + p_received_yards;
  end if;

  update yards_rolls set roll_no = v_new_no, item_id = p_item_id, width = p_width where id = p_roll_id;
  if v_received_id is null then
    insert into yards_transactions (roll_id, transaction_type, quantity, remarks, created_by)
    values (p_roll_id, 'RECEIVED', p_received_yards, 'Year-end count', auth.uid());
  else
    update yards_transactions set quantity = p_received_yards where id = v_received_id;
  end if;

  insert into audit_logs (user_id, action, entity_type, entity_id, old_data, new_data)
  values (auth.uid(), 'UPDATE', 'yards_rolls', p_roll_id,
          jsonb_build_object('roll_no', v_roll.roll_no, 'item_id', v_roll.item_id, 'received_yards', v_old_received, 'width', v_roll.width),
          jsonb_build_object('roll_no', v_new_no, 'item_id', p_item_id, 'received_yards', p_received_yards, 'width', p_width));
exception
  when unique_violation then
    raise exception 'Core No. % is already used by another roll.', v_new_no;
end;
$$;

-- Same as 0022, except a cleared roll gets a new CREATED entry for its new count.
create or replace function public.update_partial_roll(
  p_roll_id uuid, p_roll_no text, p_item_id uuid, p_quantity numeric,
  p_width numeric default null, p_length numeric default null
) returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_roll partial_rolls%rowtype;
  v_created_id uuid;
  v_old_qty numeric := 0;
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
  where partial_roll_id = p_roll_id and transaction_type = 'CREATED' and reversal_of is null and stock_year_id is null
  order by created_at limit 1;
  v_old_qty := coalesce(v_old_qty, 0);

  select coalesce(sum(quantity), 0) into v_balance from partial_roll_transactions where partial_roll_id = p_roll_id;
  if v_balance - v_old_qty + p_quantity < 0 then
    raise exception 'Quantity cannot be lower than what was already withdrawn (balance would be %)',
      v_balance - v_old_qty + p_quantity;
  end if;

  update partial_rolls set roll_no = v_new_no, item_id = p_item_id, width = p_width, length = p_length where id = p_roll_id;
  if v_created_id is null then
    insert into partial_roll_transactions (partial_roll_id, transaction_type, quantity, remarks, created_by)
    values (p_roll_id, 'CREATED', p_quantity, 'Year-end count', auth.uid());
  else
    update partial_roll_transactions set quantity = p_quantity where id = v_created_id;
  end if;

  insert into audit_logs (user_id, action, entity_type, entity_id, old_data, new_data)
  values (auth.uid(), 'UPDATE', 'partial_rolls', p_roll_id,
          jsonb_build_object('roll_no', v_roll.roll_no, 'item_id', v_roll.item_id, 'quantity', v_old_qty, 'width', v_roll.width, 'length', v_roll.length),
          jsonb_build_object('roll_no', v_new_no, 'item_id', p_item_id, 'quantity', p_quantity, 'width', p_width, 'length', p_length));
exception
  when unique_violation then
    raise exception 'Roll No. % is already used by another partial roll.', v_new_no;
end;
$$;

-- Totals only count movements that haven't been cleared. Available Balance is
-- still the plain sum of everything, which the closing row brings to 0.
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
  coalesce(sum(t.quantity) filter (where t.stock_year_id is null and coalesce(o.transaction_type, t.transaction_type) = 'RECEIVED'), 0) as total_received,
  coalesce(-sum(t.quantity) filter (where t.stock_year_id is null and coalesce(o.transaction_type, t.transaction_type) = 'WITHDRAWAL'), 0) as total_withdrawn,
  coalesce(sum(t.quantity), 0) as available_balance
from public.yards_rolls r
join public.items i on i.id = r.item_id
left join public.yards_transactions t on t.roll_id = r.id
left join public.yards_transactions o on o.id = t.reversal_of
group by r.id, i.id;

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
  coalesce(sum(t.quantity) filter (where t.stock_year_id is null and coalesce(o.transaction_type, t.transaction_type) = 'CREATED'), 0) as total_received,
  coalesce(-sum(t.quantity) filter (where t.stock_year_id is null and coalesce(o.transaction_type, t.transaction_type) = 'WITHDRAWAL'), 0) as total_withdrawn,
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

create or replace view public.yards_latest_withdrawal
with (security_invoker = true)
as
select distinct on (t.roll_id)
  t.roll_id,
  -t.quantity as yards,
  t.withdrawal_no,
  t.customer,
  t.transaction_date
from public.yards_transactions t
where t.transaction_type = 'WITHDRAWAL'
  and t.stock_year_id is null
  and not exists (select 1 from public.yards_transactions r where r.reversal_of = t.id)
order by t.roll_id, t.transaction_date desc, t.created_at desc;
