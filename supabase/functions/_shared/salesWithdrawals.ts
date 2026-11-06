import { parseCsv } from './csv.ts'
import type { OrderRow } from './salesSheet.ts'

/** One row of the "ITEMCODE V2 SBASE" lookup tab: a sheet Item ID + size → our item code. */
export interface LookupRow {
  itemId: string
  description: string
  width: number | null
  length: number | null
  itemCode: string
}

/** The columns of current_stock used here. */
export interface PlanItem {
  item_id: string
  item_code: string
  description: string
  width: number | null
  width_unit: string | null
  length: number | null
  length_unit: string | null
  on_hand: number
}

export interface YardsRoll {
  roll_id: string
  roll_no: string | null
  item_id: string
  item_code: string
  active: boolean
  remaining_yards: number
}

export interface PlanRow {
  order: OrderRow
  /** ready = can post; input = waiting on a choice; blocked = can't post; done = already withdrawn; changed = sheet no longer matches the withdrawal */
  state: 'ready' | 'input' | 'blocked' | 'done' | 'changed'
  note: string
  target: 'stock' | 'yards'
  candidates: string[]
  item: PlanItem | null
  roll: YardsRoll | null
  quantity: number
}

export interface PlanInput {
  orders: OrderRow[]
  lookup: LookupRow[]
  /** First and last sales order date to include (YYYY-MM-DD). */
  from: string
  to: string
  items: PlanItem[]
  rolls: YardsRoll[]
  /** "JOBORDER|item_id" → quantity on live withdrawals */
  withdrawn: Map<string, number>
  itemChoice: Record<string, string>
  coreChoice: Record<string, string>
  excluded: Set<string>
}

const APPLIED_STATUSES = new Set(['DELIVERY', 'PICK-UP', 'WAITING'])

const upper = (s: string) => s.trim().toUpperCase().replace(/\s+/g, ' ')

/** "48", "0.375", "3/8" and "1-1/4" → a number; blank or anything else → null. */
export function parseSize(value: string): number | null {
  const v = value.trim()
  if (!v) return null
  const fraction = v.match(/^(?:(\d+)[-\s])?(\d+)\/(\d+)$/)
  if (fraction) {
    const [, whole, top, bottom] = fraction
    return Number(bottom) ? Number(whole ?? 0) + Number(top) / Number(bottom) : null
  }
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function withdrawnKey(jobOrder: string, itemId: string) {
  return `${upper(jobOrder)}|${itemId}`
}

export function toLookup(text: string): LookupRow[] {
  const [headers = [], ...rows] = parseCsv(text)
  // WIDTH / LENGTH appear twice in this tab: C, D are the ones to match, and they come first.
  const col = (name: string) => {
    const i = headers.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase())
    if (i === -1) throw new Error(`The lookup sheet has no "${name}" column — was it renamed or moved?`)
    return i
  }
  const idx = {
    itemId: col('ITEMCODE'),
    description: col('ITEM DESCRIPTION'),
    width: col('WIDTH'),
    length: col('LENGTH'),
    itemCode: col('ITEMCODE IN FRONTEND'),
  }
  const cell = (r: string[], i: number) => (r[i] ?? '').trim()
  return rows
    .filter((r) => cell(r, idx.itemId))
    .map((r) => ({
      itemId: cell(r, idx.itemId),
      description: cell(r, idx.description),
      width: parseSize(cell(r, idx.width)),
      length: parseSize(cell(r, idx.length)),
      itemCode: cell(r, idx.itemCode),
    }))
}

type Match =
  | { kind: 'stock' | 'yards'; candidates: string[]; quantity: number }
  | { kind: 'manual'; note: string; quantity: number }

/**
 * Applies the lookup rules to one sales order. Returns null for orders that aren't ours to
 * apply: Item IDs not on the lookup tab, and cancelled orders.
 */
