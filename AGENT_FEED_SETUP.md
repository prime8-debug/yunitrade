# Hivedesk agents: setup

Hivedesk (the AI agents on the office PC) reads the inventory through a **read-only** function,
`agent-feed`. It only looks: it can't post, edit, void or delete anything. Your Google Sheet
automation keeps doing all the withdrawals as before.

Do these once, in order.

## 1. Run the migration

In the Supabase SQL Editor, run `supabase/migrations/0032_low_stock_level.sql`.
It adds **Low Stock Level** to items and shows it on the Stocks tab. Safe to run more than once.

## 2. Publish the app

Commit and push. Then set levels in **Items → Edit → Low Stock Level**. Leave it blank for items
you don't want reminders for. **Stocks → Low stock only** lists the items at or below their level.

## 3. Deploy the feed

Choose a long random password for `AGENT_FEED_SECRET`. Use a **different** one from `CRON_SECRET`.
Then run this from the project folder (`qmsrlhvvfgqdbtgcjueo` is this project's ref):

```
supabase login
supabase secrets set AGENT_FEED_SECRET=<your-password> --project-ref qmsrlhvvfgqdbtgcjueo
supabase functions deploy agent-feed --no-verify-jwt --use-api --project-ref qmsrlhvvfgqdbtgcjueo
```

`--no-verify-jwt` is needed because Hivedesk isn't a signed-in user. The `AGENT_FEED_SECRET`
password protects it instead. Don't commit the password.

## 4. Connect Hivedesk

In Hivedesk's `.env` file, set:

```
AGENT_FEED_URL=https://qmsrlhvvfgqdbtgcjueo.supabase.co/functions/v1/agent-feed
AGENT_FEED_SECRET=<your-password>
```

Restart Hivedesk. The terminal should say `📦 Inventory monitor is on: N items, M with a low stock level`.

## What the feed returns

Active items with stock and average per month (same numbers as the Stocks tab), movements from the
last 60 days (up to 120 with `?days=`), the latest automatic withdrawal run with its held orders,
open purchase orders and incoming shipments.

## Stopping it

Remove the two lines from Hivedesk's `.env`, or change the password:

```
supabase secrets set AGENT_FEED_SECRET=<new-password> --project-ref qmsrlhvvfgqdbtgcjueo
```
