import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { useAuth } from '../../auth/AuthProvider'
import { ItemPicker } from '../../components/ItemPicker'
import { errorMessage, supabase } from '../../lib/supabase'
import { useRealtime } from '../../lib/useRealtime'
import { formatQty, formatSize, type StockRow } from '../../lib/types'

const today = () => new Date().toLocaleDateString('en-CA')

type OperationRow = {
  id: string
  operation_no: string
  entry_date: string
  source_item_id: string
  output_item_id: string
  source_quantity: number
  produced_quantity: number
  customer_quantity: number
  stock_quantity: number
  customer: string | null
  withdrawal_no: string | null
  remarks: string | null
  voided_at: string | null
  created_at: string
  source: { item_code: string; description: string; width: number | null; width_unit: string | null; length: number | null; length_unit: string | null } | null
  output: { item_code: string; description: string; width: number | null; width_unit: string | null; length: number | null; length_unit: string | null } | null
}

function splitYield(source: StockRow | null, output: StockRow | null): number | null {
  if (!source || !output || source.width == null || output.width == null || source.width <= 0 || output.width <= 0) return null
  if ((source.width_unit ?? '').toUpperCase() !== (output.width_unit ?? '').toUpperCase()) return null
  const ratio = source.width / output.width
  return Number.isInteger(ratio) ? ratio : null
}

function operationSize(item: OperationRow['source'] | null): string {
  if (!item) return '—'
  const w = item.width != null ? `${item.width}${item.width_unit ?? ''}` : ''
  const l = item.length != null ? `${item.length}${item.length_unit ?? ''}` : ''
  return [w, l].filter(Boolean).join(' × ') || '—'
}

// Item codes in the catalog come in same-product pairs that only differ by their
// trailing width, e.g. "1170-ECF-CLEAR-48" / "1170-ECF-CLEAR-24". Splitting a wider
// roll almost always means producing the 24"-wide sibling, so derive it automatically
// instead of making the user search for it every time.
function deriveOutputCode(sourceCode: string): string | null {
  const m = sourceCode.match(/^(.*)-\d+$/)
  if (!m) return null
  const candidate = `${m[1]}-24`
  return candidate.toUpperCase() === sourceCode.toUpperCase() ? null : candidate
}

