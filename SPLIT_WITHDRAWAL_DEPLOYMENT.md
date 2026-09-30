# Split & Withdraw — Deployment Notes

## What was added

The inventory system now supports an atomic **Split & Withdraw** workflow.

Example:

- Source: `Commercial Grade 610-10 White — 48 in × 50 yds`
- Starting source stock: `100 rolls`
- Customer needs: `1 × 24 in × 50 yds`

The operation posts:

1. `SPLIT_PARENT` — `-1` of the 48 × 50 yd source item.
2. `SPLIT_CHILD` — `+2` of the 24 × 50 yd output item.
3. `WITHDRAWAL` — `-1` of the 24 × 50 yd customer quantity.

Final stock:

- 48 × 50 yd: `99 rolls`
- 24 × 50 yd: `1 roll`

All three ledger movements are created in one Supabase RPC transaction. If validation fails, none of the movements are committed.

## Files changed

- `supabase/migrations/0011_split_withdrawal_operations.sql`
- `web/src/features/withdraw/SplitWithdrawPage.tsx`
- `web/src/features/withdraw/WithdrawPage.tsx`

## Supabase deployment

Run the new migration **after migration 0010** in the Supabase SQL Editor (or include it in your normal Supabase migration deployment).

Do not run only the React changes; the new page calls the `post_split_withdrawal` RPC created by migration 0011.

## Important item-master requirement

For automatic split calculation, both source and output items need:

- Width
- Width unit
- The same Length and Length unit (when both are populated)

For example:

- 48 IN × 50 YDS
- 24 IN × 50 YDS

The server calculates `48 / 24 = 2` output rolls per source roll and refuses non-even width splits.

## Warehouse usage

Open **Withdraw → Split & Withdraw**.

1. Select the source item.
2. Select the output/customer-size item.
3. Enter source rolls to use.
4. Enter customer rolls needed.
5. Review the warehouse preview.
6. Enter customer / withdrawal information if needed.
7. Click **Confirm Split & Withdraw**.

The page also shows recent split operations. ADMIN users can void the entire split operation as one unit, with a required reason.

## Verification scenario

After applying migration 0011, create or use:

- `48 × 50 YDS` item with at least 1 roll on hand.
- `24 × 50 YDS` item.

Post one split withdrawal for:

- source rolls: `1`
- customer rolls: `1`

Expected ledger effect:

```text
48 × 50 YDS     SPLIT_PARENT    -1
24 × 50 YDS     SPLIT_CHILD     +2
24 × 50 YDS     WITHDRAWAL      -1
----------------------------------
Net stock:
48 × 50 YDS     -1
24 × 50 YDS     +1
```

The operation appears under Recent split operations with an operation number such as `SPL-20260930-0001`.
