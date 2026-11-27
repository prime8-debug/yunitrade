import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { errorMessage, supabase } from '../../lib/supabase'
import { useRealtime } from '../../lib/useRealtime'
import { formatQty } from '../../lib/types'
import { usePoItems } from '../../lib/usePoItems'
import { isSuggestionPick } from '../../lib/useSalesOrders'

export interface RecordField {
  name: string
  label: string
  type?: 'text' | 'date' | 'number' | 'textarea' | 'select'
  options?: string[]
  required?: boolean
  /**
   * Suggest values already used elsewhere (PO numbers, suppliers, our item codes), or
   * 'sales_code': codes from the Items sheet — picking one fills description, width and length.
   */
  suggest?: 'po_no' | 'supplier' | 'item_code' | 'sales_code'
  /** After a suggestion is picked from the list (not typed), put the cursor in this field. */
  nextOnPick?: string
  /** Leave out of the table (still in the form). */
  hideInTable?: boolean
  /** Takes the full form width. */
  wide?: boolean
}

export interface RecordAction {
  label: string
  /** Fields to change; a function may ask the user and return null to cancel. */
  apply: (row: Row) => Record<string, unknown> | null
}

type Row = Record<string, unknown> & { id: string }

interface Props {
  table: string
  /** Singular, for buttons: "Add order". */
  noun: string
  fields: RecordField[]
  /** Column to sort newest first by. */
  dateField: string
  /** Only rows whose status is (or isn't) one of these. */
  statusIn?: string[]
  statusNotIn?: string[]
  /** Values a new record starts with. */
  defaults?: Record<string, string>
  actions?: RecordAction[]
  /** Hide the Add button (e.g. Received only lists what came in). */
  readOnlyAdd?: boolean
  emptyText?: string
  /**
   * Fixed form arrangement: rows of fields, each with its width classes. Fields not listed
   * aren't shown in the form. Without it, the form is a plain grid in `fields` order.
   */
  formRows?: { name: string; className: string }[][]
}

const today = () => new Date().toLocaleDateString('en-CA')

function blankForm(fields: RecordField[], defaults: Record<string, string> = {}) {
  const form: Record<string, string> = {}
  for (const f of fields) {
    form[f.name] =
      defaults[f.name] ?? (f.required && f.type === 'date' ? today() : f.required && f.type === 'select' ? (f.options?.[0] ?? '') : '')
  }
  return form
}

/** "48", "48 in" or "48.5in" from the sheet → "48" / "48.5" for a number box; anything else unchanged. */
function sizeNumber(value: string) {
  const m = value.trim().match(/^-?\d+(?:\.\d+)?/)
  return m ? m[0] : value.trim()
}

function display(f: RecordField, value: unknown) {
  if (value == null || value === '') return ''
  if (f.type === 'number') return formatQty(Number(value))
  return String(value)
}

