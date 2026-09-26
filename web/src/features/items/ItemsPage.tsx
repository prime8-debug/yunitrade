import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { errorMessage, supabase } from '../../lib/supabase'
import { useRealtime } from '../../lib/useRealtime'
import { formatSize, type Item } from '../../lib/types'

const EMPTY = { item_code: '', description: '', width: '', width_unit: '', length: '', length_unit: '', uom: '', category: '', remarks: '' }

/** ADMIN: item master data. RLS also blocks non-admin writes server-side. */
export function ItemsPage() {
  const [items, setItems] = useState<Item[]>([])
  const [form, setForm] = useState(EMPTY)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const load = useCallback(async () => {
    const { data } = await supabase.from('items').select('*').order('item_code')
    setItems((data as Item[]) ?? [])
  }, [])
  useEffect(() => {
    load()
  }, [load])
  useRealtime(['items'], load)

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? items.filter((i) => i.item_code.toLowerCase().includes(q) || i.description.toLowerCase().includes(q)) : items
  }, [items, query])

  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value })

  async function submit(e: FormEvent) {
    e.preventDefault()
    const row = {
      item_code: form.item_code.trim().toUpperCase(),
      description: form.description.trim(),
      width: form.width === '' ? null : Number(form.width),
      width_unit: form.width_unit.trim() || null,
      length: form.length === '' ? null : Number(form.length),
      length_unit: form.length_unit.trim() || null,
      uom: form.uom.trim().toUpperCase() || null,
      category: form.category.trim() || null,
      remarks: form.remarks.trim() || null,
      updated_at: new Date().toISOString(),
    }
    const { error } = editingId
      ? await supabase.from('items').update(row).eq('id', editingId)
      : await supabase.from('items').insert(row)
    if (error) return setMessage({ kind: 'error', text: error.code === '23505' ? `Item code ${row.item_code} already exists.` : errorMessage(error) })
    setMessage({ kind: 'ok', text: `${editingId ? 'Updated' : 'Added'} ${row.item_code}` })
    setForm(EMPTY)
    setEditingId(null)
  }

  function edit(i: Item) {
    setEditingId(i.id)
    setForm({
      item_code: i.item_code,
      description: i.description,
      width: i.width?.toString() ?? '',
      width_unit: i.width_unit ?? '',
      length: i.length?.toString() ?? '',
      length_unit: i.length_unit ?? '',
      uom: i.uom ?? '',
      category: i.category ?? '',
      remarks: i.remarks ?? '',
    })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function toggleActive(i: Item) {
    const { error } = await supabase.from('items').update({ active: !i.active, updated_at: new Date().toISOString() }).eq('id', i.id)
    if (error) setMessage({ kind: 'error', text: errorMessage(error) })
  }

  return (
    <div className="space-y-6">
      <h1 className="page-title">Items</h1>

      <form onSubmit={submit} className="card p-5 grid gap-4 md:grid-cols-4">
        <label>
          <span className="label">Item Code</span>
          <input className="input font-mono" required value={form.item_code} onChange={set('item_code')} />
        </label>
        <label className="md:col-span-3">
          <span className="label">Description</span>
          <input className="input" value={form.description} onChange={set('description')} />
        </label>
        <label>
          <span className="label">Width</span>
          <input className="input" type="number" step="any" value={form.width} onChange={set('width')} />
        </label>
        <label>
          <span className="label">Width Unit</span>
          <input className="input" placeholder="in / mm / m" value={form.width_unit} onChange={set('width_unit')} />
        </label>
        <label>
          <span className="label">Length</span>
          <input className="input" type="number" step="any" value={form.length} onChange={set('length')} />
        </label>
        <label>
          <span className="label">Length Unit</span>
          <input className="input" placeholder="yd / m / ft" value={form.length_unit} onChange={set('length_unit')} />
        </label>
        <label>
          <span className="label">Stocking UOM</span>
          <input className="input" placeholder="ROLLS / PC / SQFT" value={form.uom} onChange={set('uom')} />
        </label>
        <label>
          <span className="label">Category</span>
          <input className="input" value={form.category} onChange={set('category')} />
        </label>
        <label className="md:col-span-4">
          <span className="label">Remarks</span>
          <input className="input" value={form.remarks} onChange={set('remarks')} />
        </label>
        <div className="md:col-span-4 flex items-end gap-3">
          <button className="btn-primary">{editingId ? 'Update Item' : 'Add Item'}</button>
          {editingId && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setEditingId(null)
                setForm(EMPTY)
              }}
            >
              Cancel
            </button>
          )}
        </div>
        {message && <p className={`md:col-span-4 text-sm ${message.kind === 'ok' ? 'text-green-700' : 'text-red-600'}`}>{message.text}</p>}
      </form>

      <div>
        <input className="input w-64 mb-2" placeholder="Filter items…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Item Code</th>
                <th>Description</th>
                <th>Size</th>
                <th>UOM</th>
                <th>Category</th>
                <th>Status</th>
                <th className="w-72">Remarks</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((i) => (
                <tr key={i.id} className={i.active ? '' : 'opacity-50'}>
                  <td className="font-mono font-semibold">{i.item_code}</td>
                  <td>{i.description}</td>
                  <td className="whitespace-nowrap">{formatSize(i)}</td>
                  <td>{i.uom}</td>
                  <td>{i.category}</td>
                  <td>{i.active ? 'Active' : 'Inactive'}</td>
                  <td className="text-slate-500 whitespace-normal break-words">{i.remarks}</td>
                  <td className="text-right whitespace-nowrap space-x-3">
                    <button className="text-xs text-blue-600 underline" onClick={() => edit(i)}>
                      Edit
                    </button>
                    <button className="text-xs text-slate-600 underline" onClick={() => toggleActive(i)}>
                      {i.active ? 'Deactivate' : 'Activate'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
