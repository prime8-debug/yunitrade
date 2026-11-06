import { useCallback, useEffect, useState } from 'react'
import { errorMessage, supabase } from '../../lib/supabase'
import { formatQty } from '../../lib/types'
import { useRealtime } from '../../lib/useRealtime'
import { AUTO_ENABLED_KEY, AUTO_REMARK, AUTO_START_KEY } from '../../../../supabase/functions/_shared/autoWithdrawals.ts'

const STALE_MINUTES = 15

interface Run {
  id: number
  ran_at: string
  status: 'off' | 'waiting' | 'ok' | 'error'
  posted: number
  held: number
  failed: number
  message: string | null
}

interface AutoPost {
  id: string
  entry_date: string
  quantity: number
  withdrawal_no: string
  customer: string | null
  item: { item_code: string } | null
}

interface YearRow {
  start_date: string
  items_closed: number
  closed_at: string
}

/** ADMIN-only: start date and on/off for automatic withdrawals, the year-end clear, and what the job did. */
export function AutoWithdrawals() {
  const [start, setStart] = useState('')
  const [clearDate, setClearDate] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [year, setYear] = useState<YearRow | null>(null)
  const [runs, setRuns] = useState<Run[]>([])
  const [posts, setPosts] = useState<AutoPost[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const loadActivity = useCallback(async () => {
    const [yearRes, runRes, postRes] = await Promise.all([
      supabase.from('stock_years').select('start_date, items_closed, closed_at').order('start_date', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('auto_withdrawal_runs').select('*').order('ran_at', { ascending: false }).limit(10),
      supabase
        .from('withdrawals')
        .select('id, entry_date, quantity, withdrawal_no, customer, item:items(item_code)')
        .eq('remarks', AUTO_REMARK)
        .is('voided_at', null)
        .order('created_at', { ascending: false })
        .limit(30),
    ])
    const failed = yearRes.error ?? runRes.error ?? postRes.error
    if (failed) return setError(errorMessage(failed))
    setYear(yearRes.data as YearRow | null)
    setRuns((runRes.data as Run[]) ?? [])
    setPosts((postRes.data as unknown as AutoPost[]) ?? [])
  }, [])

  const loadSettings = useCallback(async () => {
    const { data, error } = await supabase.from('app_settings').select('key, value').in('key', [AUTO_ENABLED_KEY, AUTO_START_KEY])
    if (error) setError(errorMessage(error))
    setStart(data?.find((s) => s.key === AUTO_START_KEY)?.value ?? '')
    setEnabled(data?.find((s) => s.key === AUTO_ENABLED_KEY)?.value === 'true')
    setLoading(false)
  }, [])

  useEffect(() => {
    loadSettings()
    loadActivity()
  }, [loadSettings, loadActivity])
  useRealtime(['withdrawals'], loadActivity)

  async function save(nextEnabled: boolean) {
    if (nextEnabled && !start) return setError('Choose a start date first.')
    if (nextEnabled && !window.confirm(`Turn on automatic withdrawals for sales orders dated ${start} onward? They will reduce stock with no review.`)) return
    setBusy(true)
    setMessage(null)
    const updated_at = new Date().toISOString()
    const { error } = await supabase.from('app_settings').upsert([
      { key: AUTO_START_KEY, value: start, updated_at },
      { key: AUTO_ENABLED_KEY, value: String(nextEnabled), updated_at },
    ])
    setBusy(false)
    if (error) return setError(errorMessage(error))
    setError(null)
    setEnabled(nextEnabled)
    setMessage(nextEnabled ? `On: orders dated ${start} onward post automatically.` : 'Automatic withdrawals are off.')
  }

  async function clearYear() {
    if (!clearDate) return setError('Choose the new beginning date first.')
    const typed = window.prompt(
      `Clear the year and start from ${clearDate}?\n\nEverything dated before ${clearDate} is hidden and stock for those records goes to 0, ` +
        `so enter the new Beginning count right after. Old records are kept. Yards and Partial stock are not changed. ` +
        `The automation start date also moves to ${clearDate}.\n\nType ${clearDate} to confirm:`,
    )
    if (typed === null) return
    if (typed.trim() !== clearDate) return setError('The date did not match — nothing was cleared.')
    setBusy(true)
    setMessage(null)
    const { data, error } = await supabase.rpc('start_stock_year', { p_start: clearDate })
    setBusy(false)
    if (error) return setError(errorMessage(error))
    setError(null)
    setClearDate('')
    setMessage(`Cleared ${data} items. Now enter the new Beginning stock.`)
    loadSettings()
    loadActivity()
  }

  async function undoYear() {
    if (!year || !window.confirm(`Undo the clear that started ${year.start_date}? Old records and stock come back.`)) return
    setBusy(true)
    setMessage(null)
    const { error } = await supabase.rpc('undo_stock_year')
    setBusy(false)
    if (error) return setError(errorMessage(error))
    setError(null)
    setMessage('The clear was undone.')
    loadSettings()
    loadActivity()
  }

  async function voidListed() {
    // The orders still match, so the job would post them again on its next run.
    if (enabled) return setError('Turn off automatic withdrawals first, or these orders will post again within 5 minutes.')
    const n = posts.length
    if (!window.confirm(`Void these ${n} automatic withdrawal${n === 1 ? '' : 's'}? Stock is added back and they leave the Withdraw page.`)) return
    setBusy(true)
    setMessage(null)
    const failures: string[] = []
    for (const p of posts) {
      const { error } = await supabase.rpc('void_entry', { p_reference_type: 'withdrawals', p_reference_id: p.id, p_reason: 'Cleared from Automation' })
      if (error) failures.push(`${p.withdrawal_no}: ${errorMessage(error)}`)
    }
    setBusy(false)
    setError(failures.length ? `${failures.length} not voided — ${failures[0]}` : null)
    setMessage(`Voided ${n - failures.length}. They post again if automation is turned on with a start date on or before their dates.`)
    loadActivity()
  }

  if (loading) return <p className="text-slate-500">Loading…</p>

  const lastRun = runs[0]
  const stale = !lastRun || Date.now() - new Date(lastRun.ran_at).getTime() > STALE_MINUTES * 60_000

  return (
    <div className="space-y-6">
      <section className="card p-5 space-y-3 max-w-3xl">
        <h2 className="font-semibold">Automatic withdrawals</h2>
        {enabled && <p className="text-xs text-slate-400">To change the start date, turn this off first.</p>}
        <div className="flex flex-wrap items-end gap-3">
          <label>
            <span className="label">Start date</span>
            <input className="input w-44" type="date" value={start} disabled={enabled} onChange={(e) => setStart(e.target.value)} />
          </label>
          <button className={enabled ? 'btn-secondary' : 'btn-primary'} disabled={busy} onClick={() => save(!enabled)}>
            {enabled ? 'Turn off' : 'Turn on'}
          </button>
          <span className={`text-sm pb-2 ${enabled ? 'text-green-700' : 'text-slate-500'}`}>{enabled ? 'On' : 'Off'}</span>
        </div>
        <p className="text-sm text-slate-600">
          Orders that match with nothing to decide post on their own. Yards orders, orders that fit two items, unmatched orders and orders
          changed after posting wait in <b>Apply Withdrawals</b>. Orders short of stock post once stock arrives.
        </p>
        {stale ? (
          <p className="text-sm text-red-600">
            The automatic job {lastRun ? `last ran ${new Date(lastRun.ran_at).toLocaleString()}` : "hasn't run yet"}. It should run every 5 minutes.
          </p>
        ) : (
          <p className="text-xs text-slate-400">Last run {new Date(lastRun.ran_at).toLocaleString()}</p>
        )}
      </section>

      <section className="card p-5 space-y-3 max-w-3xl">
        <h2 className="font-semibold">Year-end clear</h2>
        <p className="text-sm text-slate-600">
          Choose the date of the new beginning stock whenever management sets it. Records dated before it are hidden and kept, Stocks counts
          from that date, and the automation start date moves to it. Do this after the count, then enter the new Beginning stock. It can be
          done from the day before that date.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label>
            <span className="label">New beginning date</span>
            <input className="input w-44" type="date" value={clearDate} onChange={(e) => setClearDate(e.target.value)} />
          </label>
          <button className="btn-secondary text-red-600" disabled={busy} onClick={clearYear}>
            Clear and start new year
          </button>
          {year && (
            <>
              <span className="text-sm text-slate-500">
                Current year started {year.start_date} ({year.items_closed} items cleared)
              </span>
              <button className="text-xs text-blue-600 underline" disabled={busy} onClick={undoYear}>
                Undo
              </button>
            </>
          )}
        </div>
      </section>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {message && <p className="text-sm text-green-700">{message}</p>}

      <section>
        <h2 className="font-semibold mb-2">Recent runs</h2>
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Result</th>
                <th className="text-right">Posted</th>
                <th className="text-right">Needs review</th>
                <th className="text-right">Failed</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap">{new Date(r.ran_at).toLocaleString()}</td>
                  <td className={r.status === 'error' ? 'text-red-600' : ''}>{r.status}</td>
                  <td className="text-right">{r.posted}</td>
                  <td className="text-right">{r.held}</td>
                  <td className="text-right">{r.failed}</td>
                  <td className="text-sm">{r.message}</td>
                </tr>
              ))}
              {runs.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-center text-slate-400 py-6">
                    No runs yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-semibold">Recent automatic withdrawals</h2>
          {posts.length > 0 && (
            <button className="text-xs text-red-600 underline" disabled={busy} onClick={voidListed}>
              Clear (void these)
            </button>
          )}
        </div>
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Job Order</th>
                <th>Item</th>
                <th className="text-right">Quantity</th>
                <th>Customer</th>
              </tr>
            </thead>
            <tbody>
              {posts.map((p) => (
                <tr key={p.id}>
                  <td className="whitespace-nowrap">{p.entry_date}</td>
                  <td className="font-mono font-semibold whitespace-nowrap">{p.withdrawal_no}</td>
                  <td className="font-mono whitespace-nowrap">{p.item?.item_code}</td>
                  <td className="text-right">{formatQty(p.quantity)}</td>
                  <td>{p.customer}</td>
                </tr>
              ))}
              {posts.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-center text-slate-400 py-6">
                    None yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
