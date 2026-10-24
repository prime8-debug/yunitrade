-- =====================================================================
-- Sales Orders — read-only view of the Google Sheet (JHONG BACKEND tab).
--
-- Decided with the user (2026-10-22): the sheet stays the source of truth.
-- The app fetches its "Publish to web" CSV link in the browser and shows a
-- fixed set of columns; nothing about orders is stored in the database and
-- stock is not touched.
--
-- The only thing stored here is that link, in an ADMIN-only settings table.
-- It is deliberately NOT in a VITE_ env var (those ship in the public JS
-- bundle) and NOT in this migration (the repo is on GitHub): anyone holding
-- the link can read the sheet. Paste it once on the Sales Orders page.
--
-- Safe to run more than once.
-- =====================================================================

create table if not exists public.app_settings (
  key         text primary key,
  value       text,
  updated_by  uuid references public.profiles (id) default auth.uid(),
  updated_at  timestamptz not null default now()
);

alter table public.app_settings enable row level security;

drop policy if exists "app_settings: admin read" on public.app_settings;
create policy "app_settings: admin read" on public.app_settings
  for select to authenticated using (public.is_admin());

drop policy if exists "app_settings: admin insert" on public.app_settings;
create policy "app_settings: admin insert" on public.app_settings
  for insert to authenticated with check (public.is_admin());

drop policy if exists "app_settings: admin update" on public.app_settings;
create policy "app_settings: admin update" on public.app_settings
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
