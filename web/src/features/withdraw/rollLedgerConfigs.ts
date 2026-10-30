export interface RollLedgerConfig {
  title: string
  /** what the quantity means, shown in labels e.g. "Yards" / "Qty" */
  unitLabel: string
  stockView: 'yards_roll_stock' | 'partial_roll_stock'
  rollTable: 'yards_rolls' | 'partial_rolls'
  transactionsTable: 'yards_transactions' | 'partial_roll_transactions'
  remainingField: 'remaining_yards' | 'remaining_quantity'
  createRpc: 'create_yards_roll' | 'create_partial_roll'
  createQtyParam: 'p_received_yards' | 'p_quantity'
  withdrawRpc: 'withdraw_yards' | 'withdraw_partial_roll'
  rollIdParam: 'p_roll_id' | 'p_partial_roll_id'
  /** ADMIN-only RPC to correct a roll's number / item / starting quantity. */
  editRpc?: 'update_yards_roll' | 'update_partial_roll'
  editQtyParam?: 'p_received_yards' | 'p_quantity'
  /** Per-roll totals (received / withdrawn / balance), used to load a roll for editing. */
  summaryView: 'yards_stock_summary' | 'partial_stock_summary'
  /** Roll has its own Width box (Yards only); defaults to the item's catalog width. */
  hasWidth?: boolean
  /** Roll has its own Width and Length boxes after the quantity (Partial only). */
  hasSize?: boolean
}

export const YARDS: RollLedgerConfig = {
  title: '3M Yards',
  unitLabel: 'Yards',
  stockView: 'yards_roll_stock',
  rollTable: 'yards_rolls',
  transactionsTable: 'yards_transactions',
  remainingField: 'remaining_yards',
  createRpc: 'create_yards_roll',
  createQtyParam: 'p_received_yards',
  withdrawRpc: 'withdraw_yards',
  rollIdParam: 'p_roll_id',
  editRpc: 'update_yards_roll',
  editQtyParam: 'p_received_yards',
  summaryView: 'yards_stock_summary',
  hasWidth: true,
}

export const PARTIAL: RollLedgerConfig = {
  title: 'Partial Roll',
  unitLabel: 'Quantity',
  stockView: 'partial_roll_stock',
  rollTable: 'partial_rolls',
  transactionsTable: 'partial_roll_transactions',
  remainingField: 'remaining_quantity',
  createRpc: 'create_partial_roll',
  createQtyParam: 'p_quantity',
  withdrawRpc: 'withdraw_partial_roll',
  rollIdParam: 'p_partial_roll_id',
  editRpc: 'update_partial_roll',
  editQtyParam: 'p_quantity',
  summaryView: 'partial_stock_summary',
  hasSize: true,
}
