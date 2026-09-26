import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../../auth/AuthProvider'
import { ItemPicker } from '../../components/ItemPicker'
import { ItemsCatalog } from '../../components/ItemsCatalog'
import { errorMessage, supabase } from '../../lib/supabase'
import { useRealtime } from '../../lib/useRealtime'
import { formatQty, type StockRow } from '../../lib/types'
import type { MovementConfig } from './configs'

const today = () => new Date().toLocaleDateString('en-CA') // YYYY-MM-DD in local time

interface RecentRow {
  id: string
  entry_date: string
  quantity: number
  voided_at: string | null
  item: {
    item_code: string
    description: string
    width: number | null
    width_unit: string | null
    length: number | null
    length_unit: string | null
  } | null
  [field: string]: unknown
}

export function MovementPage({ config }: { config: MovementConfig }) {
  const { isAdmin } = useAuth()
  const [item, setItem] = useState<StockRow | null>(null)
  const [date, setDate] = useState(today)
  const [quantity, setQuantity] = useState('')
  const [extra, setExtra] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [recent, setRecent] = useState<RecentRow[]>([])

  const loadRecent = useCallback(async () => {
    if (config.showCatalog) return
    const { data } = await supabase
      .from(config.table)
      .select('*, item:items(item_code, description, width, width_unit, length, length_unit)')
      .order('created_at', { ascending: false })
      .limit(50)
    setRecent((data as RecentRow[]) ?? [])
  }, [config.table, config.showCatalog])

  useEffect(() => {
    loadRecent()
  }, [loadRecent])
  useRealtime(config.showCatalog ? [] : [config.table], loadRecent)

  const qty = Number(quantity)
  const overStock = config.checksStock && item != null && qty > Number(item.on_hand)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!item) return setMessage({ kind: 'error', text: 'Select an item first.' })
    if (!(qty > 0)) return setMessage({ kind: 'error', text: 'Quantity must be greater than 0.' })

    setBusy(true)
    setMessage(null)
    const params: Record<string, unknown> = { p_item_id: item.item_id, p_quantity: qty, p_entry_date: date }
    for (const f of config.fields) params[f.param] = extra[f.name]?.trim() || null

    const { error } = await supabase.rpc(config.rpc, params)
    setBusy(false)
    if (error) return setMessage({ kind: 'error', text: errorMessage(error) })

    setMessage({ kind: 'ok', text: `${config.title} saved: ${item.item_code} × ${formatQty(qty)}` })
    setItem(null)
    setQuantity('')
    setExtra({})
  }

  async function voidEntry(row: RecentRow) {
    const reason = window.prompt(`Void this ${config.title.toLowerCase()} for ${row.item?.item_code} × ${formatQty(row.quantity)}?\nReason:`)
    if (reason === null) return
    const { error } = await supabase.rpc('void_entry', { p_reference_type: config.table, p_reference_id: row.id, p_reason: reason || null })
    if (error) setMessage({ kind: 'error', text: errorMessage(error) })
  }

  return (
    <div className="space-y-6">
      <h1 className="page-title">{config.title}</h1>

      <form onSubmit={submit} className="card p-5 grid gap-4 md:grid-cols-2 max-w-2xl">
        <div className="md:col-span-2">
          <span className="label">Item</span>
          <ItemPicker value={item} onChange={setItem} />
        </div>
        <label>
          <span className="label">Date</span>
          <input className="input" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label>
          <span className="label">Quantity {item?.uom && <span className="text-slate-400">({item.uom})</span>}</span>
          <input
            className={`input ${overStock ? 'border-red-500' : ''}`}
            type="number"
            step="any"
            min="0"
            required
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
          {overStock && <span className="text-xs text-red-600">More than on hand ({formatQty(item!.on_hand)})</span>}
        </label>
        {config.fields.map((f) => (
          <label key={f.name} className={f.wide ? 'md:col-span-2' : ''}>
            <span className="label">{f.label}</span>
            <input className="input" value={extra[f.name] ?? ''} onChange={(e) => setExtra({ ...extra, [f.name]: e.target.value })} />
          </label>
        ))}
        <div className="md:col-span-2 flex items-center gap-3">
          <button className="btn-primary" disabled={busy || overStock}>
            {busy ? 'Saving…' : `Save ${config.title}`}
          </button>
          {message && <span className={`text-sm ${message.kind === 'ok' ? 'text-green-700' : 'text-red-600'}`}>{message.text}</span>}
        </div>
      </form>

      {config.showCatalog ? (
        <div>
          <h2 className="font-semibold text-slate-700 mb-2">Items</h2>
          <ItemsCatalog />
        </div>
      ) : (
        <div>
          <h2 className="font-semibold text-slate-700 mb-2">Recent entries</h2>
          <div className="card overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Item</th>
                  <th className="text-right">W</th>
                  <th>W-UM</th>
                  <th className="text-right">L</th>
                  <th>L-UM</th>
                  <th className="text-right">Qty</th>
                  {config.fields.map((f) => (
                    <th key={f.name}>{f.label}</th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.id} className={r.voided_at ? 'opacity-50 line-through' : ''}>
                    <td className="whitespace-nowrap">{r.entry_date}</td>
                    <td>
                      <span className="font-mono font-semibold">{r.item?.item_code}</span>{' '}
                      <span className="text-slate-500">{r.item?.description}</span>
                    </td>
                    <td className="text-right">{r.item?.width ?? ''}</td>
                    <td>{r.item?.width_unit ?? ''}</td>
                    <td className="text-right">{r.item?.length ?? ''}</td>
                    <td>{r.item?.length_unit ?? ''}</td>
                    <td className="text-right">{formatQty(r.quantity)}</td>
                    {config.fields.map((f) => (
                      <td key={f.name}>{String(r[f.name] ?? '')}</td>
                    ))}
                    <td className="text-right whitespace-nowrap no-underline">
                      {r.voided_at ? (
                        <span className="badge">VOID</span>
                      ) : (
                        isAdmin && (
                          <button className="text-xs text-red-600 underline" onClick={() => voidEntry(r)}>
                            Void
                          </button>
                        )
                      )}
                    </td>
                  </tr>
                ))}
                {recent.length === 0 && (
                  <tr>
                    <td colSpan={8 + config.fields.length} className="text-center text-slate-400 py-6">
                      No entries yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
