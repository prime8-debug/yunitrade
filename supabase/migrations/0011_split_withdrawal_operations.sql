-- =====================================================================
-- Split + Withdraw operations
--
-- A physical warehouse operation such as:
--   1 x 48" x 50yd -> 2 x 24" x 50yd -> 1 customer + 1 stock
-- is posted atomically as one operation with three ledger movements:
--   SPLIT_PARENT  -1 source roll
--   SPLIT_CHILD   +N output rolls produced
--   WITHDRAWAL    -customer quantity
--
-- The ledger remains the source of truth. The operation tables provide the
-- audit/document layer that ties the physical transformation together.
-- =====================================================================

create table if not exists public.inventory_operations (
  id                    uuid primary key default gen_random_uuid(),
  operation_no          text not null unique,
  operation_type        text not null check (operation_type in ('SPLIT', 'SPLIT_WITHDRAWAL')),
  entry_date            date not null default current_date,
  source_item_id        uuid not null references public.items(id),
  output_item_id        uuid not null references public.items(id),
  source_quantity       numeric not null check (source_quantity > 0),
  produced_quantity     numeric not null check (produced_quantity > 0),
  customer_quantity     numeric not null check (customer_quantity >= 0),
  stock_quantity        numeric not null check (stock_quantity >= 0),
  customer              text,
  withdrawal_no         text,
  remarks               text,
  voided_at             timestamptz,
  voided_by             uuid references public.profiles(id),
  created_by            uuid references public.profiles(id) default auth.uid(),
  created_at            timestamptz not null default now(),
  check (source_item_id <> output_item_id),
  check (produced_quantity = customer_quantity + stock_quantity)
);

create index if not exists inventory_operations_date_idx
  on public.inventory_operations(entry_date desc, created_at desc);
create index if not exists inventory_operations_source_idx
  on public.inventory_operations(source_item_id);
create index if not exists inventory_operations_output_idx
  on public.inventory_operations(output_item_id);

create table if not exists public.inventory_operation_lines (
  id             uuid primary key default gen_random_uuid(),
  operation_id   uuid not null references public.inventory_operations(id) on delete cascade,
  line_type      text not null check (line_type in ('SOURCE', 'OUTPUT', 'CUSTOMER')),
  item_id        uuid not null references public.items(id),
  quantity       numeric not null check (quantity > 0),
  created_at     timestamptz not null default now()
);
create index if not exists inventory_operation_lines_operation_idx
  on public.inventory_operation_lines(operation_id);

alter table public.inventory_transactions
  add column if not exists operation_id uuid references public.inventory_operations(id);
create index if not exists inventory_transactions_operation_idx
  on public.inventory_transactions(operation_id);

-- Generate a human-readable operation number inside the same transaction.
create or replace function public.next_inventory_operation_no()
returns text
language plpgsql
security definer set search_path = public
as $$
declare
  v_no text;
begin
  v_no := 'SPL-' || to_char(current_date, 'YYYYMMDD') || '-' ||
          lpad((select count(*) + 1 from public.inventory_operations
                where entry_date = current_date)::text, 4, '0');
  -- The unique constraint is the final guard. If two sessions race, the
  -- posting RPC retries with a timestamp-based suffix below.
  return v_no;
end;
$$;

