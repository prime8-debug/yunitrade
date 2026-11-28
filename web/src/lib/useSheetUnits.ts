import { useEffect, useState } from 'react'
import { parseCsv } from '../../../supabase/functions/_shared/csv.ts'
import { LOOKUP_URL_KEY } from '../../../supabase/functions/_shared/autoWithdrawals.ts'
import { errorMessage, supabase } from './supabase'

/**
 * UNIT per item, from the "ITEMCODE V2 SBASE" tab (the same published lookup sheet the
 * automatic withdrawals use). Rows are matched to our items through ITEMCODE IN FRONTEND;
 * the unit is the UNIT column (K). Several sheet rows can point at one item: the first
 * non-blank unit wins.
 */
export function toUnits(text: string): Map<string, string> {
  const [headers = [], ...rows] = parseCsv(text)
  const find = (name: string) => headers.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase())
  const codeCol = find('ITEMCODE IN FRONTEND')
  const unitCol = find('UNIT') === -1 ? 10 : find('UNIT') // K, if the header is ever renamed
  if (codeCol === -1) throw new Error('The ITEMCODE V2 SBASE tab has no "ITEMCODE IN FRONTEND" column — was it renamed or moved?')
  const units = new Map<string, string>()
  for (const r of rows) {
    const code = (r[codeCol] ?? '').trim().toUpperCase()
    const unit = (r[unitCol] ?? '').trim()
    if (code && unit && !units.has(code)) units.set(code, unit)
  }
  return units
}

export function useSheetUnits() {
  const [units, setUnits] = useState<Map<string, string>>(new Map())
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { data, error } = await supabase.from('app_settings').select('value').eq('key', LOOKUP_URL_KEY).maybeSingle()
        if (error) throw error
        if (!data?.value) throw new Error('UNIT comes from the ITEMCODE V2 SBASE sheet, whose link only ADMIN accounts can read (and it must be set in Sales Orders → Apply Withdrawals), so UNIT is blank.')
        const res = await fetch(data.value, { cache: 'no-store' })
        if (!res.ok) throw new Error(`The ITEMCODE V2 SBASE sheet couldn't be downloaded (HTTP ${res.status}), so UNIT is blank.`)
        const next = toUnits(await res.text())
        if (!cancelled) setUnits(next)
      } catch (e) {
        if (!cancelled) setError(errorMessage(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return { units, error, unitOf: (code: string) => units.get(code.trim().toUpperCase()) ?? '' }
}
