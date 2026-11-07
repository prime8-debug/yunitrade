// Called every 5 minutes by pg_cron. See AUTO_WITHDRAWAL_SETUP.md.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { runAutoWithdrawals, type RunResult } from '../_shared/autoWithdrawals.ts'

const RUNS_KEPT_DAYS = 30
const DETAILS_KEPT_DAYS = 1

async function fetchText(url: string) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Google Sheets returned ${res.status} — is the sheet still published to the web?`)
  return res.text()
}

Deno.serve(async (req) => {
  const secret = Deno.env.get('CRON_SECRET')
  if (!secret || req.headers.get('x-cron-secret') !== secret) return new Response('Unauthorized', { status: 401 })

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })

  let result: RunResult
  try {
    result = await runAutoWithdrawals(db, fetchText, today)
  } catch (e) {
    result = { status: 'error', posted: 0, held: 0, failed: 0, message: e instanceof Error ? e.message : String(e) }
  }

  await db.from('auto_withdrawal_runs').insert(result)
  const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()
  await db.from('auto_withdrawal_runs').delete().lt('ran_at', daysAgo(RUNS_KEPT_DAYS))
  await db.from('auto_withdrawal_runs').update({ details: null }).lt('ran_at', daysAgo(DETAILS_KEPT_DAYS)).not('details', 'is', null)

  return Response.json(result)
})
