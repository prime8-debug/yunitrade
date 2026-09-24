import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useRealtime } from '../../lib/useRealtime'
import { formatQty, type LedgerRow, type StockRow } from '../../lib/types'

/** Ledger for one item, with a running balance: "why is stock what it is?" */
export function ItemHistory({ item, onClose }: { item: StockRow; onClose: () => void }) {
  const [rows, setRows] = useState<LedgerRow[]>([])

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

  let running = 0
  const withBalance = rows.map((r) => ({ ...r, balance: (running += Number(r.quantity)) }))

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
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Type</th>
              <th>Remarks</th>
              <th className="text-right">Qty</th>
              <th className="text-right">Balance</th>
            </tr>
          </thead>
          <tbody>
            {withBalance.map((r) => (
              <tr key={r.id}>
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
              </tr>
            ))}
            {withBalance.length === 0 && (
              <tr>
                <td colSpan={5} className="text-center text-slate-400 py-6">
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