-- ---------------------------------------------------------------------
-- Atomic Split + Withdraw
-- ---------------------------------------------------------------------
create or replace function public.post_split_withdrawal(
  p_source_item_id uuid,
  p_output_item_id uuid,
  p_source_quantity numeric,
  p_customer_quantity numeric,
  p_entry_date date default current_date,
  p_customer text default null,
  p_withdrawal_no text default null,
  p_remarks text default null,
  p_operation_no text default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_operation_id uuid;
  v_withdrawal_id uuid;
  v_source_stock numeric;
  v_source_width numeric;
  v_source_width_unit text;
  v_source_length numeric;
  v_source_length_unit text;
  v_output_width numeric;
  v_output_width_unit text;
  v_output_length numeric;
  v_output_length_unit text;
  v_yield numeric;
  v_produced numeric;
  v_stock_quantity numeric;
  v_operation_no text;
  v_lock_id uuid;
begin
  if not public.is_active_user() then raise exception 'Not authorized'; end if;
  if p_source_item_id = p_output_item_id then raise exception 'Source and output items must be different'; end if;
  if p_source_quantity <= 0 then raise exception 'Source quantity must be greater than 0'; end if;
  if p_customer_quantity <= 0 then raise exception 'Customer quantity must be greater than 0'; end if;

  -- Lock both item rows in deterministic order so simultaneous withdrawals do
  -- not deadlock when two users operate on the same stock.
  for v_lock_id in
    select id from public.items
    where id in (p_source_item_id, p_output_item_id)
    order by id
    for update
  loop
    null;
  end loop;

  select width, width_unit, length, length_unit
    into v_source_width, v_source_width_unit, v_source_length, v_source_length_unit
  from public.items where id = p_source_item_id and active;
  if not found then raise exception 'Source item not found or inactive'; end if;

  select width, width_unit, length, length_unit
    into v_output_width, v_output_width_unit, v_output_length, v_output_length_unit
  from public.items where id = p_output_item_id and active;
  if not found then raise exception 'Output item not found or inactive'; end if;

  if v_source_width is null or v_output_width is null then
    raise exception 'Source and output items must have Width defined';
  end if;
  if upper(coalesce(v_source_width_unit, '')) <> upper(coalesce(v_output_width_unit, '')) then
    raise exception 'Source and output Width units must match';
  end if;
  if v_output_width <= 0 or v_source_width <= 0 then
    raise exception 'Source and output Width must be greater than 0';
  end if;

  -- The normal 3M use case is a width-only slit with the same length. Do not
  -- silently allow a length conversion to be recorded as a simple split.
  if v_source_length is not null and v_output_length is not null then
    if upper(coalesce(v_source_length_unit, '')) <> upper(coalesce(v_output_length_unit, ''))
       or v_source_length <> v_output_length then
      raise exception 'Source and output Length must match for a width split';
    end if;
  end if;

  v_yield := floor(v_source_width / v_output_width);
  if v_yield < 1 or (v_source_width / v_output_width) <> v_yield then
    raise exception 'Source width % cannot be evenly split into output width %', v_source_width, v_output_width;
  end if;

  v_produced := p_source_quantity * v_yield;
  if p_customer_quantity > v_produced then
    raise exception 'Customer quantity % exceeds produced quantity % from % source rolls',
      p_customer_quantity, v_produced, p_source_quantity;
  end if;
  v_stock_quantity := v_produced - p_customer_quantity;

  select coalesce(sum(quantity), 0) into v_source_stock
  from public.inventory_transactions
  where item_id = p_source_item_id;
  if p_source_quantity > v_source_stock then
    raise exception 'Insufficient source stock: % on hand, % requested', v_source_stock, p_source_quantity;
  end if;

  v_operation_no := nullif(trim(p_operation_no), '');
  if v_operation_no is null then
    v_operation_no := public.next_inventory_operation_no();
    -- Avoid the tiny daily-number race without making the user care about it.
    if exists (select 1 from public.inventory_operations where operation_no = v_operation_no) then
      v_operation_no := 'SPL-' || to_char(clock_timestamp(), 'YYYYMMDD-HH24MISSMS');
    end if;
  end if;

  insert into public.inventory_operations (
    operation_no, operation_type, entry_date, source_item_id, output_item_id,
    source_quantity, produced_quantity, customer_quantity, stock_quantity,
    customer, withdrawal_no, remarks, created_by
  ) values (
    v_operation_no, case when v_stock_quantity > 0 then 'SPLIT_WITHDRAWAL' else 'SPLIT_WITHDRAWAL' end,
    p_entry_date, p_source_item_id, p_output_item_id,
    p_source_quantity, v_produced, p_customer_quantity, v_stock_quantity,
    nullif(trim(p_customer), ''), nullif(trim(p_withdrawal_no), ''),
    nullif(trim(p_remarks), ''), auth.uid()
  ) returning id into v_operation_id;

  insert into public.inventory_operation_lines(operation_id, line_type, item_id, quantity)
  values
    (v_operation_id, 'SOURCE', p_source_item_id, p_source_quantity),
    (v_operation_id, 'OUTPUT', p_output_item_id, v_produced),
    (v_operation_id, 'CUSTOMER', p_output_item_id, p_customer_quantity);

  -- The parent source roll is consumed.
  insert into public.inventory_transactions (
    transaction_date, transaction_type, item_id, quantity,
    reference_type, reference_id, operation_id, remarks, created_by
  ) values (
    p_entry_date, 'SPLIT_PARENT', p_source_item_id, -p_source_quantity,
    'inventory_operations', v_operation_id, v_operation_id,
    coalesce(nullif(trim(p_remarks), ''), 'Split source roll'), auth.uid()
  );

  -- All pieces created by the split are first returned to inventory. The
  -- customer withdrawal below removes the pieces that actually left the site.
  if v_produced > 0 then
    insert into public.inventory_transactions (
      transaction_date, transaction_type, item_id, quantity,
      reference_type, reference_id, operation_id, remarks, created_by
    ) values (
      p_entry_date, 'SPLIT_CHILD', p_output_item_id, v_produced,
      'inventory_operations', v_operation_id, v_operation_id,
      'Pieces produced by split', auth.uid()
    );
  end if;

  insert into public.withdrawals (
    entry_date, item_id, quantity, withdrawal_no, customer, remarks,
    width, width_unit, length, length_unit, created_by
  ) values (
    p_entry_date, p_output_item_id, p_customer_quantity,
    nullif(trim(p_withdrawal_no), ''), nullif(trim(p_customer), ''),
    nullif(trim(p_remarks), ''), v_output_width, v_output_width_unit,
    v_output_length, v_output_length_unit, auth.uid()
  ) returning id into v_withdrawal_id;

  insert into public.inventory_transactions (
    transaction_date, transaction_type, item_id, quantity,
    reference_type, reference_id, operation_id, remarks, created_by
  ) values (
    p_entry_date, 'WITHDRAWAL', p_output_item_id, -p_customer_quantity,
    'withdrawals', v_withdrawal_id, v_operation_id,
    coalesce(nullif(trim(p_remarks), ''), 'Customer portion of split withdrawal'), auth.uid()
  );

  insert into public.audit_logs(user_id, action, entity_type, entity_id, new_data)
  values (
    auth.uid(), 'CREATE', 'inventory_operations', v_operation_id,
    jsonb_build_object(
      'operation_no', v_operation_no,
      'source_item_id', p_source_item_id,
      'output_item_id', p_output_item_id,
      'source_quantity', p_source_quantity,
      'produced_quantity', v_produced,
      'customer_quantity', p_customer_quantity,
      'stock_quantity', v_stock_quantity,
      'withdrawal_id', v_withdrawal_id
    )
  );

  return v_operation_id;
exception
  when unique_violation then
    raise exception 'Operation number % is already in use. Leave Operation No. blank and try again.', coalesce(v_operation_no, p_operation_no);
end;
$$;

-- ---------------------------------------------------------------------
-- Atomic void for a split operation. All original ledger rows are reversed
-- together, so the operation cannot be partially voided.
-- ---------------------------------------------------------------------
create or replace function public.void_split_withdrawal(
  p_operation_id uuid,
  p_reason text default null
) returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_op public.inventory_operations%rowtype;
  v_txn public.inventory_transactions%rowtype;
  v_on_hand numeric;
begin
  if not public.is_admin() then raise exception 'Only ADMIN can void records'; end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'A reason is required to void a split operation'; end if;

  select * into v_op from public.inventory_operations where id = p_operation_id for update;
  if not found then raise exception 'Split operation not found'; end if;
  if v_op.voided_at is not null then raise exception 'Split operation is already voided'; end if;

  -- Lock every affected item before checking balances.
  for v_txn in
    select * from public.inventory_transactions
    where operation_id = p_operation_id and reversal_of is null
    order by item_id, created_at, id
    for update
  loop
    if v_txn.quantity > 0 then
      select coalesce(sum(quantity), 0) into v_on_hand
      from public.inventory_transactions where item_id = v_txn.item_id;
      if v_on_hand - v_txn.quantity < 0 then
        raise exception 'Cannot void operation: item stock would become negative (% on hand)', v_on_hand;
      end if;
    end if;
  end loop;

  insert into public.inventory_transactions(
    transaction_date, transaction_type, item_id, quantity,
    reference_type, reference_id, operation_id, reversal_of, remarks, created_by
  )
  select
    current_date, 'REVERSAL', item_id, -quantity,
    'inventory_operations', p_operation_id, p_operation_id, id,
    p_reason, auth.uid()
  from public.inventory_transactions
  where operation_id = p_operation_id and reversal_of is null;

  update public.inventory_operations
  set voided_at = now(), voided_by = auth.uid()
  where id = p_operation_id;

  update public.withdrawals
  set voided_at = now(), voided_by = auth.uid()
  where id in (
    select reference_id from public.inventory_transactions
    where operation_id = p_operation_id and reference_type = 'withdrawals'
  );

  insert into public.audit_logs(user_id, action, entity_type, entity_id, new_data)
  values(auth.uid(), 'VOID', 'inventory_operations', p_operation_id, jsonb_build_object('reason', p_reason));
end;
$$;

alter table public.inventory_operations enable row level security;
alter table public.inventory_operation_lines enable row level security;

create policy "inventory_operations: active users read"
  on public.inventory_operations for select to authenticated using (public.is_active_user());
create policy "inventory_operation_lines: active users read"
  on public.inventory_operation_lines for select to authenticated using (public.is_active_user());

revoke execute on function public.next_inventory_operation_no,
  public.post_split_withdrawal, public.void_split_withdrawal from anon, public;
grant execute on function public.next_inventory_operation_no,
  public.post_split_withdrawal, public.void_split_withdrawal to authenticated;

alter publication supabase_realtime add table
  public.inventory_operations, public.inventory_operation_lines;