export function matchOrder(order: OrderRow, lookup: LookupRow[]): Match | null {
  const id = upper(order.itemId)
  const rows = lookup.filter((l) => upper(l.itemId) === id)
  if (rows.length === 0) return null

  const status = upper(order.status ?? '')
  if (status === 'CANCELLED') return null
  const quantity = Number((order.quantity ?? '').replace(/,/g, ''))
  const manual = (note: string): Match => ({ kind: 'manual', note, quantity })
  if (!status) return manual('Sales order has no status')
  if (!APPLIED_STATUSES.has(status)) return manual(`Status "${order.status}"`)
  if (!(quantity > 0)) return manual(`Quantity "${order.quantity}" isn't a number`)

  const codes = (found: LookupRow[]) => [...new Set(found.map((l) => l.itemCode).filter(Boolean))]
  const width = parseSize(order.width)
  const length = parseSize(order.length)
  const unit = upper(order.unit ?? '')

  // Part of a roll: comes out of Yards Stock. The Core No. picks the exact roll, so a width
  // that isn't on the lookup falls back to any of this item's codes instead of stopping here.
  if (unit === 'YDS') {
    const sameWidth = codes(width === null ? rows : rows.filter((l) => l.width === width))
    const candidates = sameWidth.length ? sameWidth : codes(rows)
    return candidates.length ? { kind: 'yards', candidates, quantity } : manual('Lookup row has no ITEMCODE IN FRONTEND')
  }
  if (!unit) return manual('Sales order has no unit')
  if (unit === 'M') return manual('Unit M — enter by hand')

  if (width !== null && length !== null) {
    const found = rows.filter((l) => l.width === width && l.length === length)
    if (found.length === 0) return manual(`Size ${order.width} × ${order.length} isn't on the lookup`)
    const candidates = codes(found)
    return candidates.length ? { kind: 'stock', candidates, quantity } : manual('Lookup row has no ITEMCODE IN FRONTEND')
  }

  // No size on the order: only SR_ and NR_ items may be matched by description.
  if (!/^(SR|NR)_/.test(id)) return manual('No width and length on the sales order')
  const found = rows.filter((l) => upper(l.description) === upper(order.itemDescription))
  if (found.length === 0) return manual(`Description isn't on the lookup`)
  const candidates = codes(found)
  return candidates.length ? { kind: 'stock', candidates, quantity } : manual('Lookup row has no ITEMCODE IN FRONTEND')
}

/** Arguments of post_sales_order_withdrawal for a stock row. */
export function withdrawalParams(p: PlanRow, remark: string) {
  const { order: o, item, quantity } = p
  return {
    p_item_id: item!.item_id,
    p_quantity: quantity,
    p_entry_date: o.date,
    p_job_order: o.jobOrder,
    p_customer: o.customer || null,
    p_remarks: remark,
    p_width: parseSize(o.width) ?? item!.width,
    p_width_unit: o.widthUnit || item!.width_unit,
    p_length: parseSize(o.length) ?? item!.length,
    p_length_unit: o.lengthUnit || item!.length_unit,
    p_description: o.itemDescription || item!.description,
  }
}

