-- =====================================================================
-- 3M Yards and Partial Rolls — new sub-ledgers for the Withdraw tab's
-- "Yards" and "Partial" sub-tabs (alongside the existing "Roll / PC"
-- withdrawal, which is unchanged).
--
-- Both are the same shape: a physical roll that starts with some quantity
-- and gets withdrawn from over time (§18/§19 of the concept plan). Each gets
-- its own append-only ledger, mirroring inventory_transactions, rather than
-- separate receive/withdraw tables like the original sheet.
--
-- IMPORTANT — open business questions (plan §44) not yet answered:
--   - Does consuming yards from a roll, or withdrawing from a partial roll,
--     reduce the item's main stock (ROLLS/PC) in `items`/`inventory_transactions`?
--   - Can a roll be split again, or reversed?
-- Until those are confirmed, these ledgers are deliberately kept SEPARATE
-- from the core inventory ledger — they do not touch `items` or
-- `inventory_transactions`, so they can't corrupt the already-working Stocks
-- calculation. Wire them together once the business rule is confirmed.
--
-- Safe to run more than once.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 3M Yards
-- ---------------------------------------------------------------------
create table if not exists public.yards_rolls (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid not null references public.items (id),
  roll_no     text,
  active      boolean not null default true,
  created_by  uuid references public.profiles (id) default auth.uid(),
  created_at  timestamptz not null default now()
);
create unique index if not exists yards_rolls_roll_no_key on public.yards_rolls (roll_no) where roll_no is not null;
create index if not exists yards_rolls_item_idx on public.yards_rolls (item_id);

create table if not exists public.yards_transactions (
  id                uuid primary key default gen_random_uuid(),
  roll_id           uuid not null references public.yards_rolls (id),
  transaction_date  date not null default current_date,
  transaction_type  text not null check (transaction_type in ('RECEIVED', 'WITHDRAWAL', 'ADJUSTMENT', 'REVERSAL')),
  quantity          numeric not null check (quantity <> 0), -- signed yards; + adds, - withdraws
  reversal_of       uuid references public.yards_transactions (id),
  customer          text,
  remarks           text,
  created_by        uuid references public.profiles (id) default auth.uid(),
  created_at        timestamptz not null default now()
);
create index if not exists yards_transactions_roll_idx on public.yards_transactions (roll_id, transaction_date);
create unique index if not exists yards_transactions_one_reversal on public.yards_transactions (reversal_of) where reversal_of is not null;

create or replace view public.yards_roll_stock
with (security_invoker = true)
as
select
  r.id as roll_id,
  r.roll_no,
  r.item_id,
  i.item_code,
  i.description,
  i.uom,
  r.active,
  coalesce(sum(t.quantity), 0) as remaining_yards,
  max(t.created_at) as last_movement_at
from public.yards_rolls r
join public.items i on i.id = r.item_id
left join public.yards_transactions t on t.roll_id = r.id
group by r.id, i.id;

