import { useCallback, useEffect, useMemo, useState } from 'react'
import { errorMessage, supabase } from '../../lib/supabase'
import { useRealtime } from '../../lib/useRealtime'
import { formatQty, formatSize, type StockRow } from '../../lib/types'
import { ItemHistory } from './ItemHistory'

export function StocksPage() {
  const [rows, setRows] = useState<StockRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [hideZero, setHideZero] = useState(false)
  const [selected, setSelected] = useState<StockRow | null>(null)

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('current_stock').select('*').eq('active', true).order('item_code')
    if (error) setError(errorMessage(error))
    else {
      setError(null)
      setRows(data as StockRow[])
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])
  useRealtime(['inventory_transactions', 'items'], load)

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter(
      (r) =>
        (!hideZero || Number(r.on_hand) !== 0) &&
        (!q || r.item_code.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)),
    )
  }, [rows, query, hideZero])

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <h1 className="page-title mb-0">Stocks</h1>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1 text-sm text-slate-600">
            <input type="checkbox" checked={hideZero} onChange={(e) => setHideZero(e.target.checked)} />
            Hide zero stock
          </label>
          <input className="input w-64" placeholder="Search code or description…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Item Code</th>
              <th>Description</th>
              <th>Size</th>
              <th className="text-right">Beginning</th>
              <th className="text-right">Received</th>
              <th className="text-right">Withdrawn</th>
              <th className="text-right">On Hand</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={7} className="text-center text-slate-400 py-8">
                  Loading…
                </td>
              </tr>
            )}
            {!loading && visible.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center text-slate-400 py-8">
                  No items.
                </td>
              </tr>
            )}
            {visible.map((r) => (
              <tr key={r.item_id} className="cursor-pointer hover:bg-slate-50" onClick={() => setSelected(r)}>
                <td className="font-mono font-semibold">{r.item_code}</td>
                <td>{r.description}</td>
                <td className="whitespace-nowrap">{formatSize(r)}</td>
                <td className="text-right">{formatQty(r.beginning)}</td>
                <td className="text-right">{formatQty(r.received)}</td>
                <td className="text-right">{formatQty(r.withdrawn)}</td>
                <td className={`text-right font-semibold ${Number(r.on_hand) <= 0 ? 'text-red-600' : ''}`}>{formatQty(r.on_hand)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-slate-400">Click an item to see why its stock is what it is. Updates live.</p>

      {selected && <ItemHistory item={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}
