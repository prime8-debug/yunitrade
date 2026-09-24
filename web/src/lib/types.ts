export type Role = 'USER' | 'ADMIN'

export interface Profile {
  id: string
  email: string | null
  display_name: string | null
  role: Role
  active: boolean
}

export interface Item {
  id: string
  item_code: string
  description: string
  width: number | null
  width_unit: string | null
  length: number | null
  length_unit: string | null
  category: string | null
  active: boolean
}

export interface StockRow {
  item_id: string
  item_code: string
  description: string
  width: number | null
  width_unit: string | null
  length: number | null
  length_unit: string | null
  category: string | null
  active: boolean
  on_hand: number
  beginning: number
  received: number
  withdrawn: number
  last_movement_at: string | null
}

export type TransactionType =
  | 'BEGINNING'
  | 'RECEIVED'
  | 'WITHDRAWAL'
  | 'SPLIT_PARENT'
  | 'SPLIT_CHILD'
  | 'ADJUSTMENT'
  | 'DISPOSAL'
  | 'RETURN'
  | 'REVERSAL'

export interface LedgerRow {
  id: string
  transaction_date: string
  transaction_type: TransactionType
  item_id: string
  quantity: number
  reference_type: string | null
  reference_id: string | null
  reversal_of: string | null
  remarks: string | null
  created_at: string
  created_by_profile: { display_name: string | null } | null
}

export function formatSize(i: Pick<Item, 'width' | 'width_unit' | 'length' | 'length_unit'>): string {
  const w = i.width != null ? `${i.width}${i.width_unit ?? ''}` : ''
  const l = i.length != null ? `${i.length}${i.length_unit ?? ''}` : ''
  return [w, l].filter(Boolean).join(' × ')
}

export function formatQty(n: number): string {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 3 })
}
