-- =====================================================================
-- Each yards roll's most recent withdrawal that hasn't been reversed,
-- shown in the 3M Yards Rolls table on Withdraw → Yards.
--
-- Requires 0020. Safe to run more than once.
-- =====================================================================

create or replace view public.yards_latest_withdrawal
with (security_invoker = true)
as
select distinct on (t.roll_id)
  t.roll_id,
  -t.quantity as yards,
  t.withdrawal_no,
  t.customer,
  t.transaction_date
from public.yards_transactions t
where t.transaction_type = 'WITHDRAWAL'
  and not exists (select 1 from public.yards_transactions r where r.reversal_of = t.id)
order by t.roll_id, t.transaction_date desc, t.created_at desc;
