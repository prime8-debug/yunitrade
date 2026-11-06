-- =====================================================================
-- Year-end clear + automatic withdrawals from Sales Orders.
--
-- Year-end clear (ADMIN): nothing is deleted. One closing row per item
-- brings everything dated before the start date to 0, so every place that
-- sums the ledger for on-hand keeps working unchanged. Old records stay in
-- the database; the app hides them, Stocks totals count from the start
-- date, and they can't be voided. Undo removes the closing rows.
--
-- Automatic withdrawals: the auto-withdrawals Edge Function posts through
-- post_sales_order_withdrawal using the service role, so created_by is
-- null and the remark says it was automatic. Its settings live in
-- app_settings (auto_withdrawal_enabled, auto_withdrawal_start).
--
-- Safe to run more than once.
-- =====================================================================

create table if not exists public.stock_years (
  id            uuid primary key default gen_random_uuid(),
  start_date    date not null unique,
  items_closed  integer not null default 0,
  closed_by     uuid references public.profiles (id) default auth.uid(),
  closed_at     timestamptz not null default now()
);
-- The automation start date before this clear, so Undo can put it back.
alter table public.stock_years add column if not exists previous_auto_start text;

alter table public.stock_years enable row level security;
drop policy if exists "stock_years: active users read" on public.stock_years;
create policy "stock_years: active users read" on public.stock_years
  for select to authenticated using (public.is_active_user());

-- A record is in the current year if it's dated on or after the start date,
-- or was entered after the clear (e.g. a Beginning count dated Nov 30).
create or replace function public.in_stock_year(p_date date, p_created_at timestamptz)
returns boolean
language sql stable set search_path = public
as $$
  select coalesce(
    (select p_date >= y.start_date or p_created_at > y.closed_at
     from stock_years y order by y.start_date desc limit 1),
    true);
$$;

-- ---------------------------------------------------------------------
-- on_hand is still the sum of the whole ledger (the closing rows make it
-- right); Beginning, Received and Withdrawn now count the current year.
-- ---------------------------------------------------------------------
create or replace view public.current_stock
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
  coalesce(sum(t.quantity) filter (where t.in_year and (t.transaction_type = 'BEGINNING' or t.reference_type = 'beginning_adjustments')), 0) as beginning,
  coalesce(sum(t.quantity) filter (where t.in_year and t.transaction_type in ('RECEIVED', 'SPLIT_CHILD')), 0) as received,
  coalesce(-sum(t.quantity) filter (where t.in_year and t.transaction_type in ('WITHDRAWAL', 'SPLIT_PARENT', 'TO_YARDS')), 0) as withdrawn,
  max(t.created_at) as last_movement_at
from public.items i
left join (
  select tx.*, (y.start_date is null or tx.transaction_date >= y.start_date or tx.created_at > y.closed_at) as in_year
  from public.inventory_transactions tx
  left join (select start_date, closed_at from public.stock_years order by start_date desc limit 1) y on true
) t on t.item_id = i.id
group by i.id;

-- Same as 0009, except the current Beginning balance is this year's only.
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
  where item_id = p_item_id and (transaction_type = 'BEGINNING' or reference_type = 'beginning_adjustments')
    and public.in_stock_year(transaction_date, created_at);

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

-- Every kind of void posts a REVERSAL, so this one check covers them all.
create or replace function public.block_closed_year_void()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.reversal_of is not null and exists (
    select 1 from inventory_transactions t
    where t.id = new.reversal_of and not public.in_stock_year(t.transaction_date, t.created_at)
  ) then
    raise exception 'This entry belongs to a closed year and can''t be voided';
  end if;
  return new;
end;
$$;

drop trigger if exists block_closed_year_void on public.inventory_transactions;
create trigger block_closed_year_void before insert on public.inventory_transactions
  for each row execute function public.block_closed_year_void();

