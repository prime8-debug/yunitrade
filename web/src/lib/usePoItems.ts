import { useEffect, useSyncExternalStore } from 'react'
import { parseCsv } from '../../../supabase/functions/_shared/csv.ts'
import { errorMessage, supabase } from './supabase'

/** app_settings key holding the ITEMCODES tab's "Publish to web" CSV link. */
export const PO_ITEMS_URL_KEY = 'po_items_csv_url'

export interface PoItem {
  code: string
  description: string
  width: string
  length: string
}

// ITEMCODES tab columns, by position: A = item code, B = description, C = width, E = length.
const COL = { code: 0, description: 1, width: 2, length: 4 }
const FRESH_MS = 5 * 60 * 1000 // Google re-publishes the CSV about every 5 minutes

type State = { items: PoItem[]; url: string | null | undefined; loading: boolean; error: string | null; at: number }

let state: State = { items: [], url: undefined, loading: false, error: null, at: 0 }
const listeners = new Set<() => void>()
let inflight: Promise<void> | null = null

function setState(patch: Partial<State>) {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

export function toPoItems(text: string): PoItem[] {
  const [, ...rows] = parseCsv(text) // row 1 is the header
  const cell = (r: string[], i: number) => (r[i] ?? '').trim()
  // A code can be listed more than once (e.g. SPYBK_HM on one row without a size and again
  // with 42 × 500). Keep one entry per code, filling its blanks from the later rows.
  const byCode = new Map<string, PoItem>()
  for (const r of rows) {
    const code = cell(r, COL.code)
    if (!code) continue
    const row = { code, description: cell(r, COL.description), width: cell(r, COL.width), length: cell(r, COL.length) }
    const prev = byCode.get(code.toUpperCase())
    if (!prev) {
      byCode.set(code.toUpperCase(), row)
      continue
    }
    if (!prev.description) prev.description = row.description
    // Width and length go together, so take both from the first row that has a size.
    if (!prev.width && !prev.length) {
      prev.width = row.width
      prev.length = row.length
    }
  }
  return [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code))
}

/** Loads the Items sheet (at most every 5 minutes unless forced). */
export function refreshPoItems(force = false): Promise<void> {
  if (inflight) return inflight
  if (!force && state.url !== undefined && Date.now() - state.at < FRESH_MS) return Promise.resolve()
  inflight = (async () => {
    setState({ loading: true, error: null })
    try {
      const { data, error } = await supabase.from('app_settings').select('value').eq('key', PO_ITEMS_URL_KEY).maybeSingle()
      if (error) throw error
      const url = data?.value || null
      if (!url) return setState({ url: null, items: [], at: Date.now() })
      const res = await fetch(url, { cache: 'no-store' })
      if (!res.ok) throw new Error(`The Items sheet couldn't be downloaded (HTTP ${res.status}). Check the link.`)
      setState({ url, items: toPoItems(await res.text()), at: Date.now() })
    } catch (e) {
      setState({ error: errorMessage(e) })
    } finally {
      setState({ loading: false })
      inflight = null
    }
  })()
  return inflight
}

export async function savePoItemsUrl(value: string) {
  const { error } = await supabase.from('app_settings').upsert({ key: PO_ITEMS_URL_KEY, value, updated_at: new Date().toISOString() })
  if (error) throw error
  await refreshPoItems(true)
}

export function usePoItems(enabled = true) {
  const snapshot = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state,
  )
  useEffect(() => {
    if (enabled) refreshPoItems()
  }, [enabled])
  return snapshot
}
