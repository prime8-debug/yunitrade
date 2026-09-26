import { useCallback, useEffect, useMemo, useState } from 'react'
import { errorMessage, supabase } from '../lib/supabase'
import { useRealtime } from '../lib/useRealtime'
import { formatQty, formatSize, type StockRow } from '../lib/types'

interface Props {
  /** Let the Beginning column be typed into directly (see BeginningCell below). */
  editableBeginning?: boolean
}

/**
 * Read-only, filterable list of all active items — same columns as the Items
 * admin page, minus the edit/delete actions, plus current stock. Any
 * signed-in user can see this (not admin-only): it's a reference list, not a
 * place to change item master data.
 */
export function ItemsCatalog({ editableBeginning }: Props) {
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
              {!editableBeginning && <th>Category</th>}
              <th className="text-right">{editableBeginning ? 'Quantity' : 'Beginning'}</th>
              <th className="text-right">On Hand</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((i) =>
              editableBeginning ? (
                <BeginningRow key={i.item_id} item={i} />
              ) : (
                <tr key={i.item_id}>
                  <td className="font-mono font-semibold">{i.item_code}</td>
                  <td>{i.description}</td>
                  <td className="whitespace-nowrap">{formatSize(i)}</td>
                  <td>{i.uom}</td>
                  <td>{i.category}</td>
                  <td className="text-right">{formatQty(i.beginning)}</td>
                  <td className={`text-right font-semibold ${Number(i.on_hand) <= 0 ? 'text-red-600' : ''}`}>{formatQty(i.on_hand)}</td>
                </tr>
              ),
            )}
            {visible.length === 0 && (
              <tr>
                <td colSpan={editableBeginning ? 6 : 7} className="text-center text-slate-400 py-6">
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

function BeginningRow({ item }: { item: StockRow }) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function commit(raw: string, revert: () => void) {
    setError(null)
    const next = Number(raw)
    if (raw.trim() === '' || !Number.isFinite(next) || next < 0) return revert()
    const delta = next - Number(item.beginning)
    if (delta === 0) return

    // The ledger is append-only: we can only ever ADD a Beginning entry, never
    // rewrite one. Raising the number posts the difference; lowering it needs
    // an ADMIN to void the original entry first, so it's refused here.
    if (delta < 0) {
      setError(`Can't lower below ${formatQty(item.beginning)} here — an ADMIN must void the existing entry first.`)
      return revert()
    }

    setSaving(true)
    const { error } = await supabase.rpc('post_beginning', {
      p_item_id: item.item_id,
      p_quantity: delta,
      p_notes: 'Set via item catalog (Beginning tab)',
    })
    setSaving(false)
    if (error) {
      setError(errorMessage(error))
      revert()
    }
    // On success the row re-renders with the new `beginning` from realtime, which
    // remounts the input (see key below) so it picks up the confirmed value.
  }

  return (
    <tr>
      <td className="font-mono font-semibold">{item.item_code}</td>
      <td>{item.description}</td>
      <td className="whitespace-nowrap">{formatSize(item)}</td>
      <td>{item.uom}</td>
      <td className="text-right">
        <input
          key={`${item.item_id}-${item.beginning}`}
          className={`input w-24 text-right py-1 ${error ? 'border-red-500' : ''}`}
          type="number"
          step="any"
          min="0"
          disabled={saving}
          defaultValue={item.beginning}
          onBlur={(e) => commit(e.target.value, () => (e.target.value = String(item.beginning)))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              e.currentTarget.value = String(item.beginning)
              e.currentTarget.blur()
            }
          }}
        />
        {error && <div className="text-xs text-red-600 text-left mt-1 whitespace-normal max-w-48">{error}</div>}
      </td>
      <td className={`text-right font-semibold ${Number(item.on_hand) <= 0 ? 'text-red-600' : ''}`}>{formatQty(item.on_hand)}</td>
    </tr>
  )
}
