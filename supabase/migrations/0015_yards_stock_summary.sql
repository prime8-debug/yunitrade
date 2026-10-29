-- =====================================================================
-- Yards Stock summary: one row per roll (Core No.) with totals.
--
-- A REVERSAL (void) is counted on the same side as the entry it cancels, so
-- voiding a withdrawal lowers Total Withdrawn rather than inflating Total
-- Received. Available Balance is always the plain sum of every movement
-- (same number as yards_roll_stock.remaining_yards).
--
-- Safe to run more than once.
-- =====================================================================
create or replace view public.yards_stock_summary
with (security_invoker = true)
as
select
  r.id as roll_id,
  r.roll_no as core_no,
  i.item_code,
  i.description,
  i.width,
  i.width_unit,
  r.active,
  coalesce(sum(t.quantity) filter (where coalesce(o.transaction_type, t.transaction_type) = 'RECEIVED'), 0) as total_received,
  coalesce(-sum(t.quantity) filter (where coalesce(o.transaction_type, t.transaction_type) = 'WITHDRAWAL'), 0) as total_withdrawn,
  coalesce(sum(t.quantity), 0) as available_balance
from public.yards_rolls r
join public.items i on i.id = r.item_id
left join public.yards_transactions t on t.roll_id = r.id
left join public.yards_transactions o on o.id = t.reversal_of
group by r.id, i.id;
