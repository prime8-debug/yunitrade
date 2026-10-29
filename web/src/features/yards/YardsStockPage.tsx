import { useCallback, useEffect, useMemo, useState } from 'react'
import { errorMessage, supabase } from '../../lib/supabase'
import { useRealtime } from '../../lib/useRealtime'
import { formatQty } from '../../lib/types'

interface YardsRow {
  roll_id: string
  core_no: string | null
  item_code: string
  description: string
  width: number | null
  width_unit: string | null
  total_received: number
  total_withdrawn: number
  available_balance: number
}

/** Per-roll Yards stock: what came in, what went out, what's left. Rolls are created/withdrawn under Withdraw → Yards. */
export function YardsStockPage() {
  const [rows, setRows] = useState<YardsRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [hideZero, setHideZero] = useState(false)

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('yards_stock_summary').select('*').eq('active', true).order('item_code').order('core_no')
    if (error) setError(errorMessage(error))
    else {
      setError(null)
      setRows(data as YardsRow[])
    }
    setLoading(false)
  }, [])
  useEffect(() => {
    load()
  }, [load])
  useRealtime(['yards_rolls', 'yards_transactions'], load)

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter(
      (r) =>
        (!hideZero || Number(r.available_balance) !== 0) &&
        (!q || [r.core_no, r.item_code, r.description].filter(Boolean).join(' ').toLowerCase().includes(q)),
    )
  }, [rows, query, hideZero])

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <h1 className="page-title mb-0">Yards Stock</h1>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1 text-sm text-slate-600">
            <input type="checkbox" checked={hideZero} onChange={(e) => setHideZero(e.target.checked)} />
            Hide zero balance
          </label>
          <input className="input w-64" placeholder="Search core no., item, description…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Core No.</th>
              <th>Item ID</th>
              <th>Description</th>
              <th className="text-right">Width</th>
              <th>W-UM</th>
              <th className="text-right">Total Received (yd)</th>
              <th className="text-right">Total Withdrawn (yd)</th>
              <th className="text-right">Available Balance (yd)</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.roll_id}>
                <td className="font-mono font-semibold whitespace-nowrap">{r.core_no}</td>
                <td className="font-mono whitespace-nowrap">{r.item_code}</td>
                <td>{r.description}</td>
                <td className="text-right">{r.width}</td>
                <td>{r.width_unit}</td>
                <td className="text-right">{formatQty(r.total_received)}</td>
                <td className="text-right">{formatQty(r.total_withdrawn)}</td>
                <td className="text-right font-semibold">{formatQty(r.available_balance)}</td>
              </tr>
            ))}
            {!loading && visible.length === 0 && (
              <tr>
                <td colSpan={8} className="text-center text-slate-400 py-6">
                  {rows.length === 0 ? 'No yards rolls yet — add one under Withdraw → Yards.' : 'No rolls match that filter.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
