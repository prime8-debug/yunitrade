import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import type { Profile } from '../lib/types'

interface AuthState {
  session: Session | null
  profile: Profile | null
  loading: boolean
  isAdmin: boolean
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      if (!data.session) setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!session) {
      setProfile(null)
      return
    }
    // Supabase refreshes the session in the background (including when the tab
    // regains focus after being backgrounded), which re-fires this effect with a
    // new session object for the SAME user. Deliberately not calling setLoading(true)
    // here: doing so would flash the full-page loader and unmount every page below
    // it — resetting things like WithdrawPage's selected sub-tab — for a refresh
    // that doesn't need to block anything. Only the very first load (loading starts
    // true) shows the loader; this just keeps the profile fresh in the background.
    let cancelled = false
    supabase
      .from('profiles')
      .select('id, email, display_name, role, active')
      .eq('id', session.user.id)
      .single()
      .then(({ data }) => {
        if (cancelled) return
        setProfile(data as Profile | null)
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [session])

  const value: AuthState = {
    session,
    profile,
    loading,
    isAdmin: profile?.role === 'ADMIN' && profile.active,
    signOut: async () => {
      await supabase.auth.signOut()
    },
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
