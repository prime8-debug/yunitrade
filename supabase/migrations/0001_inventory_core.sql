-- =====================================================================
-- YUNITRADE Inventory — Phase 1/2 core schema
-- profiles, items, inventory ledger, beginning / receipts / withdrawals,
-- audit log, current_stock view, posting RPCs, RLS.
--
-- Run once in Supabase Dashboard → SQL Editor (or `supabase db push`).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Profiles (one row per auth user)
-- ---------------------------------------------------------------------
create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  email         text,
  display_name  text,
  role          text not null default 'USER' check (role in ('USER', 'ADMIN')),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Role helpers used by RLS and RPCs
create or replace function public.is_active_user()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active);
$$;

create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active and role = 'ADMIN');
$$;

-- ---------------------------------------------------------------------
-- Items master
-- ---------------------------------------------------------------------
create table public.items (
  id           uuid primary key default gen_random_uuid(),
  item_code    text not null,
  description  text not null default '',
  width        numeric,
  width_unit   text,
  length       numeric,
  length_unit  text,
  category     text,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- OPEN QUESTION #1/#2: is item_code unique on its own, or per size?
-- Assumed unique (case-insensitive) until confirmed.
create unique index items_item_code_key on public.items (upper(item_code));
create index items_description_idx on public.items (description);

-- ---------------------------------------------------------------------
-- Inventory ledger — the single source of truth for stock.
-- quantity is SIGNED: + adds stock, - removes stock.
-- Rows are never updated or deleted; mistakes are reversed.
-- ---------------------------------------------------------------------
create table public.inventory_transactions (
  id                uuid primary key default gen_random_uuid(),
  transaction_date  date not null default current_date,
  transaction_type  text not null check (transaction_type in (
                      'BEGINNING', 'RECEIVED', 'WITHDRAWAL',
                      'SPLIT_PARENT', 'SPLIT_CHILD',
                      'ADJUSTMENT', 'DISPOSAL', 'RETURN', 'REVERSAL')),
  item_id           uuid not null references public.items (id),
  quantity          numeric not null check (quantity <> 0),
  reference_type    text,           -- 'beginning_inventory' | 'receipts' | 'withdrawals' | ...
  reference_id      uuid,
  reversal_of       uuid references public.inventory_transactions (id),
  remarks           text,
  created_by        uuid references public.profiles (id) default auth.uid(),
  created_at        timestamptz not null default now()
);

create index inventory_transactions_item_idx on public.inventory_transactions (item_id, transaction_date);
create index inventory_transactions_reference_idx on public.inventory_transactions (reference_id);
create unique index inventory_transactions_one_reversal on public.inventory_transactions (reversal_of) where reversal_of is not null;

-- ---------------------------------------------------------------------
-- Source documents (what the user entered). Each posts a ledger row.
-- ---------------------------------------------------------------------
create table public.beginning_inventory (
  id           uuid primary key default gen_random_uuid(),
  entry_date   date not null default current_date,
  item_id      uuid not null references public.items (id),
  quantity     numeric not null check (quantity > 0),
  notes        text,
  voided_at    timestamptz,
  voided_by    uuid references public.profiles (id),
  created_by   uuid references public.profiles (id) default auth.uid(),
  created_at   timestamptz not null default now()
);

create table public.receipts (
  id           uuid primary key default gen_random_uuid(),
  entry_date   date not null default current_date,
  item_id      uuid not null references public.items (id),
  quantity     numeric not null check (quantity > 0),
  mrr_no       text,               -- OPEN QUESTION #15: mandatory?
  supplier     text,
  reference    text,
  remarks      text,
  voided_at    timestamptz,
  voided_by    uuid references public.profiles (id),
  created_by   uuid references public.profiles (id) default auth.uid(),
  created_at   timestamptz not null default now()
);

create table public.withdrawals (
  id             uuid primary key default gen_random_uuid(),
  entry_date     date not null default current_date,
  item_id        uuid not null references public.items (id),
  quantity       numeric not null check (quantity > 0),
  withdrawal_no  text,             -- OPEN QUESTION #11: format / uniqueness?
  customer       text,
  remarks        text,
  voided_at      timestamptz,
  voided_by      uuid references public.profiles (id),
  created_by     uuid references public.profiles (id) default auth.uid(),
  created_at     timestamptz not null default now()
);

create index receipts_mrr_idx on public.receipts (mrr_no);
create index withdrawals_no_idx on public.withdrawals (withdrawal_no);
create index withdrawals_customer_idx on public.withdrawals (customer);

-- ---------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------
create table public.audit_logs (
  id           bigint generated always as identity primary key,
  user_id      uuid references public.profiles (id) default auth.uid(),
  action       text not null,
  entity_type  text not null,
  entity_id    uuid,
  old_data     jsonb,
  new_data     jsonb,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Current stock — computed ONLY here. Clients never add up stock.
-- ---------------------------------------------------------------------
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
  i.category,
  i.active,
  coalesce(sum(t.quantity), 0)                                              as on_hand,
  coalesce(sum(t.quantity) filter (where t.transaction_type = 'BEGINNING'), 0) as beginning,
  coalesce(sum(t.quantity) filter (where t.transaction_type = 'RECEIVED'), 0)  as received,
  coalesce(-sum(t.quantity) filter (where t.transaction_type = 'WITHDRAWAL'), 0) as withdrawn,
  max(t.created_at)                                                         as last_movement_at
from public.items i
left join public.inventory_transactions t on t.item_id = i.id
group by i.id;

-- ---------------------------------------------------------------------
-- Posting RPCs — each runs as one atomic transaction.
-- ---------------------------------------------------------------------
create or replace function public.post_beginning(
  p_item_id uuid, p_quantity numeric, p_entry_date date default current_date, p_notes text default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  if not public.is_active_user() then raise exception 'Not authorized'; end if;

  insert into beginning_inventory (entry_date, item_id, quantity, notes, created_by)
  values (p_entry_date, p_item_id, p_quantity, p_notes, auth.uid())
  returning id into v_id;

  insert into inventory_transactions (transaction_date, transaction_type, item_id, quantity, reference_type, reference_id, remarks, created_by)
  values (p_entry_date, 'BEGINNING', p_item_id, p_quantity, 'beginning_inventory', v_id, p_notes, auth.uid());

  insert into audit_logs (user_id, action, entity_type, entity_id, new_data)
  select auth.uid(), 'CREATE', 'beginning_inventory', v_id, to_jsonb(b) from beginning_inventory b where b.id = v_id;

  return v_id;
end;
$$;

create or replace function public.post_receipt(
  p_item_id uuid, p_quantity numeric, p_entry_date date default current_date,
  p_mrr_no text default null, p_supplier text default null, p_reference text default null, p_remarks text default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  if not public.is_active_user() then raise exception 'Not authorized'; end if;

  insert into receipts (entry_date, item_id, quantity, mrr_no, supplier, reference, remarks, created_by)
  values (p_entry_date, p_item_id, p_quantity, p_mrr_no, p_supplier, p_reference, p_remarks, auth.uid())
  returning id into v_id;

  insert into inventory_transactions (transaction_date, transaction_type, item_id, quantity, reference_type, reference_id, remarks, created_by)
  values (p_entry_date, 'RECEIVED', p_item_id, p_quantity, 'receipts', v_id, p_remarks, auth.uid());

  insert into audit_logs (user_id, action, entity_type, entity_id, new_data)
  select auth.uid(), 'CREATE', 'receipts', v_id, to_jsonb(r) from receipts r where r.id = v_id;

  return v_id;
end;
$$;

create or replace function public.post_withdrawal(
  p_item_id uuid, p_quantity numeric, p_entry_date date default current_date,
  p_withdrawal_no text default null, p_customer text default null, p_remarks text default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_on_hand numeric;
begin
  if not public.is_active_user() then raise exception 'Not authorized'; end if;

  -- Lock the item so two devices can't withdraw the same last units at once.
  perform 1 from items where id = p_item_id for update;
  if not found then raise exception 'Item not found'; end if;

  select coalesce(sum(quantity), 0) into v_on_hand from inventory_transactions where item_id = p_item_id;

  -- OPEN QUESTION #7: negative stock assumed NOT allowed.
  if p_quantity > v_on_hand then
    raise exception 'Insufficient stock: % on hand, % requested', v_on_hand, p_quantity;
  end if;

  insert into withdrawals (entry_date, item_id, quantity, withdrawal_no, customer, remarks, created_by)
  values (p_entry_date, p_item_id, p_quantity, p_withdrawal_no, p_customer, p_remarks, auth.uid())
  returning id into v_id;

  insert into inventory_transactions (transaction_date, transaction_type, item_id, quantity, reference_type, reference_id, remarks, created_by)
  values (p_entry_date, 'WITHDRAWAL', p_item_id, -p_quantity, 'withdrawals', v_id, p_remarks, auth.uid());

  insert into audit_logs (user_id, action, entity_type, entity_id, new_data)
  select auth.uid(), 'CREATE', 'withdrawals', v_id, to_jsonb(w) from withdrawals w where w.id = v_id;

  return v_id;
end;
$$;

-- ADMIN-only: void a beginning / receipt / withdrawal by posting a reversal.
create or replace function public.void_entry(p_reference_type text, p_reference_id uuid, p_reason text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_txn inventory_transactions%rowtype;
  v_on_hand numeric;
begin
  if not public.is_admin() then raise exception 'Only ADMIN can void records'; end if;
  if p_reference_type not in ('beginning_inventory', 'receipts', 'withdrawals') then
    raise exception 'Unsupported reference type %', p_reference_type;
  end if;

  select * into v_txn from inventory_transactions
  where reference_type = p_reference_type and reference_id = p_reference_id and reversal_of is null;
  if not found then raise exception 'Ledger entry not found'; end if;

  perform 1 from items where id = v_txn.item_id for update;

  -- Voiding an IN movement must not push stock negative.
  if v_txn.quantity > 0 then
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

revoke execute on function public.post_beginning, public.post_receipt, public.post_withdrawal, public.void_entry from anon, public;
grant execute on function public.post_beginning, public.post_receipt, public.post_withdrawal, public.void_entry to authenticated;

-- ---------------------------------------------------------------------
-- Row Level Security
-- Reads: any active user. Writes to ledger/documents: only through RPCs.
-- ---------------------------------------------------------------------
alter table public.profiles               enable row level security;
alter table public.items                  enable row level security;
alter table public.inventory_transactions enable row level security;
alter table public.beginning_inventory    enable row level security;
alter table public.receipts               enable row level security;
alter table public.withdrawals            enable row level security;
alter table public.audit_logs             enable row level security;

create policy "profiles: read own or admin" on public.profiles
  for select to authenticated using (id = auth.uid() or public.is_admin());
create policy "profiles: admin update" on public.profiles
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "items: active users read" on public.items
  for select to authenticated using (public.is_active_user());
create policy "items: admin insert" on public.items
  for insert to authenticated with check (public.is_admin());
create policy "items: admin update" on public.items
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "ledger: active users read" on public.inventory_transactions
  for select to authenticated using (public.is_active_user());
create policy "beginning: active users read" on public.beginning_inventory
  for select to authenticated using (public.is_active_user());
create policy "receipts: active users read" on public.receipts
  for select to authenticated using (public.is_active_user());
create policy "withdrawals: active users read" on public.withdrawals
  for select to authenticated using (public.is_active_user());

create policy "audit: admin read" on public.audit_logs
  for select to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------
-- Realtime: push ledger + document changes to desktop and mobile.
-- ---------------------------------------------------------------------
alter publication supabase_realtime add table
  public.inventory_transactions, public.items,
  public.beginning_inventory, public.receipts, public.withdrawals;
