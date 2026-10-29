import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { formatQty, type StockRow } from '../lib/types'

interface Props {
  value: StockRow | null
  onChange: (item: StockRow | null) => void
  /** Override the unit shown next to on-hand (e.g. "roll" in Split & Withdraw), instead of the item's stocking UOM. */
  unitLabel?: string
  /** Called after an item is chosen with the keyboard (Enter), e.g. to move focus to the next field. */
  onPickedWithKeyboard?: () => void
}

/**
 * Item-code autocomplete. Searches code + description, shows on-hand stock.
 * Picking an item (click, or typing the exact code and pressing Enter) fills
 * its Description/Width/Length/UOM back into the form automatically.
 */
export function ItemPicker({ value, onChange, unitLabel, onPickedWithKeyboard }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<StockRow[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1) // keyboard-highlighted suggestion

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
      setActive(-1)
    }, 200)
    return () => clearTimeout(t)
  }, [query])

  if (value) {
    return (
      <div className="flex items-center justify-between rounded border border-slate-300 bg-slate-50 px-3 py-2">
        {/* Description / W / L already show in the form's own fields — only the code and stock here. */}
        <div className="font-mono font-semibold truncate" title={value.description}>
          {value.item_code}
        </div>
        <div className="ml-auto pl-3 whitespace-nowrap text-sm">
          <span className="text-xs text-slate-500">On hand </span>
          <span className="font-semibold">{formatQty(value.on_hand)}</span>
          {(unitLabel ?? value.uom) && <span className="text-xs text-slate-500"> {unitLabel ?? value.uom}</span>}
        </div>
        <button
          type="button"
          className="ml-3 -mr-1 rounded px-1.5 text-lg leading-none text-slate-400 hover:bg-slate-200 hover:text-slate-700"
          onClick={() => onChange(null)}
          title="Change item"
          aria-label="Change item"
        >
          ×
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
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            if (results.length === 0) return
            e.preventDefault()
            setOpen(true)
            const step = e.key === 'ArrowDown' ? 1 : -1
            setActive((i) => (i + step + results.length) % results.length)
            return
          }
          if (e.key === 'Escape') return setOpen(false)
          if (e.key !== 'Enter') return
          e.preventDefault() // don't submit the form while still picking an item
          const pick = (open && results[active]) || results.find((r) => r.item_code.toLowerCase() === query.trim().toLowerCase())
          if (pick) {
            onChange(pick)
            setQuery('')
            setOpen(false)
            onPickedWithKeyboard?.()
          }
        }}
      />
      {open && results.length > 0 && (
        <ul className="absolute z-10 mt-1 w-full max-h-72 overflow-auto rounded border border-slate-200 bg-white shadow-lg">
          {results.map((r, n) => (
            <li key={r.item_id}>
              <button
                type="button"
                className={`w-full text-left px-3 py-2 hover:bg-slate-100 flex justify-between gap-2 ${n === active ? 'bg-slate-100' : ''}`}
                ref={(el) => {
                  if (n === active) el?.scrollIntoView({ block: 'nearest' })
                }}
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
                  {formatQty(r.on_hand)} {unitLabel ?? r.uom}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
