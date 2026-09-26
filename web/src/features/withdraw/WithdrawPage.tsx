import { useState } from 'react'
import { WITHDRAW } from '../movements/configs'
import { MovementPage } from '../movements/MovementPage'
import { RollLedgerPanel } from './RollLedgerPanel'
import { PARTIAL, YARDS } from './rollLedgerConfigs'

type SubTab = 'roll' | 'yards' | 'partial'

const TABS: { id: SubTab; label: string }[] = [
  { id: 'roll', label: 'Roll / PC' },
  { id: 'yards', label: 'Yards' },
  { id: 'partial', label: 'Partial' },
]

/** The Withdraw screen covers three different kinds of stock, each with its own workflow. */
export function WithdrawPage() {
  const [tab, setTab] = useState<SubTab>('roll')

  return (
    <div>
      <h1 className="page-title">Withdraw</h1>
      <div className="mb-4 flex gap-1 border-b border-slate-200">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
              tab === t.id ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'roll' && <MovementPage key="withdraw-roll" config={WITHDRAW} hideTitle />}
      {tab === 'yards' && <RollLedgerPanel key="withdraw-yards" config={YARDS} />}
      {tab === 'partial' && <RollLedgerPanel key="withdraw-partial" config={PARTIAL} />}
    </div>
  )
}
