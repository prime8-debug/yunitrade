import { toOrders } from './salesSheet.ts'
import { buildPlan, toLookup, withdrawalParams, withdrawnKey, type PlanItem, type PlanRow, type YardsRoll } from './salesWithdrawals.ts'

export const AUTO_REMARK = 'Auto from Sales Orders'
export const SALES_URL_KEY = 'sales_sheet_csv_url'
export const LOOKUP_URL_KEY = 'item_lookup_csv_url'
export const AUTO_ENABLED_KEY = 'auto_withdrawal_enabled'
export const AUTO_START_KEY = 'auto_withdrawal_start'

// A normal run posts a handful. Far more than this means a wrong start date or a bad sheet edit.
export const MAX_POSTS_PER_RUN = 100
// A long list of job orders would overflow the request URL, so check them in batches.
const BATCH_SIZE = 300

/** The parts of a Supabase client used here (the browser and the job each pass their own). */
export interface Db {
  // deno-lint-ignore no-explicit-any
  from(table: string): any
  // deno-lint-ignore no-explicit-any
  rpc(fn: string, args?: Record<string, unknown>): any
}

/** One order a run held for review or couldn't post. */
export interface RunDetail {
  kind: 'review' | 'failed'
  date: string
  job_order: string
  customer: string
  item: string
  quantity: number
  unit: string
  note: string
}

export interface RunResult {
  status: 'off' | 'waiting' | 'ok' | 'error'
  posted: number
  held: number
  failed: number
  message: string | null
  details?: RunDetail[]
}

function runDetail(kind: RunDetail['kind'], p: PlanRow, note: string): RunDetail {
  const { order: o, quantity } = p
  return { kind, date: o.date, job_order: o.jobOrder, customer: o.customer, item: o.itemId, quantity, unit: o.unit, note }
}

async function loadWithdrawnBatch(db: Db, jobOrders: string[], rolls: YardsRoll[], done: Map<string, number>) {
  const add = (jobOrder: string, itemId: string, quantity: number) => {
    const key = withdrawnKey(jobOrder, itemId)
    done.set(key, (done.get(key) ?? 0) + quantity)
  }

  const { data: main, error } = await db
    .from('withdrawals')
    .select('withdrawal_no, item_id, quantity')
    .in('withdrawal_no', jobOrders)
    .is('voided_at', null)
  if (error) throw new Error(error.message)
  for (const w of main ?? []) add(w.withdrawal_no, w.item_id, Number(w.quantity))

  const { data: yards, error: yardsError } = await db
    .from('yards_transactions')
    .select('id, roll_id, withdrawal_no, quantity')
    .in('withdrawal_no', jobOrders)
    .eq('transaction_type', 'WITHDRAWAL')
  if (yardsError) throw new Error(yardsError.message)
  // deno-lint-ignore no-explicit-any
  const yardsRows: any[] = yards ?? []
  const { data: reversals, error: reversalsError } = await db
    .from('yards_transactions')
    .select('reversal_of')
    .in('reversal_of', yardsRows.map((y) => y.id))
  if (reversalsError) throw new Error(reversalsError.message)
  // deno-lint-ignore no-explicit-any
  const reversed = new Set((reversals ?? []).map((r: any) => r.reversal_of))
  const rollItem = new Map(rolls.map((r) => [r.roll_id, r.item_id]))
  for (const y of yardsRows) {
    const itemId = rollItem.get(y.roll_id)
    if (itemId && !reversed.has(y.id)) add(y.withdrawal_no, itemId, -Number(y.quantity))
  }
}

/** "JOBORDER|item_id" → quantity live (not voided) on a withdrawal, from main stock or Yards. */
export async function loadWithdrawn(db: Db, jobOrders: string[], rolls: YardsRoll[]): Promise<Map<string, number>> {
  const done = new Map<string, number>()
  const batches: Promise<void>[] = []
  for (let i = 0; i < jobOrders.length; i += BATCH_SIZE) {
    batches.push(loadWithdrawnBatch(db, jobOrders.slice(i, i + BATCH_SIZE), rolls, done))
  }
  await Promise.all(batches)
  return done
}

/**
 * One run of the job: posts every sales order from the start date to today that passes the rules
 * with nothing to decide. Everything else stays in the Apply Withdrawals tab for a person.
 * Orders short of stock are simply picked up by a later run once stock arrives.
 */
export async function runAutoWithdrawals(db: Db, fetchText: (url: string) => Promise<string>, today: string): Promise<RunResult> {
  const result: RunResult = { status: 'ok', posted: 0, held: 0, failed: 0, message: null }

  const { data: settingRows, error: settingError } = await db
    .from('app_settings')
    .select('key, value')
    .in('key', [SALES_URL_KEY, LOOKUP_URL_KEY, AUTO_ENABLED_KEY, AUTO_START_KEY])
  if (settingError) throw new Error(settingError.message)
  // deno-lint-ignore no-explicit-any
  const settings = new Map<string, string>((settingRows ?? []).map((s: any) => [s.key, s.value]))

  const start = settings.get(AUTO_START_KEY)
  if (settings.get(AUTO_ENABLED_KEY) !== 'true' || !start) return { ...result, status: 'off' }
  if (today < start) return { ...result, status: 'waiting', message: `Starts ${start}` }

  const salesUrl = settings.get(SALES_URL_KEY)
  const lookupUrl = settings.get(LOOKUP_URL_KEY)
  if (!salesUrl || !lookupUrl) throw new Error('The Sales Orders or lookup sheet link is missing')

  const [orders, lookup] = await Promise.all([fetchText(salesUrl).then(toOrders), fetchText(lookupUrl).then(toLookup)])
  const [{ data: stock, error: stockError }, { data: rollData, error: rollError }] = await Promise.all([
    db.from('current_stock').select('*').eq('active', true),
    db.from('yards_roll_stock').select('roll_id, roll_no, item_id, item_code, active, remaining_yards'),
  ])
  if (stockError || rollError) throw new Error((stockError ?? rollError).message)
  const items = (stock as PlanItem[]) ?? []
  const rolls = (rollData as YardsRoll[]) ?? []

  const jobOrders = [...new Set(orders.filter((o) => o.date >= start && o.date <= today).map((o) => o.jobOrder))]
  const withdrawn = await loadWithdrawn(db, jobOrders, rolls)
  const plan = buildPlan({ orders, lookup, from: start, to: today, items, rolls, withdrawn, itemChoice: {}, coreChoice: {}, excluded: new Set() })

  const ready = plan.filter((p) => p.state === 'ready')
  const held = plan.filter((p) => p.state === 'input' || p.state === 'blocked' || p.state === 'changed')
  result.held = held.length
  result.details = held.map((p) => runDetail('review', p, p.note))
  if (ready.length > MAX_POSTS_PER_RUN) {
    throw new Error(`${ready.length} orders are ready at once, so nothing was posted. Check the start date and the sheet.`)
  }

  const failures: string[] = []
  for (const p of ready) {
    const { error } = await db.rpc('post_sales_order_withdrawal', withdrawalParams(p, AUTO_REMARK))
    if (!error) {
      result.posted++
    } else if (!error.message.startsWith('Already withdrawn')) {
      result.failed++
      failures.push(`${p.order.jobOrder}: ${error.message}`)
      result.details.push(runDetail('failed', p, error.message))
    }
  }
  if (failures.length) result.message = failures.slice(0, 5).join(' · ')
  return result
}
