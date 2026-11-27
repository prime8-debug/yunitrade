-- =====================================================================
-- Purchase Orders → Orders: Width and Length, filled in from the
-- ITEMCODES sheet tab when an item code is picked (still editable).
--
-- The sheet link itself is kept in app_settings
-- (key po_items_csv_url), set from the Orders screen.
--
-- Run after 0030. Safe to run more than once.
-- =====================================================================

alter table public.purchase_orders add column if not exists width numeric;
alter table public.purchase_orders add column if not exists length numeric;
