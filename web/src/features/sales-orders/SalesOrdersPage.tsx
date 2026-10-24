import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { errorMessage, supabase } from '../../lib/supabase'
import { formatQty } from '../../lib/types'
import { toOrders, type OrderRow } from './salesSheet'

const SETTING_KEY = 'sales_sheet_csv_url'
const PAGE_SIZE = 200
const AUTO_REFRESH_MS = 5 * 60 * 1000 // Google only re-publishes the CSV every ~5 minutes anyway

/** ADMIN-only, read-only view of the Sales Order Google Sheet (via its "Publish to web" CSV link). */
export function SalesOrdersPage() {
  const [url, setUrl] = useState<string | null | undefined>(undefined) // undefined = still loading the setting
  const [editingUrl, setEditingUrl] = useState(false)
  const [urlDraft, setUrlDraft] = useState('')

  const [orders, setOrders] = useState<OrderRow[]>([])
  const [loading, setLoading] = useState(false)
  const [loadedAt, setLoadedAt] = useState<Date | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [shown, setShown] = useState(PAGE_SIZE)

  const loadSetting = useCallback(async () => {
    const { data, error } = await supabase.from('app_settings').select('value').eq('key', SETTING_KEY).maybeSingle()
    if (error) return setError(errorMessage(error))
    setUrl(data?.value || null)
  }, [])
  useEffect(() => {
    loadSetting()
  }, [loadSetting])

  const loadSheet = useCallback(async () => {
    if (!url) return
    setLoading(true)
    try {
      const res = await fetch(url, { cache: 'no-store' })
      if (!res.ok) throw new Error(`Google Sheets returned ${res.status} — is the sheet still published to the web?`)
      setOrders(toOrders(await res.text()))
      setLoadedAt(new Date())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [url])
  useEffect(() => {
    loadSheet()
    const t = setInterval(loadSheet, AUTO_REFRESH_MS)
    return () => clearInterval(t)
  }, [loadSheet])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return orders
    return orders.filter((o) => [o.date, o.jobOrder, o.customer, o.itemId].join(' ').toLowerCase().includes(q))
  }, [orders, query])

  async function saveUrl(e: FormEvent) {
    e.preventDefault()
    const value = urlDraft.trim()
    if (!/^https:\/\/docs\.google\.com\/spreadsheets\/.+output=csv/.test(value)) {
      return setError('Paste the link from File → Share → Publish to web, with the format set to CSV (it ends in output=csv).')
    }
    const { error } = await supabase.from('app_settings').upsert({ key: SETTING_KEY, value, updated_at: new Date().toISOString() })
    if (error) return setError(errorMessage(error))
    setError(null)
    setEditingUrl(false)
    setUrl(value)
  }

  if (url === undefined && !error) return <p className="text-slate-500">Loading…</p>

  if (!url || editingUrl) {
    return (
      <div className="space-y-6">
        <h1 className="page-title">Sales Orders</h1>
        <form onSubmit={saveUrl} className="card p-5 space-y-3 max-w-3xl">
          <p className="text-sm text-slate-600">
            In Google Sheets: <b>File → Share → Publish to web</b>, pick the Sales Order tab, choose <b>Comma-separated values (.csv)</b>,
            then paste the link here. Anyone with this link can read the sheet, so it's stored ADMIN-only and never put in the app's code.
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
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <h1 className="page-title">Sales Orders</h1>
      <p className="-mt-4 text-sm text-slate-500">
        Read-only, live from the Google Sheet — edit orders there. Google refreshes the published copy about every 5 minutes.
      </p>

      <div>
        <div className="flex flex-wrap items-center gap-3 mb-2">
          <input
            className="input w-64"
            placeholder="Filter by date, job order, customer, item…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setShown(PAGE_SIZE)
            }}
          />
          <button className="btn-secondary" onClick={loadSheet} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
          <span className="text-xs text-slate-400">
            {loadedAt && `${orders.length.toLocaleString()} rows · loaded ${loadedAt.toLocaleTimeString()}`}
          </span>
          <button
            className="text-xs text-blue-600 underline ml-auto"
            onClick={() => {
              setUrlDraft(url)
              setEditingUrl(true)
            }}
          >
            Change sheet link
          </button>
        </div>
        {error && <p className="text-sm text-red-600 mb-2">{error}</p>}
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Job Order</th>
                <th>Customer</th>
                <th className="text-right">Quantity</th>
                <th className="text-right">Width</th>
                <th>Unit (W)</th>
                <th className="text-right">Length</th>
                <th>Unit (L)</th>
                <th>Item ID</th>
              </tr>
            </thead>
            <tbody>
              {visible.slice(0, shown).map((o) => (
                <tr key={o.key}>
                  <td className="whitespace-nowrap">{o.date}</td>
                  <td className="font-mono font-semibold whitespace-nowrap">{o.jobOrder}</td>
                  <td>{o.customer}</td>
                  <td className="text-right">{o.quantity && !isNaN(Number(o.quantity)) ? formatQty(Number(o.quantity)) : o.quantity}</td>
                  <td className="text-right">{o.width}</td>
                  <td>{o.widthUnit}</td>
                  <td className="text-right">{o.length}</td>
                  <td>{o.lengthUnit}</td>
                  <td className="font-mono whitespace-nowrap">{o.itemId}</td>
                </tr>
              ))}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={9} className="text-center text-slate-400 py-6">
                    {loading ? 'Loading…' : orders.length === 0 ? 'No orders in the sheet.' : 'No orders match that filter.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {visible.length > shown && (
          <button className="btn-secondary mt-2" onClick={() => setShown((n) => n + PAGE_SIZE)}>
            Show more ({(visible.length - shown).toLocaleString()} left)
          </button>
        )}
      </div>
    </div>
  )
}
