import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useAuth } from '../../auth/AuthProvider'
import { ItemPicker } from '../../components/ItemPicker'
import { ItemsCatalog } from '../../components/ItemsCatalog'
import { BeginningAdjustmentLog } from './BeginningAdjustmentLog'
import { errorMessage, supabase } from '../../lib/supabase'
import { useRealtime } from '../../lib/useRealtime'
import { useSalesOrders } from '../../lib/useSalesOrders'
import { formatQty, type StockRow } from '../../lib/types'
import type { MovementConfig } from './configs'

const today = () => new Date().toLocaleDateString('en-CA') // YYYY-MM-DD in local time

/** A roll's catalog length expressed in yards (items list length in yd / m / ft), for Send to Yards. */
function lengthInYards(length: number | null | undefined, unit: string | null | undefined): string {
  if (length == null) return ''
  const u = (unit ?? '').trim().toLowerCase()
  const yards = u.startsWith('y') || u === '' ? length : u === 'm' ? length * 1.0936133 : u.startsWith('f') ? length / 3 : u.startsWith('in') ? length / 36 : length
  return String(Math.round(yards * 100) / 100)
}

interface RecentRow {
  id: string
  entry_date: string
  quantity: number
  voided_at: string | null
  // The entry's own description/size (added after some records already existed —
  // those fall back to the item's defaults, shown via the joined `item` below).
  description: string | null
  width: number | null
  width_unit: string | null
  length: number | null
  length_unit: string | null
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

export function MovementPage({ config, hideTitle }: { config: MovementConfig; hideTitle?: boolean }) {
  const { isAdmin } = useAuth()
  const [item, setItem] = useState<StockRow | null>(null)
  const [date, setDate] = useState(today)
  const [quantity, setQuantity] = useState('')
  const [width, setWidth] = useState('')
  const [length, setLength] = useState('')
  const [description, setDescription] = useState('')
  const [extra, setExtra] = useState<Record<string, string>>({})
  // Withdraw only: open ONE whole roll from main stock into Yards Stock instead of withdrawing it to a customer.
  const canSendToYards = config.table === 'withdrawals'
  const [toYards, setToYards] = useState(false)
  const [coreNo, setCoreNo] = useState('')
  const [yards, setYards] = useState('')
  const quantityRef = useRef<HTMLInputElement>(null)
  const salesOrders = useSalesOrders()
  // Withdrawal No. suggestions: Job Orders from the Sales Orders sheet matching what's typed (prefix matches first).
  const typedNo = (extra.withdrawal_no ?? '').trim().toLowerCase()
  const jobOrderSuggestions = useMemo(() => {
    if (config.table !== 'withdrawals' || typedNo.length < 2) return []
    const seen = new Set<string>()
    const starts: typeof salesOrders = []
    const contains: typeof salesOrders = []
    for (const o of salesOrders) {
      const j = o.jobOrder.toLowerCase()
      if (seen.has(j) || !j.includes(typedNo)) continue
      seen.add(j)
      ;(j.startsWith(typedNo) ? starts : contains).push(o)
    }
    return [...starts, ...contains].slice(0, 15)
  }, [config.table, typedNo, salesOrders])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [recent, setRecent] = useState<RecentRow[]>([])
  const [recentQuery, setRecentQuery] = useState('')

  // Selecting an item defaults Width/Length to its usual size — still editable
  // per entry (e.g. a custom-cut length shorter than the full roll).
  function pickItem(next: StockRow | null) {
    setItem(next)
    setWidth(next?.width?.toString() ?? '')
    setLength(next?.length?.toString() ?? '')
    setDescription(next?.description ?? '')
    setYards(lengthInYards(next?.length, next?.length_unit))
  }

  function setSendToYards(on: boolean) {
    setToYards(on)
    if (on) setQuantity('1')
  }

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

  const visibleRecent = recentQuery.trim()
    ? recent.filter((r) => {
        const q = recentQuery.trim().toLowerCase()
        const haystack = [r.item?.item_code, r.item?.description, r.description, ...config.fields.map((f) => r[f.name])]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        return haystack.includes(q)
      })
    : recent

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!item) return setMessage({ kind: 'error', text: 'Select an item first.' })
    if (!(qty > 0)) return setMessage({ kind: 'error', text: 'Quantity must be greater than 0.' })

