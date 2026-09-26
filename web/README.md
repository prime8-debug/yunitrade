# YUNITRADE Inventory — Web (Desktop / PWA)

React + TypeScript + Vite + Tailwind, talking directly to Supabase.
Stock is **never** calculated here — it comes from the `current_stock` view, and every
stock movement goes through a database function (`post_withdrawal`, etc.).

## First-time setup

1. **Create a Supabase project** at https://supabase.com.
2. **Create the database**: Dashboard → SQL Editor → paste and run every file in
   [`../supabase/migrations/`](../supabase/migrations/) **in order** (0001, 0002, 0003, …).
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
| Beginning Inventory / Received / Withdraw (Roll/PC) | Item autocomplete; saved atomically via RPC; withdraw is stock-checked **server-side** |
| Withdraw → Yards / Partial sub-tabs | Add a roll with a starting quantity, then withdraw from it; own ledger, kept separate from the main item stock (see assumption below) |
| Void (ADMIN) | Posts a REVERSAL ledger row; the original stays in history |
| Items (ADMIN) | Item master add / edit / deactivate / delete (blocked if it has history) |

Other menu entries (Sales Orders, Served, 3M Yards, Partial Rolls, Search, Audit) are placeholders — note the
Yards/Partial *withdrawal* workflow already exists under Withdraw; those separate pages would add full roll
management (edit/close a roll, reports) later.

## Bulk-loading item codes from the Google Sheet

1. Export the item-code sheet as CSV with headers `ITEMCODE, Item Description, WIDTH, W-UNIT,
   LENGTH, L-UNIT, STOCKING UNIT MEASURE` and save it as `../data/ITEMCODES.csv` (gitignored).
2. Copy `../.env.import.local.example` to `../.env.import.local` and fill in your Project URL
   and **service_role** key (Dashboard → Project Settings → API — not the anon key; this key
   bypasses RLS to bulk-write, so it's kept out of the frontend entirely).
3. Dry run first (writes nothing, just reports problems):
   ```
   npm run import:items
   ```
   It flags duplicate item codes (keeping the first, skipping the rest) and any WIDTH/LENGTH
   value it couldn't read as a number. Fix the sheet and re-export if anything looks wrong.
4. When the dry run looks right, actually write it:
   ```
   npm run import:items -- --commit
   ```
   Safe to re-run — it upserts by `item_code`, so re-running after fixing a few rows just
   updates them instead of creating duplicates.

## Milestone test

Open the app in two browsers (Desktop A / Desktop B), add an item, post Beginning 100,
Received 50, Withdraw 20 → both should show **130** on hand without refreshing.

## Assumptions to confirm (open business questions)

- Item code is unique (case-insensitive).
- Negative stock is **not** allowed.
- Quantities may be decimals.
- Only ADMIN can void; USER can post Beginning / Received / Withdraw.
- One item code = one fixed width/length/UOM. The real sheet has **`STAMARK N450`** listed
  twice with two different widths (24in and 12in) — that's not possible under this rule. The
  import kept the first row and skipped the second; if both sizes are real stock, give the
  second one its own code (e.g. `STAMARK N450-12`) in the sheet and re-run the import.
- **3M Yards / Partial Roll withdrawals do not touch the item's main stock.** A roll's
  remaining Yards/Quantity is tracked in its own ledger (`yards_transactions` /
  `partial_roll_transactions`). Whether consuming a roll should also reduce the item's
  ROLLS/PC count in `items` is an open question (plan §44, #23–29) — confirm the rule, then
  wire the two together.
