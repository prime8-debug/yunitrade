import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { errorMessage } from '../../lib/supabase'
import { refreshPoItems, savePoItemsUrl, usePoItems } from '../../lib/usePoItems'
import { RecordsTable, type RecordAction, type RecordField } from './RecordsTable'

/**
 * The ITEMCODES sheet tab (Publish to web → CSV) behind the Item Code suggestions on Orders:
 * column A item code, B description, C width, E length.
 */
function ItemsSheetLink() {
  const { items, url, loading, error } = usePoItems()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function save(e: FormEvent) {
    e.preventDefault()
    const value = draft.trim()
    if (!/^https:\/\/docs\.google\.com\/spreadsheets\/.+output=csv/.test(value)) {
      return setSaveError('Paste the link from File → Share → Publish to web, with the ITEMCODES tab and CSV picked (it ends in output=csv).')
    }
    setSaving(true)
    try {
      await savePoItemsUrl(value)
      setSaveError(null)
      setEditing(false)
    } catch (err) {
      setSaveError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  // The saved link is never shown; it can only be replaced.
  return (
    <div className="card p-5 space-y-3 max-w-3xl">
      <div>
        <h2 className="font-semibold text-slate-700">Item codes sheet</h2>
        <p className="text-sm text-slate-500">
          The Item Code suggestions on Orders come from the ITEMCODES tab: A item code, B description, C width, E length.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        {url === undefined ? (
          <span className="text-slate-400">Checking…</span>
        ) : url === null ? (
          <span className="badge bg-amber-100 text-amber-800">No link saved</span>
        ) : (
          <>
            <span className="badge bg-green-100 text-green-800">Link saved</span>
            <span className="text-slate-500">{loading && items.length === 0 ? 'Loading item codes…' : `${items.length} item codes loaded`}</span>
            <button className="text-xs underline text-slate-600" onClick={() => refreshPoItems(true)} disabled={loading}>
              Refresh
            </button>
          </>
        )}
        {url !== undefined && !editing && (
          <button
            className="text-xs underline text-slate-600"
            onClick={() => {
              setDraft('')
              setEditing(true)
            }}
          >
            {url ? 'Replace link' : 'Add link'}
          </button>
        )}
      </div>
      {error && <div className="text-sm text-red-600">{error}</div>}

      {editing && (
        <form onSubmit={save} className="space-y-2 border-t border-slate-100 pt-3">
          <div className="text-xs text-slate-500">
            In Google Sheets: File → Share → Publish to web → pick the <b>ITEMCODES</b> tab and <b>CSV</b> → Publish, then paste the link here.
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              className="input font-mono text-xs flex-1 min-w-[16rem]"
              placeholder="https://docs.google.com/spreadsheets/d/e/…/pub?gid=…&single=true&output=csv"
              autoComplete="off"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button className="btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save link'}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
          {saveError && <div className="text-sm text-red-600">{saveError}</div>}
        </form>
      )}
    </div>
  )
}

/** On Orders: only speaks up when the suggestions can't work. */
function ItemsSheetNotice() {
  const { url, error } = usePoItems()
  if (url !== null && !error) return null
  return (
    <div className="mb-3 text-xs text-amber-700">
      {url === null ? 'Item Code suggestions are off — no item codes sheet link is saved.' : `Item codes couldn't load: ${error}`}{' '}
      <Link to="/po/settings" className="underline">
        Open Settings
      </Link>
    </div>
  )
}

export type SubTab = 'orders' | 'shipments' | 'received' | 'samples' | 'notes' | 'settings'

const TABS: { id: SubTab; label: string }[] = [
  { id: 'orders', label: 'Orders' },
  { id: 'shipments', label: 'Incoming Shipments' },
  { id: 'received', label: 'Received' },
  { id: 'samples', label: 'Samples' },
  { id: 'notes', label: 'Notes' },
  { id: 'settings', label: 'Settings' },
]

const today = () => new Date().toLocaleDateString('en-CA')

const ORDER_FIELDS: RecordField[] = [
  { name: 'po_date', label: 'PO Date', type: 'date', required: true },
  { name: 'po_no', label: 'PO No.', required: true, suggest: 'po_no' },
  { name: 'supplier', label: 'Supplier', suggest: 'supplier' },
  { name: 'item_code', label: 'Item Code', suggest: 'sales_code', nextOnPick: 'supplier' },
  { name: 'description', label: 'Description' },
  { name: 'width', label: 'Width', type: 'number' },
  { name: 'length', label: 'Length', type: 'number' },
  { name: 'quantity', label: 'Qty', type: 'number' },
  { name: 'status', label: 'Status', type: 'select', required: true, options: ['Ordered', 'Partially Shipped', 'Shipped', 'Received', 'Cancelled'] },
  { name: 'remarks', label: 'Remarks', wide: true },
]

// New / edit order form, two rows; Save and Cancel sit at the end of the second.
const ORDER_FORM_ROWS = [
  [
    { name: 'po_date', className: 'w-40' },
    { name: 'po_no', className: 'w-52' },
    { name: 'item_code', className: 'flex-1 min-w-[12rem]' },
    { name: 'description', className: 'flex-1 min-w-[12rem]' },
    { name: 'supplier', className: 'flex-1 min-w-[12rem]' },
  ],
  [
    { name: 'quantity', className: 'w-40' },
    { name: 'width', className: 'w-28' },
    { name: 'length', className: 'w-28' },
    { name: 'status', className: 'w-48' },
    { name: 'remarks', className: 'w-full sm:w-96' },
  ],
]

const SHIPMENT_STATUSES =['In Transit', 'Arrived', 'Customs', 'Delayed', 'Received']

const SHIPMENT_FIELDS: RecordField[] = [
  { name: 'ship_date', label: 'Ship Date', type: 'date' },
  { name: 'eta', label: 'ETA', type: 'date' },
  { name: 'po_no', label: 'PO No.', suggest: 'po_no' },
  { name: 'supplier', label: 'Supplier', suggest: 'supplier' },
  { name: 'shipment_ref', label: 'B/L / AWB / Tracking' },
  { name: 'carrier', label: 'Forwarder / Courier' },
  { name: 'item_code', label: 'Item Code', suggest: 'item_code' },
  { name: 'description', label: 'Description' },
  { name: 'quantity', label: 'Qty', type: 'number' },
  { name: 'unit', label: 'Unit' },
  { name: 'status', label: 'Status', type: 'select', required: true, options: SHIPMENT_STATUSES },
  { name: 'received_date', label: 'Received Date', type: 'date', hideInTable: true },
  { name: 'mrr_no', label: 'MRR No.', hideInTable: true },
  { name: 'remarks', label: 'Remarks', wide: true },
]

// The Received sub-tab shows the same shipments once they're in, with when and the MRR No.
const RECEIVED_FIELDS: RecordField[] = [
  { name: 'received_date', label: 'Received Date', type: 'date' },
  { name: 'mrr_no', label: 'MRR No.' },
  ...SHIPMENT_FIELDS.filter((f) => !['received_date', 'mrr_no', 'ship_date'].includes(f.name)).map((f) => ({ ...f, hideInTable: f.name === 'status' })),
]

const SAMPLE_FIELDS: RecordField[] = [
  { name: 'request_date', label: 'Request Date', type: 'date', required: true },
  { name: 'supplier', label: 'Supplier', suggest: 'supplier' },
  { name: 'item_code', label: 'Item Code', suggest: 'item_code' },
  { name: 'description', label: 'Description' },
  { name: 'quantity', label: 'Qty', type: 'number' },
  { name: 'unit', label: 'Unit' },
  { name: 'status', label: 'Status', type: 'select', required: true, options: ['Requested', 'Received', 'Approved', 'Rejected'] },
  { name: 'received_date', label: 'Received Date', type: 'date' },
  { name: 'remarks', label: 'Remarks', wide: true },
]

const NOTE_FIELDS: RecordField[] = [
  { name: 'note_date', label: 'Date', type: 'date', required: true },
  { name: 'po_no', label: 'PO No.', suggest: 'po_no' },
  { name: 'title', label: 'Title', required: true },
  { name: 'body', label: 'Note', type: 'textarea' },
]

// Module-level so the lists keep their identity between renders (they drive the data loading).
const RECEIVED_ONLY = ['Received']

const MARK_RECEIVED: RecordAction = {
  label: 'Mark received',
  apply: (row) => {
    const date = window.prompt(`Received date for ${row.shipment_ref || row.po_no || 'this shipment'} (YYYY-MM-DD):`, today())
    if (date === null) return null
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) {
      window.alert('Use the date format YYYY-MM-DD, e.g. 2026-11-27.')
      return null
    }
    const mrr = window.prompt('MRR No. (optional):', String(row.mrr_no ?? ''))
    if (mrr === null) return null
    return { status: 'Received', received_date: date.trim(), mrr_no: mrr.trim() || null }
  },
}

const BACK_IN_TRANSIT: RecordAction = {
  label: 'Undo received',
  apply: (row) =>
    window.confirm(`Move ${row.shipment_ref || row.po_no || 'this shipment'} back to Incoming Shipments?`)
      ? { status: 'In Transit', received_date: null }
      : null,
}

/**
 * One section of the ADMIN-only Purchase Orders workspace (the sidebar picks which).
 * A record of purchase orders and what's on its way — doesn't change stock.
 */
export function PurchaseOrdersPage({ section: tab }: { section: SubTab }) {
  return (
    <div>
      <h1 className="page-title">{TABS.find((t) => t.id === tab)?.label}</h1>

      {tab === 'orders' && <ItemsSheetNotice />}
      {tab === 'settings' && <ItemsSheetLink />}
      {tab === 'orders' && (
        <RecordsTable key="orders" table="purchase_orders" noun="Order" fields={ORDER_FIELDS} formRows={ORDER_FORM_ROWS} dateField="po_date" emptyText="No purchase orders yet." />
      )}
      {tab === 'shipments' && (
        <RecordsTable
          key="shipments"
          table="po_shipments"
          noun="Shipment"
          fields={SHIPMENT_FIELDS}
          dateField="eta"
          statusNotIn={RECEIVED_ONLY}
          actions={[MARK_RECEIVED]}
          emptyText="No incoming shipments."
        />
      )}
      {tab === 'received' && (
        <>
          <p className="text-xs text-slate-500 mb-3">
            Shipments marked received. This is a record only — post the goods into stock on the Received page as usual.
          </p>
          <RecordsTable
            key="received"
            table="po_shipments"
            noun="Shipment"
            fields={RECEIVED_FIELDS}
            dateField="received_date"
            statusIn={RECEIVED_ONLY}
            actions={[BACK_IN_TRANSIT]}
            readOnlyAdd
            emptyText="Nothing received yet. Use Mark received on an incoming shipment."
          />
        </>
      )}
      {tab === 'samples' && (
        <RecordsTable key="samples" table="po_samples" noun="Sample" fields={SAMPLE_FIELDS} dateField="request_date" defaults={{ status: 'Requested' }} emptyText="No samples yet." />
      )}
      {tab === 'notes' && <RecordsTable key="notes" table="po_notes" noun="Note" fields={NOTE_FIELDS} dateField="note_date" emptyText="No notes yet." />}
    </div>
  )
}
