import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useRealtime } from '../../lib/useRealtime'
import { formatQty } from '../../lib/types'

interface AdjustmentRow {
  id: string
  previous_quantity: number
  new_quantity: number
  difference: number
  reason: string
  created_at: string
  item: { item_code: string; description: string } | null
  changed_by: { display_name: string | null; email: string | null } | null
}

/** Audit trail for §"one important improvement": every change to an existing Beginning balance, never a silent overwrite. */
export function BeginningAdjustmentLog() {
  const [rows, setRows] = useState<AdjustmentRow[]>([])

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('beginning_adjustments')
      .select('*, item:items(item_code, description), changed_by:profiles(display_name, email)')
      .order('created_at', { ascending: false })
      .limit(50)
    setRows((data as AdjustmentRow[]) ?? [])
  }, [])
  useEffect(() => {
    load()
  }, [load])
  useRealtime(['beginning_adjustments'], load)

  if (rows.length === 0) return null

  return (
    <div>
      <h2 className="font-semibold text-slate-700 mb-2">Beginning Inventory — Adjustment Log</h2>
      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Date/Time</th>
              <th>Item</th>
              <th className="text-right">Old Qty</th>
              <th className="text-right">New Qty</th>
              <th className="text-right">Difference</th>
              <th>Reason</th>
              <th>Changed By</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap">{new Date(r.created_at).toLocaleString()}</td>
                <td>
                  <span className="font-mono font-semibold">{r.item?.item_code}</span>{' '}
                  <span className="text-slate-500">{r.item?.description}</span>
                </td>
                <td className="text-right">{formatQty(r.previous_quantity)}</td>
                <td className="text-right font-semibold">{formatQty(r.new_quantity)}</td>
                <td className={`text-right ${r.difference < 0 ? 'text-red-600' : 'text-green-700'}`}>
                  {r.difference > 0 ? '+' : ''}
                  {formatQty(r.difference)}
                </td>
                <td className="text-slate-500">{r.reason}</td>
                <td>{r.changed_by?.display_name ?? r.changed_by?.email}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
