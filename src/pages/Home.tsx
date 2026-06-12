import { Link } from 'react-router-dom'
import { getUtilities } from '../utilities/registry'

export function Home() {
  const utilities = getUtilities()

  return (
    <div>
      <h1 className="text-2xl font-bold">Welcome to your Toolbox</h1>
      <p className="mt-1 text-slate-400">
        Pick a utility below. Your settings are saved to your account automatically.
      </p>

      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {utilities.map((u) => (
          <Link
            key={u.id}
            to={`/tools/${u.id}`}
            className="rounded-xl border border-slate-800 bg-slate-900 p-5 transition hover:border-indigo-500/50 hover:bg-slate-800/80"
          >
            <span className="text-3xl">{u.icon}</span>
            <h2 className="mt-3 font-semibold text-white">{u.name}</h2>
            <p className="mt-1 text-sm text-slate-400">{u.description}</p>
          </Link>
        ))}
      </div>
    </div>
  )
}
