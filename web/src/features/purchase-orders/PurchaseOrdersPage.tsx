import { RecordsTable, type RecordAction, type RecordField } from './RecordsTable'

export type SubTab ='orders' | 'shipments' | 'received' | 'samples' | 'notes'

const TABS: { id: SubTab; label: string }[] = [
  { id: 'orders', label: 'Orders' },
  { id: 'shipments', label: 'Incoming Shipments' },
  { id: 'received', label: 'Received' },
  { id: 'samples', label: 'Samples' },
  { id: 'notes', label: 'Notes' },
]

const today = () => new Date().toLocaleDateString('en-CA')

const ORDER_FIELDS: RecordField[] = [
  { name: 'po_date', label: 'PO Date', type: 'date', required: true },
  { name: 'po_no', label: 'PO No.', required: true, suggest: 'po_no' },
  { name: 'supplier', label: 'Supplier', suggest: 'supplier' },
  { name: 'item_code', label: 'Item Code', suggest: 'item_code' },
  { name: 'description', label: 'Description' },
  { name: 'quantity', label: 'Qty', type: 'number' },
  { name: 'eta', label: 'ETA', type: 'date' },
  { name: 'status', label: 'Status', type: 'select', required: true, options: ['Ordered', 'Partially Shipped', 'Shipped', 'Received', 'Cancelled'] },
  { name: 'remarks', label: 'Remarks', wide: true },
]

const SHIPMENT_STATUSES = ['In Transit', 'Arrived', 'Customs', 'Delayed', 'Received']

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

      {tab === 'orders' && (
        <RecordsTable key="orders" table="purchase_orders" noun="Order" fields={ORDER_FIELDS} dateField="po_date" emptyText="No purchase orders yet." />
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
