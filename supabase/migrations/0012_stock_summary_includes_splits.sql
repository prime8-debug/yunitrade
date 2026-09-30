-- =====================================================================
-- Fix: current_stock's Received/Withdrawn columns didn't count Split &
-- Withdraw movements (SPLIT_CHILD / SPLIT_PARENT), only RECEIVED/WITHDRAWAL.
-- On Hand was already correct (it sums every transaction type), but:
--   - the SOURCE item's Withdrawn column showed 0 even though rolls left it
--   - Beginning + Received - Withdrawn didn't equal On Hand for any item
--     touched by a split, on either side
--
-- SPLIT_PARENT (rolls consumed to produce a split) now counts as Withdrawn;
-- SPLIT_CHILD (rolls produced by a split) now counts as Received. These are
-- each the only ledger row recording that specific movement (not a second,
-- duplicate one), so this doesn't double-count anything — it just puts an
-- existing movement in the right summary bucket.
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
  coalesce(sum(t.quantity) filter (where t.transaction_type = 'BEGINNING' or t.reference_type = 'beginning_adjustments'), 0) as beginning,
  coalesce(sum(t.quantity) filter (where t.transaction_type in ('RECEIVED', 'SPLIT_CHILD')), 0) as received,
  coalesce(-sum(t.quantity) filter (where t.transaction_type in ('WITHDRAWAL', 'SPLIT_PARENT')), 0) as withdrawn,
  max(t.created_at) as last_movement_at
from public.items i
left join public.inventory_transactions t on t.item_id = i.id
group by i.id;
