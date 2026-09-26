import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { formatQty, type StockRow } from '../lib/types'

interface Props {
  value: StockRow | null
  onChange: (item: StockRow | null) => void
}

/**
 * Item-code autocomplete. Searches code + description, shows on-hand stock.
 * Picking an item (click, or typing the exact code and pressing Enter) fills
 * its Description/Width/Length/UOM back into the form automatically.
 */
export function ItemPicker({ value, onChange }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<StockRow[]>([])
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setResults([])
      return
    }
    const escaped = q.replace(/[%_,()]/g, ' ')
    const t = setTimeout(async () => {
      const { data } = await supabase
        .from('current_stock')
        .select('*')
        .eq('active', true)
        .or(`item_code.ilike.%${escaped}%,description.ilike.%${escaped}%`)
        .order('item_code')
        .limit(15)
      setResults((data as StockRow[]) ?? [])
    }, 200)
    return () => clearTimeout(t)
  }, [query])

  if (value) {
    return (
      <div className="flex items-center justify-between rounded border border-slate-300 bg-slate-50 px-3 py-2">
        <div>
          <div className="font-mono font-semibold">{value.item_code}</div>
          <div className="text-xs text-slate-500">{value.description}</div>
        </div>
        {/* W / L come from the item master — display only, never re-entered here. */}
        <div className="flex items-center gap-4 px-4">
          <div className="text-right">
            <div className="text-xs text-slate-500">W ({value.width_unit ?? '—'})</div>
            <div className="font-semibold">{value.width ?? '—'}</div>
          </div>
          <div className="text-right">
            <div className="text-xs text-slate-500">L ({value.length_unit ?? '—'})</div>
            <div className="font-semibold">{value.length ?? '—'}</div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs text-slate-500">On hand</div>
          <div className="font-semibold">
            {formatQty(value.on_hand)} {value.uom && <span className="text-xs font-normal text-slate-500">{value.uom}</span>}
          </div>
        </div>
        <button type="button" className="ml-3 text-sm text-blue-600 underline" onClick={() => onChange(null)}>
          Change
        </button>
      </div>
    )
  }

  return (
    <div className="relative">
      <input
        className="input"
        placeholder="Type item code or description…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          e.preventDefault() // don't submit the form while still picking an item
          const exact = results.find((r) => r.item_code.toLowerCase() === query.trim().toLowerCase())
          if (exact) {
            onChange(exact)
            setQuery('')
            setOpen(false)
          }
        }}
      />
      {open && results.length > 0 && (
        <ul className="absolute z-10 mt-1 w-full max-h-72 overflow-auto rounded border border-slate-200 bg-white shadow-lg">
          {results.map((r) => (
            <li key={r.item_id}>
              <button
                type="button"
                className="w-full text-left px-3 py-2 hover:bg-slate-100 flex justify-between gap-2"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(r)
                  setQuery('')
                  setOpen(false)
                }}
              >
                <span>
                  <span className="font-mono font-semibold">{r.item_code}</span>{' '}
                  <span className="text-sm text-slate-500">{r.description}</span>
                </span>
                <span className="text-sm text-slate-600 whitespace-nowrap">
                  {formatQty(r.on_hand)} {r.uom}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
