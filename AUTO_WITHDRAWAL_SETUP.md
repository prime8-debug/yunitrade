# Automatic withdrawals: setup

Do these once, in order. Nothing posts until you press **Turn on** in the app.

## 1. Run the migration

In the Supabase SQL Editor, run `supabase/migrations/0024_stock_year_and_auto_withdrawals.sql`.
Run any earlier migrations you haven't run first. This must happen **before** step 2, because the
Apply Withdrawals tab posts through a function this migration adds.

## 2. Publish the app

Commit and push. The new tab is **Sales Orders → Automation**.

## 3. Deploy the job

Choose a long random password for `CRON_SECRET`, then run this from the project folder.
`<project-ref>` is the part before `.supabase.co` in your Supabase URL.

```
supabase login
supabase secrets set CRON_SECRET=<your-password> --project-ref <project-ref>
supabase functions deploy auto-withdrawals --no-verify-jwt --use-api --project-ref <project-ref>
```

`--no-verify-jwt` is needed because the job is called by the scheduler, not a signed-in user.
The `CRON_SECRET` password protects it instead. Don't commit the password.

## 4. Schedule it every 5 minutes

Supabase Dashboard → Integrations: enable **Cron** and **Vault**. Then, in the SQL Editor, using
the same password and your project ref:

```sql
create extension if not exists pg_net;

select vault.create_secret('<your-password>', 'auto_withdrawal_cron_secret');

select cron.schedule('auto-withdrawals', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/auto-withdrawals',
    headers := jsonb_build_object('x-cron-secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'auto_withdrawal_cron_secret')),
    timeout_milliseconds := 120000
  );
$$);
```

## 5. Check it

Within 5 minutes, **Automation → Recent runs** should show a run with the result `off`. If the page
says the job hasn't run, check Dashboard → Edge Functions → auto-withdrawals → Logs.

## New year steps

Management sets the date each year. Nothing in the app assumes a particular date.

1. Finish the count and enter all remaining movements from before the new beginning date.
2. In **Automation → Year-end clear**, choose the **New beginning date**.
3. Press **Clear and start new year**. It opens from the day before that date. The automation start
   date moves to the same date, and automation stays on or off as it was.
4. Enter the new Beginning stock in the **Beginning** tab.
5. If automation is off, press **Turn on**.

Orders short of stock wait and post once Beginning is entered, so step 5 can come before step 4 ends.

Automation can also start on its own date without a clear: use the start date in the
**Automatic withdrawals** section, turning it off first if it's on.

## Stopping it

Press **Turn off** in the Automation tab. To remove the schedule completely:

```sql
select cron.unschedule('auto-withdrawals');
```
