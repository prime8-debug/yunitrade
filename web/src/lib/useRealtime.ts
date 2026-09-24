import { useEffect, useRef } from 'react'
import { supabase } from './supabase'

/**
 * Calls `onChange` whenever any of the given tables change in the database,
 * so every open desktop/mobile screen refreshes without manual sync.
 */
export function useRealtime(tables: string[], onChange: () => void) {
  const cb = useRef(onChange)
  useEffect(() => {
    cb.current = onChange
  })
  const key = tables.join(',')

  useEffect(() => {
    const channel = supabase.channel(`rt-${key}-${Math.random().toString(36).slice(2)}`)
    for (const table of key.split(',')) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => cb.current())
    }
    channel.subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [key])
}
