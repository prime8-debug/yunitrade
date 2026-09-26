import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useRealtime } from '../lib/useRealtime'
import { formatQty, formatSize, type StockRow } from '../lib/types'

/**
 * Read-only, filterable list of all active items — same columns as the Items
 * admin page, minus the edit/delete actions, plus current on-hand stock.
 * Any signed-in user can see this (not admin-only): it's a reference list,
 * not a place to change item master data.
 */
export function ItemsCatalog() {
  const [items, setItems] = useState<StockRow[]>([])
  const [query, setQuery] = useState('')

  const load = useCallback(async () => {
    const { data } = await supabase.from('current_stock').select('*').eq('active', true).order('item_code')
    setItems((data as StockRow[]) ?? [])
  }, [])
  useEffect(() => {
    load()
  }, [load])
  useRealtime(['items', 'inventory_transactions'], load)

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? items.filter((i) => i.item_code.toLowerCase().includes(q) || i.description.toLowerCase().includes(q)) : items
  }, [items, query])

  return (
    <div>
      <input className="input w-64 mb-2" placeholder="Filter items…" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Item Code</th>
              <th>Description</th>
              <th>Size</th>
              <th>UOM</th>
              <th>Category</th>
              <th className="text-right">On Hand</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((i) => (
              <tr key={i.item_id}>
                <td className="font-mono font-semibold">{i.item_code}</td>
                <td>{i.description}</td>
                <td className="whitespace-nowrap">{formatSize(i)}</td>
                <td>{i.uom}</td>
                <td>{i.category}</td>
                <td className={`text-right font-semibold ${Number(i.on_hand) <= 0 ? 'text-red-600' : ''}`}>{formatQty(i.on_hand)}</td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center text-slate-400 py-6">
                  No items.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
