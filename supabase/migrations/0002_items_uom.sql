-- =====================================================================
-- Items: stocking unit of measure + a plain unique constraint on item_code.
--
-- The item list (from Google Sheets) has a "STOCKING UNIT MEASURE" column
-- (ROLLS, PC, SQFT, SQM, GAL, KG, SHEETS, ...) — the unit a quantity is
-- counted in for that item. There was nowhere to store it; width_unit /
-- length_unit only describe the item's *size*, not its counting unit.
--
-- Safe to run more than once (e.g. after a previous attempt failed partway).
-- Run this in Supabase SQL Editor after 0001_inventory_core.sql.
-- =====================================================================

alter table public.items add column if not exists uom text;
comment on column public.items.uom is
  'Stocking unit of measure the quantity is counted in, e.g. ROLLS, PC, SQFT, SQM, GAL, KG, SHEETS.';

-- The app always uppercases item_code before saving (see ItemsPage.tsx and the
-- import script), so a plain unique constraint on the column works and lets
-- bulk upserts target it directly (ON CONFLICT (item_code)). Replaces the
-- expression index (upper(item_code)), which an upsert can't reference.
do $$
begin
  if exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'items_item_code_key' and indexdef ilike '%upper(item_code)%'
  ) then
    drop index public.items_item_code_key;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'items_item_code_key') then
    alter table public.items add constraint items_item_code_key unique (item_code);
  end if;
end $$;

-- Rebuild the view (drop + create, not "or replace" — Postgres won't let
-- "or replace" insert a new column in the middle of the existing column list).
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
  coalesce(sum(t.quantity), 0)                                              as on_hand,
  coalesce(sum(t.quantity) filter (where t.transaction_type = 'BEGINNING'), 0) as beginning,
  coalesce(sum(t.quantity) filter (where t.transaction_type = 'RECEIVED'), 0)  as received,
  coalesce(-sum(t.quantity) filter (where t.transaction_type = 'WITHDRAWAL'), 0) as withdrawn,
  max(t.created_at)                                                         as last_movement_at
from public.items i
left join public.inventory_transactions t on t.item_id = i.id
group by i.id;
