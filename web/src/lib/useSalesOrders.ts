import { useEffect, useSyncExternalStore } from 'react'
import { toOrders, type OrderRow } from '../features/sales-orders/salesSheet'
import { supabase } from './supabase'

const SETTING_KEY = 'sales_sheet_csv_url'
const FRESH_MS = 5 * 60 * 1000 // Google only re-publishes the CSV every ~5 minutes anyway

// The last download is kept in this browser (IndexedDB) so the page can show it instantly
// while a fresh copy loads. It's tagged with the user it belongs to and wiped on sign-out.
const DB_NAME = 'yunitrade'
const DB_STORE = 'cache'
const DB_KEY = 'salesOrders'

type Saved = { userId: string; at: number; orders: OrderRow[] }

export type SalesOrdersState = {
  orders: OrderRow[]
  loadedAt: Date | null
  loading: boolean
  error: string | null
}

let state: SalesOrdersState = { orders: [], loadedAt: null, loading: false, error: null }
const listeners = new Set<() => void>()
let inflight: Promise<void> | null = null
let restored: Promise<void> | null = null

function setState(patch: Partial<SalesOrdersState>) {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function dbRun<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(DB_STORE, mode).objectStore(DB_STORE))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

async function currentUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getSession()
  return data.session?.user.id ?? null
}

/** Puts the copy saved in this browser on screen (once), if it belongs to the signed-in user. */
function restoreSaved(): Promise<void> {
  restored ??= (async () => {
    try {
      const [saved, userId] = await Promise.all([dbRun<Saved | undefined>('readonly', (s) => s.get(DB_KEY)), currentUserId()])
      if (saved && userId && saved.userId === userId && !state.loadedAt) {
        setState({ orders: saved.orders, loadedAt: new Date(saved.at) })
      }
    } catch {
      // No IndexedDB (private window etc.) — just load from the sheet.
    }
  })()
  return restored
}

/**
 * Shows the saved copy right away, then downloads the sheet in the background unless the
 * copy is under 5 minutes old. `force` always downloads (the Refresh button, a new link).
 */
export function refreshSalesOrders(force = false): Promise<void> {
  inflight ??= (async () => {
    await restoreSaved()
    if (!force && state.loadedAt && Date.now() - state.loadedAt.getTime() < FRESH_MS) return
    setState({ loading: true })
    try {
      // app_settings is ADMIN-only (RLS): for anyone else there's simply no link, so nothing to load.
      const { data } = await supabase.from('app_settings').select('value').eq('key', SETTING_KEY).maybeSingle()
      if (!data?.value) return setState({ error: null })
      const res = await fetch(data.value, { cache: 'no-store' })
      if (!res.ok) throw new Error(`Google Sheets returned ${res.status} — is the sheet still published to the web?`)
      const orders = toOrders(await res.text())
      const at = Date.now()
      setState({ orders, loadedAt: new Date(at), error: null })
      const userId = await currentUserId()
      if (userId) dbRun('readwrite', (s) => s.put({ userId, at, orders } satisfies Saved, DB_KEY)).catch(() => {})
    } catch (e) {
      setState({ error: e instanceof Error ? e.message : String(e) })
    } finally {
      setState({ loading: false })
    }
  })().finally(() => {
    inflight = null
  })
  return inflight
}

/** Forgets the sales orders in memory and in this browser (on sign-out). */
export async function clearSalesOrdersCache(): Promise<void> {
  state = { orders: [], loadedAt: null, loading: false, error: null }
  restored = null
  listeners.forEach((l) => l())
  try {
    await dbRun('readwrite', (s) => s.delete(DB_KEY))
  } catch {
    // nothing saved
  }
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

function subscribe(l: () => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** Sales orders plus loading info, kept fresh in the background (every 5 minutes while mounted). */
export function useSalesOrdersState(): SalesOrdersState {
  const s = useSyncExternalStore(subscribe, () => state)
  useEffect(() => {
    refreshSalesOrders()
    const t = setInterval(() => refreshSalesOrders(), FRESH_MS)
    return () => clearInterval(t)
  }, [])
  return s
}

/** Sales orders from the Google Sheet for autocomplete; empty until loaded, or if unavailable. */
export function useSalesOrders(): OrderRow[] {
  return useSalesOrdersState().orders
}
