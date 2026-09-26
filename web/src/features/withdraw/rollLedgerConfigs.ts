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
}
