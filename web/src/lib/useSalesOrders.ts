import { useEffect, useState } from 'react'
import { toOrders, type OrderRow } from '../features/sales-orders/salesSheet'
import { supabase } from './supabase'

const SETTING_KEY = 'sales_sheet_csv_url'
const CACHE_MS = 5 * 60 * 1000

let cache: { at: number; orders: OrderRow[] } | null = null
let inflight: Promise<OrderRow[]> | null = null

/** Fetches the published Sales Order sheet once and shares it (5 min cache) across screens. */
function loadSalesOrders(): Promise<OrderRow[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return Promise.resolve(cache.orders)
  inflight ??= (async () => {
    try {
      // app_settings is ADMIN-only (RLS): for anyone else there's simply no link, so no suggestions.
      const { data } = await supabase.from('app_settings').select('value').eq('key', SETTING_KEY).maybeSingle()
      if (!data?.value) return []
      const res = await fetch(data.value)
      if (!res.ok) return []
      const orders = toOrders(await res.text())
      cache = { at: Date.now(), orders }
      return orders
    } catch {
      return []
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** Job Orders matching what's typed in a Withdrawal No. box (prefix matches first, one per Job Order, max 15). */
export function matchJobOrders(orders: OrderRow[], typed: string): OrderRow[] {
  const q = typed.trim().toLowerCase()
  if (q.length < 2) return []
  const seen = new Set<string>()
  const starts: OrderRow[] = []
  const contains: OrderRow[] = []
  for (const o of orders) {
    const j = o.jobOrder.toLowerCase()
    if (seen.has(j) || !j.includes(q)) continue
    seen.add(j)
    ;(j.startsWith(q) ? starts : contains).push(o)
  }
  return [...starts, ...contains].slice(0, 15)
}

/** True when a Withdrawal No. change came from picking a browser suggestion rather than typing. */
export function isSuggestionPick(e: { nativeEvent: Event }): boolean {
  const inputType = (e.nativeEvent as InputEvent).inputType
  return inputType === 'insertReplacementText' || inputType === undefined
}

/** Sales orders from the Google Sheet for autocomplete; empty until loaded, or if unavailable. */
export function useSalesOrders(): OrderRow[] {
  const [orders, setOrders] = useState<OrderRow[]>(cache?.orders ?? [])
  useEffect(() => {
    let alive = true
    loadSalesOrders().then((o) => alive && setOrders(o))
    return () => {
      alive = false
    }
  }, [])
  return orders
}
