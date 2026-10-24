import { parseCsv } from '../../lib/csv.ts'

export interface OrderRow {
  key: string
  date: string
  jobOrder: string
  customer: string
  quantity: string
  width: string
  widthUnit: string
  length: string
  lengthUnit: string
  itemId: string
  itemDescription: string
}

/**
 * The sheet has two header rows (group names like "JOB ORDER", then sub-names like
 * "Job Order No."), so look a column up by its sub-name first, then its group name.
 */
function findColumn(headers: string[][], name: string): number {
  const want = name.toLowerCase()
  for (const row of [headers[1] ?? [], headers[0] ?? []]) {
    const i = row.findIndex((h) => h.trim().toLowerCase() === want)
    if (i !== -1) return i
  }
  throw new Error(`The sheet has no "${name}" column — was it renamed or moved?`)
}

export function toOrders(text: string): OrderRow[] {
  const rows = parseCsv(text)
  const headers = rows.slice(0, 2)
  const idx = {
    date: findColumn(headers, 'DATE'),
    jobNo: findColumn(headers, 'Job Order No.'),
    subKey: findColumn(headers, 'Job Order SubKey'),
    customer: findColumn(headers, 'Customer Name'),
    quantity: findColumn(headers, 'QUANTITY'),
    width: findColumn(headers, 'WIDTH'),
    widthUnit: findColumn(headers, 'Unit (W)'),
    length: findColumn(headers, 'LENGTH'),
    lengthUnit: findColumn(headers, 'Unit (L)'),
    itemId: findColumn(headers, 'Item ID'),
    itemDescription: findColumn(headers, 'Item Description'),
  }
  const cell = (r: string[], i: number) => (r[i] ?? '').trim()

  const orders: OrderRow[] = []
  rows.slice(2).forEach((r, n) => {
    const jobNo = cell(r, idx.jobNo)
    if (!jobNo) return // spacer rows / stray cells
    const subKey = cell(r, idx.subKey)
    orders.push({
      key: String(n),
      date: cell(r, idx.date),
      jobOrder: subKey ? `${jobNo}-${subKey}` : jobNo,
      customer: cell(r, idx.customer),
      quantity: cell(r, idx.quantity),
      width: cell(r, idx.width),
      widthUnit: cell(r, idx.widthUnit),
      length: cell(r, idx.length),
      lengthUnit: cell(r, idx.lengthUnit),
      itemId: cell(r, idx.itemId),
      itemDescription: cell(r, idx.itemDescription),
    })
  })
  // Newest first; rows on the same date keep "added later in the sheet = higher up".
  return orders.reverse().sort((a, b) => b.date.localeCompare(a.date))
}