    if (toYards) {
      const y = Number(yards)
      if (!(y > 0)) return setMessage({ kind: 'error', text: 'Yards must be greater than 0.' })
      setBusy(true)
      setMessage(null)
      const { error } = await supabase.rpc('send_roll_to_yards', {
        p_item_id: item.item_id,
        p_yards: y,
        p_roll_no: coreNo.trim() || null,
        p_width: width.trim() === '' ? null : Number(width),
        p_entry_date: date,
        p_remarks: extra.remarks?.trim() || null,
      })
      setBusy(false)
      if (error) return setMessage({ kind: 'error', text: errorMessage(error) })
      setMessage({ kind: 'ok', text: `Sent 1 roll of ${item.item_code} to Yards Stock (${formatQty(y)} yd${coreNo.trim() ? `, Core No. ${coreNo.trim()}` : ''}).` })
      pickItem(null)
      setCoreNo('')
      setExtra({})
      return
    }

    setBusy(true)
    setMessage(null)
    const params: Record<string, unknown> = {
      p_item_id: item.item_id,
      p_quantity: qty,
      p_entry_date: date,
      p_width: width.trim() === '' ? null : Number(width),
      p_width_unit: item.width_unit ?? null,
      p_length: length.trim() === '' ? null : Number(length),
      p_length_unit: item.length_unit ?? null,
      p_description: description.trim() || null,
    }
    for (const f of config.fields) params[f.param] = extra[f.name]?.trim() || null

    const { error } = await supabase.rpc(config.rpc, params)
    setBusy(false)
    if (error) return setMessage({ kind: 'error', text: errorMessage(error) })

