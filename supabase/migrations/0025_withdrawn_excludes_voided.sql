-- =====================================================================
-- Stocks: Withdrawn no longer counts voided entries.
--
-- A void adds a REVERSAL row pointing at the original, which corrects
-- on_hand, but the Withdrawn column only looked at the original row. This
-- also applies to voided Split & Withdraw and Send to Yards entries, and
-- so to Average per Month, which is worked out from Withdrawn.
--
-- Safe to run more than once.
-- =====================================================================

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
  coalesce(-sum(t.quantity) filter (where t.in_year and not t.voided and t.transaction_type in ('WITHDRAWAL', 'SPLIT_PARENT', 'TO_YARDS')), 0) as withdrawn,
  max(t.created_at) as last_movement_at
from public.items i
left join (
  select
    tx.*,
    (y.start_date is null or tx.transaction_date >= y.start_date or tx.created_at > y.closed_at) as in_year,
    exists (select 1 from public.inventory_transactions r where r.reversal_of = tx.id) as voided
  from public.inventory_transactions tx
  left join (select start_date, closed_at from public.stock_years order by start_date desc limit 1) y on true
) t on t.item_id = i.id
group by i.id;
