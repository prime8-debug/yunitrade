import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../../auth/AuthProvider'
import { ItemPicker } from '../../components/ItemPicker'
import { errorMessage, supabase } from '../../lib/supabase'
import { useRealtime } from '../../lib/useRealtime'
import { isSuggestionPick, matchJobOrders, useSalesOrders } from '../../lib/useSalesOrders'
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

interface RollSize {
  width: number | null
  width_unit: string | null
  length: number | null
  length_unit: string | null
}

/**
 * Shared UI for 3M Yards and Partial Rolls: create a roll with a starting
 * quantity, then withdraw from it over time. Deliberately its own ledger,
 * separate from the main items/inventory_transactions stock — see the
 * migration comment for why (open business question, plan §44).
 */
export function RollLedgerPanel({ config, mode = 'all' }: { config: RollLedgerConfig; mode?: 'all' | 'add' | 'withdraw' }) {
  const { isAdmin } = useAuth()
  const showAdd = mode !== 'withdraw'
  const showWithdraw = mode !== 'add'
  const canEdit = showAdd && isAdmin && !!config.editRpc
  const [editing, setEditing] = useState<RollRow | null>(null)
  const [rolls, setRolls] = useState<RollRow[]>([])
  const [rollQuery, setRollQuery] = useState('')
  const [coreQuery, setCoreQuery] = useState('')
  const [listQuery, setListQuery] = useState('')

  // Create-roll form
  const [newItem, setNewItem] = useState<StockRow | null>(null)
  const [newRollNo, setNewRollNo] = useState('')
  const [newQty, setNewQty] = useState('')
  const [newWidth, setNewWidth] = useState('')
  const [newLength, setNewLength] = useState('')
  const [newRemarks, setNewRemarks] = useState('')
  const [creating, setCreating] = useState(false)
  const [createMsg, setCreateMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  // Withdraw form
  const [roll, setRoll] = useState<RollRow | null>(null)
  const [rollSearchOpen, setRollSearchOpen] = useState(false)
  const [date, setDate] = useState(today)
  const [qty, setQty] = useState('')
  const qtyRef = useRef<HTMLInputElement>(null)
  const [customer, setCustomer] = useState('')
  const [withdrawalNo, setWithdrawalNo] = useState('')
  const remarksRef = useRef<HTMLInputElement>(null)
  // Withdrawal No. suggests Job Orders from the Sales Orders sheet; picking one fills Customer (same as Roll / PC).
  const salesOrders = useSalesOrders()
  const jobOrderSuggestions = useMemo(() => matchJobOrders(salesOrders, withdrawalNo), [salesOrders, withdrawalNo])

  function changeWithdrawalNo(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value
    setWithdrawalNo(value)
    const match = jobOrderSuggestions.find((o) => o.jobOrder.toLowerCase() === value.trim().toLowerCase())
    if (match?.customer) setCustomer(match.customer)
    if (match && isSuggestionPick(e)) setTimeout(() => remarksRef.current?.focus(), 0)
  }
  // Yards: each roll's width (its own, else the item's), shown read-only as "Roll Width".
  const [rollWidths, setRollWidths] = useState<Record<string, string>>({})
  // Partial: each roll's own Width / Length, shown in the rolls list.
  const [rollSizes, setRollSizes] = useState<Record<string, RollSize>>({})
  const [remarks, setRemarks] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const load = useCallback(async () => {
    const { data } = await supabase.from(config.stockView).select('*').eq('active', true).order('item_code')
    setRolls((data as RollRow[]) ?? [])
    if (config.hasWidth) {
      const { data: sizes } = await supabase.from('yards_stock_summary').select('roll_id, width, width_unit')
      const map: Record<string, string> = {}
      for (const r of (sizes as { roll_id: string; width: number | null; width_unit: string | null }[]) ?? []) {
        if (r.width != null) map[r.roll_id] = `${r.width}${r.width_unit ? ` ${r.width_unit}` : ''}`
      }
      setRollWidths(map)
    }
    if (config.hasSize) {
      const { data: sizes } = await supabase.from(config.summaryView).select('roll_id, width, width_unit, length, length_unit')
      const map: Record<string, RollSize> = {}
      for (const r of (sizes as ({ roll_id: string } & RollSize)[]) ?? []) map[r.roll_id] = r
      setRollSizes(map)
    }
  }, [config.stockView, config.hasWidth, config.hasSize, config.summaryView])
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

  const visibleRolls = listQuery.trim()
    ? rolls.filter((r) => {
        const q = listQuery.trim().toLowerCase()
        return [r.item_code, r.description, r.roll_no].filter(Boolean).join(' ').toLowerCase().includes(q)
      })
    : rolls

  function resetCreateForm() {
    setEditing(null)
    setNewItem(null)
    setNewRollNo('')
    setNewQty('')
    setNewWidth('')
    setNewLength('')
    setNewRemarks('')
  }

  /** p_width / p_length for the create and edit RPCs, when this ledger has them. */
  function sizeParams() {
    const num = (v: string) => (v === '' ? null : Number(v))
    if (config.hasSize) return { p_width: num(newWidth), p_length: num(newLength) }
    if (config.hasWidth) return { p_width: num(newWidth) }
    return {}
  }

  /** Load a roll into the Add form for editing (its item and received quantity come from the DB). */
  async function startEdit(r: RollRow) {
    setCreateMsg(null)
    const [{ data: stock }, { data: summary }] = await Promise.all([
      supabase.from('current_stock').select('*').eq('item_id', r.item_id).single(),
      supabase
        .from(config.summaryView)
        .select(config.hasSize ? 'total_received, width, length' : config.hasWidth ? 'total_received, width' : 'total_received')
        .eq('roll_id', r.roll_id)
        .single<{ total_received: number; width?: number | null; length?: number | null }>(),
    ])
    if (!stock || !summary) return setCreateMsg({ kind: 'error', text: 'Could not load that roll.' })
    setEditing(r)
    setNewItem(stock as StockRow)
    setNewRollNo(r.roll_no ?? '')
    setNewQty(String(summary.total_received))
    setNewWidth(summary.width != null ? String(summary.width) : '')
    setNewLength(summary.length != null ? String(summary.length) : '')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function createRoll(e: React.FormEvent) {
    e.preventDefault()
    if (!newItem) return setCreateMsg({ kind: 'error', text: 'Select an item first.' })
    const n = Number(newQty)
    if (!(n > 0)) return setCreateMsg({ kind: 'error', text: `${config.unitLabel} must be greater than 0.` })

    setCreating(true)
    setCreateMsg(null)
    if (editing && config.editRpc) {
      const { error } = await supabase.rpc(config.editRpc, {
        p_roll_id: editing.roll_id,
        p_roll_no: newRollNo.trim() || null,
        p_item_id: newItem.item_id,
        [config.editQtyParam ?? config.createQtyParam]: n,
        ...sizeParams(),
      })
      setCreating(false)
      if (error) return setCreateMsg({ kind: 'error', text: errorMessage(error) })
      setCreateMsg({ kind: 'ok', text: `Updated roll ${newRollNo.trim() || newItem.item_code}.` })
      resetCreateForm()
      return
    }
    const { error } = await supabase.rpc(config.createRpc, {
      p_item_id: newItem.item_id,
      [config.createQtyParam]: n,
      p_roll_no: newRollNo.trim() || null,
      p_entry_date: date,
      p_remarks: newRemarks.trim() || null,
      ...sizeParams(),
    })
    setCreating(false)
    if (error) return setCreateMsg({ kind: 'error', text: errorMessage(error) })

    setCreateMsg({ kind: 'ok', text: `Roll created for ${newItem.item_code}.` })
    resetCreateForm()
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
      p_withdrawal_no: withdrawalNo.trim() || null,
    })
    setSaving(false)
    if (error) return setSaveMsg({ kind: 'error', text: errorMessage(error) })

    setSaveMsg({ kind: 'ok', text: `Withdrew ${formatQty(withdrawQty)} from ${roll.item_code}${roll.roll_no ? ` (${roll.roll_no})` : ''}.` })
    setRoll(null)
    setCoreQuery('')
    setQty('')
    setCustomer('')
    setWithdrawalNo('')
    setRemarks('')
  }

  /** Typing a roll's exact Core No. selects that roll; the box then shows the selected roll's Core No. */
  function typeCoreNo(value: string) {
    setCoreQuery(value)
    const q = value.trim().toLowerCase()
    setRoll(q ? (rolls.find((r) => (r.roll_no ?? '').toLowerCase() === q) ?? null) : null)
  }

  return (
    <div className="space-y-6">
      {showAdd && (
      <div className="card p-5">
        <h2 className="font-semibold text-slate-700 mb-3">
          {editing ? `Edit Roll (${editing.roll_no ?? editing.item_code})` : `Add Roll (${config.title})`}
        </h2>
        <form onSubmit={createRoll} className="grid gap-4 md:grid-cols-2 lg:grid-cols-6">
          <div className="lg:col-span-2">
            <span className="label">Item</span>
            <ItemPicker
              value={newItem}
              onChange={(item) => {
                setNewItem(item)
                // Width defaults to the item's catalog width; change it if this roll differs.
                if (config.hasWidth || config.hasSize) setNewWidth(item?.width != null ? String(item.width) : '')
              }}
            />
          </div>
          <label>
            <span className="label">Roll No.</span>
            <input className="input max-w-xs" value={newRollNo} onChange={(e) => setNewRollNo(e.target.value)} />
          </label>
          {config.hasWidth && (
            <label>
              <span className="label">Width {newItem?.width_unit && <span className="text-slate-400">({newItem.width_unit})</span>}</span>
              <input className="input max-w-xs" type="number" step="any" min="0" value={newWidth} onChange={(e) => setNewWidth(e.target.value)} />
            </label>
          )}
          <label>
            <span className="label">{config.unitLabel}</span>
            <input className="input max-w-xs" type="number" step="any" min="0" value={newQty} onChange={(e) => setNewQty(e.target.value)} />
          </label>
          {config.hasSize && (
            // Width and Length share one column, so each box is half the width of Quantity.
            <div className="grid grid-cols-2 gap-2">
              <label>
                <span className="label">Width {newItem?.width_unit && <span className="text-slate-400">({newItem.width_unit})</span>}</span>
                <input className="input" type="number" step="any" min="0" value={newWidth} onChange={(e) => setNewWidth(e.target.value)} />
              </label>
              <label>
                <span className="label">Length {newItem?.length_unit && <span className="text-slate-400">({newItem.length_unit})</span>}</span>
                <input className="input" type="number" step="any" min="0" value={newLength} onChange={(e) => setNewLength(e.target.value)} />
              </label>
            </div>
          )}
          {!editing && (
            <label>
              <span className="label">Remarks</span>
              <input className="input" value={newRemarks} onChange={(e) => setNewRemarks(e.target.value)} />
            </label>
          )}
          <div className="md:col-span-2 lg:col-span-6 flex items-center gap-3">
            <button className="btn-primary" disabled={creating}>
              {creating ? 'Saving…' : editing ? 'Save Changes' : 'Add Roll'}
            </button>
            {editing && (
              <button type="button" className="btn-secondary" onClick={resetCreateForm} disabled={creating}>
                Cancel
              </button>
            )}
            {createMsg && <span className={`text-sm ${createMsg.kind === 'ok' ? 'text-green-700' : 'text-red-600'}`}>{createMsg.text}</span>}
          </div>
        </form>
      </div>
      )}

      {showWithdraw && (
      <div className="card p-5">
        <h2 className="font-semibold text-slate-700 mb-3">Withdraw {config.title}</h2>
        {/* Row 1: Core No., Item, Roll Width, qty, Withdrawal No., Customer, Date. Row 2: Remarks + button. */}
        <form onSubmit={withdraw} className="space-y-4">
          <div className="flex flex-wrap items-start gap-4">
            <label className="w-28">
              <span className="label">Core No.</span>
              <input
                className="input"
                maxLength={10}
                placeholder="e.g. 2"
                value={roll ? (roll.roll_no ?? '') : coreQuery}
                onChange={(e) => typeCoreNo(e.target.value)}
                onKeyDown={(e) => {
                  // Core No. already picks the roll, so Tab skips the Item box and goes straight to the quantity.
                  if (e.key !== 'Tab' || e.shiftKey) return
                  e.preventDefault()
                  qtyRef.current?.focus()
                }}
              />
            </label>
            <div className="flex-1 min-w-64 relative">
              <span className="label">Item</span>
              {roll ? (
                <div className="flex items-center rounded border border-slate-300 bg-slate-50 px-3 py-2">
                  <div className="font-mono font-semibold truncate" title={roll.description}>
                    {roll.item_code}
                  </div>
                  <div className="ml-auto pl-3 whitespace-nowrap text-sm">
                    <span className="text-xs text-slate-500">Remaining </span>
                    <span className="font-semibold">{formatQty(remaining(roll))}</span>
                  </div>
                  <button
                    type="button"
                    className="ml-3 -mr-1 rounded px-1.5 text-lg leading-none text-slate-400 hover:bg-slate-200 hover:text-slate-700"
                    title="Change roll"
                    aria-label="Change roll"
                    onClick={() => {
                      setRoll(null)
                      setCoreQuery('')
                    }}
                  >
                    ×
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
            {config.hasWidth && (
              <label className="w-36">
                <span className="label">Roll Width</span>
                <input className="input bg-slate-50" readOnly tabIndex={-1} value={roll ? (rollWidths[roll.roll_id] ?? '') : ''} />
              </label>
            )}
            <label className="w-36">
              <span className="label">{config.unitLabel}</span>
              <input
                ref={qtyRef}
                className={`input ${overStock ? 'border-red-500' : ''}`}
                type="number"
                step="any"
                min="0"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
              />
              {overStock && <span className="text-xs text-red-600">More than remaining ({formatQty(remaining(roll!))})</span>}
            </label>
            <label className="w-60">
              <span className="label">Withdrawal No.</span>
              <input
                className="input"
                list="roll-job-order-suggestions"
                autoComplete="off"
                value={withdrawalNo}
                onChange={changeWithdrawalNo}
                onKeyDown={(e) => {
                  // Enter moves on to Remarks instead of submitting the withdrawal.
                  if (e.key !== 'Enter') return
                  e.preventDefault()
                  remarksRef.current?.focus()
                }}
              />
              <datalist id="roll-job-order-suggestions">
                {jobOrderSuggestions.map((o) => (
                  <option key={o.jobOrder} value={o.jobOrder} label={[o.customer, o.itemId, o.quantity].filter(Boolean).join(' · ')} />
                ))}
              </datalist>
            </label>
            <label className="w-60">
              <span className="label">Customer</span>
              <input className="input" value={customer} onChange={(e) => setCustomer(e.target.value)} />
            </label>
            <label className="w-40">
              <span className="label">Date</span>
              <input className="input" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
          </div>
          <div className="flex flex-wrap items-end gap-4">
            <label className="w-96">
              <span className="label">Remarks</span>
              <input ref={remarksRef} className="input" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
            </label>
            <button className="btn-primary" disabled={saving || overStock}>
              {saving ? 'Saving…' : `Withdraw ${config.unitLabel}`}
            </button>
          </div>
          {saveMsg && <p className={`text-sm ${saveMsg.kind === 'ok' ? 'text-green-700' : 'text-red-600'}`}>{saveMsg.text}</p>}
        </form>
      </div>
      )}

      <div>
        <h2 className="font-semibold text-slate-700 mb-2">{config.title} Rolls</h2>
        <input
          className="input w-64 mb-2"
          placeholder="Filter by item code, description, roll no…"
          value={listQuery}
          onChange={(e) => setListQuery(e.target.value)}
        />
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Item Code</th>
                <th>Description</th>
                <th>Roll No.</th>
                {config.hasSize && (
                  <>
                    <th className="text-right">Width</th>
                    <th>W-UM</th>
                    <th className="text-right">Length</th>
                    <th>L-UM</th>
                  </>
                )}
                <th>UOM</th>
                <th className="text-right">Remaining</th>
                {canEdit && <th />}
              </tr>
            </thead>
            <tbody>
              {visibleRolls.map((r) => (
                <tr key={r.roll_id}>
                  <td className="font-mono font-semibold">{r.item_code}</td>
                  <td>{r.description}</td>
                  <td>{r.roll_no}</td>
                  {config.hasSize && (
                    <>
                      <td className="text-right">{rollSizes[r.roll_id]?.width}</td>
                      <td>{rollSizes[r.roll_id]?.width_unit}</td>
                      <td className="text-right">{rollSizes[r.roll_id]?.length}</td>
                      <td>{rollSizes[r.roll_id]?.length_unit}</td>
                    </>
                  )}
                  <td>{r.uom}</td>
                  <td className={`text-right font-semibold ${remaining(r) <= 0 ? 'text-red-600' : ''}`}>{formatQty(remaining(r))}</td>
                  {canEdit && (
                    <td className="text-right">
                      <button className="text-xs text-blue-600 underline" onClick={() => startEdit(r)}>
                        Edit
                      </button>
                    </td>
                  )}
                </tr>
              ))}
              {visibleRolls.length === 0 && (
                <tr>
                  <td colSpan={(canEdit ? 6 : 5) + (config.hasSize ? 4 : 0)} className="text-center text-slate-400 py-6">
                    {rolls.length === 0 ? 'No rolls yet — add one above.' : 'No rolls match that filter.'}
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
