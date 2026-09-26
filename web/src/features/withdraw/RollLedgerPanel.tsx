import { useCallback, useEffect, useState } from 'react'
import { ItemPicker } from '../../components/ItemPicker'
import { errorMessage, supabase } from '../../lib/supabase'
import { useRealtime } from '../../lib/useRealtime'
import { formatQty, type StockRow } from '../../lib/types'
import type { RollLedgerConfig } from './rollLedgerConfigs'

const today = () => new Date().toLocaleDateString('en-CA')

interface RollRow {
  roll_id: string
  roll_no: string | null
  item_id: string
  item_code: string
  description: string
  uom: string | null
  active: boolean
  [remainingField: string]: unknown
}

/**
 * Shared UI for 3M Yards and Partial Rolls: create a roll with a starting
 * quantity, then withdraw from it over time. Deliberately its own ledger,
 * separate from the main items/inventory_transactions stock — see the
 * migration comment for why (open business question, plan §44).
 */
export function RollLedgerPanel({ config }: { config: RollLedgerConfig }) {
  const [rolls, setRolls] = useState<RollRow[]>([])
  const [rollQuery, setRollQuery] = useState('')

  // Create-roll form
  const [newItem, setNewItem] = useState<StockRow | null>(null)
  const [newRollNo, setNewRollNo] = useState('')
  const [newQty, setNewQty] = useState('')
  const [newRemarks, setNewRemarks] = useState('')
  const [creating, setCreating] = useState(false)
  const [createMsg, setCreateMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  // Withdraw form
  const [roll, setRoll] = useState<RollRow | null>(null)
  const [rollSearchOpen, setRollSearchOpen] = useState(false)
  const [date, setDate] = useState(today)
  const [qty, setQty] = useState('')
  const [customer, setCustomer] = useState('')
  const [remarks, setRemarks] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const load = useCallback(async () => {
    const { data } = await supabase.from(config.stockView).select('*').eq('active', true).order('item_code')
    setRolls((data as RollRow[]) ?? [])
  }, [config.stockView])
  useEffect(() => {
    load()
  }, [load])
  useRealtime([config.rollTable, config.transactionsTable], load)

  const remaining = (r: RollRow) => Number(r[config.remainingField] ?? 0)

  const matches = rollQuery.trim()
    ? rolls.filter(
        (r) =>
          r.item_code.toLowerCase().includes(rollQuery.trim().toLowerCase()) ||
          (r.roll_no ?? '').toLowerCase().includes(rollQuery.trim().toLowerCase()),
      )
    : rolls

  async function createRoll(e: React.FormEvent) {
    e.preventDefault()
    if (!newItem) return setCreateMsg({ kind: 'error', text: 'Select an item first.' })
    const n = Number(newQty)
    if (!(n > 0)) return setCreateMsg({ kind: 'error', text: `${config.unitLabel} must be greater than 0.` })

    setCreating(true)
    setCreateMsg(null)
    const { error } = await supabase.rpc(config.createRpc, {
      p_item_id: newItem.item_id,
      [config.createQtyParam]: n,
      p_roll_no: newRollNo.trim() || null,
      p_entry_date: date,
      p_remarks: newRemarks.trim() || null,
    })
    setCreating(false)
    if (error) return setCreateMsg({ kind: 'error', text: errorMessage(error) })

    setCreateMsg({ kind: 'ok', text: `Roll created for ${newItem.item_code}.` })
    setNewItem(null)
    setNewRollNo('')
    setNewQty('')
    setNewRemarks('')
  }

  const withdrawQty = Number(qty)
  const overStock = roll != null && withdrawQty > remaining(roll)

  async function withdraw(e: React.FormEvent) {
    e.preventDefault()
    if (!roll) return setSaveMsg({ kind: 'error', text: 'Select a roll first.' })
    if (!(withdrawQty > 0)) return setSaveMsg({ kind: 'error', text: `${config.unitLabel} must be greater than 0.` })

    setSaving(true)
    setSaveMsg(null)
    const { error } = await supabase.rpc(config.withdrawRpc, {
      [config.rollIdParam]: roll.roll_id,
      p_quantity: withdrawQty,
      p_entry_date: date,
      p_customer: customer.trim() || null,
      p_remarks: remarks.trim() || null,
    })
    setSaving(false)
    if (error) return setSaveMsg({ kind: 'error', text: errorMessage(error) })

    setSaveMsg({ kind: 'ok', text: `Withdrew ${formatQty(withdrawQty)} from ${roll.item_code}${roll.roll_no ? ` (${roll.roll_no})` : ''}.` })
    setRoll(null)
    setQty('')
    setCustomer('')
    setRemarks('')
  }

  return (
    <div className="space-y-6">
      <div className="card p-5">
        <h2 className="font-semibold text-slate-700 mb-3">Add Roll ({config.title})</h2>
        <form onSubmit={createRoll} className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
          <div className="lg:col-span-2">
            <span className="label">Item</span>
            <ItemPicker value={newItem} onChange={setNewItem} />
          </div>
          <label>
            <span className="label">Roll No.</span>
            <input className="input max-w-xs" value={newRollNo} onChange={(e) => setNewRollNo(e.target.value)} />
          </label>
          <label>
            <span className="label">{config.unitLabel}</span>
            <input className="input max-w-xs" type="number" step="any" min="0" value={newQty} onChange={(e) => setNewQty(e.target.value)} />
          </label>
          <label>
            <span className="label">Remarks</span>
            <input className="input" value={newRemarks} onChange={(e) => setNewRemarks(e.target.value)} />
          </label>
          <div className="md:col-span-2 lg:col-span-5 flex items-center gap-3">
            <button className="btn-primary" disabled={creating}>
              {creating ? 'Saving…' : 'Add Roll'}
            </button>
            {createMsg && <span className={`text-sm ${createMsg.kind === 'ok' ? 'text-green-700' : 'text-red-600'}`}>{createMsg.text}</span>}
          </div>
        </form>
      </div>

      <div className="card p-5">
        <h2 className="font-semibold text-slate-700 mb-3">Withdraw {config.title}</h2>
        <form onSubmit={withdraw} className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
          <div className="lg:col-span-2 relative">
            <span className="label">Roll</span>
            {roll ? (
              <div className="flex items-center justify-between rounded border border-slate-300 bg-slate-50 px-3 py-2">
                <div>
                  <div className="font-mono font-semibold">
                    {roll.item_code} {roll.roll_no && <span className="text-slate-500">· {roll.roll_no}</span>}
                  </div>
                  <div className="text-xs text-slate-500">{roll.description}</div>
                </div>
                <div className="text-right">
                  <div className="text-xs text-slate-500">Remaining</div>
                  <div className="font-semibold">
                    {formatQty(remaining(roll))} {roll.uom}
                  </div>
                </div>
                <button type="button" className="ml-3 text-sm text-blue-600 underline" onClick={() => setRoll(null)}>
                  Change
                </button>
              </div>
            ) : (
              <>
                <input
                  className="input"
                  placeholder="Type item code or roll no…"
                  value={rollQuery}
                  onChange={(e) => setRollQuery(e.target.value)}
                  onFocus={() => setRollSearchOpen(true)}
                  onBlur={() => setTimeout(() => setRollSearchOpen(false), 150)}
                />
                {rollSearchOpen && matches.length > 0 && (
                  <ul className="absolute z-10 mt-1 w-full max-h-72 overflow-auto rounded border border-slate-200 bg-white shadow-lg">
                    {matches.map((r) => (
                      <li key={r.roll_id}>
                        <button
                          type="button"
                          className="w-full text-left px-3 py-2 hover:bg-slate-100 flex justify-between gap-2"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            setRoll(r)
                            setRollQuery('')
                            setRollSearchOpen(false)
                          }}
                        >
                          <span>
                            <span className="font-mono font-semibold">{r.item_code}</span>{' '}
                            {r.roll_no && <span className="text-slate-500">· {r.roll_no}</span>}
                          </span>
                          <span className="text-sm text-slate-600 whitespace-nowrap">
                            {formatQty(remaining(r))} {r.uom}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
          <label>
            <span className="label">Date</span>
            <input className="input max-w-xs" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label>
            <span className="label">{config.unitLabel}</span>
            <input
              className={`input max-w-xs ${overStock ? 'border-red-500' : ''}`}
              type="number"
              step="any"
              min="0"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
            />
            {overStock && <span className="text-xs text-red-600">More than remaining ({formatQty(remaining(roll!))})</span>}
          </label>
          <label>
            <span className="label">Customer</span>
            <input className="input max-w-xs" value={customer} onChange={(e) => setCustomer(e.target.value)} />
          </label>
          <label className="md:col-span-2 lg:col-span-1">
            <span className="label">Remarks</span>
            <input className="input" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
          </label>
          <div className="md:col-span-2 lg:col-span-5 flex items-center gap-3">
            <button className="btn-primary" disabled={saving || overStock}>
              {saving ? 'Saving…' : `Withdraw ${config.unitLabel}`}
            </button>
            {saveMsg && <span className={`text-sm ${saveMsg.kind === 'ok' ? 'text-green-700' : 'text-red-600'}`}>{saveMsg.text}</span>}
          </div>
        </form>
      </div>

      <div>
        <h2 className="font-semibold text-slate-700 mb-2">{config.title} Rolls</h2>
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Item Code</th>
                <th>Description</th>
                <th>Roll No.</th>
                <th>UOM</th>
                <th className="text-right">Remaining</th>
              </tr>
            </thead>
            <tbody>
              {rolls.map((r) => (
                <tr key={r.roll_id}>
                  <td className="font-mono font-semibold">{r.item_code}</td>
                  <td>{r.description}</td>
                  <td>{r.roll_no}</td>
                  <td>{r.uom}</td>
                  <td className={`text-right font-semibold ${remaining(r) <= 0 ? 'text-red-600' : ''}`}>{formatQty(remaining(r))}</td>
                </tr>
              ))}
              {rolls.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-center text-slate-400 py-6">
                    No rolls yet — add one above.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
