-- =====================================================================
-- Average withdrawn per month, for the Stocks tab.
--
-- Withdrawals (Roll / PC, split parents, rolls sent to Yards) are totalled
-- by calendar month (1st to last day) and averaged over every month from
-- the item's first movement up to the current month — months with no
-- withdrawals count as 0. A voided withdrawal cancels out in the month of
-- the entry it voids.
--
-- Safe to run more than once.
-- =====================================================================
create or replace view public.item_withdrawal_average
with (security_invoker = true)
as
with withdrawn as (
  select t.item_id, -t.quantity as qty
  from public.inventory_transactions t
  left join public.inventory_transactions o on o.id = t.reversal_of
  where coalesce(o.transaction_type, t.transaction_type) in ('WITHDRAWAL', 'SPLIT_PARENT', 'TO_YARDS')
),
first_move as (
  select item_id, date_trunc('month', min(transaction_date))::date as first_month
  from public.inventory_transactions
  group by item_id
)
select
  f.item_id,
  f.first_month,
  m.months,
  coalesce(sum(w.qty), 0) as total_withdrawn,
  round(coalesce(sum(w.qty), 0) / m.months, 2) as avg_per_month
from first_move f
cross join lateral (
  select greatest(1, (
    (extract(year from current_date) - extract(year from f.first_month)) * 12
    + extract(month from current_date) - extract(month from f.first_month) + 1
  )::int) as months
) m
left join withdrawn w on w.item_id = f.item_id
group by f.item_id, f.first_month, m.months;
