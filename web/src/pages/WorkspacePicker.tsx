import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'

const CARDS = [
  {
    to: '/stocks',
    title: 'Inventory',
    text: 'Stocks, withdrawals, receiving, sales orders, yards and partial rolls.',
    sections: ['Stocks', 'Withdraw', 'Received', 'Sales Orders', 'Yards Stock'],
    accent: 'bg-slate-900 text-white',
    ring: 'hover:border-slate-400',
    icon: (
      // Stacked boxes
      <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 7.5 12 3l9 4.5-9 4.5-9-4.5Z" />
        <path d="M3 12l9 4.5 9-4.5" />
        <path d="M3 16.5 12 21l9-4.5" />
      </svg>
    ),
  },
  {
    to: '/po/orders',
    title: 'Purchase Orders',
    text: 'Orders to suppliers, incoming shipments, received goods, samples and notes.',
    sections: ['Orders', 'Incoming Shipments', 'Received', 'Samples', 'Notes'],
    accent: 'bg-indigo-700 text-white',
    ring: 'hover:border-indigo-400',
    icon: (
      // Clipboard with lines
      <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="5" y="4" width="14" height="17" rx="2" />
        <path d="M9 4V3h6v1" />
        <path d="M9 10h6M9 14h6M9 18h3" />
      </svg>
    ),
  },
]

/** Home screen for ADMIN accounts: pick which work to do. */
export function WorkspacePicker() {
  const { profile, signOut } = useAuth()

  return (
    <div className="min-h-screen bg-slate-100 px-4 py-10">
      <div className="mx-auto max-w-4xl">
        <div className="mb-8 flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-sm font-bold tracking-wide text-slate-500">YUNITRADE</div>
            <h1 className="text-2xl font-bold text-slate-800">What are you working on?</h1>
          </div>
          <div className="text-right text-sm">
            <div className="text-slate-700">{profile?.display_name ?? profile?.email}</div>
            <button className="text-xs text-slate-500 underline" onClick={signOut}>
              Sign out
            </button>
          </div>
        </div>

        <div className="grid gap-5 md:grid-cols-2">
          {CARDS.map((c) => (
            <Link
              key={c.to}
              to={c.to}
              className={`card group block p-6 transition hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${c.ring}`}
            >
              <div className={`mb-4 inline-flex h-12 w-12 items-center justify-center rounded-lg ${c.accent}`}>{c.icon}</div>
              <h2 className="text-lg font-semibold text-slate-800">{c.title}</h2>
              <p className="mt-1 text-sm text-slate-500">{c.text}</p>
              <div className="mt-4 flex flex-wrap gap-1.5">
                {c.sections.map((s) => (
                  <span key={s} className="badge font-medium">
                    {s}
                  </span>
                ))}
              </div>
              <div className="mt-5 text-sm font-medium text-blue-700 group-hover:underline">Open {c.title} →</div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
