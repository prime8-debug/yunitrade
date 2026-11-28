-- =====================================================================
-- Low stock level per item, set on the Items page (ADMIN).
--
-- When On Hand drops to this level or below, the Stocks tab marks the
-- item, and the Hivedesk agents (through the read-only agent-feed
-- function) send a Telegram reminder. Blank = no reminder for that item.
--
-- current_stock is the same as 0027, with low_stock_level added at the end.
--
-- Requires 0027. Safe to run more than once.
-- =====================================================================

alter table public.items add column if not exists low_stock_level numeric;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'items_low_stock_level_check') then
    alter table public.items add constraint items_low_stock_level_check check (low_stock_level is null or low_stock_level >= 0);
  end if;
end $$;

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
  coalesce(sum(t.quantity) filter (where t.counted and (t.transaction_type = 'BEGINNING' or t.reference_type = 'beginning_adjustments')), 0) as beginning,
  coalesce(sum(t.quantity) filter (where t.counted and t.transaction_type in ('RECEIVED', 'SPLIT_CHILD')), 0) as received,
  coalesce(-sum(t.quantity) filter (where t.counted and t.transaction_type in ('WITHDRAWAL', 'SPLIT_PARENT', 'TO_YARDS')), 0) as withdrawn,
  max(t.created_at) as last_movement_at,
  i.low_stock_level
from public.items i
left join (
  select
    tx.*,
    (y.start_date is null or tx.transaction_date >= y.start_date or tx.created_at > y.closed_at)
      and tx.transaction_type <> 'REVERSAL'
      and not exists (select 1 from public.inventory_transactions r where r.reversal_of = tx.id) as counted
  from public.inventory_transactions tx
  left join (select start_date, closed_at from public.stock_years order by start_date desc limit 1) y on true
) t on t.item_id = i.id
group by i.id;
