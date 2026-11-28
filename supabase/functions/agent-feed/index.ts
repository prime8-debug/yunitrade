// Read-only data feed for the Hivedesk AI agents. See AGENT_FEED_SETUP.md.
//
// It only runs fixed SELECT queries: nothing here inserts, updates, deletes or calls a
// posting function, so the agents can look at the inventory but never change it.
// Locked with its own secret (AGENT_FEED_SECRET), separate from CRON_SECRET.
import { createClient } from 'npm:@supabase/supabase-js@2'

const PAGE = 1000 // PostgREST returns at most 1000 rows per request
const MAX_DAYS = 120

// deno-lint-ignore no-explicit-any
type Query = any

/** Reads every row of a query, a page at a time. */
async function all(make: () => Query) {
  const rows: Record<string, unknown>[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await make().range(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    rows.push(...(data ?? []))
    if (!data || data.length < PAGE) return rows
  }
}

const num = (v: unknown) => (v == null ? null : Number(v))
const size = (r: Record<string, unknown>) =>
  [r.width != null ? `${r.width}${r.width_unit ?? ''}` : '', r.length != null ? `${r.length}${r.length_unit ?? ''}` : ''].filter(Boolean).join(' x ')

Deno.serve(async (req) => {
  const secret = Deno.env.get('AGENT_FEED_SECRET')
  if (!secret || req.headers.get('x-agent-secret') !== secret) return new Response('Unauthorized', { status: 401 })
  if (req.method !== 'GET') return new Response('Read-only: use GET', { status: 405 })

  const url = new URL(req.url)
  const days = Math.min(MAX_DAYS, Math.max(1, Number(url.searchParams.get('days')) || 60))
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })
  const since = new Date(Date.now() - days * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })

  try {
    const [stock, year, ledger, withdrawals, receipts, run, orders, shipments] = await Promise.all([
      all(() => db.from('current_stock').select('*').eq('active', true).order('item_code')),
      db.from('stock_years').select('start_date').order('start_date', { ascending: false }).limit(1).maybeSingle(),
      all(() =>
        db
          .from('inventory_transactions')
          .select('id, transaction_date, transaction_type, quantity, reference_type, reference_id, reversal_of, remarks, items(item_code)')
          .gte('transaction_date', since)
          .order('transaction_date')
          .order('created_at'),
      ),
      all(() => db.from('withdrawals').select('id, withdrawal_no, customer').gte('entry_date', since)),
      all(() => db.from('receipts').select('id, mrr_no, supplier').gte('entry_date', since)),
      db.from('auto_withdrawal_runs').select('ran_at, status, posted, held, failed, message, details').order('ran_at', { ascending: false }).limit(1).maybeSingle(),
      all(() => db.from('purchase_orders').select('po_no, po_date, supplier, item_code, description, quantity, unit, eta, status').not('status', 'in', '("Received","Cancelled")')),
      all(() => db.from('po_shipments').select('po_no, supplier, item_code, description, quantity, unit, ship_date, eta, status').neq('status', 'Received')),
    ])
    if (year.error) throw new Error(year.error.message)
    if (run.error) throw new Error(run.error.message)

    // Same average as the Stocks tab: Withdrawn ÷ months in the stock year so far.
    const start = year.data?.start_date as string | undefined
    const now = new Date(today)
    const months = start
      ? Math.max(1, (now.getFullYear() - Number(start.slice(0, 4))) * 12 + now.getMonth() + 1 - Number(start.slice(5, 7)) + 1)
      : now.getMonth() + 1

    const items = stock.map((r) => ({
      code: r.item_code,
      description: r.description,
      size: size(r),
      uom: r.uom,
      category: r.category,
      on_hand: num(r.on_hand),
      low_level: num(r.low_stock_level),
      beginning: num(r.beginning),
      received: num(r.received),
      withdrawn: num(r.withdrawn),
      avg_per_month: Math.round((Number(r.withdrawn) / months) * 100) / 100,
      last_movement_at: r.last_movement_at,
    }))

    const docs = new Map<string, Record<string, unknown>>()
    for (const w of withdrawals) docs.set(w.id as string, { ref: w.withdrawal_no, party: w.customer })
    for (const r of receipts) docs.set(r.id as string, { ref: r.mrr_no, party: r.supplier })
    const reversed = new Set(ledger.filter((t) => t.reversal_of).map((t) => t.reversal_of as string))

    const movements = ledger
      .filter((t) => t.transaction_type !== 'REVERSAL')
      .map((t) => {
        const doc = docs.get(t.reference_id as string)
        return {
          date: t.transaction_date,
          type: t.transaction_type,
          code: (t.items as { item_code?: string } | null)?.item_code ?? null,
          qty: num(t.quantity),
          voided: reversed.has(t.id as string),
          ref: doc?.ref ?? null,
          party: doc?.party ?? null,
          remarks: t.remarks,
        }
      })

    return Response.json({
      generated_at: new Date().toISOString(),
      today,
      stock_year_start: start ?? null,
      months_in_average: months,
      movement_days: days,
      items,
      movements,
      auto_withdrawals: run.data ?? null,
      open_purchase_orders: orders,
      incoming_shipments: shipments,
    })
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
})
