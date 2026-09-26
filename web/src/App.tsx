// HashRouter: GitHub Pages has no SPA fallback, so /withdraw would 404 on refresh.
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './auth/AuthProvider'
import { Layout, NAV } from './components/Layout'
import { ItemsPage } from './features/items/ItemsPage'
import { BEGINNING, RECEIVED } from './features/movements/configs'
import { MovementPage } from './features/movements/MovementPage'
import { StocksPage } from './features/stocks/StocksPage'
import { WithdrawPage } from './features/withdraw/WithdrawPage'
import { supabaseConfigured } from './lib/supabase'
import { ComingSoon } from './pages/ComingSoon'
import { LoginPage } from './pages/LoginPage'

function Gate() {
  const { session, profile, loading, isAdmin, signOut } = useAuth()

  if (loading) return <div className="min-h-screen grid place-items-center text-slate-400">Loading…</div>
  if (!session) return <LoginPage />
  if (!profile || !profile.active) {
    return (
      <div className="min-h-screen grid place-items-center text-center p-6">
        <div>
          <p className="mb-3 text-slate-700">Your account is not active. Ask an ADMIN to enable it.</p>
          <button className="btn-secondary" onClick={signOut}>
            Sign out
          </button>
        </div>
      </div>
    )
  }

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<StocksPage />} />
        <Route path="beginning" element={<MovementPage key="beginning" config={BEGINNING} />} />
        <Route path="withdraw" element={<WithdrawPage />} />
        <Route path="received" element={<MovementPage key="received" config={RECEIVED} />} />
        <Route path="items" element={isAdmin ? <ItemsPage /> : <Navigate to="/" />} />
        {NAV.filter((n) => n.soon).map((n) => (
          <Route key={n.to} path={n.to.slice(1)} element={<ComingSoon title={n.label} />} />
        ))}
        <Route path="*" element={<Navigate to="/" />} />
      </Route>
    </Routes>
  )
}

export default function App() {
  if (!supabaseConfigured) {
    return (
      <div className="min-h-screen grid place-items-center p-6">
        <div className="card p-6 max-w-md">
          <h1 className="font-bold mb-2">Supabase not configured</h1>
          <p className="text-sm text-slate-600">
            Copy <code>web/.env.example</code> to <code>web/.env.local</code>, fill in <code>VITE_SUPABASE_URL</code> and{' '}
            <code>VITE_SUPABASE_ANON_KEY</code>, then restart <code>npm run dev</code>.
          </p>
        </div>
      </div>
    )
  }
  return (
    <AuthProvider>
      <HashRouter>
        <Gate />
      </HashRouter>
    </AuthProvider>
  )
}
