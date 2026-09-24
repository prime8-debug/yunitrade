import { useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'

interface NavEntry {
  to: string
  label: string
  adminOnly?: boolean
  soon?: boolean
}

// Navigation from the concept plan (§6). `soon` = later phase, not built yet.
export const NAV: NavEntry[] = [
  { to: '/', label: 'Stocks' },
  { to: '/beginning', label: 'Beginning Inventory' },
  { to: '/withdraw', label: 'Withdraw' },
  { to: '/received', label: 'Received' },
  { to: '/sales-orders', label: 'Sales Orders', soon: true },
  { to: '/served', label: 'Served', soon: true },
  { to: '/yards', label: '3M Yards', soon: true },
  { to: '/partial-rolls', label: 'Partial Rolls', soon: true },
  { to: '/search', label: 'Search', soon: true },
  { to: '/items', label: 'Items', adminOnly: true },
  { to: '/audit', label: 'Audit', adminOnly: true, soon: true },
]

export function Layout() {
  const { profile, isAdmin, signOut } = useAuth()
  const [open, setOpen] = useState(false)
  const entries = NAV.filter((n) => !n.adminOnly || isAdmin)

  return (
    <div className="min-h-screen bg-slate-100 md:flex">
      <header className="md:hidden flex items-center justify-between bg-slate-900 text-white px-4 py-3">
        <span className="font-bold">YUNITRADE</span>
        <button className="px-2 py-1 rounded border border-slate-600" onClick={() => setOpen(!open)}>
          Menu
        </button>
      </header>

      <aside className={`${open ? 'block' : 'hidden'} md:block md:w-56 shrink-0 bg-slate-900 text-slate-200 md:min-h-screen flex-col`}>
        <div className="hidden md:block px-4 py-5 font-bold text-white text-lg">YUNITRADE</div>
        <nav className="px-2 pb-4 space-y-0.5">
          {entries.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                `flex items-center justify-between rounded px-3 py-2 text-sm ${isActive ? 'bg-slate-700 text-white' : 'hover:bg-slate-800'}`
              }
            >
              <span>{n.label}</span>
              {n.soon && <span className="text-[10px] uppercase text-slate-500">soon</span>}
            </NavLink>
          ))}
        </nav>
        <div className="px-4 py-4 border-t border-slate-800 text-sm">
          <div className="text-white">{profile?.display_name ?? profile?.email}</div>
          <div className="text-xs text-slate-400 mb-2">{profile?.role}</div>
          <button className="text-xs text-slate-300 underline" onClick={signOut}>
            Sign out
          </button>
        </div>
      </aside>

      <main className="flex-1 min-w-0 p-4 md:p-6">
        <Outlet />
      </main>
    </div>
  )
}
