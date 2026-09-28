-- =====================================================================
-- Beginning Inventory becomes ADMIN-only, and changing an already-set
-- balance is now a distinct, reason-required "Adjustment" — never a silent
-- overwrite. This replaces the old "can't lower" dead end with a proper,
-- audited correction path.
--
--   ADMIN → Beginning Inventory (first entry) → Adjustment (later changes,
--   reason required) → beginning_adjustments log → Stocks Summary
--   (Beginning = BEGINNING entry + all its Adjustments)
--
-- Safe to run more than once.
-- =====================================================================

-- ---------------------------------------------------------------------
-- post_beginning is now ADMIN-only (was: any active user).
-- Signature unchanged from 0006, so "create or replace" is fine here.
-- ---------------------------------------------------------------------
create or replace function public.post_beginning(
  p_item_id uuid, p_quantity numeric, p_entry_date date default current_date, p_notes text default null,
  p_width numeric default null, p_width_unit text default null, p_length numeric default null, p_length_unit text default null,
  p_description text default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  if not public.is_admin() then raise exception 'Only ADMIN can set Beginning Inventory'; end if;

  insert into beginning_inventory (entry_date, item_id, quantity, notes, width, width_unit, length, length_unit, description, created_by)
  values (p_entry_date, p_item_id, p_quantity, p_notes, p_width, p_width_unit, p_length, p_length_unit, p_description, auth.uid())
  returning id into v_id;

  insert into inventory_transactions (transaction_date, transaction_type, item_id, quantity, reference_type, reference_id, remarks, created_by)
  values (p_entry_date, 'BEGINNING', p_item_id, p_quantity, 'beginning_inventory', v_id, p_notes, auth.uid());

  insert into audit_logs (user_id, action, entity_type, entity_id, new_data)
  select auth.uid(), 'CREATE', 'beginning_inventory', v_id, to_jsonb(b) from beginning_inventory b where b.id = v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Adjustment log: one row per correction to an item's Beginning balance,
-- with exactly the fields needed for an audit table (old/new/difference/
-- reason/who/when). Rows are never edited or deleted.
-- ---------------------------------------------------------------------
create table if not exists public.beginning_adjustments (
  id                  uuid primary key default gen_random_uuid(),
  item_id             uuid not null references public.items (id),
  previous_quantity   numeric not null,
  new_quantity        numeric not null,
  difference          numeric not null,
  reason              text not null check (btrim(reason) <> ''),
  created_by          uuid references public.profiles (id) default auth.uid(),
  created_at          timestamptz not null default now()
);
create index if not exists beginning_adjustments_item_idx on public.beginning_adjustments (item_id, created_at);

alter table public.beginning_adjustments enable row level security;
drop policy if exists "beginning_adjustments: active users read" on public.beginning_adjustments;
create policy "beginning_adjustments: active users read" on public.beginning_adjustments
  for select to authenticated using (public.is_active_user());

-- ---------------------------------------------------------------------
-- post_beginning_adjustment — the ONLY way to change an existing Beginning
-- balance. ADMIN-only, reason required, can raise or lower (unlike the
-- inline editor's old rule), and still can't push overall on-hand negative.
-- ---------------------------------------------------------------------
create or replace function public.post_beginning_adjustment(
  p_item_id uuid, p_new_quantity numeric, p_reason text, p_entry_date date default current_date
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_current_beginning numeric;
  v_on_hand numeric;
  v_new_on_hand numeric;
  v_delta numeric;
begin
  if not public.is_admin() then raise exception 'Only ADMIN can adjust Beginning Inventory'; end if;
  if p_new_quantity < 0 then raise exception 'Beginning quantity cannot be negative'; end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'A reason is required to adjust Beginning Inventory'; end if;

  perform 1 from items where id = p_item_id for update;
  if not found then raise exception 'Item not found'; end if;

  select coalesce(sum(quantity), 0) into v_current_beginning
  from inventory_transactions
  where item_id = p_item_id and (transaction_type = 'BEGINNING' or reference_type = 'beginning_adjustments');

  v_delta := p_new_quantity - v_current_beginning;
  if v_delta = 0 then raise exception 'New quantity is the same as the current Beginning balance (%).', v_current_beginning; end if;

  select coalesce(sum(quantity), 0) into v_on_hand from inventory_transactions where item_id = p_item_id;
  v_new_on_hand := v_on_hand + v_delta;
  if v_new_on_hand < 0 then
    raise exception 'This would take on-hand stock negative (% currently, % after adjustment)', v_on_hand, v_new_on_hand;
  end if;

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

revoke execute on function public.post_beginning_adjustment from anon, public;
grant execute on function public.post_beginning_adjustment to authenticated;

-- ---------------------------------------------------------------------
-- current_stock's "beginning" column now means the CURRENT Beginning
-- balance (initial entry + all adjustments), not just the original entry.
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
  coalesce(sum(t.quantity) filter (where t.transaction_type = 'BEGINNING' or t.reference_type = 'beginning_adjustments'), 0) as beginning,
  coalesce(sum(t.quantity) filter (where t.transaction_type = 'RECEIVED'), 0) as received,
  coalesce(-sum(t.quantity) filter (where t.transaction_type = 'WITHDRAWAL'), 0) as withdrawn,
  max(t.created_at) as last_movement_at
from public.items i
left join public.inventory_transactions t on t.item_id = i.id
group by i.id;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'beginning_adjustments'
  ) then
    alter publication supabase_realtime add table public.beginning_adjustments;
  end if;
end $$;
