import { useEffect, useState } from 'react'
import { supabase } from './supabase'

export interface StockYear {
  start_date: string
  closed_at: string
}

/** The current stock year, or null if the year-end clear was never used. undefined while loading. */
export function useStockYear(): StockYear | null | undefined {
  const [year, setYear] = useState<StockYear | null | undefined>(undefined)
  useEffect(() => {
    supabase
      .from('stock_years')
      .select('start_date, closed_at')
      .order('start_date', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data, error }) => setYear(error ? null : (data as StockYear | null)))
  }, [])
  return year
}

/** PostgREST filter for "this year's records" on a table with entry_date and created_at. */
export function yearFilter(year: StockYear) {
  return `entry_date.gte.${year.start_date},created_at.gt."${year.closed_at}"`
}

export function inYear(year: StockYear | null | undefined, date: string, createdAt: string) {
  return !year || date >= year.start_date || new Date(createdAt) > new Date(year.closed_at)
}
