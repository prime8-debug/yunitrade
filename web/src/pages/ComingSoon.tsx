export function ComingSoon({ title }: { title: string }) {
  return (
    <div>
      <h1 className="page-title">{title}</h1>
      <div className="card p-6 text-slate-500">
        This module is planned for a later phase. The core inventory (Stocks, Beginning, Received, Withdraw) comes first.
      </div>
    </div>
  )
}
