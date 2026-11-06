import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { errorMessage, supabase } from '../../lib/supabase'
import { formatQty, type StockRow } from '../../lib/types'
import { refreshSalesOrders, useSalesOrdersState } from '../../lib/useSalesOrders'
import { AUTO_START_KEY, LOOKUP_URL_KEY, loadWithdrawn } from '../../../../supabase/functions/_shared/autoWithdrawals.ts'
import { buildPlan, toLookup, withdrawalParams, withdrawnKey, type LookupRow, type PlanRow, type YardsRoll } from './salesWithdrawals'

const REMARK = 'From Sales Orders'

const today = () => new Date().toLocaleDateString('en-CA')

const STATE_STYLE: Record<PlanRow['state'], string> = {
  ready: 'text-green-700',
  input: 'text-amber-700',
  blocked: 'text-red-600',
  done: 'text-slate-400',
  changed: 'text-red-600',
}

/** Turns a date range of sales orders into withdrawals, after a review. ADMIN-only (inside Sales Orders). */
export function ApplyWithdrawals() {
  const { orders, loading: sheetLoading, error: sheetError } = useSalesOrdersState()
  const [url, setUrl] = useState<string | null | undefined>(undefined)
  const [editingUrl, setEditingUrl] = useState(false)
  const [urlDraft, setUrlDraft] = useState('')

  const [lookup, setLookup] = useState<LookupRow[]>([])
  const [items, setItems] = useState<StockRow[]>([])
  const [rolls, setRolls] = useState<YardsRoll[]>([])
  const [withdrawn, setWithdrawn] = useState<Map<string, number>>(new Map())
  const [hideDone, setHideDone] = useState(true)
  const [from, setFrom] = useState(today)
  const [to, setTo] = useState(today)
  const [itemChoice, setItemChoice] = useState<Record<string, string>>({})
  const [coreChoice, setCoreChoice] = useState<Record<string, string>>({})
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})

  const [loading, setLoading] = useState(true)
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  // Always work from the latest sheet here, not the copy saved in this browser.
  useEffect(() => {
    refreshSalesOrders(true)
  }, [])

  useEffect(() => {
    supabase
      .from('app_settings')
      .select('key, value')
      .in('key', [LOOKUP_URL_KEY, AUTO_START_KEY])
      .then(({ data, error }) => {
        if (error) setError(errorMessage(error))
        setUrl(data?.find((s) => s.key === LOOKUP_URL_KEY)?.value || null)
        // With automation set up, what's left to review is everything since it started.
        const start = data?.find((s) => s.key === AUTO_START_KEY)?.value
        if (start && start < today()) setFrom(start)
      })
  }, [])

  const rangeJobOrders = useMemo(
    () => [...new Set(orders.filter((o) => o.date >= from && o.date <= to).map((o) => o.jobOrder))],
    [orders, from, to],
  )

  const load = useCallback(async () => {
    if (!url) return
    setLoading(true)
    try {
      const res = await fetch(url, { cache: 'no-store' })
      if (!res.ok) throw new Error(`Google Sheets returned ${res.status} — is the lookup tab still published to the web?`)
      const nextLookup = toLookup(await res.text())
      const [{ data: stock, error: stockError }, { data: rollData, error: rollError }] = await Promise.all([
        supabase.from('current_stock').select('*').eq('active', true),
        supabase.from('yards_roll_stock').select('roll_id, roll_no, item_id, item_code, active, remaining_yards'),
      ])
      if (stockError || rollError) throw new Error(errorMessage(stockError ?? rollError))
      const nextRolls = (rollData as YardsRoll[]) ?? []
      const nextWithdrawn = await loadWithdrawn(supabase, rangeJobOrders, nextRolls)
      setLookup(nextLookup)
      setItems((stock as StockRow[]) ?? [])
      setRolls(nextRolls)
      setWithdrawn(nextWithdrawn)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [url, rangeJobOrders])
  useEffect(() => {
    load()
  }, [load])

  const plan = useMemo(
    () => buildPlan({ orders, lookup, from, to, items, rolls, withdrawn, itemChoice, coreChoice, excluded }),
    [orders, lookup, from, to, items, rolls, withdrawn, itemChoice, coreChoice, excluded],
  )
  const toPost = plan.filter((p) => p.state === 'ready' && !excluded.has(p.order.key))
  const count = (state: PlanRow['state']) => plan.filter((p) => p.state === state).length
  const shown = hideDone ? plan.filter((p) => p.state !== 'done') : plan

  function changeRange(nextFrom: string, nextTo: string) {
    setFrom(nextFrom)
    setTo(nextTo)
    setItemChoice({})
    setCoreChoice({})
    setExcluded(new Set())
    setRowErrors({})
    setMessage(null)
  }

  function toggleExcluded(key: string) {
    setExcluded((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }

  async function saveUrl(e: FormEvent) {
    e.preventDefault()
    const value = urlDraft.trim()
    if (!/^https:\/\/docs\.google\.com\/spreadsheets\/.+output=csv/.test(value)) {
      return setError('Paste the link from File → Share → Publish to web, with the format set to CSV (it ends in output=csv).')
    }
    const { error } = await supabase.from('app_settings').upsert({ key: LOOKUP_URL_KEY, value, updated_at: new Date().toISOString() })
    if (error) return setError(errorMessage(error))
    setError(null)
    setEditingUrl(false)
    setUrl(value)
  }

  async function postOne(p: PlanRow) {
    const { order: o, roll, quantity } = p
    if (roll) {
      return supabase.rpc('withdraw_yards', {
        p_roll_id: roll.roll_id,
        p_quantity: quantity,
        p_entry_date: o.date,
        p_customer: o.customer || null,
        p_remarks: REMARK,
        p_withdrawal_no: o.jobOrder,
      })
    }
    return supabase.rpc('post_sales_order_withdrawal', withdrawalParams(p, REMARK))
  }

  async function post() {
    const dated = from === to ? `dated ${from}` : `using each order's own date (${from} to ${to})`
    if (!window.confirm(`Post ${toPost.length} withdrawal${toPost.length === 1 ? '' : 's'} ${dated}? This reduces stock.`)) return
    setPosting(true)
    setMessage(null)
    const errors: Record<string, string> = {}
    let posted = 0
    let skipped = 0
    try {
      // Re-check right before posting, in case someone withdrew one of these in the meantime.
      const latest = await loadWithdrawn(supabase, rangeJobOrders, rolls)
      for (const p of toPost) {
        const itemId = p.roll?.item_id ?? p.item!.item_id
        if (latest.has(withdrawnKey(p.order.jobOrder, itemId))) {
          skipped++
          continue
        }
        const { error } = await postOne(p)
        if (error) errors[p.order.key] = errorMessage(error)
        else posted++
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setRowErrors(errors)
    const failed = Object.keys(errors).length
    setMessage(
      [`Posted ${posted}`, skipped ? `${skipped} already withdrawn` : '', failed ? `${failed} failed — see the rows below` : '']
        .filter(Boolean)
        .join(' · '),
    )
    setPosting(false)
    await load()
  }

  if (url === undefined) return <p className="text-slate-500">Loading…</p>

  if (!url || editingUrl) {
    return (
      <form onSubmit={saveUrl} className="card p-5 space-y-3 max-w-3xl">
        <p className="text-sm text-slate-600">
          In Google Sheets: <b>File → Share → Publish to web</b>, pick the <b>ITEMCODE V2 SBASE</b> tab, choose{' '}
          <b>Comma-separated values (.csv)</b>, then paste the link here. It's stored ADMIN-only.
        </p>
        <input className="input font-mono text-xs" placeholder="https://docs.google.com/spreadsheets/d/e/…/pub?…output=csv" value={urlDraft} onChange={(e) => setUrlDraft(e.target.value)} />
        <div className="flex items-center gap-3">
          <button className="btn-primary">Save link</button>
          {url && (
            <button type="button" className="btn-secondary" onClick={() => setEditingUrl(false)}>
              Cancel
            </button>
          )}
          {error && <span className="text-sm text-red-600">{error}</span>}
        </div>
      </form>
    )
  }

  const busy = loading || sheetLoading

  return (
    <div>
      <div className="flex flex-wrap items-end gap-4 mb-3">
        <label>
          <span className="label">From</span>
          <input className="input w-44" type="date" value={from} onChange={(e) => changeRange(e.target.value, to)} />
        </label>
        <label>
          <span className="label">To</span>
          <input className="input w-44" type="date" value={to} onChange={(e) => changeRange(from, e.target.value)} />
        </label>
        <button className="btn-primary" onClick={post} disabled={posting || busy || toPost.length === 0}>
          {posting ? 'Posting…' : `Post ${toPost.length} Withdrawal${toPost.length === 1 ? '' : 's'}`}
        </button>
        <span className="text-xs text-slate-400 pb-2">
          {busy
            ? 'Loading the latest sheets…'
            : `${count('ready')} ready · ${count('input')} need input · ${count('blocked')} can't post · ${count('changed')} changed in the sheet · ${count('done')} already withdrawn`}
        </span>
        <label className="flex items-center gap-1 text-xs text-slate-500 pb-2">
          <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} />
          Hide already withdrawn
        </label>
        <button
          className="text-xs text-blue-600 underline ml-auto pb-2"
          onClick={() => {
            setUrlDraft(url)
            setEditingUrl(true)
          }}
        >
          Change lookup link
        </button>
      </div>

      {(error || sheetError) && <p className="text-sm text-red-600 mb-2">{error ?? sheetError}</p>}
      {message && <p className="text-sm text-green-700 mb-2">{message}</p>}

      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th />
              <th>Date</th>
              <th>Job Order</th>
              <th>Customer</th>
              <th>Sales Order Item</th>
              <th>Size</th>
              <th className="text-right">Quantity</th>
              <th>Unit</th>
              <th>Status</th>
              <th>Withdraw From</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => {
              const { order: o } = p
              const rowError = rowErrors[o.key]
              return (
                <tr key={o.key}>
                  <td>
                    {p.state === 'ready' && (
                      <input
                        type="checkbox"
                        aria-label={`Include ${o.jobOrder}`}
                        checked={!excluded.has(o.key)}
                        onChange={() => toggleExcluded(o.key)}
                      />
                    )}
                  </td>
                  <td className="whitespace-nowrap">{o.date}</td>
                  <td className="font-mono font-semibold whitespace-nowrap">{o.jobOrder}</td>
                  <td>{o.customer}</td>
                  <td>
                    <div className="font-mono whitespace-nowrap">{o.itemId}</div>
                    <div className="text-xs text-slate-500">{o.itemDescription}</div>
                  </td>
                  <td className="whitespace-nowrap">
                    {[o.width && `${o.width} ${o.widthUnit}`.trim(), o.length && `${o.length} ${o.lengthUnit}`.trim()].filter(Boolean).join(' × ')}
                  </td>
                  <td className="text-right">{formatQty(p.quantity)}</td>
                  <td>{o.unit}</td>
                  <td>{o.status}</td>
                  <td className="whitespace-nowrap">
                    {p.state !== 'done' && p.state !== 'changed' && p.target === 'yards' && (
                      <div className="flex items-center gap-2">
                        <input
                          className="input w-24"
                          placeholder="Core No."
                          aria-label={`Core No. for ${o.jobOrder}`}
                          value={coreChoice[o.key] ?? ''}
                          onChange={(e) => setCoreChoice((c) => ({ ...c, [o.key]: e.target.value }))}
                        />
                        <span className="text-xs text-slate-500">{p.roll?.item_code ?? p.candidates.join(' / ')}</span>
                      </div>
                    )}
                    {p.state !== 'done' && p.state !== 'changed' && p.target === 'stock' && p.candidates.length > 1 && (
                      <select
                        className="input"
                        aria-label={`Item for ${o.jobOrder}`}
                        value={itemChoice[o.key] ?? ''}
                        onChange={(e) => setItemChoice((c) => ({ ...c, [o.key]: e.target.value }))}
                      >
                        <option value="">Choose…</option>
                        {p.candidates.map((c) => (
                          <option key={c}>{c}</option>
                        ))}
                      </select>
                    )}
                    {p.target === 'stock' && p.candidates.length === 1 && <span className="font-mono">{p.candidates[0]}</span>}
                  </td>
                  <td className={`text-sm ${rowError ? 'text-red-600' : STATE_STYLE[p.state]}`}>{rowError ?? (p.note || 'Ready')}</td>
                </tr>
              )
            })}
            {shown.length === 0 && (
              <tr>
                <td colSpan={11} className="text-center text-slate-400 py-6">
                  {busy ? 'Loading…' : from > to ? 'The To date is before the From date.' : plan.length ? 'Everything for these dates is already withdrawn.' : 'No lookup items in the sales orders for these dates.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