export function SplitWithdrawPage() {
  const { isAdmin } = useAuth()
  const [source, setSource] = useState<StockRow | null>(null)
  const [output, setOutput] = useState<StockRow | null>(null)
  const [sourceQty, setSourceQty] = useState('1')
  const [customerQty, setCustomerQty] = useState('1')
  const [date, setDate] = useState(today)
  const [customer, setCustomer] = useState('')
  const [withdrawalNo, setWithdrawalNo] = useState('')
  const [operationNo, setOperationNo] = useState('')
  const [remarks, setRemarks] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [recent, setRecent] = useState<OperationRow[]>([])
  const [recentQuery, setRecentQuery] = useState('')
  const [outputAuto, setOutputAuto] = useState(false)

  // Auto-fill Output from Source's 24"-wide sibling code. A manual pick (via
  // the picker's own "Change" link) sticks until Source changes again.
  useEffect(() => {
    setOutput(null)
    setOutputAuto(false)
    if (!source) return
    const code = deriveOutputCode(source.item_code)
    if (!code) return
    let cancelled = false
    supabase
      .from('current_stock')
      .select('*')
      .eq('active', true)
      .ilike('item_code', code)
      .then(({ data }) => {
        if (cancelled) return
        const match = (data as StockRow[] | null)?.find((r) => r.item_code.toUpperCase() === code.toUpperCase())
        if (match) {
          setOutput(match)
          setOutputAuto(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [source])

  const yieldPerSource = useMemo(() => splitYield(source, output), [source, output])
  const customerCount = Number(customerQty)

  // Source rolls needed = enough to produce at least the customer's quantity,
  // e.g. yield 2: 2 customer rolls -> 1 source, 3 -> 2 (rounds up), 4 -> 2, 6 -> 3.
  useEffect(() => {
    if (!yieldPerSource || yieldPerSource <= 0 || !(customerCount > 0)) return
    setSourceQty(String(Math.ceil(customerCount / yieldPerSource)))
  }, [customerCount, yieldPerSource])

  const sourceCount = Number(sourceQty)
  const produced = yieldPerSource != null && sourceCount > 0 ? sourceCount * yieldPerSource : 0
  const stockRemainder = produced > 0 && customerCount > 0 ? produced - customerCount : 0
  const invalidCustomerQty = customerCount <= 0 || (produced > 0 && customerCount > produced)
  const overSourceStock = source != null && sourceCount > Number(source.on_hand)

  const loadRecent = useCallback(async () => {
    const { data, error } = await supabase
      .from('inventory_operations')
      .select(`*, source:items!inventory_operations_source_item_id_fkey(item_code,description,width,width_unit,length,length_unit), output:items!inventory_operations_output_item_id_fkey(item_code,description,width,width_unit,length,length_unit)`)
      .order('created_at', { ascending: false })
      .limit(30)
    if (!error) setRecent((data as OperationRow[]) ?? [])
  }, [])

  useEffect(() => { loadRecent() }, [loadRecent])
  useRealtime(['inventory_operations', 'inventory_transactions', 'items'], loadRecent)

  const visibleRecent = recentQuery.trim()
    ? recent.filter((row) => {
        const q = recentQuery.trim().toLowerCase()
        const haystack = [row.operation_no, row.source?.item_code, row.source?.description, row.output?.item_code, row.output?.description, row.customer, row.withdrawal_no, row.remarks]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        return haystack.includes(q)
      })
    : recent

  function clear() {
    setSource(null)
    setOutput(null)
    setSourceQty('1')
    setCustomerQty('1')
    setDate(today())
    setCustomer('')
    setWithdrawalNo('')
    setOperationNo('')
    setRemarks('')
    setMessage(null)
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setMessage(null)
    if (!source || !output) return setMessage({ kind: 'error', text: 'Select both the source roll and output size.' })
    if (source.item_id === output.item_id) return setMessage({ kind: 'error', text: 'Source and output items must be different.' })
    if (yieldPerSource == null) return setMessage({ kind: 'error', text: 'The source width must divide evenly into the output width, using the same width unit.' })
    if (!(sourceCount > 0) || !Number.isInteger(sourceCount)) return setMessage({ kind: 'error', text: 'Source quantity must be a whole number of source rolls.' })
    if (!(customerCount > 0) || !Number.isInteger(customerCount)) return setMessage({ kind: 'error', text: 'Customer quantity must be a whole number of output rolls.' })
    if (overSourceStock) return setMessage({ kind: 'error', text: `Only ${formatQty(source.on_hand)} roll of the source item is on hand.` })
    if (invalidCustomerQty) return setMessage({ kind: 'error', text: `This split produces ${formatQty(produced)} output rolls, but the customer needs ${formatQty(customerCount)}.` })

    setBusy(true)
    const { data, error } = await supabase.rpc('post_split_withdrawal', {
      p_source_item_id: source.item_id,
      p_output_item_id: output.item_id,
      p_source_quantity: sourceCount,
      p_customer_quantity: customerCount,
      p_entry_date: date,
      p_customer: customer.trim() || null,
      p_withdrawal_no: withdrawalNo.trim() || null,
      p_remarks: remarks.trim() || null,
      p_operation_no: operationNo.trim() || null,
    })
    setBusy(false)
    if (error) return setMessage({ kind: 'error', text: errorMessage(error) })

    const successText = `Split withdrawal posted successfully${data ? ` (${String(data).slice(0, 8)}…)` : ''}. ${formatQty(stockRemainder)} ${output.item_code} remains in stock.`
    setSource(null)
    setOutput(null)
    setSourceQty('1')
    setCustomerQty('1')
    setDate(today())
    setCustomer('')
    setWithdrawalNo('')
    setOperationNo('')
    setRemarks('')
    setMessage({ kind: 'ok', text: successText })
    await loadRecent()
  }

  async function voidOperation(row: OperationRow) {
    const reason = window.prompt(`Void ${row.operation_no}? This reverses the source split and customer withdrawal together.\nReason:`)
    if (reason === null) return
    const { error } = await supabase.rpc('void_split_withdrawal', { p_operation_id: row.id, p_reason: reason.trim() || null })
    if (error) setMessage({ kind: 'error', text: errorMessage(error) })
    else await loadRecent()
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="page-title">Split &amp; Withdraw</h2>
        <p className="text-sm text-slate-500">Take larger stock, split it into the customer size, send the requested pieces to the customer, and automatically return the remainder to stock.</p>
      </div>

      <form onSubmit={submit} className="card p-5 space-y-5">
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <span className="label">Source stock</span>
            <ItemPicker value={source} onChange={setSource} unitLabel="roll" />
          </div>
          <div>
            <span className="label">
              Output / customer size {outputAuto && <span className="text-slate-400 font-normal">(auto from source — click Change to override)</span>}
            </span>
            <ItemPicker
              value={output}
              onChange={(v) => {
                setOutput(v)
                setOutputAuto(false)
              }}
              unitLabel="roll"
            />
          </div>
        </div>

        {source && output && (
          <div className="rounded-lg bg-slate-50 border border-slate-200 p-4 grid gap-4 md:grid-cols-4">
            <div><div className="text-xs text-slate-500">Source</div><div className="font-semibold">{formatSize(source)}</div></div>
            <div><div className="text-xs text-slate-500">Output</div><div className="font-semibold">{formatSize(output)}</div></div>
            <div><div className="text-xs text-slate-500">Pieces per source roll</div><div className="font-semibold">{yieldPerSource ?? 'Cannot calculate'}</div></div>
            <div><div className="text-xs text-slate-500">Source on hand</div><div className="font-semibold">{formatQty(source.on_hand)} roll</div></div>
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <label><span className="label">Customer rolls needed</span><input className={`input ${invalidCustomerQty ? 'border-red-500' : ''}`} type="number" min="1" step="1" value={customerQty} onChange={e => setCustomerQty(e.target.value)} /></label>
          <label><span className="label">Source rolls to use {yieldPerSource && <span className="text-slate-400 font-normal">(auto from customer rolls)</span>}</span><input className={`input ${overSourceStock ? 'border-red-500' : ''}`} type="number" min="1" step="1" value={sourceQty} onChange={e => setSourceQty(e.target.value)} />{overSourceStock && <span className="text-xs text-red-600">More than source stock.</span>}</label>
          <label><span className="label">Date</span><input className="input" type="date" required value={date} onChange={e => setDate(e.target.value)} /></label>
          <label><span className="label">Customer</span><input className="input" value={customer} onChange={e => setCustomer(e.target.value)} /></label>
          <label><span className="label">Withdrawal No.</span><input className="input" value={withdrawalNo} onChange={e => setWithdrawalNo(e.target.value)} /></label>
          <label><span className="label">Operation No. <span className="text-slate-400">(optional)</span></span><input className="input" placeholder="Auto-generate" value={operationNo} onChange={e => setOperationNo(e.target.value)} /></label>
          <label className="md:col-span-2"><span className="label">Remarks</span><input className="input" value={remarks} onChange={e => setRemarks(e.target.value)} /></label>
        </div>

        {source && output && yieldPerSource != null && sourceCount > 0 && customerCount > 0 && (
          <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
            <div className="font-semibold text-slate-800 mb-2">Warehouse preview</div>
            <div className="grid gap-2 text-sm md:grid-cols-4">
              <div><span className="text-slate-500">Use</span><br /><b>{formatQty(sourceCount)} × {source.item_code}</b></div>
              <div><span className="text-slate-500">Produces</span><br /><b>{formatQty(produced)} × {output.item_code}</b></div>
              <div><span className="text-slate-500">Customer gets</span><br /><b>{formatQty(customerCount)} × {output.item_code}</b></div>
              <div><span className="text-slate-500">Returns to stock</span><br /><b>{formatQty(Math.max(stockRemainder, 0))} × {output.item_code}</b></div>
            </div>
          </div>
        )}

        <div className="flex items-center gap-3">
          <button className="btn-primary" disabled={busy || overSourceStock || invalidCustomerQty || yieldPerSource == null}>{busy ? 'Posting…' : 'Confirm Split & Withdraw'}</button>
          <button type="button" className="btn-secondary" disabled={busy} onClick={clear}>Clear</button>
          {message && <span className={`text-sm ${message.kind === 'ok' ? 'text-green-700' : 'text-red-600'}`}>{message.text}</span>}
        </div>
      </form>

      <div>
        <h3 className="font-semibold text-slate-700 mb-2">Recent split operations</h3>
        <input
          className="input w-64 mb-2"
          placeholder="Filter by operation, item, customer…"
          value={recentQuery}
          onChange={(e) => setRecentQuery(e.target.value)}
        />
        <div className="card overflow-x-auto">
          <table className="table">
            <thead><tr><th>Date</th><th>Operation</th><th>Source</th><th>Output</th><th className="text-right">Source Qty</th><th className="text-right">Customer</th><th className="text-right">Stock Remainder</th><th>Status</th>{isAdmin && <th />}</tr></thead>
            <tbody>
              {visibleRecent.length === 0 ? (
                <tr><td colSpan={isAdmin ? 9 : 8} className="text-slate-400">{recent.length === 0 ? 'No split operations yet.' : 'No operations match that filter.'}</td></tr>
              ) : visibleRecent.map(row => (
                <tr key={row.id}>
                  <td>{row.entry_date}</td><td className="font-mono">{row.operation_no}</td>
                  <td><b>{row.source?.item_code ?? '—'}</b><br /><span className="text-xs text-slate-500">{operationSize(row.source)}</span></td>
                  <td><b>{row.output?.item_code ?? '—'}</b><br /><span className="text-xs text-slate-500">{operationSize(row.output)}</span></td>
                  <td className="text-right">{formatQty(row.source_quantity)}</td><td className="text-right">{formatQty(row.customer_quantity)}</td><td className="text-right">{formatQty(row.stock_quantity)}</td>
                  <td>{row.voided_at ? <span className="text-red-600">Voided</span> : <span className="text-green-700">Posted</span>}</td>
                  {isAdmin && <td>{!row.voided_at && <button className="text-red-600 underline text-xs" onClick={() => voidOperation(row)}>Void</button>}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
