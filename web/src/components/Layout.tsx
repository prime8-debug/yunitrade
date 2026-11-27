import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { refreshSalesOrders } from '../lib/useSalesOrders'

interface NavEntry {
  to: string
  label: string
  adminOnly?: boolean
  soon?: boolean
}

export type Workspace = 'inventory' | 'purchase'

// Inventory workspace navigation (concept plan §6). `soon` = later phase, not built yet.
export const NAV: NavEntry[] = [
  { to: '/stocks', label: 'Stocks' },
  { to: '/beginning', label: 'Beginning Inventory', adminOnly: true },
  { to: '/withdraw', label: 'Withdraw' },
  { to: '/received', label: 'Received' },
  { to: '/sales-orders', label: 'Sales Orders', adminOnly: true },
  { to: '/yards', label: 'Yards Stock' },
  { to: '/partial-rolls', label: 'Partial Rolls' },
  { to: '/search', label: 'Search', soon: true },
  { to: '/items', label: 'Items', adminOnly: true },
  { to: '/audit', label: 'Audit', adminOnly: true, soon: true },
]

// Purchase Orders workspace navigation (ADMIN only as a whole).
export const PO_NAV: NavEntry[] = [
  { to: '/po/orders', label: 'Orders' },
  { to: '/po/shipments', label: 'Incoming Shipments' },
  { to: '/po/received', label: 'Received' },
  { to: '/po/samples', label: 'Samples' },
  { to: '/po/notes', label: 'Notes' },
]

const THEME: Record<Workspace, { name: string; aside: string; header: string; active: string; hover: string; border: string; muted: string }> = {
  inventory: {
    name: 'Inventory',
    aside: 'bg-slate-900 text-slate-200',
    header: 'bg-slate-900',
    active: 'bg-slate-700 text-white',
    hover: 'hover:bg-slate-800',
    border: 'border-slate-800',
    muted: 'text-slate-400',
  },
  purchase: {
    name: 'Purchase Orders',
    aside: 'bg-indigo-950 text-indigo-100',
    header: 'bg-indigo-950',
    active: 'bg-indigo-700 text-white',
    hover: 'hover:bg-indigo-900',
    border: 'border-indigo-900',
    muted: 'text-indigo-300',
  },
}

export function Layout({ workspace = 'inventory' }: { workspace?: Workspace }) {
  const { profile, isAdmin, signOut } = useAuth()
  const [open, setOpen] = useState(false)
  const theme = THEME[workspace]
  const entries = (workspace === 'purchase' ? PO_NAV : NAV).filter((n) => !n.adminOnly || isAdmin)

  // Start loading the Sales Order sheet as soon as an admin is in, so Sales Orders and the
  // Withdrawal No. suggestions are usually ready before they're opened.
  useEffect(() => {
    if (isAdmin && workspace === 'inventory') refreshSalesOrders()
  }, [isAdmin, workspace])

  return (
    <div className="min-h-screen bg-slate-100 md:flex">
      <header className={`md:hidden flex items-center justify-between ${theme.header} text-white px-4 py-3`}>
        <span className="font-bold">
          YUNITRADE <span className={`font-normal ${theme.muted}`}>· {theme.name}</span>
        </span>
        <button className="px-2 py-1 rounded border border-white/30" onClick={() => setOpen(!open)}>
          Menu
        </button>
      </header>

      <aside className={`${open ? 'block' : 'hidden'} md:block md:w-56 shrink-0 ${theme.aside} md:min-h-screen flex-col`}>
        <div className="hidden md:block px-4 pt-5 pb-4">
          <div className="font-bold text-white text-lg">YUNITRADE</div>
          <div className={`text-xs uppercase tracking-wide ${theme.muted}`}>{theme.name}</div>
        </div>
        {isAdmin && (
          <div className="px-2 pb-2">
            <Link
              to="/"
              onClick={() => setOpen(false)}
              className={`flex items-center gap-2 rounded px-3 py-2 text-xs ${theme.muted} ${theme.hover}`}
            >
              <span aria-hidden>←</span> Switch work
            </Link>
          </div>
        )}
        <nav className="px-2 pb-4 space-y-0.5">
          {entries.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              onClick={() => setOpen(false)}
              className={({ isActive }) => `flex items-center justify-between rounded px-3 py-2 text-sm ${isActive ? theme.active : theme.hover}`}
            >
              <span>{n.label}</span>
              {n.soon && <span className={`text-[10px] uppercase ${theme.muted}`}>soon</span>}
            </NavLink>
          ))}
        </nav>
        <div className={`px-4 py-4 border-t ${theme.border} text-sm`}>
          <div className="text-white">{profile?.display_name ?? profile?.email}</div>
          <div className={`text-xs ${theme.muted} mb-2`}>{profile?.role}</div>
          <button className="text-xs underline opacity-80" onClick={signOut}>
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
