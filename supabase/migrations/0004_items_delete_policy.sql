-- Let ADMIN delete an item row outright (e.g. a mistyped/duplicate code with no
-- movements yet). Items that already have ledger history are protected
-- automatically: inventory_transactions.item_id (and the other tables that
-- reference items) has no ON DELETE CASCADE, so Postgres rejects the delete
-- with a foreign-key-violation error instead of silently losing history.
-- The app shows a friendly message for that error; see ItemsPage.tsx.
create policy "items: admin delete" on public.items
  for delete to authenticated using (public.is_admin());