create or replace function public.start_stock_year(p_start date)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_year_id uuid := gen_random_uuid();
  v_items integer;
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

  lock table inventory_transactions in share row exclusive mode;

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

  select value into v_previous_start from app_settings where key = 'auto_withdrawal_start';
  insert into stock_years (id, start_date, items_closed, previous_auto_start)
  values (v_year_id, p_start, v_items, v_previous_start);

  -- Automation follows the new year, so orders left over from the old one can't post into it.
  insert into app_settings (key, value, updated_at) values ('auto_withdrawal_start', p_start::text, now())
  on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at;

  insert into audit_logs (user_id, action, entity_type, entity_id, new_data)
  values (auth.uid(), 'START_YEAR', 'stock_years', v_year_id, jsonb_build_object('start_date', p_start, 'items_closed', v_items));

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

-- ---------------------------------------------------------------------
-- Posts one sales order. Used by both the job and the Apply Withdrawals
-- tab, so the two can't withdraw the same order: the item lock makes the
-- "already withdrawn" check and the insert happen one order at a time.
-- Only signed-in users (checked below) and the service role can call it.
-- ---------------------------------------------------------------------
create or replace function public.post_sales_order_withdrawal(
  p_item_id uuid, p_quantity numeric, p_entry_date date, p_job_order text,
  p_customer text default null, p_remarks text default null,
  p_width numeric default null, p_width_unit text default null, p_length numeric default null, p_length_unit text default null,
  p_description text default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_on_hand numeric;
begin
  if auth.uid() is not null and not public.is_active_user() then raise exception 'Not authorized'; end if;
  if p_job_order is null or btrim(p_job_order) = '' then raise exception 'Job order is required'; end if;

  perform 1 from items where id = p_item_id for update;
  if not found then raise exception 'Item not found'; end if;

  if exists (
    select 1 from withdrawals
    where item_id = p_item_id and voided_at is null and upper(btrim(withdrawal_no)) = upper(btrim(p_job_order))
  ) then
    raise exception 'Already withdrawn: %', p_job_order;
  end if;

  select coalesce(sum(quantity), 0) into v_on_hand from inventory_transactions where item_id = p_item_id;
  if p_quantity > v_on_hand then
    raise exception 'Insufficient stock: % on hand, % requested', v_on_hand, p_quantity;
  end if;

  insert into withdrawals (entry_date, item_id, quantity, withdrawal_no, customer, remarks, width, width_unit, length, length_unit, description, created_by)
  values (p_entry_date, p_item_id, p_quantity, p_job_order, p_customer, p_remarks, p_width, p_width_unit, p_length, p_length_unit, p_description, auth.uid())
  returning id into v_id;

  insert into inventory_transactions (transaction_date, transaction_type, item_id, quantity, reference_type, reference_id, remarks, created_by)
  values (p_entry_date, 'WITHDRAWAL', p_item_id, -p_quantity, 'withdrawals', v_id, p_remarks, auth.uid());

  insert into audit_logs (user_id, action, entity_type, entity_id, new_data)
  select auth.uid(), 'CREATE', 'withdrawals', v_id, to_jsonb(w) from withdrawals w where w.id = v_id;

  return v_id;
end;
$$;

-- One row per run of the job, so a stopped or failing job is visible in the app.
create table if not exists public.auto_withdrawal_runs (
  id          bigint generated always as identity primary key,
  ran_at      timestamptz not null default now(),
  status      text not null check (status in ('off', 'waiting', 'ok', 'error')),
  posted      integer not null default 0,
  held        integer not null default 0,
  failed      integer not null default 0,
  message     text
);
create index if not exists auto_withdrawal_runs_ran_idx on public.auto_withdrawal_runs (ran_at desc);

alter table public.auto_withdrawal_runs enable row level security;
drop policy if exists "auto_withdrawal_runs: admin read" on public.auto_withdrawal_runs;
create policy "auto_withdrawal_runs: admin read" on public.auto_withdrawal_runs
  for select to authenticated using (public.is_admin());

revoke execute on function public.start_stock_year, public.undo_stock_year, public.post_sales_order_withdrawal from anon, public;
grant execute on function public.start_stock_year, public.undo_stock_year, public.post_sales_order_withdrawal to authenticated;
grant execute on function public.post_sales_order_withdrawal to service_role;
