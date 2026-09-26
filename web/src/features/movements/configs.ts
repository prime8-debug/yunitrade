export interface MovementField {
  /** column name in the table */
  name: string
  /** matching RPC parameter */
  param: string
  label: string
  wide?: boolean
}

export interface MovementConfig {
  title: string
  table: 'beginning_inventory' | 'receipts' | 'withdrawals'
  rpc: 'post_beginning' | 'post_receipt' | 'post_withdrawal'
  /** warn in the UI before the server rejects it */
  checksStock: boolean
  fields: MovementField[]
  /** Show the full item catalog (with filter) instead of a Recent entries / void list below the form. */
  showCatalog?: boolean
}

export const BEGINNING: MovementConfig = {
  title: 'Beginning Inventory',
  table: 'beginning_inventory',
  rpc: 'post_beginning',
  checksStock: false,
  fields: [{ name: 'notes', param: 'p_notes', label: 'Notes', wide: true }],
  showCatalog: true,
}

export const RECEIVED: MovementConfig = {
  title: 'Received',
  table: 'receipts',
  rpc: 'post_receipt',
  checksStock: false,
  fields: [
    { name: 'mrr_no', param: 'p_mrr_no', label: 'MRR No.' },
    { name: 'supplier', param: 'p_supplier', label: 'Supplier' },
    { name: 'reference', param: 'p_reference', label: 'Reference' },
    { name: 'remarks', param: 'p_remarks', label: 'Remarks' },
  ],
}

export const WITHDRAW: MovementConfig = {
  title: 'Withdraw',
  table: 'withdrawals',
  rpc: 'post_withdrawal',
  checksStock: true,
  fields: [
    { name: 'withdrawal_no', param: 'p_withdrawal_no', label: 'Withdrawal No.' },
    { name: 'customer', param: 'p_customer', label: 'Customer' },
    { name: 'remarks', param: 'p_remarks', label: 'Remarks', wide: true },
  ],
}