/** One screen's worth of decisions for a date range: what can post, and why the rest can't. */
export function buildPlan(input: PlanInput): PlanRow[] {
  const { orders, lookup, from, to, items, rolls, withdrawn, itemChoice, coreChoice, excluded } = input
  const itemByCode = new Map(items.map((i) => [upper(i.item_code), i]))
  const stockLeft = new Map(items.map((i) => [i.item_id, Number(i.on_hand)]))
  const rollLeft = new Map(rolls.map((r) => [r.roll_id, Number(r.remaining_yards)]))
  const seen = new Set<string>()
  const plan: PlanRow[] = []

  const lookupById = new Map<string, LookupRow[]>()
  for (const l of lookup) {
    const id = upper(l.itemId)
    lookupById.set(id, [...(lookupById.get(id) ?? []), l])
  }

  // Oldest first, so when stock runs short it's the later orders that wait.
  const rangeOrders = orders
    .filter((o) => o.date >= from && o.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date) || a.jobOrder.localeCompare(b.jobOrder, undefined, { numeric: true }))

  for (const order of rangeOrders) {
    const orderLookup = lookupById.get(upper(order.itemId)) ?? []
    const liveQuantity = (lookupRows: { itemCode: string }[]) => {
      const keys = lookupRows.flatMap((l) => itemByCode.get(upper(l.itemCode)) ?? []).map((i) => withdrawnKey(order.jobOrder, i.item_id))
      return keys.map((k) => withdrawn.get(k)).find((q) => q !== undefined)
    }

    const match = matchOrder(order, orderLookup)
    if (!match) {
      const posted = upper(order.status ?? '') === 'CANCELLED' ? liveQuantity(orderLookup) : undefined
      if (posted !== undefined) {
        plan.push({
          order, quantity: posted, item: null, roll: null, candidates: [], target: 'stock', state: 'changed',
          note: 'Cancelled in the sheet — void this withdrawal',
        })
      }
      continue
    }
    const { quantity } = match
    const base = { order, quantity, item: null, roll: null, candidates: [] as string[] }

    if (match.kind === 'manual') {
      plan.push({ ...base, target: 'stock', state: 'blocked', note: match.note })
      continue
    }

    const { candidates, kind: target } = match
    const row = { ...base, target, candidates }
    const posted = liveQuantity(candidates.map((itemCode) => ({ itemCode })))
    if (posted === quantity) {
      plan.push({ ...row, state: 'done', note: 'Already withdrawn' })
      continue
    }
    if (posted !== undefined) {
      plan.push({ ...row, state: 'changed', note: `Sheet says ${quantity}, withdrawn ${posted} — void it to re-post` })
      continue
    }

    const claim = (itemId: string) => {
      const key = withdrawnKey(order.jobOrder, itemId)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }
    const isIn = !excluded.has(order.key)

    if (target === 'yards') {
      const core = (coreChoice[order.key] ?? '').trim()
      if (!core) {
        plan.push({ ...row, state: 'input', note: 'Enter the Core No.' })
        continue
      }
      const roll = rolls.find((r) => r.active && upper(r.roll_no ?? '') === upper(core)) ?? null
      if (!roll) {
        plan.push({ ...row, state: 'input', note: `No active roll with Core No. ${core}` })
        continue
      }
      if (!candidates.some((c) => upper(c) === upper(roll.item_code))) {
        plan.push({ ...row, state: 'input', note: `Core No. ${core} is ${roll.item_code}, not this item` })
        continue
      }
      const left = rollLeft.get(roll.roll_id) ?? 0
      if (quantity > left) {
        plan.push({ ...row, roll, state: 'blocked', note: `Only ${left} yd left on this roll` })
        continue
      }
      if (!claim(roll.item_id)) {
        plan.push({ ...row, roll, state: 'blocked', note: 'Same job order and item twice in the sheet' })
        continue
      }
      if (isIn) rollLeft.set(roll.roll_id, left - quantity)
      plan.push({ ...row, roll, state: 'ready', note: '' })
      continue
    }

    const code = candidates.length === 1 ? candidates[0] : itemChoice[order.key]
    if (!code) {
      plan.push({ ...row, state: 'input', note: 'Choose the item' })
      continue
    }
    const item = itemByCode.get(upper(code)) ?? null
    if (!item) {
      plan.push({ ...row, state: 'blocked', note: `${code} isn't in Items` })
      continue
    }
    const left = stockLeft.get(item.item_id) ?? 0
    if (quantity > left) {
      plan.push({ ...row, item, state: 'blocked', note: `Not enough stock: ${left} on hand` })
      continue
    }
    if (!claim(item.item_id)) {
      plan.push({ ...row, item, state: 'blocked', note: 'Same job order and item twice in the sheet' })
      continue
    }
    if (isIn) stockLeft.set(item.item_id, left - quantity)
    plan.push({ ...row, item, state: 'ready', note: '' })
  }
  return plan
}
