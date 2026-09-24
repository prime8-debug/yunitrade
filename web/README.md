# YUNITRADE Inventory — Web (Desktop / PWA)

React + TypeScript + Vite + Tailwind, talking directly to Supabase.
Stock is **never** calculated here — it comes from the `current_stock` view, and every
stock movement goes through a database function (`post_withdrawal`, etc.).

## First-time setup

1. **Create a Supabase project** at https://supabase.com.
2. **Create the database**: Dashboard → SQL Editor → paste and run
   [`../supabase/migrations/0001_inventory_core.sql`](../supabase/migrations/0001_inventory_core.sql).
3. **Create users**: Dashboard → Authentication → Users → *Add user* (email + password,
   tick *Auto confirm*). A `profiles` row is created automatically with role `USER`.
4. **Make yourself ADMIN** (SQL Editor):
   ```sql
   update profiles set role = 'ADMIN' where email = 'you@example.com';
   ```
5. **Connect the app**: copy `.env.example` to `.env.local` and fill in the Project URL and
   `anon` public key from Dashboard → Project Settings → API.
6. Run it:
   ```
   npm install
   npm run dev
   ```

## What works now (Phase 1–2 milestone)

| Screen | Notes |
|---|---|
| Login | Supabase Auth (email/password) — replaces the PIN |
| Stocks | Live on-hand per item; click a row for its ledger + running balance |
| Beginning Inventory / Received / Withdraw | Item autocomplete; saved atomically via RPC; withdraw is stock-checked **server-side** |
| Void (ADMIN) | Posts a REVERSAL ledger row; the original stays in history |
| Items (ADMIN) | Item master add / edit / deactivate |

Other menu entries (Sales Orders, Served, 3M Yards, Partial Rolls, Search, Audit) are placeholders.

## Milestone test

Open the app in two browsers (Desktop A / Desktop B), add an item, post Beginning 100,
Received 50, Withdraw 20 → both should show **130** on hand without refreshing.

## Assumptions to confirm (open business questions)

- Item code is unique (case-insensitive).
- Negative stock is **not** allowed.
- Quantities may be decimals.
- Only ADMIN can void; USER can post Beginning / Received / Withdraw.
