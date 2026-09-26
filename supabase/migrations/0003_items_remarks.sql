-- Free-text notes on an item (e.g. why it was deactivated, sourcing notes).
-- Safe to run more than once.
alter table public.items add column if not exists remarks text;