/** Add / edit / delete list for one Purchase Orders sub-tab. ADMIN only (enforced in the database too). */
export function RecordsTable({ table, noun, fields, dateField, statusIn, statusNotIn, defaults, actions, readOnlyAdd, emptyText, formRows }: Props) {
  const [rows, setRows] = useState<Row[]>([])
  const [loaded, setLoaded] = useState(false)
  const [query, setQuery] = useState('')
  const [editingId, setEditingId] = useState<string | 'new' | null>(null)
  const [form, setForm] = useState<Record<string, string>>(() => blankForm(fields, defaults))
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [suggestions, setSuggestions] = useState<Record<string, string[]>>({})
  const usesSheetItems = fields.some((f) => f.suggest === 'sales_code')
  const { items: sheetItems } = usePoItems(usesSheetItems)
  const sheetItemByCode = useMemo(() => new Map(sheetItems.map((i) => [i.code.toUpperCase(), i])), [sheetItems])

  const load = useCallback(async () => {
    let q = supabase.from(table).select('*')
    if (statusIn) q = q.in('status', statusIn)
    if (statusNotIn) q = q.not('status', 'in', `(${statusNotIn.map((s) => `"${s}"`).join(',')})`)
    const { data, error } = await q.order(dateField, { ascending: false }).order('created_at', { ascending: false }).limit(500)
    if (error) setMessage({ kind: 'error', text: errorMessage(error) })
    else setRows((data as Row[]) ?? [])
    setLoaded(true)
  }, [table, dateField, statusIn, statusNotIn])

  useEffect(() => {
    load()
  }, [load])
  useRealtime([table], load)

  // Suggestions for the fields that ask for them.
  const suggestKinds = useMemo(() => [...new Set(fields.map((f) => f.suggest).filter(Boolean))] as string[], [fields])
  useEffect(() => {
    if (suggestKinds.length === 0) return
    let cancelled = false
    ;(async () => {
      const next: Record<string, string[]> = {}
      const uniq = (values: unknown[]) => [...new Set(values.map((v) => String(v ?? '').trim()).filter(Boolean))].sort()
      if (suggestKinds.includes('po_no') || suggestKinds.includes('supplier')) {
        const { data } = await supabase.from('purchase_orders').select('po_no, supplier').order('po_date', { ascending: false }).limit(1000)
        next.po_no = uniq((data ?? []).map((r) => r.po_no))
        next.supplier = uniq((data ?? []).map((r) => r.supplier))
      }
      if (suggestKinds.includes('item_code')) {
        const { data } = await supabase.from('items').select('item_code').eq('active', true).order('item_code')
        next.item_code = uniq((data ?? []).map((r) => r.item_code))
      }
      if (!cancelled) setSuggestions(next)
    })()
    return () => {
      cancelled = true
    }
  }, [suggestKinds, editingId])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) => fields.map((f) => r[f.name] ?? '').join(' ').toLowerCase().includes(q))
  }, [rows, query, fields])

  const tableFields = fields.filter((f) => !f.hideInTable)

  function startAdd() {
    setForm(blankForm(fields, defaults))
    setEditingId('new')
    setMessage(null)
  }

  function startEdit(row: Row) {
    const next: Record<string, string> = {}
    for (const f of fields) next[f.name] = row[f.name] == null ? '' : String(row[f.name])
    setForm(next)
    setEditingId(row.id)
    setMessage(null)
  }

  // Picking a PO No. that's already on file fills in its supplier when that's still empty.
  function isSuggested(f: RecordField, value: string) {
    const v = value.trim().toUpperCase()
    if (f.suggest === 'sales_code') return sheetItemByCode.has(v)
    return !!f.suggest && (suggestions[f.suggest] ?? []).some((s) => s.toUpperCase() === v)
  }

  async function changeField(name: string, value: string) {
    setForm((f) => ({ ...f, [name]: value }))

    // Picking an Items sheet code fills its description and size (all still editable).
    if (fields.find((f) => f.name === name)?.suggest === 'sales_code') {
      const item = sheetItemByCode.get(value.trim().toUpperCase())
      if (item) {
        const has = (n: string) => fields.some((f) => f.name === n)
        setForm((f) => ({
          ...f,
          ...(has('description') && { description: item.description }),
          ...(has('width') && { width: sizeNumber(item.width) }),
          ...(has('length') && { length: sizeNumber(item.length) }),
        }))
      }
      return
    }

    if (name !== 'po_no' || table === 'purchase_orders' || !fields.some((f) => f.name === 'supplier')) return
    if (!suggestions.po_no?.includes(value.trim())) return
    const { data } = await supabase.from('purchase_orders').select('supplier').eq('po_no', value.trim()).not('supplier', 'is', null).limit(1)
    const supplier = data?.[0]?.supplier
    if (supplier) setForm((f) => (f.supplier ? f : { ...f, supplier }))
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    const missing = fields.find((f) => f.required && !form[f.name]?.trim())
    if (missing) return setMessage({ kind: 'error', text: `${missing.label} is required.` })
    const values: Record<string, unknown> = {}
    for (const f of fields) {
      const v = form[f.name]?.trim() ?? ''
      values[f.name] = v === '' ? null : f.type === 'number' ? Number(v.replace(/,/g, '')) : v
      if (f.type === 'number' && v !== '' && !Number.isFinite(values[f.name] as number)) {
        return setMessage({ kind: 'error', text: `${f.label} must be a number.` })
      }
    }
    setBusy(true)
    const { error } =
      editingId === 'new'
        ? await supabase.from(table).insert(values)
        : await supabase.from(table).update({ ...values, updated_at: new Date().toISOString() }).eq('id', editingId)
    setBusy(false)
    if (error) return setMessage({ kind: 'error', text: errorMessage(error) })
    setMessage({ kind: 'ok', text: editingId === 'new' ? `${noun} added.` : `${noun} updated.` })
    setEditingId(null)
    load()
  }

  async function remove(row: Row) {
    if (!window.confirm(`Delete this ${noun.toLowerCase()}? This cannot be undone.`)) return
    const { error } = await supabase.from(table).delete().eq('id', row.id)
    if (error) setMessage({ kind: 'error', text: errorMessage(error) })
    else load()
  }

  async function runAction(action: RecordAction, row: Row) {
    const change = action.apply(row)
    if (!change) return
    const { error } = await supabase.from(table).update({ ...change, updated_at: new Date().toISOString() }).eq('id', row.id)
    if (error) setMessage({ kind: 'error', text: errorMessage(error) })
    else load()
  }

  const buttons = (
    <div className="flex gap-3">
      <button className="btn-primary" disabled={busy}>
        {busy ? 'Saving…' : 'Save'}
      </button>
      <button type="button" className="btn-secondary" disabled={busy} onClick={() => setEditingId(null)}>
        Cancel
      </button>
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input className="input w-64" placeholder="Filter…" value={query} onChange={(e) => setQuery(e.target.value)} />
        {!readOnlyAdd && editingId === null && (
          <button className="btn-primary" onClick={startAdd}>
            Add {noun.toLowerCase()}
          </button>
        )}
        {message && <span className={`text-sm ${message.kind === 'ok' ? 'text-green-700' : 'text-red-600'}`}>{message.text}</span>}
      </div>

      {editingId !== null && (
        <form onSubmit={save} className="card p-5 space-y-4">
          <div className="font-semibold text-slate-700">{editingId === 'new' ? `New ${noun.toLowerCase()}` : `Edit ${noun.toLowerCase()}`}</div>
          {formRows ? (
            // Fixed arrangement: each row left to right, Save / Cancel at the end of the last row.
            formRows.map((row, i) => (
              <div key={i} className="flex flex-wrap items-end gap-4">
                {row.map((cell) => {
                  const f = fields.find((x) => x.name === cell.name)
                  return f ? renderField(f, cell.className) : null
                })}
                {i === formRows.length - 1 && buttons}
              </div>
            ))
          ) : (
            <>
              <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-4">
                {fields.map((f) => renderField(f, f.wide || f.type === 'textarea' ? 'md:col-span-3 lg:col-span-4' : ''))}
              </div>
              {buttons}
            </>
          )}
        </form>
      )}

      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              {tableFields.map((f) => (
                <th key={f.name} className={f.type === 'number' ? 'text-right' : ''}>
                  {f.label}
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.id}>
                {tableFields.map((f) => (
                  <td
                    key={f.name}
                    className={
                      f.type === 'number' ? 'text-right' : f.type === 'textarea' ? 'whitespace-pre-wrap max-w-md' : f.type === 'date' ? 'whitespace-nowrap' : ''
                    }
                  >
                    {display(f, r[f.name])}
                  </td>
                ))}
                <td className="text-right whitespace-nowrap space-x-3">
                  {actions?.map((a) => (
                    <button key={a.label} className="text-xs text-blue-700 underline" onClick={() => runAction(a, r)}>
                      {a.label}
                    </button>
                  ))}
                  <button className="text-xs text-slate-600 underline" onClick={() => startEdit(r)}>
                    Edit
                  </button>
                  <button className="text-xs text-red-600 underline" onClick={() => remove(r)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={tableFields.length + 1} className="text-center text-slate-400 py-6">
                  {!loaded ? 'Loading…' : rows.length === 0 ? (emptyText ?? 'Nothing here yet.') : 'Nothing matches that filter.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )

  function renderField(f: RecordField, className: string) {
    return (
              <label key={f.name} className={className}>
                <span className="label">
                  {f.label}
                  {f.required && <span className="text-red-500"> *</span>}
                </span>
                {f.type === 'textarea' ? (
                  <textarea className="input min-h-[6rem]" value={form[f.name] ?? ''} onChange={(e) => changeField(f.name, e.target.value)} />
                ) : f.type === 'select' ? (
                  <select className="input" value={form[f.name] ?? ''} onChange={(e) => changeField(f.name, e.target.value)}>
                    {!f.required && <option value="" />}
                    {(f.options ?? []).map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                ) : (
                  <>
                    <input
                      id={`${table}-${f.name}`}
                      className="input"
                      type={f.type === 'date' ? 'date' : 'text'}
                      inputMode={f.type === 'number' ? 'decimal' : undefined}
                      list={f.suggest ? `${table}-${f.name}-suggestions` : undefined}
                      autoComplete="off"
                      value={form[f.name] ?? ''}
                      onChange={(e) => {
                        changeField(f.name, e.target.value)
                        // Picking a suggestion (not typing) moves on to the next box.
                        if (f.nextOnPick && isSuggestionPick(e) && isSuggested(f, e.target.value)) {
                          setTimeout(() => document.getElementById(`${table}-${f.nextOnPick}`)?.focus(), 0)
                        }
                      }}
                    />
                    {f.suggest === 'sales_code' ? (
                      <datalist id={`${table}-${f.name}-suggestions`}>
                        {sheetItems.map((i) => (
                          <option key={i.code} value={i.code} label={i.description} />
                        ))}
                      </datalist>
                    ) : (
                      f.suggest && (
                        <datalist id={`${table}-${f.name}-suggestions`}>
                          {(suggestions[f.suggest] ?? []).map((s) => (
                            <option key={s} value={s} />
                          ))}
                        </datalist>
                      )
                    )}
                  </>
                )}
              </label>
    )
  }
}