    setMessage({ kind: 'ok', text: `${config.title} saved: ${item.item_code} × ${formatQty(qty)}` })
    pickItem(null)
    setQuantity('')
    setExtra({})
  }

  function clearForm() {
    pickItem(null)
    setDate(today())
    setQuantity(toYards ? '1' : '')
    setCoreNo('')
    setExtra({})
    setMessage(null)
  }

  async function voidEntry(row: RecentRow) {
    const reason = window.prompt(`Void this ${config.title.toLowerCase()} for ${row.item?.item_code} × ${formatQty(row.quantity)}?\nReason:`)
    if (reason === null) return
    const { error } = await supabase.rpc('void_entry', { p_reference_type: config.table, p_reference_id: row.id, p_reason: reason || null })
    if (error) setMessage({ kind: 'error', text: errorMessage(error) })
  }

  return (
    <div className="space-y-6">
      {!hideTitle && <h1 className="page-title">{config.title}</h1>}

      <form onSubmit={submit} className="card p-5 grid gap-4 md:grid-cols-2 lg:grid-cols-6">
        <div className="md:col-span-2 lg:col-span-3">
          <span className="label">Item</span>
          <ItemPicker value={item} onChange={pickItem} onPickedWithKeyboard={() => setTimeout(() => quantityRef.current?.focus(), 0)} />
        </div>
        <label className="md:col-span-2 lg:col-span-3">
          <span className="label">Description</span>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label>
          <span className="label">Quantity {item?.uom && <span className="text-slate-400">({item.uom})</span>}</span>
          <input
            ref={quantityRef}
            className={`input ${overStock ? 'border-red-500' : ''}`}
            type="number"
            step="any"
            min="0"
            required
            readOnly={toYards}
            title={toYards ? 'Send to Yards opens one roll at a time' : undefined}
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            onKeyDown={(e) => {
              // Withdraw / Received: Tab from Quantity jumps straight to Withdrawal No. / MRR No. (Width/Length/Date are pre-filled).
              if (e.key !== 'Tab' || e.shiftKey || (config.table !== 'withdrawals' && config.table !== 'receipts')) return
              const next = e.currentTarget.form?.querySelector<HTMLInputElement>('[data-first-extra]')
              if (next) {
                e.preventDefault()
                next.focus()
              }
            }}
          />
          {overStock && <span className="text-xs text-red-600">More than on hand ({formatQty(item!.on_hand)})</span>}
        </label>
        <label>
          <span className="label">Width {item?.width_unit && <span className="text-slate-400">({item.width_unit})</span>}</span>
          <input className="input" type="number" step="any" min="0" value={width} onChange={(e) => setWidth(e.target.value)} />
        </label>
        <label>
          <span className="label">Length {item?.length_unit && <span className="text-slate-400">({item.length_unit})</span>}</span>
          <input className="input" type="number" step="any" min="0" value={length} onChange={(e) => setLength(e.target.value)} />
        </label>
        <label>
          <span className="label">Date</span>
          <input className="input" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        {canSendToYards && (
          <label className="flex items-center gap-2 self-end pb-2">
            <input type="checkbox" checked={toYards} onChange={(e) => setSendToYards(e.target.checked)} />
            <span className="text-sm text-slate-700">Send to Yards</span>
          </label>
        )}
        {toYards && (
          <>
            <label>
              <span className="label">Core No.</span>
              <input className="input" data-first-extra value={coreNo} onChange={(e) => setCoreNo(e.target.value)} />
            </label>
            <label>
              <span className="label">Yards</span>
              <input className="input" type="number" step="any" min="0" required value={yards} onChange={(e) => setYards(e.target.value)} />
            </label>
          </>
        )}
        {config.fields.filter((f) => !toYards || f.name === 'remarks').map((f, n) => (
          <label key={f.name} className={f.wide ? 'md:col-span-2 lg:col-span-2' : ''}>
            <span className="label">{f.label}</span>
            <input
              className="input"
              {...(n === 0 && !toYards ? { 'data-first-extra': true } : {})}
              {...(f.name === 'withdrawal_no' ? { list: 'job-order-suggestions', autoComplete: 'off' } : {})}
              value={extra[f.name] ?? ''}
              data-field={f.name}
              onKeyDown={(e) => {
                // Withdraw: Enter in Withdrawal No. moves on to Remarks instead of submitting the form.
                if (e.key !== 'Enter' || f.name !== 'withdrawal_no') return
                const remarks = e.currentTarget.form?.querySelector<HTMLInputElement>('[data-field="remarks"]')
                if (!remarks) return
                e.preventDefault()
                remarks.focus()
              }}
              onChange={(e) => {
                const value = e.target.value
                const next = { ...extra, [f.name]: value }
                // Picking (or typing in full) a Job Order from the Sales Orders sheet fills in its customer.
                if (f.name === 'withdrawal_no' && config.fields.some((x) => x.name === 'customer')) {
                  const match = jobOrderSuggestions.find((o) => o.jobOrder.toLowerCase() === value.trim().toLowerCase())
                  if (match?.customer) next.customer = match.customer
                }
                setExtra(next)
              }}
            />
          </label>
        ))}
        <datalist id="job-order-suggestions">
          {jobOrderSuggestions.map((o) => (
            <option key={o.jobOrder} value={o.jobOrder} label={[o.customer, o.itemId, o.quantity].filter(Boolean).join(' · ')} />
          ))}
        </datalist>
        <div className="md:col-span-2 lg:col-span-6 flex items-center gap-3">
          <button className="btn-primary" disabled={busy || overStock}>
            {busy ? 'Saving…' : toYards ? 'Send 1 Roll to Yards' : `Save ${config.title}`}
          </button>
          <button type="button" className="btn-secondary" onClick={clearForm} disabled={busy}>
            Clear
          </button>
          {message && <span className={`text-sm ${message.kind === 'ok' ? 'text-green-700' : 'text-red-600'}`}>{message.text}</span>}
        </div>
      </form>

      {config.showCatalog ? (
        <div className="space-y-6">
          <div>
            <h2 className="font-semibold text-slate-700 mb-2">Items</h2>
            <p className="text-xs text-slate-400 mb-2">
              Type a Beginning quantity directly in the table — press Enter or click away to save. Changing an already-set balance
              requires a reason and is logged below.
            </p>
            <ItemsCatalog editableBeginning={config.table === 'beginning_inventory'} />
          </div>
          <BeginningAdjustmentLog />
        </div>
      ) : (
        <div>
          <h2 className="font-semibold text-slate-700 mb-2">Recent entries</h2>
          <input
            className="input w-64 mb-2"
            placeholder="Filter by item, code, customer…"
            value={recentQuery}
            onChange={(e) => setRecentQuery(e.target.value)}
          />
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
                {visibleRecent.map((r) => (
                  <tr key={r.id} className={r.voided_at ? 'opacity-50 line-through' : ''}>
                    <td className="whitespace-nowrap">{r.entry_date}</td>
                    <td>
                      <span className="font-mono font-semibold">{r.item?.item_code}</span>{' '}
                      <span className="text-slate-500">{r.description ?? r.item?.description}</span>
                    </td>
                    <td className="text-right">{r.width ?? r.item?.width ?? ''}</td>
                    <td>{r.width_unit ?? r.item?.width_unit ?? ''}</td>
                    <td className="text-right">{r.length ?? r.item?.length ?? ''}</td>
                    <td>{r.length_unit ?? r.item?.length_unit ?? ''}</td>
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
                {visibleRecent.length === 0 && (
                  <tr>
                    <td colSpan={8 + config.fields.length} className="text-center text-slate-400 py-6">
                      {recent.length === 0 ? 'No entries yet.' : 'No entries match that filter.'}
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
