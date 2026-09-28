import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../../auth/AuthProvider'
import { errorMessage, supabase } from '../../lib/supabase'
import { useRealtime } from '../../lib/useRealtime'
import { formatQty, type LedgerRow, type StockRow } from '../../lib/types'

/** Ledger for one item, with a running balance: "why is stock what it is?" */
export function ItemHistory({ item, onClose }: { item: StockRow; onClose: () => void }) {
  const { isAdmin } = useAuth()
  const [rows, setRows] = useState<LedgerRow[]>([])
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('inventory_transactions')
      .select('*, created_by_profile:profiles(display_name)')
      .eq('item_id', item.item_id)
      .order('transaction_date')
      .order('created_at')
    setRows((data as LedgerRow[]) ?? [])
  }, [item.item_id])

  useEffect(() => {
    load()
  }, [load])
  useRealtime(['inventory_transactions'], load)

  const withBalance = rows.reduce<(LedgerRow & { balance: number })[]>((acc, r) => {
    const prev = acc.length ? acc[acc.length - 1].balance : 0
    acc.push({ ...r, balance: prev + Number(r.quantity) })
    return acc
  }, [])

  // A row that's already been voided has a later REVERSAL row pointing back at it.
  const voidedIds = new Set(rows.map((r) => r.reversal_of).filter((id): id is string => id != null))

  async function voidRow(r: LedgerRow) {
    if (!r.reference_type || !r.reference_id) return
    const reason = window.prompt(`Void this ${r.transaction_type} entry (${r.transaction_date}, qty ${formatQty(r.quantity)})?\nReason:`)
    if (reason === null) return
    setError(null)
    const { error } = await supabase.rpc('void_entry', { p_reference_type: r.reference_type, p_reference_id: r.reference_id, p_reason: reason || null })
    if (error) setError(errorMessage(error))
  }

  return (
    <div className="fixed inset-0 z-20 flex justify-end bg-black/30" onClick={onClose}>
      <div className="h-full w-full max-w-2xl overflow-auto bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold font-mono">{item.item_code}</h2>
            <p className="text-sm text-slate-500">{item.description}</p>
          </div>
          <button className="btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
        {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Type</th>
              <th>Remarks</th>
              <th className="text-right">Qty</th>
              <th className="text-right">Balance</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {withBalance.map((r) => (
              <tr key={r.id} className={voidedIds.has(r.id) ? 'opacity-50 line-through' : ''}>
                <td className="whitespace-nowrap">{r.transaction_date}</td>
                <td>
                  <span className="badge">{r.transaction_type}</span>
                </td>
                <td className="text-slate-500">{r.remarks}</td>
                <td className={`text-right ${r.quantity < 0 ? 'text-red-600' : 'text-green-700'}`}>
                  {r.quantity > 0 ? '+' : ''}
                  {formatQty(r.quantity)}
                </td>
                <td className="text-right font-semibold">{formatQty(r.balance)}</td>
                <td className="text-right whitespace-nowrap no-underline">
                  {isAdmin && r.reference_type && r.reference_id && r.transaction_type !== 'REVERSAL' && !voidedIds.has(r.id) && (
                    <button className="text-xs text-red-600 underline" onClick={() => voidRow(r)}>
                      Void
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {withBalance.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center text-slate-400 py-6">
                  No movements yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