create or replace function public.create_yards_roll(
  p_item_id uuid, p_received_yards numeric, p_roll_no text default null,
  p_entry_date date default current_date, p_remarks text default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  if not public.is_active_user() then raise exception 'Not authorized'; end if;
  if p_received_yards <= 0 then raise exception 'Received yards must be greater than 0'; end if;

  insert into yards_rolls (item_id, roll_no, created_by)
  values (p_item_id, nullif(trim(p_roll_no), ''), auth.uid())
  returning id into v_id;

  insert into yards_transactions (roll_id, transaction_date, transaction_type, quantity, remarks, created_by)
  values (v_id, p_entry_date, 'RECEIVED', p_received_yards, p_remarks, auth.uid());

  insert into audit_logs (user_id, action, entity_type, entity_id, new_data)
  values (auth.uid(), 'CREATE', 'yards_rolls', v_id, jsonb_build_object('item_id', p_item_id, 'roll_no', p_roll_no, 'received_yards', p_received_yards));

  return v_id;
end;
$$;

create or replace function public.withdraw_yards(
  p_roll_id uuid, p_quantity numeric, p_entry_date date default current_date,
  p_customer text default null, p_remarks text default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_remaining numeric;
begin
  if not public.is_active_user() then raise exception 'Not authorized'; end if;
  if p_quantity <= 0 then raise exception 'Quantity must be greater than 0'; end if;

  perform 1 from yards_rolls where id = p_roll_id for update;
  if not found then raise exception 'Roll not found'; end if;

  select coalesce(sum(quantity), 0) into v_remaining from yards_transactions where roll_id = p_roll_id;
  if p_quantity > v_remaining then
    raise exception 'Insufficient yards on this roll: % remaining, % requested', v_remaining, p_quantity;
  end if;

  insert into yards_transactions (roll_id, transaction_date, transaction_type, quantity, customer, remarks, created_by)
  values (p_roll_id, p_entry_date, 'WITHDRAWAL', -p_quantity, p_customer, p_remarks, auth.uid())
  returning id into v_id;

  insert into audit_logs (user_id, action, entity_type, entity_id, new_data)
  values (auth.uid(), 'CREATE', 'yards_transactions', v_id, jsonb_build_object('roll_id', p_roll_id, 'quantity', -p_quantity, 'customer', p_customer));

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Partial Rolls
-- ---------------------------------------------------------------------
create table if not exists public.partial_rolls (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid not null references public.items (id),
  roll_no     text,
  active      boolean not null default true,
  created_by  uuid references public.profiles (id) default auth.uid(),
  created_at  timestamptz not null default now()
);
create unique index if not exists partial_rolls_roll_no_key on public.partial_rolls (roll_no) where roll_no is not null;
create index if not exists partial_rolls_item_idx on public.partial_rolls (item_id);

create table if not exists public.partial_roll_transactions (
  id                uuid primary key default gen_random_uuid(),
  partial_roll_id   uuid not null references public.partial_rolls (id),
  transaction_date  date not null default current_date,
  transaction_type  text not null check (transaction_type in ('CREATED', 'WITHDRAWAL', 'ADJUSTMENT', 'REVERSAL')),
  quantity          numeric not null check (quantity <> 0), -- signed; + adds, - withdraws
  reversal_of       uuid references public.partial_roll_transactions (id),
  customer          text,
  remarks           text,
  created_by        uuid references public.profiles (id) default auth.uid(),
  created_at        timestamptz not null default now()
);
create index if not exists partial_roll_transactions_roll_idx on public.partial_roll_transactions (partial_roll_id, transaction_date);
create unique index if not exists partial_roll_transactions_one_reversal on public.partial_roll_transactions (reversal_of) where reversal_of is not null;

create or replace view public.partial_roll_stock
with (security_invoker = true)
as
select
  r.id as roll_id,
  r.roll_no,
  r.item_id,
  i.item_code,
  i.description,
  i.uom,
  r.active,
  coalesce(sum(t.quantity), 0) as remaining_quantity,
  max(t.created_at) as last_movement_at
from public.partial_rolls r
join public.items i on i.id = r.item_id
left join public.partial_roll_transactions t on t.partial_roll_id = r.id
group by r.id, i.id;

create or replace function public.create_partial_roll(
  p_item_id uuid, p_quantity numeric, p_roll_no text default null,
  p_entry_date date default current_date, p_remarks text default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  if not public.is_active_user() then raise exception 'Not authorized'; end if;
  if p_quantity <= 0 then raise exception 'Quantity must be greater than 0'; end if;

  insert into partial_rolls (item_id, roll_no, created_by)
  values (p_item_id, nullif(trim(p_roll_no), ''), auth.uid())
  returning id into v_id;

  insert into partial_roll_transactions (partial_roll_id, transaction_date, transaction_type, quantity, remarks, created_by)
  values (v_id, p_entry_date, 'CREATED', p_quantity, p_remarks, auth.uid());

  insert into audit_logs (user_id, action, entity_type, entity_id, new_data)
  values (auth.uid(), 'CREATE', 'partial_rolls', v_id, jsonb_build_object('item_id', p_item_id, 'roll_no', p_roll_no, 'quantity', p_quantity));

  return v_id;
end;
$$;

create or replace function public.withdraw_partial_roll(
  p_partial_roll_id uuid, p_quantity numeric, p_entry_date date default current_date,
  p_customer text default null, p_remarks text default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_remaining numeric;
begin
  if not public.is_active_user() then raise exception 'Not authorized'; end if;
  if p_quantity <= 0 then raise exception 'Quantity must be greater than 0'; end if;

  perform 1 from partial_rolls where id = p_partial_roll_id for update;
  if not found then raise exception 'Partial roll not found'; end if;

  select coalesce(sum(quantity), 0) into v_remaining from partial_roll_transactions where partial_roll_id = p_partial_roll_id;
  if p_quantity > v_remaining then
    raise exception 'Insufficient quantity on this partial roll: % remaining, % requested', v_remaining, p_quantity;
  end if;

  insert into partial_roll_transactions (partial_roll_id, transaction_date, transaction_type, quantity, customer, remarks, created_by)
  values (p_partial_roll_id, p_entry_date, 'WITHDRAWAL', -p_quantity, p_customer, p_remarks, auth.uid())
  returning id into v_id;

  insert into audit_logs (user_id, action, entity_type, entity_id, new_data)
  values (auth.uid(), 'CREATE', 'partial_roll_transactions', v_id, jsonb_build_object('partial_roll_id', p_partial_roll_id, 'quantity', -p_quantity, 'customer', p_customer));

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------
alter table public.yards_rolls                 enable row level security;
alter table public.yards_transactions          enable row level security;
alter table public.partial_rolls               enable row level security;
alter table public.partial_roll_transactions   enable row level security;

create policy "yards_rolls: active users read" on public.yards_rolls
  for select to authenticated using (public.is_active_user());
create policy "yards_transactions: active users read" on public.yards_transactions
  for select to authenticated using (public.is_active_user());
create policy "partial_rolls: active users read" on public.partial_rolls
  for select to authenticated using (public.is_active_user());
create policy "partial_roll_transactions: active users read" on public.partial_roll_transactions
  for select to authenticated using (public.is_active_user());

revoke execute on function public.create_yards_roll, public.withdraw_yards,
  public.create_partial_roll, public.withdraw_partial_roll from anon, public;
grant execute on function public.create_yards_roll, public.withdraw_yards,
  public.create_partial_roll, public.withdraw_partial_roll to authenticated;

alter publication supabase_realtime add table
  public.yards_rolls, public.yards_transactions,
  public.partial_rolls, public.partial_roll_transactions;
