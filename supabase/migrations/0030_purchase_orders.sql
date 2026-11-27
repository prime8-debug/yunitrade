-- =====================================================================
-- Purchase Orders (ADMIN only): orders placed with suppliers, incoming
-- shipments against them, samples, and notes.
--
-- Record-keeping only: nothing here changes stock. Goods that arrive
-- still go into stock through the Received page as before.
--
-- Run this in the Supabase SQL editor before using the Purchase Orders
-- tab. Safe to run more than once.
-- =====================================================================

-- One row per item ordered; several rows can share a PO No.
create table if not exists public.purchase_orders (
  id          uuid primary key default gen_random_uuid(),
  po_no       text not null,
  po_date     date not null default current_date,
  supplier    text,
  item_code   text,
  description text,
  quantity    numeric,
  unit        text,
  unit_cost   numeric,
  currency    text,
  eta         date,
  status      text not null default 'Ordered',
  remarks     text,
  created_by  uuid references public.profiles (id) default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- A shipment on its way. Marking it Received moves it to the Received sub-tab.
create table if not exists public.po_shipments (
  id            uuid primary key default gen_random_uuid(),
  po_no         text,
  supplier      text,
  shipment_ref  text,          -- B/L, AWB, container or tracking no.
  carrier       text,          -- forwarder / courier
  item_code     text,
  description   text,
  quantity      numeric,
  unit          text,
  ship_date     date,
  eta           date,
  status        text not null default 'In Transit',
  received_date date,
  mrr_no        text,
  remarks       text,
  created_by    uuid references public.profiles (id) default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.po_samples (
  id            uuid primary key default gen_random_uuid(),
  request_date  date not null default current_date,
  supplier      text,
  item_code     text,
  description   text,
  quantity      numeric,
  unit          text,
  status        text not null default 'Requested',
  received_date date,
  remarks       text,
  created_by    uuid references public.profiles (id) default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.po_notes (
  id          uuid primary key default gen_random_uuid(),
  note_date   date not null default current_date,
  po_no       text,
  title       text,
  body        text,
  created_by  uuid references public.profiles (id) default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists purchase_orders_po_no_idx on public.purchase_orders (po_no);
create index if not exists po_shipments_po_no_idx on public.po_shipments (po_no);

-- ADMIN only: read, add, edit and delete.
do $$
declare
  t text;
begin
  foreach t in array array['purchase_orders', 'po_shipments', 'po_samples', 'po_notes'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "%s: admin all" on public.%I', t, t);
    execute format(
      'create policy "%s: admin all" on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())',
      t, t
    );
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
