import { useState, type FormEvent } from 'react'
import { errorMessage, supabase } from '../lib/supabase'

export function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setError(errorMessage(error))
    setBusy(false)
  }

  return (
    <div className="min-h-screen grid place-items-center bg-slate-100 px-4">
      <form onSubmit={submit} className="w-full max-w-sm bg-white rounded-xl shadow p-6 space-y-4">
        <div>
          <h1 className="text-xl font-bold text-slate-800">YUNITRADE Inventory</h1>
          <p className="text-sm text-slate-500">Sign in to continue</p>
        </div>
        <label className="block">
          <span className="label">Email</span>
          <input className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <div>
          <label htmlFor="login-password" className="label">Password</label>
          <div className="relative">
            <input
              id="login-password"
              className="input pr-16"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              type="button"
              className="absolute inset-y-0 right-0 px-3 text-xs font-medium text-slate-500 hover:text-slate-700"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              aria-pressed={showPassword}
            >
              {showPassword ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button className="btn-primary w-full" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
