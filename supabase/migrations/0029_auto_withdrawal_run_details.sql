-- =====================================================================
-- Each automatic withdrawal run keeps the orders it held for review or
-- couldn't post, and why, so Recent runs can show them.
--
-- Run this before deploying the auto-withdrawals function. The function
-- clears details older than a day, because a run happens every 5 minutes.
--
-- Safe to run more than once.
-- =====================================================================

alter table public.auto_withdrawal_runs add column if not exists details jsonb;
